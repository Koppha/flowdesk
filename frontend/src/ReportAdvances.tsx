import React, { useEffect, useMemo, useState } from "react";
import { api, openBlobInNewTab } from "./api";
import { formatMoney, travelTypeLabel, TravelType } from "./constants";
import { Download, FileText, Users, CheckCircle, XCircle, MoreHorizontal, ChevronLeft, ChevronRight } from "lucide-react";

function travelTypeCurrency(code: string | null | undefined, travelTypes: TravelType[]) {
  return travelTypes.find((type) => type.code === code)?.currency ?? "LSL";
}

interface Props {
  advances: any[];
  travelTypes: any[];
  onBack: () => void;
}

const STATUS_STYLE: Record<string, [string, string]> = {
  DRAFT:            ["#f1f5f9", "#64748b"],
  SUBMITTED:        ["#dbeafe", "#1d4ed8"],
  PENDING_APPROVAL: ["#fef3c7", "#92400e"],
  PENDING_PAYMENT:  ["#fef3c7", "#92400e"],
  APPROVED:         ["#d1fae5", "#065f46"],
  REJECTED:         ["#fee2e2", "#dc2626"],
  PAID:             ["#ede9fe", "#6d28d9"],
};

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  const label = status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{label}</span>;
}

const PAGE_SIZE = 20;

const ALL_COLUMNS: { key: string; label: string }[] = [
  { key: "employee", label: "Employee" },
  { key: "department", label: "Division" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "requested", label: "Requested" },
  { key: "approved", label: "Approved" },
  { key: "submitted", label: "Submitted" },
  { key: "approvedDate", label: "Approved Date" },
  { key: "paidDate", label: "Paid Date" },
];

const COLUMNS_STORAGE_KEY = "advancesReportColumns";

