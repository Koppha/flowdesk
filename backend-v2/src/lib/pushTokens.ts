import { query } from "./db.js";

// Expo push tokens for the FlowDesk Mobile app - one row per (user, device),
// since the same person can be signed in on more than one phone. Storage
// only for now; nothing sends through these yet (see the FlowDesk Mobile
// write-up's Notification delivery section) - a later change wires
// notifications.ts's existing call sites to push a message here too,
// alongside the emails/in-app notices they already send.
export async function ensurePushTokensSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS mobile_push_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expo_push_token text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, expo_push_token)
    )
  `);
}

export async function saveMobilePushToken(userId: string, expoPushToken: string) {
  await query(
    `INSERT INTO mobile_push_tokens (user_id, expo_push_token)
     VALUES ($1, $2)
     ON CONFLICT (user_id, expo_push_token) DO UPDATE SET updated_at = now()`,
    [userId, expoPushToken]
  );
}

// Per-user notification preferences, set from FlowDesk Mobile (Profile >
// Notifications). No row = everything on. Every lookup fails open: if it
// errors, the notification is sent as before rather than silently dropped.
let notificationPrefsReady: Promise<void> | null = null;
export function ensureNotificationPrefsSchema() {
  notificationPrefsReady ??= query(`
    CREATE TABLE IF NOT EXISTS user_notification_prefs (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      email_enabled boolean NOT NULL DEFAULT true,
      push_enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `).then(() => undefined).catch((err) => {
    notificationPrefsReady = null;
    throw err;
  });
  return notificationPrefsReady;
}

export type NotificationPrefs = { email: boolean; push: boolean };

export async function getNotificationPrefs(userId: string): Promise<NotificationPrefs> {
  await ensureNotificationPrefsSchema();
  const row = (
    await query<{ email_enabled: boolean; push_enabled: boolean }>(
      `SELECT email_enabled, push_enabled FROM user_notification_prefs WHERE user_id = $1`,
      [userId]
    )
  )[0];
  return { email: row?.email_enabled ?? true, push: row?.push_enabled ?? true };
}

export async function setNotificationPrefs(userId: string, prefs: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
  const next = { ...(await getNotificationPrefs(userId)), ...prefs };
  await query(
    `INSERT INTO user_notification_prefs (user_id, email_enabled, push_enabled, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET email_enabled = $2, push_enabled = $3, updated_at = now()`,
    [userId, next.email, next.push]
  );
  return next;
}

/** Drops recipients who switched email notifications off. */
export async function filterEmailRecipients(emails: string[]): Promise<string[]> {
  if (!emails.length) return emails;
  try {
    await ensureNotificationPrefsSchema();
    const rows = await query<{ email: string }>(
      `SELECT lower(u.email) AS email
         FROM users u JOIN user_notification_prefs p ON p.user_id = u.id
        WHERE p.email_enabled = false AND lower(u.email) = ANY($1::text[])`,
      [emails.map((e) => String(e).toLowerCase())]
    );
    const off = new Set(rows.map((r) => r.email));
    return emails.filter((e) => !off.has(String(e).toLowerCase()));
  } catch {
    return emails;
  }
}

export async function isPushEnabled(userId: string): Promise<boolean> {
  try {
    return (await getNotificationPrefs(userId)).push;
  } catch {
    return true;
  }
}
