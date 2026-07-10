import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Activity, CheckCircle, GitBranch, RefreshCw, Zap } from "lucide-react";

interface Workflow {
  id: string;
  name: string;
  request_type: string;
  advance_sub_type: string | null;
  department: string | null;
  section: string | null;
  status: string;
  steps: any[];
  step_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface Props {
  advances: any[];
  onBack: () => void;
}

function typeChip(rt: string, sub?: string | null) {
  const labels: Record<string, string> = {
    ADVANCE_REQUEST: "Advance", CLEARANCE_REQUEST: "Clearance", OVERTIME_REQUEST: "Overtime",
  };
  const subLabels: Record<string, string> = { SALARY: "Salary", LOAN: "Loan", TRAVEL: "Travel" };
  const label = labels[rt] || rt;
  const subLabel = sub ? subLabels[sub] || sub : null;
  const colors: Record<string, [string, string]> = {
    ADVANCE_REQUEST: ["#eff6ff", "#1d4ed8"],
    CLEARANCE_REQUEST: ["#d1fae5", "#065f46"],
    OVERTIME_REQUEST: ["#fef3c7", "#92400e"],
  };
  const [bg, color] = colors[rt] || ["#f1f5f9", "#64748b"];
  return (
    <div>
      <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color }}>{label}</span>
      {subLabel && <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{subLabel}</span>}
    </div>
  );
}

export default function ReportWorkflowAnalytics({ advances, onBack }: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await api.workflows() as Workflow[];
      setWorkflows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e.message || "Failed to load workflows");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const active   = useMemo(() => workflows.filter(w => w.status === "ACTIVE"), [workflows]);
  const inactive = useMemo(() => workflows.filter(w => w.status !== "ACTIVE"), [workflows]);

  // Group by request type
  const byType = useMemo(() => {
    const m: Record<string, number> = {};
    for (const w of workflows) {
      const k = w.request_type;
      m[k] = (m[k] || 0) + 1;
    }
    return Object.entries(m).sort(([,a],[,b]) => b - a);
  }, [workflows]);

  // Group by department
  const byDept = useMemo(() => {
    const m: Record<string, number> = {};
    for (const w of workflows) {
      const k = w.department || "Global";
      m[k] = (m[k] || 0) + 1;
    }
    return Object.entries(m).sort(([,a],[,b]) => b - a);
  }, [workflows]);

  const avgSteps = useMemo(() => {
    if (!workflows.length) return 0;
    const total = workflows.reduce((s, w) => s + (w.step_count || w.steps?.length || 0), 0);
    return (total / workflows.length).toFixed(1);
  }, [workflows]);

  // Advance coverage: how many advances have a resolved workflow
  const advancesByType = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of advances) {
      const k = a.type || "UNKNOWN";
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  }, [advances]);

  const maxByType = byType.length ? byType[0][1] : 1;

  const typeLabels: Record<string, string> = {
    ADVANCE_REQUEST: "Advance Request", CLEARANCE_REQUEST: "Clearance Request",
    OVERTIME_REQUEST: "Overtime Request",
  };
  const typeColors: Record<string, string> = {
    ADVANCE_REQUEST: "#3b82f6", CLEARANCE_REQUEST: "#10b981", OVERTIME_REQUEST: "#f59e0b",
  };

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Reports</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Workflow Analytics</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Workflow Analytics</h1>
          <p className="ep-subtitle">Insight into workflow configuration, coverage, and complexity across all request types.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && <div style={{ padding: "10px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, color: "#dc2626", marginBottom: 16, fontSize: 13 }}>{error}</div>}

      {/* KPI cards */}
      <div className="ep-kpi-row">
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><GitBranch size={28} /></span>
          <div><div className="stat-value">{workflows.length}</div><div className="stat-label">Total Workflows</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle size={28} /></span>
          <div><div className="stat-value">{active.length}</div><div className="stat-label">Active</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Activity size={28} /></span>
          <div><div className="stat-value">{avgSteps}</div><div className="stat-label">Avg Steps</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><Zap size={28} /></span>
          <div><div className="stat-value">{inactive.length}</div><div className="stat-label">Inactive / Draft</div></div>
        </div>
      </div>

      {loading && !workflows.length ? (
        <div className="ep-panel"><div className="ep-loading"><p>Loading workflows…</p></div></div>
      ) : (
        <>
          {/* By type + by dept */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>

            <div className="ep-panel">
              <div className="ep-panel-head"><div className="ep-panel-title">Workflows by Request Type</div></div>
              <div style={{ padding: "12px 20px" }}>
                {byType.length === 0 ? (
                  <div className="ep-empty" style={{ padding: "20px 0" }}><p>No workflows configured.</p></div>
                ) : byType.map(([type, count]) => (
                  <div key={type} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: typeColors[type] || "#94a3b8", flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{typeLabels[type] || type}</span>
                    <div style={{ width: 120, height: 7, background: "var(--surface-soft)", borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${(count / maxByType) * 100}%`, background: typeColors[type] || "#94a3b8", borderRadius: 99 }} />
                    </div>
                    <span style={{ fontWeight: 700, color: "var(--text)", minWidth: 20, textAlign: "right", fontSize: 13 }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="ep-panel">
              <div className="ep-panel-head"><div className="ep-panel-title">Workflows by Division</div></div>
              <div style={{ padding: "12px 20px", maxHeight: 260, overflowY: "auto" }}>
                {byDept.length === 0 ? (
                  <div className="ep-empty" style={{ padding: "20px 0" }}><p>No workflows configured.</p></div>
                ) : byDept.map(([dept, count]) => {
                  const max = byDept[0][1];
                  return (
                    <div key={dept} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <span style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: dept === "Global" ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dept}</span>
                      <div style={{ width: 100, height: 6, background: "var(--surface-soft)", borderRadius: 99, overflow: "hidden", flexShrink: 0 }}>
                        <div style={{ height: "100%", width: `${(count / max) * 100}%`, background: "#8b5cf6", borderRadius: 99 }} />
                      </div>
                      <span style={{ fontWeight: 700, color: "var(--text)", minWidth: 20, textAlign: "right", fontSize: 13 }}>{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Workflow list */}
          <div className="ep-panel">
            <div className="ep-panel-head"><div className="ep-panel-title">All Workflows</div></div>
            <div className="ep-table-wrap">
              {workflows.length === 0 ? (
                <div className="ep-empty"><p>No workflows found.</p></div>
              ) : (
                <table className="ep-table">
                  <thead>
                    <tr>
                      <th>Workflow Name</th>
                      <th>Request Type</th>
                      <th>Division</th>
                      <th>Department</th>
                      <th>Steps</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workflows.map(w => (
                      <tr key={w.id}>
                        <td style={{ fontWeight: 600 }}>{w.name}</td>
                        <td>{typeChip(w.request_type, w.advance_sub_type)}</td>
                        <td style={{ color: "var(--muted)" }}>{w.department || <span style={{ fontStyle: "italic" }}>Global</span>}</td>
                        <td style={{ color: "var(--muted)" }}>{w.section || "—"}</td>
                        <td>
                          <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 12, fontWeight: 700, background: "#f1f5f9", color: "var(--text)" }}>
                            {w.step_count || w.steps?.length || 0}
                          </span>
                        </td>
                        <td>
                          <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: w.status === "ACTIVE" ? "#d1fae5" : "#f1f5f9", color: w.status === "ACTIVE" ? "#065f46" : "#64748b" }}>
                            {w.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
