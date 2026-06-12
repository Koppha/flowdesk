import React, { useMemo, useState } from "react";
import { formatMoney } from "./constants";
import { CheckCircle, Clock, TrendingUp, Users, XCircle } from "lucide-react";

interface Props {
  advances: any[];
  onBack: () => void;
}

function fmtH(h: number | null): string {
  if (h == null || h <= 0) return "—";
  const d = h / 24;
  if (d >= 1) return `${d.toFixed(1)}d`;
  return `${h.toFixed(0)}h`;
}

function hoursBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const diff = (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
  return diff > 0 ? diff : null;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const STAGE_COLORS: Record<string, string> = {
  APPROVED: "#059669", PAID: "#7c3aed", REJECTED: "#dc2626",
  SUBMITTED: "#1d4ed8", PENDING_APPROVAL: "#92400e", DRAFT: "#64748b",
  PENDING_PAYMENT: "#92400e",
};

const STAGE_BG: Record<string, string> = {
  APPROVED: "#d1fae5", PAID: "#ede9fe", REJECTED: "#fee2e2",
  SUBMITTED: "#dbeafe", PENDING_APPROVAL: "#fef3c7", DRAFT: "#f1f5f9",
  PENDING_PAYMENT: "#fef3c7",
};

export default function ReportApprovalPerformance({ advances, onBack }: Props) {
  const [filterDept, setFilterDept] = useState("");

  const depts = useMemo(() =>
    [...new Set(advances.map(a => a.department).filter(Boolean))].sort(),
  [advances]);

  const filtered = useMemo(() =>
    filterDept ? advances.filter(a => a.department === filterDept) : advances,
  [advances, filterDept]);

  // Overall metrics
  const metrics = useMemo(() => {
    const withSub = filtered.filter(a => a.submitted_at && a.created_at);
    const withAppr = filtered.filter(a => a.approved_at && a.submitted_at);
    const withPay = filtered.filter(a => a.paid_at && a.approved_at);

    const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

    const subHours  = withSub.map(a => hoursBetween(a.created_at, a.submitted_at)).filter(Boolean) as number[];
    const apprHours = withAppr.map(a => hoursBetween(a.submitted_at, a.approved_at)).filter(Boolean) as number[];
    const payHours  = withPay.map(a => hoursBetween(a.approved_at, a.paid_at)).filter(Boolean) as number[];

    return {
      avgSubmit: avg(subHours),
      avgApprove: avg(apprHours),
      avgPay: avg(payHours),
      totalApproved: filtered.filter(a => ["APPROVED","PAID"].includes(a.status)).length,
      totalRejected: filtered.filter(a => a.status === "REJECTED").length,
      totalPending:  filtered.filter(a => ["SUBMITTED","PENDING_APPROVAL","PENDING_PAYMENT"].includes(a.status)).length,
    };
  }, [filtered]);

  // By-department breakdown
  const deptRows = useMemo(() => {
    const map: Record<string, { total: number; approved: number; rejected: number; pending: number; submitHours: number[]; apprHours: number[] }> = {};
    for (const a of filtered) {
      const d = a.department || "Unassigned";
      if (!map[d]) map[d] = { total: 0, approved: 0, rejected: 0, pending: 0, submitHours: [], apprHours: [] };
      map[d].total++;
      if (["APPROVED","PAID"].includes(a.status)) map[d].approved++;
      else if (a.status === "REJECTED") map[d].rejected++;
      else if (["SUBMITTED","PENDING_APPROVAL","PENDING_PAYMENT"].includes(a.status)) map[d].pending++;
      const sh = hoursBetween(a.created_at, a.submitted_at);
      if (sh) map[d].submitHours.push(sh);
      const ah = hoursBetween(a.submitted_at, a.approved_at);
      if (ah) map[d].apprHours.push(ah);
    }
    return Object.entries(map)
      .map(([dept, d]) => ({
        dept,
        total: d.total,
        approved: d.approved,
        rejected: d.rejected,
        pending: d.pending,
        approvalRate: d.total > 0 ? Math.round((d.approved / d.total) * 100) : 0,
        avgSubmit: d.submitHours.length ? d.submitHours.reduce((s,v)=>s+v,0)/d.submitHours.length : null,
        avgApprove: d.apprHours.length ? d.apprHours.reduce((s,v)=>s+v,0)/d.apprHours.length : null,
      }))
      .sort((a, b) => b.total - a.total);
  }, [filtered]);

  // Recent approvals feed
  const recentActivity = useMemo(() =>
    filtered
      .filter(a => a.approved_at || a.paid_at || a.submitted_at)
      .sort((a, b) => {
        const ta = new Date(a.approved_at || a.paid_at || a.submitted_at || 0).getTime();
        const tb = new Date(b.approved_at || b.paid_at || b.submitted_at || 0).getTime();
        return tb - ta;
      })
      .slice(0, 12),
  [filtered]);

  const rateBar = (pct: number) => {
    const color = pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <div style={{ flex: 1, height: 7, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 99 }} />
        </div>
        <span style={{ minWidth: 38, fontWeight: 700, color, fontSize: 13 }}>{pct}%</span>
      </div>
    );
  };

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Reports</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Approval Performance</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Approval Performance</h1>
          <p className="ep-subtitle">Advance request approval rates, processing times, and department breakdowns.</p>
        </div>
        <div className="ep-actions">
          <select className="ep-form-select" value={filterDept} onChange={e => setFilterDept(e.target.value)} style={{ minWidth: 160 }}>
            <option value="">All Departments</option>
            {depts.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>

      {/* KPI cards */}
      <div className="ep-kpi-row">
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle size={28} /></span>
          <div>
            <div className="stat-value">{metrics.totalApproved}</div>
            <div className="stat-label">Approved / Paid</div>
          </div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Clock size={28} /></span>
          <div>
            <div className="stat-value">{metrics.totalPending}</div>
            <div className="stat-label">Pending Approval</div>
          </div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><XCircle size={28} /></span>
          <div>
            <div className="stat-value">{metrics.totalRejected}</div>
            <div className="stat-label">Rejected</div>
          </div>
        </div>
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><TrendingUp size={28} /></span>
          <div>
            <div className="stat-value">
              {filtered.length > 0 ? Math.round((metrics.totalApproved / filtered.length) * 100) : 0}%
            </div>
            <div className="stat-label">Approval Rate</div>
          </div>
        </div>
      </div>

      {/* Avg stage times */}
      <div className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head"><div className="ep-panel-title">Average Processing Times</div></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 0 }}>
          {[
            { label: "Draft → Submitted",     val: metrics.avgSubmit,  icon: <Clock size={20} style={{color:"#3b82f6"}}/>,  bg: "#eff6ff" },
            { label: "Submitted → Approved",  val: metrics.avgApprove, icon: <Users size={20} style={{color:"#059669"}}/>, bg: "#d1fae5" },
            { label: "Approved → Paid",       val: metrics.avgPay,     icon: <CheckCircle size={20} style={{color:"#7c3aed"}}/>, bg: "#ede9fe" },
          ].map(({ label, val, icon, bg }) => (
            <div key={label} style={{ padding: "20px 24px", borderRight: "1px solid #f1f5f9" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <span style={{ width: 36, height: 36, borderRadius: "50%", background: bg, display: "flex", alignItems: "center", justifyContent: "center" }}>{icon}</span>
                <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>{label}</span>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "var(--text)" }}>{fmtH(val)}</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>average across {filtered.length} requests</div>
            </div>
          ))}
        </div>
      </div>

      {/* Dept breakdown + recent activity */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>

        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Performance by Department</div></div>
          <div className="ep-table-wrap">
            {deptRows.length === 0 ? (
              <div className="ep-empty"><p>No data available.</p></div>
            ) : (
              <table className="ep-table">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th>Total</th>
                    <th>Approved</th>
                    <th>Rejected</th>
                    <th>Pending</th>
                    <th>Avg Submit</th>
                    <th>Avg Approve</th>
                    <th>Approval Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {deptRows.map(d => (
                    <tr key={d.dept}>
                      <td style={{ fontWeight: 600 }}>{d.dept}</td>
                      <td>{d.total}</td>
                      <td><span style={{ color: "#059669", fontWeight: 700 }}>{d.approved}</span></td>
                      <td><span style={{ color: d.rejected > 0 ? "#dc2626" : "var(--muted)", fontWeight: d.rejected > 0 ? 700 : 400 }}>{d.rejected}</span></td>
                      <td><span style={{ color: d.pending > 0 ? "#d97706" : "var(--muted)" }}>{d.pending}</span></td>
                      <td style={{ color: "var(--muted)", fontSize: 12 }}>{fmtH(d.avgSubmit)}</td>
                      <td style={{ color: "var(--muted)", fontSize: 12 }}>{fmtH(d.avgApprove)}</td>
                      <td style={{ minWidth: 130 }}>{rateBar(d.approvalRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Recent Activity</div></div>
          <div style={{ padding: "8px 0" }}>
            {recentActivity.length === 0 ? (
              <div className="ep-empty"><p>No recent activity.</p></div>
            ) : recentActivity.map((a, i) => {
              const lastDate = a.paid_at || a.approved_at || a.submitted_at;
              const action = a.paid_at ? "Paid" : a.approved_at ? "Approved" : "Submitted";
              const [bg, color] = [STAGE_BG[a.status] || "#f1f5f9", STAGE_COLORS[a.status] || "#64748b"];
              return (
                <div key={a.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 20px", borderBottom: i < recentActivity.length - 1 ? "1px solid #f8fafc" : "none" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, marginTop: 5, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{a.requester_name || "—"}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>{a.department || "—"} · {action} {fmtDate(lastDate)}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color }}>{a.status}</span>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{formatMoney(a.approved_total || a.requested_total, "LSL")}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
