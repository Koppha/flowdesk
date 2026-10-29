import { query } from "../../lib/db.js";
import { logger, serializeError } from "../../lib/logger.js";
import { notifyCustomRequestAssigneeReminder, notifySlaReminder } from "../../lib/notifications.js";
import { getBooleanSystemSetting, getNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { ensureSlaReminderSchema } from "./sla.schema.js";
import { assigneeEmails, assigneeLabel, unconfirmedAssignees } from "../custom-requests/change-collab.service.js";

// A reminder-only SLA nudge across the three chain-based approval surfaces
// in FlowDesk (Advances/Claims, Custom Requests - including BRS Approval and
// Change Request, both routed through the Custom Requests engine - and
// Signatures' routing documents) - deliberately never reassigns or mutates
// the underlying request, only emails whoever the CURRENT step's approver
// is once that step has sat past the configured threshold, then again every
// time another full threshold window passes with the step still unactioned
// (see sendRemindersFor's use of sla_reminder_log.reminded_at) - so someone
// who ignores the first email keeps getting nudged rather than falling
// permanently silent after one reminder. See index.ts's own comment on why
// an earlier *reassigning* sweep was turned off - this is the intentionally
// safer alternative: notify a human, don't move work around automatically.

type OverdueStep = {
  docId: string;
  stepOrder: number;
  approverId: string;
  approverEmail: string | null;
  approverName: string | null;
  reference: string;
  hoursPending: number;
};

async function findOverdueAdvances(thresholdHours: number): Promise<OverdueStep[]> {
  const rows = await query<any>(
    `SELECT a.id, a.workflow_step_order, a.approval_chain, a.updated_at, a.purpose,
            u.full_name AS requester_name
       FROM advance_requests a
       LEFT JOIN users u ON u.id = a.requester_id
      WHERE a.status NOT IN ('DRAFT','PAID','CLOSED','REJECTED','CANCELLED')
        AND jsonb_typeof(a.approval_chain) = 'array'
        AND jsonb_array_length(a.approval_chain) > a.workflow_step_order
        AND a.updated_at < now() - ($1 || ' hours')::interval`,
    [thresholdHours]
  );
  return rows.flatMap((r) => {
    const chain = r.approval_chain as any[];
    const step = chain[r.workflow_step_order];
    if (!step?.approver_id) return [];
    return [{
      docId: r.id, stepOrder: r.workflow_step_order, approverId: step.approver_id,
      approverEmail: step.approver_email ?? null, approverName: step.approver_name ?? null,
      reference: `Advance — ${r.requester_name || "Unknown"}${r.purpose ? `: ${r.purpose}` : ""}`,
      hoursPending: (Date.now() - new Date(r.updated_at).getTime()) / 3_600_000
    }];
  });
}

async function findOverdueClaims(thresholdHours: number): Promise<OverdueStep[]> {
  const rows = await query<any>(
    `SELECT c.id, c.workflow_step_order, c.approval_chain, c.updated_at,
            u.full_name AS claimant_name
       FROM clearance_claims c
       LEFT JOIN users u ON u.id = c.claimant_id
      WHERE c.status NOT IN ('DRAFT','SETTLED','CLOSED','REJECTED','CANCELLED','COMPLETED')
        AND jsonb_typeof(c.approval_chain) = 'array'
        AND jsonb_array_length(c.approval_chain) > c.workflow_step_order
        AND c.updated_at < now() - ($1 || ' hours')::interval`,
    [thresholdHours]
  );
  return rows.flatMap((r) => {
    const chain = r.approval_chain as any[];
    const step = chain[r.workflow_step_order];
    if (!step?.approver_id) return [];
    return [{
      docId: r.id, stepOrder: r.workflow_step_order, approverId: step.approver_id,
      approverEmail: step.approver_email ?? null, approverName: step.approver_name ?? null,
      reference: `Clearance — ${r.claimant_name || "Unknown"}`,
      hoursPending: (Date.now() - new Date(r.updated_at).getTime()) / 3_600_000
    }];
  });
}

type AssigneeHold = { row: any; pending: Awaited<ReturnType<typeof unconfirmedAssignees>> };

async function findOverdueCustomRequests(thresholdHours: number): Promise<{ steps: OverdueStep[]; assigneeHolds: AssigneeHold[] }> {
  const rows = await query<any>(
    `SELECT s.id, s.current_step_order, s.approval_chain, s.updated_at, s.created_at, s.data, s.request_type_id,
            rt.name AS request_type_name, u.full_name AS requester_name
       FROM custom_request_submissions s
       JOIN custom_request_types rt ON rt.id = s.request_type_id
       LEFT JOIN users u ON u.id = s.requester_id
      WHERE s.status = 'IN_PROGRESS'
        AND jsonb_typeof(s.approval_chain) = 'array'
        AND jsonb_array_length(s.approval_chain) > s.current_step_order
        AND s.updated_at < now() - ($1 || ' hours')::interval`,
    [thresholdHours]
  );
  const steps: OverdueStep[] = [];
  const assigneeHolds: AssigneeHold[] = [];
  for (const r of rows) {
    const chain = r.approval_chain as any[];
    const step = chain[r.current_step_order];
    if (!step?.approver_id) continue;
    // Assignees still to confirm: the approver can't act yet, so it's the
    // assignees who get reminded (remindPendingAssignees), not the approver.
    const pending = await unconfirmedAssignees(r.request_type_id, r.data);
    if (pending.length) { assigneeHolds.push({ row: r, pending }); continue; }
    steps.push({
      docId: r.id, stepOrder: r.current_step_order, approverId: step.approver_id,
      approverEmail: step.approver_email ?? null, approverName: step.approver_name ?? null,
      reference: `${r.request_type_name || "Custom Request"} — ${r.requester_name || "Unknown"}`,
      hoursPending: (Date.now() - new Date(r.updated_at).getTime()) / 3_600_000
    });
  }
  return { steps, assigneeHolds };
}

// Shares the step's sla_reminder_log row with the approver reminder (and the
// requester's Remind button), claimed atomically so both PROD nodes running
// this sweep don't each send it.
async function remindPendingAssignees(holds: AssigneeHold[], thresholdHours: number) {
  for (const { row: r, pending } of holds) {
    const claimed = await query(
      `INSERT INTO sla_reminder_log (doc_type, doc_id, step_order, reminded_at) VALUES ('CUSTOM_REQUEST',$1,$2,now())
       ON CONFLICT (doc_type, doc_id, step_order) DO UPDATE SET reminded_at = now()
         WHERE sla_reminder_log.reminded_at < now() - ($3 || ' hours')::interval
       RETURNING reminded_at`,
      [r.id, r.current_step_order, String(thresholdHours)]
    );
    if (!claimed.length) continue;
    for (const p of pending) {
      await notifyCustomRequestAssigneeReminder({
        submissionId: r.id,
        requestTypeName: r.request_type_name || "Custom Request",
        requesterName: r.requester_name ?? null,
        fieldLabel: p.field_label,
        assigneeLabel: assigneeLabel(p.entry),
        isGroup: Boolean(p.entry.teamId || p.entry.departmentId || p.entry.divisionName),
        recipientEmails: await assigneeEmails(p.entry),
        hoursPending: (Date.now() - new Date(r.created_at).getTime()) / 3_600_000
      });
    }
  }
}

async function findOverdueSignableDocuments(thresholdHours: number): Promise<OverdueStep[]> {
  const rows = await query<any>(
    `SELECT d.id, d.current_step_order, d.approval_chain, d.updated_at, d.title, d.created_by_id
       FROM signable_documents d
      WHERE d.status = 'OPEN'
        AND jsonb_typeof(d.approval_chain) = 'array'
        AND jsonb_array_length(d.approval_chain) > d.current_step_order
        AND d.updated_at < now() - ($1 || ' hours')::interval`,
    [thresholdHours]
  );
  return rows.flatMap((r) => {
    const chain = r.approval_chain as any[];
    const step = chain[r.current_step_order];
    if (!step?.approver_id) return [];
    // No reminder to sign your own document.
    if (step.approver_id === r.created_by_id) return [];
    return [{
      docId: r.id, stepOrder: r.current_step_order, approverId: step.approver_id,
      approverEmail: null, approverName: step.approver_name ?? null,
      reference: r.title,
      hoursPending: (Date.now() - new Date(r.updated_at).getTime()) / 3_600_000
    }];
  });
}

async function sendRemindersFor(docType: string, itemLabel: string, steps: OverdueStep[], thresholdHours: number) {
  for (const step of steps) {
    const existing = await query<{ reminded_at: string }>(
      `SELECT reminded_at FROM sla_reminder_log WHERE doc_type=$1 AND doc_id=$2 AND step_order=$3`,
      [docType, step.docId, step.stepOrder]
    );
    // Already reminded within the current threshold window - not overdue for
    // ANOTHER reminder yet. Once that window has passed and the step still
    // hasn't moved, it's eligible again - this is what makes the nudge
    // repeat for as long as someone hasn't submitted their review, instead
    // of firing exactly once and then staying silent forever.
    if (existing[0] && new Date(existing[0].reminded_at).getTime() > Date.now() - thresholdHours * 3_600_000) continue;

    let approverEmail = step.approverEmail;
    let approverName = step.approverName;
    if (!approverEmail) {
      const user = (await query<{ email: string; full_name: string | null }>(`SELECT email, full_name FROM users WHERE id = $1`, [step.approverId]))[0];
      approverEmail = user?.email ?? null;
      approverName = approverName ?? user?.full_name ?? null;
    }

    await notifySlaReminder({
      docType, docId: step.docId, itemLabel, reference: step.reference,
      approverEmail, approverName, hoursPending: step.hoursPending
    });
    await query(
      `INSERT INTO sla_reminder_log (doc_type, doc_id, step_order, reminded_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (doc_type, doc_id, step_order) DO UPDATE SET reminded_at = now()`,
      [docType, step.docId, step.stepOrder]
    );
  }
}

export async function runSlaReminderCycle() {
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.slaRemindersEnabled, true))) return;
  await ensureSlaReminderSchema();
  const thresholdHours = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.slaReminderThresholdHours, 48);

  try {
    await sendRemindersFor("ADVANCE", "Advance Request", await findOverdueAdvances(thresholdHours), thresholdHours);
    await sendRemindersFor("CLAIM", "Clearance", await findOverdueClaims(thresholdHours), thresholdHours);
    const customRequests = await findOverdueCustomRequests(thresholdHours);
    await sendRemindersFor("CUSTOM_REQUEST", "Request", customRequests.steps, thresholdHours);
    await remindPendingAssignees(customRequests.assigneeHolds, thresholdHours);
    await sendRemindersFor("SIGNABLE_DOCUMENT", "Signature Request", await findOverdueSignableDocuments(thresholdHours), thresholdHours);
  } catch (err) {
    logger.warn("sla_reminder_cycle_failed", { error: serializeError(err) });
  }
}

export function startSlaReminderWorker() {
  const intervalMinutes = Number(process.env.SLA_REMINDER_INTERVAL_MINUTES || 60);
  runSlaReminderCycle().catch(() => {});
  setInterval(() => { runSlaReminderCycle().catch(() => {}); }, intervalMinutes * 60_000);
}
