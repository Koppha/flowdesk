import React, { useMemo, useState } from "react";
import { formatMoney, travelTypeLabel } from "./constants";
import { Download, FileText, Users, CheckCircle, XCircle } from "lucide-react";

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

export default function ReportAdvances({ advances, travelTypes, onBack }: Props) {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

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
    const headers = ["Employee","Department","Type","Status","Requested","Approved","Submitted","Approved Date","Paid Date"];
    const rows = filtered.map(a => [
      a.requester_name ?? "", a.department ?? "",
      travelTypeLabel(a.type, travelTypes), a.status,
      a.requested_total ?? "", a.approved_total ?? "",
      fmtDate(a.submitted_at), fmtDate(a.approved_at), fmtDate(a.paid_at),
    ]);
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
        <div className="ep-actions">
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

      {/* Filters */}
      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 200px" }}>
            <input placeholder="Search name, department…" value={search}
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
            <option value="">All Departments</option>
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
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Requested</th>
                  <th>Approved</th>
                  <th>Submitted</th>
                  <th>Approved Date</th>
                  <th>Paid Date</th>
                </tr>
              </thead>
              <tbody>
                {paged.map(a => (
                  <tr key={a.id}>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: "0.87rem" }}>{a.requester_name || "—"}</div>
                      {a.employee_no && <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{a.employee_no}</div>}
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{a.department || "—"}</td>
                    <td style={{ fontSize: 13 }}>{travelTypeLabel(a.type, travelTypes)}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td style={{ fontWeight: 600 }}>{formatMoney(a.requested_total, "LSL")}</td>
                    <td style={{ color: "var(--muted)" }}>{formatMoney(a.approved_total, "LSL")}</td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(a.submitted_at || a.created_at)}</td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(a.approved_at)}</td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(a.paid_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Page {page} of {totalPages} · {filtered.length} records
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="ep-btn-outline" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
              <button className="ep-btn-outline" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
