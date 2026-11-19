import { useEffect, useState } from "react";
import { send } from "../api";
import { appCan, inApp, postToApp } from "../bridge";
import { formatDateTime } from "../ui";

// Shared by Overtime and Standby: both use the same employee-defined
// approval route (pick each approver and the capacity they sign in), the same
// approve / reject / send back decision and the same claim statuses - see the
// portal's components/ApprovalRoute.tsx and ClaimTrackingTimeline.tsx.

export type RouteStep = { approver_user_id: string; title: string; approver_name?: string | null };

/** A row from /overtime/eligible-approvers or /standby/eligible-approvers. */
export type Approver = { id: string; full_name: string | null; employee_no?: string | null; title?: string | null; department?: string | null };

/** One step of a submitted route, as the detail endpoints return it. */
export type ApprovalStep = {
  step_order: number;
  approver_user_id: string;
  approver_name: string | null;
  title: string;
  status: string;
  decided_at: string | null;
  comments: string | null;
  route_version?: number;
};

const STATUS: Record<string, [string, string]> = {
  DRAFT: ["Draft", "muted"],
  SUBMITTED: ["Pending approval", "warn"],
  APPROVED: ["Approved", "good"],
  AWAITING_TREASURY: ["Awaiting Treasury", "info"],
  FINANCE_PROCESSING: ["With Finance", "info"],
  PAYMENT_PENDING: ["Payment pending", "info"],
  PAID: ["Paid", "good"],
  CLOSED: ["Closed", "good"],
  REJECTED: ["Rejected", "bad"],
  RETURNED: ["Returned", "warn"],
  WITHDRAWN: ["Withdrawn", "muted"]
};

export function HrStatus({ status, myTurn }: { status: string; myTurn?: boolean }) {
  if (myTurn) return <span className="pill accent">Your turn</span>;
  const [label, tone] = STATUS[status] || [String(status || "").replace(/_/g, " ").toLowerCase(), "muted"];
  return <span className={`pill ${tone}`}>{label}</span>;
}

/** "2026-11-03" (a date column) shown without a timezone shift. */
export function dayLabel(date: string | null | undefined, withWeekday = false) {
  if (!date) return "—";
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString("en-GB", { ...(withWeekday ? { weekday: "short" } : {}), day: "numeric", month: "short", year: "numeric" });
}

/** Postgres time columns come back as "17:00:00". */
export const hhmm = (t: string | null | undefined) => (t ? String(t).slice(0, 5) : "—");

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (year: number, month: number) => `${MONTHS[(month || 1) - 1] || ""} ${year || ""}`.trim();

/** Who it's with now, for lists. */
export function withText(status: string, stepTitle?: string | null) {
  return status === "SUBMITTED" && stepTitle ? `Pending ${stepTitle}` : "";
}

// ── Route builder ──────────────────────────────────────────────────────────

