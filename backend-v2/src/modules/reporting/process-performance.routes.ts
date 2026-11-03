import { Router } from "express";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { query } from "../../lib/db.js";
import { logger, serializeError } from "../../lib/logger.js";

// Process Performance (admin, Reports > Process Performance): one view of
// how every FlowDesk process performs - volumes, how long a request takes
// from submission to done, how long each approver takes to act on a step
// that's waiting for them, and what's stuck right now.
//
// Each process stores its approvals differently, so each gets a small
// adapter (below) that turns its rows into the same shape: when it was
// submitted, how it ended, the steps acted on (who, waited since, acted at)
// and who it's waiting on now. A step's wait starts when the previous step
// acted, or at submission for the first step. Nothing here writes.

const HOUR = 3_600_000;
const TZ = "Africa/Maseru";

type Outcome = "DONE" | "REJECTED" | "CANCELLED" | "OPEN";
type Who = { who: string; whoId: string | null };
type StepDone = Who & { startedAt: Date; actedAt: Date; rejected: boolean };
type Item = {
  process: string;
  id: string;
  ref: string;
  title: string;
  requesterId: string | null;
  submittedAt: Date;
  outcome: Outcome;
  finishedAt: Date | null;
  steps: StepDone[];
  waiting: (Who & { since: Date; step: string }) | null;
};

const ts = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

// --- approval_chain (jsonb list) processes ---------------------------------
// Advances and clearances mark a step with approved/approved_at, custom
// requests and Sign a Document with status/acted_at. A step can name a person
// (approver_id/approver_name) or a team (approval_group_name).

function chainWho(s: any): Who {
  const person = s.approver_id && s.approver_name;
  return {
    whoId: person ? String(s.approver_id) : null,
    who: s.approver_name || (s.approval_group_name ? `Team: ${s.approval_group_name}` : null) || s.position_name || "Unassigned"
  };
}
const chainActedAt = (s: any) => ts(s.acted_at || s.approved_at || s.decided_at || s.rejected_at);
const chainLabel = (s: any) => String(s.position_name || s.action_type || s.title || "Approval").replace(/_/g, " ");

function fromChain(chain: unknown, submittedAt: Date, open: boolean) {
  const list = (Array.isArray(chain) ? chain : [])
    .filter((s) => s && typeof s === "object" && String(s.status || "").toUpperCase() !== "SKIPPED")
    .sort((a, b) => Number(a.step_order ?? 0) - Number(b.step_order ?? 0));
  const steps: StepDone[] = [];
  let last = submittedAt;
  let waiting: Item["waiting"] = null;
  for (const s of list) {
    const acted = chainActedAt(s);
    if (acted) {
      if (acted >= last) steps.push({ ...chainWho(s), startedAt: last, actedAt: acted, rejected: String(s.status || "").toUpperCase() === "REJECTED" });
      if (acted > last) last = acted;
    } else if (open && !waiting) {
      waiting = { ...chainWho(s), since: last, step: chainLabel(s) };
    }
  }
  return { steps, waiting, lastActed: steps.length ? last : null };
}

// --- approval-steps-table processes (overtime, standby, call-out) ----------

type StepRow = { parent_id: string; step_order: number; status: string; decided_at: Date | null; approver_user_id: string | null; title: string | null; full_name: string | null };

function fromStepRows(rows: StepRow[], submittedAt: Date, open: boolean) {
  const steps: StepDone[] = [];
  let last = submittedAt;
  let waiting: Item["waiting"] = null;
  for (const r of [...rows].sort((a, b) => a.step_order - b.step_order)) {
    const who: Who = { whoId: r.full_name ? r.approver_user_id : null, who: r.full_name || r.title || "Unassigned" };
    const st = (r.status || "").toUpperCase();
    if (r.decided_at && st !== "PENDING" && st !== "SKIPPED") {
      if (r.decided_at >= last) steps.push({ ...who, startedAt: last, actedAt: r.decided_at, rejected: st.includes("REJECT") });
      if (r.decided_at > last) last = r.decided_at;
    } else if (open && st === "PENDING" && !waiting) {
      waiting = { ...who, since: last, step: r.title || "Approval" };
    }
  }
  return { steps, waiting, lastActed: steps.length ? last : null };
}

