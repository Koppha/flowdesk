import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, getUserFromToken } from "./api";
import { formatMoney, isFinanceDeptClient } from "./constants";
import {
  Clock, Wallet, HandCoins, CheckCircle2, MoreHorizontal,
  ChevronLeft, ChevronRight, Download, ArrowUpDown, FolderSearch, X, Check,
  Building2, Users, FileText, Hourglass
} from "lucide-react";
import { BusinessUnitTabs, IconTabRow, FinanceFilterBar, FilterField, SearchField, FinanceEmptyState, type BusinessUnit, ColumnChooser, useColumnVisibility, type ColumnOption } from "./components/FinanceQueueKit";

const STATUS_STYLE: Record<string, [string, string]> = {
  DEDUCTED:  ["#d1fae5", "#065f46"],
  PENDING:   ["#fef3c7", "#92400e"],
  NO_ACTION: ["#f1f5f9", "#64748b"]
};

const STATUS_LABEL: Record<string, string> = {
  DEDUCTED: "Deducted",
  PENDING: "Pending",
  NO_ACTION: "No action needed"
};

interface DeductionItem {
  id: string;
  employee_id: string;
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
  month: string | null;
  // VR Date = when the advance this clears was approved.
  vr_date: string | null;
  clearance_submitted_at: string | null;
  has_receipts: boolean;
  advance_amount: string | number;
  cleared_amount: string | number;
  amount_to_be_expensed: string | number;
  salary_deduction: string | number;
  payable: string | number;
  deducted_at: string | null;
  deducted_by_name: string | null;
  closed_at: string | null;
  currency: string | null;
}

// Groups amounts by currency rather than blending e.g. LSL and USD claims
// into one number under a single (arbitrary) currency symbol.
function sumByCurrency(items: DeductionItem[], keys: Array<"salary_deduction" | "payable">) {
  const totals = new Map<string, number>();
  for (const i of items) {
    const currency = i.currency || "LSL";
    const value = keys.reduce((s, key) => s + Number(i[key] || 0), 0);
    totals.set(currency, (totals.get(currency) || 0) + value);
  }
  return Array.from(totals.entries());
}

