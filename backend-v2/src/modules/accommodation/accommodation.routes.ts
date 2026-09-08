import fs from "fs";
import path from "path";
import multer from "multer";
import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, hasFeatureAccess, requireAuth, requireFeatureAccess, requireRole } from "../../lib/auth.js";
import { isCompensationFinanceSection, isCompensationFinanceUser } from "../../lib/financeAuthority.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getNumericSystemSetting, setNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";
import { isTravelAdvanceType } from "../../lib/travel.js";
import { advanceWorkflowStep, getAdvanceById } from "../advances/advances.service.js";
import { canApproveStep, findPendingAccommodationStep, type ChainStep } from "../../lib/workflowEngine.js";
import { isCaptureActionType } from "../inbox/inbox.routes.js";
import { getDelegatedManagerIds } from "../../lib/delegations.js";
import { notifyAdvanceTask } from "../../lib/notifications.js";
import { getAdvanceNotificationContext, writeAdvanceAudit } from "../advances/advances.routes.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { resolveAccommodationPdfData, getFieldCatalogFor } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";
import { formatPaymentReference } from "../../lib/pdf/pdfHelpers.js";

const LESOTHO_DISTRICTS = [
  "Butha-Buthe",
  "Leribe",
  "Berea",
  "Maseru",
  "Mafeteng",
  "Mohale's Hoek",
  "Quthing",
  "Qacha's Nek",
  "Mokhotlong",
  "Thaba-Tseka"
] as const;

const HotelBaseSchema = z.object({
  name: z.string().trim().min(1),
  district: z.string().trim().optional(),
  country: z.string().trim().optional(),
  province: z.string().trim().optional(),
  city: z.string().trim().optional(),
  address: z.string().trim().optional(),
  contact: z.string().trim().optional()
});

const HotelCreateSchema = HotelBaseSchema.superRefine((data, ctx) => {
  const hasDistrict = Boolean(String(data.district || "").trim());
  const hasCountryCity = Boolean(String(data.country || "").trim() && String(data.city || "").trim());
  if (!hasDistrict && !hasCountryCity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["district"], message: "district or country/city is required" });
  }
  if (String(data.country || "").trim().toLowerCase() === "south africa" && !String(data.province || "").trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["province"], message: "province is required for South Africa" });
  }
});

const HotelUpdateSchema = HotelBaseSchema.partial();

const MealValueSchema = z.object({
  meal_value: z.coerce.number().nonnegative("meal value must be zero or greater")
});

const CreateAccommodationSchema = z.object({
  advance_request_id: z.string().uuid(),
  location: z.string().trim().min(1, "location is required"),
  provider: z.string().trim().optional(),
  check_in: z.string().optional(),
  check_out: z.string().optional(),
  amount: z.coerce.number().positive("amount must be greater than 0"),
  notes: z.string().trim().optional()
});

const RejectSchema = z.object({
  comments: z.string().trim().min(1, "comments are required")
});

const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const suffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${suffix}-${sanitizeUploadFilename(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["pdf", "jpg", "jpeg", "png", "doc", "docx"])
});

export const accommodationRouter = Router();
accommodationRouter.use(requireAuth);

