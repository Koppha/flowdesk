import { Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { query } from "../../lib/db.js";
import { badRequest, notFound, HttpError } from "../../lib/errors.js";
import { EMAIL_ACTION_PURPOSE, type EmailActionDocType } from "../../lib/emailActionTokens.js";
import { performAdvanceApprove, performAdvanceReject, getAdvanceNotificationContext } from "../advances/advances.routes.js";
import { performClaimApprove, performClaimReject, getClaimNotificationContext } from "../claims/claims.routes.js";
import { performCustomRequestAction } from "../custom-requests/custom-requests.routes.js";
import { performOvertimeRequestApprove, performOvertimeRequestReject, performOvertimeClaimApprove, performOvertimeClaimReject } from "../overtime/overtime.routes.js";
import { performStandbyClaimApprove, performStandbyClaimReject } from "../standby/standby.routes.js";
import { emailActionLimiter } from "../../middleware/rateLimit.js";

export const emailActionsRouter = Router();
emailActionsRouter.use(emailActionLimiter);

// This router renders a self-contained HTML page with an inline <script>/
// <style> (see renderPage below) instead of loading external assets, so it
// works behind any proxy path prefix. Helmet's default CSP (applied
// app-wide in app.ts) would block that inline script/style, so relax it
// only for this router - the rest of the API only returns JSON, where CSP
// has no effect anyway.
emailActionsRouter.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'"
  );
  next();
});

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

// Self-contained page (no external CSS/JS/images) so it renders correctly
// behind any reverse-proxy path prefix - the confirm button posts to a
// relative URL ("<token>/confirm") resolved against the page's own address,
// so it works regardless of what prefix a proxy puts in front of it.
function renderPage(opts: {
  token: string;
  approverName: string | null;
  alreadyActioned: boolean;
  liveStatus: string;
  summary: { docLabel: string; requester: string | null; amount: number | null; status: string } | null;
}) {
  const { token, approverName, alreadyActioned, liveStatus, summary } = opts;
  const amount = summary?.amount != null ? `M${summary.amount.toFixed(2)}` : "—";
  const body = alreadyActioned
    ? `<p class="status">This request has already been actioned (current status: <strong>${escapeHtml(liveStatus)}</strong>). No further action is needed.</p>`
    : `
      <div id="form">
        <textarea id="comment" placeholder="Comment (required to reject)"></textarea>
        <div class="row">
          <button id="approve" class="btn approve">Approve</button>
          <button id="reject" class="btn reject">Reject</button>
        </div>
      </div>
      <div id="result" class="status" hidden></div>
      <script>
        var token = ${JSON.stringify(token)};
        function submit(action) {
          var comment = document.getElementById("comment").value.trim();
          if (action === "REJECT" && !comment) {
            alert("A comment is required to reject.");
            return;
          }
          document.getElementById("approve").disabled = true;
          document.getElementById("reject").disabled = true;
          fetch(encodeURIComponent(token) + "/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: action, comment: comment || undefined })
          })
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (r) {
              var result = document.getElementById("result");
              document.getElementById("form").hidden = true;
              result.hidden = false;
              result.textContent = r.ok
                ? "Done - new status: " + r.data.status
                : "Error: " + (r.data && r.data.error ? r.data.error : "Something went wrong.");
            })
            .catch(function () {
              document.getElementById("approve").disabled = false;
              document.getElementById("reject").disabled = false;
              alert("Network error - please try again.");
            });
        }
        document.getElementById("approve").addEventListener("click", function () { submit("APPROVE"); });
        document.getElementById("reject").addEventListener("click", function () { submit("REJECT"); });
      </script>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowDesk - Approval</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1f2937}
  h1{font-size:18px}
  .card{border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-top:12px}
  .card div{margin-bottom:6px}
  textarea{width:100%;min-height:70px;margin:12px 0;padding:8px;font-family:inherit;box-sizing:border-box}
  .row{display:flex;gap:8px}
  .btn{flex:1;padding:10px;border:none;border-radius:6px;font-size:15px;cursor:pointer;color:#fff}
  .approve{background:#16a34a}
  .reject{background:#dc2626}
  .status{margin-top:16px;font-weight:600}
</style></head>
<body>
  <h1>Approval request${approverName ? " for " + escapeHtml(approverName) : ""}</h1>
  <div class="card">
    <div><strong>${escapeHtml(summary?.docLabel ?? "Request")}</strong></div>
    <div>Requester: ${escapeHtml(summary?.requester ?? "—")}</div>
    <div>Amount: ${escapeHtml(amount)}</div>
    <div>Status: ${escapeHtml(summary?.status ?? liveStatus)}</div>
  </div>
  ${body}
</body></html>`;
}

