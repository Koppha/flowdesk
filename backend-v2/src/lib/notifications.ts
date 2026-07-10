import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";
import { buildOnboardingMessage } from "./onboardingTemplates.js";
import { createEmailActionToken, buildEmailActionUrl } from "./emailActionTokens.js";

type Role = "MANAGER" | "HOD" | "HR_MANAGER" | "EXCO" | "FINANCE" | "CEO";

// ─── Transport: Microsoft Teams Incoming Webhook ─────────────────────────────

type TeamsFact = { name: string; value: string };

interface TeamsCard {
  title: string;
  summary: string;
  subtitle?: string;
  facts: TeamsFact[];
  /** Hex color without # — default blue */
  color?: string;
}

async function sendTeamsCard(card: TeamsCard): Promise<void> {
  if (!env.TEAMS_ENABLED || !env.TEAMS_WEBHOOK_URL) return;
  // Power Automate HTTP trigger — send plain JSON; the flow parses and posts to Teams
  const payload = {
    title:     card.title,
    message:   card.subtitle || card.summary,
    summary:   card.summary,
    color:     card.color || "1d4ed8",
    facts:     card.facts,
    actionUrl: env.CORS_ORIGIN || "http://10.3.10.59:5174",
    timestamp: new Date().toISOString()
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Power Automate trigger responded with HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Transport: HTTP Email API ────────────────────────────────────────────────

function textToHtml(text: string): string {
  const loginUrl = env.CORS_ORIGIN || "http://10.3.10.59:5174";
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines = text.split("\n");
  // First line is "FlowDesk", second is the title — strip them; the HTML wrapper handles branding
  const titleLine = lines[1] || "";
  const body = lines.slice(2).join("\n").trim();

  // Build rows of the detail table from lines containing " : "
  const contentLines = body.split("\n");
  const htmlLines: string[] = [];
  let inDetails = false;
  let detailRows: string[] = [];

  function flushDetails() {
    if (!detailRows.length) return;
    htmlLines.push(
      `<table style="border-collapse:collapse;width:100%;margin:16px 0">` +
      detailRows.join("") +
      `</table>`
    );
    detailRows = [];
    inDetails = false;
  }

  for (const line of contentLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inDetails) flushDetails();
      htmlLines.push(`<div style="height:12px"></div>`);
      continue;
    }
    // Detect detail rows: "Key    : Value"
    const detailMatch = trimmed.match(/^([^:]+?)\s*:\s+(.*)$/);
    if (detailMatch && !trimmed.startsWith("Login:") && !trimmed.startsWith("EmailAction:") && !trimmed.startsWith("This is")) {
      inDetails = true;
      const key = esc(detailMatch[1].trim());
      const val = esc(detailMatch[2].trim()) || "—";
      detailRows.push(
        `<tr>` +
        `<td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;font-size:13px;width:1%">${key}</td>` +
        `<td style="padding:6px 0;font-weight:600;font-size:13px">${val}</td>` +
        `</tr>`
      );
      continue;
    }
    if (inDetails) flushDetails();

    // Login link → button
    if (trimmed.startsWith("Login:")) {
      htmlLines.push(
        `<div style="margin:20px 0">` +
        `<a href="${loginUrl}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:600;display:inline-block">` +
        `Log in to FlowDesk` +
        `</a></div>`
      );
      continue;
    }

    // Email-approve/reject link → button
    if (trimmed.startsWith("EmailAction:")) {
      const actionUrl = trimmed.slice("EmailAction:".length).trim();
      htmlLines.push(
        `<div style="margin:8px 0 20px">` +
        `<a href="${esc(actionUrl)}" style="background:#16a34a;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:600;display:inline-block">` +
        `Approve or Reject by Email` +
        `</a></div>`
      );
      continue;
    }
    if (trimmed.startsWith("This is an automated")) continue; // moved to footer
    if (trimmed.startsWith("Hello ")) {
      htmlLines.push(`<p style="margin:0 0 12px;font-size:15px">${esc(trimmed)}</p>`);
      continue;
    }
    htmlLines.push(`<p style="margin:0 0 10px">${esc(trimmed)}</p>`);
  }
  if (inDetails) flushDetails();

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <div style="background:#1d4ed8;padding:18px 28px;display:flex;align-items:center;gap:10px">
      <span style="color:#fff;font-size:20px;font-weight:700;letter-spacing:.5px">FlowDesk</span>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 20px;font-size:16px;font-weight:700;color:#111;text-transform:uppercase;letter-spacing:.5px">${esc(titleLine)}</h2>
      ${htmlLines.join("\n      ")}
    </div>
    <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 28px;font-size:12px;color:#6b7280">
      This is an automated notification from FlowDesk. Please do not reply to this email.
    </div>
  </div>
</body>
</html>`;
}

async function sendViaEmailApi(recipient: string, subject: string, body: string): Promise<void> {
  const baseUrl = env.EMAIL_API_BASE_URL.replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.EMAIL_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/sent_email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Body: textToHtml(body), Subject: subject, Recipient: recipient, Attachment: "", Importance: "High", Priority: "High" }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Email API responded with HTTP ${response.status}`);
    const text = (await response.text()).trim().toLowerCase().replace(/^"(.*)"$/, "$1");
    if (text && text !== "true" && text !== "ok") throw new Error(`Email API returned unexpected response: ${text}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Transport: SMTP fallback ─────────────────────────────────────────────────

let smtpTransporter: nodemailer.Transporter | null = null;

function getSmtpTransporter() {
  if (!env.SMTP_ENABLED || !env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) return null;
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
    });
  }
  return smtpTransporter;
}

async function sendViaSmtp(to: string[], subject: string, text: string): Promise<void> {
  const mailer = getSmtpTransporter();
  if (!mailer || to.length === 0) return;
  await mailer.sendMail({
    from: env.SMTP_FROM,
    to: to.join(", "),
    subject,
    text,
    headers: {
      "Importance": "High",
      "X-Priority": "1",
      "X-MS-Exchange-Organization-SCL": "-1"
    }
  });
}

// ─── Unified send ─────────────────────────────────────────────────────────────

async function sendMail(args: { to: string[]; subject: string; text: string }): Promise<void> {
  if (args.to.length === 0) return;
  if (env.EMAIL_API_ENABLED) {
    for (const recipient of args.to) {
      await sendViaEmailApi(recipient, args.subject, args.text);
    }
    return;
  }
  if (env.SMTP_ENABLED) {
    await sendViaSmtp(args.to, args.subject, args.text);
  }
}

// ─── Recipient helpers ────────────────────────────────────────────────────────

async function getRecipients(role: Role, department?: string | null) {
  const rows = await query<{ email: string; full_name: string | null }>(
    `SELECT email, full_name
       FROM users
      WHERE role = $1
        AND is_active = true
        AND ($2::text IS NULL OR trim(coalesce(department, '')) = trim($2))
      ORDER BY full_name NULLS LAST, email`,
    [role, department?.trim() || null]
  );
  return rows.filter((r) => r.email);
}

// Finance approval authority comes from org structure (Department: Finance)
// rather than a dedicated FINANCE role.
async function getFinanceRecipients() {
  const rows = await query<{ email: string; full_name: string | null }>(
    `SELECT email, full_name
       FROM users
      WHERE is_active = true
        AND trim(lower(coalesce(department, ''))) = 'finance'
      ORDER BY full_name NULLS LAST, email`,
    []
  );
  return rows.filter((r) => r.email);
}

async function getAssignedDepartmentOwnerRecipients(
  department: string | null,
  ownerColumn: "manager_user_id" | "exco_user_id"
) {
  if (!department?.trim()) return [];
  const rows = await query<{ email: string; full_name: string | null }>(
    `SELECT owner.email, owner.full_name
       FROM departments d
       JOIN users owner ON owner.id = d.${ownerColumn}
      WHERE lower(trim(d.name)) = lower(trim($1))
        AND owner.is_active = true
      LIMIT 1`,
    [department]
  );
  return rows.filter((r) => r.email);
}

// ─── Email template helpers ───────────────────────────────────────────────────

function header(title: string) {
  // Line 0: "FlowDesk" (brand — stripped by textToHtml and placed in the header bar)
  // Line 1: title     (placed as the <h2> in the HTML version)
  return [`FlowDesk`, title].join("\n");
}

function footer() {
  const url = env.CORS_ORIGIN || "http://10.3.10.59:5174";
  // textToHtml converts "Login: <url>" into a blue button
  return `Login: ${url}\nThis is an automated notification. Please do not reply.`;
}

function detailBlock(rows: [string, string | null | undefined][]) {
  const pad = Math.max(...rows.map(([k]) => k.length));
  // "Key    : Value" format — textToHtml detects these and renders them as a table
  return rows.map(([k, v]) => `${k.padEnd(pad)} : ${v || "—"}`).join("\n");
}

// Mirrors frontend/src/constants.ts's CURRENCIES table so email/Teams amounts
// use the same symbol as the UI instead of always assuming Loti.
const CURRENCY_SYMBOLS: Record<string, string> = {
  LSL: "M", ZAR: "R", USD: "$", EUR: "€", GBP: "£",
  BWP: "P", MZN: "MT", ZMW: "K", NAD: "N$", MWK: "MK"
};

// A request always sticks with the currency it was requested in — never a
// hardcoded default — so callers must resolve and pass it through explicitly.
// Falls back to LSL only when no currency could be resolved (e.g. non-travel
// advance types that have no associated travel_types row).
function fmt(amount: number, currency?: string | null) {
  const code = currency || "LSL";
  const symbol = CURRENCY_SYMBOLS[code] || code;
  return `${symbol} ${Number(amount).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

// Human-friendly label for an advance request type, used in email subjects so
// recipients can tell at a glance what kind of request the email is about
// (e.g. "Salary Advance", "Loan Advance", "Local Travel Advance").
function advanceTypeLabel(code: string) {
  const upper = (code || "").toUpperCase();
  if (upper === "SALARY") return "Salary Advance";
  if (upper === "LOAN") return "Loan Advance";
  return `${code.replace(/_/g, " ")} Advance`;
}

// ─── notifyAdvanceTask ────────────────────────────────────────────────────────

export async function notifyAdvanceTask(args: {
  advanceId: string;
  status: string;
  advanceType: string;
  requesterName: string | null;
  requesterEmail?: string | null;
  department: string | null;
  requestedTotal: number;
  approvedTotal?: number;
  currency?: string | null;
  comments?: string | null;
  // The specific approver for the next workflow step (workflow-driven advances).
  // When provided, this takes priority over the legacy role-based lookup.
  nextApprover?: { id?: string | null; name: string | null; email: string | null; title: string | null } | null;
  // The workflow step order nextApprover is being asked to act on — required
  // to mint a one-click email-approve/reject link bound to that exact step.
  stepOrder?: number;
}) {
  const requester = args.requesterName || "Requester";
  const department = args.department || null;

  // ── Determine who the next approver role is (legacy fallback) ──────────────
  let role: Role | null = null;
  if (args.status === "SUBMITTED")            role = "MANAGER";
  if (args.status === "COUNTERSIGNED")        role = "HOD";
  if (args.status === "HR_MANAGER_REVIEW")    role = "HR_MANAGER";
  if (args.status === "HR_REVIEW")            role = "HR_MANAGER";
  if (args.status === "HR_OFFICER")           role = "FINANCE";
  if (args.status === "APPROVED")             role = "FINANCE";

  const details = detailBlock([
    ["Requester",   requester],
    ["Division",  department],
    ["Type",        args.advanceType.replace(/_/g, " ")],
    ["Amount",      fmt(args.requestedTotal, args.currency)],
    ["Status",      statusLabel(args.status)],
    ...(args.comments ? [["Comments", args.comments] as [string, string]] : [])
  ]);

  // ── Notify approver ────────────────────────────────────────────────────────
  if (args.nextApprover?.email) {
    try {
      const roleLabel = args.nextApprover.title || "Approver";
      let emailActionLine = "";
      if (args.nextApprover.id && args.stepOrder !== undefined) {
        try {
          const token = await createEmailActionToken({
            userId: args.nextApprover.id, docType: "ADVANCE", docId: args.advanceId, stepOrder: args.stepOrder
          });
          emailActionLine = `EmailAction: ${buildEmailActionUrl(token)}\n`;
        } catch (e) {
          logger.warn("advance_email_action_token_failed", { advance_id: args.advanceId, error: serializeError(e) });
        }
      }
      const approverMsg = [
        header(`ADVANCE REQUEST — ACTION REQUIRED`),
        ``,
        `Hello ${args.nextApprover.name || ""},`.trim(),
        ``,
        `An advance request requires your ${roleLabel} approval.`,
        ``,
        details,
        ``,
        emailActionLine,
        `Please log in to review and take action on this request.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.nextApprover.email],
        subject: `[Action Required] ${advanceTypeLabel(args.advanceType)} awaiting ${roleLabel} approval`,
        text: approverMsg
      });

      sendTeamsCard({
        title: "Advance Request — Action Required",
        summary: `Advance request from ${requester} awaiting ${roleLabel} approval`,
        subtitle: `Requires ${roleLabel} action`,
        color: "f59e0b",
        facts: [
          { name: "Requester", value: requester },
          { name: "Division", value: department || "—" },
          { name: "Type", value: args.advanceType.replace(/_/g, " ") },
          { name: "Amount", value: fmt(args.requestedTotal, args.currency) },
          { name: "Status", value: statusLabel(args.status) },
          ...(args.comments ? [{ name: "Comments", value: args.comments }] : [])
        ]
      }).catch((e) => logger.warn("teams_advance_approver_failed", { error: serializeError(e) }));
    } catch (error) {
      logger.warn("advance_approver_notification_failed", {
        advance_id: args.advanceId, status: args.status, error: serializeError(error)
      });
    }
  } else if (role) {
    try {
      const recipientDept = role === "HR_MANAGER" ? null : department;
      const approverRecipients =
        args.status === "SUBMITTED"
          ? await getAssignedDepartmentOwnerRecipients(department, "manager_user_id")
          : role === "FINANCE"
            ? await getFinanceRecipients()
            : await getRecipients(role, recipientDept);

      if (approverRecipients.length > 0) {
        const roleLabel = role.replace(/_/g, " ");
        const approverMsg = [
          header(`ADVANCE REQUEST — ACTION REQUIRED`),
          ``,
          `Hello,`,
          ``,
          `An advance request requires your ${roleLabel} approval.`,
          ``,
          details,
          ``,
          `Please log in to review and take action on this request.`,
          ``,
          footer()
        ].join("\n");

        await sendMail({
          to: approverRecipients.map((r) => r.email),
          subject: `[Action Required] ${advanceTypeLabel(args.advanceType)} awaiting ${roleLabel} approval`,
          text: approverMsg
        });

        sendTeamsCard({
          title: "Advance Request — Action Required",
          summary: `Advance request from ${requester} awaiting ${roleLabel} approval`,
          subtitle: `Requires ${roleLabel} action`,
          color: "f59e0b",
          facts: [
            { name: "Requester", value: requester },
            { name: "Division", value: department || "—" },
            { name: "Type", value: args.advanceType.replace(/_/g, " ") },
            { name: "Amount", value: fmt(args.requestedTotal, args.currency) },
            { name: "Status", value: statusLabel(args.status) },
            ...(args.comments ? [{ name: "Comments", value: args.comments }] : [])
          ]
        }).catch((e) => logger.warn("teams_advance_approver_failed", { error: serializeError(e) }));
      }
    } catch (error) {
      logger.warn("advance_approver_notification_failed", {
        advance_id: args.advanceId, status: args.status, error: serializeError(error)
      });
    }
  }

  // ── Notify requester of status update ─────────────────────────────────────
  if (args.requesterEmail) {
    try {
      const requesterMessages: Record<string, string> = {
        SUBMITTED:            `Your advance request has been submitted and is awaiting manager approval.`,
        COUNTERSIGNED:        `Your advance request has been approved by your manager and is now pending HOD / EXCO review.`,
        HR_MANAGER_REVIEW:    `Your advance request is progressing and is now under HR Manager review.`,
        HR_REVIEW:            `Your advance request is under HR review.`,
        HR_OFFICER:           `Your advance request has been approved and is being processed for payment.`,
        APPROVED:             `Great news! Your advance request has been fully approved and forwarded to Finance for payment.`,
        REJECTED:             `Your advance request has been reviewed and unfortunately has been rejected.${args.comments ? `\n\nReason: ${args.comments}` : ""}`
      };

      const statusMsg = requesterMessages[args.status];
      if (!statusMsg) return;

      const typeLabel = advanceTypeLabel(args.advanceType);
      const subject =
        args.status === "APPROVED"  ? `[Approved] Your ${typeLabel} has been approved` :
        args.status === "REJECTED"  ? `[Rejected] Your ${typeLabel} has been rejected` :
        `[Update] ${typeLabel} status — ${statusLabel(args.status)}`;

      const requesterMsg = [
        header(`ADVANCE REQUEST — STATUS UPDATE`),
        ``,
        `Hello ${requester},`,
        ``,
        statusMsg,
        ``,
        details,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.requesterEmail],
        subject,
        text: requesterMsg
      });

      const statusColor: Record<string, string> = {
        APPROVED: "16a34a", REJECTED: "dc2626"
      };
      sendTeamsCard({
        title: "Advance Request — Status Update",
        summary: subject,
        subtitle: `Update for ${requester}`,
        color: statusColor[args.status] || "3b82f6",
        facts: [
          { name: "Requester", value: requester },
          { name: "Division", value: department || "—" },
          { name: "Type", value: args.advanceType.replace(/_/g, " ") },
          { name: "Amount", value: fmt(args.requestedTotal, args.currency) },
          { name: "Status", value: statusLabel(args.status) },
          ...(args.comments ? [{ name: "Comments", value: args.comments }] : [])
        ]
      }).catch((e) => logger.warn("teams_advance_requester_failed", { error: serializeError(e) }));
    } catch (error) {
      logger.warn("advance_requester_notification_failed", {
        advance_id: args.advanceId, status: args.status, error: serializeError(error)
      });
    }
  }
}

// ─── notifyAdvancePaid ────────────────────────────────────────────────────────

export async function notifyAdvancePaid(args: {
  advanceId: string;
  requesterName: string | null;
  requesterEmail: string | null;
  department: string | null;
  advanceType: string;
  approvedTotal: number;
  currency?: string | null;
  paidReference?: string | null;
}) {
  if (!args.requesterEmail) return;
  try {
    const requester = args.requesterName || "Requester";
    const details = detailBlock([
      ["Requester",  requester],
      ["Division", args.department],
      ["Type",       args.advanceType.replace(/_/g, " ")],
      ["Amount",     fmt(args.approvedTotal, args.currency)],
      ["Status",     "PAID"],
      ...(args.paidReference ? [["Reference", args.paidReference] as [string, string]] : [])
    ]);

    const body = [
      header(`ADVANCE REQUEST — PAYMENT PROCESSED`),
      ``,
      `Hello ${requester},`,
      ``,
      `Your advance request has been processed and payment has been made.`,
      `Please check your account.`,
      ``,
      details,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.requesterEmail],
      subject: `[Paid] Your ${advanceTypeLabel(args.advanceType)} payment has been processed`,
      text: body
    });

    sendTeamsCard({
      title: "Advance Request — Payment Processed",
      summary: `Advance payment processed for ${requester}`,
      subtitle: "Payment has been made",
      color: "16a34a",
      facts: [
        { name: "Requester", value: requester },
        { name: "Division", value: args.department || "—" },
        { name: "Type", value: args.advanceType.replace(/_/g, " ") },
        { name: "Amount", value: fmt(args.approvedTotal, args.currency) },
        { name: "Status", value: "PAID" },
        ...(args.paidReference ? [{ name: "Reference", value: args.paidReference }] : [])
      ]
    }).catch((e) => logger.warn("teams_advance_paid_failed", { error: serializeError(e) }));
  } catch (error) {
    logger.warn("advance_paid_notification_failed", {
      advance_id: args.advanceId, error: serializeError(error)
    });
  }
}

// ─── notifyAdvanceCancelled ───────────────────────────────────────────────────

export async function notifyAdvanceCancelled(args: {
  advanceId: string;
  requesterName: string | null;
  requesterEmail: string | null;
  department: string | null;
  advanceType: string;
  requestedTotal: number;
  currency?: string | null;
}) {
  if (!args.requesterEmail) return;
  try {
    const requester = args.requesterName || "Requester";
    const details = detailBlock([
      ["Requester",  requester],
      ["Division", args.department],
      ["Type",       args.advanceType.replace(/_/g, " ")],
      ["Amount",     fmt(args.requestedTotal, args.currency)],
      ["Status",     "CANCELLED"]
    ]);

    const body = [
      header(`ADVANCE REQUEST — CANCELLED`),
      ``,
      `Hello ${requester},`,
      ``,
      `Your advance request has been cancelled.`,
      `If you did not cancel this request, please contact your HR division.`,
      ``,
      details,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.requesterEmail],
      subject: `[Cancelled] Your ${advanceTypeLabel(args.advanceType)} has been cancelled`,
      text: body
    });

    sendTeamsCard({
      title: "Advance Request — Cancelled",
      summary: `Advance request cancelled for ${requester}`,
      subtitle: "Your advance request has been cancelled",
      color: "6b7280",
      facts: [
        { name: "Requester", value: requester },
        { name: "Division", value: args.department || "—" },
        { name: "Type", value: args.advanceType.replace(/_/g, " ") },
        { name: "Amount", value: fmt(args.requestedTotal, args.currency) },
        { name: "Status", value: "CANCELLED" }
      ]
    }).catch((e) => logger.warn("teams_advance_cancelled_failed", { error: serializeError(e) }));
  } catch (error) {
    logger.warn("advance_cancelled_notification_failed", {
      advance_id: args.advanceId, error: serializeError(error)
    });
  }
}

// ─── notifyClaimTask ──────────────────────────────────────────────────────────

export async function notifyClaimTask(args: {
  claimId: string;
  status: string;
  claimantName: string | null;
  claimantEmail?: string | null;
  department: string | null;
  claimTotal: number;
  currency?: string | null;
  claimType?: string | null;
  // The specific approver for the next workflow step. When provided, this
  // takes priority over the legacy role-based recipient lookup.
  nextApprover?: { id?: string | null; name: string | null; email: string | null; title: string | null } | null;
  // The workflow step order nextApprover is being asked to act on — required
  // to mint a one-click email-approve/reject link bound to that exact step.
  stepOrder?: number;
}) {
  const claimant = args.claimantName || "Claimant";
  const department = args.department || null;
  const claimTypeLabel = args.claimType ? `${args.claimType.replace(/_/g, " ")} Clearance Claim` : "Clearance Claim";

  const details = detailBlock([
    ["Claimant",   claimant],
    ["Division", department],
    ["Amount",     fmt(args.claimTotal, args.currency)],
    ["Status",     statusLabel(args.status)]
  ]);

  // ── Settled: notify claimant directly ────────────────────────────────────
  if (args.status === "SETTLED") {
    if (!args.claimantEmail) return;
    try {
      const body = [
        header(`CLEARANCE CLAIM — SETTLED`),
        ``,
        `Hello ${claimant},`,
        ``,
        `Your clearance claim has been settled. Payment has been processed.`,
        `Please check your account.`,
        ``,
        details,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.claimantEmail],
        subject: `[Settled] Your ${claimTypeLabel} has been settled`,
        text: body
      });

      sendTeamsCard({
        title: "Clearance Claim — Settled",
        summary: `Clearance claim settled for ${claimant}`,
        subtitle: "Payment has been processed",
        color: "16a34a",
        facts: [
          { name: "Claimant", value: claimant },
          { name: "Division", value: department || "—" },
          { name: "Amount", value: fmt(args.claimTotal, args.currency) },
          { name: "Status", value: "SETTLED" }
        ]
      }).catch((e) => logger.warn("teams_claim_settled_failed", { error: serializeError(e) }));
    } catch (error) {
      logger.warn("claim_settled_notification_failed", {
        claim_id: args.claimId, error: serializeError(error)
      });
    }
    return;
  }

  // ── Notify approver (workflow-driven: specific approver known) ──────────────
  if (args.nextApprover?.email) {
    try {
      const roleLabel = args.nextApprover.title || "Approver";
      let emailActionLine = "";
      if (args.nextApprover.id && args.stepOrder !== undefined) {
        try {
          const token = await createEmailActionToken({
            userId: args.nextApprover.id, docType: "CLAIM", docId: args.claimId, stepOrder: args.stepOrder
          });
          emailActionLine = `EmailAction: ${buildEmailActionUrl(token)}\n`;
        } catch (e) {
          logger.warn("claim_email_action_token_failed", { claim_id: args.claimId, error: serializeError(e) });
        }
      }
      const body = [
        header(`CLEARANCE CLAIM — ACTION REQUIRED`),
        ``,
        `Hello ${args.nextApprover.name || ""},`.trim(),
        ``,
        `A clearance claim requires your ${roleLabel} action.`,
        ``,
        details,
        ``,
        emailActionLine,
        `Please log in to review and take action on this request.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.nextApprover.email],
        subject: `[Action Required] ${claimTypeLabel} awaiting ${roleLabel} action`,
        text: body
      });

      sendTeamsCard({
        title: "Clearance Claim — Action Required",
        summary: `Clearance claim from ${claimant} awaiting ${roleLabel} action`,
        subtitle: `Requires ${roleLabel} action`,
        color: "f59e0b",
        facts: [
          { name: "Claimant", value: claimant },
          { name: "Division", value: department || "—" },
          { name: "Amount", value: fmt(args.claimTotal, args.currency) },
          { name: "Status", value: statusLabel(args.status) }
        ]
      }).catch((e) => logger.warn("teams_claim_approver_failed", { error: serializeError(e) }));
    } catch (error) {
      logger.warn("claim_approver_notification_failed", {
        claim_id: args.claimId, status: args.status, error: serializeError(error)
      });
    }
    return;
  }

  // ── Notify approver (legacy role-based recipient lookup) ────────────────────
  let roles: Role[] = [];
  if (args.status === "SUBMITTED")              roles = ["MANAGER"];
  if (args.status === "MANAGER_APPROVED")       roles = ["EXCO"];
  if (args.status === "CHIEF_OFFICER_APPROVED") roles = ["MANAGER"];
  if (args.status === "HR_OFFICER")             roles = ["HR_MANAGER"];
  if (args.status === "HR_MANAGER_REVIEW")      roles = ["FINANCE"];
  if (args.status === "FINANCE_VERIFIED")       roles = ["FINANCE"];

  if (roles.length > 0) {
    try {
      const allRecipients = (
        await Promise.all(
          roles.map((role) =>
            role === "FINANCE"
              ? getFinanceRecipients()
              : args.status === "CHIEF_OFFICER_APPROVED"
              ? getRecipients(role, null)
              : args.status === "SUBMITTED"
                ? getAssignedDepartmentOwnerRecipients(department, "manager_user_id")
                : args.status === "MANAGER_APPROVED"
                  ? getAssignedDepartmentOwnerRecipients(department, "exco_user_id")
                  : getRecipients(role, null)
          )
        )
      ).flat();

      const unique = Array.from(new Map(allRecipients.map((r) => [r.email, r])).values());
      const roleLabel = roles.map((r) => r.replace(/_/g, " ")).join(" / ");

      if (unique.length > 0) {
        const body = [
          header(`CLEARANCE CLAIM — ACTION REQUIRED`),
          ``,
          `Hello,`,
          ``,
          `A clearance claim requires your ${roleLabel} action.`,
          ``,
          details,
          ``,
          `Please log in to review and take action on this claim.`,
          ``,
          footer()
        ].join("\n");

        await sendMail({
          to: unique.map((r) => r.email),
          subject: `[Action Required] ${claimTypeLabel} awaiting ${roleLabel} action`,
          text: body
        });

        sendTeamsCard({
          title: "Clearance Claim — Action Required",
          summary: `Clearance claim from ${claimant} awaiting ${roleLabel} action`,
          subtitle: `Requires ${roleLabel} action`,
          color: "f59e0b",
          facts: [
            { name: "Claimant", value: claimant },
            { name: "Division", value: department || "—" },
            { name: "Amount", value: fmt(args.claimTotal, args.currency) },
            { name: "Status", value: statusLabel(args.status) }
          ]
        }).catch((e) => logger.warn("teams_claim_approver_failed", { error: serializeError(e) }));
      }
    } catch (error) {
      logger.warn("claim_approver_notification_failed", {
        claim_id: args.claimId, status: args.status, error: serializeError(error)
      });
    }
  }

  // ── Notify claimant of progress ───────────────────────────────────────────
  if (args.claimantEmail) {
    try {
      const claimantMessages: Record<string, string> = {
        SUBMITTED:              `Your clearance claim has been submitted and is awaiting manager approval.`,
        MANAGER_APPROVED:       `Your clearance claim has been approved by your manager and is now pending EXCO review.`,
        CHIEF_OFFICER_APPROVED: `Your clearance claim has been approved by EXCO and is now with HR for processing.`,
        HR_OFFICER:             `Your clearance claim is being reviewed by HR Management.`,
        HR_MANAGER_REVIEW:      `Your clearance claim has been reviewed by HR and forwarded to Finance for verification.`,
        FINANCE_VERIFIED:       `Your clearance claim has been verified by Finance and is awaiting final settlement.`,
        CLOSED:                 `Your clearance claim has been fully approved and closed.`
      };

      const statusMsg = claimantMessages[args.status];
      if (!statusMsg) return;

      const body = [
        header(`CLEARANCE CLAIM — STATUS UPDATE`),
        ``,
        `Hello ${claimant},`,
        ``,
        statusMsg,
        ``,
        details,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.claimantEmail],
        subject: `[Update] ${claimTypeLabel} — ${statusLabel(args.status)}`,
        text: body
      });

      sendTeamsCard({
        title: "Clearance Claim — Status Update",
        summary: `Clearance claim update for ${claimant}: ${statusLabel(args.status)}`,
        subtitle: `Update for ${claimant}`,
        color: "3b82f6",
        facts: [
          { name: "Claimant", value: claimant },
          { name: "Division", value: department || "—" },
          { name: "Amount", value: fmt(args.claimTotal, args.currency) },
          { name: "Status", value: statusLabel(args.status) }
        ]
      }).catch((e) => logger.warn("teams_claim_claimant_failed", { error: serializeError(e) }));
    } catch (error) {
      logger.warn("claim_claimant_notification_failed", {
        claim_id: args.claimId, status: args.status, error: serializeError(error)
      });
    }
  }
}

