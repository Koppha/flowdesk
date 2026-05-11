import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import { query } from "../../lib/db.js";

function startOfCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function parsePrompt(prompt: string) {
  const value = prompt.toLowerCase();
  return {
    rejected: value.includes("rejected"),
    salary: value.includes("salary"),
    thisMonth: value.includes("this month"),
    byDepartment: value.includes("by department"),
    byStatus: value.includes("by status")
  };
}

function extractDate(text: string) {
  const match = text.match(/\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}[\/-]\d{2}[\/-]\d{2})\b/);
  return match?.[1] || null;
}

function extractAmount(text: string) {
  const match = text.match(/\b(?:M|LSL|ZAR)?\s?([0-9]{1,3}(?:[,\s][0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2})?)\b/i);
  if (!match) return null;
  return Number(match[1].replace(/[,\s]/g, ""));
}

function extractReference(text: string) {
  const labelled = text.match(/(?:reference|ref|voucher|txn|transaction)[\s:#-]*([A-Z0-9-]{5,})/i);
  if (labelled) return labelled[1];
  const fallback = text.match(/\b[A-Z0-9]{8,}\b/);
  return fallback?.[0] || null;
}

export const aiRouter = Router();
aiRouter.use(requireAuth);

aiRouter.get("/anomalies", async (_req: AuthedRequest, res, next) => {
  try {
    const duplicateClaims = await query(
      `SELECT u.department, u.full_name AS claimant_name, c.month, c.linked_advance_id, COUNT(*)::int AS duplicate_count
       FROM clearance_claims c
       JOIN users u ON u.id = c.claimant_id
       WHERE c.status <> 'REJECTED'
       GROUP BY u.department, u.full_name, c.month, c.linked_advance_id
       HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC, u.full_name`
    );
    const unusualAdvances = await query(
      `WITH baseline AS (
         SELECT COALESCE(AVG(requested_total), 0) AS avg_amount
         FROM advance_requests
         WHERE status <> 'REJECTED'
       )
       SELECT u.department, u.full_name AS requester_name, ar.type, ar.requested_total
       FROM advance_requests ar
       JOIN users u ON u.id = ar.requester_id
       CROSS JOIN baseline b
       WHERE ar.requested_total >= GREATEST(10000, b.avg_amount * 2)
       ORDER BY ar.requested_total DESC
       LIMIT 20`
    );
    const repeatedRollbacks = await query(
      `SELECT al.entity_id AS advance_id, u.full_name AS requester_name, COUNT(*)::int AS rollback_count
       FROM audit_log al
       LEFT JOIN advance_requests ar ON ar.id = al.entity_id
       LEFT JOIN users u ON u.id = ar.requester_id
       WHERE al.action = 'ADVANCE_ROLLBACK'
       GROUP BY al.entity_id, u.full_name
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC, u.full_name`
    );
    return res.json({ duplicateClaims, unusualAdvances, repeatedRollbacks });
  } catch (err) {
    return next(err);
  }
});

aiRouter.post("/nl-report", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ prompt: z.string().trim().min(3) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid report prompt", parsed.error.flatten());
    const intent = parsePrompt(parsed.data.prompt);

    if (intent.rejected && intent.salary && intent.byDepartment) {
      const params: unknown[] = [];
      let dateFilter = "";
      if (intent.thisMonth) {
        params.push(startOfCurrentMonth());
        dateFilter = ` AND ar.created_at >= $${params.length}`;
      }
      const rows = await query(
        `SELECT COALESCE(u.department, 'Unknown') AS department,
                COUNT(*)::int AS total_requests,
                COALESCE(SUM(ar.requested_total), 0) AS total_amount
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         WHERE ar.status='REJECTED'
           AND ar.type='SALARY'${dateFilter}
         GROUP BY COALESCE(u.department, 'Unknown')
         ORDER BY total_requests DESC, department`,
        params
      );
      return res.json({
        interpretation: "Rejected salary advances grouped by department",
        rows
      });
    }

    const rows = await query(
      `SELECT ar.type,
              ar.status,
              COUNT(*)::int AS total_requests,
              COALESCE(SUM(ar.requested_total), 0) AS total_amount
       FROM advance_requests ar
       GROUP BY ar.type, ar.status
       ORDER BY total_requests DESC, ar.type, ar.status`
    );
    return res.json({
      interpretation: "General advance request summary by type and status",
      rows
    });
  } catch (err) {
    return next(err);
  }
});

aiRouter.post("/ocr-extract", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ text: z.string().trim().min(3) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid OCR extraction payload", parsed.error.flatten());
    const text = parsed.data.text;
    return res.json({
      extracted_date: extractDate(text),
      extracted_amount: extractAmount(text),
      extracted_reference: extractReference(text)
    });
  } catch (err) {
    return next(err);
  }
});
