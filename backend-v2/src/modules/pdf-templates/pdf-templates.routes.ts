import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import multer from "multer";
import sharp from "sharp";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { getFieldCatalogFor, resolvePdfData, pickSampleRecordId, buildDummyPdfData, PDF_REQUEST_TYPES, type PdfRequestType } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead, type PdfTemplateRow } from "../../lib/pdf/genericPdfRenderer.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";

export const pdfTemplatesRouter = Router();
pdfTemplatesRouter.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeUploadFilename(file.originalname)}`)
});
const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["jpg", "jpeg", "png", "gif", "webp", "svg"])
});

// ── Zod Schemas ───────────────────────────────────────────────────────────────

const RequestTypeSchema = z.enum(PDF_REQUEST_TYPES);

const SectionFieldSchema = z.object({
  fieldKey: z.string(),
  labelOverride: z.string().optional(),
  checkboxValue: z.string().optional()
});

const SectionSchema = z.object({
  id: z.string(),
  type: z.enum(["heading", "field_grid", "table", "two_column_table", "approval_summary", "disclaimer", "spacer"]),
  numbered: z.boolean().optional(),
  title: z.string().optional(),
  columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  fields: z.array(SectionFieldSchema).optional(),
  tableKey: z.string().optional(),
  tableColumns: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
  leftHeader: z.string().optional(),
  rightHeader: z.string().optional(),
  leftFields: z.array(SectionFieldSchema).optional(),
  rightFields: z.array(SectionFieldSchema).optional(),
  disclaimerItems: z.array(z.string()).optional()
});

const CreateTemplateSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  request_type: RequestTypeSchema,
  custom_request_type_id: z.string().uuid().nullish(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).default("DRAFT"),
  show_letterhead: z.boolean().optional().default(true),
  header_title: z.string().trim().nullish(),
  footer_text_override: z.string().trim().nullish(),
  accent_color: z.string().trim().nullish(),
  sections: z.array(SectionSchema).default([])
});

const UpdateTemplateSchema = CreateTemplateSchema.partial();

const PermissionSchema = z.object({
  permission_type: z.enum(["ALL", "GROUP", "USER"]),
  group_name: z.string().trim().nullish(),
  user_id: z.string().uuid().nullish(),
  can_view_pdf: z.boolean().optional().default(false),
  can_design_pdf: z.boolean().optional().default(false)
});

const LetterheadSchema = z.object({
  company_name: z.string().trim().nullish(),
  address_lines: z.array(z.string()).optional(),
  contact_line: z.string().trim().nullish(),
  footer_confidentiality_text: z.string().trim().nullish()
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function assertCanDesign(req: AuthedRequest, requestType: PdfRequestType, customRequestTypeId?: string | null) {
  const allowed = await canAccessPdf({
    requestType, customRequestTypeId, userId: req.user!.userId, role: req.user!.role, action: "design"
  });
  if (!allowed) throw forbidden("You do not have design access to PDF templates for this request type");
}

async function getTemplateOr404(id: string): Promise<PdfTemplateRow & { request_type: string; custom_request_type_id: string | null }> {
  const rows = await query<any>(`SELECT * FROM pdf_templates WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /pdf-templates/field-catalog?request_type=&custom_request_type_id=  (fixed path — must precede /:id)
pdfTemplatesRouter.get("/field-catalog", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ request_type: RequestTypeSchema, custom_request_type_id: z.string().uuid().optional() }).safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid query", parsed.error.flatten());
    const catalog = await getFieldCatalogFor(parsed.data.request_type, parsed.data.custom_request_type_id ?? null);
    return res.json(catalog);
  } catch (err) {
    return next(err);
  }
});

