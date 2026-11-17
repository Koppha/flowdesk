import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { type AuthedRequest, hasFeatureAccess, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";
import { ensureLocalFile, persistentDiskStorage } from "../../lib/fileStore.js";
import { fileExtensionFilter, sanitizeUploadFilename } from "../../lib/uploads.js";
import { sendPushToUser } from "../../lib/push.js";
import { logger, serializeError } from "../../lib/logger.js";
import { formatRequestNumber } from "../../lib/pdf/pdfHelpers.js";
import {
  acceptedRepayments, cents, ensureSalaryAdvanceColumns, salaryAdvanceAmount, salaryAdvancePlan
} from "../../lib/salaryAdvances.js";

// Salary advance repayments: the employee pays some or all of the balance
// themselves and uploads proof; someone with the "salary_advance_repayments"
// permission (Roles & Permissions) accepts or rejects it. Accepting lowers
// the balance - the installment stays, the plan ends sooner
// (lib/salaryAdvances.ts salaryAdvancePlan: same installment, ends sooner); a repayment that clears the
// balance marks the advance paid in full.
export const salaryAdvancesRouter = Router();
salaryAdvancesRouter.use(requireAuth);

export const REPAYMENT_REVIEW_FEATURE = "salary_advance_repayments";
const REPAYMENT_REVIEW_DEFAULTS = ["ADMIN", "Section: Treasury & Financial Accounting", "Team: Treasury & Financial Accounting"];
const canReview = (req: AuthedRequest) => hasFeatureAccess(req.user!.userId, req.user!.role, REPAYMENT_REVIEW_FEATURE, REPAYMENT_REVIEW_DEFAULTS);

const uploadDir = path.join(process.env.UPLOAD_DIR || "uploads", "salary-repayments");
const upload = multer({
  storage: persistentDiskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(uploadDir, { recursive: true }); cb(null, uploadDir); },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeUploadFilename(file.originalname)}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["pdf", "jpg", "jpeg", "png"])
});

type AdvanceRow = {
  id: string; requester_id: string; created_at: string; submitted_at: string | null; status: string;
  requested_total: string; approved_total: string; payback_months: number | null;
  salary_paid_in_full_at: string | null; salary_month: string | null; paid_at: string | null;
};

async function loadAdvance(id: string) {
  const sql = `SELECT id, requester_id, created_at, submitted_at, status::text AS status, requested_total, approved_total, payback_months,
                      salary_paid_in_full_at, salary_month, paid_at
                 FROM advance_requests WHERE id = $1 AND type = 'SALARY'`;
  return (await query<AdvanceRow>(sql, [id]))[0] ?? null;
}

