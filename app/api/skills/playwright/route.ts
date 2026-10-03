import { createClient } from "@supabase/supabase-js";
import { copyFile, cp, mkdir } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const operations = ["open", "goto", "snapshot", "click", "fill", "screenshot", "trace_start", "trace_stop", "console_errors", "network_requests", "accessibility_audit", "smoke_test"] as const;
type Operation = typeof operations[number];
type Input = { operation?: Operation; url?: string; reference?: string; value?: string; sessionId?: string; conversationId?: string };

function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function isPrivateIp(address: string) {
  const ip = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+|[\da-f]{1,4}:[\da-f]{1,4})$/);
    if (!mapped) return false;
    if (mapped[1].includes(".")) return isPrivateIp(mapped[1]);
    const [high, low] = mapped[1].split(":").map((part) => Number.parseInt(part, 16));
    return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

async function validateUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a valid http or https URL."); }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) throw new Error("Only public http and https URLs are allowed.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || isPrivateIp(host)) {
    throw new Error("Private-network and localhost targets are blocked for safety.");
  }
  if (!isIP(host)) {
    try {
      const addresses = await lookup(host, { all: true, verbatim: true });
      if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error("Private-network targets are blocked for safety.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("blocked")) throw error;
      throw new Error("The target hostname could not be resolved.");
    }
  }
  return url;
}

function redact(text: string) {
  return text
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[\w.~-]+/gi, "$1[REDACTED]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key)\s*[=:]\s*)[^&\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|key|code|signature|auth|jwt)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 40_000);
}

async function saveTraceArtifacts(output: string, sessionId: string) {
  const root = process.cwd();
  const destination = path.join(root, "outputs", "playwright", sessionId, new Date().toISOString().replace(/[:.]/g, "-"));
  const artifacts: string[] = [];
  const links = [...output.matchAll(/\[(Trace|Network log|Resources)\]\(([^)]+)\)/g)];
  if (!links.length) return artifacts;
  await mkdir(destination, { recursive: true });
  for (const [, label, href] of links) {
    const source = path.resolve(root, href);
    if (!source.startsWith(`${root}${path.sep}`)) continue;
    const target = path.join(destination, label === "Resources" ? "resources" : path.basename(source));
    try {
      const info = await import("node:fs/promises").then(({ stat }) => stat(source));
      if (info.isDirectory()) await cp(source, target, { recursive: true });
      else await copyFile(source, target);
      artifacts.push(path.relative(root, target));
    } catch { /* A trace may be unavailable on an ephemeral runner. */ }
  }
  return artifacts;
}

const accessibilityAudit = `async (page) => JSON.stringify(await page.evaluate(() => {
  const unlabeled = (el) => !((el.getAttribute('aria-label') || '').trim() || (el.getAttribute('aria-labelledby') || '').trim() || (el.getAttribute('title') || '').trim() || (el.innerText || el.value || '').trim());
  const controls = [...document.querySelectorAll('button,[role=button],a[href]')].filter(unlabeled).length;
  const fields = [...document.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(el => !el.labels?.length && unlabeled(el)).length;
  const missingImageAlt = [...document.images].filter(img => !img.hasAttribute('alt')).length;
  const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index).length;
  return { page: location.href, documentLanguage: document.documentElement.lang || null, h1Count: document.querySelectorAll('h1').length, unlabeledControls: controls, unlabeledFields: fields, imagesMissingAlt: missingImageAlt, duplicateIds };
}));`;

const smokeTest = `async (page) => JSON.stringify(await page.evaluate(() => ({
  page: location.href,
  title: document.title,
  bodyTextLength: document.body?.innerText?.trim().length || 0,
  h1Count: document.querySelectorAll('h1').length,
  horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  brokenImages: [...document.images].filter(image => image.complete && image.naturalWidth === 0).length
})));`;