// ─── notifyUserOnboarded ──────────────────────────────────────────────────────

export async function notifyUserOnboarded(args: {
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
  sectionOrDepartment: string | null;
  temporaryPassword: string;
}) {
  try {
    const name = args.fullName || args.email;
    const roleLabel = args.role.replace(/_/g, " ");
    const credentialLine = env.AD_AUTH_ENABLED
      ? `Use your Active Directory (network) credentials to sign in.\nIf local login is needed, your administrator has a temporary password for you.`
      : `Your temporary password is: ${args.temporaryPassword}\nPlease change it after your first sign-in.`;

    const message = buildOnboardingMessage({
      name,
      email: args.email,
      role: args.role,
      roleLabel,
      department: args.sectionOrDepartment,
      credentialLine
    });

    await sendMail({
      to: [args.email],
      subject: message.subject,
      text: message.body
    });

    sendTeamsCard(message.teams).catch((e) =>
      logger.warn("teams_onboarding_failed", { error: serializeError(e) })
    );
  } catch (error) {
    logger.warn("user_onboarding_notification_failed", {
      user_id: args.userId, email: args.email, error: serializeError(error)
    });
  }
}

// ─── notifyUserReactivated ────────────────────────────────────────────────────

export async function notifyUserReactivated(args: {
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
  sectionOrDepartment: string | null;
}) {
  try {
    const name = args.fullName || args.email;
    const roleLabel = args.role.replace(/_/g, " ");

    const message = [
      header(`ACCOUNT REACTIVATED`),
      ``,
      `Hello ${name},`,
      ``,
      `Your account on the Advance Clearance System has been reactivated. You can now sign in again.`,
      ``,
      detailBlock([
        ["Email",      args.email],
        ["Role",       roleLabel],
        ["Division", args.sectionOrDepartment]
      ]),
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.email],
      subject: `[Account Reactivated] Your access has been restored`,
      text: message
    });

    sendTeamsCard({
      title: "Account Reactivated",
      summary: `${name}'s account has been reactivated`,
      subtitle: roleLabel,
      color: "16a34a",
      facts: [
        { name: "Email", value: args.email },
        { name: "Role", value: roleLabel },
        { name: "Division", value: args.sectionOrDepartment || "—" }
      ]
    }).catch((e) => logger.warn("teams_reactivation_failed", { error: serializeError(e) }));
  } catch (error) {
    logger.warn("user_reactivation_notification_failed", {
      user_id: args.userId, email: args.email, error: serializeError(error)
    });
  }
}

