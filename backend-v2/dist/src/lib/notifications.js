import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";
let transporter = null;
function getTransporter() {
    if (!env.SMTP_ENABLED || !env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM)
        return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE,
            auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
        });
    }
    return transporter;
}
async function getRecipients(role, department) {
    const rows = await query(`SELECT email, full_name
       FROM users
      WHERE role = $1
        AND is_active = true
        AND ($2::text IS NULL OR trim(coalesce(department, '')) = trim($2))
      ORDER BY full_name NULLS LAST, email`, [role, department?.trim() || null]);
    return rows.filter((row) => row.email);
}
async function sendMail(args) {
    const mailer = getTransporter();
    if (!mailer || args.to.length === 0)
        return;
    await mailer.sendMail({
        from: env.SMTP_FROM,
        to: args.to.join(", "),
        subject: args.subject,
        text: args.text
    });
}
export async function notifyAdvanceTask(args) {
    const requester = args.requesterName || "Requester";
    const department = args.department || null;
    let role = null;
    if (args.status === "SUBMITTED" && args.advanceType === "TRAVEL_SUBSISTENCE")
        role = "COUNTERSIGN";
    if (args.status === "SUBMITTED" && ["SALARY", "LOAN"].includes(args.advanceType))
        role = "AUTH_OFFICER";
    if (args.status === "COUNTERSIGNED")
        role = "MANAGER";
    if (args.status === "HR_MANAGER_REVIEW")
        role = "HR_MANAGER";
    if (args.status === "AUTH_OFFICER_APPROVED")
        role = "FINANCE";
    if (args.status === "APPROVED")
        role = args.advanceType === "TRAVEL_SUBSISTENCE" ? "AUTH_OFFICER" : "FINANCE";
    if (!role)
        return;
    try {
        const recipientDepartment = role === "FINANCE" || role === "HR_MANAGER" || (role === "AUTH_OFFICER" && args.status === "APPROVED" && args.advanceType === "TRAVEL_SUBSISTENCE")
            ? null
            : department;
        const recipients = await getRecipients(role, recipientDepartment);
        await sendMail({
            to: recipients.map((recipient) => recipient.email),
            subject: `New advance task awaiting ${role}`,
            text: `A new advance request needs your action.\n\n` +
                `Requester: ${requester}\n` +
                `Department: ${department || "—"}\n` +
                `Type: ${args.advanceType}\n` +
                `Amount: M${Number(args.requestedTotal || 0).toFixed(2)}\n` +
                `Status: ${args.status}\n`
        });
    }
    catch (error) {
        logger.warn("advance_task_notification_failed", { advance_id: args.advanceId, status: args.status, error: serializeError(error) });
    }
}
export async function notifyClaimTask(args) {
    const claimant = args.claimantName || "Claimant";
    const department = args.department || null;
    let roles = [];
    if (args.status === "SUBMITTED")
        roles = ["MANAGER"];
    if (args.status === "MANAGER_APPROVED")
        roles = ["CHIEF_OFFICER"];
    if (args.status === "CHIEF_OFFICER_APPROVED")
        roles = ["AUTH_OFFICER", "FINANCE"];
    if (roles.length === 0)
        return;
    try {
        const recipients = (await Promise.all(roles.map((role) => getRecipients(role, role === "FINANCE" ? null : department)))).flat();
        const uniqueRecipients = Array.from(new Map(recipients.map((recipient) => [recipient.email, recipient])).values());
        await sendMail({
            to: uniqueRecipients.map((recipient) => recipient.email),
            subject: `New clearance task awaiting ${roles.join(" and ")}`,
            text: `A new clearance claim needs your action.\n\n` +
                `Claimant: ${claimant}\n` +
                `Department: ${department || "—"}\n` +
                `Amount: M${Number(args.claimTotal || 0).toFixed(2)}\n` +
                `Status: ${args.status}\n`
        });
    }
    catch (error) {
        logger.warn("claim_task_notification_failed", { claim_id: args.claimId, status: args.status, error: serializeError(error) });
    }
}
