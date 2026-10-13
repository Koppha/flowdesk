import { useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import { api } from "./api";
import { formatMoney } from "./constants";
import {
  LayoutDashboard, ClipboardList, CalendarCheck, Wallet, History as HistoryIcon,
  ChevronLeft, Hourglass, CheckCircle2, FolderSearch, Users, Clock, Banknote, Download, Lock, Unlock
} from "lucide-react";
import {
  FinanceFilterBar, FilterField, SearchField, SelectField, FinanceEmptyState,
  FinanceKpiRow, FinanceKpiTile, FinancePageHeader
} from "./components/FinanceQueueKit";

// Salaries has five sidebar entries (Dashboard/Salary Registers/Attendance/
// Ready for Payment/History) that are really views over the same two data
// sources - already-submitted Attendance Register custom requests (grouped
// into "Salary Registers") and approved Salary Advance requests - so
// they're all implemented here as one component's internal views rather
// than five separate page components, the way Standby.tsx/Overtime.tsx
// already manage their own multi-screen flows. App.tsx remounts this with
// a different `initialView` (via a `key`) per sidebar link so each still
// gets its own nav highlight and its own browser-visible "page".
export type SalariesView = "dashboard" | "registers" | "attendance" | "ready" | "history";

type RegisterRow = {
  division: string | null;
  department: string | null;
  period: string;
  employee_count: number;
  submitted_count: number;
  paid_count: number;
  attendance_complete_pct: number;
  status: "IN_PROGRESS" | "READY_FOR_PAYMENT" | "PAID";
};

type ReadyItem = {
  submission_id: string | null;
  advance_request_id: string | null;
  item_type: "REGISTER" | "ADVANCE";
  employee_name: string | null;
  employee_no: string | null;
  division: string | null;
  department: string | null;
  period: string | null;
  approved_total?: string | number;
  currency?: string;
  converted_hours?: number | null;
};

type HistoryItem = {
  id: string;
  submission_id: string | null;
  advance_request_id: string | null;
  item_type: "REGISTER" | "ADVANCE";
  employee_name: string | null;
  employee_no: string | null;
  division: string | null;
  department: string | null;
  period: string | null;
  converted_hours: number | null;
  payment_reference: string;
  payment_date: string;
  comment: string | null;
  paid_at: string;
  paid_by_name: string | null;
};

const REGISTER_STATUS_LABEL: Record<string, string> = { IN_PROGRESS: "In Progress", READY_FOR_PAYMENT: "Ready for Payment", PAID: "Paid" };
const REGISTER_STATUS_STYLE: Record<string, [string, string]> = {
  IN_PROGRESS: ["#fef3c7", "#92400e"],
  READY_FOR_PAYMENT: ["#dbeafe", "#1e40af"],
  PAID: ["#d1fae5", "#065f46"]
};

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
// A Salary Advance has a real approved money amount; a Salary Register never
// does (see the backend's convertedHoursFor) - Converted Hours is what's
// actually being "paid out" for those, the same figure History already shows.
function readyAmountLabel(it: ReadyItem): string {
  return it.item_type === "ADVANCE"
    ? formatMoney(it.approved_total, it.currency)
    : `${it.converted_hours ?? 0} hrs`;
}

function fmtPeriod(s: string | null | undefined) {
  if (!s) return "—";
  const [y, m] = s.split("-");
  if (!m) return s;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

// Every list screen's "report" is a plain CSV export of what's on screen -
// the same pattern Compensation Claims already uses, rather than a separate
// Reports module (nothing else in Salaries needs a different shape of
// report yet - this can grow into a dedicated Reports screen later if a
// specific breakdown is asked for).
function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const el = document.createElement("a");
  el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  el.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  el.click();
}

function ExportButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return <button className="ep-btn-outline" onClick={onClick} disabled={disabled}><Download size={14} /> Export</button>;
}

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = REGISTER_STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{REGISTER_STATUS_LABEL[status] || status}</span>;
}