// ─── notifyUserRoleChanged ────────────────────────────────────────────────────

export async function notifyUserRoleChanged(args: {
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
  sectionOrDepartment: string | null;
}) {
  try {
    const name = args.fullName || args.email;
    const roleLabel = args.role.replace(/_/g, " ");

    const message = [
      header(`ROLE UPDATED`),
      ``,
      `Hello ${name},`,
      ``,
      `Your role on the Advance Clearance System has been updated. Your new role is shown below.`,
      ``,
      detailBlock([
        ["Email",      args.email],
        ["New Role",   roleLabel],
        ["Division", args.sectionOrDepartment]
      ]),
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.email],
      subject: `[Role Updated] Your access on the Advance Clearance System has changed`,
      text: message
    });

    sendTeamsCard({
      title: "User Role Updated",
      summary: `${name}'s role has been changed to ${roleLabel}`,
      subtitle: roleLabel,
      color: "2563eb",
      facts: [
        { name: "Email", value: args.email },
        { name: "New Role", value: roleLabel },
        { name: "Division", value: args.sectionOrDepartment || "—" }
      ]
    }).catch((e) => logger.warn("teams_role_change_failed", { error: serializeError(e) }));
  } catch (error) {
    logger.warn("user_role_change_notification_failed", {
      user_id: args.userId, email: args.email, error: serializeError(error)
    });
  }
}

