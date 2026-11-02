import { useState } from "react";
import { mApi, type Action, type ActionInput, type Detail, type Meta } from "./api";
import { PhotoPicker, stillUploading, uploadedIds, type PickedPhoto } from "./Photos";

type Field = "body" | "photos" | "worker" | "target_date" | "priority" | "status" | "estimate" | "work_done" | "parts_used" | "time_spent_hours" | "cost";

type Spec = {
  label: string;
  tone: "primary" | "secondary" | "danger";
  fields: Field[];
  bodyLabel?: string;
  /** Minimum length the server insists on for body (0 = optional). */
  bodyMin?: number;
  photosMin?: number;
  /** Body or a photo, either will do (provide_info, comment). */
  bodyOrPhoto?: boolean;
};

// One entry per action the server allows (maintenance.routes.ts ActionSchema),
// with the same required fields it checks - so the phone asks for exactly
// what the server will accept. Listed in the order they're offered.
export const ACTIONS: Record<Action, Spec> = {
  approve: { label: "Approve spend", tone: "primary", fields: ["body"], bodyLabel: "Comment (optional)" },
  reject_approval: { label: "Reject spend", tone: "danger", fields: ["body"], bodyLabel: "Why are you rejecting it?", bodyMin: 3 },
  provide_info: { label: "Answer the question", tone: "primary", fields: ["body", "photos"], bodyLabel: "Your answer", bodyOrPhoto: true },
  confirm: { label: "Yes, it's fixed", tone: "primary", fields: [] },
  reopen: { label: "No - reopen it", tone: "danger", fields: ["body", "photos"], bodyLabel: "What's still wrong?", bodyMin: 3 },
  accept: { label: "Accept the job", tone: "primary", fields: ["body"], bodyLabel: "Note (optional)" },
  decline: { label: "Decline", tone: "danger", fields: ["body"], bodyLabel: "Why are you declining?", bodyMin: 3 },
  complete: { label: "Mark work complete", tone: "primary", fields: ["work_done", "parts_used", "time_spent_hours", "cost", "photos"], photosMin: 1 },
  set_status: { label: "Update work status", tone: "secondary", fields: ["status", "body", "photos"], bodyLabel: "Note (optional)" },
  review: { label: "Mark reviewed", tone: "primary", fields: ["priority"] },
  assign: { label: "Assign a worker", tone: "primary", fields: ["worker", "target_date", "priority", "body"], bodyLabel: "Instructions (optional)" },
  verify: { label: "Verify the work", tone: "primary", fields: [] },
  send_back: { label: "Send back to worker", tone: "danger", fields: ["body"], bodyLabel: "What still needs doing?", bodyMin: 3 },
  request_info: { label: "Ask the requester", tone: "secondary", fields: ["body"], bodyLabel: "Your question", bodyMin: 3 },
  request_approval: { label: "Request spend approval", tone: "secondary", fields: ["body", "estimate", "photos"], bodyLabel: "What needs approving (replacement, contractor or spend)?", bodyMin: 3 },
  request_update: { label: "Ask for an update", tone: "secondary", fields: ["body"], bodyLabel: "Message (optional)" },
  comment: { label: "Add a comment", tone: "secondary", fields: ["body", "photos"], bodyLabel: "Comment", bodyOrPhoto: true },
  cancel: { label: "Cancel request", tone: "danger", fields: ["body"], bodyLabel: "Why cancel it?", bodyMin: 3 }
};

const WORK_STATUSES = [
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "WAITING_MATERIALS", label: "Waiting for Materials" },
  { value: "AWAITING_CONTRACTOR", label: "Awaiting Contractor" }
];

const num = (s: string) => (s.trim() === "" ? undefined : Number(s.replace(/,/g, "")));

