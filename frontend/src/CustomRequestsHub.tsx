import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, openBlobInNewTab } from "./api";
import { showNotice } from "./alerts";
import { ArrowDown, ArrowUp, Calendar, ChevronDown, ClipboardList, Download, FileText, Inbox, Paperclip, Plus, Search, Trash2, UploadCloud, UserCheck, Users, X } from "lucide-react";

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
  attachments?: Attachment[];
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
  // Anchor coordinates for the portaled dropdown, in viewport (position:fixed)
  // terms — collision detection against the window only works if the dropdown
  // actually escapes any ancestor with overflow:hidden (e.g. a wizard panel
  // card), which an absolutely-positioned child of this combobox can't do.
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
      // Ignore scrolling inside the dropdown's own results list — only
      // close when an ancestor (the page/panel) scrolls underneath it.
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

    // The dropdown is widened beyond the (often narrow) input column for
    // readability. Anchor it to whichever side of the input has enough
    // room — falling back to clamping its width to the viewport so it
    // never gets clipped or runs under a neighboring column. Positioned via
    // a portal to document.body (position: fixed, viewport coordinates) so
    // it isn't clipped by a parent card/panel with overflow:hidden.
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
        </div>,
        document.body
      )}
    </div>
  );
}

function assigneeLabel(a: AssigneeEntry) {
  return a.teamId ? `Team: ${a.teamName}` : a.name || a.email || "—";
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
    value?.kind === "team" ? `Team: ${teams.find((t) => t.id === value.id)?.name ?? ""}`
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
          placeholder="Assign a team or individual"
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
              <div style={{ padding: "6px 12px", fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>Teams</div>
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

// Editable list of assignees for a "user_multi" field (e.g. Change Assignee)
// while composing a new request — pick a system user, invite by email, or
// assign a whole team (any member can confirm later). Confirmation happens
// post-submission.
function UserMultiField({
  entries, users, teams, onAdd, onRemove
}: { entries: AssigneeEntry[]; users: DirectoryUser[]; teams: TeamOption[]; onAdd: (entry: AssigneeEntry) => void; onRemove: (idx: number) => void }) {
  const [pending, setPending] = useState<AssigneePick | null>(null);

  function commitPick() {
    if (!pending) return;
    if (pending.kind === "team") {
      const t = teams.find((x) => x.id === pending.id);
      if (!t) return;
      onAdd({ id: null, name: null, email: null, teamId: t.id, teamName: t.name, confirmed: false, confirmed_at: null });
    } else if (pending.kind === "user") {
      const u = users.find((x) => x.id === pending.id);
      if (!u) return;
      onAdd({ id: u.id, name: u.full_name, email: u.email, confirmed: false, confirmed_at: null });
    } else {
      onAdd({ id: null, name: null, email: pending.value, confirmed: false, confirmed_at: null });
    }
    setPending(null);
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
          <AssigneeCombobox users={users} teams={teams} value={pending} onChange={setPending} allowFreeEmail />
        </div>
        <button type="button" className="ep-btn-outline" disabled={!pending} onClick={commitPick} style={{ whiteSpace: "nowrap", padding: "0 10px", height: 38 }}>
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
  const [pending, setPending] = useState<AssigneePick | null>(null);

  function commitPick() {
    if (!pending) return;
    if (pending.kind === "team") {
      onAdd({ team_id: pending.id });
    } else if (pending.kind === "user") {
      onAdd({ id: pending.id });
    } else {
      onAdd({ email: pending.value });
    }
    setPending(null);
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <AssigneeCombobox users={users} teams={teams} value={pending} onChange={setPending} allowFreeEmail />
      </div>
      <button type="button" className="ep-btn-outline" disabled={!pending} onClick={commitPick} style={{ whiteSpace: "nowrap", padding: "0 10px", height: 38 }}>
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
  const [cancelComment, setCancelComment] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const selectedType = types.find((t) => t.id === selectedTypeId) || null;
  const isChangeRequestType = selectedType?.code === "CHANGE_REQUEST";

  // Group fields into wizard pages by their configured wizard_step, then
  // append one implicit final page for the approval chain / change control.
  const fieldStepNumbers = useMemo(() => [...new Set(fields.map((f) => f.wizard_step || 1))].sort((a, b) => a - b), [fields]);
  const totalWizardSteps = fieldStepNumbers.length + 1;
  const approvalsStepIndex = totalWizardSteps;
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
        setWizardStep(1);
        setAttachmentFiles([]);
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
        approval_chain: submitChain
      }, attachmentFiles);
      setValues({});
      setChain(
        fixedChain?.length
          ? fixedChain.map((step) => ({ approver_id: step.source === "AUTO_MANAGER" ? (myManager?.id || "") : "", position_name: step.title, decision_type: "APPROVE" as const }))
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
      if (!f.is_required) continue;
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
    setWizardStep((s) => Math.min(s + 1, approvalsStepIndex));
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

  async function addAssignee(submissionId: string, fieldKey: string, entry: { id?: string; email?: string; name?: string; team_id?: string }) {
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
        // The "month" field (e.g. Attendance Register) only ever needs a
        // calendar month, not a specific day.
        if (f.field_key === "month") {
          return <MonthYearPicker value={value} onChange={(v) => setValue(f.field_key, v)} />;
        }
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
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon">
              <ClipboardList size={18} />
            </span>
            <h2>Custom Requests</h2>
          </div>
          <p className="custom-requests-subtitle">
            Submit any configured request type and define who needs to approve it.
          </p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      {types.length > 1 && (
        <div className="ep-form-group custom-request-type-picker">
          <label>Request Type</label>
          <select className="ep-form-select" value={selectedTypeId || ""} onChange={(e) => setSelectedTypeId(e.target.value)}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}

      <div className="ep-tabs custom-request-tabs">
        <a href="#" className={`ep-tab ${tab === "NEW" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("NEW"); }}>
          <FileText size={14} /> New Request
        </a>
        <a href="#" className={`ep-tab ${tab === "MINE" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("MINE"); }}>
          <Inbox size={14} /> My Requests
        </a>
        <a href="#" className={`ep-tab ${tab === "ASSIGNED" ? "active" : ""}`} onClick={(e) => { e.preventDefault(); setTab("ASSIGNED"); }}>
          <UserCheck size={14} /> Assigned to Me
        </a>
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
                          const mine = entries.find((a) => a.id === profile?.id || (a.teamId && profile?.team_id && a.teamId === profile.team_id));
                          return mine && !mine.confirmed;
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
                            <label>{f.field_label}{f.is_required && <span className="ep-required"> *</span>}</label>
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
                {isApprovalsStep ? (
                  <button className="ep-btn" onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Submitting…" : `Submit ${selectedType?.name || "Request"}`}
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
                                {step.decision_type === "NOTE" && <span style={{ color: "var(--muted)", fontSize: 12 }}> (noting)</span>}
                                {step.comment && <div style={{ color: "var(--muted)", fontSize: 12 }}>"{step.comment}"</div>}
                              </div>
                              {statusBadge(i === s.current_step_order && s.status === "IN_PROGRESS" ? "PENDING" : step.status)}
                            </div>
                          ))}
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
    </div>
  );
}
