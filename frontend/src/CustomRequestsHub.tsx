import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { ArrowDown, ArrowUp, ClipboardList, Plus, Search, Trash2, X } from "lucide-react";

type DirectoryUser = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  department: string | null;
  title?: string | null;
  role?: string | null;
};

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
};

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
  confirmed: boolean;
  confirmed_at: string | null;
  confirmedBy?: string | null;
};

type TeamOption = { id: string; name: string; section_id: string | null };

type FixedApprovalStep = {
  title: string;
  source: "AUTO_MANAGER" | "ROLE_PICKER";
  role?: string;
};

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
};

type Submission = {
  id: string;
  status: string;
  data: Record<string, any>;
  approval_chain: Array<{ approver_id: string; approver_name: string | null; position_name: string; status: string; comment: string | null; acted_at: string | null }>;
  current_step_order: number;
  created_at: string;
  request_type_id: string;
  request_type_name: string;
  request_type_code: string;
  implementation_date: string | null;
  closure_notes: string | null;
  closed_at: string | null;
};

type CustomRequestsHubProps = {
  profile: any;
  // Department-scoped (the requester's own team) — used for request types
  // that restrict approvers to management within the requester's own team,
  // e.g. Attendance Register.
  requestDirectory: DirectoryUser[];
  onBack: () => void;
};

function userLabel(u: DirectoryUser) {
  const parts = [u.full_name || u.email];
  if (u.title) parts.push(u.title);
  else if (u.department) parts.push(u.department);
  return parts.join(" — ");
}

