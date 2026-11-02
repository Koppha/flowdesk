import { useEffect, useMemo, useState } from "react";
import { mApi, type Meta, type Scope, type StatusFilter, type Summary } from "./api";
import { MPriority, MStatus, useMeta } from "./shared";
import { href } from "../router";
import { formatDate } from "../ui";

const SCOPE_KEY = "flowdesk.maintenance.scope";

function scopesFor(meta: Meta): { key: Scope; label: string }[] {
  return [
    ...(meta.is_admin_office ? [{ key: "office" as Scope, label: "Admin Office" }] : []),
    ...(meta.is_worker ? [{ key: "jobs" as Scope, label: "My jobs" }] : []),
    { key: "mine", label: "My requests" },
    ...(meta.my_site_ids.length ? [{ key: "site" as Scope, label: "My site" }] : []),
    { key: "approvals", label: "Approvals" }
  ];
}

export default function MaintenanceList() {
  const { meta, error: metaError } = useMeta();
  const [scope, setScope] = useState<Scope | null>(null);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [items, setItems] = useState<Summary[] | null>(null);
  const [error, setError] = useState("");

  const scopes = useMemo(() => (meta ? scopesFor(meta) : []), [meta]);

  // Start where this person works most: the Admin Office's queue, a worker's
  // jobs, otherwise their own requests - or wherever they were last.
  useEffect(() => {
    if (!meta || scope) return;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(SCOPE_KEY);
    } catch {
      // ignore
    }
    setScope((scopes.find((s) => s.key === saved)?.key as Scope) || scopes[0].key);
  }, [meta, scope, scopes]);

  useEffect(() => {
    if (!scope) return;
    try {
      sessionStorage.setItem(SCOPE_KEY, scope);
    } catch {
      // ignore
    }
    setItems(null);
    setError("");
    mApi.list(scope, status).then(setItems).catch((e) => setError(e.message));
  }, [scope, status]);

  if (metaError) return <p className="error">{metaError}</p>;
  if (!meta || !scope) return <p className="muted center">Loading…</p>;

  const canCreate = meta.enabled && meta.has_route;

  return (
    <div className="stack">
      <div className="row space">
        <h1>Maintenance</h1>
        {canCreate && <a className="pill-btn" href={href({ name: "mnew" })}>+ New request</a>}
      </div>
      {!meta.enabled && <p className="muted small">New maintenance requests are switched off right now. Requests already open can still be finished.</p>}
      {meta.enabled && !meta.has_route && <p className="muted small">There's no maintenance route for your division yet, so you can't log a request. Ask an administrator to set one up.</p>}

      <div className="chips" role="tablist">
        {scopes.map((s) => (
          <button key={s.key} type="button" role="tab" aria-selected={scope === s.key} className={scope === s.key ? "on" : ""} onClick={() => setScope(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="segmented">
        {(["open", "closed", "all"] as StatusFilter[]).map((s) => (
          <button key={s} type="button" className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
            {s === "open" ? "Open" : s === "closed" ? "Closed" : "All"}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted center">Loading…</p>}
      {items && items.length === 0 && <p className="muted center">Nothing here.</p>}
      {items && items.length > 0 && (
        <ul className="list">
          {items.map((r) => (
            <li key={r.id} className={r.next_step ? "highlight" : undefined}>
              <a href={href({ name: "mreq", id: r.id })} className="row-link">
                <span className="grow">
                  <span className="row gap-sm">
                    <strong>{r.request_no}</strong>
                    {r.priority === "EMERGENCY" || r.priority === "HIGH" ? <MPriority priority={r.priority} label={r.priority_label} /> : null}
                  </span>
                  <span className="small">{r.site_name} · {r.location}</span>
                  <span className="muted small">{r.category} · {formatDate(r.created_at)}{r.worker_name ? ` · ${r.worker_name}` : ""}</span>
                  {r.next_step && <span className="next-step small">{r.next_step}</span>}
                </span>
                <MStatus status={r.status} label={r.status_label} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
