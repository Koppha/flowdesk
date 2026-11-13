import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil, Users } from "lucide-react";
import { API, getToken } from "../api";

// Working together on a BRS or Change Request: who else has it open, who is
// editing which section, and what to do when two people saved the same thing.

export type PresentPerson = { user_id: string; name: string | null; section_key: string | null; editing: boolean };

export async function sendJson(method: string, path: string, body?: unknown, keepalive = false): Promise<{ ok: boolean; status: number; data: any }> {
  const token = getToken();
  const r = await fetch(`${API}${path}`, {
    method,
    keepalive,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
}

// Checks in every 5 seconds (and at once when what you're editing changes);
// `onData` gets the server's answer (people + what changed) each time.
export function usePresence<T extends { people: PresentPerson[] }>(
  path: string | null,
  state: { section_key: string | null; editing: boolean },
  onData: (data: T) => void
) {
  const [people, setPeople] = useState<PresentPerson[]>([]);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!path) { setPeople([]); return; }
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await sendJson("POST", path, { section_key: stateRef.current.section_key, editing: stateRef.current.editing });
        if (!stopped && r.ok && r.data) { setPeople(r.data.people || []); onDataRef.current(r.data as T); }
      } catch { /* offline for a moment */ }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      void sendJson("POST", path, { leaving: true }, true).catch(() => {});
    };
  }, [path]);

  // Tell the others straight away when you start or stop editing a section.
  useEffect(() => {
    if (!path) return;
    void sendJson("POST", path, state).then((r) => { if (r.ok && r.data) { setPeople(r.data.people || []); onDataRef.current(r.data as T); } }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, state.section_key, state.editing]);

  return people;
}

const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#6250d6", "#e34948", "#008300", "#c98500", "#d55181"];
const initials = (n: string | null) => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
const colorOf = (id: string) => COLORS[[...id].reduce((t, c) => t + c.charCodeAt(0), 0) % COLORS.length];

export function PresenceBar({ people, sectionTitle }: { people: PresentPerson[]; sectionTitle: (key: string) => string | null }) {
  if (!people.length) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 12px", borderRadius: 8, background: "#f0f7ff", border: "1px solid #cfe3fb", fontSize: 12.5, color: "#1e3a5f" }}>
      <Users size={14} />
      <span style={{ fontWeight: 600 }}>Working on this now:</span>
      {people.map((p) => {
        const where = p.section_key ? sectionTitle(p.section_key) : null;
        return (
          <span key={p.user_id} title={p.editing && where ? `${p.name} is editing "${where}"` : `${p.name} has this open`}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#fff", border: "1px solid #dbe7f5", borderRadius: 99, padding: "2px 8px 2px 2px" }}>
            <span style={{ width: 20, height: 20, borderRadius: 99, background: colorOf(p.user_id), color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{initials(p.name)}</span>
            {p.name || "Someone"}
            {p.editing && where && <span style={{ color: "#92400e" }}>· editing {where}</span>}
          </span>
        );
      })}
    </div>
  );
}

// "Lerato is editing this section" on the section itself.
export function EditingBadge({ people, sectionKey }: { people: PresentPerson[]; sectionKey: string }) {
  const here = people.filter((p) => p.editing && p.section_key === sectionKey);
  if (!here.length) return null;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "3px 8px", margin: "4px 0" }}>
      <Pencil size={12} /> {here.map((p) => p.name || "Someone").join(", ")} {here.length > 1 ? "are" : "is"} editing this section right now - your changes are kept separately and checked when you save.
    </div>
  );
}

// Two people saved the same thing: keep mine, take theirs, or go back.
export function ConflictDialog(props: { title: string; by: string | null; theirs: ReactNode; onKeepMine: () => void; onTakeTheirs: () => void; onCancel: () => void }) {
  return (
    <div className="ep-modal-overlay">
      <div className="ep-modal" style={{ maxWidth: 720, width: "94vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="ep-modal-head">
          <div>
            <h3 className="ep-modal-title">{props.by || "Someone"} also changed {props.title}</h3>
            <p className="ep-modal-sub">They saved it while you were editing. Choose which version to keep - nothing has been saved yet.</p>
          </div>
        </div>
        <div className="ep-modal-body" style={{ maxHeight: "56vh", overflow: "auto" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Their version</div>
          <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 10, fontSize: 13 }}>{props.theirs}</div>
        </div>
        <div className="ep-modal-footer">
          <button type="button" className="ep-btn-outline" onClick={props.onCancel}>Go back to my edit</button>
          <button type="button" className="ep-btn-outline" onClick={props.onTakeTheirs}>Use theirs (drop mine)</button>
          <button type="button" className="ep-btn" onClick={props.onKeepMine}>Keep mine (replace theirs)</button>
        </div>
      </div>
    </div>
  );
}
