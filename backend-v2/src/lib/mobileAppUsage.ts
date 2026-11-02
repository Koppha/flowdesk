import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";

// FlowDesk Mobile usage: how many requests each person's app makes per day,
// and when they were last seen (so Analytics can show who is online now).
// Counted in requireAuth for calls carrying X-Flowdesk-Client: mobile - the
// app and its server-built pages (Sign a Document, Maintenance) all send it.
//
// Counts are kept in memory and written once every FLUSH_MS as one upsert per
// person, so a busy app never costs a database write per API call. A restart
// loses at most that window's counts.

const FLUSH_MS = 30_000;
/** Seen within this long = "online now". */
export const ONLINE_WINDOW_MINUTES = 5;

let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  schemaReady ??= (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS mobile_app_usage (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day date NOT NULL,
        requests int NOT NULL DEFAULT 0,
        last_seen timestamptz NOT NULL,
        PRIMARY KEY (user_id, day)
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_mobile_app_usage_last_seen ON mobile_app_usage (last_seen DESC)`);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

const pending = new Map<string, number>();

/** Called once per authenticated mobile request (lib/auth.ts requireAuth). */
export function trackMobileRequest(userId: string) {
  pending.set(userId, (pending.get(userId) || 0) + 1);
}

async function flush() {
  if (!pending.size) return;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    await ensureSchema();
    // "day" is the Lesotho calendar day, so the daily numbers match people's days.
    await query(
      `INSERT INTO mobile_app_usage (user_id, day, requests, last_seen)
       SELECT u.user_id, (now() AT TIME ZONE 'Africa/Maseru')::date, u.n, now()
         FROM unnest($1::uuid[], $2::int[]) AS u(user_id, n)
         JOIN users ON users.id = u.user_id
       ON CONFLICT (user_id, day) DO UPDATE
         SET requests = mobile_app_usage.requests + EXCLUDED.requests, last_seen = EXCLUDED.last_seen`,
      [batch.map(([id]) => id), batch.map(([, n]) => n)]
    );
  } catch (error) {
    // Put the counts back so the next flush retries them.
    for (const [id, n] of batch) pending.set(id, (pending.get(id) || 0) + n);
    logger.warn("mobile_usage_flush_failed", { error: serializeError(error) });
  }
}

if (process.env.NODE_ENV !== "test") {
  setInterval(() => void flush(), FLUSH_MS).unref();
}

export type MobileUsage = {
  onlineNow: { userId: string; fullName: string | null; lastSeen: string }[];
  requestsToday: number;
  /** Per person: requests in the last 30 days and all time. */
  byUser: Map<string, { last30Days: number; total: number; lastSeen: string }>;
};

export async function getMobileUsage(): Promise<MobileUsage> {
  await flush();
  await ensureSchema();
  const [online, [today], perUser] = await Promise.all([
    query<{ user_id: string; full_name: string | null; last_seen: string }>(
      `SELECT g.user_id, u.full_name, g.last_seen
         FROM (SELECT user_id, max(last_seen) AS last_seen FROM mobile_app_usage GROUP BY user_id) g
         JOIN users u ON u.id = g.user_id
        WHERE g.last_seen > now() - make_interval(mins => $1)
        ORDER BY g.last_seen DESC`,
      [ONLINE_WINDOW_MINUTES]
    ),
    query<{ n: string }>(`SELECT coalesce(sum(requests), 0) AS n FROM mobile_app_usage WHERE day = (now() AT TIME ZONE 'Africa/Maseru')::date`),
    query<{ user_id: string; d30: string; total: string; last_seen: string }>(
      `SELECT user_id,
              coalesce(sum(requests) FILTER (WHERE day > (now() AT TIME ZONE 'Africa/Maseru')::date - 30), 0) AS d30,
              sum(requests) AS total, max(last_seen) AS last_seen
         FROM mobile_app_usage GROUP BY user_id`
    )
  ]);
  return {
    onlineNow: online.map((o) => ({ userId: o.user_id, fullName: o.full_name, lastSeen: o.last_seen })),
    requestsToday: Number(today?.n || 0),
    byUser: new Map(perUser.map((p) => [p.user_id, { last30Days: Number(p.d30), total: Number(p.total), lastSeen: p.last_seen }]))
  };
}
