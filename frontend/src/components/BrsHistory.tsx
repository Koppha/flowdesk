import { useEffect, useMemo, useState } from "react";
import { History, X } from "lucide-react";
import { api } from "../api";
import { RichTextField } from "../shared/RichTextField";
import { BrsRoleBadge } from "./BrsPeoplePicker";

// The BRS audit trail: every saved version of each section and of the
// Intake, plus every workflow event, with who did it and in what capacity
// (Creator / Owner / Co-writer / Contributor / Approver). Any saved version
// can be opened beside the one before it.

const KIND_LABEL: Record<string, string> = {
  CREATED: "Created",
  SECTION_SAVED: "Section saved",
  INTAKE_SAVED: "Intake saved",
  PEOPLE_CHANGED: "People changed",
  PHASE: "Sent on",
  ROUTED: "Routed for approval",
  APPROVAL_ACTION: "Approval decision",
  BASELINED: "Approved version",
  RETURNED: "Returned to Draft",
  REOPENED: "Reopened",
  AMENDMENT_STARTED: "Amendment started",
  SECTION_ADDED: "Section added",
  SECTION_REMOVED: "Section removed",
  REVIEWERS_CHANGED: "Reviewers changed",
  COMMENTED: "Comment"
};

function fmt(ts: string) {
  return new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function BrsHistory({ docId, versions, onClose }: {
  docId: string;
  versions: Array<{ id: string; version_number: number; baselined_at: string; baselined_by_name: string | null }>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | "CONTENT" | "EVENTS">("ALL");
  const [openRev, setOpenRev] = useState<any>(null);
  const [openVersion, setOpenVersion] = useState<any>(null);

  useEffect(() => {
    setLoading(true);
    api.brsHistory(docId).then((r: any) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([])).finally(() => setLoading(false));
  }, [docId]);

  const shown = useMemo(() => {
    const list = [...rows].reverse();
    if (filter === "CONTENT") return list.filter((r) => r.kind === "SECTION_SAVED" || r.kind === "INTAKE_SAVED");
    if (filter === "EVENTS") return list.filter((r) => r.kind !== "SECTION_SAVED" && r.kind !== "INTAKE_SAVED");
    return list;
  }, [rows, filter]);

  const contentCount = rows.filter((r) => r.kind === "SECTION_SAVED" || r.kind === "INTAKE_SAVED").length;

  async function openRevision(id: string) {
    setOpenVersion(null);
    try { setOpenRev(await api.brsHistoryItem(docId, id)); } catch { setOpenRev(null); }
  }
  async function openApprovedVersion(id: string) {
    setOpenRev(null);
    try { setOpenVersion(await api.brsVersionDetail(docId, id)); } catch { setOpenVersion(null); }
  }

  return (
    <div className="ep-panel" style={{ marginBottom: 16 }}>
      <div className="ep-panel-head">
        <div>
          <div className="ep-panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><History size={16} /> History</div>
          <div className="ep-panel-sub">Every saved version and every step, with who did it and in what role.</div>
        </div>
        <button className="ep-icon-btn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close history"><X size={16} /></button>
      </div>
      <div className="ep-panel-body">
        {versions.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 6 }}>Approved versions</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {versions.map((v) => (
                <button key={v.id} className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => void openApprovedVersion(v.id)}>
                  Version {v.version_number} · {fmt(v.baselined_at)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="ep-tabs">
          <button className={`ep-tab ${filter === "ALL" ? "active" : ""}`} onClick={() => setFilter("ALL")}>All <span className="ep-tab-count">{rows.length}</span></button>
          <button className={`ep-tab ${filter === "CONTENT" ? "active" : ""}`} onClick={() => setFilter("CONTENT")}>Saved versions <span className="ep-tab-count">{contentCount}</span></button>
          <button className={`ep-tab ${filter === "EVENTS" ? "active" : ""}`} onClick={() => setFilter("EVENTS")}>Workflow events <span className="ep-tab-count">{rows.length - contentCount}</span></button>
        </div>

        {loading ? (
          <div className="ep-loading"><p>Loading history…</p></div>
        ) : shown.length === 0 ? (
          <div className="ep-empty"><p>{rows.length ? "Nothing in this view." : "No history recorded yet — it starts with the next change."}</p></div>
        ) : (
          <div style={{ display: "grid", gap: 2 }}>
            {shown.map((r) => (
              <div key={r.id} style={{ display: "grid", gridTemplateColumns: "150px 1fr auto", gap: 12, alignItems: "center", padding: "8px 4px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>{fmt(r.created_at)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {r.actor_name || "System"} <BrsRoleBadge role={r.actor_role} />
                    <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{KIND_LABEL[r.kind] || r.kind}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--text)" }}>{r.summary}</div>
                </div>
                {r.has_content ? (
                  <button className="ep-btn-outline" style={{ fontSize: 12, padding: "3px 10px" }} onClick={() => void openRevision(r.id)}>View</button>
                ) : <span />}
              </div>
            ))}
          </div>
        )}

        {openRev && (
          <div style={{ marginTop: 16, border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13 }}>{openRev.section_title || "Intake"}</strong>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>saved {fmt(openRev.created_at)} by {openRev.actor_name || "—"}</span>
              <BrsRoleBadge role={openRev.actor_role} />
              <button className="ep-icon-btn" style={{ marginLeft: "auto" }} onClick={() => setOpenRev(null)} aria-label="Close"><X size={14} /></button>
            </div>
            {openRev.content_html != null ? (
              <div style={{ display: "grid", gridTemplateColumns: openRev.previous ? "1fr 1fr" : "1fr", gap: 12 }}>
                {openRev.previous && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 6 }}>
                      Before — {fmt(openRev.previous.created_at)}{openRev.previous.actor_name ? `, ${openRev.previous.actor_name}` : ""}
                    </div>
                    <RichTextField value={openRev.previous.content_html || ""} readOnly />
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 6 }}>{openRev.previous ? "This version" : "First saved version"}</div>
                  <RichTextField value={openRev.content_html || ""} readOnly />
                </div>
              </div>
            ) : openRev.intake_data ? (
              <div style={{ fontSize: 13, display: "grid", gap: 6 }}>
                {[["Requesting department", "department"], ["Product owner", "product_owner"], ["Target launch quarter", "target_quarter"], ["Programme type", "programme_type"]].map(([label, key]) => (
                  <div key={key}><span style={{ color: "var(--muted)" }}>{label}:</span> {openRev.intake_data[key] || "—"}</div>
                ))}
                <div style={{ color: "var(--muted)" }}>Business justification:</div>
                <RichTextField value={openRev.intake_data.business_justification || ""} readOnly />
              </div>
            ) : null}
          </div>
        )}

        {openVersion && (
          <div style={{ marginTop: 16, border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <strong style={{ fontSize: 13 }}>Approved version {openVersion.version_number}</strong>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{fmt(openVersion.baselined_at)}</span>
              <button className="ep-icon-btn" style={{ marginLeft: "auto" }} onClick={() => setOpenVersion(null)} aria-label="Close"><X size={14} /></button>
            </div>
            {(openVersion.snapshot?.sections || []).map((s: any, i: number) => (
              <div key={i} className="brs-section-card">
                <div className="brs-section-card-title" style={{ marginBottom: 8 }}>{s.title}</div>
                <RichTextField value={s.content_html || ""} readOnly />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
