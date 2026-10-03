"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Activity, AudioLines, ChevronDown, FileUp, ImagePlus, Mail, MessageCircle, Mic2, Sparkles, Video, X } from "lucide-react";
import { useRef, useState } from "react";
import type { VaultData } from "@/lib/security/vault";
import { supabase } from "@/lib/supabase/browser";

type Panel = "email" | "upload" | "llm" | "image" | "video" | "speech" | "extract" | "whatsapp";
type Props = { open: boolean; onClose: () => void; vault: VaultData };
type Msg = { role: "system" | "user" | "assistant"; content: string };
const cards: { id: Panel; title: string; icon: typeof Mail }[] = [
  { id: "email", title: "Send email", icon: Mail }, { id: "upload", title: "Upload file", icon: FileUp },
  { id: "llm", title: "Invoke LLM", icon: Sparkles }, { id: "image", title: "Generate image", icon: ImagePlus },
  { id: "video", title: "Generate video", icon: Video }, { id: "speech", title: "Generate speech", icon: AudioLines },
  { id: "extract", title: "Extract file data", icon: Activity }, { id: "whatsapp", title: "WhatsApp link", icon: MessageCircle },
];
const asFile = ".csv,.pdf,.png,.jpg,.jpeg,.webp,application/pdf,text/csv,image/png,image/jpeg";

