import path from "path";
import type { Request } from "express";
import type multer from "multer";
import { badRequest } from "./errors.js";

const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g;

// Multer writes this straight into a path under the upload dir - stripping
// any directory components (path.basename) and non-alphanumeric characters
// stops a crafted originalname (e.g. containing "../") from escaping it.
export function sanitizeUploadFilename(originalname: string): string {
  const base = path.basename(originalname).replace(UNSAFE_FILENAME_CHARS, "_");
  return base.slice(-200) || "file";
}

export function fileExtensionFilter(allowedExtensions: string[]) {
  const allowed = new Set(allowedExtensions.map((ext) => ext.toLowerCase()));
  return (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/^\./, "");
    if (!allowed.has(ext)) {
      cb(badRequest(`Unsupported file type: .${ext || "unknown"}`));
      return;
    }
    cb(null, true);
  };
}
