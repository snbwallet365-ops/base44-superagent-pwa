import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ConnectorInput = {
  action?: string; to?: string[]; subject?: string; html?: string; sender?: string; prompt?: string;
  aspect?: string; key?: string; phone?: string; text?: string; name?: string; type?: string; size?: number;
};

function reply(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

async function authorized(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anon) return false;
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  return !error && Boolean(data.user);
}

function parseCsv(text: string) {
  return text.split(/\r?\n/).filter(Boolean).slice(0, 501).map((line) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((cell) => cell.trim().replace(/^"|"$/g, "")));
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 12 * 1024 * 1024) return reply({ error: "Upload must be smaller than 12 MB." }, 413);
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return reply({ error: "Choose a file to upload." }, 400);
    if (file.size > 10 * 1024 * 1024) return reply({ error: "Files must be 10 MB or smaller." }, 413);
    if (!/^(image\/(png|jpeg|webp)|text\/(plain|csv)|application\/(pdf|json))$/.test(file.type)) return reply({ error: "Supported: CSV, PDF, PNG, JPG, and WEBP." }, 415);
    return reply({ ok: true, simulated: true, name: file.name, type: file.type, size: file.size, url: `preview://assets/${encodeURIComponent(file.name)}`, notice: "Mock CDN link; configure private object storage for production uploads." });
  }

  let input: ConnectorInput;
  try { input = await request.json() as ConnectorInput; } catch { return reply({ error: "Request body must be valid JSON." }, 400); }
  if (!input || typeof input !== "object" || typeof input.action !== "string") return reply({ error: "Choose a connector action." }, 400);

  if (input.action === "send_email") {
    if (process.env.RESEND_API_KEY && !(await authorized(request))) return reply({ error: "Sign in to send email from this workspace." }, 401);
    const recipients = input.to?.filter((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)).slice(0, 20) ?? [];
    if (!recipients.length || !input.subject?.trim() || !input.html?.trim()) return reply({ error: "Add a valid recipient, subject, and email content." }, 400);
    if (!process.env.RESEND_API_KEY) return reply({ ok: true, simulated: true, id: `preview-email-${Date.now()}`, recipients, notice: "Email preview only. Add RESEND_API_KEY and RESEND_FROM to enable delivery." });
    const from = input.sender?.trim() || process.env.RESEND_FROM;
    if (!from || from.length > 200) return reply({ error: "Configure a verified RESEND_FROM sender alias." }, 400);
    const sent = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: recipients, subject: input.subject.slice(0, 300), html: input.html.slice(0, 100_000) }), signal: AbortSignal.timeout(20_000) });
    const result = await sent.json().catch(() => ({}));
    return sent.ok ? reply({ ok: true, simulated: false, ...result }) : reply({ error: "Email provider rejected this send request." }, 502);
  }

  if (input.action === "extract_data") {
    if (typeof input.text !== "string" || input.text.length > 1_000_000) return reply({ error: "Provide file text under 1 MB for extraction." }, 400);
    const rows = parseCsv(input.text);
    const headers = rows[0] ?? [];
    return reply({ ok: true, simulated: false, format: "csv", headers, rows: rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, row[index] ?? ""]))) });
  }

  if (input.action === "whatsapp_link") {
    const phone = (input.phone ?? "").replace(/\D/g, "");
    if (phone.length < 7 || phone.length > 15) return reply({ error: "Enter a phone number with country code." }, 400);
    return reply({ ok: true, url: `https://wa.me/${phone}${input.text ? `?text=${encodeURIComponent(input.text.slice(0, 1000))}` : ""}` });
  }

  if (input.action === "generate_image") {
    if (!input.key) return reply({ ok: true, simulated: true, imageUrl: "https://images.unsplash.com/photo-1470252649378-9c29740c9fa8?auto=format&fit=crop&w=1024&q=80", notice: "Demo image. Unlock an OpenAI key for generated artwork." });
    const generated = await fetch("https://api.openai.com/v1/images/generations", { method: "POST", headers: { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-image-1", prompt: input.prompt?.slice(0, 4000) ?? "", size: input.aspect === "16:9" ? "1536x1024" : input.aspect === "9:16" ? "1024x1536" : "1024x1024", n: 1 }), signal: AbortSignal.timeout(90_000) });
    const data = await generated.json().catch(() => ({})) as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
    if (!generated.ok) return reply({ error: data.error?.message ?? "Image provider request failed." }, 502);
    const image = data.data?.[0];
    return reply({ ok: true, simulated: false, imageUrl: image?.url ?? (image?.b64_json ? `data:image/png;base64,${image.b64_json}` : "") });
  }

  if (input.action === "generate_speech") {
    if (!input.key) return reply({ ok: true, simulated: true, notice: "Browser speech preview. Unlock an OpenAI key to download MP3 audio." });
    const speech = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "tts-1", voice: "alloy", input: input.text?.slice(0, 4000) ?? "Hello from Elowen.", response_format: "mp3" }), signal: AbortSignal.timeout(60_000) });
    if (!speech.ok) return reply({ error: "Speech provider request failed." }, 502);
    const audio = Buffer.from(await speech.arrayBuffer()).toString("base64");
    return reply({ ok: true, simulated: false, audio: `data:audio/mpeg;base64,${audio}`, filename: "elowen-speech.mp3" });
  }

  if (input.action === "generate_video") {
    if (process.env.VIDEO_GENERATION_URL && process.env.VIDEO_GENERATION_API_KEY && !(await authorized(request))) return reply({ error: "Sign in to dispatch video jobs from this workspace." }, 401);
    if (!process.env.VIDEO_GENERATION_URL || !process.env.VIDEO_GENERATION_API_KEY) return reply({ ok: true, simulated: true, status: "queued", notice: "Video job simulated. Configure a trusted VIDEO_GENERATION_URL adapter to dispatch real jobs." });
    const response = await fetch(process.env.VIDEO_GENERATION_URL, { method: "POST", headers: { Authorization: `Bearer ${process.env.VIDEO_GENERATION_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: input.prompt?.slice(0, 4000), aspect: input.aspect }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json().catch(() => ({}));
    return response.ok ? reply({ ok: true, simulated: false, ...result }) : reply({ error: "Video adapter rejected this job." }, 502);
  }

  return reply({ error: "Unknown connector action." }, 400);
}
