import dotenv from "dotenv";
import { z } from "zod";
import { logger } from "../lib/logger.js";

dotenv.config({ override: process.env.NODE_ENV !== "test" });

const booleanFromEnv = (defaultValue: boolean) =>
  z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
      return value;
    }, z.boolean())
    .default(defaultValue);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  CORS_ORIGIN: z.string().optional(),
  // Public URL of the frontend — included as the sign-in link in onboarding emails
  APP_URL: z.string().default("http://10.3.10.59:5174"),
  // Public-internet hostname for one-click email approve/reject links (e.g. a
  // Cloudflare Access / Tailscale Funnel front door that exposes ONLY the
  // /email-actions routes, while the rest of the app stays internal-only).
  // Falls back to APP_URL when unset, so existing internal-only deployments
  // are unaffected.
  EMAIL_ACTION_PUBLIC_URL: z.string().optional(),
  AD_AUTH_ENABLED: booleanFromEnv(false),
  AD_AUTH_URL: z.string().optional(),
  AD_API_BASE_URL: z.string().default("http://dt-internalproxy-1.etl.co.ls/ldap/api"),
  AD_AUTH_PATH: z.string().default("/autheticate_User"),
  AD_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  AD_FALLBACK_LOCAL: booleanFromEnv(true),
  AD_SYNTHETIC_EMAIL_DOMAIN: z.string().default("etl.co.ls"),
  ADMIN_SEED_EMAIL: z.string().default("pmo@etl.co.ls"),
  ADMIN_SEED_PASSWORD: z.string().default("pass123"),
  // HTTP email API (Active Directory email service — primary transport)
  EMAIL_API_ENABLED: booleanFromEnv(false),
  EMAIL_API_BASE_URL: z.string().default("http://10.1.10.105/EmailActiveDirectoryAPI"),
  EMAIL_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  // Legacy SMTP (fallback — used only if EMAIL_API_ENABLED is false and SMTP_ENABLED is true)
  SMTP_ENABLED: booleanFromEnv(false),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: booleanFromEnv(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // Microsoft Teams Incoming Webhook (channel notifications)
  TEAMS_ENABLED: booleanFromEnv(false),
  TEAMS_WEBHOOK_URL: z.string().optional()
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment: ${JSON.stringify(parsed.error.flatten())}`);
}

export const env = parsed.data;

// Guard against two easy-to-miss misconfigurations that don't fit the
// per-field zod schema above: an unset CORS_ORIGIN makes app.ts fall back to
// reflecting any origin while still allowing credentials (any site could
// make authenticated requests), and the default admin seed password is
// public (this repo's own .env.example). Checked regardless of NODE_ENV —
// a real UAT/staging/prod box that's accidentally left on the default
// NODE_ENV=development must not silently ship either — but only a hard
// failure in "production" to keep zero-config local dev convenient.
{
  const problems: string[] = [];
  if (!env.CORS_ORIGIN) {
    problems.push("CORS_ORIGIN is unset (reflecting all origins with credentials enabled is unsafe on any network-reachable deployment)");
  }
  if (env.ADMIN_SEED_PASSWORD === "pass123") {
    problems.push("ADMIN_SEED_PASSWORD is left at its default (the value is public in this repo's .env.example)");
  }
  if (problems.length > 0) {
    if (env.NODE_ENV === "production") {
      throw new Error(`Invalid production environment: ${problems.join("; ")}`);
    }
    logger.warn("env_misconfiguration", { node_env: env.NODE_ENV, problems });
  }
}
