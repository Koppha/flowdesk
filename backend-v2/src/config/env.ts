import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  CORS_ORIGIN: z.string().optional(),
  AD_AUTH_ENABLED: z.coerce.boolean().default(false),
  AD_API_BASE_URL: z.string().default("http://10.1.11.43/EmailActiveDirectoryAPI"),
  AD_AUTH_PATH: z.string().default("/autheticate_User"),
  AD_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  AD_FALLBACK_LOCAL: z.coerce.boolean().default(true),
  AD_SYNTHETIC_EMAIL_DOMAIN: z.string().default("ad.local"),
  ADMIN_SEED_EMAIL: z.string().default("admin@example.com"),
  ADMIN_SEED_PASSWORD: z.string().default("pass123"),
  SMTP_ENABLED: z.coerce.boolean().default(false),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional()
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment: ${JSON.stringify(parsed.error.flatten())}`);
}

export const env = parsed.data;
