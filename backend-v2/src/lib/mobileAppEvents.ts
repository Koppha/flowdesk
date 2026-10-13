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

export async function recordMobileAppEvent(eventType: "DOWNLOAD" | "LOGIN", userId: string | null, metadata: Record<string, unknown> = {}) {
  await query(`INSERT INTO mobile_app_events (event_type, user_id, metadata) VALUES ($1, $2, $3)`, [
    eventType,
    userId,
    JSON.stringify(metadata)
  ]);
}

export type MobileAppAnalytics = {
  totalDownloads: number;
  totalLogins: number;
  uniqueLoginUsers: number;
  recentDownloads: { createdAt: string; fullName: string | null; version: string | null }[];
  recentLogins: { createdAt: string; fullName: string | null }[];
};

export async function getMobileAppAnalytics(): Promise<MobileAppAnalytics> {
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
    recentDownloads: recentDownloads.map((r) => ({ createdAt: r.created_at, fullName: r.full_name, version: r.version })),
    recentLogins: recentLogins.map((r) => ({ createdAt: r.created_at, fullName: r.full_name }))
  };
}
