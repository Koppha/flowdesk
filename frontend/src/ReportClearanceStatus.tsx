import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { formatMoney } from "./constants";
import { CheckCircle2, Clock3, AlertTriangle, ClipboardList, Search, Download, ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  onBack: () => void;
}

type ClearanceStatus = "COMPLETE" | "NOT_COMPLETE" | "NOT_CLEARED";

type Row = {
  advance_id: string;
  type: string;
  requester_id: string;
  requester_name: string | null;
  department: string | null;
  approved_total: number;
  currency: string;
  paid_at: string | null;
  claim_id: string | null;
  claim_status: string | null;
  claim_total: number | null;
  submitted_at: string | null;
  closed_at: string | null;
  settled_at: string | null;
  not_cleared_confirmed_at: string | null;
  status: ClearanceStatus;
};

const STATUS_CONFIG: Record<ClearanceStatus, { label: string; bg: string; color: string }> = {
  COMPLETE:     { label: "Complete",     bg: "#d1fae5", color: "#065f46" },
  NOT_COMPLETE: { label: "Not Complete", bg: "#fef3c7", color: "#92400e" },
  NOT_CLEARED:  { label: "Not Cleared",  bg: "#fee2e2", color: "#991b1b" }
};

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function claimStageLabel(status: string | null) {
  if (!status) return "Not submitted";
  return status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const PAGE_SIZE_OPTIONS = [10, 25, 50];

export default function ReportClearanceStatus({ onBack }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<"" | ClearanceStatus>("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.clearanceStatusReport();
      setRows(Array.isArray(resp?.items) ? resp.items : []);
    } catch (e: any) {
      setError(e?.message || "Failed to load clearance status report.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const departments = useMemo(
    () => Array.from(new Set(rows.map((r) => r.department).filter(Boolean))).sort() as string[],
    [rows]
  );

  const counts = useMemo(() => ({
    total: rows.length,
    complete: rows.filter((r) => r.status === "COMPLETE").length,
    notComplete: rows.filter((r) => r.status === "NOT_COMPLETE").length,
    notCleared: rows.filter((r) => r.status === "NOT_CLEARED").length,
    notClearedValue: rows.filter((r) => r.status === "NOT_CLEARED").reduce((s, r) => s + Number(r.approved_total || 0), 0)
  }), [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (departmentFilter && r.department !== departmentFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (r.requester_name || "").toLowerCase().includes(q) || (r.department || "").toLowerCase().includes(q);
    }
    return true;
  }), [rows, statusFilter, departmentFilter, search]);

  useEffect(() => { setPage(1); }, [statusFilter, departmentFilter, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const paged = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

  function exportCsv() {
    const h = ["Employee", "Department", "Advance Type", "Amount", "Paid Date", "Clearance Status", "Claim Stage", "Submitted", "Closed/Settled"];
    const csvRows = filtered.map((r) => [
      r.requester_name || "—",
      r.department || "—",
      r.type,
      formatMoney(r.approved_total, r.currency),
      fmtDate(r.paid_at),
      STATUS_CONFIG[r.status].label,
      claimStageLabel(r.claim_status),
      fmtDate(r.submitted_at),
      fmtDate(r.closed_at || r.settled_at)
    ]);
    const csv = [h, ...csvRows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `clearance-status-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Reports</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Clearance Status</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Clearance Status</h1>
          <p className="ep-subtitle">Every paid travel advance, tracked through to a complete clearance.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!filtered.length}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div className="ep-kpi-row">
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><ClipboardList size={28} /></span>
          <div><div className="stat-value">{counts.total}</div><div className="stat-label">Paid Travel Advances</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle2 size={28} /></span>
          <div><div className="stat-value">{counts.complete}</div><div className="stat-label">Complete</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Clock3 size={28} /></span>
          <div><div className="stat-value">{counts.notComplete}</div><div className="stat-label">Not Complete</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><AlertTriangle size={28} /></span>
          <div>
            <div className="stat-value">{counts.notCleared}</div>
            <div className="stat-label">Not Cleared</div>
            <small>{formatMoney(counts.notClearedValue)}</small>
          </div>
        </div>
      </div>

      <div className="ep-tabs">
        {([
          { key: "", label: "All", count: rows.length },
          { key: "COMPLETE", label: "Complete", count: counts.complete },
          { key: "NOT_COMPLETE", label: "Not Complete", count: counts.notComplete },
          { key: "NOT_CLEARED", label: "Not Cleared", count: counts.notCleared }
        ] as const).map((t) => (
          <button key={t.key} type="button" className={`ep-tab ${statusFilter === t.key ? "active" : ""}`}
            onClick={() => setStatusFilter(t.key)}>
            {t.label} <span className="inbox-count-chip">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px" }}>
            <Search size={14} />
            <input placeholder="Search employee or department…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="ep-form-select" value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>{filtered.length} of {rows.length}</span>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-empty"><p>Loading…</p></div>
          ) : filtered.length === 0 ? (
            <div className="ep-empty"><p>No advances match your filters.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Advance Type</th>
                  <th>Amount</th>
                  <th>Paid Date</th>
                  <th>Claim Stage</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((r) => {
                  const cfg = STATUS_CONFIG[r.status];
                  return (
                    <tr key={r.advance_id}>
                      <td style={{ fontWeight: 600 }}>{r.requester_name || "—"}</td>
                      <td style={{ color: "var(--muted)" }}>{r.department || "—"}</td>
                      <td>{r.type}</td>
                      <td style={{ fontWeight: 600 }}>{formatMoney(r.approved_total, r.currency)}</td>
                      <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(r.paid_at)}</td>
                      <td style={{ color: "var(--muted)" }}>{claimStageLabel(r.claim_status)}</td>
                      <td>
                        <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color, whiteSpace: "nowrap" }}>{cfg.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {filtered.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, filtered.length)} of {filtered.length} entries
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <select className="ep-form-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}><ChevronLeft size={14} /></button>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Page {page} of {pageCount}</span>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
