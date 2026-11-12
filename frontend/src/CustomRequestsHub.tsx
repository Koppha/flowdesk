import { useEffect, useMemo, useRef, useState } from "react";
import { RaidLogButton, RaidRegisterButton } from "./components/RaidLog";
import { createPortal } from "react-dom";
import { api, openBlobInNewTab } from "./api";
import DistributeDialog from "./components/DistributeDialog";
import ChangeRequestWorkspace from "./components/ChangeRequestWorkspace";
import { BrsPeoplePicker, CR_PERMISSION_OPTIONS, CR_PRESETS } from "./components/BrsPeoplePicker";
import OrgSearchModal, { type OrgEntry } from "./components/OrgSearchModal";
import { confirmAction, showNotice } from "./alerts";
import { ArrowDown, ArrowUp, Calendar, ChevronDown, ClipboardList, Download, FileText, Inbox, Paperclip, Plus, Search, Trash2, UploadCloud, UserCheck, Users, Share2 } from "lucide-react";
import { ApproverCombobox, COMBOBOX_DROPDOWN_HEIGHT, COMBOBOX_DROPDOWN_MIN_WIDTH, EMAIL_RE, userLabel, type DirectoryUser } from "./shared/ApproverCombobox";

type TableFieldConfig = {
  columnMode: "DAY_OF_MONTH" | "FIXED";
  monthFieldKey?: string;
  columns?: { key: string; label: string }[];
  rowSource: "FREE_TEXT" | "SELF";
  cellOptions: { value: string; label: string }[];
  summaryColumns: { key: string; label: string; countsValue: string }[];
};

const MANAGEMENT_ROLES = new Set(["MANAGER", "HOD", "EXCO", "ADMIN"]);

type TableRow = { employee: string; cells: Record<string, string> };
type TableValue = { rows: TableRow[]; summary?: { perRow: Record<string, number>[]; totals: Record<string, number> } };

type RequestField = {
  field_key: string;
  field_label: string;
  field_type: "text" | "number" | "date" | "select" | "textarea" | "checkbox" | "file" | "table" | "user" | "user_multi" | "section";
  is_required: boolean;
  placeholder: string | null;
  options: { label: string; value: string }[] | TableFieldConfig | null;
  sort_order: number;
  wizard_step: number;
};

type Attachment = { id: string; original_name: string; content_type?: string | null; size_bytes?: number | null; uploaded_at?: string };

// "user_multi" field value shape (e.g. Change Assignee) — each assignee
// individually confirms before approvers can act on the request.
// Either a person (id and/or email set) or a whole team (teamId set) — a
// team entry is confirmed by any one of its current members.
type AssigneeEntry = {
  id: string | null;
  name: string | null;
  email: string | null;
  teamId?: string | null;
  teamName?: string | null;
  // A whole Department (sections) or Division (users.department) - any one
  // member can confirm, like a Section (team).
  departmentId?: string | null;
  departmentName?: string | null;
  divisionName?: string | null;
  confirmed: boolean;
  confirmed_at: string | null;
  confirmedBy?: string | null;
};

type TeamOption = { id: string; name: string; section_id: string | null };

type FixedApprovalStep = {
  title: string;
  source: "AUTO_MANAGER" | "ROLE_PICKER";
  role?: string;
  // A step any of several roles may sign (e.g. "IS HOD/CIO" = HOD or EXCO).
  roles?: string[];
  // Pre-filled approver for a ROLE_PICKER step (set by IT); the requester can change it.
  default_approver_id?: string | null;
};

// What the requester sees of their Computer Request once it reaches IT.
const IT_STAGE_TEXT: Record<string, string> = {
  AWAITING_PROVISIONING: "Waiting for an IT officer",
  IN_PROGRESS: "Being prepared",
  PROVISIONED: "Prepared",
  READY_FOR_COLLECTION: "Ready for collection",
  HANDED_OVER: "Handed over — please confirm collection",
  COMPLETED: "Collected"
};

function initialStepApprover(step: FixedApprovalStep, managerId: string | undefined) {
  if (step.source === "AUTO_MANAGER") return managerId || "";
  return step.default_approver_id || "";
}

type RequestTypeSummary = {
  id: string;
  name: string;
  code: string;
  icon: string | null;
  color: string | null;
  status: string;
  requires_closure: boolean;
  restrict_approvers_to_management: boolean;
  approver_title_options: string[] | null;
  fixed_approval_chain: FixedApprovalStep[] | null;
};

type ChainStepDraft = {
  approver_id: string;
  position_name: string;
  // "NOTE" steps still have to act for the chain to progress, but they're
  // acknowledging the change for the record rather than formally approving
  // it (e.g. GM Internal Audit & Risk on the ECONET Change Control form).
  // Only surfaced in the UI for Change Request.
  decision_type: "APPROVE" | "NOTE";
};

type Submission = {
  id: string;
  status: string;
  data: Record<string, any>;
  approval_chain: Array<{ approver_id: string; approver_name: string | null; position_name: string; decision_type?: "APPROVE" | "NOTE"; status: string; comment: string | null; acted_at: string | null }>;
  current_step_order: number;
  created_at: string;
  request_type_id: string;
  request_type_name: string;
  request_type_code: string;
  implementation_date: string | null;
  closure_notes: string | null;
  closed_at: string | null;
  cancel_comment?: string | null;
  cancelled_at?: string | null;
  // Computer Request only: where IT Provisioning is up to.
  it_provisioning?: { status: string; assigned_to_name: string | null; asset_number: string | null; ready_for_collection_at: string | null; collection_acknowledged_at: string | null } | null;
  attachments?: Attachment[];
  // Change Request collaboration
  updated_at?: string;
  my_role?: "OWNER" | "CO_WRITER";
  requester_name?: string | null;
};

type CustomRequestsHubProps = {
  profile: any;
  // Department-scoped (the requester's own team) — used for request types
  // that restrict approvers to management within the requester's own team,
  // e.g. Attendance Register.
  requestDirectory: DirectoryUser[];
  onBack: () => void;
  // Set by BRS Studio's "Raise a Change Request" button — pre-selects the
  // Change Request type and pre-fills its "Related BRS" field with this
  // reference, consumed once on mount (see the type/field-loading effects).
  deepLink?: { brsReferenceNo: string } | null;
  // The process chosen in the sidebar's Custom Processes submenu.
  typeId?: string | null;
  onDeepLinkConsumed?: () => void;
};

function statusBadge(status: string) {
  const normalized = status.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (
    <span className={`custom-status-badge custom-status-${normalized || "default"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

// Attachments are auth-gated, so a plain <a href> won't carry the bearer
// token — fetch the blob first, then hand the browser an object URL.
function AttachmentDownloadLink({ submissionId, attachment }: { submissionId: string; attachment: Attachment }) {
  const [downloading, setDownloading] = useState(false);
  async function handleClick() {
    setDownloading(true);
    try {
      const blob = await api.customRequestAttachmentBlob(submissionId, attachment.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.original_name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* silent */
    } finally {
      setDownloading(false);
    }
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={downloading}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent, #0ea5e9)", fontSize: 13 }}
    >
      <Download size={12} /> {attachment.original_name}
    </button>
  );
}

function assigneeLabel(a: AssigneeEntry) {
  if (a.teamId) return `Section: ${a.teamName}`;
  if (a.departmentId) return `Department: ${a.departmentName}`;
  if (a.divisionName) return `Division: ${a.divisionName}`;
  return a.name || a.email || "—";
}
const isGroupAssignee = (a: AssigneeEntry) => Boolean(a.teamId || a.departmentId || a.divisionName);
// The signed-in person is covered by this assignee - themselves or a group they're in.
function assigneeIsMe(a: AssigneeEntry, profile: any) {
  if (!profile) return false;
  if (a.id && a.id === profile.id) return true;
  if (a.teamId && profile.team_id && a.teamId === profile.team_id) return true;
  if (a.departmentId && profile.section_id && a.departmentId === profile.section_id) return true;
  if (a.divisionName && profile.department && a.divisionName.trim().toLowerCase() === String(profile.department).trim().toLowerCase()) return true;
  return false;
}
const assigneeKey = (a: AssigneeEntry) => a.teamId ? `section:${a.teamId}` : a.departmentId ? `department:${a.departmentId}` : a.divisionName ? `division:${a.divisionName.toLowerCase()}` : a.id ? `user:${a.id}` : `email:${(a.email || "").toLowerCase()}`;
function orgEntryToAssignee(e: OrgEntry, users: DirectoryUser[]): AssigneeEntry {
  const base = { id: null, name: null, email: null, teamId: null, teamName: null, confirmed: false, confirmed_at: null };
  if (e.type === "section") return { ...base, teamId: e.id ?? null, teamName: e.label };
  if (e.type === "department") return { ...base, departmentId: e.id ?? null, departmentName: e.label };
  if (e.type === "division") return { ...base, divisionName: e.name ?? e.label };
  const u = users.find((x) => x.id === e.id);
  return { ...base, id: e.id ?? null, name: u?.full_name ?? e.label, email: u?.email ?? null };
}

// Search people and whole groups (the same search as BRS), plus invite by
// email for someone without an account. Used for Change Assignee.
function AssigneeOrgPicker({ users, exclude, onAdd }: { users: DirectoryUser[]; exclude: AssigneeEntry[]; onAdd: (entries: AssigneeEntry[]) => void }) {
  const [searching, setSearching] = useState(false);
  const [email, setEmail] = useState("");
  const validEmail = EMAIL_RE.test(email.trim());
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" className="ep-btn-outline" style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 38 }} onClick={() => setSearching(true)}>
        <Search size={14} /> Add people, sections, departments or divisions
      </button>
      <input className="ep-form-input" style={{ flex: 1, minWidth: 180 }} placeholder="…or invite by email" value={email} onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && validEmail) { e.preventDefault(); onAdd([{ id: null, name: null, email: email.trim(), confirmed: false, confirmed_at: null }]); setEmail(""); } }} />
      <button type="button" className="ep-btn-outline" disabled={!validEmail} style={{ height: 38 }}
        onClick={() => { onAdd([{ id: null, name: null, email: email.trim(), confirmed: false, confirmed_at: null }]); setEmail(""); }}>Invite</button>
      {searching && (
        <OrgSearchModal
          title="Assign people or groups"
          subtitle="Search and select employees, or a whole division, department or section — any one member of a group can confirm for it."
          people={users}
          excludeKeys={exclude.map(assigneeKey)}
          onAdd={(entries) => onAdd(entries.map((e) => orgEntryToAssignee(e, users)))}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  );
}

type AssigneePick = { kind: "user"; id: string } | { kind: "team"; id: string } | { kind: "email"; value: string };

// Single combined search/select for picking either a team or an individual
// (and, optionally, inviting someone by email) — one input with a search
// icon and a dropdown chevron, not a search box bolted onto a separate
// native <select>.
function AssigneeCombobox({
  users, teams, value, onChange, allowFreeEmail
}: { users: DirectoryUser[]; teams: TeamOption[]; value: AssigneePick | null; onChange: (v: AssigneePick | null) => void; allowFreeEmail?: boolean }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [openLeftward, setOpenLeftward] = useState(false);
  const [dropdownWidth, setDropdownWidth] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function isInside(target: Node) {
      return Boolean(boxRef.current?.contains(target)) || Boolean(dropdownRef.current?.contains(target));
    }
    function onOutside(e: MouseEvent) {
      if (!isInside(e.target as Node)) setOpen(false);
    }
    function onScroll(e: Event) {
      if (isInside(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  function handleOpen() {
    const rect = boxRef.current?.getBoundingClientRect();
    const spaceBelow = rect ? window.innerHeight - rect.bottom : Infinity;
    const upward = spaceBelow < COMBOBOX_DROPDOWN_HEIGHT + 16;
    setOpenUpward(upward);

    if (rect) {
      const desiredWidth = Math.max(rect.width, COMBOBOX_DROPDOWN_MIN_WIDTH);
      const spaceRight = window.innerWidth - rect.left;
      const spaceLeft = rect.right;
      const leftward = desiredWidth > spaceRight - 16 && spaceLeft >= desiredWidth;
      setOpenLeftward(leftward);
      setDropdownWidth(Math.min(desiredWidth, window.innerWidth - 16));
      setAnchor({
        top: rect.bottom + 2,
        bottom: window.innerHeight - rect.top + 2,
        left: rect.left,
        right: window.innerWidth - rect.right
      });
    } else {
      setOpenLeftward(false);
      setDropdownWidth(null);
      setAnchor(null);
    }

    setOpen(true);
    setQuery("");
  }

  const selectedUserForLabel = value?.kind === "user" ? users.find((u) => u.id === value.id) : undefined;
  const selectedLabel =
    value?.kind === "team" ? `Section: ${teams.find((t) => t.id === value.id)?.name ?? ""}`
    : selectedUserForLabel ? userLabel(selectedUserForLabel)
    : value?.kind === "email" ? value.value
    : "";

  const trimmedQuery = query.trim();
  const q = trimmedQuery.toLowerCase();
  const matchingTeams = q ? teams.filter((t) => t.name.toLowerCase().includes(q)) : teams;
  const matchingUsers = q ? users.filter((u) => userLabel(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) : users;
  const isQueryEmail = Boolean(allowFreeEmail) && EMAIL_RE.test(trimmedQuery);
  const hasExactEmailMatch = matchingUsers.some((u) => u.email.toLowerCase() === q);
  const showInviteOption = isQueryEmail && !hasExactEmailMatch;

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <Search size={13} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
        <input
          className="ep-form-input"
          style={{ paddingLeft: 26, paddingRight: 26 }}
          placeholder="Assign a section or individual"
          value={open ? query : selectedLabel}
          onFocus={handleOpen}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ChevronDown size={14} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none" }} />
      </div>
      {open && anchor && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed", zIndex: 1000,
            width: dropdownWidth ?? "100%",
            ...(openLeftward ? { right: anchor.right } : { left: anchor.left }),
            ...(openUpward ? { bottom: anchor.bottom } : { top: anchor.top }),
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
            maxHeight: COMBOBOX_DROPDOWN_HEIGHT, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.12)"
          }}
        >
          {matchingTeams.length > 0 && (
            <>
              <div style={{ padding: "6px 12px", fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>Sections</div>
              {matchingTeams.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { onChange({ kind: "team", id: t.id }); setOpen(false); setQuery(""); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: value?.kind === "team" && value.id === t.id ? "#eff6ff" : "transparent", cursor: "pointer", fontSize: 13 }}
                >
                  <Users size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                  <span style={{ fontWeight: 600 }}>{t.name}</span>
                </button>
              ))}
            </>
          )}
          {matchingUsers.length > 0 && (
            <>
              <div style={{ padding: "6px 12px", fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>People</div>
              {matchingUsers.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { onChange({ kind: "user", id: u.id }); setOpen(false); setQuery(""); }}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: value?.kind === "user" && value.id === u.id ? "#eff6ff" : "transparent", cursor: "pointer", fontSize: 13 }}
                >
                  <div style={{ fontWeight: 600 }}>{u.full_name || u.email}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{u.email}{u.title ? ` · ${u.title}` : u.department ? ` · ${u.department}` : ""}</div>
                </button>
              ))}
            </>
          )}
          {showInviteOption && (
            <button
              type="button"
              onClick={() => { onChange({ kind: "email", value: trimmedQuery }); setOpen(false); setQuery(""); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", borderTop: "1px solid var(--border)", background: "transparent", cursor: "pointer", fontSize: 13 }}
            >
              <div style={{ fontWeight: 600 }}>Invite "{trimmedQuery}"</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Not yet a FlowDesk user — they'll get an email about this request</div>
            </button>
          )}
          {matchingTeams.length === 0 && matchingUsers.length === 0 && !showInviteOption && (
            <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--muted)" }}>
              {allowFreeEmail ? "No matches. Type a full email address to invite someone new." : "No matches."}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

// A "section" field (e.g. Change Implementor): the same people-and-groups
// search as Change Assignee, but just a record of who carries it out - no
// confirmation step. Stored as the chosen names, "; "-separated, so a value
// saved before (one section's name) still shows, and the PDF and the
// "you're the implementor" notification read the names
// (custom-requests.routes.ts).
function ImplementorField({ value, users, onChange }: { value: string; users: DirectoryUser[]; onChange: (value: string) => void }) {
  const [searching, setSearching] = useState(false);
  const names = String(value || "").split(";").map((s) => s.trim()).filter(Boolean);
  const setNames = (next: string[]) => onChange([...new Set(next)].join("; "));
  return (
    <div>
      {names.map((n, idx) => (
        <div key={`${n}-${idx}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--surface-soft)", borderRadius: 6, marginBottom: 6, fontSize: 13 }}>
          <strong>{n}</strong>
          <button type="button" className="ep-icon-btn" onClick={() => setNames(names.filter((_, i) => i !== idx))} title="Remove">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="ep-btn-outline" style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 38 }} onClick={() => setSearching(true)}>
        <Search size={14} /> {names.length ? "Add more" : "Add people, sections, departments or divisions"}
      </button>
      {searching && (
        <OrgSearchModal
          title="Choose the implementor"
          subtitle="Search and select who carries out the change - employees, or a whole division, department or section."
          people={users}
          excludeKeys={[]}
          onAdd={(entries) => setNames([
            ...names,
            ...entries.map((e) => e.type === "user" ? (users.find((u) => u.id === e.id)?.full_name || e.label) : e.type === "division" ? (e.name ?? e.label) : e.label)
          ])}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  );
}

