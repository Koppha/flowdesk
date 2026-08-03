import React, { useEffect, useMemo, useState } from "react";
import { formatMoney, travelTypeLabel, TravelType } from "./constants";
import { Activity, CheckCircle, Clock, Download, FileText, XCircle } from "lucide-react";

function travelTypeCurrency(code: string | null | undefined, travelTypes: TravelType[]) {
  return travelTypes.find((type) => type.code === code)?.currency ?? "LSL";
}

interface Props {
  advances: any[];
  claims: any[];
  travelTypes: any[];
  onBack: () => void;
}

type AuditEntry = {
  id: string;
  timestamp: string;
  action: string;
  actor: string;
  department: string;
  requestType: string;
  amount: string;
  status: string;
  entityId: string;
};

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function timeAgo(s: string): string {
  const ms = Date.now() - new Date(s).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const ACTION_CONFIG: Record<string, { label: string; icon: React.ReactNode; bg: string; color: string }> = {
  SUBMITTED:        { label: "Submitted",        icon: <FileText size={14}/>,   bg: "#dbeafe", color: "#1d4ed8" },
  APPROVED:         { label: "Approved",          icon: <CheckCircle size={14}/>,bg: "#d1fae5", color: "#065f46" },
  PAID:             { label: "Paid",              icon: <CheckCircle size={14}/>,bg: "#ede9fe", color: "#6d28d9" },
  REJECTED:         { label: "Rejected",          icon: <XCircle size={14}/>,    bg: "#fee2e2", color: "#dc2626" },
  PENDING_APPROVAL: { label: "Pending Approval",  icon: <Clock size={14}/>,      bg: "#fef3c7", color: "#92400e" },
  DRAFT:            { label: "Created (Draft)",   icon: <FileText size={14}/>,   bg: "#f1f5f9", color: "#64748b" },
  PENDING_PAYMENT:  { label: "Pending Payment",   icon: <Clock size={14}/>,      bg: "#fef3c7", color: "#92400e" },
};

export default function ReportAuditTrail({ advances, claims, travelTypes, onBack }: Props) {
  const [filterAction, setFilterAction] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Build audit entries from advance + claim timestamps
  const entries = useMemo((): AuditEntry[] => {
    const list: AuditEntry[] = [];

    for (const a of advances) {
      const addEntry = (ts: string | null, action: string) => {
        if (!ts) return;
        list.push({
          id: `adv-${a.id}-${action}`,
          timestamp: ts,
          action,
          actor: a.requester_name || "Unknown",
          department: a.department || "—",
          requestType: "Advance · " + travelTypeLabel(a.type, travelTypes),
          amount: formatMoney(a.approved_total || a.requested_total, travelTypeCurrency(a.type, travelTypes)),
          status: action,
          entityId: a.id,
        });
      };
      if (a.created_at)   addEntry(a.created_at,   a.status === "DRAFT" ? "DRAFT" : "SUBMITTED");
      if (a.submitted_at && a.submitted_at !== a.created_at) addEntry(a.submitted_at, "SUBMITTED");
      if (a.approved_at)  addEntry(a.approved_at,  "APPROVED");
      if (a.paid_at)      addEntry(a.paid_at,       "PAID");
      if (a.status === "REJECTED" && (a.updated_at || a.approved_at)) {
        addEntry(a.updated_at || a.approved_at, "REJECTED");
      }
    }

    for (const c of claims) {
      const addEntry = (ts: string | null, action: string) => {
        if (!ts) return;
        list.push({
          id: `clm-${c.id}-${action}`,
          timestamp: ts,
          action,
          actor: c.requester_name || c.claimant_name || "Unknown",
          department: c.department || "—",
          requestType: "Clearance",
          amount: formatMoney(c.claim_total || c.approved_total, c.currency ?? "LSL"),
          status: action,
          entityId: c.id,
        });
      };
      if (c.created_at) addEntry(c.created_at, "SUBMITTED");
      if (c.approved_at) addEntry(c.approved_at, "APPROVED");
      if (c.paid_at) addEntry(c.paid_at, "PAID");
    }

    return list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [advances, claims, travelTypes]);

  const depts = useMemo(() => [...new Set(entries.map(e => e.department).filter(d => d !== "—"))].sort(), [entries]);

  const filtered = useMemo(() => entries.filter(e => {
    if (filterAction && e.action !== filterAction) return false;
    if (filterDept && e.department !== filterDept) return false;
    if (search) {
      const q = search.toLowerCase();
      return e.actor.toLowerCase().includes(q) || e.department.toLowerCase().includes(q) || e.requestType.toLowerCase().includes(q);
    }
    return true;
  }), [entries, filterAction, filterDept, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [filterAction, filterDept, search]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page]
  );

  const counts = useMemo(() => ({
    total:    entries.length,
    today:    entries.filter(e => new Date(e.timestamp).toDateString() === new Date().toDateString()).length,
    approved: entries.filter(e => e.action === "APPROVED").length,
    rejected: entries.filter(e => e.action === "REJECTED").length,
  }), [entries]);

  function exportCsv() {
    const h = ["Timestamp","Action","Actor","Division","Request Type","Amount"];
    const rows = filtered.map(e => [fmtDate(e.timestamp), ACTION_CONFIG[e.action]?.label || e.action, e.actor, e.department, e.requestType, e.amount]);
    const csv = [h, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `audit-trail-${new Date().toISOString().slice(0,10)}.csv`;
    el.click();
  }

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Reports</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Audit Trail</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Audit Trail</h1>
          <p className="ep-subtitle">Chronological log of all advance and clearance activity across the system.</p>
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
          <span className="stat-icon"><Activity size={28} /></span>
          <div><div className="stat-value">{counts.total}</div><div className="stat-label">Total Events</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Clock size={28} /></span>
          <div><div className="stat-value">{counts.today}</div><div className="stat-label">Today</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle size={28} /></span>
          <div><div className="stat-value">{counts.approved}</div><div className="stat-label">Approvals</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><XCircle size={28} /></span>
          <div><div className="stat-value">{counts.rejected}</div><div className="stat-label">Rejections</div></div>
        </div>
      </div>

      {/* Filters */}
      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 200px" }}>
            <input placeholder="Search actor, division, type…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="ep-form-select" value={filterAction} onChange={e => setFilterAction(e.target.value)}>
            <option value="">All Actions</option>
            {Object.entries(ACTION_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select className="ep-form-select" value={filterDept} onChange={e => setFilterDept(e.target.value)} style={{ minWidth: 160 }}>
            <option value="">All Divisions</option>
            {depts.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>{filtered.length} events</span>
        </div>
      </div>

      {/* Timeline / table */}
      <div className="ep-panel">
        <div style={{ padding: "0 0 4px" }}>
          {filtered.length === 0 ? (
            <div className="ep-empty"><p>No audit events match your filters.</p></div>
          ) : (
            <>
              {paged.map((e, i) => {
                const cfg = ACTION_CONFIG[e.action] || { label: e.action, icon: <Activity size={14}/>, bg: "#f1f5f9", color: "#64748b" };
                return (
                  <div key={e.id} style={{ display: "flex", gap: 14, padding: "12px 20px", borderBottom: i < paged.length - 1 ? "1px solid #f8fafc" : "none", alignItems: "flex-start" }}>
                    {/* Timeline dot */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 2 }}>
                      <span style={{ width: 30, height: 30, borderRadius: "50%", background: cfg.bg, color: cfg.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {cfg.icon}
                      </span>
                      {i < paged.length - 1 && (
                        <div style={{ width: 2, flex: 1, background: "#f1f5f9", marginTop: 4, minHeight: 12 }} />
                      )}
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>{e.actor}</span>
                          <span style={{ fontSize: 13, color: "var(--muted)", marginLeft: 6 }}>·</span>
                          <span style={{ marginLeft: 6, padding: "1px 8px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{e.amount}</span>
                          <span style={{ fontSize: 11, color: "var(--muted)" }}>{timeAgo(e.timestamp)}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                        {e.department} · {e.requestType} · {fmtDate(e.timestamp)}
                      </div>
                    </div>
                  </div>
                );
              })}

              {pageCount > 1 && (
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, padding: 16 }}>
                  <button className="ep-btn-outline" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
                    Previous
                  </button>
                  <span style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap" }}>Page {page} of {pageCount}</span>
                  <button className="ep-btn-outline" onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
