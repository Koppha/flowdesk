import { useEffect, useMemo, useState } from "react";
import { api, openBlobInNewTab } from "./api";
import Swal from "sweetalert2";
import { Briefcase, Calendar, CheckCircle2, ChevronLeft, ClipboardList, Clock3, Eye, FileBarChart, FileText, Plus, Trash2, UserPlus, Wallet } from "lucide-react";
import { ApprovalRouteBuilder, useApprovalTitleOptions } from "./components/ApprovalRoute";
import { ClaimTrackingTimeline } from "./components/ClaimTrackingTimeline";
import { useDelegationScope, DelegationScopeBar, DelegatedTag } from "./components/DelegationScope";

type StandbyProps = {
  profile: any;
  role: string;
  onBack: () => void;
  deepLink?: { kind: "REQUEST" | "CLAIM"; id: string } | null;
  onDeepLinkConsumed?: () => void;
};

type View =
  | "DASHBOARD"
  | "ROSTERS"
  | "ROSTER_DETAIL"
  | "MY_STANDBY"
  | "CLAIM"
  | "CLAIMS"
  | "APPROVALS"
  | "CLAIM_REVIEW"
  | "FINANCE_QUEUE"
  | "FINANCE_PROCESS"
  | "DELEGATIONS"
  | "WHOS_ON_STANDBY"
  | "REPORTS";

const STANDBY_POLICY_ROLES = ["MANAGER", "HOD", "EXCO", "FINANCE", "CEO"];

