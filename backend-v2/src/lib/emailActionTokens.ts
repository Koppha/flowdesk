import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { env } from "../config/env.js";
import { query } from "./db.js";

export type EmailActionDocType = "ADVANCE" | "CLAIM" | "CUSTOM_REQUEST";

export const EMAIL_ACTION_PURPOSE = "EMAIL_ACTION";

// One-click approve/reject-by-email link. The JWT only carries a jti — every
// binding fact (who, which document, which step) lives in email_action_tokens
// so the server can re-validate against live document state when clicked,
// independent of what the token itself claims. Lives outside modules/ so the
// advances/claims/custom-requests route modules (which mint tokens when
// sending notifications) and the email-actions module (which redeems them)
// can both depend on it without importing each other.
export async function createEmailActionToken(args: {
  userId: string;
  docType: EmailActionDocType;
  docId: string;
  stepOrder: number;
}): Promise<string> {
  const jti = randomUUID();
  await query(
    `INSERT INTO email_action_tokens (jti, user_id, doc_type, doc_id, step_order) VALUES ($1,$2,$3,$4,$5)`,
    [jti, args.userId, args.docType, args.docId, args.stepOrder]
  );
  return jwt.sign({ jti, purpose: EMAIL_ACTION_PURPOSE }, env.JWT_SECRET, { expiresIn: "7d" });
}

export function buildEmailActionUrl(token: string) {
  // EMAIL_ACTION_PUBLIC_URL points at a restricted proxy that forwards
  // straight to this backend's /email-actions route (see
  // email-actions.routes.ts, which renders a self-contained HTML page for
  // browser requests) - no frontend involved, so it works behind any path
  // prefix the proxy adds. The proxy's location block only matches
  // /email-actions/ (see deploy/nginx-email-action-proxy.conf.example), so
  // the segment must be included here; strip it first in case the base
  // already ends in /email-actions, to avoid doubling it up.
  // Falls back to the frontend SPA flow (APP_URL, internal-only) when unset.
  if (env.EMAIL_ACTION_PUBLIC_URL) {
    const base = env.EMAIL_ACTION_PUBLIC_URL.replace(/\/+$/, "").replace(/\/email-actions$/, "");
    return `${base}/email-actions/${encodeURIComponent(token)}`;
  }
  return `${env.APP_URL}/?email_action=${encodeURIComponent(token)}`;
}