// Confirmed via Swal, capturing Payment Reference / Payment Date / optional
// Comments — the one shape every "mark as paid" action in Salaries uses,
// whether it's a Salary Register row or an approved Salary Advance.
async function promptForPayment(title: string): Promise<{ payment_reference: string; payment_date: string; comment?: string } | null> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await Swal.fire({
    title,
    html: `
      <div style="text-align:left;display:flex;flex-direction:column;gap:10px;">
        <label style="font-size:13px;font-weight:600;">Payment Reference
          <input id="swal-pay-ref" class="swal2-input" style="margin:4px 0 0;width:100%;box-sizing:border-box;" placeholder="e.g. PAY-2026-0123" />
        </label>
        <label style="font-size:13px;font-weight:600;">Payment Date
          <input id="swal-pay-date" type="date" class="swal2-input" style="margin:4px 0 0;width:100%;box-sizing:border-box;" value="${today}" />
        </label>
        <label style="font-size:13px;font-weight:600;">Comments (optional)
          <textarea id="swal-pay-comment" class="swal2-textarea" style="margin:4px 0 0;width:100%;box-sizing:border-box;" rows="2"></textarea>
        </label>
      </div>`,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: "Mark as Paid",
    preConfirm: () => {
      const ref = (document.getElementById("swal-pay-ref") as HTMLInputElement)?.value.trim();
      const date = (document.getElementById("swal-pay-date") as HTMLInputElement)?.value;
      const comment = (document.getElementById("swal-pay-comment") as HTMLTextAreaElement)?.value.trim();
      if (!ref) { Swal.showValidationMessage("Payment reference is required"); return false; }
      if (!date) { Swal.showValidationMessage("Payment date is required"); return false; }
      return { payment_reference: ref, payment_date: date, comment: comment || undefined };
    }
  });
  return result.isConfirmed ? (result.value as any) : null;
}

type Screen =
  | { type: "list" }
  | { type: "register-detail"; division: string; department: string; period: string }
  | { type: "record"; submissionId: string };

export default function Salaries({ initialView }: { initialView: SalariesView }) {
  const [screen, setScreen] = useState<Screen>({ type: "list" });

  if (screen.type === "register-detail") {
    return (
      <div className="ep-page">
        <RegisterDetailScreen
          division={screen.division}
          department={screen.department}
          period={screen.period}
          onBack={() => setScreen({ type: "list" })}
          onOpenRecord={(submissionId) => setScreen({ type: "record", submissionId })}
        />
      </div>
    );
  }

  if (screen.type === "record") {
    return (
      <div className="ep-page">
        <SalaryRecordScreen submissionId={screen.submissionId} onBack={() => setScreen({ type: "list" })} />
      </div>
    );
  }

  return (
    <div className="ep-page">
      <SalariesListView view={initialView} onOpenRegister={(division, department, period) => setScreen({ type: "register-detail", division, department, period })} />
    </div>
  );
}

function SalariesListView({ view, onOpenRegister }: { view: SalariesView; onOpenRegister: (division: string, department: string, period: string) => void }) {
  switch (view) {
    case "dashboard": return <SalariesDashboard />;
    case "registers": return <SalaryRegisters mode="registers" onOpenRegister={onOpenRegister} />;
    case "attendance": return <SalaryRegisters mode="attendance" onOpenRegister={onOpenRegister} />;
    case "ready": return <SalariesReadyForPayment />;
    case "history": return <SalariesHistory />;
  }
}

// ── Dashboard ───────────────────────────────────────────────────────────

