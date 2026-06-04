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
async function getAssignedDepartmentOwnerRecipients(department, ownerColumn) {
    if (!department?.trim())
        return [];
    const rows = await query(`SELECT owner.email, owner.full_name
       FROM departments d
       JOIN users owner ON owner.id = d.${ownerColumn}
      WHERE lower(trim(d.name)) = lower(trim($1))
        AND owner.is_active = true
      LIMIT 1`, [department]);
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
    if (args.status === "SUBMITTED")
        role = "MANAGER";
    if (args.status === "CHIEF_OFFICER_REVIEW")
        role = "CHIEF_OFFICER";
    if (args.status === "HR_MANAGER_REVIEW")
        role = "HR_MANAGER";
    if (args.status === "HR_REVIEW")
        role = "AUTH_OFFICER";
    if (args.status === "HR_OFFICER")
        role = "FINANCE";
    if (args.status === "APPROVED")
        role = "FINANCE";
    if (!role)
        return;
    try {
        const recipientDepartment = ["HR_MANAGER", "AUTH_OFFICER", "FINANCE"].includes(role) ? null : department;
        const recipients = args.status === "SUBMITTED"
            ? await getAssignedDepartmentOwnerRecipients(department, "manager_user_id")
            : args.status === "CHIEF_OFFICER_REVIEW"
                ? await getAssignedDepartmentOwnerRecipients(department, "exco_user_id")
                : await getRecipients(role, recipientDepartment);
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
    if (args.status === "SETTLED") {
        if (!args.claimantEmail)
            return;
        try {
            await sendMail({
                to: [args.claimantEmail],
                subject: "Clearance claim settled",
                text: `Your clearance claim has been settled.\n\n` +
                    `Claimant: ${claimant}\n` +
                    `Department: ${department || "—"}\n` +
                    `Amount: M${Number(args.claimTotal || 0).toFixed(2)}\n` +
                    `Status: ${args.status}\n`
            });
        }
        catch (error) {
            logger.warn("claim_task_notification_failed", { claim_id: args.claimId, status: args.status, error: serializeError(error) });
        }
        return;
    }
    let roles = [];
    if (args.status === "SUBMITTED")
        roles = ["MANAGER"];
    if (args.status === "MANAGER_APPROVED")
        roles = ["CHIEF_OFFICER"];
    if (args.status === "CHIEF_OFFICER_APPROVED")
        roles = ["AUTH_OFFICER"];
    if (args.status === "HR_OFFICER")
        roles = ["HR_MANAGER"];
    if (args.status === "HR_MANAGER_REVIEW")
        roles = ["FINANCE"];
    if (args.status === "FINANCE_VERIFIED")
        roles = ["FINANCE"];
    if (roles.length === 0)
        return;
    try {
        const recipients = (await Promise.all(roles.map((role) => getRecipients(role, role === "AUTH_OFFICER" || role === "FINANCE" ? null : department)))).flat();
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
export async function notifyUserOnboarded(args) {
    try {
        const recipientName = args.fullName || args.email;
        const role = args.role.replace(/_/g, " ");
        const credentialLine = env.AD_AUTH_ENABLED
            ? `Use your network credentials to sign in. If local login is required, use this temporary password: ${args.temporaryPassword}\n`
            : `Temporary password: ${args.temporaryPassword}\n`;
        await sendMail({
            to: [args.email],
            subject: "Advance Clearance onboarding",
            text: `Hello ${recipientName},\n\n` +
                `You have been onboarded on the Advance Clearance System.\n\n` +
                `Role: ${role}\n` +
                `Section/Department: ${args.sectionOrDepartment || "-"}\n` +
                credentialLine +
                `\nPlease sign in and confirm your profile details.`
        });
    }
    catch (error) {
        logger.warn("user_onboarding_notification_failed", { user_id: args.userId, email: args.email, error: serializeError(error) });
    }
}