function monthLabel(month: string) {
  if (!month) return "";
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    DRAFT: { bg: "#f1f5f9", color: "#475569" },
    PUBLISHED: { bg: "#dcfce7", color: "#15803d" },
    SUBMITTED: { bg: "#dbeafe", color: "#1d4ed8" },
    FINANCE_PROCESSING: { bg: "#fef3c7", color: "#b45309" },
    PAYMENT_PENDING: { bg: "#fef3c7", color: "#b45309" },
    PAID: { bg: "#dcfce7", color: "#15803d" },
    CLOSED: { bg: "#e0e7ff", color: "#4338ca" },
    REJECTED: { bg: "#fee2e2", color: "#b91c1c" },
    RETURNED: { bg: "#fef3c7", color: "#b45309" }
  };
  const style = colors[status] || { bg: "#f1f5f9", color: "#475569" };
  return (
    <span style={{ background: style.bg, color: style.color, fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 999, textTransform: "capitalize" }}>
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

export default function Standby({ profile, role, onBack, deepLink, onDeepLinkConsumed }: StandbyProps) {
  const [view, setView] = useState<View>("DASHBOARD");
  const [loading, setLoading] = useState(false);

  const [dashboard, setDashboard] = useState<any>(null);
  const [teams, setTeams] = useState<any[]>([]);
  const [orgStructure, setOrgStructure] = useState<{ divisions: any[]; departments: any[]; sections: any[]; teams: any[] }>({ divisions: [], departments: [], sections: [], teams: [] });
  const [rosters, setRosters] = useState<any[]>([]);
  const [rosterId, setRosterId] = useState("");
  const [rosterDetail, setRosterDetail] = useState<any>(null);

  const [myMonth, setMyMonth] = useState(currentMonth());
  const [myStandby, setMyStandby] = useState<any>(null);

  const [claimId, setClaimId] = useState("");
  const [claim, setClaim] = useState<any>(null);
  const [claims, setClaims] = useState<any[]>([]);

  const [approvals, setApprovals] = useState<any[]>([]);
  const [financeQueue, setFinanceQueue] = useState<any[]>([]);

  const isManager = role === "MANAGER" || role === "ADMIN" || teams.some((t) => t.leader_user_id === profile?.id);
  const isFinance = Boolean(dashboard?.is_finance) || role === "ADMIN";

  useEffect(() => {
    void loadDashboard();
    void loadTeams();
    if (role === "ADMIN") void loadOrgStructure();
  }, []);

  // Keeps the active tab's data current without a manual click — the
  // Approvals tab only used to fetch once, so a claim that landed on
  // someone's step after they'd opened the page stayed invisible until
  // they clicked away and back. Re-fetches quietly (no loading spinner)
  // every 30s for whichever tab is currently open.
  useEffect(() => {
    const interval = setInterval(() => {
      if (view === "DASHBOARD") void loadDashboard();
      if (view === "APPROVALS") void loadApprovals(true);
      if (view === "FINANCE_QUEUE") void loadFinanceQueue(true);
    }, 30000);
    return () => clearInterval(interval);
  }, [view]);

  async function loadOrgStructure() {
    try {
      const result: any = await api.orgStructure();
      setOrgStructure({
        divisions: Array.isArray(result?.divisions) ? result.divisions : [],
        departments: Array.isArray(result?.departments) ? result.departments : [],
        sections: Array.isArray(result?.sections) ? result.sections : [],
        teams: Array.isArray(result?.teams) ? result.teams : []
      });
    } catch {
      // ADMIN cascading picker just falls back to the flat team list
    }
  }

  async function loadDashboard(silent = false) {
    try {
      setDashboard(await api.standbyDashboard());
    } catch (e: any) {
      if (silent) return;
      void Swal.fire({ icon: "error", title: "Failed to load dashboard", text: e.message });
    }
  }

  async function loadTeams() {
    try {
      setTeams(await api.standbyTeams());
    } catch {
      // non-fatal — manager-only screens will just show empty
    }
  }

  async function loadRosters() {
    setLoading(true);
    try {
      setRosters(await api.standbyRosters());
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Failed to load rosters", text: e.message });
    } finally {
      setLoading(false);
    }
  }

  async function openRoster(id: string) {
    setLoading(true);
    try {
      setRosterId(id);
      setRosterDetail(await api.standbyRoster(id));
      setView("ROSTER_DETAIL");
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Failed to load roster", text: e.message });
    } finally {
      setLoading(false);
    }
  }

  async function refreshRoster() {
    if (!rosterId) return;
    setRosterDetail(await api.standbyRoster(rosterId));
  }

  async function loadMyStandby(month: string) {
    setLoading(true);
    try {
      setMyMonth(month);
      setMyStandby(await api.myStandby(month));
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Failed to load your standby", text: e.message });
    } finally {
      setLoading(false);
    }
  }

  async function openClaim(id: string) {
    setLoading(true);
    try {
      setClaimId(id);
      setClaim(await api.standbyClaim(id));
      setView("CLAIM");
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Failed to load claim", text: e.message });
    } finally {
      setLoading(false);
    }
  }

  // Arriving here from the Inbox with a specific claim to review — open it
  // directly instead of landing on the Dashboard, then tell the parent the
  // link's been used so it doesn't re-fire on a later visit to this page.
  useEffect(() => {
    if (!deepLink) return;
    void openClaim(deepLink.id).finally(() => onDeepLinkConsumed?.());
  }, [deepLink]);

  async function loadClaims() {
    setLoading(true);
    try {
      setClaims(await api.standbyClaims());
    } finally {
      setLoading(false);
    }
  }

  async function loadApprovals(silent = false) {
    if (!silent) setLoading(true);
    try {
      setApprovals(await api.standbyApprovals());
    } catch (err) {
      if (silent) return;
      throw err;
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function loadFinanceQueue(silent = false) {
    if (!silent) setLoading(true);
    try {
      setFinanceQueue(await api.standbyFinanceQueue());
    } catch (err) {
      if (silent) return;
      throw err;
    } finally {
      if (!silent) setLoading(false);
    }
  }

  function TabBar() {
    const tabs: { key: View; label: string; icon: any; show: boolean }[] = [
      { key: "DASHBOARD", label: "Dashboard", icon: Briefcase, show: true },
      { key: "ROSTERS", label: "Rosters", icon: Calendar, show: isManager },
      { key: "DELEGATIONS", label: "My Delegations", icon: UserPlus, show: isManager },
      { key: "WHOS_ON_STANDBY", label: "Who's on Standby", icon: Eye, show: true },
      { key: "MY_STANDBY", label: "My Standby", icon: Clock3, show: true },
      { key: "CLAIMS", label: "My Claims", icon: ClipboardList, show: true },
      { key: "APPROVALS", label: "Approvals", icon: CheckCircle2, show: true },
      { key: "FINANCE_QUEUE", label: "Finance Queue", icon: Wallet, show: isFinance },
      { key: "REPORTS", label: "Reports", icon: FileBarChart, show: role === "ADMIN" || isFinance }
    ];
    return (
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 18, flexWrap: "wrap" }}>
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setView(t.key);
              if (t.key === "ROSTERS") void loadRosters();
              if (t.key === "MY_STANDBY") void loadMyStandby(myMonth);
              if (t.key === "CLAIMS") void loadClaims();
              if (t.key === "APPROVALS") void loadApprovals();
              if (t.key === "FINANCE_QUEUE") void loadFinanceQueue();
              if (t.key === "DASHBOARD") void loadDashboard();
            }}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", fontSize: 13, fontWeight: 600,
              border: "none", background: "none", cursor: "pointer",
              color: view === t.key ? "#1d4ed8" : "var(--muted)",
              borderBottom: view === t.key ? "2px solid #1d4ed8" : "2px solid transparent"
            }}
          >
            <t.icon size={14} aria-hidden />{t.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="workflow-page">
      <div className="page-heading workflow-page-heading">
        <div>
          <h2>Standby Roster &amp; Claim Management</h2>
          <p>Monthly standby scheduling, claims, approvals and Finance processing.</p>
        </div>
        <button className="button button-subtle" type="button" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden />Back
        </button>
      </div>

      <TabBar />

      {loading && <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</p>}

      {view === "DASHBOARD" && dashboard && (
        <>
          <div className="ep-kpi-row">
            <div className="ep-kpi ep-kpi-blue"><Calendar size={22} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{dashboard.active_rosters}</div><div className="ep-kpi-label">Active Rosters</div></div></div>
            <div className="ep-kpi ep-kpi-gold"><ClipboardList size={22} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{dashboard.awaiting_claims}</div><div className="ep-kpi-label">Awaiting Claims</div></div></div>
            <div className="ep-kpi ep-kpi-purple"><CheckCircle2 size={22} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{dashboard.in_approval}</div><div className="ep-kpi-label">In Approval</div></div></div>
            <div className="ep-kpi ep-kpi-cyan"><Wallet size={22} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{dashboard.finance_processing}</div><div className="ep-kpi-label">Finance Processing</div></div></div>
          </div>

          <section className="ep-panel" style={{ marginTop: 18 }}>
            <div className="ep-panel-head"><div className="ep-panel-title">Who's on Standby Today</div></div>
            <div className="ep-table-wrap">
              <table className="ep-table">
                <thead><tr><th>Employee</th><th>Position</th><th>Email</th><th>Phone</th><th>From</th><th>To</th></tr></thead>
                <tbody>
                  {(!dashboard.on_standby_today || dashboard.on_standby_today.length === 0) && (
                    <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>Nobody on standby today.</td></tr>
                  )}
                  {(dashboard.on_standby_today || []).map((p: any, idx: number) => (
                    <tr key={idx}>
                      <td>{p.full_name}</td>
                      <td>{p.title || "—"}</td>
                      <td>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : "—"}</td>
                      <td>{p.phone ? <a href={`tel:${p.phone}`}>{p.phone}</a> : "—"}</td>
                      <td>{p.start_time}</td>
                      <td>{p.end_time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {view === "ROSTERS" && (
        <RostersScreen
          role={role}
          teams={teams}
          orgStructure={orgStructure}
          rosters={rosters}
          onOpen={(id) => void openRoster(id)}
          onCreated={() => void loadRosters()}
        />
      )}

      {view === "ROSTER_DETAIL" && rosterDetail && (
        <RosterDetailScreen
          role={role}
          roster={rosterDetail}
          onBack={() => setView("ROSTERS")}
          onChanged={() => void refreshRoster()}
          onCancelled={() => { setView("ROSTERS"); void loadRosters(); }}
        />
      )}

      {view === "MY_STANDBY" && (
        <MyStandbyScreen
          month={myMonth}
          data={myStandby}
          onMonthChange={(m) => void loadMyStandby(m)}
          onGenerateClaim={async () => {
            try {
              const result: any = await api.generateStandbyClaim(myMonth);
              await openClaim(result.id);
            } catch (e: any) {
              void Swal.fire({ icon: "error", title: "Could not generate claim", text: e.message });
            }
          }}
          onOpenClaim={(id) => void openClaim(id)}
        />
      )}

      {view === "CLAIMS" && (
        <ClaimsListScreen claims={claims} onOpen={(id) => void openClaim(id)} />
      )}

      {view === "CLAIM" && claim && (
        <ClaimScreen
          claim={claim}
          onBack={() => setView("MY_STANDBY")}
          onRefresh={async () => setClaim(await api.standbyClaim(claimId))}
          onOpenClaim={(id) => void openClaim(id)}
        />
      )}

      {view === "APPROVALS" && (
        <ApprovalsScreen
          approvals={approvals}
          onOpen={(id) => void openClaim(id)}
        />
      )}

      {view === "FINANCE_QUEUE" && (
        <FinanceQueueScreen
          queue={financeQueue}
          onOpen={(id) => void openClaim(id)}
        />
      )}

      {view === "DELEGATIONS" && (
        <DelegationsScreen teams={teams.filter((t) => t.leader_user_id === profile?.id || role === "ADMIN")} />
      )}

      {view === "WHOS_ON_STANDBY" && <WhosOnStandbyScreen />}

      {view === "REPORTS" && <ReportsScreen role={role} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rosters list + create
// ---------------------------------------------------------------------------

function RostersScreen({
  role,
  teams,
  orgStructure,
  rosters,
  onOpen,
  onCreated
}: {
  role: string;
  teams: any[];
  orgStructure: { divisions: any[]; departments: any[]; sections: any[]; teams: any[] };
  rosters: any[];
  onOpen: (id: string) => void;
  onCreated: () => void;
}) {
  const [teamId, setTeamId] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [creating, setCreating] = useState(false);

  // ADMIN isn't scoped to one Section like a Section Manager is, so they
  // narrow down the full org hierarchy — Company -> Division -> Department
  // -> Section — rather than picking from a single flat team list.
  const [companyId, setCompanyId] = useState("");
  const [divisionId, setDivisionId] = useState("");
  const [departmentId, setDepartmentId] = useState("");

  const divisionOptions = useMemo(
    () => orgStructure.departments.filter((d) => d.active !== false && (companyId ? (d.division_ids || []).includes(companyId) || d.division_id === companyId : true)),
    [orgStructure.departments, companyId]
  );
  const departmentOptions = useMemo(
    () => orgStructure.sections.filter((s) => s.active !== false && (divisionId ? s.department_id === divisionId : true)),
    [orgStructure.sections, divisionId]
  );
  const sectionOptions = useMemo(
    () => orgStructure.teams.filter((t) => t.active !== false && (departmentId ? t.section_id === departmentId : true)),
    [orgStructure.teams, departmentId]
  );

  async function create() {
    if (!teamId) return void Swal.fire({ icon: "warning", title: "Choose a Section" });
    setCreating(true);
    try {
      const result: any = await api.createStandbyRoster({ team_id: teamId, roster_month: month });
      onCreated();
      onOpen(result.id);
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not create roster", text: e.message });
    } finally {
      setCreating(false);
    }
  }

  async function cancelRoster(id: string) {
    const confirm = await Swal.fire({ title: "Cancel this roster?", text: "The draft and any standby already assigned will be removed.", icon: "warning", showCancelButton: true, confirmButtonText: "Cancel Roster", confirmButtonColor: "#b91c1c" });
    if (!confirm.isConfirmed) return;
    try {
      await api.cancelStandbyRoster(id);
      onCreated();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not cancel roster", text: e.message });
    }
  }

  return (
    <div>
      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head"><div className="ep-panel-title">New Standby Roster</div><div className="ep-panel-sub">Select the roster month and Section — organisational context is populated automatically.</div></div>
        <div className="ep-panel-body" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>Roster Period</div>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="review-control" />
          </label>

          {role === "ADMIN" ? (
            <>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, fontWeight: 600 }}>Company</div>
                <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setDivisionId(""); setDepartmentId(""); setTeamId(""); }} className="review-control">
                  <option value="">All Companies</option>
                  {orgStructure.divisions.filter((d) => d.active !== false).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, fontWeight: 600 }}>Division</div>
                <select value={divisionId} onChange={(e) => { setDivisionId(e.target.value); setDepartmentId(""); setTeamId(""); }} className="review-control">
                  <option value="">All Divisions</option>
                  {divisionOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, fontWeight: 600 }}>Department</div>
                <select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setTeamId(""); }} className="review-control">
                  <option value="">All Departments</option>
                  {departmentOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, fontWeight: 600 }}>Section</div>
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="review-control">
                  <option value="">Select Section…</option>
                  {sectionOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            </>
          ) : (
            <label style={{ fontSize: 13 }}>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Section</div>
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="review-control">
                <option value="">Select Section…</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}

          <button className="ep-btn" type="button" disabled={creating} onClick={() => void create()}>
            <Plus size={14} aria-hidden /> Create Roster
          </button>
        </div>
      </section>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Current Rosters</div></div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Period</th><th>Section</th><th>Employees</th><th>Assignments</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rosters.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>No rosters yet.</td></tr>}
              {rosters.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}>
                  <td>{monthLabel(String(r.roster_month).slice(0, 7))}</td>
                  <td>{r.team_name}</td>
                  <td>{r.employee_count}</td>
                  <td>{r.assignment_count}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td style={{ display: "flex", gap: 12 }}>
                    <a href="#" onClick={(e) => { e.preventDefault(); onOpen(r.id); }}>{r.status === "DRAFT" ? "Continue" : "View"}</a>
                    {r.status === "DRAFT" && (
                      <a
                        href="#"
                        style={{ color: "#b91c1c" }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void cancelRoster(r.id);
                        }}
                      >
                        Cancel
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster detail — assign standby + publish
// ---------------------------------------------------------------------------

function RosterDetailScreen({ role, roster, onBack, onChanged, onCancelled }: { role: string; roster: any; onBack: () => void; onChanged: () => void; onCancelled: () => void }) {
  const [showAssign, setShowAssign] = useState(false);
  const [userId, setUserId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState("17:00");
  const [endTime, setEndTime] = useState("08:00");
  const [saving, setSaving] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [outsideSection, setOutsideSection] = useState(false);
  const [outsideQuery, setOutsideQuery] = useState("");
  const [outsideResults, setOutsideResults] = useState<any[]>([]);
  const [outsideName, setOutsideName] = useState("");
  const [overrideReason, setOverrideReason] = useState("");

  useEffect(() => {
    if (!outsideSection || outsideQuery.trim().length < 2) { setOutsideResults([]); return; }
    const handle = setTimeout(() => {
      api.standbyEligibleApprovers(outsideQuery).then(setOutsideResults).catch(() => setOutsideResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [outsideSection, outsideQuery]);

  async function toggleRequiredRole(role: string, checked: boolean) {
    const current: string[] = roster.standby_required_roles || [];
    const next = checked ? [...new Set([...current, role])] : current.filter((r) => r !== role);
    setSavingPolicy(true);
    try {
      await api.updateStandbyTeamSettings(roster.team_id, { required_roles: next });
      onChanged();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not update policy", text: e.message });
    } finally {
      setSavingPolicy(false);
    }
  }

  async function assign() {
    if (!userId || !startDate) return void Swal.fire({ icon: "warning", title: "Employee and start date are required" });
    if (outsideSection && !overrideReason.trim()) return void Swal.fire({ icon: "warning", title: "An override reason is required for someone outside this Section" });
    setSaving(true);
    try {
      await api.addStandbyAssignment(roster.id, {
        user_id: userId,
        start_date: startDate,
        end_date: endDate || undefined,
        start_time: startTime,
        end_time: endTime,
        override_reason: outsideSection ? overrideReason.trim() : undefined
      });
      setShowAssign(false);
      setUserId(""); setStartDate(""); setEndDate(""); setOutsideSection(false); setOutsideQuery(""); setOutsideName(""); setOverrideReason("");
      onChanged();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not assign standby", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function removeAssignment(id: string) {
    await api.deleteStandbyAssignment(roster.id, id);
    onChanged();
  }

  async function publish() {
    const confirm = await Swal.fire({ title: "Publish this roster?", text: "Employees will be able to view their standby schedule.", icon: "question", showCancelButton: true, confirmButtonText: "Publish" });
    if (!confirm.isConfirmed) return;
    try {
      await api.publishStandbyRoster(roster.id);
      onChanged();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not publish", text: e.message });
    }
  }

  async function cancelRoster() {
    const confirm = await Swal.fire({ title: "Cancel this roster?", text: "The draft and any standby already assigned will be removed.", icon: "warning", showCancelButton: true, confirmButtonText: "Cancel Roster", confirmButtonColor: "#b91c1c" });
    if (!confirm.isConfirmed) return;
    try {
      await api.cancelStandbyRoster(roster.id);
      onCancelled();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not cancel roster", text: e.message });
    }
  }

  return (
    <div>
      <button className="button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={14} aria-hidden /> Back to Rosters</button>

      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="ep-panel-title">{roster.team_name} — {monthLabel(String(roster.roster_month).slice(0, 7))}</div>
            <div className="ep-panel-sub">
              {roster.org_path?.division_name ? `${roster.org_path.division_name} · ` : ""}
              {roster.org_path?.department || ""}
            </div>
            {role === "ADMIN" && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
                <div style={{ marginBottom: 4 }}>Require these roles in this Section's claim Approval Route:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                  {STANDBY_POLICY_ROLES.map((r) => (
                    <label key={r} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <input
                        type="checkbox"
                        checked={(roster.standby_required_roles || []).includes(r)}
                        disabled={savingPolicy}
                        onChange={(e) => void toggleRequiredRole(r, e.target.checked)}
                      />
                      {r}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusBadge status={roster.status} />
            {roster.status === "DRAFT" && (
              <>
                <button className="ep-btn-outline" style={{ color: "#b91c1c", borderColor: "#fecaca" }} type="button" onClick={() => void cancelRoster()}>Cancel Roster</button>
                <button className="ep-btn" type="button" onClick={() => void publish()}>Publish Roster</button>
              </>
            )}
          </div>
        </div>
        <div className="ep-panel-body">
          {roster.status === "PUBLISHED" && (
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 12 }}>
              This roster is published — employees may already be relying on it. Changes are still allowed but are recorded in the audit trail.
            </div>
          )}
          <button className="ep-btn" type="button" onClick={() => setShowAssign((v) => !v)} style={{ marginBottom: 14 }}>
            <Plus size={14} aria-hidden /> Assign Standby
          </button>
          {showAssign && (
            <div style={{ background: "var(--surface-soft)", padding: 12, borderRadius: 8, marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: outsideSection ? 10 : 0 }}>
                {!outsideSection ? (
                  <label style={{ fontSize: 13 }}>
                    <div style={{ marginBottom: 4, fontWeight: 600 }}>Employee</div>
                    <select value={userId} onChange={(e) => setUserId(e.target.value)} className="review-control">
                      <option value="">Select…</option>
                      {roster.members.map((m: any) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                    </select>
                  </label>
                ) : (
                  <label style={{ fontSize: 13, position: "relative" }}>
                    <div style={{ marginBottom: 4, fontWeight: 600 }}>Employee (outside this Section)</div>
                    <input
                      className="review-control"
                      value={outsideName}
                      onChange={(e) => { setOutsideName(e.target.value); setOutsideQuery(e.target.value); setUserId(""); }}
                      placeholder="Search employee…"
                    />
                    {outsideResults.length > 0 && outsideName && !userId && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, zIndex: 30, maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
                        {outsideResults.map((u) => (
                          <div
                            key={u.id}
                            onMouseDown={(e) => { e.preventDefault(); setUserId(u.id); setOutsideName(u.full_name); setOutsideResults([]); }}
                            style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid var(--border)" }}
                          >
                            <div style={{ fontWeight: 600 }}>{u.full_name}</div>
                            <div style={{ fontSize: 11, color: "var(--muted)" }}>{[u.title, u.department].filter(Boolean).join(" • ")}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </label>
                )}
                <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>From</div><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="review-control" /></label>
                <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>To (optional)</div><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="review-control" /></label>
                <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Start Time</div><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="review-control" /></label>
                <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>End Time</div><input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="review-control" /></label>
                <button className="ep-btn" type="button" disabled={saving} onClick={() => void assign()}>Assign</button>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", marginTop: 10 }}>
                <input type="checkbox" checked={outsideSection} onChange={(e) => { setOutsideSection(e.target.checked); setUserId(""); setOutsideName(""); }} />
                Assign someone outside this Section (requires an override reason)
              </label>
              {outsideSection && (
                <label style={{ display: "block", fontSize: 13, marginTop: 8 }}>
                  <div style={{ marginBottom: 4, fontWeight: 600 }}>Override Reason</div>
                  <input className="review-control" style={{ width: "100%", boxSizing: "border-box" }} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why is this person covering standby for a Section they're not part of?" />
                </label>
              )}
            </div>
          )}

          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Employee</th><th>Date</th><th>From</th><th>To</th><th>Hours</th><th></th></tr></thead>
              <tbody>
                {roster.assignments.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>No standby assigned yet.</td></tr>}
                {roster.assignments.map((a: any) => (
                  <tr key={a.id}>
                    <td>{a.full_name}{a.override_reason && <span title={`Override: ${a.override_reason}`} style={{ marginLeft: 6, fontSize: 11, color: "#b45309" }}>⚠</span>}</td>
                    <td>{a.standby_date}</td>
                    <td>{a.start_time}</td>
                    <td>{a.end_time}</td>
                    <td>{a.hours}</td>
                    <td><button className="ep-icon-btn danger" type="button" onClick={() => void removeAssignment(a.id)}><Trash2 size={13} aria-hidden /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Standby
// ---------------------------------------------------------------------------

function MyStandbyScreen({ month, data, onMonthChange, onGenerateClaim, onOpenClaim }: { month: string; data: any; onMonthChange: (m: string) => void; onGenerateClaim: () => void; onOpenClaim: (id: string) => void }) {
  return (
    <section className="ep-panel">
      <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="ep-panel-title">My Standby — {monthLabel(month)}</div>
        <input type="month" value={month} onChange={(e) => onMonthChange(e.target.value)} className="review-control" style={{ maxWidth: 180 }} />
      </div>
      <div className="ep-panel-body">
        {data ? (
          <>
            <div className="ep-kpi-row ep-kpi-row-3" style={{ marginBottom: 18 }}>
              <div className="ep-kpi ep-kpi-blue"><Clock3 size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{data.assignments.length}</div><div className="ep-kpi-label">Assignments</div></div></div>
              <div className="ep-kpi ep-kpi-green"><Clock3 size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{data.total_standby_hours}</div><div className="ep-kpi-label">Total Standby Hours</div></div></div>
              <div className="ep-kpi ep-kpi-gold"><ClipboardList size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{data.claim ? data.claim.status.replace(/_/g, " ") : "Not started"}</div><div className="ep-kpi-label">Claim Status</div></div></div>
            </div>

            <div className="ep-table-wrap" style={{ marginBottom: 14 }}>
              <table className="ep-table">
                <thead><tr><th>Date</th><th>From</th><th>To</th><th>Hours</th></tr></thead>
                <tbody>
                  {data.assignments.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--muted)" }}>No published standby for this month.</td></tr>}
                  {data.assignments.map((a: any) => (
                    <tr key={a.id}><td>{a.standby_date}</td><td>{a.start_time}</td><td>{a.end_time}</td><td>{a.hours}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.claim ? (
              <button className="ep-btn" type="button" onClick={() => onOpenClaim(data.claim.id)}>Review Claim</button>
            ) : (
              data.assignments.length > 0 && <button className="ep-btn" type="button" onClick={onGenerateClaim}>Generate Monthly Claim</button>
            )}
          </>
        ) : (
          <p style={{ color: "var(--muted)" }}>Loading…</p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// My claims (list)
// ---------------------------------------------------------------------------

function ClaimsListScreen({ claims, onOpen }: { claims: any[]; onOpen: (id: string) => void }) {
  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">My Standby Claims</div></div>
      <div className="ep-table-wrap">
        <table className="ep-table">
          <thead><tr><th>Claim No.</th><th>Month</th><th>Compensable Hrs</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            {claims.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--muted)" }}>No claims yet.</td></tr>}
            {claims.map((c) => (
              <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => onOpen(c.id)}>
                <td>{c.claim_no}</td>
                <td>{monthLabel(String(c.claim_month).slice(0, 7))}</td>
                <td>{c.compensable_hours}</td>
                <td>{c.calculated_amount ? `M ${Number(c.calculated_amount).toFixed(2)}` : "—"}</td>
                <td><StatusBadge status={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Claim detail — claim-specific inputs, Approval Route builder, submit,
// approve/reject/send-back, and Finance processing all live here since the
// same claim can be viewed by its owner, an approver, or Finance.
// ---------------------------------------------------------------------------

function ClaimScreen({ claim, onBack, onRefresh, onOpenClaim }: { claim: any; onBack: () => void; onRefresh: () => void; onOpenClaim: (id: string) => void }) {
  const [route, setRoute] = useState<{ approver_user_id: string; title: string; approver_name?: string }[]>(
    (claim.approval_steps || []).map((s: any) => ({ approver_user_id: s.approver_user_id, title: s.title, approver_name: s.approver_name }))
  );
  const [comments, setComments] = useState(claim.comments || "");
  const [saving, setSaving] = useState(false);
  const titleOptions = useApprovalTitleOptions();

  // Finance processing form state
  const [hourlyRate, setHourlyRate] = useState("");
  const [costCentre, setCostCentre] = useState(claim.cost_centre || "");
  const [accountProject, setAccountProject] = useState(claim.account_project || "");
  const [payrollPeriod, setPayrollPeriod] = useState(claim.payroll_period || "");
  const [financeReference, setFinanceReference] = useState(claim.finance_reference || "");
  const [financeComments, setFinanceComments] = useState("");

  const isDraft = claim.status === "DRAFT";
  const isSubmitted = claim.status === "SUBMITTED";
  const isFinanceStage = ["FINANCE_PROCESSING", "PAYMENT_PENDING"].includes(claim.status);

  const [costCentreOptions, setCostCentreOptions] = useState<{ name: string }[]>([]);
  const [accountProjectOptions, setAccountProjectOptions] = useState<{ name: string }[]>([]);
  useEffect(() => {
    if (claim.status !== "FINANCE_PROCESSING") return;
    api.standbyFinanceCodes("COST_CENTRE").then(setCostCentreOptions).catch(() => setCostCentreOptions([]));
    api.standbyFinanceCodes("ACCOUNT_PROJECT").then(setAccountProjectOptions).catch(() => setAccountProjectOptions([]));
  }, [claim.status]);

  async function downloadPdf() {
    try {
      await openBlobInNewTab(() => api.standbyClaimPdf(claim.id));
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not generate PDF", text: e.message });
    }
  }

  async function saveDraft() {
    setSaving(true);
    try {
      await api.updateStandbyClaim(claim.id, { comments, approval_route: route.filter((s) => s.approver_user_id) });
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Saved", timer: 1200, showConfirmButton: false });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not save", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    const incomplete = route.some((s) => !s.approver_user_id);
    if (incomplete || route.length === 0) return void Swal.fire({ icon: "warning", title: "Complete the Approval Route before submitting" });
    setSaving(true);
    try {
      await api.updateStandbyClaim(claim.id, { comments, approval_route: route });
      await api.submitStandbyClaim(claim.id);
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Claim submitted" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not submit", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function decide(action: "approve" | "reject" | "send-back") {
    if (action !== "approve") {
      const result = await Swal.fire({ title: action === "reject" ? "Reject claim" : "Send back for correction", input: "textarea", inputLabel: "Comments (required)", showCancelButton: true, confirmButtonText: action === "reject" ? "Reject" : "Send Back" });
      if (!result.isConfirmed || !result.value?.trim()) return;
      try {
        if (action === "reject") await api.rejectStandbyClaim(claim.id, result.value.trim());
        else await api.sendBackStandbyClaim(claim.id, result.value.trim());
        await onRefresh();
      } catch (e: any) {
        void Swal.fire({ icon: "error", title: "Action failed", text: e.message });
      }
      return;
    }
    try {
      await api.approveStandbyClaim(claim.id, "");
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Approved" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not approve", text: e.message });
    }
  }

  async function processFinance() {
    if (!hourlyRate) return void Swal.fire({ icon: "warning", title: "Enter the hourly rate" });
    try {
      await api.processStandbyFinance(claim.id, {
        hourly_rate: Number(hourlyRate),
        cost_centre: costCentre,
        account_project: accountProject,
        payroll_period: payrollPeriod,
        finance_reference: financeReference,
        finance_comments: financeComments
      });
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Sent for payment" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not process", text: e.message });
    }
  }

  async function returnFromFinance() {
    const result = await Swal.fire({ title: "Return claim", input: "textarea", inputLabel: "Reason (required)", showCancelButton: true, confirmButtonText: "Return" });
    if (!result.isConfirmed || !result.value?.trim()) return;
    try {
      await api.returnStandbyFinance(claim.id, result.value.trim());
      await onRefresh();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not return", text: e.message });
    }
  }

  async function markPaid() {
    const confirm = await Swal.fire({ title: "Mark as paid?", icon: "question", showCancelButton: true, confirmButtonText: "Mark Paid" });
    if (!confirm.isConfirmed) return;
    try {
      await api.markStandbyClaimPaid(claim.id);
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Claim closed" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not mark paid", text: e.message });
    }
  }

  return (
    <div>
      <button className="button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={14} aria-hidden /> Back</button>

      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="ep-panel-title">Standby Claim — {monthLabel(String(claim.claim_month).slice(0, 7))}</div>
            <div className="ep-panel-sub">{claim.claim_no}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!isDraft && (
              <button className="button button-subtle" type="button" onClick={() => void downloadPdf()}>
                <FileText size={14} aria-hidden /> Download PDF
              </button>
            )}
            <StatusBadge status={claim.status} />
          </div>
        </div>
        <div className="ep-panel-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Employee Information</div>
              <div style={{ fontSize: 13, lineHeight: 2 }}>
                <div><strong>Name:</strong> {claim.employee_name}</div>
                <div><strong>Employee No.:</strong> {claim.employee_no}</div>
                <div><strong>Position:</strong> {claim.job_title || "—"}</div>
                <div><strong>Section:</strong> {claim.org_path?.team_name || "—"}</div>
                <div><strong>Department:</strong> {claim.org_path?.section_name || "—"}</div>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Standby Detail</div>
              <div className="ep-table-wrap">
                <table className="ep-table">
                  <thead><tr><th>Date</th><th>From</th><th>To</th><th>Hours</th></tr></thead>
                  <tbody>
                    {claim.lines.map((l: any) => (
                      <tr key={l.id}><td>{l.standby_date}</td><td>{l.start_time}</td><td>{l.end_time}</td><td>{l.hours}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 13 }}>
                <strong>Total Standby Hours</strong><span>{claim.total_standby_hours}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <strong>Compensable Hours (10%)</strong><span>{claim.compensable_hours}</span>
              </div>
            </div>
          </div>

          {isDraft && (
            <label style={{ display: "block", marginTop: 18, fontSize: 13 }}>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Comments</div>
              <textarea className="review-control" style={{ width: "100%", boxSizing: "border-box" }} rows={2} value={comments} onChange={(e) => setComments(e.target.value)} />
            </label>
          )}
        </div>
      </section>

      {isDraft && (
        <section className="ep-panel" style={{ marginBottom: 18 }}>
          <div className="ep-panel-body">
            <ApprovalRouteBuilder steps={route} onChange={setRoute} disabled={false} eligibleApproversFn={api.standbyEligibleApprovers} titleOptions={titleOptions} defaultTitle="Manager" />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="ep-btn-outline" type="button" disabled={saving} onClick={() => void saveDraft()}>Save Draft</button>
              <button className="ep-btn" type="button" disabled={saving} onClick={() => void submit()}>Submit Claim</button>
            </div>
          </div>
        </section>
      )}

      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head"><div className="ep-panel-title">Claim Tracking</div></div>
        <div className="ep-panel-body">
          <ClaimTrackingTimeline claim={claim} financeStageLabel="Standby Compensation Processing" />
        </div>
      </section>

      {isSubmitted && claim.is_current_approver && (
        <ApproverActions claim={claim} onDecide={decide} />
      )}

      {isFinanceStage && (
        <section className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Standby Compensation Processing</div></div>
          <div className="ep-panel-body">
            {claim.status === "FINANCE_PROCESSING" ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Hourly Rate (M)</div><input className="review-control" type="number" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} /></label>
                  <label style={{ fontSize: 13 }}>
                    <div style={{ marginBottom: 4, fontWeight: 600 }}>Cost Centre</div>
                    {costCentreOptions.length > 0 ? (
                      <select className="review-control" value={costCentre} onChange={(e) => setCostCentre(e.target.value)}>
                        <option value="">Select…</option>
                        {costCentreOptions.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </select>
                    ) : (
                      <input className="review-control" value={costCentre} onChange={(e) => setCostCentre(e.target.value)} />
                    )}
                  </label>
                  <label style={{ fontSize: 13 }}>
                    <div style={{ marginBottom: 4, fontWeight: 600 }}>Account / Project</div>
                    {accountProjectOptions.length > 0 ? (
                      <select className="review-control" value={accountProject} onChange={(e) => setAccountProject(e.target.value)}>
                        <option value="">Select…</option>
                        {accountProjectOptions.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </select>
                    ) : (
                      <input className="review-control" value={accountProject} onChange={(e) => setAccountProject(e.target.value)} />
                    )}
                  </label>
                  <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Payroll Period</div><input className="review-control" value={payrollPeriod} onChange={(e) => setPayrollPeriod(e.target.value)} /></label>
                  <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Finance Reference</div><input className="review-control" value={financeReference} onChange={(e) => setFinanceReference(e.target.value)} /></label>
                </div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>
                  <div style={{ marginBottom: 4, fontWeight: 600 }}>Finance Comments</div>
                  <textarea className="review-control" style={{ width: "100%", boxSizing: "border-box" }} rows={2} value={financeComments} onChange={(e) => setFinanceComments(e.target.value)} />
                </label>
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="ep-btn-outline" type="button" onClick={() => void returnFromFinance()}>Return</button>
                  <button className="ep-btn" type="button" onClick={() => void processFinance()}>Process</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, marginBottom: 12 }}>
                  <div><strong>Calculated Amount:</strong> M {Number(claim.calculated_amount || 0).toFixed(2)}</div>
                  <div><strong>Cost Centre:</strong> {claim.cost_centre || "—"}</div>
                  <div><strong>Payroll Period:</strong> {claim.payroll_period || "—"}</div>
                  <div><strong>Finance Reference:</strong> {claim.finance_reference || "—"}</div>
                </div>
                <button className="ep-btn" type="button" onClick={() => void markPaid()}>Mark Paid</button>
              </>
            )}
          </div>
        </section>
      )}

      {["PAID", "CLOSED"].includes(claim.status) && (
        <section className="ep-panel" style={{ marginBottom: 18 }}>
          <div className="ep-panel-body" style={{ fontSize: 13 }}>
            <strong>Paid:</strong> {claim.paid_at ? new Date(claim.paid_at).toLocaleString() : "—"} · Amount M {Number(claim.calculated_amount || 0).toFixed(2)}
          </div>
        </section>
      )}

      {claim.original_claim && (
        <section className="ep-panel" style={{ marginBottom: 18 }}>
          <div className="ep-panel-body" style={{ fontSize: 13 }}>
            This is adjustment <strong>{claim.claim_no}</strong> against original claim <strong>{claim.original_claim.claim_no}</strong>.
          </div>
        </section>
      )}

      {!claim.is_adjustment && (claim.status === "CLOSED" || (claim.adjustments && claim.adjustments.length > 0)) && (
        <AdjustmentsPanel claim={claim} onRefresh={onRefresh} onOpenClaim={onOpenClaim} />
      )}
    </div>
  );
}

function ApproverActions({ claim, onDecide }: { claim: any; onDecide: (action: "approve" | "reject" | "send-back") => void }) {
  return (
    <section className="ep-panel" style={{ marginBottom: 18 }}>
      <div className="ep-panel-head"><div className="ep-panel-title">Your Decision</div></div>
      <div className="ep-panel-body" style={{ display: "flex", gap: 10 }}>
        <button className="ep-btn-outline" type="button" onClick={() => onDecide("send-back")}>Send Back</button>
        <button className="ep-btn-outline" style={{ color: "#b91c1c", borderColor: "#fecaca" }} type="button" onClick={() => onDecide("reject")}>Reject</button>
        <button className="ep-btn" type="button" onClick={() => onDecide("approve")}>Approve</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Approvals inbox + Finance queue
// ---------------------------------------------------------------------------

function ApprovalsScreen({ approvals, onOpen }: { approvals: any[]; onOpen: (id: string) => void }) {
  const { scope, setScope, scopedItems, hasAnyDelegated, delegatingManagers } = useDelegationScope(approvals);
  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">Claims Awaiting Your Approval</div></div>
      <div className="ep-panel-body" style={{ paddingBottom: 0 }}>
        <DelegationScopeBar items={approvals} scope={scope} setScope={setScope} hasAnyDelegated={hasAnyDelegated} delegatingManagers={delegatingManagers} />
      </div>
      <div className="ep-table-wrap">
        <table className="ep-table">
          <thead><tr><th>Claim No.</th><th>Employee</th><th>Month</th><th>Your Title</th><th>Submitted</th></tr></thead>
          <tbody>
            {scopedItems.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--muted)" }}>Nothing awaiting your approval.</td></tr>}
            {scopedItems.map((c) => (
              <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => onOpen(c.id)}>
                <td>
                  {c.claim_no}
                  <DelegatedTag item={c} />
                </td>
                <td>{c.employee_name}</td>
                <td>{monthLabel(String(c.claim_month).slice(0, 7))}</td>
                <td>{c.my_title}</td>
                <td>{c.submitted_at ? new Date(c.submitted_at).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FinanceQueueScreen({ queue, onOpen }: { queue: any[]; onOpen: (id: string) => void }) {
  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">Treasury &amp; Financial Accounting Queue</div></div>
      <div className="ep-table-wrap">
        <table className="ep-table">
          <thead><tr><th>Claim No.</th><th>Employee</th><th>Section</th><th>Comp. Hrs</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            {queue.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>Nothing in the Finance queue.</td></tr>}
            {queue.map((c) => (
              <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => onOpen(c.id)}>
                <td>{c.claim_no}</td>
                <td>{c.employee_name}</td>
                <td>{c.team_name}</td>
                <td>{c.compensable_hours}</td>
                <td>{c.calculated_amount ? `M ${Number(c.calculated_amount).toFixed(2)}` : "—"}</td>
                <td><StatusBadge status={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Roster-creation delegation (7.1)
// ---------------------------------------------------------------------------

function DelegationsScreen({ teams }: { teams: any[] }) {
  const [teamId, setTeamId] = useState(teams[0]?.id || "");
  const [delegations, setDelegations] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [delegateId, setDelegateId] = useState("");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (teamId) void load(teamId);
  }, [teamId]);

  // Reuses the app's existing manager_delegations system (/auth/delegations)
  // rather than a standby-specific delegation API — rows are tagged
  // request_types: ["STANDBY_ROSTER"] and scoped by team_id.
  async function load(id: string) {
    try {
      setDelegations(await api.delegations({ team_id: id, request_type: "STANDBY_ROSTER" }));
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not load delegations", text: e.message });
    }
  }

  async function addDelegate() {
    if (!teamId || !delegateId) return void Swal.fire({ icon: "warning", title: "Choose a Section and delegate" });
    setSaving(true);
    try {
      await api.createDelegation({
        team_id: teamId,
        delegate_id: delegateId,
        request_types: ["STANDBY_ROSTER"],
        from_date: startDate,
        to_date: endDate || undefined
      });
      setDelegateId("");
      await load(teamId);
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not add delegate", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    const confirm = await Swal.fire({ title: "Revoke this delegation?", icon: "warning", showCancelButton: true, confirmButtonText: "Revoke", confirmButtonColor: "#b91c1c" });
    if (!confirm.isConfirmed) return;
    try {
      await api.endDelegation(id);
      await load(teamId);
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not revoke", text: e.message });
    }
  }

  useEffect(() => {
    if (!teamId) { setMembers([]); return; }
    // Members are sourced from any roster already created for this Section;
    // if none exists yet, create one first from the Rosters tab.
    api.standbyRosters(teamId)
      .then(async (rosters: any[]) => {
        if (!rosters.length) { setMembers([]); return; }
        const detail: any = await api.standbyRoster(rosters[0].id);
        setMembers(detail.members || []);
      })
      .catch(() => setMembers([]));
  }, [teamId]);

  return (
    <div>
      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head">
          <div className="ep-panel-title">Roster Creation Delegation</div>
          <div className="ep-panel-sub">Grant an employee time-bound authority to create and maintain the standby roster for your Section. Publishing always remains with you.</div>
        </div>
        <div className="ep-panel-body" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>Section</div>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="review-control">
              <option value="">Select Section…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>Delegate</div>
            <select value={delegateId} onChange={(e) => setDelegateId(e.target.value)} className="review-control" disabled={!teamId}>
              <option value="">{members.length === 0 ? "No Section members found — create a roster first" : "Select employee…"}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>From</div><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="review-control" /></label>
          <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Until (optional)</div><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="review-control" /></label>
          <button className="ep-btn" type="button" disabled={saving || !teamId} onClick={() => void addDelegate()}><UserPlus size={14} aria-hidden /> Add Delegate</button>
        </div>
      </section>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Delegates</div></div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Delegate</th><th>Employee No.</th><th>Position</th><th>Period</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {delegations.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>No delegations for this Section.</td></tr>}
              {delegations.map((d) => (
                <tr key={d.id}>
                  <td>{d.delegate_name}</td>
                  <td>{d.delegate_employee_no || "—"}</td>
                  <td>{d.delegate_title || "—"}</td>
                  <td>{d.from_date || "—"}{d.to_date ? ` – ${d.to_date}` : " – open-ended"}</td>
                  <td><StatusBadge status={d.active ? "ACTIVE" : "REVOKED"} /></td>
                  <td>{d.active && <button className="ep-icon-btn danger" type="button" onClick={() => void revoke(d.id)}><Trash2 size={13} aria-hidden /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only published-roster view (7.12)
// ---------------------------------------------------------------------------

function WhosOnStandbyScreen() {
  const [scope, setScope] = useState("SECTION");
  const [range, setRange] = useState("TODAY");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void load();
  }, [scope, range, date]);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.standbyRosterView(scope, range, date));
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not load standby roster", text: e.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="ep-panel">
      <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="ep-panel-title">Standby Roster</div>
          <div className="ep-panel-sub">Read-only — see who's currently on standby and who's scheduled next.</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {["TODAY", "WEEK", "MONTH"].map((r) => (
            <button
              key={r}
              type="button"
              className={r === range ? "ep-btn" : "ep-btn-outline"}
              onClick={() => setRange(r)}
              style={{ padding: "6px 12px", fontSize: 12 }}
            >
              {r === "TODAY" ? "Today" : r === "WEEK" ? "This Week" : "Month"}
            </button>
          ))}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="review-control" style={{ maxWidth: 150 }} />
          <select value={scope} onChange={(e) => setScope(e.target.value)} className="review-control" style={{ maxWidth: 160 }}>
            <option value="SECTION">My Section</option>
            <option value="DEPARTMENT">My Department</option>
            <option value="DIVISION">My Division</option>
            <option value="ALL">All Standby Rosters</option>
          </select>
        </div>
      </div>
      <div className="ep-table-wrap">
        <table className="ep-table">
          <thead><tr><th>Date</th><th>Employee</th><th>Position</th><th>Section</th><th>Email</th><th>Phone</th><th>From</th><th>To</th></tr></thead>
          <tbody>
            {!loading && rows.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--muted)" }}>No standby coverage found for this scope and period.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.standby_date}</td>
                <td>{r.full_name}</td>
                <td>{r.title || "—"}</td>
                <td>{r.team_name}</td>
                <td>{r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : "—"}</td>
                <td>{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : "—"}</td>
                <td>{r.start_time}</td>
                <td>{r.end_time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reporting (13. Reporting, Audit and Controls)
// ---------------------------------------------------------------------------

function StandbySettingsPanel() {
  const [settings, setSettings] = useState<{ compensable_rate_pct: number; default_hourly_rate: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.standbySettings().then(setSettings).catch(() => setSettings({ compensable_rate_pct: 10, default_hourly_rate: 0 }));
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      await api.updateStandbySettings(settings);
      await Swal.fire({ icon: "success", title: "Settings saved", timer: 1400, showConfirmButton: false });
    } catch (err: any) {
      await Swal.fire({ icon: "error", title: "Could not save settings", text: err?.message || "" });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">Compensation Settings</div></div>
      <div className="ep-panel-body" style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Compensable Rate (%)
          <input
            type="number" min={0} max={100} step="0.1" value={settings.compensable_rate_pct}
            onChange={(e) => setSettings({ ...settings, compensable_rate_pct: Number(e.target.value) })}
            style={{ width: 140 }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Default Hourly Rate (M)
          <input
            type="number" min={0} step="0.01" value={settings.default_hourly_rate}
            onChange={(e) => setSettings({ ...settings, default_hourly_rate: Number(e.target.value) })}
            style={{ width: 140 }}
          />
        </label>
        <button className="button button-primary" type="button" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save Settings"}
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--muted)", padding: "0 16px 12px" }}>
        Compensable hours = total standby hours × this rate. Used to generate claims each month; the default hourly rate seeds new claim lines and can still be overridden per line.
      </p>
    </section>
  );
}

export function FinanceCodesPanel({ kind, title }: { kind: "COST_CENTRE" | "ACCOUNT_PROJECT"; title: string }) {
  const [codes, setCodes] = useState<any[]>([]);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setCodes(await api.standbyFinanceCodes(kind, true).catch(() => []));
  }

  useEffect(() => { void load(); }, []);

  async function addCode() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await api.createStandbyFinanceCode({ kind, name: newName.trim() });
      setNewName("");
      await load();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not add", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(code: any) {
    await api.updateStandbyFinanceCode(code.id, { active: !code.active });
    await load();
  }

  async function remove(code: any) {
    const confirm = await Swal.fire({ title: `Delete "${code.name}"?`, icon: "warning", showCancelButton: true, confirmButtonText: "Delete", confirmButtonColor: "#b91c1c" });
    if (!confirm.isConfirmed) return;
    await api.deleteStandbyFinanceCode(code.id);
    await load();
  }

  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">{title}</div></div>
      <div className="ep-panel-body">
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input className="review-control" style={{ flex: 1 }} placeholder={`New ${title.toLowerCase()}`} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="button button-primary" type="button" disabled={saving} onClick={() => void addCode()}>Add</button>
        </div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {codes.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--muted)" }}>None configured — Finance will type these in freely until at least one is added.</td></tr>}
              {codes.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td><StatusBadge status={c.active ? "ACTIVE" : "INACTIVE"} /></td>
                  <td style={{ display: "flex", gap: 8 }}>
                    <button className="button button-subtle" type="button" onClick={() => void toggleActive(c)}>{c.active ? "Deactivate" : "Activate"}</button>
                    <button className="button button-subtle" type="button" onClick={() => void remove(c)}><Trash2 size={14} aria-hidden /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function FinanceSectionsPanel() {
  const [sectionsList, setSectionsList] = useState<any[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  async function load() {
    setSectionsList(await api.standbyFinanceSections().catch(() => []));
  }

  useEffect(() => { void load(); }, []);

  async function toggle(section: any, next: boolean) {
    setSaving(section.id);
    try {
      await api.updateStandbyFinanceSection(section.id, { is_standby_finance: next });
      await load();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not update", text: e.message });
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">Standby Finance Departments</div></div>
      <div className="ep-panel-body">
        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 0 }}>
          Employees whose Department is checked can act as Finance for standby claims (queue, process, return, mark paid, reports) — e.g. Treasury &amp; Financial Accounting. Based on each employee's Department assignment in the org structure — assign them there first if they're not showing up.
        </p>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Department</th><th>Division</th><th>Finance Authority</th></tr></thead>
            <tbody>
              {sectionsList.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--muted)" }}>No Departments found.</td></tr>}
              {sectionsList.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.division_name || "—"}</td>
                  <td>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(s.is_standby_finance)}
                        disabled={saving === s.id}
                        onChange={(e) => void toggle(s, e.target.checked)}
                      />
                      {s.is_standby_finance ? "Yes" : "No"}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function ReportsScreen({ role }: { role: string }) {
  const [operational, setOperational] = useState<any>(null);
  const [financial, setFinancial] = useState<any>(null);

  useEffect(() => {
    api.standbyOperationalReport().then(setOperational).catch(() => setOperational({ roster_coverage: [], not_submitted: [], by_stage: [] }));
    api.standbyFinancialReport().then(setFinancial).catch(() => setFinancial({ by_month: [], by_section: [], paid_vs_outstanding: { paid: 0, outstanding: 0 }, adjustments: [] }));
  }, []);

  if (!operational || !financial) return <p style={{ color: "var(--muted)" }}>Loading…</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {role === "ADMIN" && (
        <>
          <StandbySettingsPanel />
          <FinanceSectionsPanel />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <FinanceCodesPanel kind="COST_CENTRE" title="Cost Centres" />
            <FinanceCodesPanel kind="ACCOUNT_PROJECT" title="Accounts / Projects" />
          </div>
        </>
      )}

      <div className="ep-kpi-row ep-kpi-row-3">
        <div className="ep-kpi ep-kpi-green"><Wallet size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">M {Number(financial.paid_vs_outstanding.paid).toFixed(2)}</div><div className="ep-kpi-label">Paid</div></div></div>
        <div className="ep-kpi ep-kpi-amber"><Wallet size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">M {Number(financial.paid_vs_outstanding.outstanding).toFixed(2)}</div><div className="ep-kpi-label">Outstanding</div></div></div>
        <div className="ep-kpi ep-kpi-indigo"><ClipboardList size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{financial.adjustments.length}</div><div className="ep-kpi-label">Adjustments</div></div></div>
      </div>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Claims by Stage</div></div>
        <div className="ep-panel-body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {operational.by_stage.length === 0 && <span style={{ color: "var(--muted)", fontSize: 13 }}>No claims yet.</span>}
          {operational.by_stage.map((s: any) => (
            <div key={s.status} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <StatusBadge status={s.status} /><span style={{ fontSize: 13 }}>{s.count}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Roster Coverage</div></div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Section</th><th>Month</th><th>Employees Covered</th></tr></thead>
            <tbody>
              {operational.roster_coverage.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--muted)" }}>No published rosters yet.</td></tr>}
              {operational.roster_coverage.map((r: any, idx: number) => (
                <tr key={idx}><td>{r.section}</td><td>{monthLabel(String(r.month).slice(0, 7))}</td><td>{r.employees_covered}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Claims Not Yet Submitted</div></div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Employee</th><th>Employee No.</th><th>Section</th><th>Month</th></tr></thead>
            <tbody>
              {operational.not_submitted.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--muted)" }}>Everyone with published standby has claimed.</td></tr>}
              {operational.not_submitted.map((r: any, idx: number) => (
                <tr key={idx}><td>{r.full_name}</td><td>{r.employee_no}</td><td>{r.section}</td><td>{monthLabel(String(r.month).slice(0, 7))}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Standby Compensation by Month</div></div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Month</th><th>Total Paid</th></tr></thead>
            <tbody>
              {financial.by_month.length === 0 && <tr><td colSpan={2} style={{ textAlign: "center", color: "var(--muted)" }}>No paid claims yet.</td></tr>}
              {financial.by_month.map((r: any, idx: number) => (
                <tr key={idx}><td>{monthLabel(String(r.month).slice(0, 7))}</td><td>M {Number(r.total).toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Standby Amount by Section</div></div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Section</th><th>Total Paid</th></tr></thead>
            <tbody>
              {financial.by_section.length === 0 && <tr><td colSpan={2} style={{ textAlign: "center", color: "var(--muted)" }}>No paid claims yet.</td></tr>}
              {financial.by_section.map((r: any, idx: number) => (
                <tr key={idx}><td>{r.section}</td><td>M {Number(r.total).toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Adjustment Report</div></div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Adjustment Claim</th><th>Original Claim</th><th>Reason</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {financial.adjustments.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--muted)" }}>No adjustments raised yet.</td></tr>}
              {financial.adjustments.map((r: any, idx: number) => (
                <tr key={idx}>
                  <td>{r.claim_no}</td>
                  <td>{r.original_claim_no}</td>
                  <td>{r.comments}</td>
                  <td>{r.calculated_amount ? `M ${Number(r.calculated_amount).toFixed(2)}` : "—"}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adjustments (15. Exception and Adjustment Handling) — a paid claim can't
// be edited, so a missed day or an overpayment becomes a new linked claim.
// ---------------------------------------------------------------------------

function AdjustmentsPanel({ claim, onRefresh, onOpenClaim }: { claim: any; onRefresh: () => void; onOpenClaim: (id: string) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<{ standby_date: string; start_time: string; end_time: string; hours: string }[]>([
    { standby_date: "", start_time: "", end_time: "", hours: "" }
  ]);
  const [saving, setSaving] = useState(false);

  function updateLine(i: number, patch: Partial<{ standby_date: string; start_time: string; end_time: string; hours: string }>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { standby_date: "", start_time: "", end_time: "", hours: "" }]);
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (!reason.trim()) return void Swal.fire({ icon: "warning", title: "A reason is required" });
    const validLines = lines.filter((l) => l.standby_date && l.hours);
    if (!validLines.length) return void Swal.fire({ icon: "warning", title: "Add at least one line", text: "Enter a date and hours (negative hours for a recovery/overpayment correction)." });
    setSaving(true);
    try {
      await api.createStandbyAdjustment(claim.id, {
        reason: reason.trim(),
        lines: validLines.map((l) => ({ standby_date: l.standby_date, start_time: l.start_time || undefined, end_time: l.end_time || undefined, hours: Number(l.hours) }))
      });
      setShowForm(false);
      setReason("");
      setLines([{ standby_date: "", start_time: "", end_time: "", hours: "" }]);
      onRefresh();
      void Swal.fire({ icon: "success", title: "Adjustment claim created", text: "Complete its Approval Route and submit it like a normal claim." });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not create adjustment", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ep-panel">
      <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div className="ep-panel-title">Adjustments</div>
          <div className="ep-panel-sub">Missed standby days or an incorrect payment on this paid claim, without altering the original.</div>
        </div>
        {claim.status === "CLOSED" && (
          <button className="ep-btn-outline" type="button" onClick={() => setShowForm((v) => !v)}>
            <Plus size={13} aria-hidden /> Raise Adjustment
          </button>
        )}
      </div>
      <div className="ep-panel-body">
        {showForm && (
          <div style={{ background: "var(--surface-soft)", padding: 12, borderRadius: 8, marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 13, marginBottom: 10 }}>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Reason</div>
              <textarea className="review-control" style={{ width: "100%", boxSizing: "border-box" }} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Missed standby day on 14 Aug not on the original roster, or overpayment correction" />
            </label>
            {lines.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input type="date" className="review-control" value={l.standby_date} onChange={(e) => updateLine(i, { standby_date: e.target.value })} />
                <input type="time" className="review-control" placeholder="From" value={l.start_time} onChange={(e) => updateLine(i, { start_time: e.target.value })} />
                <input type="time" className="review-control" placeholder="To" value={l.end_time} onChange={(e) => updateLine(i, { end_time: e.target.value })} />
                <input type="number" className="review-control" style={{ maxWidth: 110 }} placeholder="Hours (± )" value={l.hours} onChange={(e) => updateLine(i, { hours: e.target.value })} />
                <button type="button" className="ep-icon-btn danger" onClick={() => removeLine(i)}><Trash2 size={13} aria-hidden /></button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button type="button" className="ep-btn-outline" onClick={addLine}><Plus size={13} aria-hidden /> Add Line</button>
              <button type="button" className="ep-btn" disabled={saving} onClick={() => void submit()}>Create Adjustment</button>
            </div>
          </div>
        )}

        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Adjustment Claim</th><th>Reason</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {(!claim.adjustments || claim.adjustments.length === 0) && <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--muted)" }}>No adjustments raised against this claim.</td></tr>}
              {(claim.adjustments || []).map((a: any) => (
                <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => onOpenClaim(a.id)}>
                  <td>{a.claim_no}</td>
                  <td>{a.comments || "—"}</td>
                  <td>{a.calculated_amount ? `M ${Number(a.calculated_amount).toFixed(2)}` : "—"}</td>
                  <td><StatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