// Hotels CRUD - who can onboard hotels is admin-configurable via the
// "travel_setup" feature (Roles & Permissions), same as the frontend's own
// gate on the Travel Setup page - previously this was a hardcoded
// MANAGER/ADMIN role check here while the frontend showed the Add/Edit/
// Delete controls to anyone granted travel_setup access (role or
// permission group), so someone granted access through a group (e.g. HR
// Operations) could see the buttons but every write would 403.
accommodationRouter.get("/hotels", async (req: AuthedRequest, res, next) => {
  try {
    const search = String(req.query.search || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const params: unknown[] = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE name ILIKE $${params.length} OR district ILIKE $${params.length} OR country ILIKE $${params.length} OR province ILIKE $${params.length} OR city ILIKE $${params.length}`;
    }
    const total = (
      await query<{ count: string }>(`SELECT count(*)::text AS count FROM accommodation_hotels ${where}`, params)
    )[0]?.count ?? "0";
    params.push(limit, offset);
    const rows = await query(
      `SELECT * FROM accommodation_hotels ${where}
        ORDER BY country NULLS LAST, province NULLS LAST, city NULLS LAST, district NULLS LAST, name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({ items: rows, total: Number(total), limit, offset });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.post("/hotels", requireFeatureAccess("travel_setup", ["MANAGER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const body = HotelCreateSchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid hotel payload", body.error.flatten());
    const rows = await query<{ id: string }>(
      `INSERT INTO accommodation_hotels (name, district, country, province, city, address, contact, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        body.data.name,
        body.data.district ?? null,
        body.data.country ?? null,
        body.data.province ?? null,
        body.data.city ?? null,
        body.data.address ?? null,
        body.data.contact ?? null,
        req.user!.userId
      ]
    );
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.put("/hotels/:id", requireFeatureAccess("travel_setup", ["MANAGER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const body = HotelUpdateSchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid hotel payload", body.error.flatten());
    const updates: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(body.data)) {
      if (v === undefined) continue;
      params.push(v);
      updates.push(`${k}=$${params.length}`);
    }
    if (updates.length === 0) return res.json({ ok: true });
    params.push(req.params.id);
    await query(`UPDATE accommodation_hotels SET ${updates.join(",")}, updated_at=now() WHERE id=$${params.length}`, params);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.delete("/hotels/:id", requireFeatureAccess("travel_setup", ["MANAGER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<{ id: string }>(
      `DELETE FROM accommodation_hotels WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound("Hotel not found");
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.get("/meal-value", async (_req: AuthedRequest, res, next) => {
  try {
    const mealValue = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.mealValue, 0);
    return res.json({ meal_value: mealValue });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.put("/meal-value", requireRole(["MANAGER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const body = MealValueSchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid meal value payload", body.error.flatten());
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.mealValue, Number(body.data.meal_value.toFixed(2)));
    return res.json({ meal_value: Number(body.data.meal_value.toFixed(2)) });
  } catch (err) {
    return next(err);
  }
});

async function writeAccommodationAudit(args: {
  actorId: string;
  accommodationId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}) {
  await query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json)
     VALUES ($1,$2,'accommodation_requests',$3,$4,$5)`,
    [
      args.actorId,
      args.action,
      args.accommodationId,
      args.before ? JSON.stringify(args.before) : null,
      args.after ? JSON.stringify(args.after) : null
    ]
  );
}

async function getAccommodationById(id: string) {
  const rows = await query<any>(
    `SELECT acc.*,
            creator.full_name AS created_by_name,
            requester.full_name AS requester_name,
            requester.department AS requester_department,
            ar.purpose AS advance_purpose,
            ar.status AS advance_status
       FROM accommodation_requests acc
       JOIN users creator ON creator.id = acc.created_by_id
       JOIN users requester ON requester.id = acc.requester_id
       JOIN advance_requests ar ON ar.id = acc.advance_request_id
      WHERE acc.id=$1`,
    [id]
  );
  const row = rows[0] ?? null;
  if (!row) return null;
  const quotations = await query<any>(
    `SELECT id,
            quotation_path AS path,
            substring(quotation_path from '[^/]+$') AS file_name,
            quotation_uploaded_at,
            quotation_uploaded_by_id
       FROM accommodation_quotations
      WHERE accommodation_request_id=$1
      ORDER BY quotation_uploaded_at ASC`,
    [id]
  );
  return { ...row, quotations };
}

// Accommodation is captured/paid centrally by MNO's own Finance/Treasury
// team for every company (unlike Advance capture, which each company's own
// finance team handles for itself) - so acting on a booking is gated purely
// on the actor's OWN is_compensation_finance flag, company-agnostic, never
// on which company the booking itself belongs to.
async function canActOnAccommodation(actor: { role: string; sectionId?: string | null }): Promise<boolean> {
  return actor.role === "ADMIN" || isCompensationFinanceSection(actor.sectionId);
}

// A non-Treasury viewer (e.g. SEFS's own finance-adjacent staff) can see -
// but never act on - a booking for their own company: specifically, whoever
// would be eligible to act on the *linked advance's own* Capture step (that
// advance's chain is already resolved per the requester's own division at
// submission time, so this is naturally scoped to that one company, no
// separate division filter needed).
async function isEligibleOnLinkedAdvanceCaptureStep(row: any, actor: { userId: string; role: string; sectionId?: string | null }): Promise<boolean> {
  const advance = await getAdvanceById(row.advance_request_id);
  const chain = (advance?.approval_chain ?? []) as ChainStep[];
  const captureStep = chain.find((s) => isCaptureActionType(s.action_type));
  if (!captureStep) return false;
  const delegatedManagerIds = await getDelegatedManagerIds(actor.userId, "ADVANCE_REQUEST");
  return canApproveStep(captureStep, actor.userId, actor.role, delegatedManagerIds, actor.sectionId);
}

async function canViewAccommodation(args: { role: string; sectionId?: string | null; userId: string; row: any }) {
  if (await canActOnAccommodation(args)) return true;
  if (args.row.created_by_id === args.userId) return true;
  if (args.row.requester_id === args.userId) return true;
  return isEligibleOnLinkedAdvanceCaptureStep(args.row, args);
}

accommodationRouter.get("/", requireFeatureAccess("accommodation", ["ADMIN", "Section: Human Resources Operations", "Section: Treasury & Financial Accounting"]), async (req: AuthedRequest, res, next) => {
  try {
    const mine = req.query.mine === "true";
    const params: unknown[] = [];
    let where = "";

    if (mine) {
      params.push(req.user!.userId);
      where = "WHERE acc.created_by_id=$1 OR acc.requester_id=$1";
    } else if (req.user!.role === "ADMIN" || (await isCompensationFinanceSection(req.user!.sectionId))) {
      where = "";
    } else {
      // Anyone who booked it (e.g. HR Operations staff, regardless of role)
      // or who it's for can see it - not just MANAGER-role bookers.
      params.push(req.user!.userId);
      where = "WHERE acc.created_by_id=$1 OR acc.requester_id=$1";
    }

    const rows = await query<any>(
      `SELECT acc.*,
              creator.full_name AS created_by_name,
              requester.full_name AS requester_name,
              requester.department AS requester_department
         FROM accommodation_requests acc
         JOIN users creator ON creator.id = acc.created_by_id
         JOIN users requester ON requester.id = acc.requester_id
        ${where}
        ORDER BY acc.created_at DESC`,
      params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// Accommodation payments endpoint - mirrors advances/payments but for accommodation records
// Returns submitted and paid accommodation bookings for payment tracking
accommodationRouter.get("/payments", async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user!.role;
    // Mirror GET /advances/payments' permission check exactly: also honor the
    // admin-configured "payments" group grant (admin_feature_permissions), not
    // just real Finance-section authority. Without this, a user granted access
    // via a group (e.g. "Department: Finance Operations") could see/act on the
    // advances side of the combined Payments page but get a hard 403 here,
    // which - since the frontend fetches both in one Promise.all - blanks out
    // the entire page instead of just omitting accommodation rows.
    const isCentralFinance = await isCompensationFinanceUser(req);
    const allowed = (await hasFeatureAccess(req.user!.userId, role, "payments", ["ADMIN", "Department: Finance"]))
      || isCentralFinance;
    if (!allowed) throw forbidden();

    const statusParam = String(req.query.status || "all") as "pending" | "paid" | "all";
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const rows = await query<any>(
      `SELECT acc.id, acc.status, acc.amount, acc.location, acc.provider,
              acc.created_at, acc.paid_at, acc.paid_reference,
              acc.created_by_id, acc.requester_id,
              requester.full_name AS requester_name, requester.department,
              dv.name AS division, COALESCE(tt.currency, 'LSL') AS currency
         FROM accommodation_requests acc
         JOIN users requester ON requester.id = acc.requester_id
         JOIN advance_requests ar ON ar.id = acc.advance_request_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
         LEFT JOIN divisions dv ON dv.id = requester.division_id
        WHERE acc.status IN ('SUBMITTED','PAID')
        ORDER BY acc.created_at DESC`
    );

    const items: any[] = [];
    for (const a of rows) {
      const canSeeAllAccommodation = role === "ADMIN" || isCentralFinance;
      const isOwner = a.created_by_id === req.user!.userId || a.requester_id === req.user!.userId;
      if (!canSeeAllAccommodation && !isOwner) continue;

      items.push({
        doc_type: "ACCOMMODATION",
        id: a.id,
        status: a.status,
        payment_status: a.status === "PAID" ? "PAID" : "PENDING",
        type: "ACCOMMODATION",
        currency: a.currency,
        requested_total: Number(a.amount),
        approved_total: Number(a.amount),
        purpose: [a.location, a.provider].filter(Boolean).join(" - ") || "Accommodation booking",
        requester_name: a.requester_name,
        department: a.department,
        division: a.division ?? null,
        created_at: a.created_at,
        paid_at: a.paid_at,
        paid_reference: a.paid_reference,
        approved_by_name: null,
        pdf_filename: `accommodation-${a.id}.pdf`
      });
    }

    items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const filtered = statusParam === "all" ? items : items.filter((r) => r.payment_status === statusParam.toUpperCase());
    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);
    return res.json({ items: paginated, total, limit, offset });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateAccommodationSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid accommodation payload", parsed.error.flatten());

    const advance = await getAdvanceById(parsed.data.advance_request_id);
    if (!advance) throw badRequest("Linked advance not found");
    if (!(await isTravelAdvanceType(advance.type))) throw badRequest("Accommodation requests can only be linked to travel advances");

    // Only the person assigned to the advance's accommodation step may attach
    // a booking. Found by scanning the whole chain for the still-unapproved
    // requires_accommodation step (not just the current pending group) since
    // it's parallel/non-blocking and the chain's position can move past it
    // once Capture/payment complete - see findPendingAccommodationStep.
    const role = req.user!.role;
    if (role !== "ADMIN") {
      if (!advance.approval_chain?.length) throw badRequest("This advance does not have an active approval workflow.");
      const chain = advance.approval_chain as ChainStep[];
      const accommodationStep = findPendingAccommodationStep(chain);
      if (!accommodationStep) throw badRequest("This advance's accommodation step has already been completed or is not part of its workflow.");
      const delegatedManagerIds = await getDelegatedManagerIds(req.user!.userId, "ADVANCE_REQUEST");
      const eligible = await canApproveStep(accommodationStep.step, req.user!.userId, role, delegatedManagerIds, req.user!.sectionId);
      if (!eligible) throw forbidden(`You are not the assigned approver for step: ${accommodationStep.step.position_name}`);
    }

    const rows = await query<{ id: string }>(
      `INSERT INTO accommodation_requests
        (advance_request_id, requester_id, created_by_id, location, provider, check_in, check_out, amount, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT')
       RETURNING id`,
      [
        parsed.data.advance_request_id,
        advance.requester_id,
        req.user!.userId,
        parsed.data.location,
        parsed.data.provider ?? null,
        parsed.data.check_in ?? null,
        parsed.data.check_out ?? null,
        parsed.data.amount,
        parsed.data.notes ?? null
      ]
    );

    await writeAccommodationAudit({
      actorId: req.user!.userId,
      accommodationId: rows[0].id,
      action: "ACCOMMODATION_CREATE",
      after: { status: "DRAFT", amount: parsed.data.amount, advance_request_id: parsed.data.advance_request_id }
    });

    return res.status(201).json({ id: rows[0].id, status: "DRAFT" });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.post("/:id/upload-quotation", upload.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
    if (row.created_by_id !== req.user!.userId && req.user!.role !== "ADMIN") {
      throw forbidden("Only the requesting HR user can upload quotations for this accommodation request");
    }
    if (row.status !== "DRAFT") throw badRequest("Quotations can only be uploaded while the accommodation request is in draft");
    if (!req.file) throw badRequest("Quotation file is required");

    await query(
      `INSERT INTO accommodation_quotations
        (accommodation_request_id, quotation_path, quotation_uploaded_at, quotation_uploaded_by_id)
       VALUES ($1,$2,now(),$3)`,
      [req.params.id, req.file.path, req.user!.userId]
    );

    await query(
      `UPDATE accommodation_requests
          SET quotation_path=$2,
              quotation_uploaded_at=now(),
              quotation_uploaded_by_id=$3,
              updated_at=now()
        WHERE id=$1`,
      [req.params.id, req.file.path, req.user!.userId]
    );

    await writeAccommodationAudit({
      actorId: req.user!.userId,
      accommodationId: req.params.id,
      action: "ACCOMMODATION_QUOTATION_UPLOAD",
      after: { quotation_path: req.file.path }
    });

    return res.json({ ok: true, quotation_path: req.file.path });
  } catch (err) {
    return next(err);
  }
});

// HR sends the accommodation booking to Finance and, in the same action,
// forwards the linked advance request to the next workflow step — HR does not
// separately "approve" the advance at this stage.
accommodationRouter.post("/:id/send-to-finance", async (req: AuthedRequest, res, next) => {
  try {
    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
    if (row.created_by_id !== req.user!.userId && req.user!.role !== "ADMIN") {
      throw forbidden("Only the requesting HR user can send this accommodation request to finance");
    }
    if (row.status !== "DRAFT") throw badRequest("Only draft accommodation requests can be sent to finance");

    await query(
      `UPDATE accommodation_requests
          SET status='SUBMITTED',
              updated_at=now()
        WHERE id=$1`,
      [req.params.id]
    );

    await writeAccommodationAudit({
      actorId: req.user!.userId,
      accommodationId: req.params.id,
      action: "ACCOMMODATION_SEND_TO_FINANCE",
      before: { status: row.status },
      after: { status: "SUBMITTED" }
    });

    // Multi-destination trips can have several accommodation bookings (one per
    // destination district) attached to the same advance. They are all created
    // as DRAFT, but only the last one triggers send-to-finance, which advances
    // the advance's workflow step once for the whole batch — so submit any
    // remaining sibling drafts alongside it here.
    const siblingDrafts = await query<{ id: string }>(
      `UPDATE accommodation_requests
          SET status='SUBMITTED',
              updated_at=now()
        WHERE advance_request_id=$1 AND id<>$2 AND status='DRAFT' AND created_by_id=$3
        RETURNING id`,
      [row.advance_request_id, req.params.id, req.user!.userId]
    );
    for (const sibling of siblingDrafts) {
      await writeAccommodationAudit({
        actorId: req.user!.userId,
        accommodationId: sibling.id,
        action: "ACCOMMODATION_SEND_TO_FINANCE",
        before: { status: "DRAFT" },
        after: { status: "SUBMITTED" }
      });
    }

    const userId = req.user!.userId;
    const role = req.user!.role;
    const adv = await getAdvanceById(row.advance_request_id);
    let advanceStatus: string | null = null;
    if (adv) {
      const delegatedManagerIds = await getDelegatedManagerIds(userId, "ADVANCE_REQUEST");
      const result = await advanceWorkflowStep({ adv, userId, role, delegatedManagerIds });
      advanceStatus = result.nextStatus;
      await writeAdvanceAudit({
        actorId: userId,
        advanceId: adv.id,
        action: "ADVANCE_APPROVE",
        before: { status: adv.status, approved_total: Number(adv.approved_total || 0) },
        after: {
          status: result.nextStatus,
          approved_total: Number(adv.approved_total || adv.requested_total),
          workflow_step: result.newStepOrder,
          step_name: result.hasMore ? (adv.approval_chain as ChainStep[])[result.newStepOrder].position_name : "Complete"
        }
      });
      const notificationContext = await getAdvanceNotificationContext(adv.id);
      if (notificationContext) {
        await notifyAdvanceTask({
          advanceId: adv.id,
          status: result.nextStatus,
          advanceType: notificationContext.type,
          requesterName: notificationContext.full_name,
          requesterEmail: notificationContext.email,
          department: notificationContext.department,
          requestedTotal: Number(notificationContext.requested_total),
          currency: notificationContext.currency,
          nextApprover: result.nextApprover
        });
      }
    }

    return res.json({ ok: true, status: "SUBMITTED", advance_status: advanceStatus });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
    if (!(await canViewAccommodation({ role: req.user!.role, sectionId: req.user!.sectionId, userId: req.user!.userId, row }))) throw forbidden();
    const isOwner = row.requester_id === req.user!.userId || row.created_by_id === req.user!.userId;
    const can_view_pdf = await canAccessPdf({ requestType: "ACCOMMODATION_REQUEST", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" });
    return res.json({ ...row, can_view_pdf });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.get("/:id/pdf", async (req: AuthedRequest, res, next) => {
  try {
    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
    if (!(await canViewAccommodation({ role: req.user!.role, sectionId: req.user!.sectionId, userId: req.user!.userId, row }))) throw forbidden();
    const isOwner = row.requester_id === req.user!.userId || row.created_by_id === req.user!.userId;
    if (!(await canAccessPdf({ requestType: "ACCOMMODATION_REQUEST", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" }))) {
      throw forbidden();
    }

    const template = (await query<any>(`SELECT * FROM pdf_templates WHERE request_type = 'ACCOMMODATION_REQUEST' AND status = 'ACTIVE' LIMIT 1`))[0];
    if (!template) throw badRequest("No PDF template configured for accommodation requests yet.");

    const data = await resolveAccommodationPdfData(req.params.id);
    const catalog = await getFieldCatalogFor("ACCOMMODATION_REQUEST");
    const letterhead = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
    };
    const doc = renderPdfTemplate(template, letterhead, data, catalog);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="accommodation-${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

// The reference is generated the same way an advance's own mark-paid does
// (payment_ref_seq -> formatPaymentReference) rather than typed in by
// Finance, so there's no free-text "budget code" to get wrong or leave blank.
accommodationRouter.post("/:id/mark-paid", async (req: AuthedRequest, res, next) => {
  try {
    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
    if (!(await canActOnAccommodation({ role: req.user!.role, sectionId: req.user!.sectionId }))) throw forbidden();
    if (row.status !== "SUBMITTED") throw badRequest("Only submitted accommodation requests can be paid");

    const seqRows = await query<{ seq: string }>(`SELECT nextval('payment_ref_seq') AS seq`);
    const paidReference = formatPaymentReference(Number(seqRows[0].seq));

    await query(
      `UPDATE accommodation_requests
          SET status='PAID',
              paid_reference=$2,
              paid_at=now(),
              updated_at=now()
        WHERE id=$1`,
      [req.params.id, paidReference]
    );

    await writeAccommodationAudit({
      actorId: req.user!.userId,
      accommodationId: req.params.id,
      action: "ACCOMMODATION_MARK_PAID",
      before: { status: row.status },
      after: { status: "PAID", paid_reference: paidReference }
    });

    return res.json({ ok: true, status: "PAID", paid_reference: paidReference });
  } catch (err) {
    return next(err);
  }
});

// The accommodation-side counterpart to the advance's own /recall-payment -
// this booking's own mark-paid is a plain SUBMITTED->PAID flip (no workflow
// chain to restore), so recalling it is just as plain in reverse.
accommodationRouter.post("/:id/recall-payment", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("A reason is required to recall a payment", parsed.error.flatten());

    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
    if (!(await canActOnAccommodation({ role: req.user!.role, sectionId: req.user!.sectionId }))) throw forbidden();
    if (row.status !== "PAID") throw badRequest("Only a paid accommodation booking can have its payment recalled.");

    await query(
      `UPDATE accommodation_requests
          SET status='SUBMITTED',
              paid_reference=NULL,
              paid_at=NULL,
              updated_at=now()
        WHERE id=$1`,
      [req.params.id]
    );

    await writeAccommodationAudit({
      actorId: req.user!.userId,
      accommodationId: req.params.id,
      action: "ACCOMMODATION_PAYMENT_RECALLED",
      before: { status: "PAID", paid_reference: row.paid_reference },
      after: { status: "SUBMITTED", comments: parsed.data.comments }
    });

    return res.json({ ok: true, status: "SUBMITTED" });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for reject", parsed.error.flatten());

    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
    if (!(await canActOnAccommodation({ role: req.user!.role, sectionId: req.user!.sectionId }))) throw forbidden();
    if (row.status !== "SUBMITTED") throw badRequest("Only submitted accommodation requests can be rejected");

    await query(
      `UPDATE accommodation_requests
          SET status='REJECTED',
              rejection_comments=$2,
              updated_at=now()
        WHERE id=$1`,
      [req.params.id, parsed.data.comments]
    );

    await writeAccommodationAudit({
      actorId: req.user!.userId,
      accommodationId: req.params.id,
      action: "ACCOMMODATION_REJECT",
      before: { status: row.status },
      after: { status: "REJECTED", comments: parsed.data.comments }
    });

    return res.json({ ok: true, status: "REJECTED" });
  } catch (err) {
    return next(err);
  }
});
