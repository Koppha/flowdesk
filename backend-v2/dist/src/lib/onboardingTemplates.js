import { env } from "../config/env.js";
// ─── Onboarding email templates ───────────────────────────────────────────────
// Single source of truth for the "welcome / account created" message sent to
// every employee type. Each role can define its own heading/intro/responsibility
// copy; roles without an entry fall back to DEFAULT_COPY. This keeps the wording
// for new roles (or changes to existing ones) in one place instead of scattered
// across notification call sites.
const HR = "─".repeat(55);
const HR2 = "═".repeat(55);
function header(title) {
    return [HR2, `  ADVANCE CLEARANCE SYSTEM`, `  ${title}`, HR2].join("\n");
}
function footer() {
    return [
        HR,
        "This is an automated notification. Please do not reply.",
        HR2
    ].join("\n");
}
function detailBlock(rows) {
    const pad = Math.max(...rows.map(([k]) => k.length));
    return [
        HR,
        ...rows.map(([k, v]) => `  ${k.padEnd(pad)} : ${v || "—"}`),
        HR
    ].join("\n");
}
const STAFF_CLOSING = () => [
    `After signing in, please complete your profile to access all features.`,
    `If you have any issues, contact your system administrator.`
];
const LEADERSHIP_CLOSING = () => [
    `Please sign in and complete your profile at your earliest convenience so that approvals routed to you are not delayed.`,
    `If you have any questions about your role or access, please contact your system administrator.`
];
const DEFAULT_COPY = {
    heading: "WELCOME — YOUR ACCOUNT HAS BEEN CREATED",
    intro: ({ name }) => `Your Advance Clearance System account has been created by an administrator.`,
    closing: STAFF_CLOSING,
    subject: () => `[Welcome] Your Advance Clearance System account is ready`,
    accentColor: "8b5cf6",
    teamsTitle: "New User Onboarded"
};
/**
 * Per-role onboarding copy. Add an entry here to give a role its own welcome
 * wording — anything not listed uses DEFAULT_COPY.
 */
