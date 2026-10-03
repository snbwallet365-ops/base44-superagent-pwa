"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, ArrowDownToLine, Bug, Check, ChevronDown, CircleAlert, Code2,
  Globe, Network, Play, ScanSearch, ShieldCheck, Sparkles, Square, Terminal, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/browser";

type Operation = "open" | "goto" | "snapshot" | "click" | "fill" | "screenshot" | "trace_start" | "trace_stop" | "console_errors" | "network_requests" | "accessibility_audit" | "smoke_test";
type Props = { open: boolean; enabled: boolean; conversationId: string | null; onConversationCreated: (id: string) => void; onClose: () => void };

const actions: { op: Operation; title: string; icon: typeof Globe; tone?: string }[] = [
  { op: "open", title: "Open headed browser", icon: Globe },
  { op: "snapshot", title: "DOM snapshot + refs", icon: ScanSearch },
  { op: "click", title: "Click element ref", icon: Play },
  { op: "fill", title: "Fill element ref", icon: Code2 },
  { op: "screenshot", title: "Capture screenshot", icon: ArrowDownToLine },
  { op: "trace_start", title: "Start trace", icon: Activity },
  { op: "trace_stop", title: "Stop + save trace", icon: Square },
  { op: "console_errors", title: "Console errors", icon: Bug },
  { op: "network_requests", title: "Network requests", icon: Network },
  { op: "accessibility_audit", title: "Accessibility audit", icon: ShieldCheck },
  { op: "smoke_test", title: "Run smoke test", icon: Sparkles },
];

export default function AutomationSkills({ open, enabled, conversationId, onConversationCreated, onClose }: Props) {
  const [sessionId, setSessionId] = useState("");
  const [url, setUrl] = useState("https://example.com");
  const [reference, setReference] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<Operation | null>(null);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [lastStatus, setLastStatus] = useState<"idle" | "passed" | "failed">("idle");

  useEffect(() => { setSessionId(crypto.randomUUID()); }, []);

  async function run(operation: Operation) {
    if (!supabase) { setError("Supabase sign-in is required to run and persist automation skills."); return; }
    if ((operation === "click" || operation === "fill") && !/^e[1-9]\d*$/.test(reference)) {
      setError("Use a ref such as e3 from the latest DOM snapshot.");
      return;
    }
    setBusy(operation); setError(""); setOutput(""); setLastStatus("idle");
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to use the automation tools.");
      const response = await fetch("/api/skills/playwright", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ operation, url, reference, value, sessionId, conversationId }),
      });
      const result = await response.json();
      if (!conversationId && result.conversationId) onConversationCreated(result.conversationId);
      if (!response.ok) throw new Error(result.error ?? "Automation skill failed.");
      setOutput([result.output, result.artifacts?.length ? `Saved artifacts:\n${result.artifacts.join("\n")}` : ""].filter(Boolean).join("\n\n"));
      setLastStatus(result.ok ? "passed" : "failed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Automation skill failed.");
      setLastStatus("failed");
    } finally { setBusy(null); }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop skills-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
          <motion.section className="skills-drawer" role="dialog" aria-modal="true" aria-labelledby="skills-title" initial={{ x: 18, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 18, opacity: 0 }}>
            <header className="skills-header">
              <div className="skills-title-icon"><Terminal size={17} /></div>
              <div><h2 id="skills-title">Automation skills</h2><p>Playwright CLI · DevTools · ScoutQA</p></div>
              <button className="modal-close" aria-label="Close automation skills" onClick={onClose}><X size={17} /></button>
            </header>
            <div className="skills-status-row">
              <span className={`execution-pill ${lastStatus}`}><i />{busy ? "Executing" : lastStatus === "passed" ? "Checks passed" : lastStatus === "failed" ? "Needs attention" : enabled ? "Runner ready" : "Runner not configured"}</span>
              <span className="skills-session">Session {sessionId.slice(0, 8) || "..."}</span>
            </div>
            {!enabled && <div className="skills-notice"><CircleAlert size={15} /> Install Microsoft Playwright CLI on the app runner and set <code>PLAYWRIGHT_CLI_ENABLED=true</code>.</div>}
            <div className="skills-fields">
              <label>Target page<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" /></label>
              <div className="skills-fields-pair">
                <label>Snapshot ref<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="e3" /></label>
                <label>Fill value<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Text to enter" /></label>
              </div>
            </div>
            <div className="skills-grid">
              {actions.map(({ op, title, icon: Icon }) => (
                <button key={op} className={`skill-action ${busy === op ? "running" : ""}`} disabled={Boolean(busy) || !enabled} onClick={() => void run(op)} title={title}>
                  <Icon size={15} /> <span>{title}</span>{busy === op && <span className="skill-spinner" />}
                </button>
              ))}
            </div>
            <div className="skills-output-head"><strong>Latest result</strong>{output && <span><Check size={13} /> Stored in conversation traces</span>}</div>
            {error ? <div className="skills-error" role="alert">{error}</div> : <pre className="skills-output">{output || "Open a page, inspect its accessible DOM, then use the generated e1, e2… refs to act. Traces and screenshots are written to outputs/playwright/."}</pre>}
            <p className="skills-footnote"><ChevronDown size={13} /> Commands run in an isolated, signed-in session. Arbitrary shell commands and code are not accepted.</p>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
