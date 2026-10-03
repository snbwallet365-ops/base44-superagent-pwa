"use client";

import { KeyRound, LockKeyhole, Save, ShieldCheck, Unlock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { emptyVault, openVault, sealVault, type VaultData } from "@/lib/security/vault";

const storageKey = "elowen-encrypted-vault-v1";
const keyFields = [
  ["browserUseKeys", "Browser Use Cloud API keys", "bu_…"],
  ["base44Keys", "Base44 agent API key pool", "Agent API key"],
  ["openaiKeys", "OpenAI keys", "sk-…"],
  ["anthropicKeys", "Anthropic keys", "sk-ant-…"],
  ["geminiKeys", "Google Gemini keys", "AIza…"],
  ["customKeys", "Custom / OpenRouter / Groq keys", "Optional API key"],
] as const;
type Props = { open: boolean; onClose: () => void; onUnlock: (vault: VaultData) => void };

export default function CredentialVault({ open, onClose, onUnlock }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [stored, setStored] = useState(false);
  const [vault, setVault] = useState<VaultData>(emptyVault);
  const [unlocked, setUnlocked] = useState(false);
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStored(Boolean(localStorage.getItem(storageKey)));
    setNotice("");
  }, [open]);

  async function unlockVault() {
    if (passphrase.length < 12) return setNotice("Use a passphrase with at least 12 characters.");
    setBusy(true); setNotice("");
    try {
      const saved = localStorage.getItem(storageKey);
      const data = saved ? await openVault(saved, passphrase) : { ...emptyVault };
      setVault(data); setUnlocked(true); onUnlock(data);
      if (!saved) localStorage.setItem(storageKey, await sealVault(data, passphrase));
    } catch { setNotice("Could not unlock this vault. Check the passphrase."); }
    finally { setBusy(false); }
  }

  function lines(value: string) { return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).slice(0, 10); }

  async function saveVault() {
    setBusy(true); setNotice("");
    try {
      const serialized = await sealVault(vault, passphrase);
      localStorage.setItem(storageKey, serialized);
      onUnlock(vault);
      setNotice("Encrypted vault saved on this device.");
    } catch { setNotice("Could not save the encrypted vault in this browser."); }
    finally { setBusy(false); }
  }

  function update<K extends keyof VaultData>(field: K, value: VaultData[K]) {
    setVault((current) => ({ ...current, [field]: value }));
  }

  if (!open) return null;
  return <div className="modal-backdrop vault-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="vault-drawer" role="dialog" aria-modal="true" aria-labelledby="vault-title">
      <header className="vault-header"><span className="vault-icon"><KeyRound size={17} /></span><div><h2 id="vault-title">Credential vault</h2><p>Encrypted locally with your passphrase</p></div><button className="modal-close" aria-label="Close credential vault" onClick={onClose}><X size={17} /></button></header>
      {!unlocked ? <div className="vault-lock"><LockKeyhole size={25} /><p>{stored ? "Unlock your encrypted provider keys." : "Create a local encrypted vault. The passphrase is never saved."}</p><label>Vault passphrase<input type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="At least 12 characters" /></label><button className="modal-primary" disabled={busy} onClick={() => void unlockVault()}><Unlock size={14} />{stored ? "Unlock vault" : "Create vault"}</button></div> : <div className="vault-content">
        <div className="vault-secure-note"><ShieldCheck size={15} />Keys are stored as AES-GCM ciphertext in this browser. They are only sent over HTTPS when you run a provider task.</div>
        <div className="vault-field"><label>Base44 Agent ID<input value={vault.base44AgentId} onChange={(event) => update("base44AgentId", event.target.value)} placeholder="Agent ID" /></label><label>Base44 trusted adapter URL<input value={vault.base44AgentUrl} onChange={(event) => update("base44AgentUrl", event.target.value)} placeholder="https://your-agent-adapter.example/api" /></label></div>
        {keyFields.map(([field, label, placeholder]) => <label className="vault-field" key={field}>{label}<small>One key per line · up to 10</small><textarea rows={2} value={vault[field].join("\n")} onChange={(event) => update(field, lines(event.target.value))} placeholder={placeholder} style={{ WebkitTextSecurity: visible ? "none" : "disc" }} /></label>)}
        <div className="vault-field vault-pair"><label>Custom / local base URL<input value={vault.customBaseUrl} onChange={(event) => update("customBaseUrl", event.target.value)} placeholder="https://openrouter.ai/api/v1" /></label><label>Model name<input value={vault.customModel} onChange={(event) => update("customModel", event.target.value)} placeholder="model id" /></label></div>
        <div className="vault-actions"><button className="toolbar-button" onClick={() => setVisible((value) => !value)}>{visible ? "Hide keys" : "Reveal keys"}</button><button className="modal-primary" disabled={busy} onClick={() => void saveVault()}><Save size={14} />Save encrypted vault</button></div>
        {notice && <div className="modal-message" role="status">{notice}</div>}
      </div>}
      {!unlocked && notice && <div className="vault-error" role="alert">{notice}</div>}
    </section>
  </div>;
}
