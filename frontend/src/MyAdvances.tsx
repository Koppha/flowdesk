import React, { useMemo, useState } from "react";
import { formatMoney, travelTypeLabel, isTravelTypeCode, TravelType, currentApprovalStepLabel } from "./constants";
import { FileText, Clock3, CheckCircle2, XCircle, Edit3, RefreshCw, Plus, ChevronLeft, ChevronRight } from "lucide-react";

function travelTypeCurrency(code: string | null | undefined, travelTypes: TravelType[]) {
  return travelTypes.find((type) => type.code === code)?.currency ?? "LSL";
}

interface Props {
  advances: any[];
  travelTypes: TravelType[];
  claims?: any[];
  onNew: () => void;
  onEdit: (advance: any) => void;
  onTrack: (advanceId: string) => void;
  onClear: (advanceId: string) => void;
  onContinueClearance?: (claimId: string) => void;
}

const PENDING_STATUSES = ["SUBMITTED", "COUNTERSIGNED", "HR_MANAGER_REVIEW", "HR_OFFICER"];
const CANCELLED_STATUSES = ["CANCELLED", "REJECTED"];

const TABS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "PAID", label: "Paid" },
  { key: "CANCELLED", label: "Cancelled" },
];

function tabStatuses(tab: string) {
  switch (tab) {
    case "PENDING": return PENDING_STATUSES;
    case "APPROVED": return ["APPROVED"];
    case "PAID": return ["PAID"];
    case "CANCELLED": return CANCELLED_STATUSES;
    default: return null;
  }
}