function loadVisibleColumns(): Record<string, boolean> {
  const defaults = Object.fromEntries(ALL_COLUMNS.map(c => [c.key, true]));
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_STORAGE_KEY) || "{}");
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export default function ReportAdvances({ advances, travelTypes, onBack }: Props) {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [visibleCols, setVisibleCols] = useState<Record<string, boolean>>(loadVisibleColumns);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    function closeMenu() { setOpenMenuId(null); }
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  function viewPdf(a: any) {
    setPdfError(null);
    setOpenMenuId(null);
    openBlobInNewTab(() => api.advancePdf(a.id)).catch((e: any) => setPdfError(e?.message || "Failed to open PDF."));
  }

  function toggleColumn(key: string) {
    setVisibleCols(prev => {
      const visibleCount = ALL_COLUMNS.filter(c => prev[c.key]).length;
      if (prev[key] && visibleCount <= 1) return prev; // keep at least one column visible
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  const uniqueTypes = useMemo(() => [...new Set(advances.map(a => a.type).filter(Boolean))].sort(), [advances]);
  const uniqueDepts = useMemo(() => [...new Set(advances.map(a => a.department).filter(Boolean))].sort(), [advances]);

  const filtered = useMemo(() => {
    return advances.filter(a => {
      if (filterStatus && a.status !== filterStatus) return false;
      if (filterType && a.type !== filterType) return false;
      if (filterDept && a.department !== filterDept) return false;
      if (dateFrom && a.created_at && a.created_at < dateFrom) return false;
      if (dateTo && a.created_at && a.created_at > dateTo + "T23:59:59") return false;
      if (search) {
        const q = search.toLowerCase();
        return (a.requester_name || "").toLowerCase().includes(q) ||
               (a.department || "").toLowerCase().includes(q) ||
               (a.employee_no || "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [advances, filterStatus, filterType, filterDept, dateFrom, dateTo, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const stats = useMemo(() => ({
    total:    advances.length,
    pending:  advances.filter(a => ["DRAFT","SUBMITTED","PENDING_APPROVAL","PENDING_PAYMENT"].includes(a.status)).length,
    approved: advances.filter(a => ["APPROVED","PAID"].includes(a.status)).length,
    rejected: advances.filter(a => a.status === "REJECTED").length,
    totalValue: advances.reduce((s, a) => s + Number(a.approved_total || 0), 0),
  }), [advances]);

  function exportCsv() {
    const valueByKey: Record<string, (a: any) => string | number> = {
      employee: a => a.requester_name ?? "",
      department: a => a.department ?? "",
      type: a => travelTypeLabel(a.type, travelTypes),
      status: a => a.status,
      requested: a => a.requested_total ?? "",
      approved: a => a.approved_total ?? "",
      submitted: a => fmtDate(a.submitted_at),
      approvedDate: a => fmtDate(a.approved_at),
      paidDate: a => fmtDate(a.paid_at),
    };
    const cols = ALL_COLUMNS.filter(c => visibleCols[c.key]);
    const headers = cols.map(c => c.label);
    const rows = filtered.map(a => cols.map(c => valueByKey[c.key](a)));
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `advance-requests-${new Date().toISOString().slice(0,10)}.csv`;
    el.click();
  }

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Reports</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Advance Requests</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Advance Requests</h1>
          <p className="ep-subtitle">Full admin view of all advance requests across the organisation.</p>
        </div>
        <div className="ep-actions" style={{ position: "relative" }}>
          <button className="ep-btn-outline" onClick={() => setColumnsMenuOpen(v => !v)}>
            Columns ({ALL_COLUMNS.filter(c => visibleCols[c.key]).length}/{ALL_COLUMNS.length})
          </button>
          {columnsMenuOpen && (
            <div style={{
              position: "absolute", top: "100%", right: 0, marginTop: 6, zIndex: 20,
              background: "var(--card,#fff)", border: "1px solid var(--border,#e5e7eb)", borderRadius: 8,
              boxShadow: "0 4px 14px rgba(0,0,0,0.12)", padding: "8px 0", minWidth: 180,
            }}>
              {ALL_COLUMNS.map(c => (
                <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 14px", fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={!!visibleCols[c.key]}
                    onChange={() => toggleColumn(c.key)}
                    style={{ accentColor: "var(--primary,#2563eb)" }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!filtered.length}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="ep-kpi-row">
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><FileText size={28} /></span>
          <div><div className="stat-value">{stats.total}</div><div className="stat-label">Total Requests</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Users size={28} /></span>
          <div><div className="stat-value">{stats.pending}</div><div className="stat-label">Pending</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle size={28} /></span>
          <div><div className="stat-value">{stats.approved}</div><div className="stat-label">Approved / Paid</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><XCircle size={28} /></span>
          <div><div className="stat-value">{stats.rejected}</div><div className="stat-label">Rejected</div></div>
        </div>
      </div>

      {pdfError && <pre className="inbox-error">{pdfError}</pre>}

      {/* Filters */}
      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div className="ep-filter-bar" style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 200px" }}>
            <input placeholder="Search name, division…" value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="ep-form-select" value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1); }}>
            <option value="">All Statuses</option>
            {["DRAFT","SUBMITTED","PENDING_APPROVAL","APPROVED","REJECTED","PAID","PENDING_PAYMENT"].map(s => (
              <option key={s} value={s}>{s.charAt(0)+s.slice(1).toLowerCase().replace(/_/g," ")}</option>
            ))}
          </select>
          <select className="ep-form-select" value={filterType} onChange={e => { setFilterType(e.target.value); setPage(1); }}>
            <option value="">All Types</option>
            {uniqueTypes.map(t => <option key={t} value={t}>{travelTypeLabel(t, travelTypes)}</option>)}
          </select>
          <select className="ep-form-select" value={filterDept} onChange={e => { setFilterDept(e.target.value); setPage(1); }} style={{ minWidth: 160 }}>
            <option value="">All Divisions</option>
            {uniqueDepts.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <input type="date" className="ep-form-select" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
          <input type="date" className="ep-form-select" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} title="To date" />
          {(search || filterStatus || filterType || filterDept || dateFrom || dateTo) && (
            <button className="ep-btn-outline" onClick={() => { setSearch(""); setFilterStatus(""); setFilterType(""); setFilterDept(""); setDateFrom(""); setDateTo(""); setPage(1); }}>
              Clear
            </button>
          )}
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>{filtered.length} results</span>
        </div>
      </div>

      {/* Table */}
      <div className="ep-panel">
        <div className="ep-table-wrap">
          {filtered.length === 0 ? (
            <div className="ep-empty"><p>No requests match your filters.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  {visibleCols.employee && <th>Employee</th>}
                  {visibleCols.department && <th>Division</th>}
                  {visibleCols.type && <th>Type</th>}
                  {visibleCols.status && <th>Status</th>}
                  {visibleCols.requested && <th>Requested</th>}
                  {visibleCols.approved && <th>Approved</th>}
                  {visibleCols.submitted && <th>Submitted</th>}
                  {visibleCols.approvedDate && <th>Approved Date</th>}
                  {visibleCols.paidDate && <th>Paid Date</th>}
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {paged.map(a => (
                  <tr key={a.id}>
                    {visibleCols.employee && (
                      <td>
                        <div style={{ fontWeight: 600, fontSize: "0.87rem" }}>{a.requester_name || "—"}</div>
                        {a.employee_no && <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{a.employee_no}</div>}
                      </td>
                    )}
                    {visibleCols.department && <td style={{ color: "var(--muted)", fontSize: 13 }}>{a.department || "—"}</td>}
                    {visibleCols.type && <td style={{ fontSize: 13 }}>{travelTypeLabel(a.type, travelTypes)}</td>}
                    {visibleCols.status && <td><StatusBadge status={a.status} /></td>}
                    {visibleCols.requested && <td style={{ fontWeight: 600 }}>{formatMoney(a.requested_total, travelTypeCurrency(a.type, travelTypes))}</td>}
                    {visibleCols.approved && <td style={{ color: "var(--muted)" }}>{formatMoney(a.approved_total, travelTypeCurrency(a.type, travelTypes))}</td>}
                    {visibleCols.submitted && <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(a.submitted_at || a.created_at)}</td>}
                    {visibleCols.approvedDate && <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(a.approved_at)}</td>}
                    {visibleCols.paidDate && <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(a.paid_at)}</td>}
                    <td className="ep-dropdown-wrap">
                      <button
                        className="ep-icon-btn"
                        onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === a.id ? null : a.id); }}
                        aria-label="Row actions"
                      >
                        <MoreHorizontal size={16} />
                      </button>
                      {openMenuId === a.id && (
                        <div className="ep-dropdown" onClick={(e) => e.stopPropagation()}>
                          <button className="ep-dropdown-item" onClick={() => viewPdf(a)}>View PDF</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {filtered.length > 0 && (
          <div className="ep-filter-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Showing {(page - 1) * PAGE_SIZE + 1} to {Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length} results
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="ep-btn-outline" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}><ChevronLeft size={14} /></button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 7).map(n => (
                <button key={n} className={`button small-button ${page === n ? "button-primary" : "button-subtle"}`} onClick={() => setPage(n)}>{n}</button>
              ))}
              <button className="ep-btn-outline" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