function renderErrorPage(message: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>FlowDesk - Approval</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1f2937}</style>
</head><body><h1>Approval request</h1><p>${escapeHtml(message)}</p></body></html>`;
}

type TokenRow = { id: string; jti: string; user_id: string; doc_type: EmailActionDocType; doc_id: string; step_order: number; route_version: number; used_at: string | null };

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

  const actor = (await query<{ id: string; full_name: string | null; role: string; department: string | null; section_id: string | null }>(
    `SELECT id, full_name, role, department, section_id FROM users WHERE id = $1 AND is_active = true`,
    [row.user_id]
  ))[0];
  if (!actor) throw badRequest("This approver account is no longer active.");

  return { row, actor };
}

const TERMINAL_STATUSES: Record<EmailActionDocType, string[]> = {
  ADVANCE: ["APPROVED", "PAID", "REJECTED", "CANCELLED"],
  CLAIM: ["SETTLED", "REJECTED"],
  CUSTOM_REQUEST: ["APPROVED", "REJECTED", "CLOSED"],
  OVERTIME_REQUEST: ["APPROVED", "REJECTED", "WITHDRAWN"],
  // FINANCE_PROCESSING/PAYMENT_PENDING count as terminal for email-approval
  // purposes even though the claim itself isn't done - once it's past the
  // approval chain there's no more approver action for this link to take.
  OVERTIME_CLAIM: ["REJECTED", "WITHDRAWN", "CLOSED", "FINANCE_PROCESSING", "PAYMENT_PENDING"],
  STANDBY_CLAIM: ["REJECTED", "CLOSED", "FINANCE_PROCESSING", "PAYMENT_PENDING"]
};

async function getLiveStep(docType: EmailActionDocType, docId: string): Promise<{ stepOrder: number; routeVersion: number; status: string } | null> {
  if (docType === "ADVANCE") {
    const rows = await query<{ workflow_step_order: number | null; status: string }>(
      `SELECT workflow_step_order, status FROM advance_requests WHERE id = $1`, [docId]
    );
    return rows[0] ? { stepOrder: rows[0].workflow_step_order ?? 0, routeVersion: 0, status: rows[0].status } : null;
  }
  if (docType === "CLAIM") {
    const rows = await query<{ workflow_step_order: number | null; status: string }>(
      `SELECT workflow_step_order, status FROM clearance_claims WHERE id = $1`, [docId]
    );
    return rows[0] ? { stepOrder: rows[0].workflow_step_order ?? 0, routeVersion: 0, status: rows[0].status } : null;
  }
  if (docType === "CUSTOM_REQUEST") {
    const rows = await query<{ current_step_order: number; status: string }>(
      `SELECT current_step_order, status FROM custom_request_submissions WHERE id = $1`, [docId]
    );
    return rows[0] ? { stepOrder: rows[0].current_step_order, routeVersion: 0, status: rows[0].status } : null;
  }
  // OVERTIME_REQUEST/OVERTIME_CLAIM/STANDBY_CLAIM track approval steps in a
  // normalized child table keyed by (parent_id, route_version, step_order) -
  // a send-back bumps route_version and resets step_order, so both fields are
  // needed here (unlike the three chain-based types above, always route 0).
  if (docType === "OVERTIME_REQUEST") {
    const rows = await query<{ current_step_order: number; current_route_version: number; status: string }>(
      `SELECT current_step_order, current_route_version, status FROM overtime_requests WHERE id = $1`, [docId]
    );
    return rows[0] ? { stepOrder: rows[0].current_step_order, routeVersion: rows[0].current_route_version, status: rows[0].status } : null;
  }
  if (docType === "OVERTIME_CLAIM") {
    const rows = await query<{ current_step_order: number; current_route_version: number; status: string }>(
      `SELECT current_step_order, current_route_version, status FROM overtime_claims WHERE id = $1`, [docId]
    );
    return rows[0] ? { stepOrder: rows[0].current_step_order, routeVersion: rows[0].current_route_version, status: rows[0].status } : null;
  }
  const rows = await query<{ current_step_order: number; current_route_version: number; status: string }>(
    `SELECT current_step_order, current_route_version, status FROM standby_claims WHERE id = $1`, [docId]
  );
  return rows[0] ? { stepOrder: rows[0].current_step_order, routeVersion: rows[0].current_route_version, status: rows[0].status } : null;
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
  if (docType === "CUSTOM_REQUEST") {
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
  if (docType === "OVERTIME_REQUEST") {
    const rows = await query<{ status: string; full_name: string | null }>(
      `SELECT r.status, u.full_name FROM overtime_requests r JOIN users u ON u.id = r.employee_id WHERE r.id = $1`, [docId]
    );
    const row = rows[0];
    if (!row) return null;
    return { docLabel: "Overtime Request", requester: row.full_name, amount: null, status: row.status };
  }
  if (docType === "OVERTIME_CLAIM") {
    const rows = await query<{ status: string; total_amount: string | number | null; full_name: string | null }>(
      `SELECT c.status, c.total_amount, u.full_name FROM overtime_claims c JOIN users u ON u.id = c.employee_id WHERE c.id = $1`, [docId]
    );
    const row = rows[0];
    if (!row) return null;
    return { docLabel: "Overtime Claim", requester: row.full_name, amount: row.total_amount != null ? Number(row.total_amount) : null, status: row.status };
  }
  const rows = await query<{ status: string; calculated_amount: string | number | null; full_name: string | null }>(
    `SELECT c.status, c.calculated_amount, u.full_name FROM standby_claims c JOIN users u ON u.id = c.employee_id WHERE c.id = $1`, [docId]
  );
  const row = rows[0];
  if (!row) return null;
  return { docLabel: "Standby Claim", requester: row.full_name, amount: row.calculated_amount != null ? Number(row.calculated_amount) : null, status: row.status };
}

// GET /email-actions/:token — safe, read-only. Powers the confirmation page;
// never mutates anything, so an email link-prefetcher hitting this is harmless.
emailActionsRouter.get("/:token", async (req, res, next) => {
  const wantsHtml = req.accepts(["html", "json"]) === "html";
  try {
    const { row, actor } = await resolveToken(req.params.token);
    const live = await getLiveStep(row.doc_type, row.doc_id);
    if (!live) throw notFound("This request no longer exists.");

    const alreadyActioned = live.stepOrder !== row.step_order || live.routeVersion !== row.route_version || TERMINAL_STATUSES[row.doc_type].includes(live.status);
    const summary = await buildSummary(row.doc_type, row.doc_id);

    if (wantsHtml) {
      return res.type("html").send(
        renderPage({ token: req.params.token, approverName: actor.full_name, alreadyActioned, liveStatus: live.status, summary })
      );
    }
    return res.json({
      docType: row.doc_type,
      approverName: actor.full_name,
      alreadyActioned,
      liveStatus: live.status,
      summary
    });
  } catch (err) {
    if (wantsHtml && err instanceof HttpError) {
      return res.status(err.statusCode).type("html").send(renderErrorPage(err.message));
    }
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
    if (live.stepOrder !== row.step_order || live.routeVersion !== row.route_version || TERMINAL_STATUSES[row.doc_type].includes(live.status)) {
      throw badRequest("This step has already been actioned — please check the app for the latest status.");
    }
    if (parsed.data.action === "REJECT" && !parsed.data.comment) {
      throw badRequest("A comment is required to reject.");
    }

    const actorArg = { userId: actor.id, role: actor.role, sectionId: actor.section_id };
    let result: { status: string };

    if (row.doc_type === "ADVANCE") {
      if (parsed.data.action === "APPROVE") {
        // Preserve any amount adjustment a prior approver already made
        // in-app — falling back to requested_total only if nobody has
        // adjusted approved_total yet — rather than always resetting to the
        // original requested amount and silently discarding that edit.
        const ctx = await getAdvanceNotificationContext(row.doc_id);
        const approvedTotal = Number(ctx?.approved_total || ctx?.requested_total || 0);
        result = await performAdvanceApprove(row.doc_id, actorArg, approvedTotal);
      } else {
        result = await performAdvanceReject(row.doc_id, actorArg, parsed.data.comment!);
      }
    } else if (row.doc_type === "CLAIM") {
      result = parsed.data.action === "APPROVE"
        ? await performClaimApprove(row.doc_id, actorArg)
        : await performClaimReject(row.doc_id, actorArg, parsed.data.comment!);
    } else if (row.doc_type === "CUSTOM_REQUEST") {
      result = await performCustomRequestAction(
        row.doc_id,
        { userId: actor.id, role: actor.role, fullName: actor.full_name },
        parsed.data.action,
        parsed.data.comment
      );
    } else {
      const actorRole = { userId: actor.id, role: actor.role };
      if (row.doc_type === "OVERTIME_REQUEST") {
        result = parsed.data.action === "APPROVE"
          ? await performOvertimeRequestApprove(row.doc_id, actorRole, parsed.data.comment)
          : await performOvertimeRequestReject(row.doc_id, actorRole, parsed.data.comment!);
      } else if (row.doc_type === "OVERTIME_CLAIM") {
        result = parsed.data.action === "APPROVE"
          ? await performOvertimeClaimApprove(row.doc_id, actorRole, parsed.data.comment)
          : await performOvertimeClaimReject(row.doc_id, actorRole, parsed.data.comment!);
      } else {
        result = parsed.data.action === "APPROVE"
          ? await performStandbyClaimApprove(row.doc_id, actorRole, parsed.data.comment)
          : await performStandbyClaimReject(row.doc_id, actorRole, parsed.data.comment!);
      }
    }

    await query(`UPDATE email_action_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    return res.json({ ok: true, status: result.status });
  } catch (err) {
    return next(err);
  }
});
