import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { query } from "./db.js";
import { unauthorized } from "./errors.js";

// System-to-system auth, distinct from FlowDesk's own JWT session auth
// (requireAuth in auth.ts). Used by external integrations - e.g. the
// Service Contracts external API - where the caller is another system, not
// a logged-in FlowDesk user. Keys are stored hashed; the raw value is only
// ever returned once, at creation time.

export type ApiKeyedRequest = Request & { apiKeyId?: string };

export async function ensureApiKeysSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label text NOT NULL,
      key_hash text UNIQUE NOT NULL,
      key_prefix text NOT NULL,
      scope text NOT NULL DEFAULT 'service_contracts',
      is_active boolean NOT NULL DEFAULT true,
      created_by_id uuid REFERENCES users(id),
      last_used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// Returns the raw key (show once, never persisted) alongside what gets stored.
export function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `sc_live_${crypto.randomBytes(24).toString("hex")}`;
  return { rawKey, keyHash: hashKey(rawKey), keyPrefix: rawKey.slice(0, 12) };
}

export function requireApiKey(scope: string) {
  return async (req: ApiKeyedRequest, _res: Response, next: NextFunction) => {
    try {
      const header = req.header("X-API-Key");
      if (!header) return next(unauthorized("Missing API key"));
      const rows = await query<{ id: string }>(
        `SELECT id FROM api_keys WHERE key_hash=$1 AND scope=$2 AND is_active=true LIMIT 1`,
        [hashKey(header), scope]
      );
      const row = rows[0];
      if (!row) return next(unauthorized("Invalid API key"));
      req.apiKeyId = row.id;
      query(`UPDATE api_keys SET last_used_at=now() WHERE id=$1`, [row.id]).catch(() => {});
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
