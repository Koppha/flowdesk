import fs from "fs";
import path from "path";
import multer from "multer";
import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, isFinanceDept, requireAuth, requireFinance, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getNumericSystemSetting, setNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { isTravelAdvanceType } from "../../lib/travel.js";
import { advanceWorkflowStep, getAdvanceById } from "../advances/advances.service.js";
import { canApproveStep, getPendingGroup, type ChainStep } from "../../lib/workflowEngine.js";
import { getActiveManagerDelegation } from "../../lib/delegations.js";
import { notifyAdvanceTask } from "../../lib/notifications.js";
import { getAdvanceNotificationContext, writeAdvanceAudit } from "../advances/advances.routes.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { resolveAccommodationPdfData, getFieldCatalogFor } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";

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

const MarkPaidSchema = z.object({
  paid_reference: z.string().trim().min(1, "payment reference is required")
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
    cb(null, `${suffix}-${file.originalname}`);
  }
});

const upload = multer({ storage });

export const accommodationRouter = Router();
accommodationRouter.use(requireAuth);

// Hotels CRUD - HR Managers can onboard hotels
accommodationRouter.get("/hotels", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query(`SELECT * FROM accommodation_hotels ORDER BY country NULLS LAST, province NULLS LAST, city NULLS LAST, district NULLS LAST, name`);
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.post("/hotels", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
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

accommodationRouter.put("/hotels/:id", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
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

accommodationRouter.delete("/hotels/:id", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
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

accommodationRouter.put("/meal-value", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
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

function canViewAccommodation(args: { role: string; department?: string | null; userId: string; row: any }) {
  if (args.role === "ADMIN" || isFinanceDept(args.department)) return true;
  if (args.role === "MANAGER" && args.row.created_by_id === args.userId) return true;
  if (args.row.requester_id === args.userId) return true;
  return false;
}

accommodationRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const mine = req.query.mine === "true";
    const params: unknown[] = [];
    let where = "";

    if (mine) {
      params.push(req.user!.userId);
      where = "WHERE acc.created_by_id=$1 OR acc.requester_id=$1";
    } else if (req.user!.role === "ADMIN" || isFinanceDept(req.user!.department)) {
      where = "";
    } else if (req.user!.role === "MANAGER") {
      params.push(req.user!.userId);
      where = "WHERE acc.created_by_id=$1";
    } else {
      params.push(req.user!.userId);
      where = "WHERE acc.requester_id=$1";
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

accommodationRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateAccommodationSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid accommodation payload", parsed.error.flatten());

    const advance = await getAdvanceById(parsed.data.advance_request_id);
    if (!advance) throw badRequest("Linked advance not found");
    if (!(await isTravelAdvanceType(advance.type))) throw badRequest("Accommodation requests can only be linked to travel advances");

    // Only the person whose turn it currently is on the advance's approval chain
    // (i.e. the assigned HR/accommodation step) may attach an accommodation booking.
    const role = req.user!.role;
    if (role !== "ADMIN") {
      if (!advance.approval_chain?.length) throw badRequest("This advance does not have an active approval workflow.");
      const chain = advance.approval_chain as ChainStep[];
      const group = getPendingGroup(chain, advance.workflow_step_order ?? 0);
      if (!group.indices.length) throw badRequest("All workflow steps have been completed");
      const delegated = await getActiveManagerDelegation(req.user!.userId);
      let currentStep: ChainStep | undefined;
      for (const idx of group.indices) {
        if (await canApproveStep(chain[idx], req.user!.userId, role, delegated?.manager_id, req.user!.department)) { currentStep = chain[idx]; break; }
      }
      if (!currentStep) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);
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
      const delegated = await getActiveManagerDelegation(userId);
      const result = await advanceWorkflowStep({ adv, userId, role, delegatedManagerId: delegated?.manager_id });
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
    if (!canViewAccommodation({ role: req.user!.role, department: req.user!.department, userId: req.user!.userId, row })) throw forbidden();
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
    if (!canViewAccommodation({ role: req.user!.role, department: req.user!.department, userId: req.user!.userId, row })) throw forbidden();
    const isOwner = row.requester_id === req.user!.userId || row.created_by_id === req.user!.userId;
    if (!(await canAccessPdf({ requestType: "ACCOMMODATION_REQUEST", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" }))) {
      throw forbidden();
    }

    const template = (await query<any>(`SELECT * FROM pdf_templates WHERE request_type = 'ACCOMMODATION_REQUEST' AND status = 'ACTIVE' LIMIT 1`))[0];
    if (!template) throw badRequest("No PDF template configured for accommodation requests yet.");

    const data = await resolveAccommodationPdfData(req.params.id);
    const catalog = await getFieldCatalogFor("ACCOMMODATION_REQUEST");
    const letterhead = (await query<PdfLetterhead>(`SELECT * FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
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

accommodationRouter.post("/:id/mark-paid", requireFinance, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = MarkPaidSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
    if (row.status !== "SUBMITTED") throw badRequest("Only submitted accommodation requests can be paid");

    await query(
      `UPDATE accommodation_requests
          SET status='PAID',
              paid_reference=$2,
              paid_at=now(),
              updated_at=now()
        WHERE id=$1`,
      [req.params.id, parsed.data.paid_reference]
    );

    await writeAccommodationAudit({
      actorId: req.user!.userId,
      accommodationId: req.params.id,
      action: "ACCOMMODATION_MARK_PAID",
      before: { status: row.status },
      after: { status: "PAID", paid_reference: parsed.data.paid_reference }
    });

    return res.json({ ok: true, status: "PAID" });
  } catch (err) {
    return next(err);
  }
});

accommodationRouter.post("/:id/reject", requireFinance, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for reject", parsed.error.flatten());

    const row = await getAccommodationById(req.params.id);
    if (!row) throw notFound();
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