function statusLabel(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusTone(value: string | null | undefined) {
  const status = String(value || "").toUpperCase();
  if (status.includes("REJECT") || status.includes("CANCEL")) return "status-pill-danger";
  if (status.includes("PAID") || status.includes("APPROVED")) return "status-pill-success";
  if (status.includes("SUBMITTED") || status.includes("REVIEW") || status.includes("OFFICER") || status.includes("COUNTERSIGNED")) return "status-pill-warning";
  if (status.includes("DRAFT")) return "status-pill-neutral";
  return "status-pill-info";
}

function fmtDate(value: any) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function requestNumber(advance: any) {
  const created = new Date(advance?.created_at || Date.now());
  const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear();
  const digits = String(advance?.id || "").replace(/\D/g, "").slice(-5);
  const fallback = String(advance?.id || "00000").replace(/-/g, "").slice(0, 5).toUpperCase();
  return `ADV-${year}-${(digits || fallback || "00000").padStart(5, "0")}`;
}

function advanceStageLabel(status: string) {
  switch (status) {
    case "DRAFT": return "Draft (not submitted)";
    case "SUBMITTED": return "Pending Approval";
    case "COUNTERSIGNED": return "Pending HOD / EXCO Approval";
    case "HR_MANAGER_REVIEW": return "Pending HR Manager Approval";
    case "HR_OFFICER": return "Pending Finance Payment";
    case "APPROVED": return "Approved — Awaiting Payment";
    case "PAID": return "Completed";
    case "CANCELLED": return "Cancelled";
    case "REJECTED": return "Rejected";
    default: return statusLabel(status);
  }
}

const PAGE_SIZE = 10;

export default function MyAdvances({ advances, travelTypes, claims = [], onNew, onEdit, onTrack, onClear, onContinueClearance }: Props) {
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [tab, setTab] = useState("ALL");
  const [page, setPage] = useState(1);

  // An advance already has an active (non-rejected) clearance claim once its
  // employee starts one — even a DRAFT. Keyed by linked_advance_id so the
  // "Clear" action can be replaced with "Continue" / hidden instead of
  // letting the user try to create a second claim for the same advance.
  const claimByAdvanceId = useMemo(() => {
    const map = new Map<string, any>();
    for (const c of claims) {
      if (c.linked_advance_id && c.status !== "REJECTED") map.set(c.linked_advance_id, c);
    }
    return map;
  }, [claims]);

  const stats = useMemo(() => ({
    total: advances.length,
    pending: advances.filter((a) => PENDING_STATUSES.includes(a.status)).length,
    approvedOrPaid: advances.filter((a) => a.status === "APPROVED" || a.status === "PAID").length,
    cancelled: advances.filter((a) => CANCELLED_STATUSES.includes(a.status)).length,
  }), [advances]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of TABS) {
      const statuses = tabStatuses(t.key);
      counts[t.key] = statuses ? advances.filter((a) => statuses.includes(a.status)).length : advances.length;
    }
    return counts;
  }, [advances]);

  const uniqueTypes = useMemo(() => [...new Set(advances.map((a) => a.type).filter(Boolean))], [advances]);
  const uniqueStatuses = useMemo(() => [...new Set(advances.map((a) => a.status).filter(Boolean))], [advances]);

  const filtered = useMemo(() => {
    const statuses = tabStatuses(tab);
    return advances.filter((a) => {
      if (statuses && !statuses.includes(a.status)) return false;
      if (filterType && a.type !== filterType) return false;
      if (filterStatus && a.status !== filterStatus) return false;
      if (dateFrom && a.created_at && a.created_at < dateFrom) return false;
      if (dateTo && a.created_at && a.created_at > dateTo + "T23:59:59") return false;
      if (search) {
        const q = search.toLowerCase();
        return travelTypeLabel(a.type, travelTypes).toLowerCase().includes(q) ||
          requestNumber(a).toLowerCase().includes(q);
      }
      return true;
    });
  }, [advances, tab, filterType, filterStatus, dateFrom, dateTo, search, travelTypes]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const hasFilters = Boolean(search || filterType || filterStatus || dateFrom || dateTo);

  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">My Advances</h1>
          <p className="ep-subtitle">View and manage all your advance requests.</p>
        </div>
        <div className="ep-actions">
          <button className="button button-primary small-button" onClick={onNew}>
            <Plus size={14} aria-hidden /> New Advance Request
          </button>
        </div>
      </div>

      <div className="ep-kpi-row">
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><FileText size={28} /></span>
          <div><div className="stat-value">{stats.total}</div><div className="stat-label">Total Advances</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Clock3 size={28} /></span>
          <div><div className="stat-value">{stats.pending}</div><div className="stat-label">Pending</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle2 size={28} /></span>
          <div><div className="stat-value">{stats.approvedOrPaid}</div><div className="stat-label">Approved / Paid</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><XCircle size={28} /></span>
          <div><div className="stat-value">{stats.cancelled}</div><div className="stat-label">Cancelled</div></div>
        </div>
      </div>

      <div className="ep-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`ep-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => { setTab(t.key); setPage(1); }}
          >
            {t.label} <span className="inbox-count-chip">{tabCounts[t.key]}</span>
          </button>
        ))}
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div className="ep-filter-bar" style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px" }}>
            <input
              placeholder="Search by type or reference…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select className="ep-form-select" value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}>
            <option value="">All Statuses</option>
            {uniqueStatuses.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <select className="ep-form-select" value={filterType} onChange={(e) => { setFilterType(e.target.value); setPage(1); }}>
            <option value="">All Types</option>
            {uniqueTypes.map((t) => <option key={t} value={t}>{travelTypeLabel(t, travelTypes)}</option>)}
          </select>
          <input type="date" className="ep-form-select" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
          <input type="date" className="ep-form-select" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} title="To date" />
          {hasFilters && (
            <button className="ep-btn-outline" onClick={() => { setSearch(""); setFilterType(""); setFilterStatus(""); setDateFrom(""); setDateTo(""); setPage(1); }}>
              Clear
            </button>
          )}
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>{filtered.length} results</span>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {filtered.length === 0 ? (
            <div className="ep-empty"><p>No advance requests match your filters.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Reference</th>
                  <th>Status / Stage</th>
                  <th>Current Stage</th>
                  <th>Requested</th>
                  <th>Approved</th>
                  <th>Requested On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((a) => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600 }}>{travelTypeLabel(a.type, travelTypes)}</td>
                    <td><strong>{requestNumber(a)}</strong></td>
                    <td>
                      <span className={`status-pill ${statusTone(a.status)}`}>{currentApprovalStepLabel(a) || statusLabel(a.status)}</span>
                      {a.is_overdue && <span className="status-pill status-pill-danger" style={{ marginLeft: 6 }}>Overdue</span>}
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>
                      {currentApprovalStepLabel(a) ? `Pending ${currentApprovalStepLabel(a)} Approval` : advanceStageLabel(a.status)}
                    </td>
                    <td>{formatMoney(a.requested_total, travelTypeCurrency(a.type, travelTypes))}</td>
                    <td>{formatMoney(a.approved_total, travelTypeCurrency(a.type, travelTypes))}</td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(a.created_at)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        {(a.status === "DRAFT" || a.status === "SUBMITTED") && (
                          <button className="ep-icon-btn" title="Edit" onClick={() => onEdit(a)}>
                            <Edit3 size={15} aria-hidden />
                          </button>
                        )}
                        <button className="ep-icon-btn" title="Track" onClick={() => onTrack(a.id)}>
                          <RefreshCw size={14} aria-hidden />
                        </button>
                        {a.status === "PAID" && isTravelTypeCode(a.type, travelTypes) && (() => {
                          const existingClaim = claimByAdvanceId.get(a.id);
                          if (!existingClaim) {
                            return <button className="button small-button" onClick={() => onClear(a.id)}>Clear</button>;
                          }
                          if (existingClaim.status === "DRAFT" && onContinueClearance) {
                            return (
                              <button className="button small-button" onClick={() => onContinueClearance(existingClaim.id)}>
                                Continue Clearance
                              </button>
                            );
                          }
                          return null;
                        })()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {filtered.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Showing {(currentPage - 1) * PAGE_SIZE + 1} to {Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} results
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