// Editable list of assignees for a "user_multi" field (e.g. Change Assignee)
// while composing a new request — pick a system user, invite by email, or
// assign a whole team (any member can confirm later). Confirmation happens
// post-submission.
function UserMultiField({
  entries, users, onAdd, onRemove
}: { entries: AssigneeEntry[]; users: DirectoryUser[]; teams?: TeamOption[]; onAdd: (entry: AssigneeEntry) => void; onRemove: (idx: number) => void }) {
  return (
    <div>
      {entries.map((a, idx) => (
        <div key={idx} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--surface-soft)", borderRadius: 6, marginBottom: 6, fontSize: 13 }}>
          <div>
            <strong>{assigneeLabel(a)}</strong>
            {!a.id && !isGroupAssignee(a) && <span style={{ color: "var(--muted)" }}> · invited, no account yet</span>}
            {a.id && a.name && <span style={{ color: "var(--muted)" }}> · {a.email}</span>}
            {isGroupAssignee(a) && <span style={{ color: "var(--muted)" }}> · any member can confirm</span>}
          </div>
          <button type="button" className="ep-icon-btn" onClick={() => onRemove(idx)} title="Remove">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <AssigneeOrgPicker users={users} exclude={entries} onAdd={(added) => added.forEach(onAdd)} />
    </div>
  );
}

// Inline "add another assignee" picker for an already-submitted request
// (Assigned to Me tab) — pull in another person or a whole group to help.
type AssigneeAddPayload = { id?: string; email?: string; name?: string; team_id?: string; department_id?: string; division_name?: string };
function AssigneeAdder({
  users, existing, onAdd
}: { users: DirectoryUser[]; teams?: TeamOption[]; existing?: AssigneeEntry[]; onAdd: (entry: AssigneeAddPayload) => void }) {
  return (
    <AssigneeOrgPicker users={users} exclude={existing ?? []} onAdd={(entries) => entries.forEach((a) => onAdd(
      a.teamId ? { team_id: a.teamId } : a.departmentId ? { department_id: a.departmentId } : a.divisionName ? { division_name: a.divisionName } : a.id ? { id: a.id } : { email: a.email ?? undefined }
    ))} />
  );
}

function daysInMonth(dateValue: string | undefined) {
  const d = dateValue ? new Date(dateValue) : null;
  if (!d || Number.isNaN(d.getTime())) return 31;
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// <input type="month"> has no usable picker in some browsers (e.g. Firefox
// falls back to a plain text box), so the month field is a button showing
// "Month yyyy" with a calendar icon that opens a year/month-grid popup —
// universally clickable, no typing required. The underlying value stays the
// 1st of that month (e.g. "2026-06-01") so existing date-based logic
// (daysInMonth, date_trunc in SQL) keeps working unchanged.
function MonthYearPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const d = value ? new Date(value) : null;
  const selectedMonth = d && !Number.isNaN(d.getTime()) ? d.getMonth() : null;
  const selectedYear = d && !Number.isNaN(d.getTime()) ? d.getFullYear() : null;

  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(selectedYear ?? new Date().getFullYear());
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const boxRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function isInside(target: Node) {
      return Boolean(boxRef.current?.contains(target)) || Boolean(popupRef.current?.contains(target));
    }
    function onOutside(e: MouseEvent) {
      if (!isInside(e.target as Node)) setOpen(false);
    }
    function onScroll(e: Event) {
      if (isInside(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  function handleOpen() {
    const rect = boxRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 260) });
    setViewYear(selectedYear ?? new Date().getFullYear());
    setOpen(true);
  }

  function pickMonth(monthIdx: number) {
    onChange(`${viewYear}-${String(monthIdx + 1).padStart(2, "0")}-01`);
    setOpen(false);
  }

  const displayLabel = selectedMonth !== null && selectedYear !== null ? `${MONTH_NAMES[selectedMonth]} ${selectedYear}` : "";

  return (
    <>
      <button
        ref={boxRef}
        type="button"
        className="ep-form-input"
        onClick={handleOpen}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left", cursor: "pointer", color: displayLabel ? "inherit" : "var(--muted)" }}
      >
        {displayLabel || "Select month…"}
        <Calendar size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
      </button>
      {open && anchor && createPortal(
        <div
          ref={popupRef}
          style={{
            position: "fixed", top: anchor.top, left: anchor.left, width: anchor.width, zIndex: 1000,
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: 10
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <button type="button" className="ep-icon-btn" onClick={() => setViewYear((y) => y - 1)} title="Previous year">
              <ArrowUp size={14} style={{ transform: "rotate(-90deg)" }} />
            </button>
            <strong style={{ fontSize: 13 }}>{viewYear}</strong>
            <button type="button" className="ep-icon-btn" onClick={() => setViewYear((y) => y + 1)} title="Next year">
              <ArrowDown size={14} style={{ transform: "rotate(-90deg)" }} />
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {MONTH_NAMES_SHORT.map((name, idx) => {
              const isSelected = selectedYear === viewYear && selectedMonth === idx;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => pickMonth(idx)}
                  style={{
                    padding: "8px 4px", borderRadius: 6, fontSize: 13, cursor: "pointer",
                    border: isSelected ? "1px solid var(--accent, #0ea5e9)" : "1px solid transparent",
                    background: isSelected ? "var(--accent, #0ea5e9)" : "var(--surface-soft)",
                    color: isSelected ? "#fff" : "inherit", fontWeight: isSelected ? 700 : 400
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function tableColumns(cfg: TableFieldConfig | null | undefined, values: Record<string, any>) {
  if (!cfg) return [] as { key: string; label: string }[];
  if (cfg.columnMode === "FIXED") return cfg.columns || [];
  const days = daysInMonth(cfg.monthFieldKey ? values[cfg.monthFieldKey] : undefined);
  return Array.from({ length: days }, (_, i) => ({ key: String(i + 1), label: String(i + 1) }));
}

// True if day-of-month `day` (1-based) falls on a Saturday/Sunday in the
// month `monthValue` (e.g. "2026-06-01") points to — used to tint weekend
// columns in a DAY_OF_MONTH table, same as the attendance register mockup.
function isWeekendDay(monthValue: string | undefined, day: number): boolean {
  if (!monthValue) return false;
  const m = new Date(monthValue);
  if (Number.isNaN(m.getTime())) return false;
  const wd = new Date(m.getFullYear(), m.getMonth(), day).getDay();
  return wd === 0 || wd === 6;
}

const CELL_BADGE_PALETTE = [
  { bg: "#dbeafe", fg: "#1d4ed8" },
  { bg: "#ffedd5", fg: "#c2410c" },
  { bg: "#fef9c3", fg: "#a16207" },
  { bg: "#dcfce7", fg: "#15803d" },
  { bg: "#f3e8ff", fg: "#7e22ce" },
  { bg: "#fee2e2", fg: "#b91c1c" },
  { bg: "#ccfbf1", fg: "#0f766e" },
  { bg: "#fce7f3", fg: "#be185d" },
  { bg: "#f1f5f9", fg: "#475569" }
];

function cellBadgeColor(idx: number) {
  return CELL_BADGE_PALETTE[idx % CELL_BADGE_PALETTE.length];
}

function computeTableSummary(cfg: TableFieldConfig | null | undefined, rows: TableRow[]) {
  const summaryColumns = cfg?.summaryColumns || [];
  const perRow = rows.map((row) => {
    const counts: Record<string, number> = {};
    for (const sc of summaryColumns) {
      counts[sc.key] = Object.values(row.cells).filter((v) => v === sc.countsValue).length;
    }
    return counts;
  });
  const totals: Record<string, number> = {};
  for (const sc of summaryColumns) {
    totals[sc.key] = perRow.reduce((sum, r) => sum + (r[sc.key] || 0), 0);
  }
  return { perRow, totals };
}

export default function CustomRequestsHub({ profile, requestDirectory, onBack, deepLink, onDeepLinkConsumed, typeId }: CustomRequestsHubProps) {
  const [tab, setTab] = useState<"NEW" | "MINE" | "ASSIGNED" | "SHARED">("NEW");
  const [shared, setShared] = useState<Array<Submission & { requester_name?: string | null; distributed_at?: string; distributed_by_name?: string | null; distribution_message?: string | null }>>([]);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [distributingId, setDistributingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [types, setTypes] = useState<RequestTypeSummary[]>([]);
  // Approvers can be anyone in the company, not just the requester's own
  // department — e.g. a Change Request signer may sit in a different division.
  const [companyDirectory, setCompanyDirectory] = useState<DirectoryUser[]>([]);
  const [sections, setSections] = useState<{ id: string; name: string }[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [fields, setFields] = useState<RequestField[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [chain, setChain] = useState<ChainStepDraft[]>([{ approver_id: "", position_name: "", decision_type: "APPROVE" }]);
  const [myManager, setMyManager] = useState<DirectoryUser | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mine, setMine] = useState<Submission[]>([]);
  const [assignedToMe, setAssignedToMe] = useState<Submission[]>([]);
  const [assignedToMeLoading, setAssignedToMeLoading] = useState(false);
  const [assignedToMeError, setAssignedToMeError] = useState<string | null>(null);
  const [expandedAssigned, setExpandedAssigned] = useState<Set<string>>(new Set());
  // The assigned-to-me list doesn't include field metadata per submission —
  // fetch each distinct request type's "user_multi" fields once and cache.
  const [assignedTypeFields, setAssignedTypeFields] = useState<Record<string, RequestField[]>>({});
  const [assigneeActionError, setAssigneeActionError] = useState<string | null>(null);
  // Change Request, step 1: an assignee's comment for Roll back / Reject, per request.
  const [assigneeComment, setAssigneeComment] = useState<Record<string, string>>({});
  // Local edit buffer for implementation-side fields (Implementation Plan,
  // Callout Person/Contact) an assignee fills in before confirming — keyed
  // by submission id so multiple cards can be edited independently.
  const [implEdits, setImplEdits] = useState<Record<string, Record<string, any>>>({});
  const [savingImplId, setSavingImplId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeImplDate, setCloseImplDate] = useState("");
  const [closeNotes, setCloseNotes] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  // Which page of the NEW-request wizard is showing — 1-indexed field pages,
  // plus one implicit final page ("Approvals") past the highest wizard_step.
  const [wizardStep, setWizardStep] = useState(1);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const [cancelComment, setCancelComment] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [remindingId, setRemindingId] = useState<string | null>(null);
  // Change Request collaboration: the open workspace, the draft being
  // submitted through the wizard, and the "save as draft" people dialog.
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftDialog, setDraftDialog] = useState<{ ownerIds: string[]; coWriters: OrgEntry[] } | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  // Attendance Register only - day-by-day autosave (see attendance.routes.ts)
  // lets the grid be built up over several sessions instead of only ever
  // reaching the database on final Submit.
  const [attendanceSaveStatus, setAttendanceSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [attendancePeriodLocked, setAttendancePeriodLocked] = useState(false);

  const selectedType = types.find((t) => t.id === selectedTypeId) || null;
  const isChangeRequestType = selectedType?.code === "CHANGE_REQUEST";
  // Change Request: a Back-out Plan is required once Impact is Significant
  // or Major (RAID CR R3) - the server enforces the same rule.
  const isFieldRequired = (f: RequestField) =>
    f.is_required || (isChangeRequestType && f.field_key === "back_out_plan" && ["SIGNIFICANT", "MAJOR"].includes(String(values.impact || "").toUpperCase()));

  // A new Change Request is saved as a draft first, for its owners and
  // co-writers to work on; approvers are only picked when it's submitted from
  // that draft. So the form has no approvals page until then.
  const crNeedsDraft = isChangeRequestType && !draftId;

  // Group fields into wizard pages by their configured wizard_step, then
  // append one implicit final page for the approval chain / change control.
  const fieldStepNumbers = useMemo(() => [...new Set(fields.map((f) => f.wizard_step || 1))].sort((a, b) => a - b), [fields]);
  const approvalsStepIndex = fieldStepNumbers.length + 1;
  const totalWizardSteps = crNeedsDraft ? fieldStepNumbers.length : approvalsStepIndex;
  const currentStepFields = useMemo(
    () => fields.filter((f) => (f.wizard_step || 1) === (fieldStepNumbers[wizardStep - 1] ?? 1)),
    [fields, fieldStepNumbers, wizardStep]
  );
  const isApprovalsStep = wizardStep === approvalsStepIndex;

  useEffect(() => {
    api.companyDirectory().then((rows: any) => setCompanyDirectory(Array.isArray(rows) ? rows : [])).catch(() => setCompanyDirectory([]));
    api.myManager().then((row: any) => setMyManager(row || null)).catch(() => setMyManager(null));
    api.sections().then((rows: any) => setSections(Array.isArray(rows) ? rows : [])).catch(() => setSections([]));
    api.teams().then((rows: any) => setTeams(Array.isArray(rows) ? rows : [])).catch(() => setTeams([]));
  }, []);

  async function loadAssignedToMe() {
    setAssignedToMeLoading(true);
    setAssignedToMeError(null);
    try {
      const rows: Submission[] = await api.assignedToMeCustomRequests();
      setAssignedToMe(Array.isArray(rows) ? rows : []);

      const typeIds = [...new Set((rows || []).map((r) => r.request_type_id))];
      const missing = typeIds.filter((id) => !assignedTypeFields[id]);
      if (missing.length) {
        const fetched = await Promise.all(missing.map((id) => api.requestTypeDetail(id).catch(() => null)));
        setAssignedTypeFields((prev) => {
          const next = { ...prev };
          fetched.forEach((detail: any, i) => {
            if (detail?.fields) next[missing[i]] = detail.fields;
          });
          return next;
        });
      }
    } catch (e: any) {
      setAssignedToMeError(e?.message || "Failed to load requests assigned to you.");
    } finally {
      setAssignedToMeLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "ASSIGNED") loadAssignedToMe();
    if (tab === "SHARED") {
      setSharedLoading(true);
      api.customRequestsSharedWithMe()
        .then((rows: any) => setShared(Array.isArray(rows) ? rows : []))
        .catch(() => setShared([]))
        .finally(() => setSharedLoading(false));
    }
  }, [tab]);

  // Choosing another process in the sidebar switches this page to it.
  useEffect(() => {
    if (typeId && types.some((t) => t.id === typeId)) setSelectedTypeId(typeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId]);

  useEffect(() => {
    (async () => {
      try {
        const allTypes = await api.requestTypes();
        // Internal types (e.g. BRS_APPROVAL) only ever get a submission
        // created programmatically by their owning module - never picked
        // from this "New Request" list, even though they're an otherwise
        // completely ordinary, active custom_request_types row.
        const active: RequestTypeSummary[] = (allTypes || []).filter((t: any) => t.status === "ACTIVE" && !t.is_internal);
        setTypes(active);
        if (!active.length) {
          setError("No processes have been configured yet.");
          return;
        }
        // A BRS-originated deep link pre-selects Change Request instead of
        // the first type in the list — read once at mount, same as the
        // field pre-fill below.
        // The sidebar picks the process (typeId); a BRS deep link means
        // Change Request.
        const preselect = (typeId ? active.find((t) => t.id === typeId) : null)
          || (deepLink ? active.find((t) => t.code === "CHANGE_REQUEST") : null);
        setSelectedTypeId((preselect || active[0]).id);
      } catch {
        setError("Failed to load processes.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedTypeId) return;
    (async () => {
      setLoading(true);
      try {
        const detail = await api.requestTypeDetail(selectedTypeId);
        const sorted = [...(detail.fields || [])].sort((a: any, b: any) => a.sort_order - b.sort_order);
        setFields(sorted);
        setWizardStep(1);
        setAttachmentFiles([]);
        const initialValues: Record<string, any> = {};
        const myName = profile?.full_name || profile?.fullName || "";
        // Known from the requester's own org-structure profile — pre-fill
        // rather than asking them to retype it. Permanent staff have a real
        // job title; non-permanent staff (interns, temps, contractors) often
        // don't, so fall back to their employment type instead.
        const isPermanent = String(profile?.employment_type || "").toUpperCase() === "PERMANENT";
        const isChangeRequestDetail = (detail as RequestTypeSummary).code === "CHANGE_REQUEST";
        const knownByFieldKey: Record<string, string> = {
          division: profile?.division_name || "",
          department: profile?.department || "",
          position: isPermanent ? (profile?.title || "") : (profile?.employment_type || ""),
          emp_no: profile?.employee_no || ""
        };
        if (isChangeRequestDetail && deepLink?.brsReferenceNo) {
          knownByFieldKey.related_brs_document_id = deepLink.brsReferenceNo;
        }
        const today = new Date().toISOString().slice(0, 10);
        const isAttendanceRegister = (detail as RequestTypeSummary).code === "ATTENDANCE_REGISTER";
        for (const f of sorted) {
          if (f.field_type === "table" && (f.options as TableFieldConfig | null)?.rowSource === "SELF") {
            initialValues[f.field_key] = { rows: [{ employee: myName, cells: {} }] };
          } else if (f.field_type === "text" && knownByFieldKey[f.field_key]) {
            initialValues[f.field_key] = knownByFieldKey[f.field_key];
          } else if (f.field_type === "date" && f.field_key === "date_requested") {
            initialValues[f.field_key] = today;
          } else if (f.field_type === "date" && f.field_key === "month" && isAttendanceRegister) {
            // Defaults to the current month so day-by-day logging can start
            // immediately, without first asking the employee to pick one.
            initialValues[f.field_key] = today;
          }
        }
        setAttendanceSaveStatus("idle");
        setAttendancePeriodLocked(false);
        if (isAttendanceRegister) {
          try {
            const period = today.slice(0, 7);
            const draft = await api.attendanceDraft(period);
            if (draft?.cells && Object.keys(draft.cells).length) {
              initialValues.attendance_grid = { rows: [{ employee: myName, cells: draft.cells }] };
            }
            setAttendancePeriodLocked(Boolean(draft?.locked));
          } catch {
            // No draft yet, or the lookup failed - the form still works,
            // it just starts blank exactly as it always has.
          }
        }
        setValues(initialValues);
        if (isChangeRequestDetail && deepLink?.brsReferenceNo) onDeepLinkConsumed?.();
        const fixedChain = (detail as RequestTypeSummary).fixed_approval_chain;
        if (fixedChain?.length) {
          setChain(fixedChain.map((step) => ({
            approver_id: initialStepApprover(step, myManager?.id),
            position_name: step.title,
            decision_type: "APPROVE"
          })));
        } else {
          setChain([{ approver_id: "", position_name: "", decision_type: "APPROVE" }]);
        }
      } catch {
        setError("Failed to load the request form.");
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedTypeId, myManager, profile?.title, profile?.employment_type, profile?.department, profile?.division_name, profile?.employee_no]);

  // Attendance Register only - autosaves the day-grid to a DRAFT submission
  // (attendance.routes.ts) a second or so after the employee stops editing,
  // so progress survives closing the browser instead of only ever being
  // written to the database on final Submit.
  const isAttendanceRegisterSelected = selectedType?.code === "ATTENDANCE_REGISTER";
  useEffect(() => {
    if (!isAttendanceRegisterSelected || attendancePeriodLocked) return;
    const cells = values.attendance_grid?.rows?.[0]?.cells;
    const period = String(values.month || "").slice(0, 7);
    if (!cells || !period) return;
    setAttendanceSaveStatus("saving");
    const handle = setTimeout(() => {
      api.saveAttendanceDraft({ period, division: values.division, department: values.department, cells })
        .then(() => setAttendanceSaveStatus("saved"))
        .catch(() => setAttendanceSaveStatus("error"));
    }, 1000);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAttendanceRegisterSelected, attendancePeriodLocked, values.attendance_grid, values.month, values.division, values.department]);

  async function loadMine() {
    if (!selectedType) return;
    try {
      const rows = await api.myCustomRequests();
      const own = Array.isArray(rows) ? rows.filter((r: any) => r.request_type_code === selectedType.code) : [];
      // Change Requests I own or co-write but didn't start show here too.
      const shared = selectedType.code === "CHANGE_REQUEST" ? await api.changeRequestsCollaborating().catch(() => []) : [];
      const ids = new Set(own.map((r: any) => r.id));
      setMine([...own, ...(Array.isArray(shared) ? shared.filter((r: any) => !ids.has(r.id)) : [])]
        .sort((a: any, b: any) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))));
    } catch { /* silent */ }
  }

  useEffect(() => {
    if (tab === "MINE") loadMine();
  }, [tab, selectedTypeId]);

  function setValue(key: string, value: any) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function addChainStep() {
    setChain((prev) => [...prev, { approver_id: "", position_name: "", decision_type: "APPROVE" }]);
  }

  function removeChainStep(idx: number) {
    setChain((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveChainStep(idx: number, dir: -1 | 1) {
    setChain((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function updateChainStep(idx: number, patch: Partial<ChainStepDraft>) {
    setChain((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  const directorySorted = useMemo(() => {
    // Management-restricted types (e.g. Attendance Register) are scoped to
    // the requester's own team — everything else can pick anyone company-wide.
    const pool = selectedType?.restrict_approvers_to_management
      ? requestDirectory.filter((u) => MANAGEMENT_ROLES.has(String(u.role || "").toUpperCase()))
      : companyDirectory;
    return [...pool].sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  }, [companyDirectory, requestDirectory, selectedType?.restrict_approvers_to_management]);

  // "user" fields (e.g. Change Assignee) always pick from anyone company-wide,
  // independent of any approver restriction on this request type.
  const companyDirectorySorted = useMemo(
    () => [...companyDirectory].sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email)),
    [companyDirectory]
  );

  // For fixed approval chains (e.g. Computer Request), each ROLE_PICKER step
  // is scoped to company-wide users holding one of the step's roles (e.g.
  // only Managers for "IT Manager", HODs or Exco members for "IS HOD/CIO").
  function directoryForStep(step: FixedApprovalStep) {
    const roles = (step.roles?.length ? step.roles : step.role ? [step.role] : []).map((r) => r.toUpperCase());
    if (!roles.length) return companyDirectory;
    return [...companyDirectory]
      .filter((u) => roles.includes(String(u.role || "").toUpperCase()))
      .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  }

  async function handleSubmit() {
    if (!selectedTypeId) return;
    setError(null);

    if (isAttendanceRegisterSelected && attendancePeriodLocked) {
      setError("This attendance period has been closed for submissions — contact HR/Admin.");
      return;
    }

    for (const f of fields) {
      if (isFieldRequired(f)) {
        const v = values[f.field_key];
        const isEmpty = f.field_type === "table"
          ? !v?.rows?.length
          : f.field_type === "user_multi"
            ? !Array.isArray(v) || !v.length
            : (v === undefined || v === null || v === "");
        if (isEmpty) {
          setError(`"${f.field_label}" is required`);
          return;
        }
      }
    }

    const fixedChain = selectedType?.fixed_approval_chain;
    let submitChain: { approver_id: string | null; position_name: string; decision_type: "APPROVE" | "NOTE" }[];
    if (fixedChain?.length) {
      for (let i = 0; i < fixedChain.length; i++) {
        const isAutoManagerResolved = fixedChain[i].source === "AUTO_MANAGER" && myManager;
        if (!isAutoManagerResolved && !chain[i]?.approver_id) {
          setError(`Please select an approver for "${fixedChain[i].title}".`);
          return;
        }
      }
      submitChain = fixedChain.map((step, i) => ({
        approver_id: chain[i].approver_id || null,
        position_name: step.title,
        decision_type: "APPROVE"
      }));
    } else {
      const validChain = chain.filter((s) => s.approver_id && s.position_name.trim());
      if (!validChain.length) {
        setError("Please define at least one approval step.");
        return;
      }
      submitChain = validChain;
    }

    // Embed a frozen summary snapshot for any table fields before submitting.
    const payloadData: Record<string, any> = { ...values };
    for (const f of fields) {
      if (f.field_type === "table") {
        const cfg = f.options as TableFieldConfig | null;
        const tv: TableValue | undefined = payloadData[f.field_key];
        if (tv?.rows) payloadData[f.field_key] = { ...tv, summary: computeTableSummary(cfg, tv.rows) };
      } else if (f.field_type === "user" && payloadData[f.field_key]) {
        // Store a human-readable snapshot, not the raw user id — detail/list
        // views render this value directly with no lookup against the directory.
        const picked = companyDirectorySorted.find((u) => u.id === payloadData[f.field_key]);
        if (picked) payloadData[f.field_key] = userLabel(picked);
      }
    }

    setSubmitting(true);
    try {
      await api.submitCustomRequest({
        request_type_id: selectedTypeId,
        data: payloadData,
        approval_chain: submitChain,
        draft_id: draftId
      }, attachmentFiles);
      setDraftId(null);
      setValues({});
      setChain(
        fixedChain?.length
          ? fixedChain.map((step) => ({ approver_id: initialStepApprover(step, myManager?.id), position_name: step.title, decision_type: "APPROVE" as const }))
          : [{ approver_id: "", position_name: "", decision_type: "APPROVE" }]
      );
      setAttachmentFiles([]);
      setWizardStep(1);
      setTab("MINE");
    } catch (e: any) {
      setError(e?.message || "Failed to submit the request");
    } finally {
      setSubmitting(false);
    }
  }

  // Validates the fields on the currently-shown wizard page only, so a user
  // can't be blocked by a required field on a page they haven't reached yet.
  function goToNextStep() {
    setError(null);
    for (const f of currentStepFields) {
      if (!isFieldRequired(f)) continue;
      const v = values[f.field_key];
      const isEmpty = f.field_type === "table"
        ? !v?.rows?.length
        : f.field_type === "user_multi"
          ? !Array.isArray(v) || !v.length
          : (v === undefined || v === null || v === "");
      if (isEmpty) {
        setError(`"${f.field_label}" is required`);
        return;
      }
    }
    setWizardStep((s) => Math.min(s + 1, totalWizardSteps));
  }

  // Change Request only: save the form as a draft that owners and co-writers
  // finish together. A draft already open in the wizard is just updated.
  async function saveChangeRequestDraft(people?: { ownerIds: string[]; coWriters: OrgEntry[] }) {
    setSavingDraft(true);
    setError(null);
    try {
      let id = draftId;
      if (id) {
        await api.crSaveFields(id, values);
      } else {
        const created = await api.createChangeRequestDraft({
          data: values,
          owner_user_ids: people?.ownerIds ?? [],
          co_writers: (people?.coWriters ?? []).map((c) => ({ type: c.type, id: c.id ?? null, name: c.name ?? null, permissions: c.permissions ?? ["EDIT"] }))
        });
        id = created.id;
      }
      setDraftDialog(null);
      setDraftId(null);
      setValues({});
      setWizardStep(1);
      setTab("MINE");
      setWorkspaceId(id);
    } catch (e: any) {
      setError(e?.message || "Couldn't save the draft.");
    } finally {
      setSavingDraft(false);
    }
  }

  // From the workspace: carry the draft into the wizard to pick approvers and submit.
  function submitDraftThroughWizard(draft: { id: string; data: Record<string, any>; approval_chain?: any[] }) {
    setWorkspaceId(null);
    setDraftId(draft.id);
    setValues({ ...draft.data });
    // A draft that was rolled back for correction keeps its last approval
    // route - start from it rather than an empty list.
    const previous = (draft.approval_chain || []).filter((s: any) => s?.approver_id);
    if (previous.length && !selectedType?.fixed_approval_chain?.length) {
      setChain(previous.map((s: any) => ({ approver_id: s.approver_id, position_name: s.position_name || "", decision_type: s.decision_type === "NOTE" ? "NOTE" as const : "APPROVE" as const })));
    }
    setAttachmentFiles([]);
    setWizardStep(1);
    setError(null);
    setTab("NEW");
  }

  async function handleCancelSubmission(id: string) {
    if (!cancelComment.trim()) { setCancelError("A comment is required to cancel a request."); return; }
    setCancelError(null);
    setCancelling(true);
    try {
      await api.cancelCustomRequest(id, cancelComment.trim());
      setCancellingId(null);
      setCancelComment("");
      await loadMine();
    } catch (e: any) {
      setCancelError(e?.message || "Failed to cancel the request.");
    } finally {
      setCancelling(false);
    }
  }

  async function handleAcknowledgeCollection(id: string) {
    setAcknowledgingId(id);
    try {
      await api.acknowledgeComputerCollection(id);
      void showNotice("Thanks — you've confirmed collecting your computer. Your request is complete.");
      await loadMine();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to confirm collection.");
    } finally {
      setAcknowledgingId(null);
    }
  }

  async function handleSendReminder(id: string) {
    setRemindingId(id);
    try {
      const result = await api.remindCustomRequest(id);
      void showNotice(`Reminder sent to ${result.approver_name || "the current approver"}.`);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to send reminder.");
    } finally {
      setRemindingId(null);
    }
  }

  async function handleClose(id: string) {
    if (!closeImplDate) { setCloseError("Implementation date is required."); return; }
    setCloseError(null);
    setClosing(true);
    try {
      await api.closeCustomRequest(id, { implementation_date: closeImplDate, closure_notes: closeNotes || undefined });
      setClosingId(null);
      setCloseImplDate("");
      setCloseNotes("");
      await loadMine();
    } catch (e: any) {
      setCloseError(e?.message || "Failed to close the request.");
    } finally {
      setClosing(false);
    }
  }

  async function downloadCustomRequestPdf(id: string) {
    try {
      await openBlobInNewTab(() => api.customRequestPdf(id));
    } catch (e: any) {
      void showNotice(e?.message || "Failed to generate PDF.");
    }
  }

  async function confirmAssignee(submissionId: string, fieldKey: string) {
    setAssigneeActionError(null);
    try {
      await api.confirmCustomRequestAssignee(submissionId, fieldKey);
      await loadAssignedToMe();
    } catch (e: any) {
      setAssigneeActionError(e?.message || "Failed to confirm.");
    }
  }

  // Change Request, step 1: an assignee rejects it (a dead stop) or rolls it
  // back to its owners as a draft for correction - both with a comment.
  async function assigneeDecision(submissionId: string, decision: "REJECT" | "ROLLBACK") {
    setAssigneeActionError(null);
    const comment = (assigneeComment[submissionId] || "").trim();
    if (!comment) {
      setAssigneeActionError(decision === "REJECT" ? "Add a comment saying why you're rejecting it." : "Add a comment saying what needs correcting.");
      return;
    }
    const ok = await confirmAction(decision === "REJECT"
      ? { title: "Reject this Change Request?", text: "This is a dead stop: the Change Request is closed as rejected and can't continue.", confirmButtonText: "Reject" }
      : { title: "Roll it back for correction?", text: "It goes back to its owners as a draft with your comment. When they resubmit it, it starts again from step 1.", confirmButtonText: "Roll back" });
    if (!ok) return;
    try {
      await api.decideCustomRequestAssignee(submissionId, { decision, comment });
      setAssigneeComment((prev) => { const next = { ...prev }; delete next[submissionId]; return next; });
      await loadAssignedToMe();
    } catch (e: any) {
      setAssigneeActionError(e?.message || "Failed to save your decision.");
    }
  }

  async function addAssignee(submissionId: string, fieldKey: string, entry: AssigneeAddPayload) {
    setAssigneeActionError(null);
    try {
      await api.addCustomRequestAssignee(submissionId, { field_key: fieldKey, ...entry });
      await loadAssignedToMe();
    } catch (e: any) {
      setAssigneeActionError(e?.message || "Failed to add assignee.");
    }
  }

  function updateImplEdit(submissionId: string, fieldKey: string, value: any) {
    setImplEdits((prev) => ({ ...prev, [submissionId]: { ...prev[submissionId], [fieldKey]: value } }));
  }

  // Filling in the implementation plan IS the assignee's "I'm done" signal —
  // save it and confirm in one action rather than making them click twice.
  // Once every assignee has done this, the current approver is notified
  // their turn has actually arrived (handled server-side on confirm).
  async function saveImplementationFields(submissionId: string, data: Record<string, any>, confirmFieldKey?: string) {
    setAssigneeActionError(null);
    setSavingImplId(submissionId);
    try {
      await api.updateCustomRequestData(submissionId, data);
      if (confirmFieldKey) await api.confirmCustomRequestAssignee(submissionId, confirmFieldKey);
      setImplEdits((prev) => { const next = { ...prev }; delete next[submissionId]; return next; });
      await loadAssignedToMe();
    } catch (e: any) {
      setAssigneeActionError(e?.message || "Failed to save implementation details.");
    } finally {
      setSavingImplId(null);
    }
  }

  function renderTableField(f: RequestField) {
    const cfg = (f.options as TableFieldConfig) || null;
    const value: TableValue = values[f.field_key] || { rows: [] };
    const columns = tableColumns(cfg, values);
    const summary = computeTableSummary(cfg, value.rows);

    function updateRows(rows: TableRow[]) {
      setValue(f.field_key, { ...value, rows });
    }
    function addRow() {
      updateRows([...value.rows, { employee: "", cells: {} }]);
    }
    function removeRow(idx: number) {
      updateRows(value.rows.filter((_, i) => i !== idx));
    }
    function updateRow(idx: number, patch: Partial<TableRow>) {
      updateRows(value.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    }
    function updateCell(idx: number, colKey: string, code: string) {
      updateRows(value.rows.map((r, i) => (i === idx ? { ...r, cells: { ...r.cells, [colKey]: code } } : r)));
    }

    const monthValue: string | undefined = cfg?.monthFieldKey ? values[cfg.monthFieldKey] : undefined;
    const isDayOfMonth = cfg?.columnMode !== "FIXED";
    const weekendBg = "#eef2ff";
    const colorByValue = new Map((cfg?.cellOptions || []).map((o, idx) => [o.value, cellBadgeColor(idx)]));
    const dayTotals = columns.map((c) => value.rows.filter((r) => r.cells[c.key]).length);

    return (
      <div>
        <div className="ep-table-wrap" style={{ overflowX: "auto" }}>
          <table className="ep-table">
            <thead>
              <tr>
                <th>Employee</th>
                {columns.map((c) => {
                  const weekend = isDayOfMonth && isWeekendDay(monthValue, Number(c.key));
                  return (
                    <th key={c.key} style={{ minWidth: 36, textAlign: "center", background: weekend ? weekendBg : undefined }}>
                      {c.label}
                    </th>
                  );
                })}
                {(cfg?.summaryColumns || []).map((c) => <th key={c.key} style={{ minWidth: 60 }}>{c.label}</th>)}
                {cfg?.rowSource !== "SELF" && <th />}
              </tr>
            </thead>
            <tbody>
              {value.rows.map((row, ri) => (
                <tr key={ri}>
                  <td>
                    {cfg?.rowSource === "SELF" ? (
                      <strong>{row.employee || "—"}</strong>
                    ) : (
                      <input
                        className="ep-form-input"
                        style={{ minWidth: 140 }}
                        placeholder="Employee name"
                        value={row.employee}
                        onChange={(e) => updateRow(ri, { employee: e.target.value })}
                      />
                    )}
                  </td>
                  {columns.map((c) => {
                    const weekend = isDayOfMonth && isWeekendDay(monthValue, Number(c.key));
                    const cellValue = row.cells[c.key] || "";
                    const color = cellValue ? colorByValue.get(cellValue) : undefined;
                    return (
                      <td key={c.key} style={{ background: weekend ? weekendBg : undefined, padding: 4 }}>
                        <div style={{ position: "relative" }}>
                          <select
                            className="ep-form-select"
                            style={{
                              padding: "3px 18px 3px 6px", minWidth: 44, appearance: "none", WebkitAppearance: "none",
                              fontWeight: 700, textAlign: "center", textAlignLast: "center",
                              background: color ? color.bg : "var(--surface)",
                              color: color ? color.fg : "var(--muted)",
                              border: color ? `1px solid ${color.bg}` : undefined
                            }}
                            value={cellValue}
                            onChange={(e) => updateCell(ri, c.key, e.target.value)}
                          >
                            <option value="">—</option>
                            {(cfg?.cellOptions || []).map((o) => <option key={o.value} value={o.value} title={o.label}>{o.value}</option>)}
                          </select>
                          <ArrowDown size={10} style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: color ? color.fg : "var(--muted)" }} />
                        </div>
                      </td>
                    );
                  })}
                  {(cfg?.summaryColumns || []).map((c) => (
                    <td key={c.key} style={{ textAlign: "center", color: "var(--muted)" }}>{summary.perRow[ri]?.[c.key] ?? 0}</td>
                  ))}
                  {cfg?.rowSource !== "SELF" && (
                    <td>
                      <button type="button" className="ep-icon-btn" onClick={() => removeRow(ri)} title="Remove row"><Trash2 size={14} /></button>
                    </td>
                  )}
                </tr>
              ))}
              {value.rows.length > 0 && (
                <tr>
                  <td style={{ fontWeight: 700 }}>Total</td>
                  {columns.map((c, ci) => {
                    const weekend = isDayOfMonth && isWeekendDay(monthValue, Number(c.key));
                    return (
                      <td key={c.key} style={{ textAlign: "center", fontWeight: 700, background: weekend ? weekendBg : undefined }}>
                        {dayTotals[ci]}
                      </td>
                    );
                  })}
                  {(cfg?.summaryColumns || []).map((c) => <td key={c.key} style={{ textAlign: "center", fontWeight: 700 }}>{summary.totals[c.key] ?? 0}</td>)}
                  {cfg?.rowSource !== "SELF" && <td />}
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {cfg?.rowSource !== "SELF" && (
          <button type="button" className="ep-btn-outline" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }} onClick={addRow}>
            <Plus size={14} /> Add employee row
          </button>
        )}
        {!!cfg?.cellOptions?.length && (
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 12 }}>
            {cfg.cellOptions.map((o, idx) => {
              const color = cellBadgeColor(idx);
              return (
                <div key={o.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <span style={{ background: color.bg, color: color.fg, fontWeight: 700, borderRadius: 4, padding: "2px 7px", fontSize: 11, minWidth: 18, textAlign: "center" }}>{o.value}</span>
                  <span style={{ color: "var(--muted)" }}>{o.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const CHECKBOX_GROUPS = [
    { prefix: "change_type_", title: "Change Type", description: "Select one or more change types that apply." },
    { prefix: "category_", title: "Change Category", description: "Select one or more change categories that apply." }
  ];

  type FieldRenderItem =
    | { kind: "field"; field: RequestField }
    | { kind: "group"; title: string; description: string; fields: RequestField[] };

  function groupCheckboxFields(allFields: RequestField[]): FieldRenderItem[] {
    const items: FieldRenderItem[] = [];
    let i = 0;
    while (i < allFields.length) {
      const group = CHECKBOX_GROUPS.find((g) => allFields[i].field_key.startsWith(g.prefix));
      if (group) {
        const groupFields: RequestField[] = [];
        while (i < allFields.length && allFields[i].field_key.startsWith(group.prefix)) {
          groupFields.push(allFields[i]);
          i++;
        }
        items.push({ kind: "group", title: group.title, description: group.description, fields: groupFields });
      } else {
        items.push({ kind: "field", field: allFields[i] });
        i++;
      }
    }
    return items;
  }

  // `vals`/`set` let the Change Request workspace reuse the same editors on
  // its own edit buffer.
  function renderField(f: RequestField, vals: Record<string, any> = values, set: (key: string, value: any) => void = setValue) {
    const value = vals[f.field_key] ?? "";
    switch (f.field_type) {
      case "table":
        return renderTableField(f);
      case "user":
        return (
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <ApproverCombobox
                users={companyDirectorySorted}
                value={value}
                onChange={(id) => set(f.field_key, id)}
                allowFreeEmail
              />
            </div>
            {profile?.id && value !== profile.id && (
              <button
                type="button"
                className="ep-btn-outline"
                style={{ whiteSpace: "nowrap", padding: "0 10px", height: 38 }}
                onClick={() => set(f.field_key, profile.id)}
                title="Assign this to yourself"
              >
                Myself
              </button>
            )}
          </div>
        );
      case "user_multi": {
        const entries: AssigneeEntry[] = Array.isArray(vals[f.field_key]) ? vals[f.field_key] : [];
        return (
          <UserMultiField
            entries={entries}
            users={companyDirectorySorted}
            teams={teams}
            onAdd={(entry) => set(f.field_key, [...entries, entry])}
            onRemove={(idx) => set(f.field_key, entries.filter((_, i) => i !== idx))}
          />
        );
      }
      case "section":
        return <ImplementorField value={String(value || "")} users={companyDirectorySorted} onChange={(v) => set(f.field_key, v)} />;
      case "textarea":
        return (
          <textarea
            className="ep-form-textarea"
            rows={3}
            placeholder={f.placeholder || ""}
            value={value}
            onChange={(e) => set(f.field_key, e.target.value)}
          />
        );
      case "number":
        return (
          <input
            type="number"
            className="ep-form-input"
            placeholder={f.placeholder || ""}
            value={value}
            onChange={(e) => set(f.field_key, e.target.value)}
          />
        );
      case "date":
        // The "month" field (e.g. Attendance Register) only ever needs a
        // calendar month, not a specific day.
        if (f.field_key === "month") {
          return <MonthYearPicker value={value} onChange={(v) => set(f.field_key, v)} />;
        }
        return (
          <input
            type="date"
            className="ep-form-input"
            value={value}
            onChange={(e) => set(f.field_key, e.target.value)}
          />
        );
      case "checkbox":
        return (
          <label className="ep-checkbox-label">
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(f.field_key, e.target.checked)} />
            {f.placeholder || f.field_label}
          </label>
        );
      case "select":
        return (
          <select className="ep-form-select" value={value} onChange={(e) => set(f.field_key, e.target.value)}>
            <option value="">{f.placeholder || "Select…"}</option>
            {((f.options as { label: string; value: string }[]) || []).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        );
      default:
        return (
          <input
            className="ep-form-input"
            placeholder={f.placeholder || ""}
            value={value}
            onChange={(e) => set(f.field_key, e.target.value)}
          />
        );
    }
  }

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon">
              <ClipboardList size={18} />
            </span>
            <h2>{types.find((t) => t.id === selectedTypeId)?.name || "Custom Processes"}</h2>
          </div>
          <p className="custom-requests-subtitle">
            Custom Processes — choose another process from the sidebar.
          </p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      <div className="ep-tabs">
        <a href="#" className={`ep-tab ${tab === "NEW" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("NEW"); }}>
          <FileText size={14} /> New Request
        </a>
        <a href="#" className={`ep-tab ${tab === "MINE" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("MINE"); }}>
          <Inbox size={14} /> My Requests
        </a>
        <a href="#" className={`ep-tab ${tab === "ASSIGNED" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("ASSIGNED"); }}>
          <UserCheck size={14} /> Assigned to Me
        </a>
        <a href="#" className={`ep-tab ${tab === "SHARED" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("SHARED"); }}>
          <Share2 size={14} /> Shared with Me
        </a>
      </div>

      {loading ? (
        <div className="ep-loading"><p>Loading form…</p></div>
      ) : tab === "SHARED" ? (
        <div className="ep-panel">
          <div className="ep-panel-head">
            <div className="ep-panel-title">Shared with Me</div>
            <div className="ep-panel-sub">Approved Change Requests their requesters distributed to you.</div>
          </div>
          <div className="ep-panel-body">
            {sharedLoading ? (
              <div className="ep-loading"><p>Loading…</p></div>
            ) : !shared.length ? (
              <div className="ep-empty"><p>Nothing has been distributed to you yet.</p></div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {shared.map((s) => (
                  <div key={s.id} className="card" style={{ padding: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{s.data?.description_of_change || s.request_type_name}</div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>
                          {s.request_type_name} by {s.requester_name || "—"} · shared by {s.distributed_by_name || "—"}
                          {s.distributed_at ? ` on ${new Date(s.distributed_at).toLocaleDateString()}` : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => void downloadCustomRequestPdf(s.id)}>
                          <FileText size={13} /> Download PDF
                        </button>
                        {statusBadge(s.status)}
                      </div>
                    </div>
                    {s.distribution_message && (
                      <div style={{ marginTop: 10, fontSize: 13, background: "var(--surface-soft)", padding: 10, borderRadius: 6 }}>{s.distribution_message}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : tab === "ASSIGNED" ? (
        <div className="ep-panel">
          <div className="ep-panel-head">
            <div className="ep-panel-title">Assigned to Me</div>
          </div>
          <div className="ep-panel-body">
            {assigneeActionError && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 12 }}>{assigneeActionError}</div>}
            {assignedToMeLoading ? (
              <div className="ep-loading"><p>Loading…</p></div>
            ) : assignedToMeError ? (
              <div className="ep-empty"><p>{assignedToMeError}</p></div>
            ) : !assignedToMe.length ? (
              <div className="ep-empty"><p>No requests have assigned you as an implementer yet.</p></div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {assignedToMe.map((s) => {
                  const typeFields = assignedTypeFields[s.request_type_id] || [];
                  const multiFields = typeFields.filter((f) => f.field_type === "user_multi");
                  const isExpanded = expandedAssigned.has(s.id);
                  const toggleExpanded = () => {
                    setExpandedAssigned((prev) => {
                      const next = new Set(prev);
                      if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                      return next;
                    });
                  };
                  return (
                    <div key={s.id} className="card" style={{ padding: 14 }}>
                      <button
                        type="button"
                        onClick={toggleExpanded}
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <ChevronDown size={16} style={{ color: "var(--muted)", transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s", flexShrink: 0 }} />
                          <div>
                            <div style={{ fontWeight: 700 }}>{s.data?.description_of_change || s.request_type_name}</div>
                            <div style={{ fontSize: 12, color: "var(--muted)" }}>Submitted {new Date(s.created_at).toLocaleDateString()}</div>
                          </div>
                        </div>
                        {statusBadge(s.status)}
                      </button>
                      {isExpanded && (
                      <>

                      {s.request_type_code === "CHANGE_REQUEST" && (
                        // Assignees see the whole Change Request - every section, comments,
                        // history and approvals - not just their own part.
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                          <button className="ep-btn" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => setWorkspaceId(s.id)}>
                            <FileText size={13} /> Open the full Change Request
                          </button>
                          <button className="ep-btn-outline" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => void downloadCustomRequestPdf(s.id)}>
                            <Download size={13} /> Download PDF
                          </button>
                        </div>
                      )}

                      {multiFields.map((f) => {
                        const entries: AssigneeEntry[] = Array.isArray(s.data?.[f.field_key]) ? s.data[f.field_key] : [];
                        const mine = entries.find((a) => !a.confirmed && assigneeIsMe(a, profile)) ?? entries.find((a) => assigneeIsMe(a, profile));
                        return (
                          <div key={f.field_key} style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{f.field_label}</div>
                            <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
                              {entries.map((a, i) => (
                                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                                  <div>
                                    {assigneeLabel(a)}
                                    {!a.id && !isGroupAssignee(a) && <span style={{ color: "var(--muted)" }}> · invited, no account yet</span>}
                                    {isGroupAssignee(a) && <span style={{ color: "var(--muted)" }}> · any member can confirm</span>}
                                    {a.confirmed && a.confirmedBy && <span style={{ color: "var(--muted)" }}> · confirmed by {a.confirmedBy}</span>}
                                  </div>
                                  {statusBadge(a.confirmed ? "APPROVED" : "PENDING")}
                                </div>
                              ))}
                            </div>
                            {mine && !mine.confirmed && s.status === "IN_PROGRESS" && (
                              <button className="ep-btn" style={{ fontSize: 12, padding: "5px 12px", marginRight: 8 }} onClick={() => confirmAssignee(s.id, f.field_key)}>
                                {isGroupAssignee(mine) ? `Confirm Ready for ${assigneeLabel(mine)}` : "Confirm Ready"}
                              </button>
                            )}
                            {mine && !mine.confirmed && s.status === "IN_PROGRESS" && s.request_type_code === "CHANGE_REQUEST" && (
                              <div style={{ marginTop: 10, maxWidth: 560 }}>
                                <textarea
                                  className="ep-form-textarea"
                                  rows={2}
                                  placeholder="Comment (required to roll back or reject)"
                                  value={assigneeComment[s.id] || ""}
                                  onChange={(e) => setAssigneeComment((prev) => ({ ...prev, [s.id]: e.target.value }))}
                                  style={{ width: "100%", marginBottom: 8 }}
                                />
                                <button className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 12px", marginRight: 8 }} onClick={() => void assigneeDecision(s.id, "ROLLBACK")}
                                  title="Send it back to its owners as a draft, with your comment, to correct and resubmit">
                                  Roll back for correction
                                </button>
                                <button className="ep-btn-danger" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => void assigneeDecision(s.id, "REJECT")}
                                  title="A dead stop: it's closed as rejected">
                                  Reject
                                </button>
                              </div>
                            )}
                            {s.status === "IN_PROGRESS" && (
                              <div style={{ marginTop: 8, maxWidth: 460 }}>
                                <AssigneeAdder users={companyDirectorySorted} existing={entries} onAdd={(entry) => addAssignee(s.id, f.field_key, entry)} />
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {(() => {
                        // Show the assignee the same "implementation" page the requester
                        // filled in (wizard page 2 onward) rather than a fixed three-field
                        // allowlist — for Change Request that's Priority through Business
                        // Implications, not just Implementation Plan/Callout. Falls back to
                        // the old allowlist for single-page request types, where there's no
                        // separate technical page to single out.
                        const editableTypes = ["text", "number", "date", "select", "textarea", "checkbox"];
                        const stepNums = [...new Set(typeFields.map((f) => f.wizard_step || 1))].sort((a, b) => a - b);
                        const implFields = stepNums.length > 1
                          ? typeFields.filter((f) => (f.wizard_step || 1) === stepNums[stepNums.length - 1] && editableTypes.includes(f.field_type))
                          : typeFields.filter((f) => ["implementation_plan", "callout_person", "callout_contact_no"].includes(f.field_key));
                        if (!implFields.length || s.status !== "IN_PROGRESS") return null;
                        const buffer = implEdits[s.id] || {};
                        const currentValue = (f: RequestField) => buffer[f.field_key] ?? s.data?.[f.field_key] ?? "";
                        // If the viewer is themselves an unconfirmed assignee, saving the
                        // plan also confirms them — filling it in IS their "I'm done" signal.
                        const myUnconfirmedField = multiFields.find((f) => {
                          const entries: AssigneeEntry[] = Array.isArray(s.data?.[f.field_key]) ? s.data[f.field_key] : [];
                          return entries.some((a) => !a.confirmed && assigneeIsMe(a, profile));
                        });
                        return (
                          <div className="cr-impl-card">
                            <div className="cr-impl-card-header">
                              <div className="cr-impl-card-icon"><ClipboardList size={16} /></div>
                              <div>
                                <div className="cr-impl-card-title">Implementation Details</div>
                                <div className="cr-impl-card-desc">Provide detailed information about how the change will be implemented.</div>
                              </div>
                            </div>
                            <div className="cr-impl-fields-grid">
                              {implFields.map((f) => (
                                <div key={f.field_key} className={["textarea", "table"].includes(f.field_type) ? "cr-impl-field-full" : undefined}>
                                  {f.field_type !== "checkbox" && (
                                    <label style={{ fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 4, fontWeight: 600 }}>{f.field_label}</label>
                                  )}
                                  {f.field_type === "textarea" ? (
                                    <textarea
                                      className="ep-form-textarea"
                                      rows={3}
                                      value={currentValue(f)}
                                      onChange={(e) => updateImplEdit(s.id, f.field_key, e.target.value)}
                                    />
                                  ) : f.field_type === "select" ? (
                                    <select
                                      className="ep-form-select"
                                      value={currentValue(f)}
                                      onChange={(e) => updateImplEdit(s.id, f.field_key, e.target.value)}
                                    >
                                      <option value="">{f.placeholder || "Select…"}</option>
                                      {((f.options as { label: string; value: string }[]) || []).map((o) => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                      ))}
                                    </select>
                                  ) : f.field_type === "checkbox" ? (
                                    <label className="ep-checkbox-label">
                                      <input
                                        type="checkbox"
                                        checked={Boolean(currentValue(f))}
                                        onChange={(e) => updateImplEdit(s.id, f.field_key, e.target.checked as any)}
                                      />
                                      {f.placeholder || f.field_label}
                                    </label>
                                  ) : (
                                    <input
                                      type={f.field_type === "date" ? "date" : f.field_type === "number" ? "number" : "text"}
                                      className="ep-form-input"
                                      placeholder={f.placeholder || ""}
                                      value={currentValue(f)}
                                      onChange={(e) => updateImplEdit(s.id, f.field_key, e.target.value)}
                                    />
                                  )}
                                </div>
                              ))}
                            </div>
                            <button
                              className="ep-btn"
                              style={{ fontSize: 13, padding: "8px 16px", marginTop: 14 }}
                              disabled={savingImplId === s.id}
                              onClick={() => saveImplementationFields(
                                s.id,
                                Object.fromEntries(implFields.map((f) => [f.field_key, currentValue(f)])),
                                myUnconfirmedField?.field_key
                              )}
                            >
                              {savingImplId === s.id ? "Saving…" : myUnconfirmedField ? "Submit Implementation Plan & Confirm" : "Save Implementation Details"}
                            </button>
                          </div>
                        );
                      })()}
                      </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : tab === "NEW" ? (
        error && !fields.length ? (
          <div className="ep-empty"><p>{error}</p></div>
        ) : (
          <div className="ep-panel custom-request-wizard-panel">
            <div className="ep-panel-head custom-request-panel-head">
              <div>
                <div className="ep-panel-title">{selectedType?.name || "Request"} Form</div>
                <div className="custom-request-panel-subtitle">Step {wizardStep} of {totalWizardSteps}</div>
              </div>
            </div>
            <div className="ep-panel-body custom-request-panel-body">
              <div className="custom-request-stepper">
                {Array.from({ length: totalWizardSteps }, (_, i) => i + 1).map((step) => {
                  const title = step === approvalsStepIndex ? "Approvals & Change Control" : `Details${fieldStepNumbers.length > 1 ? ` ${step}` : ""}`;
                  const description = step === approvalsStepIndex
                    ? "Define approvals and control"
                    : step === 1
                      ? "Provide request information"
                      : "Additional information";
                  const state = step < wizardStep ? "is-complete" : step === wizardStep ? "is-active" : "";
                  return (
                    <div key={step} className={`custom-request-step ${state}`}>
                      <span className="custom-request-step-index">{step}</span>
                      <span className="custom-request-step-copy">
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="custom-request-form-body">
              {crNeedsDraft && (
                <div className="custom-request-note custom-request-note-neutral" style={{ marginBottom: 12 }}>
                  A Change Request starts as a draft. Fill in what you can, save it and invite the people who'll work on it with you (co-owners, co-writers, sections). When it's ready, open the draft and choose <strong>Submit for approval</strong> to pick the approvers.
                </div>
              )}
              {draftId && (
                <div className="custom-request-note custom-request-note-neutral" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span>You're submitting a draft worked on with others. Check the details, pick the approvers and submit — its people, sections, comments and history carry on.</span>
                  <button className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px", marginLeft: "auto" }}
                    onClick={() => { const id = draftId; setDraftId(null); setValues({}); setWizardStep(1); setTab("MINE"); setWorkspaceId(id); }}>
                    Back to the draft
                  </button>
                </div>
              )}
              {!isApprovalsStep && (
                <>
                  <div className="ep-form-fields-grid">
                    {groupCheckboxFields(currentStepFields).map((item, idx) => {
                      if (item.kind === "group") {
                        return (
                          <div className="ep-checkbox-group" key={`group-${idx}`}>
                            <div className="ep-checkbox-group-header">
                              <span className="ep-checkbox-group-title">{item.title} <span className="ep-required">*</span></span>
                              <span className="ep-checkbox-group-desc">{item.description}</span>
                            </div>
                            <div className="ep-checkbox-group-grid">
                              {item.fields.map((f) => (
                                <label className="ep-checkbox-label" key={f.field_key}>
                                  <input
                                    type="checkbox"
                                    checked={Boolean(values[f.field_key])}
                                    onChange={(e) => setValue(f.field_key, e.target.checked)}
                                  />
                                  {f.placeholder || f.field_label}
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      }
                      const f = item.field;
                      return (
                        <div
                          className={`ep-form-group ${["textarea", "table"].includes(f.field_type) ? "ep-form-field-full" : ""}`}
                          key={f.field_key}
                        >
                          {f.field_type !== "checkbox" && (
                            <label>{f.field_label}{isFieldRequired(f) && <span className="ep-required"> *</span>}{isChangeRequestType && f.field_key === "back_out_plan" && isFieldRequired(f) && !f.is_required && <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 11.5 }}> — required for {String(values.impact).toUpperCase() === "MAJOR" ? "Major" : "Significant"} impact</span>}</label>
                          )}
                          {f.field_key === "attendance_grid" && isAttendanceRegisterSelected && (
                            attendancePeriodLocked ? (
                              <div className="custom-request-notice custom-request-notice-warning">
                                This month has been closed by HR/Admin — you can no longer edit or submit it.
                              </div>
                            ) : (
                              <div className="custom-request-autosave-status">
                                {attendanceSaveStatus === "saving" && "Saving…"}
                                {attendanceSaveStatus === "saved" && "All changes saved — come back any time to keep logging."}
                                {attendanceSaveStatus === "error" && "Couldn't save just now — check your connection."}
                              </div>
                            )
                          )}
                          {renderField(f)}
                        </div>
                      );
                    })}
                  </div>

                  {wizardStep === 1 && (
                    <div className="custom-attachments">
                      <div className="custom-attachments-title">
                        <Paperclip size={15} /> Attachments
                      </div>
                      <div className="custom-attachments-copy">
                        Attach any supporting documents this request needs (e.g. quotations, diagrams, sign-off forms).
                      </div>
                      <label
                        className="custom-attachment-dropzone"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const picked = Array.from(e.dataTransfer.files || []);
                          if (picked.length) setAttachmentFiles((prev) => [...prev, ...picked]);
                        }}
                      >
                        <UploadCloud size={24} />
                        <span>Drag and drop files here or <strong>click to browse</strong></span>
                        <small>Multiple files supported</small>
                        <input
                          type="file"
                          multiple
                          style={{ display: "none" }}
                          onChange={(e) => {
                            const picked = Array.from(e.target.files || []);
                            if (picked.length) setAttachmentFiles((prev) => [...prev, ...picked]);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {attachmentFiles.length > 0 && (
                        <div className="custom-attachment-list">
                          {attachmentFiles.map((file, idx) => (
                            <div key={idx} className="custom-attachment-file">
                              <span>{file.name} <span style={{ color: "var(--muted)" }}>({Math.round(file.size / 1024)} KB)</span></span>
                              <button
                                type="button"
                                className="ep-icon-btn"
                                title="Remove"
                                onClick={() => setAttachmentFiles((prev) => prev.filter((_, i) => i !== idx))}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {isApprovalsStep && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Approval Workflow</div>

                {selectedType?.fixed_approval_chain?.length ? (
                  <>
                    <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
                      This process has a fixed sign-off order. Choose the people for each role below.
                    </div>
                    {selectedType.fixed_approval_chain.map((stepDef, idx) => (
                      <div key={idx} style={{ marginBottom: 8 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "32px 1.3fr 2fr", gap: 8, alignItems: "center" }}>
                          <div style={{ fontWeight: 700, color: "var(--muted)", textAlign: "center" }}>{idx + 1}</div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{stepDef.title}</div>
                          <ApproverCombobox
                            users={stepDef.source === "AUTO_MANAGER" ? directorySorted : directoryForStep(stepDef)}
                            value={chain[idx]?.approver_id || ""}
                            onChange={(id) => updateChainStep(idx, { approver_id: id })}
                          />
                        </div>
                        {stepDef.source === "AUTO_MANAGER" && !myManager && (
                          <div style={{ fontSize: 12, color: "#b45309", marginTop: 4, gridColumn: "2 / -1" }}>
                            No manager found in the org structure for you — please select your manager manually.
                          </div>
                        )}
                        {idx > 0 && chain[idx]?.approver_id && chain[idx].approver_id === chain[idx - 1]?.approver_id && (
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, marginLeft: 40 }}>
                            Same person as the step above — they'll approve once, as {selectedType.fixed_approval_chain![idx - 1].title} &amp; {stepDef.title}.
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
                      Every request can follow a different approval path. Add the people who need to approve this request, in order.
                      {isChangeRequestType && " For each step, say whether they're formally approving the change or just noting it for the record (e.g. Internal Audit & Risk)."}
                    </div>

                    {chain.map((step, idx) => (
                      <div
                        key={idx}
                        style={{ display: "grid", gridTemplateColumns: isChangeRequestType ? "32px 2fr 2fr 1.3fr auto auto auto" : "32px 2fr 2fr auto auto auto", gap: 8, alignItems: "center", marginBottom: 8 }}
                      >
                        <div style={{ fontWeight: 700, color: "var(--muted)", textAlign: "center" }}>{idx + 1}</div>
                        <ApproverCombobox users={directorySorted} value={step.approver_id} onChange={(id) => updateChainStep(idx, { approver_id: id })} />
                        {selectedType?.approver_title_options?.length ? (
                          <select
                            className="ep-form-select"
                            value={step.position_name}
                            onChange={(e) => updateChainStep(idx, { position_name: e.target.value })}
                          >
                            <option value="">Select title…</option>
                            {selectedType.approver_title_options.map((title) => <option key={title} value={title}>{title}</option>)}
                          </select>
                        ) : (
                          <input
                            className="ep-form-input"
                            placeholder="Approver role / title (e.g. Compiled by)"
                            value={step.position_name}
                            onChange={(e) => updateChainStep(idx, { position_name: e.target.value })}
                          />
                        )}
                        {isChangeRequestType && (
                          <select
                            className="ep-form-select"
                            value={step.decision_type}
                            onChange={(e) => updateChainStep(idx, { decision_type: e.target.value as "APPROVE" | "NOTE" })}
                            title="Whether this person formally approves the change, or is only noting it for the record"
                          >
                            <option value="APPROVE">Approving</option>
                            <option value="NOTE">Noting</option>
                          </select>
                        )}
                        <button type="button" className="ep-btn-outline" onClick={() => moveChainStep(idx, -1)} disabled={idx === 0} title="Move up" style={{ padding: "6px 8px" }}>
                          <ArrowUp size={14} />
                        </button>
                        <button type="button" className="ep-btn-outline" onClick={() => moveChainStep(idx, 1)} disabled={idx === chain.length - 1} title="Move down" style={{ padding: "6px 8px" }}>
                          <ArrowDown size={14} />
                        </button>
                        <button type="button" className="ep-btn-danger" onClick={() => removeChainStep(idx)} disabled={chain.length === 1} title="Remove" style={{ padding: "6px 8px" }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}

                    <button type="button" className="ep-btn-outline" onClick={addChainStep} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <Plus size={14} /> Add approval step
                    </button>
                  </>
                )}
              </div>
              )}

              {error && <div className="custom-request-error">{error}</div>}

              <div className="custom-request-footer">
                <button
                  className="ep-btn-outline"
                  onClick={() => { setError(null); setWizardStep((s) => Math.max(1, s - 1)); }}
                  disabled={wizardStep === 1}
                  style={{ visibility: wizardStep === 1 ? "hidden" : "visible" }}
                >
                  Back
                </button>
                {isChangeRequestType && !(crNeedsDraft && wizardStep === totalWizardSteps) && (
                  <button
                    className="ep-btn-outline"
                    style={{ marginLeft: "auto", marginRight: 8 }}
                    disabled={savingDraft || submitting}
                    title="Save it as a draft and invite owners and co-writers to finish it with you"
                    onClick={() => (draftId ? void saveChangeRequestDraft() : setDraftDialog({ ownerIds: [], coWriters: [] }))}
                  >
                    {savingDraft ? "Saving…" : draftId ? "Save draft" : "Save as draft & invite people"}
                  </button>
                )}
                {isApprovalsStep ? (
                  <button className="ep-btn" onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Submitting…" : `Submit ${selectedType?.name || "Request"}`}
                  </button>
                ) : crNeedsDraft && wizardStep === totalWizardSteps ? (
                  <button className="ep-btn" style={{ marginLeft: "auto" }} disabled={savingDraft} onClick={() => setDraftDialog({ ownerIds: [], coWriters: [] })}
                    title="A Change Request starts as a draft: save it and invite the people who'll work on it with you">
                    {savingDraft ? "Saving…" : "Save as draft & invite people"}
                  </button>
                ) : (
                  <button className="ep-btn" onClick={goToNextStep}>Next</button>
                )}
              </div>
            </div>
          </div>
          </div>
        )
      ) : (
        <div className="ep-panel">
          <div className="ep-panel-head" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="ep-panel-title">My {selectedType?.name || "Requests"}</div>
            {(selectedType?.code === "CHANGE_REQUEST" || selectedType?.code === "COMPUTER_REQUEST") && (
              <span style={{ marginLeft: "auto" }}><RaidRegisterButton docType={selectedType.code as "CHANGE_REQUEST" | "COMPUTER_REQUEST"} /></span>
            )}
          </div>
          <div className="ep-panel-body">
            {!mine.length ? (
              <div className="ep-empty"><p>{isChangeRequestType ? "You have no Change Requests or drafts yet." : "You haven't submitted any requests of this type yet."}</p></div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {mine.map((s) => (
                  <div key={s.id} className="card" style={{ padding: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{s.data?.description_of_change || (s.status === "DRAFT" ? "Untitled Change Request" : s.request_type_name)}</div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>
                          {s.status === "DRAFT" ? "Draft started" : "Submitted"} {new Date(s.created_at).toLocaleDateString()}
                          {s.my_role && <> · You're {s.my_role === "OWNER" ? "a co-owner" : "a co-writer"}{s.requester_name ? ` — started by ${s.requester_name}` : ""}</>}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {s.request_type_code === "COMPUTER_REQUEST" && (
                          <RaidLogButton docType="COMPUTER_REQUEST" docId={s.id} title={`Computer Request CR-${s.id.slice(0, 8).toUpperCase()}`} users={companyDirectorySorted} small />
                        )}
                        {s.request_type_code === "CHANGE_REQUEST" && (
                          <button
                            className={s.status === "DRAFT" ? "ep-btn" : "ep-btn-outline"}
                            style={{ fontSize: 12, padding: "4px 10px" }}
                            onClick={(e) => { e.stopPropagation(); setWorkspaceId(s.id); }}
                            title="People, sections, comments and history"
                          >
                            {s.status === "DRAFT" ? "Open draft" : "Open workspace"}
                          </button>
                        )}
                        {s.status === "APPROVED" && selectedType?.requires_closure && closingId !== s.id && (
                          <button
                            className="ep-btn-outline"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                            onClick={(e) => { e.stopPropagation(); setClosingId(s.id); setCloseImplDate(""); setCloseNotes(""); setCloseError(null); }}
                          >
                            Close Request
                          </button>
                        )}
                        {s.request_type_code === "CHANGE_REQUEST" && ["APPROVED", "CLOSED"].includes(s.status) && (
                          <button
                            className="ep-btn"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                            onClick={(e) => { e.stopPropagation(); setDistributingId(s.id); }}
                            title="Send this approved Change Request to the people who need it"
                          >
                            <Share2 size={13} /> Distribute
                          </button>
                        )}
                        {s.status === "IN_PROGRESS" && cancellingId !== s.id && (
                          <button
                            className="ep-btn-outline"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                            disabled={remindingId === s.id}
                            onClick={(e) => { e.stopPropagation(); void handleSendReminder(s.id); }}
                            title="Nudge the current approver by email now, instead of waiting for the automatic reminder"
                          >
                            {remindingId === s.id ? "Sending…" : "Send Reminder"}
                          </button>
                        )}
                        {s.status === "IN_PROGRESS" && cancellingId !== s.id && (
                          <button
                            className="ep-btn-danger"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                            onClick={(e) => { e.stopPropagation(); setCancellingId(s.id); setCancelComment(""); setCancelError(null); }}
                          >
                            Cancel Request
                          </button>
                        )}
                        {statusBadge(s.status)}
                      </div>
                    </div>

                    {s.it_provisioning && (
                      <div
                        style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div style={{ fontSize: 13 }}>
                          <span style={{ fontWeight: 700 }}>IT Provisioning: </span>
                          {IT_STAGE_TEXT[s.it_provisioning.status] || s.it_provisioning.status}
                          {s.it_provisioning.assigned_to_name && !["COMPLETED"].includes(s.it_provisioning.status) ? ` — ${s.it_provisioning.assigned_to_name}` : ""}
                          {s.it_provisioning.asset_number ? ` (asset ${s.it_provisioning.asset_number})` : ""}
                        </div>
                        {["READY_FOR_COLLECTION", "HANDED_OVER"].includes(s.it_provisioning.status) && (
                          <button className="ep-btn" style={{ fontSize: 12, padding: "6px 12px" }} disabled={acknowledgingId === s.id} onClick={() => void handleAcknowledgeCollection(s.id)}>
                            {acknowledgingId === s.id ? "Confirming…" : "I've collected my computer"}
                          </button>
                        )}
                      </div>
                    )}

                    {cancellingId === s.id && (
                      <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Cancel Request</div>
                        <div className="ep-form-group">
                          <label>Reason for cancelling <span className="ep-required">*</span></label>
                          <textarea
                            className="ep-form-textarea"
                            rows={3}
                            placeholder="Let the current approver know why you're withdrawing this request…"
                            value={cancelComment}
                            onChange={(e) => setCancelComment(e.target.value)}
                          />
                        </div>
                        {cancelError && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>{cancelError}</div>}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="ep-btn-danger" onClick={() => handleCancelSubmission(s.id)} disabled={cancelling}>{cancelling ? "Cancelling…" : "Confirm Cancellation"}</button>
                          <button className="ep-btn-outline" onClick={() => setCancellingId(null)} disabled={cancelling}>Back</button>
                        </div>
                      </div>
                    )}

                    {closingId === s.id && (
                      <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Close Request — Record Implementation</div>
                        <div className="ep-form-group">
                          <label>Implementation Date <span className="ep-required">*</span></label>
                          <input type="date" className="ep-form-input" value={closeImplDate} onChange={(e) => setCloseImplDate(e.target.value)} />
                        </div>
                        <div className="ep-form-group">
                          <label>Closure Notes / Post-Implementation Outcome</label>
                          <textarea className="ep-form-textarea" rows={3} placeholder="Describe the outcome, any issues encountered, or confirmation of successful implementation…" value={closeNotes} onChange={(e) => setCloseNotes(e.target.value)} />
                        </div>
                        {closeError && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>{closeError}</div>}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="ep-btn" onClick={() => handleClose(s.id)} disabled={closing}>{closing ? "Closing…" : "Confirm Closure"}</button>
                          <button className="ep-btn-outline" onClick={() => setClosingId(null)} disabled={closing}>Cancel</button>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                          A post-implementation review email will be sent to all approvers and yourself one day after the implementation date.
                        </div>
                      </div>
                    )}

                    {expanded === s.id && closingId !== s.id && cancellingId !== s.id && (
                      <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                          <button className="ep-btn-outline" onClick={(e) => { e.stopPropagation(); void downloadCustomRequestPdf(s.id); }}>
                            <FileText size={13} /> Download PDF
                          </button>
                        </div>
                        {!!s.attachments?.length && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Attachments</div>
                            <div style={{ display: "grid", gap: 4 }}>
                              {s.attachments.map((a) => <AttachmentDownloadLink key={a.id} submissionId={s.id} attachment={a} />)}
                            </div>
                          </div>
                        )}
                        {fields.filter((f) => f.field_type === "user_multi").map((f) => {
                          const entries: AssigneeEntry[] = Array.isArray(s.data?.[f.field_key]) ? s.data[f.field_key] : [];
                          if (!entries.length) return null;
                          return (
                            <div key={f.field_key} style={{ marginBottom: 12 }}>
                              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{f.field_label}</div>
                              <div style={{ display: "grid", gap: 6 }}>
                                {entries.map((a, i) => (
                                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                                    <div>
                                      {assigneeLabel(a)}
                                      {isGroupAssignee(a) && !a.confirmed && <span style={{ color: "var(--muted)" }}> · any one member can confirm</span>}
                                      {a.confirmed && a.confirmedBy && <span style={{ color: "var(--muted)" }}> · confirmed by {a.confirmedBy}</span>}
                                    </div>
                                    {statusBadge(a.confirmed ? "APPROVED" : "PENDING")}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                        {(() => {
                          // Assignees confirm first; the approver isn't asked until they all have.
                          const all = fields.filter((f) => f.field_type === "user_multi").flatMap((f) => (Array.isArray(s.data?.[f.field_key]) ? s.data[f.field_key] : []) as AssigneeEntry[]);
                          const waiting = all.filter((a) => !a.confirmed);
                          if (s.status !== "IN_PROGRESS" || !waiting.length) return null;
                          const next = s.approval_chain[s.current_step_order];
                          return (
                            <div className="custom-request-note" style={{ marginBottom: 12, fontSize: 13 }}>
                              <strong>Waiting on the assignees to confirm ({all.length - waiting.length} of {all.length} done)</strong>: {waiting.map(assigneeLabel).join(", ")}.
                              {waiting.some(isGroupAssignee) && <> For a section, department or division, any one member confirms for all of them.</>}
                              {next && <> It goes to {next.approver_name || next.position_name} once they all have.</>}
                            </div>
                          );
                        })()}
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Approval Chain</div>
                        <div style={{ display: "grid", gap: 6 }}>
                          {s.approval_chain.map((step, i) => {
                            // A step that hasn't been acted on yet only ever
                            // shows "Pending" while it's actually this step's
                            // turn (i === current_step_order) - any step
                            // further down the chain hasn't started yet, so
                            // it reads as "Waiting" instead of a misleading
                            // "Pending" that makes every approver look like
                            // they're up right now regardless of turn order.
                            const assigneesPending = fields.some((f) => f.field_type === "user_multi" && Array.isArray(s.data?.[f.field_key]) && s.data[f.field_key].some((a: AssigneeEntry) => !a.confirmed));
                            const displayStatus = step.acted_at
                              ? step.status
                              : i === s.current_step_order && s.status === "IN_PROGRESS" && !assigneesPending
                                ? "PENDING"
                                : "WAITING";
                            return (
                              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                                <div>
                                  <strong>{i + 1}. {step.position_name}</strong> — {step.approver_name || "—"}
                                  {step.decision_type === "NOTE" && <span style={{ color: "var(--muted)", fontSize: 12 }}> (noting)</span>}
                                  {step.comment && <div style={{ color: "var(--muted)", fontSize: 12 }}>"{step.comment}"</div>}
                                  {step.acted_at && <div style={{ color: "var(--muted)", fontSize: 11.5 }}>{new Date(step.acted_at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>}
                                </div>
                                {statusBadge(displayStatus)}
                              </div>
                            );
                          })}
                        </div>
                        {s.status === "CLOSED" && (
                          <div className="custom-request-note custom-request-note-success">
                            <div style={{ fontWeight: 700, marginBottom: 4 }}>Closure Details</div>
                            <div><strong>Implementation Date:</strong> {s.implementation_date || "—"}</div>
                            {s.closure_notes && <div style={{ marginTop: 4 }}><strong>Notes:</strong> {s.closure_notes}</div>}
                            <div style={{ marginTop: 4, color: "var(--muted)" }}>Closed {s.closed_at ? new Date(s.closed_at).toLocaleDateString() : "—"}</div>
                          </div>
                        )}
                        {s.status === "CANCELLED" && (
                          <div className="custom-request-note custom-request-note-neutral">
                            <div style={{ fontWeight: 700, marginBottom: 4 }}>Cancelled</div>
                            {s.cancel_comment && <div><strong>Reason:</strong> {s.cancel_comment}</div>}
                            <div style={{ marginTop: 4, color: "var(--muted)" }}>Cancelled {s.cancelled_at ? new Date(s.cancelled_at).toLocaleDateString() : "—"}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {workspaceId && (
        <ChangeRequestWorkspace
          submissionId={workspaceId}
          currentUserId={profile?.id ?? null}
          directory={companyDirectorySorted}
          renderFieldEditor={(f, vals, set) => renderField(f as RequestField, vals, set)}
          onSubmitDraft={submitDraftThroughWizard}
          onChanged={() => void loadMine()}
          onClose={() => { setWorkspaceId(null); void loadMine(); if (tab === "ASSIGNED") void loadAssignedToMe(); }}
        />
      )}
      {draftDialog && createPortal(
        <div className="ep-modal-overlay" onClick={() => !savingDraft && setDraftDialog(null)}>
          <div className="ep-modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h3 className="ep-modal-title">Save as draft</h3>
                <p className="ep-modal-sub">Add co-owners and co-writers to finish this Change Request with you. You can add or remove people later.</p>
              </div>
            </div>
            <div className="ep-modal-body">
              <BrsPeoplePicker
                users={companyDirectorySorted}
                ownerIds={draftDialog.ownerIds}
                onOwnersChange={(ids) => setDraftDialog((d) => (d ? { ...d, ownerIds: ids } : d))}
                coWriters={draftDialog.coWriters}
                onCoWritersChange={(entries) => setDraftDialog((d) => (d ? { ...d, coWriters: entries } : d))}
                excludeIds={profile?.id ? [profile.id] : []}
                permissionOptions={CR_PERMISSION_OPTIONS}
                presets={CR_PRESETS}
                ownerWord="co-owner"
              />
              {error && <div className="custom-request-error">{error}</div>}
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn-outline" disabled={savingDraft} onClick={() => setDraftDialog(null)}>Cancel</button>
              <button className="ep-btn" disabled={savingDraft} onClick={() => void saveChangeRequestDraft(draftDialog)}>{savingDraft ? "Saving…" : "Save draft"}</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {distributingId && (() => {
        const sub = mine.find((m) => m.id === distributingId);
        return (
          <DistributeDialog
            docType="CHANGE_REQUEST"
            docId={distributingId}
            title={sub?.data?.description_of_change || sub?.request_type_name || "Change Request"}
            onClose={() => setDistributingId(null)}
            onDone={(count) => { void showNotice(`Distributed to ${count} ${count === 1 ? "person" : "people"}.`); }}
          />
        );
      })()}
    </div>
  );
}
