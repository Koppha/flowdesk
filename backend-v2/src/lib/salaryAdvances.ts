// Salary advances: the repayment schedule, "paid in full", and the
// one-at-a-time rule. Shared by the Salary Advances report
// (deductions.routes.ts) and advance creation/submission (advances.routes.ts)
// so both agree on when a salary advance is finished.
//
// Schedule: deductions start in the pay cycle AFTER the month it was
// requested (requested in November -> first deduction in December), one
// installment a month for the payback period: amount / months, the last one
// taking the rounding so they add up exactly.
import type { PoolClient } from "pg";
import { query } from "./db.js";
import { badRequest } from "./errors.js";
import { formatRequestNumber } from "./pdf/pdfHelpers.js";

export const maseruMonth = (d: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Maseru", year: "numeric", month: "2-digit" }).formatToParts(d);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
};
export const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};
export const cents = (v: number) => Math.round(v * 100) / 100;

/** Installment plan: first deduction the month after the request, `months` installments. */
export function salaryAdvanceSchedule(amount: number, months: number, requestedAt: Date) {
  const n = Math.max(1, Math.floor(months || 1));
  const installment = cents(amount / n);
  const start = addMonths(maseruMonth(requestedAt), 1);
  return Array.from({ length: n }, (_, i) => ({
    month: addMonths(start, i),
    amount: i === n - 1 ? cents(amount - installment * (n - 1)) : installment
  }));
}

// "Paid in full": Finance records that the employee repaid the rest early
// (or a repayment the employee made covers the whole balance). Installments
// from that month on are no longer deducted. It can't be undone.
//
// Repayments: the employee pays some or all of the balance themselves and
// uploads proof; someone with the "salary_advance_repayments" permission
// accepts (or rejects) it. An accepted repayment lowers the balance; the
// installment stays the same, so the plan ends sooner (from the month it was
// accepted, including that month's deduction).
let columnsReady: Promise<void> | null = null;
export function ensureSalaryAdvanceColumns() {
  columnsReady ??= (async () => {
    await query(`ALTER TABLE advance_requests
      ADD COLUMN IF NOT EXISTS salary_paid_in_full_at timestamptz,
      ADD COLUMN IF NOT EXISTS salary_paid_in_full_by_id uuid REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS salary_paid_in_full_reference text,
      ADD COLUMN IF NOT EXISTS salary_paid_in_full_note text`);
    await query(`CREATE TABLE IF NOT EXISTS salary_advance_repayments (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      advance_id     uuid NOT NULL REFERENCES advance_requests(id) ON DELETE CASCADE,
      employee_id    uuid NOT NULL REFERENCES users(id),
      amount         numeric(12,2) NOT NULL CHECK (amount > 0),
      payment_date   date NOT NULL,
      reference      text NOT NULL,
      note           text,
      file_path      text NOT NULL,
      original_name  text,
      status         text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACCEPTED','REJECTED')),
      reviewed_by_id uuid REFERENCES users(id),
      reviewed_at    timestamptz,
      reject_reason  text,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS salary_advance_repayments_advance_idx ON salary_advance_repayments (advance_id)`);
  })().catch((err) => { columnsReady = null; throw err; });
  return columnsReady;
}

export type AcceptedRepayment = { amount: number; accepted_at: string | Date };
export type PlanMonth = { month: string; amount: number; planned: number; cancelled: boolean };

/** The repayment plan as it stands: the schedule after accepted repayments
 *  (re-spread over the months left) and any "paid in full". */
export function salaryAdvancePlan(args: {
  amount: number; months: number; requestedAt: Date;
  repayments?: AcceptedRepayment[]; paidInFullAt?: string | Date | null; paid: boolean; now?: Date;
}) {
  const base = salaryAdvanceSchedule(args.amount, args.months, args.requestedAt);
  const thisMonth = maseruMonth(args.now ?? new Date());
  const settledMonth = args.paidInFullAt ? maseruMonth(new Date(args.paidInFullAt)) : null;
  const reps = (args.repayments || [])
    .map((r) => ({ amount: Number(r.amount) || 0, month: maseruMonth(new Date(r.accepted_at)) }))
    .sort((a, b) => a.month.localeCompare(b.month));
  let balance = args.amount;
  let next = 0; // repayments applied so far
  let clearedByRepayment = false;
  const applyUpTo = (month: string | null) => {
    while (next < reps.length && (month === null || reps[next].month <= month)) {
      balance = cents(balance - reps[next++].amount);
      if (balance <= 0.004) clearedByRepayment = true;
    }
  };
  // The installment never changes: a partial repayment shortens the plan -
  // the same amount is deducted each month until the balance runs out (the
  // last one may be smaller), and the months after that drop off.
  const installment = base[0].amount;
  const schedule: PlanMonth[] = base.map((b) => {
    // Repayments accepted up to this month come off before its installment.
    applyUpTo(b.month);
    if ((settledMonth && b.month >= settledMonth) || balance <= 0.004) return { month: b.month, amount: 0, planned: b.amount, cancelled: true };
    const take = Math.min(installment, balance);
    balance = cents(balance - take);
    return { month: b.month, amount: cents(take), planned: b.amount, cancelled: false };
  });
  applyUpTo(null); // any accepted after the last month
  const repaid = cents(reps.reduce((t, r) => t + r.amount, 0));
  // Installments whose pay cycle has passed count as deducted (by schedule).
  const deducted = args.paid ? cents(schedule.filter((s) => !s.cancelled && s.month < thisMonth).reduce((t, s) => t + s.amount, 0)) : 0;
  const live = schedule.filter((s) => !s.cancelled);
  // Paid in full: marked so by Finance, or a repayment cleared the balance.
  const paidInFull = args.paid && (Boolean(settledMonth) || clearedByRepayment);
  const outstanding = args.paid ? (paidInFull ? 0 : Math.max(0, cents(args.amount - deducted - repaid))) : null;
  const lastLive = live.length ? live[live.length - 1].month : null;
  return {
    schedule,
    repaid,
    deducted,
    outstanding,
    paidInFull,
    lastDeduction: lastLive,
    // Finished: nothing left to deduct this month or later.
    finished: args.paid && (paidInFull || !lastLive || lastLive < thisMonth),
    thisMonth
  };
}

