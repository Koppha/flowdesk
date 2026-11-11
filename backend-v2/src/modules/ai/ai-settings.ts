/**
 * Which AI services the FlowDesk Assistant uses - the services connected
 * (each with its own address and API key), one model list across them in
 * order of preference, daily limit, on/off - set from Settings > AI Assistant
 * and stored in system_state, so moving to another service or a paid model
 * needs no code, .env edit or restart. Until an admin saves them, the backend
 * .env is used as before (AI_PROVIDER, AI_BASE_URL, AI_ASSISTANT_MODEL,
 * AI_API_KEY / ANTHROPIC_API_KEY, AI_ASSISTANT_DAILY_LIMIT).
 *
 * API keys are stored encrypted (AES-256-GCM, key derived from JWT_SECRET),
 * never sent back to the browser, and bound to the service and address they
 * were saved for, so no key is ever sent to another service. A service can
 * hold several named keys (say a free and a paid one); its key_id says which
 * one it uses, so switching is a pick and a save. Removing a service keeps
 * its keys, so adding it back later needs no re-entry.
 *
 * People can pick their own model from the admin's list (user_choice); theirs
 * is tried first, then the admin's order as usual.
 */
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../../config/env.js";
import { query } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { getStringSystemSetting, setStringSystemSetting } from "../../lib/systemSettings.js";

const SETTINGS_KEY = "ai_assistant_settings";
const KEYS_KEY = "ai_assistant_api_keys";
// Single-service format (one key) saved before several services were supported.
const LEGACY_KEY_KEY = "ai_assistant_api_key";
// Both PROD nodes re-read the settings this often, so a saved change reaches
// every server without a restart.
const CACHE_MS = 15_000;

export const AI_SERVICES = ["gemini", "groq", "openrouter", "anthropic", "ollama", "custom"] as const;
export type AiService = (typeof AI_SERVICES)[number];
const SERVICE_LABEL: Record<AiService, string> = { gemini: "Google Gemini", groq: "Groq", openrouter: "OpenRouter", anthropic: "Claude", ollama: "Ollama", custom: "Other service" };
// The key that comes from the backend .env rather than one saved here.
export const ENV_KEY_ID = "env";

