import { useEffect, useState } from "react";
import { api, openBlobInNewTab } from "./api";
import Swal from "sweetalert2";
import {
  Briefcase, Calendar, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Clock3, FileBarChart, FileText, Plus, Trash2, Wallet
} from "lucide-react";
import { ApprovalRouteBuilder, type ApprovalRouteStep } from "./components/ApprovalRoute";
import { ClaimTrackingTimeline } from "./components/ClaimTrackingTimeline";
import { FinanceCodesPanel, FinanceSectionsPanel } from "./Standby";
import { useDelegationScope, DelegationScopeBar, DelegatedTag } from "./components/DelegationScope";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Overtime's approval-route "title" is the action being taken (who checked
// it vs. who approved it) rather than a free-typed job title/position — the
// PDF prints the approver's own real job title automatically (see
// resolveOvertimeRequestPdfData), so nobody needs to type it here.
const OVERTIME_TITLE_OPTIONS = ["Ordered by", "Checked by", "Approved by"];

function monthLabel(year: number, month: number) {
  return `${MONTH_NAMES[(month || 1) - 1] || ""} ${year || ""}`.trim();
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    DRAFT: { bg: "#f1f5f9", color: "#475569" },
    SUBMITTED: { bg: "#dbeafe", color: "#1d4ed8" },
    FINANCE_PROCESSING: { bg: "#fef3c7", color: "#b45309" },
    PAYMENT_PENDING: { bg: "#fef3c7", color: "#b45309" },
    CLOSED: { bg: "#e0e7ff", color: "#4338ca" },
    APPROVED: { bg: "#dcfce7", color: "#15803d" },
    REJECTED: { bg: "#fee2e2", color: "#b91c1c" },
    WITHDRAWN: { bg: "#f1f5f9", color: "#64748b" }
  };
  const style = colors[status] || { bg: "#f1f5f9", color: "#475569" };
  return (
    <span style={{ background: style.bg, color: style.color, fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 999 }}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

type View = "DASHBOARD" | "MY_REQUESTS" | "NEW_REQUEST" | "REQUEST_DETAIL" | "CLAIM_DETAIL" | "APPROVALS" | "FINANCE_QUEUE" | "REPORTS";

export default function Overtime({ profile, role, onBack, deepLink, onDeepLinkConsumed }: {
  profile: any; role: string; onBack: () => void;
  deepLink?: { kind: "REQUEST" | "CLAIM"; id: string } | null;
  onDeepLinkConsumed?: () => void;
}) {
  const [view, setView] = useState<View>("DASHBOARD");
  const [loading, setLoading] = useState(false);

  const [dashboard, setDashboard] = useState<any>(null);
  const [requests, setRequests] = useState<any[]>([]);
  const [requestId, setRequestId] = useState("");
  const [requestDetail, setRequestDetail] = useState<any>(null);
  const [claimId, setClaimId] = useState("");
  const [claimDetail, setClaimDetail] = useState<any>(null);
  const [requestApprovals, setRequestApprovals] = useState<any[]>([]);
  const [claimApprovals, setClaimApprovals] = useState<any[]>([]);
  const [financeQueue, setFinanceQueue] = useState<any[]>([]);

  const isFinance = Boolean(dashboard?.is_finance) || role === "ADMIN";

  useEffect(() => {
    void loadDashboard();
    void loadRequests();
  }, []);

  // Keeps the active tab's data current without a manual click — the
  // Approvals tab in particular only used to fetch once, so a request that
  // landed on someone's step after they'd opened the page stayed invisible
  // until they clicked away and back. Re-fetches quietly (no loading
  // spinner) every 30s for whichever tab is currently open.
  useEffect(() => {
    const interval = setInterval(() => {
      if (view === "DASHBOARD") void loadDashboard();
      if (view === "APPROVALS") void loadApprovals(true);
      if (view === "FINANCE_QUEUE") void loadFinanceQueue(true);
    }, 30000);
    return () => clearInterval(interval);
  }, [view]);

  async function loadDashboard() {
    try { setDashboard(await api.overtimeDashboard()); } catch { /* silent */ }
  }
  async function loadRequests() {
    setLoading(true);
    try { setRequests(await api.overtimeRequests()); } finally { setLoading(false); }
  }
  async function loadApprovals(silent = false) {
    if (!silent) setLoading(true);
    try {
      const [reqRows, claimRows] = await Promise.all([api.overtimeRequestApprovals(), api.overtimeApprovals()]);
      setRequestApprovals(reqRows);
      setClaimApprovals(claimRows);
    } catch (err) {
      if (silent) return; // keep last known list, retry next tick
      throw err;
    } finally {
      if (!silent) setLoading(false);
    }
  }
  async function openRequest(id: string) {
    setRequestId(id);
    setRequestDetail(await api.overtimeRequestDetail(id));
    setView("REQUEST_DETAIL");
  }
  async function openClaim(id: string) {
    setClaimId(id);
    setClaimDetail(await api.overtimeClaimDetail(id));
    setView("CLAIM_DETAIL");
  }

  // Arriving here from the Inbox with a specific item to review — open it
  // directly instead of landing on the Dashboard, then tell the parent the
  // link's been used so it doesn't re-fire on a later visit to this page.
  useEffect(() => {
    if (!deepLink) return;
    const open = deepLink.kind === "REQUEST" ? openRequest(deepLink.id) : openClaim(deepLink.id);
    void open.finally(() => onDeepLinkConsumed?.());
  }, [deepLink]);

  async function refreshRequest() {
    setRequestDetail(await api.overtimeRequestDetail(requestId));
    void loadRequests();
  }
  async function refreshClaim() {
    setClaimDetail(await api.overtimeClaimDetail(claimId));
    void loadRequests();
  }
  async function loadFinanceQueue(silent = false) {
    if (!silent) setLoading(true);
    try { setFinanceQueue(await api.overtimeFinanceQueue()); } catch (err) {
      if (silent) return;
      throw err;
    } finally { if (!silent) setLoading(false); }
  }

  function TabBar() {
    const tabs: { key: View; label: string; icon: any; show: boolean }[] = [
      { key: "DASHBOARD", label: "Dashboard", icon: Briefcase, show: true },
      { key: "MY_REQUESTS", label: "My Requests", icon: Calendar, show: true },
      { key: "NEW_REQUEST", label: "New Request", icon: Plus, show: true },
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
              if (t.key === "MY_REQUESTS") void loadRequests();
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
          <h2>Overtime Request &amp; Claim Management</h2>
          <p>Overtime planning, employee-defined approval routes, and Treasury &amp; Financial Accounting processing.</p>
        </div>
        <button className="button button-subtle" type="button" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden />Back
        </button>
      </div>

      <TabBar />
      {loading && <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</p>}

      {view === "DASHBOARD" && dashboard && (
        <DashboardScreen dashboard={dashboard} onOpenClaim={openClaim} onViewAll={() => { setView("MY_REQUESTS"); void loadRequests(); }} />
      )}
      {view === "MY_REQUESTS" && (
        <MyRequestsScreen requests={requests} onOpen={openRequest} onNew={() => setView("NEW_REQUEST")} />
      )}
      {view === "NEW_REQUEST" && (
        <NewRequestScreen
          profile={profile}
          onCreated={async (id) => { await loadRequests(); await openRequest(id); }}
          onCancel={() => setView("MY_REQUESTS")}
        />
      )}
      {view === "REQUEST_DETAIL" && requestDetail && (
        <RequestDetailScreen
          request={requestDetail}
          onBack={() => setView("MY_REQUESTS")}
          onRefresh={refreshRequest}
          onOpenClaim={openClaim}
        />
      )}
      {view === "CLAIM_DETAIL" && claimDetail && (
        <ClaimDetailScreen claim={claimDetail} onBack={() => setView("MY_REQUESTS")} onRefresh={refreshClaim} />
      )}
      {view === "APPROVALS" && (
        <ApprovalsScreen
          requestApprovals={requestApprovals}
          claimApprovals={claimApprovals}
          onOpenRequest={openRequest}
          onOpenClaim={openClaim}
          onRefresh={loadApprovals}
        />
      )}
      {view === "FINANCE_QUEUE" && <FinanceQueueScreen queue={financeQueue} onOpen={openClaim} />}
      {view === "REPORTS" && <ReportsScreen role={role} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function DashboardScreen({ dashboard, onOpenClaim, onViewAll }: { dashboard: any; onOpenClaim: (id: string) => void; onViewAll: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="ep-kpi-row ep-kpi-row-5">
        <div className="ep-kpi ep-kpi-indigo"><Clock3 size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{dashboard.estimated_hours_this_month}</div><div className="ep-kpi-label">This Month Estimated Hours</div></div></div>
        <div className="ep-kpi ep-kpi-indigo"><Clock3 size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{dashboard.converted_hours_this_month}</div><div className="ep-kpi-label">This Month Converted Hours</div></div></div>
        <div className="ep-kpi ep-kpi-amber"><ClipboardList size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{dashboard.pending_approvals}</div><div className="ep-kpi-label">Pending Approvals</div></div></div>
        <div className="ep-kpi ep-kpi-green"><CheckCircle2 size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{dashboard.approved_ytd_converted_hours}</div><div className="ep-kpi-label">Approved (YTD) Converted Hours</div></div></div>
        <div className="ep-kpi ep-kpi-green"><Wallet size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">M {Number(dashboard.paid_ytd_amount || 0).toFixed(2)}</div><div className="ep-kpi-label">Paid (YTD) Amount</div></div></div>
      </div>

      <section className="ep-panel">
        <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="ep-panel-title">Recent Claims</div>
          <span className="dashboard-panel-link" style={{ cursor: "pointer" }} onClick={onViewAll}>View All →</span>
        </div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Claim No.</th><th>Period</th><th>Status</th></tr></thead>
            <tbody>
              {(dashboard.recent_claims || []).length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--muted)" }}>No claims yet.</td></tr>}
              {(dashboard.recent_claims || []).map((c: any) => (
                <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => onOpenClaim(c.id)}>
                  <td>{c.claim_no}</td>
                  <td>{monthLabel(c.year, c.month)}</td>
                  <td><StatusBadge status={c.status} /></td>
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
// My Requests
// ---------------------------------------------------------------------------

const REQUEST_STATUS_TABS = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "SUBMITTED", label: "Pending Approval" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "WITHDRAWN", label: "Withdrawn" }
];

function MyRequestsScreen({ requests, onOpen, onNew }: { requests: any[]; onOpen: (id: string) => void; onNew: () => void }) {
  const [tab, setTab] = useState("ALL");
  const filtered = tab === "ALL" ? requests : requests.filter((r) => r.status === tab);

  function currentApprovalLabel(r: any) {
    if (r.status === "SUBMITTED" && r.current_step_title) return `Pending ${r.current_step_title}`;
    if (r.status === "APPROVED" && r.claim_status === "CLOSED") return "Completed";
    if (r.status === "APPROVED" && r.claim_id) return "Claim In Progress";
    if (r.status === "APPROVED") return "Ready to Claim";
    return "—";
  }

  function estimatedHours(r: any) {
    const lines = Array.isArray(r.lines) ? r.lines : [];
    return lines.reduce((sum: number, l: any) => {
      const [sh, sm] = (l.estimated_start || "00:00").split(":").map(Number);
      const [eh, em] = (l.estimated_end || "00:00").split(":").map(Number);
      let minutes = eh * 60 + em - (sh * 60 + sm);
      if (minutes < 0) minutes += 24 * 60;
      return sum + minutes / 60;
    }, 0).toFixed(2);
  }

  return (
    <section className="ep-panel">
      <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div className="ep-panel-title">My Overtime Requests</div>
        <button className="ep-btn" type="button" onClick={onNew}><Plus size={14} aria-hidden /> New Request</button>
      </div>
      <div style={{ display: "flex", gap: 4, padding: "0 16px", flexWrap: "wrap" }}>
        {REQUEST_STATUS_TABS.map((t) => {
          const count = t.key === "ALL" ? requests.length : requests.filter((r) => r.status === t.key).length;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              style={{
                padding: "6px 12px", fontSize: 12, fontWeight: 600, border: "none", background: "none", cursor: "pointer",
                color: tab === t.key ? "#1d4ed8" : "var(--muted)", borderBottom: tab === t.key ? "2px solid #1d4ed8" : "2px solid transparent"
              }}
            >
              {t.label} {count > 0 ? `(${count})` : ""}
            </button>
          );
        })}
      </div>
      <div className="ep-table-wrap">
        <table className="ep-table">
          <thead><tr><th>Request No.</th><th>Month</th><th>Submitted On</th><th>Estimated Hours</th><th>Status</th><th>Current Approval</th><th></th></tr></thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--muted)" }}>No requests found.</td></tr>}
            {filtered.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}>
                <td>{r.request_no}</td>
                <td>{monthLabel(r.year, r.month)}</td>
                <td>{r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : "—"}</td>
                <td>{estimatedHours(r)}</td>
                <td><StatusBadge status={r.status} /></td>
                <td>{currentApprovalLabel(r)}</td>
                <td><FileText size={14} aria-hidden /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// New Request
// ---------------------------------------------------------------------------

type RequestLine = { date: string; day?: string; estimated_start: string; estimated_end: string; reason: string };

function dayFromDate(dateStr: string) {
  if (!dateStr) return "";
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[new Date(`${dateStr}T00:00:00`).getDay()] || "";
}

function NewRequestScreen({ profile, onCreated, onCancel }: { profile: any; onCreated: (id: string) => void; onCancel: () => void }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [noc, setNoc] = useState("");
  const [carReg, setCarReg] = useState("");
  const [lines, setLines] = useState<RequestLine[]>([{ date: "", estimated_start: "", estimated_end: "", reason: "" }]);
  const [route, setRoute] = useState<ApprovalRouteStep[]>([
    { approver_user_id: "", title: "Checked by" },
    { approver_user_id: "", title: "Approved by" },
    { approver_user_id: "", title: "Approved by" }
  ]);
  const [saving, setSaving] = useState(false);
  const titleOptions = OVERTIME_TITLE_OPTIONS;

  function updateLine(i: number, patch: Partial<RequestLine>) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch, day: patch.date ? dayFromDate(patch.date) : l.day } : l)));
  }
  function addRow() {
    setLines([...lines, { date: "", estimated_start: "", estimated_end: "", reason: "" }]);
  }
  function removeRow(i: number) {
    setLines(lines.filter((_, idx) => idx !== i));
  }

  async function save(submit: boolean) {
    if (submit && route.some((s) => !s.approver_user_id)) {
      return void Swal.fire({ icon: "warning", title: "Complete the Approval Route before submitting" });
    }
    setSaving(true);
    try {
      const created: any = await api.createOvertimeRequest({ year, month, noc, car_reg: carReg, lines });
      if (submit) {
        await api.updateOvertimeRequest(created.id, { approval_route: route });
        await api.submitOvertimeRequest(created.id);
        void Swal.fire({ icon: "success", title: "Request submitted" });
      } else {
        void Swal.fire({ icon: "success", title: "Draft saved", timer: 1200, showConfirmButton: false });
      }
      onCreated(created.id);
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not save", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head"><div className="ep-panel-title">Employee Details</div></div>
        <div className="ep-panel-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
            <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Names</div><input className="review-control" value={profile?.full_name || ""} disabled /></label>
            <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>E/N</div><input className="review-control" value={profile?.employee_no || ""} disabled /></label>
            <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Job Title</div><input className="review-control" value={profile?.title || ""} disabled /></label>
            <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Section</div><input className="review-control" value={profile?.team_name || ""} disabled /></label>
            <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Year</div><input className="review-control" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} /></label>
            <label style={{ fontSize: 13 }}>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Month</div>
              <select className="review-control" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {MONTH_NAMES.map((m, idx) => <option key={m} value={idx + 1}>{m}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>NOC</div><input className="review-control" value={noc} onChange={(e) => setNoc(e.target.value)} /></label>
            <label style={{ fontSize: 13 }}><div style={{ marginBottom: 4, fontWeight: 600 }}>Car Reg</div><input className="review-control" value={carReg} onChange={(e) => setCarReg(e.target.value)} /></label>
          </div>

          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Overtime Details</div>
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Date</th><th>Day</th><th>Estimated From</th><th>Estimated To</th><th>Reason for Overtime</th><th></th></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td><input type="date" className="review-control" value={l.date} onChange={(e) => updateLine(i, { date: e.target.value })} /></td>
                    <td>{l.day || dayFromDate(l.date)}</td>
                    <td><input type="time" className="review-control" value={l.estimated_start} onChange={(e) => updateLine(i, { estimated_start: e.target.value })} /></td>
                    <td><input type="time" className="review-control" value={l.estimated_end} onChange={(e) => updateLine(i, { estimated_end: e.target.value })} /></td>
                    <td><input className="review-control" value={l.reason} onChange={(e) => updateLine(i, { reason: e.target.value })} /></td>
                    <td>{lines.length > 1 && <button type="button" className="ep-icon-btn danger" onClick={() => removeRow(i)}><Trash2 size={13} aria-hidden /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="ep-btn-outline" style={{ marginTop: 10 }} onClick={addRow}><Plus size={13} aria-hidden /> Add Row</button>
        </div>
      </section>

      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-body">
          <ApprovalRouteBuilder
            steps={route}
            onChange={setRoute}
            disabled={false}
            eligibleApproversFn={api.overtimeEligibleApprovers}
            titleOptions={titleOptions}
            defaultTitle="Checked by"
          />
        </div>
      </section>

      <div style={{ display: "flex", gap: 10 }}>
        <button className="button button-subtle" type="button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="ep-btn-outline" type="button" disabled={saving} onClick={() => void save(false)}>Save Draft</button>
        <button className="ep-btn" type="button" disabled={saving} onClick={() => void save(true)}>Submit Request</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request detail
// ---------------------------------------------------------------------------

function ApproverActions({ onDecide }: { onDecide: (action: "approve" | "reject" | "send-back") => void }) {
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

function RequestDetailScreen({ request, onBack, onRefresh, onOpenClaim }: { request: any; onBack: () => void; onRefresh: () => void; onOpenClaim: (id: string) => void }) {
  const [route, setRoute] = useState<ApprovalRouteStep[]>(
    (request.approval_steps || []).map((s: any) => ({ approver_user_id: s.approver_user_id, title: s.title, approver_name: s.approver_name }))
  );
  const [saving, setSaving] = useState(false);
  const titleOptions = OVERTIME_TITLE_OPTIONS;
  const isDraft = request.status === "DRAFT";
  const isSubmitted = request.status === "SUBMITTED";

  async function downloadPdf() {
    try {
      await openBlobInNewTab(() => api.overtimeRequestPdf(request.id));
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not generate PDF", text: e.message });
    }
  }

  async function saveDraft() {
    setSaving(true);
    try {
      await api.updateOvertimeRequest(request.id, { approval_route: route.filter((s) => s.approver_user_id) });
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Saved", timer: 1200, showConfirmButton: false });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not save", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    if (route.some((s) => !s.approver_user_id) || route.length === 0) {
      return void Swal.fire({ icon: "warning", title: "Complete the Approval Route before submitting" });
    }
    setSaving(true);
    try {
      await api.updateOvertimeRequest(request.id, { approval_route: route });
      await api.submitOvertimeRequest(request.id);
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Request submitted" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not submit", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function withdraw() {
    const confirm = await Swal.fire({ title: "Withdraw this request?", icon: "warning", showCancelButton: true, confirmButtonText: "Withdraw", confirmButtonColor: "#b91c1c" });
    if (!confirm.isConfirmed) return;
    try {
      await api.withdrawOvertimeRequest(request.id);
      await onRefresh();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not withdraw", text: e.message });
    }
  }

  async function decide(action: "approve" | "reject" | "send-back") {
    if (action !== "approve") {
      const result = await Swal.fire({ title: action === "reject" ? "Reject request" : "Send back for correction", input: "textarea", inputLabel: "Comments (required)", showCancelButton: true, confirmButtonText: action === "reject" ? "Reject" : "Send Back" });
      if (!result.isConfirmed || !result.value?.trim()) return;
      try {
        if (action === "reject") await api.rejectOvertimeRequest(request.id, result.value.trim());
        else await api.sendBackOvertimeRequest(request.id, result.value.trim());
        await onRefresh();
      } catch (e: any) {
        void Swal.fire({ icon: "error", title: "Action failed", text: e.message });
      }
      return;
    }
    try {
      await api.approveOvertimeRequest(request.id, "");
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Approved" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not approve", text: e.message });
    }
  }

  async function generateClaim() {
    try {
      const result: any = await api.generateOvertimeClaim(request.id);
      onOpenClaim(result.id);
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not generate claim", text: e.message });
    }
  }

  return (
    <div>
      <button className="button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={14} aria-hidden /> Back to Requests</button>

      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="ep-panel-title">Overtime Request — {monthLabel(request.year, request.month)}</div>
            <div className="ep-panel-sub">{request.request_no}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!isDraft && (
              <button className="button button-subtle" type="button" onClick={() => void downloadPdf()}><FileText size={14} aria-hidden /> Download PDF</button>
            )}
            {["DRAFT", "SUBMITTED"].includes(request.status) && request.is_owner && (
              <button className="button button-subtle" type="button" onClick={() => void withdraw()}>Withdraw</button>
            )}
            <StatusBadge status={request.status} />
          </div>
        </div>
        <div className="ep-panel-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Employee Information</div>
              <div style={{ fontSize: 13, lineHeight: 2 }}>
                <div><strong>Name:</strong> {request.employee_name}</div>
                <div><strong>Employee No.:</strong> {request.employee_no}</div>
                <div><strong>Position:</strong> {request.job_title || "—"}</div>
                <div><strong>Section:</strong> {request.org_path?.team_name || "—"}</div>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Details</div>
              <div style={{ fontSize: 13, lineHeight: 2 }}>
                <div><strong>NOC:</strong> {request.noc || "—"}</div>
                <div><strong>Car Reg:</strong> {request.car_reg || "—"}</div>
                <div><strong>Remarks:</strong> {request.remarks || "—"}</div>
              </div>
            </div>
          </div>
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Date</th><th>Day</th><th>Est. From</th><th>Est. To</th><th>Reason</th></tr></thead>
              <tbody>
                {(request.lines || []).map((l: any, idx: number) => (
                  <tr key={idx}>
                    <td>{l.date}</td><td>{l.day}</td><td>{l.estimated_start}</td><td>{l.estimated_end}</td>
                    <td>{l.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {isDraft && (
        <section className="ep-panel" style={{ marginBottom: 18 }}>
          <div className="ep-panel-body">
            <ApprovalRouteBuilder steps={route} onChange={setRoute} disabled={false} eligibleApproversFn={api.overtimeEligibleApprovers} titleOptions={titleOptions} defaultTitle="Checked by" />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="ep-btn-outline" type="button" disabled={saving} onClick={() => void saveDraft()}>Save Draft</button>
              <button className="ep-btn" type="button" disabled={saving} onClick={() => void submit()}>Submit Request</button>
            </div>
          </div>
        </section>
      )}

      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head"><div className="ep-panel-title">Request Tracking</div></div>
        <div className="ep-panel-body">
          <ClaimTrackingTimeline claim={request} showFinanceStages={false} approvedLabel="Request Approved" />
        </div>
      </section>

      {isSubmitted && request.is_current_approver && <ApproverActions onDecide={decide} />}

      {request.status === "APPROVED" && (
        <section className="ep-panel">
          <div className="ep-panel-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {request.claim ? (
              <>
                <div style={{ fontSize: 13 }}>Claim <strong>{request.claim.claim_no}</strong> — <StatusBadge status={request.claim.status} /></div>
                <button className="ep-btn" type="button" onClick={() => onOpenClaim(request.claim.id)}>View Claim</button>
              </>
            ) : request.is_owner ? (
              <>
                <div style={{ fontSize: 13 }}>This request is approved and ready to be claimed.</div>
                <button className="ep-btn" type="button" onClick={() => void generateClaim()}>Generate Claim</button>
              </>
            ) : (
              <div style={{ fontSize: 13 }}>This request is approved. The employee still needs to generate the claim.</div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claim detail
// ---------------------------------------------------------------------------

function ClaimDetailScreen({ claim, onBack, onRefresh }: { claim: any; onBack: () => void; onRefresh: () => void }) {
  const [route, setRoute] = useState<ApprovalRouteStep[]>(
    (claim.approval_steps || []).map((s: any) => ({ approver_user_id: s.approver_user_id, title: s.title, approver_name: s.approver_name }))
  );
  const [preference, setPreference] = useState(claim.compensation_preference || "");
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const titleOptions = OVERTIME_TITLE_OPTIONS;
  // The request only ever captures estimated hours — the claim is where the
  // employee fills in what was actually worked, so from_time/to_time here
  // default to the request's estimate (see generate-claim) but are editable
  // while still a draft.
  const [lines, setLines] = useState<any[]>(claim.lines || []);
  function updateLine(i: number, patch: Record<string, string>) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const [hourlyRate, setHourlyRate] = useState("");
  const [costCentre, setCostCentre] = useState(claim.cost_centre || "");
  const [accountProject, setAccountProject] = useState(claim.account_project || "");
  const [payrollPeriod, setPayrollPeriod] = useState(claim.payroll_period || "");
  const [financeReference, setFinanceReference] = useState(claim.finance_reference || "");
  const [financeComments, setFinanceComments] = useState("");
  const [costCentreOptions, setCostCentreOptions] = useState<{ name: string }[]>([]);
  const [accountProjectOptions, setAccountProjectOptions] = useState<{ name: string }[]>([]);

  const isDraft = claim.status === "DRAFT";
  const isSubmitted = claim.status === "SUBMITTED";
  const isFinanceStage = ["FINANCE_PROCESSING", "PAYMENT_PENDING"].includes(claim.status);

  useEffect(() => {
    if (claim.status !== "FINANCE_PROCESSING") return;
    api.standbyFinanceCodes("COST_CENTRE").then(setCostCentreOptions).catch(() => setCostCentreOptions([]));
    api.standbyFinanceCodes("ACCOUNT_PROJECT").then(setAccountProjectOptions).catch(() => setAccountProjectOptions([]));
  }, [claim.status]);

  async function downloadPdf() {
    try {
      await openBlobInNewTab(() => api.overtimeClaimPdf(claim.id));
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not generate PDF", text: e.message });
    }
  }

  async function saveDraft() {
    setSaving(true);
    try {
      await api.updateOvertimeClaim(claim.id, { lines, compensation_preference: preference || undefined, approval_route: route.filter((s) => s.approver_user_id) });
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Saved", timer: 1200, showConfirmButton: false });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not save", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    if (!preference) return void Swal.fire({ icon: "warning", title: "Choose a Compensation Preference (Pay or Days)" });
    if (route.some((s) => !s.approver_user_id) || route.length === 0) return void Swal.fire({ icon: "warning", title: "Complete the Approval Route before submitting" });
    setSaving(true);
    try {
      await api.updateOvertimeClaim(claim.id, { lines, compensation_preference: preference, approval_route: route });
      await api.submitOvertimeClaim(claim.id);
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Claim submitted" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not submit", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function withdraw() {
    const confirm = await Swal.fire({ title: "Withdraw this claim?", icon: "warning", showCancelButton: true, confirmButtonText: "Withdraw", confirmButtonColor: "#b91c1c" });
    if (!confirm.isConfirmed) return;
    try {
      await api.withdrawOvertimeClaim(claim.id);
      await onRefresh();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not withdraw", text: e.message });
    }
  }

  async function decide(action: "approve" | "reject" | "send-back") {
    if (action !== "approve") {
      const result = await Swal.fire({ title: action === "reject" ? "Reject claim" : "Send back for correction", input: "textarea", inputLabel: "Comments (required)", showCancelButton: true, confirmButtonText: action === "reject" ? "Reject" : "Send Back" });
      if (!result.isConfirmed || !result.value?.trim()) return;
      try {
        if (action === "reject") await api.rejectOvertimeClaim(claim.id, result.value.trim());
        else await api.sendBackOvertimeClaim(claim.id, result.value.trim());
        await onRefresh();
      } catch (e: any) {
        void Swal.fire({ icon: "error", title: "Action failed", text: e.message });
      }
      return;
    }
    try {
      await api.approveOvertimeClaim(claim.id, "");
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Approved" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not approve", text: e.message });
    }
  }

  async function processFinance() {
    if (!hourlyRate) return void Swal.fire({ icon: "warning", title: "Enter the hourly rate" });
    try {
      await api.processOvertimeClaimFinance(claim.id, {
        hourly_rate: Number(hourlyRate), cost_centre: costCentre, account_project: accountProject,
        payroll_period: payrollPeriod, finance_reference: financeReference, finance_comments: financeComments
      });
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Sent for settlement" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not process", text: e.message });
    }
  }

  async function returnFromFinance() {
    const result = await Swal.fire({ title: "Return claim", input: "textarea", inputLabel: "Reason (required)", showCancelButton: true, confirmButtonText: "Return" });
    if (!result.isConfirmed || !result.value?.trim()) return;
    try {
      await api.returnOvertimeClaimFinance(claim.id, result.value.trim());
      await onRefresh();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not return", text: e.message });
    }
  }

  async function markSettled() {
    const confirm = await Swal.fire({ title: "Mark as settled?", icon: "question", showCancelButton: true, confirmButtonText: "Mark Settled" });
    if (!confirm.isConfirmed) return;
    try {
      await api.markOvertimeClaimSettled(claim.id);
      await onRefresh();
      void Swal.fire({ icon: "success", title: "Claim closed" });
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not mark settled", text: e.message });
    }
  }

  return (
    <div>
      <button className="button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={14} aria-hidden /> Back</button>

      <section className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="ep-panel-title">Overtime Claim (Allowance Report) — {monthLabel(claim.year, claim.month)}</div>
            <div className="ep-panel-sub">{claim.claim_no}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!isDraft && <button className="button button-subtle" type="button" onClick={() => void downloadPdf()}><FileText size={14} aria-hidden /> Download PDF</button>}
            {["DRAFT", "SUBMITTED"].includes(claim.status) && claim.is_owner && <button className="button button-subtle" type="button" onClick={() => void withdraw()}>Withdraw</button>}
            <button className="button button-subtle" type="button" onClick={() => setShowHistory((v) => !v)}>View Approval History</button>
            <StatusBadge status={claim.status} />
          </div>
        </div>
        <div className="ep-panel-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Employee Information</div>
              <div style={{ fontSize: 13, lineHeight: 2 }}>
                <div><strong>Name:</strong> {claim.employee_name}</div>
                <div><strong>Employee No.:</strong> {claim.employee_no}</div>
                <div><strong>Job Title:</strong> {claim.job_title || "—"}</div>
                <div><strong>Section:</strong> {claim.org_path?.team_name || "—"}</div>
                {claim.source_request && <div><strong>Source Request:</strong> {claim.source_request.request_no}</div>}
              </div>
            </div>
            <div style={{ fontSize: 13, lineHeight: 2 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Summary</div>
              <div><strong>Total Overtime:</strong> {claim.total_overtime} Hours</div>
              <div><strong>Converted to Number of Hours:</strong> {claim.converted_hours} Hours</div>
              <div><strong>Equivalent Days:</strong> {claim.equivalent_days}</div>
              <div><strong>Hourly Rate:</strong> {claim.hourly_rate != null ? `M ${Number(claim.hourly_rate).toFixed(2)}` : "—"}</div>
              <div><strong>Total Amount:</strong> {claim.total_amount != null ? `M ${Number(claim.total_amount).toFixed(2)}` : "—"}</div>
              <div><strong>Submitted On:</strong> {claim.submitted_at ? new Date(claim.submitted_at).toLocaleString() : "—"}</div>
            </div>
          </div>

          {isDraft ? (
            <label style={{ display: "block", marginBottom: 16, fontSize: 13 }}>
              <div style={{ marginBottom: 4, fontWeight: 600 }}>Compensation Method</div>
              <div style={{ display: "flex", gap: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="radio" checked={preference === "PAY"} onChange={() => setPreference("PAY")} /> Pay</label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="radio" checked={preference === "DAYS"} onChange={() => setPreference("DAYS")} /> Days</label>
              </div>
            </label>
          ) : (
            <div style={{ fontSize: 13, marginBottom: 16 }}><strong>Compensation Method:</strong> {claim.compensation_preference || "—"}</div>
          )}

          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Date</th><th>Day</th><th>From</th><th>To</th><th>Ordered By</th>
                  <th>Actual Hours</th><th>125%</th><th>150%</th><th>200%</th><th>Converted Hours</th><th>Account No.</th><th>Account Name</th>
                </tr>
              </thead>
              <tbody>
                {(isDraft ? lines : claim.lines || []).map((l: any, idx: number) => (
                  <tr key={idx}>
                    <td>{l.date}</td><td>{l.day}</td>
                    {isDraft ? (
                      <>
                        <td><input type="time" className="review-control" value={l.from_time || ""} onChange={(e) => updateLine(idx, { from_time: e.target.value })} /></td>
                        <td><input type="time" className="review-control" value={l.to_time || ""} onChange={(e) => updateLine(idx, { to_time: e.target.value })} /></td>
                      </>
                    ) : (
                      <>
                        <td>{l.from_time}</td><td>{l.to_time}</td>
                      </>
                    )}
                    <td>{l.ordered_by || "—"}</td>
                    <td>{(Number(l.hours_125 || 0) + Number(l.hours_150 || 0) + Number(l.hours_200 || 0)) || "—"}</td>
                    <td>{Number(l.hours_125 || 0) || "—"}</td><td>{Number(l.hours_150 || 0) || "—"}</td><td>{Number(l.hours_200 || 0) || "—"}</td>
                    <td>{l.converted_hours}</td><td>{l.account_number || "—"}</td><td>{l.account_name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {showHistory && (
            <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <ClaimTrackingTimeline claim={claim} financeStageLabel="Overtime Compensation Processing" />
            </div>
          )}
        </div>
      </section>

      {isDraft && (
        <section className="ep-panel" style={{ marginBottom: 18 }}>
          <div className="ep-panel-body">
            <ApprovalRouteBuilder steps={route} onChange={setRoute} disabled={false} eligibleApproversFn={api.overtimeEligibleApprovers} titleOptions={titleOptions} defaultTitle="Checked by" />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="ep-btn-outline" type="button" disabled={saving} onClick={() => void saveDraft()}>Save Draft</button>
              <button className="ep-btn" type="button" disabled={saving} onClick={() => void submit()}>Submit Claim</button>
            </div>
          </div>
        </section>
      )}

      {isSubmitted && claim.is_current_approver && <ApproverActions onDecide={decide} />}

      {isFinanceStage && (
        <section className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Overtime Compensation Processing</div></div>
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
                  <button className="ep-btn-outline" type="button" onClick={() => void returnFromFinance()}>Return for Correction</button>
                  <button className="ep-btn" type="button" onClick={() => void processFinance()}>Process Claim</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, marginBottom: 12 }}>
                  <div><strong>Cost Centre:</strong> {claim.cost_centre || "—"}</div>
                  <div><strong>Payroll Period:</strong> {claim.payroll_period || "—"}</div>
                  <div><strong>Finance Reference:</strong> {claim.finance_reference || "—"}</div>
                </div>
                <button className="ep-btn" type="button" onClick={() => void markSettled()}>Mark {claim.compensation_preference === "DAYS" ? "Time Credited" : "Paid"}</button>
              </>
            )}
          </div>
        </section>
      )}

      {claim.status === "CLOSED" && (
        <section className="ep-panel" style={{ marginBottom: 18 }}>
          <div className="ep-panel-body" style={{ fontSize: 13 }}>
            <strong>Settled:</strong> {claim.paid_at ? new Date(claim.paid_at).toLocaleString() : "—"}
            {claim.compensation_preference !== "DAYS" && <> · Amount M {Number(claim.total_amount || 0).toFixed(2)}</>}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approvals — tabs for Requests / Claims. Rows open the full detail screen
// (Approve / Reject / Send Back live there, under "Your Decision") rather
// than deciding inline, so an approver always sees the request/claim before
// acting on it. Reject and Send Back both require a comment.
// ---------------------------------------------------------------------------

function ApprovalsScreen({
  requestApprovals, claimApprovals, onOpenRequest, onOpenClaim
}: {
  requestApprovals: any[]; claimApprovals: any[];
  onOpenRequest: (id: string) => void; onOpenClaim: (id: string) => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<"REQUESTS" | "CLAIMS">(claimApprovals.length > 0 || requestApprovals.length === 0 ? "CLAIMS" : "REQUESTS");
  const requestScope = useDelegationScope(requestApprovals);
  const claimScope = useDelegationScope(claimApprovals);

  return (
    <section className="ep-panel">
      <div style={{ display: "flex", gap: 4, padding: "0 16px", borderBottom: "1px solid var(--border)" }}>
        {(["REQUESTS", "CLAIMS"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: "10px 14px", fontSize: 13, fontWeight: 600, border: "none", background: "none", cursor: "pointer",
              color: tab === t ? "#1d4ed8" : "var(--muted)", borderBottom: tab === t ? "2px solid #1d4ed8" : "2px solid transparent"
            }}
          >
            {t === "REQUESTS" ? `Requests (${requestApprovals.length})` : `Claims (${claimApprovals.length})`}
          </button>
        ))}
      </div>

      {tab === "REQUESTS" ? (
        <>
          <div className="ep-panel-body" style={{ paddingBottom: 0 }}>
            <DelegationScopeBar items={requestApprovals} scope={requestScope.scope} setScope={requestScope.setScope} hasAnyDelegated={requestScope.hasAnyDelegated} delegatingManagers={requestScope.delegatingManagers} />
          </div>
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Request No.</th><th>Employee</th><th>Month</th><th>Submitted On</th><th>Your Role</th><th>Actions</th></tr></thead>
              <tbody>
                {requestScope.scopedItems.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>Nothing awaiting your approval.</td></tr>}
                {requestScope.scopedItems.map((r) => (
                  <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => onOpenRequest(r.id)}>
                    <td>
                      {r.request_no}
                      <DelegatedTag item={r} />
                    </td>
                    <td>{r.employee_name}</td>
                    <td>{monthLabel(r.year, r.month)}</td>
                    <td>{r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : "—"}</td>
                    <td>{r.my_title}</td>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#1d4ed8", fontWeight: 600, fontSize: 13 }}>
                        Review <ChevronRight size={14} aria-hidden />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="ep-panel-body" style={{ paddingBottom: 0 }}>
            <DelegationScopeBar items={claimApprovals} scope={claimScope.scope} setScope={claimScope.setScope} hasAnyDelegated={claimScope.hasAnyDelegated} delegatingManagers={claimScope.delegatingManagers} />
          </div>
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Claim No.</th><th>Employee</th><th>Month</th><th>Submitted On</th><th>Converted Hours</th><th>Your Role</th><th>Actions</th></tr></thead>
              <tbody>
                {claimScope.scopedItems.length === 0 && <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--muted)" }}>Nothing awaiting your approval.</td></tr>}
                {claimScope.scopedItems.map((c) => (
                  <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => onOpenClaim(c.id)}>
                    <td>
                      {c.claim_no}
                      <DelegatedTag item={c} />
                    </td>
                    <td>{c.employee_name}</td>
                    <td>{monthLabel(c.year, c.month)}</td>
                    <td>{c.submitted_at ? new Date(c.submitted_at).toLocaleDateString() : "—"}</td>
                    <td>{c.converted_hours}</td>
                    <td>{c.my_title}</td>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#1d4ed8", fontWeight: 600, fontSize: 13 }}>
                        Review <ChevronRight size={14} aria-hidden />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function FinanceQueueScreen({ queue, onOpen }: { queue: any[]; onOpen: (id: string) => void }) {
  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">Treasury &amp; Financial Accounting Queue</div></div>
      <div className="ep-table-wrap">
        <table className="ep-table">
          <thead><tr><th>Claim No.</th><th>Employee</th><th>Section</th><th>Converted Hours</th><th>Preference</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            {queue.length === 0 && <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--muted)" }}>Nothing in the Finance queue.</td></tr>}
            {queue.map((c) => (
              <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => onOpen(c.id)}>
                <td>{c.claim_no}</td>
                <td>{c.employee_name}</td>
                <td>{c.team_name || "—"}</td>
                <td>{c.converted_hours}</td>
                <td>{c.compensation_preference || "—"}</td>
                <td>{c.total_amount != null ? `M ${Number(c.total_amount).toFixed(2)}` : "—"}</td>
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
// Reports — Overtime Allowance Report + (ADMIN) rate/holiday configuration.
// Reuses Standby's FinanceCodesPanel / FinanceSectionsPanel since Finance
// authority and the cost-centre/account list are shared between modules.
// ---------------------------------------------------------------------------

function OvertimeRateSettingsPanel() {
  const [settings, setSettings] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.overtimeSettings().then(setSettings).catch(() => setSettings({ rate_weekday_pct: 125, rate_saturday_pct: 150, rate_sunday_holiday_pct: 200, working_hours_per_day: 8 }));
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      await api.updateOvertimeSettings(settings);
      await Swal.fire({ icon: "success", title: "Settings saved", timer: 1400, showConfirmButton: false });
    } catch (e: any) {
      await Swal.fire({ icon: "error", title: "Could not save settings", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;
  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">Overtime Rate Settings</div></div>
      <div className="ep-panel-body" style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>Weekday Rate (%)
          <input type="number" min={100} max={500} value={settings.rate_weekday_pct} onChange={(e) => setSettings({ ...settings, rate_weekday_pct: Number(e.target.value) })} style={{ width: 120 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>Saturday Rate (%)
          <input type="number" min={100} max={500} value={settings.rate_saturday_pct} onChange={(e) => setSettings({ ...settings, rate_saturday_pct: Number(e.target.value) })} style={{ width: 120 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>Sunday / Holiday Rate (%)
          <input type="number" min={100} max={500} value={settings.rate_sunday_holiday_pct} onChange={(e) => setSettings({ ...settings, rate_sunday_holiday_pct: Number(e.target.value) })} style={{ width: 120 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>Working Hours / Day
          <input type="number" min={1} max={24} value={settings.working_hours_per_day} onChange={(e) => setSettings({ ...settings, working_hours_per_day: Number(e.target.value) })} style={{ width: 120 }} />
        </label>
        <button className="button button-primary" type="button" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save Settings"}</button>
      </div>
      <p style={{ fontSize: 12, color: "var(--muted)", padding: "0 16px 12px" }}>
        Drives the 125%/150%/200% rate classification and the Equivalent Days shown on Standby and Overtime claims. Never hardcoded — every overtime line is reclassified against these settings and the Public Holiday calendar at submit time.
      </p>
    </section>
  );
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Always 6 full weeks (42 cells) so the grid height stays constant across
// months, filling in the leading/trailing days from the adjacent months.
function buildMonthGrid(year: number, month: number) {
  const firstOfMonth = new Date(year, month, 1);
  const leadingDays = (firstOfMonth.getDay() + 6) % 7; // Monday-first week
  const gridStart = new Date(year, month, 1 - leadingDays);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    return { date: d, inMonth: d.getMonth() === month };
  });
}

function PublicHolidaysPanel() {
  const [holidays, setHolidays] = useState<any[]>([]);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [viewDate, setViewDate] = useState(() => new Date());

  async function load() {
    setHolidays(await api.publicHolidays().catch(() => []));
  }
  useEffect(() => { void load(); }, []);

  async function add(prefillDate?: string) {
    const useDate = prefillDate || date;
    if (!useDate || !name.trim()) return;
    setSaving(true);
    try {
      await api.createPublicHoliday({ holiday_date: useDate, name: name.trim() });
      setDate(""); setName("");
      await load();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not add", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await api.deletePublicHoliday(id);
    await load();
  }

  const holidaysByDate = new Map<string, any>(holidays.map((h) => [h.holiday_date, h]));
  const grid = buildMonthGrid(viewDate.getFullYear(), viewDate.getMonth());
  const todayKey = dateKey(new Date());

  return (
    <section className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">Public Holiday Calendar</div></div>
      <div className="ep-panel-body">
        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 0 }}>Drives the 200% overtime rate bucket. Seeded from the standard Lesotho calendar — add or remove dates as needed. Click a day to add a holiday.</p>
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <input type="date" className="review-control" value={date} onChange={(e) => setDate(e.target.value)} />
          <input className="review-control" style={{ flex: 1, minWidth: 160 }} placeholder="Holiday name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
          <button className="button button-primary" type="button" disabled={saving} onClick={() => void add()}>Add</button>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <button className="ep-icon-btn" type="button" onClick={() => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))} aria-label="Previous month">
            <ChevronLeft size={16} aria-hidden />
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <strong style={{ fontSize: 14 }}>{MONTH_NAMES[viewDate.getMonth()]} {viewDate.getFullYear()}</strong>
            <button className="button small-button button-subtle" type="button" onClick={() => setViewDate(new Date())}>Today</button>
          </div>
          <button className="ep-icon-btn" type="button" onClick={() => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))} aria-label="Next month">
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
          {WEEKDAY_NAMES.map((w) => (
            <div key={w} style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textAlign: "center", padding: "2px 0" }}>{w}</div>
          ))}
          {grid.map(({ date: cellDate, inMonth }) => {
            const key = dateKey(cellDate);
            const holiday = holidaysByDate.get(key);
            const isToday = key === todayKey;
            return (
              <div
                key={key}
                onClick={() => { if (!holiday) setDate(key); }}
                title={holiday ? holiday.name : undefined}
                style={{
                  minHeight: 62,
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: isToday ? "1px solid #2563eb" : "1px solid var(--border, #e5e7eb)",
                  background: holiday ? "#fef3c7" : inMonth ? "var(--surface, #fff)" : "var(--surface-soft, #f9fafb)",
                  opacity: inMonth ? 1 : 0.5,
                  cursor: holiday ? "default" : "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <span style={{ fontSize: 11, fontWeight: isToday ? 700 : 400, color: isToday ? "#2563eb" : undefined }}>{cellDate.getDate()}</span>
                  {holiday && (
                    <button
                      className="ep-icon-btn danger"
                      type="button"
                      style={{ padding: 2, minWidth: "auto" }}
                      onClick={(e) => { e.stopPropagation(); void remove(holiday.id); }}
                      aria-label={`Remove ${holiday.name}`}
                    >
                      <Trash2 size={11} aria-hidden />
                    </button>
                  )}
                </div>
                {holiday && (
                  <span style={{ fontSize: 10, lineHeight: 1.2, color: "#92400e", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {holiday.name}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ReportsScreen({ role }: { role: string }) {
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => {
    api.overtimeReportsSummary().then(setSummary).catch(() => setSummary({ by_status: [], by_preference: [], by_rate_category: { hours_125: 0, hours_150: 0, hours_200: 0 }, allowance_rows: [] }));
  }, []);

  if (!summary) return <p style={{ color: "var(--muted)" }}>Loading…</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {role === "ADMIN" && (
        <>
          <OvertimeRateSettingsPanel />
          <PublicHolidaysPanel />
          <FinanceSectionsPanel />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <FinanceCodesPanel kind="COST_CENTRE" title="Cost Centres" />
            <FinanceCodesPanel kind="ACCOUNT_PROJECT" title="Accounts / Projects" />
          </div>
        </>
      )}

      <div className="ep-kpi-row ep-kpi-row-3">
        <div className="ep-kpi ep-kpi-indigo"><Clock3 size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{Number(summary.by_rate_category.hours_125 || 0).toFixed(1)}</div><div className="ep-kpi-label">125% Hours</div></div></div>
        <div className="ep-kpi ep-kpi-amber"><Clock3 size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{Number(summary.by_rate_category.hours_150 || 0).toFixed(1)}</div><div className="ep-kpi-label">150% Hours</div></div></div>
        <div className="ep-kpi ep-kpi-green"><Clock3 size={20} className="ep-kpi-icon" aria-hidden /><div><div className="ep-kpi-value">{Number(summary.by_rate_category.hours_200 || 0).toFixed(1)}</div><div className="ep-kpi-label">200% Hours</div></div></div>
      </div>

      <section className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Claims by Status</div></div>
        <div className="ep-panel-body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {summary.by_status.length === 0 && <span style={{ color: "var(--muted)", fontSize: 13 }}>No claims yet.</span>}
          {summary.by_status.map((s: any) => (
            <div key={s.status} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <StatusBadge status={s.status} /><span style={{ fontSize: 13 }}>{s.count}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="ep-panel">
        <div className="ep-panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="ep-panel-title">Overtime Allowance Report</div>
        </div>
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Claim No.</th><th>Employee</th><th>E/N</th><th>Job Title</th><th>Num of Hours</th><th>Converted Hours</th><th>Total Amount</th><th>Compensation Type</th><th>Status</th></tr></thead>
            <tbody>
              {summary.allowance_rows.length === 0 && <tr><td colSpan={9} style={{ textAlign: "center", color: "var(--muted)" }}>No claims yet.</td></tr>}
              {summary.allowance_rows.map((r: any) => (
                <tr key={r.claim_no}>
                  <td>{r.claim_no}</td><td>{r.employee_name}</td><td>{r.employee_no}</td><td>{r.job_title || "—"}</td>
                  <td>{r.total_overtime}</td><td>{r.converted_hours}</td>
                  <td>{r.total_amount != null ? `M ${Number(r.total_amount).toFixed(2)}` : "—"}</td>
                  <td>{r.compensation_preference || "—"}</td>
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