// GET /pdf-templates/letterhead  (fixed path — must precede /:id)
pdfTemplatesRouter.get("/letterhead", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT id, logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`);
    return res.json(rows[0] ?? null);
  } catch (err) {
    return next(err);
  }
});

// GET /pdf-templates/letterhead/preview — a blank sample A4 page showing just the
// letterhead (header/footer), so an admin can see how the logo looks before saving.
// Query params optionally override the saved text fields with in-progress draft
// values (the logo itself is always the already-persisted one, since logo upload
// saves immediately); falls back to the saved row for anything not passed.
pdfTemplatesRouter.get("/letterhead/preview", async (req: AuthedRequest, res, next) => {
  try {
    const saved = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
    };
    const addressLinesParam = typeof req.query.address_lines === "string" ? req.query.address_lines : undefined;
    const letterhead: PdfLetterhead = {
      logo_path: saved.logo_path,
      company_name: typeof req.query.company_name === "string" ? req.query.company_name : saved.company_name,
      address_lines: addressLinesParam ? addressLinesParam.split("\n").filter(Boolean) : saved.address_lines,
      contact_line: typeof req.query.contact_line === "string" ? req.query.contact_line : saved.contact_line,
      footer_confidentiality_text: typeof req.query.footer_text === "string" ? req.query.footer_text : saved.footer_confidentiality_text
    };

    const sampleTemplate: PdfTemplateRow = {
      id: "preview", name: "Letterhead Preview", request_type: "PREVIEW",
      show_letterhead: true, header_title: "SAMPLE DOCUMENT", footer_text_override: null, accent_color: null,
      sections: [
        { id: "s1", type: "field_grid", numbered: true, title: "Sample Section", columns: 2, fields: [{ fieldKey: "sample_field" }] },
        { id: "s2", type: "disclaimer", title: "Sample Disclaimer", disclaimerItems: ["This is a preview of how the letterhead looks on a generated PDF."] }
      ]
    };
    const sampleData = {
      scalars: { sample_field: "Sample value" },
      tables: {},
      approvalChain: [],
      meta: { id: "preview", requestType: "ADVANCE_REQUEST" as const, generatedAt: new Date().toISOString() }
    };
    const doc = renderPdfTemplate(sampleTemplate, letterhead, sampleData, [{ key: "sample_field", label: "Sample Field" }]);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="letterhead-preview.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

// PUT /pdf-templates/letterhead — design access to ANY scope required (fixed path — must precede /:id)
pdfTemplatesRouter.put("/letterhead", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") {
      const allowedAny = await Promise.all(
        PDF_REQUEST_TYPES.map((rt) => canAccessPdf({ requestType: rt, userId: req.user!.userId, role: req.user!.role, action: "design" }))
      );
      if (!allowedAny.some(Boolean)) throw forbidden("You do not have design access to any PDF templates");
    }
    const parsed = LetterheadSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid letterhead payload", parsed.error.flatten());

    const existing = (await query<{ id: string }>(`SELECT id FROM pdf_letterhead_settings LIMIT 1`))[0];
    const values = [
      parsed.data.company_name ?? null,
      JSON.stringify(parsed.data.address_lines ?? []),
      parsed.data.contact_line ?? null,
      parsed.data.footer_confidentiality_text ?? null,
      req.user!.userId
    ];
    if (existing) {
      await query(
        `UPDATE pdf_letterhead_settings
         SET company_name=$1, address_lines=$2, contact_line=$3, footer_confidentiality_text=$4, updated_by_id=$5, updated_at=now()
         WHERE id=$6`,
        [...values, existing.id]
      );
    } else {
      await query(
        `INSERT INTO pdf_letterhead_settings (company_name, address_lines, contact_line, footer_confidentiality_text, updated_by_id)
         VALUES ($1,$2,$3,$4,$5)`,
        values
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /pdf-templates/letterhead/logo — fixed path, must precede /:id
pdfTemplatesRouter.post("/letterhead/logo", uploadLogo.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") {
      const allowedAny = await Promise.all(
        PDF_REQUEST_TYPES.map((rt) => canAccessPdf({ requestType: rt, userId: req.user!.userId, role: req.user!.role, action: "design" }))
      );
      if (!allowedAny.some(Boolean)) throw forbidden("You do not have design access to any PDF templates");
    }
    if (!req.file) throw badRequest("Missing file");

    // Normalize every upload to PNG regardless of source format: pdfkit's doc.image()
    // (used by the PDF renderer) only supports PNG/JPEG natively, so a webp/svg/gif
    // upload would silently fail to render on generated PDFs (caught and dropped by
    // the renderer's try/catch) even though it looked fine in this admin screen.
    let pngBuffer: Buffer;
    try {
      pngBuffer = await sharp(req.file.path).png().toBuffer();
    } catch {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore cleanup errors */ }
      throw badRequest("Could not read this image file — please upload a valid image");
    }
    const logoData = `data:image/png;base64,${pngBuffer.toString("base64")}`;

    // Clean up the temporary uploaded file since we've now stored it in the database
    try {
      fs.unlinkSync(req.file.path);
    } catch {
      // Ignore cleanup errors
    }

    const existing = (await query<{ id: string }>(`SELECT id FROM pdf_letterhead_settings LIMIT 1`))[0];
    if (existing) {
      await query(`UPDATE pdf_letterhead_settings SET logo_data=$1, updated_by_id=$2, updated_at=now() WHERE id=$3`, [logoData, req.user!.userId, existing.id]);
    } else {
      await query(`INSERT INTO pdf_letterhead_settings (logo_data, updated_by_id) VALUES ($1,$2)`, [logoData, req.user!.userId]);
    }
    return res.json({ ok: true, logo_data: logoData.substring(0, 50) + "..." });
  } catch (err) {
    return next(err);
  }
});

// GET /pdf-templates?request_type=&custom_request_type_id=
pdfTemplatesRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ request_type: RequestTypeSchema.optional(), custom_request_type_id: z.string().uuid().optional() }).safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid query", parsed.error.flatten());

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (parsed.data.request_type) { params.push(parsed.data.request_type); conditions.push(`request_type = $${params.length}`); }
    if (parsed.data.custom_request_type_id) { params.push(parsed.data.custom_request_type_id); conditions.push(`custom_request_type_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await query(`SELECT id, name, request_type, custom_request_type_id, status, header_title, updated_at FROM pdf_templates ${where} ORDER BY request_type, name`, params);
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /pdf-templates/:id
pdfTemplatesRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const template = await getTemplateOr404(req.params.id);
    await assertCanDesign(req, template.request_type as PdfRequestType, template.custom_request_type_id);
    return res.json(template);
  } catch (err) {
    return next(err);
  }
});