// ─── notifyProfileCompleted ───────────────────────────────────────────────────

export async function notifyProfileCompleted(args: {
  userId: string;
  fullName: string | null;
  email: string;
  department: string | null;
  employmentType: string;
  employeeNo: string | null;
}) {
  try {
    const name = args.fullName || args.email;

    // Notify the user confirming their profile is complete
    const userDetails = detailBlock([
      ["Name",            name],
      ["Division",      args.department],
      ["Employment Type", args.employmentType.replace(/_/g, " ")],
      ["Employee No.",    args.employeeNo]
    ]);

    const userBody = [
      header(`PROFILE COMPLETED SUCCESSFULLY`),
      ``,
      `Hello ${name},`,
      ``,
      `Your profile has been completed. You now have full access to the Advance Clearance System.`,
      ``,
      userDetails,
      ``,
      `You can now:`,
      `  • Submit advance requests`,
      `  • Track the status of your requests`,
      `  • View your request history`,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.email],
      subject: `[Profile Complete] Welcome to the Advance Clearance System`,
      text: userBody
    });

    sendTeamsCard({
      title: "User Profile Completed",
      summary: `${name} has completed their profile and is now active`,
      subtitle: "Ready to submit advance requests",
      color: "16a34a",
      facts: [
        { name: "Name", value: name },
        { name: "Email", value: args.email },
        { name: "Division", value: args.department || "—" },
        { name: "Employment Type", value: args.employmentType.replace(/_/g, " ") },
        { name: "Employee No.", value: args.employeeNo || "—" }
      ]
    }).catch((e) => logger.warn("teams_profile_completed_failed", { error: serializeError(e) }));

    // Also notify HR/Admin that a new user has completed onboarding
    const hrRecipients = await getRecipients("HR_MANAGER" as Role, null);
    if (hrRecipients.length > 0) {
      const hrDetails = detailBlock([
        ["Name",            name],
        ["Email",           args.email],
        ["Division",      args.department],
        ["Employment Type", args.employmentType.replace(/_/g, " ")],
        ["Employee No.",    args.employeeNo]
      ]);

      const hrBody = [
        header(`NEW USER PROFILE COMPLETED`),
        ``,
        `Hello,`,
        ``,
        `A user has completed their profile and is now active in the system.`,
        ``,
        hrDetails,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: hrRecipients.map((r) => r.email),
        subject: `[New User] ${name} has completed their profile`,
        text: hrBody
      });
    }
  } catch (error) {
    logger.warn("profile_completed_notification_failed", {
      user_id: args.userId, error: serializeError(error)
    });
  }
}

