import { useCallback, useEffect, useState } from "react";
import { mApi, type Action, type Detail } from "./api";
import ActionForm, { ACTIONS } from "./ActionForm";
import { ServerPhoto } from "./Photos";
import { MPriority, MStatus, Row, useMeta } from "./shared";
import { formatDate, formatDateTime } from "../ui";

// One maintenance request: what and where, its photos, what happened so far,
// and the actions this person may take now (the server's `can`).
export default function MaintenanceRequest({ id }: { id: string }) {
  const { meta } = useMeta();
  const [r, setR] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<Action | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setR(await mApi.get(id));
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !r) return <p className="error">{error}</p>;
  if (!r || !meta) return <p className="muted center">Loading…</p>;

  const actions = (Object.keys(ACTIONS) as Action[]).filter((a) => r.can[a]);
  const requestPhotos = r.photos.filter((p) => p.stage === "REQUEST");
  const completionPhotos = r.photos.filter((p) => p.stage === "COMPLETION");

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>{r.request_no}</h1>
        <div className="row gap">
          <MStatus status={r.status} label={r.status_label} />
          <MPriority priority={r.priority} label={r.priority_label} />
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {r.next_step && !acting && <p className="banner">Next for you: <strong>{r.next_step}</strong></p>}

      {acting ? (
        <ActionForm
          action={acting}
          request={r}
          meta={meta}
          onCancel={() => setActing(null)}
          onDone={async () => {
            setNotice(`${ACTIONS[acting].label} - done.`);
            setActing(null);
            await load();
            window.scrollTo(0, 0);
          }}
        />
      ) : (
        actions.length > 0 && (
          <section className="stack-sm">
            <h2>What you can do</h2>
            <div className="action-list">
              {actions.map((a) => (
                <button key={a} type="button" className={ACTIONS[a].tone === "primary" ? "primary" : ACTIONS[a].tone === "danger" ? "secondary danger" : "secondary"}
                  onClick={() => { setNotice(""); setActing(a); }}>
                  {ACTIONS[a].label}
                </button>
              ))}
            </div>
          </section>
        )
      )}

      <section className="card stack-sm">
        <h3>{r.category}</h3>
        <p className="pre">{r.description}</p>
        {requestPhotos.length > 0 && (
          <div className="photo-grid">
            {requestPhotos.map((p) => <ServerPhoto key={p.id} id={p.id} deleted={p.deleted} />)}
          </div>
        )}
      </section>

      <section className="card">
        <Row label="Site" value={`${r.site_name}${r.district ? ` (${r.district})` : ""}`} />
        <Row label="Location" value={r.location} />
        <Row label="Access" value={r.access_times} />
        <Row label="Asset tag" value={r.asset_tag} />
        <Row label="Requested by" value={`${r.requester_name} · ${formatDate(r.created_at)}`} />
        <Row label="Contact" value={<>{r.contact_name} · <a href={`tel:${r.contact_phone}`}>{r.contact_phone}</a></>} />
        <Row label="Admin Office" value={r.admin_office_label} />
        <Row label="Worker" value={r.worker_name ? <>{r.worker_name}{r.worker_phone ? <> · <a href={`tel:${r.worker_phone}`}>{r.worker_phone}</a></> : null}</> : null} />
        <Row label="Target date" value={r.target_date ? formatDate(r.target_date) : null} />
        <Row label="Instructions" value={r.instructions} />
      </section>

      {r.approval_reason && (
        <section className="card">
          <h3>Spend approval</h3>
          <Row label="Reason" value={r.approval_reason} />
          <Row label="Estimate" value={r.approval_estimate ? `M ${Number(r.approval_estimate).toFixed(2)}` : null} />
          <Row label="Outcome" value={r.approval_status ? r.approval_status.charAt(0) + r.approval_status.slice(1).toLowerCase() : null} />
        </section>
      )}

      {r.work_done && (
        <section className="card stack-sm">
          <h3>Work done</h3>
          <p className="pre">{r.work_done}</p>
          <Row label="Parts" value={r.parts_used} />
          <Row label="Time" value={r.time_spent_hours ? `${Number(r.time_spent_hours)} h` : null} />
          <Row label="Cost" value={r.cost ? `M ${Number(r.cost).toFixed(2)}` : null} />
          {completionPhotos.length > 0 && (
            <div className="photo-grid">
              {completionPhotos.map((p) => <ServerPhoto key={p.id} id={p.id} deleted={p.deleted} />)}
            </div>
          )}
        </section>
      )}

      <section className="stack-sm">
        <h2>History</h2>
        <ol className="timeline">
          {r.events.map((e) => (
            <li key={e.id}>
              <span className="small">
                <strong>{e.actor_name || "FlowDesk"}</strong> · {meta.status_labels[e.to_status || ""] || e.kind.replace(/_/g, " ").toLowerCase()}
              </span>
              <span className="muted small">{formatDateTime(e.created_at)}</span>
              {e.body && <span className="small pre">{e.body}</span>}
              {e.photo_ids.length > 0 && (
                <div className="photo-grid small-grid">
                  {e.photo_ids.map((pid) => <ServerPhoto key={pid} id={pid} deleted={r.photos.find((p) => p.id === pid)?.deleted} />)}
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
