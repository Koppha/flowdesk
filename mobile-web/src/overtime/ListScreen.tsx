import { useEffect, useState } from "react";
import { otApi, type OtClaim, type OtRequest, type Pending } from "./api";
import { HrStatus, monthLabel, withText } from "../components/ApprovalRoute";
import { href } from "../router";
import { appCan, postToApp } from "../bridge";
import { formatDate } from "../ui";

type Scope = "todo" | "requests" | "claims";
const SCOPE_KEY = "flowdesk.overtime.scope";

const SCOPES: { key: Scope; label: string }[] = [
  { key: "todo", label: "To approve" },
  { key: "requests", label: "My requests" },
  { key: "claims", label: "My claims" }
];

type Todo = { requests: (OtRequest & Pending)[]; claims: (OtClaim & Pending)[] };

/** Where a request stands, as the portal's "Current Approval" column says it. */
function requestNext(r: OtRequest) {
  if (r.status === "SUBMITTED") return withText(r.status, r.current_step_title);
  if (r.status === "APPROVED" && r.claim_status === "CLOSED") return "Completed";
  if (r.status === "APPROVED" && r.claim_id) return "Claim in progress";
  if (r.status === "APPROVED") return "Ready to claim";
  return "";
}

function estimatedHours(r: OtRequest) {
  const total = (r.lines || []).reduce((sum, l) => {
    const [sh, sm] = (l.estimated_start || "00:00").split(":").map(Number);
    const [eh, em] = (l.estimated_end || "00:00").split(":").map(Number);
    let minutes = eh * 60 + em - (sh * 60 + sm);
    if (minutes < 0) minutes += 24 * 60;
    return sum + minutes / 60;
  }, 0);
  return Math.round(total * 100) / 100;
}

const actingFor = (p: Pending) => (p.is_delegated && p.delegated_from_manager_name ? ` for ${p.delegated_from_manager_name}` : "");

// Overtime: what's waiting on me (requests and claims), my requests and my
// claims. A claim is generated from an approved request, so "+ New" is
// always a request.
export default function OvertimeList() {
  const [scope, setScope] = useState<Scope | null>(null);
  const [todo, setTodo] = useState<Todo | null>(null);
  const [requests, setRequests] = useState<OtRequest[] | null>(null);
  const [claims, setClaims] = useState<OtClaim[] | null>(null);
  const [error, setError] = useState("");

  const loadTodo = () =>
    Promise.all([otApi.requestApprovals(), otApi.claimApprovals()]).then(([r, c]) => {
      const t = { requests: r, claims: c };
      setTodo(t);
      return t;
    });

  // Start on "To approve" when something's waiting - or wherever I was last.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(SCOPE_KEY);
    } catch {
      // ignore
    }
    loadTodo()
      .then((t) => setScope(SCOPES.find((s) => s.key === saved)?.key || (t.requests.length + t.claims.length ? "todo" : "requests")))
      .catch((e) => {
        setTodo({ requests: [], claims: [] });
        setError(e.message);
        setScope("requests");
      });
  }, []);

  useEffect(() => {
    if (!scope) return;
    try {
      sessionStorage.setItem(SCOPE_KEY, scope);
    } catch {
      // ignore
    }
    setError("");
    if (scope === "todo") void loadTodo().catch((e) => setError(e.message));
    if (scope === "requests") otApi.requests().then(setRequests).catch((e) => setError(e.message));
    if (scope === "claims") otApi.claims().then(setClaims).catch((e) => setError(e.message));
  }, [scope]);

  const headerButton = appCan("headerAction");
  useEffect(() => {
    if (!headerButton) return;
    postToApp({ type: "headerAction", label: "New", hash: href({ name: "onew" }) });
    return () => postToApp({ type: "headerAction", label: null });
  }, [headerButton]);

  if (!scope) return <p className="muted center">Loading…</p>;
  const waiting = todo ? todo.requests.length + todo.claims.length : 0;

  return (
    <div className="stack">
      {!headerButton && (
        <div className="top-actions">
          <a className="new-btn" href={href({ name: "onew" })} aria-label="New overtime request">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
            New
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
            {todo.requests.length > 0 && (
              <section className="stack-sm">
                <h2>Requests</h2>
                <ul className="list">
                  {todo.requests.map((r) => (
                    <li key={r.id} className="highlight">
                      <a href={href({ name: "oreq", id: r.id })} className="row-link">
                        <span className="grow">
                          <strong>{r.employee_name || "Employee"}</strong>
                          <span className="small">{r.request_no} · {monthLabel(r.year, r.month)}</span>
                          {r.submitted_at && <span className="muted small">Sent {formatDate(r.submitted_at)}</span>}
                          <span className="next-step small">Approve as {r.my_title}{actingFor(r)}</span>
                        </span>
                        <HrStatus status={r.status} myTurn />
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {todo.claims.length > 0 && (
              <section className="stack-sm">
                <h2>Claims</h2>
                <ul className="list">
                  {todo.claims.map((c) => (
                    <li key={c.id} className="highlight">
                      <a href={href({ name: "oclaim", id: c.id })} className="row-link">
                        <span className="grow">
                          <strong>{c.employee_name || "Employee"}</strong>
                          <span className="small">{c.claim_no} · {monthLabel(c.year, c.month)} · {c.converted_hours} converted h</span>
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
          </>
        )
      )}

      {scope === "requests" && (
        !requests ? !error && <p className="muted center">Loading…</p>
        : requests.length === 0 ? <p className="muted center">You haven't asked for overtime yet.</p>
        : (
          <ul className="list">
            {requests.map((r) => (
              <li key={r.id}>
                <a href={href({ name: "oreq", id: r.id })} className="row-link">
                  <span className="grow">
                    <strong>{monthLabel(r.year, r.month)}</strong>
                    <span className="small">{r.request_no} · {estimatedHours(r)} h planned</span>
                    <span className="muted small">{r.submitted_at ? `Sent ${formatDate(r.submitted_at)}` : `Created ${formatDate(r.created_at)}`}</span>
                    {requestNext(r) && <span className="muted small">{requestNext(r)}</span>}
                  </span>
                  <HrStatus status={r.status} />
                </a>
              </li>
            ))}
          </ul>
        )
      )}

      {scope === "claims" && (
        !claims ? !error && <p className="muted center">Loading…</p>
        : claims.length === 0 ? <p className="muted center">No claims yet. Open an approved request to generate one.</p>
        : (
          <ul className="list">
            {claims.map((c) => (
              <li key={c.id}>
                <a href={href({ name: "oclaim", id: c.id })} className="row-link">
                  <span className="grow">
                    <strong>{monthLabel(c.year, c.month)}</strong>
                    <span className="small">{c.claim_no} · {c.converted_hours} converted h</span>
                    <span className="muted small">{c.submitted_at ? `Sent ${formatDate(c.submitted_at)}` : `Created ${formatDate(c.created_at)}`}</span>
                    {withText(c.status, c.current_step_title) && <span className="muted small">{withText(c.status, c.current_step_title)}</span>}
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
