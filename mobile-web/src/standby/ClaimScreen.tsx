import { useCallback, useEffect, useState } from "react";
import { sbApi, sbMonthLabel, sbPdf, useStandbyTitles, type Pending, type SbClaimDetail } from "./api";
import {
  Decision, HrStatus, PdfButton, RouteBuilder, RouteSteps, dayLabel, draftRoute, hhmm, routePayload, sentBackNote,
  type DecisionAction, type RouteStep
} from "../components/ApprovalRoute";
import { currentUser } from "../api";
import { formatDateTime } from "../ui";

// One monthly standby claim: the standby it covers, and - as a draft - the
// owner's comments and approval route; as a submitted claim, the approver's
// decision. (Adjustments and Finance processing stay on the portal.)
export default function StandbyClaim({ id }: { id: string }) {
  const me = currentUser();
  const titles = useStandbyTitles();
  const [c, setC] = useState<SbClaimDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [route, setRoute] = useState<RouteStep[]>([]);
  const [comments, setComments] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, mine] = await Promise.all([sbApi.claim(id), sbApi.claimApprovals().catch(() => [])]);
      setC(detail);
      setPending(mine.find((x) => x.id === id) || null);
      setRoute(draftRoute(detail.approval_steps, detail.route_history, [{ approver_user_id: "", title: "Manager" }]));
      setComments(detail.comments || "");
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !c) return <p className="error">{error}</p>;
  if (!c) return <p className="muted center">Loading…</p>;

  // The standby detail doesn't say whether I own it; the server's own check is the same.
  const isOwner = c.employee_id === me?.userId || c.created_by_id === me?.userId;
  const editable = c.status === "DRAFT" && isOwner;
  const canDecide = c.status === "SUBMITTED" && (c.is_current_approver || Boolean(pending));
  const backNote = c.status === "DRAFT" ? sentBackNote(c.route_history) : "";

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      window.scrollTo(0, 0);
    }
  }

  function decide(action: DecisionAction, comment: string) {
    void run(() => sbApi.decideClaim(id, action, comment), action === "approve" ? "Approved." : action === "reject" ? "Rejected." : "Sent back to the employee for correction.");
  }

  function save(submit: boolean) {
    if (submit && !routePayload(route)) return setError("Complete the Approval Route before submitting.");
    const picked = route.filter((s) => s.approver_user_id).map((s) => ({ approver_user_id: s.approver_user_id, title: s.title }));
    void run(async () => {
      await sbApi.updateClaim(id, { comments, ...(picked.length ? { approval_route: picked } : {}) });
      if (submit) await sbApi.submitClaim(id);
    }, submit ? "Claim submitted." : "Saved.");
  }

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>Standby claim · {sbMonthLabel(c.claim_month)}</h1>
        <div className="row gap">
          <span className="muted small">{c.claim_no}</span>
          <HrStatus status={c.status} myTurn={canDecide} />
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {backNote && <p className="banner">{backNote}</p>}
      {c.original_claim && <p className="banner">This is an adjustment to claim {c.original_claim.claim_no}.</p>}

      {canDecide && (
        <Decision heading={`Your decision · ${pending?.my_title || c.approval_steps.find((s) => s.step_order === c.current_step_order)?.title || "Approver"}`}
          actingFor={pending?.is_delegated ? pending.delegated_from_manager_name : null} busy={busy} onDecide={decide} />
      )}

      <section className="card">
        <div className="kv"><span className="muted small">Employee</span><span className="kv-value">{c.employee_name}{c.employee_no ? ` · ${c.employee_no}` : ""}</span></div>
        {c.job_title && <div className="kv"><span className="muted small">Position</span><span className="kv-value">{c.job_title}</span></div>}
        {c.org_path?.team_name && <div className="kv"><span className="muted small">Section</span><span className="kv-value">{c.org_path.team_name}</span></div>}
        <div className="kv"><span className="muted small">Total standby hours</span><span className="kv-value">{c.total_standby_hours}</span></div>
        <div className="kv"><span className="muted small">Compensable hours</span><span className="kv-value">{c.compensable_hours}</span></div>
        {c.calculated_amount != null && <div className="kv"><span className="muted small">Amount</span><span className="kv-value">M {Number(c.calculated_amount).toFixed(2)}</span></div>}
        {c.submitted_at && <div className="kv"><span className="muted small">Submitted</span><span className="kv-value">{formatDateTime(c.submitted_at)}</span></div>}
        {c.closed_at && <div className="kv"><span className="muted small">Closed</span><span className="kv-value">{formatDateTime(c.closed_at)}</span></div>}
        {!editable && c.comments && <div className="kv"><span className="muted small">Comments</span><span className="kv-value pre">{c.comments}</span></div>}
      </section>

      <section className="stack-sm">
        <h2>Standby</h2>
        {c.lines.length === 0 ? <p className="muted small">No standby on this claim.</p> : (
          <ul className="list">
            {c.lines.map((l) => (
              <li key={l.id} className="row-link">
                <span className="grow">
                  <strong className="small">{dayLabel(l.standby_date, true)}</strong>
                  <span className="muted small">{hhmm(l.start_time)} – {hhmm(l.end_time)}</span>
                </span>
                <span className="small">{l.hours} h</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editable && (
        <>
          <section className="card">
            <label className="field">
              <span>Comments</span>
              <textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} />
            </label>
          </section>
          <RouteBuilder steps={route} onChange={setRoute} search={sbApi.approvers} titles={titles} defaultTitle="Manager" />
          <div className="action-list">
            <button type="button" className="primary" disabled={busy} onClick={() => save(true)}>{busy ? "Working…" : "Submit claim"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => save(false)}>Save draft</button>
          </div>
        </>
      )}

      {c.status !== "DRAFT" && <PdfButton path={sbPdf.claim(id)} name={`Standby claim ${c.claim_no}.pdf`} onError={setError} />}

      {c.status !== "DRAFT" && (
        <section className="stack-sm">
          <h2>Approval route</h2>
          <RouteSteps steps={c.approval_steps} current={c.current_step_order} status={c.status} />
        </section>
      )}
    </div>
  );
}