function statusBadge(status: string) {
  const map: Record<string, { bg: string; fg: string }> = {
    SUBMITTED: { bg: "#e0f2fe", fg: "#0369a1" },
    IN_PROGRESS: { bg: "#fef3c7", fg: "#b45309" },
    APPROVED: { bg: "#dcfce7", fg: "#15803d" },
    REJECTED: { bg: "#fee2e2", fg: "#b91c1c" },
    CLOSED: { bg: "#f0fdf4", fg: "#166534" },
    PENDING: { bg: "#fef3c7", fg: "#b45309" }
  };
  const c = map[status] || { bg: "#f1f5f9", fg: "#475569" };
  return (
    <span style={{ background: c.bg, color: c.fg, fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 999 }}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

const COMBOBOX_DROPDOWN_HEIGHT = 220;
const COMBOBOX_DROPDOWN_MIN_WIDTH = 300;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ApproverCombobox({
  users, value, onChange, allowFreeEmail
}: { users: DirectoryUser[]; value: string; onChange: (id: string) => void; allowFreeEmail?: boolean }) {
  const selected = users.find((u) => u.id === value) || null;
  // Lets the field hold a plain email for someone who hasn't logged into
  // FlowDesk yet — they'll get an email naming them on the request instead
  // of being picked from the directory.
  const isFreeEmail = !selected && allowFreeEmail && EMAIL_RE.test(value.trim());
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [openLeftward, setOpenLeftward] = useState(false);
  const [dropdownWidth, setDropdownWidth] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onScroll(e: Event) {
      // Ignore scrolling inside the dropdown's own results list — only
      // close when an ancestor (the page/panel) scrolls underneath it.
      if (boxRef.current && boxRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  function handleOpen() {
    const rect = boxRef.current?.getBoundingClientRect();
    const spaceBelow = rect ? window.innerHeight - rect.bottom : Infinity;
    setOpenUpward(spaceBelow < COMBOBOX_DROPDOWN_HEIGHT + 16);

    // The dropdown is widened beyond the (often narrow) input column for
    // readability. Anchor it to whichever side of the input has enough
    // room — falling back to clamping its width to the viewport so it
    // never gets clipped or runs under a neighboring column.
    if (rect) {
      const desiredWidth = Math.max(rect.width, COMBOBOX_DROPDOWN_MIN_WIDTH);
      const spaceRight = window.innerWidth - rect.left;
      const spaceLeft = rect.right;
      const leftward = desiredWidth > spaceRight - 16 && spaceLeft >= desiredWidth;
      setOpenLeftward(leftward);
      setDropdownWidth(Math.min(desiredWidth, window.innerWidth - 16));
    } else {
      setOpenLeftward(false);
      setDropdownWidth(null);
    }

    setOpen(true);
    setQuery("");
  }

  const trimmedQuery = query.trim();
  const q = trimmedQuery.toLowerCase();
  const matches = q
    ? users.filter((u) => userLabel(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.employee_no || "").toLowerCase().includes(q))
    : users;
  const isQueryEmail = Boolean(allowFreeEmail) && EMAIL_RE.test(trimmedQuery);
  const hasExactEmailMatch = matches.some((u) => u.email.toLowerCase() === q);
  const showInviteOption = isQueryEmail && !hasExactEmailMatch;

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <Search size={13} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
        <input
          className="ep-form-input"
          style={{ paddingLeft: 26, paddingRight: (selected || isFreeEmail) ? 26 : 10 }}
          placeholder={allowFreeEmail ? "Search approver, or type an email to invite…" : "Search approver by name, email…"}
          value={open ? query : (selected ? userLabel(selected) : (isFreeEmail ? value : ""))}
          onFocus={handleOpen}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(selected || isFreeEmail) && !open && (
          <button
            type="button"
            onClick={() => onChange("")}
            style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex" }}
            title="Clear"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {open && (
        <div
          style={{
            position: "absolute", zIndex: 20,
            width: dropdownWidth ?? "100%",
            ...(openLeftward ? { right: 0 } : { left: 0 }),
            ...(openUpward ? { bottom: "100%", marginBottom: 2 } : { top: "100%", marginTop: 2 }),
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
            maxHeight: COMBOBOX_DROPDOWN_HEIGHT, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.12)"
          }}
        >
          {showInviteOption && (
            <button
              type="button"
              onClick={() => { onChange(trimmedQuery); setOpen(false); setQuery(""); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", borderBottom: matches.length ? "1px solid var(--border)" : "none", background: "transparent", cursor: "pointer", fontSize: 13 }}
            >
              <div style={{ fontWeight: 600 }}>Invite "{trimmedQuery}"</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Not yet a FlowDesk user — they'll get an email about this request</div>
            </button>
          )}
          {matches.length === 0 && !showInviteOption ? (
            <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--muted)" }}>
              {allowFreeEmail ? "No matches. Type a full email address to invite someone new." : "No matches."}
            </div>
          ) : (
            matches.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => { onChange(u.id); setOpen(false); setQuery(""); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: u.id === value ? "#eff6ff" : "transparent", cursor: "pointer", fontSize: 13 }}
              >
                <div style={{ fontWeight: 600 }}>{u.full_name || u.email}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{u.email}{u.title ? ` · ${u.title}` : u.department ? ` · ${u.department}` : ""}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function assigneeLabel(a: AssigneeEntry) {
  return a.teamId ? `Team: ${a.teamName}` : a.name || a.email || "—";
}

// Editable list of assignees for a "user_multi" field (e.g. Change Assignee)
// while composing a new request — pick a system user, invite by email, or
// assign a whole team (any member can confirm later). Confirmation happens
// post-submission.
function UserMultiField({
  entries, users, teams, onAdd, onRemove
}: { entries: AssigneeEntry[]; users: DirectoryUser[]; teams: TeamOption[]; onAdd: (entry: AssigneeEntry) => void; onRemove: (idx: number) => void }) {
  const [pending, setPending] = useState("");
  const [pendingTeamId, setPendingTeamId] = useState("");

  function commitPick(picked: string) {
    if (!picked) return;
    const dirUser = users.find((u) => u.id === picked);
    onAdd(
      dirUser
        ? { id: dirUser.id, name: dirUser.full_name, email: dirUser.email, confirmed: false, confirmed_at: null }
        : { id: null, name: null, email: picked, confirmed: false, confirmed_at: null }
    );
    setPending("");
  }

  function commitTeam() {
    if (!pendingTeamId) return;
    const t = teams.find((x) => x.id === pendingTeamId);
    if (!t) return;
    onAdd({ id: null, name: null, email: null, teamId: t.id, teamName: t.name, confirmed: false, confirmed_at: null });
    setPendingTeamId("");
  }

  return (
    <div>
      {entries.map((a, idx) => (
        <div key={idx} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--surface-soft)", borderRadius: 6, marginBottom: 6, fontSize: 13 }}>
          <div>
            <strong>{assigneeLabel(a)}</strong>
            {!a.id && !a.teamId && <span style={{ color: "var(--muted)" }}> · invited, no account yet</span>}
            {a.id && a.name && <span style={{ color: "var(--muted)" }}> · {a.email}</span>}
            {a.teamId && <span style={{ color: "var(--muted)" }}> · any member can confirm</span>}
          </div>
          <button type="button" className="ep-icon-btn" onClick={() => onRemove(idx)} title="Remove">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <ApproverCombobox users={users} value={pending} onChange={commitPick} allowFreeEmail />
        </div>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>or</span>
        <select className="ep-form-select" style={{ maxWidth: 200 }} value={pendingTeamId} onChange={(e) => { setPendingTeamId(e.target.value); }}>
          <option value="">Assign a team…</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="button" className="ep-btn-outline" disabled={!pendingTeamId} onClick={commitTeam} style={{ whiteSpace: "nowrap" }}>
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

// Inline "add another assignee" picker for an already-submitted request
// (Assigned to Me tab) — an existing assignee can pull in another person or team to help.
function AssigneeAdder({
  users, teams, onAdd
}: { users: DirectoryUser[]; teams: TeamOption[]; onAdd: (entry: { id?: string; email?: string; name?: string; team_id?: string }) => void }) {
  const [pending, setPending] = useState("");
  const [pendingTeamId, setPendingTeamId] = useState("");

  function commitPick(picked: string) {
    if (!picked) return;
    const dirUser = users.find((u) => u.id === picked);
    onAdd(dirUser ? { id: dirUser.id } : { email: picked });
    setPending("");
  }

  function commitTeam() {
    if (!pendingTeamId) return;
    onAdd({ team_id: pendingTeamId });
    setPendingTeamId("");
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <ApproverCombobox users={users} value={pending} onChange={commitPick} allowFreeEmail />
      </div>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>or</span>
      <select className="ep-form-select" style={{ maxWidth: 200 }} value={pendingTeamId} onChange={(e) => setPendingTeamId(e.target.value)}>
        <option value="">Assign a team…</option>
        {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button type="button" className="ep-btn-outline" disabled={!pendingTeamId} onClick={commitTeam} style={{ whiteSpace: "nowrap" }}>
        <Plus size={14} />
      </button>
    </div>
  );
}

function daysInMonth(dateValue: string | undefined) {
  const d = dateValue ? new Date(dateValue) : null;
  if (!d || Number.isNaN(d.getTime())) return 31;
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function tableColumns(cfg: TableFieldConfig | null | undefined, values: Record<string, any>) {
  if (!cfg) return [] as { key: string; label: string }[];
  if (cfg.columnMode === "FIXED") return cfg.columns || [];
  const days = daysInMonth(cfg.monthFieldKey ? values[cfg.monthFieldKey] : undefined);
  return Array.from({ length: days }, (_, i) => ({ key: String(i + 1), label: String(i + 1) }));
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

export default function CustomRequestsHub({ profile, requestDirectory, onBack }: CustomRequestsHubProps) {
  const [tab, setTab] = useState<"NEW" | "MINE" | "ASSIGNED">("NEW");
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
  const [chain, setChain] = useState<ChainStepDraft[]>([{ approver_id: "", position_name: "" }]);
  const [myManager, setMyManager] = useState<DirectoryUser | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mine, setMine] = useState<Submission[]>([]);
  const [assignedToMe, setAssignedToMe] = useState<Submission[]>([]);
  const [assignedToMeLoading, setAssignedToMeLoading] = useState(false);
  const [assignedToMeError, setAssignedToMeError] = useState<string | null>(null);
  // The assigned-to-me list doesn't include field metadata per submission —
  // fetch each distinct request type's "user_multi" fields once and cache.
  const [assignedTypeFields, setAssignedTypeFields] = useState<Record<string, RequestField[]>>({});
  const [assigneeActionError, setAssigneeActionError] = useState<string | null>(null);
  // Local edit buffer for implementation-side fields (Implementation Plan,
  // Callout Person/Contact) an assignee fills in before confirming — keyed
  // by submission id so multiple cards can be edited independently.
  const [implEdits, setImplEdits] = useState<Record<string, Record<string, string>>>({});
  const [savingImplId, setSavingImplId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeImplDate, setCloseImplDate] = useState("");
  const [closeNotes, setCloseNotes] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const selectedType = types.find((t) => t.id === selectedTypeId) || null;

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
  }, [tab]);

  useEffect(() => {
    (async () => {
      try {
        const allTypes = await api.requestTypes();
        const active: RequestTypeSummary[] = (allTypes || []).filter((t: any) => t.status === "ACTIVE");
        setTypes(active);
        if (!active.length) {
          setError("No request types have been configured yet.");
          return;
        }
        setSelectedTypeId(active[0].id);
      } catch {
        setError("Failed to load request types.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedTypeId) return;
    (async () => {
      setLoading(true);
      try {
        const detail = await api.requestTypeDetail(selectedTypeId);
        const sorted = [...(detail.fields || [])].sort((a: any, b: any) => a.sort_order - b.sort_order);
        setFields(sorted);
        const initialValues: Record<string, any> = {};
        const myName = profile?.full_name || profile?.fullName || "";
        // Known from the requester's own org-structure profile — pre-fill
        // rather than asking them to retype it. Permanent staff have a real
        // job title; non-permanent staff (interns, temps, contractors) often
        // don't, so fall back to their employment type instead.
        const isPermanent = String(profile?.employment_type || "").toUpperCase() === "PERMANENT";
        const knownByFieldKey: Record<string, string> = {
          division: profile?.division_name || "",
          department: profile?.department || "",
          position: isPermanent ? (profile?.title || "") : (profile?.employment_type || ""),
          emp_no: profile?.employee_no || ""
        };
        const today = new Date().toISOString().slice(0, 10);
        for (const f of sorted) {
          if (f.field_type === "table" && (f.options as TableFieldConfig | null)?.rowSource === "SELF") {
            initialValues[f.field_key] = { rows: [{ employee: myName, cells: {} }] };
          } else if (f.field_type === "text" && knownByFieldKey[f.field_key]) {
            initialValues[f.field_key] = knownByFieldKey[f.field_key];
          } else if (f.field_type === "date" && f.field_key === "date_requested") {
            initialValues[f.field_key] = today;
          }
        }
        setValues(initialValues);
        const fixedChain = (detail as RequestTypeSummary).fixed_approval_chain;
        if (fixedChain?.length) {
          setChain(fixedChain.map((step) => ({
            approver_id: step.source === "AUTO_MANAGER" ? (myManager?.id || "") : "",
            position_name: step.title
          })));
        } else {
          setChain([{ approver_id: "", position_name: "" }]);
        }
      } catch {
        setError("Failed to load the request form.");
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedTypeId, myManager, profile?.title, profile?.employment_type, profile?.department, profile?.division_name, profile?.employee_no]);

  async function loadMine() {
    if (!selectedType) return;
    try {
      const rows = await api.myCustomRequests();
      setMine(Array.isArray(rows) ? rows.filter((r: any) => r.request_type_code === selectedType.code) : []);
    } catch { /* silent */ }
  }

  useEffect(() => {
    if (tab === "MINE") loadMine();
  }, [tab, selectedTypeId]);

  function setValue(key: string, value: any) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function addChainStep() {
    setChain((prev) => [...prev, { approver_id: "", position_name: "" }]);
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
  // is scoped to company-wide users holding that exact role (e.g. only
  // Managers for "IT Manager", only Exco members for "IS HOD/CIO"/"CTO").
  function directoryForRole(role: string | undefined) {
    if (!role) return companyDirectory;
    return [...companyDirectory]
      .filter((u) => String(u.role || "").toUpperCase() === role.toUpperCase())
      .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  }

  async function handleSubmit() {
    if (!selectedTypeId) return;
    setError(null);

    for (const f of fields) {
      if (f.is_required) {
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
    let submitChain: { approver_id: string | null; position_name: string }[];
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
        position_name: step.title
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
        approval_chain: submitChain
      });
      setValues({});
      setChain(
        fixedChain?.length
          ? fixedChain.map((step) => ({ approver_id: step.source === "AUTO_MANAGER" ? (myManager?.id || "") : "", position_name: step.title }))
          : [{ approver_id: "", position_name: "" }]
      );
      setTab("MINE");
    } catch (e: any) {
      setError(e?.message || "Failed to submit the request");
    } finally {
      setSubmitting(false);
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

  async function confirmAssignee(submissionId: string, fieldKey: string) {
    setAssigneeActionError(null);
    try {
      await api.confirmCustomRequestAssignee(submissionId, fieldKey);
      await loadAssignedToMe();
    } catch (e: any) {
      setAssigneeActionError(e?.message || "Failed to confirm.");
    }
  }

  async function addAssignee(submissionId: string, fieldKey: string, entry: { id?: string; email?: string; name?: string; team_id?: string }) {
    setAssigneeActionError(null);
    try {
      await api.addCustomRequestAssignee(submissionId, { field_key: fieldKey, ...entry });
      await loadAssignedToMe();
    } catch (e: any) {
      setAssigneeActionError(e?.message || "Failed to add assignee.");
    }
  }

  function updateImplEdit(submissionId: string, fieldKey: string, value: string) {
    setImplEdits((prev) => ({ ...prev, [submissionId]: { ...prev[submissionId], [fieldKey]: value } }));
  }

  // Filling in the implementation plan IS the assignee's "I'm done" signal —
  // save it and confirm in one action rather than making them click twice.
  // Once every assignee has done this, the current approver is notified
  // their turn has actually arrived (handled server-side on confirm).
  async function saveImplementationFields(submissionId: string, data: Record<string, string>, confirmFieldKey?: string) {
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

    return (
      <div>
        <div className="ep-table-wrap" style={{ overflowX: "auto" }}>
          <table className="ep-table">
            <thead>
              <tr>
                <th>Employee</th>
                {columns.map((c) => <th key={c.key} style={{ minWidth: 36, textAlign: "center" }}>{c.label}</th>)}
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
                  {columns.map((c) => (
                    <td key={c.key}>
                      <select
                        className="ep-form-select"
                        style={{ padding: "2px 4px", minWidth: 44 }}
                        value={row.cells[c.key] || ""}
                        onChange={(e) => updateCell(ri, c.key, e.target.value)}
                      >
                        <option value="">—</option>
                        {(cfg?.cellOptions || []).map((o) => <option key={o.value} value={o.value} title={o.label}>{o.value}</option>)}
                      </select>
                    </td>
                  ))}
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
                  {columns.map((c) => <td key={c.key} />)}
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
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
            {cfg.cellOptions.map((o) => `${o.value} - ${o.label}`).join(" · ")}
          </div>
        )}
      </div>
    );
  }

  function renderField(f: RequestField) {
    const value = values[f.field_key] ?? "";
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
                onChange={(id) => setValue(f.field_key, id)}
                allowFreeEmail
              />
            </div>
            {profile?.id && value !== profile.id && (
              <button
                type="button"
                className="ep-btn-outline"
                style={{ whiteSpace: "nowrap", padding: "0 10px", height: 38 }}
                onClick={() => setValue(f.field_key, profile.id)}
                title="Assign this to yourself"
              >
                Myself
              </button>
            )}
          </div>
        );
      case "user_multi": {
        const entries: AssigneeEntry[] = Array.isArray(values[f.field_key]) ? values[f.field_key] : [];
        return (
          <UserMultiField
            entries={entries}
            users={companyDirectorySorted}
            teams={teams}
            onAdd={(entry) => setValue(f.field_key, [...entries, entry])}
            onRemove={(idx) => setValue(f.field_key, entries.filter((_, i) => i !== idx))}
          />
        );
      }
      case "section":
        return (
          <select className="ep-form-select" value={value} onChange={(e) => setValue(f.field_key, e.target.value)}>
            <option value="">{f.placeholder || "Select a section…"}</option>
            {sections.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        );
      case "textarea":
        return (
          <textarea
            className="ep-form-textarea"
            rows={3}
            placeholder={f.placeholder || ""}
            value={value}
            onChange={(e) => setValue(f.field_key, e.target.value)}
          />
        );
      case "number":
        return (
          <input
            type="number"
            className="ep-form-input"
            placeholder={f.placeholder || ""}
            value={value}
            onChange={(e) => setValue(f.field_key, e.target.value)}
          />
        );
      case "date":
        return (
          <input
            type="date"
            className="ep-form-input"
            value={value}
            onChange={(e) => setValue(f.field_key, e.target.value)}
          />
        );
      case "checkbox":
        return (
          <label className="ep-checkbox-label">
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => setValue(f.field_key, e.target.checked)} />
            {f.placeholder || f.field_label}
          </label>
        );
      case "select":
        return (
          <select className="ep-form-select" value={value} onChange={(e) => setValue(f.field_key, e.target.value)}>
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
            onChange={(e) => setValue(f.field_key, e.target.value)}
          />
        );
    }
  }

  return (
    <div style={{ padding: "0 0 40px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
            <ClipboardList size={22} /> Custom Requests
          </h2>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>
            Submit any configured request type and define who needs to approve it.
          </p>
        </div>
        <button onClick={onBack} style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Back</button>
      </div>

      {types.length > 1 && (
        <div className="ep-form-group" style={{ maxWidth: 360 }}>
          <label>Request Type</label>
          <select className="ep-form-select" value={selectedTypeId || ""} onChange={(e) => setSelectedTypeId(e.target.value)}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}

      <div className="ep-tabs">
        <a href="#" className={`ep-tab ${tab === "NEW" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("NEW"); }}>New Request</a>
        <a href="#" className={`ep-tab ${tab === "MINE" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("MINE"); }}>My Requests</a>
        <a href="#" className={`ep-tab ${tab === "ASSIGNED" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("ASSIGNED"); }}>Assigned to Me</a>
      </div>

      {loading ? (
        <div className="ep-loading"><p>Loading form…</p></div>
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
                  return (
                    <div key={s.id} className="card" style={{ padding: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ fontWeight: 700 }}>{s.data?.description_of_change || s.request_type_name}</div>
                          <div style={{ fontSize: 12, color: "var(--muted)" }}>Submitted {new Date(s.created_at).toLocaleDateString()}</div>
                        </div>
                        {statusBadge(s.status)}
                      </div>

                      {multiFields.map((f) => {
                        const entries: AssigneeEntry[] = Array.isArray(s.data?.[f.field_key]) ? s.data[f.field_key] : [];
                        const mine = entries.find((a) =>
                          a.id === profile?.id || (a.teamId && profile?.team_id && a.teamId === profile.team_id)
                        );
                        return (
                          <div key={f.field_key} style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{f.field_label}</div>
                            <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
                              {entries.map((a, i) => (
                                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                                  <div>
                                    {assigneeLabel(a)}
                                    {!a.id && !a.teamId && <span style={{ color: "var(--muted)" }}> · invited, no account yet</span>}
                                    {a.teamId && <span style={{ color: "var(--muted)" }}> · any member can confirm</span>}
                                    {a.confirmed && a.confirmedBy && <span style={{ color: "var(--muted)" }}> · confirmed by {a.confirmedBy}</span>}
                                  </div>
                                  {statusBadge(a.confirmed ? "APPROVED" : "PENDING")}
                                </div>
                              ))}
                            </div>
                            {mine && !mine.confirmed && s.status === "IN_PROGRESS" && (
                              <button className="ep-btn" style={{ fontSize: 12, padding: "5px 12px", marginRight: 8 }} onClick={() => confirmAssignee(s.id, f.field_key)}>
                                Confirm Ready
                              </button>
                            )}
                            {s.status === "IN_PROGRESS" && (
                              <div style={{ marginTop: 8, maxWidth: 460 }}>
                                <AssigneeAdder users={companyDirectorySorted} teams={teams} onAdd={(entry) => addAssignee(s.id, f.field_key, entry)} />
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {(() => {
                        const implKeys = ["implementation_plan", "callout_person", "callout_contact_no"];
                        const implFields = typeFields.filter((f) => implKeys.includes(f.field_key));
                        if (!implFields.length || s.status !== "IN_PROGRESS") return null;
                        const buffer = implEdits[s.id] || {};
                        const currentValue = (f: RequestField) => buffer[f.field_key] ?? s.data?.[f.field_key] ?? "";
                        // If the viewer is themselves an unconfirmed assignee, saving the
                        // plan also confirms them — filling it in IS their "I'm done" signal.
                        const myUnconfirmedField = multiFields.find((f) => {
                          const entries: AssigneeEntry[] = Array.isArray(s.data?.[f.field_key]) ? s.data[f.field_key] : [];
                          const mine = entries.find((a) => a.id === profile?.id || (a.teamId && profile?.team_id && a.teamId === profile.team_id));
                          return mine && !mine.confirmed;
                        });
                        return (
                          <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Implementation Details</div>
                            <div style={{ display: "grid", gap: 10, marginBottom: 8 }}>
                              {implFields.map((f) => (
                                <div key={f.field_key}>
                                  <label style={{ fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 4 }}>{f.field_label}</label>
                                  {f.field_type === "textarea" ? (
                                    <textarea
                                      className="ep-form-textarea"
                                      rows={3}
                                      value={currentValue(f)}
                                      onChange={(e) => updateImplEdit(s.id, f.field_key, e.target.value)}
                                    />
                                  ) : (
                                    <input
                                      className="ep-form-input"
                                      value={currentValue(f)}
                                      onChange={(e) => updateImplEdit(s.id, f.field_key, e.target.value)}
                                    />
                                  )}
                                </div>
                              ))}
                            </div>
                            <button
                              className="ep-btn"
                              style={{ fontSize: 12, padding: "5px 12px" }}
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
          <div className="ep-panel">
            <div className="ep-panel-head">
              <div className="ep-panel-title">{selectedType?.name || "Request"} Form</div>
            </div>
            <div className="ep-panel-body">
              <div className="ep-form-fields-grid">
                {fields.map((f) => (
                  <div
                    className={`ep-form-group ${["textarea", "table"].includes(f.field_type) ? "ep-form-field-full" : ""}`}
                    key={f.field_key}
                  >
                    {f.field_type !== "checkbox" && (
                      <label>{f.field_label}{f.is_required && <span className="ep-required"> *</span>}</label>
                    )}
                    {renderField(f)}
                  </div>
                ))}
              </div>

              <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Approval Workflow</div>

                {selectedType?.fixed_approval_chain?.length ? (
                  <>
                    <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
                      This request type has a fixed sign-off order. Choose the people for each role below.
                    </div>
                    {selectedType.fixed_approval_chain.map((stepDef, idx) => (
                      <div key={idx} style={{ marginBottom: 8 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "32px 1.3fr 2fr", gap: 8, alignItems: "center" }}>
                          <div style={{ fontWeight: 700, color: "var(--muted)", textAlign: "center" }}>{idx + 1}</div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{stepDef.title}</div>
                          <ApproverCombobox
                            users={stepDef.source === "AUTO_MANAGER" ? directorySorted : directoryForRole(stepDef.role)}
                            value={chain[idx]?.approver_id || ""}
                            onChange={(id) => updateChainStep(idx, { approver_id: id })}
                          />
                        </div>
                        {stepDef.source === "AUTO_MANAGER" && !myManager && (
                          <div style={{ fontSize: 12, color: "#b45309", marginTop: 4, gridColumn: "2 / -1" }}>
                            No manager found in the org structure for you — please select your manager manually.
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
                      Every request can follow a different approval path. Add the people who need to approve this request, in order.
                    </div>

                    {chain.map((step, idx) => (
                      <div key={idx} style={{ display: "grid", gridTemplateColumns: "32px 2fr 2fr auto auto auto", gap: 8, alignItems: "center", marginBottom: 8 }}>
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

              {error && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 16 }}>{error}</div>}

              <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
                <button className="ep-btn" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? "Submitting…" : `Submit ${selectedType?.name || "Request"}`}
                </button>
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="ep-panel">
          <div className="ep-panel-head">
            <div className="ep-panel-title">My {selectedType?.name || "Requests"}</div>
          </div>
          <div className="ep-panel-body">
            {!mine.length ? (
              <div className="ep-empty"><p>You haven't submitted any requests of this type yet.</p></div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {mine.map((s) => (
                  <div key={s.id} className="card" style={{ padding: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{s.data?.description_of_change || s.request_type_name}</div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>Submitted {new Date(s.created_at).toLocaleDateString()}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {s.status === "APPROVED" && selectedType?.requires_closure && closingId !== s.id && (
                          <button
                            className="ep-btn-outline"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                            onClick={(e) => { e.stopPropagation(); setClosingId(s.id); setCloseImplDate(""); setCloseNotes(""); setCloseError(null); }}
                          >
                            Close Request
                          </button>
                        )}
                        {statusBadge(s.status)}
                      </div>
                    </div>

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

                    {expanded === s.id && closingId !== s.id && (
                      <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                        {fields.filter((f) => f.field_type === "user_multi").map((f) => {
                          const entries: AssigneeEntry[] = Array.isArray(s.data?.[f.field_key]) ? s.data[f.field_key] : [];
                          if (!entries.length) return null;
                          return (
                            <div key={f.field_key} style={{ marginBottom: 12 }}>
                              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{f.field_label}</div>
                              <div style={{ display: "grid", gap: 6 }}>
                                {entries.map((a, i) => (
                                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                                    <div>{assigneeLabel(a)}</div>
                                    {statusBadge(a.confirmed ? "APPROVED" : "PENDING")}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Approval Chain</div>
                        <div style={{ display: "grid", gap: 6 }}>
                          {s.approval_chain.map((step, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                              <div>
                                <strong>{i + 1}. {step.position_name}</strong> — {step.approver_name || "—"}
                                {step.comment && <div style={{ color: "var(--muted)", fontSize: 12 }}>"{step.comment}"</div>}
                              </div>
                              {statusBadge(i === s.current_step_order && s.status === "IN_PROGRESS" ? "PENDING" : step.status)}
                            </div>
                          ))}
                        </div>
                        {s.status === "CLOSED" && (
                          <div style={{ marginTop: 12, padding: "10px 12px", background: "#f0fdf4", borderRadius: 6, fontSize: 13 }}>
                            <div style={{ fontWeight: 700, marginBottom: 4 }}>Closure Details</div>
                            <div><strong>Implementation Date:</strong> {s.implementation_date || "—"}</div>
                            {s.closure_notes && <div style={{ marginTop: 4 }}><strong>Notes:</strong> {s.closure_notes}</div>}
                            <div style={{ marginTop: 4, color: "var(--muted)" }}>Closed {s.closed_at ? new Date(s.closed_at).toLocaleDateString() : "—"}</div>
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
    </div>
  );
}
