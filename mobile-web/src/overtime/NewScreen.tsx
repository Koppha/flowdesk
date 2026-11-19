import { useState } from "react";
import { otApi, OT_TITLES, type RequestLine } from "./api";
import { MONTHS, RouteBuilder, routePayload, type RouteStep } from "../components/ApprovalRoute";
import { go } from "../router";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayOf = (date: string) => (date ? WEEKDAYS[new Date(`${date}T00:00:00`).getDay()] || "" : "");
const blankLine = (): RequestLine => ({ date: "", estimated_start: "", estimated_end: "", reason: "" });

// A new overtime request: the month, the days and estimated hours planned,
// and who approves it - the portal's New Request screen, one column.
export default function OvertimeNew() {
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [noc, setNoc] = useState("");
  const [carReg, setCarReg] = useState("");
  const [lines, setLines] = useState<RequestLine[]>([blankLine()]);
  // The portal starts every request on this route.
  const [route, setRoute] = useState<RouteStep[]>([
    { approver_user_id: "", title: "Checked by" },
    { approver_user_id: "", title: "Approved by" },
    { approver_user_id: "", title: "Approved by" }
  ]);
  // Once created, a retry (e.g. submit failed) updates that draft rather
  // than creating a second one.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "draft" | "submit">("");
  const [error, setError] = useState("");

  const setLine = (i: number, patch: Partial<RequestLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch, ...(patch.date !== undefined ? { day: dayOf(patch.date) } : {}) } : l)));

  async function save(submit: boolean) {
    const used = lines.filter((l) => l.date || l.estimated_start || l.estimated_end || l.reason?.trim());
    const yr = Number(year);
    if (!yr || yr < 2000 || yr > 2100) return setError("Enter the year, e.g. 2026.");
    if (submit) {
      if (!used.length) return setError("Add at least one overtime day.");
      if (used.some((l) => !l.date || !l.estimated_start || !l.estimated_end)) return setError("Each overtime day needs a date and its estimated start and end time.");
    }
    if (submit && !routePayload(route)) return setError("Complete the Approval Route before submitting.");

    setBusy(submit ? "submit" : "draft");
    setError("");
    const body = { year: yr, month, noc: noc.trim(), car_reg: carReg.trim(), lines: used.map((l) => ({ ...l, day: dayOf(l.date), reason: l.reason?.trim() || "" })) };
    try {
      let id = createdId;
      if (id) await otApi.updateRequest(id, body);
      else {
        id = (await otApi.createRequest(body)).id;
        setCreatedId(id);
      }
      // A draft keeps whichever approvers are already picked.
      const picked = route.filter((s) => s.approver_user_id).map((s) => ({ approver_user_id: s.approver_user_id, title: s.title }));
      if (picked.length) await otApi.updateRequest(id, { approval_route: picked });
      if (submit) await otApi.submitRequest(id);
      go({ name: "oreq", id }, true);
    } catch (e: any) {
      setError(e.message);
      setBusy("");
    }
  }

  return (
    <div className="stack">
      <h1>New overtime request</h1>

      <section className="card stack">
        <div className="two-col">
          <label className="field">
            <span>Month</span>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Year</span>
            <input type="number" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          </label>
        </div>
        <div className="two-col">
          <label className="field">
            <span>NOC</span>
            <input value={noc} onChange={(e) => setNoc(e.target.value)} />
          </label>
          <label className="field">
            <span>Car reg</span>
            <input value={carReg} onChange={(e) => setCarReg(e.target.value)} />
          </label>
        </div>
      </section>

      <section className="stack-sm">
        <h2>Overtime days</h2>
        {lines.map((l, i) => (
          <div key={i} className="card stack-sm">
            <div className="row gap-sm">
              <strong className="grow small">Day {i + 1}{l.date ? ` · ${dayOf(l.date)}` : ""}</strong>
              {lines.length > 1 && <button type="button" className="link-btn" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button>}
            </div>
            <label className="field">
              <span>Date</span>
              <input type="date" value={l.date} onChange={(e) => setLine(i, { date: e.target.value })} />
            </label>
            <div className="two-col">
              <label className="field">
                <span>Estimated from</span>
                <input type="time" value={l.estimated_start || ""} onChange={(e) => setLine(i, { estimated_start: e.target.value })} />
              </label>
              <label className="field">
                <span>Estimated to</span>
                <input type="time" value={l.estimated_end || ""} onChange={(e) => setLine(i, { estimated_end: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Reason for overtime</span>
              <textarea rows={2} value={l.reason || ""} onChange={(e) => setLine(i, { reason: e.target.value })} />
            </label>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, blankLine()])}>Add another day</button>
      </section>

      <RouteBuilder steps={route} onChange={setRoute} search={otApi.approvers} titles={OT_TITLES} defaultTitle="Checked by" />

      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="button" className="primary" disabled={!!busy} onClick={() => void save(true)}>{busy === "submit" ? "Sending…" : "Submit request"}</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void save(false)}>{busy === "draft" ? "Saving…" : "Save draft"}</button>
      </div>
    </div>
  );
}
