import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RaidLog } from "./RaidLog";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Download, FileText, History, MessageSquare, Pencil, Plus, Send, ShieldAlert, Trash2, Users, X } from "lucide-react";
import { api, downloadBlob, openBlobInNewTab } from "../api";
import { confirmAction, showNotice } from "../alerts";
import type { DirectoryUser } from "../shared/ApproverCombobox";
import { BrsPeoplePicker, BrsRoleBadge, CR_PERMISSION_OPTIONS, CR_PRESETS, describeCrPermissions } from "./BrsPeoplePicker";
import { OrgEntryChip, type OrgEntry } from "./OrgSearchModal";

// One Change Request with everyone working on it: the form by section, extra
// sections added to this request, owners and co-writers, comments, the full
// history (who changed what, before and after) and recent changes.
// The hub passes `renderFieldEditor` so fields edit exactly like the form;
// without it (e.g. from the Approval Inbox) fields are read-only.

export type WsField = {
  field_key: string;
  field_label: string;
  field_type: string;
  options?: any;
  placeholder?: string | null;
  is_required?: boolean;
  sort_order?: number;
};

type Revision = {
  id: string; kind: string; summary: string; section_key: string | null; section_title: string | null;
  changes: Array<{ key: string; label: string; before: unknown; after: unknown }> | null;
  status: string | null; actor_role: string | null; actor_id: string | null; actor_name: string | null; created_at: string;
};
type Comment = { id: string; section_key: string | null; section_title: string | null; body: string; author_role: string | null; author_name: string | null; created_at: string };
type CustomSection = { id: string; title: string; description: string | null; content: string; added_by_name: string | null; updated_by_name: string | null; updated_at: string };
type Workspace = {
  status: string;
  my_role: string;
  my_permissions: { manage: boolean; edit: boolean; invite: boolean; submit: boolean; distribute: boolean };
  can_edit_fields: boolean;
  creator: { id: string; full_name: string | null; email: string } | null;
  owners: Array<{ id: string; full_name: string | null; email: string }>;
  co_writers: Array<{ entry_id: string; type: OrgEntry["type"]; id: string | null; name: string | null; label: string; permissions: string[]; added_by_name: string | null }>;
  form_sections: Array<{ key: string; title: string; field_keys: string[] }>;
  custom_sections: CustomSection[];
  comment_counts: Record<string, number>;
  recent: Revision[];
  last_seen_at: string | null;
  unseen_count: number;
};

