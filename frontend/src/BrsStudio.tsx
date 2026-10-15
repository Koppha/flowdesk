import { useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import { api, openBlobInNewTab } from "./api";
import DistributeDialog from "./components/DistributeDialog";
import BrsHistory from "./components/BrsHistory";
import { BrsPeoplePicker, BrsRoleBadge, describeBrsPermissions } from "./components/BrsPeoplePicker";
import OrgSearchModal, { OrgEntryChip, type OrgEntry } from "./components/OrgSearchModal";
import { showNotice, confirmAction } from "./alerts";
import { RichTextField } from "./shared/RichTextField";
import { ApproverCombobox, type DirectoryUser } from "./shared/ApproverCombobox";
import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Clock, Download, FileText, History, MoreVertical, Pencil, Plus, Send, Trash2, Users } from "lucide-react";
// Generic filter-bar/empty-state/page-header pieces built for the Finance
// queue redesign - nothing about their implementation is Finance-specific,
// so BRS Studio's landing page reuses them too rather than duplicating them.
import { FinancePageHeader, FinanceFilterBar, FilterField, SearchField, SelectField, FinanceEmptyState } from "./components/FinanceQueueKit";

type BrsStudioProps = {
  profile: any;
  onBack: () => void;
  // Jumps straight to Custom Processes with "Change Request" pre-selected
  // and its "Related BRS" field pre-filled with this document's reference —
  // no more copy-to-clipboard-then-go-paste-it-yourself round trip.
  onCreateChangeRequest?: (doc: { id: string; reference_no: string }) => void;
};

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

