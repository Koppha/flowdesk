import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";
import { signatureVerifyLimiter } from "../../middleware/rateLimit.js";
import { getBooleanSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { renderBrandedPage, escapeHtml } from "../../lib/htmlPageTemplate.js";
import { ensureSignaturesSchema } from "./signatures.schema.js";
import { persistentDiskStorage, ensureLocalFile } from "../../lib/fileStore.js";
import {
  performSignDocument, getSignatureRecord, getSignatureByCode, verifyFileIntegrity,
  getSignatureNotationPolicy, setSignatureNotationPolicy, signatureUploadDir,
  getSavedSignature, saveSavedSignature, clearSavedSignature,
  createSignableDocument, getSignableDocument, getSignableDocumentByCode,
  listSignableDocumentsForUser, listPlacementsForDocument, addSignaturePlacement,
  rejectSignableDocument, addTextToDocument, finishSignableDocument, addTickToDocument,
  undoLastEdit, undoableEditCount, deleteSignableDocument, assertCanSeeDocument
} from "./signatures.service.js";

const upload = multer({
  storage: persistentDiskStorage({
    destination: (_req, _file, cb) => cb(null, signatureUploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-incoming-${sanitizeUploadFilename(file.originalname)}`)
  }),
  // fieldSize: a drawn or uploaded signature arrives as a data URL form
  // field, which can be over multer's 1 MB default.
  limits: { fileSize: 25 * 1024 * 1024, fieldSize: 6 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["pdf"])
});

// ---------------------------------------------------------------------
// Authenticated routes - signing, downloading, and the admin notation
// policy. Everything here requires a logged-in FlowDesk user; this is
// the "internal signer" flow scoped first (see the standalone-module plan).
// ---------------------------------------------------------------------
export const signaturesRouter = Router();
signaturesRouter.use(requireAuth);

const SignSchema = z.object({
  title: z.string().trim().min(1, "A title is required"),
  // Optional "Place it myself" position (multipart, so numbers arrive as strings).
  pageNumber: z.coerce.number().int().min(1).optional(),
  xPct: z.coerce.number().min(0).max(1).optional(),
  yPct: z.coerce.number().min(0).max(1).optional(),
  widthPct: z.coerce.number().min(0.02).max(0.6).optional(),
  consentStatement: z.string().trim().min(1),
  typedSignatureText: z.string().trim().optional(),
  signatureImageDataUrl: z.string().trim().optional(),
  authorityUserId: z.string().uuid().optional(),
  requestedNotation: z.enum(["AI", "PP"]).optional()
});

// POST /signatures/upload-and-sign — the standalone "sign any document"
// flow: upload a PDF, capture consent and a signature, get back a signed,
// hash-verified copy with a public verification code stamped on it.
signaturesRouter.post("/upload-and-sign", async (req: AuthedRequest, res, next) => {
  // Checked before multer writes the upload to disk - no point saving a
  // file for a signing attempt that's about to be rejected anyway.
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureModuleEnabled, true))) {
    return next(forbidden("Electronic signing is currently disabled by admin."));
  }
  return next();
}, upload.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    if (!req.file) throw badRequest("A PDF file is required");
    const parsed = SignSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    await ensureSignaturesSchema();

    let authorityName: string | null = null;
    if (parsed.data.authorityUserId) {
      const authority = (await query<{ full_name: string | null }>(
        `SELECT full_name FROM users WHERE id = $1 AND is_active = true`, [parsed.data.authorityUserId]
      ))[0];
      if (!authority) throw badRequest("Selected authority user is invalid");
      authorityName = authority.full_name;
    }

    const originalBuffer = fs.readFileSync(req.file.path);
    const result = await performSignDocument({
      title: parsed.data.title,
      originalBuffer,
      originalFileName: req.file.originalname,
      contentType: req.file.mimetype,
      signerId: req.user!.userId,
      signerName: req.user!.fullName || "Unknown",
      signerIp: req.ip || null,
      consentStatement: parsed.data.consentStatement,
      typedSignatureText: parsed.data.typedSignatureText || null,
      signatureImageDataUrl: parsed.data.signatureImageDataUrl || null,
      authorityUserId: parsed.data.authorityUserId || null,
      authorityName,
      requestedNotation: parsed.data.requestedNotation ?? null,
      placement: parsed.data.pageNumber && parsed.data.xPct !== undefined && parsed.data.yPct !== undefined
        ? { pageNumber: parsed.data.pageNumber, xPct: parsed.data.xPct, yPct: parsed.data.yPct, widthPct: parsed.data.widthPct ?? 0.18 }
        : null
    });

    // The freshly-uploaded temp file has now been copied into
    // signatureUploadDir as the "original" copy on record - remove multer's
    // own copy so the same content isn't kept twice under different names.
    try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }

    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// GET /signatures/mine — every document the current user has signed,
// newest first.
signaturesRouter.get("/mine", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSignaturesSchema();
    const rows = await query<any>(
      `SELECT ds.id, ds.title, ds.verification_code, ds.signed_at, ds.source_type,
              ds.delegation_notation, au.full_name AS authority_name
         FROM document_signatures ds
         LEFT JOIN users au ON au.id = ds.authority_user_id
        WHERE ds.signer_id = $1
        ORDER BY ds.signed_at DESC`,
      [req.user!.userId]
    );
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

// GET /signatures/settings — the org's delegated-signature notation policy.
// Read access is any authenticated user (the signing screen needs to know
// the default and whether it can offer a choice); only ADMIN can change it.
signaturesRouter.get("/settings", async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await getSignatureNotationPolicy());
  } catch (err) {
    return next(err);
  }
});

const SettingsSchema = z.object({ notation: z.enum(["AI", "PP"]), overridable: z.boolean() });
signaturesRouter.put("/settings", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await setSignatureNotationPolicy(parsed.data);
    return res.json(await getSignatureNotationPolicy());
  } catch (err) {
    return next(err);
  }
});

// Saved-signature convenience cache - fixed paths, must precede /:id below
// so "my-saved-signature" is never swallowed as an :id param.
signaturesRouter.get("/my-saved-signature", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSignaturesSchema();
    const saved = await getSavedSignature(req.user!.userId);
    return res.json(saved);
  } catch (err) {
    return next(err);
  }
});

const SavedSignatureSchema = z.object({
  signatureType: z.enum(["type", "draw"]),
  typedName: z.string().trim().optional().nullable(),
  imageDataUrl: z.string().trim().optional().nullable()
});
signaturesRouter.put("/my-saved-signature", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SavedSignatureSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    if (parsed.data.signatureType === "type" && !parsed.data.typedName) throw badRequest("A typed name is required");
    if (parsed.data.signatureType === "draw" && !parsed.data.imageDataUrl) throw badRequest("A drawn signature is required");
    await ensureSignaturesSchema();
    await saveSavedSignature(req.user!.userId, {
      signatureType: parsed.data.signatureType,
      typedName: parsed.data.typedName ?? null,
      imageDataUrl: parsed.data.imageDataUrl ?? null
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

signaturesRouter.delete("/my-saved-signature", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSignaturesSchema();
    await clearSavedSignature(req.user!.userId);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------
// Routing documents - one shared PDF multiple people sign in turn, each
// picking their own spot on the page (the multi-GM paper sign-off sheet
// use case). Fixed paths, all registered before /:id below so "documents"
// is never swallowed as an :id param. Distribution is link-only: any
// authenticated user who has the document's id/link can view and sign it -
// there's no per-recipient inbox here, see the module's design note above.
// ---------------------------------------------------------------------

signaturesRouter.post("/documents", async (req: AuthedRequest, res, next) => {
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureModuleEnabled, true))) {
    return next(forbidden("Electronic signing is currently disabled by admin."));
  }
  return next();
}, upload.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    if (!req.file) throw badRequest("A PDF file is required");
    const title = String(req.body.title || "").trim();
    if (!title) throw badRequest("A title is required");

    let approvalChain: { approverId: string; approverName: string }[] | undefined;
    const rawChain = req.body.approvalChain;
    if (typeof rawChain === "string" && rawChain.trim()) {
      let parsedChain: unknown;
      try { parsedChain = JSON.parse(rawChain); } catch { throw badRequest("Invalid approval route"); }
      const ChainInputSchema = z.array(z.object({ approverId: z.string().uuid() })).max(30);
      const chainParsed = ChainInputSchema.safeParse(parsedChain);
      if (!chainParsed.success) throw badRequest("Invalid approval route", chainParsed.error.flatten());
      if (chainParsed.data.length > 0) {
        const ids = chainParsed.data.map((s) => s.approverId);
        const users = await query<{ id: string; full_name: string | null }>(
          `SELECT id, full_name FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`, [ids]
        );
        const byId = new Map(users.map((u) => [u.id, u.full_name || "Unknown"]));
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length) throw badRequest("One or more selected approvers are invalid");
        approvalChain = ids.map((id) => ({ approverId: id, approverName: byId.get(id)! }));
      }
    }

    // "I'll sign it first": the creator becomes step 1 of the route, signs,
    // and Sign & send passes it on to the first approver.
    const signFirst = String(req.body.signFirst || "") === "true";
    if (signFirst && approvalChain?.length && approvalChain[0].approverId !== req.user!.userId) {
      approvalChain = [{ approverId: req.user!.userId, approverName: req.user!.fullName || "Unknown" }, ...approvalChain];
    }

    await ensureSignaturesSchema();
    const originalBuffer = fs.readFileSync(req.file.path);
    const doc = await createSignableDocument({
      title, originalBuffer, originalFileName: req.file.originalname, createdById: req.user!.userId, approvalChain
    });
    try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }

    return res.status(201).json({ id: doc.id, verificationCode: doc.verification_code, title: doc.title });
  } catch (err) {
    return next(err);
  }
});

signaturesRouter.get("/documents/mine", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSignaturesSchema();
    const items = await listSignableDocumentsForUser(req.user!.userId);
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

signaturesRouter.get("/documents/:id", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSignaturesSchema();
    const doc = await getSignableDocument(req.params.id);
    if (doc.status === "DELETED" && req.user!.role !== "ADMIN") throw notFound("This document was deleted.");
    await assertCanSeeDocument(doc, req.user!);
    const placements = await listPlacementsForDocument(doc.id);
    const chain = Array.isArray(doc.approval_chain) ? doc.approval_chain : [];
    return res.json({
      id: doc.id, title: doc.title, verificationCode: doc.verification_code,
      createdById: doc.created_by_id, createdAt: doc.created_at, updatedAt: doc.updated_at,
      status: doc.status, currentStepOrder: doc.current_step_order,
      approvalChain: chain.map((s: any) => ({ approverId: s.approver_id, approverName: s.approver_name, status: s.status, comment: s.comment, actedAt: s.acted_at })),
      isMyTurn: doc.status === "OPEN" && chain.length > 0 && chain[doc.current_step_order]?.approver_id === req.user!.userId,
      closedAt: doc.closed_at ?? null,
      closedByName: doc.closed_by_id ? (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [doc.closed_by_id]))[0]?.full_name ?? null : null,
      canFinish: doc.status === "OPEN" && chain.length === 0 && (doc.created_by_id === req.user!.userId || req.user!.role === "ADMIN"),
      canDelete: doc.status !== "DELETED" && (doc.created_by_id === req.user!.userId || req.user!.role === "ADMIN"),
      canUndo: doc.status === "OPEN" && (await undoableEditCount(doc, req.user!.userId)) > 0,
      placements: placements.map((p) => ({
        id: p.id, signerName: p.signer_name, authorityName: p.authority_name,
        delegationNotation: p.delegation_notation, pageNumber: p.page_number,
        xPct: Number(p.x_pct), yPct: Number(p.y_pct), signedAt: p.signed_at
      }))
    });
  } catch (err) {
    return next(err);
  }
});

// POST /signatures/documents/:id/undo - takes back your latest text or tick.
signaturesRouter.post("/documents/:id/undo", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSignaturesSchema();
    return res.json(await undoLastEdit(req.params.id, req.user!.userId));
  } catch (err) {
    return next(err);
  }
});

// DELETE /signatures/documents/:id - the creator removes a document, with a
// reason; kept on record and in audit_log.
signaturesRouter.delete("/documents/:id", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ reason: z.string().trim().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Please say why you're deleting this document - it's kept in the audit log.");
    await ensureSignaturesSchema();
    await deleteSignableDocument(req.params.id, req.user!, parsed.data.reason);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /signatures/documents/:id/finish - the creator ends signing on a
// document with no approval route; after this nobody can sign it.
signaturesRouter.post("/documents/:id/finish", async (req: AuthedRequest, res, next) => {
  try {
    await ensureSignaturesSchema();
    await finishSignableDocument(req.params.id, req.user!);
    return res.json({ ok: true, status: "COMPLETED" });
  } catch (err) {
    return next(err);
  }
});

const RejectSchema = z.object({ comment: z.string().trim().min(1, "Please say why you're rejecting this") });
signaturesRouter.post("/documents/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Please give a reason for rejecting - it's sent to everyone on the route.", parsed.error.flatten());
    await ensureSignaturesSchema();
    await rejectSignableDocument({ documentId: req.params.id, signerId: req.user!.userId, signerName: req.user!.fullName || "Unknown", comment: parsed.data.comment });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const TextAnnotationSchema = z.object({
  pageNumber: z.coerce.number().int().min(1),
  xPct: z.coerce.number().min(0).max(1),
  yPct: z.coerce.number().min(0).max(1),
  text: z.string().trim().min(1).max(500),
  fontSize: z.coerce.number().min(6).max(72).default(14),
  color: z.string().regex(/^#[0-9a-fA-F]{3,6}$/).default("#111827")
});
signaturesRouter.post("/documents/:id/annotate-text", async (req: AuthedRequest, res, next) => {
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureModuleEnabled, true))) {
    return next(forbidden("Electronic signing is currently disabled by admin."));
  }
  try {
    const parsed = TextAnnotationSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await ensureSignaturesSchema();
    const result = await addTextToDocument({
      documentId: req.params.id, actorId: req.user!.userId,
      pageNumber: parsed.data.pageNumber, xPct: parsed.data.xPct, yPct: parsed.data.yPct,
      text: parsed.data.text, fontSize: parsed.data.fontSize, color: parsed.data.color
    });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// POST /signatures/documents/:id/annotate-tick - a tick or cross in a box.
const TickSchema = z.object({
  pageNumber: z.coerce.number().int().min(1),
  xPct: z.coerce.number().min(0).max(1),
  yPct: z.coerce.number().min(0).max(1),
  sizePct: z.coerce.number().min(0.008).max(0.12),
  kind: z.enum(["CHECK", "CROSS"]).default("CHECK"),
  color: z.string().regex(/^#[0-9a-fA-F]{3,6}$/).default("#111827")
});
signaturesRouter.post("/documents/:id/annotate-tick", async (req: AuthedRequest, res, next) => {
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureModuleEnabled, true))) {
    return next(forbidden("Electronic signing is currently disabled by admin."));
  }
  try {
    const parsed = TickSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid tick", parsed.error.flatten());
    await ensureSignaturesSchema();
    const result = await addTickToDocument({ documentId: req.params.id, actorId: req.user!.userId, ...parsed.data });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

signaturesRouter.get("/documents/:id/file", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await getSignableDocument(req.params.id);
    if (doc.status === "DELETED" && req.user!.role !== "ADMIN") throw notFound("This document was deleted.");
    await assertCanSeeDocument(doc, req.user!);
    const localPath = await ensureLocalFile(doc.current_file_path);
    if (!localPath) throw notFound("This document's file is missing");
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(doc.original_file_name)}"`);
    return res.sendFile(path.resolve(localPath));
  } catch (err) {
    return next(err);
  }
});

const PlacementSchema = z.object({
  consentStatement: z.string().trim().min(1),
  pageNumber: z.coerce.number().int().min(1),
  xPct: z.coerce.number().min(0).max(1),
  yPct: z.coerce.number().min(0).max(1),
  widthPct: z.coerce.number().min(0.02).max(0.6),
  typedSignatureText: z.string().trim().optional(),
  signatureImageDataUrl: z.string().trim().optional(),
  authorityUserId: z.string().uuid().optional(),
  requestedNotation: z.enum(["AI", "PP"]).optional()
});
signaturesRouter.post("/documents/:id/sign", async (req: AuthedRequest, res, next) => {
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureModuleEnabled, true))) {
    return next(forbidden("Electronic signing is currently disabled by admin."));
  }
  try {
    const parsed = PlacementSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    await ensureSignaturesSchema();
    await getSignableDocument(req.params.id); // 404s if the document doesn't exist

    let authorityName: string | null = null;
    if (parsed.data.authorityUserId) {
      const authority = (await query<{ full_name: string | null }>(
        `SELECT full_name FROM users WHERE id = $1 AND is_active = true`, [parsed.data.authorityUserId]
      ))[0];
      if (!authority) throw badRequest("Selected authority user is invalid");
      authorityName = authority.full_name;
    }

    const result = await addSignaturePlacement({
      documentId: req.params.id,
      signerId: req.user!.userId,
      signerName: req.user!.fullName || "Unknown",
      signerIp: req.ip || null,
      consentStatement: parsed.data.consentStatement,
      pageNumber: parsed.data.pageNumber,
      xPct: parsed.data.xPct,
      yPct: parsed.data.yPct,
      widthPct: parsed.data.widthPct,
      typedSignatureText: parsed.data.typedSignatureText || null,
      signatureImageDataUrl: parsed.data.signatureImageDataUrl || null,
      authorityUserId: parsed.data.authorityUserId || null,
      authorityName
    });

    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

async function assertCanViewSignature(record: any, actor: { userId: string; role: string }) {
  if (actor.role === "ADMIN") return;
  if (record.signer_id === actor.userId || record.authority_user_id === actor.userId) return;
  throw forbidden("You do not have access to this document");
}

signaturesRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const record = await getSignatureRecord(req.params.id);
    await assertCanViewSignature(record, req.user!);
    const { original_file_path, signed_file_path, ...safe } = record;
    return res.json(safe);
  } catch (err) {
    return next(err);
  }
});

