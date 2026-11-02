import { query } from "./db.js";

// Lightweight event log for FlowDesk Mobile - downloads and logins, read
// back by the admin "Analytics" tab (MobileAppConfig.tsx). Deliberately not
// a general API-call telemetry system - just the two events an admin
// actually asked to see ("downloads, and app logins and usage"), logins
// standing in for usage since instrumenting every endpoint would be a much
// bigger, more invasive system than was asked for.
export async function ensureMobileAppEventsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS mobile_app_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type text NOT NULL,
      user_id uuid REFERENCES users(id),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mobile_app_events_type_created ON mobile_app_events (event_type, created_at DESC)`);
}

// LOGIN = signed in with a password through the app. OPEN = the app was
// opened or unlocked on an existing session (biometrics/PIN, or back from the
// background) - most daily use never touches /auth/login, so without it the
// numbers only showed first sign-ins.
export type MobileAppEventType = "DOWNLOAD" | "LOGIN" | "OPEN";

export async function recordMobileAppEvent(eventType: MobileAppEventType, userId: string | null, metadata: Record<string, unknown> = {}) {
  await query(`INSERT INTO mobile_app_events (event_type, user_id, metadata) VALUES ($1, $2, $3)`, [
    eventType,
    userId,
    JSON.stringify(metadata)
  ]);
}

/** An OPEN, at most one per person per 15 minutes - switching apps back and forth isn't 20 uses. */
export async function recordMobileAppOpen(userId: string, metadata: Record<string, unknown>) {
  await query(
    `INSERT INTO mobile_app_events (event_type, user_id, metadata)
     SELECT 'OPEN', $1, $2
      WHERE NOT EXISTS (
        SELECT 1 FROM mobile_app_events
         WHERE event_type IN ('OPEN', 'LOGIN') AND user_id = $1 AND created_at > now() - interval '15 minutes'
      )`,
    [userId, JSON.stringify(metadata)]
  );
}

/** App version and platform the mobile app sends with every call (lib/api.ts in the app). */
export function clientInfo(headers: Record<string, unknown>) {
  const version = typeof headers["x-flowdesk-app-version"] === "string" ? headers["x-flowdesk-app-version"].slice(0, 20) : "";
  const platform = typeof headers["x-flowdesk-platform"] === "string" ? headers["x-flowdesk-platform"].slice(0, 12) : "";
  return { ...(version ? { version } : {}), ...(platform ? { platform } : {}) };
}

export type MobileAppUserRow = {
  userId: string;
  fullName: string | null;
  department: string | null;
  firstSeen: string;
  lastActive: string;
  logins: number;
  opens: number;
  version: string | null;
  push: boolean;
};

export type MobileAppAnalytics = {
  totalDownloads: number;
  totalLogins: number;
  uniqueLoginUsers: number;
  /** Distinct people who signed in or opened the app in the window. */
  active: { today: number; last7Days: number; last30Days: number };
  pushEnabledUsers: number;
  /** Last 30 days, oldest first: distinct active people per day. */
  daily: { day: string; users: number }[];
  /** App version each person last used, counted. */
  versions: { version: string; users: number }[];
  users: MobileAppUserRow[];
  recentDownloads: { createdAt: string; fullName: string | null; version: string | null }[];
  recentLogins: { createdAt: string; fullName: string | null }[];
};

export async function getMobileAppAnalytics(): Promise<MobileAppAnalytics> {
  const usage = `event_type IN ('LOGIN', 'OPEN')`;
  // Days are counted on the database clock in Lesotho time, so "today" means today here.
  const [[active], [push], daily, users] = await Promise.all([
    query<{ today: string; d7: string; d30: string }>(`
      SELECT count(DISTINCT user_id) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Maseru')::date = (now() AT TIME ZONE 'Africa/Maseru')::date) AS today,
             count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '7 days') AS d7,
             count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '30 days') AS d30
        FROM mobile_app_events WHERE ${usage}`),
    // mobile_push_tokens only exists once a device has registered.
    query<{ n: string }>(`SELECT CASE WHEN to_regclass('public.mobile_push_tokens') IS NULL THEN 0 ELSE (SELECT count(DISTINCT user_id) FROM mobile_push_tokens) END AS n`),
    query<{ day: string; users: string }>(`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
             (SELECT count(DISTINCT user_id) FROM mobile_app_events
               WHERE ${usage} AND (created_at AT TIME ZONE 'Africa/Maseru')::date = d) AS users
        FROM generate_series((now() AT TIME ZONE 'Africa/Maseru')::date - 29, (now() AT TIME ZONE 'Africa/Maseru')::date, interval '1 day') AS g(d)
       ORDER BY d`),
    query<any>(`
      SELECT e.user_id, u.full_name, u.department,
             min(e.created_at) AS first_seen, max(e.created_at) AS last_active,
             count(*) FILTER (WHERE e.event_type = 'LOGIN') AS logins,
             count(*) FILTER (WHERE e.event_type = 'OPEN') AS opens,
             (array_agg(e.metadata->>'version' ORDER BY e.created_at DESC) FILTER (WHERE e.metadata->>'version' IS NOT NULL))[1] AS version,
             CASE WHEN to_regclass('public.mobile_push_tokens') IS NULL THEN false
                  ELSE EXISTS (SELECT 1 FROM mobile_push_tokens t WHERE t.user_id = e.user_id) END AS push
        FROM mobile_app_events e JOIN users u ON u.id = e.user_id
       WHERE e.${usage}
       GROUP BY e.user_id, u.full_name, u.department
       ORDER BY last_active DESC
       LIMIT 500`)
  ]);
  const versionCounts = new Map<string, number>();
  for (const u of users) {
    const v = u.version || "Older than 1.0.7";
    versionCounts.set(v, (versionCounts.get(v) || 0) + 1);
  }

  const [[downloadCount], [loginCount], [uniqueLogins], recentDownloads, recentLogins] = await Promise.all([
    query<{ count: string }>(`SELECT count(*) FROM mobile_app_events WHERE event_type = 'DOWNLOAD'`),
    query<{ count: string }>(`SELECT count(*) FROM mobile_app_events WHERE event_type = 'LOGIN'`),
    query<{ count: string }>(`SELECT count(DISTINCT user_id) FROM mobile_app_events WHERE event_type = 'LOGIN'`),
    query<{ created_at: string; full_name: string | null; version: string | null }>(`
      SELECT e.created_at, u.full_name, e.metadata->>'version' AS version
        FROM mobile_app_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.event_type = 'DOWNLOAD'
       ORDER BY e.created_at DESC LIMIT 20
    `),
    query<{ created_at: string; full_name: string | null }>(`
      SELECT e.created_at, u.full_name
        FROM mobile_app_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.event_type = 'LOGIN'
       ORDER BY e.created_at DESC LIMIT 20
    `)
  ]);

  return {
    totalDownloads: Number(downloadCount?.count || 0),
    totalLogins: Number(loginCount?.count || 0),
    uniqueLoginUsers: Number(uniqueLogins?.count || 0),
    active: { today: Number(active?.today || 0), last7Days: Number(active?.d7 || 0), last30Days: Number(active?.d30 || 0) },
    pushEnabledUsers: Number(push?.n || 0),
    daily: daily.map((d) => ({ day: d.day, users: Number(d.users) })),
    versions: [...versionCounts.entries()].map(([version, n]) => ({ version, users: n })).sort((a, b) => b.users - a.users),
    users: users.map((u) => ({
      userId: u.user_id, fullName: u.full_name, department: u.department,
      firstSeen: u.first_seen, lastActive: u.last_active,
      logins: Number(u.logins), opens: Number(u.opens), version: u.version, push: Boolean(u.push)
    })),
    recentDownloads: recentDownloads.map((r) => ({ createdAt: r.created_at, fullName: r.full_name, version: r.version })),
    recentLogins: recentLogins.map((r) => ({ createdAt: r.created_at, fullName: r.full_name }))
  };
}
