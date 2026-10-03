import { createClient } from "@supabase/supabase-js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { evaluateAndRefine } from "@/lib/agent/evaluator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentRequest = {
  message?: string;
  conversationId?: string | null;
  sessionId?: string;
  model?: string;
  attachments?: { name?: string; url?: string }[];
  browserUseKeys?: string[];
  base44Keys?: string[];
  base44AgentId?: string;
  base44AgentUrl?: string;
};

function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { result: parsed };
  } catch {
    return { text };
  }
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authorize(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anon) return null;
  const authClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await authClient.auth.getUser(token);
  return error || !data.user ? null : { token, user: data.user };
}

function sessionIdOf(data: Record<string, unknown>) {
  const nested = data.session && typeof data.session === "object" ? data.session as Record<string, unknown> : {};
  return String(data.session_id ?? data.sessionId ?? data.id ?? nested.id ?? nested.session_id ?? "");
}

function messageOf(data: Record<string, unknown>) {
  for (const key of ["result", "output", "response", "message", "text"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      if (typeof nested.text === "string") return nested.text;
      if (typeof nested.content === "string") return nested.content;
      return JSON.stringify(value) ?? "";
    }
  }
  return "";
}

function privateAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(normalized) === 6) return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  return false;
}

async function trustedEndpoint(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal") || privateAddress(url.hostname)) return false;
    if (!isIP(url.hostname)) {
      const addresses = await lookup(url.hostname, { all: true });
      if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) return false;
    }
    return true;
  } catch { return false; }
}

