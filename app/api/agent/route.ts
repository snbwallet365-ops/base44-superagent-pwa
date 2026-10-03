import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentRequest = {
  message?: string;
  conversationId?: string | null;
  sessionId?: string;
  model?: string;
  attachments?: { name?: string; url?: string }[];
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

  const { data: conversation, error: conversationError } = await admin
    .from("conversations")
    .select("id")
    .eq("id", input.conversationId)
    .eq("owner_id", identity.user.id)
    .maybeSingle();
  if (conversationError || !conversation) return fail("Conversation not found.", 404);

  const task = async () => {
    if (process.env.BASE44_AGENT_URL) {
      if (!process.env.BASE44_API_KEY || !process.env.BASE44_AGENT_ID) {
        throw new Error("Set BASE44_API_KEY and BASE44_AGENT_ID alongside BASE44_AGENT_URL.");
      }
      const response = await fetch(process.env.BASE44_AGENT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.BASE44_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: process.env.BASE44_AGENT_ID,
          message: taskMessage,
          conversation_id: input.conversationId,
          ...(input.model ? { model: input.model } : {}),
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(String(payload.error ?? `Base44 endpoint returned ${response.status}.`));
      return { mode: "base44", payload, answer: messageOf(payload) };
    }

    if (!process.env.BROWSER_USE_API_KEY) {
      throw new Error("Connect Browser Use Cloud or configure a Base44 agent endpoint in the server environment.");
    }
    const baseUrl = (process.env.BROWSER_USE_BASE_URL ?? "https://api.browser-use.com/api/v3").replace(/\/$/, "");
    const costLimit = Number(process.env.BROWSER_USE_MAX_COST_USD ?? "2");
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: {
        "X-Browser-Use-API-Key": process.env.BROWSER_USE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ task: taskMessage, keep_alive: true, max_cost_usd: Number.isFinite(costLimit) && costLimit > 0 ? Math.min(costLimit, 25) : 2, ...(input.model ? { model: input.model } : {}) }),
      signal: AbortSignal.timeout(90_000),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(String(payload.detail ?? payload.error ?? `Browser Use returned ${response.status}.`));

    const sessionId = sessionIdOf(payload);
    if (!sessionId) throw new Error("Browser Use created a response without a session ID.");
    const { error: goalError } = await admin.from("agent_goals").insert({
      conversation_id: input.conversationId,
      owner_id: identity.user.id,
      goal_title: message.slice(0, 200),
      status: "in_progress",
      browser_session_id: sessionId,
      steps: [],
    });
    if (goalError) throw new Error("The agent started, but its progress could not be saved. Check the Supabase migration.");
    return { mode: "browser_use", sessionId, payload, answer: messageOf(payload) };
  };

  try {
    const result = await task();
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
    return fail(error instanceof Error ? error.message : "The agent request failed.", 502);
  }
}

export async function GET(request: Request) {
  const identity = await authorize(request);
  const admin = getAdminClient();
  if (!identity || !admin) return fail("Sign in with Supabase to check agent progress.", 401);

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) return fail("A session ID is required.");
  const { data: goal } = await admin
    .from("agent_goals")
    .select("id, conversation_id, status")
    .eq("browser_session_id", sessionId)
    .eq("owner_id", identity.user.id)
    .maybeSingle();
  if (!goal) return fail("Agent session not found.", 404);

  if (!process.env.BROWSER_USE_API_KEY) {
    return NextResponse.json({ status: goal.status, error: "Browser Use Cloud is not configured." });
  }
  const baseUrl = (process.env.BROWSER_USE_BASE_URL ?? "https://api.browser-use.com/api/v3").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { "X-Browser-Use-API-Key": process.env.BROWSER_USE_API_KEY },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await readPayload(response);
  if (!response.ok) return fail(String(payload.detail ?? `Browser Use returned ${response.status}.`), 502);

  const rawStatus = String(payload.status ?? "").toLowerCase();
  const answer = messageOf(payload);
  const taskSucceeded = payload.isTaskSuccessful;
  const completed = taskSucceeded === true || ["completed", "finished", "success", "succeeded"].includes(rawStatus);
  const failed = taskSucceeded === false || ["failed", "error", "cancelled", "canceled", "timed_out"].includes(rawStatus) || rawStatus === "stopped";
  const status = completed ? "completed" : failed ? "failed" : "in_progress";
  await admin.from("agent_goals").update({ status, ...(payload.steps ? { steps: payload.steps } : {}) }).eq("id", goal.id);

  if (answer) {
    const { data: existing } = await admin
      .from("messages")
      .select("id")
      .eq("conversation_id", goal.conversation_id)
      .eq("owner_id", identity.user.id)
      .contains("meta", { session_id: sessionId })
      .limit(1);
    if (!existing?.length) {
      await admin.from("messages").insert({
        conversation_id: goal.conversation_id,
        owner_id: identity.user.id,
        role: "assistant",
        content: answer,
        meta: { provider: "browser_use", session_id: sessionId },
      });
    }
  }
  return NextResponse.json({ status, answer, payload });
}
