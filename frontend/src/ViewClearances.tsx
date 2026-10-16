import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { formatMoney } from "./constants";
import {
  ChevronLeft, ChevronRight, Download, ArrowUpDown, FolderSearch, Building2, Users
} from "lucide-react";
import { BusinessUnitTabs, FinanceFilterBar, FilterField, SearchField, FinanceEmptyState, type BusinessUnit, ColumnChooser, useColumnVisibility, type ColumnOption } from "./components/FinanceQueueKit";

// Human-facing labels for every real clearance_claims.status value (see
// ClaimStatus in claims.service.ts) - plain badges, no color-coded urgency
// cues, since this page is a pure roster with nothing to action.
const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted",
  MANAGER_APPROVED: "Manager Approved",
  EXCO_APPROVED: "EXCO Approved",
  HR_OFFICER: "HR Officer",
  FINANCE_VERIFIED: "Finance Verified",
  PAYMENT_PROCESSING: "Payment Processing",
  SETTLED: "Settled",
  CLOSED: "Closed",
  REJECTED: "Rejected",
  REFUND_DUE: "Refund Due",
  PAYBACK_DUE: "Payback Due",
  PAYBACK_PROOF_SUBMITTED: "Payback Proof Submitted",
  PAYBACK_PROOF_REJECTED: "Payback Proof Rejected",
  FINANCE_TREASURY_REVIEW: "With Finance Treasury",
  COMPLETED: "Fully Cleared",
  CANCELLED: "Cancelled"
};

interface ClearanceItem {
  id: string;
  employee_name: string | null;
  employee_no: string | null;
  division_name: string | null;
  // division_name is the company (the tabs); these are the traveller's
  // Division and Department in Org Structure, e.g. Technical / Operations.
  org_division: string | null;
  department_name: string | null;
  duty_station: string | null;
  // Where they travelled from/to and when, from the advance this clears.
  origin: string | null;
  destination: string | null;
  departure_date: string | null;
  return_date: string | null;
  // VR Date = when the advance this clears was approved.
  vr_date: string | null;
  clearance_submitted_at: string | null;
  has_receipts: boolean;
  advance_amount: string | number;
  cleared_amount: string | number;
  amount_to_be_expensed: string | number;
  salary_deduction: string | number;
  payable: string | number;
  status: string;
  closed_at: string | null;
  currency: string | null;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

type SortKey = "name" | "empNo" | "division" | "department" | "dutyStation" | "origin" | "destination" | "departure" | "return" | "vrDate" | "submitted" | "advAmount" | "clearedAmount" | "toBeExpensed" | "salaryDeduction" | "payable" | "status";

const COLUMNS: ColumnOption[] = [
  { key: "name", label: "Name", locked: true },
  { key: "empNo", label: "Emp. No" },
  { key: "division", label: "Division" },
  { key: "department", label: "Department" },
  { key: "dutyStation", label: "Duty Station" },
  { key: "origin", label: "Starting Place" },
  { key: "destination", label: "Destination" },
  { key: "departure", label: "Departure" },
  { key: "return", label: "Return" },
  { key: "vrDate", label: "VR Date (advance approved)" },
  { key: "submitted", label: "Clearance Submitted" },
  { key: "receipts", label: "Receipts" },
  { key: "advAmount", label: "Adv Amount" },
  { key: "clearedAmount", label: "Cleared Amount" },
  { key: "toBeExpensed", label: "Amount To Be Expensed" },
  { key: "salaryDeduction", label: "Salary Deduction" },
  { key: "payable", label: "Payable" },
  { key: "status", label: "Status" },
];

const PAGE_SIZE_OPTIONS = [10, 25, 50];

// Read-only roster of every clearance company-wide, regardless of status -
// a sibling to Deductions (same columns, same permission, same division
// scoping) but with no action column: nothing here can be clicked, it's
// purely "where does every clearance stand right now."
export default function ViewClearances() {
  const [items, setItems] = useState<ClearanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [companyFilter, setCompanyFilter] = useState<BusinessUnit>("ALL");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("vrDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const columns = useColumnVisibility("finance-columns:view-clearances");
  const show = columns.show;

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    api.allClearances()
      .then((resp: any) => setItems(resp.items || []))
      .catch((e: any) => setError(String(e.message)))
      .finally(() => setLoading(false));
  }, []);