export async function POST(request: Request) {
  if (process.env.PLAYWRIGHT_CLI_ENABLED !== "true") return fail("Playwright CLI skills are disabled on this server.", 503);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !url || !anon || !service) return fail("Sign in with Supabase to run automation skills.", 401);

  const auth = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await auth.auth.getUser(token);
  if (authError || !authData.user) return fail("Your sign-in is missing or expired.", 401);
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  let input: Input;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 12_000) return fail("Request body is too large.", 413);
  try { input = await request.json() as Input; } catch { return fail("Request body must be valid JSON."); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Request body must be a JSON object.");
  if (!input.operation || !operations.includes(input.operation)) return fail("Choose a supported Playwright skill.");
  if (typeof input.sessionId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(input.sessionId)) return fail("Invalid browser session ID.");
  if (input.url !== undefined && (typeof input.url !== "string" || input.url.length > 3000)) return fail("Target URL must be 3,000 characters or fewer.");
  if (input.reference !== undefined && typeof input.reference !== "string") return fail("Element ref must be text.");
  if (input.value !== undefined && (typeof input.value !== "string" || input.value.length > 5000)) return fail("Text input must be 5,000 characters or fewer.");
  if (input.conversationId !== undefined && typeof input.conversationId !== "string") return fail("Conversation ID must be text.");
  if (["click", "fill"].includes(input.operation) && !/^e[1-9]\d*$/.test(input.reference ?? "")) return fail("Use an element ref such as e3 from the latest snapshot.");

  let conversationId = input.conversationId;
  if (conversationId) {
    const { data: owned } = await admin.from("conversations").select("id").eq("id", conversationId).eq("owner_id", authData.user.id).maybeSingle();
    if (!owned) return fail("Conversation not found.", 404);
  } else {
  const { data: conversation, error } = await admin.from("conversations").insert({ owner_id: authData.user.id, title: "Automation skill session" }).select("id").single();
    if (error || !conversation) return fail("Could not create a conversation for this execution trace.", 500);
    conversationId = conversation.id;
  }

  let target: URL | null = null;
  if (["open", "goto"].includes(input.operation)) {
    try { target = await validateUrl(input.url ?? ""); } catch (error) { return fail(error instanceof Error ? error.message : "Invalid target URL."); }
  }

  const requested = input.operation;
  let command: string[];
  switch (requested) {
    case "open": command = ["open", target!.href, "--headed"]; break;
    case "goto": command = ["goto", target!.href]; break;
    case "snapshot": command = ["snapshot"]; break;
    case "click": command = ["click", input.reference!]; break;
    case "fill": command = ["fill", input.reference!, input.value ?? ""]; break;
    case "screenshot": command = ["screenshot", `--filename=${path.join(process.cwd(), "outputs", "playwright", `${input.sessionId}.png`)}`]; break;
    case "trace_start": command = ["tracing-start"]; break;
    case "trace_stop": command = ["tracing-stop"]; break;
    case "console_errors": command = ["console", "error"]; break;
    case "network_requests": command = ["requests"]; break;
    case "accessibility_audit": command = ["run-code", accessibilityAudit]; break;
    case "smoke_test": command = ["run-code", smokeTest]; break;
  }

  const cliSession = `u${authData.user.id.replace(/-/g, "").slice(0, 10)}-${input.sessionId}`;
  const binary = process.env.PLAYWRIGHT_CLI_BIN || "playwright-cli";
  const timeoutSetting = Number(process.env.PLAYWRIGHT_CLI_TIMEOUT_MS ?? "90000");
  const timeout = Number.isFinite(timeoutSetting) ? Math.max(10_000, Math.min(timeoutSetting, 120_000)) : 90_000;
  const artifactDir = path.join(process.cwd(), "outputs", "playwright");
  await mkdir(artifactDir, { recursive: true });
  const startedAt = Date.now();
  let output = "";
  let ok = false;
  let artifacts: string[] = [];

  try {
    const result = await execFileAsync(binary, [`-s=${cliSession}`, ...command], { cwd: process.cwd(), timeout, maxBuffer: 2 * 1024 * 1024 });
    output = redact(`${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`);
    ok = true;
    if (requested === "screenshot") artifacts.push(path.relative(process.cwd(), command[1].slice("--filename=".length)));
    if (requested === "trace_stop") artifacts = await saveTraceArtifacts(result.stdout ?? "", input.sessionId);
  } catch (error) {
    const commandError = error as Error & { stdout?: string; stderr?: string; code?: string | number };
    output = redact([commandError.stdout, commandError.stderr, commandError.message].filter(Boolean).join("\n"));
    if (commandError.code === "ENOENT") output = "Playwright CLI was not found. Install @playwright/cli on the app runner and configure PLAYWRIGHT_CLI_BIN.";
  }

  const detail = {
    operation: requested,
    session_id: input.sessionId,
    ...(target ? { target_host: target.host } : {}),
    succeeded: ok,
    duration_ms: Date.now() - startedAt,
    output_length: output.length,
    artifacts,
  };
  const { error: traceError } = await admin.from("execution_traces").insert({
    conversation_id: conversationId,
    owner_id: authData.user.id,
    provider: "playwright",
    event: requested,
    details: detail,
  });
  if (traceError) return fail("The automation finished, but its execution trace could not be saved.", 500);
  return NextResponse.json({ ok, output, artifacts, sessionId: input.sessionId, conversationId }, { status: ok ? 200 : 502 });
}