// ─── notifyOvertimeSubmitted ──────────────────────────────────────────────────

export async function notifyOvertimeSubmitted(args: {
  requestId: string;
  employeeName: string | null;
  employeeEmail?: string | null;
  department: string | null;
  month: number;
  year: number;
  type: "request" | "claim";
}) {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const periodLabel = `${MONTHS[(args.month - 1)] ?? args.month} ${args.year}`;
  const employee = args.employeeName || "Employee";
  const typeLabel = args.type === "claim" ? "Overtime Claim" : "Overtime Request";

  const details = detailBlock([
    ["Employee",   employee],
    ["Division", args.department],
    ["Period",     periodLabel],
    ["Type",       typeLabel]
  ]);

  try {
    // Notify department manager
    const managers = await getAssignedDepartmentOwnerRecipients(args.department, "manager_user_id");
    if (managers.length > 0) {
      const body = [
        header(`${typeLabel.toUpperCase()} — SUBMITTED`),
        ``,
        `Hello,`,
        ``,
        `A ${typeLabel.toLowerCase()} has been submitted and requires your review.`,
        ``,
        details,
        ``,
        `Please log in to review this submission.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: managers.map((r) => r.email),
        subject: `[Review Required] ${typeLabel} submitted by ${employee}`,
        text: body
      });

      sendTeamsCard({
        title: `${typeLabel} — Submitted`,
        summary: `${typeLabel} submitted by ${employee} for ${periodLabel}`,
        subtitle: "Requires manager review",
        color: "f59e0b",
        facts: [
          { name: "Employee", value: employee },
          { name: "Division", value: args.department || "—" },
          { name: "Period", value: periodLabel },
          { name: "Type", value: typeLabel }
        ]
      }).catch((e) => logger.warn("teams_overtime_manager_failed", { error: serializeError(e) }));
    }

    // Confirm submission to the employee
    if (args.employeeEmail) {
      const confirmBody = [
        header(`${typeLabel.toUpperCase()} — SUBMISSION CONFIRMED`),
        ``,
        `Hello ${employee},`,
        ``,
        `Your ${typeLabel.toLowerCase()} has been submitted successfully.`,
        ``,
        details,
        ``,
        `You will be notified once it has been reviewed.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.employeeEmail],
        subject: `[Submitted] Your ${typeLabel.toLowerCase()} for ${periodLabel}`,
        text: confirmBody
      });
    }
  } catch (error) {
    logger.warn("overtime_notification_failed", {
      request_id: args.requestId, type: args.type, error: serializeError(error)
    });
  }
}

