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
import { ensureMobileAppEventsSchema, getMobileAppAnalytics, recordMobileAppEvent } from "../../lib/mobileAppEvents.js";

export const mobileAppUploadDir = path.join(process.env.UPLOAD_DIR || "uploads", "mobile-app");

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
    if (!build || !fs.existsSync(build.file_path)) throw notFound("No build available yet");

    void recordMobileAppEvent("DOWNLOAD", userId, { version: build.version, platform });

    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(build.original_filename)}"`);
    return res.sendFile(path.resolve(build.file_path));
  } catch (err) {
    return next(err);
  }
});

mobileAppRouter.use(requireAuth);

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

mobileAppRouter.get("/analytics", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    await ensureMobileAppEventsSchema();
    return res.json(await getMobileAppAnalytics());
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

      const build = await saveMobileAppBuild({
        platform: parsed.data.platform,
        version: parsed.data.version,
        originalFilename: req.file.originalname,
        filePath: req.file.path,
        sizeBytes: req.file.size,
        uploadedById: req.user!.userId
      });

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
