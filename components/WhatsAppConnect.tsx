"use client";

import { createClient } from "@base44/sdk";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, CheckCircle2, MessageCircle, X } from "lucide-react";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";

export default function WhatsAppConnect() {
  const [open, setOpen] = useState(false);
  const [connectUrl, setConnectUrl] = useState("");
  const [error, setError] = useState("");

  function openConnect() {
    setOpen(true);
    setError("");
    setConnectUrl("");
    const appId = process.env.NEXT_PUBLIC_BASE44_APP_ID;
    const agentName = process.env.NEXT_PUBLIC_BASE44_AGENT_NAME;
    if (!appId || !agentName) {
      setError("Add your Base44 app ID and agent name to the public environment settings to generate a secure connection link.");
      return;
    }
    try {
      const base44 = createClient({ appId });
      const url = base44.agents.getWhatsAppConnectURL(agentName as Parameters<typeof base44.agents.getWhatsAppConnectURL>[0]);
      if (!url || new URL(url).protocol !== "https:") throw new Error("Base44 returned an invalid WhatsApp authorization link.");
      setConnectUrl(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the WhatsApp connection link.");
    }
  }

  return (
    <>
      <button className="quick-action whatsapp-chip" onClick={openConnect}>
        <MessageCircle size={15} /> Connect Agent to WhatsApp
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="modal-backdrop whatsapp-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
            <motion.section className="whatsapp-modal" role="dialog" aria-modal="true" aria-labelledby="whatsapp-title" initial={{ y: 12, opacity: 0, scale: .99 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 8, opacity: 0 }}>
              <button className="modal-close whatsapp-close" aria-label="Close WhatsApp connect" onClick={() => setOpen(false)}><X size={17} /></button>
              <div className="whatsapp-emblem"><MessageCircle size={22} /></div>
              <p className="eyebrow">A more personal way to work</p>
              <h2 id="whatsapp-title">Your agent, on WhatsApp</h2>
              <p className="whatsapp-copy">Connect your Base44 agent once, then send it tasks from the chat you already use.</p>
              {error ? (
                <div className="whatsapp-error" role="alert">{error}</div>
              ) : (
                <div className="whatsapp-connect-body">
                  <div className="whatsapp-qr"><QRCodeSVG value={connectUrl} size={168} level="Q" includeMargin /></div>
                  <div className="whatsapp-steps">
                    <span><i>1</i>Open the secure Base44 link</span>
                    <span><i>2</i>Choose WhatsApp and authorize</span>
                    <span><i>3</i>Message your agent anytime</span>
                  </div>
                  <a className="whatsapp-primary" href={connectUrl} target="_blank" rel="noopener noreferrer">
                    Continue to WhatsApp <ArrowUpRight size={16} />
                  </a>
                  <div className="whatsapp-trust"><CheckCircle2 size={13} /> Authorization is handled by Base44. This app never sees your WhatsApp messages.</div>
                </div>
              )}
              <div className="whatsapp-mobile-note">On a computer? Scan the QR code with your phone's camera.</div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
