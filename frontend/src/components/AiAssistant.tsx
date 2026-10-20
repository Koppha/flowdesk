import React, { useEffect, useRef, useState } from "react";
import { History, Loader2, MessageCircleQuestion, Plus, Send, Sparkles, Trash2, X } from "lucide-react";
import { API, getToken } from "../api";

// The FlowDesk AI Assistant: a chat panel opened from a floating button.
// Answers stream in from POST /ai/assistant/chat (Server-Sent Events). It
// only sees what the signed-in person can already see, and can save drafts
// (never submit) - an "Open draft" button appears when it does.

type Msg = { role: "user" | "assistant"; text: string; notes?: string[]; drafts?: Array<{ kind: string; id: string; label: string }>; error?: boolean };
type Conv = { id: string; title: string | null; updated_at: string };

const SUGGESTIONS = [
  "Where is my latest advance?",
  "What's waiting for my approval?",
  "How do I clear an advance?",
  "What does Amount To Be Expensed mean?"
];

// Minimal, safe formatting for answers: paragraphs, bullet/numbered lists
// and **bold** - rendered as React nodes, never as HTML.
function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
}
function Formatted({ text }: { text: string }) {
  const blocks: React.ReactElement[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{renderInline(it)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length} style={{ margin: "4px 0 4px 18px", padding: 0 }}>{items}</ol> : <ul key={blocks.length} style={{ margin: "4px 0 4px 18px", padding: 0 }}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push((bullet || numbered)![1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(heading
      ? <div key={blocks.length} style={{ fontWeight: 700, marginTop: 6 }}>{renderInline(heading[1])}</div>
      : <p key={blocks.length} style={{ margin: "4px 0" }}>{renderInline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

async function getJson(path: string, init?: RequestInit) {
  const token = getToken();
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...(init?.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

// Opened from the side menu ("AI Assistant"); the parent owns open/closed.
export default function AiAssistant({ open, onClose, onOpenAdvances, onOpenClearances }: { open: boolean; onClose: () => void; onOpenAdvances: () => void; onOpenClearances: () => void }) {
  const setOpen = (v: boolean) => { if (!v) onClose(); };
  const [status, setStatus] = useState<{ configured: boolean; daily_limit: number; used_today: number } | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<Conv[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getJson("/ai/assistant/status").then(setStatus).catch((e) => { if (/access|forbidden|403/i.test(String(e.message))) setAllowed(false); });
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, open]);

  if (!allowed) return null;

  function newChat() {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    setShowHistory(false);
  }
  async function loadHistory() {
    setShowHistory((v) => !v);
    try { setHistory((await getJson("/ai/assistant/conversations")).items || []); } catch { setHistory([]); }
  }
  async function openConversation(id: string) {
    try {
      const c = await getJson(`/ai/assistant/conversations/${id}`);
      setConversationId(id);
      setMessages((c.messages || []).map((m: any) => ({ role: m.role, text: m.text })));
      setShowHistory(false);
    } catch { /* ignore */ }
  }
  async function deleteConversation(id: string) {
    await getJson(`/ai/assistant/conversations/${id}`, { method: "DELETE" }).catch(() => {});
    setHistory((h) => h.filter((c) => c.id !== id));
    if (conversationId === id) newChat();
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: question }, { role: "assistant", text: "", notes: [] }]);
    const patchLast = (fn: (m: Msg) => Msg) => setMessages((all) => all.map((m, i) => (i === all.length - 1 ? fn(m) : m)));
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const token = getToken();
      const res = await fetch(`${API}/ai/assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message: question, conversation_id: conversationId }),
        signal: controller.signal
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `The assistant is unavailable (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === "conversation") setConversationId(ev.id);
          else if (ev.type === "text") patchLast((m) => ({ ...m, text: m.text + ev.delta }));
          else if (ev.type === "tool") patchLast((m) => ({ ...m, notes: [...(m.notes || []), ev.label] }));
          else if (ev.type === "draft") patchLast((m) => ({ ...m, drafts: [...(m.drafts || []), { kind: ev.kind, id: ev.id, label: ev.label }] }));
          else if (ev.type === "error") patchLast((m) => ({ ...m, text: (m.text ? m.text + "\n\n" : "") + ev.message, error: true }));
        }
      }
      setStatus((s) => (s ? { ...s, used_today: s.used_today + 1 } : s));
    } catch (e: any) {
      if (e?.name !== "AbortError") patchLast((m) => ({ ...m, text: e?.message || "Something went wrong.", error: true }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const notConfigured = status && !status.configured;
  const left = status ? Math.max(0, status.daily_limit - status.used_today) : null;

  return (
    <>
      {open && (
        <div role="dialog" aria-label="FlowDesk Assistant" style={{ position: "fixed", right: 16, bottom: 16, zIndex: 900, width: "min(420px, calc(100vw - 32px))", height: "min(620px, calc(100vh - 32px))", display: "flex", flexDirection: "column", background: "var(--surface, #fff)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "0 18px 50px rgba(15,23,42,0.25)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)", background: "linear-gradient(135deg, #4f46e5, #2563eb)", color: "#fff" }}>
            <Sparkles size={16} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>FlowDesk Assistant</div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button type="button" onClick={() => void loadHistory()} title="Past conversations" style={iconBtn}><History size={15} /></button>
              <button type="button" onClick={newChat} title="New conversation" style={iconBtn}><Plus size={15} /></button>
              <button type="button" onClick={() => setOpen(false)} title="Close" style={iconBtn}><X size={15} /></button>
            </div>
          </div>

          {showHistory && (
            <div style={{ borderBottom: "1px solid var(--border)", maxHeight: 220, overflowY: "auto", padding: 6 }}>
              {history.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--muted)", padding: 8 }}>No past conversations.</div> : history.map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6 }}>
                  <button type="button" onClick={() => void openConversation(c.id)} style={{ flex: 1, textAlign: "left", border: "none", background: "transparent", cursor: "pointer", fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title || "Conversation"}</button>
                  <button type="button" onClick={() => void deleteConversation(c.id)} title="Delete" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--muted)" }}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}

          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {notConfigured ? (
              <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text)" }}>The assistant isn't set up yet.</strong><br />
                An administrator needs to connect it to Claude before it can answer questions.
              </div>
            ) : messages.length === 0 ? (
              <div>
                <div style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 10 }}>
                  Hi! I can explain how FlowDesk works, find your advances, clearances and approvals, run reports you have access to, and save drafts for you to review and submit.
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => void ask(s)} style={{ textAlign: "left", border: "1px solid var(--border)", background: "var(--surface-2, #f8fafc)", borderRadius: 8, padding: "8px 10px", cursor: "pointer", fontSize: 13, color: "var(--text)", display: "flex", gap: 8, alignItems: "center" }}>
                      <MessageCircleQuestion size={14} /> {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "stretch", maxWidth: m.role === "user" ? "85%" : "100%" }}>
                {m.role === "user" ? (
                  <div style={{ background: "#2563eb", color: "#fff", padding: "8px 12px", borderRadius: "12px 12px 2px 12px", fontSize: 13.5, whiteSpace: "pre-wrap" }}>{m.text}</div>
                ) : (
                  <div style={{ fontSize: 13.5, lineHeight: 1.5, color: m.error ? "#b91c1c" : "var(--text)" }}>
                    {(m.notes || []).map((n, j) => (
                      <div key={j} style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
                        {busy && i === messages.length - 1 && j === (m.notes || []).length - 1 && !m.text ? <Loader2 size={12} className="spin" /> : <span>✓</span>} {n}
                      </div>
                    ))}
                    {m.text ? <Formatted text={m.text} /> : busy && i === messages.length - 1 && !(m.notes || []).length ? (
                      <div style={{ fontSize: 12.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}><Loader2 size={13} className="spin" /> Thinking…</div>
                    ) : null}
                    {(m.drafts || []).map((d) => (
                      <button key={d.id} type="button" onClick={() => { setOpen(false); (d.kind === "clearance" ? onOpenClearances : onOpenAdvances)(); }}
                        style={{ marginTop: 6, border: "1px solid #2563eb", color: "#2563eb", background: "transparent", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
                        Open {d.label} →
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <form onSubmit={(e) => { e.preventDefault(); void ask(input); }} style={{ borderTop: "1px solid var(--border)", padding: 10, display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
              placeholder={notConfigured ? "Not set up yet" : "Ask about FlowDesk or your requests…"}
              disabled={Boolean(notConfigured) || busy}
              rows={1}
              style={{ flex: 1, resize: "none", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 11px", fontSize: 13.5, fontFamily: "inherit", maxHeight: 120, background: "var(--surface, #fff)", color: "var(--text)" }}
            />
            <button type="submit" disabled={busy || !input.trim() || Boolean(notConfigured)} aria-label="Send" style={{ border: "none", borderRadius: 10, padding: "9px 12px", background: "#2563eb", color: "#fff", cursor: "pointer", opacity: busy || !input.trim() ? 0.5 : 1 }}>
              {busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            </button>
          </form>
          {left !== null && !notConfigured && (
            <div style={{ fontSize: 11, color: "var(--muted)", padding: "0 12px 8px" }}>
              {left} question{left === 1 ? "" : "s"} left today · Answers can be wrong — check before you act.
            </div>
          )}
        </div>
      )}
    </>
  );
}

const iconBtn: React.CSSProperties = { border: "none", background: "rgba(255,255,255,0.18)", color: "#fff", borderRadius: 6, padding: 5, cursor: "pointer", display: "inline-flex" };
