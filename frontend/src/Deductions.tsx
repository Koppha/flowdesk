import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken } from "./api";
import { formatMoney, isFinanceDeptClient } from "./constants";
import {
  Clock, Wallet, HandCoins, CheckCircle2, Search, MoreHorizontal,
  ChevronLeft, ChevronRight, Download, ArrowUpDown, FolderSearch, X, Check
} from "lucide-react";

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
  destination: string | null;
  month: string | null;
  vr_date: string | null;
  has_receipts: boolean;
  advance_amount: string | number;
  cleared_amount: string | number;
  amount_to_be_expensed: string | number;
  salary_deduction: string | number;
  payable: string | number;
  deducted_at: string | null;
  deducted_by_name: string | null;
  closed_at: string | null;
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

type SortKey = "name" | "empNo" | "division" | "destination" | "vrDate" | "advAmount" | "clearedAmount" | "toBeExpensed" | "salaryDeduction" | "payable" | "status";

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
  const [search, setSearch] = useState("");
  const [filterDivision, setFilterDivision] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("vrDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

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
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  const stats = useMemo(() => {
    const pendingDeduction = items.filter((i) => !i.deducted_at && Number(i.salary_deduction || 0) > 0);
    const pendingPayable = items.filter((i) => !i.deducted_at && Number(i.payable || 0) > 0);
    const deductedThisMonth = items.filter((i) => i.deducted_at && isThisMonth(i.deducted_at));
    const sum = (arr: DeductionItem[], key: "salary_deduction" | "payable") => arr.reduce((s, i) => s + Number(i[key] || 0), 0);
    return {
      pendingDeductionCount: pendingDeduction.length,
      pendingDeductionValue: sum(pendingDeduction, "salary_deduction"),
      pendingPayableCount: pendingPayable.length,
      pendingPayableValue: sum(pendingPayable, "payable"),
      deductedCount: deductedThisMonth.length,
      deductedValue: sum(deductedThisMonth, "salary_deduction") + sum(deductedThisMonth, "payable")
    };
  }, [items]);

  const uniqueDivisions = useMemo(() => Array.from(new Set(items.map((i) => i.division_name).filter(Boolean))).sort() as string[], [items]);

  const tabFiltered = useMemo(() => {
    if (tab === "all") return items;
    if (tab === "deducted") return items.filter((i) => rowStatus(i) === "DEDUCTED");
    return items.filter((i) => rowStatus(i) === "PENDING");
  }, [items, tab]);

  const filtered = useMemo(() => {
    return tabFiltered.filter((i) => {
      if (filterDivision && i.division_name !== filterDivision) return false;
      if (dateFrom && (!i.closed_at || i.closed_at < dateFrom)) return false;
      if (dateTo && (!i.closed_at || i.closed_at > dateTo)) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          (i.employee_name || "").toLowerCase().includes(q) ||
          (i.employee_no || "").toLowerCase().includes(q) ||
          (i.division_name || "").toLowerCase().includes(q) ||
          (i.destination || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [tabFiltered, filterDivision, dateFrom, dateTo, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      switch (sortKey) {
        case "name": return (a.employee_name || "").localeCompare(b.employee_name || "") * dir;
        case "empNo": return (a.employee_no || "").localeCompare(b.employee_no || "") * dir;
        case "division": return (a.division_name || "").localeCompare(b.division_name || "") * dir;
        case "destination": return (a.destination || "").localeCompare(b.destination || "") * dir;
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
    const headers = ["Name", "Emp No", "Division", "Destination", "VR Date", "Receipts", "Adv Amount", "Cleared Amount", "Amount To Be Expensed", "Salary Deduction", "Payable", "Status"];
    const rows = sorted.map((i) => [
      i.employee_name || "", i.employee_no || "", i.division_name || "", i.destination || "",
      fmtDate(i.vr_date), i.has_receipts ? "Yes" : "No",
      Number(i.advance_amount || 0).toFixed(2), Number(i.cleared_amount || 0).toFixed(2),
      Number(i.amount_to_be_expensed || 0).toFixed(2), Number(i.salary_deduction || 0).toFixed(2),
      Number(i.payable || 0).toFixed(2), STATUS_LABEL[rowStatus(i)]
    ]);
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
            <div className="ep-kpi-subvalue">{formatMoney(stats.pendingDeductionValue)}</div>
          </div>
        </div>
        <div className="ep-kpi ep-kpi-gold">
          <div className="ep-kpi-icon"><HandCoins size={26} /></div>
          <div>
            <div className="ep-kpi-value">{stats.pendingPayableCount}</div>
            <div className="ep-kpi-label">Pending Payables</div>
            <div className="ep-kpi-subvalue">{formatMoney(stats.pendingPayableValue)}</div>
          </div>
        </div>
        <div className="ep-kpi ep-kpi-green">
          <div className="ep-kpi-icon"><CheckCircle2 size={26} /></div>
          <div>
            <div className="ep-kpi-value">{stats.deductedCount}</div>
            <div className="ep-kpi-label">Deducted (This Month)</div>
            <div className="ep-kpi-subvalue">{formatMoney(stats.deductedValue)}</div>
          </div>
        </div>
        <div className="ep-kpi ep-kpi-purple">
          <div className="ep-kpi-icon"><Wallet size={26} /></div>
          <div>
            <div className="ep-kpi-value">{formatMoney(stats.pendingDeductionValue + stats.pendingPayableValue)}</div>
            <div className="ep-kpi-label">Total Outstanding</div>
            <div className="ep-kpi-subvalue">Across {stats.pendingDeductionCount + stats.pendingPayableCount} claims</div>
          </div>
        </div>
      </div>

      <div className="ep-tabs">
        {([
          { key: "pending", label: "Pending", count: items.filter((i) => rowStatus(i) === "PENDING").length },
          { key: "deducted", label: "Deducted", count: items.filter((i) => rowStatus(i) === "DEDUCTED").length },
          { key: "all", label: "All Claims", count: items.length }
        ] as const).map((t) => (
          <button key={t.key} type="button" className={`ep-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => { setTab(t.key); setPage(1); }}>
            {t.label} <span className="inbox-count-chip">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div className="ded-filter-bar" style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px" }}>
            <Search size={14} />
            <input placeholder="Search name, emp no, division, destination…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="ep-form-select" value={filterDivision} onChange={(e) => { setFilterDivision(e.target.value); setPage(1); }} style={{ minWidth: 160 }}>
            <option value="">All Divisions</option>
            {uniqueDivisions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <input type="date" className="ep-form-select" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} title="Closed from" />
          <input type="date" className="ep-form-select" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} title="Closed to" />
          {(search || filterDivision || dateFrom || dateTo) && (
            <button className="ep-btn-outline" onClick={() => { setSearch(""); setFilterDivision(""); setDateFrom(""); setDateTo(""); setPage(1); }}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {sorted.length === 0 ? (
            <div className="ep-empty ded-empty">
              <span className="ded-empty-icon"><FolderSearch size={26} /></span>
              <p><strong>No settled clearances match your filters.</strong></p>
              <p className="ded-empty-hint">Try adjusting your search criteria or filters.</p>
            </div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <SortableHeader label="Name" sortKeyName="name" />
                  <SortableHeader label="Emp. No" sortKeyName="empNo" />
                  <SortableHeader label="Division" sortKeyName="division" />
                  <SortableHeader label="Destination" sortKeyName="destination" />
                  <SortableHeader label="VR Date" sortKeyName="vrDate" />
                  <th>Receipts</th>
                  <SortableHeader label="Adv Amount" sortKeyName="advAmount" />
                  <SortableHeader label="Cleared Amount" sortKeyName="clearedAmount" />
                  <SortableHeader label="Amount To Be Expnsd" sortKeyName="toBeExpensed" />
                  <SortableHeader label="Salary Deduction" sortKeyName="salaryDeduction" />
                  <SortableHeader label="Payable" sortKeyName="payable" />
                  <SortableHeader label="Status" sortKeyName="status" />
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
                      <td style={{ color: "var(--muted)", fontSize: 13 }}>{item.employee_no || "—"}</td>
                      <td style={{ color: "var(--muted)", fontSize: 13 }}>{item.division_name || "—"}</td>
                      <td style={{ fontSize: 13 }}>{item.destination || "—"}</td>
                      <td style={{ fontSize: 13 }}>{fmtDate(item.vr_date)}</td>
                      <td>{item.has_receipts
                        ? <span style={{ color: "#065f46", fontWeight: 600, fontSize: 12 }}>Yes</span>
                        : <span style={{ color: "var(--muted)", fontSize: 12 }}>No</span>}
                      </td>
                      <td style={{ fontWeight: 600 }}>{Number(item.advance_amount || 0).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={{ fontWeight: 600 }}>{Number(item.cleared_amount || 0).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td>{Number(item.amount_to_be_expensed || 0).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={{ color: Number(item.salary_deduction) > 0 ? "#dc2626" : "var(--muted)", fontWeight: 600 }}>
                        {Number(item.salary_deduction || 0).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td style={{ color: Number(item.payable) > 0 ? "#059669" : "var(--muted)", fontWeight: 600 }}>
                        {Number(item.payable || 0).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td><StatusBadge status={status} /></td>
                      <td className="ep-dropdown-wrap">
                        {actionable && (
                          <button
                            className="ep-icon-btn"
                            onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === item.id ? null : item.id); }}
                            aria-label="Row actions"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        )}
                        {openMenuId === item.id && (
                          <div className="ep-dropdown" onClick={(e) => e.stopPropagation()}>
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
                          </div>
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
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
