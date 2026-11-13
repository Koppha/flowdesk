import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";

// SMS through ETL's gateway (POST {sender, msisdn, msg, usr, pwd}). Used to
// send FlowDesk notifications by SMS as well as email - e.g. while Outlook is
// down. Settings (gateway, sender, login, on/off) live in the database and are
// changed by admins under Settings, so no server file needs editing. Messages
// are short and carry no links.

export type SmsSettings = { enabled: boolean; notify: boolean; url: string; sender: string; username: string; password: string };

let ready: Promise<void> | null = null;
function ensureTables() {
  ready ??= (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS sms_settings (
        id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled boolean NOT NULL DEFAULT false,
        notify boolean NOT NULL DEFAULT false,
        url text NOT NULL DEFAULT '',
        sender text NOT NULL DEFAULT 'Flowdesk',
        username text NOT NULL DEFAULT '',
        password text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid
      )`);
    await query(`INSERT INTO sms_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
    await query(`
      CREATE TABLE IF NOT EXISTS sms_log (
        id bigserial PRIMARY KEY,
        user_id uuid,
        msisdn text NOT NULL,
        kind text NOT NULL,
        msg text NOT NULL,
        ok boolean NOT NULL,
        response text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await query(`CREATE INDEX IF NOT EXISTS sms_log_created_idx ON sms_log (created_at DESC)`);
  })().catch((err) => { ready = null; throw err; });
  return ready;
}

let cache: { at: number; s: SmsSettings } | null = null;
export async function getSmsSettings(fresh = false): Promise<SmsSettings> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.s;
  await ensureTables();
  const [r] = await query<SmsSettings>(`SELECT enabled, notify, url, sender, username, password FROM sms_settings WHERE id = 1`);
  cache = { at: Date.now(), s: r };
  return r;
}

export async function saveSmsSettings(p: Partial<SmsSettings>, by: string) {
  await ensureTables();
  await query(
    `UPDATE sms_settings SET
        enabled = coalesce($1, enabled), notify = coalesce($2, notify), url = coalesce($3, url),
        sender = coalesce($4, sender), username = coalesce($5, username), password = coalesce($6, password),
        updated_at = now(), updated_by = $7
      WHERE id = 1`,
    [p.enabled ?? null, p.notify ?? null, p.url ?? null, p.sender ?? null, p.username ?? null, p.password ?? null, by]
  );
  return getSmsSettings(true);
}

// Lesotho mobile numbers as the gateway wants them: 266 + 8 digits (5... or 6...).
export function normalizeMsisdn(raw: string | null | undefined): string | null {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 8) d = "266" + d;
  return /^266[56]\d{7}$/.test(d) ? d : null;
}

// One SMS (160 characters at most, links removed).
export function shortSms(text: string) {
  const t = text.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\s+/g, " ").trim();
  return t.length <= 160 ? t : t.slice(0, 159).trimEnd() + "…";
}

export async function sendSms(msisdn: string, msg: string, meta: { kind: string; userId?: string | null }): Promise<{ ok: boolean; response: string }> {
  const s = await getSmsSettings();
  const to = normalizeMsisdn(msisdn);
  const text = shortSms(msg);
  if (!to) return { ok: false, response: "Not a valid Lesotho mobile number" };
  if (!s.enabled || !s.url) return { ok: false, response: "SMS is switched off" };
  let ok = false;
  let response = "";
  try {
    const r = await fetch(s.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: s.sender || "Flowdesk", msisdn: to, msg: text, usr: s.username, pwd: s.password }),
      signal: AbortSignal.timeout(15_000)
    });
    response = (await r.text().catch(() => "")).slice(0, 300);
    ok = r.ok && !/error|fail|invalid|denied/i.test(response);
    if (!r.ok) response = `HTTP ${r.status} ${response}`;
  } catch (err: any) {
    response = err?.name === "TimeoutError" ? "No answer from the SMS gateway within 15 seconds" : String(err?.message || err);
  }
  await query(`INSERT INTO sms_log (user_id, msisdn, kind, msg, ok, response) VALUES ($1, $2, $3, $4, $5, $6)`,
    [meta.userId ?? null, to, meta.kind, text, ok, response]).catch(() => {});
  if (!ok) logger.warn("sms_failed", { msisdn: to, kind: meta.kind, response });
  return { ok, response };
}

// ── Notifications by SMS ────────────────────────────────────────────────────
// Every FlowDesk email is also sent as a short SMS to recipients who have a
// phone on their profile (when switched on). The same text to the same number
// within 10 minutes goes once.
const recent = new Map<string, number>();
export function smsTextForEmail(subject: string) {
  const s = subject.replace(/\s+/g, " ").trim().replace(/^\[([^\]]+)\]\s*/, "$1: ");
  const tail = " Log in to FlowDesk to view.";
  const head = `FlowDesk: ${s}${/[.!?]$/.test(s) ? "" : "."}`;
  return head.length + tail.length <= 160 ? head + tail : shortSms(head);
}

export async function smsForEmail(emails: string[], subject: string) {
  try {
    const s = await getSmsSettings();
    if (!s.enabled || !s.notify || !emails.length) return;
    const people = await query<{ id: string; phone: string | null }>(
      `SELECT id, phone FROM users WHERE lower(email) = ANY($1::text[]) AND is_active AND coalesce(trim(phone), '') <> ''`,
      [emails.map((e) => e.toLowerCase())]
    );
    const text = smsTextForEmail(subject);
    const now = Date.now();
    for (const [k, t] of recent) if (now - t > 600_000) recent.delete(k);
    for (const p of people) {
      const to = normalizeMsisdn(p.phone);
      if (!to) continue;
      const key = `${to}|${text}`;
      if (recent.has(key)) continue;
      recent.set(key, now);
      await sendSms(to, text, { kind: "NOTIFICATION", userId: p.id });
    }
  } catch (err) {
    logger.warn("sms_notification_failed", { error: serializeError(err) });
  }
}

export async function smsStats() {
  await ensureTables();
  const [[u], [l]] = await Promise.all([
    query<{ active: string; with_phone: string; valid: string }>(
      `SELECT count(*) AS active,
              count(*) FILTER (WHERE coalesce(trim(phone), '') <> '') AS with_phone,
              count(*) FILTER (WHERE regexp_replace(coalesce(phone, ''), '\\D', '', 'g') ~ '^(266)?[56][0-9]{7}$') AS valid
         FROM users WHERE is_active`),
    query<{ sent: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE ok) AS sent, count(*) FILTER (WHERE NOT ok) AS failed FROM sms_log WHERE created_at > now() - interval '24 hours'`)
  ]);
  const last = await query(`SELECT msisdn, kind, msg, ok, response, created_at FROM sms_log ORDER BY created_at DESC LIMIT 10`);
  return { active_users: Number(u.active), with_phone: Number(u.with_phone), valid_phone: Number(u.valid), sent_24h: Number(l.sent), failed_24h: Number(l.failed), last };
}
