import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Role = "system" | "user" | "assistant";
type ChatInput = { provider?: string; model?: string; keys?: string[]; baseUrl?: string; messages?: { role: Role; content: string }[]; jsonSchema?: Record<string, unknown> };
const encoder = new TextEncoder();

function error(message: string, status = 400) { return NextResponse.json({ error: message }, { status }); }

function privateAddress(address: string) {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(ip) === 6) return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb");
  return false;
}

async function safeCustomUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return false;
  if (url.username || url.password) return false;
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return process.env.NODE_ENV !== "production";
  if (privateAddress(url.hostname)) return false;
  try {
    const addresses = await lookup(url.hostname, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => !privateAddress(address));
  } catch { return false; }
}

function extractText(provider: string, payload: Record<string, unknown>) {
  if (provider === "anthropic") {
    const type = payload.type;
    const delta = payload.delta as Record<string, unknown> | undefined;
    return type === "content_block_delta" && typeof delta?.text === "string" ? delta.text : "";
  }
  if (provider === "gemini") {
    const candidates = payload.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    return candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  }
  const choices = payload.choices as Array<{ delta?: { content?: string }; message?: { content?: string } }> | undefined;
  return choices?.[0]?.delta?.content ?? choices?.[0]?.message?.content ?? "";
}

export async function POST(request: Request) {
  let input: ChatInput;
  try { input = await request.json() as ChatInput; } catch { return error("Request body must be valid JSON."); }
  if (!input || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 40) return error("Send between 1 and 40 chat messages.");
  if (input.messages.some((message) => !message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 20_000)) return error("Invalid chat message.");

  const provider = input.provider ?? "openai";
  if (!["openai", "anthropic", "gemini", "custom"].includes(provider)) return error("Choose OpenAI, Anthropic, Gemini, or a compatible custom provider.");
  const keys = (input.keys ?? []).filter((key) => typeof key === "string" && key.trim()).slice(0, 10);
  if (!keys.length) return error("Unlock your encrypted vault and add a provider key.", 401);
  const model = input.model?.trim().slice(0, 120) || ({ openai: "gpt-4o-mini", anthropic: "claude-3-7-sonnet-latest", gemini: "gemini-2.0-flash", custom: "" }[provider] ?? "");
  if (!model) return error("Enter a model ID for the custom provider.");
  if (provider === "custom" && (!input.baseUrl || !(await safeCustomUrl(input.baseUrl)))) return error("Use a public HTTPS endpoint, or localhost during local development.");

  let upstream: Response | null = null;
  let providerError = "Provider request failed.";
  for (const key of keys) {
    let endpoint = "https://api.openai.com/v1/chat/completions";
    let headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    let body: Record<string, unknown>;
    if (provider === "anthropic") {
      endpoint = "https://api.anthropic.com/v1/messages";
      headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
      const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      body = { model, max_tokens: 4096, stream: true, ...(system ? { system } : {}), messages: input.messages.filter((message) => message.role !== "system") };
    } else if (provider === "gemini") {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      headers = { "x-goog-api-key": key, "Content-Type": "application/json" };
      body = { contents: input.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), ...(input.messages.some((message) => message.role === "system") ? { systemInstruction: { parts: [{ text: input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n") }] } } : {}), generationConfig: { responseMimeType: input.jsonSchema ? "application/json" : "text/plain", ...(input.jsonSchema ? { responseSchema: input.jsonSchema } : {}) } };
    } else {
      endpoint = provider === "custom" ? `${input.baseUrl!.replace(/\/$/, "")}/chat/completions` : endpoint;
      body = { model, messages: input.messages, stream: true, ...(input.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: input.jsonSchema } } } : {}) };
    }
    try {
      upstream = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal, cache: "no-store" });
      if (upstream.ok) break;
      providerError = (await upstream.text()).slice(0, 500) || `Provider returned ${upstream.status}.`;
      if (![401, 403, 408, 429, 500, 502, 503, 504].includes(upstream.status)) return error(providerError, 502);
      upstream = null;
    } catch (cause) { providerError = cause instanceof Error ? cause.message : "Provider connection failed."; upstream = null; }
  }
  if (!upstream?.body) return error(providerError, 502);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream!.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            const raw = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
            if (!raw || raw === "[DONE]") continue;
            try {
              const text = extractText(provider, JSON.parse(raw) as Record<string, unknown>);
              if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
            } catch { /* Ignore provider metadata that is not a content event. */ }
          }
          if (done) break;
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "The provider stream ended unexpectedly." })}\n\n`)); }
      finally { reader.releaseLock(); controller.close(); }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" } });
}
