import { useCallback, useEffect, useState } from "react";
import { sbApi, useStandbyTitles, type CalloutDetail, type Eligibility, type Pending } from "./api";
import { CalloutFields, calloutProblem, type CalloutValues } from "./CalloutNewScreen";
import {
  Decision, HrStatus, RouteBuilder, RouteSteps, dayLabel, draftRoute, hhmm, routePayload, sentBackNote,
  type DecisionAction, type RouteStep
} from "../components/ApprovalRoute";
import { formatDateTime } from "../ui";

// One call-out: approve / reject / send back as its current approver;
// withdraw, or fix and resubmit after a send-back, as its owner.
export default function StandbyCallout({ id }: { id: string }) {
  const titles = useStandbyTitles();
  const [c, setC] = useState<CalloutDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [values, setValues] = useState<CalloutValues | null>(null);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [route, setRoute] = useState<RouteStep[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, mine] = await Promise.all([sbApi.callout(id), sbApi.calloutApprovals().catch(() => [])]);
      setC(detail);
      setPending(mine.find((x) => x.id === id) || null);
      setValues({ call_date: String(detail.call_date).slice(0, 10), start_time: hhmm(detail.start_time), end_time: hhmm(detail.end_time), reason: detail.reason || "" });
      setRoute(draftRoute(detail.approval_steps, detail.route_history, [{ approver_user_id: "", title: "Manager" }]));
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !c) return <p className="error">{error}</p>;
  if (!c || !values) return <p className="muted center">Loading…</p>;

  const editable = c.status === "DRAFT" && c.is_owner;
  const canDecide = c.status === "SUBMITTED" && (c.is_current_approver || Boolean(pending));
  const canWithdraw = c.is_owner && (c.status === "DRAFT" || c.status === "SUBMITTED");
  const backNote = c.status === "DRAFT" ? sentBackNote(c.route_history) : "";

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(done);
      setConfirmWithdraw(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      window.scrollTo(0, 0);
    }
  }

  function decide(action: DecisionAction, comment: string) {
    void run(() => sbApi.decideCallout(id, action, comment), action === "approve" ? "Approved." : action === "reject" ? "Rejected." : "Sent back to the employee for correction.");
  }

  function resubmit() {
    const problem = calloutProblem(values!, route, eligibility);
    if (problem) return setError(problem);
    void run(async () => {
      await sbApi.updateCallout(id, { ...values!, reason: values!.reason.trim(), approval_route: routePayload(route)! });
      await sbApi.submitCallout(id);
    }, "Call-out submitted.");
  }

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>Call-out · {dayLabel(c.call_date)}</h1>
        <div className="row gap">
          <span className="muted small">{c.claim_no}</span>
          <HrStatus status={c.status} myTurn={canDecide} />
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {backNote && <p className="banner">{backNote}</p>}

      {canDecide && (
        <Decision heading={`Your decision · ${pending?.my_title || c.approval_steps.find((s) => s.step_order === c.current_step_order)?.title || "Approver"}`}
          busy={busy} onDecide={decide} />
      )}

      {confirmWithdraw && (
        <section className="card stack">
          <h3>Withdraw this call-out?</h3>
          <p className="small">It stops here and can't be submitted again.</p>
          <div className="action-list">
            <button type="button" className="secondary danger" disabled={busy} onClick={() => void run(() => sbApi.withdrawCallout(id), "Withdrawn.")}>{busy ? "Working…" : "Withdraw call-out"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmWithdraw(false)}>Keep it</button>
          </div>
        </section>
      )}

      {editable ? (
        <>
          <CalloutFields values={values} onChange={setValues} onEligibility={setEligibility} />
          <RouteBuilder steps={route} onChange={setRoute} search={sbApi.approvers} titles={titles} defaultTitle="Manager" />
          <button type="button" className="primary" disabled={busy} onClick={resubmit}>{busy ? "Working…" : "Submit call-out claim"}</button>
        </>
      ) : (
        <section className="card">
          <div className="kv"><span className="muted small">Employee</span><span className="kv-value">{c.employee_name}</span></div>
          <div className="kv"><span className="muted small">Date</span><span className="kv-value">{dayLabel(c.call_date, true)}</span></div>
          <div className="kv"><span className="muted small">Time</span><span className="kv-value">{hhmm(c.start_time)} – {hhmm(c.end_time)} ({c.hours} h)</span></div>
          <div className="kv"><span className="muted small">Rate</span><span className="kv-value">{c.rate_pct}%</span></div>
          <div className="kv"><span className="muted small">Converted hours</span><span className="kv-value">{c.converted_hours}</span></div>
          <div className="kv"><span className="muted small">Reason</span><span className="kv-value pre">{c.reason}</span></div>
          {c.submitted_at && <div className="kv"><span className="muted small">Submitted</span><span className="kv-value">{formatDateTime(c.submitted_at)}</span></div>}
          {c.closed_at && <div className="kv"><span className="muted small">Closed</span><span className="kv-value">{formatDateTime(c.closed_at)}</span></div>}
        </section>
      )}

      {c.status !== "DRAFT" && (
        <section className="stack-sm">
          <h2>Approval route</h2>
          <RouteSteps steps={c.approval_steps} current={c.current_step_order} status={c.status} />
        </section>
      )}

      {canWithdraw && !confirmWithdraw && (
        <button type="button" className="secondary danger" onClick={() => { setNotice(""); setConfirmWithdraw(true); window.scrollTo(0, 0); }}>Withdraw call-out</button>
      )}
    </div>
  );
}
