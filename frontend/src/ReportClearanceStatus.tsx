import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { formatMoney } from "./constants";
import { CheckCircle2, Clock3, AlertTriangle, ClipboardList, Search, Download, ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  onBack: () => void;
  scope?: "all" | "mine";
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

// Fixed status palette (good/warning/critical) - reserved for state, never
// reused as a generic categorical series color. Validated distinct under
// protanopia/deuteranopia/tritanopia so color never has to carry the
// distinction alone; every use still pairs it with an icon and a text label
// (legend swatch, hover title, and the Status column text itself).
const STATUS_CONFIG: Record<ClearanceStatus, { label: string; bg: string; color: string; chart: string }> = {
  COMPLETE:     { label: "Complete",     bg: "#d1fae5", color: "#065f46", chart: "#0ca30c" },
  NOT_COMPLETE: { label: "Not Complete", bg: "#fef3c7", color: "#92400e", chart: "#fab219" },
  NOT_CLEARED:  { label: "Not Cleared",  bg: "#fee2e2", color: "#991b1b", chart: "#d03b3b" }
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

export default function ReportClearanceStatus({ onBack, scope = "all" }: Props) {
  const isMine = scope === "mine";
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
      const resp = isMine ? await api.myClearanceStatusReport() : await api.clearanceStatusReport();
      setRows(Array.isArray(resp?.items) ? resp.items : []);
    } catch (e: any) {
      setError(e?.message || "Failed to load clearance status report.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [isMine]);

  const departments = useMemo(
    () => Array.from(new Set(rows.map((r) => r.department).filter(Boolean))).sort() as string[],
    [rows]
  );

  const counts = useMemo(() => {
    const notCleared = rows.filter((r) => r.status === "NOT_CLEARED");
    // Grouped by currency rather than blended into one number — an LSL and
    // a USD advance summed together and labelled with one currency symbol
    // would be meaningless.
    const notClearedValueByCurrency = new Map<string, number>();
    for (const r of notCleared) {
      const currency = r.currency || "LSL";
      notClearedValueByCurrency.set(currency, (notClearedValueByCurrency.get(currency) || 0) + Number(r.approved_total || 0));
    }
    return {
      total: rows.length,
      complete: rows.filter((r) => r.status === "COMPLETE").length,
      notComplete: rows.filter((r) => r.status === "NOT_COMPLETE").length,
      notCleared: notCleared.length,
      notClearedValueByCurrency: Array.from(notClearedValueByCurrency.entries())
    };
  }, [rows]);

  // Per-department breakdown for the "Clearance by Department" bar chart and
  // the "Not Cleared by Department" ranked list. Sorted by total volume so
  // the departments with the most paid travel advances lead the chart;
  // the ranked list re-sorts the same data by not-cleared count instead.
  const byDepartment = useMemo(() => {
    const map = new Map<string, { department: string; complete: number; notComplete: number; notCleared: number }>();
    for (const r of rows) {
      const dept = r.department || "Unassigned";
      const entry = map.get(dept) || { department: dept, complete: 0, notComplete: 0, notCleared: 0 };
      if (r.status === "COMPLETE") entry.complete += 1;
      else if (r.status === "NOT_COMPLETE") entry.notComplete += 1;
      else entry.notCleared += 1;
      map.set(dept, entry);
    }
    return Array.from(map.values())
      .map((d) => ({ ...d, total: d.complete + d.notComplete + d.notCleared }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);

  const topDepartmentsByVolume = useMemo(() => byDepartment.slice(0, 6), [byDepartment]);
  const topDepartmentsByNotCleared = useMemo(
    () => byDepartment.filter((d) => d.notCleared > 0).sort((a, b) => b.notCleared - a.notCleared).slice(0, 6),
    [byDepartment]
  );

  function filterToDepartment(department: string) {
    setDepartmentFilter((current) => (current === department ? "" : department));
  }

  const filtered = useMemo(() => rows.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (departmentFilter && (r.department || "Unassigned") !== departmentFilter) return false;
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
    const h = [
      ...(isMine ? [] : ["Employee", "Department"]),
      "Advance Type", "Amount", "Paid Date", "Clearance Status", "Claim Stage", "Submitted", "Closed/Settled"
    ];
    const csvRows = filtered.map((r) => [
      ...(isMine ? [] : [r.requester_name || "—", r.department || "—"]),
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
    el.download = `${isMine ? "my-" : ""}clearance-status-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  return (
    <div className="ep-page">
      {!isMine && (
        <div className="ep-breadcrumb">
          <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Reports</span>
          <span className="ep-breadcrumb-sep">›</span>
          <span className="ep-breadcrumb-active">Clearance Status</span>
        </div>
      )}
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">{isMine ? "My Clearance Status" : "Clearance Status"}</h1>
          <p className="ep-subtitle">
            {isMine ? "Your paid travel advances, tracked through to a complete clearance." : "Every paid travel advance, tracked through to a complete clearance."}
          </p>
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
            {counts.notClearedValueByCurrency.length === 0
              ? <small>{formatMoney(0)}</small>
              : counts.notClearedValueByCurrency.map(([currency, value]) => <small key={currency} style={{ display: "block" }}>{formatMoney(value, currency)}</small>)}
          </div>
        </div>
      </div>

      {!isMine && topDepartmentsByVolume.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14, marginBottom: 14, alignItems: "start" }}>
          <div className="ep-panel" style={{ padding: "16px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Clearance by Department</div>
              <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--muted)" }}>
                {(["COMPLETE", "NOT_COMPLETE", "NOT_CLEARED"] as const).map((s) => (
                  <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: STATUS_CONFIG[s].chart, display: "inline-block" }} />
                    {STATUS_CONFIG[s].label}
                  </span>
                ))}
              </div>
            </div>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 14px" }}>Top {topDepartmentsByVolume.length} departments by paid travel advance volume. Click a bar to filter the table below.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {topDepartmentsByVolume.map((d) => {
                const isActive = departmentFilter === d.department;
                const seg = (n: number, status: ClearanceStatus, isFirst: boolean, isLast: boolean) => n === 0 ? null : (
                  <div
                    key={status}
                    title={`${STATUS_CONFIG[status].label}: ${n}`}
                    style={{
                      flex: n,
                      background: STATUS_CONFIG[status].chart,
                      height: 18,
                      borderTopLeftRadius: isFirst ? 4 : 0,
                      borderBottomLeftRadius: isFirst ? 4 : 0,
                      borderTopRightRadius: isLast ? 4 : 0,
                      borderBottomRightRadius: isLast ? 4 : 0
                    }}
                  />
                );
                return (
                  <button
                    key={d.department}
                    type="button"
                    onClick={() => filterToDepartment(d.department)}
                    style={{
                      display: "grid", gridTemplateColumns: "120px 1fr 40px", gap: 10, alignItems: "center",
                      background: isActive ? "var(--surface-soft, #f1f5f9)" : "transparent",
                      border: "none", borderRadius: 6, padding: "4px 6px", cursor: "pointer", textAlign: "left", width: "100%"
                    }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: isActive ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.department}</span>
                    <span style={{ display: "flex", gap: 2 }}>
                      {seg(d.complete, "COMPLETE", true, d.notComplete === 0 && d.notCleared === 0)}
                      {seg(d.notComplete, "NOT_COMPLETE", d.complete === 0, d.notCleared === 0)}
                      {seg(d.notCleared, "NOT_CLEARED", d.complete === 0 && d.notComplete === 0, true)}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--muted)", textAlign: "right" }}>{d.total}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="ep-panel" style={{ padding: "16px 20px" }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Not Cleared by Department</div>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 12px" }}>Departments with the most unresolved clearances.</p>
            {topDepartmentsByNotCleared.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>Nothing not-cleared right now.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {topDepartmentsByNotCleared.map((d) => (
                  <button
                    key={d.department}
                    type="button"
                    onClick={() => filterToDepartment(d.department)}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      background: departmentFilter === d.department ? "var(--surface-soft, #f1f5f9)" : "transparent",
                      border: "none", borderRadius: 6, padding: "6px 8px", cursor: "pointer", textAlign: "left", width: "100%", fontSize: 13
                    }}
                  >
                    <span style={{ fontWeight: departmentFilter === d.department ? 700 : 500 }}>{d.department}</span>
                    <span style={{ fontWeight: 700, color: STATUS_CONFIG.NOT_CLEARED.chart }}>{d.notCleared}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="ep-tabs">
        {([
          { key: "", label: "All", count: rows.length },
          { key: "COMPLETE", label: "Complete", count: counts.complete },
          { key: "NOT_COMPLETE", label: "Not Complete", count: counts.notComplete },
          { key: "NOT_CLEARED", label: "Not Cleared", count: counts.notCleared }
        ] as const).map((t) => (
          <button key={t.key} type="button" className={`ep-tab ${statusFilter === t.key ? "active" : ""}`}
            onClick={() => setStatusFilter(t.key)}>
            {t.label} <span className="ep-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div className="ep-filter-bar" style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          {!isMine && (
            <div className="ep-search" style={{ flex: "1 1 220px" }}>
              <Search size={14} />
              <input placeholder="Search employee or department…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          )}
          {!isMine && (
            <select className="ep-form-select" value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">All Departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
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
                  {!isMine && <th>Employee</th>}
                  {!isMine && <th>Department</th>}
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
                      {!isMine && <td style={{ fontWeight: 600 }}>{r.requester_name || "—"}</td>}
                      {!isMine && <td style={{ color: "var(--muted)" }}>{r.department || "—"}</td>}
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
          <div className="ep-filter-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, filtered.length)} of {filtered.length} entries
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <select className="ep-form-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}><ChevronLeft size={14} /></button>
              <span style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap" }}>Page {page} of {pageCount}</span>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