export const ONBOARDING_TEMPLATES = {
    CEO: {
        heading: "WELCOME — YOUR EXECUTIVE ACCOUNT IS READY",
        intro: ({ roleLabel }) => `An executive account has been created for you on the Advance Clearance System as ${roleLabel} — the final point of escalation in the organisation's approval and reporting chain.`,
        responsibility: ({ roleLabel }) => `As ${roleLabel}, requests that reach the top of the approval chain will be routed to you for final review and authorisation. Other Executive Committee (EXCO) members report through you.`,
        closing: LEADERSHIP_CLOSING,
        subject: (roleLabel) => `[Welcome] Your ${roleLabel} account is ready — Advance Clearance System`,
        accentColor: "6d28d9",
        teamsTitle: "New Executive Onboarded"
    },
    EXCO: {
        heading: "WELCOME — YOUR EXECUTIVE ACCOUNT IS READY",
        intro: ({ roleLabel }) => `An executive account has been created for you on the Advance Clearance System as a member of the Executive Committee (${roleLabel}).`,
        responsibility: ({ roleLabel }) => `As an ${roleLabel} member, you'll be responsible for reviewing and authorising requests escalated from your department's leadership before they proceed further up the chain.`,
        closing: LEADERSHIP_CLOSING,
        subject: (roleLabel) => `[Welcome] Your ${roleLabel} account is ready — Advance Clearance System`,
        accentColor: "6d28d9",
        teamsTitle: "New Executive Onboarded"
    },
    CHIEF_OFFICER: {
        heading: "WELCOME — YOUR ACCOUNT HAS BEEN CREATED",
        intro: ({ roleLabel }) => `An account has been created for you on the Advance Clearance System as ${roleLabel}.`,
        responsibility: ({ roleLabel }) => `As ${roleLabel}, requests that pass manager-level review will be routed to you for senior approval before moving on to HR and Finance.`,
        closing: LEADERSHIP_CLOSING,
        subject: (roleLabel) => `[Welcome] Your ${roleLabel} account is ready — Advance Clearance System`,
        accentColor: "1d4ed8",
        teamsTitle: "New Approver Onboarded"
    },
    HOD: {
        heading: "WELCOME — YOUR ACCOUNT HAS BEEN CREATED",
        intro: ({ roleLabel, department }) => `An account has been created for you on the Advance Clearance System as ${roleLabel}${department ? ` for ${department}` : ""}.`,
        responsibility: () => `As Head of Department, requests submitted by your team will come to you first for review before moving further up the approval chain.`,
        closing: LEADERSHIP_CLOSING,
        subject: (roleLabel) => `[Welcome] Your ${roleLabel} account is ready — Advance Clearance System`,
        accentColor: "0f766e",
        teamsTitle: "New Department Lead Onboarded"
    },
    MANAGER: {
        heading: "WELCOME — YOUR ACCOUNT HAS BEEN CREATED",
        intro: ({ roleLabel, department }) => `An account has been created for you on the Advance Clearance System as ${roleLabel}${department ? ` for ${department}` : ""}.`,
        responsibility: () => `As a manager, requests submitted by your team will come to you first for review before moving further up the approval chain.`,
        closing: LEADERSHIP_CLOSING,
        subject: (roleLabel) => `[Welcome] Your ${roleLabel} account is ready — Advance Clearance System`,
        accentColor: "0f766e",
        teamsTitle: "New Manager Onboarded"
    },
    HR_MANAGER: {
        heading: "WELCOME — YOUR ACCOUNT HAS BEEN CREATED",
        intro: ({ roleLabel }) => `An account has been created for you on the Advance Clearance System as ${roleLabel}.`,
        responsibility: () => `As HR Manager, you'll review and action requests once they reach the HR stage of the approval chain, including travel, accommodation and clearance matters.`,
        closing: LEADERSHIP_CLOSING,
        subject: (roleLabel) => `[Welcome] Your ${roleLabel} account is ready — Advance Clearance System`,
        accentColor: "be185d",
        teamsTitle: "New HR Lead Onboarded"
    },
    AUTH_OFFICER: {
        heading: "WELCOME — YOUR ACCOUNT HAS BEEN CREATED",
        intro: ({ roleLabel }) => `An account has been created for you on the Advance Clearance System as ${roleLabel}.`,
        responsibility: () => `As an HR Officer, you'll handle HR-stage reviews — including travel, accommodation, and clearance requests — and help keep staff records up to date.`,
        closing: LEADERSHIP_CLOSING,
        subject: (roleLabel) => `[Welcome] Your ${roleLabel} account is ready — Advance Clearance System`,
        accentColor: "be185d",
        teamsTitle: "New HR Officer Onboarded"
    },
    FINANCE: {
        heading: "WELCOME — YOUR ACCOUNT HAS BEEN CREATED",
        intro: ({ roleLabel }) => `An account has been created for you on the Advance Clearance System as ${roleLabel}.`,
        responsibility: () => `As Finance, you'll be responsible for the final verification and processing of payments for approved advances and settled claims.`,
        closing: LEADERSHIP_CLOSING,
        subject: (roleLabel) => `[Welcome] Your ${roleLabel} account is ready — Advance Clearance System`,
        accentColor: "b45309",
        teamsTitle: "New Finance User Onboarded"
    },
    ADMIN: {
        heading: "WELCOME — YOUR ADMINISTRATOR ACCOUNT IS READY",
        intro: ({ roleLabel }) => `An administrator account has been created for you on the Advance Clearance System.`,
        responsibility: () => `As an administrator, you'll have full access to user management, organisational structure, workflows, and system configuration.`,
        closing: LEADERSHIP_CLOSING,
        subject: () => `[Welcome] Your administrator account is ready — Advance Clearance System`,
        accentColor: "374151",
        teamsTitle: "New Administrator Onboarded"
    },
    EMPLOYEE: DEFAULT_COPY
};
export function onboardingCopyFor(role) {
    return ONBOARDING_TEMPLATES[role] ?? DEFAULT_COPY;
}
/**
 * Builds the full welcome email + Teams card payload for a newly onboarded
 * user, using the role-specific copy where one is defined (falling back to
 * the generic staff welcome otherwise).
 */
export function buildOnboardingMessage(args) {
    const copy = onboardingCopyFor(args.role);
    const ctx = { name: args.name, roleLabel: args.roleLabel, department: args.department };
    const details = detailBlock([
        ["Name", args.name],
        ["Role", args.roleLabel],
        ["Department", args.department]
    ]);
    const bodyLines = [
        header(copy.heading),
        ``,
        `Hello ${args.name},`,
        ``,
        copy.intro(ctx),
        ``,
        details,
        ``,
        ...(copy.responsibility ? [copy.responsibility(ctx), ``] : []),
        HR,
        `  SIGN-IN INSTRUCTIONS`,
        HR,
        `  Sign in here: ${env.APP_URL}`,
        `  ${args.credentialLine.replace(/\n/g, "\n  ")}`,
        HR,
        ``,
        ...copy.closing(ctx),
        ``,
        footer()
    ];
    return {
        subject: copy.subject(args.roleLabel),
        body: bodyLines.join("\n"),
        teams: {
            title: copy.teamsTitle,
            summary: `${args.name} has been onboarded to the Advance Clearance System as ${args.roleLabel}`,
            subtitle: "Account created — awaiting profile completion",
            color: copy.accentColor,
            facts: [
                { name: "Name", value: args.name },
                { name: "Email", value: args.email },
                { name: "Role", value: args.roleLabel },
                { name: "Department", value: args.department || "—" }
            ]
        }
    };
}
