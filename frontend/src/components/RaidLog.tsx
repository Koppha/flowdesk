import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Download, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, downloadBlob, type RaidDocType } from "../api";
import { confirmAction, showNotice } from "../alerts";
import { ApproverCombobox, type DirectoryUser } from "../shared/ApproverCombobox";

// RAID log (Risks, Assumptions, Issues, Dependencies) for one BRS, Change
// Request or Computer Request, with Excel export. Everyone working on the
// document can add and update items; the history records each change.

type Level = "HIGH" | "MEDIUM" | "LOW";
type Item = {
  id: string; ref: string; item_type: "RISK" | "ASSUMPTION" | "ISSUE" | "DEPENDENCY"; title: string; description: string | null;
  likelihood: Level | null; impact: Level | null; action: string | null; owner_user_id: string | null; owner_name: string | null;
  owner_text: string | null; due_date: string | null; status: "OPEN" | "IN_PROGRESS" | "MONITORING" | "CLOSED";
  created_by_name: string | null; created_at: string; updated_by_name: string | null; updated_at: string; can_delete: boolean;
};
type Log = { doc: { type: RaidDocType; id: string; reference: string; title: string }; can_edit: boolean; can_manage: boolean; items: Item[] };

const TYPES: Array<{ key: Item["item_type"]; label: string; plural: string; hint: string }> = [
  { key: "RISK", label: "Risk", plural: "Risks", hint: "Something that might happen and would hurt the change" },
  { key: "ASSUMPTION", label: "Assumption", plural: "Assumptions", hint: "Something taken as true that hasn't been confirmed" },
  { key: "ISSUE", label: "Issue", plural: "Issues", hint: "A problem happening now" },
  { key: "DEPENDENCY", label: "Dependency", plural: "Dependencies", hint: "Something this relies on from someone else" }
];
const LEVELS: Level[] = ["HIGH", "MEDIUM", "LOW"];
const LEVEL_LABEL: Record<string, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
const STATUSES: Array<{ key: Item["status"]; label: string }> = [
  { key: "OPEN", label: "Open" }, { key: "IN_PROGRESS", label: "In progress" }, { key: "MONITORING", label: "Monitoring" }, { key: "CLOSED", label: "Closed" }
];
const SCORE: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const RATING_STYLE: Record<string, [string, string]> = { High: ["#fee2e2", "#b91c1c"], Medium: ["#fef3c7", "#92400e"], Low: ["#dcfce7", "#166534"] };

function rating(i: Pick<Item, "item_type" | "likelihood" | "impact">) {
  if (!i.impact) return null;
  if (i.item_type === "RISK" && i.likelihood) {
    const s = SCORE[i.likelihood] * SCORE[i.impact];
    return s >= 6 ? "High" : s >= 3 ? "Medium" : "Low";
  }
  return LEVEL_LABEL[i.impact];
}
const today = () => new Date().toISOString().slice(0, 10);
const blank = (type: Item["item_type"] = "RISK") => ({
  item_type: type, title: "", description: "", likelihood: "" as Level | "", impact: "" as Level | "", action: "",
  owner_user_id: "", owner_text: "", due_date: "", status: "OPEN" as Item["status"]
});