/** Plan + amounts for one advance (accepted repayments included). */
async function planFor(a: AdvanceRow) {
  const accepted = await acceptedRepayments([a.id]);
  const amount = salaryAdvanceAmount(a);
  const plan = salaryAdvancePlan({
    amount, months: Number(a.payback_months) || 1, requestedAt: new Date(a.submitted_at || a.created_at),
    repayments: accepted.get(a.id), paidInFullAt: a.salary_paid_in_full_at, paid: a.status === "PAID"
  });
  const pending = Number((await query<{ s: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS s FROM salary_advance_repayments WHERE advance_id = $1 AND status = 'SUBMITTED'`, [a.id]
  ))[0]?.s || 0);
  return { amount, plan, pending, available: Math.max(0, cents((plan.outstanding ?? 0) - pending)) };
}

const repaymentSelect = `
  SELECT r.id, r.advance_id, r.amount, r.payment_date, r.reference, r.note, r.original_name, r.status,
         r.reject_reason, r.created_at, r.reviewed_at, rv.full_name AS reviewed_by,
         u.full_name AS employee_name, u.employee_no, dv.name AS division_name, ar.created_at AS advance_created_at
    FROM salary_advance_repayments r
    JOIN users u ON u.id = r.employee_id
    LEFT JOIN divisions dv ON dv.id = u.division_id
    LEFT JOIN users rv ON rv.id = r.reviewed_by_id
    JOIN advance_requests ar ON ar.id = r.advance_id`;
const shapeRepayment = (r: any) => ({
  id: r.id, advance_id: r.advance_id, advance_reference: formatRequestNumber("ADV", r.advance_id, r.advance_created_at),
  amount: Number(r.amount), payment_date: r.payment_date, reference: r.reference, note: r.note, file_name: r.original_name,
  status: r.status, reject_reason: r.reject_reason, submitted_at: r.created_at, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by,
  employee_name: r.employee_name, employee_no: r.employee_no, division_name: r.division_name
});

// ── Employee ──────────────────────────────────────────────────────────────

// My salary advances, with the plan as it stands and my repayments.
salaryAdvancesRouter.get("/mine", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSalaryAdvanceColumns();
    const advances = await query<AdvanceRow>(
      `SELECT id, requester_id, created_at, submitted_at, status::text AS status, requested_total, approved_total, payback_months,
              salary_paid_in_full_at, salary_month, paid_at
         FROM advance_requests WHERE requester_id = $1 AND type = 'SALARY' AND status <> 'DRAFT'
        ORDER BY coalesce(submitted_at, created_at) DESC`,
      [req.user!.userId]
    );
    const reps = await query<any>(`${repaymentSelect} WHERE r.employee_id = $1 ORDER BY r.created_at DESC`, [req.user!.userId]);
    const items = [];
    for (const a of advances) {
      const { amount, plan, pending, available } = await planFor(a);
      items.push({
        id: a.id, reference: formatRequestNumber("ADV", a.id, a.created_at), status: a.status, amount,
        payback_months: Number(a.payback_months) || 1, paid_at: a.paid_at,
        schedule: plan.schedule, repaid: plan.repaid, deducted_to_date: plan.deducted, outstanding: plan.outstanding,
        pending_repayments: pending, can_repay_up_to: a.status === "PAID" && !plan.paidInFull ? available : 0,
        paid_in_full: plan.paidInFull, this_month: plan.thisMonth,
        repayments: reps.filter((r) => r.advance_id === a.id).map(shapeRepayment)
      });
    }
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

const RepaymentSchema = z.object({
  amount: z.coerce.number().positive("Enter the amount you paid"),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date you paid"),
  reference: z.string().trim().min(1, "Enter the payment reference").max(120),
  note: z.string().trim().max(500).optional()
});

// I paid some or all of my balance: record it with the proof, for review.
salaryAdvancesRouter.post("/:id/repayments", upload.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    await ensureSalaryAdvanceColumns();
    if (!req.file) throw badRequest("Upload your proof of payment (PDF or photo)");
    const parsed = RepaymentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid repayment", parsed.error.flatten());
    const a = await loadAdvance(req.params.id);
    if (!a) throw notFound("Salary advance not found");
    if (a.requester_id !== req.user!.userId) throw forbidden("You can only repay your own salary advance");
    if (a.status !== "PAID") throw badRequest("You can repay a salary advance once it has been paid to you");
    if (new Date(`${parsed.data.payment_date}T00:00:00+02:00`).getTime() > Date.now()) throw badRequest("The payment date can't be in the future");
    const { plan, available } = await planFor(a);
    if (plan.paidInFull || (plan.outstanding ?? 0) <= 0) throw badRequest("This salary advance is already fully repaid");
    const amount = cents(parsed.data.amount);
    if (amount > available + 0.004) {
      throw badRequest(`You can repay at most M${available.toFixed(2)} - that's what's still owed${available < (plan.outstanding ?? 0) ? " after the repayments waiting for review" : ""}.`);
    }
    const row = (await query<{ id: string }>(
      `INSERT INTO salary_advance_repayments (advance_id, employee_id, amount, payment_date, reference, note, file_path, original_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [a.id, a.requester_id, amount, parsed.data.payment_date, parsed.data.reference, parsed.data.note ?? null, req.file.path, req.file.originalname]
    ))[0];
    await query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1, 'SALARY_REPAYMENT_SUBMITTED', 'advance_requests', $2, NULL, $3)`,
      [req.user!.userId, a.id, JSON.stringify({ repayment_id: row.id, amount, reference: parsed.data.reference })]
    );
    return res.status(201).json({ ok: true, id: row.id });
  } catch (err) {
    return next(err);
  }
});

// The proof file - for the employee who uploaded it and for reviewers.
salaryAdvancesRouter.get("/repayments/:rid/file", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSalaryAdvanceColumns();
    const r = (await query<any>(`SELECT * FROM salary_advance_repayments WHERE id = $1`, [req.params.rid]))[0];
    if (!r) throw notFound();
    if (r.employee_id !== req.user!.userId && !(await canReview(req))) throw forbidden();
    const local = await ensureLocalFile(r.file_path);
    if (!local) throw notFound("The proof file is missing");
    const ext = path.extname(r.file_path).toLowerCase();
    const types: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
    res.setHeader("Content-Type", types[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(r.original_name || path.basename(r.file_path))}"`);
    return res.sendFile(path.resolve(local));
  } catch (err) {
    return next(err);
  }
});

// ── Reviewers ─────────────────────────────────────────────────────────────

salaryAdvancesRouter.get("/repayments", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSalaryAdvanceColumns();
    if (!(await canReview(req))) throw forbidden("You do not have access to salary advance repayments");
    const status = typeof req.query.status === "string" && ["SUBMITTED", "ACCEPTED", "REJECTED"].includes(req.query.status) ? req.query.status : null;
    const rows = await query<any>(`${repaymentSelect} ${status ? "WHERE r.status = $1" : ""} ORDER BY r.created_at DESC`, status ? [status] : []);
    return res.json({ items: rows.map(shapeRepayment), can_review: true });
  } catch (err) {
    return next(err);
  }
});