const stripSlash = (u: string) => u.replace(/\/+$/, "");
export const AiServiceSchema = z.object({
  service: z.enum(AI_SERVICES),
  base_url: z.string().trim().max(300).default("").transform(stripSlash),
  // Which saved key this service uses; none = the first one for it.
  key_id: z.string().trim().max(64).nullable().optional()
});
const AiModelSchema = z.object({ service: z.enum(AI_SERVICES), model: z.string().trim().min(1).max(120) });
export const AiModelsSchema = z.array(AiModelSchema).max(12);
export const AiSettingsSchema = z.object({
  enabled: z.boolean(),
  daily_limit: z.number().int().min(1).max(1000),
  services: z.array(AiServiceSchema).min(1).max(AI_SERVICES.length),
  models: AiModelsSchema.min(1),
  // People may pick their own model from the list above.
  user_choice: z.boolean().default(true)
}).superRefine((s, ctx) => {
  const ids = s.services.map((x) => x.service);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Each service can only be added once" });
  for (const x of s.services) {
    if (x.service !== "anthropic" && !/^https?:\/\/\S+$/i.test(x.base_url)) ctx.addIssue({ code: "custom", message: `${SERVICE_LABEL[x.service]} needs a service address (http:// or https://)` });
  }
  for (const m of s.models) {
    if (!ids.includes(m.service)) ctx.addIssue({ code: "custom", message: `${m.model} is on ${SERVICE_LABEL[m.service]}, which isn't in the services list` });
  }
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

type KeySource = "settings" | "env" | null;
export type AiServiceConfig = { service: AiService; base_url: string; provider: "openai" | "anthropic"; apiKey: string | null; keySource: KeySource };
export type AiConfig = { settings: AiSettings; services: AiServiceConfig[]; source: "settings" | "env" };
// One entry per model, in order, with what's needed to call it.
export type AiModelTarget = AiServiceConfig & { model: string };

export const providerOf = (service: AiService) => (service === "anthropic" ? "anthropic" : "openai");

function serviceFromUrl(url: string): AiService {
  if (/generativelanguage\.googleapis\.com/i.test(url)) return "gemini";
  if (/groq\.com/i.test(url)) return "groq";
  if (/openrouter\.ai/i.test(url)) return "openrouter";
  if (/:11434\b/.test(url)) return "ollama";
  return "custom";
}

function envConfig(): { settings: AiSettings; key: { service: AiService; base_url: string; apiKey: string } | null } {
  const openai = process.env.AI_PROVIDER?.trim().toLowerCase() === "openai";
  const baseUrl = openai ? stripSlash((process.env.AI_BASE_URL || "").trim()) : "";
  const service: AiService = openai ? serviceFromUrl(baseUrl) : "anthropic";
  const models = (process.env.AI_ASSISTANT_MODEL || "").split(",").map((m) => m.trim()).filter(Boolean);
  const apiKey = (openai ? process.env.AI_API_KEY : process.env.ANTHROPIC_API_KEY)?.trim() || null;
  return {
    settings: {
      enabled: true,
      daily_limit: Number(process.env.AI_ASSISTANT_DAILY_LIMIT || 60),
      services: [{ service, base_url: baseUrl }],
      models: (models.length ? models : openai ? [] : ["claude-opus-5-5"]).map((model) => ({ service, model })),
      user_choice: true
    },
    key: apiKey ? { service, base_url: baseUrl, apiKey } : null
  };
}

// Settings saved in the single-service format ({ service, base_url, models: [names] }).
function fromLegacy(o: any): unknown {
  if (!o || typeof o.service !== "string" || !Array.isArray(o.models) || typeof o.models[0] !== "string") return o;
  return {
    enabled: o.enabled ?? true,
    daily_limit: o.daily_limit ?? 60,
    services: [{ service: o.service, base_url: o.base_url || "" }],
    models: o.models.map((model: string) => ({ service: o.service, model }))
  };
}

function cipherKey() {
  return crypto.createHash("sha256").update(`flowdesk-ai-settings:${env.JWT_SECRET}`).digest();
}
function encrypt(plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cipherKey(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}
function decrypt(stored: string): string | null {
  try {
    const [v, iv, tag, data] = stored.split(":");
    if (v !== "v1") return null;
    const d = crypto.createDecipheriv("aes-256-gcm", cipherKey(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    // e.g. JWT_SECRET changed since it was saved - the admin re-enters the key.
    logger.warn("ai_api_key_unreadable");
    return null;
  }
}

type StoredKey = { id: string; service: AiService; base_url: string; name: string; key: string; created_at?: string };

// Every saved key (encrypted), including ones saved before keys had ids and
// names (one per service) and one saved in the single-service format.
async function storedKeys(): Promise<StoredKey[]> {
  const parse = (raw: string | null) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
  const saved = parse(await getStringSystemSetting(KEYS_KEY, null));
  const keys: StoredKey[] = (Array.isArray(saved) ? saved : []).map((k: any) => ({ ...k, id: k.id || `${k.service}-1`, name: k.name || "Saved key" }));
  const legacy = parse(await getStringSystemSetting(LEGACY_KEY_KEY, null));
  if (legacy?.service && legacy?.key && !keys.some((k) => k.service === legacy.service)) keys.push({ ...legacy, id: `${legacy.service}-1`, name: "Saved key" });
  return keys;
}

// The key a service uses at this address: the one picked (key_id), else its
// first saved one, else the .env one - only ever a key saved for this exact
// service and address. A picked key that's since been deleted falls back the
// same way, so the assistant keeps working.
async function keyFor(service: AiService, baseUrl: string, keyId?: string | null, saved?: StoredKey[]): Promise<{ apiKey: string | null; keySource: KeySource }> {
  const fromEnv = envConfig().key;
  const envKey = fromEnv && fromEnv.service === service && fromEnv.base_url === baseUrl ? fromEnv.apiKey : null;
  if (keyId === ENV_KEY_ID && envKey) return { apiKey: envKey, keySource: "env" };
  const mine = (saved ?? (await storedKeys())).filter((k) => k.service === service && k.base_url === baseUrl);
  const match = mine.find((k) => k.id === keyId) || mine[0];
  const apiKey = match ? decrypt(match.key) : null;
  if (apiKey) return { apiKey, keySource: "settings" };
  if (envKey) return { apiKey: envKey, keySource: "env" };
  return { apiKey: null, keySource: null };
}

let cache: { at: number; config: AiConfig } | null = null;

export async function loadAiConfig(): Promise<AiConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.config;
  let settings = envConfig().settings;
  let source: AiConfig["source"] = "env";
  const raw = await getStringSystemSetting(SETTINGS_KEY, null);
  if (raw) {
    try {
      const parsed = AiSettingsSchema.safeParse(fromLegacy(JSON.parse(raw)));
      if (parsed.success) { settings = parsed.data; source = "settings"; }
    } catch { /* unreadable - stay on .env */ }
  }
  const saved = await storedKeys();
  const services: AiServiceConfig[] = [];
  for (const s of settings.services) services.push({ service: s.service, base_url: s.base_url, provider: providerOf(s.service), ...(await keyFor(s.service, s.base_url, s.key_id, saved)) });
  const config: AiConfig = { settings, services, source };
  cache = { at: Date.now(), config };
  return config;
}

// A service can be called once it has what it needs: Claude a key, the
// OpenAI-compatible ones an address (Ollama needs no key).
const usable = (s: AiServiceConfig) => (s.provider === "anthropic" ? Boolean(s.apiKey) : Boolean(s.base_url));

export function modelTargets(c: AiConfig): AiModelTarget[] {
  return c.settings.models.flatMap((m) => {
    const s = c.services.find((x) => x.service === m.service);
    return s && usable(s) ? [{ ...s, model: m.model }] : [];
  });
}

export function aiConfigured(c: AiConfig) {
  return c.settings.enabled && modelTargets(c).length > 0;
}

// ── People's own model ────────────────────────────────────────────────────
export type ModelPick = { service: AiService; model: string };

let prefsReady: Promise<void> | null = null;
function ensurePrefsTable() {
  prefsReady ??= query(
    `CREATE TABLE IF NOT EXISTS ai_user_model_prefs (
       user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       service text NOT NULL,
       model text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  ).then(() => undefined).catch((err) => { prefsReady = null; throw err; });
  return prefsReady;
}

export async function userModelPick(userId: string): Promise<ModelPick | null> {
  await ensurePrefsTable();
  const [row] = await query<{ service: AiService; model: string }>(`SELECT service, model FROM ai_user_model_prefs WHERE user_id = $1`, [userId]);
  return row || null;
}

export async function setUserModelPick(userId: string, pick: ModelPick | null) {
  await ensurePrefsTable();
  if (!pick) await query(`DELETE FROM ai_user_model_prefs WHERE user_id = $1`, [userId]);
  else await query(
    `INSERT INTO ai_user_model_prefs (user_id, service, model) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET service = EXCLUDED.service, model = EXCLUDED.model, updated_at = now()`,
    [userId, pick.service, pick.model]
  );
}

// What people may pick from: the admin's working models, in their order.
export function modelChoices(c: AiConfig) {
  return modelTargets(c).map((t) => ({ service: t.service, model: t.model, label: `${t.model} (${SERVICE_LABEL[t.service]})` }));
}

// The order to try models in for this person: their pick first (when picking
// is allowed and it's still on the list), then the admin's order.
export function targetsFor(c: AiConfig, pick: ModelPick | null): AiModelTarget[] {
  const targets = modelTargets(c);
  if (!c.settings.user_choice || !pick) return targets;
  const i = targets.findIndex((t) => t.service === pick.service && t.model === pick.model);
  return i <= 0 ? targets : [targets[i], ...targets.slice(0, i), ...targets.slice(i + 1)];
}

// Services, models, the key each service uses and the rest. Keys themselves
// are added and removed with addAiKey / removeAiKey.
export async function saveAiSettings(settings: AiSettings) {
  await setStringSystemSetting(SETTINGS_KEY, JSON.stringify(settings));
  // Fold the old single-key setting into the key list for good.
  if (await getStringSystemSetting(LEGACY_KEY_KEY, null)) {
    await setStringSystemSetting(KEYS_KEY, JSON.stringify(await storedKeys()));
    await setStringSystemSetting(LEGACY_KEY_KEY, null);
  }
  cache = null;
}

// Saves another key for a service at an address, under a name (say "Free"
// or "Company paid"). Returns its id, for the service to switch to it.
export async function addAiKey(k: { service: AiService; base_url: string; name: string; key: string }) {
  const keys = await storedKeys();
  const id = `${k.service}-${crypto.randomBytes(4).toString("hex")}`;
  keys.push({ id, service: k.service, base_url: k.base_url, name: k.name.trim(), key: encrypt(k.key.trim()), created_at: new Date().toISOString() });
  await setStringSystemSetting(KEYS_KEY, JSON.stringify(keys));
  await setStringSystemSetting(LEGACY_KEY_KEY, null);
  cache = null;
  return id;
}

export async function removeAiKey(id: string) {
  const keys = await storedKeys();
  if (!keys.some((k) => k.id === id)) return false;
  await setStringSystemSetting(KEYS_KEY, JSON.stringify(keys.filter((k) => k.id !== id)));
  await setStringSystemSetting(LEGACY_KEY_KEY, null);
  cache = null;
  return true;
}

// Switch the assistant on/off from Process > Built-in Processes (request-types
// module flags) - the same `enabled` that Settings > AI Assistant edits, so
// the two screens never disagree. Only `enabled` changes; services, models
// and keys are left exactly as they are.
export async function setAiAssistantEnabled(enabled: boolean) {
  cache = null;
  const current = await loadAiConfig();
  const parsed = AiSettingsSchema.safeParse({ ...current.settings, enabled });
  if (!parsed.success) throw new Error("Set up the AI Assistant in Settings > AI Assistant first");
  await setStringSystemSetting(SETTINGS_KEY, JSON.stringify(parsed.data));
  cache = null;
}

// What the Settings page sees - never a key itself. `keys` lists every key
// available (saved or .env), so a service added back shows its key as saved.
export async function publicAiConfig(c: AiConfig) {
  const hint = (k: string | null) => (k ? `…${k.slice(-4)}` : null);
  const keys: Array<{ id: string; name: string; service: AiService; base_url: string; source: "settings" | "env"; key_hint: string | null; created_at: string | null }> = [];
  for (const k of await storedKeys()) keys.push({ id: k.id, name: k.name, service: k.service, base_url: k.base_url, source: "settings", key_hint: hint(decrypt(k.key)), created_at: k.created_at || null });
  const fromEnv = envConfig().key;
  if (fromEnv) keys.push({ id: ENV_KEY_ID, name: "From the server's .env", service: fromEnv.service, base_url: fromEnv.base_url, source: "env", key_hint: hint(fromEnv.apiKey), created_at: null });
  return { ...c.settings, source: c.source, configured: aiConfigured(c), keys };
}

// ── Talking to a service from the Settings page ───────────────────────────
export type AiTarget = { service: AiService; base_url: string; apiKey: string | null };

// The key typed into the form if any, else the saved key picked for the
// service (key_id), else the one it would use anyway.
export async function resolveTarget(t: { service: AiService; base_url: string; api_key?: string; key_id?: string | null }): Promise<AiTarget> {
  return { service: t.service, base_url: t.base_url, apiKey: t.api_key?.trim() || (await keyFor(t.service, t.base_url, t.key_id)).apiKey };
}

function explain(status: number, body: string) {
  if (/tool/i.test(body) && /not supported|does not support|unsupported/i.test(body)) return "Can't use FlowDesk lookups (no tool calling) - remove it";
  if (status === 401 || status === 403) return "Key rejected - check the API key";
  if (status === 404) return "Model not found for this key";
  // Gemini reports a model with no free allowance at all as "limit: 0".
  if (status === 429) return /limit: 0\b/i.test(body) ? "Not available on this plan (needs billing)" : /PerDay/i.test(body) ? "Daily quota used up" : "Out of quota or rate-limited";
  if (status === 503) return "Busy (high demand) - try again later";
  const m = body.match(/"message"\s*:\s*"([^"]{1,160})/);
  return m ? m[1] : `Error ${status}`;
}

// Chat-capable models the key can use, for the Settings page's picker.
export async function listAiModels(t: AiTarget): Promise<string[]> {
  if (t.service === "anthropic") {
    if (!t.apiKey) throw new Error("Enter the API key first");
    const page = await new Anthropic({ apiKey: t.apiKey }).models.list({ limit: 100 });
    return page.data.map((m) => m.id);
  }
  const r = await fetch(`${t.base_url}/models`, { headers: t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(explain(r.status, text));
  const ids = ((JSON.parse(text)?.data as any[]) || []).map((m) => String(m.id || "").replace(/^models\//, "")).filter(Boolean);
  // Speech, image, embedding, research-agent and similar models can't hold
  // this kind of conversation.
  return ids.filter((id) => !/embed|tts|image|audio|live|transcri|whisper|robotics|computer-use|guard|veo|imagen|banana|moderation|antigravity|deep-research|lyria|content-safety|^aqa$/i.test(id)).sort();
}

// One tiny request per model, in order - shows which ones work right now.
// It offers a lookup tool, as every real question does, so a model that can't
// call tools fails here instead of in the chat.
const TEST_TOOL = { name: "list_my_advances", description: "Look up the signed-in person's advances." };
export async function testAiModel(t: AiTarget, model: string) {
  const started = Date.now();
  try {
    if (t.service === "anthropic") {
      if (!t.apiKey) throw new Error("No API key for Claude");
      await new Anthropic({ apiKey: t.apiKey }).messages.create({
        model, max_tokens: 16, messages: [{ role: "user", content: "Reply with just: OK" }],
        tools: [{ ...TEST_TOOL, input_schema: { type: "object", properties: {} } }]
      });
    } else {
      const r = await fetch(`${t.base_url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with just: OK" }], tools: [{ type: "function", function: TEST_TOOL }] }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!r.ok) throw new Error(explain(r.status, await r.text().catch(() => "")));
      await r.text();
    }
    return { service: t.service, model, ok: true, ms: Date.now() - started, message: "Working" };
  } catch (err: any) {
    const message = err instanceof Anthropic.APIError ? explain(err.status ?? 0, String(err.message)) : err?.name === "TimeoutError" ? "No answer within 30 seconds" : String(err?.message || err);
    return { service: t.service, model, ok: false, ms: Date.now() - started, message };
  }
}
