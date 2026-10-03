"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp, AudioLines, BookOpen, ChevronDown, CircleHelp,
  FileText, FolderKanban, Menu, MessageSquare, Mic, PanelLeftClose,
  PanelLeftOpen, Phone, Plus, Puzzle, Search, Settings, ShieldCheck, Sparkles,
  Target, Terminal, Video, Workflow, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import AutomationSkills from "@/components/AutomationSkills";
import WhatsAppConnect from "@/components/WhatsAppConnect";
import { supabase, supabaseReady } from "@/lib/supabase/browser";

type ChatMessage = { id: string; role: "user" | "assistant"; content: string; created_at?: string };
type Conversation = { id: string; title: string; created_at: string };
type Profile = { id: string; email?: string };
type AgentAttachment = { name: string; url: string };
type LocalStore = { conversations: Conversation[]; messages: Record<string, ChatMessage[]> };
type RuntimeStatus = { supabase: boolean; browserUse: boolean; base44: boolean; playwright: boolean; evaluator: boolean; whatsapp: boolean };
type SpeechResult = { transcript: string };
type SpeechWindow = Window & {
  SpeechRecognition?: new () => { lang: string; onresult: ((e: { results: ArrayLike<ArrayLike<SpeechResult>> }) => void) | null; onend: (() => void) | null; start: () => void };
  webkitSpeechRecognition?: new () => { lang: string; onresult: ((e: { results: ArrayLike<ArrayLike<SpeechResult>> }) => void) | null; onend: (() => void) | null; start: () => void };
};

const navItems = [
  { label: "Apps", icon: FolderKanban },
  { label: "Agent", icon: Sparkles },
  { label: "Workflows", icon: Workflow },
  { label: "Plugins", icon: Puzzle },
  { label: "Automation skills", icon: Terminal },
  { label: "Meetings", icon: Video },
  { label: "Notes", icon: BookOpen },
];
const localStorageKey = "elowen-local-workspace-v1";

function PixelMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path fill="#5B50DF" d="M5 5h10v10H5zM15 15h10v10H15zM25 5h10v10H25zM5 25h10v10H5zM25 25h10v10H25z" />
      <path fill="#8A82F2" d="M15 5h10v10H15zM5 15h10v10H5zM25 15h10v10H25zM15 25h10v10H15z" />
    </svg>
  );
}