const KIND_LABEL: Record<string, string> = {
  CREATED: "Submitted", DRAFT_CREATED: "Started the draft", SUBMITTED: "Submitted for approval", FIELDS_SAVED: "Edited",
  SECTION_ADDED: "Added a section", SECTION_REMOVED: "Removed a section", SECTION_SAVED: "Edited a section",
  PEOPLE_CHANGED: "People", COMMENTED: "Comment", ASSIGNEE_ADDED: "Assignee added", ASSIGNEE_CONFIRMED: "Assignee confirmed",
  APPROVAL_ACTION: "Approval", CANCELLED: "Cancelled", CLOSED: "Closed", DISTRIBUTED: "Distributed", RAID_CHANGED: "RAID log",
  ROLLED_BACK: "Rolled back for correction", ASSIGNEE_REJECTED: "Rejected by an assignee"
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

export default function ChangeRequestWorkspace(props: {
  submissionId: string;
  currentUserId: string | null;
  directory: DirectoryUser[];
  renderFieldEditor?: (f: WsField, values: Record<string, any>, setValue: (key: string, value: any) => void) => ReactNode;
  onSubmitDraft?: (draft: { id: string; data: Record<string, any>; approval_chain?: any[] }) => void;
  onChanged?: () => void;
  onClose: () => void;
}) {
  const { submissionId, currentUserId, directory, renderFieldEditor, onSubmitDraft, onChanged, onClose } = props;
  const [view, setView] = useState<"WORK" | "COMMENTS" | "HISTORY" | "RAID">("WORK");
  const [detail, setDetail] = useState<any>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [editingPeople, setEditingPeople] = useState(false);
  const [ownerIds, setOwnerIds] = useState<string[]>([]);
  const [coWriters, setCoWriters] = useState<OrgEntry[]>([]);
  const [newSection, setNewSection] = useState<{ title: string; description: string } | null>(null);
  const [sectionDrafts, setSectionDrafts] = useState<Record<string, string>>({});
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function load() {
    try {
      const [d, w] = await Promise.all([api.customRequestDetail(submissionId), api.crWorkspace(submissionId)]);
      setDetail(d);
      setWs(w);
      setError(null);
      return w as Workspace;
    } catch (e: any) {
      setError(e?.message || "Couldn't open this Change Request.");
      return null;
    }
  }

  useEffect(() => {
    void (async () => {
      const w = await load();
      // Keep the "new" markers for this visit, then record it as seen.
      if (w) { setLastSeen(w.last_seen_at); void api.crMarkSeen(submissionId).catch(() => {}); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  const fields: WsField[] = useMemo(() => [...(detail?.fields || [])].sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), [detail]);
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.field_key, f])), [fields]);
  const userName = (id: string) => { const u = directory.find((x) => x.id === id); return u ? u.full_name || u.email : null; };

  function formatValue(f: WsField | undefined, v: any): string {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return "—";
    if (!f) return typeof v === "string" ? v : JSON.stringify(v);
    if (f.field_type === "checkbox") return v ? "Yes" : "No";
    if (f.field_type === "user") return userName(String(v)) || String(v);
    if (f.field_type === "select") return (Array.isArray(f.options) ? f.options : []).find((o: any) => o.value === v)?.label || String(v);
    if (f.field_type === "user_multi" && Array.isArray(v)) {
      return v.map((a: any) => (a.teamName ? `${a.teamName} (Section)` : a.departmentName ? `${a.departmentName} (Department)` : a.divisionName ? `${a.divisionName} (Division)` : a.name || a.email || (a.id && userName(a.id)) || "—")
        + (a.confirmed ? " ✓" : "")).join(", ");
    }
    if (f.field_type === "date") return String(v).slice(0, 10);
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  if (!ws || !detail) {
    return (
      <Shell onClose={onClose} title="Change Request" sub={error || "Loading…"}>
        {error ? <div className="ep-empty"><p>{error}</p></div> : <div className="ep-loading"><p>Loading…</p></div>}
      </Shell>
    );
  }

  const perms = ws.my_permissions;
  const editable = ["DRAFT", "IN_PROGRESS"].includes(ws.status);
  const title = detail.data?.description_of_change || (ws.status === "DRAFT" ? "Untitled Change Request (draft)" : "Change Request");
  const commentTotal = Object.values(ws.comment_counts).reduce((a, b) => a + b, 0);
  const isNew = (r: Revision) => !!lastSeen && r.actor_id !== currentUserId && new Date(r.created_at) > new Date(lastSeen);
  const afterChange = async () => { await load(); onChanged?.(); };

  async function saveSection(keys: string[]) {
    const data: Record<string, any> = {};
    for (const k of keys) {
      const f = fieldByKey.get(k);
      if (f && !(f.field_type === "user_multi" && ws!.status !== "DRAFT")) data[k] = buffer[k] ?? null;
    }
    setSaving(true);
    try {
      await api.crSaveFields(submissionId, data);
      setEditingSection(null);
      await afterChange();
    } catch (e: any) { void showNotice(e?.message || "Couldn't save."); } finally { setSaving(false); }
  }

  function startPeopleEdit() {
    setOwnerIds(ws!.owners.map((o) => o.id));
    setCoWriters(ws!.co_writers.map((c) => ({ type: c.type, id: c.id, name: c.name, label: c.label, permissions: c.permissions })));
    setEditingPeople(true);
  }
  async function savePeople() {
    setSaving(true);
    try {
      await api.crSetPeople(submissionId, { owner_user_ids: ownerIds, co_writers: coWriters.map((c) => ({ type: c.type, id: c.id ?? null, name: c.name ?? null, permissions: c.permissions ?? ["EDIT"] })) });
      setEditingPeople(false);
      await afterChange();
    } catch (e: any) { void showNotice(e?.message || "Couldn't save people."); } finally { setSaving(false); }
  }

  async function addSection() {
    if (!newSection?.title.trim()) return;
    setSaving(true);
    try {
      await api.crAddSection(submissionId, { title: newSection.title.trim(), description: newSection.description.trim() || null });
      setNewSection(null);
      await afterChange();
    } catch (e: any) { void showNotice(e?.message || "Couldn't add the section."); } finally { setSaving(false); }
  }
  async function saveCustomSection(s: CustomSection) {
    setSaving(true);
    try {
      await api.crUpdateSection(submissionId, s.id, { content: sectionDrafts[s.id] ?? s.content });
      setSectionDrafts((d) => { const n = { ...d }; delete n[s.id]; return n; });
      await afterChange();
    } catch (e: any) { void showNotice(e?.message || "Couldn't save the section."); } finally { setSaving(false); }
  }
  async function removeSection(s: CustomSection) {
    if (!(await confirmAction({ title: `Remove "${s.title}"?`, text: "Its text stays in the history.", confirmButtonText: "Remove" }))) return;
    try { await api.crRemoveSection(submissionId, s.id); await afterChange(); } catch (e: any) { void showNotice(e?.message || "Couldn't remove the section."); }
  }
  async function downloadCommentsHistory() {
    setDownloading(true);
    try {
      // Same reference as the RAID log and the PDF itself.
      await downloadBlob(() => api.crCommentsHistoryPdf(submissionId), `CHG-${submissionId.slice(0, 8).toUpperCase()}-comments-and-history.pdf`);
    } catch (e: any) { void showNotice(e?.message || "Couldn't download the comments and history."); } finally { setDownloading(false); }
  }
  async function discardDraft() {
    if (!(await confirmAction({ title: "Discard this draft?", text: "The draft and its comments and history are deleted for everyone.", confirmButtonText: "Discard" }))) return;
    try { await api.crDiscardDraft(submissionId); onChanged?.(); onClose(); } catch (e: any) { void showNotice(e?.message || "Couldn't discard the draft."); }
  }

  const sectionHead = (key: string, label: string, extra?: ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
      <button className="ep-btn-outline" style={{ marginLeft: "auto", fontSize: 12, padding: "3px 8px", display: "inline-flex", alignItems: "center", gap: 4 }}
        onClick={() => { setCommentFor(key); setView("COMMENTS"); }} title="Comment on this section">
        <MessageSquare size={12} /> {ws.comment_counts[key] ? ws.comment_counts[key] : "Comment"}
      </button>
      {extra}
    </div>
  );

  const header = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <div className="ep-tabs" style={{ margin: 0, border: "none" }}>
        <button className={`ep-tab ${view === "WORK" ? "active" : ""}`} onClick={() => setView("WORK")}>Workspace</button>
        <button className={`ep-tab ${view === "COMMENTS" ? "active" : ""}`} onClick={() => { setCommentFor(null); setView("COMMENTS"); }}>
          <MessageSquare size={13} /> Comments <span className="ep-tab-count">{commentTotal}</span>
        </button>
        <button className={`ep-tab ${view === "HISTORY" ? "active" : ""}`} onClick={() => setView("HISTORY")}>
          <History size={13} /> History
        </button>
        <button className={`ep-tab ${view === "RAID" ? "active" : ""}`} onClick={() => setView("RAID")} title="Risks, assumptions, issues and dependencies">
          <ShieldAlert size={13} /> RAID log
        </button>
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
        {detail.can_view_pdf && (
          <button className="ep-btn-outline" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => void openBlobInNewTab(() => api.customRequestPdf(submissionId)).catch((e: any) => showNotice(e?.message || "Couldn't generate the PDF."))}>
            <FileText size={13} /> Download PDF
          </button>
        )}
        <button className="ep-btn-outline" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }} disabled={downloading}
          onClick={() => void downloadCommentsHistory()} title="Every comment and the full history, oldest first, as a PDF">
          <Download size={13} /> {downloading ? "Preparing…" : "Download comments & history"}
        </button>
        {ws.status === "DRAFT" && perms.submit && onSubmitDraft && (
          <button className="ep-btn" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => onSubmitDraft({ id: submissionId, data: detail.data || {}, approval_chain: Array.isArray(detail.approval_chain) ? detail.approval_chain : [] })}>
            <Send size={13} /> Submit for approval
          </button>
        )}
        {ws.status === "DRAFT" && perms.manage && (
          <button className="ep-btn-danger" style={{ fontSize: 12.5 }} onClick={() => void discardDraft()}>Discard draft</button>
        )}
      </div>
    </div>
  );

  return (
    <Shell onClose={onClose} title={title} sub={<>
      <span className={`custom-status-badge custom-status-${ws.status.toLowerCase().replace(/_/g, "-")}`}>{ws.status.replace(/_/g, " ")}</span>
      <span style={{ marginLeft: 8 }}>You're here as</span> <CrRoleBadge role={ws.my_role} />
      {detail.requester_name && <span style={{ marginLeft: 8 }}>· Started by {detail.requester_name} on {new Date(detail.created_at).toLocaleDateString()}</span>}
    </>} toolbar={header}>
      {view === "RAID" ? (
        <RaidLog docType="CHANGE_REQUEST" docId={submissionId} users={directory.length ? directory : undefined} />
      ) : view === "COMMENTS" ? (
        <CommentsView submissionId={submissionId} sections={[...ws.form_sections.map((s) => ({ key: s.key, title: s.title })), ...ws.custom_sections.map((s) => ({ key: s.id, title: s.title }))]}
          initialSection={commentFor} onPosted={() => void load()} />
      ) : view === "HISTORY" ? (
        <HistoryView submissionId={submissionId} fieldByKey={fieldByKey} formatValue={formatValue} lastSeen={lastSeen} currentUserId={currentUserId} />
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {/* Rolled back for correction: say who sent it back and why, until it's resubmitted. */}
          {(() => {
            if (ws.status !== "DRAFT") return null;
            const back = [...ws.recent].sort((a, b) => b.created_at.localeCompare(a.created_at)).find((r) => r.kind === "ROLLED_BACK" || r.kind === "SUBMITTED" || r.kind === "CREATED");
            if (!back || back.kind !== "ROLLED_BACK") return null;
            return (
              <div className="card" style={{ padding: 14, borderLeft: "4px solid #f59e0b", background: "#fffbeb", color: "#78350f" }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Rolled back for correction</div>
                <div style={{ fontSize: 13 }}>{back.summary.replace(/^Rolled back for correction /, "")}</div>
                <div style={{ fontSize: 12, marginTop: 6 }}>{when(back.created_at)} · Make the corrections, then choose <strong>Submit for approval</strong>. It starts again from step 1{detail.data && Object.values(detail.data).some((v) => Array.isArray(v) && v.some((a: any) => a && typeof a === "object" && "confirmed" in a)) ? " (the assignees confirm again)" : ""}.</div>
              </div>
            );
          })()}
          {/* Recent changes */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Recent changes</div>
              {ws.unseen_count > 0 && <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: "#fef3c7", color: "#92400e" }}>{ws.unseen_count} new since your last visit</span>}
              <button className="ep-btn-outline" style={{ marginLeft: "auto", fontSize: 12, padding: "3px 8px" }} onClick={() => setView("HISTORY")}>Full history</button>
            </div>
            {!ws.recent.length ? <div style={{ fontSize: 13, color: "var(--muted)" }}>Nothing yet.</div> : (
              <div style={{ display: "grid", gap: 6 }}>
                {ws.recent.map((r) => (
                  <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 13 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, flexShrink: 0, background: isNew(r) ? "#f59e0b" : "transparent" }} title={isNew(r) ? "New since your last visit" : undefined} />
                    <span style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>{when(r.created_at)}</span>
                    <span style={{ minWidth: 0 }}><strong>{r.actor_name || "System"}</strong> — {r.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* People */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Users size={15} /><div style={{ fontWeight: 700, fontSize: 14 }}>People</div>
              {(perms.manage || perms.invite) && !editingPeople && !["REJECTED", "CANCELLED"].includes(ws.status) && (
                <button className="ep-btn-outline" style={{ marginLeft: "auto", fontSize: 12, padding: "3px 8px" }} onClick={startPeopleEdit}>
                  {perms.manage ? "Add or remove people" : "Invite people"}
                </button>
              )}
            </div>
            {editingPeople ? (
              <>
                <BrsPeoplePicker users={directory} ownerIds={ownerIds} onOwnersChange={setOwnerIds} coWriters={coWriters} onCoWritersChange={setCoWriters}
                  excludeIds={[...(ws.creator ? [ws.creator.id] : []), ...((detail.approval_chain || []) as any[]).map((st) => st.approver_id)]}
                  permissionOptions={CR_PERMISSION_OPTIONS} presets={CR_PRESETS} ownersLocked={!perms.manage} ownerWord="co-owner" />
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="ep-btn" disabled={saving} onClick={() => void savePeople()}>{saving ? "Saving…" : "Save people"}</button>
                  <button className="ep-btn-outline" onClick={() => setEditingPeople(false)}>Cancel</button>
                </div>
              </>
            ) : (
              <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <CrRoleBadge role="CREATOR" /> {ws.creator?.full_name || ws.creator?.email || "—"}
                </div>
                {ws.owners.map((o) => (
                  <div key={o.id} style={{ display: "flex", gap: 8, alignItems: "center" }}><CrRoleBadge role="OWNER" /> {o.full_name || o.email}</div>
                ))}
                {ws.co_writers.map((c) => (
                  <div key={c.entry_id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <CrRoleBadge role="CO_WRITER" /> <OrgEntryChip entry={{ type: c.type, id: c.id, name: c.name, label: c.label }} />
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>{describeCrPermissions(c.permissions)}{c.added_by_name ? ` · added by ${c.added_by_name}` : ""}</span>
                  </div>
                ))}
                {!ws.owners.length && !ws.co_writers.length && <div style={{ color: "var(--muted)" }}>No co-owners or co-writers yet.</div>}
              </div>
            )}
          </div>

          {/* The form, by section */}
          {ws.form_sections.map((s) => {
            const isEditing = editingSection === s.key;
            const sectionFields = s.field_keys.map((k) => fieldByKey.get(k)).filter(Boolean) as WsField[];
            const lockedMulti = (f: WsField) => f.field_type === "user_multi" && ws.status !== "DRAFT";
            return (
              <div key={s.key} className="card" style={{ padding: 14 }}>
                {sectionHead(s.key, s.title, ws.can_edit_fields && renderFieldEditor && !isEditing && (
                  <button className="ep-btn-outline" style={{ fontSize: 12, padding: "3px 8px", display: "inline-flex", alignItems: "center", gap: 4 }}
                    onClick={() => { setBuffer({ ...(detail.data || {}) }); setEditingSection(s.key); }}>
                    <Pencil size={12} /> Edit
                  </button>
                ))}
                {isEditing && renderFieldEditor ? (
                  <>
                    <div className="ep-form-fields-grid">
                      {sectionFields.map((f) => (
                        <div key={f.field_key} className="ep-form-group">
                          {f.field_type !== "checkbox" && <label>{f.field_label}{f.is_required && <span className="ep-required"> *</span>}</label>}
                          {lockedMulti(f)
                            ? <div style={{ fontSize: 13 }}>{formatValue(f, detail.data?.[f.field_key])} <span style={{ color: "var(--muted)", fontSize: 12 }}>— changed from the assignee list</span></div>
                            : renderFieldEditor(f, buffer, (k, v) => setBuffer((b) => ({ ...b, [k]: v })))}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="ep-btn" disabled={saving} onClick={() => void saveSection(s.field_keys)}>{saving ? "Saving…" : "Save section"}</button>
                      <button className="ep-btn-outline" onClick={() => setEditingSection(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr", gap: "6px 14px", fontSize: 13 }}>
                    {sectionFields
                      .filter((f) => !(f.field_type === "checkbox" && s.key === "type" && !detail.data?.[f.field_key]))
                      .map((f) => (
                        <FragmentRow key={f.field_key} label={f.field_label} value={formatValue(f, detail.data?.[f.field_key])} />
                      ))}
                    {s.key === "type" && !sectionFields.some((f) => detail.data?.[f.field_key]) && <FragmentRow label="Selected" value="—" />}
                  </div>
                )}
              </div>
            );
          })}

          {/* Sections added to this request */}
          {ws.custom_sections.map((s) => {
            const draft = sectionDrafts[s.id];
            return (
              <div key={s.id} className="card" style={{ padding: 14 }}>
                {sectionHead(s.id, s.title, <>
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "#e0f2fe", color: "#075985", fontWeight: 700 }}>Added to this request</span>
                  {perms.manage && editable && (
                    <button className="ep-btn-outline" style={{ fontSize: 12, padding: "3px 8px", color: "#dc2626" }} onClick={() => void removeSection(s)} title="Remove this section">
                      <Trash2 size={12} />
                    </button>
                  )}
                </>)}
                {s.description && <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 8 }}>{s.description}</div>}
                {perms.edit && editable ? (
                  <>
                    <textarea className="ep-form-textarea" rows={5} value={draft ?? s.content} onChange={(e) => setSectionDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                      placeholder="Write this section…" style={{ width: "100%" }} />
                    {draft !== undefined && draft !== s.content && (
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button className="ep-btn" disabled={saving} onClick={() => void saveCustomSection(s)}>{saving ? "Saving…" : "Save section"}</button>
                        <button className="ep-btn-outline" onClick={() => setSectionDrafts((d) => { const n = { ...d }; delete n[s.id]; return n; })}>Undo</button>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{s.content || "—"}</div>
                )}
                {s.updated_by_name && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>Last edited by {s.updated_by_name}, {when(s.updated_at)}</div>}
              </div>
            );
          })}

          {perms.manage && editable && (
            newSection ? (
              <div className="card" style={{ padding: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Add a section</div>
                <div className="ep-form-group"><label>Title</label>
                  <input className="ep-form-input" value={newSection.title} maxLength={120} onChange={(e) => setNewSection({ ...newSection, title: e.target.value })} placeholder="e.g. Test plan" /></div>
                <div className="ep-form-group"><label>What goes here <span style={{ fontWeight: 400, color: "var(--muted)" }}>(optional)</span></label>
                  <input className="ep-form-input" value={newSection.description} maxLength={500} onChange={(e) => setNewSection({ ...newSection, description: e.target.value })} /></div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="ep-btn" disabled={saving || !newSection.title.trim()} onClick={() => void addSection()}>Add section</button>
                  <button className="ep-btn-outline" onClick={() => setNewSection(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="ep-btn-outline" style={{ justifySelf: "start", display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => setNewSection({ title: "", description: "" })}>
                <Plus size={14} /> Add a section
              </button>
            )
          )}

          {/* Approvals, once submitted */}
          {Array.isArray(detail.approval_chain) && detail.approval_chain.length > 0 && (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{ws.status === "DRAFT" ? "Approvals (last round, before it was rolled back)" : "Approvals"}</div>
              <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                {detail.approval_chain.map((step: any, i: number) => (
                  <div key={i}>
                    <strong>{i + 1}. {step.position_name}</strong> — {step.approver_name || "—"}
                    <span style={{ color: "var(--muted)" }}> · {step.acted_at ? (step.status === "ROLLED_BACK" ? "ROLLED BACK FOR CORRECTION" : step.status) : i === detail.current_step_order && ws.status === "IN_PROGRESS" ? "PENDING" : ws.status === "DRAFT" ? "—" : "WAITING"}</span>
                    {step.comment && <div style={{ color: "var(--muted)", fontSize: 12 }}>"{step.comment}"</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

// In a Change Request an owner is a co-owner.
function CrRoleBadge({ role }: { role: string | null | undefined }) {
  return <BrsRoleBadge role={role} label={role === "OWNER" ? "Co-owner" : undefined} />;
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div style={{ color: "var(--muted)" }}>{label}</div>
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{value}</div>
    </>
  );
}

function Shell({ title, sub, toolbar, onClose, children }: { title: string; sub: ReactNode; toolbar?: ReactNode; onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div className="ep-modal-overlay" onClick={onClose}>
      <div className="ep-modal ep-modal-lg" style={{ maxWidth: 1080, height: "90vh" }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="ep-modal-head" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <h3 className="ep-modal-title">{title}</h3>
              <div className="ep-modal-sub" style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>{sub}</div>
            </div>
            <button className="ep-icon-btn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
          {toolbar && <div style={{ marginTop: 12 }}>{toolbar}</div>}
        </div>
        <div className="ep-modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function CommentsView({ submissionId, sections, initialSection, onPosted }: {
  submissionId: string; sections: Array<{ key: string; title: string }>; initialSection: string | null; onPosted: () => void;
}) {
  const [rows, setRows] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>(initialSection ?? "ALL");
  const [target, setTarget] = useState<string>(initialSection ?? "");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);

  async function load() {
    setLoading(true);
    try { setRows(await api.crComments(submissionId)); } catch { setRows([]); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [submissionId]);

  async function post() {
    if (!body.trim()) return;
    setPosting(true);
    try {
      await api.crAddComment(submissionId, { body: body.trim(), section_key: target || null });
      setBody("");
      await load();
      onPosted();
    } catch (e: any) { void showNotice(e?.message || "Couldn't post the comment."); } finally { setPosting(false); }
  }

  const shown = rows.filter((r) => filter === "ALL" || (filter === "_doc" ? !r.section_key : r.section_key === filter));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, color: "var(--muted)" }}>Show</label>
        <select className="ep-form-select" style={{ width: "auto" }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="ALL">All comments</option>
          <option value="_doc">On the whole request</option>
          {sections.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
        </select>
      </div>
      {loading ? <div className="ep-loading"><p>Loading comments…</p></div> : !shown.length ? (
        <div className="ep-empty"><p>No comments here yet.</p></div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {shown.map((c) => (
            <div key={c.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                <strong>{c.author_name || "Someone"}</strong> <CrRoleBadge role={c.author_role} />
                <span style={{ color: "var(--muted)", fontSize: 12 }}>on {c.section_title || "the whole request"} · {when(c.created_at)}</span>
              </div>
              <div style={{ marginTop: 6, fontSize: 13.5, whiteSpace: "pre-wrap" }}>{c.body}</div>
            </div>
          ))}
        </div>
      )}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12.5, fontWeight: 600 }}>Comment on</label>
          <select className="ep-form-select" style={{ width: "auto" }} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">The whole request</option>
            {sections.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
          </select>
        </div>
        <textarea className="ep-form-textarea" rows={3} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment…" style={{ width: "100%" }} />
        <div style={{ marginTop: 8 }}>
          <button className="ep-btn" disabled={posting || !body.trim()} onClick={() => void post()}>{posting ? "Posting…" : "Post comment"}</button>
        </div>
      </div>
    </div>
  );
}

function HistoryView({ submissionId, fieldByKey, formatValue, lastSeen, currentUserId }: {
  submissionId: string; fieldByKey: Map<string, WsField>; formatValue: (f: WsField | undefined, v: any) => string;
  lastSeen: string | null; currentUserId: string | null;
}) {
  const [rows, setRows] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"ALL" | "EDITS" | "PEOPLE" | "EVENTS">("ALL");
  const [person, setPerson] = useState("ALL");

  useEffect(() => {
    setLoading(true);
    api.crHistory(submissionId).then((r: Revision[]) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([])).finally(() => setLoading(false));
  }, [submissionId]);

  const EDIT_KINDS = ["FIELDS_SAVED", "SECTION_SAVED", "SECTION_ADDED", "SECTION_REMOVED"];
  const PEOPLE_KINDS = ["PEOPLE_CHANGED", "ASSIGNEE_ADDED", "ASSIGNEE_CONFIRMED"];
  const people = [...new Set(rows.map((r) => r.actor_name || "System"))].sort();
  const shown = rows.filter((r) =>
    (filter === "ALL" || (filter === "EDITS" ? EDIT_KINDS.includes(r.kind) : filter === "PEOPLE" ? PEOPLE_KINDS.includes(r.kind) : ![...EDIT_KINDS, ...PEOPLE_KINDS].includes(r.kind)))
    && (person === "ALL" || (r.actor_name || "System") === person));
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {(["ALL", "EDITS", "PEOPLE", "EVENTS"] as const).map((k) => (
          <button key={k} className={`ep-tab ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
            {k === "ALL" ? "Everything" : k === "EDITS" ? "Edits" : k === "PEOPLE" ? "People" : "Approvals & comments"}
          </button>
        ))}
        <select className="ep-form-select" style={{ width: "auto", marginLeft: "auto" }} value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Filter by person">
          <option value="ALL">Everyone</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      {loading ? <div className="ep-loading"><p>Loading history…</p></div> : !shown.length ? (
        <div className="ep-empty"><p>{rows.length ? "Nothing in this view." : "No history yet — it starts with the next change."}</p></div>
      ) : (
        <div style={{ display: "grid", gap: 2 }}>
          {shown.map((r) => {
            const isNew = !!lastSeen && r.actor_id !== currentUserId && new Date(r.created_at) > new Date(lastSeen);
            const hasChanges = !!r.changes?.length;
            return (
              <div key={r.id} style={{ padding: "8px 4px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: hasChanges ? "pointer" : "default" }} onClick={() => hasChanges && toggle(r.id)}>
                  <span style={{ width: 14, flexShrink: 0, color: "var(--muted)" }}>{hasChanges ? (open.has(r.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
                  <div style={{ fontSize: 12, color: "var(--muted)", width: 150, flexShrink: 0 }}>{when(r.created_at)}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {r.actor_name || "System"} <CrRoleBadge role={r.actor_role} />
                      <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{KIND_LABEL[r.kind] || r.kind}{r.section_title ? ` · ${r.section_title}` : ""}</span>
                      {isNew && <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "#fef3c7", color: "#92400e" }}>NEW</span>}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 2 }}>{r.summary}</div>
                  </div>
                </div>
                {hasChanges && open.has(r.id) && (
                  <table style={{ width: "100%", marginTop: 8, fontSize: 12.5, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                        <th style={{ padding: "4px 6px", width: "22%" }}>Field</th>
                        <th style={{ padding: "4px 6px", width: "39%" }}>Before</th>
                        <th style={{ padding: "4px 6px", width: "39%" }}>After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.changes!.map((c, i) => {
                        const f = fieldByKey.get(c.key);
                        return (
                          <tr key={i} style={{ borderTop: "1px solid var(--border)", verticalAlign: "top" }}>
                            <td style={{ padding: "6px", fontWeight: 600 }}>{c.label}</td>
                            <td style={{ padding: "6px", whiteSpace: "pre-wrap", background: "rgba(239,68,68,0.07)" }}>{formatValue(f, c.before)}</td>
                            <td style={{ padding: "6px", whiteSpace: "pre-wrap", background: "rgba(34,197,94,0.08)" }}>{formatValue(f, c.after)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
