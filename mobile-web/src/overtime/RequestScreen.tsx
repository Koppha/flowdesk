import { useCallback, useEffect, useState } from "react";
import { otApi, otPdf, OT_TITLES, type OtRequestDetail, type Pending } from "./api";
import {
  Decision, HrStatus, PdfButton, RouteBuilder, RouteSteps, dayLabel, draftRoute, hhmm, monthLabel, routePayload, sentBackNote,
  type DecisionAction, type RouteStep
} from "../components/ApprovalRoute";
import { go, href } from "../router";

const START_ROUTE: RouteStep[] = [
  { approver_user_id: "", title: "Checked by" },
  { approver_user_id: "", title: "Approved by" }
];

// One overtime request: the days asked for, the approval route, and what I
// can do with it now - approve / reject / send back as its current
// approver, or finish, submit, withdraw or claim it as its owner.
export default function OvertimeRequest({ id }: { id: string }) {
  const [r, setR] = useState<OtRequestDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [route, setRoute] = useState<RouteStep[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const load = useCallback(async () => {
    try {
      // The approvals list also covers requests I approve for a manager who
      // delegated to me.
      const [detail, mine] = await Promise.all([otApi.request(id), otApi.requestApprovals().catch(() => [])]);
      setR(detail);
      setPending(mine.find((x) => x.id === id) || null);
      setRoute(draftRoute(detail.approval_steps, detail.route_history, START_ROUTE));
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !r) return <p className="error">{error}</p>;
  if (!r) return <p className="muted center">Loading…</p>;

  const isDraft = r.status === "DRAFT";
  const canDecide = r.status === "SUBMITTED" && (r.is_current_approver || Boolean(pending));
  const canWithdraw = r.is_owner && (r.status === "DRAFT" || r.status === "SUBMITTED");
  const backNote = isDraft ? sentBackNote(r.route_history) : "";

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(done);
      setConfirmWithdraw(false);
      await load();
      window.scrollTo(0, 0);
    } catch (e: any) {
      setError(e.message);
      window.scrollTo(0, 0);
    } finally {
      setBusy(false);
    }
  }

  function decide(action: DecisionAction, comment: string) {
    void run(() => otApi.decideRequest(id, action, comment), action === "approve" ? "Approved." : action === "reject" ? "Rejected." : "Sent back to the employee for correction.");
  }

  function saveRoute(submit: boolean) {
    const full = routePayload(route);
    if (submit && !full) return setError("Complete the Approval Route before submitting.");
    const picked = route.filter((s) => s.approver_user_id).map((s) => ({ approver_user_id: s.approver_user_id, title: s.title }));
    void run(async () => {
      await otApi.updateRequest(id, { approval_route: picked });
      if (submit) await otApi.submitRequest(id);
    }, submit ? "Request submitted." : "Saved.");
  }

  async function generateClaim() {
    setBusy(true);
    setError("");
    try {
      const res = await otApi.generateClaim(id);
      go({ name: "oclaim", id: res.id });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>Overtime · {monthLabel(r.year, r.month)}</h1>
        <div className="row gap">
          <span className="muted small">{r.request_no}</span>
          <HrStatus status={r.status} myTurn={canDecide} />
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {backNote && <p className="banner">{backNote}</p>}

      {canDecide && (
        <Decision heading={`Your decision · ${pending?.my_title || r.approval_steps.find((s) => s.step_order === r.current_step_order)?.title || "Approver"}`}
          actingFor={pending?.is_delegated ? pending.delegated_from_manager_name : null} busy={busy} onDecide={decide} />
      )}

      {confirmWithdraw && (
        <section className="card stack">
          <h3>Withdraw this request?</h3>
          <p className="small">It stops here and can't be submitted again.</p>
          <div className="action-list">
            <button type="button" className="secondary danger" disabled={busy} onClick={() => void run(() => otApi.withdrawRequest(id), "Withdrawn.")}>{busy ? "Working…" : "Withdraw request"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmWithdraw(false)}>Keep it</button>
          </div>
        </section>
      )}

      {r.status === "APPROVED" && (
        <section className="card stack-sm">
          {r.claim ? (
            <>
              <div className="row gap-sm">
                <span className="grow small">Claim <strong>{r.claim.claim_no}</strong></span>
                <HrStatus status={r.claim.status} />
              </div>
              <a className="secondary" href={href({ name: "oclaim", id: r.claim.id })}>Open the claim</a>
            </>
          ) : r.is_owner ? (
            <>
              <p className="small">This request is approved and ready to be claimed. The claim starts from these days; fill in the times you actually worked.</p>
              <button type="button" className="primary" disabled={busy} onClick={() => void generateClaim()}>{busy ? "Working…" : "Generate claim"}</button>
            </>
          ) : (
            <p className="small">This request is approved. The employee still needs to generate the claim.</p>
          )}
        </section>
      )}

      <section className="card">
        <div className="kv"><span className="muted small">Employee</span><span className="kv-value">{r.employee_name}{r.employee_no ? ` · ${r.employee_no}` : ""}</span></div>
        {r.job_title && <div className="kv"><span className="muted small">Position</span><span className="kv-value">{r.job_title}</span></div>}
        {r.org_path?.team_name && <div className="kv"><span className="muted small">Section</span><span className="kv-value">{r.org_path.team_name}</span></div>}
        {r.noc && <div className="kv"><span className="muted small">NOC</span><span className="kv-value">{r.noc}</span></div>}
        {r.car_reg && <div className="kv"><span className="muted small">Car reg</span><span className="kv-value">{r.car_reg}</span></div>}
        {r.remarks && <div className="kv"><span className="muted small">Remarks</span><span className="kv-value pre">{r.remarks}</span></div>}
        {r.submitted_at && <div className="kv"><span className="muted small">Submitted</span><span className="kv-value">{dayLabel(r.submitted_at.slice(0, 10))}</span></div>}
      </section>

      <section className="stack-sm">
        <h2>Overtime days</h2>
        {r.lines.length === 0 ? <p className="muted small">No days added.</p> : (
          <ul className="list">
            {r.lines.map((l, i) => (
              <li key={i} className="row-link">
                <span className="grow">
                  <strong className="small">{dayLabel(l.date, true)}</strong>
                  <span className="small">Estimated {hhmm(l.estimated_start)} – {hhmm(l.estimated_end)}</span>
                  {l.reason && <span className="muted small pre">{l.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isDraft && r.is_owner && (
        <>
          <RouteBuilder steps={route} onChange={setRoute} search={otApi.approvers} titles={OT_TITLES} defaultTitle="Checked by" />
          <div className="action-list">
            <button type="button" className="primary" disabled={busy} onClick={() => saveRoute(true)}>{busy ? "Working…" : "Submit request"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => saveRoute(false)}>Save draft</button>
          </div>
        </>
      )}

      {!isDraft && r.can_view_pdf && (
        <PdfButton path={otPdf.request(id)} name={`Overtime request ${r.request_no}.pdf`} onError={setError} />
      )}

      {!isDraft && (
        <section className="stack-sm">
          <h2>Approval route</h2>
          <RouteSteps steps={r.approval_steps} current={r.current_step_order} status={r.status} />
        </section>
      )}

      {canWithdraw && !confirmWithdraw && (
        <button type="button" className="secondary danger" onClick={() => { setNotice(""); setConfirmWithdraw(true); window.scrollTo(0, 0); }}>Withdraw request</button>
      )}
    </div>
  );
}
