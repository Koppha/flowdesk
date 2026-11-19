import { useEffect, useState } from "react";
import { cApi, type Summary, type Task } from "./api";
import { allMyBrs, BRS_PHASES, type BrsSummary } from "./brs";
import { CStatus, nextStepText, refOf } from "./shared";
import { href } from "../router";
import { appCan, postToApp } from "../bridge";
import { formatDate } from "../ui";

type Scope = "todo" | "mine" | "assigned" | "cr" | "brs";
type BrsRow = BrsSummary & { why: "mine" | "assigned" | "shared" };
const BRS_WHY = { mine: "Yours", assigned: "Your input / review", shared: "Shared with you" } as const;
const SCOPE_KEY = "flowdesk.custom.scope";

const SCOPES: { key: Scope; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "mine", label: "My requests" },
  { key: "assigned", label: "Assigned to me" },
  { key: "cr", label: "Change Requests" },
  // BRS Studio: on the portal it sits under Custom Processes too.
  { key: "brs", label: "BRS" }
];

// Custom Processes: what's waiting on me, my own requests, the ones I'm an
// assignee on, and the Change Requests I own or co-write.
export default function CustomList() {
  const [scope, setScope] = useState<Scope | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [items, setItems] = useState<Summary[] | null>(null);
  const [brs, setBrs] = useState<BrsRow[] | null>(null);
  const [error, setError] = useState("");

  // Start on "To do" when something's waiting, otherwise my requests - or
  // wherever I was last.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(SCOPE_KEY);
    } catch {
      // ignore
    }
    cApi.tasks()
      .then((t) => {
        setTasks(t);
        setScope((SCOPES.find((s) => s.key === saved)?.key) || (t.length ? "todo" : "mine"));
      })
      .catch((e) => {
        setTasks([]);
        setError(e.message);
        setScope("mine");
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
    if (scope === "todo") {
      setItems(null);
      cApi.tasks().then(setTasks).catch((e) => setError(e.message));
      return;
    }
    if (scope === "brs") {
      setBrs(null);
      allMyBrs().then(setBrs).catch((e) => setError(e.message));
      return;
    }
    setItems(null);
    const load = scope === "mine" ? cApi.mine() : scope === "assigned" ? cApi.assigned() : cApi.collaborating();
    load.then(setItems).catch((e) => setError(e.message));
  }, [scope]);

  // "+ New" in the app's header (1.0.8+), like Maintenance; older builds get a page button.
  const headerButton = appCan("headerAction");
  useEffect(() => {
    if (!headerButton) return;
    postToApp({ type: "headerAction", label: "New", hash: href({ name: "cnew" }) });
    return () => postToApp({ type: "headerAction", label: null });
  }, [headerButton]);

  if (!scope) return <p className="muted center">Loading…</p>;

  return (
    <div className="stack">
      {!headerButton && (
        <div className="top-actions">
          <a className="new-btn" href={href({ name: "cnew" })} aria-label="New request">
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
            {s.label}{s.key === "todo" && tasks && tasks.length > 0 ? ` (${tasks.length})` : ""}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {scope === "brs" ? (
        !brs ? (!error && <p className="muted center">Loading…</p>)
        : brs.length === 0 ? <p className="muted center">You&apos;re not on any BRS yet. BRSs are started in BRS Studio on the FlowDesk portal.</p>
        : (
          <ul className="list">
            {brs.map((d) => (
              <li key={d.id}>
                <a href={href({ name: "cbrs", id: d.id })} className="row-link">
                  <span className="grow">
                    <strong>{d.title}</strong>
                    <span className="small">{d.reference_no || "BRS"} · {d.brs_type_name}</span>
                    <span className="muted small">{BRS_WHY[d.why]}{d.owner_name ? ` · ${d.owner_name}` : ""} · {formatDate(d.updated_at || d.created_at)}</span>
                  </span>
                  <span className={`pill ${d.phase === "BASELINE" ? "good" : d.phase === "APPROVAL" ? "warn" : "info"}`}>{BRS_PHASES[d.phase] || d.phase}</span>
                </a>
              </li>
            ))}
          </ul>
        )
      ) : scope === "todo" ? (
        !tasks ? <p className="muted center">Loading…</p>
        : tasks.length === 0 ? <p className="muted center">Nothing is waiting on you.</p>
        : (
          <ul className="list">
            {tasks.map((t) => (
              <li key={t.id} className="highlight">
                <a href={href({ name: "creq", id: t.id })} className="row-link">
                  <span className="grow">
                    <strong>{t.request_type_name}</strong>
                    <span className="small">{t.requester_name} · {refOf(t.id)}</span>
                    <span className="muted small">{formatDate(t.created_at)}</span>
                    <span className="next-step small">
                      {t.is_assignee_task && !t.current_step_actionable_by_me
                        ? "Confirm you're ready (assignee)"
                        : `Approve as ${t.current_step_position_name || "approver"}${t.delegated_from_manager_name ? ` for ${t.delegated_from_manager_name}` : ""}`}
                    </span>
                  </span>
                  <CStatus status={t.status} myTurn />
                </a>
              </li>
            ))}
          </ul>
        )
      ) : !items ? (
        !error && <p className="muted center">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted center">
          {scope === "mine" ? "You haven't sent any requests yet." : scope === "assigned" ? "You're not an assignee on any request." : "You don't own or co-write any Change Request."}
        </p>
      ) : (
        <ul className="list">
          {items.map((r) => (
            <li key={r.id}>
              <a href={href({ name: "creq", id: r.id })} className="row-link">
                <span className="grow">
                  <strong>{r.request_type_name}</strong>
                  <span className="small">{r.requester_name ? `${r.requester_name} · ` : ""}{refOf(r.id)}{r.my_role ? ` · ${r.my_role === "OWNER" ? "Owner" : "Co-writer"}` : ""}</span>
                  <span className="muted small">{formatDate(r.submitted_at || r.created_at)}</span>
                  {nextStepText(r) && <span className="muted small">{nextStepText(r)}</span>}
                </span>
                <CStatus status={r.status} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