function StepRow({ index, step, titles, search, onChange, onRemove }: {
  index: number; step: RouteStep; titles: string[]; search: (q: string) => Promise<Approver[]>;
  onChange: (patch: Partial<RouteStep>) => void; onRemove: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Approver[] | null>(null);

  // Same as the portal: the server only searches from two characters.
  useEffect(() => {
    if (q.trim().length < 2) return setResults(null);
    const t = setTimeout(() => {
      search(q.trim()).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, search]);

  return (
    <div className="stack-sm">
      <div className="row gap-sm">
        <strong className="grow small">Step {index + 1}</strong>
        <button type="button" className="link-btn" onClick={onRemove}>Remove</button>
      </div>
      <select value={step.title} onChange={(e) => onChange({ title: e.target.value })} aria-label={`Step ${index + 1} capacity`}>
        {(titles.includes(step.title) ? titles : [step.title, ...titles]).map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {step.approver_user_id ? (
        <div className="row gap-sm">
          <span className="grow">{step.approver_name || "Approver picked"}</span>
          <button type="button" className="link-btn" onClick={() => onChange({ approver_user_id: "", approver_name: null })}>Change</button>
        </div>
      ) : (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or employee no…" aria-label={`Step ${index + 1} approver`} />
          {results && results.length > 0 && (
            <ul className="list">
              {results.map((p) => (
                <li key={p.id}>
                  <button type="button" className="row-link plain" onClick={() => { onChange({ approver_user_id: p.id, approver_name: p.full_name }); setQ(""); }}>
                    <span className="grow">
                      <span className="small"><strong>{p.full_name || p.employee_no || "Unnamed"}</strong></span>
                      {(p.title || p.department) && <span className="muted small">{[p.title, p.department].filter(Boolean).join(" · ")}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {results && !results.length && <span className="muted small">No one matches.</span>}
        </>
      )}
    </div>
  );
}

/** The approvers, in order, each with the capacity they approve in. */
export function RouteBuilder({ steps, onChange, search, titles, defaultTitle }: {
  steps: RouteStep[]; onChange: (s: RouteStep[]) => void; search: (q: string) => Promise<Approver[]>; titles: string[]; defaultTitle: string;
}) {
  return (
    <section className="card stack">
      <div>
        <h3>Approval route</h3>
        <p className="muted small">Add the people who need to approve this, in order.</p>
      </div>
      {steps.map((s, i) => (
        <StepRow key={i} index={i} step={s} titles={titles} search={search}
          onChange={(patch) => onChange(steps.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
          onRemove={() => onChange(steps.filter((_, j) => j !== i))} />
      ))}
      <button type="button" className="secondary" onClick={() => onChange([...steps, { approver_user_id: "", title: defaultTitle }])}>Add approver</button>
    </section>
  );
}

/** Steps as the PATCH endpoints take them; null when one isn't picked yet. */
export function routePayload(steps: RouteStep[]) {
  if (!steps.length || steps.some((s) => !s.approver_user_id)) return null;
  return steps.map((s) => ({ approver_user_id: s.approver_user_id, title: s.title }));
}

export const stepsToRoute = (steps: ApprovalStep[] | undefined): RouteStep[] =>
  (steps || []).map((s) => ({ approver_user_id: s.approver_user_id, title: s.title, approver_name: s.approver_name }));

/**
 * The route to edit on a draft: its own, or - after a send-back, which
 * starts a new empty route version - the one it was sent back from, so the
 * employee doesn't pick everyone again.
 */
export function draftRoute(steps: ApprovalStep[] | undefined, history: ApprovalStep[] | undefined, fallback: RouteStep[]): RouteStep[] {
  if (steps?.length) return stepsToRoute(steps);
  const last = Math.max(0, ...(history || []).map((s) => s.route_version || 0));
  const previous = (history || []).filter((s) => (s.route_version || 0) === last);
  return previous.length ? stepsToRoute(previous) : fallback;
}

// ── Approval history ───────────────────────────────────────────────────────

const STEP_STATUS: Record<string, string> = { APPROVED: "Approved", REJECTED: "Rejected", SENT_BACK: "Sent back", PENDING: "Waiting" };

export function RouteSteps({ steps, current, status }: { steps: ApprovalStep[]; current: number; status: string }) {
  if (!steps.length) return <p className="muted small">No approvers yet.</p>;
  return (
    <ol className="timeline">
      {steps.map((s) => {
        const isCurrent = status === "SUBMITTED" && s.step_order === current;
        const label = isCurrent ? "Waiting now" : STEP_STATUS[s.status] || s.status.replace(/_/g, " ").toLowerCase();
        return (
          <li key={`${s.route_version || 0}-${s.step_order}`}>
            <span className="row gap-sm">
              <strong className="small grow">{s.title}</strong>
              <span className={`pill ${isCurrent ? "accent" : s.status === "APPROVED" ? "good" : s.status === "REJECTED" ? "bad" : s.status === "SENT_BACK" ? "warn" : "muted"}`}>{label}</span>
            </span>
            <span className="small">{s.approver_name || "—"}</span>
            {s.decided_at && <span className="muted small">{formatDateTime(s.decided_at)}</span>}
            {s.comments && <span className="small pre">“{s.comments}”</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Why a draft came back to its owner (the last send-back in the old route). */
export function sentBackNote(history: ApprovalStep[] | undefined) {
  const last = [...(history || [])].reverse().find((s) => s.status === "SENT_BACK");
  return last ? `Sent back by ${last.approver_name || last.title}${last.comments ? `: “${last.comments}”` : "."}` : "";
}

// ── Approve / reject / send back ───────────────────────────────────────────

export type DecisionAction = "approve" | "reject" | "send-back";

/** Comment is optional to approve, required to reject or send back (as the server insists). */
export function Decision({ heading, actingFor, busy, onDecide }: {
  heading: string; actingFor?: string | null; busy: boolean; onDecide: (action: DecisionAction, comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  function go(action: DecisionAction) {
    if (action !== "approve" && !comment.trim()) return setError(action === "reject" ? "Say why you're rejecting it." : "Say what needs correcting.");
    setError("");
    onDecide(action, comment.trim());
  }
  return (
    <section className="card stack">
      <h3>{heading}</h3>
      {actingFor && <p className="muted small">You're acting for {actingFor}.</p>}
      <label className="field">
        <span>Comment (needed to reject or send back)</span>
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="action-list">
        <button type="button" className="primary" disabled={busy} onClick={() => go("approve")}>{busy ? "Working…" : "Approve"}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => go("send-back")}>Send back for correction</button>
        <button type="button" className="secondary danger" disabled={busy} onClick={() => go("reject")}>Reject</button>
      </div>
      <p className="muted small">Send back returns it to the employee as a draft to fix and resubmit. Reject is final.</p>
    </section>
  );
}

// ── PDFs ───────────────────────────────────────────────────────────────────

// The app (capability "hrFiles") downloads an overtime/standby PDF with the
// session and opens the share sheet; older builds reject these paths, so the
// button only shows when it will work. In a browser it's a plain download.
const canShare = () => !inApp || appCan("hrFiles");

async function download(path: string, name: string) {
  if (inApp) {
    postToApp({ type: "sharePdf", path, title: name });
    return;
  }
  const res = await send(path);
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json?.message || json?.error?.message || json?.error || "Couldn't download the PDF.");
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PdfButton({ path, name, onError }: { path: string; name: string; onError: (msg: string) => void }) {
  if (!canShare()) return <p className="muted small">Update the FlowDesk app to download the PDF here.</p>;
  return (
    <button type="button" className="secondary" onClick={() => download(path, name).catch((e) => onError(e.message))}>
      {inApp ? "Download / share PDF" : "Download PDF"}
    </button>
  );
}