export async function POST(request: Request) {
  const identity = await authorize(request);
  const admin = getAdminClient();
  if (!identity || !admin) return fail("Sign in with Supabase to securely run an agent task.", 401);

  let input: AgentRequest;
  try {
    input = (await request.json()) as AgentRequest;
  } catch {
    return fail("Request body must be valid JSON.");
  }
  const message = input.message?.trim();
  if (!message || message.length > 12000) return fail("Enter a task between 1 and 12,000 characters.");
  if (!input.conversationId) return fail("Start a conversation before sending a task.");
  if (input.model && !["claude-sonnet-4.6", "claude-opus-4.7"].includes(input.model)) return fail("The selected model is not supported.");
  if (input.attachments !== undefined && !Array.isArray(input.attachments)) return fail("Attachments must be a list of signed file links.");
  const attachmentList = input.attachments ?? [];
  const storageOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin : "";
  if (attachmentList.length > 5 || attachmentList.some((file) => {
    try { return !file || typeof file.name !== "string" || file.name.length > 255 || typeof file.url !== "string" || file.url.length > 3000 || new URL(file.url).origin !== storageOrigin; }
    catch { return true; }
  })) return fail("Attachments must be Supabase storage links from your signed-in workspace.");
  const taskMessage = attachmentList.length
    ? `${message}\n\nAttached files:\n${attachmentList.map((file) => `- ${file.name}: ${file.url}`).join("\n")}`
    : message;
  const browserUseKeys = [...(Array.isArray(input.browserUseKeys) ? input.browserUseKeys : []), process.env.BROWSER_USE_API_KEY ?? ""].filter((key) => typeof key === "string" && key.trim()).slice(0, 10);
  const base44Keys = [...(Array.isArray(input.base44Keys) ? input.base44Keys : []), process.env.BASE44_API_KEY ?? ""].filter((key) => typeof key === "string" && key.trim()).slice(0, 10);
  const base44AgentUrl = input.base44AgentUrl?.trim() || process.env.BASE44_AGENT_URL || "";
  const base44AgentId = input.base44AgentId?.trim() || process.env.BASE44_AGENT_ID || "";
  if (base44AgentUrl && !(await trustedEndpoint(base44AgentUrl))) return fail("Base44 adapter URL must be public HTTPS. Private-network destinations are blocked.");

  const { data: conversation, error: conversationError } = await admin
    .from("conversations")
    .select("id")
    .eq("id", input.conversationId)
    .eq("owner_id", identity.user.id)
    .maybeSingle();
  if (conversationError || !conversation) return fail("Conversation not found.", 404);

  const { data: goal, error: goalCreateError } = await admin.from("agent_goals").insert({
    conversation_id: input.conversationId,
    owner_id: identity.user.id,
    goal_title: message.slice(0, 200),
    status: "planning",
    steps: [],
  }).select("id").single();
  if (goalCreateError || !goal) return fail("Could not save this task to Supabase.", 500);
  await admin.from("execution_traces").insert({
    conversation_id: input.conversationId,
    agent_goal_id: goal.id,
    owner_id: identity.user.id,
    provider: "offline",
    event: "task_received",
    details: { message_length: message.length, attachment_count: attachmentList.length },
  });

  const task = async () => {
    if (base44AgentUrl) {
      if (!base44Keys.length || !base44AgentId) throw new Error("Unlock a Base44 API key and configure the Base44 Agent ID.");
      let response: Response | null = null;
      let payload: Record<string, unknown> = {};
      for (const key of base44Keys) {
        response = await fetch(base44AgentUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: base44AgentId, message: taskMessage, conversation_id: input.conversationId, ...(input.model ? { model: input.model } : {}) }),
          signal: AbortSignal.timeout(90_000),
        });
        payload = await readPayload(response);
        if (response.ok) break;
        if (![401, 403, 408, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(String(payload.error ?? `Base44 endpoint returned ${response.status}.`));
      }
      if (!response?.ok) throw new Error(String(payload.error ?? `Base44 endpoint returned ${response?.status ?? "an error"}.`));
      return { mode: "base44", payload, answer: messageOf(payload) || "Your Base44 agent accepted the task. Check its connected conversation for the result." };
    }

    if (!browserUseKeys.length) {
      return { mode: "offline", payload: {}, answer: "I saved this task. Add a Browser Use API key or Base44 agent endpoint to enable live execution; your conversation and task remain synced here." };
    }
    const baseUrl = (process.env.BROWSER_USE_BASE_URL ?? "https://api.browser-use.com/api/v3").replace(/\/$/, "");
    const costLimit = Number(process.env.BROWSER_USE_MAX_COST_USD ?? "2");
    let response: Response | null = null;
    let payload: Record<string, unknown> = {};
    for (const key of browserUseKeys) {
      response = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ task: taskMessage, keep_alive: true, max_cost_usd: Number.isFinite(costLimit) && costLimit > 0 ? Math.min(costLimit, 25) : 2, ...(input.model ? { model: input.model } : {}) }),
        signal: AbortSignal.timeout(90_000),
      });
      payload = await readPayload(response);
      if (response.ok) break;
      if (![401, 403, 408, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(String(payload.detail ?? payload.error ?? `Browser Use returned ${response.status}.`));
    }
    if (!response?.ok) throw new Error(String(payload.detail ?? payload.error ?? `Browser Use returned ${response?.status ?? "an error"}.`));

    const sessionId = sessionIdOf(payload);
    if (!sessionId) throw new Error("Browser Use created a response without a session ID.");
    const { error: goalError } = await admin.from("agent_goals").update({ status: "in_progress", browser_session_id: sessionId }).eq("id", goal.id);
    if (goalError) throw new Error("The agent started, but its progress could not be saved. Check the Supabase migration.");
    await admin.from("execution_traces").insert({
      conversation_id: input.conversationId,
      agent_goal_id: goal.id,
      owner_id: identity.user.id,
      provider: "browser_use",
      event: "session_started",
      details: { session_id: sessionId, model: input.model ?? "auto" },
    });
    return { mode: "browser_use", sessionId, payload, answer: messageOf(payload) };
  };

  try {
    const result = await task();
    if (result.mode !== "browser_use") {
      await admin.from("agent_goals").update({ status: "completed" }).eq("id", goal.id);
      await admin.from("execution_traces").insert({
        conversation_id: input.conversationId,
        agent_goal_id: goal.id,
        owner_id: identity.user.id,
        provider: result.mode === "base44" ? "base44" : "offline",
        event: result.mode === "base44" ? "task_completed" : "offline_fallback",
        details: { answer_length: result.answer.length },
      });
    }
    if (result.answer) {
      await admin.from("messages").insert({
        conversation_id: input.conversationId,
        owner_id: identity.user.id,
        role: "assistant",
        content: result.answer,
        meta: { provider: result.mode, ...(result.mode === "browser_use" ? { session_id: result.sessionId } : {}) },
      });
    }
    return NextResponse.json(result, { status: result.mode === "browser_use" ? 202 : 200 });
  } catch (error) {
    await admin.from("agent_goals").update({ status: "failed" }).eq("id", goal.id);
    await admin.from("execution_traces").insert({
      conversation_id: input.conversationId,
      agent_goal_id: goal.id,
      owner_id: identity.user.id,
      provider: base44AgentUrl ? "base44" : browserUseKeys.length ? "browser_use" : "offline",
      event: "task_failed",
      details: { error: error instanceof Error ? error.message.slice(0, 500) : "Unknown agent error" },
    });
    return fail(error instanceof Error ? error.message : "The agent request failed.", 502);
  }
}