// ─── Custom request types (e.g. Change Requests) ─────────────────────────────

export async function notifyCustomRequestStep(args: {
  submissionId: string;
  requestTypeName: string;
  requesterName: string | null;
  approverEmail: string | null;
  approverName: string | null;
  approverId?: string | null;
  stepLabel: string;
  // The chain step index approverId is being asked to act on — required to
  // mint a one-click email-approve/reject link bound to that exact step.
  stepOrder?: number;
}) {
  try {
    if (!args.approverEmail) return;

    let emailActionLine = "";
    if (args.approverId && args.stepOrder !== undefined) {
      try {
        const token = await createEmailActionToken({
          userId: args.approverId, docType: "CUSTOM_REQUEST", docId: args.submissionId, stepOrder: args.stepOrder
        });
        emailActionLine = `EmailAction: ${buildEmailActionUrl(token)}\n`;
      } catch (e) {
        logger.warn("custom_request_email_action_token_failed", { submission_id: args.submissionId, error: serializeError(e) });
      }
    }

    const body = [
      header(`${args.requestTypeName.toUpperCase()} — APPROVAL REQUIRED`),
      ``,
      `Hello ${args.approverName || ""},`,
      ``,
      `A ${args.requestTypeName.toLowerCase()} from ${args.requesterName || "an employee"} requires your approval (${args.stepLabel}).`,
      ``,
      emailActionLine,
      `Please log in to review this request.`,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.approverEmail],
      subject: `[Action Required] ${args.requestTypeName} — ${args.stepLabel}`,
      text: body
    });
  } catch (error) {
    logger.warn("custom_request_notification_failed", {
      submission_id: args.submissionId, error: serializeError(error)
    });
  }
}

// Sent when a custom request's "user" field (e.g. Change Assignee) is filled
// in with a plain email address instead of a picked system user — i.e. the
// assignee doesn't have a FlowDesk account yet. Unlike notifyCustomRequestStep,
// there's no approverId/login link to mint, just a heads-up email.
export async function notifyCustomRequestUnregisteredAssignee(args: {
  submissionId: string;
  requestTypeName: string;
  requesterName: string | null;
  fieldLabel: string;
  assigneeEmail: string;
}) {
  try {
    const body = [
      header(`${args.requestTypeName.toUpperCase()} — YOU'VE BEEN ASSIGNED`),
      ``,
      `Hello,`,
      ``,
      `${args.requesterName || "An employee"} submitted a ${args.requestTypeName.toLowerCase()} and listed you as "${args.fieldLabel}".`,
      ``,
      `You don't appear to have a FlowDesk account yet — if you need to follow up on this request, contact ${args.requesterName || "the requester"} directly or ask IT/Admin to set up access.`,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.assigneeEmail],
      subject: `[FYI] ${args.requestTypeName} — ${args.fieldLabel}`,
      text: body
    });
  } catch (error) {
    logger.warn("custom_request_unregistered_assignee_notification_failed", {
      submission_id: args.submissionId, error: serializeError(error)
    });
  }
}

// Sent to every current member of a Section picked in a custom request's
// "section" field (e.g. Change Implementor) — they're the ones expected to
// carry out the implementation, so they need to know even though, unlike
// "user_multi" assignees, nobody here needs to confirm anything.
export async function notifyCustomRequestSectionAssigned(args: {
  submissionId: string;
  requestTypeName: string;
  requesterName: string | null;
  fieldLabel: string;
  sectionName: string;
  memberEmails: string[];
}) {
  try {
    if (!args.memberEmails.length) return;

    const body = [
      header(`${args.requestTypeName.toUpperCase()} — YOUR DEPARTMENT IS THE IMPLEMENTOR`),
      ``,
      `Hello,`,
      ``,
      `${args.requesterName || "An employee"} submitted a ${args.requestTypeName.toLowerCase()} and listed your department, "${args.sectionName}", as the ${args.fieldLabel}.`,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: args.memberEmails,
      subject: `[FYI] ${args.requestTypeName} — ${args.fieldLabel} (${args.sectionName})`,
      text: body
    });
  } catch (error) {
    logger.warn("custom_request_section_assigned_notification_failed", {
      submission_id: args.submissionId, error: serializeError(error)
    });
  }
}

// Sent to a registered FlowDesk user named as a custom request's "user_multi"
// assignee (e.g. Change Assignee) — distinct from notifyCustomRequestUnregisteredAssignee,
// which only covers people invited by plain email with no account yet.
export async function notifyCustomRequestAssigneeAssigned(args: {
  submissionId: string;
  requestTypeName: string;
  requesterName: string | null;
  fieldLabel: string;
  assigneeEmail: string;
  assigneeName: string | null;
}) {
  try {
    const body = [
      header(`${args.requestTypeName.toUpperCase()} — YOU'VE BEEN ASSIGNED`),
      ``,
      `Hello ${args.assigneeName || ""},`,
      ``,
      `${args.requesterName || "An employee"} submitted a ${args.requestTypeName.toLowerCase()} and listed you as "${args.fieldLabel}".`,
      ``,
      `Log in to FlowDesk to confirm once you're ready — approval can't proceed until every assignee has confirmed.`,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.assigneeEmail],
      subject: `[Action Required] ${args.requestTypeName} — ${args.fieldLabel}`,
      text: body
    });
  } catch (error) {
    logger.warn("custom_request_assignee_assigned_notification_failed", {
      submission_id: args.submissionId, error: serializeError(error)
    });
  }
}