  const companyCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: items.length, MNO: 0, SEFS: 0, HigherLife: 0 };
    for (const i of items) {
      if (i.division_name && i.division_name in counts) counts[i.division_name]++;
    }
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (companyFilter !== "ALL" && i.division_name !== companyFilter) return false;
      if (dateFrom && (!i.closed_at || i.closed_at < dateFrom)) return false;
      if (dateTo && (!i.closed_at || i.closed_at > dateTo)) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          (i.employee_name || "").toLowerCase().includes(q) ||
          (i.employee_no || "").toLowerCase().includes(q) ||
          (i.org_division || "").toLowerCase().includes(q) ||
          (i.department_name || "").toLowerCase().includes(q) ||
          (i.destination || "").toLowerCase().includes(q) ||
          (i.origin || "").toLowerCase().includes(q) ||
          (i.duty_station || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [items, companyFilter, dateFrom, dateTo, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      switch (sortKey) {
        case "name": return (a.employee_name || "").localeCompare(b.employee_name || "") * dir;
        case "empNo": return (a.employee_no || "").localeCompare(b.employee_no || "") * dir;
        case "division": return (a.org_division || "").localeCompare(b.org_division || "") * dir;
        case "department": return (a.department_name || "").localeCompare(b.department_name || "") * dir;
        case "origin": return (a.origin || "").localeCompare(b.origin || "") * dir;
        case "destination": return (a.destination || "").localeCompare(b.destination || "") * dir;
        case "dutyStation": return (a.duty_station || "").localeCompare(b.duty_station || "") * dir;
        case "departure": return (a.departure_date || "").localeCompare(b.departure_date || "") * dir;
        case "return": return (a.return_date || "").localeCompare(b.return_date || "") * dir;
        case "submitted": return (a.clearance_submitted_at || "").localeCompare(b.clearance_submitted_at || "") * dir;
        case "advAmount": return (Number(a.advance_amount) - Number(b.advance_amount)) * dir;
        case "clearedAmount": return (Number(a.cleared_amount) - Number(b.cleared_amount)) * dir;
        case "toBeExpensed": return (Number(a.amount_to_be_expensed) - Number(b.amount_to_be_expensed)) * dir;
        case "salaryDeduction": return (Number(a.salary_deduction) - Number(b.salary_deduction)) * dir;
        case "payable": return (Number(a.payable) - Number(b.payable)) * dir;
        case "status": return a.status.localeCompare(b.status) * dir;
        case "vrDate":
        default: {
          const av = a.vr_date ? new Date(a.vr_date).getTime() : 0;
          const bv = b.vr_date ? new Date(b.vr_date).getTime() : 0;
          return (av - bv) * dir;
        }
      }
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  function exportCsv() {
    // Exports the columns currently shown (Company is always included).
    const allCsvColumns: Array<[string, string, (i: typeof sorted[number]) => string]> = [
      ["name", "Name", (i) => String(i.employee_name || "")],
      ["empNo", "Emp No", (i) => String(i.employee_no || "")],
      ["*", "Company", (i) => String(i.division_name || "")],
      ["division", "Division", (i) => String(i.org_division || "")],
      ["department", "Department", (i) => String(i.department_name || "")],
      ["dutyStation", "Duty Station", (i) => String(i.duty_station || "")],
      ["origin", "Starting Place", (i) => String(i.origin || "")],
      ["destination", "Destination", (i) => String(i.destination || "")],
      ["departure", "Departure", (i) => String(i.departure_date ? fmtDate(i.departure_date) : "")],
      ["return", "Return", (i) => String(i.return_date ? fmtDate(i.return_date) : "")],
      ["vrDate", "VR Date", (i) => String(fmtDate(i.vr_date))],
      ["submitted", "Clearance Submitted", (i) => String(i.clearance_submitted_at ? fmtDate(i.clearance_submitted_at) : "")],
      ["receipts", "Receipts", (i) => String(i.has_receipts ? "Yes" : "No")],
      ["advAmount", "Adv Amount", (i) => String(Number(i.advance_amount || 0).toFixed(2))],
      ["clearedAmount", "Cleared Amount", (i) => String(Number(i.cleared_amount || 0).toFixed(2))],
      ["toBeExpensed", "Amount To Be Expensed", (i) => String(Number(i.amount_to_be_expensed || 0).toFixed(2))],
      ["salaryDeduction", "Salary Deduction", (i) => String(Number(i.salary_deduction || 0).toFixed(2))],
      ["payable", "Payable", (i) => String(Number(i.payable || 0).toFixed(2))],
      ["status", "Status", (i) => String(STATUS_LABEL[i.status] || i.status)],
    ];
    const csvColumns = allCsvColumns.filter(([key]) => key === "*" || show(key));
    const headers = csvColumns.map(([, h]) => h);
    const rows = sorted.map((i) => csvColumns.map(([, , f]) => f(i)));
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `all-clearances-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  const SortableHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(sortKeyName)}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label} <ArrowUpDown size={12} style={{ opacity: sortKey === sortKeyName ? 1 : 0.35 }} />
      </span>
    </th>
  );

  if (loading) return <div className="ep-page"><p>Loading clearances…</p></div>;

  return (
    <div className="ep-page deductions-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">View Clearances</h1>
          <p className="ep-subtitle">Every clearance company-wide, at whatever stage it's currently at — view only, nothing to action here.</p>
        </div>
        <div className="ep-actions">
          <ColumnChooser columns={COLUMNS} show={columns.show} toggle={columns.toggle} reset={columns.reset} />
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!sorted.length}>
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <BusinessUnitTabs value={companyFilter} onChange={(v) => { setCompanyFilter(v); setPage(1); }} counts={companyCounts} icon={Building2} allIcon={Users} />

      <FinanceFilterBar
        showReset={Boolean(search || companyFilter !== "ALL" || dateFrom || dateTo)}
        onReset={() => { setSearch(""); setCompanyFilter("ALL"); setDateFrom(""); setDateTo(""); setPage(1); }}
      >
        <SearchField label="Search" placeholder="Search name, emp no, division, department, destination, duty station…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
        <FilterField label="Closed From">
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
        </FilterField>
        <FilterField label="Closed To">
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
        </FilterField>
      </FinanceFilterBar>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {sorted.length === 0 ? (
            <FinanceEmptyState icon={FolderSearch} title="No clearances match your filters." hint="Try adjusting your search criteria or filters." />
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <SortableHeader label="Name" sortKeyName="name" />
                  {show("empNo") && <SortableHeader label="Emp. No" sortKeyName="empNo" />}
                  {show("division") && <SortableHeader label="Division" sortKeyName="division" />}
                  {show("department") && <SortableHeader label="Department" sortKeyName="department" />}
                  {show("dutyStation") && <SortableHeader label="Duty Station" sortKeyName="dutyStation" />}
                  {show("origin") && <SortableHeader label="Starting Place" sortKeyName="origin" />}
                  {show("destination") && <SortableHeader label="Destination" sortKeyName="destination" />}
                  {show("departure") && <SortableHeader label="Departure" sortKeyName="departure" />}
                  {show("return") && <SortableHeader label="Return" sortKeyName="return" />}
                  {show("vrDate") && <SortableHeader label="VR Date" sortKeyName="vrDate" />}
                  {show("submitted") && <SortableHeader label="Clearance Submitted" sortKeyName="submitted" />}
                  {show("receipts") && <th>Receipts</th>}
                  {show("advAmount") && <SortableHeader label="Adv Amount" sortKeyName="advAmount" />}
                  {show("clearedAmount") && <SortableHeader label="Cleared Amount" sortKeyName="clearedAmount" />}
                  {show("toBeExpensed") && <SortableHeader label="Amount To Be Expensed" sortKeyName="toBeExpensed" />}
                  {show("salaryDeduction") && <SortableHeader label="Salary Deduction" sortKeyName="salaryDeduction" />}
                  {show("payable") && <SortableHeader label="Payable" sortKeyName="payable" />}
                  {show("status") && <SortableHeader label="Status" sortKeyName="status" />}
                </tr>
              </thead>
              <tbody>
                {paged.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 600, fontSize: "0.87rem" }}>{item.employee_name || "—"}</td>
                    {show("empNo") && <td style={{ color: "var(--muted)", fontSize: 13 }}>{item.employee_no || "—"}</td>}
                    {show("division") && <td style={{ fontSize: 13 }}>{item.org_division || "—"}</td>}
                    {show("department") && <td style={{ fontSize: 13 }}>{item.department_name || "—"}</td>}
                    {show("dutyStation") && <td style={{ fontSize: 13 }}>{item.duty_station || "—"}</td>}
                    {show("origin") && <td style={{ fontSize: 13 }}>{item.origin || "—"}</td>}
                    {show("destination") && <td style={{ fontSize: 13 }}>{item.destination || "—"}</td>}
                    {show("departure") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{fmtDate(item.departure_date)}</td>}
                    {show("return") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{fmtDate(item.return_date)}</td>}
                    {show("vrDate") && <td style={{ fontSize: 13 }}>{fmtDate(item.vr_date)}</td>}
                    {show("submitted") && <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>{fmtDate(item.clearance_submitted_at)}</td>}
                    {show("receipts") && <td>{item.has_receipts
                      ? <span style={{ color: "#065f46", fontWeight: 600, fontSize: 12 }}>Yes</span>
                      : <span style={{ color: "var(--muted)", fontSize: 12 }}>No</span>}
                    </td>}
                    {show("advAmount") && <td style={{ fontWeight: 600 }}>{formatMoney(item.advance_amount, item.currency)}</td>}
                    {show("clearedAmount") && <td style={{ fontWeight: 600 }}>{formatMoney(item.cleared_amount, item.currency)}</td>}
                    {show("toBeExpensed") && <td>{formatMoney(item.amount_to_be_expensed, item.currency)}</td>}
                    {show("salaryDeduction") && (
                      <td style={{ color: Number(item.salary_deduction) > 0 ? "#dc2626" : "var(--muted)", fontWeight: 600 }}>
                        {formatMoney(item.salary_deduction, item.currency)}
                      </td>
                    )}
                    {show("payable") && (
                      <td style={{ color: Number(item.payable) > 0 ? "#059669" : "var(--muted)", fontWeight: 600 }}>
                        {formatMoney(item.payable, item.currency)}
                      </td>
                    )}
                    {show("status") && (
                      <td>
                        <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: "#f1f5f9", color: "#475569", whiteSpace: "nowrap" }}>
                          {STATUS_LABEL[item.status] || item.status}
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
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
              {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 7).map((n) => (
                <button key={n} className={`button small-button ${currentPage === n ? "button-primary" : "button-subtle"}`} onClick={() => setPage(n)}>{n}</button>
              ))}
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
