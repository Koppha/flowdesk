import { createHash, randomBytes } from "crypto";
import type { Request } from "express";
import { query } from "./db.js";
import { logger } from "./logger.js";

// FlowDesk Mobile stays signed in. Access tokens last 12 hours (lib/auth.ts),
// so a phone opened the next day - often from a notification - found its
// session gone and signed the person out. A phone sign-in now also gets a
// refresh key: kept in the phone's secure storage and only used after the
// app is unlocked with fingerprint / face / PIN, it buys a fresh 12-hour
// session at POST /auth/refresh.
//
// - Rotated on every use; a key that was already swapped is refused, and
//   reusing one (outside a short grace for two requests racing) ends that
//   whole sign-in, since it means the key was copied.
// - Lasts SESSION_DAYS from its last use, so a phone used at least monthly
//   never needs the password; one left unused that long does.
// - Ended by logging out, by an admin's "sign everyone out"
//   (system_state.sessions_cleared_at), and by deactivating the account.
// - Only issued after a complete sign-in (password, plus two-step where the
//   account has it), and only to the app (X-Flowdesk-Client: mobile).

const SESSION_DAYS = 30;
// Two requests can race to refresh with the same key (e.g. app start and a
// screen at once); the loser shouldn't end the sign-in.
const REUSE_GRACE_SECONDS = 30;

const sha256 = (s: string) => createHash("sha256").update(`flowdesk-mobile-session:${s}`).digest("hex");

let schemaReady: Promise<void> | null = null;
export function ensureMobileSessionSchema() {
  schemaReady ??= (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS mobile_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        family_id uuid NOT NULL,
        token_hash text NOT NULL UNIQUE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        username text NOT NULL,
        device text,
        created_at timestamptz NOT NULL DEFAULT now(),
        family_started_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        replaced_at timestamptz,
        revoked_at timestamptz
      )`);
    await query(`CREATE INDEX IF NOT EXISTS mobile_sessions_family_idx ON mobile_sessions (family_id)`);
    await query(`CREATE INDEX IF NOT EXISTS mobile_sessions_user_idx ON mobile_sessions (user_id)`);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

function deviceOf(req: Request) {
  const h = req.headers;
  return [h["x-flowdesk-device-brand"], h["x-flowdesk-device-model"], h["x-flowdesk-platform"], h["x-flowdesk-app-version"]]
    .filter((v) => typeof v === "string" && v)
    .join(" ")
    .slice(0, 200) || null;
}

/** Whether this request comes from an app build that keeps a refresh key. */
export const wantsMobileSession = (req: Request) => req.headers["x-flowdesk-client"] === "mobile" && req.headers["x-flowdesk-refresh"] === "1";

async function insertKey(args: { userId: string; username: string; device: string | null; familyId?: string; familyStartedAt?: string }) {
  const raw = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO mobile_sessions (family_id, token_hash, user_id, username, device, family_started_at, expires_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, COALESCE($6::timestamptz, now()), now() + ($7 || ' days')::interval)`,
    [args.familyId ?? null, sha256(raw), args.userId, args.username, args.device, args.familyStartedAt ?? null, String(SESSION_DAYS)]
  );
  return raw;
}

/** A new sign-in on a phone: its first refresh key. */
export async function startMobileSession(req: Request, userId: string, username: string) {
  await ensureMobileSessionSchema();
  return insertKey({ userId, username, device: deviceOf(req) });
}

type Row = {
  id: string; family_id: string; user_id: string; username: string; device: string | null;
  family_started_at: string; expires_at: string; replaced_at: string | null; revoked_at: string | null;
};

/**
 * Swap a refresh key for a new one. Returns the user and username to issue
 * an access token for, or null when the key can't be used (caller answers 401).
 */
export async function rotateMobileSession(req: Request, rawKey: string): Promise<{ userId: string; username: string; refreshKey: string } | null> {
  await ensureMobileSessionSchema();
  const row = (await query<Row>(
    `SELECT id, family_id, user_id, username, device, family_started_at, expires_at, replaced_at, revoked_at
       FROM mobile_sessions WHERE token_hash = $1`,
    [sha256(rawKey)]
  ))[0];
  if (!row) return null;
  if (row.revoked_at) return null;

  if (row.replaced_at) {
    const ageSeconds = (Date.now() - new Date(row.replaced_at).getTime()) / 1000;
    if (ageSeconds > REUSE_GRACE_SECONDS) {
      // An old key used again: someone has a copy. End this sign-in everywhere.
      await query(`UPDATE mobile_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]);
      logger.warn("mobile_session_reuse", { user_id: row.user_id, family_id: row.family_id });
      return null;
    }
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  // An admin's "sign everyone out" covers phones too.
  const cleared = (await query<{ value: string }>(`SELECT value FROM system_state WHERE key = 'sessions_cleared_at' LIMIT 1`).catch(() => []))[0]?.value;
  if (cleared && Date.parse(cleared) >= new Date(row.family_started_at).getTime()) {
    await query(`UPDATE mobile_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]);
    return null;
  }

  const active = (await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [row.user_id]))[0];
  if (!active?.is_active) return null;

  if (!row.replaced_at) await query(`UPDATE mobile_sessions SET replaced_at = now() WHERE id = $1`, [row.id]);
  const refreshKey = await insertKey({
    userId: row.user_id, username: row.username, device: deviceOf(req) ?? row.device,
    familyId: row.family_id, familyStartedAt: row.family_started_at
  });
  return { userId: row.user_id, username: row.username, refreshKey };
}

/** Log out on the phone: that sign-in's keys stop working. */
export async function endMobileSession(rawKey: string) {
  await ensureMobileSessionSchema();
  await query(
    `UPDATE mobile_sessions SET revoked_at = now()
      WHERE family_id = (SELECT family_id FROM mobile_sessions WHERE token_hash = $1) AND revoked_at IS NULL`,
    [sha256(rawKey)]
  );
}
