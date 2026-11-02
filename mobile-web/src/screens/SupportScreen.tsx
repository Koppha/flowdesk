import { useCallback, useEffect, useRef, useState } from "react";
import { req } from "../api";
import { href } from "../router";
import { formatDateTime } from "../ui";

// Help & Support: chat with the support team (admins + whoever an admin adds
// as an agent) - backend modules/support, at /mobile-app/support. Agents also
// get the Support inbox with everyone's conversations.

type Message = { id: string; body: string; from_agent: boolean; created_at: string; sender_name: string | null; sender_id: string | null };
type Mine = { isAgent: boolean; conversation: { id: string; status: string } | null; messages: Message[] };
type ConvRow = { id: string; status: string; last_message_at: string; full_name: string | null; department: string | null; last_body: string | null; last_from_agent: boolean | null };
type ConvDetail = { conversation: { id: string; status: string; user: { fullName: string | null; email: string; department: string | null; phone: string | null } }; messages: Message[] };

const POLL_MS = 5000;

/** Re-runs `load` every few seconds while the page is visible. */
function usePolling(load: () => Promise<void>) {
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
}

function Thread({ messages, mineIsAgent }: { messages: Message[]; mineIsAgent: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages.length]);
  if (!messages.length) return <p className="muted small center">No messages yet.</p>;
  return (
    <div className="chat">
      {messages.map((m) => {
        const mine = m.from_agent === mineIsAgent;
        return (
          <div key={m.id} className={`bubble ${mine ? "mine" : "theirs"}`}>
            {!mine && <span className="bubble-who">{m.from_agent ? `${m.sender_name || "Support"} · Support` : m.sender_name || "Staff member"}</span>}
            <span className="pre">{m.body}</span>
            <span className="bubble-time">{formatDateTime(m.created_at)}</span>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function Composer({ onSend, placeholder }: { onSend: (body: string) => Promise<void>; placeholder: string }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send() {
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSend(body.trim());
      setBody("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="composer">
      {error && <p className="error">{error}</p>}
      <div className="composer-row">
        <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder} />
        <button type="button" className="primary send-btn" onClick={send} disabled={busy || !body.trim()}>{busy ? "…" : "Send"}</button>
      </div>
    </div>
  );
}

/** My own chat with support. */
export default function SupportScreen() {
  const [mine, setMine] = useState<Mine | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setMine(await req<Mine>("/mobile-app/support/me"));
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  usePolling(load);

  if (error && !mine) return <p className="error">{error}</p>;
  if (!mine) return <p className="muted center">Loading…</p>;

  return (
    <div className="stack">
      {mine.isAgent && (
        <a className="action-tile" href={href({ name: "supportInbox" })}>
          <strong>Support inbox</strong>
          <span className="muted small">Everyone's conversations - you're on the support team</span>
        </a>
      )}
      <p className="muted small">
        Ask anything about FlowDesk. The support team replies here, and you'll get a notification.
        {mine.conversation?.status === "CLOSED" ? " Your last conversation was closed - writing again starts a new one." : ""}
      </p>
      <Thread messages={mine.messages} mineIsAgent={false} />
      <Composer
        placeholder="Type your message"
        onSend={async (body) => {
          const r = await req<{ messages: Message[]; conversationId: string }>("/mobile-app/support/me/messages", { method: "POST", body: JSON.stringify({ body }) });
          setMine((m) => (m ? { ...m, conversation: { id: r.conversationId, status: "OPEN" }, messages: r.messages } : m));
        }}
      />
    </div>
  );
}

/** Agents: everyone's conversations. */
export function SupportInbox() {
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [rows, setRows] = useState<ConvRow[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setRows(await req<ConvRow[]>(`/mobile-app/support/conversations?status=${status}`));
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [status]);
  usePolling(load);

  return (
    <div className="stack">
      <div className="segmented">
        <button type="button" className={status === "open" ? "on" : ""} onClick={() => { setRows(null); setStatus("open"); }}>Open</button>
        <button type="button" className={status === "closed" ? "on" : ""} onClick={() => { setRows(null); setStatus("closed"); }}>Closed</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!rows && !error && <p className="muted center">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted center">No {status} conversations.</p>}
      {rows && rows.length > 0 && (
        <ul className="list">
          {rows.map((c) => (
            <li key={c.id} className={c.status === "OPEN" && c.last_from_agent === false ? "highlight" : undefined}>
              <a href={href({ name: "supportChat", id: c.id })} className="row-link">
                <span className="grow">
                  <strong>{c.full_name || "Staff member"}</strong>
                  <span className="muted small">{c.last_from_agent ? "You: " : ""}{(c.last_body || "").slice(0, 80)}</span>
                  <span className="muted small">{c.department ? `${c.department} · ` : ""}{formatDateTime(c.last_message_at)}</span>
                </span>
                {c.status === "OPEN" && c.last_from_agent === false && <span className="pill accent">Waiting</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Agents: one conversation. */
export function SupportChat({ id }: { id: string }) {
  const [d, setD] = useState<ConvDetail | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setD(await req<ConvDetail>(`/mobile-app/support/conversations/${id}`));
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);
  usePolling(load);

  if (error && !d) return <p className="error">{error}</p>;
  if (!d) return <p className="muted center">Loading…</p>;
  const u = d.conversation.user;

  return (
    <div className="stack">
      <section className="card stack-sm">
        <strong>{u.fullName || u.email}</strong>
        <span className="muted small">{[u.department, u.email].filter(Boolean).join(" · ")}</span>
        {u.phone && <a href={`tel:${u.phone}`} className="small">{u.phone}</a>}
        {d.conversation.status === "OPEN" ? (
          <button type="button" className="link-btn" onClick={async () => { await req(`/mobile-app/support/conversations/${id}/close`, { method: "POST" }); await load(); }}>
            Close conversation
          </button>
        ) : (
          <span className="pill muted">Closed - replying reopens it</span>
        )}
      </section>
      <Thread messages={d.messages} mineIsAgent />
      <Composer
        placeholder="Reply"
        onSend={async (body) => {
          const r = await req<{ messages: Message[] }>(`/mobile-app/support/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ body }) });
          setD((x) => (x ? { ...x, conversation: { ...x.conversation, status: "OPEN" }, messages: r.messages } : x));
        }}
      />
    </div>
  );
}
