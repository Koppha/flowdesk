import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";
import { notifyApprovedItemChanged } from "./notifications.js";
import { sendPushToUser } from "./push.js";

// RAID BRS R3 / CR R1: a Change Request or BRS can still be edited while it
// is out for approval. Approvers see every change made since it was sent
// (getChangesDuringApproval), and anyone who already approved is told when
// it changes afterwards - at most once every THROTTLE_HOURS per document.

const THROTTLE_HOURS = 2;
type ChainStep = { approver_id: string; status?: string; acted_at?: string | null };

export async function ensureApprovalChangeSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS approval_change_notices (
      doc_type    text NOT NULL,
      doc_id      uuid NOT NULL,
      approver_id uuid NOT NULL,
      notified_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (doc_type, doc_id, approver_id)
    )`);
}

export async function notifyEarlierApprovers(args: {
  docType: "CHANGE_REQUEST" | "BRS";
  docId: string;
  title: string;
  chain: ChainStep[];
  actorId: string | null;
  summary: string;
}) {
  try {
    const approved = args.chain.filter((s) => s.acted_at && ["APPROVED", "NOTED"].includes(String(s.status)) && s.approver_id !== args.actorId);
    if (!approved.length) return;
    const actor = args.actorId ? (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [args.actorId]))[0]?.full_name ?? null : null;
    for (const step of approved) {
      // Claim the notice (throttled) - also stops both PROD servers sending it.
      const claimed = await query(
        `INSERT INTO approval_change_notices (doc_type, doc_id, approver_id) VALUES ($1, $2, $3)
         ON CONFLICT (doc_type, doc_id, approver_id) DO UPDATE SET notified_at = now()
           WHERE approval_change_notices.notified_at < now() - ($4 || ' hours')::interval
         RETURNING notified_at`,
        [args.docType, args.docId, step.approver_id, String(THROTTLE_HOURS)]
      );
      if (!claimed.length) continue;
      const u = (await query<{ email: string; full_name: string | null }>(`SELECT email, full_name FROM users WHERE id = $1 AND is_active`, [step.approver_id]))[0];
      if (!u) continue;
      await notifyApprovedItemChanged({
        docId: args.docId, itemLabel: args.docType === "BRS" ? "BRS" : "Change Request", title: args.title,
        approverEmail: u.email, approverName: u.full_name, changedBy: actor, summary: args.summary
      });
      void sendPushToUser(step.approver_id, {
        title: `${args.docType === "BRS" ? "A BRS" : "A Change Request"} you approved was changed`,
        body: `${args.title}${actor ? ` - by ${actor}` : ""}`
      });
    }
  } catch (err) {
    logger.warn("approval_change_notice_failed", { doc_type: args.docType, doc_id: args.docId, error: serializeError(err) });
  }
}

// What changed on a Change Request (or the BRS behind a BRS approval) since
// it was sent for approval, for the approver's review window.
export async function getChangesDuringApproval(submission: any, viewerId: string) {
  const myStep = (submission.approval_chain || []).find((s: any) => s.approver_id === viewerId && s.acted_at);
  const myActedAt = myStep?.acted_at ? new Date(myStep.acted_at).getTime() : null;
  let rows: any[] = [];
  if (submission.request_type_code === "CHANGE_REQUEST") {
    const sentAt = (await query<{ at: string }>(
      `SELECT max(created_at) AS at FROM cr_revisions WHERE submission_id = $1 AND kind IN ('CREATED', 'SUBMITTED')`, [submission.id]
    ))[0]?.at ?? submission.created_at;
    rows = await query(
      `SELECT r.created_at, r.summary, r.section_title, r.changes, r.actor_id, u.full_name AS actor_name
         FROM cr_revisions r LEFT JOIN users u ON u.id = r.actor_id
        WHERE r.submission_id = $1 AND r.created_at > $2
          AND r.kind IN ('FIELDS_SAVED', 'SECTION_SAVED', 'SECTION_ADDED', 'SECTION_REMOVED', 'ASSIGNEE_ADDED')
        ORDER BY r.created_at`,
      [submission.id, sentAt]
    );
  } else if (submission.request_type_code === "BRS_APPROVAL" && submission.data?.brs_document_id) {
    rows = await query(
      `SELECT r.created_at, r.summary, r.section_title, NULL::jsonb AS changes, r.actor_id, u.full_name AS actor_name
         FROM brs_document_revisions r LEFT JOIN users u ON u.id = r.actor_id
        WHERE r.document_id = $1 AND r.created_at > $2
          AND r.kind IN ('SECTION_SAVED', 'INTAKE_SAVED', 'SECTION_ADDED', 'SECTION_REMOVED')
        ORDER BY r.created_at`,
      [submission.data.brs_document_id, submission.created_at]
    );
  }
  return rows.map((r) => ({
    at: r.created_at, actor_name: r.actor_name, summary: r.summary, section_title: r.section_title, changes: r.changes,
    after_my_approval: myActedAt !== null && new Date(r.created_at).getTime() > myActedAt
  }));
}
