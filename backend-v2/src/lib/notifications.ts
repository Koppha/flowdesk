import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";
import { buildOnboardingMessage } from "./onboardingTemplates.js";

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

async function sendViaEmailApi(recipient: string, subject: string, body: string): Promise<void> {
  const baseUrl = env.EMAIL_API_BASE_URL.replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.EMAIL_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/sent_email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Body: body, Subject: subject, Recipient: recipient, Attachment: "" }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Email API responded with HTTP ${response.status}`);
    const text = (await response.text()).trim().toLowerCase();
    if (text && text !== "true") throw new Error(`Email API returned unexpected response: ${text}`);
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
  await mailer.sendMail({ from: env.SMTP_FROM, to: to.join(", "), subject, text });
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

const HR = "─".repeat(55);
const HR2 = "═".repeat(55);

function header(title: string) {
  return [HR2, `  ADVANCE CLEARANCE SYSTEM`, `  ${title}`, HR2].join("\n");
}

function footer() {
  return [
    HR,
    "This is an automated notification. Please do not reply.",
    HR2
  ].join("\n");
}

function detailBlock(rows: [string, string | null | undefined][]) {
  const pad = Math.max(...rows.map(([k]) => k.length));
  return [
    HR,
    ...rows.map(([k, v]) => `  ${k.padEnd(pad)} : ${v || "—"}`),
    HR
  ].join("\n");
}

function fmt(amount: number) {
  return `M ${Number(amount).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
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
  comments?: string | null;
  // The specific approver for the next workflow step (workflow-driven advances).
  // When provided, this takes priority over the legacy role-based lookup.
  nextApprover?: { name: string | null; email: string | null; title: string | null } | null;
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
    ["Department",  department],
    ["Type",        args.advanceType.replace(/_/g, " ")],
    ["Amount",      fmt(args.requestedTotal)],
    ["Status",      statusLabel(args.status)],
    ...(args.comments ? [["Comments", args.comments] as [string, string]] : [])
  ]);

  // ── Notify approver ────────────────────────────────────────────────────────
  if (args.nextApprover?.email) {
    try {
      const roleLabel = args.nextApprover.title || "Approver";
      const approverMsg = [
        header(`ADVANCE REQUEST — ACTION REQUIRED`),
        ``,
        `Hello ${args.nextApprover.name || ""},`.trim(),
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
        to: [args.nextApprover.email],
        subject: `[Action Required] Advance request awaiting ${roleLabel} approval`,
        text: approverMsg
      });

      sendTeamsCard({
        title: "Advance Request — Action Required",
        summary: `Advance request from ${requester} awaiting ${roleLabel} approval`,
        subtitle: `Requires ${roleLabel} action`,
        color: "f59e0b",
        facts: [
          { name: "Requester", value: requester },
          { name: "Department", value: department || "—" },
          { name: "Type", value: args.advanceType.replace(/_/g, " ") },
          { name: "Amount", value: fmt(args.requestedTotal) },
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
      const recipientDept = ["HR_MANAGER", "FINANCE"].includes(role) ? null : department;
      const approverRecipients =
        args.status === "SUBMITTED"
          ? await getAssignedDepartmentOwnerRecipients(department, "manager_user_id")
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
          subject: `[Action Required] Advance request awaiting ${roleLabel} approval`,
          text: approverMsg
        });

        sendTeamsCard({
          title: "Advance Request — Action Required",
          summary: `Advance request from ${requester} awaiting ${roleLabel} approval`,
          subtitle: `Requires ${roleLabel} action`,
          color: "f59e0b",
          facts: [
            { name: "Requester", value: requester },
            { name: "Department", value: department || "—" },
            { name: "Type", value: args.advanceType.replace(/_/g, " ") },
            { name: "Amount", value: fmt(args.requestedTotal) },
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

      const subject =
        args.status === "APPROVED"  ? `[Approved] Your advance request has been approved` :
        args.status === "REJECTED"  ? `[Rejected] Your advance request has been rejected` :
        `[Update] Advance request status — ${statusLabel(args.status)}`;

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
          { name: "Department", value: department || "—" },
          { name: "Type", value: args.advanceType.replace(/_/g, " ") },
          { name: "Amount", value: fmt(args.requestedTotal) },
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
  paidReference?: string | null;
}) {
  if (!args.requesterEmail) return;
  try {
    const requester = args.requesterName || "Requester";
    const details = detailBlock([
      ["Requester",  requester],
      ["Department", args.department],
      ["Type",       args.advanceType.replace(/_/g, " ")],
      ["Amount",     fmt(args.approvedTotal)],
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
      subject: `[Paid] Your advance payment has been processed`,
      text: body
    });

    sendTeamsCard({
      title: "Advance Request — Payment Processed",
      summary: `Advance payment processed for ${requester}`,
      subtitle: "Payment has been made",
      color: "16a34a",
      facts: [
        { name: "Requester", value: requester },
        { name: "Department", value: args.department || "—" },
        { name: "Type", value: args.advanceType.replace(/_/g, " ") },
        { name: "Amount", value: fmt(args.approvedTotal) },
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
}) {
  if (!args.requesterEmail) return;
  try {
    const requester = args.requesterName || "Requester";
    const details = detailBlock([
      ["Requester",  requester],
      ["Department", args.department],
      ["Type",       args.advanceType.replace(/_/g, " ")],
      ["Amount",     fmt(args.requestedTotal)],
      ["Status",     "CANCELLED"]
    ]);

    const body = [
      header(`ADVANCE REQUEST — CANCELLED`),
      ``,
      `Hello ${requester},`,
      ``,
      `Your advance request has been cancelled.`,
      `If you did not cancel this request, please contact your HR department.`,
      ``,
      details,
      ``,
      footer()
    ].join("\n");

    await sendMail({
      to: [args.requesterEmail],
      subject: `[Cancelled] Your advance request has been cancelled`,
      text: body
    });

    sendTeamsCard({
      title: "Advance Request — Cancelled",
      summary: `Advance request cancelled for ${requester}`,
      subtitle: "Your advance request has been cancelled",
      color: "6b7280",
      facts: [
        { name: "Requester", value: requester },
        { name: "Department", value: args.department || "—" },
        { name: "Type", value: args.advanceType.replace(/_/g, " ") },
        { name: "Amount", value: fmt(args.requestedTotal) },
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
}) {
  const claimant = args.claimantName || "Claimant";
  const department = args.department || null;

  const details = detailBlock([
    ["Claimant",   claimant],
    ["Department", department],
    ["Amount",     fmt(args.claimTotal)],
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
        subject: `[Settled] Your clearance claim has been settled`,
        text: body
      });

      sendTeamsCard({
        title: "Clearance Claim — Settled",
        summary: `Clearance claim settled for ${claimant}`,
        subtitle: "Payment has been processed",
        color: "16a34a",
        facts: [
          { name: "Claimant", value: claimant },
          { name: "Department", value: department || "—" },
          { name: "Amount", value: fmt(args.claimTotal) },
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

  // ── Notify approver ───────────────────────────────────────────────────────
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
            args.status === "CHIEF_OFFICER_APPROVED" || role === "FINANCE"
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
          subject: `[Action Required] Clearance claim awaiting ${roleLabel} action`,
          text: body
        });

        sendTeamsCard({
          title: "Clearance Claim — Action Required",
          summary: `Clearance claim from ${claimant} awaiting ${roleLabel} action`,
          subtitle: `Requires ${roleLabel} action`,
          color: "f59e0b",
          facts: [
            { name: "Claimant", value: claimant },
            { name: "Department", value: department || "—" },
            { name: "Amount", value: fmt(args.claimTotal) },
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
        FINANCE_VERIFIED:       `Your clearance claim has been verified by Finance and is awaiting final settlement.`
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
        subject: `[Update] Clearance claim — ${statusLabel(args.status)}`,
        text: body
      });

      sendTeamsCard({
        title: "Clearance Claim — Status Update",
        summary: `Clearance claim update for ${claimant}: ${statusLabel(args.status)}`,
        subtitle: `Update for ${claimant}`,
        color: "3b82f6",
        facts: [
          { name: "Claimant", value: claimant },
          { name: "Department", value: department || "—" },
          { name: "Amount", value: fmt(args.claimTotal) },
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
      ["Department",      args.department],
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
        { name: "Department", value: args.department || "—" },
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
        ["Department",      args.department],
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
    ["Department", args.department],
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
          { name: "Department", value: args.department || "—" },
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
