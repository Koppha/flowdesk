import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Users, Clock3, UserCheck, FileText, RefreshCw, Search } from "lucide-react";

interface Props {
  onDelegate: () => void;
}

type Member = {
  id: string;
  full_name: string | null;
  email: string;
  title: string | null;
  role: string;
  department: string | null;
  is_active: boolean;
  pending_requests: number;
  total_requests: number;
  last_activity: string | null;
};

type Delegation = {
  id: string;
  delegate_id: string;
  delegate_name?: string;
  from_date: string | null;
  to_date: string | null;
  active: boolean;
};

type ActivityRow = {
  id: string;
  action: string;
  entity_type: string;
  created_at: string;
  actor_name: string;
};

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function humanizeAction(action: string) {
  return action.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function MyTeam({ onDelegate }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [activeDelegation, setActiveDelegation] = useState<Delegation | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 10;

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data: any = await api.myTeam();
      setMembers(Array.isArray(data?.members) ? data.members : []);
      setActiveDelegation(data?.active_delegation || null);
      setRecentActivity(Array.isArray(data?.recent_activity) ? data.recent_activity : []);
    } catch (e: any) {
      alert("Error loading your team: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => members.filter((m) => {
    if (statusFilter === "active" && !m.is_active) return false;
    if (statusFilter === "inactive" && m.is_active) return false;
    if (statusFilter === "pending" && !m.pending_requests) return false;
    if (search) {
      const q = search.toLowerCase();
      return (m.full_name || m.email).toLowerCase().includes(q) || (m.title || "").toLowerCase().includes(q);
    }
    return true;
  }), [members, search, statusFilter]);

  useEffect(() => { setPage(1); }, [search, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const paged = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page]);

  const counts = useMemo(() => ({
    members: members.length,
    pendingRequests: members.reduce((s, m) => s + m.pending_requests, 0),
    totalRequests: members.reduce((s, m) => s + m.total_requests, 0)
  }), [members]);

  const maxPending = Math.max(1, ...members.map((m) => m.pending_requests));

  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">My Team</h1>
          <p className="ep-subtitle">Overview of the people who report to you and their open requests.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} aria-hidden /> {loading ? "Loading…" : "Refresh"}
          </button>
          <button className="ep-btn" onClick={onDelegate}>
            <UserCheck size={14} aria-hidden /> Delegate Approval
          </button>
        </div>
      </div>

      <div className="ep-kpi-row">
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><Users size={28} /></span>
          <div><div className="stat-value">{counts.members}</div><div className="stat-label">Team Members</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Clock3 size={28} /></span>
          <div><div className="stat-value">{counts.pendingRequests}</div><div className="stat-label">Pending Requests</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><UserCheck size={28} /></span>
          <div><div className="stat-value">{activeDelegation ? 1 : 0}</div><div className="stat-label">Active Delegation</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><FileText size={28} /></span>
          <div><div className="stat-value">{counts.totalRequests}</div><div className="stat-label">Total Requests</div></div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, alignItems: "start" }}>
        <div>
          <div className="ep-panel" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
              <div className="ep-search" style={{ flex: "1 1 200px" }}>
                <Search size={14} />
                <input placeholder="Search team members…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <select className="ep-form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="pending">Has Pending Requests</option>
              </select>
              <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>{filtered.length} of {members.length} members</span>
            </div>
          </div>

          <div className="ep-panel">
            <div className="ep-table-wrap">
              {loading ? (
                <div className="ep-empty"><p>Loading…</p></div>
              ) : filtered.length === 0 ? (
                <div className="ep-empty"><p>{members.length === 0 ? "No one currently reports to you." : "No team members match your filters."}</p></div>
              ) : (
                <table className="ep-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Position</th>
                      <th>Status</th>
                      <th>Pending Requests</th>
                      <th>Total Requests</th>
                      <th>Last Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((m) => (
                      <tr key={m.id}>
                        <td style={{ fontWeight: 600 }}>{m.full_name || m.email}</td>
                        <td style={{ color: "var(--muted)" }}>{m.title || m.role}</td>
                        <td>
                          <span className={`status-pill ${m.is_active ? "status-pill-success" : "status-pill-danger"}`}>
                            {m.is_active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td>{m.pending_requests}</td>
                        <td style={{ color: "var(--muted)" }}>{m.total_requests}</td>
                        <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(m.last_activity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {pageCount > 1 && (
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, padding: 16 }}>
                <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Previous</button>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>Page {page} of {pageCount}</span>
                <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>Next</button>
              </div>
            )}
          </div>
        </div>

        <div>
          {members.length > 0 && (
            <div className="ep-panel" style={{ marginBottom: 14, padding: "16px 20px" }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Pending Requests by Member</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {members.slice(0, 8).map((m) => (
                  <div key={m.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                      <span>{m.full_name || m.email}</span>
                      <span style={{ color: "var(--muted)" }}>{m.pending_requests}</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: "var(--surface-soft, #f1f5f9)" }}>
                      <div style={{ height: 6, borderRadius: 3, width: `${(m.pending_requests / maxPending) * 100}%`, background: m.pending_requests > 0 ? "#f59e0b" : "var(--border)" }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="ep-panel" style={{ marginBottom: 14, padding: "16px 20px" }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Active Delegation</div>
            {activeDelegation ? (
              <div style={{ fontSize: 13 }}>
                <div>You're delegating to <strong>{activeDelegation.delegate_name || "—"}</strong></div>
                <div style={{ color: "var(--muted)", marginTop: 4 }}>
                  {fmtDate(activeDelegation.from_date)} → {fmtDate(activeDelegation.to_date)}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>No active delegation. Use "Delegate Approval" if you'll be away.</div>
            )}
          </div>

          <div className="ep-panel" style={{ padding: "16px 20px" }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Recent Team Activity</div>
            {recentActivity.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>No recent activity from your team.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {recentActivity.map((a) => (
                  <div key={a.id} style={{ fontSize: 12, borderLeft: "2px solid var(--border)", paddingLeft: 8 }}>
                    <strong>{a.actor_name}</strong> — {humanizeAction(a.action)}
                    <div style={{ color: "var(--muted)" }}>{new Date(a.created_at).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
