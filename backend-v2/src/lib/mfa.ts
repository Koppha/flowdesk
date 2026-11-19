import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { env } from "../config/env.js";
import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";
import { sendPushToUser } from "./push.js";
import { isPushEnabled } from "./pushTokens.js";
import { getStringSystemSetting, setStringSystemSetting } from "./systemSettings.js";

// Two-step sign-in (CBL/LCA DFS Security Guidelines 3.2.5 - MFA, no SMS).
//
// After the password (AD or local) checks out, a user with two-step sign-in
// gets a short-lived challenge instead of a session. They finish it with a
// 6-digit code from an authenticator app (TOTP, RFC 6238), a one-time
// recovery code, or - for a portal sign-in - by tapping Approve on the push
// FlowDesk Mobile receives. Users the policy requires who haven't set it up
// yet get a SETUP challenge: they set up the authenticator before any session
// is issued.

const ISSUER = "FlowDesk";
const STEP_SECONDS = 30;
const DIGITS = 6;
const LOGIN_TTL_MINUTES = 5;
const SETUP_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RECOVERY_CODES = 10;

let schemaReady: Promise<void> | null = null;

export function ensureMfaSchema() {
  schemaReady ??= (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS user_mfa (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret_enc text,
        pending_secret_enc text,
        enabled_at timestamptz,
        last_step bigint NOT NULL DEFAULT 0,
        recovery_hashes text[] NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await query(`
      CREATE TABLE IF NOT EXISTS mfa_challenges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash text NOT NULL UNIQUE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose text NOT NULL,
        username text NOT NULL,
        client text NOT NULL,
        ip text,
        user_agent text,
        status text NOT NULL DEFAULT 'PENDING',
        attempts integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        decided_at timestamptz
      )`);
    await query(`CREATE INDEX IF NOT EXISTS mfa_challenges_user_idx ON mfa_challenges (user_id, status)`);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

// ── Secrets at rest: AES-256-GCM. MFA_ENCRYPTION_KEY if set, else derived
// from JWT_SECRET (changing that key means everyone sets up again).
function key() {
  return createHash("sha256").update(`flowdesk-mfa:${process.env.MFA_ENCRYPTION_KEY || env.JWT_SECRET}`).digest();
}
function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}
function decrypt(stored: string) {
  const [iv, tag, body] = stored.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) - what every authenticator app speaks.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s: string) {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function hotp(secret: Buffer, counter: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  const bin = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}
function sameText(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** The time step the code matches (±1 step for clock drift), or null. */
function matchTotp(secretB32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const step = Math.floor(now / 1000 / STEP_SECONDS);
  for (const s of [step, step - 1, step + 1]) if (sameText(hotp(secret, s), code)) return s;
  return null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normalizeRecovery = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODES }, () => {
    const raw = randomBytes(5).toString("hex"); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// ── Policy: who must use it. Stored in system_state.
export type MfaPolicy = { requiredRoles: string[]; financeSections: boolean; everyone: boolean };
const POLICY_KEY = "mfa_policy";
const DEFAULT_POLICY: MfaPolicy = { requiredRoles: ["ADMIN", "FINANCE"], financeSections: true, everyone: false };

export async function getMfaPolicy(): Promise<MfaPolicy> {
  const raw = await getStringSystemSetting(POLICY_KEY, null);
  if (!raw) return DEFAULT_POLICY;
  try {
    const p = JSON.parse(raw);
    return {
      requiredRoles: Array.isArray(p.requiredRoles) ? p.requiredRoles.filter((r: unknown) => typeof r === "string") : DEFAULT_POLICY.requiredRoles,
      financeSections: typeof p.financeSections === "boolean" ? p.financeSections : DEFAULT_POLICY.financeSections,
      everyone: Boolean(p.everyone)
    };
  } catch {
    return DEFAULT_POLICY;
  }
}
export async function setMfaPolicy(p: MfaPolicy) {
  await setStringSystemSetting(POLICY_KEY, JSON.stringify(p));
}

/** Must this user use two-step sign-in? (Their role, or a finance Department.) */
export async function isMfaRequired(userId: string, role: string): Promise<boolean> {
  const policy = await getMfaPolicy();
  if (policy.everyone || policy.requiredRoles.includes(role)) return true;
  if (!policy.financeSections) return false;
  const rows = await query<{ finance: boolean }>(
    `SELECT COALESCE(s.is_compensation_finance, false) AS finance FROM users u LEFT JOIN sections s ON s.id = u.section_id WHERE u.id = $1`,
    [userId]
  ).catch(() => []);
  return Boolean(rows[0]?.finance);
}

// ── Per-user state
type MfaRow = { secret_enc: string | null; pending_secret_enc: string | null; enabled_at: string | null; last_step: string; recovery_hashes: string[] };
async function row(userId: string) {
  await ensureMfaSchema();
  return (await query<MfaRow>(`SELECT secret_enc, pending_secret_enc, enabled_at, last_step, recovery_hashes FROM user_mfa WHERE user_id = $1`, [userId]))[0] ?? null;
}

export async function getMfaStatus(userId: string, role: string) {
  const r = await row(userId);
  const pushRows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM mobile_push_tokens WHERE user_id = $1`, [userId]).catch(() => [{ n: 0 }]);
  return {
    enabled: Boolean(r?.enabled_at && r.secret_enc),
    enabledAt: r?.enabled_at ?? null,
    required: await isMfaRequired(userId, role),
    recoveryCodesLeft: r?.recovery_hashes?.length ?? 0,
    // Portal sign-ins can be approved on the phone (FlowDesk Mobile with notifications on).
    phoneApproval: (pushRows[0]?.n ?? 0) > 0 && (await isPushEnabled(userId).catch(() => false))
  };
}

/** A new secret to scan; replaces any earlier unconfirmed one. */
export async function startSetup(userId: string, label: string) {
  await ensureMfaSchema();
  const secret = base32Encode(randomBytes(20));
  await query(
    `INSERT INTO user_mfa (user_id, pending_secret_enc) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET pending_secret_enc = EXCLUDED.pending_secret_enc, updated_at = now()`,
    [userId, encrypt(secret)]
  );
  const otpauthUrl =
    `otpauth://totp/${encodeURIComponent(`${ISSUER}:${label}`)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  return { secret, otpauthUrl };
}

/** Confirm the first code from the app: turns it on and returns fresh recovery codes. */
export async function confirmSetup(userId: string, code: string) {
  const r = await row(userId);
  if (!r?.pending_secret_enc) throw new Error("Start the setup again - it expired or was already finished.");
  const secret = decrypt(r.pending_secret_enc);
  const step = matchTotp(secret, code.trim());
  if (step === null) throw new Error("That code didn't match. Check the time on your phone is automatic, then try the newest code.");
  const codes = newRecoveryCodes();
  await query(
    `UPDATE user_mfa SET secret_enc = $2, pending_secret_enc = NULL, enabled_at = now(), last_step = $3,
            recovery_hashes = $4, updated_at = now() WHERE user_id = $1`,
    [userId, encrypt(secret), step, codes.map((c) => sha256(normalizeRecovery(c)))]
  );
  logger.info("mfa_enabled", { user_id: userId });
  return codes;
}

/**
 * Check an authenticator code or a recovery code (used up). Codes are
 * single-use: a step at or before the last accepted one is refused.
 */
export async function verifyCode(userId: string, input: string): Promise<"totp" | "recovery" | null> {
  const r = await row(userId);
  if (!r?.enabled_at || !r.secret_enc) return null;
  const code = input.trim();
  const step = matchTotp(decrypt(r.secret_enc), code.replace(/\s/g, ""));
  if (step !== null) {
    const updated = await query(`UPDATE user_mfa SET last_step = $2, updated_at = now() WHERE user_id = $1 AND last_step < $2 RETURNING user_id`, [userId, step]);
    return updated.length ? "totp" : null;
  }
  const hash = sha256(normalizeRecovery(code));
  if (normalizeRecovery(code).length === 10 && r.recovery_hashes.includes(hash)) {
    const updated = await query(
      `UPDATE user_mfa SET recovery_hashes = array_remove(recovery_hashes, $2), updated_at = now() WHERE user_id = $1 AND $2 = ANY(recovery_hashes) RETURNING user_id`,
      [userId, hash]
    );
    if (updated.length) {
      logger.info("mfa_recovery_code_used", { user_id: userId, left: r.recovery_hashes.length - 1 });
      return "recovery";
    }
  }
  return null;
}

export async function regenerateRecoveryCodes(userId: string) {
  const codes = newRecoveryCodes();
  await query(`UPDATE user_mfa SET recovery_hashes = $2, updated_at = now() WHERE user_id = $1`, [userId, codes.map((c) => sha256(normalizeRecovery(c)))]);
  return codes;
}

export async function disableMfa(userId: string) {
  await ensureMfaSchema();
  await query(`DELETE FROM user_mfa WHERE user_id = $1`, [userId]);
  await query(`UPDATE mfa_challenges SET status = 'CANCELLED' WHERE user_id = $1 AND status = 'PENDING'`, [userId]);
}

// ── Challenges
export type ChallengePurpose = "LOGIN" | "SETUP";
export type Challenge = {
  id: string; user_id: string; purpose: ChallengePurpose; username: string; client: string;
  ip: string | null; user_agent: string | null; status: string; attempts: number; created_at: string; expires_at: string;
};

export async function createChallenge(args: { userId: string; purpose: ChallengePurpose; username: string; client: "web" | "mobile"; ip?: string | null; userAgent?: string | null }) {
  await ensureMfaSchema();
  const token = randomBytes(32).toString("base64url");
  const minutes = args.purpose === "SETUP" ? SETUP_TTL_MINUTES : LOGIN_TTL_MINUTES;
  const created = await query<{ id: string }>(
    `INSERT INTO mfa_challenges (token_hash, user_id, purpose, username, client, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' minutes')::interval) RETURNING id`,
    [sha256(token), args.userId, args.purpose, args.username, args.client, args.ip ?? null, (args.userAgent || "").slice(0, 300) || null, String(minutes)]
  );
  return { token, id: created[0].id };
}

/** The live challenge for a token (PENDING or APPROVED, not expired), or null. */
export async function challengeByToken(token: unknown, purpose: ChallengePurpose): Promise<Challenge | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  await ensureMfaSchema();
  return (
    await query<Challenge>(
      `SELECT id, user_id, purpose, username, client, ip, user_agent, status, attempts, created_at, expires_at
         FROM mfa_challenges
        WHERE token_hash = $1 AND purpose = $2 AND status IN ('PENDING', 'APPROVED') AND expires_at > now()`,
      [sha256(token), purpose]
    )
  )[0] ?? null;
}

/** A wrong code: count it, and kill the challenge after MAX_ATTEMPTS. */
export async function recordFailedAttempt(id: string) {
  await query(
    `UPDATE mfa_challenges SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= $2 THEN 'FAILED' ELSE status END
      WHERE id = $1`,
    [id, MAX_ATTEMPTS]
  );
}

/** Mark a challenge used. Returns false if someone else already did (single use). */
export async function consumeChallenge(id: string) {
  const r = await query(`UPDATE mfa_challenges SET status = 'USED', decided_at = COALESCE(decided_at, now()) WHERE id = $1 AND status IN ('PENDING', 'APPROVED') RETURNING id`, [id]);
  return r.length > 0;
}

/** Any challenge's status by its token, live or not (DENIED, FAILED, USED...). */
export async function challengeStatus(token: unknown) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  return (await query<{ status: string }>(`SELECT status FROM mfa_challenges WHERE token_hash = $1`, [sha256(token)]))[0] ?? null;
}

/** Portal sign-ins waiting on my approval in FlowDesk Mobile. */
export async function pendingApprovals(userId: string) {
  await ensureMfaSchema();
  return query<{ id: string; client: string; ip: string | null; user_agent: string | null; created_at: string; expires_at: string }>(
    `SELECT id, client, ip, user_agent, created_at, expires_at FROM mfa_challenges
      WHERE user_id = $1 AND purpose = 'LOGIN' AND client = 'web' AND status = 'PENDING' AND expires_at > now()
      ORDER BY created_at DESC`,
    [userId]
  );
}

export async function decideApproval(userId: string, id: string, approve: boolean) {
  const r = await query(
    `UPDATE mfa_challenges SET status = $3, decided_at = now()
      WHERE id = $1 AND user_id = $2 AND purpose = 'LOGIN' AND client = 'web' AND status = 'PENDING' AND expires_at > now()
      RETURNING id`,
    [id, userId, approve ? "APPROVED" : "DENIED"]
  );
  if (r.length) logger.info(approve ? "mfa_phone_approved" : "mfa_phone_denied", { user_id: userId, challenge_id: id });
  return r.length > 0;
}

/** Ask FlowDesk Mobile to approve a portal sign-in. */
export function pushApprovalRequest(userId: string, challengeId: string, ip: string | null) {
  void sendPushToUser(userId, {
    title: "Approve your FlowDesk sign-in?",
    body: `Someone is signing in to the FlowDesk portal${ip ? ` from ${ip}` : ""}. Tap to approve or deny.`,
    data: { type: "MFA_APPROVE", id: challengeId }
  }).catch((err) => logger.warn("mfa_push_failed", { user_id: userId, error: serializeError(err) }));
}
