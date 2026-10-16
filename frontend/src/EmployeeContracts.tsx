import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowLeft, Bell, CheckCircle2, Clock, Download, FileSignature, FileText, FolderSearch,
  GraduationCap, Plus, RefreshCw, Settings2, Trash2, Upload, UserPlus, Users, X, XCircle
} from "lucide-react";
import { api, openBlobInNewTab } from "./api";
import { ApproverCombobox, type DirectoryUser } from "./shared/ApproverCombobox";
import {
  FinanceEmptyState, FinanceFilterBar, FinanceKpiRow, FinanceKpiTile, FinancePageHeader, IconTabRow, SearchField, SelectField
} from "./components/FinanceQueueKit";

// Contracts > Employee Contracts: fixed-term contracts for interns and temporary
// staff. HR decides how many days before a contract ends they get reminded
// (Reminder settings). Reminders go to HR; HR can also tick a contract to
// remind the employee, who then gets their own separately worded email.

type Contract = {
  id: string;
  contract_no: string;
  user_id: string | null;
  person_name: string;
  person_email: string | null;
  user_employee_no: string | null;
  contract_type: "INTERN" | "TEMPORARY";
  position: string | null;
  department: string | null;
  supervisor_id: string | null;
  supervisor_name: string | null;
  start_date: string;
  end_date: string;
  days_left: number;
  status: "ACTIVE" | "RENEWED" | "ENDED" | "TERMINATED";
  reminder_days: number[] | null;
  notify_employee: boolean | null;
  notes: string | null;
  renewed_from_id: string | null;
  renewed_from_no: string | null;
  renewed_to_id: string | null;
  renewed_to_no: string | null;
  close_reason: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  created_by_name: string | null;
  created_at: string;
  document_count: number;
  last_reminder_at: string | null;
};
type Detail = Contract & {
  documents: Array<{ id: string; file_name: string; file_size: number | null; uploaded_at: string; uploaded_by_name: string | null }>;
  reminders: Array<{ days_before: number; status: string; recipients: string[]; employee_notified_to: string | null; sent_at: string | null; end_date: string }>;
  history: Array<{ action: string; created_at: string; actor_name: string | null; after_json: any }>;
};

const TYPE_LABEL: Record<string, string> = { INTERN: "Intern", TEMPORARY: "Temporary" };
const STATUS_STYLE: Record<string, [string, string]> = {
  ACTIVE: ["#d1fae5", "#065f46"],
  EXPIRING: ["#fef3c7", "#92400e"],
  EXPIRED: ["#fee2e2", "#991b1b"],
  RENEWED: ["#dbeafe", "#1d4ed8"],
  ENDED: ["#f1f5f9", "#475569"],
  TERMINATED: ["#f1f5f9", "#475569"]
};
const HISTORY_LABEL: Record<string, string> = {
  EMPLOYEE_CONTRACT_CREATED: "Contract created",
  EMPLOYEE_CONTRACT_UPDATED: "Contract edited",
  EMPLOYEE_CONTRACT_RENEWED: "Renewed",
  EMPLOYEE_CONTRACT_ENDED: "Ended",
  EMPLOYEE_CONTRACT_TERMINATED: "Terminated early",
  EMPLOYEE_CONTRACT_DOCUMENT_ADDED: "Document added",
  EMPLOYEE_CONTRACT_DOCUMENT_REMOVED: "Document removed",
  EMPLOYEE_CONTRACT_REOPENED: "Reopened"
};

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s.length === 10 ? s + "T00:00:00" : s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(date: string, days: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysLabel(days: number[]) {
  return days.length ? days.map((d) => `${d} day${d === 1 ? "" : "s"}`).join(", ") + " before" : "—";
}

// What HR sees as the state of an active contract: expired (end date passed,
// still not renewed or ended), expiring (inside the furthest reminder
// window), or simply active.
function displayStatus(c: Contract, windowDays: number) {
  if (c.status !== "ACTIVE") return c.status;
  if (c.days_left < 0) return "EXPIRED";
  if (c.days_left <= windowDays) return "EXPIRING";
  return "ACTIVE";
}
function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  const label = status === "EXPIRED" ? "Expired — action needed" : status === "EXPIRING" ? "Expiring soon" : status.charAt(0) + status.slice(1).toLowerCase();
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{label}</span>;
}
function DaysLeft({ c }: { c: Contract }) {
  if (c.status !== "ACTIVE") return <span style={{ color: "var(--muted)" }}>—</span>;
  const d = c.days_left;
  const color = d < 0 ? "#b91c1c" : d <= 30 ? "#b45309" : "var(--text)";
  return <span style={{ color, fontWeight: 600 }}>{d < 0 ? `${-d} day${d === -1 ? "" : "s"} ago` : d === 0 ? "Today" : `${d} day${d === 1 ? "" : "s"}`}</span>;
}

function DaysEditor({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const [draft, setDraft] = useState("");
  function add() {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || n < 1 || n > 365) return;
    onChange(Array.from(new Set([...value, n])).sort((a, b) => b - a));
    setDraft("");
  }
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {value.map((d) => (
        <span key={d} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 6px 3px 10px", borderRadius: 99, background: "var(--surface-2, #eef2ff)", fontSize: 12.5, fontWeight: 600 }}>
          {d} day{d === 1 ? "" : "s"}
          <button type="button" aria-label={`Remove ${d} days`} onClick={() => onChange(value.filter((x) => x !== d))} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--muted)", display: "inline-flex" }}><X size={13} /></button>
        </span>
      ))}
      <input
        className="ep-form-input"
        style={{ width: 90 }}
        type="number"
        min={1}
        max={365}
        placeholder="Days"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
      />
      <button type="button" className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 10px" }} onClick={add} disabled={!draft}>Add</button>
    </div>
  );
}

