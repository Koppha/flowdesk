import { Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { query } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { EMAIL_ACTION_PURPOSE, type EmailActionDocType } from "../../lib/emailActionTokens.js";
import { performAdvanceApprove, performAdvanceReject, getAdvanceNotificationContext } from "../advances/advances.routes.js";
import { performClaimApprove, performClaimReject, getClaimNotificationContext } from "../claims/claims.routes.js";
import { performCustomRequestAction } from "../custom-requests/custom-requests.routes.js";

export const emailActionsRouter = Router();

type TokenRow = { id: string; jti: string; user_id: string; doc_type: EmailActionDocType; doc_id: string; step_order: number; used_at: string | null };

async function resolveToken(token: string) {
  let decoded: any;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch {
    throw badRequest("This link is invalid or has expired.");
  }
  if (decoded?.purpose !== EMAIL_ACTION_PURPOSE || !decoded.jti) throw badRequest("This link is invalid.");

  const row = (await query<TokenRow>(`SELECT * FROM email_action_tokens WHERE jti = $1`, [decoded.jti]))[0];
  if (!row) throw badRequest("This link is invalid.");
  if (row.used_at) throw badRequest("This link has already been used.");

  const actor = (await query<{ id: string; full_name: string | null; role: string; department: string | null }>(
    `SELECT id, full_name, role, department FROM users WHERE id = $1 AND is_active = true`,
    [row.user_id]
  ))[0];
  if (!actor) throw badRequest("This approver account is no longer active.");

  return { row, actor };
}

const TERMINAL_STATUSES: Record<EmailActionDocType, string[]> = {
  ADVANCE: ["APPROVED", "PAID", "REJECTED", "CANCELLED"],
  CLAIM: ["SETTLED", "REJECTED"],
  CUSTOM_REQUEST: ["APPROVED", "REJECTED", "CLOSED"]
};

async function getLiveStep(docType: EmailActionDocType, docId: string): Promise<{ stepOrder: number; status: string } | null> {
  if (docType === "ADVANCE") {
    const rows = await query<{ workflow_step_order: number | null; status: string }>(
      `SELECT workflow_step_order, status FROM advance_requests WHERE id = $1`, [docId]
    );
    return rows[0] ? { stepOrder: rows[0].workflow_step_order ?? 0, status: rows[0].status } : null;
  }
  if (docType === "CLAIM") {
    const rows = await query<{ workflow_step_order: number | null; status: string }>(
      `SELECT workflow_step_order, status FROM clearance_claims WHERE id = $1`, [docId]
    );
    return rows[0] ? { stepOrder: rows[0].workflow_step_order ?? 0, status: rows[0].status } : null;
  }
  const rows = await query<{ current_step_order: number; status: string }>(
    `SELECT current_step_order, status FROM custom_request_submissions WHERE id = $1`, [docId]
  );
  return rows[0] ? { stepOrder: rows[0].current_step_order, status: rows[0].status } : null;
}

async function buildSummary(docType: EmailActionDocType, docId: string) {
  if (docType === "ADVANCE") {
    const ctx = await getAdvanceNotificationContext(docId);
    if (!ctx) return null;
    return { docLabel: `${ctx.type} Advance`, requester: ctx.full_name, amount: Number(ctx.requested_total), status: ctx.status };
  }
  if (docType === "CLAIM") {
    const ctx = await getClaimNotificationContext(docId);
    if (!ctx) return null;
    return { docLabel: "Clearance Claim", requester: ctx.full_name, amount: Number(ctx.claim_total), status: ctx.status };
  }
  const rows = await query<{ status: string; request_type_name: string; requester_name: string | null }>(
    `SELECT s.status, rt.name AS request_type_name, u.full_name AS requester_name
       FROM custom_request_submissions s
       JOIN custom_request_types rt ON rt.id = s.request_type_id
       JOIN users u ON u.id = s.requester_id
      WHERE s.id = $1`,
    [docId]
  );
  const row = rows[0];
  if (!row) return null;
  return { docLabel: row.request_type_name, requester: row.requester_name, amount: null, status: row.status };
}

// GET /email-actions/:token — safe, read-only. Powers the confirmation page;
// never mutates anything, so an email link-prefetcher hitting this is harmless.
emailActionsRouter.get("/:token", async (req, res, next) => {
  try {
    const { row, actor } = await resolveToken(req.params.token);
    const live = await getLiveStep(row.doc_type, row.doc_id);
    if (!live) throw notFound("This request no longer exists.");

    const alreadyActioned = live.stepOrder !== row.step_order || TERMINAL_STATUSES[row.doc_type].includes(live.status);
    const summary = await buildSummary(row.doc_type, row.doc_id);

    return res.json({
      docType: row.doc_type,
      approverName: actor.full_name,
      alreadyActioned,
      liveStatus: live.status,
      summary
    });
  } catch (err) {
    return next(err);
  }
});

const ConfirmSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().trim().optional()
});

// POST /email-actions/:token/confirm — the actual mutation, only reached via
// an explicit button click on the confirmation page (never a bare GET).
emailActionsRouter.post("/:token/confirm", async (req, res, next) => {
  try {
    const parsed = ConfirmSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const { row, actor } = await resolveToken(req.params.token);
    const live = await getLiveStep(row.doc_type, row.doc_id);
    if (!live) throw notFound("This request no longer exists.");
    if (live.stepOrder !== row.step_order || TERMINAL_STATUSES[row.doc_type].includes(live.status)) {
      throw badRequest("This step has already been actioned — please check the app for the latest status.");
    }
    if (parsed.data.action === "REJECT" && !parsed.data.comment) {
      throw badRequest("A comment is required to reject.");
    }

    const actorArg = { userId: actor.id, role: actor.role, department: actor.department };
    let result: { status: string };

    if (row.doc_type === "ADVANCE") {
      if (parsed.data.action === "APPROVE") {
        const ctx = await getAdvanceNotificationContext(row.doc_id);
        result = await performAdvanceApprove(row.doc_id, actorArg, Number(ctx?.requested_total ?? 0));
      } else {
        result = await performAdvanceReject(row.doc_id, actorArg, parsed.data.comment!);
      }
    } else if (row.doc_type === "CLAIM") {
      result = parsed.data.action === "APPROVE"
        ? await performClaimApprove(row.doc_id, actorArg)
        : await performClaimReject(row.doc_id, actorArg, parsed.data.comment!);
    } else {
      result = await performCustomRequestAction(
        row.doc_id,
        { userId: actor.id, role: actor.role, fullName: actor.full_name },
        parsed.data.action,
        parsed.data.comment
      );
    }

    await query(`UPDATE email_action_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    return res.json({ ok: true, status: result.status });
  } catch (err) {
    return next(err);
  }
});
