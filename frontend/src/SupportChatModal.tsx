import { useEffect, useRef, useState } from "react";
import { MessageCircle, Send, X } from "lucide-react";
import { api } from "./api";

// A Help & Support chat opened from the Approval Inbox. The support team
// (asAgent) answers a staff member's conversation and can close it; anyone
// else sees their own chat with support (opening it marks support's replies
// as read). Same conversations as the app's Profile > Help & support.

type Msg = { id: string; body: string; from_agent: boolean; created_at: string; sender_name: string | null };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export default function SupportChatModal(props: { conversationId: string; asAgent: boolean; name: string; onClose: () => void }) {
  const { conversationId, asAgent, name, onClose } = props;
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [status, setStatus] = useState<string>("OPEN");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const r: any = asAgent ? await api.supportConversation(conversationId) : await api.supportMine();
      setMsgs(r.messages || []);
      setStatus(r.conversation?.status || "OPEN");
    } catch (e: any) {
      setError(e?.message || "Couldn't load the chat.");
    }
  }

  // New messages every 10 seconds while it's open.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, asAgent]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [msgs?.length]);

  async function send() {
    const body = reply.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      const r: any = asAgent ? await api.supportReply(conversationId, body) : await api.supportWrite(body);
      setMsgs(r.messages || []);
      setReply("");
      setStatus("OPEN");
    } catch (e: any) {
      setError(e?.message || "Couldn't send it.");
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setBusy(true);
    try {
      await api.supportClose(conversationId);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Couldn't close it.");
      setBusy(false);
    }
  }

  return (
    <div className="tracking-modal-backdrop" role="dialog" aria-modal="true" aria-label="Help & Support chat" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(640px, calc(100vw - 32px))", maxHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "0 24px 60px rgba(15, 23, 42, 0.25)", overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <MessageCircle size={18} aria-hidden />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>{asAgent ? name : "FlowDesk support"}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Help &amp; Support{status === "CLOSED" ? " · closed" : ""}</div>
          </div>
          {asAgent && status === "OPEN" && (
            <button type="button" className="button small-button button-subtle" disabled={busy} onClick={() => void close()}>
              Close conversation
            </button>
          )}
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10, minHeight: 240 }}>
          {msgs === null ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</div>
          ) : msgs.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>No messages yet.</div>
          ) : (
            msgs.map((m) => {
              // My side: the support team's messages for an agent, my own otherwise.
              const mine = m.from_agent === asAgent;
              return (
                <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "80%" }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 3, textAlign: mine ? "right" : "left" }}>
                    {m.from_agent ? `${m.sender_name || "Support"} · Support` : m.sender_name || "Staff member"} · {when(m.created_at)}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.45, padding: "9px 12px", borderRadius: 12, background: mine ? "#2563eb" : "var(--surface-soft)", color: mine ? "#fff" : "var(--text)", border: mine ? "none" : "1px solid var(--border)" }}>
                    {m.body}
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottom} />
        </div>

        <div style={{ borderTop: "1px solid var(--border)", padding: 12, display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={asAgent ? "Write a reply…" : "Write to support…"}
            rows={2}
            maxLength={4000}
            style={{ flex: 1, resize: "vertical", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: 13.5 }}
          />
          <button type="button" className="button small-button button-primary" disabled={busy || !reply.trim()} onClick={() => void send()}>
            <Send size={14} aria-hidden /> Send
          </button>
        </div>
        {error && <div style={{ padding: "0 12px 12px", color: "#dc2626", fontSize: 12.5 }}>{error}</div>}
      </div>
    </div>
  );
}
