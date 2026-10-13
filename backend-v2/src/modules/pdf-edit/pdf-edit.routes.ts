import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";
import { stampTextAnnotations } from "../../lib/pdf/textAnnotate.js";

// Deliberately its own tiny module, not folded into signatures/ - this is a
// stateless "add text, get the PDF back" utility with no audit trail, no
// verification code, nothing kept beyond the request. Nothing is persisted
// to the database at all.

const uploadDir = path.join(process.env.UPLOAD_DIR || "uploads", "pdf-edit");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeUploadFilename(file.originalname)}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["pdf"])
});

export const pdfEditRouter = Router();
pdfEditRouter.use(requireAuth);

const AnnotationSchema = z.object({
  pageNumber: z.coerce.number().int().min(1),
  xPct: z.coerce.number().min(0).max(1),
  yPct: z.coerce.number().min(0).max(1),
  text: z.string().trim().min(1).max(500),
  fontSize: z.coerce.number().min(6).max(72).default(14),
  color: z.string().regex(/^#[0-9a-fA-F]{3,6}$/).default("#111827")
});

pdfEditRouter.post("/annotate", upload.single("file"), async (req: AuthedRequest, res, next) => {
  const tempPath = req.file?.path;
  try {
    if (!req.file) throw badRequest("A PDF file is required");

    let raw: unknown;
    try { raw = JSON.parse(String(req.body.annotations || "[]")); } catch { throw badRequest("Invalid annotations"); }
    const parsed = z.array(AnnotationSchema).min(1, "Add at least one piece of text").max(200).safeParse(raw);
    if (!parsed.success) throw badRequest("Invalid annotations", parsed.error.flatten());

    const originalBuffer = fs.readFileSync(req.file.path);
    const buffer = await stampTextAnnotations(originalBuffer, parsed.data);

    const downloadName = `${req.file.originalname.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "document"}-edited.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadName)}"`);
    return res.send(buffer);
  } catch (err) {
    return next(err);
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch { /* best effort */ } }
  }
});
