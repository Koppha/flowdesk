import { Router } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { query } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { ensureLocalFile, writeStoredFile } from "../../lib/fileStore.js";
import { logger, serializeError } from "../../lib/logger.js";

// Over-the-air updates for FlowDesk Mobile - the Expo Updates protocol v1
// (https://docs.expo.dev/technical-specs/expo-updates-1/), self-hosted.
//
//   GET  /mobile-app/updates/manifest      the app asks on launch (public)
//   GET  /mobile-app/updates/assets/:hash  bundle + assets (public, immutable)
//   POST /mobile-app/updates               publish (ADMIN) - mobile repo's
//                                          scripts/publish-update.mjs / CI
//
// An update reaches only installed apps with the same runtime version (the
// native fingerprint the publish script computes), so a JS update can never
// land on a build it wasn't made for. Manifests are signed with the private
// key at MOBILE_UPDATES_PRIVATE_KEY_PATH (outside git); the app verifies them
// against certs/certificate.pem (keyid "main", rsa-v1_5-sha256 - app.json).
// Mounted by mobile-app.routes.ts BEFORE requireAuth: the app's update check
// carries no session.

export const mobileUpdatesRouter = Router();

const UPDATES_DIR = path.join(process.env.UPLOAD_DIR || "uploads", "mobile-updates");
const PLATFORMS = ["android", "ios"];

