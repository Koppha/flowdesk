import { Router, type Request } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import { requireAuth, requireRole, type AuthedRequest } from "../../lib/auth.js";
import { badRequest, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { loginLimiter } from "../../middleware/rateLimit.js";
import {
  challengeByToken, challengeStatus, confirmSetup, consumeChallenge, createChallenge, decideApproval, disableMfa, ensureMfaSchema,
  getMfaPolicy, getMfaStatus, isMfaRequired, pendingApprovals, pushApprovalRequest, recordFailedAttempt, regenerateRecoveryCodes,
  setMfaPolicy, startSetup, verifyCode, type Challenge
} from "../../lib/mfa.js";

// Two-step sign-in endpoints, mounted at /auth/mfa (see lib/mfa.ts).
// The challenge routes are public - the challenge token, only handed out after
// a correct password, is the credential; everything else needs a session.

type LoginUser = {
  id: string; role: any; full_name: string | null; employee_no: string | null; department: string | null;
  division_id?: string | null; section_id?: string | null; team_id?: string | null; employment_type: string | null; profile_completed: boolean | null;
};
type Issue = (user: LoginUser, username: string) => { token: string; user: unknown };

const clientOf = (req: Request): "web" | "mobile" => (req.headers["x-flowdesk-client"] === "mobile" ? "mobile" : "web");
const ipOf = (req: Request) => (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || null);

/**
 * The end of a correct password check (auth.routes.ts /login): a session, or
 * the two-step sign-in this user still has to pass.
 */
export async function completeLogin(req: Request, user: LoginUser, username: string, issue: Issue) {
  const status = await getMfaStatus(user.id, String(user.role));
  const client = clientOf(req);
  // FlowDesk Mobile before two-step sign-in (1.0.10 and older) would take the
  // challenge for a session and break - tell them to update instead.
  if (client === "mobile" && (status.enabled || status.required) && req.headers["x-flowdesk-mfa"] !== "1") {
    logger.warn("mfa_old_app_blocked", { user_id: user.id, version: String(req.headers["x-flowdesk-app-version"] || "") });
    throw forbidden("Your account uses two-step sign-in, which needs the latest FlowDesk Mobile. Update the app (FlowDesk portal > Get the App), then sign in again.");
  }
  if (status.enabled) {
    const { token, id } = await createChallenge({ userId: user.id, purpose: "LOGIN", username, client, ip: ipOf(req), userAgent: String(req.headers["user-agent"] || "") });
    const phoneApproval = client === "web" && status.phoneApproval;
    if (phoneApproval) pushApprovalRequest(user.id, id, ipOf(req));
    logger.info("mfa_challenge_issued", { user_id: user.id, client, phone_approval: phoneApproval });
    return { mfa: "required" as const, challenge: token, phoneApproval };
  }
  if (status.required) {
    const { token } = await createChallenge({ userId: user.id, purpose: "SETUP", username, client, ip: ipOf(req), userAgent: String(req.headers["user-agent"] || "") });
    logger.info("mfa_setup_required", { user_id: user.id, client });
    return { mfa: "setup" as const, challenge: token };
  }
  return issue(user, username);
}

async function loadUser(userId: string) {
  return (
    await query<LoginUser>(
      `SELECT id, role, full_name, employee_no, department, division_id, section_id, team_id, employment_type, profile_completed
         FROM users WHERE id = $1 AND is_active = true`,
      [userId]
    )
  )[0] ?? null;
}

const CodeSchema = z.object({ challenge: z.string().min(20).max(100).optional(), code: z.string().trim().min(6).max(20) });

export function createMfaRouter(issue: Issue) {
  const router = Router();
  router.use(async (_req, _res, next) => {
    try {
      await ensureMfaSchema();
      next();
    } catch (err) {
      next(err);
    }
  });

  // Finish the session a challenge was for (single use).
  async function finish(c: Challenge) {
    if (!(await consumeChallenge(c.id))) throw unauthorized("This sign-in has already been used. Sign in again.");
    const user = await loadUser(c.user_id);
    if (!user) throw unauthorized("Invalid credentials");
    logger.info("auth_login_success_mfa", { user_id: user.id, client: c.client, purpose: c.purpose });
    return issue(user, c.username);
  }

  // ── Sign-in with a code (authenticator or recovery code).
  router.post("/verify", loginLimiter, async (req, res, next) => {
    try {
      const parsed = CodeSchema.safeParse(req.body);
      if (!parsed.success || !parsed.data.challenge) throw badRequest("Enter the 6-digit code from your authenticator app");
      const c = await challengeByToken(parsed.data.challenge, "LOGIN");
      if (!c) throw unauthorized("This sign-in expired. Sign in again.");
      const how = await verifyCode(c.user_id, parsed.data.code);
      if (!how) {
        await recordFailedAttempt(c.id);
        logger.warn("auth_login_failed_mfa_code", { user_id: c.user_id, attempt: c.attempts + 1 });
        throw unauthorized(c.attempts + 1 >= 5 ? "Too many wrong codes. Sign in again." : "That code didn't work. Try the newest code in your authenticator app.");
      }
      return res.json({ ...(await finish(c)), usedRecoveryCode: how === "recovery" });
    } catch (err) {
      return next(err);
    }
  });

  // ── The portal waiting for an Approve on the phone (polled every few seconds).
  router.get("/approval", async (req, res, next) => {
    try {
      const c = await challengeByToken(req.query.challenge, "LOGIN");
      if (c?.status === "APPROVED") return res.json({ status: "APPROVED", ...(await finish(c)) });
      if (c) return res.json({ status: "PENDING" });
      // Not live any more: denied on the phone, or expired / used up.
      const s = await challengeStatus(req.query.challenge);
      return res.json({ status: s?.status === "DENIED" ? "DENIED" : "EXPIRED" });
    } catch (err) {
      return next(err);
    }
  });

  // ── Setup: during sign-in (SETUP challenge) or from Settings / Profile (session).
  async function setupUser(req: AuthedRequest): Promise<{ userId: string; label: string; challenge: Challenge | null }> {
    const token = req.body?.challenge;
    if (token) {
      const c = await challengeByToken(token, "SETUP");
      if (!c) throw unauthorized("This sign-in expired. Sign in again.");
      return { userId: c.user_id, label: c.username, challenge: c };
    }
    await new Promise<void>((resolve, reject) => requireAuth(req, {} as any, (err?: unknown) => (err ? reject(err) : resolve())));
    return { userId: req.user!.userId, label: req.user!.username || req.user!.userId, challenge: null };
  }

  router.post("/setup/start", async (req: AuthedRequest, res, next) => {
    try {
      const { userId, label } = await setupUser(req);
      const { secret, otpauthUrl } = await startSetup(userId, label);
      const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
      return res.json({ secret, otpauthUrl, qr });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/setup/confirm", loginLimiter, async (req: AuthedRequest, res, next) => {
    try {
      const parsed = CodeSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest("Enter the 6-digit code from your authenticator app");
      const { userId, challenge } = await setupUser(req);
      let recoveryCodes: string[];
      try {
        recoveryCodes = await confirmSetup(userId, parsed.data.code);
      } catch (e: any) {
        if (challenge) await recordFailedAttempt(challenge.id);
        throw badRequest(e?.message || "That code didn't match");
      }
      // During sign-in, setting it up also finishes the sign-in.
      const session = challenge ? await finish(challenge) : null;
      return res.json({ recoveryCodes, ...(session ?? {}) });
    } catch (err) {
      return next(err);
    }
  });

  // ── My two-step sign-in (needs a session).
  router.get("/status", requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      return res.json(await getMfaStatus(req.user!.userId, req.user!.role));
    } catch (err) {
      return next(err);
    }
  });

  router.post("/recovery-codes", requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const parsed = CodeSchema.safeParse(req.body);
      if (!parsed.success || (await verifyCode(req.user!.userId, parsed.data.code)) !== "totp") {
        throw badRequest("Enter a current code from your authenticator app");
      }
      return res.json({ recoveryCodes: await regenerateRecoveryCodes(req.user!.userId) });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/disable", requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (await isMfaRequired(req.user!.userId, req.user!.role)) throw forbidden("Two-step sign-in is required for your role, so it can't be turned off.");
      const parsed = CodeSchema.safeParse(req.body);
      if (!parsed.success || !(await verifyCode(req.user!.userId, parsed.data.code))) throw badRequest("Enter a current code from your authenticator app");
      await disableMfa(req.user!.userId);
      logger.info("mfa_disabled", { user_id: req.user!.userId, by: "self" });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // ── FlowDesk Mobile: approve or deny a portal sign-in.
  router.get("/pending", requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      return res.json({ items: await pendingApprovals(req.user!.userId) });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/approvals/:id", requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const parsed = z.object({ approve: z.boolean() }).safeParse(req.body);
      if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success) throw badRequest("Invalid request");
      if (!(await decideApproval(req.user!.userId, req.params.id, parsed.data.approve))) throw notFound("This sign-in request has expired or was already answered.");
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // ── Admin: who must use it; reset for a lost phone.
  router.get("/policy", requireAuth, requireRole(["ADMIN"]), async (_req, res, next) => {
    try {
      const enrolled = await query<{ user_id: string; full_name: string | null; email: string; role: string; enabled_at: string; recovery_left: number }>(
        `SELECT m.user_id, u.full_name, u.email, u.role, m.enabled_at, coalesce(array_length(m.recovery_hashes, 1), 0) AS recovery_left
           FROM user_mfa m JOIN users u ON u.id = m.user_id
          WHERE m.enabled_at IS NOT NULL ORDER BY u.full_name NULLS LAST`
      );
      return res.json({ policy: await getMfaPolicy(), enrolled });
    } catch (err) {
      return next(err);
    }
  });

  router.put("/policy", requireAuth, requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
    try {
      const parsed = z
        .object({ requiredRoles: z.array(z.string().min(1).max(40)).max(30), financeSections: z.boolean(), everyone: z.boolean() })
        .safeParse(req.body);
      if (!parsed.success) throw badRequest("Invalid policy", parsed.error.flatten());
      await setMfaPolicy(parsed.data);
      logger.info("mfa_policy_changed", { by: req.user!.userId, ...parsed.data });
      return res.json({ policy: parsed.data });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/admin/reset/:userId", requireAuth, requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.userId).success) throw badRequest("Invalid user");
      await disableMfa(req.params.userId);
      logger.info("mfa_disabled", { user_id: req.params.userId, by: req.user!.userId });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
