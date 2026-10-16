import { useEffect, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { api } from "../api";
import { BrsRoleBadge } from "./BrsPeoplePicker";

// Comments on a BRS - reviewers' main tool, open to everyone involved. A
// comment can be about the whole BRS or one section.

function fmt(ts: string) {
  return new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function BrsComments({ docId, sections, myRole, onClose, onPosted }: {
  docId: string;
  sections: Array<{ id: string; title: string }>;
  myRole: string | null;
  onClose: () => void;
  onPosted?: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    api.brsComments(docId).then((r: any) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([])).finally(() => setLoading(false));
  }
  useEffect(load, [docId]);

  async function post() {
    if (!body.trim()) return;
    setPosting(true);
    setError(null);
    try {
      await api.addBrsComment(docId, { body: body.trim(), section_id: sectionId || null });
      setBody("");
      load();
      onPosted?.();
    } catch (e: any) {
      setError(e?.message || "Failed to post the comment");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="ep-panel" style={{ marginBottom: 16 }}>
      <div className="ep-panel-head">
        <div>
          <div className="ep-panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><MessageSquare size={16} /> Comments</div>
          <div className="ep-panel-sub">
            {myRole === "REVIEWER"
              ? "You're a reviewer on this BRS — read it and add your comments. You don't need to approve it."
              : "Review comments and replies from everyone working on this BRS."}
          </div>
        </div>
        <button className="ep-icon-btn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close comments"><X size={16} /></button>
      </div>
      <div className="ep-panel-body">
        {loading ? (
          <div className="ep-loading"><p>Loading comments…</p></div>
        ) : rows.length === 0 ? (
          <div className="ep-empty"><p>No comments yet.</p></div>
        ) : (
          <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
            {rows.map((c) => (
              <div key={c.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <strong style={{ fontSize: 13 }}>{c.author_name || "—"}</strong>
                  <BrsRoleBadge role={c.author_role} />
                  {c.section_title && <span style={{ fontSize: 12, color: "var(--muted)" }}>on “{c.section_title}”</span>}
                  <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: "auto" }}>{fmt(c.created_at)}</span>
                </div>
                <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{c.body}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>About</label>
            <select className="ep-form-select" style={{ width: "auto", minWidth: 220 }} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">The whole BRS</option>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </div>
          <textarea className="ep-form-textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment…" />
          {error && <div style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>}
          <div><button className="ep-btn" disabled={posting || !body.trim()} onClick={() => void post()}>{posting ? "Posting…" : "Post comment"}</button></div>
        </div>
      </div>
    </div>
  );
}
