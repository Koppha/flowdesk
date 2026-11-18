import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env.js";
import { type AuthedRequest, requireAuth, requireRole, verifyToken } from "../../lib/auth.js";
import { badRequest, notFound, unauthorized } from "../../lib/errors.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";
import { ensureMobileAppBuildsSchema, getLatestMobileAppBuild, saveMobileAppBuild } from "../../lib/mobileAppBuilds.js";
import { ensureLocalFile, persistFile, storeKey } from "../../lib/fileStore.js";
import { query } from "../../lib/db.js";
import { logger, serializeError } from "../../lib/logger.js";
import { clientInfo, ensureMobileAppEventsSchema, getMobileAppAnalytics, listMobileAppEvents, recordMobileAppEvent, recordMobileAppOpen } from "../../lib/mobileAppEvents.js";
import { mobileSignPageRouter } from "./mobile-sign-page.routes.js";
import { mobileUpdatesRouter } from "./mobile-updates.routes.js";
import { getPhoneCampaign, runPhoneCampaignNow, setPhoneCampaign, startPhoneCampaign } from "../../lib/phoneCampaign.js";
import { supportRouter } from "../support/support.routes.js";
import { notifyMobileRelease } from "../../lib/mobileReleasePush.js";

export const mobileAppUploadDir = path.join(process.env.UPLOAD_DIR || "uploads", "mobile-app");

// The "add your phone number" push campaign runs alongside the mobile API.
startPhoneCampaign();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(mobileAppUploadDir, { recursive: true });
      cb(null, mobileAppUploadDir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeUploadFilename(file.originalname)}`)
  }),
  // Debug APKs with symbols can run well past a typical document upload -
  // generous limit rather than the 25MB ceiling other upload routes use.
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["apk"])
});

const DOWNLOAD_TOKEN_PURPOSE = "MOBILE_APP_DOWNLOAD";

// App builds kept in the shared database so both PROD servers can serve them.
// Same as the upload limit; only the newest few are kept there (each is
// ~70 MB) - older ones stay on the disk they were uploaded to.
const APP_BUILD_MAX_DB_BYTES = 250 * 1024 * 1024;
const APP_BUILDS_KEPT_IN_DB = 3;

async function pruneStoredAppBuilds() {
  try {
    const keep = (await query<{ file_path: string }>(
      `SELECT file_path FROM mobile_app_builds ORDER BY uploaded_at DESC LIMIT $1`,
      [APP_BUILDS_KEPT_IN_DB]
    )).map((b) => storeKey(b.file_path));
    await query(
      `DELETE FROM stored_files WHERE key LIKE 'uploads/mobile-app/%' AND NOT (key = ANY($1::text[]))`,
      [keep]
    );
  } catch (err) {
    logger.warn("app_build_prune_failed", { error: serializeError(err) });
  }
}

export const mobileAppRouter = Router();

// /download deliberately sits BEFORE the router-wide requireAuth below: a
// large (200MB+) file needs to be a plain, browser-native <a href> download
// (streamed straight through res.sendFile, with the browser's own progress
// UI and resumability) rather than fetched as a JS Blob first - the earlier
// Bearer-header-only version forced the whole file into page memory before
// anything could start, which is exactly what made the button sit on
// "Preparing…" for a long time with no feedback on a 229MB file. A plain
// <a> can't carry an Authorization header, so this accepts a short-lived,
// single-purpose download token via ?token= instead - minted by
// /download-token below, which DOES require a real session.
mobileAppRouter.get("/download", async (req, res, next) => {
  try {
    let userId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        userId = verifyToken(authHeader.slice("Bearer ".length)).userId;
      } catch {
        // fall through to the query token
      }
    }
    if (!userId) {
      const token = typeof req.query.token === "string" ? req.query.token : null;
      if (!token) throw unauthorized("Missing bearer token or download token");
      try {
        const payload = jwt.verify(token, env.JWT_SECRET) as { purpose?: string; userId?: string };
        if (payload.purpose !== DOWNLOAD_TOKEN_PURPOSE || !payload.userId) throw new Error("wrong purpose");
        userId = payload.userId;
      } catch {
        throw unauthorized("Invalid or expired download link - go back to Get the App and try again");
      }
    }

    await ensureMobileAppBuildsSchema();
    await ensureMobileAppEventsSchema();
    const platform = typeof req.query.platform === "string" ? req.query.platform.toUpperCase() : "ANDROID";
    const build = await getLatestMobileAppBuild(platform);
    // The build may have been uploaded to the other PROD server: restore it
    // from the shared database onto this one.
    const filePath = build ? await ensureLocalFile(build.file_path) : null;
    if (!build || !filePath) throw notFound("No build available yet");

    void recordMobileAppEvent("DOWNLOAD", userId, { version: build.version, platform });

    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(build.original_filename)}"`);
    return res.sendFile(path.resolve(filePath));
  } catch (err) {
    return next(err);
  }
});

// The mobile app's server-built screens (mobile-web/: Sign a Document,
// Maintenance). A static page with no data in it - every API call it makes
// carries the user's own token - so it sits before requireAuth.
mobileAppRouter.use("/web", mobileSignPageRouter);