function CurrencyBreakdown({ byCurrency }: { byCurrency: Array<[string, number]> }) {
  if (byCurrency.length === 0) return <div className="ep-kpi-subvalue">{formatMoney(0)}</div>;
  return <>{byCurrency.map(([currency, value]) => <div key={currency} className="ep-kpi-subvalue">{formatMoney(value, currency)}</div>)}</>;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function isThisMonth(s: string | null | undefined) {
  if (!s) return false;
  const d = new Date(s);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function rowStatus(item: DeductionItem): "DEDUCTED" | "PENDING" | "NO_ACTION" {
  if (item.deducted_at) return "DEDUCTED";
  const owed = Number(item.salary_deduction || 0) > 0 || Number(item.payable || 0) > 0;
  return owed ? "PENDING" : "NO_ACTION";
}

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{STATUS_LABEL[status] || status}</span>;
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

export default function Deductions() {
  // Viewing this page can be granted to any group (e.g. HR Operations, for
  // visibility only) via the Deductions feature permission; actually
  // recording a deduction stays restricted to Finance dept / ADMIN, mirrored
  // server-side in the PATCH /:id/deducted gate.
  const me = getUserFromToken();
  const canAct = me?.role === "ADMIN" || isFinanceDeptClient(me?.department || "");

  const [items, setItems] = useState<DeductionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [tab, setTab] = useState<"pending" | "deducted" | "all">("pending");
  // Company filter (MNO / SEFS / HigherLife) - same fixed set and pattern as
  // Payments and the Capture Inbox, replacing the old free-text division
  // dropdown so this page's filtering is consistent across admin screens.
  const [companyFilter, setCompanyFilter] = useState<BusinessUnit>("ALL");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("vrDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const columns = useColumnVisibility("finance-columns:deductions");
  const show = columns.show;

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);

  async function refresh() {
    setError(null);
    try {
      const resp = await api.deductions();
      setItems(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    function closeMenu() { setOpenMenuId(null); }
    window.addEventListener("click", closeMenu);
    // The menu is portaled to <body> with a fixed position computed from the
    // trigger button's rect, so it won't track the table's own scrolling —
    // close it instead of letting it drift away from the button.
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, []);

  const stats = useMemo(() => {
    const pendingDeduction = items.filter((i) => !i.deducted_at && Number(i.salary_deduction || 0) > 0);
    const pendingPayable = items.filter((i) => !i.deducted_at && Number(i.payable || 0) > 0);
    const deductedThisMonth = items.filter((i) => i.deducted_at && isThisMonth(i.deducted_at));
    const outstanding = items.filter((i) => !i.deducted_at && (Number(i.salary_deduction || 0) > 0 || Number(i.payable || 0) > 0));
    return {
      pendingDeductionCount: pendingDeduction.length,
      pendingDeductionByCurrency: sumByCurrency(pendingDeduction, ["salary_deduction"]),
      pendingPayableCount: pendingPayable.length,
      pendingPayableByCurrency: sumByCurrency(pendingPayable, ["payable"]),
      deductedCount: deductedThisMonth.length,
      deductedByCurrency: sumByCurrency(deductedThisMonth, ["salary_deduction", "payable"]),
      outstandingCount: outstanding.length,
      outstandingByCurrency: sumByCurrency(outstanding, ["salary_deduction", "payable"])
    };
  }, [items]);

  const companyCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: items.length, MNO: 0, SEFS: 0, HigherLife: 0 };
    for (const i of items) {
      if (i.division_name && i.division_name in counts) counts[i.division_name]++;
    }
    return counts;
  }, [items]);

  const tabFiltered = useMemo(() => {
    if (tab === "all") return items;
    if (tab === "deducted") return items.filter((i) => rowStatus(i) === "DEDUCTED");
    return items.filter((i) => rowStatus(i) === "PENDING");
  }, [items, tab]);

  const filtered = useMemo(() => {
    return tabFiltered.filter((i) => {
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
  }, [tabFiltered, companyFilter, dateFrom, dateTo, search]);

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
        case "status": return rowStatus(a).localeCompare(rowStatus(b)) * dir;
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

  async function toggleDeducted(item: DeductionItem, deducted: boolean) {
    setBusyId(item.id);
    setError(null);
    try {
      await api.setDeductionActioned(item.id, deducted);
      await refresh();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusyId(null);
      setOpenMenuId(null);
    }
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
      ["salaryDeduction", "Refund Proof", (i) => String(Number(i.salary_deduction || 0) > 0 ? (i.has_receipts ? "Yes" : "No") : "")],
      ["payable", "Payable", (i) => String(Number(i.payable || 0).toFixed(2))],
      ["status", "Status", (i) => String(STATUS_LABEL[rowStatus(i)])],
    ];
    const csvColumns = allCsvColumns.filter(([key]) => key === "*" || show(key));
    const headers = csvColumns.map(([, h]) => h);
    const rows = sorted.map((i) => csvColumns.map(([, , f]) => f(i)));
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `deductions-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  const SortableHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(sortKeyName)}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label} <ArrowUpDown size={12} style={{ opacity: sortKey === sortKeyName ? 1 : 0.35 }} />
      </span>
    </th>
  );

  if (loading) return <div className="ep-page"><p>Loading deductions…</p></div>;

  return (
    <div className="ep-page deductions-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Deductions</h1>
          <p className="ep-subtitle">Subsistence clearance settlements requiring a salary deduction or payable amount.</p>
        </div>
        <div className="ep-actions">
          <ColumnChooser columns={COLUMNS} show={columns.show} toggle={columns.toggle} reset={columns.reset} />
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!sorted.length}>
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div className="ep-kpi-row">
        <div className="ep-kpi ep-kpi-blue">
          <div className="ep-kpi-icon"><Clock size={26} /></div>
          <div>
            <div className="ep-kpi-value">{stats.pendingDeductionCount}</div>
            <div className="ep-kpi-label">Pending Salary Deductions</div>
            <CurrencyBreakdown byCurrency={stats.pendingDeductionByCurrency} />
          </div>
        </div>
        <div className="ep-kpi ep-kpi-gold">
          <div className="ep-kpi-icon"><HandCoins size={26} /></div>
          <div>
            <div className="ep-kpi-value">{stats.pendingPayableCount}</div>
            <div className="ep-kpi-label">Pending Payables</div>
            <CurrencyBreakdown byCurrency={stats.pendingPayableByCurrency} />
          </div>
        </div>
        <div className="ep-kpi ep-kpi-green">
          <div className="ep-kpi-icon"><CheckCircle2 size={26} /></div>
          <div>
            <div className="ep-kpi-value">{stats.deductedCount}</div>
            <div className="ep-kpi-label">Deducted (This Month)</div>
            <CurrencyBreakdown byCurrency={stats.deductedByCurrency} />
          </div>
        </div>
        <div className="ep-kpi ep-kpi-purple">
          <div className="ep-kpi-icon"><Wallet size={26} /></div>
          <div>
            {stats.outstandingByCurrency.length === 0
              ? <div className="ep-kpi-value">{formatMoney(0)}</div>
              : stats.outstandingByCurrency.map(([currency, value]) => <div key={currency} className="ep-kpi-value">{formatMoney(value, currency)}</div>)}
            <div className="ep-kpi-label">Total Outstanding</div>
            <div className="ep-kpi-subvalue">Across {stats.outstandingCount} claims</div>
          </div>
        </div>
      </div>

      <BusinessUnitTabs value={companyFilter} onChange={(v) => { setCompanyFilter(v); setPage(1); }} counts={companyCounts} icon={Building2} allIcon={Users} />

      <IconTabRow
        value={tab}
        onChange={(v) => { setTab(v); setPage(1); }}
        tabs={[
          { key: "pending", label: "Pending", count: items.filter((i) => rowStatus(i) === "PENDING").length, icon: Hourglass },
          { key: "deducted", label: "Deducted", count: items.filter((i) => rowStatus(i) === "DEDUCTED").length, icon: CheckCircle2 },
          { key: "all", label: "All Claims", count: items.length, icon: FileText }
        ]}
      />

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
            <FinanceEmptyState icon={FolderSearch} title="No settled clearances match your filters." hint="Try adjusting your search criteria or filters." />
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
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {paged.map((item) => {
                  const status = rowStatus(item);
                  const actionable = status !== "NO_ACTION" && canAct;
                  return (
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
                          {Number(item.salary_deduction) > 0 && (
                            <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2, color: item.has_receipts ? "#065f46" : "#b45309" }}>
                              {item.has_receipts ? "Refund proof attached" : "No refund proof"}
                            </div>
                          )}
                        </td>
                      )}
                      {show("payable") && (
                        <td style={{ color: Number(item.payable) > 0 ? "#059669" : "var(--muted)", fontWeight: 600 }}>
                          {formatMoney(item.payable, item.currency)}
                        </td>
                      )}
                      {show("status") && <td><StatusBadge status={status} /></td>}
                      <td className="ep-dropdown-wrap">
                        {actionable && (
                          <button
                            className="ep-icon-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (openMenuId === item.id) { setOpenMenuId(null); return; }
                              const rect = e.currentTarget.getBoundingClientRect();
                              setMenuAnchor({ top: rect.bottom + 6, left: rect.right - 180 });
                              setOpenMenuId(item.id);
                            }}
                            aria-label="Row actions"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        )}
                        {openMenuId === item.id && menuAnchor && createPortal(
                          <div
                            className="ep-dropdown ep-dropdown-portal"
                            style={{ top: menuAnchor.top, left: Math.max(8, menuAnchor.left) }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {status === "PENDING" && (
                              <button className="ep-dropdown-item" onClick={() => toggleDeducted(item, true)} disabled={busyId === item.id}>
                                <Check size={14} style={{ marginRight: 6 }} /> Mark as Deducted
                              </button>
                            )}
                            {status === "DEDUCTED" && (
                              <button className="ep-dropdown-item" onClick={() => toggleDeducted(item, false)} disabled={busyId === item.id}>
                                <X size={14} style={{ marginRight: 6 }} /> Undo
                              </button>
                            )}
                          </div>,
                          document.body
                        )}
                      </td>
                    </tr>
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