type Row = {
  id: string; created_at: string; submitted_at: string | null; status: string;
  requested_total: string; approved_total: string; payback_months: number | null; salary_paid_in_full_at: string | null;
};

/** The amount the plan is based on: approved, else requested. */
export const salaryAdvanceAmount = (r: { approved_total: unknown; requested_total: unknown }) =>
  Number(r.approved_total) > 0 ? Number(r.approved_total) : Number(r.requested_total) || 0;

/** The requester's salary advance that's still running, if any: in approval
 *  (submitted, not yet paid), or paid and not yet fully repaid by the schedule
 *  (and not marked paid in full). */
export async function runningSalaryAdvance(requesterId: string, client?: PoolClient, excludeId?: string) {
  await ensureSalaryAdvanceColumns();
  const sql = `SELECT id, created_at, submitted_at, status::text AS status, requested_total, approved_total, payback_months, salary_paid_in_full_at
                 FROM advance_requests
                WHERE requester_id = $1 AND type = 'SALARY'
                  AND status NOT IN ('DRAFT', 'REJECTED', 'CANCELLED')
                  AND salary_paid_in_full_at IS NULL
                  AND ($2::uuid IS NULL OR id <> $2::uuid)
                ORDER BY created_at DESC`;
  const rows = client ? (await client.query<Row>(sql, [requesterId, excludeId ?? null])).rows : await query<Row>(sql, [requesterId, excludeId ?? null]);
  const accepted = await acceptedRepayments(rows.map((r) => r.id));
  for (const r of rows) {
    const plan = salaryAdvancePlan({
      amount: salaryAdvanceAmount(r), months: Number(r.payback_months) || 1, requestedAt: new Date(r.submitted_at || r.created_at),
      repayments: accepted.get(r.id), paidInFullAt: r.salary_paid_in_full_at, paid: r.status === "PAID"
    });
    if (r.status !== "PAID" || !plan.finished) {
      return { ...r, reference: formatRequestNumber("ADV", r.id, r.created_at), amount: salaryAdvanceAmount(r), last_deduction: plan.lastDeduction ?? plan.schedule[plan.schedule.length - 1].month, paid: r.status === "PAID" };
    }
  }
  return null;
}

/** Accepted repayments per advance (for salaryAdvancePlan). */
export async function acceptedRepayments(advanceIds: string[]) {
  const out = new Map<string, AcceptedRepayment[]>();
  if (!advanceIds.length) return out;
  await ensureSalaryAdvanceColumns();
  const rows = await query<{ advance_id: string; amount: string; reviewed_at: string }>(
    `SELECT advance_id, amount, reviewed_at FROM salary_advance_repayments WHERE status = 'ACCEPTED' AND advance_id = ANY($1::uuid[])`,
    [advanceIds]
  );
  for (const r of rows) {
    const list = out.get(r.advance_id) ?? [];
    list.push({ amount: Number(r.amount), accepted_at: r.reviewed_at });
    out.set(r.advance_id, list);
  }
  return out;
}

const monthName = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
};

/** One salary advance at a time, until it's repaid (or marked paid in full). */
export async function assertNoRunningSalaryAdvance(requesterId: string, client?: PoolClient, excludeId?: string) {
  const running = await runningSalaryAdvance(requesterId, client, excludeId);
  if (!running) return;
  const amount = `M${running.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  throw badRequest(running.paid
    ? `You already have a salary advance being repaid (${running.reference}, ${amount}, last deduction ${monthName(running.last_deduction)}). You can apply for another once it's fully repaid.`
    : `You already have a salary advance in progress (${running.reference}, ${amount}). You can apply for another once it's fully repaid.`);
}