// Over-the-air updates (mobile-updates.routes.ts): the app checks on launch
// without a session; publishing inside is ADMIN-only.
mobileAppRouter.use("/updates", mobileUpdatesRouter);

mobileAppRouter.use(requireAuth);

// Help & Support chat (modules/support) - signed-in users only.
mobileAppRouter.use("/support", supportRouter);

// Logged into FlowDesk at all is the only access control here, by design -
// see mobileAppBuilds.ts. Any authenticated user can mint a download token
// or see what's available; only ADMIN can upload a new build or see analytics.
mobileAppRouter.get("/download-token", (req: AuthedRequest, res) => {
  const token = jwt.sign({ purpose: DOWNLOAD_TOKEN_PURPOSE, userId: req.user!.userId }, env.JWT_SECRET, { expiresIn: "2m" });
  return res.json({ token });
});

mobileAppRouter.get("/latest", async (req: AuthedRequest, res, next) => {
  try {
    await ensureMobileAppBuildsSchema();
    const platform = typeof req.query.platform === "string" ? req.query.platform.toUpperCase() : "ANDROID";
    const build = await getLatestMobileAppBuild(platform);
    if (!build) return res.json({ build: null });
    return res.json({
      build: {
        version: build.version,
        originalFilename: build.original_filename,
        sizeBytes: build.size_bytes,
        uploadedAt: build.uploaded_at
      }
    });
  } catch (err) {
    return next(err);
  }
});

// The app reports each open/unlock (its lib/api.ts trackOpen) - logins alone
// miss everyone who unlocks with biometrics. Best-effort: always 204.
mobileAppRouter.post("/events", async (req: AuthedRequest, res) => {
  try {
    if (req.body?.type === "OPEN") {
      await ensureMobileAppEventsSchema();
      await recordMobileAppOpen(req.user!.userId, clientInfo(req.headers as Record<string, unknown>));
    }
  } catch {
    // Analytics must never break the app.
  }
  return res.status(204).end();
});

mobileAppRouter.get("/analytics", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    await ensureMobileAppEventsSchema();
    return res.json(await getMobileAppAnalytics());
  } catch (err) {
    return next(err);
  }
});

// Mobile Analytics: downloads or logins, a page at a time, with a name search.
mobileAppRouter.get("/analytics/events", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const type = String(req.query.type || "").toUpperCase();
    if (type !== "DOWNLOAD" && type !== "LOGIN") throw badRequest("type must be download or login");
    const page = Math.max(1, Math.min(10_000, Number(req.query.page) || 1));
    const pageSize = Math.max(5, Math.min(50, Number(req.query.pageSize) || 10));
    await ensureMobileAppEventsSchema();
    return res.json(await listMobileAppEvents(type, page, pageSize, String(req.query.q || "").slice(0, 100)));
  } catch (err) {
    return next(err);
  }
});

// "Add your phone number" campaign (lib/phoneCampaign.ts) - admin on/off and
// testing (every 5 minutes) vs live (random 7-14 days per person).
mobileAppRouter.get("/campaigns/phone", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await getPhoneCampaign());
  } catch (err) {
    return next(err);
  }
});

const CampaignSchema = z.object({ enabled: z.boolean().optional(), testMode: z.boolean().optional() });
mobileAppRouter.put("/campaigns/phone", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const p = CampaignSchema.safeParse(req.body);
    if (!p.success) throw badRequest("Invalid campaign settings", p.error.flatten());
    const status = await setPhoneCampaign(p.data);
    if (p.data.enabled) void runPhoneCampaignNow();
    return res.json(status);
  } catch (err) {
    return next(err);
  }
});

const UploadMetaSchema = z.object({
  version: z.string().trim().min(1, "A version is required"),
  platform: z.enum(["ANDROID"]).default("ANDROID")
});

mobileAppRouter.post(
  "/",
  requireRole(["ADMIN"]),
  upload.single("file"),
  async (req: AuthedRequest, res, next) => {
    try {
      if (!req.file) throw badRequest("An .apk file is required");
      const parsed = UploadMetaSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

      // PROD1 and PROD2 don't share a disk, and "Get the App" can land on
      // either: keep the build in the shared database too (it's larger than
      // the usual file limit), or the other server says "No build available".
      await persistFile(req.file.path, { maxBytes: APP_BUILD_MAX_DB_BYTES, required: true });

      const previous = await getLatestMobileAppBuild(parsed.data.platform);
      const build = await saveMobileAppBuild({
        platform: parsed.data.platform,
        version: parsed.data.version,
        originalFilename: req.file.originalname,
        filePath: req.file.path,
        sizeBytes: req.file.size,
        uploadedById: req.user!.userId
      });
      await pruneStoredAppBuilds();
      // A new version (not a re-upload of the same one): tell the phones.
      if (previous?.version !== build.version) void notifyMobileRelease(build.version);

      return res.status(201).json({
        build: {
          version: build.version,
          originalFilename: build.original_filename,
          sizeBytes: build.size_bytes,
          uploadedAt: build.uploaded_at
        }
      });
    } catch (err) {
      return next(err);
    }
  }
);
