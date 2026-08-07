import React, { useMemo, useState } from "react";
import { formatMoney } from "./constants";
import { ShieldCheck, CheckCircle2, Clock3, AlertTriangle, Edit3, RefreshCw, Plus } from "lucide-react";

interface Props {
  claims: any[];
  onNew: () => void;
  onEdit: (claimId: string) => void;
  onTrack: (claimId: string) => void;
}

const PENDING_STATUSES = ["SUBMITTED", "MANAGER_APPROVED", "EXCO_APPROVED", "HR_OFFICER", "FINANCE_VERIFIED"];

const TABS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "PENDING", label: "Pending" },
  { key: "SETTLED", label: "Settled" },
  { key: "ISSUES", label: "Issues" },
];

function tabStatuses(tab: string) {
  switch (tab) {
    case "PENDING": return PENDING_STATUSES;
    case "SETTLED": return ["SETTLED", "CLOSED"];
    case "ISSUES": return ["REJECTED"];
    default: return null;
  }
}

function statusLabel(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusTone(value: string | null | undefined) {
  const status = String(value || "").toUpperCase();
  if (status.includes("REJECT")) return "status-pill-danger";
  if (status.includes("SETTLED") || status.includes("APPROVED") || status.includes("CLOSED")) return "status-pill-success";
  if (status.includes("SUBMITTED") || status.includes("REVIEW") || status.includes("OFFICER") || status.includes("VERIFIED")) return "status-pill-warning";
  if (status.includes("DRAFT")) return "status-pill-neutral";
  return "status-pill-info";
}

function fmtDate(value: any) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function claimNumber(claim: any) {
  const created = new Date(claim?.created_at || Date.now());
  const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear();
  const digits = String(claim?.id || "").replace(/\D/g, "").slice(-5);
  const fallback = String(claim?.id || "00000").replace(/-/g, "").slice(0, 5).toUpperCase();
  return `CL-${year}-${(digits || fallback || "00000").padStart(5, "0")}`;
}

function clearanceStageLabel(claim: any) {
  switch (claim?.status) {
    case "DRAFT": return "Draft clearance";
    case "SETTLED":
    case "CLOSED": return "Cleared";
    case "REJECTED": return "Rejected";
    case "SUBMITTED": return "Waiting Manager Certification";
    case "MANAGER_APPROVED":
    case "EXCO_APPROVED": return "Pending Approval";
    case "HR_OFFICER": return "Waiting Finance Verification";
    case "FINANCE_VERIFIED": return "Waiting Finance Settlement";
    default: return statusLabel(claim?.status);
  }
}

const PAGE_SIZE = 10;

export default function MyClearances({ claims, onNew, onEdit, onTrack }: Props) {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [tab, setTab] = useState("ALL");
  const [page, setPage] = useState(1);

  const stats = useMemo(() => ({
    total: claims.length,
    settled: claims.filter((c) => c.status === "SETTLED" || c.status === "CLOSED").length,
    awaitingCto: claims.filter((c) => c.status === "EXCO_APPROVED").length,
    issues: claims.filter((c) => c.status === "REJECTED").length,
  }), [claims]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of TABS) {
      const statuses = tabStatuses(t.key);
      counts[t.key] = statuses ? claims.filter((c) => statuses.includes(c.status)).length : claims.length;
    }
    return counts;
  }, [claims]);

  const uniqueStatuses = useMemo(() => [...new Set(claims.map((c) => c.status).filter(Boolean))], [claims]);

  const filtered = useMemo(() => {
    const statuses = tabStatuses(tab);
    return claims.filter((c) => {
      if (statuses && !statuses.includes(c.status)) return false;
      if (filterStatus && c.status !== filterStatus) return false;
      if (dateFrom && c.created_at && c.created_at < dateFrom) return false;
      if (dateTo && c.created_at && c.created_at > dateTo + "T23:59:59") return false;
      if (search) {
        const q = search.toLowerCase();
        return (c.month || "").toLowerCase().includes(q) || claimNumber(c).toLowerCase().includes(q);
      }
      return true;
    });
  }, [claims, tab, filterStatus, dateFrom, dateTo, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const hasFilters = Boolean(search || filterStatus || dateFrom || dateTo);

  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">My Clearances</h1>
          <p className="ep-subtitle">View and manage all your clearance records.</p>
        </div>
        <div className="ep-actions">
          <button className="button button-primary small-button" onClick={onNew}>
            <Plus size={14} aria-hidden /> New Clearance
          </button>
        </div>
      </div>

      <div className="flow-stat-row flow-stat-row-4">
        <div className="flow-stat-card flow-stat-blue">
          <span className="flow-stat-icon"><ShieldCheck size={22} aria-hidden /></span>
          <div className="flow-stat-body"><strong>{stats.total}</strong><span>Total Clearances</span><small>All time</small></div>
        </div>
        <div className="flow-stat-card flow-stat-green">
          <span className="flow-stat-icon"><CheckCircle2 size={22} aria-hidden /></span>
          <div className="flow-stat-body"><strong>{stats.settled}</strong><span>Settled</span><small>Fully cleared</small></div>
        </div>
        <div className="flow-stat-card flow-stat-amber">
          <span className="flow-stat-icon"><Clock3 size={22} aria-hidden /></span>
          <div className="flow-stat-body"><strong>{stats.awaitingCto}</strong><span>Awaiting Approval</span><small>Pending approval</small></div>
        </div>
        <div className="flow-stat-card flow-stat-rose">
          <span className="flow-stat-icon"><AlertTriangle size={22} aria-hidden /></span>
          <div className="flow-stat-body"><strong>{stats.issues}</strong><span>Issues</span><small>Requires attention</small></div>
        </div>
      </div>

      <div className="ep-panel">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 18px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px" }}>
            <input
              placeholder="Search by month or reference…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select className="ep-form-select" value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}>
            <option value="">All Statuses</option>
            {uniqueStatuses.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <input type="date" className="ep-form-select" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
          <input type="date" className="ep-form-select" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} title="To date" />
          {hasFilters && (
            <button className="ep-btn-outline" onClick={() => { setSearch(""); setFilterStatus(""); setDateFrom(""); setDateTo(""); setPage(1); }}>
              Clear
            </button>
          )}
        </div>

        <div className="flow-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`flow-tab ${tab === t.key ? "active" : ""}`}
              onClick={() => { setTab(t.key); setPage(1); }}
            >
              {t.label} ({tabCounts[t.key]})
            </button>
          ))}
        </div>

        <div className="ep-table-wrap">
          {filtered.length === 0 ? (
            <div className="ep-empty"><p>No clearances match your filters.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Reference</th>
                  <th>Status</th>
                  <th>Stage</th>
                  <th>Total</th>
                  <th>Advance</th>
                  <th>Balance</th>
                  <th>Cleared On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((c) => (
                  <tr key={c.id}>
                    <td>{c.month || "—"}</td>
                    <td><strong>{claimNumber(c)}</strong></td>
                    <td><span className={`status-pill ${statusTone(c.status)}`}>{statusLabel(c.status)}</span></td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{clearanceStageLabel(c)}</td>
                    <td>{formatMoney(c.claim_total, c.currency)}</td>
                    <td>{formatMoney(c.advance_amount, c.currency)}</td>
                    <td>{formatMoney(c.balance_amount, c.currency)}</td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(c.settled_at)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        {c.status === "DRAFT" ? (
                          <button className="ep-icon-btn" title="Edit" onClick={() => onEdit(c.id)}>
                            <Edit3 size={15} aria-hidden />
                          </button>
                        ) : (
                          <button className="ep-icon-btn" title="Track" onClick={() => onTrack(c.id)}>
                            <RefreshCw size={14} aria-hidden />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Showing {(currentPage - 1) * PAGE_SIZE + 1} to {Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} entries
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>← Prev</button>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>Next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