export function RaidLog({ docType, docId, users: usersProp }: { docType: RaidDocType; docId: string; users?: DirectoryUser[] }) {
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<DirectoryUser[]>(usersProp ?? []);
  const [typeFilter, setTypeFilter] = useState<"ALL" | Item["item_type"]>("ALL");
  const [showClosed, setShowClosed] = useState(false);
  const [form, setForm] = useState<(ReturnType<typeof blank> & { id?: string }) | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function load() {
    try { setLog(await api.raidLog(docType, docId)); setError(null); } catch (e: any) { setError(e?.message || "Couldn't load the RAID log."); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [docType, docId]);
  useEffect(() => {
    if (usersProp?.length) { setUsers(usersProp); return; }
    api.companyDirectory().then((rows: any) => setUsers(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [usersProp]);

  const items = log?.items ?? [];
  const shown = useMemo(() => items.filter((i) => (typeFilter === "ALL" || i.item_type === typeFilter) && (showClosed || i.status !== "CLOSED")), [items, typeFilter, showClosed]);
  const open = items.filter((i) => i.status !== "CLOSED");
  const openHigh = open.filter((i) => rating(i) === "High").length;
  const overdue = open.filter((i) => i.due_date && i.due_date < today()).length;
  const sortedUsers = useMemo(() => [...users].sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email)), [users]);

  async function save() {
    if (!form) return;
    if (!form.title.trim()) { void showNotice("Give the item a title."); return; }
    setSaving(true);
    const payload: Record<string, any> = {
      title: form.title.trim(), description: form.description.trim() || null,
      likelihood: form.item_type === "RISK" ? form.likelihood || null : null, impact: form.impact || null,
      action: form.action.trim() || null, owner_user_id: form.owner_user_id || null, owner_text: form.owner_user_id ? null : form.owner_text.trim() || null,
      due_date: form.due_date || null, status: form.status
    };
    try {
      if (form.id) await api.updateRaidItem(docType, docId, form.id, payload);
      else await api.addRaidItem(docType, docId, { ...payload, item_type: form.item_type });
      setForm(null);
      await load();
    } catch (e: any) { void showNotice(e?.message || "Couldn't save the item."); } finally { setSaving(false); }
  }
  async function setStatus(i: Item, status: Item["status"]) {
    try { await api.updateRaidItem(docType, docId, i.id, { status }); await load(); } catch (e: any) { void showNotice(e?.message || "Couldn't update the status."); }
  }
  async function remove(i: Item) {
    if (!(await confirmAction({ title: `Delete ${i.ref}?`, text: `"${i.title}" — it stays in the history.`, confirmButtonText: "Delete" }))) return;
    try { await api.deleteRaidItem(docType, docId, i.id); await load(); } catch (e: any) { void showNotice(e?.message || "Couldn't delete the item."); }
  }
  async function exportExcel() {
    setExporting(true);
    try { await downloadBlob(() => api.raidExportBlob(docType, docId), `RAID-${log?.doc.reference || docType}.xlsx`); }
    catch (e: any) { void showNotice(e?.message || "Couldn't export."); } finally { setExporting(false); }
  }

  if (error) return <div className="ep-empty"><p>{error}</p></div>;
  if (!log) return <div className="ep-loading"><p>Loading RAID log…</p></div>;

  const chip = (active: boolean): CSSProperties => ({
    border: "1px solid var(--border)", borderRadius: 99, padding: "4px 10px", fontSize: 12.5, cursor: "pointer",
    background: active ? "var(--text)" : "transparent", color: active ? "var(--surface)" : "var(--text)", fontWeight: 600
  });

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button style={chip(typeFilter === "ALL")} onClick={() => setTypeFilter("ALL")}>All {items.length}</button>
        {TYPES.map((t) => (
          <button key={t.key} style={chip(typeFilter === t.key)} onClick={() => setTypeFilter(t.key)} title={t.hint}>
            {t.plural} {items.filter((i) => i.item_type === t.key).length}
          </button>
        ))}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, marginLeft: 4 }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="ep-btn-outline" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }} disabled={exporting} onClick={() => void exportExcel()}>
            <Download size={13} /> {exporting ? "Exporting…" : "Export to Excel"}
          </button>
          {log.can_edit && !form && (
            <button className="ep-btn" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => setForm(blank(typeFilter === "ALL" ? "RISK" : typeFilter))}>
              <Plus size={13} /> Add item
            </button>
          )}
        </div>
      </div>
      <div style={{ fontSize: 13, color: "var(--muted)" }}>
        {open.length} open{openHigh ? <> · <strong style={{ color: "#b91c1c" }}>{openHigh} rated High</strong></> : null}{overdue ? <> · <strong style={{ color: "#b91c1c" }}>{overdue} overdue</strong></> : null}
        {!log.can_edit && " · view only"}
      </div>

      {form && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>{form.id ? `Edit ${items.find((i) => i.id === form.id)?.ref}` : "Add a RAID item"}</div>
          <div className="ep-form-fields-grid">
            {!form.id && (
              <div className="ep-form-group"><label>Type</label>
                <select className="ep-form-select" value={form.item_type} onChange={(e) => setForm({ ...form, item_type: e.target.value as Item["item_type"] })}>
                  {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label} — {t.hint.toLowerCase()}</option>)}
                </select></div>
            )}
            <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}><label>Title <span className="ep-required">*</span></label>
              <input className="ep-form-input" maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}><label>Description</label>
              <textarea className="ep-form-textarea" rows={2} maxLength={4000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            {form.item_type === "RISK" && (
              <div className="ep-form-group"><label>Likelihood</label>
                <select className="ep-form-select" value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value as Level })}>
                  <option value="">—</option>{LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                </select></div>
            )}
            <div className="ep-form-group"><label>Impact</label>
              <select className="ep-form-select" value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value as Level })}>
                <option value="">—</option>{LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
              </select></div>
            <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}><label>Action / mitigation</label>
              <textarea className="ep-form-textarea" rows={2} maxLength={4000} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} /></div>
            <div className="ep-form-group"><label>Owner</label>
              <ApproverCombobox users={sortedUsers} value={form.owner_user_id} onChange={(id) => setForm({ ...form, owner_user_id: id, owner_text: "" })} placeholder="Search a FlowDesk user…" />
              {!form.owner_user_id && (
                <input className="ep-form-input" style={{ marginTop: 6 }} placeholder="…or type a name (e.g. a supplier)" maxLength={120} value={form.owner_text} onChange={(e) => setForm({ ...form, owner_text: e.target.value })} />
              )}
              {form.owner_user_id && <button type="button" className="ep-btn-outline" style={{ marginTop: 6, fontSize: 12, padding: "3px 8px", justifySelf: "start" }} onClick={() => setForm({ ...form, owner_user_id: "" })}>Clear owner</button>}
            </div>
            <div className="ep-form-group"><label>Due date</label>
              <input type="date" className="ep-form-input" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></div>
            <div className="ep-form-group"><label>Status</label>
              <select className="ep-form-select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Item["status"] })}>
                {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select></div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ep-btn" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : form.id ? "Save changes" : "Add item"}</button>
            <button className="ep-btn-outline" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {!shown.length ? (
        <div className="ep-empty"><p>{items.length ? "Nothing in this view." : log.can_edit ? "No RAID items yet. Add the risks, assumptions, issues and dependencies for this request." : "No RAID items yet."}</p></div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12 }}>
                {["ID", "Item", "Rating", "Owner", "Due", "Status", ""].map((h) => <th key={h} style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => {
                const r = rating(i);
                const late = i.status !== "CLOSED" && i.due_date && i.due_date < today();
                return (
                  <tr key={i.id} style={{ borderBottom: "1px solid var(--border)", verticalAlign: "top", opacity: i.status === "CLOSED" ? 0.6 : 1 }}>
                    <td style={{ padding: 8, fontWeight: 700, whiteSpace: "nowrap" }}>{i.ref}</td>
                    <td style={{ padding: 8, minWidth: 240 }}>
                      <div style={{ fontWeight: 600 }}>{i.title}</div>
                      {i.description && <div style={{ color: "var(--muted)", whiteSpace: "pre-wrap", marginTop: 2 }}>{i.description}</div>}
                      {i.action && <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}><span style={{ fontWeight: 600 }}>Action:</span> {i.action}</div>}
                      <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>
                        Raised by {i.created_by_name || "—"} {new Date(i.created_at).toLocaleDateString()}
                        {i.updated_by_name && i.updated_at !== i.created_at ? ` · updated by ${i.updated_by_name} ${new Date(i.updated_at).toLocaleDateString()}` : ""}
                      </div>
                    </td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                      {r ? <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11.5, fontWeight: 700, background: RATING_STYLE[r][0], color: RATING_STYLE[r][1] }}>{r}</span> : "—"}
                      {i.item_type === "RISK" && i.likelihood && i.impact && <div style={{ color: "var(--muted)", fontSize: 11 }}>L {LEVEL_LABEL[i.likelihood]} · I {LEVEL_LABEL[i.impact]}</div>}
                    </td>
                    <td style={{ padding: 8 }}>{i.owner_name || i.owner_text || "—"}</td>
                    <td style={{ padding: 8, whiteSpace: "nowrap", color: late ? "#b91c1c" : undefined, fontWeight: late ? 700 : undefined }}>
                      {i.due_date ? new Date(i.due_date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—"}
                    </td>
                    <td style={{ padding: 8 }}>
                      {log.can_edit ? (
                        <select className="ep-form-select" style={{ width: "auto", fontSize: 12.5, padding: "3px 6px" }} value={i.status} onChange={(e) => void setStatus(i, e.target.value as Item["status"])} aria-label={`Status of ${i.ref}`}>
                          {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      ) : STATUSES.find((s) => s.key === i.status)?.label}
                    </td>
                    <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                      {log.can_edit && (
                        <button className="ep-icon-btn" title="Edit" onClick={() => setForm({
                          id: i.id, item_type: i.item_type, title: i.title, description: i.description || "", likelihood: i.likelihood || "", impact: i.impact || "",
                          action: i.action || "", owner_user_id: i.owner_user_id || "", owner_text: i.owner_text || "", due_date: i.due_date || "", status: i.status
                        })}><Pencil size={14} /></button>
                      )}
                      {i.can_delete && <button className="ep-icon-btn" title="Delete" onClick={() => void remove(i)}><Trash2 size={14} /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// The log in its own window - for places without a tab to put it in.
export function RaidLogModal({ docType, docId, title, users, onClose }: { docType: RaidDocType; docId: string; title: string; users?: DirectoryUser[]; onClose: () => void }) {
  return createPortal(
    <div className="ep-modal-overlay" style={{ zIndex: 1050 }} onClick={onClose}>
      <div className="ep-modal ep-modal-lg" style={{ maxWidth: 1080, height: "88vh" }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="RAID log">
        <div className="ep-modal-head">
          <div style={{ minWidth: 0 }}>
            <h3 className="ep-modal-title">RAID log</h3>
            <p className="ep-modal-sub">{title} — risks, assumptions, issues and dependencies</p>
          </div>
          <button className="ep-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="ep-modal-body"><RaidLog docType={docType} docId={docId} users={users} /></div>
      </div>
    </div>,
    document.body
  );
}

// "Export RAID register" - every item across the documents of one kind.
export function RaidRegisterButton({ docType, label }: { docType: RaidDocType; label?: string }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try { await downloadBlob(() => api.raidRegisterBlob(docType, true), `${docType}-RAID-register-${new Date().toISOString().slice(0, 10)}.xlsx`); }
    catch (e: any) { void showNotice(e?.message || "Couldn't export."); } finally { setBusy(false); }
  }
  return (
    <button className="ep-btn-outline" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }} disabled={busy} onClick={() => void run()}
      title="Every RAID item on the documents you can open, in one Excel workbook">
      <Download size={13} /> {busy ? "Exporting…" : label || "RAID register (Excel)"}
    </button>
  );
}

// A "RAID log" button that opens the log in its own window.
export function RaidLogButton({ docType, docId, title, users, label, className, small }: {
  docType: RaidDocType; docId: string; title: string; users?: DirectoryUser[]; label?: string; className?: string; small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className || "ep-btn-outline"} style={small ? { fontSize: 12, padding: "4px 10px" } : undefined}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }} title="Risks, assumptions, issues and dependencies">
        {label || "RAID log"}
      </button>
      {open && <RaidLogModal docType={docType} docId={docId} title={title} users={users} onClose={() => setOpen(false)} />}
    </>
  );
}
