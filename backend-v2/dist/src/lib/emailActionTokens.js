import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { env } from "../config/env.js";
import { query } from "./db.js";
export const EMAIL_ACTION_PURPOSE = "EMAIL_ACTION";
// One-click approve/reject-by-email link. The JWT only carries a jti — every
// binding fact (who, which document, which step) lives in email_action_tokens
// so the server can re-validate against live document state when clicked,
// independent of what the token itself claims. Lives outside modules/ so the
// advances/claims/custom-requests route modules (which mint tokens when
// sending notifications) and the email-actions module (which redeems them)
// can both depend on it without importing each other.
export async function createEmailActionToken(args) {
    const jti = randomUUID();
    await query(`INSERT INTO email_action_tokens (jti, user_id, doc_type, doc_id, step_order) VALUES ($1,$2,$3,$4,$5)`, [jti, args.userId, args.docType, args.docId, args.stepOrder]);
    return jwt.sign({ jti, purpose: EMAIL_ACTION_PURPOSE }, env.JWT_SECRET, { expiresIn: "7d" });
}
export function buildEmailActionUrl(token) {
    // EMAIL_ACTION_PUBLIC_URL points at a restricted proxy that already
    // rewrites its path prefix straight to this backend's /email-actions
    // route (see email-actions.routes.ts, which renders a self-contained
    // HTML page for browser requests) - the proxy adds the /email-actions
    // segment itself when forwarding upstream, so the public link must be
    // just "<base>/<token>", not "<base>/email-actions/<token>" (confirmed
    // against a working link: http://dt-internalproxy-1.etl.co.ls/flowdesk/uat/<token>).
    // Falls back to the frontend SPA flow (APP_URL, internal-only) when unset.
    if (env.EMAIL_ACTION_PUBLIC_URL) {
        const base = env.EMAIL_ACTION_PUBLIC_URL.replace(/\/+$/, "").replace(/\/email-actions$/, "");
        return `${base}/${encodeURIComponent(token)}`;
    }
    return `${env.APP_URL}/?email_action=${encodeURIComponent(token)}`;
}
