/**
 * Clearance reminders for travellers: which of a person's paid travel
 * advances still have to be cleared, and by when (paid date + the
 * clearance window in advance_recovery_settings - the same rule as the
 * "Overdue" flag in advances.routes.ts).
 *
 * Used three ways:
 *  - the AI Assistant greets with them (GET /ai/assistant/reminders),
 *  - the assistant knows them while answering (assistant.ts),
 *  - a scheduled push + email reminder (runClearanceReminderCycle) - only
 *    when an admin switches "Clearance Reminders" on (Processes page).
 *
 * An advance counts until a clearance is SUBMITTED for it: a draft
 * clearance still needs finishing. Advances confirmed as never-cleared
 * (not_cleared_confirmed_at) and salary advances/loans never count.
 */
import { query } from "../../lib/db.js";
import { logger, serializeError } from "../../lib/logger.js";
import { getBooleanSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { formatRequestNumber } from "../../lib/pdf/pdfHelpers.js";
import { notifyClearanceReminder } from "../../lib/notifications.js";
import { clearanceDueSql, TODAY_SQL } from "../../lib/clearanceDue.js";

export type ClearanceDue = {
  advance_id: string;
  reference: string;
  type: string;
  amount: number;
  currency: string;
  paid_on: string;
  due_on: string;
  /** Days until the due date (Lesotho time); negative = overdue by that many days. */
  days_left: number;
  overdue: boolean;
  draft_clearance_id: string | null;
};

type DueRow = {
  id: string; created_at: string; type: string; type_name: string | null; amount: string | null; currency: string | null;
  paid_on: string; due_on: string; days_left: number; draft_claim_id: string | null;
  user_id: string; full_name: string | null; email: string | null;
};

const DUE_SQL = `
  SELECT ar.id, ar.created_at, ar.type, tt.name AS type_name,
         COALESCE(NULLIF(ar.approved_total, 0), ar.requested_total) AS amount,
         COALESCE(tt.currency, 'LSL') AS currency,
         to_char((ar.paid_at AT TIME ZONE 'Africa/Maseru')::date, 'YYYY-MM-DD') AS paid_on,
         -- Due: the clearance window after they return (lib/clearanceDue.ts).
         to_char(${clearanceDueSql("ar")}, 'YYYY-MM-DD') AS due_on,
         (${clearanceDueSql("ar")} - ${TODAY_SQL})::int AS days_left,
         (SELECT cc.id FROM clearance_claims cc
           WHERE cc.linked_advance_id = ar.id AND cc.status = 'DRAFT'
           ORDER BY cc.created_at DESC LIMIT 1) AS draft_claim_id,
         u.id AS user_id, u.full_name, u.email
    FROM advance_requests ar
    JOIN users u ON u.id = ar.requester_id AND u.is_active = true
    CROSS JOIN (SELECT clearance_duration_days FROM advance_recovery_settings ORDER BY updated_at DESC LIMIT 1) ars
    LEFT JOIN travel_types tt ON tt.code = ar.type
   WHERE ar.status = 'PAID'
     AND ar.paid_at IS NOT NULL
     AND ar.not_cleared_confirmed_at IS NULL
     AND ar.type NOT IN ('SALARY', 'LOAN')
     AND NOT EXISTS (
       SELECT 1 FROM clearance_claims cc
        WHERE cc.linked_advance_id = ar.id AND cc.status NOT IN ('REJECTED', 'DRAFT')
     )`;

function toDue(r: DueRow): ClearanceDue {
  return {
    advance_id: r.id,
    reference: formatRequestNumber("ADV", r.id, r.created_at),
    type: r.type_name || r.type.replace(/_/g, " "),
    amount: Number(r.amount) || 0,
    currency: r.currency || "LSL",
    paid_on: r.paid_on,
    due_on: r.due_on,
    days_left: Number(r.days_left),
    overdue: Number(r.days_left) < 0,
    draft_clearance_id: r.draft_claim_id
  };
}

/** The signed-in person's advances still to clear, soonest due first. */
export async function clearancesDue(userId: string): Promise<ClearanceDue[]> {
  const rows = await query<DueRow>(`${DUE_SQL} AND ar.requester_id = $1 ORDER BY days_left, ar.paid_at`, [userId]);
  return rows.map(toDue);
}

/** "15 Nov 2026" */
export function longDate(isoDay: string) {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
/** "due today", "due in 3 days", "overdue by 2 days" */
export function dueText(c: ClearanceDue) {
  const n = Math.abs(c.days_left);
  if (c.days_left === 0) return "due today";
  if (c.days_left > 0) return `due in ${n} day${n === 1 ? "" : "s"}`;
  return `overdue by ${n} day${n === 1 ? "" : "s"}`;
}

/** The lines the assistant is given about this person (empty = nothing to clear). */
export function remindersForAssistant(list: ClearanceDue[]) {
  return list.slice(0, 8).map((c) =>
    `- ${c.reference}: ${c.type}, ${c.currency === "LSL" ? "M" : c.currency === "USD" ? "$" : `${c.currency} `}${c.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}, paid ${longDate(c.paid_on)}, clearance ${dueText(c)} (${longDate(c.due_on)})${c.draft_clearance_id ? " - a draft clearance is started but not submitted" : ""}. advance_id ${c.advance_id}`
  ).join("\n");
}

// ── Scheduled push + email ─────────────────────────────────────────────────
// Each reminder is sent once per advance (clearance_reminder_log), claimed
// atomically so both PROD nodes can run the cycle. Every reminder has a
// short window, so switching the feature on never mails people about
// advances that went overdue long ago:
//   due_3      3 or 2 days before the due date
//   due_1      1 day before, or on the day
//   overdue_N  N = 1..3 weeks: on days 1-3, 8-10 and 15-17 after the due date
function reminderKind(daysLeft: number): string | null {
  if (daysLeft === 3 || daysLeft === 2) return "due_3";
  if (daysLeft === 1 || daysLeft === 0) return "due_1";
  if (daysLeft < 0) {
    const over = -daysLeft;
    const week = Math.floor((over - 1) / 7) + 1;
    if (week <= 3 && (over - 1) % 7 < 3) return `overdue_${week}`;
  }
  return null;
}

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS clearance_reminder_log (
      advance_id uuid NOT NULL REFERENCES advance_requests(id) ON DELETE CASCADE,
      kind text NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (advance_id, kind)
    )
  `);
  schemaReady = true;
}

export async function runClearanceReminderCycle(): Promise<{ sent: number }> {
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.clearanceRemindersEnabled, false))) return { sent: 0 };
  // Working hours only (Lesotho time).
  const hour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Africa/Maseru" }));
  if (hour < 8 || hour >= 17) return { sent: 0 };
  await ensureSchema();
  const rows = await query<DueRow>(`${DUE_SQL} ORDER BY ar.paid_at`);
  let sent = 0;
  for (const r of rows) {
    const kind = reminderKind(Number(r.days_left));
    if (!kind) continue;
    const claimed = await query<{ advance_id: string }>(
      `INSERT INTO clearance_reminder_log (advance_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING advance_id`,
      [r.id, kind]
    );
    if (!claimed[0]) continue;
    const c = toDue(r);
    try {
      await notifyClearanceReminder({
        userId: r.user_id,
        email: r.email,
        name: r.full_name,
        advanceId: c.advance_id,
        reference: c.reference,
        type: c.type,
        amount: c.amount,
        currency: c.currency,
        paidOn: longDate(c.paid_on),
        dueOn: longDate(c.due_on),
        when: dueText(c),
        overdue: c.overdue,
        draftClearanceId: c.draft_clearance_id
      });
      sent++;
    } catch (error) {
      logger.warn("clearance_reminder_failed", { advance_id: r.id, kind, error: serializeError(error) });
    }
  }
  return { sent };
}
