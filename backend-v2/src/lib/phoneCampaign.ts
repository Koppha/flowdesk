import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";
import { sendPushToUser } from "./push.js";

// "Add your phone number" campaign for FlowDesk Mobile. People with no phone
// on their profile get a push that opens the app's phone screen
// (/web?go=phone, a server-built page). If they still haven't added one, the
// push comes again after a random 7-14 days each (live) - or every 5 minutes
// while testing. It stops as soon as the profile has a phone. Switched on/off
// and between testing/live from the admin Mobile App Configuration screen.
//
// Only phones on app 1.0.8+ are pushed: older builds don't have the /web
// screen the push opens. Every send is claimed with one conditional upsert,
// so two servers running this never push the same person twice.

export const PHONE_CAMPAIGN = "phone";
const MIN_APP_VERSION = [1, 0, 8];
const TICK_MS = 60_000;
const TITLE = "Add your phone number";
const BODY = "Complete your FlowDesk profile so the team can reach you about your requests.";

let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  schemaReady ??= (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS mobile_campaigns (
        key text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT false,
        test_mode boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await query(`
      CREATE TABLE IF NOT EXISTS mobile_campaign_sends (
        campaign text NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pushes int NOT NULL DEFAULT 0,
        first_sent_at timestamptz NOT NULL DEFAULT now(),
        last_sent_at timestamptz NOT NULL DEFAULT now(),
        next_at timestamptz NOT NULL,
        PRIMARY KEY (campaign, user_id)
      )`);
    await query(`INSERT INTO mobile_campaigns (key) VALUES ($1) ON CONFLICT DO NOTHING`, [PHONE_CAMPAIGN]);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

function atLeast(version: string | null | undefined, min: number[]) {
  if (!version) return false;
  const v = version.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((v[i] || 0) !== min[i]) return (v[i] || 0) > min[i];
  }
  return true;
}

// No phone on the profile, a registered device, push not switched off (checked
// in sendPushToUser), and the latest app version they used.
async function audience() {
  return query<{ id: string; version: string | null }>(`
    SELECT u.id,
           (SELECT e.metadata->>'version' FROM mobile_app_events e
             WHERE e.user_id = u.id AND e.event_type IN ('LOGIN', 'OPEN') AND e.metadata ? 'version'
             ORDER BY e.created_at DESC LIMIT 1) AS version
      FROM users u
     WHERE u.is_active AND coalesce(trim(u.phone), '') = ''
       AND EXISTS (SELECT 1 FROM mobile_push_tokens t WHERE t.user_id = u.id)`);
}

async function tick() {
  try {
    await ensureSchema();
    const [c] = await query<{ enabled: boolean; test_mode: boolean }>(`SELECT enabled, test_mode FROM mobile_campaigns WHERE key = $1`, [PHONE_CAMPAIGN]);
    if (!c?.enabled) return;
    for (const person of await audience()) {
      if (!atLeast(person.version, MIN_APP_VERSION)) continue;
      // Testing: again in 5 minutes. Live: a random 7-14 days, per person.
      const minutes = c.test_mode ? 5 : Math.round((7 + Math.random() * 7) * 24 * 60);
      const claimed = await query<{ user_id: string }>(
        `INSERT INTO mobile_campaign_sends (campaign, user_id, pushes, next_at)
         VALUES ($1, $2, 1, now() + make_interval(mins => $3))
         ON CONFLICT (campaign, user_id) DO UPDATE
           SET pushes = mobile_campaign_sends.pushes + 1, last_sent_at = now(), next_at = now() + make_interval(mins => $3)
           WHERE mobile_campaign_sends.next_at <= now()
         RETURNING user_id`,
        [PHONE_CAMPAIGN, person.id, minutes]
      );
      if (!claimed.length) continue;
      await sendPushToUser(person.id, { title: TITLE, body: BODY, data: { url: "/web?go=phone", campaign: PHONE_CAMPAIGN } });
    }
  } catch (error) {
    logger.warn("phone_campaign_tick_failed", { error: serializeError(error) });
  }
}

let started = false;
/** Starts the campaign loop once per process (mobile-app.routes.ts). */
export function startPhoneCampaign() {
  if (started || process.env.NODE_ENV === "test") return;
  started = true;
  setInterval(() => void tick(), TICK_MS).unref();
  setTimeout(() => void tick(), 15_000).unref();
}

export type PhoneCampaignStatus = {
  enabled: boolean;
  testMode: boolean;
  /** Active people with no phone on their profile. */
  missingPhone: number;
  /** ...of whom the campaign can reach now (registered device on app 1.0.8+). */
  reachable: number;
  /** People pushed at least once, and how many of them have since added a phone. */
  reached: number;
  completed: number;
  pushesSent: number;
};

export async function getPhoneCampaign(): Promise<PhoneCampaignStatus> {
  await ensureSchema();
  const [[c], [missing], people, [sends]] = await Promise.all([
    query<{ enabled: boolean; test_mode: boolean }>(`SELECT enabled, test_mode FROM mobile_campaigns WHERE key = $1`, [PHONE_CAMPAIGN]),
    query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE is_active AND coalesce(trim(phone), '') = ''`),
    audience(),
    query<{ reached: string; completed: string; pushes: string }>(
      `SELECT count(*) AS reached,
              count(*) FILTER (WHERE coalesce(trim(u.phone), '') <> '') AS completed,
              coalesce(sum(s.pushes), 0) AS pushes
         FROM mobile_campaign_sends s JOIN users u ON u.id = s.user_id WHERE s.campaign = $1`,
      [PHONE_CAMPAIGN]
    )
  ]);
  return {
    enabled: Boolean(c?.enabled),
    testMode: c?.test_mode ?? true,
    missingPhone: Number(missing?.n || 0),
    reachable: people.filter((p) => atLeast(p.version, MIN_APP_VERSION)).length,
    reached: Number(sends?.reached || 0),
    completed: Number(sends?.completed || 0),
    pushesSent: Number(sends?.pushes || 0)
  };
}

export async function setPhoneCampaign(input: { enabled?: boolean; testMode?: boolean }) {
  await ensureSchema();
  await query(
    `UPDATE mobile_campaigns SET enabled = coalesce($2, enabled), test_mode = coalesce($3, test_mode), updated_at = now() WHERE key = $1`,
    [PHONE_CAMPAIGN, input.enabled ?? null, input.testMode ?? null]
  );
  // Switching to live re-spaces anyone already waiting, so nobody gets a
  // 5-minute test cadence carried into production.
  if (input.testMode === false) {
    await query(
      `UPDATE mobile_campaign_sends SET next_at = last_sent_at + make_interval(mins => (7 * 1440 + floor(random() * 7 * 1440))::int)
        WHERE campaign = $1 AND next_at < last_sent_at + interval '7 days'`,
      [PHONE_CAMPAIGN]
    );
  }
  return getPhoneCampaign();
}

// Exposed for an immediate run after switching it on.
export const runPhoneCampaignNow = tick;