// ── Reminder settings ───────────────────────────────────────────────────
function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [days, setDays] = useState<number[]>([]);
  const [remindEmployee, setRemindEmployee] = useState(false);
  const [hrPeople, setHrPeople] = useState<Array<{ id: string; full_name: string | null; email: string }>>([]);
  const [emails, setEmails] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.employeeContractSettings().then((s: any) => {
      setDays(s.reminder_days || []);
      setRemindEmployee(!!s.remind_employee);
      setHrPeople(s.hr_recipients || []);
      setEmails((s.extra_emails || []).join(", "));
    }).catch((e: any) => setError(e?.message || "Failed to load settings")).finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.saveEmployeeContractSettings({
        reminder_days: days,
        remind_employee: remindEmployee,
        extra_emails: emails.split(/[;,\s]+/).map((e) => e.trim()).filter(Boolean)
      });
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ep-modal-overlay" onClick={onClose}>
      <div className="ep-modal" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="ep-modal-head">
          <div>
            <h2 className="ep-modal-title">Reminder settings</h2>
            <p className="ep-modal-sub">When reminders go out before an intern or temporary contract ends, and whether the employee is reminded too.</p>
          </div>
          <button className="ep-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="ep-modal-body">
          {loading ? <p>Loading…</p> : (
            <>
              <div className="ep-form-group">
                <label>Remind this many days before a contract ends</label>
                <DaysEditor value={days} onChange={setDays} />
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  One email per reminder, plus one on the day it ends if it's still open. A contract can override these.
                </div>
              </div>
              <div className="ep-form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={remindEmployee} onChange={(e) => setRemindEmployee(e.target.checked)} />
                  Also remind the employee
                </label>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  The intern or temp gets their own short reminder on the same days. HR is always reminded. A contract can override this.
                </div>
              </div>
              <div className="ep-form-group">
                <label>HR reminders go to</label>
                <div style={{ fontSize: 13 }}>
                  {hrPeople.length
                    ? hrPeople.map((p) => p.full_name || p.email).join(", ")
                    : <span style={{ color: "#b45309" }}>Nobody yet — an admin grants Employee Contracts to HR on Roles &amp; Permissions. Until then, whoever captured the contract is reminded.</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>Everyone with access to Employee Contracts (set by an admin on Roles &amp; Permissions).</div>
              </div>
              <div className="ep-form-group">
                <label>Other addresses <span style={{ fontWeight: 400, color: "var(--muted)" }}>— optional, e.g. a shared HR mailbox</span></label>
                <input className="ep-form-input" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="hr@etl.co.ls" />
              </div>
              {error && <div style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>}
            </>
          )}
        </div>
        <div className="ep-modal-footer">
          <button className="ep-btn-outline" onClick={onClose}>Cancel</button>
          <button className="ep-btn" disabled={saving || loading || days.length === 0} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</button>
        </div>
      </div>
    </div>
  );
}

// ── New / edit contract ─────────────────────────────────────────────────
type FormState = {
  personMode: "SYSTEM" | "OTHER";
  user_id: string;
  person_name: string;
  person_email: string;
  contract_type: "INTERN" | "TEMPORARY";
  position: string;
  department: string;
  supervisor_id: string;
  start_date: string;
  end_date: string;
  customReminders: boolean;
  reminder_days: number[];
  notify_employee: "DEFAULT" | "YES" | "NO";
  notes: string;
};

type Suggestion = {
  id: string; full_name: string | null; email: string; employee_no: string | null; title: string | null; employment_type: string;
  department: string | null; supervisor_id: string | null; supervisor_name: string | null;
  last_contract_no: string | null; last_end_date: string | null; last_status: string | null;
  dismissed: boolean; dismissed_reason: string | null; dismissed_by_name: string | null; dismissed_at: string | null;
};

