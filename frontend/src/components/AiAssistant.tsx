import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlarmClock, ArrowUp, CircleHelp, FileText, History, Inbox, Loader2, MapPin, Smartphone, Sparkles, SquarePen, Trash2, X, Wallet, Users, Wifi, Clock3 } from "lucide-react";
import { API, getToken, getUserFromToken } from "../api";
import AssistantChart, { type AssistantChartData } from "./AssistantChart";

// The FlowDesk AI Assistant: a chat panel opened from the side menu. Answers
// stream in from POST /ai/assistant/chat (Server-Sent Events). It only sees
// what the signed-in person can already see, and can save drafts (never
// submit) - an "Open draft" button appears when it does. Styles: .fda-* in
// styles.css.

type Msg = { role: "user" | "assistant"; text: string; notes?: string[]; drafts?: Array<{ kind: string; id: string; label: string }>; charts?: AssistantChartData[]; error?: boolean };
type Conv = { id: string; title: string | null; updated_at: string };
type DueClearance = { advance_id: string; reference: string; type: string; amount: number; currency: string; due_text: string; due_on_text: string; overdue: boolean; days_left: number; draft_clearance_id: string | null };
type Suggestion = {
  icon: typeof FileText; title: string; hint: string; ask: string;
  // Omitted = everyone. Otherwise only shown to a matching role or
  // department (JWT's free-text `department` field, matched loosely).
  forRoles?: string[];
  forDepartments?: RegExp[];
};

// Always-eligible, everyone-sees-these questions.
const GENERIC_SUGGESTIONS: Suggestion[] = [
  { icon: FileText, title: "How many advances do I have?", hint: "Totals and what's not cleared", ask: "How many advances do I have, and how many are not cleared?" },
  { icon: Inbox, title: "What's waiting for my approval?", hint: "Your Approval Inbox", ask: "What's waiting for my approval?" },
  { icon: MapPin, title: "Where is my latest advance?", hint: "Who it's with and since when", ask: "Where is my latest advance?" },
  { icon: CircleHelp, title: "How do I clear an advance?", hint: "Step-by-step help", ask: "How do I clear an advance?" }
];

// Only shown when the signed-in person's role/department matches - mixed
// into the pool below instead of always appearing, so two people in
// different departments don't see an identical set of four every time.
const TARGETED_SUGGESTIONS: Suggestion[] = [
  { icon: Smartphone, title: "How many people use the app?", hint: "Users and mobile app usage", ask: "How many users are active, and how many use the mobile app?", forRoles: ["ADMIN"] },
  { icon: Wallet, title: "What's waiting in Finance?", hint: "Capture, payments, deductions, refunds", ask: "What's waiting for Finance to action right now?", forDepartments: [/finance/i, /treasury/i] },
  { icon: Users, title: "What's waiting on HR?", hint: "Requests and approvals for HR Operations", ask: "What's waiting on HR right now?", forDepartments: [/human resources/i, /^hr\b/i] },
  { icon: Wifi, title: "Which service contracts are expiring soon?", hint: "Next 30 days, individual and company", ask: "Which service contracts are expiring in the next 30 days?", forDepartments: [/enterprise/i, /service/i] },
  { icon: Clock3, title: "What's my team's standby schedule?", hint: "This month's standby and call-outs", ask: "What's my team's standby schedule this month?", forDepartments: [/technical/i, /operations/i, /network/i] }
];