function SalariesDashboard() {
  const [registers, setRegisters] = useState<RegisterRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.salaryRegisters().then((r: any) => setRegisters(r.items || [])).finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => ({
    total: registers.length,
    inProgress: registers.filter((r) => r.status === "IN_PROGRESS").length,
    ready: registers.filter((r) => r.status === "READY_FOR_PAYMENT").length,
    paid: registers.filter((r) => r.status === "PAID").length
  }), [registers]);

  if (loading) return <div className="ep-page"><p>Loading…</p></div>;

  return (
    <>
      <FinancePageHeader icon={Banknote} title="Salaries" subtitle="Manage salary registers, review attendance and process payments." />
      <FinanceKpiRow>
        <FinanceKpiTile icon={ClipboardList} value={stats.total} label="Total Registers" tint="#dbeafe" color="#1e40af" />
        <FinanceKpiTile icon={Hourglass} value={stats.inProgress} label="In Progress" tint="#fef3c7" color="#92400e" />
        <FinanceKpiTile icon={CheckCircle2} value={stats.ready} label="Ready for Payment" tint="#d1fae5" color="#065f46" />
        <FinanceKpiTile icon={Wallet} value={stats.paid} label="Paid" tint="#ede9fe" color="#5b21b6" />
      </FinanceKpiRow>
      {registers.length === 0 ? (
        <FinanceEmptyState icon={FolderSearch} title="No salary registers yet." hint="Registers appear here once employees submit their Attendance Register for the month." />
      ) : (
        <div className="ep-panel">
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Period</th><th>Division</th><th>Department</th><th>Employees</th><th>Attendance</th><th>Status</th></tr></thead>
              <tbody>
                {registers.slice(0, 10).map((r, i) => (
                  <tr key={i}>
                    <td>{fmtPeriod(r.period)}</td>
                    <td>{r.division || "—"}</td>
                    <td>{r.department || "—"}</td>
                    <td>{r.employee_count}</td>
                    <td>{r.attendance_complete_pct}%</td>
                    <td><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <AttendancePeriodsPanel />
      <SalaryAdvanceSettingsPanel />
    </>
  );
}

// When a Salary Advance for the CURRENT calendar month opens for
// applications (e.g. 5 - "you can apply for September after the 5th of
// September"). A past or future month is never gated by this - only a
// request whose own Salary Month is the current month.
function SalaryAdvanceSettingsPanel() {
  const [openDay, setOpenDay] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.salariesSettings().then((r: any) => setOpenDay(r.application_open_day ?? 1)).catch(() => setOpenDay(1));
  }, []);

  async function save() {
    if (openDay == null) return;
    setSaving(true);
    try {
      await api.updateSalariesSettings({ application_open_day: openDay });
      await Swal.fire({ icon: "success", title: "Settings saved", timer: 1400, showConfirmButton: false });
    } catch (err: any) {
      await Swal.fire({ icon: "error", title: "Could not save settings", text: err?.message || "" });
    } finally {
      setSaving(false);
    }
  }

  if (openDay == null) return null;

  return (
    <div className="ep-panel" style={{ marginTop: 16 }}>
      <div className="ep-panel-head">
        <div className="ep-panel-title">Salary Advance Settings</div>
        <div className="ep-panel-sub">Controls when employees can apply for a Salary Advance covering the current month.</div>
      </div>
      <div className="ep-panel-body" style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Opens on day of the month
          <input
            type="number" min={1} max={28} value={openDay}
            onChange={(e) => setOpenDay(Number(e.target.value))}
            style={{ width: 140 }}
          />
        </label>
        <button className="button button-primary" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save Settings"}
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--muted)", padding: "0 16px 12px" }}>
        E.g. 5 means an employee can't request a Salary Advance for September until the 5th of September — applying for a different month (past or future) is never affected by this. Set to 1 for no restriction.
      </p>
    </div>
  );
}

// Attendance Register months are open by default (employees can log/submit
// as they go, see attendance.routes.ts) - an admin can explicitly close one
// once payroll processing starts, blocking further drafts/submissions for
// it. No row from GET /attendance/periods for a given month means it's
// open, so unlike Overtime's ClaimPeriodsPanel (opt-in: closed until
// opened), every listed month starts Open here and nothing changes for
// anyone until Close is actually clicked.
function AttendancePeriodsPanel() {
  const [periods, setPeriods] = useState<{ period: string; locked: boolean; closed_at: string | null; closed_by_name: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyPeriod, setBusyPeriod] = useState<string | null>(null);

  function load() {
    setLoading(true);
    api.attendancePeriods().then((r: any) => setPeriods(r.items || [])).finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function close(period: string) {
    const confirm = await Swal.fire({
      title: `Close ${fmtPeriod(period)}?`,
      text: "Employees will no longer be able to log or submit an Attendance Register for this month.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Close Month"
    });
    if (!confirm.isConfirmed) return;
    setBusyPeriod(period);
    try {
      await api.closeAttendancePeriod(period);
      load();
    } finally {
      setBusyPeriod(null);
    }
  }

  async function reopen(period: string) {
    setBusyPeriod(period);
    try {
      await api.reopenAttendancePeriod(period);
      load();
    } finally {
      setBusyPeriod(null);
    }
  }

  return (
    <div className="ep-panel" style={{ marginTop: 16 }}>
      <div className="ep-panel-head">
        <div className="ep-panel-title">Attendance Periods</div>
        <div className="ep-panel-sub">Months are open for logging by default — close one once payroll processing starts.</div>
      </div>
      <div className="ep-panel-body">
        {loading ? <p>Loading…</p> : (
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Period</th><th>Status</th><th>Closed By</th><th></th></tr></thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.period}>
                    <td>{fmtPeriod(p.period)}</td>
                    <td>
                      {p.locked
                        ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "#991b1b" }}><Lock size={13} /> Closed</span>
                        : <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "#065f46" }}><Unlock size={13} /> Open</span>}
                    </td>
                    <td>{p.closed_by_name || "—"}</td>
                    <td>
                      {p.locked ? (
                        <button className="ep-btn-outline" disabled={busyPeriod === p.period} onClick={() => void reopen(p.period)}>Reopen</button>
                      ) : (
                        <button className="ep-btn-outline" disabled={busyPeriod === p.period} onClick={() => void close(p.period)}>Close</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Salary Registers / Attendance (same data, "attendance" mode drops the
// payment-status framing since it's a browsing/reporting view) ───────────

function SalaryRegisters({ mode, onOpenRegister }: { mode: "registers" | "attendance"; onOpenRegister: (division: string, department: string, period: string) => void }) {
  const [items, setItems] = useState<RegisterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"ALL" | "IN_PROGRESS" | "READY_FOR_PAYMENT" | "PAID">("ALL");
  const [divisionFilter, setDivisionFilter] = useState("ALL");
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [periodFilter, setPeriodFilter] = useState("ALL");

  useEffect(() => {
    api.salaryRegisters().then((r: any) => setItems(r.items || [])).catch((e: any) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const divisionOptions = useMemo(() => [{ value: "ALL", label: "All Divisions" }, ...Array.from(new Set(items.map((i) => i.division).filter(Boolean) as string[])).sort().map((d) => ({ value: d, label: d }))], [items]);
  const departmentOptions = useMemo(() => [{ value: "ALL", label: "All Departments" }, ...Array.from(new Set(items.map((i) => i.department).filter(Boolean) as string[])).sort().map((d) => ({ value: d, label: d }))], [items]);
  const periodOptions = useMemo(() => [{ value: "ALL", label: "All Periods" }, ...Array.from(new Set(items.map((i) => i.period))).sort().reverse().map((p) => ({ value: p, label: fmtPeriod(p) }))], [items]);

  const filtered = useMemo(() => items.filter((r) => {
    if (mode === "registers" && statusFilter !== "ALL" && r.status !== statusFilter) return false;
    if (divisionFilter !== "ALL" && r.division !== divisionFilter) return false;
    if (departmentFilter !== "ALL" && r.department !== departmentFilter) return false;
    if (periodFilter !== "ALL" && r.period !== periodFilter) return false;
    return true;
  }), [items, mode, statusFilter, divisionFilter, departmentFilter, periodFilter]);

  const counts = useMemo(() => ({
    all: items.length,
    inProgress: items.filter((i) => i.status === "IN_PROGRESS").length,
    ready: items.filter((i) => i.status === "READY_FOR_PAYMENT").length,
    paid: items.filter((i) => i.status === "PAID").length
  }), [items]);

  if (loading) return <p>Loading…</p>;

  return (
    <>
      <FinancePageHeader
        icon={mode === "attendance" ? CalendarCheck : ClipboardList}
        title={mode === "attendance" ? "Attendance" : "Salary Registers"}
        subtitle={mode === "attendance"
          ? "Browse submitted Attendance Registers by division, department and month."
          : "Manage salary registers, review attendance and process payments."}
        actions={
          <ExportButton
            disabled={!filtered.length}
            onClick={() => downloadCsv(mode === "attendance" ? "attendance" : "salary-registers",
              ["Period", "Division", "Department", "Employees", "Submitted", "Attendance Complete %", "Status"],
              filtered.map((r) => [fmtPeriod(r.period), r.division || "", r.department || "", r.employee_count, r.submitted_count, r.attendance_complete_pct, REGISTER_STATUS_LABEL[r.status] || r.status])
            )}
          />
        }
      />
      {error && <pre className="inbox-error">{error}</pre>}

      {mode === "registers" && (
        <FinanceKpiRow>
          <FinanceKpiTile icon={ClipboardList} value={counts.all} label="Total Registers" tint="#dbeafe" color="#1e40af" />
          <FinanceKpiTile icon={Hourglass} value={counts.inProgress} label="In Progress" tint="#fef3c7" color="#92400e" />
          <FinanceKpiTile icon={CheckCircle2} value={counts.ready} label="Ready for Payment" tint="#d1fae5" color="#065f46" />
          <FinanceKpiTile icon={Wallet} value={counts.paid} label="Paid" tint="#ede9fe" color="#5b21b6" />
        </FinanceKpiRow>
      )}

      <FinanceFilterBar
        showReset={divisionFilter !== "ALL" || departmentFilter !== "ALL" || periodFilter !== "ALL" || statusFilter !== "ALL"}
        onReset={() => { setDivisionFilter("ALL"); setDepartmentFilter("ALL"); setPeriodFilter("ALL"); setStatusFilter("ALL"); }}
      >
        <SelectField label="Division" value={divisionFilter} onChange={setDivisionFilter} options={divisionOptions} />
        <SelectField label="Department" value={departmentFilter} onChange={setDepartmentFilter} options={departmentOptions} />
        <SelectField label="Period" value={periodFilter} onChange={setPeriodFilter} options={periodOptions} />
        {mode === "registers" && (
          <SelectField
            label="Status"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
            options={[{ value: "ALL", label: "All Registers" }, { value: "IN_PROGRESS", label: "In Progress" }, { value: "READY_FOR_PAYMENT", label: "Ready for Payment" }, { value: "PAID", label: "Paid" }]}
          />
        )}
      </FinanceFilterBar>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {filtered.length === 0 ? (
            <FinanceEmptyState icon={FolderSearch} title="No registers match your filters." />
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>#</th><th>Register Name</th><th>Period</th><th>Division</th><th>Department</th>
                  <th>Employees</th><th>Attendance Complete</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={i} style={{ cursor: "pointer" }} onClick={() => onOpenRegister(r.division || "", r.department || "", r.period)}>
                    <td>{i + 1}</td>
                    <td style={{ fontWeight: 600 }}>{fmtPeriod(r.period)} — {r.department || r.division || "—"}</td>
                    <td>{fmtPeriod(r.period)}</td>
                    <td>{r.division || "—"}</td>
                    <td>{r.department || "—"}</td>
                    <td>{r.employee_count}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--surface-soft,#f1f5f9)", overflow: "hidden", minWidth: 60 }}>
                          <div style={{ width: `${r.attendance_complete_pct}%`, height: "100%", background: r.attendance_complete_pct === 100 ? "#22c55e" : "#3b82f6" }} />
                        </div>
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>{r.submitted_count}/{r.employee_count} ({r.attendance_complete_pct}%)</span>
                      </div>
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    <td><button className="ep-btn-outline" onClick={(e) => { e.stopPropagation(); onOpenRegister(r.division || "", r.department || "", r.period); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

// ── Register Detail: employee list within one division/department/period ──

function RegisterDetailScreen({ division, department, period, onBack, onOpenRecord }: {
  division: string; department: string; period: string; onBack: () => void; onOpenRecord: (submissionId: string) => void;
}) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.salaryRegisterDetail(division, department, period).then((r: any) => setItems(r.items || [])).catch((e: any) => setError(e.message)).finally(() => setLoading(false));
  }, [division, department, period]);

  return (
    <>
      <button className="button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={14} aria-hidden /> Back to Salary Registers</button>
      <FinancePageHeader icon={ClipboardList} title={`${fmtPeriod(period)} — ${department || division}`} subtitle={`${division || "—"} · ${department || "—"}`} />
      {error && <pre className="inbox-error">{error}</pre>}
      {loading ? <p>Loading…</p> : items.length === 0 ? (
        <FinanceEmptyState icon={FolderSearch} title="No employees in this register." />
      ) : (
        <div className="ep-panel">
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Employee</th><th>Employee No.</th><th>Status</th><th>Regular Days</th><th>Submitted</th><th></th></tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.submission_id} style={{ cursor: "pointer" }} onClick={() => onOpenRecord(r.submission_id)}>
                    <td style={{ fontWeight: 600 }}>{r.employee_name}</td>
                    <td>{r.employee_no || "—"}</td>
                    <td>
                      {r.payment_id ? <StatusBadge status="PAID" /> : r.status === "APPROVED" ? <StatusBadge status="READY_FOR_PAYMENT" /> : <StatusBadge status="IN_PROGRESS" />}
                    </td>
                    <td>{r.totals?.regular ?? "—"}</td>
                    <td>{fmtDate(r.submitted_at)}</td>
                    <td><button className="ep-btn-outline" onClick={(e) => { e.stopPropagation(); onOpenRecord(r.submission_id); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ── Salary Record: one employee's attendance grid + Converted Hours + pay ──

const DAY_CODE_LABEL: Record<string, string> = {
  R: "Regular", C: "Time compensation", S: "Sick Leave", A: "Annual Leave",
  O: "Official Trip", H: "Holiday", E: "Emergency", T: "Study Leave / Training", X: "Other Absenteeism"
};
const DAY_CODE_COLOR: Record<string, string> = {
  R: "#dcfce7", C: "#e0e7ff", S: "#fce7f3", A: "#fef3c7", O: "#dbeafe", H: "#f3e8ff", E: "#fee2e2", T: "#e0f2fe", X: "#f1f5f9"
};

function SalaryRecordScreen({ submissionId, onBack }: { submissionId: string; onBack: () => void }) {
  const [record, setRecord] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function refresh() {
    setLoading(true);
    api.salaryRecord(submissionId).then(setRecord).catch((e: any) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(refresh, [submissionId]);

  async function markPaid() {
    const data = await promptForPayment("Mark Salary Record as Paid?");
    if (!data) return;
    setSaving(true);
    try {
      await api.paySalaryRecord(submissionId, data);
      refresh();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not record payment", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p>Loading…</p>;
  if (error || !record) return <pre className="inbox-error">{error || "Salary record not found"}</pre>;

  const daysInMonth = record.period ? new Date(Number(record.period.slice(0, 4)), Number(record.period.slice(5, 7)), 0).getDate() : 31;
  const cells: Record<string, string> = record.cells || {};

  return (
    <>
      <button className="button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={14} aria-hidden /> Back to Salary Requests</button>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, alignItems: "start" }}>
        <div>
          <div className="ep-panel" style={{ marginBottom: 16 }}>
            <div className="ep-panel-head">
              <div className="ep-panel-title">Salary Record</div>
              <div className="ep-panel-sub">Review attendance for the selected period.</div>
              {record.payment ? <StatusBadge status="PAID" /> : <StatusBadge status="READY_FOR_PAYMENT" />}
            </div>
            <div className="ep-panel-body" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
              <div><div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>Employee</div><div>{record.employee_name}</div></div>
              <div><div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>Employee No.</div><div>{record.employee_no || "—"}</div></div>
              <div><div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>Division</div><div>{record.division || "—"}</div></div>
              <div><div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>Department</div><div>{record.department || "—"}</div></div>
            </div>
          </div>

          <div className="ep-panel" style={{ marginBottom: 16 }}>
            <div className="ep-panel-head">
              <div className="ep-panel-title">Attendance Overview</div>
              <div className="ep-panel-sub">Daily attendance for {fmtPeriod(record.period)}</div>
            </div>
            <div className="ep-panel-body">
              <div className="ep-table-wrap">
                <table className="ep-table">
                  <thead><tr>{Array.from({ length: daysInMonth }, (_, i) => <th key={i} style={{ textAlign: "center", padding: "4px 6px" }}>{i + 1}</th>)}</tr></thead>
                  <tbody>
                    <tr>
                      {Array.from({ length: daysInMonth }, (_, i) => {
                        const code = cells[String(i + 1)];
                        return (
                          <td key={i} style={{ textAlign: "center", padding: "4px 6px", background: code ? DAY_CODE_COLOR[code] : undefined, fontWeight: 700, fontSize: 12 }}>
                            {code || "-"}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12, fontSize: 11.5, color: "var(--muted)" }}>
                {Object.entries(DAY_CODE_LABEL).map(([code, label]) => (
                  <span key={code}><strong style={{ color: "var(--text)" }}>{code}</strong> {label}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="ep-panel">
            <div className="ep-panel-head"><div className="ep-panel-title">Attendance Summary</div></div>
            <div className="ep-panel-body" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {["regular", "holiday", "annual", "official", "sick"].map((k) => (
                <div key={k} className="fin-kpi">
                  <div><div className="fin-kpi-value">{record.summary?.[k] ?? 0}</div><div className="fin-kpi-label">{k[0].toUpperCase() + k.slice(1)}</div></div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="ep-panel" style={{ marginBottom: 16 }}>
            <div className="ep-panel-head"><div className="ep-panel-title">Salary Summary</div></div>
            <div className="ep-panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div><div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>Converted Hours</div><div style={{ fontSize: 22, fontWeight: 800 }}>{record.converted_hours}</div></div>
              <div><div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>Status</div><div>{record.payment ? <StatusBadge status="PAID" /> : <StatusBadge status="READY_FOR_PAYMENT" />}</div></div>
            </div>
          </div>

          <div className="ep-panel">
            <div className="ep-panel-head"><div className="ep-panel-title">Payment Details</div></div>
            <div className="ep-panel-body">
              {record.payment ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                  <div><strong>Reference:</strong> {record.payment.payment_reference}</div>
                  <div><strong>Date:</strong> {fmtDate(record.payment.payment_date)}</div>
                  {record.payment.comment && <div><strong>Comments:</strong> {record.payment.comment}</div>}
                </div>
              ) : (
                <button className="ep-btn" style={{ width: "100%" }} disabled={saving || record.status !== "APPROVED"} onClick={() => void markPaid()}>
                  <Wallet size={14} /> Mark as Paid
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Ready for Payment / History ────────────────────────────────────────

function SalariesReadyForPayment() {
  const [items, setItems] = useState<ReadyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    setLoading(true);
    api.salariesReadyForPayment().then((r: any) => setItems(r.items || [])).catch((e: any) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(refresh, []);

  async function pay(item: ReadyItem) {
    const data = await promptForPayment(item.item_type === "ADVANCE" ? "Mark Salary Advance as Paid?" : "Mark Salary Record as Paid?");
    if (!data) return;
    try {
      if (item.item_type === "ADVANCE" && item.advance_request_id) await api.paySalaryAdvance(item.advance_request_id, data);
      else if (item.submission_id) await api.paySalaryRecord(item.submission_id, data);
      refresh();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not record payment", text: e.message });
    }
  }

  return (
    <>
      <FinancePageHeader
        icon={CheckCircle2}
        title="Ready for Payment"
        subtitle="Approved salary registers and salary advances awaiting payment."
        actions={
          <ExportButton
            disabled={!items.length}
            onClick={() => downloadCsv("salaries-ready-for-payment",
              ["Type", "Employee", "Employee No", "Division", "Department", "Period", "Amount"],
              items.map((it) => [it.item_type === "ADVANCE" ? "Salary Advance" : "Salary Register", it.employee_name || "", it.employee_no || "", it.division || "", it.department || "", fmtPeriod(it.period), readyAmountLabel(it)])
            )}
          />
        }
      />
      {error && <pre className="inbox-error">{error}</pre>}
      {loading ? <p>Loading…</p> : items.length === 0 ? (
        <FinanceEmptyState icon={FolderSearch} title="Nothing is waiting on payment." />
      ) : (
        <div className="ep-panel">
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Type</th><th>Employee</th><th>Employee No.</th><th>Division</th><th>Department</th><th>Period</th><th>Amount</th><th></th></tr></thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td>{it.item_type === "ADVANCE" ? "Salary Advance" : "Salary Register"}</td>
                    <td style={{ fontWeight: 600 }}>{it.employee_name}</td>
                    <td>{it.employee_no || "—"}</td>
                    <td>{it.division || "—"}</td>
                    <td>{it.department || "—"}</td>
                    <td>{fmtPeriod(it.period)}</td>
                    <td style={{ fontWeight: 600 }}>{readyAmountLabel(it)}</td>
                    <td><button className="ep-btn" onClick={() => void pay(it)}><Wallet size={14} /> Mark as Paid</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function SalariesHistory() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.salariesHistory().then((r: any) => setItems(r.items || [])).catch((e: any) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => items.filter((i) =>
    !search || (i.employee_name || "").toLowerCase().includes(search.toLowerCase()) || (i.payment_reference || "").toLowerCase().includes(search.toLowerCase())
  ), [items, search]);

  return (
    <>
      <FinancePageHeader
        icon={HistoryIcon}
        title="History"
        subtitle="Salary registers and salary advances that have been paid."
        actions={
          <ExportButton
            disabled={!filtered.length}
            onClick={() => downloadCsv("salaries-history",
              ["Type", "Employee", "Employee No", "Period", "Converted Hours", "Reference", "Paid On", "Paid By"],
              filtered.map((it) => [it.item_type === "ADVANCE" ? "Salary Advance" : "Salary Register", it.employee_name || "", it.employee_no || "", fmtPeriod(it.period), it.converted_hours ?? "", it.payment_reference, fmtDate(it.paid_at), it.paid_by_name || ""])
            )}
          />
        }
      />
      {error && <pre className="inbox-error">{error}</pre>}
      <FinanceFilterBar>
        <SearchField label="Search" placeholder="Search by employee or payment reference…" value={search} onChange={setSearch} />
      </FinanceFilterBar>
      {loading ? <p>Loading…</p> : filtered.length === 0 ? (
        <FinanceEmptyState icon={FolderSearch} title="No payments recorded yet." />
      ) : (
        <div className="ep-panel">
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Type</th><th>Employee</th><th>Period</th><th>Converted Hours</th><th>Reference</th><th>Paid On</th><th>Paid By</th></tr></thead>
              <tbody>
                {filtered.map((it) => (
                  <tr key={it.id}>
                    <td>{it.item_type === "ADVANCE" ? "Salary Advance" : "Salary Register"}</td>
                    <td style={{ fontWeight: 600 }}>{it.employee_name}</td>
                    <td>{fmtPeriod(it.period)}</td>
                    <td>{it.converted_hours ?? "—"}</td>
                    <td>{it.payment_reference}</td>
                    <td>{fmtDate(it.paid_at)}</td>
                    <td>{it.paid_by_name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