// GET /pdf-templates/:id/preview?sample_id=  (sample_id is optional — if
// omitted, the most recent real record of this type is used automatically,
// falling back to placeholder data if none exist yet)
pdfTemplatesRouter.get("/:id/preview", async (req: AuthedRequest, res, next) => {
  try {
    const template = await getTemplateOr404(req.params.id);
    await assertCanDesign(req, template.request_type as PdfRequestType, template.custom_request_type_id);
    const requestType = template.request_type as PdfRequestType;
    const catalog = await getFieldCatalogFor(requestType, template.custom_request_type_id);

    const sampleId = String(req.query.sample_id || "") || (await pickSampleRecordId(requestType, template.custom_request_type_id));
    const data = sampleId ? await resolvePdfData(requestType, sampleId) : buildDummyPdfData(requestType, catalog);

    const letterhead = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
    };
    const doc = renderPdfTemplate(template, letterhead, data, catalog);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="preview.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

// GET /pdf-templates/:id/permissions
pdfTemplatesRouter.get("/:id/permissions", async (req: AuthedRequest, res, next) => {
  try {
    const template = await getTemplateOr404(req.params.id);
    await assertCanDesign(req, template.request_type as PdfRequestType, template.custom_request_type_id);
    const rows = await query(
      `SELECT pp.*, u.full_name AS user_name, u.email AS user_email
         FROM pdf_permissions pp
         LEFT JOIN users u ON u.id = pp.user_id
        WHERE pp.request_type = $1 AND (pp.custom_request_type_id = $2 OR pp.custom_request_type_id IS NULL)
        ORDER BY pp.created_at`,
      [template.request_type, template.custom_request_type_id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// POST /pdf-templates/:id/permissions
pdfTemplatesRouter.post("/:id/permissions", async (req: AuthedRequest, res, next) => {
  try {
    const template = await getTemplateOr404(req.params.id);
    await assertCanDesign(req, template.request_type as PdfRequestType, template.custom_request_type_id);
    const parsed = PermissionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid permission payload", parsed.error.flatten());

    const rows = await query(
      `INSERT INTO pdf_permissions (request_type, custom_request_type_id, permission_type, group_name, user_id, can_view_pdf, can_design_pdf, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        template.request_type, template.custom_request_type_id, parsed.data.permission_type,
        parsed.data.group_name ?? null, parsed.data.user_id ?? null,
        parsed.data.can_view_pdf ?? false, parsed.data.can_design_pdf ?? false, req.user!.userId
      ]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

// DELETE /pdf-templates/:id/permissions/:permId
pdfTemplatesRouter.delete("/:id/permissions/:permId", async (req: AuthedRequest, res, next) => {
  try {
    const template = await getTemplateOr404(req.params.id);
    await assertCanDesign(req, template.request_type as PdfRequestType, template.custom_request_type_id);
    const rows = await query(`DELETE FROM pdf_permissions WHERE id = $1 RETURNING id`, [req.params.permId]);
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /pdf-templates — create
pdfTemplatesRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateTemplateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid template payload", parsed.error.flatten());
    await assertCanDesign(req, parsed.data.request_type, parsed.data.custom_request_type_id);

    const rows = await query<{ id: string }>(
      `INSERT INTO pdf_templates (name, request_type, custom_request_type_id, status, show_letterhead, header_title, footer_text_override, accent_color, sections, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        parsed.data.name, parsed.data.request_type, parsed.data.custom_request_type_id ?? null, parsed.data.status,
        parsed.data.show_letterhead, parsed.data.header_title ?? null, parsed.data.footer_text_override ?? null,
        parsed.data.accent_color ?? null, JSON.stringify(parsed.data.sections), req.user!.userId
      ]
    );
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

// PUT /pdf-templates/:id — whole-row replace
pdfTemplatesRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const template = await getTemplateOr404(req.params.id);
    await assertCanDesign(req, template.request_type as PdfRequestType, template.custom_request_type_id);

    const parsed = UpdateTemplateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid template payload", parsed.error.flatten());

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const set = (col: string, value: unknown) => { fields.push(`${col}=$${idx++}`); values.push(value); };
    if (parsed.data.name !== undefined) set("name", parsed.data.name);
    if (parsed.data.status !== undefined) set("status", parsed.data.status);
    if (parsed.data.show_letterhead !== undefined) set("show_letterhead", parsed.data.show_letterhead);
    if (parsed.data.header_title !== undefined) set("header_title", parsed.data.header_title ?? null);
    if (parsed.data.footer_text_override !== undefined) set("footer_text_override", parsed.data.footer_text_override ?? null);
    if (parsed.data.accent_color !== undefined) set("accent_color", parsed.data.accent_color ?? null);
    if (parsed.data.sections !== undefined) set("sections", JSON.stringify(parsed.data.sections));
    if (!fields.length) return res.json({ ok: true });

    values.push(req.params.id);
    await query(`UPDATE pdf_templates SET ${fields.join(",")}, updated_at = now() WHERE id = $${idx}`, values);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// DELETE /pdf-templates/:id
pdfTemplatesRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const template = await getTemplateOr404(req.params.id);
    await assertCanDesign(req, template.request_type as PdfRequestType, template.custom_request_type_id);
    await query(`DELETE FROM pdf_templates WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