function matchesSuggestion(s: Suggestion, role: string, department: string): boolean {
  if (s.forRoles && !s.forRoles.includes(role)) return false;
  if (s.forDepartments && !s.forDepartments.some((re) => re.test(department))) return false;
  return true;
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Minimal, safe formatting for answers: paragraphs, bullet/numbered lists,
// simple | tables | (some models answer with them) and **bold** - rendered
// as React nodes, never as HTML.
function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
}
function Formatted({ text }: { text: string }) {
  const blocks: React.ReactElement[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;
  const flush = () => {
    if (table) {
      const [head, ...rows] = table;
      blocks.push(
        <div key={blocks.length} className="fda-table-wrap">
          <table className="fda-table">
            <thead><tr>{head.map((c, i) => <th key={i}>{renderInline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{renderInline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      table = null;
    }
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{renderInline(it)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length} style={{ margin: "4px 0 4px 18px", padding: 0 }}>{items}</ol> : <ul key={blocks.length} style={{ margin: "4px 0 4px 18px", padding: 0 }}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("|")) {
      if (list) flush();
      // The |---|---| line under the header carries no content.
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")) continue;
      (table ??= []).push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      continue;
    }
    if (table) flush();
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

type ModelChoice = { service: string; model: string; label: string };

// Opened from the side menu ("AI Assistant"); the parent owns open/closed.
// Drafts are saved behind the page's back, so the parent is told when one is
// (to reload its lists) and opens the draft itself from the "Open" button.
// The panel docks to the right of the page (the page shrinks to make room,
// via html.fda-docked + --fda-w in styles.css) and its left edge can be
// dragged. The width is remembered per browser.
const WIDTH_KEY = "fda-width";
const DEFAULT_WIDTH = 864;
const MIN_WIDTH = 360;
// Leave the page at least this much room (sidebar + a usable column).
const PAGE_MIN = 480;
function clampWidth(w: number) {
  const max = Math.max(MIN_WIDTH, window.innerWidth - PAGE_MIN);
  return Math.round(Math.min(Math.max(w, MIN_WIDTH), max));
}
function savedWidth() {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return w > 0 ? w : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export default function AiAssistant({ open, onClose, onDraftSaved, onOpenDraft }: { open: boolean; onClose: () => void; onDraftSaved: () => void; onOpenDraft: (kind: string, id: string) => void }) {
  const setOpen = (v: boolean) => { if (!v) onClose(); };
  const [status, setStatus] = useState<{
    configured: boolean; enabled?: boolean; daily_limit: number; used_today: number;
    // Picking your own model (Settings > AI Assistant allows it): the list and my pick.
    user_choice?: boolean; models?: ModelChoice[]; my_model?: { service: string; model: string } | null;
  } | null>(null);
  const [modelError, setModelError] = useState("");
  const [allowed, setAllowed] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [width, setWidth] = useState(savedWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  // While open, the page makes room for the panel instead of sitting under it.
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const apply = () => html.style.setProperty("--fda-w", `${clampWidth(widthRef.current)}px`);
    apply();
    html.classList.add("fda-docked");
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      html.classList.remove("fda-docked");
    };
  }, [open, width]);
  const keepWidth = (w: number) => {
    setWidth(w);
    try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private window: not remembered */ }
  };
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const html = document.documentElement;
    html.classList.add("fda-resizing");
    let w = widthRef.current;
    const move = (ev: PointerEvent) => { w = clampWidth(window.innerWidth - ev.clientX); setWidth(w); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      html.classList.remove("fda-resizing");
      keepWidth(w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function resizeKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 96 : 24;
    if (e.key === "ArrowLeft") { e.preventDefault(); keepWidth(clampWidth(widthRef.current + step)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); keepWidth(clampWidth(widthRef.current - step)); }
  }
  const [history, setHistory] = useState<Conv[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Advances to clear - shown on the welcome screen.
  const [dueList, setDueList] = useState<DueClearance[]>([]);
  useEffect(() => {
    if (!open) return;
    getJson("/ai/assistant/reminders").then((r) => setDueList(r?.clearances || [])).catch(() => setDueList([]));
  }, [open]);
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
      setMessages((c.messages || []).map((m: any) => ({ role: m.role, text: m.text, ...(m.charts?.length ? { charts: m.charts } : {}) })));
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
          else if (ev.type === "chart") patchLast((m) => ({ ...m, charts: [...(m.charts || []), ev.chart] }));
          else if (ev.type === "draft") {
            patchLast((m) => ({ ...m, drafts: [...(m.drafts || []), { kind: ev.kind, id: ev.id, label: ev.label }] }));
            onDraftSaved();
          }
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

  const notConfigured = Boolean(status && !status.configured);
  const switchedOff = status?.enabled === false;
  const left = status ? Math.max(0, status.daily_limit - status.used_today) : null;
  // Shuffled once per time the panel opens (not on every keystroke/render),
  // from a pool mixing the everyday questions with the ones that match this
  // person's role/department - so two people in different departments see
  // a different set, and the same person sees some variety across visits.
  const suggestions = useMemo(() => {
    const me = getUserFromToken();
    const role = me?.role || "";
    const department = me?.department || "";
    const eligible = TARGETED_SUGGESTIONS.filter((s) => matchesSuggestion(s, role, department));
    return shuffled([...GENERIC_SUGGESTIONS, ...eligible]).slice(0, 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "" = the admin's order; otherwise "service|model".
  const myModelValue = status?.my_model ? `${status.my_model.service}|${status.my_model.model}` : "";
  async function pickModel(value: string) {
    const [service, ...rest] = value.split("|");
    const pick = value ? { service, model: rest.join("|") } : null;
    setModelError("");
    try {
      await getJson("/ai/assistant/my-model", { method: "PUT", body: JSON.stringify({ pick }) });
      setStatus((s) => (s ? { ...s, my_model: pick } : s));
    } catch (e: any) {
      setModelError(e?.message || "Couldn't change the model");
    }
  }

  if (!open) return null;
  return (
    <div role="dialog" aria-label="FlowDesk Assistant" className="fda-panel">
      <div
        className="fda-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the assistant panel"
        aria-valuenow={clampWidth(width)}
        aria-valuemin={MIN_WIDTH}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onKeyDown={resizeKey}
        onDoubleClick={() => keepWidth(clampWidth(DEFAULT_WIDTH))}
      />
      <div className="fda-header">
        <div className="fda-logo"><Sparkles size={20} aria-hidden /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fda-kicker">
            AI Assistant
            <span className={`fda-status${notConfigured || !status ? " is-off" : ""}`}>{!status ? "Connecting" : switchedOff ? "Switched off" : notConfigured ? "Not set up" : "Online"}</span>
          </div>
          <div className="fda-title">Ask about FlowDesk</div>
          {status?.user_choice && (status.models?.length || 0) > 1 && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12, color: "var(--muted)" }}>
              Model
              <select
                value={myModelValue}
                onChange={(e) => void pickModel(e.target.value)}
                disabled={busy}
                aria-label="AI model"
                style={{ fontSize: 12, padding: "2px 6px", minHeight: 0, height: 26, maxWidth: 360, borderRadius: 6 }}
              >
                <option value="">Default</option>
                {status.models!.map((m) => <option key={`${m.service}|${m.model}`} value={`${m.service}|${m.model}`}>{m.label}</option>)}
              </select>
              {modelError && <span style={{ color: "#dc2626" }}>{modelError}</span>}
            </label>
          )}
        </div>
        <button type="button" className="fda-icon-btn" onClick={() => void loadHistory()} title="Past conversations" aria-label="Past conversations"><History size={16} /></button>
        <button type="button" className="fda-icon-btn" onClick={newChat} title="New conversation" aria-label="New conversation"><SquarePen size={16} /></button>
        <button type="button" className="fda-icon-btn" onClick={() => setOpen(false)} title="Close" aria-label="Close"><X size={16} /></button>
      </div>

      {showHistory && (
        <div className="fda-history">
          {history.length === 0 ? <div className="fda-history-empty">No past conversations.</div> : history.map((c) => (
            <div key={c.id} className="fda-history-row">
              <button type="button" className="fda-history-open" onClick={() => void openConversation(c.id)}>{c.title || "Conversation"}</button>
              <button type="button" className="fda-history-delete" onClick={() => void deleteConversation(c.id)} title="Delete" aria-label="Delete conversation"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="fda-body">
        {messages.length === 0 ? (
          <div className="fda-welcome">
            <div className="fda-hero"><Sparkles size={28} aria-hidden /></div>
            {notConfigured ? (
              <>
                <h3>{switchedOff ? "The assistant is switched off" : "The assistant isn't set up yet"}</h3>
                <p>{switchedOff ? "An administrator has turned it off for now." : "An administrator needs to connect it to an AI service before it can answer questions."}</p>
              </>
            ) : (
              <>
                <h3>What would you like to know?</h3>
                <p>Ask in plain language about your advances, clearances and approvals, or how anything in FlowDesk works.</p>
                {dueList.length > 0 && (
                  <div className="fda-due" role="region" aria-label="Advances to clear">
                    <div className="fda-due-head"><AlarmClock size={16} aria-hidden /> {dueList.length === 1 ? "You have an advance to clear" : `You have ${dueList.length} advances to clear`}</div>
                    {dueList.slice(0, 4).map((c) => (
                      <div key={c.advance_id} className={`fda-due-row${c.overdue ? " is-overdue" : c.days_left <= 3 ? " is-soon" : ""}`}>
                        <div className="fda-due-text">
                          <strong>{c.type}</strong> · {c.reference} · {c.currency === "LSL" ? "M" : c.currency === "USD" ? "$" : `${c.currency} `}{c.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          <span className="fda-due-when">{c.overdue ? `Overdue - was due ${c.due_on_text}` : `Clear by ${c.due_on_text} (${c.due_text})`}{c.draft_clearance_id ? " · draft started" : ""}</span>
                        </div>
                        <div className="fda-due-actions">
                          {c.draft_clearance_id && (
                            <button type="button" className="fda-draft-btn" onClick={() => onOpenDraft("clearance", c.draft_clearance_id!)}>Open draft</button>
                          )}
                          <button type="button" className="fda-draft-btn" disabled={busy} onClick={() => void ask(`Help me clear my ${c.type} advance ${c.reference} (advance_id ${c.advance_id}). It's ${c.due_text}.`)}>Clear it with me</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="fda-cards">
                  {suggestions.map((s) => (
                    <button key={s.title} type="button" className="fda-card" onClick={() => void ask(s.ask)} disabled={busy}>
                      <span className="fda-card-icon"><s.icon size={16} aria-hidden /></span>
                      <span>
                        <strong>{s.title}</strong>
                        <span className="fda-card-hint">{s.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="fda-disclaimer">AI-generated from the FlowDesk records you can see. Check before acting on it.</div>
              </>
            )}
          </div>
        ) : messages.map((m, i) => (
          m.role === "user" ? (
            <div key={i} className="fda-msg-user">{m.text}</div>
          ) : (
            <div key={i} className={`fda-msg-ai${m.error ? " is-error" : ""}`}>
              {(m.notes || []).map((n, j) => (
                <div key={j} className="fda-note">
                  {busy && i === messages.length - 1 && j === (m.notes || []).length - 1 && !m.text ? <Loader2 size={12} className="spin" /> : <span>✓</span>} {n}
                </div>
              ))}
              {(m.charts || []).map((c, j) => <AssistantChart key={j} chart={c} />)}
              {m.text ? <Formatted text={m.text} /> : busy && i === messages.length - 1 && !(m.notes || []).length ? (
                <div className="fda-note"><Loader2 size={13} className="spin" /> Thinking…</div>
              ) : null}
              {(m.drafts || []).map((d) => (
                <button key={d.id} type="button" className="fda-draft-btn" onClick={() => { setOpen(false); onOpenDraft(d.kind, d.id); }}>
                  Open {d.label} →
                </button>
              ))}
            </div>
          )
        ))}
        <div ref={endRef} />
      </div>

      <form className="fda-composer" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        <div className="fda-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
            placeholder={notConfigured ? "Not set up yet" : "Ask about FlowDesk or your requests…"}
            disabled={notConfigured || busy}
            rows={1}
          />
          <button type="submit" className="fda-send" disabled={busy || !input.trim() || notConfigured} aria-label="Send">
            {busy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={17} />}
          </button>
        </div>
        <div className="fda-hints">
          <span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>
          {left !== null && !notConfigured && <span>{left} question{left === 1 ? "" : "s"} left today · verify before acting</span>}
        </div>
      </form>
    </div>
  );
}
