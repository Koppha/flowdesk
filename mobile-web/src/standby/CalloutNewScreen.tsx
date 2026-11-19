import { useEffect, useState } from "react";
import { sbApi, useStandbyTitles, type Eligibility } from "./api";
import { RouteBuilder, routePayload, type RouteStep } from "../components/ApprovalRoute";
import { go } from "../router";

export type CalloutValues = { call_date: string; start_time: string; end_time: string; reason: string };

/**
 * When, why, and the live check against my standby - shared by a new
 * call-out and a draft one that was sent back.
 */
export function CalloutFields({ values, onChange, onEligibility }: {
  values: CalloutValues; onChange: (v: CalloutValues) => void; onEligibility: (e: Eligibility | null) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Eligibility | { message: string } | null>(null);
  const set = (patch: Partial<CalloutValues>) => onChange({ ...values, ...patch });

  // Informational, as on the portal: a call-out outside a published standby
  // assignment can still be sent; the note just says so, with the rate.
  useEffect(() => {
    const { call_date, start_time, end_time } = values;
    if (!call_date || !start_time || !end_time) {
      setCheck(null);
      onEligibility(null);
      return;
    }
    setChecking(true);
    const t = setTimeout(() => {
      sbApi.eligibility(call_date, start_time, end_time)
        .then((e) => { setCheck(e); onEligibility(e); })
        .catch((e) => { setCheck({ message: e.message }); onEligibility(null); })
        .finally(() => setChecking(false));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.call_date, values.start_time, values.end_time]);

  const result = check && "ratePct" in check ? check : null;

  return (
    <section className="card stack">
      <label className="field">
        <span>Date</span>
        <input type="date" value={values.call_date} onChange={(e) => set({ call_date: e.target.value })} />
      </label>
      <div className="two-col">
        <label className="field">
          <span>Start time</span>
          <input type="time" value={values.start_time} onChange={(e) => set({ start_time: e.target.value })} />
        </label>
        <label className="field">
          <span>End time</span>
          <input type="time" value={values.end_time} onChange={(e) => set({ end_time: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>Reason</span>
        <textarea rows={3} value={values.reason} placeholder="What happened and what you did" onChange={(e) => set({ reason: e.target.value })} />
      </label>
      {checking && <p className="muted small">Checking against your standby assignments…</p>}
      {!checking && check && (
        <div className={result?.insideStandbyAssignment ? "notice" : "banner"}>
          <strong>{result?.insideStandbyAssignment ? "Falls inside your standby period." : check.message || "This time is outside any published standby assignment."}</strong>
          {result && <div className="small">Rate {result.ratePct}% · Duration {result.hours} h · Converted hours {result.convertedHours}</div>}
        </div>
      )}
    </section>
  );
}

/** Same checks the portal makes before sending a call-out. */
export function calloutProblem(v: CalloutValues, route: RouteStep[], eligibility: Eligibility | null) {
  if (!v.call_date || !v.start_time || !v.end_time) return "Fill in the date, start and end time.";
  if (!v.reason.trim()) return "A reason is required.";
  if (eligibility && eligibility.eligible === false) return eligibility.message || "This call-out can't be claimed.";
  if (!routePayload(route)) return "Complete the Approval Route before submitting.";
  return "";
}

// Log a call-out: time actually worked when called out, sent straight for
// approval (the portal has no draft step for a new one either).
export default function StandbyCalloutNew() {
  const titles = useStandbyTitles();
  const [values, setValues] = useState<CalloutValues>({ call_date: new Date().toLocaleDateString("en-CA"), start_time: "", end_time: "", reason: "" });
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [route, setRoute] = useState<RouteStep[]>([{ approver_user_id: "", title: "Manager" }]);
  // If submitting fails after the call-out was created, a retry updates and
  // submits that one instead of creating a duplicate.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const problem = calloutProblem(values, route, eligibility);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    const body = { ...values, reason: values.reason.trim(), approval_route: routePayload(route)! };
    try {
      let id = createdId;
      if (id) await sbApi.updateCallout(id, body);
      else {
        id = (await sbApi.createCallout(body)).id;
        setCreatedId(id);
      }
      await sbApi.submitCallout(id);
      go({ name: "scall", id }, true);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>Log a call-out</h1>
      <CalloutFields values={values} onChange={setValues} onEligibility={setEligibility} />
      <RouteBuilder steps={route} onChange={setRoute} search={sbApi.approvers} titles={titles} defaultTitle="Manager" />
      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>{busy ? "Sending…" : "Submit call-out claim"}</button>
      </div>
    </div>
  );
}
