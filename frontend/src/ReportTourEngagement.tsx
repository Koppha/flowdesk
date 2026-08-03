import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Users, PlayCircle, CheckCircle, Percent, Download } from "lucide-react";

interface Props {
  onBack: () => void;
}

type ProgressRow = {
  tour_key: string;
  last_step_seen: number;
  total_steps: number;
  completed: boolean;
  completed_at: string | null;
  updated_at: string;
  user_id: string;
  full_name: string | null;
  email: string;
  department: string | null;
  role: string;
};

type UserRow = { id: string; full_name: string | null; email: string; department: string | null; role: string; is_active?: boolean };

// GuidedTour components are keyed by their storageKey - this is the only one
// wired up today (frontend/src/App.tsx's advance request form). Add new
// entries here as more tours get added elsewhere in the app.
const TOUR_LABELS: Record<string, string> = {
  fd_advance_form_tour_seen_v1: "Advance Request Form Walkthrough"
};

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type Status = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";

function statusOf(row: ProgressRow | undefined): Status {
  if (!row) return "NOT_STARTED";
  return row.completed ? "COMPLETED" : "IN_PROGRESS";
}

const STATUS_CONFIG: Record<Status, { label: string; bg: string; color: string }> = {
  NOT_STARTED: { label: "Not Started", bg: "#f1f5f9", color: "#64748b" },
  IN_PROGRESS: { label: "In Progress", bg: "#fef3c7", color: "#92400e" },
  COMPLETED:   { label: "Completed",   bg: "#d1fae5", color: "#065f46" }
};

export default function ReportTourEngagement({ onBack }: Props) {
  const [progress, setProgress] = useState<ProgressRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tourFilter, setTourFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 10;

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [progressData, usersData] = await Promise.all([
        api.tourProgressReport(),
        api.adminUsers()
      ]);
      setProgress(Array.isArray(progressData) ? progressData : []);
      setUsers((Array.isArray(usersData) ? usersData : []).filter((u: UserRow) => u.is_active !== false));
    } catch (e: any) {
      alert("Error loading tour engagement report: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  const tourKeys = useMemo(() => {
    const fromData = new Set(progress.map((p) => p.tour_key));
    Object.keys(TOUR_LABELS).forEach((k) => fromData.add(k));
    return Array.from(fromData);
  }, [progress]);

  const activeTourKey = tourFilter || tourKeys[0] || "";

  // One row per active user for the selected tour - including users who
  // never triggered it at all, so "Not Started" is a real, countable state
  // rather than an absence from the data.
  const rows = useMemo(() => {
    const byUser = new Map(progress.filter((p) => p.tour_key === activeTourKey).map((p) => [p.user_id, p]));
    return users.map((u) => {
      const p = byUser.get(u.id);
      return {
        user: u,
        progressRow: p,
        status: statusOf(p)
      };
    });
  }, [users, progress, activeTourKey]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (r.user.full_name || r.user.email).toLowerCase().includes(q) || (r.user.department || "").toLowerCase().includes(q);
    }
    return true;
  }), [rows, statusFilter, search]);

  useEffect(() => { setPage(1); }, [tourFilter, statusFilter, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const paged = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page]);

  const counts = useMemo(() => ({
    total: rows.length,
    started: rows.filter((r) => r.status !== "NOT_STARTED").length,
    completed: rows.filter((r) => r.status === "COMPLETED").length
  }), [rows]);
  const completionRate = counts.total ? Math.round((counts.completed / counts.total) * 100) : 0;

  function exportCsv() {
    const h = ["Employee", "Email", "Department", "Role", "Status", "Step Reached", "Last Activity"];
    const csvRows = filtered.map((r) => [
      r.user.full_name || "—",
      r.user.email,
      r.user.department || "—",
      r.user.role,
      STATUS_CONFIG[r.status].label,
      r.progressRow ? `${r.progressRow.last_step_seen + 1} of ${r.progressRow.total_steps}` : "—",
      r.progressRow ? fmtDate(r.progressRow.updated_at) : "—"
    ]);
    const csv = [h, ...csvRows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `tour-engagement-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Reports</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Tooltip Engagement</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Tooltip Engagement</h1>
          <p className="ep-subtitle">How far users get through each in-app guided tour before completing or skipping it.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!filtered.length}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      <div className="ep-kpi-row">
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><Users size={28} /></span>
          <div><div className="stat-value">{counts.total}</div><div className="stat-label">Active Users</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><PlayCircle size={28} /></span>
          <div><div className="stat-value">{counts.started}</div><div className="stat-label">Started Tour</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle size={28} /></span>
          <div><div className="stat-value">{counts.completed}</div><div className="stat-label">Completed</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><Percent size={28} /></span>
          <div><div className="stat-value">{completionRate}%</div><div className="stat-label">Completion Rate</div></div>
        </div>
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 200px" }}>
            <input placeholder="Search employee or department…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="ep-form-select" value={tourFilter} onChange={(e) => setTourFilter(e.target.value)} style={{ minWidth: 220 }}>
            {tourKeys.map((k) => <option key={k} value={k}>{TOUR_LABELS[k] || k}</option>)}
          </select>
          <select className="ep-form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            {(["NOT_STARTED", "IN_PROGRESS", "COMPLETED"] as Status[]).map((s) => <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>)}
          </select>
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>{filtered.length} users</span>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-empty"><p>Loading…</p></div>
          ) : filtered.length === 0 ? (
            <div className="ep-empty"><p>No users match your filters.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Step Reached</th>
                  <th>Last Activity</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((r) => {
                  const cfg = STATUS_CONFIG[r.status];
                  return (
                    <tr key={r.user.id}>
                      <td style={{ fontWeight: 600 }}>{r.user.full_name || r.user.email}</td>
                      <td style={{ color: "var(--muted)" }}>{r.user.department || "—"}</td>
                      <td style={{ color: "var(--muted)" }}>{r.user.role}</td>
                      <td>
                        <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                      </td>
                      <td>{r.progressRow ? `${r.progressRow.last_step_seen + 1} of ${r.progressRow.total_steps}` : "—"}</td>
                      <td style={{ fontSize: 12, color: "var(--muted)" }}>{r.progressRow ? fmtDate(r.progressRow.updated_at) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {pageCount > 1 && (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, padding: 16 }}>
            <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Previous</button>
            <span style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap" }}>Page {page} of {pageCount}</span>
            <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
}
