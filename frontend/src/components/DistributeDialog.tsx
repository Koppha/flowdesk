import React, { useEffect, useMemo, useState } from "react";
import { Search, Send, User, Users, X } from "lucide-react";
import { api } from "../api";

// Manual distribution of a fully approved BRS or Change Request: the
// requester picks people and/or whole groups (Division / Department /
// Section, as named in the UI) and an optional message. Recipients are
// emailed and get read-only access in FlowDesk ("Shared with me").

type DocType = "BRS" | "CHANGE_REQUEST";
type GroupOption = { key: string; kind: "division" | "department" | "section"; value: string; name: string; parent: string | null; members: number };
type Person = { id: string; full_name: string | null; email: string };
type HistoryItem = {
  id: string; message: string | null; created_at: string; recipient_count: number; distributed_by_name: string | null;
  targets: { people?: string[]; divisions?: string[]; departments?: string[]; sections?: string[] };
};

const KIND_LABEL = { division: "Division", department: "Department", section: "Section" } as const;

export default function DistributeDialog(props: { docType: DocType; docId: string; title: string; onClose: () => void; onDone?: (count: number) => void }) {
  const { docType, docId, title, onClose, onDone } = props;
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [search, setSearch] = useState("");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [groupKeys, setGroupKeys] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.companyDirectory().then((rows: any) => setPeople(Array.isArray(rows) ? rows : [])).catch(() => {});
    api.distributionOptions().then((o: any) => {
      const list: GroupOption[] = [
        ...(o?.divisions || []).map((d: any) => ({ key: `division:${d.name}`, kind: "division" as const, value: d.name, name: d.name, parent: d.company, members: d.members })),
        ...(o?.departments || []).map((d: any) => ({ key: `department:${d.id}`, kind: "department" as const, value: d.id, name: d.name, parent: d.parent, members: d.members })),
        ...(o?.sections || []).map((d: any) => ({ key: `section:${d.id}`, kind: "section" as const, value: d.id, name: d.name, parent: d.parent, members: d.members }))
      ];
      setGroups(list.filter((g) => g.members > 0));
    }).catch(() => {});
    api.distributionHistory(docType, docId).then((r: any) => setHistory(r?.items || [])).catch(() => {});
  }, [docType, docId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !sending) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  const q = search.toLowerCase().trim();
  const matchedGroups = useMemo(
    () => groups.filter((g) => !q || g.name.toLowerCase().includes(q) || (g.parent || "").toLowerCase().includes(q)).slice(0, q ? 40 : 12),
    [groups, q]
  );
  const matchedPeople = useMemo(
    () => [...people]
      .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email))
      .filter((p) => !q || (p.full_name || "").toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
      .slice(0, q ? 40 : 12),
    [people, q]
  );

  const selectedGroups = groups.filter((g) => groupKeys.includes(g.key));
  const selectedPeople = userIds.map((id) => people.find((p) => p.id === id)).filter(Boolean) as Person[];
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const nothingChosen = !selectedGroups.length && !selectedPeople.length;

  async function send() {
    setSending(true);
    setError(null);
    try {
      const res: any = await api.distribute(docType, docId, {
        user_ids: userIds,
        divisions: selectedGroups.filter((g) => g.kind === "division").map((g) => g.value),
        department_ids: selectedGroups.filter((g) => g.kind === "department").map((g) => g.value),
        section_ids: selectedGroups.filter((g) => g.kind === "section").map((g) => g.value),
        message: message.trim() || null
      });
      onDone?.(res?.recipient_count ?? 0);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Failed to distribute.");
    } finally {
      setSending(false);
    }
  }

  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", fontSize: 13, cursor: "pointer", borderRadius: 6 };
  const groupTitle = (t: string) => (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--muted)", padding: "8px 8px 4px" }}>{t}</div>
  );
  const describeTargets = (t: HistoryItem["targets"]) =>
    [...(t.divisions || []), ...(t.departments || []), ...(t.sections || []), ...(t.people || [])].filter(Boolean).join(", ") || "—";

  return (
    <div className="ep-modal-overlay" onClick={() => { if (!sending) onClose(); }}>
      <div className="ep-modal" style={{ maxWidth: 640, width: "calc(100vw - 32px)" }} onClick={(e) => e.stopPropagation()}>
        <div className="ep-modal-head">
          <div>
            <h2 className="ep-modal-title">Distribute</h2>
            <p className="ep-modal-sub">{title}</p>
          </div>
          <button className="ep-icon-btn" onClick={onClose} disabled={sending} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="ep-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            Recipients are emailed and can view the approved document and its PDF in FlowDesk under "Shared with me".
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 32, border: "1px solid var(--border)", borderRadius: 8, padding: 6 }}>
            {nothingChosen && <span style={{ fontSize: 13, color: "var(--muted)", padding: "4px 6px" }}>Nobody chosen yet — search below.</span>}
            {selectedGroups.map((g) => (
              <span key={g.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, background: "#e0e7ff", color: "#3730a3" }}>
                <Users size={13} /> {g.name} <span style={{ fontWeight: 400, opacity: 0.75 }}>· {KIND_LABEL[g.kind]} · {g.members}</span>
                <button type="button" aria-label={`Remove ${g.name}`} onClick={() => setGroupKeys((k) => k.filter((x) => x !== g.key))} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 2, display: "inline-flex", color: "inherit" }}><X size={12} /></button>
              </span>
            ))}
            {selectedPeople.map((p) => (
              <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, background: "#f1f5f9", color: "#0f172a" }}>
                <User size={13} /> {p.full_name || p.email}
                <button type="button" aria-label={`Remove ${p.full_name || p.email}`} onClick={() => setUserIds((u) => u.filter((x) => x !== p.id))} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 2, display: "inline-flex", color: "inherit" }}><X size={12} /></button>
              </span>
            ))}
          </div>

          <div>
            <div className="ep-search" style={{ width: "100%", boxSizing: "border-box" }}>
              <Search size={14} />
              <input placeholder="Search people, divisions, departments, sections…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} autoFocus />
            </div>
            <div style={{ border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 8px 8px", maxHeight: 260, overflowY: "auto", padding: "0 4px 6px" }}>
              {matchedGroups.length > 0 && groupTitle("Groups")}
              {matchedGroups.map((g) => (
                <label key={g.key} style={rowStyle}>
                  <input type="checkbox" checked={groupKeys.includes(g.key)} onChange={() => setGroupKeys((k) => toggle(k, g.key))} />
                  <Users size={14} color="#4f46e5" />
                  <span style={{ flex: 1 }}>{g.name} <span style={{ color: "var(--muted)", fontSize: 12 }}>{KIND_LABEL[g.kind]}{g.parent ? ` · ${g.parent}` : ""}</span></span>
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>{g.members} {g.members === 1 ? "person" : "people"}</span>
                </label>
              ))}
              {matchedPeople.length > 0 && groupTitle("People")}
              {matchedPeople.map((p) => (
                <label key={p.id} style={rowStyle}>
                  <input type="checkbox" checked={userIds.includes(p.id)} onChange={() => setUserIds((u) => toggle(u, p.id))} />
                  <User size={14} color="#64748b" />
                  <span style={{ flex: 1 }}>{p.full_name || p.email}</span>
                </label>
              ))}
              {!matchedGroups.length && !matchedPeople.length && <div style={{ padding: 12, fontSize: 13, color: "var(--muted)" }}>Nothing matches "{search}".</div>}
              {!q && <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--muted)" }}>Type to search everyone.</div>}
            </div>
          </div>

          <div className="ep-form-group" style={{ margin: 0 }}>
            <label>Message (optional)</label>
            <textarea className="ep-form-textarea" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. For your information and planning." />
          </div>

          {history.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 4 }}>Already distributed</div>
              {history.map((h) => (
                <div key={h.id} style={{ fontSize: 12, padding: "4px 0", borderTop: "1px solid var(--border)" }}>
                  {new Date(h.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                  {" — "}{h.recipient_count} {h.recipient_count === 1 ? "person" : "people"} ({describeTargets(h.targets)})
                  {h.distributed_by_name ? ` by ${h.distributed_by_name}` : ""}
                </div>
              ))}
            </div>
          )}

          {error && <div style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>}
        </div>
        <div className="ep-modal-footer">
          <button className="ep-btn-outline" onClick={onClose} disabled={sending}>Cancel</button>
          <button className="ep-btn" onClick={() => void send()} disabled={sending || nothingChosen}>
            <Send size={14} /> {sending ? "Sending…" : "Distribute"}
          </button>
        </div>
      </div>
    </div>
  );
}