/** DRAFT is left out entirely; the rest by name, so new statuses land somewhere sensible. */
function outcomeOf(status: string, doneStatuses: string[]): Outcome | null {
  const s = (status || "").toUpperCase();
  if (s === "DRAFT") return null;
  if (s.includes("REJECT")) return "REJECTED";
  if (s.includes("CANCEL") || s === "DELETED" || s === "WITHDRAWN") return "CANCELLED";
  if (doneStatuses.includes(s)) return "DONE";
  return "OPEN";
}

/** Still in flight: not a draft, not ended. Old finished rows outside the period are never loaded. */
const OPEN_FILTER = (col: string, done: string[]) =>
  `${col}::text NOT IN (${["DRAFT", "REJECTED", "CANCELLED", "DELETED", ...done].map((x) => `'${x}'`).join(",")})`;

// --- adapters ----------------------------------------------------------------

type Adapter = { key: string; label: string; load: (since: Date) => Promise<Item[]> };

const ADAPTERS: Adapter[] = [
  {
    key: "advances",
    label: "Advances",
    async load(since) {
      const rows = await query<any>(
        `SELECT id, sequence_no, type, purpose, requester_id, status::text AS status, submitted_at, paid_at, updated_at, approval_chain
           FROM advance_requests
          WHERE submitted_at IS NOT NULL AND status::text <> 'DRAFT' AND (submitted_at >= $1 OR ${OPEN_FILTER("status", ["PAID", "CLOSED"])})`, [since]);
      return rows.flatMap((r): Item[] => {
        const outcome = outcomeOf(r.status, ["PAID", "CLOSED"]);
        if (!outcome) return [];
        const c = fromChain(r.approval_chain, r.submitted_at, outcome === "OPEN");
        return [{
          process: "advances", id: r.id, ref: r.sequence_no ? `ADV-${r.sequence_no}` : r.id.slice(0, 8),
          title: [String(r.type || "").replace(/_/g, " ").toLowerCase(), r.purpose].filter(Boolean).join(" · "),
          requesterId: r.requester_id, submittedAt: r.submitted_at, outcome,
          finishedAt: outcome === "DONE" ? ts(r.paid_at) ?? c.lastActed ?? r.updated_at : outcome === "OPEN" ? null : r.updated_at,
          steps: c.steps, waiting: c.waiting
        }];
      });
    }
  },
  {
    key: "clearances",
    label: "Clearances",
    async load(since) {
      const rows = await query<any>(
        `SELECT id, month, duty_station, claimant_id, status::text AS status, submitted_at, closed_at, treasury_completed_at, settled_at, updated_at, approval_chain
           FROM clearance_claims
          WHERE submitted_at IS NOT NULL AND status::text <> 'DRAFT' AND (submitted_at >= $1 OR ${OPEN_FILTER("status", ["SETTLED", "CLOSED", "COMPLETED"])})`, [since]);
      return rows.flatMap((r): Item[] => {
        const outcome = outcomeOf(r.status, ["SETTLED", "CLOSED", "COMPLETED"]);
        if (!outcome) return [];
        const c = fromChain(r.approval_chain, r.submitted_at, outcome === "OPEN");
        return [{
          process: "clearances", id: r.id, ref: r.id.slice(0, 8), title: [r.month, r.duty_station].filter(Boolean).join(" · ") || "Clearance",
          requesterId: r.claimant_id, submittedAt: r.submitted_at, outcome,
          finishedAt: outcome === "DONE" ? ts(r.closed_at) ?? ts(r.treasury_completed_at) ?? ts(r.settled_at) ?? r.updated_at : outcome === "OPEN" ? null : r.updated_at,
          steps: c.steps, waiting: c.waiting
        }];
      });
    }
  },
  {
    // Change Request, Computer Request, Attendance Register, BRS Approval and any
    // other request type built in Request Types - one process per type.
    key: "custom",
    label: "Custom requests",
    async load(since) {
      const rows = await query<any>(
        `SELECT s.id, s.requester_id, s.status, s.created_at, s.updated_at, s.closed_at, s.cancelled_at, s.approval_chain, s.data,
                t.code, t.name
           FROM custom_request_submissions s
           JOIN custom_request_types t ON t.id = s.request_type_id
          WHERE s.status <> 'DRAFT' AND (s.created_at >= $1 OR ${OPEN_FILTER("s.status", ["APPROVED", "CLOSED", "COMPLETED", "IMPLEMENTED"])})`, [since]);
      return rows.flatMap((r): Item[] => {
        const outcome = outcomeOf(r.status, ["APPROVED", "CLOSED", "COMPLETED", "IMPLEMENTED"]);
        if (!outcome) return [];
        const c = fromChain(r.approval_chain, r.created_at, outcome === "OPEN");
        // Approved but still open (e.g. a Change Request being implemented).
        const waiting = c.waiting ?? (outcome === "OPEN" ? { who: "Implementation / closure", whoId: null, since: c.lastActed ?? r.created_at, step: "Closure" } : null);
        const d = r.data && typeof r.data === "object" ? r.data : {};
        return [{
          process: `custom:${r.code || r.name}`, id: r.id, ref: r.id.slice(0, 8),
          title: String(d.title || d.subject || d.change_title || d.summary || r.name).slice(0, 120),
          requesterId: r.requester_id, submittedAt: r.created_at, outcome,
          finishedAt: outcome === "DONE" ? ts(r.closed_at) ?? c.lastActed ?? r.updated_at : outcome === "CANCELLED" ? ts(r.cancelled_at) ?? r.updated_at : outcome === "REJECTED" ? c.lastActed ?? r.updated_at : null,
          steps: c.steps, waiting
        }];
      });
    }
  },
  stepTableAdapter("overtime_requests", "Overtime requests", {
    table: "overtime_requests", steps: "overtime_request_approval_steps", fk: "request_id", person: "employee_id",
    ref: "request_no", title: `'Overtime ' || p.month || '/' || p.year`, finish: "NULL::timestamptz", done: ["APPROVED", "CLOSED", "PAID", "PROCESSED", "COMPLETED"]
  }),
  stepTableAdapter("overtime_claims", "Overtime claims", {
    table: "overtime_claims", steps: "overtime_claim_approval_steps", fk: "claim_id", person: "employee_id",
    ref: "claim_no", title: `'Overtime claim ' || p.month || '/' || p.year`, finish: "coalesce(p.closed_at, p.paid_at, p.processed_at, p.finance_processed_at)",
    done: ["APPROVED", "CLOSED", "PAID", "PROCESSED", "COMPLETED", "FINANCE_PROCESSED"]
  }),
  stepTableAdapter("standby_claims", "Standby claims", {
    table: "standby_claims", steps: "standby_approval_steps", fk: "claim_id", person: "employee_id",
    ref: "claim_no", title: `'Standby ' || coalesce(p.claim_month::text, '')`, finish: "coalesce(p.closed_at, p.paid_at, p.processed_at, p.finance_processed_at)",
    done: ["APPROVED", "CLOSED", "PAID", "PROCESSED", "COMPLETED", "FINANCE_PROCESSED"]
  }),
  stepTableAdapter("callout_claims", "Call-out claims", {
    table: "standby_callout_claims", steps: "standby_callout_approval_steps", fk: "claim_id", person: "employee_id",
    ref: "claim_no", title: `'Call-out ' || coalesce(p.call_date::text, '')`, finish: "coalesce(p.closed_at, p.processed_at)",
    done: ["APPROVED", "CLOSED", "PAID", "PROCESSED", "COMPLETED"]
  }),
  {
    // Maintenance runs on its own lifecycle: Admin Office assigns, the worker
    // accepts and does the job, the requester confirms.
    key: "maintenance",
    label: "Maintenance",
    async load(since) {
      const rows = await query<any>(
        `SELECT m.id, m.request_no, m.category, m.site_name, m.requester_id, m.status, m.created_at, m.updated_at,
                m.assigned_at, m.accepted_at, m.completed_at, m.verified_at, m.closed_at, m.cancelled_at, m.worker_id,
                w.full_name AS worker_name, rq.full_name AS requester_name
           FROM maintenance_requests m
           LEFT JOIN users w ON w.id = m.worker_id
           LEFT JOIN users rq ON rq.id = m.requester_id
          WHERE m.created_at >= $1 OR m.status NOT IN ('CLOSED','CANCELLED')`, [since]);
      return rows.map((r): Item => {
        const outcome: Outcome = r.cancelled_at || r.status === "CANCELLED" ? "CANCELLED" : r.status === "CLOSED" ? "DONE" : "OPEN";
        const worker: Who = { who: r.worker_name || "Worker", whoId: r.worker_name ? r.worker_id : null };
        const phases: [Who, string, Date | null][] = [
          [{ who: "Team: Admin Office", whoId: null }, "Assign a worker", ts(r.assigned_at)],
          [worker, "Accept the job", ts(r.accepted_at)],
          [worker, "Do the work", ts(r.completed_at)],
          [{ who: r.requester_name || "Requester", whoId: r.requester_name ? r.requester_id : null }, "Confirm it's fixed", ts(r.verified_at)]
        ];
        const steps: StepDone[] = [];
        let last: Date = r.created_at;
        let waiting: Item["waiting"] = null;
        for (const [who, step, at] of phases) {
          if (at) {
            if (at >= last) steps.push({ ...who, startedAt: last, actedAt: at, rejected: false });
            if (at > last) last = at;
          } else if (outcome === "OPEN" && !waiting) {
            waiting = { ...who, since: last, step };
          }
        }
        return {
          process: "maintenance", id: r.id, ref: r.request_no || r.id.slice(0, 8), title: [r.category, r.site_name].filter(Boolean).join(" · "),
          requesterId: r.requester_id, submittedAt: r.created_at, outcome,
          finishedAt: outcome === "DONE" ? ts(r.completed_at) ?? ts(r.closed_at) : outcome === "CANCELLED" ? ts(r.cancelled_at) ?? r.updated_at : null,
          steps, waiting
        };
      });
    }
  },
  {
    key: "accommodation",
    label: "Accommodation",
    async load(since) {
      const rows = await query<any>(
        `SELECT id, location, provider, requester_id, status, created_at, updated_at, paid_at
           FROM accommodation_requests
          WHERE status <> 'DRAFT' AND (created_at >= $1 OR ${OPEN_FILTER("status", ["PAID", "CLOSED", "COMPLETED"])})`, [since]);
      return rows.flatMap((r): Item[] => {
        const outcome = outcomeOf(r.status, ["PAID", "CLOSED", "COMPLETED"]);
        if (!outcome) return [];
        const finance: Who = { who: "Team: Finance", whoId: null };
        const paid = ts(r.paid_at);
        return [{
          process: "accommodation", id: r.id, ref: r.id.slice(0, 8), title: [r.location, r.provider].filter(Boolean).join(" · ") || "Accommodation",
          requesterId: r.requester_id, submittedAt: r.created_at, outcome,
          finishedAt: outcome === "DONE" ? paid ?? r.updated_at : outcome === "OPEN" ? null : r.updated_at,
          steps: paid && paid >= r.created_at ? [{ ...finance, startedAt: r.created_at, actedAt: paid, rejected: false }] : [],
          waiting: outcome === "OPEN" ? { ...finance, since: r.created_at, step: "Pay the hotel" } : null
        }];
      });
    }
  },
  {
    key: "it_provisioning",
    label: "IT provisioning",
    async load(since) {
      const rows = await query<any>(
        `SELECT t.id, t.status, t.created_at, t.updated_at, t.completed_at, t.handed_over_at, t.assigned_to_id,
                a.full_name AS assignee, s.requester_id
           FROM it_provisioning_tasks t
           LEFT JOIN users a ON a.id = t.assigned_to_id
           LEFT JOIN custom_request_submissions s ON s.id = t.submission_id
          WHERE t.created_at >= $1 OR t.completed_at IS NULL`, [since]);
      return rows.map((r): Item => {
        const s = String(r.status || "").toUpperCase();
        const done = ts(r.completed_at) ?? ts(r.handed_over_at);
        const outcome: Outcome = s.includes("CANCEL") ? "CANCELLED" : done || s === "COMPLETED" ? "DONE" : "OPEN";
        const it: Who = { who: r.assignee || "Team: IT", whoId: r.assignee ? r.assigned_to_id : null };
        return {
          process: "it_provisioning", id: r.id, ref: r.id.slice(0, 8), title: "Device provisioning",
          requesterId: r.requester_id, submittedAt: r.created_at, outcome,
          finishedAt: outcome === "DONE" ? done ?? r.updated_at : outcome === "CANCELLED" ? r.updated_at : null,
          steps: done && done >= r.created_at ? [{ ...it, startedAt: r.created_at, actedAt: done, rejected: false }] : [],
          waiting: outcome === "OPEN" ? { ...it, since: r.created_at, step: "Provision and hand over" } : null
        };
      });
    }
  },
  {
    key: "signatures",
    label: "Sign a Document",
    async load(since) {
      const rows = await query<any>(
        `SELECT id, title, verification_code, created_by_id, status, created_at, closed_at, updated_at, approval_chain
           FROM signable_documents
          WHERE status <> 'DELETED' AND jsonb_array_length(approval_chain) > 0 AND (created_at >= $1 OR status = 'OPEN')`, [since]);
      return rows.map((r): Item => {
        const outcome: Outcome = r.status === "COMPLETED" ? "DONE" : r.status === "REJECTED" ? "REJECTED" : "OPEN";
        const c = fromChain(r.approval_chain, r.created_at, outcome === "OPEN");
        return {
          process: "signatures", id: r.id, ref: r.verification_code, title: r.title, requesterId: r.created_by_id,
          submittedAt: r.created_at, outcome, finishedAt: outcome === "OPEN" ? null : c.lastActed ?? ts(r.closed_at) ?? r.updated_at,
          steps: c.steps, waiting: c.waiting ? { ...c.waiting, step: "Sign" } : null
        };
      });
    }
  }
];

