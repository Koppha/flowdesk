import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Clock, CheckCircle2, ChevronLeft, ChevronRight, Download, ArrowUpDown, FolderSearch, Eye, Building2, Users, FileText, Shield, PhoneCall, Hourglass } from "lucide-react";
import {
  BusinessUnitTabs, FinanceFilterBar, FilterField, SearchField, SelectField, FinanceEmptyState,
  FinanceKpiRow, FinanceKpiTile, FinancePageHeader, type BusinessUnit
} from "./components/FinanceQueueKit";

// Overtime, Standby, and Standby Call-Out claims all land here once their
// approval chain is fully complete — status AWAITING_TREASURY — and stay
// visible (as CLOSED) once Treasury actually closes them. This queue never
// itself closes anything; clicking a row opens the dedicated Treasury detail
// screen (CompensationClaimDetail.tsx) where Close Claim actually happens.

const TYPE_LABEL: Record<string, string> = { OVERTIME: "Overtime", STANDBY: "Standby", CALL_OUT: "Call-Out" };
const TYPE_STYLE: Record<string, [string, string]> = {
  OVERTIME: ["#fef3c7", "#92400e"],
  STANDBY: ["#e0e7ff", "#4338ca"],
  CALL_OUT: ["#fce7f3", "#9d174d"]
};

const STATUS_STYLE: Record<string, [string, string]> = {
  CLOSED: ["#d1fae5", "#065f46"],
  AWAITING_TREASURY: ["#fef3c7", "#92400e"]
};
const STATUS_LABEL: Record<string, string> = { CLOSED: "Closed", AWAITING_TREASURY: "Awaiting Treasury" };

interface CompClaimItem {
  claim_type: "OVERTIME" | "STANDBY" | "CALL_OUT";
  id: string;
  claim_no: string;
  employee_name: string | null;
  employee_no: string | null;
  division_name: string | null;
  department: string | null;
  section_name: string | null;
  hours: string | number;
  equivalent_days: string | number | null;
  detail: string | null;
  status: "AWAITING_TREASURY" | "CLOSED";
  submitted_at: string | null;
  closed_at: string | null;
}

const ALL_OPTION = { value: "ALL", label: "All" };

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

function TypeBadge({ type }: { type: string }) {
  const [bg, color] = TYPE_STYLE[type] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{TYPE_LABEL[type] || type}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{STATUS_LABEL[status] || status}</span>;
}

type SortKey = "type" | "name" | "empNo" | "hours" | "submittedAt" | "status";
const PAGE_SIZE_OPTIONS = [10, 25, 50];