async function notifyEmployee(employeeId: string, title: string, body: string) {
  try {
    await sendPushToUser(employeeId, { title, body, data: { url: "/my-advances" } });
  } catch (err) {
    logger.warn("salary_repayment_push_failed", { error: serializeError(err) });
  }
}

// Accept: the balance drops and the remaining installments are re-spread;
// clearing the balance marks the advance paid in full.
salaryAdvancesRouter.post("/repayments/:rid/accept", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSalaryAdvanceColumns();
    if (!(await canReview(req))) throw forbidden("Only people with the Salary Advance Repayments permission can accept repayments");
    const result = await withTransaction(async (client) => {
      const r = (await client.query<any>(`SELECT * FROM salary_advance_repayments WHERE id = $1 FOR UPDATE`, [req.params.rid])).rows[0];
      if (!r) throw notFound("Repayment not found");
      if (r.status !== "SUBMITTED") throw badRequest(`This repayment was already ${String(r.status).toLowerCase()}`);
      await client.query(`SELECT id FROM advance_requests WHERE id = $1 FOR UPDATE`, [r.advance_id]);
      const a = await loadAdvance(r.advance_id);
      if (!a || a.status !== "PAID") throw badRequest("This salary advance isn't in a state that can take repayments");
      const { plan } = await planFor(a);
      if (plan.paidInFull) throw badRequest("This salary advance is already paid in full");
      if (Number(r.amount) > (plan.outstanding ?? 0) + 0.004) {
        throw badRequest(`This repayment (M${Number(r.amount).toFixed(2)}) is more than what's still owed (M${(plan.outstanding ?? 0).toFixed(2)}) - reject it and ask for the correct amount.`);
      }
      await client.query(
        `UPDATE salary_advance_repayments SET status = 'ACCEPTED', reviewed_by_id = $2, reviewed_at = now() WHERE id = $1`,
        [r.id, req.user!.userId]
      );
      // Cleared? Then it's paid in full (no more deductions; can't be undone).
      const clears = cents((plan.outstanding ?? 0) - Number(r.amount)) <= 0.004;
      if (clears) {
        await client.query(
          `UPDATE advance_requests SET salary_paid_in_full_at = now(), salary_paid_in_full_by_id = $2,
                  salary_paid_in_full_reference = $3, salary_paid_in_full_note = $4, updated_at = now()
            WHERE id = $1 AND salary_paid_in_full_at IS NULL`,
          [a.id, req.user!.userId, r.reference, "Repaid by the employee (accepted repayment)"]
        );
      }
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1, 'SALARY_REPAYMENT_ACCEPTED', 'advance_requests', $2, $3, $4)`,
        [req.user!.userId, a.id, JSON.stringify({ outstanding: plan.outstanding }), JSON.stringify({ repayment_id: r.id, amount: Number(r.amount), paid_in_full: clears })]
      );
      return { employeeId: r.employee_id, amount: Number(r.amount), clears, outstanding: cents((plan.outstanding ?? 0) - Number(r.amount)) };
    });
    void notifyEmployee(result.employeeId, "Salary advance repayment accepted",
      result.clears ? `M${result.amount.toFixed(2)} accepted - your salary advance is paid in full.` : `M${result.amount.toFixed(2)} accepted - M${result.outstanding.toFixed(2)} left; your deductions stay the same and now end sooner.`);
    return res.json({ ok: true, paid_in_full: result.clears });
  } catch (err) {
    return next(err);
  }
});

const RejectSchema = z.object({ reason: z.string().trim().min(3, "Say why it's rejected").max(500) });
salaryAdvancesRouter.post("/repayments/:rid/reject", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSalaryAdvanceColumns();
    if (!(await canReview(req))) throw forbidden("Only people with the Salary Advance Repayments permission can reject repayments");
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("A reason is required", parsed.error.flatten());
    const r = (await query<any>(`SELECT * FROM salary_advance_repayments WHERE id = $1`, [req.params.rid]))[0];
    if (!r) throw notFound("Repayment not found");
    if (r.status !== "SUBMITTED") throw badRequest(`This repayment was already ${String(r.status).toLowerCase()}`);
    await query(
      `UPDATE salary_advance_repayments SET status = 'REJECTED', reviewed_by_id = $2, reviewed_at = now(), reject_reason = $3 WHERE id = $1 AND status = 'SUBMITTED'`,
      [r.id, req.user!.userId, parsed.data.reason]
    );
    await query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1, 'SALARY_REPAYMENT_REJECTED', 'advance_requests', $2, NULL, $3)`,
      [req.user!.userId, r.advance_id, JSON.stringify({ repayment_id: r.id, amount: Number(r.amount), reason: parsed.data.reason })]
    );
    void notifyEmployee(r.employee_id, "Salary advance repayment not accepted", `M${Number(r.amount).toFixed(2)}: ${parsed.data.reason}`);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