function fmtDateTime(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
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

export default function BrsStudio({ profile, onBack, onCreateChangeRequest }: BrsStudioProps) {
  const [view, setView] = useState<"landing" | "workspace">("landing");
  const [landingTab, setLandingTab] = useState<"MINE" | "ASSIGNED" | "SHARED">("MINE");
  const [mine, setMine] = useState<any[]>([]);
  const [assigned, setAssigned] = useState<any[]>([]);
  const [shared, setShared] = useState<any[]>([]);
  const [distributing, setDistributing] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [landingDeptFilter, setLandingDeptFilter] = useState("ALL");
  const [createdByFilter, setCreatedByFilter] = useState("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // The single BRS structure everyone opens a new document against — there's
  // no "types" concept exposed to the user, so this is fetched once (and
  // auto-created server-side the first time anyone asks) rather than shown
  // as a picker.
  const [defaultTypeId, setDefaultTypeId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [newCoWriters, setNewCoWriters] = useState<OrgEntry[]>([]);
  const [assignModalSectionId, setAssignModalSectionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [peopleEdit, setPeopleEdit] = useState<{ ownerId: string; coWriters: OrgEntry[] } | null>(null);
  const [savingPeople, setSavingPeople] = useState(false);
  const [newQuarter, setNewQuarter] = useState("");
  const [newProgrammeType, setNewProgrammeType] = useState("Ongoing / permanent");
  const [newJustification, setNewJustification] = useState("");
  const [departments, setDepartments] = useState<Array<{ company: string; departments: string[] }>>([]);
  const [creating, setCreating] = useState(false);

  const [docId, setDocId] = useState<string | null>(null);
  const [doc, setDoc] = useState<any>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [approvalSubmission, setApprovalSubmission] = useState<any>(null);
  const [sendingReminder, setSendingReminder] = useState(false);
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
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainDraft[]>([{ approver_id: "", position_name: "", decision_type: "APPROVE" }]);
  const [routing, setRouting] = useState(false);

  // Landing-page KPI/filter/table data - computed unconditionally (hooks
  // can't sit after the "landing" vs "workspace" early return below), even
  // though only the landing view ever reads them; cheap over these lists.
  const rows = landingTab === "MINE" ? mine : landingTab === "ASSIGNED" ? assigned : shared;

  const kpiCounts = useMemo(() => {
    const counts = { total: rows.length, draft: 0, deptInput: 0, inApproval: 0, baseline: 0 };
    for (const d of rows) {
      if (d.phase === "DRAFT") counts.draft++;
      else if (d.phase === "DEPT_INPUT") counts.deptInput++;
      else if (d.phase === "APPROVAL" || d.phase === "GATE") counts.inApproval++;
      else if (d.phase === "BASELINE") counts.baseline++;
    }
    return counts;
  }, [rows]);

  const landingDeptOptions = useMemo(() => {
    const set = new Set<string>();
    for (const d of rows) { const dep = d.intake_data?.department; if (dep) set.add(dep); }
    return [{ value: "ALL", label: "All Departments" }, ...Array.from(set).sort().map((d) => ({ value: d, label: d }))];
  }, [rows]);

  const createdByOptions = useMemo(() => {
    const set = new Set<string>();
    for (const d of rows) { if (d.requester_name) set.add(d.requester_name); }
    return [{ value: "ALL", label: "All Users" }, ...Array.from(set).sort().map((n) => ({ value: n, label: n }))];
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows.filter((d: any) => {
      if (statusFilter !== "ALL" && d.phase !== statusFilter) return false;
      if (landingDeptFilter !== "ALL" && (d.intake_data?.department || "") !== landingDeptFilter) return false;
      if (createdByFilter !== "ALL" && (d.requester_name || "") !== createdByFilter) return false;
      if (dateFrom && (!d.created_at || d.created_at < dateFrom)) return false;
      if (dateTo && (!d.created_at || d.created_at > dateTo)) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          (d.title || "").toLowerCase().includes(q) ||
          (d.reference_no || "").toLowerCase().includes(q) ||
          (d.intake_data?.department || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rows, statusFilter, landingDeptFilter, createdByFilter, dateFrom, dateTo, search]);

  const landingTotalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const landingCurrentPage = Math.min(page, landingTotalPages);
  const pagedRows = filteredRows.slice((landingCurrentPage - 1) * pageSize, landingCurrentPage * pageSize);
  const landingShowReset = Boolean(search || statusFilter !== "ALL" || landingDeptFilter !== "ALL" || createdByFilter !== "ALL" || dateFrom || dateTo);
  function landingResetFilters() {
    setSearch(""); setStatusFilter("ALL"); setLandingDeptFilter("ALL"); setCreatedByFilter("ALL");
    setDateFrom(""); setDateTo(""); setPage(1);
  }

  useEffect(() => { setPage(1); }, [landingTab]);

  useEffect(() => {
    api.companyDirectory().then((rows: any) => setCompanyDirectory(Array.isArray(rows) ? rows : [])).catch(() => setCompanyDirectory([]));
    api.brsDefaultType().then((t: any) => setDefaultTypeId(t?.id ?? null)).catch(() => setDefaultTypeId(null));
    api.departmentsByCompany().then((rows: any) => setDepartments(Array.isArray(rows) ? rows : [])).catch(() => setDepartments([]));
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
    Promise.all([api.myBrs().catch(() => []), api.assignedToMeBrs().catch(() => []), api.brsSharedWithMe().catch(() => [])])
      .then(([m, a, sh]) => { setMine(Array.isArray(m) ? m : []); setAssigned(Array.isArray(a) ? a : []); setShared(Array.isArray(sh) ? sh : []); })
      .finally(() => setLoadingList(false));
  }

  const [deletingId, setDeletingId] = useState<string | null>(null);
  async function handleDeleteBrs(d: any) {
    const ok = await confirmAction({
      title: `Delete "${d.title}"?`,
      text: "This permanently deletes this draft BRS and everything in it. This can't be undone.",
      confirmButtonText: "Delete"
    });
    if (!ok) return;
    setDeletingId(d.id);
    try {
      await api.deleteBrs(d.id);
      loadLanding();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to delete this BRS.");
    } finally {
      setDeletingId(null);
    }
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
    setShowHistory(false);
    setPeopleEdit(null);
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
          target_quarter: newQuarter || null,
          programme_type: newProgrammeType || null,
          business_justification: newJustification || null
        },
        owner_user_id: newOwnerId || null,
        co_writers: newCoWriters.map((e) => ({ type: e.type, id: e.id ?? null, name: e.name ?? null, permissions: e.permissions ?? ["EDIT"] }))
      });
      setShowNewForm(false);
      setNewTitle("");
      setNewDepartment("");
      setNewOwnerId("");
      setNewCoWriters([]);
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

  async function assignEntries(sectionId: string, entries: OrgEntry[]) {
    if (!doc) return;
    try {
      for (const e of entries) {
        await api.addBrsSectionAssignee(doc.id, sectionId,
          e.type === "user" ? { user_id: e.id! }
            : e.type === "department" ? { section_ref_id: e.id! }
            : e.type === "section" ? { team_ref_id: e.id! }
            : { division_name: e.name! });
      }
      loadDoc(doc.id);
    } catch (err: any) {
      void showNotice(err?.message || "Failed to assign");
      loadDoc(doc.id);
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

  // Requester-initiated "go back and actually fix it" - as opposed to
  // viewingIndex, which only ever changes what's on screen. This discards
  // any approval routing in flight and clears every approval already given,
  // so it's confirmed up front.
  async function reopenDoc() {
    if (!doc) return;
    const result = await Swal.fire({
      icon: "warning",
      title: "Reopen this BRS for editing?",
      html: doc.phase === "APPROVAL" || doc.brs_approval_submission_id
        ? "This will withdraw the approval routing in progress and discard any approvals already given. The BRS goes back to Draft and will need to be routed again once you're done."
        : "This will move the BRS back to Draft so you can fix its content.",
      input: "text",
      inputPlaceholder: "What are you fixing? (optional)",
      showCancelButton: true,
      confirmButtonText: "Reopen for editing",
      confirmButtonColor: "#c22b3f"
    });
    if (!result.isConfirmed) return;
    try {
      await api.reopenBrs(doc.id, result.value || undefined);
      setViewingIndex(null);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to reopen this BRS");
    }
  }

  // Manual nudge for whoever is holding up the current approval step - the
  // same generic reminder used by Change Requests, since BRS Approval rides
  // the same custom-requests engine (see submitRouteApproval's insert into
  // custom_request_submissions).
  async function sendReminder() {
    if (!approvalSubmission?.id) return;
    setSendingReminder(true);
    try {
      const result = await api.remindCustomRequest(approvalSubmission.id);
      void showNotice(`Reminder sent to ${result.approver_name || "the current approver"}.`);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to send reminder");
    } finally {
      setSendingReminder(false);
    }
  }

  async function savePeople() {
    if (!doc || !peopleEdit) return;
    setSavingPeople(true);
    try {
      await api.setBrsPeople(doc.id, {
        owner_user_id: peopleEdit.ownerId || null,
        co_writers: peopleEdit.coWriters.map((e) => ({ type: e.type, id: e.id ?? null, name: e.name ?? null, permissions: e.permissions ?? ["EDIT"] }))
      });
      setPeopleEdit(null);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to update people");
    } finally {
      setSavingPeople(false);
    }
  }

  // Reopen an approved BRS: the approved version stays on record; the
  // amended content is re-approved as the next version.
  async function amendDoc() {
    if (!doc) return;
    const current = (doc.versions || [])[0]?.version_number;
    const result = await Swal.fire({
      icon: "question",
      title: "Amend this approved BRS?",
      html: `It goes back to Draft for changes. Version ${current ?? "1"} stays on record as approved until the amended BRS is approved again as version ${(current ?? 1) + 1}.`,
      input: "text",
      inputPlaceholder: "What is being amended? (optional)",
      showCancelButton: true,
      confirmButtonText: "Start amendment"
    });
    if (!result.isConfirmed) return;
    try {
      await api.amendBrs(doc.id, result.value || undefined);
      setViewingIndex(null);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to start the amendment");
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
  // Full rights (creator, owner, admin): drive the workflow, route, amend,
  // distribute, manage people. Writers (those plus co-writers): edit content.
  // Both come from the server, which enforces the same rules.
  const canManage = Boolean(doc?.can_manage);
  const canWrite = Boolean(doc?.can_write);
  // Co-writers get exactly what the creator/owner granted them.
  const myPerms = doc?.my_permissions || {};
  const canWorkflow = Boolean(myPerms.workflow);
  const canInvite = Boolean(myPerms.invite);
  const canDistribute = Boolean(myPerms.distribute);
  const canAmend = Boolean(myPerms.amend);

  // Writers edit every section; anyone else needs to be an assignee of it.
  function isSectionOwner(section: any): boolean {
    if (canWrite) return true;
    return (section.assignees || []).some((a: any) => a.user_id === profile?.id || (a.section_ref_id && a.section_ref_id === profile?.section_id));
  }

  function isSectionAssigneeOf(section: any): boolean {
    return (section.assignees || []).some((a: any) => a.user_id === profile?.id || (a.section_ref_id && a.section_ref_id === profile?.section_id) || (a.team_ref_id && a.team_ref_id === profile?.team_id));
  }

  async function cancelInvitation(sectionId: string, assignee: any) {
    if (!doc) return;
    const ok = await confirmAction({
      title: "Cancel this invitation?",
      text: `${assignee.user_name || assignee.section_name || assignee.team_name || assignee.division_name || "They"} will no longer be able to work on this section. What they already saved stays in History.`,
      confirmButtonText: "Cancel invitation"
    });
    if (!ok) return;
    try {
      await api.removeBrsSectionAssignee(doc.id, sectionId, assignee.id);
      loadDoc(doc.id);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to cancel the invitation");
    }
  }

  function myUnconfirmedAssignee(section: any) {
    return (section.assignees || []).find((a: any) =>
      !a.confirmed && (a.user_id === profile?.id || (a.section_ref_id && a.section_ref_id === profile?.section_id))
    );
  }

  // ── Landing ────────────────────────────────────────────────────────────────
  if (view === "landing") {
    return (
      <div className="custom-requests-page">
        <FinancePageHeader
          icon={FileText}
          title="BRS Studio"
          subtitle="Business Requirement Specifications — draft, route for department input, and baseline before approval."
          actions={
            <>
              <button className="ep-btn" onClick={() => setShowNewForm((v) => !v)}><Plus size={14} /> New BRS</button>
              <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
            </>
          }
        />

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
                        {departments.map((g) => (
                          <optgroup key={g.company} label={g.company}>
                            {g.departments.map((d) => <option key={d} value={d}>{d}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                    <div className="ep-form-group">
                      <label>Target launch quarter</label>
                      <select className="ep-form-select" value={newQuarter} onChange={(e) => setNewQuarter(e.target.value)}>
                        <option value="">Select…</option>
                        {quarterOptions.map((q) => <option key={q} value={q}>{q}</option>)}
                      </select>
                    </div>
                    <div className="ep-form-group">
                      <label>Programme type</label>
                      <select className="ep-form-select" value={newProgrammeType} onChange={(e) => setNewProgrammeType(e.target.value)}>
                        <option value="Ongoing / permanent">Ongoing / permanent</option>
                        <option value="Time-bound campaign">Time-bound campaign</option>
                      </select>
                    </div>
                  </div>
                  <BrsPeoplePicker
                    users={directorySorted}
                    ownerId={newOwnerId}
                    onOwnerChange={setNewOwnerId}
                    coWriters={newCoWriters}
                    onCoWritersChange={setNewCoWriters}
                    excludeIds={profile?.id ? [profile.id] : []}
                  />
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

        <div className="brs-kpi-row">
          <div className="brs-kpi">
            <span className="brs-kpi-icon" style={{ background: "var(--primary-soft)", color: "var(--primary)" }}><FileText size={20} /></span>
            <div><div className="brs-kpi-value">{kpiCounts.total}</div><div className="brs-kpi-label">Total BRS</div><div className="brs-kpi-sub">All records</div></div>
          </div>
          <div className="brs-kpi">
            <span className="brs-kpi-icon" style={{ background: "var(--primary-soft)", color: "var(--primary)" }}><Pencil size={20} /></span>
            <div><div className="brs-kpi-value">{kpiCounts.draft}</div><div className="brs-kpi-label">Draft</div><div className="brs-kpi-sub">In progress</div></div>
          </div>
          <div className="brs-kpi brs-kpi-tint-amber">
            <span className="brs-kpi-icon" style={{ background: "rgba(255,255,255,0.55)", color: "#92400e" }}><Send size={20} /></span>
            <div><div className="brs-kpi-value">{kpiCounts.deptInput}</div><div className="brs-kpi-label">Department Input</div><div className="brs-kpi-sub">Awaiting input</div></div>
          </div>
          <div className="brs-kpi">
            <span className="brs-kpi-icon" style={{ background: "var(--primary-soft)", color: "var(--primary)" }}><Clock size={20} /></span>
            <div><div className="brs-kpi-value">{kpiCounts.inApproval}</div><div className="brs-kpi-label">In Approval</div><div className="brs-kpi-sub">Under review</div></div>
          </div>
          <div className="brs-kpi brs-kpi-tint-green">
            <span className="brs-kpi-icon" style={{ background: "rgba(255,255,255,0.55)", color: "#065f46" }}><CheckCircle2 size={20} /></span>
            <div><div className="brs-kpi-value">{kpiCounts.baseline}</div><div className="brs-kpi-label">Baseline</div><div className="brs-kpi-sub">Approved</div></div>
          </div>
        </div>

        <div className="ep-tabs custom-request-tabs">
          <a href="#" className={`ep-tab ${landingTab === "MINE" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setLandingTab("MINE"); }}>My BRS</a>
          <a href="#" className={`ep-tab ${landingTab === "ASSIGNED" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setLandingTab("ASSIGNED"); }}>Assigned to Me</a>
          <a href="#" className={`ep-tab ${landingTab === "SHARED" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setLandingTab("SHARED"); }}>Shared with Me <span className="ep-tab-count">{shared.length}</span></a>
        </div>

        <FinanceFilterBar showReset={landingShowReset} onReset={landingResetFilters} onApply={() => setPage(1)}>
          <SearchField label="Search" placeholder="Search by BRS title, number or department…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          <SelectField
            label="Status" value={statusFilter} onChange={(v) => { setStatusFilter(v); setPage(1); }}
            options={[{ value: "ALL", label: "All Statuses" }, ...STAGES.map((s) => ({ value: s.key, label: s.label }))]}
          />
          <SelectField label="Department" value={landingDeptFilter} onChange={(v) => { setLandingDeptFilter(v); setPage(1); }} options={landingDeptOptions} />
          <SelectField label="Created By" value={createdByFilter} onChange={(v) => { setCreatedByFilter(v); setPage(1); }} options={createdByOptions} />
          <FilterField label="From Date">
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
          </FilterField>
          <FilterField label="To Date">
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          </FilterField>
        </FinanceFilterBar>

        <div className="ep-panel">
          <div className="ep-table-wrap">
            {loadingList ? (
              <div className="ep-loading"><p>Loading…</p></div>
            ) : !filteredRows.length ? (
              <FinanceEmptyState
                icon={FileText}
                title={rows.length ? "No BRS match your filters." : landingTab === "MINE" ? "You haven't opened a BRS yet." : landingTab === "SHARED" ? "No approved BRS has been distributed to you yet." : "No BRS sections have been assigned to you yet."}
                hint={rows.length ? "Try adjusting your search criteria or filters." : undefined}
              />
            ) : (
              <table className="ep-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>BRS No.</th>
                    <th>Department</th>
                    <th>Created By</th>
                    <th>Last Updated</th>
                    <th>Status</th>
                    <th style={{ width: 80 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((d: any) => (
                    <tr key={d.id} style={{ cursor: "pointer" }} onClick={() => openDoc(d.id)}>
                      <td style={{ fontWeight: 600, fontSize: "0.87rem" }}>
                        {d.title}
                        {landingTab === "MINE" && d.my_role && d.my_role !== "CREATOR" && <span style={{ marginLeft: 8 }}><BrsRoleBadge role={d.my_role} /></span>}
                      </td>
                      <td style={{ color: "var(--muted)", fontSize: 13 }}>{d.reference_no}</td>
                      <td style={{ color: "var(--muted)", fontSize: 13 }}>{d.intake_data?.department || "—"}</td>
                      <td style={{ fontSize: 13 }}>{d.requester_name || "—"}</td>
                      <td style={{ fontSize: 13 }}>{fmtDateTime(d.updated_at)}</td>
                      <td>{phaseBadge(d.phase)}</td>
                      <td style={{ display: "flex", gap: 4 }}>
                        <button className="ep-icon-btn" aria-label="Open BRS" onClick={(e) => { e.stopPropagation(); openDoc(d.id); }}>
                          <MoreVertical size={16} />
                        </button>
                        {landingTab === "MINE" && d.phase === "DRAFT" && (
                          <button
                            className="ep-icon-btn"
                            aria-label="Delete BRS"
                            title="Delete this draft"
                            disabled={deletingId === d.id}
                            onClick={(e) => { e.stopPropagation(); void handleDeleteBrs(d); }}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {filteredRows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>
                Showing {(landingCurrentPage - 1) * pageSize + 1} to {Math.min(landingCurrentPage * pageSize, filteredRows.length)} of {filteredRows.length} entries
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <select className="ep-form-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                  {[10, 25, 50].map((n) => <option key={n} value={n}>{n} per page</option>)}
                </select>
                <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={landingCurrentPage === 1}><ChevronLeft size={14} /></button>
                {Array.from({ length: landingTotalPages }, (_, i) => i + 1).slice(0, 7).map((n) => (
                  <button key={n} className={`button small-button ${landingCurrentPage === n ? "button-primary" : "button-subtle"}`} onClick={() => setPage(n)}>{n}</button>
                ))}
                <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(landingTotalPages, p + 1))} disabled={landingCurrentPage === landingTotalPages}><ChevronRight size={14} /></button>
              </div>
            </div>
          )}
        </div>
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
          {doc && (
            <button className="ep-btn-outline" onClick={() => setShowHistory((v) => !v)}>
              <History size={14} /> History
            </button>
          )}
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
                {showHistory && <BrsHistory docId={doc.id} versions={doc.versions || []} onClose={() => setShowHistory(false)} />}
                {doc.amending_from_version && doc.phase !== "BASELINE" && (
                  <div className="brs-notify-banner" style={{ background: "#ede9fe", color: "#5b21b6" }}>
                    Amending approved version {doc.amending_from_version}. That version stays on record; once this amendment is approved it becomes version {doc.amending_from_version + 1}.
                  </div>
                )}
                <Stepper phase={doc.phase} viewing={activeIdx} onSelect={(i) => setViewingIndex(i === currentIdx ? null : i)} />

                {!isLive && (
                  <div className="brs-notify-banner" style={{ background: doc.phase === "APPROVAL" && canWrite ? "#ecfdf5" : "var(--surface-soft)", color: doc.phase === "APPROVAL" && canWrite ? "#065f46" : "var(--muted)" }}>
                    {doc.phase === "APPROVAL" && canWrite && ["INTAKE", "DRAFT", "DEPT_INPUT"].includes(STAGES[activeIdx].key)
                      ? <>This BRS is in approval — you can still correct its content here. Approval carries on without restarting, and every change is kept in History.</>
                      : <>Viewing {STAGES[activeIdx].label} (read-only) — this BRS is actually at {STAGES[currentIdx].label}.</>}
                    <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                      {canWorkflow && doc.phase !== "BASELINE" && doc.phase !== "APPROVAL" && (
                        <button className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => void reopenDoc()}>
                          Reopen for editing
                        </button>
                      )}
                      <button className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setViewingIndex(null)}>
                        ← Back to current stage
                      </button>
                    </div>
                  </div>
                )}

          {doc.phase === "DRAFT" && doc.return_comment && (
            <div className="brs-notify-banner" style={{ background: "#fef3c7", color: "#b45309" }}>
              Returned for rework: {doc.return_comment}
            </div>
          )}

          {activePhase === "INTAKE" && (() => {
            const canEditIntake = canWrite && doc.phase !== "BASELINE";
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
                            {departments.map((g) => (
                          <optgroup key={g.company} label={g.company}>
                            {g.departments.map((d) => <option key={d} value={d}>{d}</option>)}
                          </optgroup>
                        ))}
                          </select>
                        </div>
                        <div className="ep-form-group">
                          <label>Product owner</label>
                          <div style={{ fontSize: 14, padding: "8px 0" }}>{doc.owner?.full_name || doc.intake_data?.product_owner || "—"} <span style={{ fontSize: 12, color: "var(--muted)" }}>(change under People)</span></div>
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
                          <div style={{ fontSize: 14, marginBottom: 14 }}>{doc.owner?.full_name || doc.intake_data?.product_owner || "—"}</div>
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

                  <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <Users size={15} /><strong style={{ fontSize: 13 }}>People</strong>
                      {canManage && !peopleEdit && (
                        <button
                          className="ep-btn-outline"
                          style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }}
                          onClick={() => setPeopleEdit({
                            ownerId: doc.owner?.id || "",
                            coWriters: (doc.co_writers || []).map((c: any) => ({ type: c.type, id: c.ref_id, name: c.division_name, label: c.label, permissions: c.permissions || [] }))
                          })}
                        >
                          Change people
                        </button>
                      )}
                    </div>
                    {peopleEdit ? (
                      <>
                        <BrsPeoplePicker
                          users={directorySorted}
                          ownerId={peopleEdit.ownerId}
                          onOwnerChange={(id) => setPeopleEdit((p) => (p ? { ...p, ownerId: id } : p))}
                          coWriters={peopleEdit.coWriters}
                          onCoWritersChange={(entries) => setPeopleEdit((p) => (p ? { ...p, coWriters: entries } : p))}
                          excludeIds={[doc.requester_id]}
                        />
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="ep-btn" disabled={savingPeople} onClick={() => void savePeople()}>{savingPeople ? "Saving…" : "Save people"}</button>
                          <button className="ep-btn-outline" disabled={savingPeople} onClick={() => setPeopleEdit(null)}>Cancel</button>
                        </div>
                      </>
                    ) : (
                      <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><BrsRoleBadge role="CREATOR" /> {doc.creator?.full_name || "—"}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><BrsRoleBadge role="OWNER" /> {doc.owner?.full_name || <span style={{ color: "var(--muted)" }}>No separate owner — the creator owns it</span>}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <BrsRoleBadge role="CO_WRITER" />
                          {(doc.co_writers || []).length
                            ? (doc.co_writers || []).map((c: any) => (
                                <span key={c.entry_id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <OrgEntryChip entry={{ type: c.type, id: c.ref_id, name: c.division_name, label: c.label }} />
                                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{describeBrsPermissions(c.permissions || [])}</span>
                                </span>
                              ))
                            : <span style={{ color: "var(--muted)" }}>None</span>}
                        </div>
                      </div>
                    )}
                  </div>
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
                    // Editable on the live step, and - so an approver's comments
                    // can be fixed without restarting - during Approval too.
                    const editingInApproval = doc.phase === "APPROVAL";
                    const canEdit = (isLive || editingInApproval) && isSectionOwner(s) && (s.status !== "SUBMITTED" || editingInApproval);
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
                              {a.user_name || (a.section_name && `${a.section_name} (Department)`) || (a.team_name && `${a.team_name} (Section)`) || (a.division_name && `${a.division_name} (Division)`) || a.user_email || "—"}
                              {a.confirmed ? " · confirmed" : " · not yet confirmed"}
                              {(a.section_ref_id || a.team_ref_id || a.division_name) && !a.confirmed && " (any member can confirm)"}
                              {a.added_by_name && <span> · invited by {a.added_by_name}</span>}
                              {(canManage || a.added_by_id === profile?.id) && (
                                <button
                                  type="button"
                                  onClick={() => void cancelInvitation(s.id, a)}
                                  title="Cancel this invitation"
                                  style={{ marginLeft: 8, border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 12, padding: 0 }}
                                >
                                  Cancel invitation
                                </button>
                              )}
                            </div>
                          ))}
                          {isLive && (canInvite || isSectionAssigneeOf(s)) && s.status !== "SUBMITTED" && (
                            <button className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 10px", marginTop: 4 }} onClick={() => setAssignModalSectionId(s.id)}>
                              {s.owner_phase === "DRAFT" ? "+ Invite collaborators" : "+ Assign"}
                            </button>
                          )}
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
                            {mine && isLive && (
                              <button className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => confirmSection(s.id)}>
                                Confirm Ready
                              </button>
                            )}
                            {s.owner_phase === "DEPT_INPUT" && isLive && (
                              <button className="ep-btn" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => submitSection(s.id)}>
                                Mark Submitted
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                {isLive && canWorkflow && (
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
                {isLive && canWorkflow && (
                  <button className="ep-btn-outline" style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }} onClick={() => void reopenDoc()}>
                    Back to Department Input
                  </button>
                )}
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
                    {!isLive && !!approvalSubmission?.approval_chain?.length && (
                      // This BRS has already moved past Gate - the live
                      // builder below only ever holds transient, in-progress
                      // input (already consumed once routed), so re-showing
                      // it here would just look empty/reset. Show what was
                      // actually submitted instead, so revisiting this step
                      // doesn't look like the approval chain got lost.
                      <div style={{ display: "grid", gap: 6 }}>
                        {approvalSubmission.approval_chain.map((c: any, idx: number) => (
                          <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                            <div>
                              <strong>{idx + 1}. {c.approver_name || "—"}</strong>
                              <span style={{ color: "var(--muted)", marginLeft: 8 }}>{c.position_name}</span>
                            </div>
                            {c.decision_type === "NOTE" && <span style={{ color: "var(--muted)", fontSize: 12 }}>Noting</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {isLive && canWorkflow && (
                      <>
                        {chain.map((c, idx) => (
                          <div key={idx} className="brs-chain-row">
                            <span style={{ fontSize: 12, color: "var(--muted)" }}>{idx + 1}</span>
                            <ApproverCombobox
                              users={directorySorted}
                              value={c.approver_id}
                              onChange={(id) => {
                                // Auto-fill the position field from the
                                // picked person's own directory title, when
                                // they have one on file - still free text
                                // otherwise (and still editable afterward
                                // either way, this is just the starting
                                // value for whoever's newly picked).
                                const picked = directorySorted.find((u) => u.id === id);
                                setChain((prev) => prev.map((p, i) => i === idx ? { ...p, approver_id: id, position_name: picked?.title || p.position_name } : p));
                              }}
                            />
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
                {isLive && canWorkflow && approvalSubmission?.status === "IN_PROGRESS" && (
                  <button
                    className="ep-btn-outline"
                    style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }}
                    disabled={sendingReminder}
                    onClick={() => void sendReminder()}
                    title="Nudge the current approver by email now, instead of waiting for the automatic reminder"
                  >
                    {sendingReminder ? "Sending…" : "Send Reminder"}
                  </button>
                )}
                {isLive && canWorkflow && (
                  <button className="ep-btn-outline" style={{ marginLeft: approvalSubmission?.status === "IN_PROGRESS" ? 8 : "auto", fontSize: 12, padding: "4px 10px" }} onClick={() => void reopenDoc()}>
                    Reopen for editing
                  </button>
                )}
              </div>
              <div className="ep-panel-body">
                {isLive && canWrite && (
                  <div className="brs-notify-banner" style={{ background: "#ecfdf5", color: "#065f46", marginBottom: 12 }}>
                    An approver has comments? Correct the content directly — approval carries on without starting over, and every change is kept in History.
                    <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                      <button className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setViewingIndex(STAGES.findIndex((x) => x.key === "INTAKE"))}>Edit Intake</button>
                      <button className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setViewingIndex(STAGES.findIndex((x) => x.key === "DRAFT"))}>Edit Draft</button>
                      <button className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setViewingIndex(STAGES.findIndex((x) => x.key === "DEPT_INPUT"))}>Edit Department Input</button>
                    </div>
                  </div>
                )}
                {(approvalSubmission?.approval_chain || []).map((step: any, idx: number) => {
                  // Same fix as CustomRequestsHub's chain view: a step only
                  // reads "Pending" while it's actually its turn - anything
                  // further down the chain shows "Waiting" instead, so it's
                  // clear approval is sequential rather than every approver
                  // appearing pending at once.
                  const displayStatus = step.acted_at
                    ? step.status
                    : idx === approvalSubmission.current_step_order && approvalSubmission.status === "IN_PROGRESS"
                      ? "PENDING"
                      : "WAITING";
                  return (
                    <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{step.position_name}</div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>{step.approver_name}</div>
                        {step.acted_at && (
                          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                            {new Date(step.acted_at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          </div>
                        )}
                      </div>
                      <span className={`custom-status-badge custom-status-${displayStatus.toLowerCase()}`}>{displayStatus}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activePhase === "BASELINE" && (
            <div className="ep-panel" style={{ marginBottom: 16 }}>
              <div className="ep-panel-head">
                <div className="ep-panel-title">Baseline</div>
                <div className="ep-panel-sub">
                  Approved{(doc.versions || [])[0] ? ` — version ${(doc.versions || [])[0].version_number}` : ""}. It is only shared with others when you distribute it. Use Amend to change it; the approved version stays on record.
                </div>
              </div>
              <div className="ep-panel-body">
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  {canDistribute && (
                    <button className="ep-btn" onClick={() => setDistributing(true)}>
                      <Send size={14} /> Distribute
                    </button>
                  )}
                  {canAmend && (
                    <button className="ep-btn-outline" onClick={() => void amendDoc()}>
                      <Pencil size={14} /> Amend
                    </button>
                  )}
                  <button className="ep-btn-outline" onClick={() => { void openBlobInNewTab(() => api.brsPdfBlob(doc.id)); }}>
                    <Download size={14} /> Download PDF
                  </button>
                  <button
                    className="ep-btn-outline"
                    onClick={() => onCreateChangeRequest?.({ id: doc.id, reference_no: doc.reference_no || doc.id })}
                  >
                    <ClipboardList size={14} /> Raise a Change Request
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
      {assignModalSectionId && doc && (() => {
        const sec = doc.sections.find((x: any) => x.id === assignModalSectionId);
        const existing = (sec?.assignees || []).map((a: any) =>
          a.user_id ? `user:${a.user_id}` : a.section_ref_id ? `department:${a.section_ref_id}` : a.team_ref_id ? `section:${a.team_ref_id}` : `division:${String(a.division_name || "").toLowerCase()}`
        );
        return (
          <OrgSearchModal
            title={sec?.owner_phase === "DRAFT" ? `Invite collaborators — ${sec?.title}` : `Assign — ${sec?.title}`}
            subtitle="Search and select employees, or a whole division, department or section. Anyone in a group can fill in and confirm this section."
            people={directorySorted}
            excludeKeys={existing}
            onAdd={(entries) => void assignEntries(assignModalSectionId, entries)}
            onClose={() => setAssignModalSectionId(null)}
          />
        );
      })()}
      {distributing && doc && (
        <DistributeDialog
          docType="BRS"
          docId={doc.id}
          title={`${doc.reference_no ? doc.reference_no + " — " : ""}${doc.title}`}
          onClose={() => setDistributing(false)}
          onDone={(count) => { void showNotice(`Distributed to ${count} ${count === 1 ? "person" : "people"}.`); }}
        />
      )}
    </div>
  );
}