export default function ConnectorSuite({ open, onClose, vault }: Props) {
  const [panel, setPanel] = useState<Panel>("email");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [sender, setSender] = useState("");
  const emailBody = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [llmProvider, setLlmProvider] = useState("openai");
  const [llmModel, setLlmModel] = useState("gpt-4o-mini");
  const [system, setSystem] = useState("You are a concise, helpful assistant.");
  const [prompt, setPrompt] = useState("");
  const [jsonSchema, setJsonSchema] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [throughput, setThroughput] = useState(0);
  const [aspect, setAspect] = useState("1:1");
  const [phone, setPhone] = useState("");
  const [whatsText, setWhatsText] = useState("");
  const [pitch, setPitch] = useState(1);
  const [rate, setRate] = useState(1);

  function keysFor(provider: string) {
    if (provider === "anthropic") return vault.anthropicKeys;
    if (provider === "gemini") return vault.geminiKeys;
    if (provider === "custom") return vault.customKeys;
    return vault.openaiKeys;
  }

  async function post(action: string, data: Record<string, unknown> = {}) {
    const { data: sessionData } = await supabase?.auth.getSession() ?? { data: { session: null } };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sessionData.session) headers.Authorization = `Bearer ${sessionData.session.access_token}`;
    const response = await fetch("/api/connectors", { method: "POST", headers, body: JSON.stringify({ action, ...data }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "Connector request failed.");
    setResult(value); setNotice(value.notice ?? (value.simulated ? "Simulation complete." : "Completed."));
    return value as Record<string, any>;
  }

  async function sendEmail() {
    setBusy(true); setNotice("");
    try { await post("send_email", { to: emailTo.split(/[;,\s]+/).filter(Boolean), sender, subject: emailSubject, html: emailBody.current?.innerHTML ?? "" }); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Email send failed."); }
    finally { setBusy(false); }
  }

  async function uploadSelected(selected: File | null, action: "upload" | "extract" = "upload") {
    if (!selected) return;
    setFile(selected); setNotice(""); setResult(null); setUploadProgress(15); setBusy(true);
    const timer = setInterval(() => setUploadProgress((value) => Math.min(88, value + 13)), 160);
    try {
      if (action === "extract" && (selected.type === "text/csv" || selected.name.toLowerCase().endsWith(".csv"))) {
        const value = await post("extract_data", { text: await selected.text() });
        setNotice("CSV parsed into structured rows.");
        setResult(value);
      } else {
        const form = new FormData(); form.set("file", selected);
        const { data: sessionData } = await supabase?.auth.getSession() ?? { data: { session: null } };
        const headers: Record<string, string> = {};
        if (sessionData.session) headers.Authorization = `Bearer ${sessionData.session.access_token}`;
        const response = await fetch("/api/connectors", { method: "POST", headers, body: form });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "Upload failed.");
        setResult(value); setNotice(value.notice ?? "Upload complete.");
        if (action === "extract") setResult({ file: selected.name, mediaType: selected.type, bytes: selected.size, extraction: "Preview fallback: metadata is available. Connect a vision/OCR model to extract page contents." });
      }
      setUploadProgress(100);
    } catch (error) { setNotice(error instanceof Error ? error.message : "File operation failed."); setUploadProgress(0); }
    finally { clearInterval(timer); setBusy(false); }
  }

  async function runLlm() {
    if (!prompt.trim()) return;
    setBusy(true); setNotice(""); setThroughput(0);
    const providerMessages: Msg[] = [...messages, { role: "user", content: prompt.trim() }];
    const started = Date.now(); let count = 0;
    try {
      let schema: Record<string, unknown> | undefined;
      if (jsonSchema.trim()) schema = JSON.parse(jsonSchema);
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: llmProvider, model: llmModel, keys: keysFor(llmProvider), baseUrl: vault.customBaseUrl, messages: [{ role: "system", content: system }, ...providerMessages], jsonSchema: schema }) });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error ?? "LLM request failed."); }
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "", answer = "";
      setPrompt("");
      while (true) {
        const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() ?? "";
        for (const event of events) {
          const line = event.split(/\r?\n/).find((entry) => entry.startsWith("data: "))?.slice(6);
          if (!line || line === "[DONE]") continue;
          const chunk = JSON.parse(line) as { text?: string; error?: string };
          if (chunk.error) throw new Error(chunk.error);
          if (chunk.text) { answer += chunk.text; count += 1; setThroughput(Math.round(count / Math.max((Date.now() - started) / 1000, .1))); }
        }
        setMessages([...providerMessages, { role: "assistant", content: answer }]);
        if (done) break;
      }
      setMessages([...providerMessages, { role: "assistant", content: answer }]);
      setNotice(`Stream complete · ${count} chunks · ${Math.round(count / Math.max((Date.now() - started) / 1000, .1))} tokens/s`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "LLM request failed."); }
    finally { setBusy(false); }
  }

  async function runImage() {
    setBusy(true); setNotice("Generating image…");
    try { const value = await post("generate_image", { prompt, aspect, key: vault.openaiKeys[0] }); setResult(value); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Image generation failed."); }
    finally { setBusy(false); }
  }

  async function runVideo() {
    setBusy(true); setNotice("Preparing video job…");
    try { const value = await post("generate_video", { prompt, aspect }); setResult(value); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Video job failed."); }
    finally { setBusy(false); }
  }

  async function runSpeech() {
    setBusy(true); setNotice("Preparing speech…");
    try {
      const value = await post("generate_speech", { text: prompt, key: vault.openaiKeys[0] });
      if (value.audio) setResult(value);
      else { speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(prompt || "Hello from Elowen."); utterance.pitch = pitch; utterance.rate = rate; speechSynthesis.speak(utterance); }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Speech request failed."); }
    finally { setBusy(false); }
  }

  async function whatsappLink() {
    setBusy(true);
    try { await post("whatsapp_link", { phone, text: whatsText }); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not create WhatsApp link."); }
    finally { setBusy(false); }
  }

  const sharedField = (label: string, value: string, set: (value: string) => void, placeholder = "") => <label className="connector-field">{label}<input value={value} onChange={(event) => set(event.target.value)} placeholder={placeholder} /></label>;

  return <AnimatePresence>{open && <>
    <motion.div className="modal-backdrop connectors-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} />
    <motion.aside className="connectors-drawer" role="dialog" aria-modal="true" aria-labelledby="connectors-title" initial={{ x: 26, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 26, opacity: 0 }}>
      <header className="connectors-head"><div><p className="eyebrow">Workspace tools</p><h2 id="connectors-title">Connectors suite</h2></div><button className="modal-close" aria-label="Close connectors" onClick={onClose}><X size={18} /></button></header>
      <nav className="connector-tabs" aria-label="Connector actions">{cards.map(({ id, title, icon: Icon }) => <button className={panel === id ? "active" : ""} key={id} onClick={() => { setPanel(id); setNotice(""); setResult(null); }}><Icon size={14} />{title}</button>)}</nav>
      <div className="connector-content">
        {panel === "email" && <section><h3>Send email</h3><p className="connector-help">Rich text editor · recipient tags · verified sender alias</p>{sharedField("Recipients · comma or space separated", emailTo, setEmailTo, "person@example.com, team@example.com")}{sharedField("Sender alias", sender, setSender, "Elowen <you@verified-domain.com>")}{sharedField("Subject", emailSubject, setEmailSubject, "A quick note") }<label className="connector-field">Message<div ref={emailBody} contentEditable suppressContentEditableWarning className="wysiwyg" data-placeholder="Write a richly formatted note…" /></label><button className="modal-primary" disabled={busy} onClick={() => void sendEmail()}><Mail size={14} />{busy ? "Sending…" : "Send email"}</button></section>}
        {panel === "upload" && <section><h3>Upload file</h3><p className="connector-help">CSV, PDF, PNG, JPG, and WEBP · maximum 10 MB</p><input ref={uploadInput} hidden type="file" accept={asFile} onChange={(event) => void uploadSelected(event.target.files?.[0] ?? null)} /><button className="dropzone" onClick={() => uploadInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadSelected(event.dataTransfer.files[0] ?? null); }}><FileUp size={27} /><strong>{file?.name ?? "Drop a file here or browse"}</strong><span>Private preview upload · mock CDN fallback</span></button>{uploadProgress > 0 && <div className="progress"><i style={{ width: `${uploadProgress}%` }} /></div>}</section>}
        {panel === "llm" && <section><h3>Invoke LLM</h3><p className="connector-help">Streaming multi-turn runner · JSON schema · live throughput</p><div className="connector-pair"><label className="connector-field">Provider<select value={llmProvider} onChange={(event) => { const next = event.target.value; setLlmProvider(next); setLlmModel(({openai:"gpt-4o-mini",anthropic:"claude-3-7-sonnet-latest",gemini:"gemini-2.0-flash",custom:vault.customModel} as Record<string,string>)[next] ?? ""); }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option><option value="custom">Custom endpoint</option></select></label>{sharedField("Model", llmModel, setLlmModel, "model ID")}</div>{sharedField("System instructions", system, setSystem, "You are a helpful assistant") }<label className="connector-field">JSON schema (optional)<textarea rows={3} value={jsonSchema} onChange={(event) => setJsonSchema(event.target.value)} placeholder={'{"type":"object","properties":{"summary":{"type":"string"}}}'} /></label><div className="llm-history">{messages.map((message, index) => <p key={index}><b>{message.role}</b> · {message.content}</p>)}</div><label className="connector-field">Prompt<textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask your model…" /></label><div className="connector-inline"><button className="modal-primary" disabled={busy} onClick={() => void runLlm()}><Sparkles size={14} />{busy ? "Streaming…" : "Run model"}</button><span><Activity size={13} />{throughput} tokens/s</span></div></section>}
        {panel === "image" && <section><h3>Generate image</h3><p className="connector-help">Prompt runner · aspect selection · gallery</p><label className="connector-field">Prompt<textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the image…" /></label><div className="aspect-pills">{["1:1", "16:9", "9:16"].map((value) => <button key={value} className={aspect === value ? "active" : ""} onClick={() => setAspect(value)}>{value}</button>)}</div><button className="modal-primary" disabled={busy} onClick={() => void runImage()}><ImagePlus size={14} />{busy ? "Creating…" : "Generate image"}</button>{busy && <div className="image-skeleton" />}{(result as any)?.imageUrl && <figure className="generated-media"><img src={(result as any).imageUrl} alt="Generated artwork" /><figcaption>{(result as any).simulated ? "Example gallery image · simulation" : "Generated with OpenAI"}</figcaption></figure>}</section>}
        {panel === "video" && <section><h3>Generate video</h3><p className="connector-help">Prompt workflow · status · inline player</p><label className="connector-field">Prompt<textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the motion and scene…" /></label><div className="aspect-pills">{["16:9", "9:16", "1:1"].map((value) => <button key={value} className={aspect === value ? "active" : ""} onClick={() => setAspect(value)}>{value}</button>)}</div><button className="modal-primary" disabled={busy} onClick={() => void runVideo()}><Video size={14} />{busy ? "Queueing…" : "Start video job"}</button>{(result as any)?.status && <div className="video-status"><span className="status-dot" />{(result as any).status} · {(result as any).simulated ? "adapter simulation" : "provider job"}</div>}{(result as any)?.videoUrl && <video className="generated-video" controls src={(result as any).videoUrl} />}</section>}
        {panel === "speech" && <section><h3>Generate speech</h3><p className="connector-help">Browser voice fallback · optional OpenAI MP3</p><label className="connector-field">Text<textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Text to speak…" /></label><div className="connector-pair"><label className="connector-field">Pitch · {pitch.toFixed(1)}<input type="range" min="0.5" max="1.8" step="0.1" value={pitch} onChange={(event) => setPitch(Number(event.target.value))} /></label><label className="connector-field">Rate · {rate.toFixed(1)}<input type="range" min="0.5" max="1.8" step="0.1" value={rate} onChange={(event) => setRate(Number(event.target.value))} /></label></div><button className="modal-primary" disabled={busy} onClick={() => void runSpeech()}><Mic2 size={14} />Preview voice</button>{(result as any)?.audio && <div className="audio-card"><audio controls src={(result as any).audio} /><a download={(result as any).filename} href={(result as any).audio}>MP3 download</a></div>}</section>}
        {panel === "extract" && <section><h3>Extract file data</h3><p className="connector-help">CSV to structured JSON · PDF/image metadata fallback</p><input hidden ref={uploadInput} type="file" accept={asFile} onChange={(event) => void uploadSelected(event.target.files?.[0] ?? null, "extract")} /><button className="dropzone" onClick={() => uploadInput.current?.click()}><FileUp size={27} /><strong>{file?.name ?? "Choose CSV, PDF, PNG, or JPG"}</strong><span>CSV rows are parsed into structured JSON</span></button>{result && <pre className="connector-json">{JSON.stringify(result, null, 2)}</pre>}</section>}
        {panel === "whatsapp" && <section><h3>WhatsApp connect</h3><p className="connector-help">Create an instant deep link to message a phone number.</p>{sharedField("Phone · include country code", phone, setPhone, "+1 555 010 1234")}{sharedField("Prefilled message", whatsText, setWhatsText, "Hello from Elowen") }<button className="modal-primary green" disabled={busy} onClick={() => void whatsappLink()}><MessageCircle size={14} />Create WhatsApp link</button>{(result as any)?.url && <a className="whatsapp-deep-link" href={(result as any).url} target="_blank" rel="noopener noreferrer">Open wa.me link ↗</a>}<div className="vault-secure-note"><ChevronDown size={13} />Pair your Base44 agent with the WhatsApp connect chip on the home screen.</div></section>}
        {notice && <div className="connector-notice" role="status">{notice}</div>}
      </div>
    </motion.aside>
  </>}</AnimatePresence>;
}