function stepTableAdapter(key: string, label: string, o: { table: string; steps: string; fk: string; person: string; ref: string; title: string; finish: string; done: string[] }): Adapter {
  return {
    key,
    label,
    async load(since) {
      const rows = await query<any>(
        `SELECT p.id, p.${o.ref} AS ref, ${o.title} AS title, p.${o.person} AS requester_id, p.status::text AS status,
                p.submitted_at, p.updated_at, p.current_route_version, ${o.finish} AS finished_at
           FROM ${o.table} p
          WHERE p.submitted_at IS NOT NULL AND p.status::text <> 'DRAFT' AND (p.submitted_at >= $1 OR ${OPEN_FILTER("p.status", o.done)})`, [since]);
      if (!rows.length) return [];
      const stepRows = await query<StepRow & { route_version: number | null }>(
        `SELECT s.${o.fk} AS parent_id, s.step_order, s.status, s.decided_at, s.approver_user_id, s.title, s.route_version, u.full_name
           FROM ${o.steps} s LEFT JOIN users u ON u.id = s.approver_user_id
          WHERE s.${o.fk} = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
      return rows.flatMap((r): Item[] => {
        const outcome = outcomeOf(r.status, o.done);
        if (!outcome) return [];
        // Only the current route - a resubmitted request starts a new one.
        const mine = stepRows.filter((s) => s.parent_id === r.id && (r.current_route_version == null || s.route_version == null || s.route_version === r.current_route_version));
        const c = fromStepRows(mine, r.submitted_at, outcome === "OPEN");
        const waiting = c.waiting ?? (outcome === "OPEN" ? { who: "Team: Finance / processing", whoId: null, since: c.lastActed ?? r.submitted_at, step: "Processing" } : null);
        return [{
          process: key, id: r.id, ref: r.ref || r.id.slice(0, 8), title: r.title || label, requesterId: r.requester_id,
          submittedAt: r.submitted_at, outcome,
          finishedAt: outcome === "DONE" ? ts(r.finished_at) ?? c.lastActed ?? r.updated_at : outcome === "OPEN" ? null : c.lastActed ?? r.updated_at,
          steps: c.steps, waiting
        }];
      });
    }
  };
}

// --- maths ---------------------------------------------------------------------

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / HOUR;
const dayOf = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });

function summarize(items: Item[], since: Date, now: number, slaHours: number) {
  const inPeriod = items.filter((i) => i.submittedAt >= since);
  const count = (o: Outcome) => inPeriod.filter((i) => i.outcome === o).length;
  const closed = inPeriod.filter((i) => i.outcome !== "OPEN").length;
  const turnaround = inPeriod.filter((i) => i.outcome === "DONE" && i.finishedAt).map((i) => hours(i.submittedAt, i.finishedAt!)).filter((h) => h >= 0);
  const stepHours = items.flatMap((i) => i.steps).filter((s) => s.actedAt >= since).map((s) => hours(s.startedAt, s.actedAt));
  const waits = items.filter((i) => i.waiting).map((i) => (now - i.waiting!.since.getTime()) / HOUR);
  return {
    submitted: inPeriod.length,
    done: count("DONE"),
    rejected: count("REJECTED"),
    cancelled: count("CANCELLED"),
    stillOpen: count("OPEN"),
    completionRate: pct(count("DONE"), inPeriod.length),
    rejectionRate: pct(count("REJECTED"), closed),
    turnaroundMedianHours: r1(median(turnaround)),
    turnaroundAvgHours: r1(avg(turnaround)),
    stepMedianHours: r1(median(stepHours)),
    stepAvgHours: r1(avg(stepHours)),
    stepsActed: stepHours.length,
    stepsWithinSla: pct(stepHours.filter((h) => h <= slaHours).length, stepHours.length),
    waitingNow: waits.length,
    overdueNow: waits.filter((h) => h > slaHours).length,
    oldestWaitingHours: r1(waits.length ? Math.max(...waits) : null)
  };
}

export const processPerformanceRouter = Router();
processPerformanceRouter.use(requireAuth, requireRole(["ADMIN"]));

// GET /reporting/process-performance?days=30&slaHours=48&process=advances
processPerformanceRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const slaHours = Math.min(Math.max(Number(req.query.slaHours) || 48, 1), 24 * 30);
    const only = typeof req.query.process === "string" && req.query.process ? req.query.process : null;
    const now = Date.now();
    const since = new Date(now - days * 24 * HOUR);

    // One adapter failing (a table missing on some server) leaves the rest working.
    const failed: string[] = [];
    const loaded = await Promise.all(ADAPTERS.map(async (a) => {
      try {
        return await a.load(since);
      } catch (error) {
        logger.warn("process_performance_adapter_failed", { process: a.key, error: serializeError(error) });
        failed.push(a.label);
        return [] as Item[];
      }
    }));
    const all = loaded.flat();

    // Custom request types become one process each, named after the type.
    const labels = new Map(ADAPTERS.filter((a) => a.key !== "custom").map((a) => [a.key, a.label]));
    if (all.some((i) => i.process.startsWith("custom:"))) {
      const types = await query<{ code: string | null; name: string }>(`SELECT code, name FROM custom_request_types`);
      for (const t of types) labels.set(`custom:${t.code || t.name}`, t.name);
    }
    const labelOf = (k: string) => labels.get(k) || k.replace(/^custom:/, "");

    const byProcess = new Map<string, Item[]>();
    for (const i of all) byProcess.set(i.process, [...(byProcess.get(i.process) || []), i]);
    const processes = [...byProcess.entries()]
      .map(([key, items]) => ({ key, label: labelOf(key), ...summarize(items, since, now, slaHours) }))
      .filter((p) => p.submitted || p.waitingNow || p.stepsActed)
      .sort((a, b) => b.submitted - a.submitted || b.waitingNow - a.waitingNow);

    const items = only ? byProcess.get(only) || [] : all;

    // Submitted and done per day - by week beyond 90 days.
    const byWeek = days > 90;
    const bucketOf = (t: Date) => {
      if (!byWeek) return dayOf(t);
      const d = new Date(dayOf(t) + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    };
    const series = new Map<string, { day: string; submitted: number; done: number }>();
    for (let t = since.getTime(); t <= now; t += 24 * HOUR) {
      const k = bucketOf(new Date(t));
      if (!series.has(k)) series.set(k, { day: k, submitted: 0, done: 0 });
    }
    for (const i of items) {
      if (i.submittedAt >= since) { const row = series.get(bucketOf(i.submittedAt)); if (row) row.submitted++; }
      if (i.outcome === "DONE" && i.finishedAt && i.finishedAt >= since) { const row = series.get(bucketOf(i.finishedAt)); if (row) row.done++; }
    }

    // Per approver (a person, or a team for team steps).
    type A = { key: string; who: string; whoId: string | null; processes: Set<string>; acted: number[]; rejected: number; waiting: number; oldest: number | null };
    const approvers = new Map<string, A>();
    const approver = (w: Who) => {
      const key = w.whoId || `name:${w.who}`;
      let a = approvers.get(key);
      if (!a) approvers.set(key, (a = { key, who: w.who, whoId: w.whoId, processes: new Set(), acted: [], rejected: 0, waiting: 0, oldest: null }));
      return a;
    };
    for (const i of items) {
      for (const s of i.steps) {
        if (s.actedAt < since) continue;
        const a = approver(s);
        a.acted.push(hours(s.startedAt, s.actedAt));
        if (s.rejected) a.rejected++;
        a.processes.add(labelOf(i.process));
      }
      if (i.waiting) {
        const a = approver(i.waiting);
        const h = (now - i.waiting.since.getTime()) / HOUR;
        a.waiting++;
        a.oldest = Math.max(a.oldest ?? 0, h);
        a.processes.add(labelOf(i.process));
      }
    }

    const userIds = [...new Set([...items.map((i) => i.requesterId), ...[...approvers.values()].map((a) => a.whoId)].filter((x): x is string => !!x))];
    const users = userIds.length
      ? await query<{ id: string; full_name: string | null; department: string | null }>(`SELECT id, full_name, department FROM users WHERE id = ANY($1::uuid[])`, [userIds])
      : [];
    const userOf = new Map(users.map((u) => [u.id, u]));

    return res.json({
      days,
      slaHours,
      bucket: byWeek ? "week" : "day",
      process: only,
      failed,
      processes,
      summary: summarize(items, since, now, slaHours),
      series: [...series.values()],
      waiting: items
        .filter((i) => i.waiting)
        .map((i) => {
          const h = (now - i.waiting!.since.getTime()) / HOUR;
          return {
            process: labelOf(i.process), id: i.id, ref: i.ref, title: i.title,
            requester: (i.requesterId && userOf.get(i.requesterId)?.full_name) || null,
            waitingOn: i.waiting!.who, step: i.waiting!.step, submittedAt: i.submittedAt,
            waitingHours: r1(h), overdue: h > slaHours
          };
        })
        .sort((a, b) => (b.waitingHours ?? 0) - (a.waitingHours ?? 0))
        .slice(0, 100),
      approvers: [...approvers.values()]
        .map((a) => ({
          key: a.key,
          who: a.who,
          department: (a.whoId && userOf.get(a.whoId)?.department) || null,
          isTeam: !a.whoId,
          processes: [...a.processes].sort(),
          stepsActed: a.acted.length,
          medianHours: r1(median(a.acted)),
          avgHours: r1(avg(a.acted)),
          withinSla: pct(a.acted.filter((h) => h <= slaHours).length, a.acted.length),
          rejected: a.rejected,
          waiting: a.waiting,
          oldestWaitingHours: r1(a.oldest)
        }))
        .sort((a, b) => b.waiting - a.waiting || (b.oldestWaitingHours ?? 0) - (a.oldestWaitingHours ?? 0) || b.stepsActed - a.stepsActed)
    });
  } catch (err) {
    return next(err);
  }
});
