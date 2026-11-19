import { useCallback, useEffect, useState } from "react";
import { otApi, otPdf, OT_TITLES, type ClaimLine, type OtClaimDetail, type Pending } from "./api";
import {
  Decision, HrStatus, PdfButton, RouteBuilder, RouteSteps, dayLabel, draftRoute, hhmm, monthLabel, routePayload, sentBackNote,
  type DecisionAction, type RouteStep
} from "../components/ApprovalRoute";
import { href } from "../router";
import { formatDateTime } from "../ui";

const START_ROUTE: RouteStep[] = [
  { approver_user_id: "", title: "Checked by" },
  { approver_user_id: "", title: "Approved by" }
];

/** The rate bucket the server put a day in (125 / 150 / 200%). */
function rateOf(l: ClaimLine) {
  if (Number(l.hours_200)) return "200%";
  if (Number(l.hours_150)) return "150%";
  if (Number(l.hours_125)) return "125%";
  return "";
}

const money = (v: string | number | null) => `M ${Number(v || 0).toFixed(2)}`;

// One overtime claim (the Allowance Report). The request only carries
// estimated hours, so while it's a draft the owner fills in the times
// actually worked here; the server recomputes the rates on save.
export default function OvertimeClaim({ id }: { id: string }) {
  const [c, setC] = useState<OtClaimDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lines, setLines] = useState<ClaimLine[]>([]);
  const [route, setRoute] = useState<RouteStep[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, mine] = await Promise.all([otApi.claim(id), otApi.claimApprovals().catch(() => [])]);
      setC(detail);
      setPending(mine.find((x) => x.id === id) || null);
      setLines(detail.lines || []);
      setRoute(draftRoute(detail.approval_steps, detail.route_history, START_ROUTE));
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

  const editable = c.status === "DRAFT" && c.is_owner;
  const canDecide = c.status === "SUBMITTED" && (c.is_current_approver || Boolean(pending));
  const canWithdraw = c.is_owner && (c.status === "DRAFT" || c.status === "SUBMITTED");
  const backNote = c.status === "DRAFT" ? sentBackNote(c.route_history) : "";
  const setLine = (i: number, patch: Partial<ClaimLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

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
    void run(() => otApi.decideClaim(id, action, comment), action === "approve" ? "Approved." : action === "reject" ? "Rejected." : "Sent back to the employee for correction.");
  }

  function save(submit: boolean) {
    if (submit && !routePayload(route)) return setError("Complete the Approval Route before submitting.");
    if (lines.some((l) => !l.from_time || !l.to_time)) return setError("Each day needs a from and to time.");
    const picked = route.filter((s) => s.approver_user_id).map((s) => ({ approver_user_id: s.approver_user_id, title: s.title }));
    void run(async () => {
      await otApi.updateClaim(id, { lines, ...(picked.length ? { approval_route: picked } : {}) });
      if (submit) await otApi.submitClaim(id);
    }, submit ? "Claim submitted." : "Saved - hours recalculated.");
  }

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>Overtime claim · {monthLabel(c.year, c.month)}</h1>
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
          actingFor={pending?.is_delegated ? pending.delegated_from_manager_name : null} busy={busy} onDecide={decide} />
      )}

      {confirmWithdraw && (
        <section className="card stack">
          <h3>Withdraw this claim?</h3>
          <p className="small">It stops here and can't be submitted again.</p>
          <div className="action-list">
            <button type="button" className="secondary danger" disabled={busy} onClick={() => void run(() => otApi.withdrawClaim(id), "Withdrawn.")}>{busy ? "Working…" : "Withdraw claim"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmWithdraw(false)}>Keep it</button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="kv"><span className="muted small">Employee</span><span className="kv-value">{c.employee_name}{c.employee_no ? ` · ${c.employee_no}` : ""}</span></div>
        {c.job_title && <div className="kv"><span className="muted small">Job title</span><span className="kv-value">{c.job_title}</span></div>}
        {c.org_path?.team_name && <div className="kv"><span className="muted small">Section</span><span className="kv-value">{c.org_path.team_name}</span></div>}
        {c.source_request && (
          <div className="kv"><span className="muted small">From request</span><a className="kv-value" href={href({ name: "oreq", id: c.source_request.id })}>{c.source_request.request_no}</a></div>
        )}
        <div className="kv"><span className="muted small">Total overtime</span><span className="kv-value">{c.total_overtime} h</span></div>
        <div className="kv"><span className="muted small">Converted hours</span><span className="kv-value">{c.converted_hours} h</span></div>
        <div className="kv"><span className="muted small">Equivalent days</span><span className="kv-value">{c.equivalent_days}</span></div>
        {c.total_amount != null && (
          <>
            <div className="kv"><span className="muted small">Hourly rate</span><span className="kv-value">{money(c.hourly_rate)}</span></div>
            <div className="kv"><span className="muted small">Total amount</span><span className="kv-value">{money(c.total_amount)}</span></div>
          </>
        )}
        {c.submitted_at && <div className="kv"><span className="muted small">Submitted</span><span className="kv-value">{formatDateTime(c.submitted_at)}</span></div>}
        {c.closed_at && <div className="kv"><span className="muted small">Closed</span><span className="kv-value">{formatDateTime(c.closed_at)}</span></div>}
      </section>

      <section className="stack-sm">
        <h2>Days worked</h2>
        {(editable ? lines : c.lines).map((l, i) => editable ? (
          <div key={i} className="card stack-sm">
            <strong className="small">{dayLabel(l.date, true)}{rateOf(l) ? ` · ${rateOf(l)}` : ""}</strong>
            <div className="two-col">
              <label className="field"><span>From</span><input type="time" value={(l.from_time || "").slice(0, 5)} onChange={(e) => setLine(i, { from_time: e.target.value })} /></label>
              <label className="field"><span>To</span><input type="time" value={(l.to_time || "").slice(0, 5)} onChange={(e) => setLine(i, { to_time: e.target.value })} /></label>
            </div>
            <label className="field"><span>Ordered by</span><input value={l.ordered_by || ""} onChange={(e) => setLine(i, { ordered_by: e.target.value })} /></label>
            <div className="two-col">
              <label className="field"><span>Account no.</span><input value={l.account_number || ""} onChange={(e) => setLine(i, { account_number: e.target.value })} /></label>
              <label className="field"><span>Account name</span><input value={l.account_name || ""} onChange={(e) => setLine(i, { account_name: e.target.value })} /></label>
            </div>
            <label className="consent">
              <input type="checkbox" checked={Boolean(l.observed_holiday)} onChange={(e) => setLine(i, { observed_holiday: e.target.checked })} />
              <span className="small">Public holiday (200%) - e.g. a holiday moved onto this weekday that the calendar doesn't show</span>
            </label>
          </div>
        ) : (
          <div key={i} className="card stack-sm">
            <div className="row gap-sm">
              <strong className="grow small">{dayLabel(l.date, true)}</strong>
              {rateOf(l) && <span className="pill info">{rateOf(l)}</span>}
            </div>
            <span className="small">{hhmm(l.from_time)} – {hhmm(l.to_time)} · {l.converted_hours ?? 0} converted h</span>
            {l.ordered_by && <span className="muted small">Ordered by {l.ordered_by}</span>}
            {(l.account_number || l.account_name) && <span className="muted small">Account {[l.account_number, l.account_name].filter(Boolean).join(" · ")}</span>}
            {l.observed_holiday && <span className="muted small">Marked as a public holiday</span>}
          </div>
        ))}
        {!c.lines.length && <p className="muted small">No days on this claim.</p>}
      </section>

      {editable && (
        <>
          <RouteBuilder steps={route} onChange={setRoute} search={otApi.approvers} titles={OT_TITLES} defaultTitle="Checked by" />
          <div className="action-list">
            <button type="button" className="primary" disabled={busy} onClick={() => save(true)}>{busy ? "Working…" : "Submit claim"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => save(false)}>Save draft</button>
          </div>
        </>
      )}

      {c.status !== "DRAFT" && c.can_view_pdf && (
        <PdfButton path={otPdf.claim(id)} name={`Overtime claim ${c.claim_no}.pdf`} onError={setError} />
      )}

      {c.status !== "DRAFT" && (
        <section className="stack-sm">
          <h2>Approval route</h2>
          <RouteSteps steps={c.approval_steps} current={c.current_step_order} status={c.status} />
        </section>
      )}

      {canWithdraw && !confirmWithdraw && (
        <button type="button" className="secondary danger" onClick={() => { setNotice(""); setConfirmWithdraw(true); window.scrollTo(0, 0); }}>Withdraw claim</button>
      )}
    </div>
  );
}
