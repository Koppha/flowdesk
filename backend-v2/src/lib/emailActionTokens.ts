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
  const base = env.EMAIL_ACTION_PUBLIC_URL || env.APP_URL;
  return `${base}/?email_action=${encodeURIComponent(token)}`;
}