signaturesRouter.get("/:id/file", async (req: AuthedRequest, res, next) => {
  try {
    const record = await getSignatureRecord(req.params.id);
    await assertCanViewSignature(record, req.user!);
    const signedPath = await ensureLocalFile(record.signed_file_path);
    if (!signedPath) throw notFound("This document's file is missing");
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent("signed-" + record.original_file_name)}"`);
    return res.sendFile(path.resolve(signedPath));
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------
// Public verification - no login required, same principle as the
// email-action confirmation pages: a self-contained HTML response with
// inline style/script, so it renders correctly behind any reverse-proxy
// path prefix without needing the React app or its own asset bundle.
// Mounted at a MORE SPECIFIC path than signaturesRouter above and
// registered first in app.ts, so requireAuth on the authed router never
// intercepts it.
// ---------------------------------------------------------------------
export const signatureVerifyRouter = Router();
signatureVerifyRouter.use(signatureVerifyLimiter);
signatureVerifyRouter.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'"
  );
  next();
});

function renderVerifyPage(opts: {
  code?: string;
  found: boolean;
  valid?: boolean;
  title?: string;
  signerName?: string;
  authorityLine?: string | null;
  signedAt?: string;
  // Set instead of signerName/authorityLine/signedAt for a routing document
  // signed by more than one person - lists everyone who has signed so far.
  signers?: { name: string; authorityLine: string | null; signedAt: string }[];
}) {
  const { code, found, valid, title, signerName, authorityLine, signedAt, signers } = opts;
  const signersHtml = signers
    ? signers.length === 0
      ? `<div class="row"><span>Signed by</span><strong>No one yet</strong></div>`
      : signers.map((s) => `
         <div class="row"><span>Signed by</span><strong>${escapeHtml(s.name)}${s.authorityLine ? ` (${escapeHtml(s.authorityLine)})` : ""}</strong></div>
         <div class="row"><span>&nbsp;</span><span>${escapeHtml(s.signedAt)}</span></div>`).join("")
    : `<div class="row"><span>Signed by</span><strong>${escapeHtml(signerName)}</strong></div>
       ${authorityLine ? `<div class="row"><span>Authority</span><strong>${escapeHtml(authorityLine)}</strong></div>` : ""}
       <div class="row"><span>Signed on</span><strong>${escapeHtml(signedAt)}</strong></div>`;

  const resultHtml = !code
    ? ""
    : !found
    ? `<div class="result bad">
         <div class="result-head"><span class="dot"></span>Not found</div>
         <div class="rows"><p class="msg">No signed document matches this code.</p></div>
       </div>`
    : `<div class="result ${valid ? "good" : "bad"}">
         <div class="result-head"><span class="dot"></span>${valid ? "Verified" : "Integrity check failed"}</div>
         <div class="rows">
           <div class="row"><span>Document</span><strong>${escapeHtml(title)}</strong></div>
           ${signersHtml}
           <div class="row"><span>Integrity</span><strong>${valid ? "Matches the current copy" : "Does not match — this file may have been altered"}</strong></div>
         </div>
       </div>`;

  return renderBrandedPage({
    title: "FlowDesk &middot; Verify Signature",
    bodyHtml: `
      <h1>Verify a signed document</h1>
      <p class="lead">Enter the verification code printed on the document to confirm who signed it and whether it's still intact.</p>
      <form method="get" class="search">
        <input name="code" placeholder="XXXXX-XXXXX" value="${escapeHtml(code || "")}" autofocus />
        <button type="submit">Verify</button>
      </form>
      ${resultHtml}`
  });
}

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