export default function Home() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({ supabase: false, browserUse: false, base44: false, playwright: false, evaluator: false, whatsapp: false });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentWarning, setAttachmentWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [modelIndex, setModelIndex] = useState(0);
  const [voiceActive, setVoiceActive] = useState(false);
  const [activeNav, setActiveNav] = useState("Agent");
  const [localStore, setLocalStore] = useState<LocalStore>({ conversations: [], messages: {} });
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const modelNames = ["Auto", "Balanced", "Deep"];

  useEffect(() => {
    try {
      const saved = localStorage.getItem(localStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as LocalStore;
        setLocalStore(parsed);
        if (parsed.conversations.length) setConversations(parsed.conversations);
      }
    } catch { /* Keep the workspace usable if local storage is unavailable. */ }
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    fetch("/api/status").then((response) => response.json()).then((data: RuntimeStatus) => setRuntimeStatus(data)).catch(() => undefined);
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => setProfile(data.user ? { id: data.user.id, email: data.user.email } : null));
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setProfile(session?.user ? { id: session.user.id, email: session.user.email } : null);
      if (session?.user && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) { setCurrentId(null); setMessages([]); }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || !profile) return;
    const client = supabase;
    let live = true;
    client.from("conversations").select("id,title,created_at").order("created_at", { ascending: false }).limit(40)
      .then(({ data }) => { if (live && data) setConversations(data as Conversation[]); });
    return () => { live = false; };
  }, [profile]);

  useEffect(() => {
    if (!currentId) { setMessages([]); return; }
    if (!supabase || !profile) {
      setMessages(localStore.messages[currentId] ?? []);
      return;
    }
    const client = supabase;
    let live = true;
    client.from("messages").select("id,role,content,created_at").eq("conversation_id", currentId)
      .order("created_at", { ascending: true }).then(({ data }) => {
        if (live && data) setMessages(data.filter((m) => m.role === "user" || m.role === "assistant") as ChatMessage[]);
      });
    const channel = client.channel(`conversation-${currentId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${currentId}` }, (event) => {
        const row = event.new as ChatMessage;
        if (row.role === "user" || row.role === "assistant") {
          setMessages((previous) => previous.some((m) => m.id === row.id) ? previous : [...previous, row]);
        }
      }).subscribe();
    return () => { live = false; void client.removeChannel(channel); };
  }, [currentId, profile, localStore.messages]);

  useEffect(() => {
    if (!activeSession || !supabase) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const { data: auth } = await supabase!.auth.getSession();
      if (!auth.session || stopped) return;
      try {
        const response = await fetch(`/api/agent?sessionId=${encodeURIComponent(activeSession)}`, {
          headers: { Authorization: `Bearer ${auth.session.access_token}` }, cache: "no-store",
        });
        const data = await response.json();
        if (stopped) return;
        if (data.status === "completed" || data.status === "failed") {
          if (data.answer) addMessage({ id: `answer-${activeSession}`, role: "assistant", content: data.answer });
          else if (data.status === "failed") addMessage({ id: `failed-${activeSession}`, role: "assistant", content: "The browser task could not be completed. Open Agent Settings to check the connection and try again." });
          setActiveSession(null);
          return;
        }
      } catch { /* Retry the status check while the task is still active. */ }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 2500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeSession]);

  function addMessage(message: ChatMessage) {
    setMessages((previous) => previous.some((item) => item.id === message.id || (item.role === message.role && item.content === message.content))
      ? previous : [...previous, message]);
  }

  function saveLocal(nextConversations: Conversation[], nextMessages: Record<string, ChatMessage[]>) {
    const next = { conversations: nextConversations, messages: nextMessages };
    setLocalStore(next);
    setConversations(nextConversations);
    try { localStorage.setItem(localStorageKey, JSON.stringify(next)); } catch { /* Storage quota is non-fatal. */ }
  }

  async function startConversation(firstMessage = "") {
    const title = firstMessage.trim().slice(0, 52) || "New Conversation";
    let conversation: Conversation;
    if (supabase && profile) {
      const { data, error } = await supabase.from("conversations").insert({ title, owner_id: profile.id }).select("id,title,created_at").single();
      if (error || !data) throw new Error("Could not create a synced conversation. Please try again.");
      conversation = data as Conversation;
      setConversations((list) => [conversation, ...list]);
    } else {
      conversation = { id: crypto.randomUUID(), title, created_at: new Date().toISOString() };
      saveLocal([conversation, ...conversations], { ...localStore.messages, [conversation.id]: [] });
    }
    setCurrentId(conversation.id);
    setMessages([]);
    return conversation;
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if ((!content && !attachments.length) || busy) return;
    setBusy(true);
    const selectedFiles = attachments;
    const fileNotes = selectedFiles.map((file) => `Attached: ${file.name}`).join("\n");
    const combined = [content, fileNotes].filter(Boolean).join("\n\n");
    setDraft("");
    setAttachments([]);
    if (textarea.current) textarea.current.style.height = "auto";
    try {
      const conversation = currentId ? conversations.find((item) => item.id === currentId) : await startConversation(combined);
      const activeConversation = conversation ?? (currentId ? { id: currentId, title: "New Conversation", created_at: new Date().toISOString() } : null);
      if (!activeConversation) throw new Error("Could not start a conversation.");
      const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: combined, created_at: new Date().toISOString() };
      if (supabase && profile) {
        const uploaded: AgentAttachment[] = [];
        for (const file of selectedFiles) {
          const path = `${profile.id}/${activeConversation.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]/g, "_")}`;
          const { error: uploadError } = await supabase.storage.from("agent-attachments").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
          if (uploadError) throw new Error(`Could not upload ${file.name}: ${uploadError.message}`);
          const { data: signed, error: linkError } = await supabase.storage.from("agent-attachments").createSignedUrl(path, 3600);
          if (linkError || !signed) throw new Error(`Could not prepare ${file.name} for the agent.`);
          uploaded.push({ name: file.name, url: signed.signedUrl });
        }
        const { error } = await supabase.from("messages").insert({ conversation_id: activeConversation.id, owner_id: profile.id, role: "user", content: combined, meta: { attachments: uploaded.map(({ name }) => name) } });
        if (error) throw new Error("Your message could not be saved. Please try again.");
        addMessage(userMessage);
        const { data: auth } = await supabase.auth.getSession();
        if (!auth.session) throw new Error("Your sign-in expired. Please sign in again.");
        const response = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.session.access_token}` },
          body: JSON.stringify({
            message: content || "Please review the attached file(s) and help me with their contents.",
            conversationId: activeConversation.id,
            model: [undefined, "claude-sonnet-4.6", "claude-opus-4.7"][modelIndex],
            attachments: uploaded,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "The agent could not start this task.");
        if (result.answer) addMessage({ id: crypto.randomUUID(), role: "assistant", content: result.answer });
        if (result.sessionId) {
          setActiveSession(result.sessionId);
          addMessage({ id: `working-${result.sessionId}`, role: "assistant", content: "I’m working on that now. You can keep this conversation open while I make progress." });
        }
      } else {
        const nextMessages = { ...localStore.messages, [activeConversation.id]: [...(localStore.messages[activeConversation.id] ?? []), userMessage] };
        saveLocal(conversations, nextMessages);
        addMessage(userMessage);
        addMessage({ id: crypto.randomUUID(), role: "assistant", content: "This conversation is saved on this device. Sign in and connect Supabase plus Browser Use Cloud or a Base44 endpoint in Agent Settings to run live tasks and sync across devices." });
      }
    } catch (error) {
      addMessage({ id: crypto.randomUUID(), role: "assistant", content: error instanceof Error ? error.message : "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
      setVoiceActive(false);
    }
  }

  async function selectConversation(conversation: Conversation) {
    setCurrentId(conversation.id);
    setActiveSession(null);
    setSidebarOpen(false);
    setActiveNav("Agent");
  }

  function newChat() {
    setCurrentId(null);
    setMessages([]);
    setActiveSession(null);
    setActiveNav("Agent");
    setSidebarOpen(false);
    textarea.current?.focus();
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return setAuthMessage("Add the Supabase URL and public anon key to your environment first.");
    setAuthBusy(true);
    setAuthMessage("");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setAuthMessage(error ? error.message : "Check your inbox for a secure sign-in link.");
    setAuthBusy(false);
  }

  async function signOut() {
    await supabase?.auth.signOut();
    setProfile(null);
    setSettingsOpen(false);
    setCurrentId(null);
  }

  function startDictation() {
    const Speech = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
    if (!Speech) {
      setAuthMessage("Voice typing is not supported in this browser. Try Chrome or use the keyboard.");
      setSettingsOpen(true);
      return;
    }
    const recognition = new Speech();
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const spoken = event.results[0]?.[0]?.transcript ?? "";
      setDraft((value) => `${value}${value ? " " : ""}${spoken}`);
    };
    recognition.onend = () => setVoiceActive(false);
    setVoiceActive(true);
    recognition.start();
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const greeting = profile?.email?.split("@")[0] || "there";
  const isFresh = messages.length === 0;

  return (
    <div className="app-shell">
      <button aria-label="Close navigation" className={`overlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${collapsed ? "collapsed" : ""} ${sidebarOpen ? "mobile-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><PixelMark size={23} /></div>
          <span className="brand-name">elowen</span>
          <button className="collapse-button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        </div>
        <button className="new-chat" onClick={newChat}><Plus size={16} /><span className="nav-label">New conversation</span></button>
        <div className="sidebar-section">Workspace</div>
        <nav className="nav-stack" aria-label="Main navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${activeNav === label ? "active" : ""}`} onClick={() => { setActiveNav(label); setSidebarOpen(false); if (label === "Automation skills") setSkillsOpen(true); }}>
              <Icon size={16} strokeWidth={1.8} /><span className="nav-label">{label}</span>
            </button>
          ))}
          <button className={`nav-item ${settingsOpen ? "active" : ""}`} onClick={() => { setSettingsOpen(true); setSidebarOpen(false); }}><Settings size={16} strokeWidth={1.8} /><span className="nav-label">Agent settings</span></button>
        </nav>
        <div className="sidebar-section" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="nav-label">Recent</span><button className="icon-button" aria-label="Search conversations" style={{ width: 22, height: 22 }} onClick={() => setActiveNav("History")}><Search size={14} /></button>
        </div>
        <div className="history-list">
          {conversations.length ? conversations.slice(0, 20).map((conversation) => (
            <button key={conversation.id} className={`nav-item ${currentId === conversation.id ? "active" : ""}`} onClick={() => void selectConversation(conversation)} title={conversation.title}>
              <MessageSquare size={14} /><span className="nav-label">{conversation.title}</span>
            </button>
          )) : <div className="empty-history">Your conversations will show up here.</div>}
        </div>
        <div className="sidebar-bottom">
          <button className="profile-button" onClick={() => setSettingsOpen(true)}>
            <span className="avatar">{profile?.email?.slice(0, 1).toUpperCase() || "E"}</span>
            <span className="profile-copy"><strong>{profile?.email?.split("@")[0] || "Personal workspace"}</strong><span>{profile ? "Synced workspace" : "Local workspace"}</span></span>
            <ChevronDown size={14} style={{ marginLeft: "auto", color: "#a1a1aa" }} />
          </button>
        </div>
      </aside>

      <main className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-brand" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
            <button className="workspace-trigger" onClick={() => setSettingsOpen(true)}>
              <span className="workspace-dot"><Sparkles size={12} /></span>
              <span className="workspace-name">{activeNav === "Agent" ? "Personal workspace" : activeNav}</span>
              <ChevronDown className="workspace-chevron" size={14} />
            </button>
          </div>
          <div className="topbar-right">
            <button className="icon-button" aria-label="Help" onClick={() => setSettingsOpen(true)}><CircleHelp size={17} /></button>
            <button className="upgrade-button" onClick={() => setSettingsOpen(true)}><Sparkles size={13} /><span>Upgrade</span></button>
          </div>
        </header>

        <section className="main-content">
          <AnimatePresence mode="wait">
            {isFresh ? (
              <motion.div key="hero" className="hero" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: .22 }}>
                <div className="hero-mark"><PixelMark size={39} /></div>
                <h1>Hey <span>{greeting},</span><br className="mobile-break" /> what can I do for you today?</h1>
                <p className="hero-subtitle">Your agent can take the busywork from here.</p>
                <div className="quick-actions">
                  <button className="quick-action" onClick={() => { setDraft("Let your agent call someone for me about "); textarea.current?.focus(); }}><Phone size={14} />Let your agent call other people for you</button>
                  <button className="quick-action" onClick={() => { setDraft("/goal "); textarea.current?.focus(); }}><Target size={14} />Use /goal for longer and complex tasks</button>
                  <WhatsAppConnect />
                </div>
              </motion.div>
            ) : (
              <div className="chat-thread" aria-live="polite">
                {messages.map((message) => (
                  <div key={message.id} className={`message-row ${message.role}`}>
                    {message.role === "assistant" && <span className="message-avatar"><PixelMark size={18} /></span>}
                    <div className="message-bubble">{message.content}</div>
                  </div>
                ))}
                {activeSession && <div className="execution-pill thread-status"><i />Agent is running your task</div>}
                {busy && <div className="message-row assistant"><span className="message-avatar"><PixelMark size={18} /></span><span className="message-pending"><i /><i /><i /></span></div>}
                <div aria-hidden="true" style={{ float: "left", clear: "both" }} ref={(element) => element?.scrollIntoView({ behavior: "smooth", block: "end" })} />
              </div>
            )}
          </AnimatePresence>

          <div className="composer-wrap">
            <form className="composer" onSubmit={(event) => void sendMessage(event)}>
              {attachments.map((file) => <span className="attachment-pill" key={`${file.name}-${file.size}`}><FileText size={12} />{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttachments((items) => items.filter((item) => item !== file))}><X size={11} /></button></span>)}
              <textarea
                ref={textarea}
                aria-label="Message your agent"
                placeholder="Ask me anything, or type / for more options"
                value={draft}
                rows={2}
                onChange={(event) => { setDraft(event.target.value); event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`; }}
                onKeyDown={onComposerKeyDown}
              />
              <div className="composer-toolbar">
                <input ref={fileInput} type="file" multiple hidden onChange={(event) => {
                  const picked = Array.from(event.target.files ?? []);
                  const accepted = picked.filter((file) => file.size <= 10 * 1024 * 1024);
                  const available = Math.max(0, 5 - attachments.length);
                  setAttachments((items) => [...items, ...accepted.slice(0, available)]);
                  setAttachmentWarning(picked.length !== accepted.length ? "Files must be 10 MB or smaller." : accepted.length > available ? "You can attach up to 5 files per message." : "");
                  event.target.value = "";
                }} />
                <button type="button" className="toolbar-button" aria-label="Attach file" title="Attach files" onClick={() => fileInput.current?.click()}><Plus size={18} /></button>
                <button type="button" className="toolbar-button model-select" aria-label="Change model" title="Choose response depth" onClick={() => setModelIndex((index) => (index + 1) % modelNames.length)}>{modelNames[modelIndex]}<ChevronDown size={12} /></button>
                <span className="toolbar-spacer" />
                <button type="button" className="toolbar-button" aria-label="Voice typing" title="Dictate a message" onClick={startDictation}><Mic size={16} /></button>
                <button type="button" className={`toolbar-button waveform-button ${voiceActive ? "active" : ""}`} aria-label="Voice input" title={voiceActive ? "Listening" : "Start voice input"} onClick={startDictation}><AudioLines size={17} /></button>
                <button type="submit" className="send-button" disabled={busy || (!draft.trim() && !attachments.length)} aria-label="Send message"><ArrowUp size={17} /></button>
              </div>
            </form>
            {attachmentWarning && <div className="composer-note" role="status" style={{ color: "#c2410c" }}>{attachmentWarning}</div>}
            <div className="composer-note">Elowen can make mistakes. Review important actions before they happen.</div>
          </div>
        </section>
      </main>

      <AnimatePresence>
        {settingsOpen && (
          <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
            <motion.section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" initial={{ y: 10, opacity: 0, scale: .99 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 7, opacity: 0 }}>
              <div className="modal-head">
                <div><h2 id="settings-title">Agent settings</h2><p>Connect your workspace to enable private sync and live tasks.</p></div>
                <button className="modal-close" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={17} /></button>
              </div>
              {profile ? (
                <div className="modal-form">
                  <div className="modal-message" style={{ display: "flex", alignItems: "center", gap: 8 }}><ShieldCheck size={15} color="#4f46e5" />Signed in as {profile.email}. Your conversations sync to Supabase.</div>
                  <div className="modal-message">Supabase {runtimeStatus.supabase ? "connected" : "not configured"} · Browser Use {runtimeStatus.browserUse ? "connected" : "not configured"} · WhatsApp {runtimeStatus.whatsapp ? "ready" : "not configured"} · Playwright {runtimeStatus.playwright ? "ready" : "optional"} · Evaluator {runtimeStatus.evaluator ? "ready" : "local checks"}</div>
                  <button className="modal-primary" type="button" onClick={() => void signOut()}>Sign out</button>
                </div>
              ) : (
                <form className="modal-form" onSubmit={(event) => void signIn(event)}>
                  <label>Email address<input autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></label>
                  <button className="modal-primary" type="submit" disabled={authBusy}>{authBusy ? "Sending link…" : "Continue with email"}</button>
                  {authMessage && <div className="modal-message" role="status">{authMessage}</div>}
                  <p className="modal-footer-note">A sign-in link keeps your conversations private and lets the agent run tasks using your configured integrations. Without sign-in, chats stay only on this device.</p>
                </form>
              )}
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
      <AutomationSkills
        open={skillsOpen}
        enabled={runtimeStatus.playwright}
        conversationId={currentId}
        onConversationCreated={(id) => {
          setCurrentId(id);
          setConversations((items) => items.some((item) => item.id === id) ? items : [{ id, title: "Automation skill session", created_at: new Date().toISOString() }, ...items]);
        }}
        onClose={() => setSkillsOpen(false)}
      />
      <span className="sr-only" aria-live="polite">{voiceActive ? "Listening" : ""}</span>
    </div>
  );
}
