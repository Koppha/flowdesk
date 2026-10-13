import { query } from "../../lib/db.js";

// One row per (doc_type, doc_id, step_order), tracking the LAST time that
// step was reminded - a step that advances gets a new step_order, so it's
// naturally eligible for its own fresh reminder without any date-based
// bookkeeping. reminded_at is updated (not just inserted once) so the same
// step can be nudged again every threshold-hours window it keeps sitting
// unactioned, rather than getting exactly one reminder ever. Deliberately
// reminder-only: nothing here ever reassigns or mutates the underlying
// request, mirroring vendor_contract_reminder_log's same dedupe-only role.
export async function ensureSlaReminderSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS sla_reminder_log (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_type    text NOT NULL,
      doc_id      uuid NOT NULL,
      step_order  int  NOT NULL,
      reminded_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sla_reminder_log_step ON sla_reminder_log(doc_type, doc_id, step_order)`);
}
