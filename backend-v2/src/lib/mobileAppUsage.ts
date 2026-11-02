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
    // The phones each person uses the app on (model, brand, OS), latest first.
    await query(`
      CREATE TABLE IF NOT EXISTS mobile_app_devices (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model text NOT NULL,
        brand text,
        os text,
        first_seen timestamptz NOT NULL DEFAULT now(),
        last_seen timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, model)
      )`);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

const pending = new Map<string, number>();

// ── Devices ──────────────────────────────────────────────────────────────────
export type DeviceInfo = { model: string; brand: string | null; os: string | null };

// Brand from the model code, for when the phone doesn't say (the in-app
// screens' WebView user agent only has the model, e.g. "SM-A556E").
const BRANDS: [RegExp, string][] = [
  [/^(SM-|GT-|Galaxy)/i, "Samsung"], [/^Pixel/i, "Google"], [/^(Redmi|Mi |POCO|M2\d{3}|2\d{3}[A-Z0-9]{4,})/i, "Xiaomi"],
  [/^(HUAWEI|[A-Z]{3}-[A-Z]{1,2}\d)/, "Huawei"], [/^TECNO/i, "Tecno"], [/^Infinix/i, "Infinix"], [/^itel/i, "itel"],
  [/^Nokia/i, "Nokia"], [/^moto/i, "Motorola"], [/^(CPH|OPPO)/i, "Oppo"], [/^(vivo|V2\d{3})/i, "vivo"], [/^(RMX|realme)/i, "realme"],
  [/^(iPhone|iPad)/, "Apple"]
];
const brandOf = (model: string) => BRANDS.find(([re]) => re.test(model))?.[1] ?? null;

/**
 * The phone behind a request: the app's own X-Flowdesk-Device-* headers
 * (1.0.8+), else the WebView user agent of the in-app screens
 * ("…(Linux; Android 16; SM-A556E Build/…; wv)…").
 */
export function deviceFrom(headers: Record<string, unknown>): DeviceInfo | null {
  const h = (k: string) => (typeof headers[k] === "string" ? (headers[k] as string).trim().slice(0, 60) : "");
  const model = h("x-flowdesk-device-model");
  if (model) {
    const os = [h("x-flowdesk-platform") === "ios" ? "iOS" : "Android", h("x-flowdesk-os-version")].filter(Boolean).join(" ");
    const brand = h("x-flowdesk-device-brand");
    // "samsung" -> "Samsung", so the same brand groups together however it was reported.
    return { model, brand: brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : brandOf(model), os: os || null };
  }
  const ua = typeof headers["user-agent"] === "string" ? (headers["user-agent"] as string) : "";
  const android = /Android ([\d.]+); ([^;)]+?)(?: Build\/|;|\))/.exec(ua);
  if (android && android[2].trim() !== "K") return { model: android[2].trim(), brand: brandOf(android[2].trim()), os: `Android ${android[1]}` };
  const ios = /(iPhone|iPad).*? OS (\d+)_(\d+)/.exec(ua);
  if (ios) return { model: ios[1], brand: "Apple", os: `iOS ${ios[2]}.${ios[3]}` };
  return null;
}

const pendingDevices = new Map<string, DeviceInfo & { userId: string }>();

/** Called once per authenticated mobile request (lib/auth.ts requireAuth). */
export function trackMobileRequest(userId: string, device?: DeviceInfo | null) {
  pending.set(userId, (pending.get(userId) || 0) + 1);
  if (device) pendingDevices.set(`${userId}|${device.model}`, { ...device, userId });
}

async function flushDevices() {
  if (!pendingDevices.size) return;
  const batch = [...pendingDevices.values()];
  pendingDevices.clear();
  try {
    await query(
      `INSERT INTO mobile_app_devices (user_id, model, brand, os, last_seen)
       SELECT d.user_id, d.model, d.brand, d.os, now()
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS d(user_id, model, brand, os)
         JOIN users ON users.id = d.user_id
       ON CONFLICT (user_id, model) DO UPDATE
         SET brand = coalesce(EXCLUDED.brand, mobile_app_devices.brand), os = coalesce(EXCLUDED.os, mobile_app_devices.os), last_seen = now()`,
      [batch.map((d) => d.userId), batch.map((d) => d.model), batch.map((d) => d.brand), batch.map((d) => d.os)]
    );
  } catch (error) {
    logger.warn("mobile_device_flush_failed", { error: serializeError(error) });
  }
}

async function flush() {
  await ensureSchema().catch(() => {});
  await flushDevices();
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
  /** Phone models in use (each person counted on their latest phone), most used first. */
  devices: { model: string; brand: string | null; os: string | null; users: number }[];
  /** Each person's latest phone. */
  deviceByUser: Map<string, { model: string; brand: string | null; os: string | null }>;
};

export async function getMobileUsage(): Promise<MobileUsage> {
  await flush();
  await ensureSchema();
  const [online, [today], perUser, latestDevices] = await Promise.all([
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
    ),
    query<{ user_id: string; model: string; brand: string | null; os: string | null }>(
      `SELECT DISTINCT ON (user_id) user_id, model, brand, os FROM mobile_app_devices ORDER BY user_id, last_seen DESC`
    )
  ]);
  const counts = new Map<string, { model: string; brand: string | null; os: string | null; users: number }>();
  for (const d of latestDevices) {
    const key = `${d.brand || ""}|${d.model}`;
    const c = counts.get(key) || { model: d.model, brand: d.brand, os: d.os, users: 0 };
    c.users += 1;
    counts.set(key, c);
  }
  return {
    onlineNow: online.map((o) => ({ userId: o.user_id, fullName: o.full_name, lastSeen: o.last_seen })),
    requestsToday: Number(today?.n || 0),
    byUser: new Map(perUser.map((p) => [p.user_id, { last30Days: Number(p.d30), total: Number(p.total), lastSeen: p.last_seen }])),
    devices: [...counts.values()].sort((a, b) => b.users - a.users),
    deviceByUser: new Map(latestDevices.map((d) => [d.user_id, { model: d.model, brand: d.brand, os: d.os }]))
  };
}
