import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, getUserFromToken } from "./api";
import { formatMoney, isFinanceDeptClient } from "./constants";
import {
  Clock, Wallet, CheckCircle2, MoreHorizontal,
  ChevronLeft, ChevronRight, Download, ArrowUpDown, FolderSearch, X, Check,
  Building2, Users, FileText, Hourglass
} from "lucide-react";
import { BusinessUnitTabs, IconTabRow, FinanceFilterBar, FilterField, SearchField, FinanceEmptyState, type BusinessUnit } from "./components/FinanceQueueKit";

// Refundable is the opposite of Deductions: closed clearance claims where
// the claimant spent more of their own money on the trip than they were
// advanced (balance_amount < 0), so the company owes them a refund rather
// than the other way around. Mirrors Deductions.tsx's structure closely.

const STATUS_STYLE: Record<string, [string, string]> = {
  REFUNDED:  ["#d1fae5", "#065f46"],
  PENDING:   ["#fef3c7", "#92400e"]
};

const STATUS_LABEL: Record<string, string> = {
  REFUNDED: "Refunded",
  PENDING: "Pending"
};

interface RefundableItem {
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
  refundable_amount: string | number;
  refunded_at: string | null;
  refunded_by_name: string | null;
  closed_at: string | null;
  currency: string | null;
}