export async function GET(request: Request) {
  const identity = await authorize(request);
  const admin = getAdminClient();
  if (!identity || !admin) return fail("Sign in with Supabase to check agent progress.", 401);

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) return fail("A session ID is required.");
  const { data: goal, error: goalError } = await admin
    .from("agent_goals")
    .select("id, conversation_id, goal_title, status")
    .eq("browser_session_id", sessionId)
    .eq("owner_id", identity.user.id)
    .maybeSingle();
  if (goalError || !goal) return fail("Agent session not found.", 404);
  if (goal.status === "completed" || goal.status === "failed") {
    const { data: messages } = await admin.from("messages").select("content").eq("conversation_id", goal.conversation_id).contains("meta", { session_id: sessionId }).limit(1);
    return NextResponse.json({ status: goal.status, answer: messages?.[0]?.content ?? "" });
  }
  if (goal.status !== "in_progress") return NextResponse.json({ status: "in_progress" });

  let suppliedKeys: unknown = [];
  try {
    const header = request.headers.get("x-browser-use-keys");
    if (header) suppliedKeys = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch { return fail("Invalid Browser Use credential pool."); }
  const userKeys = Array.isArray(suppliedKeys) ? suppliedKeys.filter((key): key is string => typeof key === "string" && key.trim()).slice(0, 10) : [];
  const browserUseKeys = [...userKeys, process.env.BROWSER_USE_API_KEY ?? ""].filter(Boolean).slice(0, 10);
  if (!browserUseKeys.length) {
    return NextResponse.json({ status: goal.status, error: "Browser Use Cloud is not configured." });
  }
  const { data: claimed } = await admin.from("agent_goals").update({ status: "planning" }).eq("id", goal.id).eq("status", "in_progress").select("id").maybeSingle();
  if (!claimed) return NextResponse.json({ status: "in_progress" });

  const baseUrl = (process.env.BROWSER_USE_BASE_URL ?? "https://api.browser-use.com/api/v3").replace(/\/$/, "");
  try {
    let response: Response | null = null;
    let payload: Record<string, unknown> = {};
    for (const key of browserUseKeys) {
      response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, { headers: { "X-Browser-Use-API-Key": key }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      payload = await readPayload(response);
      if (response.ok) break;
      if (![401, 403, 408, 429, 500, 502, 503, 504].includes(response.status)) break;
    }
    if (!response?.ok) {
      await admin.from("agent_goals").update({ status: "in_progress" }).eq("id", goal.id);
      return fail(String(payload.detail ?? `Browser Use returned ${response?.status ?? "an error"}.`), 502);
    }

    const rawStatus = String(payload.status ?? "").toLowerCase();
    const taskSucceeded = payload.isTaskSuccessful;
    const completed = taskSucceeded === true || ["completed", "finished", "success", "succeeded"].includes(rawStatus);
    const failed = taskSucceeded === false || ["failed", "error", "cancelled", "canceled", "timed_out"].includes(rawStatus) || rawStatus === "stopped";
    if (!completed && !failed) {
      await admin.from("agent_goals").update({ status: "in_progress", ...(payload.steps ? { steps: payload.steps } : {}) }).eq("id", goal.id);
      return NextResponse.json({ status: "in_progress", progress: payload.lastStepSummary ?? null });
    }

    const evaluation = await evaluateAndRefine({ task: goal.goal_title, draft: messageOf(payload), succeeded: completed && !failed });
    const finalStatus = evaluation.passed ? "completed" : "failed";
    await admin.from("agent_goals").update({ status: finalStatus, ...(payload.steps ? { steps: payload.steps } : {}) }).eq("id", goal.id);
    await admin.from("execution_traces").insert({
      conversation_id: goal.conversation_id,
      agent_goal_id: goal.id,
      owner_id: identity.user.id,
      provider: "browser_use",
      event: "task_finished",
      details: { session_id: sessionId, result_status: rawStatus, successful: evaluation.passed, result_length: evaluation.answer.length },
    });
    await admin.from("execution_traces").insert({
      conversation_id: goal.conversation_id,
      agent_goal_id: goal.id,
      owner_id: identity.user.id,
      provider: "evaluator",
      event: evaluation.passed ? "answer_approved" : "answer_rejected",
      details: { source: evaluation.source, critique: evaluation.critique },
    });
    await admin.from("messages").insert({
      conversation_id: goal.conversation_id,
      owner_id: identity.user.id,
      role: "assistant",
      content: evaluation.answer,
      meta: { provider: "browser_use", session_id: sessionId, evaluation: { passed: evaluation.passed, source: evaluation.source } },
    });
    return NextResponse.json({ status: finalStatus, answer: evaluation.answer, evaluation: { passed: evaluation.passed, critique: evaluation.critique } });
  } catch (error) {
    await admin.from("agent_goals").update({ status: "in_progress" }).eq("id", goal.id);
    return fail(error instanceof Error ? error.message : "Could not retrieve the agent result.", 502);
  }
}