// Sent to every current member of a team named as a custom request's
// "user_multi" assignee (e.g. Change Assignee). Any one member can confirm
// readiness on the team's behalf, so everyone needs to know they were named.
export async function notifyCustomRequestTeamAssigned(args: {
  submissionId: string;
  requestTypeName: string;
  requesterName: string | null;
  fieldLabel: string;
  teamName: string;
  memberEmails: string[];
}) {
  try {
    if (!args.memberEmails.length) return;

    const body = [
      header(`${args.requestTypeName.toUpperCase()} — YOUR SECTION HAS BEEN ASSIGNED`),
      ``,
      `Hello,`,
      ``,
      `${args.requesterName || "An employee"} submitted a ${args.requestTypeName.toLowerCase()} and assigned it to your section, "${args.teamName}" (${args.fieldLabel}).`,
      ``,
      `Any one member of the section can confirm in FlowDesk once it's ready — approval can't proceed until then.`,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: args.memberEmails,
      subject: `[Action Required] ${args.requestTypeName} — ${args.fieldLabel} (${args.teamName})`,
      text: body
    });
  } catch (error) {
    logger.warn("custom_request_team_assigned_notification_failed", {
      submission_id: args.submissionId, error: serializeError(error)
    });
  }
}

export async function notifyChangeRequestFollowUp(args: {
  submissionId: string;
  requestTypeName: string;
  requesterName: string | null;
  requesterEmail: string | null;
  implementationDate: string;
  closureNotes: string | null;
  approvers: Array<{ name: string | null; email: string | null }>;
}) {
  const requester = args.requesterName || "Requester";
  const details = detailBlock([
    ["Request Type",       args.requestTypeName],
    ["Requester",          requester],
    ["Implementation Date", args.implementationDate],
    ...(args.closureNotes ? [["Closure Notes", args.closureNotes] as [string, string]] : [])
  ]);

  const recipients = [
    ...(args.requesterEmail ? [args.requesterEmail] : []),
    ...args.approvers.map((a) => a.email).filter((e): e is string => !!e)
  ];
  const unique = [...new Set(recipients)];
  if (unique.length === 0) return;

  try {
    const body = [
      header(`${args.requestTypeName.toUpperCase()} — POST-IMPLEMENTATION REVIEW`),
      ``,
      `Hello,`,
      ``,
      `This is a follow-up notification for a ${args.requestTypeName.toLowerCase()} that was implemented on ${args.implementationDate}.`,
      ``,
      `Please confirm that the change has been implemented successfully and that no issues have arisen since implementation.`,
      ``,
      details,
      ``,
      `If you have concerns or encountered issues post-implementation, please log them immediately.`,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: unique,
      subject: `[Post-Implementation Review] ${args.requestTypeName} — ${args.implementationDate}`,
      text: body
    });

    sendTeamsCard({
      title: `${args.requestTypeName} — Post-Implementation Review`,
      summary: `Post-implementation review due for ${args.requestTypeName} by ${requester}`,
      subtitle: `Implemented on ${args.implementationDate}`,
      color: "0ea5e9",
      facts: [
        { name: "Requester", value: requester },
        { name: "Implementation Date", value: args.implementationDate },
        ...(args.closureNotes ? [{ name: "Closure Notes", value: args.closureNotes }] : [])
      ]
    }).catch((e) => logger.warn("teams_change_request_followup_failed", { error: serializeError(e) }));
  } catch (error) {
    logger.warn("change_request_followup_notification_failed", {
      submission_id: args.submissionId, error: serializeError(error)
    });
  }
}

export async function notifyCustomRequestDecision(args: {
  submissionId: string;
  requestTypeName: string;
  requesterEmail: string | null;
  requesterName: string | null;
  decision: "APPROVED" | "REJECTED";
  decidedBy: string | null;
  comment?: string | null;
}) {
  try {
    if (!args.requesterEmail) return;

    const lines = [
      header(`${args.requestTypeName.toUpperCase()} — ${args.decision}`),
      ``,
      `Hello ${args.requesterName || ""},`,
      ``,
      `Your ${args.requestTypeName.toLowerCase()} has been ${args.decision.toLowerCase()} by ${args.decidedBy || "an approver"}.`
    ];
    if (args.comment) {
      lines.push(``, `Comment: ${args.comment}`);
    }
    lines.push(``, footer());
    const body = lines.join("\n");

    await sendMail({
      to: [args.requesterEmail],
      subject: `[${args.decision}] Your ${args.requestTypeName}`,
      text: body
    });
  } catch (error) {
    logger.warn("custom_request_notification_failed", {
      submission_id: args.submissionId, error: serializeError(error)
    });
  }
}

export async function notifyCustomRequestCancelled(args: {
  submissionId: string;
  requestTypeName: string;
  requesterName: string | null;
  approverEmail: string | null;
  approverName: string | null;
  comment: string;
}) {
  try {
    if (!args.approverEmail) return;

    const lines = [
      header(`${args.requestTypeName.toUpperCase()} — WITHDRAWN`),
      ``,
      `Hello ${args.approverName || ""},`,
      ``,
      `${args.requesterName || "The requester"} has withdrawn their ${args.requestTypeName.toLowerCase()} that was awaiting your approval. No further action is needed.`,
      ``,
      `Comment: ${args.comment}`,
      ``,
      footer()
    ];

    await sendMail({
      to: [args.approverEmail],
      subject: `[Withdrawn] ${args.requestTypeName}`,
      text: lines.join("\n")
    });
  } catch (error) {
    logger.warn("custom_request_cancel_notification_failed", {
      submission_id: args.submissionId, error: serializeError(error)
    });
  }
}

// ─── Delegation notifications ─────────────────────────────────────────────────

export async function notifyDelegationAssigned(args: {
  delegationId: string;
  managerName: string | null;
  managerEmail: string | null;
  delegateName: string | null;
  delegateEmail: string | null;
  department: string | null;
  fromDate: string | null;
  toDate: string | null;
}) {
  const period = args.fromDate && args.toDate
    ? `${args.fromDate} to ${args.toDate}`
    : args.fromDate ? `from ${args.fromDate}` : args.toDate ? `until ${args.toDate}` : "until further notice";

  // Notify the delegate
  if (args.delegateEmail) {
    try {
      const body = [
        header("DELEGATION ASSIGNED"),
        ``,
        `Hello ${args.delegateName || ""},`,
        ``,
        `${args.managerName || "A manager"} has delegated their approval authority to you.`,
        ``,
        detailBlock([
          ["Delegating Manager", args.managerName],
          ["Division",         args.department],
          ["Period",             period]
        ]),
        ``,
        `You will receive approval requests on their behalf during this period. Please log in to review any pending items.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.delegateEmail],
        subject: `[Delegation] You have been assigned as delegate for ${args.managerName || "a manager"}`,
        text: body
      });

      sendTeamsCard({
        title: "Delegation Assigned",
        summary: `${args.managerName} has delegated approval authority to ${args.delegateName}`,
        color: "7c3aed",
        facts: [
          { name: "Manager",    value: args.managerName || "—" },
          { name: "Division", value: args.department  || "—" },
          { name: "Period",     value: period }
        ]
      }).catch((e) => logger.warn("teams_delegation_assigned_failed", { error: serializeError(e) }));
    } catch (error) {
      logger.warn("delegation_assigned_delegate_notification_failed", {
        delegation_id: args.delegationId, error: serializeError(error)
      });
    }
  }

  // Confirm to the manager
  if (args.managerEmail) {
    try {
      const body = [
        header("DELEGATION CONFIRMED"),
        ``,
        `Hello ${args.managerName || ""},`,
        ``,
        `Your approval authority has been successfully delegated.`,
        ``,
        detailBlock([
          ["Delegate",   args.delegateName],
          ["Division", args.department],
          ["Period",     period]
        ]),
        ``,
        `${args.delegateName || "Your delegate"} will handle approvals on your behalf during this period.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.managerEmail],
        subject: `[Delegation] Your approvals delegated to ${args.delegateName || "delegate"}`,
        text: body
      });
    } catch (error) {
      logger.warn("delegation_assigned_manager_notification_failed", {
        delegation_id: args.delegationId, error: serializeError(error)
      });
    }
  }
}

