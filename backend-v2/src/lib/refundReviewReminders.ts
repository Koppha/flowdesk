// Reminds HR Operations about refunds waiting for them.
//
// A new-style refund (REFUND_DUE) needs HR Operations' reviewer - the
// clearance's close step, the same person who verifies payback proofs - to
// press "Send to Treasury" before Treasury can pay it. Nothing reminded them,
// and a M31.50 refund waited four weeks (Oct-Nov 2026). Now: once a refund has
// waited 3 days, the reviewer gets an email + push, then every 3 days for the
// first 5, then weekly until it's sent. Working hours only (Lesotho). Each reminder is claimed in
// refund_review_reminder_log first, so PROD1 and PROD2 send it once.
import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";
import { notifyClaimTask } from "./notifications.js";
import type { ChainStep } from "./workflowEngine.js";
import { paybackReviewStep } from "../modules/claims/claims.routes.js";

const FIRST_AFTER_DAYS = 3;
const EVERY_DAYS = 3;
const MAX_REMINDERS = 5;
const TICK_MS = 60 * 60 * 1000;

let started = false;

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS refund_review_reminder_log (
      claim_id uuid NOT NULL REFERENCES clearance_claims(id) ON DELETE CASCADE,
      kind     text NOT NULL,
      sent_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (claim_id, kind)
    )`);
}

type Waiting = {
  id: string; approval_chain: ChainStep[] | null; balance_amount: string; currency: string | null;
  claimant_name: string | null; department: string | null; days_waiting: number;
};

/** Refunds waiting for HR Operations, with how many whole days they've waited. */
export async function refundsWaitingForHr(): Promise<Waiting[]> {
  return query<Waiting>(
    `SELECT c.id, c.approval_chain, c.balance_amount, COALESCE(c.currency, 'LSL') AS currency,
            u.full_name AS claimant_name, nullif(trim(u.department), '') AS department,
            ((now() AT TIME ZONE 'Africa/Maseru')::date - (coalesce(c.closed_at, c.updated_at) AT TIME ZONE 'Africa/Maseru')::date)::int AS days_waiting
       FROM clearance_claims c JOIN users u ON u.id = c.claimant_id
      WHERE c.status = 'REFUND_DUE' AND c.financial_outcome = 'REFUND_DUE' AND c.balance_amount < 0`
  );
}

/** Which reminder is due after this many days (its log key), or null:
 *  every 3 days for the first 5, then weekly until it's sent to Treasury. */
export function reminderKind(daysWaiting: number): string | null {
  if (daysWaiting < FIRST_AFTER_DAYS) return null;
  const n = Math.floor((daysWaiting - FIRST_AFTER_DAYS) / EVERY_DAYS) + 1;
  return n <= MAX_REMINDERS ? `reminder_${n}` : `weekly_${Math.floor(daysWaiting / 7)}`;
}

export async function runRefundReviewReminderCycle(opts: { force?: boolean } = {}) {
  if (!opts.force) {
    const hour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Africa/Maseru" }));
    if (hour < 8 || hour >= 17) return { sent: 0 };
  }
  await ensureSchema();
  let sent = 0;
  for (const r of await refundsWaitingForHr()) {
    const kind = reminderKind(r.days_waiting);
    if (!kind) continue;
    const chain = Array.isArray(r.approval_chain) ? r.approval_chain : [];
    if (!chain.length) continue;
    const step = paybackReviewStep(chain);
    // The assigned reviewer, else everyone on that step.
    const ids = step.assigned_user_id
      ? [step.assigned_user_id]
      : (step.approver_ids || []).filter(Boolean);
    if (!ids.length) continue;
    const claimed = await query(
      `INSERT INTO refund_review_reminder_log (claim_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING claim_id`,
      [r.id, kind]
    );
    if (!claimed.length) continue; // the other server already sent it
    const people = await query<{ id: string; full_name: string | null; email: string | null }>(
      `SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[]) AND is_active`,
      [ids]
    );
    for (const p of people) {
      await notifyClaimTask({
        claimId: r.id,
        status: "REFUND_DUE",
        claimantName: r.claimant_name,
        department: r.department,
        claimTotal: -Number(r.balance_amount), // the refund owed
        currency: r.currency,
        claimType: "Refund",
        nextApprover: { id: p.id, name: p.full_name, email: p.email, title: `HR Operations (send to Treasury - waiting ${r.days_waiting} days)` },
        isReminder: true
      });
      sent++;
    }
  }
  if (sent) logger.info("refund_review_reminders_sent", { sent });
  return { sent };
}

export function startRefundReviewReminders() {
  if (started || process.env.NODE_ENV === "test") return;
  started = true;
  const tick = () => runRefundReviewReminderCycle().catch((err) => logger.warn("refund_review_reminders_failed", { error: serializeError(err) }));
  setInterval(tick, TICK_MS).unref();
  setTimeout(tick, 90_000).unref();
}