function sumByCurrency(items: RefundableItem[]) {
  const totals = new Map<string, number>();
  for (const i of items) {
    const currency = i.currency || "LSL";
    totals.set(currency, (totals.get(currency) || 0) + Number(i.refundable_amount || 0));
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

function rowStatus(item: RefundableItem): "REFUNDED" | "PENDING" {
  return item.refunded_at ? "REFUNDED" : "PENDING";
}

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{STATUS_LABEL[status] || status}</span>;
}

type SortKey = "name" | "empNo" | "division" | "destination" | "vrDate" | "advAmount" | "clearedAmount" | "toBeExpensed" | "refundable" | "status";

const PAGE_SIZE_OPTIONS = [10, 25, 50];

export default function Refundable() {
  // Viewing this page can be granted to any group (e.g. HR Operations, for
  // visibility only) via the Refundable feature permission; actually
  // recording a refund stays restricted to Finance dept / ADMIN, mirrored
  // server-side in the PATCH /:id/refunded gate.
  const me = getUserFromToken();
  const canAct = me?.role === "ADMIN" || isFinanceDeptClient(me?.department || "");

  const [items, setItems] = useState<RefundableItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [tab, setTab] = useState<"pending" | "refunded" | "all">("pending");
  // Company filter (MNO / SEFS / HigherLife) - same fixed set and pattern as
  // Payments and the Capture Inbox, replacing the old free-text division
  // dropdown so this page's filtering is consistent across admin screens.
  const [companyFilter, setCompanyFilter] = useState<BusinessUnit>("ALL");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("vrDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);

  async function refresh() {
    setError(null);
    try {
      const resp = await api.refundable();
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
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, []);

  const stats = useMemo(() => {
    const pending = items.filter((i) => !i.refunded_at);
    const refundedThisMonth = items.filter((i) => i.refunded_at && isThisMonth(i.refunded_at));
    return {
      pendingCount: pending.length,
      pendingByCurrency: sumByCurrency(pending),
      refundedCount: refundedThisMonth.length,
      refundedByCurrency: sumByCurrency(refundedThisMonth),
      outstandingCount: pending.length,
      outstandingByCurrency: sumByCurrency(pending)
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
    if (tab === "refunded") return items.filter((i) => rowStatus(i) === "REFUNDED");
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
          (i.division_name || "").toLowerCase().includes(q) ||
          (i.destination || "").toLowerCase().includes(q)
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
        case "division": return (a.division_name || "").localeCompare(b.division_name || "") * dir;
        case "destination": return (a.destination || "").localeCompare(b.destination || "") * dir;
        case "advAmount": return (Number(a.advance_amount) - Number(b.advance_amount)) * dir;
        case "clearedAmount": return (Number(a.cleared_amount) - Number(b.cleared_amount)) * dir;
        case "toBeExpensed": return (Number(a.amount_to_be_expensed) - Number(b.amount_to_be_expensed)) * dir;
        case "refundable": return (Number(a.refundable_amount) - Number(b.refundable_amount)) * dir;
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

  async function toggleRefunded(item: RefundableItem, refunded: boolean) {
    setBusyId(item.id);
    setError(null);
    try {
      await api.setRefundableActioned(item.id, refunded);
      await refresh();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusyId(null);
      setOpenMenuId(null);
    }
  }

  function exportCsv() {
    const headers = ["Name", "Emp No", "Division", "Destination", "VR Date", "Receipts", "Adv Amount", "Cleared Amount", "Amount To Be Expensed", "Refundable", "Status"];
    const rows = sorted.map((i) => [
      i.employee_name || "", i.employee_no || "", i.division_name || "", i.destination || "",
      fmtDate(i.vr_date), i.has_receipts ? "Yes" : "No",
      Number(i.advance_amount || 0).toFixed(2), Number(i.cleared_amount || 0).toFixed(2),
      Number(i.amount_to_be_expensed || 0).toFixed(2), Number(i.refundable_amount || 0).toFixed(2),
      STATUS_LABEL[rowStatus(i)]
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `refundable-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  const SortableHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(sortKeyName)}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label} <ArrowUpDown size={12} style={{ opacity: sortKey === sortKeyName ? 1 : 0.35 }} />
      </span>
    </th>
  );

  if (loading) return <div className="ep-page"><p>Loading refundable claims…</p></div>;

  return (
    <div className="ep-page deductions-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Refundable</h1>
          <p className="ep-subtitle">Subsistence clearance settlements where the claimant overspent their own money and is owed a refund.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!sorted.length}>
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div className="ep-kpi-row">
        <div className="ep-kpi ep-kpi-gold">
          <div className="ep-kpi-icon"><Clock size={26} /></div>
          <div>
            <div className="ep-kpi-value">{stats.pendingCount}</div>
            <div className="ep-kpi-label">Pending Refunds</div>
            <CurrencyBreakdown byCurrency={stats.pendingByCurrency} />
          </div>
        </div>
        <div className="ep-kpi ep-kpi-green">
          <div className="ep-kpi-icon"><CheckCircle2 size={26} /></div>
          <div>
            <div className="ep-kpi-value">{stats.refundedCount}</div>
            <div className="ep-kpi-label">Refunded (This Month)</div>
            <CurrencyBreakdown byCurrency={stats.refundedByCurrency} />
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
          { key: "refunded", label: "Refunded", count: items.filter((i) => rowStatus(i) === "REFUNDED").length, icon: CheckCircle2 },
          { key: "all", label: "All Claims", count: items.length, icon: FileText }
        ]}
      />

      <FinanceFilterBar
        showReset={Boolean(search || companyFilter !== "ALL" || dateFrom || dateTo)}
        onReset={() => { setSearch(""); setCompanyFilter("ALL"); setDateFrom(""); setDateTo(""); setPage(1); }}
      >
        <SearchField label="Search" placeholder="Search name, emp no, division, destination…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
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
                  <SortableHeader label="Emp. No" sortKeyName="empNo" />
                  <SortableHeader label="Division" sortKeyName="division" />
                  <SortableHeader label="Destination" sortKeyName="destination" />
                  <SortableHeader label="VR Date" sortKeyName="vrDate" />
                  <th>Receipts</th>
                  <SortableHeader label="Adv Amount" sortKeyName="advAmount" />
                  <SortableHeader label="Cleared Amount" sortKeyName="clearedAmount" />
                  <SortableHeader label="Amount To Be Expnsd" sortKeyName="toBeExpensed" />
                  <SortableHeader label="Refundable" sortKeyName="refundable" />
                  <SortableHeader label="Status" sortKeyName="status" />
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {paged.map((item) => {
                  const status = rowStatus(item);
                  const actionable = canAct;
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
                      <td style={{ fontWeight: 600 }}>{formatMoney(item.advance_amount, item.currency)}</td>
                      <td style={{ fontWeight: 600 }}>{formatMoney(item.cleared_amount, item.currency)}</td>
                      <td>{formatMoney(item.amount_to_be_expensed, item.currency)}</td>
                      <td style={{ color: Number(item.refundable_amount) > 0 ? "#059669" : "var(--muted)", fontWeight: 600 }}>
                        {formatMoney(item.refundable_amount, item.currency)}
                      </td>
                      <td><StatusBadge status={status} /></td>
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
                              <button className="ep-dropdown-item" onClick={() => toggleRefunded(item, true)} disabled={busyId === item.id}>
                                <Check size={14} style={{ marginRight: 6 }} /> Mark as Refunded
                              </button>
                            )}
                            {status === "REFUNDED" && (
                              <button className="ep-dropdown-item" onClick={() => toggleRefunded(item, false)} disabled={busyId === item.id}>
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