signatureVerifyRouter.get("/:code", async (req, res, next) => {
  try {
    // The page's "look up another code" form submits ?code= to this URL.
    // Redirects are relative so they keep any proxy prefix (PROD serves this
    // page under /api/).
    const asked = typeof req.query.code === "string" ? req.query.code.trim() : "";
    if (asked && asked.toUpperCase() !== req.params.code.toUpperCase()) return res.redirect(`./${encodeURIComponent(asked)}`);
    await ensureSignaturesSchema();
    const code = req.params.code;

    const record = await getSignatureByCode(code);
    if (record) {
      const authority = record.authority_user_id
        ? (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [record.authority_user_id]))[0]
        : null;
      const signer = (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [record.signer_id]))[0];
      const valid = record.status === "VALID" && (await verifyFileIntegrity(record.signed_file_path, record.content_hash));

      return res.type("html").send(renderVerifyPage({
        code, found: true, valid, title: record.title,
        signerName: signer?.full_name || "Unknown",
        authorityLine: authority ? `${record.delegation_notation === "AI" ? "a.i." : "p.p."} for ${authority.full_name}` : null,
        signedAt: fmtDate(record.signed_at)
      }));
    }

    const doc = await getSignableDocumentByCode(code);
    if (doc) {
      const placements = await listPlacementsForDocument(doc.id);
      const valid = await verifyFileIntegrity(doc.current_file_path, doc.current_content_hash);
      // Routed documents: signers in route order (the order they were listed
      // when it was sent) - a server's clock can't reorder them. Anyone not on
      // the route, or a document with no route, follows by signing time.
      const chain: Array<{ approver_id: string }> = Array.isArray(doc.approval_chain) ? doc.approval_chain : [];
      const used = new Set<number>();
      const routePos = (signerId: string) => {
        const i = chain.findIndex((st, k) => !used.has(k) && st.approver_id === signerId);
        if (i >= 0) used.add(i);
        return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
      };
      const ordered = placements
        .map((p: any, k: number) => ({ p, pos: routePos(p.signer_id), k }))
        .sort((a, b) => a.pos - b.pos || a.k - b.k)
        .map((x) => x.p);
      return res.type("html").send(renderVerifyPage({
        code, found: true, valid, title: doc.title,
        signers: ordered.map((p: any) => ({
          name: p.signer_name,
          authorityLine: p.authority_name ? `${p.delegation_notation === "AI" ? "a.i." : "p.p."} for ${p.authority_name}` : null,
          signedAt: fmtDate(p.signed_at)
        }))
      }));
    }

    return res.type("html").send(renderVerifyPage({ code, found: false }));
  } catch (err) {
    return next(err);
  }
});

// Bare /signatures/verify (no code yet) - just the lookup form.
signatureVerifyRouter.get("/", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  if (code) return res.redirect(`verify/${encodeURIComponent(code)}`); // relative: keeps a proxy prefix
  return res.type("html").send(renderVerifyPage({ found: false }));
});