export async function notifyPositionAssigned(args: {
  assigneeName: string | null;
  assigneeEmail: string | null;
  positionLabel: string; // e.g. "HOD", "Manager", "Exco Member"
  groupLabel: string;    // department or section name
  groupType: "Division" | "Department";
}) {
  if (!args.assigneeEmail) return;
  try {
    const body = [
      header("POSITION ASSIGNED"),
      ``,
      `Hello ${args.assigneeName || ""},`,
      ``,
      `You have been assigned as ${args.positionLabel} of the ${args.groupLabel} ${args.groupType.toLowerCase()}.`,
      ``,
      detailBlock([
        ["Position",      args.positionLabel],
        [args.groupType,  args.groupLabel]
      ]),
      ``,
      `Please log in to review your new responsibilities, including any pending approvals routed to this position.`,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.assigneeEmail],
      subject: `[Invitation] You have been assigned as ${args.positionLabel} of ${args.groupLabel}`,
      text: body
    });

    sendTeamsCard({
      title: "Position Assigned",
      summary: `${args.assigneeName || "A user"} has been assigned as ${args.positionLabel} of ${args.groupLabel}`,
      color: "0ea5e9",
      facts: [
        { name: "Assignee",     value: args.assigneeName || "—" },
        { name: "Position",     value: args.positionLabel },
        { name: args.groupType, value: args.groupLabel }
      ]
    }).catch((e) => logger.warn("teams_position_assigned_failed", { error: serializeError(e) }));
  } catch (error) {
    logger.warn("position_assigned_notification_failed", { error: serializeError(error) });
  }
}

export async function notifyAdvanceReminder(args: {
  advanceId: string;
  advanceType: string;
  requesterName: string | null;
  department: string | null;
  requestedTotal: number;
  currency?: string | null;
  status: string;
  approverName: string | null;
  approverEmail: string | null;
  approverTitle: string | null;
  senderName: string | null;
  senderEmail: string | null;
}) {
  const details = detailBlock([
    ["Requester",  args.requesterName],
    ["Division", args.department],
    ["Type",       args.advanceType.replace(/_/g, " ")],
    ["Amount",     fmt(args.requestedTotal, args.currency)],
    ["Status",     statusLabel(args.status)]
  ]);

  // Email the approver
  if (args.approverEmail) {
    try {
      const roleLabel = args.approverTitle || "Approver";
      const body = [
        header("ADVANCE REQUEST — REMINDER"),
        ``,
        `Hello ${args.approverName || ""},`,
        ``,
        `This is a friendly reminder that an advance request is awaiting your ${roleLabel} approval.`,
        ``,
        details,
        ``,
        `Please log in to review and take action on this request.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.approverEmail],
        subject: `[Reminder] ${advanceTypeLabel(args.advanceType)} awaiting ${roleLabel} approval`,
        text: body
      });

      sendTeamsCard({
        title: "Advance Request Reminder",
        summary: `${args.senderName || "Requester"} sent a reminder to ${args.approverName || args.approverEmail}`,
        color: "f59e0b",
        facts: [
          { name: "Requester",  value: args.requesterName || "—" },
          { name: "Division", value: args.department    || "—" },
          { name: "Amount",     value: fmt(args.requestedTotal, args.currency) },
          { name: "Sent to",    value: args.approverName  || "—" }
        ]
      }).catch((e) => logger.warn("teams_advance_reminder_failed", { error: serializeError(e) }));
    } catch (error) {
      logger.warn("advance_reminder_approver_notification_failed", {
        advance_id: args.advanceId, error: serializeError(error)
      });
    }
  }

  // Confirm to the sender
  if (args.senderEmail) {
    try {
      const body = [
        header("REMINDER SENT"),
        ``,
        `Hello ${args.senderName || ""},`,
        ``,
        `Your reminder has been sent to ${args.approverName || "the approver"} for the advance request below.`,
        ``,
        details,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.senderEmail],
        subject: `[Reminder Sent] ${advanceTypeLabel(args.advanceType)} — reminder sent to ${args.approverName || "approver"}`,
        text: body
      });
    } catch (error) {
      logger.warn("advance_reminder_sender_notification_failed", {
        advance_id: args.advanceId, error: serializeError(error)
      });
    }
  }
}

export async function notifyDelegationEnded(args: {
  delegationId: string;
  managerName: string | null;
  managerEmail: string | null;
  delegateName: string | null;
  delegateEmail: string | null;
  department: string | null;
  endedBy: string | null;
}) {
  // Notify the delegate
  if (args.delegateEmail) {
    try {
      const body = [
        header("DELEGATION ENDED"),
        ``,
        `Hello ${args.delegateName || ""},`,
        ``,
        `Your delegation from ${args.managerName || "your manager"} has been ended by ${args.endedBy || "an administrator"}.`,
        ``,
        detailBlock([
          ["Manager",    args.managerName],
          ["Division", args.department]
        ]),
        ``,
        `You will no longer receive approval requests on their behalf.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.delegateEmail],
        subject: `[Delegation Ended] Your delegation from ${args.managerName || "manager"} has ended`,
        text: body
      });

      sendTeamsCard({
        title: "Delegation Ended",
        summary: `Delegation from ${args.managerName} to ${args.delegateName} has ended`,
        color: "6b7280",
        facts: [
          { name: "Manager",    value: args.managerName  || "—" },
          { name: "Delegate",   value: args.delegateName || "—" },
          { name: "Division", value: args.department   || "—" },
          { name: "Ended by",   value: args.endedBy      || "—" }
        ]
      }).catch((e) => logger.warn("teams_delegation_ended_failed", { error: serializeError(e) }));
    } catch (error) {
      logger.warn("delegation_ended_delegate_notification_failed", {
        delegation_id: args.delegationId, error: serializeError(error)
      });
    }
  }

  // Confirm to the manager
  if (args.managerEmail) {
    try {
      const body = [
        header("DELEGATION ENDED"),
        ``,
        `Hello ${args.managerName || ""},`,
        ``,
        `The delegation to ${args.delegateName || "your delegate"} for ${args.department || "your department"} has been ended by ${args.endedBy || "an administrator"}.`,
        ``,
        `You will now receive approval requests directly again.`,
        ``,
        footer()
      ].join("\n");

      await sendMail({
        to: [args.managerEmail],
        subject: `[Delegation Ended] Delegation to ${args.delegateName || "delegate"} has ended`,
        text: body
      });
    } catch (error) {
      logger.warn("delegation_ended_manager_notification_failed", {
        delegation_id: args.delegationId, error: serializeError(error)
      });
    }
  }
}
