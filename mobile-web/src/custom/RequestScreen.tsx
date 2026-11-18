import { useCallback, useEffect, useState } from "react";
import { cApi, attachmentPathFor, pdfPathFor, type Detail, type Task } from "./api";
import { CStatus, FieldList, Route, refOf } from "./shared";
import { currentUser, send } from "../api";
import { appCan, inApp, postToApp } from "../bridge";
import { formatDate } from "../ui";

// The app (1.0.10+, capability "customFiles") downloads a request's PDF or an
// attachment with the session and opens the share sheet; in a browser it's a
// plain download.
const canDownload = () => !inApp || appCan("customFiles");

async function download(path: string, name: string) {
  if (inApp) {
    postToApp({ type: "sharePdf", path, title: name });
    return;
  }
  const res = await send(path);
  if (!res.ok) throw new Error("Couldn't download it.");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type Mode = null | "approve" | "assignee" | "cancel";

// One custom request: what was asked, the approval route, and what I can do
// with it now - approve/reject (and roll back a Change Request), confirm as
// an assignee, or remind/cancel/confirm collection as the requester.
export default function CustomRequest({ id }: { id: string }) {
  const me = currentUser();
  const [r, setR] = useState<Detail | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<Mode>(null);
  const [comment, setComment] = useState("");
  const [stepValues, setStepValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, tasks] = await Promise.all([cApi.get(id), cApi.tasks().catch(() => [] as Task[])]);
      setR(detail);
      setTask(tasks.find((t) => t.id === id) || null);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Open straight on the decision when it's my turn.
  useEffect(() => {
    if (!task || mode) return;
    setMode(task.current_step_actionable_by_me ? "approve" : task.is_assignee_task ? "assignee" : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  if (error && !r) return <p className="error">{error}</p>;
  if (!r) return <p className="muted center">Loading…</p>;

  const isChangeRequest = r.request_type_code === "CHANGE_REQUEST";
  const canApprove = Boolean(task?.current_step_actionable_by_me) && r.status === "IN_PROGRESS";
  const isAssigneeTask = Boolean(task?.is_assignee_task) && !canApprove;
  const isRequester = r.requester_id === me?.userId;
  const step = r.approval_chain?.[r.current_step_order];
  const isNote = step?.decision_type === "NOTE";
  // Fields this step's approver writes (e.g. Justification by Supervisor);
  // requests sent before that change already carry the requester's text.
  const stepFields = r.fields.filter((f) => f.filled_at_step !== null && f.filled_at_step !== undefined && f.filled_at_step === r.current_step_order);
  const stepValue = (key: string) => stepValues[key] ?? String(r.data?.[key] ?? "");
  const provisioning = r.it_provisioning;
  const canCollect = isRequester && provisioning && ["READY_FOR_COLLECTION", "HANDED_OVER"].includes(provisioning.status) && !provisioning.collection_acknowledged_at;

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setNotice(done);
      setMode(null);
      setComment("");
      await load();
      window.scrollTo(0, 0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function decide(action: "APPROVE" | "REJECT" | "ROLLBACK") {
    if (action === "APPROVE") {
      const missing = stepFields.find((f) => f.is_required && !stepValue(f.field_key).trim());
      if (missing) return setError(`Write the "${missing.field_label}" first.`);
    } else if (!comment.trim()) {
      return setError(action === "REJECT" ? "Say why you're rejecting it." : "Say what needs correcting.");
    }
    const field_values = action === "APPROVE" && stepFields.length
      ? Object.fromEntries(stepFields.map((f) => [f.field_key, stepValue(f.field_key).trim()]))
      : undefined;
    void run(
      () => cApi.act(id, { action, comment: comment.trim() || undefined, field_values }),
      action === "APPROVE" ? (isNote ? "Noted." : "Approved.") : action === "REJECT" ? "Rejected." : "Rolled back to its owners for correction."
    );
  }

  function assigneeDecide(decision: "REJECT" | "ROLLBACK") {
    if (!comment.trim()) return setError(decision === "REJECT" ? "Say why you're rejecting it." : "Say what needs correcting.");
    void run(() => cApi.assigneeDecision(id, decision, comment.trim()), decision === "REJECT" ? "Rejected." : "Rolled back to its owners for correction.");
  }

  const groups = (task?.assignee_labels || []).filter((l) => l !== "You");

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>{r.request_type_name}</h1>
        <div className="row gap">
          <span className="muted small">{refOf(r.id)}</span>
          <CStatus status={r.status} myTurn={canApprove || isAssigneeTask} />
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {/* ── My move ─────────────────────────────────────────────── */}
      {mode === "approve" && canApprove && (
        <section className="card stack">
          <h3>Your decision{step ? ` · ${step.position_name}` : ""}</h3>
          {task?.delegated_from_manager_name && <p className="muted small">You're acting for {task.delegated_from_manager_name}.</p>}
          {stepFields.map((f) => (
            <label key={f.field_key} className="field">
              <span>{f.field_label}{f.is_required ? " *" : ""}</span>
              <textarea rows={5} value={stepValue(f.field_key)} placeholder={f.placeholder || ""}
                onChange={(e) => setStepValues((v) => ({ ...v, [f.field_key]: e.target.value }))} />
              <span className="muted small">You write this as {step?.position_name || "the approver"}. It's needed to approve, not to reject.</span>
            </label>
          ))}
          <label className="field">
            <span>Comment{isChangeRequest ? " (needed to reject or roll back)" : " (needed to reject)"}</span>
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div className="action-list">
            <button type="button" className="primary" disabled={busy} onClick={() => decide("APPROVE")}>{busy ? "Working…" : isNote ? "Acknowledge (note)" : "Approve"}</button>
            {isChangeRequest && <button type="button" className="secondary" disabled={busy} onClick={() => decide("ROLLBACK")}>Roll back for correction</button>}
            <button type="button" className="secondary danger" disabled={busy} onClick={() => decide("REJECT")}>Reject</button>
          </div>
          {isChangeRequest && <p className="muted small">Reject is a dead stop. Roll back sends it to its owners as a draft; when they resubmit, it starts again from step 1.</p>}
        </section>
      )}

      {mode === "assignee" && isAssigneeTask && (
        <section className="card stack">
          <h3>You're an assignee</h3>
          <p className="small">
            {groups.length
              ? <>Assigned to <strong>{groups.join(", ")}</strong>. Any one member confirms for the whole group.</>
              : <>It's your turn before the approvers.</>}
            {" "}It goes to the first approver once every assignee has confirmed.
          </p>
          {isChangeRequest && (
            <label className="field">
              <span>Comment (needed to reject or roll back)</span>
              <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
          )}
          <div className="action-list">
            {!!task?.assignee_field_keys?.length && (
              <button type="button" className="primary" disabled={busy}
                onClick={() => void run(async () => { for (const k of task!.assignee_field_keys || []) await cApi.confirmAssignee(id, k); }, "Confirmed - thank you.")}>
                {busy ? "Working…" : groups.length ? `Confirm for ${groups.join(", ")}` : "Confirm I'm ready"}
              </button>
            )}
            {isChangeRequest && (
              <>
                <button type="button" className="secondary" disabled={busy} onClick={() => assigneeDecide("ROLLBACK")}>Roll back for correction</button>
                <button type="button" className="secondary danger" disabled={busy} onClick={() => assigneeDecide("REJECT")}>Reject</button>
              </>
            )}
          </div>
          {isChangeRequest && <p className="muted small">To fill in the implementation plan first, use the FlowDesk portal: Custom Processes › Assigned to Me.</p>}
        </section>
      )}

      {mode === "cancel" && (
        <section className="card stack">
          <h3>Cancel this request?</h3>
          <p className="small">It's withdrawn for good and can't be reopened.</p>
          <label className="field">
            <span>Why are you cancelling it?</span>
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div className="action-list">
            <button type="button" className="secondary danger" disabled={busy}
              onClick={() => (comment.trim() ? void run(() => cApi.cancel(id, comment.trim()), "Cancelled.") : setError("Say why you're cancelling it."))}>
              {busy ? "Working…" : "Cancel request"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { setMode(null); setComment(""); setError(""); }}>Keep it</button>
          </div>
        </section>
      )}

      {!mode && (canApprove || isAssigneeTask || (isRequester && r.status === "IN_PROGRESS") || canCollect) && (
        <section className="stack-sm">
          <h2>What you can do</h2>
          <div className="action-list">
            {canApprove && <button type="button" className="primary" onClick={() => setMode("approve")}>Decide</button>}
            {isAssigneeTask && <button type="button" className="primary" onClick={() => setMode("assignee")}>Confirm as assignee</button>}
            {canCollect && (
              <button type="button" className="primary" disabled={busy} onClick={() => void run(() => cApi.acknowledgeCollection(id), "Thanks - collection confirmed.")}>
                I've collected my computer
              </button>
            )}
            {isRequester && r.status === "IN_PROGRESS" && (
              <>
                <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => cApi.remind(id), `Reminder sent to ${step?.approver_name || "the approver"}.`)}>
                  Remind {step?.approver_name || "the approver"}
                </button>
                <button type="button" className="secondary danger" onClick={() => { setNotice(""); setMode("cancel"); }}>Cancel request</button>
              </>
            )}
          </div>
        </section>
      )}

      {/* ── The request ─────────────────────────────────────────── */}
      <section className="card">
        <div className="kv">
          <span className="muted small">Requested by</span>
          <span className="kv-value">{r.requester_name || r.requester_email} · {formatDate(r.submitted_at || r.created_at)}</span>
        </div>
        {r.status === "IN_PROGRESS" && step && (
          <div className="kv">
            <span className="muted small">With</span>
            <span className="kv-value">{step.position_name}{step.approver_name ? ` · ${step.approver_name}` : ""}</span>
          </div>
        )}
        {r.cancel_comment && (
          <div className="kv">
            <span className="muted small">Cancelled because</span>
            <span className="kv-value pre">{r.cancel_comment}</span>
          </div>
        )}
      </section>

      {provisioning && (
        <section className="card">
          <h3>IT provisioning</h3>
          <div className="kv"><span className="muted small">Status</span><span className="kv-value">{provisioning.status.replace(/_/g, " ").toLowerCase()}</span></div>
          {provisioning.assigned_to_name && <div className="kv"><span className="muted small">IT officer</span><span className="kv-value">{provisioning.assigned_to_name}</span></div>}
          {provisioning.asset_number && <div className="kv"><span className="muted small">Asset number</span><span className="kv-value">{provisioning.asset_number}</span></div>}
        </section>
      )}

      <section className="card">
        <h3>Details</h3>
        <FieldList fields={r.fields} data={r.data} />
      </section>

      {(r.attachments.length > 0 || r.can_view_pdf) && (
        <section className="card stack-sm">
          <h3>Documents</h3>
          {r.attachments.map((a) => (
            <div key={a.id} className="row gap-sm">
              <span className="grow small">{a.original_name}</span>
              {canDownload() && (
                <button type="button" className="link-btn" onClick={() => download(attachmentPathFor(id, a.id), a.original_name).catch((e) => setError(e.message))}>
                  {inApp ? "Open" : "Download"}
                </button>
              )}
            </div>
          ))}
          {r.can_view_pdf && canDownload() && (
            <button type="button" className="secondary" onClick={() => download(pdfPathFor(id), `${r.request_type_name} ${refOf(r.id)}.pdf`).catch((e) => setError(e.message))}>
              {inApp ? "Download / share PDF" : "Download PDF"}
            </button>
          )}
          {!canDownload() && <p className="muted small">Update the FlowDesk app to open documents here.</p>}
        </section>
      )}

      {r.approval_chain?.length > 0 && (
        <section className="stack-sm">
          <h2>Approval route</h2>
          <Route chain={r.approval_chain} current={r.current_step_order} status={r.status} />
        </section>
      )}
    </div>
  );
}