let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  schemaReady ??= (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS mobile_updates (
        id uuid PRIMARY KEY,
        platform text NOT NULL,
        runtime_version text NOT NULL,
        app_version text,
        message text,
        manifest jsonb NOT NULL,
        uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_mobile_updates_runtime ON mobile_updates (platform, runtime_version, created_at DESC)`);
    await query(`
      CREATE TABLE IF NOT EXISTS mobile_update_assets (
        hash text PRIMARY KEY,
        content_type text NOT NULL,
        file_path text NOT NULL,
        size_bytes int NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

let privateKey: string | null | undefined;
function signingKey(): string | null {
  if (privateKey === undefined) {
    const p = process.env.MOBILE_UPDATES_PRIVATE_KEY_PATH;
    try {
      privateKey = p ? fs.readFileSync(p, "utf8") : null;
    } catch (error) {
      logger.warn("mobile_updates_key_unreadable", { path: p, error: serializeError(error) });
      privateKey = null;
    }
  }
  return privateKey;
}

// Common protocol headers, on every manifest response.
function protocolHeaders(res: any) {
  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("cache-control", "private, max-age=0");
}

mobileUpdatesRouter.get("/manifest", async (req, res, next) => {
  try {
    await ensureSchema();
    const platform = String(req.header("expo-platform") || req.query.platform || "");
    const runtimeVersion = String(req.header("expo-runtime-version") || req.query["runtime-version"] || "");
    if (!PLATFORMS.includes(platform)) throw badRequest("Unsupported platform");
    if (!runtimeVersion) throw badRequest("Missing expo-runtime-version");

    protocolHeaders(res);
    const [latest] = await query<{ manifest: unknown }>(
      `SELECT manifest FROM mobile_updates WHERE platform = $1 AND runtime_version = $2 ORDER BY created_at DESC LIMIT 1`,
      [platform, runtimeVersion]
    );
    // Nothing published for this build: "no update", the app keeps what it has.
    if (!latest) return res.status(204).end();

    const manifestJson = JSON.stringify(latest.manifest);
    let signatureHeader = "";
    if (req.header("expo-expect-signature")) {
      const key = signingKey();
      if (!key) throw new Error("MOBILE_UPDATES_PRIVATE_KEY_PATH is not set or unreadable - can't sign the update");
      // The exact manifest bytes, RSA-SHA256, as an SFV dictionary (the
      // app's codeSigningMetadata: keyid "main", alg rsa-v1_5-sha256).
      const sig = crypto.createSign("RSA-SHA256").update(manifestJson, "utf8").sign(key, "base64");
      signatureHeader = `expo-signature: sig="${sig}", keyid="main"\r\n`;
    }

    const boundary = `flowdesk-${crypto.randomBytes(12).toString("hex")}`;
    const body =
      `--${boundary}\r\n` +
      `content-disposition: form-data; name="manifest"\r\n` +
      `content-type: application/json; charset=utf-8\r\n` +
      signatureHeader +
      `\r\n${manifestJson}\r\n` +
      `--${boundary}\r\n` +
      `content-disposition: form-data; name="extensions"\r\n` +
      `content-type: application/json\r\n` +
      `\r\n${JSON.stringify({ assetRequestHeaders: {} })}\r\n` +
      `--${boundary}--\r\n`;
    res.setHeader("content-type", `multipart/mixed; boundary=${boundary}`);
    return res.status(200).send(Buffer.from(body, "utf8"));
  } catch (err) {
    return next(err);
  }
});

mobileUpdatesRouter.get("/assets/:hash", async (req, res, next) => {
  try {
    await ensureSchema();
    const [asset] = await query<{ content_type: string; file_path: string }>(
      `SELECT content_type, file_path FROM mobile_update_assets WHERE hash = $1`,
      [req.params.hash]
    );
    if (!asset) throw notFound();
    const local = await ensureLocalFile(asset.file_path);
    if (!local) throw notFound("Update file missing");
    res.setHeader("content-type", asset.content_type);
    // Named by content hash - never changes.
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    return res.sendFile(path.resolve(local));
  } catch (err) {
    return next(err);
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 600 } });
const sha256Base64Url = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("base64url");

const AssetSchema = z.object({ hash: z.string().min(10), key: z.string(), contentType: z.string(), url: z.string().url() }).passthrough();
const ManifestSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  runtimeVersion: z.string().min(1),
  launchAsset: AssetSchema,
  assets: z.array(AssetSchema),
  metadata: z.record(z.unknown()).default({}),
  extra: z.record(z.unknown()).default({})
});

mobileUpdatesRouter.post("/", requireAuth, requireRole(["ADMIN"]), upload.array("files"), async (req: AuthedRequest, res, next) => {
  try {
    await ensureSchema();
    const platform = String(req.body.platform || "");
    const runtimeVersion = String(req.body.runtimeVersion || "");
    if (!PLATFORMS.includes(platform)) throw badRequest("Unsupported platform");
    let manifest: z.infer<typeof ManifestSchema>;
    try {
      const parsed = ManifestSchema.safeParse(JSON.parse(String(req.body.manifest || "")));
      if (!parsed.success) throw new Error(parsed.error.message);
      manifest = parsed.data;
    } catch (e: any) {
      throw badRequest(`Invalid manifest: ${e.message}`);
    }
    if (manifest.runtimeVersion !== runtimeVersion) throw badRequest("Manifest runtime version doesn't match");

    // Each file is named by its hash; check it before storing anything.
    const files = (req.files as Express.Multer.File[]) || [];
    const byHash = new Map<string, Express.Multer.File>();
    for (const f of files) {
      if (sha256Base64Url(f.buffer) !== f.originalname) throw badRequest(`File ${f.originalname} doesn't match its hash`);
      byHash.set(f.originalname, f);
    }
    const needed = [manifest.launchAsset, ...manifest.assets];
    const known = new Set(
      (await query<{ hash: string }>(`SELECT hash FROM mobile_update_assets WHERE hash = ANY($1::text[])`, [needed.map((a) => a.hash)])).map((r) => r.hash)
    );
    const missing = needed.filter((a) => !byHash.has(a.hash) && !known.has(a.hash));
    if (missing.length) throw badRequest(`Missing ${missing.length} file(s), e.g. ${missing[0].hash}`);

    for (const a of needed) {
      const f = byHash.get(a.hash);
      if (!f || known.has(a.hash)) continue;
      const filePath = path.join(UPDATES_DIR, a.hash);
      await writeStoredFile(filePath, f.buffer);
      await query(
        `INSERT INTO mobile_update_assets (hash, content_type, file_path, size_bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (hash) DO NOTHING`,
        [a.hash, a.contentType, filePath, f.size]
      );
    }
    await query(
      `INSERT INTO mobile_updates (id, platform, runtime_version, app_version, message, manifest, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [manifest.id, platform, runtimeVersion, String(req.body.appVersion || "") || null, String(req.body.message || "").slice(0, 500) || null, JSON.stringify(manifest), req.user!.userId]
    );
    logger.info("mobile_update_published", { id: manifest.id, platform, runtime_version: runtimeVersion, files: files.length });
    return res.status(201).json({ id: manifest.id, runtimeVersion, assets: needed.length });
  } catch (err) {
    return next(err);
  }
});

// Admin overview: what's published per build.
mobileUpdatesRouter.get("/", requireAuth, requireRole(["ADMIN"]), async (_req, res, next) => {
  try {
    await ensureSchema();
    return res.json(
      await query(
        `SELECT id, platform, runtime_version, app_version, message, created_at FROM mobile_updates ORDER BY created_at DESC LIMIT 50`
      )
    );
  } catch (err) {
    return next(err);
  }
});
