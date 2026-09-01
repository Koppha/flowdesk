import { useEffect, useState } from "react";
import { api, openBlobInNewTab } from "./api";
import { showNotice } from "./alerts";
import { RichTextField } from "./shared/RichTextField";
import { ApproverCombobox, type DirectoryUser } from "./shared/ApproverCombobox";
import { ArrowLeft, ClipboardList, Download, FileText, Plus, Trash2 } from "lucide-react";

type BrsStudioProps = { profile: any; onBack: () => void };

const STAGES = [
  { key: "INTAKE", label: "Intake" },
  { key: "DRAFT", label: "Draft" },
  { key: "DEPT_INPUT", label: "Department Input" },
  { key: "GATE", label: "Consistency Gate" },
  { key: "APPROVAL", label: "Approval Routing" },
  { key: "BASELINE", label: "Baseline" }
];

function phaseIndex(phase: string) {
  const i = STAGES.findIndex((s) => s.key === phase);
  return i === -1 ? 0 : i;
}

function phaseBadge(phase: string) {
  const slug = phase.toLowerCase().replace(/_/g, "-");
  return <span className={`custom-status-badge custom-status-${slug}`}>{phase.replace(/_/g, " ")}</span>;
}

function Stepper({ phase, viewing, onSelect }: { phase: string; viewing: number; onSelect: (i: number) => void }) {
  const current = phaseIndex(phase);
  return (
    <div className="brs-stepper">
      {STAGES.map((s, i) => {
        const isDone = i < current;
        const isClickable = isDone || i === current;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => isClickable && onSelect(i)}
            disabled={!isClickable}
            className={`brs-stepper-step ${i === viewing ? "is-current" : ""} ${isDone ? "is-done" : ""}`}
            style={{ textAlign: "left", cursor: isClickable ? "pointer" : "default" }}
          >
            <span className="brs-stepper-step-num">STEP {String(i + 1).padStart(2, "0")}</span>
            <span className="brs-stepper-step-label">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

type ChainDraft = { approver_id: string; position_name: string; decision_type: "APPROVE" | "NOTE" };

export default function BrsStudio({ profile, onBack }: BrsStudioProps) {
  const [view, setView] = useState<"landing" | "workspace">("landing");
  const [landingTab, setLandingTab] = useState<"MINE" | "ASSIGNED">("MINE");
  const [mine, setMine] = useState<any[]>([]);
  const [assigned, setAssigned] = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  // The single BRS structure everyone opens a new document against — there's
  // no "types" concept exposed to the user, so this is fetched once (and
  // auto-created server-side the first time anyone asks) rather than shown
  // as a picker.
  const [defaultTypeId, setDefaultTypeId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newQuarter, setNewQuarter] = useState("");
  const [newProgrammeType, setNewProgrammeType] = useState("Ongoing / permanent");
  const [newJustification, setNewJustification] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const [docId, setDocId] = useState<string | null>(null);
  const [doc, setDoc] = useState<any>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [approvalSubmission, setApprovalSubmission] = useState<any>(null);
  // Which stepper step's content is currently on screen — defaults to the
  // document's real, live phase. Clicking an earlier, already-completed step
  // switches this to a read-only recap of that stage without touching the
  // document's actual phase; "Back to current stage" (or re-clicking the
  // live step) returns here. Reset to null (= "follow the live phase") every
  // time a different document loads.
  const [viewingIndex, setViewingIndex] = useState<number | null>(null);
  // Editable buffer for the Intake panel — separate from `doc.intake_data`
  // so typing doesn't need a full doc reload on every keystroke; Save
  // persists it and reloads. Intake isn't a workflow step with its own
  // "current phase" the way Draft/Department Input are (this system moves a
  // document straight past Intake into Draft on creation), so it stays
  // editable independent of which stepper step is being viewed live.
  const [intakeEdits, setIntakeEdits] = useState<Record<string, any>>({});
  const [savingIntake, setSavingIntake] = useState(false);

  const [companyDirectory, setCompanyDirectory] = useState<DirectoryUser[]>([]);
  const [orgSections, setOrgSections] = useState<{ id: string; name: string }[]>([]);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [assignPicker, setAssignPicker] = useState<{ sectionId: string; mode: "person" | "section"; value: string } | null>(null);
  const [chain, setChain] = useState<ChainDraft[]>([{ approver_id: "", position_name: "", decision_type: "APPROVE" }]);
  const [routing, setRouting] = useState(false);

  useEffect(() => {
    api.companyDirectory().then((rows: any) => setCompanyDirectory(Array.isArray(rows) ? rows : [])).catch(() => setCompanyDirectory([]));
    api.sections().then((rows: any) => setOrgSections(Array.isArray(rows) ? rows : [])).catch(() => setOrgSections([]));
    api.brsDefaultType().then((t: any) => setDefaultTypeId(t?.id ?? null)).catch(() => setDefaultTypeId(null));
    api.departments().then((rows: any) => setDepartments(Array.isArray(rows) ? rows : [])).catch(() => setDepartments([]));
  }, []);

  // Next several calendar quarters from today, e.g. "Q4 2026", "Q1 2027", …
  const quarterOptions = (() => {
    const now = new Date();
    const startQ = Math.floor(now.getMonth() / 3) + 1;
    const out: string[] = [];
    let q = startQ, y = now.getFullYear();
    for (let i = 0; i < 6; i++) {
      out.push(`Q${q} ${y}`);
      q += 1;
      if (q > 4) { q = 1; y += 1; }
    }
    return out;
  })();

  function loadLanding() {
    setLoadingList(true);
    Promise.all([api.myBrs().catch(() => []), api.assignedToMeBrs().catch(() => [])])
      .then(([m, a]) => { setMine(Array.isArray(m) ? m : []); setAssigned(Array.isArray(a) ? a : []); })
      .finally(() => setLoadingList(false));
  }

  useEffect(() => {
    if (view === "landing") loadLanding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  function loadDoc(id: string) {
    setDocLoading(true);
    setDocError(null);
    api.brsDetail(id)
      .then((d: any) => {
        setDoc(d);
        setIntakeEdits(d.intake_data || {});
        if (d.brs_approval_submission_id) {
          api.customRequestDetail(d.brs_approval_submission_id).then(setApprovalSubmission).catch(() => setApprovalSubmission(null));
        } else {
          setApprovalSubmission(null);
        }
      })
      .catch((e: any) => setDocError(e?.message || "Failed to load this BRS"))
      .finally(() => setDocLoading(false));
  }

  useEffect(() => {
    if (docId) loadDoc(docId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  function openDoc(id: string) {
    setDocId(id);
    setChain([{ approver_id: "", position_name: "", decision_type: "APPROVE" }]);
    setViewingIndex(null);
    setView("workspace");
  }

  function backToLanding() {
    setView("landing");
    setDocId(null);
    setDoc(null);
  }

  async function handleCreate() {
    if (!defaultTypeId || !newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await api.brsCreate({
        brs_type_id: defaultTypeId,
        title: newTitle.trim(),
        intake_data: {
          department: newDepartment || null,
          product_owner: newOwner.trim() || null,
          target_quarter: newQuarter || null,
          programme_type: newProgrammeType || null,
          business_justification: newJustification || null
        }
      });
      setShowNewForm(false);
      setNewTitle("");
      setNewDepartment("");
      setNewOwner("");
      setNewQuarter("");
      setNewProgrammeType("Ongoing / permanent");
      setNewJustification("");
      openDoc(res.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to open a new BRS");
    } finally {
      setCreating(false);
    }
  }

  async function saveSection(sectionId: string, html: string) {
    if (!doc) return;
    setSavingSection(sectionId);
    try {
      await api.updateBrsSection(doc.id, sectionId, html);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to save this section");
    } finally {
      setSavingSection(null);
    }
  }

  async function submitSection(sectionId: string) {
    if (!doc) return;
    try {
      await api.submitBrsSection(doc.id, sectionId);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to submit this section");
    }
  }

  async function doAssign(sectionId: string) {
    if (!doc || !assignPicker || assignPicker.sectionId !== sectionId || !assignPicker.value) return;
    try {
      await api.addBrsSectionAssignee(
        doc.id, sectionId,
        assignPicker.mode === "person" ? { user_id: assignPicker.value } : { section_ref_id: assignPicker.value }
      );
      setAssignPicker(null);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to assign");
    }
  }

  async function confirmSection(sectionId: string) {
    if (!doc) return;
    try {
      await api.confirmBrsSectionAssignee(doc.id, sectionId);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to confirm");
    }
  }

  async function advancePhase() {
    if (!doc) return;
    try {
      await api.advanceBrsPhase(doc.id);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "This BRS is not ready to advance yet");
    }
  }

  async function saveIntake() {
    if (!doc) return;
    setSavingIntake(true);
    try {
      await api.updateBrsIntake(doc.id, intakeEdits);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to save Intake");
    } finally {
      setSavingIntake(false);
    }
  }

  async function submitRouteApproval() {
    if (!doc) return;
    const clean = chain.filter((c) => c.approver_id && c.position_name.trim());
    if (!clean.length) { void showNotice("Add at least one approver before routing for approval."); return; }
    setRouting(true);
    try {
      await api.routeBrsApproval(doc.id, clean);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to route for approval");
    } finally {
      setRouting(false);
    }
  }

  const directorySorted = [...companyDirectory].sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  const isRequester = Boolean(doc && profile?.id && doc.requester_id === profile.id);

  // The requester always owns every section of their own document; anyone
  // else needs to actually be invited onto that section - true for Draft
  // sections too, not just Department Input ones, so the requester can bring
  // in collaborators (e.g. Legal, a co-author) to help draft.
  function isSectionOwner(section: any): boolean {
    if (isRequester) return true;
    return (section.assignees || []).some((a: any) => a.user_id === profile?.id || (a.section_ref_id && a.section_ref_id === profile?.section_id));
  }

  function myUnconfirmedAssignee(section: any) {
    return (section.assignees || []).find((a: any) =>
      !a.confirmed && (a.user_id === profile?.id || (a.section_ref_id && a.section_ref_id === profile?.section_id))
    );
  }

  // ── Landing ────────────────────────────────────────────────────────────────
  if (view === "landing") {
    const rows = landingTab === "MINE" ? mine : assigned;
    return (
      <div className="custom-requests-page">
        <div className="custom-requests-header">
          <div>
            <div className="custom-requests-title-row">
              <span className="custom-requests-title-icon"><FileText size={18} /></span>
              <h2>BRS Studio</h2>
            </div>
            <p className="custom-requests-subtitle">
              Business Requirement Specifications — draft, route for department input, and baseline before approval.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ep-btn" onClick={() => setShowNewForm((v) => !v)}><Plus size={14} /> New BRS</button>
            <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
          </div>
        </div>

        {showNewForm && (
          <div className="ep-panel" style={{ marginBottom: 16 }}>
            <div className="ep-panel-head">
              <div>
                <div className="ep-panel-title">Open a new BRS</div>
                <div className="ep-panel-sub">Every specification starts from this form — no email threads, no stray attachments.</div>
              </div>
            </div>
            <div className="ep-panel-body">
              <div className="brs-new-form-layout">
                <div className="brs-new-form-main">
                  <div className="ep-form-group">
                    <label>Title</label>
                    <input className="ep-form-input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Complimentary Gift: Birthday and Anniversary" autoFocus />
                  </div>
                  <div className="ep-form-row-3">
                    <div className="ep-form-group">
                      <label>Requesting department</label>
                      <select className="ep-form-select" value={newDepartment} onChange={(e) => setNewDepartment(e.target.value)}>
                        <option value="">Select…</option>
                        {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                    <div className="ep-form-group">
                      <label>Product owner</label>
                      <input className="ep-form-input" value={newOwner} onChange={(e) => setNewOwner(e.target.value)} placeholder="Who owns this on the business side" />
                    </div>
                    <div className="ep-form-group">
                      <label>Target launch quarter</label>
                      <select className="ep-form-select" value={newQuarter} onChange={(e) => setNewQuarter(e.target.value)}>
                        <option value="">Select…</option>
                        {quarterOptions.map((q) => <option key={q} value={q}>{q}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="ep-form-group" style={{ maxWidth: 280 }}>
                    <label>Programme type</label>
                    <select className="ep-form-select" value={newProgrammeType} onChange={(e) => setNewProgrammeType(e.target.value)}>
                      <option value="Ongoing / permanent">Ongoing / permanent</option>
                      <option value="Time-bound campaign">Time-bound campaign</option>
                    </select>
                  </div>
                  <div className="ep-form-group">
                    <label>Business justification</label>
                    <RichTextField value={newJustification} onChange={setNewJustification} placeholder="Why this is worth building, backed by whatever numbers you have…" />
                  </div>
                  <button className="ep-btn" style={{ marginTop: 4 }} disabled={creating || !defaultTypeId || !newTitle.trim()} onClick={handleCreate}>
                    {creating ? "Opening…" : "Open BRS →"}
                  </button>
                </div>
                <aside className="brs-new-form-aside">
                  <div className="brs-new-form-aside-title">How a BRS moves</div>
                  {STAGES.map((s, i) => (
                    <div className="brs-new-form-aside-step" key={s.key}>
                      <span className={`brs-new-form-aside-dot ${i === 0 ? "current" : ""}`}>{i + 1}</span>
                      <div>
                        <div className="brs-new-form-aside-step-label">{s.label}</div>
                        {i === 0 && <div className="brs-new-form-aside-step-hint">You're here — this form opens the Draft.</div>}
                      </div>
                    </div>
                  ))}
                </aside>
              </div>
            </div>
          </div>
        )}

        <div className="ep-tabs custom-request-tabs">
          <a href="#" className={`ep-tab ${landingTab === "MINE" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setLandingTab("MINE"); }}>My BRS</a>
          <a href="#" className={`ep-tab ${landingTab === "ASSIGNED" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setLandingTab("ASSIGNED"); }}>Assigned to Me</a>
        </div>

        {loadingList ? (
          <div className="ep-loading"><p>Loading…</p></div>
        ) : !rows.length ? (
          <div className="ep-empty"><p>{landingTab === "MINE" ? "You haven't opened a BRS yet." : "No BRS sections have been assigned to you yet."}</p></div>
        ) : (
          <div>
            {rows.map((d: any) => (
              <div key={d.id} className="brs-landing-row" onClick={() => openDoc(d.id)}>
                <div>
                  <div className="brs-landing-row-title">{d.title}</div>
                  <div className="brs-landing-row-meta">{d.reference_no}</div>
                </div>
                {phaseBadge(d.phase)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Workspace ──────────────────────────────────────────────────────────────
  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon"><FileText size={18} /></span>
            <h2>{doc?.title || "Loading…"}</h2>
          </div>
          <p className="custom-requests-subtitle">
            {doc ? doc.reference_no : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {doc && phaseBadge(doc.phase)}
          <button onClick={backToLanding} className="ep-btn-outline custom-requests-back"><ArrowLeft size={14} /> All BRS</button>
        </div>
      </div>

      {docLoading && !doc ? (
        <div className="ep-loading"><p>Loading…</p></div>
      ) : docError ? (
        <div className="ep-empty"><p>{docError}</p></div>
      ) : !doc ? null : (
        <>
          {(() => {
            const currentIdx = phaseIndex(doc.phase);
            const activeIdx = viewingIndex ?? currentIdx;
            const activePhase = STAGES[activeIdx].key;
            const isLive = activeIdx === currentIdx;
            return (
              <>
                <Stepper phase={doc.phase} viewing={activeIdx} onSelect={(i) => setViewingIndex(i === currentIdx ? null : i)} />

                {!isLive && (
                  <div className="brs-notify-banner" style={{ background: "var(--surface-soft)", color: "var(--muted)" }}>
                    Viewing {STAGES[activeIdx].label} (read-only) — this BRS is actually at {STAGES[currentIdx].label}.
                    <button className="ep-btn-outline" style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }} onClick={() => setViewingIndex(null)}>
                      ← Back to current stage
                    </button>
                  </div>
                )}

          {doc.phase === "DRAFT" && doc.return_comment && (
            <div className="brs-notify-banner" style={{ background: "#fef3c7", color: "#b45309" }}>
              Returned for rework: {doc.return_comment}
            </div>
          )}

          {activePhase === "INTAKE" && (() => {
            const canEditIntake = isRequester && doc.phase !== "APPROVAL" && doc.phase !== "BASELINE";
            return (
              <div className="ep-panel" style={{ marginBottom: 16 }}>
                <div className="ep-panel-head">
                  <div className="ep-panel-title">Intake</div>
                  <div className="ep-panel-sub">
                    {canEditIntake
                      ? "What was submitted to open this BRS — fill in or correct anything below at any time before this is routed for approval."
                      : "What was submitted to open this BRS."}
                  </div>
                </div>
                <div className="ep-panel-body">
                  {canEditIntake ? (
                    <>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>Requesting department</label>
                          <select className="ep-form-select" value={intakeEdits.department || ""} onChange={(e) => setIntakeEdits((prev) => ({ ...prev, department: e.target.value }))}>
                            <option value="">Select…</option>
                            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                          </select>
                        </div>
                        <div className="ep-form-group">
                          <label>Product owner</label>
                          <input className="ep-form-input" value={intakeEdits.product_owner || ""} onChange={(e) => setIntakeEdits((prev) => ({ ...prev, product_owner: e.target.value }))} placeholder="Who owns this on the business side" />
                        </div>
                      </div>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>Target launch quarter</label>
                          <select className="ep-form-select" value={intakeEdits.target_quarter || ""} onChange={(e) => setIntakeEdits((prev) => ({ ...prev, target_quarter: e.target.value }))}>
                            <option value="">Select…</option>
                            {quarterOptions.map((q) => <option key={q} value={q}>{q}</option>)}
                          </select>
                        </div>
                        <div className="ep-form-group">
                          <label>Programme type</label>
                          <select className="ep-form-select" value={intakeEdits.programme_type || "Ongoing / permanent"} onChange={(e) => setIntakeEdits((prev) => ({ ...prev, programme_type: e.target.value }))}>
                            <option value="Ongoing / permanent">Ongoing / permanent</option>
                            <option value="Time-bound campaign">Time-bound campaign</option>
                          </select>
                        </div>
                      </div>
                      <div className="ep-form-group">
                        <label>Business justification</label>
                        <RichTextField value={intakeEdits.business_justification || ""} onChange={(html) => setIntakeEdits((prev) => ({ ...prev, business_justification: html }))} placeholder="Why this is worth building, backed by whatever numbers you have…" />
                      </div>
                      <button className="ep-btn" style={{ marginTop: 4 }} disabled={savingIntake} onClick={saveIntake}>
                        {savingIntake ? "Saving…" : "Save"}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="ep-form-row">
                        <div>
                          <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 3 }}>Requesting department</div>
                          <div style={{ fontSize: 14, marginBottom: 14 }}>{doc.intake_data?.department || "—"}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 3 }}>Product owner</div>
                          <div style={{ fontSize: 14, marginBottom: 14 }}>{doc.intake_data?.product_owner || "—"}</div>
                        </div>
                      </div>
                      <div className="ep-form-row">
                        <div>
                          <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 3 }}>Target launch quarter</div>
                          <div style={{ fontSize: 14, marginBottom: 14 }}>{doc.intake_data?.target_quarter || "—"}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 3 }}>Programme type</div>
                          <div style={{ fontSize: 14, marginBottom: 14 }}>{doc.intake_data?.programme_type || "—"}</div>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginBottom: 6 }}>Business justification</div>
                      <RichTextField value={doc.intake_data?.business_justification || ""} readOnly />
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {(activePhase === "DRAFT" || activePhase === "DEPT_INPUT") && (
            <div className="ep-panel" style={{ marginBottom: 16 }}>
              <div className="ep-panel-head">
                <div className="ep-panel-title">{activePhase === "DRAFT" ? "Draft" : "Department Input"}</div>
                <div className="ep-panel-sub">
                  {activePhase === "DRAFT"
                    ? "Fill in every required section below, then send this on."
                    : "Assigned departments fill in their sections below, in parallel."}
                </div>
              </div>
              <div className="ep-panel-body">
                {doc.sections
                  .filter((s: any) => s.owner_phase === (activePhase === "DRAFT" ? "DRAFT" : "DEPT_INPUT"))
                  .map((s: any) => {
                    const canEdit = isLive && isSectionOwner(s) && s.status !== "SUBMITTED";
                    const mine = myUnconfirmedAssignee(s);
                    return (
                      <div key={s.id} className={`brs-section-card ${s.is_required && !s.content_html?.trim() ? "is-blocking" : ""}`}>
                        <div className="brs-section-card-head">
                          <div>
                            <div className="brs-section-card-title">{s.title}{s.is_required && <span style={{ color: "#dc2626" }}> *</span>}</div>
                            {s.description && <div className="brs-section-card-meta">{s.description}</div>}
                          </div>
                          <span className={`custom-status-badge custom-status-${s.status.toLowerCase().replace(/_/g, "-")}`}>{s.status.replace(/_/g, " ")}</span>
                        </div>

                        <div style={{ marginBottom: 10 }}>
                          {(s.assignees || []).map((a: any, i: number) => (
                            <div key={i} style={{ fontSize: 12, color: "var(--muted)", marginBottom: 2 }}>
                              {a.user_name || a.section_name || a.user_email || "—"}
                              {a.confirmed ? " · confirmed" : " · not yet confirmed"}
                              {a.section_ref_id && !a.confirmed && " (any member can confirm)"}
                            </div>
                          ))}
                          {(() => {
                            const picker = assignPicker && assignPicker.sectionId === s.id ? assignPicker : null;
                            if (!isLive || !(isRequester || (s.assignees || []).length > 0) || s.status === "SUBMITTED") return null;
                            return picker ? (
                              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, maxWidth: 420 }}>
                                <select className="ep-form-select" style={{ width: 90 }} value={picker.mode} onChange={(e) => setAssignPicker({ sectionId: s.id, mode: e.target.value as "person" | "section", value: "" })}>
                                  <option value="person">Person</option>
                                  <option value="section">Section</option>
                                </select>
                                {picker.mode === "person" ? (
                                  <div style={{ flex: 1 }}>
                                    <ApproverCombobox users={directorySorted} value={picker.value} onChange={(id) => setAssignPicker({ ...picker, value: id })} />
                                  </div>
                                ) : (
                                  <select className="ep-form-select" style={{ flex: 1 }} value={picker.value} onChange={(e) => setAssignPicker({ ...picker, value: e.target.value })}>
                                    <option value="">Select a section…</option>
                                    {orgSections.map((sec) => <option key={sec.id} value={sec.id}>{sec.name}</option>)}
                                  </select>
                                )}
                                <button className="ep-btn" style={{ padding: "6px 10px" }} onClick={() => doAssign(s.id)}>Add</button>
                                <button className="ep-btn-outline" style={{ padding: "6px 10px" }} onClick={() => setAssignPicker(null)}>Cancel</button>
                              </div>
                            ) : (
                              <button className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 10px", marginTop: 4 }} onClick={() => setAssignPicker({ sectionId: s.id, mode: "person", value: "" })}>
                                {s.owner_phase === "DRAFT" ? "+ Invite collaborator" : "+ Assign"}
                              </button>
                            );
                          })()}
                        </div>

                        <RichTextField
                          value={s.content_html || ""}
                          readOnly={!canEdit}
                          onChange={(html) => { s.content_html = html; }}
                        />

                        {canEdit && (
                          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                            <button
                              className="ep-btn-outline"
                              style={{ fontSize: 12, padding: "5px 12px" }}
                              disabled={savingSection === s.id}
                              onClick={() => saveSection(s.id, s.content_html || "")}
                            >
                              {savingSection === s.id ? "Saving…" : "Save"}
                            </button>
                            {mine && (
                              <button className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => confirmSection(s.id)}>
                                Confirm Ready
                              </button>
                            )}
                            {s.owner_phase === "DEPT_INPUT" && (
                              <button className="ep-btn" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => submitSection(s.id)}>
                                Mark Submitted
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                {isLive && isRequester && (
                  <button className="ep-btn" style={{ marginTop: 8 }} onClick={advancePhase}>
                    {activePhase === "DRAFT" ? "Send on →" : "Advance to Consistency Gate →"}
                  </button>
                )}
              </div>
            </div>
          )}

          {activePhase === "GATE" && (
            <div className="ep-panel" style={{ marginBottom: 16 }}>
              <div className="ep-panel-head">
                <div className="ep-panel-title">Consistency Gate</div>
                <div className="ep-panel-sub">No blanks, no gaps — every required section must be filled before this can be routed for approval.</div>
              </div>
              <div className="ep-panel-body">
                {!doc.gate.passed ? (
                  <div className="ep-empty">
                    <p>Still blocking:</p>
                    <ul>{doc.gate.blockingSections.map((b: any) => <li key={b.id}>{b.title}</li>)}</ul>
                  </div>
                ) : (
                  <>
                    <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>All required sections are filled. Build the approval chain and route it on.</p>
                    {isLive && isRequester && (
                      <>
                        {chain.map((c, idx) => (
                          <div key={idx} className="brs-chain-row">
                            <span style={{ fontSize: 12, color: "var(--muted)" }}>{idx + 1}</span>
                            <ApproverCombobox users={directorySorted} value={c.approver_id} onChange={(id) => setChain((prev) => prev.map((p, i) => i === idx ? { ...p, approver_id: id } : p))} />
                            <input
                              className="ep-form-input"
                              placeholder="Position / title (e.g. GM Marketing)"
                              value={c.position_name}
                              onChange={(e) => setChain((prev) => prev.map((p, i) => i === idx ? { ...p, position_name: e.target.value } : p))}
                            />
                            <select
                              className="ep-form-select"
                              value={c.decision_type}
                              onChange={(e) => setChain((prev) => prev.map((p, i) => i === idx ? { ...p, decision_type: e.target.value as "APPROVE" | "NOTE" } : p))}
                            >
                              <option value="APPROVE">Approving</option>
                              <option value="NOTE">Noting</option>
                            </select>
                            <button
                              className="ep-icon-btn"
                              disabled={chain.length === 1}
                              onClick={() => setChain((prev) => prev.filter((_, i) => i !== idx))}
                              title="Remove"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <button className="ep-btn-outline" onClick={() => setChain((prev) => [...prev, { approver_id: "", position_name: "", decision_type: "APPROVE" }])}>+ Add approver</button>
                          <button className="ep-btn" disabled={routing} onClick={submitRouteApproval}>{routing ? "Routing…" : "Route for Approval →"}</button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {activePhase === "APPROVAL" && (
            <div className="ep-panel" style={{ marginBottom: 16 }}>
              <div className="ep-panel-head">
                <div className="ep-panel-title">Approval Routing</div>
                <div className="ep-panel-sub">Approvers act from their Approval Inbox — this is a read-only view of progress.</div>
              </div>
              <div className="ep-panel-body">
                {(approvalSubmission?.approval_chain || []).map((step: any, idx: number) => (
                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{step.position_name}</div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>{step.approver_name}</div>
                    </div>
                    <span className={`custom-status-badge custom-status-${step.status.toLowerCase()}`}>{step.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activePhase === "BASELINE" && (
            <div className="ep-panel" style={{ marginBottom: 16 }}>
              <div className="ep-panel-head">
                <div className="ep-panel-title">Baseline</div>
                <div className="ep-panel-sub">Locked and published. Raise a Change Request from Custom Processes to amend it.</div>
              </div>
              <div className="ep-panel-body">
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <button className="ep-btn-outline" onClick={() => { void openBlobInNewTab(() => api.brsPdfBlob(doc.id)); }}>
                    <Download size={14} /> Download PDF
                  </button>
                  <button
                    className="ep-btn-outline"
                    onClick={() => { navigator.clipboard?.writeText(doc.reference_no || doc.id); void showNotice("Reference copied — paste it into \"Related BRS\" when raising a Change Request from Custom Processes."); }}
                  >
                    <ClipboardList size={14} /> Copy reference for a Change Request
                  </button>
                </div>
                {doc.sections.map((s: any) => (
                  <div key={s.id} className="brs-section-card">
                    <div className="brs-section-card-title" style={{ marginBottom: 8 }}>{s.title}</div>
                    <RichTextField value={s.content_html || ""} readOnly />
                  </div>
                ))}
              </div>
            </div>
          )}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
