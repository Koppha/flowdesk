import { useEffect, useState } from "react";
import { sbApi, sbMonthLabel, shiftMonth, thisMonth, type Callout, type MyStandby, type Pending, type SbClaim } from "./api";
import { HrStatus, dayLabel, hhmm } from "../components/ApprovalRoute";
import { go, href } from "../router";
import { appCan, postToApp } from "../bridge";
import { formatDate } from "../ui";

type Scope = "todo" | "my" | "claims" | "callouts";
const SCOPE_KEY = "flowdesk.standby.scope";
const MONTH_KEY = "flowdesk.standby.month";

const SCOPES: { key: Scope; label: string }[] = [
  { key: "todo", label: "To approve" },
  { key: "my", label: "My standby" },
  { key: "claims", label: "My claims" },
  { key: "callouts", label: "My call-outs" }
];

type Todo = { claims: (SbClaim & Pending)[]; callouts: (Callout & Pending)[] };

const actingFor = (p: Pending) => (p.is_delegated && p.delegated_from_manager_name ? ` for ${p.delegated_from_manager_name}` : "");

function readSession(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

// Standby: what's waiting on me (claims and call-outs), my published standby
// for a month (and its claim), my claims and my call-outs. The only thing
// started here is a call-out - a monthly claim comes from "My standby".
export default function StandbyList() {
  const [scope, setScope] = useState<Scope | null>(null);
  const [todo, setTodo] = useState<Todo | null>(null);
  const [month, setMonth] = useState(() => readSession(MONTH_KEY) || thisMonth());
  const [my, setMy] = useState<MyStandby | null>(null);
  const [claims, setClaims] = useState<SbClaim[] | null>(null);
  const [callouts, setCallouts] = useState<Callout[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadTodo = () =>
    Promise.all([sbApi.claimApprovals(), sbApi.calloutApprovals()]).then(([claims, callouts]) => {
      const t = { claims, callouts };
      setTodo(t);
      return t;
    });

  useEffect(() => {
    const saved = readSession(SCOPE_KEY);
    loadTodo()
      .then((t) => setScope(SCOPES.find((s) => s.key === saved)?.key || (t.claims.length + t.callouts.length ? "todo" : "my")))
      .catch((e) => {
        setTodo({ claims: [], callouts: [] });
        setError(e.message);
        setScope("my");
      });
  }, []);

  useEffect(() => {
    if (!scope) return;
    writeSession(SCOPE_KEY, scope);
    setError("");
    if (scope === "todo") void loadTodo().catch((e) => setError(e.message));
    if (scope === "claims") sbApi.claims().then(setClaims).catch((e) => setError(e.message));
    if (scope === "callouts") sbApi.callouts().then(setCallouts).catch((e) => setError(e.message));
  }, [scope]);

  useEffect(() => {
    if (scope !== "my") return;
    writeSession(MONTH_KEY, month);
    setMy(null);
    sbApi.my(month).then(setMy).catch((e) => setError(e.message));
  }, [scope, month]);

  const headerButton = appCan("headerAction");
  useEffect(() => {
    if (!headerButton) return;
    postToApp({ type: "headerAction", label: "Call-out", hash: href({ name: "snew" }) });
    return () => postToApp({ type: "headerAction", label: null });
  }, [headerButton]);

  async function generateClaim() {
    setBusy(true);
    setError("");
    try {
      const res = await sbApi.generateClaim(month);
      go({ name: "sclaim", id: res.id });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  if (!scope) return <p className="muted center">Loading…</p>;
  const waiting = todo ? todo.claims.length + todo.callouts.length : 0;

  return (
    <div className="stack">
      {!headerButton && (
        <div className="top-actions">
          <a className="new-btn" href={href({ name: "snew" })} aria-label="Log a call-out">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
            Call-out
          </a>
        </div>
      )}

      <div className="chips" role="tablist">
        {SCOPES.map((s) => (
          <button key={s.key} type="button" role="tab" aria-selected={scope === s.key} className={scope === s.key ? "on" : ""} onClick={() => setScope(s.key)}>
            {s.label}{s.key === "todo" && waiting > 0 ? ` (${waiting})` : ""}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {scope === "todo" && (
        !todo ? <p className="muted center">Loading…</p>
        : waiting === 0 ? <p className="muted center">Nothing is waiting on you.</p>
        : (
          <>
            {todo.claims.length > 0 && (
              <section className="stack-sm">
                <h2>Standby claims</h2>
                <ul className="list">
                  {todo.claims.map((c) => (
                    <li key={c.id} className="highlight">
                      <a href={href({ name: "sclaim", id: c.id })} className="row-link">
                        <span className="grow">
                          <strong>{c.employee_name || "Employee"}</strong>
                          <span className="small">{c.claim_no} · {sbMonthLabel(c.claim_month)} · {c.compensable_hours} compensable h</span>
                          {c.submitted_at && <span className="muted small">Sent {formatDate(c.submitted_at)}</span>}
                          <span className="next-step small">Approve as {c.my_title}{actingFor(c)}</span>
                        </span>
                        <HrStatus status={c.status} myTurn />
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {todo.callouts.length > 0 && (
              <section className="stack-sm">
                <h2>Call-outs</h2>
                <ul className="list">
                  {todo.callouts.map((c) => (
                    <li key={c.id} className="highlight">
                      <a href={href({ name: "scall", id: c.id })} className="row-link">
                        <span className="grow">
                          <strong>{c.employee_name || "Employee"}</strong>
                          <span className="small">{c.claim_no} · {dayLabel(c.call_date)} · {hhmm(c.start_time)}–{hhmm(c.end_time)} · {c.rate_pct}%</span>
                          {c.submitted_at && <span className="muted small">Sent {formatDate(c.submitted_at)}</span>}
                          <span className="next-step small">Approve as {c.my_title}{c.is_delegated ? " (delegated)" : ""}</span>
                        </span>
                        <HrStatus status={c.status} myTurn />
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )
      )}

      {scope === "my" && (
        <>
          <div className="month-nav">
            <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
            <strong>{sbMonthLabel(month)}</strong>
            <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
          </div>
          {!my ? !error && <p className="muted center">Loading…</p> : (
            <>
              <div className="stats">
                <div className="stat"><strong>{my.assignments.length}</strong><span className="muted small">Assignments</span></div>
                <div className="stat"><strong>{Math.round(Number(my.total_standby_hours) * 100) / 100}</strong><span className="muted small">Standby hours</span></div>
                <div className="stat"><span>{my.claim ? <HrStatus status={my.claim.status} /> : <span className="pill muted">Not started</span>}</span><span className="muted small">Claim</span></div>
              </div>
              {my.assignments.length === 0 ? (
                <p className="muted center">No published standby for this month.</p>
              ) : (
                <ul className="list">
                  {my.assignments.map((a) => (
                    <li key={a.id} className="row-link">
                      <span className="grow">
                        <strong className="small">{dayLabel(a.standby_date, true)}</strong>
                        <span className="muted small">{hhmm(a.start_time)} – {hhmm(a.end_time)}</span>
                      </span>
                      <span className="small">{a.hours} h</span>
                    </li>
                  ))}
                </ul>
              )}
              {my.claim ? (
                <a className="primary" href={href({ name: "sclaim", id: my.claim.id })}>Review claim</a>
              ) : my.assignments.length > 0 && (
                <button type="button" className="primary" disabled={busy} onClick={() => void generateClaim()}>{busy ? "Working…" : "Generate monthly claim"}</button>
              )}
              <a className="secondary" href={href({ name: "snew" })}>Log a call-out</a>
            </>
          )}
        </>
      )}

      {scope === "claims" && (
        !claims ? !error && <p className="muted center">Loading…</p>
        : claims.length === 0 ? <p className="muted center">No claims yet. Generate one from My standby.</p>
        : (
          <ul className="list">
            {claims.map((c) => (
              <li key={c.id}>
                <a href={href({ name: "sclaim", id: c.id })} className="row-link">
                  <span className="grow">
                    <strong>{sbMonthLabel(c.claim_month)}{c.is_adjustment ? " · adjustment" : ""}</strong>
                    <span className="small">{c.claim_no} · {c.compensable_hours} compensable h</span>
                    <span className="muted small">{c.submitted_at ? `Sent ${formatDate(c.submitted_at)}` : `Created ${formatDate(c.created_at)}`}</span>
                  </span>
                  <HrStatus status={c.status} />
                </a>
              </li>
            ))}
          </ul>
        )
      )}

      {scope === "callouts" && (
        !callouts ? !error && <p className="muted center">Loading…</p>
        : callouts.length === 0 ? <p className="muted center">No call-outs logged yet.</p>
        : (
          <ul className="list">
            {callouts.map((c) => (
              <li key={c.id}>
                <a href={href({ name: "scall", id: c.id })} className="row-link">
                  <span className="grow">
                    <strong>{dayLabel(c.call_date, true)}</strong>
                    <span className="small">{c.claim_no} · {hhmm(c.start_time)}–{hhmm(c.end_time)} · {c.hours} h at {c.rate_pct}%</span>
                    <span className="muted small">{c.converted_hours} converted h</span>
                  </span>
                  <HrStatus status={c.status} />
                </a>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