function ContractModal({ users, existing, prefill, defaultDays, remindEmployeeDefault, onClose, onSaved }: {
  users: DirectoryUser[];
  existing: Contract | null;
  prefill?: Suggestion | null;
  defaultDays: number[];
  remindEmployeeDefault: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState<FormState>(() => existing ? {
    personMode: existing.user_id ? "SYSTEM" : "OTHER",
    user_id: existing.user_id || "",
    person_name: existing.person_name,
    person_email: existing.person_email || "",
    contract_type: existing.contract_type,
    position: existing.position || "",
    department: existing.department || "",
    supervisor_id: existing.supervisor_id || "",
    start_date: existing.start_date,
    end_date: existing.end_date,
    customReminders: !!existing.reminder_days?.length,
    reminder_days: existing.reminder_days?.length ? existing.reminder_days : defaultDays,
    notify_employee: existing.notify_employee === null ? "DEFAULT" : existing.notify_employee ? "YES" : "NO",
    notes: existing.notes || ""
  } : {
    personMode: "SYSTEM", user_id: "", person_name: "", person_email: "", contract_type: "INTERN", position: "", department: "",
    supervisor_id: "", start_date: today(), end_date: addDays(today(), 180), customReminders: false, reminder_days: defaultDays, notify_employee: "DEFAULT", notes: "",
    // Suggested from the employee list: everything we know is filled in, a
    // renewal-style start the day after their last contract ended.
    ...(prefill ? {
      user_id: prefill.id,
      contract_type: prefill.employment_type === "INTERN" ? "INTERN" as const : "TEMPORARY" as const,
      position: prefill.title || "",
      department: prefill.department || "",
      supervisor_id: prefill.supervisor_id || "",
      ...(prefill.last_end_date && prefill.last_end_date >= today() ? { start_date: addDays(prefill.last_end_date, 1), end_date: addDays(prefill.last_end_date, 181) } : {})
    } : {})
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setF((prev) => ({ ...prev, ...patch }));

  const [autoNote, setAutoNote] = useState<string | null>(prefill ? "Department from Org Structure; supervisor is their immediate manager (reporting line, else Org Structure)." : null);
  // Picking an employee fills in their Org Structure placement and immediate
  // manager - the same manager an approval workflow would route to.
  async function pickUser(id: string) {
    set({ user_id: id });
    if (!id) return;
    try {
      const p: any = await api.employeeContractPerson(id);
      set({
        user_id: id,
        position: p.position || "",
        department: p.org_path || "",
        supervisor_id: p.supervisor_id || "",
        ...(p.employment_type === "INTERN" || p.employment_type === "TEMPORARY" ? { contract_type: p.employment_type } : {})
      });
      setAutoNote(p.supervisor_id
        ? "Department from Org Structure; supervisor is their immediate manager (reporting line, else Org Structure)."
        : "Department from Org Structure. No immediate manager found — set up their reporting line, or choose a supervisor.");
    } catch {
      setAutoNote(null);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    const payload = {
      user_id: f.personMode === "SYSTEM" ? f.user_id || null : null,
      person_name: f.personMode === "OTHER" ? f.person_name : null,
      person_email: f.personMode === "OTHER" ? f.person_email || null : null,
      contract_type: f.contract_type,
      position: f.position || null,
      department: f.department || null,
      supervisor_id: f.supervisor_id || null,
      start_date: f.start_date,
      end_date: f.end_date,
      reminder_days: f.customReminders ? f.reminder_days : null,
      notify_employee: f.notify_employee === "DEFAULT" ? null : f.notify_employee === "YES",
      notes: f.notes || null
    };
    try {
      if (existing) {
        await api.updateEmployeeContract(existing.id, payload);
        onSaved(existing.id);
      } else {
        const r: any = await api.createEmployeeContract(payload);
        onSaved(r.id);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to save the contract");
    } finally {
      setSaving(false);
    }
  }

  const months = f.start_date && f.end_date
    ? Math.round(((new Date(f.end_date).getTime() - new Date(f.start_date).getTime()) / 86400000 + 1) / 30.44 * 10) / 10
    : null;

  return (
    <div className="ep-modal-overlay" onClick={onClose}>
      <div className="ep-modal ep-modal-lg" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="ep-modal-head">
          <div>
            <h2 className="ep-modal-title">{existing ? `Edit ${existing.contract_no}` : prefill ? `Contract for ${prefill.full_name || prefill.email}` : "New contract"}</h2>
            <p className="ep-modal-sub">{prefill ? "Filled in from their FlowDesk profile — check the details and set the dates." : "A fixed-term contract for an intern or temporary employee."}</p>
          </div>
          <button className="ep-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="ep-modal-body">
          <div className="ep-form-group">
            <label>Employee <span className="ep-required">*</span></label>
            <div className="ep-tabs" style={{ marginBottom: 8 }}>
              <button type="button" className={`ep-tab ${f.personMode === "SYSTEM" ? "active" : ""}`} onClick={() => set({ personMode: "SYSTEM" })}>Has a FlowDesk account</button>
              <button type="button" className={`ep-tab ${f.personMode === "OTHER" ? "active" : ""}`} onClick={() => set({ personMode: "OTHER" })}>Not on FlowDesk</button>
            </div>
            {f.personMode === "SYSTEM" ? (
              <>
                <ApproverCombobox users={users} value={f.user_id} onChange={(id) => void pickUser(id)} placeholder="Search the employee by name or email…" />
                {autoNote && f.user_id && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{autoNote}</div>}
              </>
            ) : (
              <div className="ep-form-row">
                <input className="ep-form-input" placeholder="Full name" value={f.person_name} onChange={(e) => set({ person_name: e.target.value })} />
                <input className="ep-form-input" placeholder="Email (optional)" value={f.person_email} onChange={(e) => set({ person_email: e.target.value })} />
              </div>
            )}
          </div>
          <div className="ep-form-row">
            <div className="ep-form-group">
              <label>Contract type <span className="ep-required">*</span></label>
              <select className="ep-form-select" value={f.contract_type} onChange={(e) => set({ contract_type: e.target.value as FormState["contract_type"] })}>
                <option value="INTERN">Intern</option>
                <option value="TEMPORARY">Temporary</option>
              </select>
            </div>
            <div className="ep-form-group">
              <label>Position</label>
              <input className="ep-form-input" value={f.position} onChange={(e) => set({ position: e.target.value })} placeholder="e.g. IT Intern" />
            </div>
          </div>
          <div className="ep-form-row">
            <div className="ep-form-group">
              <label>Department</label>
              <input className="ep-form-input" value={f.department} onChange={(e) => set({ department: e.target.value })} />
            </div>
            <div className="ep-form-group">
              <label>Supervisor</label>
              <ApproverCombobox users={users} value={f.supervisor_id} onChange={(id) => set({ supervisor_id: id })} placeholder="Search supervisor…" />
            </div>
          </div>
          <div className="ep-form-row">
            <div className="ep-form-group">
              <label>Start date <span className="ep-required">*</span></label>
              <input className="ep-form-input" type="date" value={f.start_date} onChange={(e) => set({ start_date: e.target.value })} />
            </div>
            <div className="ep-form-group">
              <label>End date <span className="ep-required">*</span> {months !== null && months > 0 && <span style={{ fontWeight: 400, color: "var(--muted)" }}>— about {months} month{months === 1 ? "" : "s"}</span>}</label>
              <input className="ep-form-input" type="date" value={f.end_date} min={f.start_date} onChange={(e) => set({ end_date: e.target.value })} />
            </div>
          </div>
          <div className="ep-form-group">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={f.customReminders} onChange={(e) => set({ customReminders: e.target.checked })} />
              Different reminders for this contract
              {!f.customReminders && <span style={{ fontWeight: 400, color: "var(--muted)" }}>— using the default: {daysLabel(defaultDays)}</span>}
            </label>
            {f.customReminders && <DaysEditor value={f.reminder_days} onChange={(v) => set({ reminder_days: v })} />}
          </div>
          <div className="ep-form-group">
            <label>Remind the employee too? <span style={{ fontWeight: 400, color: "var(--muted)" }}>— HR is always reminded</span></label>
            <select className="ep-form-select" style={{ maxWidth: 320 }} value={f.notify_employee} onChange={(e) => set({ notify_employee: e.target.value as FormState["notify_employee"] })}>
              <option value="DEFAULT">Use the setting ({remindEmployeeDefault ? "yes" : "no"})</option>
              <option value="YES">Yes, remind them</option>
              <option value="NO">No, HR only</option>
            </select>
            {(f.notify_employee === "YES" || (f.notify_employee === "DEFAULT" && remindEmployeeDefault)) && f.personMode === "OTHER" && !f.person_email.trim() && (
              <div style={{ fontSize: 12, color: "#b45309" }}>Add the employee's email above so they can be reminded.</div>
            )}
          </div>
          <div className="ep-form-group">
            <label>Notes</label>
            <textarea className="ep-form-textarea" rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. university placement, stipend arrangement" />
          </div>
          {error && <div style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>}
        </div>
        <div className="ep-modal-footer">
          <button className="ep-btn-outline" onClick={onClose}>Cancel</button>
          <button className="ep-btn" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : existing ? "Save changes" : "Create contract"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Renew / close ───────────────────────────────────────────────────────
function RenewModal({ c, onClose, onDone }: { c: Contract; onClose: () => void; onDone: (newId: string) => void }) {
  const [start, setStart] = useState(addDays(c.end_date, 1));
  const [end, setEnd] = useState(addDays(c.end_date, 180));
  const [type, setType] = useState(c.contract_type);
  const [position, setPosition] = useState(c.position || "");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r: any = await api.renewEmployeeContract(c.id, { start_date: start, end_date: end, contract_type: type, position: position || null, notes: notes || null });
      onDone(r.id);
    } catch (e: any) {
      setError(e?.message || "Failed to renew");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="ep-modal-overlay" onClick={onClose}>
      <div className="ep-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="ep-modal-head">
          <div>
            <h2 className="ep-modal-title">Renew {c.person_name}'s contract</h2>
            <p className="ep-modal-sub">{c.contract_no} is kept as history and a new contract starts. Its documents stay with the old one.</p>
          </div>
          <button className="ep-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="ep-modal-body">
          <div className="ep-form-row">
            <div className="ep-form-group"><label>New start date</label><input className="ep-form-input" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="ep-form-group"><label>New end date</label><input className="ep-form-input" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <div className="ep-form-row">
            <div className="ep-form-group">
              <label>Contract type</label>
              <select className="ep-form-select" value={type} onChange={(e) => setType(e.target.value as Contract["contract_type"])}>
                <option value="INTERN">Intern</option>
                <option value="TEMPORARY">Temporary</option>
              </select>
            </div>
            <div className="ep-form-group"><label>Position</label><input className="ep-form-input" value={position} onChange={(e) => setPosition(e.target.value)} /></div>
          </div>
          <div className="ep-form-group"><label>Notes</label><textarea className="ep-form-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          {error && <div style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>}
        </div>
        <div className="ep-modal-footer">
          <button className="ep-btn-outline" onClick={onClose}>Cancel</button>
          <button className="ep-btn" disabled={saving} onClick={() => void save()}>{saving ? "Renewing…" : "Renew contract"}</button>
        </div>
      </div>
    </div>
  );
}

function CloseModal({ c, onClose, onDone }: { c: Contract; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState<"ENDED" | "TERMINATED">(c.days_left <= 0 ? "ENDED" : "TERMINATED");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.closeEmployeeContract(c.id, { outcome, reason: reason || null });
      onDone();
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="ep-modal-overlay" onClick={onClose}>
      <div className="ep-modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="ep-modal-head">
          <div>
            <h2 className="ep-modal-title">Close {c.person_name}'s contract</h2>
            <p className="ep-modal-sub">Stops the reminders for {c.contract_no}.</p>
          </div>
          <button className="ep-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="ep-modal-body">
          <div className="ep-form-group">
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 500 }}>
              <input type="radio" checked={outcome === "ENDED"} onChange={() => setOutcome("ENDED")} /> Ended — not renewed (ran to its end date)
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 500 }}>
              <input type="radio" checked={outcome === "TERMINATED"} onChange={() => setOutcome("TERMINATED")} /> Terminated early
            </label>
          </div>
          <div className="ep-form-group">
            <label>Reason {outcome === "TERMINATED" && <span className="ep-required">*</span>}</label>
            <textarea className="ep-form-textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error && <div style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>}
        </div>
        <div className="ep-modal-footer">
          <button className="ep-btn-outline" onClick={onClose}>Cancel</button>
          <button className="ep-btn" disabled={saving || (outcome === "TERMINATED" && !reason.trim())} onClick={() => void save()}>{saving ? "Saving…" : "Close contract"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────
function ContractDetail({ id, users, defaultDays, remindEmployeeDefault, windowDays, onBack, onOpen }: {
  id: string; users: DirectoryUser[]; defaultDays: number[]; remindEmployeeDefault: boolean; windowDays: number; onBack: () => void; onOpen: (id: string) => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<"edit" | "renew" | "close" | null>(null);
  const [uploading, setUploading] = useState(false);

  function load() {
    setError(null);
    api.employeeContract(id).then((r: any) => setD(r)).catch((e: any) => setError(e?.message || "Failed to load"));
  }
  useEffect(load, [id]);

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api.uploadEmployeeContractDocument(id, form);
      load();
    } catch (e: any) {
      alert(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }
  async function removeDoc(docId: string, name: string) {
    if (!confirm(`Remove "${name}"?`)) return;
    await api.deleteEmployeeContractDocument(id, docId).catch((e: any) => alert(e?.message || "Failed"));
    load();
  }
  async function remove() {
    if (!d || !confirm(`Delete ${d.contract_no} permanently? Use this only for a contract captured by mistake — otherwise close it.`)) return;
    try {
      await api.deleteEmployeeContract(id);
      onBack();
    } catch (e: any) {
      alert(e?.message || "Failed to delete");
    }
  }

  if (error) return <div className="ep-panel"><div className="ep-panel-body" style={{ color: "#b91c1c" }}>{error}</div></div>;
  if (!d) return <div className="ep-loading"><p>Loading contract…</p></div>;
  const status = displayStatus(d, windowDays);
  const effectiveDays = d.reminder_days?.length ? d.reminder_days : defaultDays;
  const employeeReminded = d.notify_employee ?? remindEmployeeDefault;
  const nextReminders = d.status === "ACTIVE"
    ? [...effectiveDays, 0].filter((n) => d.days_left > n).map((n) => ({ n, on: addDays(d.end_date, -n) })).sort((a, b) => a.on.localeCompare(b.on))
    : [];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button className="ep-btn-outline" onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><ArrowLeft size={14} /> All contracts</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>{d.person_name}</h2>
        <StatusBadge status={status} />
        <span style={{ color: "var(--muted)", fontSize: 13 }}>{d.contract_no}</span>
        {d.status === "ACTIVE" && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ep-btn-outline" onClick={() => setModal("edit")}>Edit</button>
            <button className="ep-btn-outline" onClick={() => setModal("close")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><XCircle size={14} /> End / terminate</button>
            <button className="ep-btn" onClick={() => setModal("renew")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><RefreshCw size={14} /> Renew</button>
          </div>
        )}
      </div>

      {status === "EXPIRED" && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: "#fef2f2", color: "#991b1b", fontSize: 13, marginBottom: 14, display: "flex", gap: 8, alignItems: "center" }}>
          <AlertTriangle size={16} /> This contract ended on {fmtDate(d.end_date)} but hasn't been renewed or closed.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 16 }} className="ec-detail-grid">
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <div className="ep-panel">
            <div className="ep-panel-head"><div className="ep-panel-title">Contract</div></div>
            <div className="ep-panel-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px 18px", fontSize: 13.5 }}>
              {[
                ["Type", TYPE_LABEL[d.contract_type]],
                ["Position", d.position],
                ["Department", d.department],
                ["Supervisor", d.supervisor_name],
                ["Start date", fmtDate(d.start_date)],
                ["End date", fmtDate(d.end_date)],
                ["Days left", d.status === "ACTIVE" ? <DaysLeft c={d} /> : "—"],
                ["Email", d.person_email],
                ["Employee reminded", `${employeeReminded ? "Yes" : "No — HR only"}${d.notify_employee === null ? " (setting)" : ""}`],
                ["Employee no.", d.user_employee_no],
                ["Captured by", `${d.created_by_name || "—"} · ${fmtDate(d.created_at)}`]
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600 }}>{label}</div>
                  <div>{value || "—"}</div>
                </div>
              ))}
              {d.renewed_from_no && (
                <div><div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600 }}>Renewal of</div><a href="#" onClick={(e) => { e.preventDefault(); onOpen(d.renewed_from_id!); }}>{d.renewed_from_no}</a></div>
              )}
              {d.renewed_to_no && (
                <div><div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600 }}>Renewed as</div><a href="#" onClick={(e) => { e.preventDefault(); onOpen(d.renewed_to_id!); }}>{d.renewed_to_no}</a></div>
              )}
              {d.close_reason && (
                <div style={{ gridColumn: "1 / -1" }}><div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600 }}>Closed</div>{d.close_reason} — {d.closed_by_name || "—"}, {fmtDate(d.closed_at)}</div>
              )}
              {d.notes && (
                <div style={{ gridColumn: "1 / -1" }}><div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600 }}>Notes</div><div style={{ whiteSpace: "pre-wrap" }}>{d.notes}</div></div>
              )}
            </div>
          </div>

          <div className="ep-panel">
            <div className="ep-panel-head">
              <div><div className="ep-panel-title">Documents</div><div className="ep-panel-sub">The signed contract and any attachments.</div></div>
              <label className="ep-btn-outline" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, cursor: uploading ? "wait" : "pointer" }}>
                <Upload size={14} /> {uploading ? "Uploading…" : "Upload"}
                <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" hidden disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void uploadFile(file); }} />
              </label>
            </div>
            <div className="ep-panel-body">
              {d.documents.length === 0 ? <div style={{ color: "var(--muted)", fontSize: 13 }}>No documents yet.</div> : (
                <div style={{ display: "grid", gap: 6 }}>
                  {d.documents.map((doc) => (
                    <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
                      <FileText size={16} />
                      <a href="#" style={{ fontWeight: 600, fontSize: 13 }} onClick={(e) => { e.preventDefault(); void openBlobInNewTab(() => api.employeeContractDocumentBlob(id, doc.id)); }}>{doc.file_name}</a>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>{doc.file_size ? `${Math.max(1, Math.round(doc.file_size / 1024))} KB · ` : ""}{doc.uploaded_by_name || "—"}, {fmtDate(doc.uploaded_at)}</span>
                      <button className="ep-icon-btn" style={{ marginLeft: "auto" }} aria-label="Download" onClick={() => void openBlobInNewTab(() => api.employeeContractDocumentBlob(id, doc.id))}><Download size={14} /></button>
                      <button className="ep-icon-btn" aria-label="Remove" onClick={() => void removeDoc(doc.id, doc.file_name)}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="ep-panel">
            <div className="ep-panel-head"><div className="ep-panel-title">History</div></div>
            <div className="ep-panel-body">
              {d.history.length === 0 ? <div style={{ color: "var(--muted)", fontSize: 13 }}>Nothing recorded yet.</div> : d.history.map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 12, fontSize: 13, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ color: "var(--muted)", minWidth: 150 }}>{fmtDateTime(h.created_at)}</span>
                  <span><strong>{HISTORY_LABEL[h.action] || h.action}</strong> — {h.actor_name || "System"}
                    {h.action === "EMPLOYEE_CONTRACT_RENEWED" && h.after_json?.renewed_as ? ` (as ${h.after_json.renewed_as}, ends ${fmtDate(h.after_json.end_date)})` : ""}
                    {h.after_json?.file_name ? ` (${h.after_json.file_name})` : ""}
                    {h.after_json?.reason ? ` — ${h.after_json.reason}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="ep-panel" style={{ alignSelf: "start" }}>
          <div className="ep-panel-head">
            <div><div className="ep-panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><Bell size={15} /> Reminders</div>
              <div className="ep-panel-sub">{d.reminder_days?.length ? "Custom for this contract" : "Using the default"}: {daysLabel(effectiveDays)}</div></div>
          </div>
          <div className="ep-panel-body" style={{ fontSize: 13 }}>
            {nextReminders.length > 0 && (
              <>
                <div style={{ fontWeight: 700, fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Coming up</div>
                {nextReminders.map((r) => (
                  <div key={r.n} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                    <span>{fmtDate(r.on)}</span><span style={{ color: "var(--muted)" }}>{r.n === 0 ? "on the end date" : `${r.n} days before`}</span>
                  </div>
                ))}
              </>
            )}
            <div style={{ fontWeight: 700, fontSize: 12, color: "var(--muted)", margin: "12px 0 6px" }}>Sent</div>
            {d.reminders.filter((r) => r.status === "SENT").length === 0 ? <div style={{ color: "var(--muted)" }}>None yet.</div> : d.reminders.filter((r) => r.status === "SENT").map((r, i) => (
              <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span>{fmtDateTime(r.sent_at)}</span><span style={{ color: "var(--muted)" }}>{r.days_before === 0 ? "end date" : `${r.days_before} days before`}</span></div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>HR: {r.recipients.join(", ")}</div>
                {r.employee_notified_to && <div style={{ fontSize: 12, color: "var(--muted)" }}>Employee: {r.employee_notified_to}</div>}
              </div>
            ))}
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>
              {employeeReminded
                ? (d.person_email ? `HR and the employee (${d.person_email}) are both reminded.` : "HR is reminded. The employee would be too, but has no email on this contract.")
                : "Only HR is reminded — the employee isn't emailed."}
            </div>
          </div>
        </div>
      </div>

      {d.status === "ACTIVE" && (
        <div style={{ marginTop: 16 }}>
          <button onClick={() => void remove()} style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}><Trash2 size={13} /> Delete this contract (captured by mistake)</button>
        </div>
      )}

      {modal === "edit" && <ContractModal users={users} existing={d} defaultDays={defaultDays} remindEmployeeDefault={remindEmployeeDefault} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === "renew" && <RenewModal c={d} onClose={() => setModal(null)} onDone={(newId) => { setModal(null); onOpen(newId); }} />}
      {modal === "close" && <CloseModal c={d} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
    </>
  );
}

// ── Page ────────────────────────────────────────────────────────────────
type Tab = "NEEDED" | "ACTIVE" | "EXPIRING" | "EXPIRED" | "CLOSED";

function SuggestionsPanel({ items, onComplete, onChanged }: { items: Suggestion[]; onComplete: (s: Suggestion) => void; onChanged: () => void }) {
  const [showDismissed, setShowDismissed] = useState(false);
  const open = items.filter((s) => !s.dismissed);
  const dismissed = items.filter((s) => s.dismissed);
  const shown = showDismissed ? dismissed : open;
  async function dismiss(s: Suggestion) {
    const reason = prompt(`Why doesn't ${s.full_name || s.email} need a contract here? (optional)`);
    if (reason === null) return;
    await api.dismissEmployeeContractSuggestion(s.id, reason || null).catch((e: any) => alert(e?.message || "Failed"));
    onChanged();
  }
  async function restore(s: Suggestion) {
    await api.undismissEmployeeContractSuggestion(s.id).catch((e: any) => alert(e?.message || "Failed"));
    onChanged();
  }
  return (
    <div className="ep-panel">
      <div className="ep-panel-head">
        <div>
          <div className="ep-panel-title">Needs a contract</div>
          <div className="ep-panel-sub">Interns and temporary staff (from their FlowDesk profile) with no active contract. Complete a contract — the details are filled in for you.</div>
        </div>
        {dismissed.length > 0 && (
          <button className="ep-btn-outline" style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }} onClick={() => setShowDismissed(!showDismissed)}>
            {showDismissed ? "Back to suggestions" : `Marked not needed (${dismissed.length})`}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <FinanceEmptyState icon={CheckCircle2} title={showDismissed ? "Nobody is marked as not needing a contract." : "Everyone has a contract."} hint={showDismissed ? undefined : "Interns and temporary staff appear here when they don't have an active contract."} />
      ) : (
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Employee</th><th>Type</th><th>Position</th><th>Department</th><th>Supervisor</th><th>{showDismissed ? "Marked not needed" : "Last contract"}</th><th></th></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td><div style={{ fontWeight: 600 }}>{s.full_name || s.email}</div><div style={{ fontSize: 12, color: "var(--muted)" }}>{s.employee_no || s.email}</div></td>
                  <td>{TYPE_LABEL[s.employment_type] || s.employment_type}</td>
                  <td>{s.title || "—"}</td>
                  <td>{s.department || "—"}</td>
                  <td>{s.supervisor_name || "—"}</td>
                  <td style={{ fontSize: 12.5 }}>
                    {showDismissed
                      ? <>{s.dismissed_by_name || "—"}, {fmtDate(s.dismissed_at)}{s.dismissed_reason ? <div style={{ color: "var(--muted)" }}>{s.dismissed_reason}</div> : null}</>
                      : s.last_contract_no ? <>{s.last_contract_no} — {s.last_status === "RENEWED" ? "renewed" : "ended"} {fmtDate(s.last_end_date)}</> : <span style={{ color: "var(--muted)" }}>None yet</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    {showDismissed ? (
                      <button className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => void restore(s)}>Suggest again</button>
                    ) : (
                      <>
                        <button className="ep-btn" style={{ fontSize: 12, padding: "5px 10px", display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => onComplete(s)}><UserPlus size={13} /> Complete contract</button>
                        <button onClick={() => void dismiss(s)} style={{ border: "none", background: "transparent", color: "var(--muted)", cursor: "pointer", fontSize: 12, marginLeft: 8 }}>Not needed</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function EmployeeContracts() {
  const [items, setItems] = useState<Contract[]>([]);
  const [defaultDays, setDefaultDays] = useState<number[]>([30, 7]);
  const [remindEmployeeDefault, setRemindEmployeeDefault] = useState(false);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [completing, setCompleting] = useState<Suggestion | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  function loadSuggestions() {
    api.employeeContractSuggestions().then((r: any) => setSuggestions(r.items || [])).catch(() => setSuggestions([]));
  }
  function load() {
    setLoading(true);
    loadSuggestions();
    setError(null);
    api.employeeContracts()
      .then((r: any) => { setItems(r.items || []); setDefaultDays(r.reminder_days || [30, 7]); setRemindEmployeeDefault(!!r.remind_employee); })
      .catch((e: any) => setError(e?.message || "Failed to load contracts"))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    load();
    api.companyDirectory().then((r: any) => setUsers(Array.isArray(r) ? r : r?.items || [])).catch(() => setUsers([]));
  }, []);
  useEffect(() => { if (!openId) load(); }, [openId]);

  // "Expiring soon" uses the furthest reminder lead time, so it lines up
  // with when HR starts getting emails.
  const windowDays = Math.max(30, ...defaultDays);
  const neededCount = suggestions.filter((s) => !s.dismissed).length;
  // Open on "Needs a contract" the first time there's anyone to do.
  const [tabChosen, setTabChosen] = useState(false);
  useEffect(() => { if (!tabChosen && neededCount > 0) { setTab("NEEDED"); setTabChosen(true); } }, [neededCount, tabChosen]);
  const counts = useMemo(() => {
    const c = { ACTIVE: 0, EXPIRING: 0, EXPIRED: 0, CLOSED: 0, interns: 0, temps: 0 };
    for (const x of items) {
      const s = displayStatus(x, windowDays);
      if (x.status === "ACTIVE") {
        c.ACTIVE++;
        if (x.contract_type === "INTERN") c.interns++; else c.temps++;
      } else c.CLOSED++;
      if (s === "EXPIRING") c.EXPIRING++;
      if (s === "EXPIRED") c.EXPIRED++;
    }
    return c;
  }, [items, windowDays]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((x) => {
      const s = displayStatus(x, windowDays);
      if (tab === "ACTIVE" && x.status !== "ACTIVE") return false;
      if (tab === "EXPIRING" && s !== "EXPIRING") return false;
      if (tab === "EXPIRED" && s !== "EXPIRED") return false;
      if (tab === "CLOSED" && x.status === "ACTIVE") return false;
      if (typeFilter !== "ALL" && x.contract_type !== typeFilter) return false;
      if (q && ![x.person_name, x.contract_no, x.position, x.department, x.supervisor_name].some((v) => (v || "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, tab, search, typeFilter, windowDays]);

  return (
    <div className="ep-page">
      <FinancePageHeader
        icon={FileSignature}
        title="Employee Contracts"
        subtitle="Intern and temporary employee contracts, with expiry reminders to HR."
        actions={!openId && (
          <>
            <button className="ep-btn-outline" onClick={() => setShowSettings(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Settings2 size={14} /> Reminder settings</button>
            <button className="ep-btn" onClick={() => setShowNew(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Plus size={14} /> New contract</button>
          </>
        )}
      />

      {openId ? (
        <ContractDetail id={openId} users={users} defaultDays={defaultDays} remindEmployeeDefault={remindEmployeeDefault} windowDays={windowDays} onBack={() => setOpenId(null)} onOpen={setOpenId} />
      ) : (
        <>
          <FinanceKpiRow>
            <FinanceKpiTile icon={UserPlus} value={neededCount} label="Need a contract" sub="Interns & temps without one" tint="#e0f2fe" color="#0369a1" />
            <FinanceKpiTile icon={Users} value={counts.ACTIVE} label="Active contracts" sub={`${counts.interns} intern${counts.interns === 1 ? "" : "s"} · ${counts.temps} temporary`} tint="#dbeafe" color="#1d4ed8" />
            <FinanceKpiTile icon={Clock} value={counts.EXPIRING} label="Expiring soon" sub={`Within ${windowDays} days`} tint="#fef3c7" color="#b45309" />
            <FinanceKpiTile icon={AlertTriangle} value={counts.EXPIRED} label="Expired — action needed" sub="Not renewed or closed" tint="#fee2e2" color="#b91c1c" />
            <FinanceKpiTile icon={Bell} value={defaultDays.join(" / ")} label="Reminder days" sub={remindEmployeeDefault ? "Before the end date, to HR & employee" : "Before the end date, to HR"} tint="#ede9fe" color="#6d28d9" />
          </FinanceKpiRow>

          <IconTabRow<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "NEEDED", label: "Needs a contract", count: neededCount, icon: UserPlus },
              { key: "ACTIVE", label: "Active", count: counts.ACTIVE, icon: CheckCircle2 },
              { key: "EXPIRING", label: "Expiring soon", count: counts.EXPIRING, icon: Clock },
              { key: "EXPIRED", label: "Expired", count: counts.EXPIRED, icon: AlertTriangle },
              { key: "CLOSED", label: "Renewed & ended", count: counts.CLOSED, icon: FolderSearch }
            ]}
          />

          {tab === "NEEDED" ? (
            <SuggestionsPanel items={suggestions} onComplete={setCompleting} onChanged={loadSuggestions} />
          ) : (<>
          <FinanceFilterBar>
            <SearchField label="Search" placeholder="Name, contract no., position, department…" value={search} onChange={setSearch} />
            <SelectField label="Type" value={typeFilter} onChange={setTypeFilter} options={[{ value: "ALL", label: "All types" }, { value: "INTERN", label: "Interns" }, { value: "TEMPORARY", label: "Temporary" }]} />
          </FinanceFilterBar>

          {error && <div style={{ color: "#b91c1c", marginBottom: 12 }}>{error}</div>}
          <div className="ep-panel">
            {loading ? <div className="ep-loading"><p>Loading contracts…</p></div> : shown.length === 0 ? (
              <FinanceEmptyState icon={GraduationCap} title={items.length ? "Nothing in this view." : "No contracts yet."} hint={items.length ? undefined : "Add an intern or temporary employee's contract with New contract."} />
            ) : (
              <div className="ep-table-wrap">
                <table className="ep-table">
                  <thead><tr><th>Employee</th><th>Type</th><th>Position</th><th>Department</th><th>Start</th><th>End</th><th>Days left</th><th>Status</th></tr></thead>
                  <tbody>
                    {shown.map((x) => (
                      <tr key={x.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(x.id)}>
                        <td><div style={{ fontWeight: 600 }}>{x.person_name}</div><div style={{ fontSize: 12, color: "var(--muted)" }}>{x.contract_no}</div></td>
                        <td>{TYPE_LABEL[x.contract_type]}</td>
                        <td>{x.position || "—"}</td>
                        <td>{x.department || "—"}</td>
                        <td>{fmtDate(x.start_date)}</td>
                        <td>{fmtDate(x.end_date)}</td>
                        <td><DaysLeft c={x} /></td>
                        <td><StatusBadge status={displayStatus(x, windowDays)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          </>)}
        </>
      )}

      {showNew && <ContractModal users={users} existing={null} defaultDays={defaultDays} remindEmployeeDefault={remindEmployeeDefault} onClose={() => setShowNew(false)} onSaved={(id) => { setShowNew(false); setOpenId(id); }} />}
      {completing && <ContractModal users={users} existing={null} prefill={completing} defaultDays={defaultDays} remindEmployeeDefault={remindEmployeeDefault} onClose={() => setCompleting(null)} onSaved={(id) => { setCompleting(null); loadSuggestions(); setOpenId(id); }} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} onSaved={load} />}
    </div>
  );
}