export default function ActionForm({ action, request, meta, onDone, onCancel }: {
  action: Action;
  request: Detail;
  meta: Meta;
  onDone: () => void;
  onCancel: () => void;
}) {
  const spec = ACTIONS[action];
  const has = (f: Field) => spec.fields.includes(f);
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [workerId, setWorkerId] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [priority, setPriority] = useState(request.priority);
  const [status, setStatus] = useState(WORK_STATUSES.find((s) => s.value !== request.status)?.value || "IN_PROGRESS");
  const [estimate, setEstimate] = useState("");
  const [workDone, setWorkDone] = useState("");
  const [partsUsed, setPartsUsed] = useState("");
  const [hours, setHours] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function problem(): string {
    const ids = uploadedIds(photos);
    if (stillUploading(photos)) return "Wait for the photos to finish uploading.";
    if (photos.some((p) => p.state === "error")) return "A photo didn't upload - retry it or remove it.";
    if (spec.bodyMin && body.trim().length < spec.bodyMin) return spec.bodyLabel || "Write a note.";
    if (spec.bodyOrPhoto && !body.trim() && !ids.length) return "Write something or add a photo.";
    if (has("worker") && !workerId) return "Pick a worker.";
    if (has("work_done") && workDone.trim().length < 3) return "Describe the work done.";
    if (spec.photosMin && ids.length < spec.photosMin) return `Add at least ${spec.photosMin} photo.`;
    for (const [label, v] of [["Estimate", estimate], ["Time spent", hours], ["Cost", cost]] as const) {
      const n = num(v);
      if (n !== undefined && (!Number.isFinite(n) || n < 0)) return `${label} must be a number.`;
    }
    return "";
  }

  async function submit() {
    const p = problem();
    if (p) return setError(p);
    const input: ActionInput = { action, body: body.trim(), photo_ids: uploadedIds(photos) };
    if (has("worker")) input.worker_id = workerId;
    if (has("target_date") && targetDate) input.target_date = targetDate;
    if (has("priority") && priority !== request.priority) input.priority = priority;
    if (has("status")) input.status = status;
    if (has("estimate")) input.estimate = num(estimate);
    if (has("work_done")) input.work_done = workDone.trim();
    if (has("parts_used") && partsUsed.trim()) input.parts_used = partsUsed.trim();
    if (has("time_spent_hours")) input.time_spent_hours = num(hours);
    if (has("cost")) input.cost = num(cost);
    setBusy(true);
    setError("");
    try {
      await mApi.act(request.id, input);
      onDone();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h3>{spec.label}</h3>

      {has("worker") && (
        <label className="field">
          <span>Worker</span>
          <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
            <option value="">Choose a worker…</option>
            {meta.workers.map((w) => (
              <option key={w.id} value={w.id}>{w.name}{w.is_contractor ? ` (contractor${w.contractor_company ? `, ${w.contractor_company}` : ""})` : ""}</option>
            ))}
          </select>
        </label>
      )}
      {has("target_date") && (
        <label className="field">
          <span>Target date (optional - worked out from the priority if left blank)</span>
          <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </label>
      )}
      {has("priority") && (
        <div className="field">
          <span>Priority</span>
          <div className="segmented">
            {meta.priorities.map((p) => (
              <button key={p.value} type="button" className={priority === p.value ? "on" : ""} onClick={() => setPriority(p.value)}>{p.label}</button>
            ))}
          </div>
        </div>
      )}
      {has("status") && (
        <label className="field">
          <span>Work status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {WORK_STATUSES.filter((s) => s.value !== request.status).map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      )}
      {has("work_done") && (
        <label className="field">
          <span>Work done</span>
          <textarea rows={3} value={workDone} onChange={(e) => setWorkDone(e.target.value)} />
        </label>
      )}
      {has("parts_used") && (
        <label className="field">
          <span>Parts used (optional)</span>
          <input value={partsUsed} onChange={(e) => setPartsUsed(e.target.value)} />
        </label>
      )}
      {(has("time_spent_hours") || has("cost")) && (
        <div className="two-col">
          {has("time_spent_hours") && (
            <label className="field">
              <span>Hours (optional)</span>
              <input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
            </label>
          )}
          {has("cost") && (
            <label className="field">
              <span>Cost M (optional)</span>
              <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
            </label>
          )}
        </div>
      )}
      {has("estimate") && (
        <label className="field">
          <span>Estimate M (optional)</span>
          <input inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} />
        </label>
      )}
      {has("body") && (
        <label className="field">
          <span>{spec.bodyLabel}</span>
          <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
      )}
      {has("photos") && (
        <div className="field">
          <span>{spec.photosMin ? "Completion photos" : "Photos (optional)"}</span>
          <PhotoPicker photos={photos} onChange={setPhotos} />
        </div>
      )}
      {spec.fields.length === 0 && <p className="muted small">{action === "confirm" ? "This closes the request." : "The requester is then asked to confirm it's fixed."}</p>}

      {error && <p className="error">{error}</p>}
      <div className="row gap">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Back</button>
        <button type="button" className={spec.tone === "danger" ? "primary danger" : "primary"} onClick={submit} disabled={busy}>
          {busy ? "Saving…" : spec.label}
        </button>
      </div>
    </section>
  );
}
