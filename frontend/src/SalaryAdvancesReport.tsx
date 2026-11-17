import { GuidedTour } from "./shared/GuidedTour";
import { TOURS } from "./menu/menuTips";
import { Fragment, useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import { API, getToken } from "./api";
import { showNotice } from "./alerts";
import { formatMoney } from "./constants";
import {
  ArrowUpDown, Banknote, Building2, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, FolderSearch, Hourglass, Users, Wallet
} from "lucide-react";
import {
  BusinessUnitTabs, ColumnChooser, FilterField, FinanceEmptyState, FinanceFilterBar, FinanceKpiRow, FinanceKpiTile, FinancePageHeader, SearchField,
  type BusinessUnit, type ColumnOption, useColumnVisibility
} from "./components/FinanceQueueKit";

// Salary Advances report (Finance): every salary advance and its repayment
// plan - see GET /deductions/salary-advances. Deductions start the month
// AFTER the request (requested in November -> first deduction in December),
// one installment a month for the payback period.

// cancelled: after the employee paid it in full - not deducted.
type ScheduleRow = { month: string; amount: number; cancelled?: boolean };
interface SalaryAdvance {
  id: string;
  reference: string;
  employee_name: string | null;
  employee_no: string | null;
  email: string | null;
  division_name: string | null; // company (the tabs)
  org_division: string | null;
  department_name: string | null;
  status: string;
  purpose: string | null;
  payment_method: string | null;
  salary_month: string | null;
  requested_total: number;
  approved_total: number;
  amount: number;
  payback_months: number;
  installment: number;
  request_month: string;
  first_deduction: string;
  last_deduction: string;
  schedule: ScheduleRow[];
  this_month_installment: number;
  deducted_to_date: number;
  balance: number | null;
  repaid_directly: number | null;
  pending_repayments: { count: number; amount: number } | null;
  deduction_status: "NOT_STARTED" | "DEDUCTING" | "COMPLETED" | "PAID_IN_FULL" | null;
  paid_in_full_at: string | null;
  paid_in_full_reference: string | null;
  paid_in_full_note: string | null;
  paid_in_full_by: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  paid_at: string | null;
  paid_reference: string | null;
  waiting_with: string | null;
  currency: string;
}

const STATUS: Record<string, { label: string; bg: string; color: string }> = {
  PAID: { label: "Paid", bg: "#d1fae5", color: "#065f46" },
  APPROVED: { label: "Approved - awaiting payment", bg: "#dbeafe", color: "#1e40af" },
  SUBMITTED: { label: "In approval", bg: "#fef3c7", color: "#92400e" },
  COUNTERSIGNED: { label: "In approval", bg: "#fef3c7", color: "#92400e" },
  HR_OFFICER: { label: "In approval", bg: "#fef3c7", color: "#92400e" },
  REJECTED: { label: "Rejected", bg: "#fee2e2", color: "#991b1b" },
  CANCELLED: { label: "Cancelled", bg: "#f1f5f9", color: "#475569" }
};
const DEDUCTION: Record<string, string> = { NOT_STARTED: "Not started", DEDUCTING: "Deducting", COMPLETED: "Completed", PAID_IN_FULL: "Paid in full" };

// Status filter groups.
const STATUS_FILTERS: Array<{ value: string; label: string; match: (s: string) => boolean }> = [
  { value: "ALL", label: "All statuses", match: () => true },
  { value: "PAID", label: "Paid", match: (s) => s === "PAID" },
  { value: "IN_APPROVAL", label: "In approval / awaiting payment", match: (s) => ["SUBMITTED", "COUNTERSIGNED", "HR_OFFICER", "APPROVED"].includes(s) },
  { value: "REJECTED", label: "Rejected / cancelled", match: (s) => ["REJECTED", "CANCELLED"].includes(s) }
];

function monthLabel(ym: string | null | undefined) {
  if (!ym || !/^\d{4}-\d{2}/.test(ym)) return "—";
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}
function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
const money = (v: number | null | undefined) => (v == null ? "—" : formatMoney(v, "LSL"));

type SortKey = "name" | "empNo" | "division" | "department" | "reference" | "requested" | "amount" | "months" | "installment" | "first" | "last" | "submitted" | "approved" | "paid" | "deducted" | "balance" | "thisMonth" | "status";

const COLUMNS: ColumnOption[] = [
  { key: "name", label: "Name", locked: true },
  { key: "empNo", label: "Emp. No" },
  { key: "division", label: "Division" },
  { key: "department", label: "Department" },
  { key: "reference", label: "Reference" },
  { key: "salaryMonth", label: "Salary Month" },
  { key: "requested", label: "Requested" },
  { key: "amount", label: "Advance Amount" },
  { key: "months", label: "Duration (months)" },
  { key: "installment", label: "Installment / month" },
  { key: "first", label: "First Deduction" },
  { key: "last", label: "Last Deduction" },
  { key: "thisMonth", label: "Deduct this month" },
  { key: "deducted", label: "Deducted so far" },
  { key: "balance", label: "Balance" },
  { key: "repaid", label: "Paid in full (repaid directly)" },
  { key: "submitted", label: "Requested On" },
  { key: "approved", label: "Approved On" },
  { key: "paid", label: "Paid On" },
  { key: "paidRef", label: "Payment Reference" },
  { key: "paymentMethod", label: "Payment Method" },
  { key: "purpose", label: "Reason" },
  { key: "waiting", label: "Waiting With" },
  { key: "status", label: "Status" }
];
const DEFAULT_HIDDEN = ["reference", "salaryMonth", "requested", "approved", "paidRef", "paymentMethod", "purpose"];
const PAGE_SIZE_OPTIONS = [10, 25, 50];

// Repayments employees made themselves, waiting for review. Shown only to
// people with the Salary Advance Repayments permission (the list endpoint
// refuses everyone else). Accepting lowers the balance - the installment
// stays and the deductions end sooner; clearing the balance makes it paid in full.
type Repayment = {
  id: string; advance_id: string; advance_reference: string; amount: number; payment_date: string; reference: string; note: string | null;
  file_name: string | null; status: "SUBMITTED" | "ACCEPTED" | "REJECTED"; reject_reason: string | null; submitted_at: string;
  reviewed_at: string | null; reviewed_by: string | null; employee_name: string | null; employee_no: string | null; division_name: string | null;
};
function RepaymentsReview({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Repayment[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const token = getToken();
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  function load() {
    fetch(`${API}/salary-advances/repayments?status=SUBMITTED`, { headers: auth, cache: "no-store" })
      .then(async (r) => (r.ok ? setItems((await r.json()).items || []) : setItems(null)))
      .catch(() => setItems(null));
  }
  useEffect(load, []);
  async function act(r: Repayment, action: "accept" | "reject") {
    let body: string | undefined;
    if (action === "reject") {
      const res = await Swal.fire({
        title: "Reject this repayment?", input: "textarea", inputLabel: `Why? (sent to ${r.employee_name || "the employee"})`,
        inputPlaceholder: "e.g. The amount isn't on the bank statement", showCancelButton: true, confirmButtonText: "Reject",
        inputValidator: (v) => (v && v.trim().length >= 3 ? undefined : "Say why it's rejected")
      });
      if (!res.isConfirmed) return;
      body = JSON.stringify({ reason: String(res.value).trim() });
    } else {
      const ok = await Swal.fire({ title: `Accept ${money(r.amount)}?`, text: `From ${r.employee_name || "the employee"} for ${r.advance_reference}. The balance drops; the monthly deduction stays and ends sooner.`, showCancelButton: true, confirmButtonText: "Accept" });
      if (!ok.isConfirmed) return;
    }
    setBusy(r.id);
    try {
      const res = await fetch(`${API}/salary-advances/repayments/${r.id}/${action}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Could not save");
      void showNotice(action === "accept" ? (json.paid_in_full ? "Accepted - the salary advance is paid in full." : "Accepted - the balance and remaining deductions are updated.") : "Rejected - the employee has been told why.");
      load();
      onChanged();
    } catch (e: any) {
      void showNotice(e?.message || "Could not save");
    } finally {
      setBusy(null);
    }
  }
  async function proof(r: Repayment) {
    try {
      const res = await fetch(`${API}/salary-advances/repayments/${r.id}/file`, { headers: auth });
      if (!res.ok) throw new Error("Could not open the proof");
      window.open(URL.createObjectURL(await res.blob()), "_blank", "noopener");
    } catch (e: any) {
      void showNotice(e?.message || "Could not open the proof");
    }
  }
  if (!items || items.length === 0) return null;
  return (
    <div id="repayments-review" className="ep-panel" style={{ padding: "16px 20px", marginBottom: 14, borderLeft: "4px solid #f59e0b", scrollMarginTop: 80 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Repayments to review <span className="inbox-count-chip">{items.length}</span></div>
      <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 10px" }}>Employees repaying their salary advance themselves. Check the proof, then accept or reject.</p>
      <table className="ep-table">
        <thead><tr><th>Employee</th><th>Advance</th><th>Amount</th><th>Paid On</th><th>Reference</th><th>Proof</th><th /></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id} id={`repayment-${r.advance_id}`}>
              <td style={{ fontWeight: 600 }}>{r.employee_name || "—"}<div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>{[r.employee_no, r.division_name].filter(Boolean).join(" · ")}</div></td>
              <td style={{ fontSize: 13 }}>{r.advance_reference}</td>
              <td style={{ fontWeight: 700 }}>{money(r.amount)}</td>
              <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{fmtDate(r.payment_date)}</td>
              <td style={{ fontSize: 13 }}>{r.reference}{r.note ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.note}</div> : null}</td>
              <td><button type="button" className="ep-btn-outline" style={{ fontSize: 12, padding: "3px 10px" }} onClick={() => void proof(r)}>Open</button></td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button type="button" className="button button-primary small-button" disabled={busy === r.id} onClick={() => void act(r, "accept")}>Accept</button>{" "}
                <button type="button" className="ep-btn-outline" style={{ fontSize: 12, padding: "4px 10px" }} disabled={busy === r.id} onClick={() => void act(r, "reject")}>Reject</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SalaryAdvancesReport() {
  const [items, setItems] = useState<SalaryAdvance[]>([]);
  const [thisMonth, setThisMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Finance can record "paid in full" (see canRecordSalarySettlement).
  const [canSettle, setCanSettle] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [company, setCompany] = useState<BusinessUnit>("ALL");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  // A payroll month: only the advances deducting in it, with that month's installment.
  const [deductionMonth, setDeductionMonth] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("submitted");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const columns = useColumnVisibility("finance-columns:salary-advances", DEFAULT_HIDDEN);
  const show = columns.show;

  async function call(method: string, path: string, body?: unknown) {
    const token = getToken();
    const r = await fetch(`${API}/deductions/salary-advances${path}`, {
      method, cache: "no-store",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json?.error || `Request failed (${r.status})`);
    return json;
  }

  function load() {
    return call("GET", "")
      .then((body) => {
        setItems(body.items || []);
        setThisMonth(body.this_month || "");
        setCanSettle(Boolean(body.can_record_settlement));
      })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }
  useEffect(() => { void load(); }, []);

  async function markPaidInFull(i: SalaryAdvance) {
    const today = new Date().toISOString().slice(0, 10);
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
    const result = await Swal.fire({
      title: "Mark as paid in full?",
      html: `<div style="font-size:14px;text-align:left;margin-bottom:10px">${esc(i.employee_name || "The employee")} repaid the rest of ${esc(i.reference)} early - the remaining deductions (balance ${esc(money(i.balance))}) stop from the month it was repaid.</div>
        <label style="display:block;text-align:left;font-size:13px;margin:6px 0 2px">Date repaid</label>
        <input id="pif-date" type="date" class="swal2-input" style="margin:0;width:100%" value="${today}" max="${today}">
        <label style="display:block;text-align:left;font-size:13px;margin:10px 0 2px">Payment reference</label>
        <input id="pif-ref" class="swal2-input" style="margin:0;width:100%" placeholder="e.g. bank or EcoCash reference">
        <label style="display:block;text-align:left;font-size:13px;margin:10px 0 2px">Note (optional)</label>
        <input id="pif-note" class="swal2-input" style="margin:0;width:100%">`,
      showCancelButton: true,
      confirmButtonText: "Mark paid in full",
      focusConfirm: false,
      preConfirm: () => {
        const date = (document.getElementById("pif-date") as HTMLInputElement).value;
        const reference = (document.getElementById("pif-ref") as HTMLInputElement).value.trim();
        const note = (document.getElementById("pif-note") as HTMLInputElement).value.trim();
        if (!date) { Swal.showValidationMessage("Choose the date it was repaid"); return false; }
        if (!reference) { Swal.showValidationMessage("Enter the payment reference"); return false; }
        return { date, reference, note: note || undefined };
      }
    });
    if (!result.isConfirmed || !result.value) return;
    setBusyId(i.id);
    try {
      await call("POST", `/${i.id}/paid-in-full`, result.value);
      await load();
      void showNotice(`${i.employee_name || "The salary advance"} is marked paid in full - no more deductions.`);
    } catch (e: any) {
      void showNotice(e?.message || "Could not mark it paid in full");
    } finally {
      setBusyId(null);
    }
  }


  const inCompany = useMemo(() => items.filter((i) => company === "ALL" || i.division_name === company), [items, company]);

  const companyCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: items.length, MNO: 0, SEFS: 0, HigherLife: 0 };
    for (const i of items) if (i.division_name && i.division_name in counts) counts[i.division_name]++;
    return counts;
  }, [items]);

  // Every month any paid advance deducts in, for the payroll-month filter and the monthly totals.
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const i of inCompany) if (i.status === "PAID") for (const s of i.schedule) if (!s.cancelled) set.add(s.month);
    return [...set].sort();
  }, [inCompany]);

  // Installments after "paid in full" aren't deducted.
  const installmentIn = (i: SalaryAdvance, ym: string) => i.schedule.find((s) => s.month === ym && !s.cancelled)?.amount ?? 0;

  const filtered = useMemo(() => {
    const st = STATUS_FILTERS.find((f) => f.value === statusFilter) || STATUS_FILTERS[0];
    const q = search.trim().toLowerCase();
    return inCompany.filter((i) => {
      if (!st.match(i.status)) return false;
      if (deductionMonth && !(i.status === "PAID" && installmentIn(i, deductionMonth) > 0)) return false;
      if (q && ![i.employee_name, i.employee_no, i.org_division, i.department_name, i.reference, i.purpose].some((v) => (v || "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [inCompany, statusFilter, deductionMonth, search]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const str = (a: string | null | undefined, b: string | null | undefined) => (a || "").localeCompare(b || "") * dir;
    const num = (a: number | null | undefined, b: number | null | undefined) => ((a ?? -1) - (b ?? -1)) * dir;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "name": return str(a.employee_name, b.employee_name);
        case "empNo": return str(a.employee_no, b.employee_no);
        case "division": return str(a.org_division, b.org_division);
        case "department": return str(a.department_name, b.department_name);
        case "reference": return str(a.reference, b.reference);
        case "requested": return num(a.requested_total, b.requested_total);
        case "amount": return num(a.amount, b.amount);
        case "months": return num(a.payback_months, b.payback_months);
        case "installment": return num(a.installment, b.installment);
        case "first": return str(a.first_deduction, b.first_deduction);
        case "last": return str(a.last_deduction, b.last_deduction);
        case "thisMonth": return num(installmentIn(a, deductionMonth || thisMonth), installmentIn(b, deductionMonth || thisMonth));
        case "deducted": return num(a.deducted_to_date, b.deducted_to_date);
        case "balance": return num(a.balance, b.balance);
        case "approved": return str(a.approved_at, b.approved_at);
        case "paid": return str(a.paid_at, b.paid_at);
        case "status": return str(a.status, b.status);
        case "submitted":
        default: return str(a.submitted_at, b.submitted_at);
      }
    });
  }, [filtered, sortKey, sortDir, deductionMonth, thisMonth]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // KPIs (paid advances in the selected company).
  const stats = useMemo(() => {
    const paid = inCompany.filter((i) => i.status === "PAID");
    const m = deductionMonth || thisMonth;
    return {
      paidCount: paid.length,
      paidTotal: paid.reduce((t, i) => t + i.amount, 0),
      outstanding: paid.reduce((t, i) => t + (i.balance || 0), 0),
      monthTotal: paid.reduce((t, i) => t + installmentIn(i, m), 0),
      monthPeople: paid.filter((i) => installmentIn(i, m) > 0).length,
      month: m,
      inApproval: inCompany.filter((i) => ["SUBMITTED", "COUNTERSIGNED", "HR_OFFICER", "APPROVED"].includes(i.status)).length
    };
  }, [inCompany, deductionMonth, thisMonth]);

  // Monthly deductions across all paid advances - what payroll deducts each month.
  const monthly = useMemo(() => months.map((m) => {
    const rows = inCompany.filter((i) => i.status === "PAID" && installmentIn(i, m) > 0);
    return { month: m, people: rows.length, total: rows.reduce((t, i) => t + installmentIn(i, m), 0) };
  }), [months, inCompany]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }
  const Th = ({ label, k }: { label: string; k: SortKey }) => (
    <th style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }} onClick={() => toggleSort(k)}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{label} <ArrowUpDown size={12} style={{ opacity: sortKey === k ? 1 : 0.35 }} /></span>
    </th>
  );

  // Export: the columns shown, plus one column per deduction month (each person's installment).
  function exportCsv() {
    const m = deductionMonth || thisMonth;
    const cols: Array<[string, string, (i: SalaryAdvance) => string]> = [
      ["name", "Name", (i) => i.employee_name || ""],
      ["empNo", "Emp No", (i) => i.employee_no || ""],
      ["*", "Company", (i) => i.division_name || ""],
      ["division", "Division", (i) => i.org_division || ""],
      ["department", "Department", (i) => i.department_name || ""],
      ["reference", "Reference", (i) => i.reference],
      ["salaryMonth", "Salary Month", (i) => monthLabel(i.salary_month)],
      ["requested", "Requested", (i) => i.requested_total.toFixed(2)],
      ["amount", "Advance Amount", (i) => i.amount.toFixed(2)],
      ["months", "Duration (months)", (i) => String(i.payback_months)],
      ["installment", "Installment / month", (i) => i.installment.toFixed(2)],
      ["first", "First Deduction", (i) => monthLabel(i.first_deduction)],
      ["last", "Last Deduction", (i) => monthLabel(i.last_deduction)],
      ["thisMonth", `Deduct ${monthLabel(m)}`, (i) => (i.status === "PAID" ? installmentIn(i, m).toFixed(2) : "")],
      ["deducted", "Deducted so far", (i) => (i.status === "PAID" ? i.deducted_to_date.toFixed(2) : "")],
      ["balance", "Balance", (i) => (i.balance == null ? "" : i.balance.toFixed(2))],
      ["repaid", "Paid in full (repaid directly)", (i) => (i.repaid_directly == null ? "" : `${i.repaid_directly.toFixed(2)} on ${fmtDate(i.paid_in_full_at)}, ref ${i.paid_in_full_reference || ""}`)],
      ["submitted", "Requested On", (i) => fmtDate(i.submitted_at)],
      ["approved", "Approved On", (i) => fmtDate(i.approved_at)],
      ["paid", "Paid On", (i) => fmtDate(i.paid_at)],
      ["paidRef", "Payment Reference", (i) => i.paid_reference || ""],
      ["paymentMethod", "Payment Method", (i) => i.payment_method || ""],
      ["purpose", "Reason", (i) => i.purpose || ""],
      ["waiting", "Waiting With", (i) => i.waiting_with || ""],
      ["status", "Status", (i) => (STATUS[i.status]?.label || i.status) + (i.deduction_status ? ` - ${DEDUCTION[i.deduction_status]}` : "")]
    ];
    const chosen = cols.filter(([k]) => k === "*" || show(k));
    const allMonths = [...new Set(sorted.flatMap((i) => i.schedule.filter((s) => !s.cancelled).map((s) => s.month)))].sort();
    const header = [...chosen.map(([, h]) => h), ...allMonths.map((mm) => `Installment ${monthLabel(mm)}`)];
    const rows = sorted.map((i) => [...chosen.map(([, , f]) => f(i)), ...allMonths.map((mm) => { const v = installmentIn(i, mm); return v ? v.toFixed(2) : ""; })]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `salary-advances-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  if (loading) return <div className="ep-page"><p>Loading salary advances…</p></div>;

  const visibleCount = COLUMNS.filter((c) => c.locked || show(c.key)).length + 1 + (canSettle ? 1 : 0);

  return (
    <div className="ep-page deductions-page">
      <FinancePageHeader
        icon={Banknote}
        title="Salary Advances"
        subtitle="Every salary advance and its repayment: deductions start the month after the request, one installment a month for the payback period."
        actions={<>
          <GuidedTour id="salary_advances" {...TOURS.salary_advances} />
          <ColumnChooser columns={COLUMNS} show={columns.show} toggle={columns.toggle} reset={columns.reset} />
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!sorted.length}><Download size={14} /> Export</button>
        </>}
      />

      {error && <pre className="inbox-error">{error}</pre>}

      <RepaymentsReview onChanged={() => void load()} />

      <FinanceKpiRow>
        <FinanceKpiTile icon={Wallet} tint="#dbeafe" color="#1e40af" label="Paid out" value={money(stats.paidTotal)} sub={`${stats.paidCount} salary advance${stats.paidCount === 1 ? "" : "s"}`} />
        <FinanceKpiTile icon={Banknote} tint="#fef3c7" color="#92400e" label="Still to deduct" value={money(stats.outstanding)} sub="By the repayment schedule" />
        <FinanceKpiTile icon={CalendarClock} tint="#d1fae5" color="#065f46" label={`Deduct in ${monthLabel(stats.month)}`} value={money(stats.monthTotal)} sub={`${stats.monthPeople} employee${stats.monthPeople === 1 ? "" : "s"}`} />
        <FinanceKpiTile icon={Hourglass} tint="#f1f5f9" color="#475569" label="In approval / awaiting payment" value={stats.inApproval} />
      </FinanceKpiRow>

      <BusinessUnitTabs value={company} onChange={(v) => { setCompany(v); setPage(1); }} counts={companyCounts} icon={Building2} allIcon={Users} />

      <FinanceFilterBar
        showReset={Boolean(search || company !== "ALL" || statusFilter !== "ALL" || deductionMonth)}
        onReset={() => { setSearch(""); setCompany("ALL"); setStatusFilter("ALL"); setDeductionMonth(""); setPage(1); }}
      >
        <SearchField label="Search" placeholder="Search name, emp no, division, department, reference…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
        <FilterField label="Status">
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </FilterField>
        <FilterField label="Deduction month">
          <select value={deductionMonth} onChange={(e) => { setDeductionMonth(e.target.value); setPage(1); }}>
            <option value="">Any month</option>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}{m === thisMonth ? " (this month)" : ""}</option>)}
          </select>
        </FilterField>
      </FinanceFilterBar>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {sorted.length === 0 ? (
            <FinanceEmptyState icon={FolderSearch} title="No salary advances match your filters." hint="Try adjusting your search criteria or filters." />
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <Th label="Name" k="name" />
                  {show("empNo") && <Th label="Emp. No" k="empNo" />}
                  {show("division") && <Th label="Division" k="division" />}
                  {show("department") && <Th label="Department" k="department" />}
                  {show("reference") && <Th label="Reference" k="reference" />}
                  {show("salaryMonth") && <th>Salary Month</th>}
                  {show("requested") && <Th label="Requested" k="requested" />}
                  {show("amount") && <Th label="Advance Amount" k="amount" />}
                  {show("months") && <Th label="Months" k="months" />}
                  {show("installment") && <Th label="Installment / month" k="installment" />}
                  {show("first") && <Th label="First Deduction" k="first" />}
                  {show("last") && <Th label="Last Deduction" k="last" />}
                  {show("thisMonth") && <Th label={`Deduct ${monthLabel(deductionMonth || thisMonth)}`} k="thisMonth" />}
                  {show("deducted") && <Th label="Deducted so far" k="deducted" />}
                  {show("balance") && <Th label="Balance" k="balance" />}
                  {show("repaid") && <th>Paid in full</th>}
                  {show("submitted") && <Th label="Requested On" k="submitted" />}
                  {show("approved") && <Th label="Approved On" k="approved" />}
                  {show("paid") && <Th label="Paid On" k="paid" />}
                  {show("paidRef") && <th>Payment Reference</th>}
                  {show("paymentMethod") && <th>Payment Method</th>}
                  {show("purpose") && <th>Reason</th>}
                  {show("waiting") && <th>Waiting With</th>}
                  {show("status") && <Th label="Status" k="status" />}
                  {canSettle && <th />}
                </tr>
              </thead>
              <tbody>
                {paged.map((i) => {
                  const st = STATUS[i.status] || { label: i.status, bg: "#f1f5f9", color: "#475569" };
                  const open = expanded === i.id;
                  const m = deductionMonth || thisMonth;
                  return (
                    <Fragment key={i.id}>
                      <tr>
                        <td>
                          <button type="button" className="ep-icon-btn" aria-label={open ? "Hide installments" : "Show installments"} title="Installments by month" onClick={() => setExpanded(open ? null : i.id)}>
                            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        </td>
                        <td style={{ fontWeight: 600, fontSize: "0.87rem" }}>{i.employee_name || "—"}</td>
                        {show("empNo") && <td style={{ color: "var(--muted)", fontSize: 13 }}>{i.employee_no || "—"}</td>}
                        {show("division") && <td style={{ fontSize: 13 }}>{i.org_division || "—"}</td>}
                        {show("department") && <td style={{ fontSize: 13 }}>{i.department_name || "—"}</td>}
                        {show("reference") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{i.reference}</td>}
                        {show("salaryMonth") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{monthLabel(i.salary_month)}</td>}
                        {show("requested") && <td style={{ fontSize: 13 }}>{money(i.requested_total)}</td>}
                        {show("amount") && <td style={{ fontWeight: 600 }}>{money(i.amount)}</td>}
                        {show("months") && <td style={{ fontSize: 13 }}>{i.payback_months}</td>}
                        {show("installment") && <td style={{ fontWeight: 600 }}>{money(i.installment)}</td>}
                        {show("first") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{monthLabel(i.first_deduction)}</td>}
                        {show("last") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{monthLabel(i.last_deduction)}</td>}
                        {show("thisMonth") && <td style={{ fontWeight: 600, color: i.status === "PAID" && installmentIn(i, m) ? "#065f46" : "var(--muted)" }}>{i.status === "PAID" ? money(installmentIn(i, m)) : "—"}</td>}
                        {show("deducted") && <td style={{ fontSize: 13 }}>{i.status === "PAID" ? money(i.deducted_to_date) : "—"}</td>}
                        {show("balance") && <td style={{ fontWeight: 600, color: i.balance ? "#92400e" : "var(--muted)" }}>{money(i.balance)}</td>}
                        {show("repaid") && (
                          <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                            {i.paid_in_full_at ? <>
                              <div style={{ fontWeight: 600 }}>{money(i.repaid_directly)} · {fmtDate(i.paid_in_full_at)}</div>
                              <div style={{ color: "var(--muted)" }}>Ref {i.paid_in_full_reference}{i.paid_in_full_by ? ` · ${i.paid_in_full_by}` : ""}</div>
                            </> : "—"}
                          </td>
                        )}
                        {show("submitted") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{fmtDate(i.submitted_at)}</td>}
                        {show("approved") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{fmtDate(i.approved_at)}</td>}
                        {show("paid") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{fmtDate(i.paid_at)}</td>}
                        {show("paidRef") && <td style={{ fontSize: 13 }}>{i.paid_reference || "—"}</td>}
                        {show("paymentMethod") && <td style={{ fontSize: 13 }}>{i.payment_method || "—"}</td>}
                        {show("purpose") && <td style={{ fontSize: 13, maxWidth: 240 }}>{i.purpose || "—"}</td>}
                        {show("waiting") && <td style={{ fontSize: 12, color: "var(--muted)" }}>{i.waiting_with || "—"}</td>}
                        {show("status") && (
                          <td>
                            <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: st.bg, color: st.color, whiteSpace: "nowrap" }}>{st.label}</span>
                            {i.deduction_status && (
                              <div style={{ marginTop: 3, fontSize: 11, whiteSpace: "nowrap", color: i.deduction_status === "PAID_IN_FULL" ? "#065f46" : "var(--muted)", fontWeight: i.deduction_status === "PAID_IN_FULL" ? 700 : 400 }}>
                                {DEDUCTION[i.deduction_status]}{i.deduction_status === "PAID_IN_FULL" ? ` · ${fmtDate(i.paid_in_full_at)}` : ""}
                              </div>
                            )}
                            {i.pending_repayments && (
                              <button
                                type="button"
                                title="Go to Repayments to review (proof, Accept, Reject)"
                                onClick={() => {
                                  // Jump to the review box and flash this employee's repayment.
                                  const row = document.getElementById(`repayment-${i.id}`);
                                  (row || document.getElementById("repayments-review"))?.scrollIntoView({ behavior: "smooth", block: "center" });
                                  if (row) { row.style.transition = "background 0.3s"; row.style.background = "#fef3c7"; setTimeout(() => { row.style.background = ""; }, 2200); }
                                }}
                                style={{ display: "block", marginTop: 3, padding: 0, border: 0, background: "none", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", color: "#92400e", fontWeight: 700, textDecoration: "underline" }}
                              >
                                Review {money(i.pending_repayments.amount)} repayment ↑
                              </button>
                            )}
                          </td>
                        )}
                        {canSettle && (
                          <td style={{ whiteSpace: "nowrap" }}>
                            {i.status === "PAID" && (i.deduction_status === "NOT_STARTED" || i.deduction_status === "DEDUCTING") && (
                              <button type="button" className="ep-btn-outline" style={{ fontSize: 12, padding: "3px 10px" }} disabled={busyId === i.id} onClick={() => void markPaidInFull(i)}>
                                {busyId === i.id ? "Saving…" : "Paid in full"}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                      {open && (
                        <tr>
                          <td />
                          <td colSpan={visibleCount - 1} style={{ background: "var(--surface-soft, #f8fafc)" }}>
                            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                              Installments: {money(i.amount)} over {i.payback_months} month{i.payback_months === 1 ? "" : "s"}, requested {monthLabel(i.request_month)}
                              {i.status !== "PAID" && <span style={{ fontWeight: 400, color: "var(--muted)" }}> - planned; deductions apply once it's paid</span>}
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                              {i.schedule.map((s, n) => {
                                const past = i.status === "PAID" && !s.cancelled && s.month < thisMonth;
                                const now = !s.cancelled && s.month === thisMonth;
                                return (
                                  <div key={s.month} style={{ border: `1px solid ${now ? "#065f46" : "var(--border)"}`, borderRadius: 8, padding: "6px 10px", minWidth: 110, background: past ? "#ecfdf5" : "var(--surface, #fff)", opacity: s.cancelled ? 0.6 : 1 }}>
                                    <div style={{ fontSize: 11, color: "var(--muted)" }}>#{n + 1} · {monthLabel(s.month)}{now ? " (this month)" : ""}</div>
                                    <div style={{ fontWeight: 700, fontSize: 13, textDecoration: s.cancelled ? "line-through" : "none" }}>{money(s.amount)}</div>
                                    {past && <div style={{ fontSize: 10.5, color: "#065f46" }}>deducted (by schedule)</div>}
                                    {s.cancelled && <div style={{ fontSize: 10.5, color: "#065f46" }}>not deducted - repaid</div>}
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {sorted.length > 0 && (
          <div className="ded-filter-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, sorted.length)} of {sorted.length} entries
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <select className="ep-form-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}><ChevronLeft size={14} /></button>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Page {currentPage} of {totalPages}</span>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>

      {monthly.length > 0 && (
        <div className="ep-panel" style={{ marginTop: 14, padding: "16px 20px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Installments per month</div>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 12px" }}>What payroll deducts each month across paid salary advances{company !== "ALL" ? ` (${company})` : ""}. Click a month to list who.</p>
          <table className="ep-table">
            <thead><tr><th>Month</th><th>Employees</th><th>Total to deduct</th></tr></thead>
            <tbody>
              {monthly.map((r) => (
                <tr key={r.month} style={{ cursor: "pointer", background: deductionMonth === r.month ? "var(--surface-soft, #f1f5f9)" : undefined }}
                  onClick={() => { setDeductionMonth(deductionMonth === r.month ? "" : r.month); setStatusFilter("ALL"); setPage(1); }}>
                  <td style={{ fontWeight: r.month === thisMonth ? 700 : 500 }}>{monthLabel(r.month)}{r.month === thisMonth ? " (this month)" : ""}{r.month < thisMonth ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> - past</span> : null}</td>
                  <td>{r.people}</td>
                  <td style={{ fontWeight: 700 }}>{money(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