export default function CompensationClaims({ onOpen }: { onOpen: (claimType: string, id: string) => void }) {
  const [items, setItems] = useState<CompClaimItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<"awaiting" | "closed" | "all">("awaiting");
  const [typeFilter, setTypeFilter] = useState<"ALL" | "OVERTIME" | "STANDBY" | "CALL_OUT">("ALL");
  const [companyFilter, setCompanyFilter] = useState<BusinessUnit>("ALL");
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [sectionFilter, setSectionFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("submittedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  async function refresh() {
    setError(null);
    try {
      const resp = await api.compensationClaims();
      setItems(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  // Business Unit tabs partition the whole page — everything below (KPIs,
  // dropdown filters, table) works within the selected company.
  const companyFiltered = useMemo(
    () => (companyFilter === "ALL" ? items : items.filter((i) => i.division_name === companyFilter)),
    [items, companyFilter]
  );

  const companyCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: items.length, MNO: 0, SEFS: 0, HigherLife: 0 };
    for (const i of items) {
      if (i.division_name && i.division_name in counts) counts[i.division_name]++;
    }
    return counts;
  }, [items]);

  // KPI tiles summarize the selected Business Unit as a whole — independent
  // of the Type/Status/date/search filters below, so they stay a stable
  // "at a glance" overview while those filters only narrow the table.
  const stats = useMemo(() => {
    const byType = (type: string) => companyFiltered.filter((i) => i.claim_type === type);
    const sumHours = (list: CompClaimItem[]) => list.reduce((s, i) => s + Number(i.hours || 0), 0);
    const awaiting = companyFiltered.filter((i) => i.status === "AWAITING_TREASURY");
    const closedThisMonth = companyFiltered.filter((i) => i.status === "CLOSED" && isThisMonth(i.closed_at));
    const overtime = byType("OVERTIME");
    const standby = byType("STANDBY");
    const callout = byType("CALL_OUT");
    return {
      awaitingCount: awaiting.length, awaitingHours: sumHours(awaiting),
      closedCount: closedThisMonth.length, closedHours: sumHours(closedThisMonth),
      totalCount: companyFiltered.length, totalHours: sumHours(companyFiltered),
      overtimeCount: overtime.length, overtimeHours: sumHours(overtime),
      standbyCount: standby.length, standbyHours: sumHours(standby),
      calloutCount: callout.length, calloutHours: sumHours(callout)
    };
  }, [companyFiltered]);

  const departmentOptions = useMemo(
    () => [ALL_OPTION, ...Array.from(new Set(companyFiltered.map((i) => i.department).filter(Boolean) as string[])).sort().map((d) => ({ value: d, label: d }))],
    [companyFiltered]
  );
  const sectionOptions = useMemo(
    () => [ALL_OPTION, ...Array.from(new Set(companyFiltered.map((i) => i.section_name).filter(Boolean) as string[])).sort().map((s) => ({ value: s, label: s }))],
    [companyFiltered]
  );

  const tabFiltered = useMemo(() => {
    if (tab === "all") return companyFiltered;
    if (tab === "closed") return companyFiltered.filter((i) => i.status === "CLOSED");
    return companyFiltered.filter((i) => i.status === "AWAITING_TREASURY");
  }, [companyFiltered, tab]);

  const filtered = useMemo(() => {
    return tabFiltered.filter((i) => {
      if (typeFilter !== "ALL" && i.claim_type !== typeFilter) return false;
      if (departmentFilter !== "ALL" && i.department !== departmentFilter) return false;
      if (sectionFilter !== "ALL" && i.section_name !== sectionFilter) return false;
      if (dateFrom && (!i.submitted_at || i.submitted_at < dateFrom)) return false;
      if (dateTo && (!i.submitted_at || i.submitted_at > dateTo)) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          (i.employee_name || "").toLowerCase().includes(q) ||
          (i.employee_no || "").toLowerCase().includes(q) ||
          (i.claim_no || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [tabFiltered, typeFilter, departmentFilter, sectionFilter, dateFrom, dateTo, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      switch (sortKey) {
        case "type": return a.claim_type.localeCompare(b.claim_type) * dir;
        case "name": return (a.employee_name || "").localeCompare(b.employee_name || "") * dir;
        case "empNo": return (a.employee_no || "").localeCompare(b.employee_no || "") * dir;
        case "hours": return (Number(a.hours) - Number(b.hours)) * dir;
        case "status": return a.status.localeCompare(b.status) * dir;
        case "submittedAt":
        default: {
          const av = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
          const bv = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
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
    const headers = ["Type", "Claim No", "Employee", "Emp No", "Business Unit", "Detail", "Hours", "Equivalent Days", "Submitted", "Status", "Closed"];
    const rows = sorted.map((i) => [
      TYPE_LABEL[i.claim_type], i.claim_no, i.employee_name || "", i.employee_no || "", i.division_name || "", i.detail || "",
      i.hours, i.equivalent_days ?? "", fmtDate(i.submitted_at), STATUS_LABEL[i.status], fmtDate(i.closed_at)
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `compensation-claims-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  const SortableHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(sortKeyName)}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label} <ArrowUpDown size={12} style={{ opacity: sortKey === sortKeyName ? 1 : 0.35 }} />
      </span>
    </th>
  );

  if (loading) return <div className="ep-page"><p>Loading compensation claims…</p></div>;

  return (
    <div className="ep-page deductions-page">
      <FinancePageHeader
        icon={FileText}
        title="Compensation Claims"
        subtitle="Review approved Standby, Overtime, and Call-Out claims. Take the approved hours for payroll processing."
        actions={
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!sorted.length}>
            <Download size={14} /> Export
          </button>
        }
      />

      {error && <pre className="inbox-error">{error}</pre>}

      <FinanceKpiRow>
        <FinanceKpiTile icon={Hourglass} value={stats.awaitingCount} label="Awaiting Treasury" sub={`${stats.awaitingHours.toFixed(2)} hours`} tint="#dbeafe" color="#1e40af" />
        <FinanceKpiTile icon={CheckCircle2} value={stats.closedCount} label="Closed (This Month)" sub={`${stats.closedHours.toFixed(2)} hours`} tint="#d1fae5" color="#065f46" />
        <FinanceKpiTile icon={FolderSearch} value={stats.totalCount} label="Total Claims" sub={`${stats.totalHours.toFixed(2)} hours`} tint="#ede9fe" color="#5b21b6" />
        <FinanceKpiTile icon={Clock} value={stats.overtimeCount} label="Overtime" sub={`${stats.overtimeHours.toFixed(2)} hours`} tint="#fef3c7" color="#92400e" />
        <FinanceKpiTile icon={Shield} value={stats.standbyCount} label="Standby" sub={`${stats.standbyHours.toFixed(2)} hours`} tint="#e0e7ff" color="#4338ca" />
        <FinanceKpiTile icon={PhoneCall} value={stats.calloutCount} label="Call-Out" sub={`${stats.calloutHours.toFixed(2)} hours`} tint="#fce7f3" color="#9d174d" />
      </FinanceKpiRow>

      {/* Business Unit tabs — counts show total claims per business unit. */}
      <BusinessUnitTabs value={companyFilter} onChange={(v) => { setCompanyFilter(v); setPage(1); }} counts={companyCounts} icon={Building2} allIcon={Users} />

      <FinanceFilterBar
        showReset={Boolean(search || typeFilter !== "ALL" || departmentFilter !== "ALL" || sectionFilter !== "ALL" || tab !== "awaiting" || dateFrom || dateTo)}
        onReset={() => {
          setSearch(""); setTypeFilter("ALL"); setDepartmentFilter("ALL"); setSectionFilter("ALL");
          setTab("awaiting"); setDateFrom(""); setDateTo(""); setPage(1);
        }}
      >
        <SearchField label="Search" placeholder="Search by employee, claim no. or section…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
        <SelectField label="Department" value={departmentFilter} onChange={(v) => { setDepartmentFilter(v); setPage(1); }} options={departmentOptions} />
        <SelectField label="Section" value={sectionFilter} onChange={(v) => { setSectionFilter(v); setPage(1); }} options={sectionOptions} />
        <SelectField
          label="Type"
          value={typeFilter}
          onChange={(v) => { setTypeFilter(v as typeof typeFilter); setPage(1); }}
          options={[ALL_OPTION, { value: "OVERTIME", label: "Overtime" }, { value: "STANDBY", label: "Standby" }, { value: "CALL_OUT", label: "Call-Out" }]}
        />
        <SelectField
          label="Status"
          value={tab}
          onChange={(v) => { setTab(v as typeof tab); setPage(1); }}
          options={[{ value: "awaiting", label: "Awaiting Treasury" }, { value: "closed", label: "Closed" }, { value: "all", label: "All Claims" }]}
        />
        <FilterField label="Period From">
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
        </FilterField>
        <FilterField label="Period To">
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
        </FilterField>
      </FinanceFilterBar>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {sorted.length === 0 ? (
            <FinanceEmptyState icon={FolderSearch} title="No claims match your filters." hint="Try adjusting your search criteria or filters." />
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <SortableHeader label="Type" sortKeyName="type" />
                  <th>Claim No.</th>
                  <SortableHeader label="Employee" sortKeyName="name" />
                  <th>Section</th>
                  <th>Period</th>
                  <SortableHeader label="Hours" sortKeyName="hours" />
                  <SortableHeader label="Submitted" sortKeyName="submittedAt" />
                  <SortableHeader label="Status" sortKeyName="status" />
                  <th style={{ width: 50 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((item) => (
                  <tr key={item.id} style={{ cursor: "pointer" }} onClick={() => onOpen(item.claim_type, item.id)}>
                    <td><TypeBadge type={item.claim_type} /></td>
                    <td style={{ fontWeight: 600, fontSize: "0.87rem", color: "#1d4ed8" }}>{item.claim_no}</td>
                    <td style={{ fontWeight: 600, fontSize: "0.87rem" }}>{item.employee_name || "—"}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{item.department || "—"}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{item.detail || "—"}</td>
                    <td style={{ fontWeight: 600 }}>{Number(item.hours).toFixed(1)}</td>
                    <td style={{ fontSize: 13 }}>{fmtDate(item.submitted_at)}</td>
                    <td><StatusBadge status={item.status} /></td>
                    <td>
                      <button className="ep-icon-btn" aria-label="View claim" onClick={(e) => { e.stopPropagation(); onOpen(item.claim_type, item.id); }}>
                        <Eye size={16} />
                      </button>
                    </td>
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
