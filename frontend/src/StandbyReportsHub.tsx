import { useEffect, useMemo, useState } from "react";
import { api, downloadBlob } from "./api";
import { showNotice } from "./alerts";
import {
  BarChart3, FileText, Clock, Wallet, CheckCircle2, Download, FolderSearch, ClipboardList, ChevronLeft, ChevronRight
} from "lucide-react";
import { FinancePageHeader, FinanceKpiRow, FinanceKpiTile, FinanceFilterBar, SelectField, SearchField, IconTabRow, FinanceEmptyState } from "./components/FinanceQueueKit";

// Standby Reports — same server-side-filtered, CSV/PDF-exportable shape as
// the Overtime report (standby-reports.routes.ts), but the list here is
// small enough (Finance/HR-scale, not a raw transaction feed) that the
// on-screen table/KPIs/status tabs filter client-side over one fetch, the
// same pattern Salaries' Salary Registers list already uses. PDF export
// still goes through the server so it always reflects the same query the
// CSV/on-screen table are built from, not just what's rendered on the
// current page.
type StandbyReportRow = {
  id: string;
  claim_no: string;
  employee_name: string | null;
  employee_no: string | null;
  division_name: string | null;
  department_name: string | null;
  section_name: string | null;
  period: string;
  date_from: string | null;
  date_to: string | null;
  total_days: number | null;
  compensable_hours: string | number;
  rate: number;
  amount: number;
  is_estimated: boolean;
  status: string;
  submitted_at: string | null;
  closed_at: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted",
  FINANCE_PROCESSING: "With Finance",
  PAYMENT_PENDING: "Payment Pending",
  CLOSED: "Processed",
  REJECTED: "Rejected"
};
function statusLabel(s: string) {
  return STATUS_LABEL[s] || s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
const STATUS_STYLE: Record<string, [string, string]> = {
  SUBMITTED: ["#fef3c7", "#92400e"],
  FINANCE_PROCESSING: ["#fef3c7", "#92400e"],
  PAYMENT_PENDING: ["#dbeafe", "#1e40af"],
  CLOSED: ["#d1fae5", "#065f46"],
  REJECTED: ["#fee2e2", "#991b1b"]
};
function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{statusLabel(status)}</span>;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateRange(row: StandbyReportRow) {
  if (!row.date_from) return "—";
  if (!row.date_to || row.date_to === row.date_from) return fmtDate(row.date_from);
  return `${fmtDate(row.date_from)} – ${fmtDate(row.date_to)}`;
}
function fmtPeriod(s: string | null | undefined) {
  if (!s) return "—";
  const [y, m] = s.split("-");
  if (!m) return s;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}
function fmtMoney(n: number) {
  return `M ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const el = document.createElement("a");
  el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  el.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  el.click();
}

const PAGE_SIZE_OPTIONS = [10, 25, 50];

export default function StandbyReportsHub({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<StandbyReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  const [tab, setTab] = useState<"all" | "pending" | "processed">("all");
  const [divisionFilter, setDivisionFilter] = useState("ALL");
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [sectionFilter, setSectionFilter] = useState("ALL");
  const [periodFilter, setPeriodFilter] = useState("ALL");
  const [employeeSearch, setEmployeeSearch] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  function refresh() {
    setLoading(true);
    api.standbyReport({}).then((r: any) => setItems(r.items || [])).catch((e: any) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(refresh, []);

  const divisionOptions = useMemo(() => [{ value: "ALL", label: "All Divisions" }, ...Array.from(new Set(items.map((i) => i.division_name).filter(Boolean) as string[])).sort().map((d) => ({ value: d, label: d }))], [items]);
  const departmentOptions = useMemo(() => [{ value: "ALL", label: "All Departments" }, ...Array.from(new Set(items.map((i) => i.department_name).filter(Boolean) as string[])).sort().map((d) => ({ value: d, label: d }))], [items]);
  const sectionOptions = useMemo(() => [{ value: "ALL", label: "All Sections" }, ...Array.from(new Set(items.map((i) => i.section_name).filter(Boolean) as string[])).sort().map((d) => ({ value: d, label: d }))], [items]);
  const periodOptions = useMemo(() => [{ value: "ALL", label: "All Periods" }, ...Array.from(new Set(items.map((i) => i.period))).sort().reverse().map((p) => ({ value: p, label: fmtPeriod(p) }))], [items]);

  // Filter-bar criteria only (not the status tab) — this is what the KPI
  // row and the tab counts themselves are based on, so switching tabs
  // narrows the table without the KPIs/counts jumping around underneath it.
  const filteredByBar = useMemo(() => items.filter((r) => {
    if (divisionFilter !== "ALL" && r.division_name !== divisionFilter) return false;
    if (departmentFilter !== "ALL" && r.department_name !== departmentFilter) return false;
    if (sectionFilter !== "ALL" && r.section_name !== sectionFilter) return false;
    if (periodFilter !== "ALL" && r.period !== periodFilter) return false;
    if (employeeSearch && !`${r.employee_name || ""} ${r.employee_no || ""}`.toLowerCase().includes(employeeSearch.toLowerCase())) return false;
    return true;
  }), [items, divisionFilter, departmentFilter, sectionFilter, periodFilter, employeeSearch]);

  const counts = useMemo(() => ({
    all: filteredByBar.length,
    pending: filteredByBar.filter((i) => i.status !== "CLOSED").length,
    processed: filteredByBar.filter((i) => i.status === "CLOSED").length
  }), [filteredByBar]);

  const filtered = useMemo(() => filteredByBar.filter((r) => {
    if (tab === "pending") return r.status !== "CLOSED";
    if (tab === "processed") return r.status === "CLOSED";
    return true;
  }), [filteredByBar, tab]);

  const kpis = useMemo(() => ({
    records: filteredByBar.length,
    days: filteredByBar.reduce((s, r) => s + (r.total_days || 0), 0),
    amount: filteredByBar.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    processedPct: filteredByBar.length ? Math.round((counts.processed / filteredByBar.length) * 100) : 0
  }), [filteredByBar, counts.processed]);

  useEffect(() => { setPage(1); }, [tab, divisionFilter, departmentFilter, sectionFilter, periodFilter, employeeSearch]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function exportCsv() {
    downloadCsv("standby-report",
      ["Claim No", "Employee", "Employee No", "Division", "Department", "Standby From", "Standby To", "Total Days", "Compensable Hours", "Rate (M/hr)", "Amount (M)", "Status"],
      filtered.map((r) => [r.claim_no, r.employee_name || "", r.employee_no || "", r.division_name || "", r.department_name || "", fmtDate(r.date_from), fmtDate(r.date_to), r.total_days ?? "", r.compensable_hours, r.rate, r.amount, statusLabel(r.status)])
    );
  }

  async function exportPdf() {
    setExporting("pdf");
    try {
      const params: Record<string, string> = {};
      if (divisionFilter !== "ALL") params.division = divisionFilter;
      if (departmentFilter !== "ALL") params.department = departmentFilter;
      if (sectionFilter !== "ALL") params.section = sectionFilter;
      if (periodFilter !== "ALL") params.month = periodFilter;
      if (employeeSearch) params.employee = employeeSearch;
      if (tab !== "all") params.status = tab.toUpperCase();
      await downloadBlob(() => api.standbyReportPdf(params), "standby-report.pdf");
    } catch (e: any) {
      void showNotice(e?.message || "Failed to export PDF");
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon"><BarChart3 size={18} /></span>
            <h2>Standby Reports</h2>
          </div>
          <p className="custom-requests-subtitle">View and generate standby compensation reports for reporting and processing.</p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <FinanceKpiRow>
        <FinanceKpiTile icon={FileText} value={kpis.records} label="Total Records" sub="Employees on standby" tint="#dbeafe" color="#1e40af" />
        <FinanceKpiTile icon={Clock} value={kpis.days} label="Total Standby Days" sub="Across all records" tint="#fef3c7" color="#92400e" />
        <FinanceKpiTile icon={Wallet} value={fmtMoney(kpis.amount)} label="Total Amount" tint="#ede9fe" color="#5b21b6" />
        <FinanceKpiTile icon={CheckCircle2} value={counts.processed} label="Processed" sub={`${kpis.processedPct}% of records`} tint="#d1fae5" color="#065f46" />
      </FinanceKpiRow>

      <FinanceFilterBar
        showReset={divisionFilter !== "ALL" || departmentFilter !== "ALL" || sectionFilter !== "ALL" || periodFilter !== "ALL" || employeeSearch !== ""}
        onReset={() => { setDivisionFilter("ALL"); setDepartmentFilter("ALL"); setSectionFilter("ALL"); setPeriodFilter("ALL"); setEmployeeSearch(""); }}
      >
        <SelectField label="Period" value={periodFilter} onChange={setPeriodFilter} options={periodOptions} />
        <SelectField label="Division" value={divisionFilter} onChange={setDivisionFilter} options={divisionOptions} />
        <SelectField label="Department" value={departmentFilter} onChange={setDepartmentFilter} options={departmentOptions} />
        <SelectField label="Section" value={sectionFilter} onChange={setSectionFilter} options={sectionOptions} />
        <SearchField label="Employee" placeholder="Search employee…" value={employeeSearch} onChange={setEmployeeSearch} />
      </FinanceFilterBar>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <IconTabRow
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "all", label: "All Records", count: counts.all, icon: ClipboardList },
            { key: "pending", label: "Pending", count: counts.pending, icon: Clock },
            { key: "processed", label: "Processed", count: counts.processed, icon: CheckCircle2 }
          ]}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ep-btn-outline" disabled={!filtered.length} onClick={exportCsv}><Download size={14} /> Export to Excel</button>
          <button className="ep-btn-outline" disabled={!filtered.length || exporting !== null} onClick={() => void exportPdf()}><Download size={14} /> Export to PDF</button>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : filtered.length === 0 ? (
            <FinanceEmptyState icon={FolderSearch} title="No standby records match your filters." />
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>#</th><th>Employee</th><th>Employee No.</th><th>Division</th><th>Department</th>
                  <th>Standby Date(s)</th><th>Total Days</th><th>Rate (M/hr)</th><th>Amount (M)</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((r, i) => (
                  <tr key={r.id}>
                    <td>{(currentPage - 1) * pageSize + i + 1}</td>
                    <td style={{ fontWeight: 600 }}>{r.employee_name || "—"}</td>
                    <td>{r.employee_no || "—"}</td>
                    <td>{r.division_name || "—"}</td>
                    <td>{r.department_name || "—"}</td>
                    <td>{fmtDateRange(r)}</td>
                    <td>{r.total_days ?? "—"}</td>
                    <td>{Number(r.rate || 0).toFixed(2)}</td>
                    <td style={{ fontWeight: 600 }}>
                      {fmtMoney(r.amount)}
                      {r.is_estimated && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "var(--muted)" }} title="Not yet processed by Finance — estimated from the default standby rate.">est.</span>}
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {filtered.length > 0 && (
          <div className="ep-pagination">
            <span>Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, filtered.length)} of {filtered.length} records</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button className="ep-btn-outline" disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={14} /></button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                <button key={n} className={n === currentPage ? "ep-btn" : "ep-btn-outline"} onClick={() => setPage(n)}>{n}</button>
              ))}
              <button className="ep-btn-outline" disabled={currentPage >= totalPages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></button>
              <select className="ep-form-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
