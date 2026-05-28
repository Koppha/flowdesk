import fs from "fs";
import path from "path";
import multer from "multer";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getNumericSystemSetting, setNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
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
];
const districtSchema = z.string().trim().refine((value) => LESOTHO_DISTRICTS.includes(value), {
    message: "district must be one of the 10 Lesotho districts"
});
const HotelCreateSchema = z.object({
    name: z.string().trim().min(1),
    district: districtSchema,
    address: z.string().trim().optional(),
    contact: z.string().trim().optional(),
    department: z.string().trim().optional()
});
const HotelUpdateSchema = HotelCreateSchema.partial();
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
if (!fs.existsSync(uploadDir))
    fs.mkdirSync(uploadDir, { recursive: true });
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
accommodationRouter.get("/hotels", async (_req, res, next) => {
    try {
        const rows = await query(`SELECT * FROM accommodation_hotels ORDER BY district NULLS LAST, name`);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.post("/hotels", requireRole(["HR_MANAGER", "AUTH_OFFICER", "ADMIN"]), async (req, res, next) => {
    try {
        const body = HotelCreateSchema.safeParse(req.body);
        if (!body.success)
            throw badRequest("Invalid hotel payload", body.error.flatten());
        const rows = await query(`INSERT INTO accommodation_hotels (name, district, address, contact, department, created_by_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [body.data.name, body.data.district, body.data.address ?? null, body.data.contact ?? null, body.data.department ?? null, req.user.userId]);
        return res.status(201).json({ id: rows[0].id });
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.put("/hotels/:id", requireRole(["HR_MANAGER", "AUTH_OFFICER", "ADMIN"]), async (req, res, next) => {
    try {
        const body = HotelUpdateSchema.safeParse(req.body);
        if (!body.success)
            throw badRequest("Invalid hotel payload", body.error.flatten());
        const updates = [];
        const params = [];
        for (const [k, v] of Object.entries(body.data)) {
            if (v === undefined)
                continue;
            params.push(v);
            updates.push(`${k}=$${params.length}`);
        }
        if (updates.length === 0)
            return res.json({ ok: true });
        params.push(req.params.id);
        await query(`UPDATE accommodation_hotels SET ${updates.join(",")}, updated_at=now() WHERE id=$${params.length}`, params);
        return res.json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.get("/meal-value", async (_req, res, next) => {
    try {
        const mealValue = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.mealValue, 0);
        return res.json({ meal_value: mealValue });
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.put("/meal-value", requireRole(["HR_MANAGER", "AUTH_OFFICER", "ADMIN"]), async (req, res, next) => {
    try {
        const body = MealValueSchema.safeParse(req.body);
        if (!body.success)
            throw badRequest("Invalid meal value payload", body.error.flatten());
        await setNumericSystemSetting(SYSTEM_SETTING_KEYS.mealValue, Number(body.data.meal_value.toFixed(2)));
        return res.json({ meal_value: Number(body.data.meal_value.toFixed(2)) });
    }
    catch (err) {
        return next(err);
    }
});
async function writeAccommodationAudit(args) {
    await query(`INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json)
     VALUES ($1,$2,'accommodation_requests',$3,$4,$5)`, [
        args.actorId,
        args.action,
        args.accommodationId,
        args.before ? JSON.stringify(args.before) : null,
        args.after ? JSON.stringify(args.after) : null
    ]);
}
async function getAccommodationById(id) {
    const rows = await query(`SELECT acc.*,
            creator.full_name AS created_by_name,
            requester.full_name AS requester_name,
            requester.department AS requester_department,
            ar.purpose AS advance_purpose,
            ar.status AS advance_status
       FROM accommodation_requests acc
       JOIN users creator ON creator.id = acc.created_by_id
       JOIN users requester ON requester.id = acc.requester_id
       JOIN advance_requests ar ON ar.id = acc.advance_request_id
      WHERE acc.id=$1`, [id]);
    const row = rows[0] ?? null;
    if (!row)
        return null;
    const quotations = await query(`SELECT id,
            quotation_path AS path,
            substring(quotation_path from '[^/]+$') AS file_name,
            quotation_uploaded_at,
            quotation_uploaded_by_id
       FROM accommodation_quotations
      WHERE accommodation_request_id=$1
      ORDER BY quotation_uploaded_at ASC`, [id]);
    return { ...row, quotations };
}
function canViewAccommodation(args) {
    if (args.role === "ADMIN" || args.role === "FINANCE")
        return true;
    if (args.role === "AUTH_OFFICER" && args.row.created_by_id === args.userId)
        return true;
    if (args.row.requester_id === args.userId)
        return true;
    return false;
}
accommodationRouter.get("/", async (req, res, next) => {
    try {
        const mine = req.query.mine === "true";
        const params = [];
        let where = "";
        if (mine) {
            params.push(req.user.userId);
            where = "WHERE acc.created_by_id=$1 OR acc.requester_id=$1";
        }
        else if (req.user.role === "FINANCE" || req.user.role === "ADMIN") {
            where = "";
        }
        else if (req.user.role === "AUTH_OFFICER") {
            params.push(req.user.userId);
            where = "WHERE acc.created_by_id=$1";
        }
        else {
            params.push(req.user.userId);
            where = "WHERE acc.requester_id=$1";
        }
        const rows = await query(`SELECT acc.*,
              creator.full_name AS created_by_name,
              requester.full_name AS requester_name,
              requester.department AS requester_department
         FROM accommodation_requests acc
         JOIN users creator ON creator.id = acc.created_by_id
         JOIN users requester ON requester.id = acc.requester_id
        ${where}
        ORDER BY acc.created_at DESC`, params);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.post("/", requireRole(["AUTH_OFFICER", "ADMIN"]), async (req, res, next) => {
    try {
        const parsed = CreateAccommodationSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid accommodation payload", parsed.error.flatten());
        const advance = (await query(`SELECT ar.id, ar.requester_id, ar.type, ar.status
           FROM advance_requests ar
          WHERE ar.id=$1`, [parsed.data.advance_request_id]))[0];
        if (!advance)
            throw badRequest("Linked advance not found");
        if (advance.type !== "TRAVEL_SUBSISTENCE")
            throw badRequest("Accommodation requests can only be linked to travel advances");
        if (advance.status !== "HR_REVIEW") {
            throw badRequest("Travel advance must be in HR review stage before accommodation can be booked");
        }
        const rows = await query(`INSERT INTO accommodation_requests
        (advance_request_id, requester_id, created_by_id, location, provider, check_in, check_out, amount, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT')
       RETURNING id`, [
            parsed.data.advance_request_id,
            advance.requester_id,
            req.user.userId,
            parsed.data.location,
            parsed.data.provider ?? null,
            parsed.data.check_in ?? null,
            parsed.data.check_out ?? null,
            parsed.data.amount,
            parsed.data.notes ?? null
        ]);
        await writeAccommodationAudit({
            actorId: req.user.userId,
            accommodationId: rows[0].id,
            action: "ACCOMMODATION_CREATE",
            after: { status: "DRAFT", amount: parsed.data.amount, advance_request_id: parsed.data.advance_request_id }
        });
        return res.status(201).json({ id: rows[0].id, status: "DRAFT" });
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.post("/:id/upload-quotation", requireRole(["AUTH_OFFICER", "ADMIN"]), upload.single("file"), async (req, res, next) => {
    try {
        const row = await getAccommodationById(req.params.id);
        if (!row)
            throw notFound();
        if (row.created_by_id !== req.user.userId && req.user.role !== "ADMIN") {
            throw forbidden("Only the requesting HR user can upload quotations for this accommodation request");
        }
        if (row.status !== "DRAFT")
            throw badRequest("Quotations can only be uploaded while the accommodation request is in draft");
        if (!req.file)
            throw badRequest("Quotation file is required");
        await query(`INSERT INTO accommodation_quotations
        (accommodation_request_id, quotation_path, quotation_uploaded_at, quotation_uploaded_by_id)
       VALUES ($1,$2,now(),$3)`, [req.params.id, req.file.path, req.user.userId]);
        await query(`UPDATE accommodation_requests
          SET quotation_path=$2,
              quotation_uploaded_at=now(),
              quotation_uploaded_by_id=$3,
              updated_at=now()
        WHERE id=$1`, [req.params.id, req.file.path, req.user.userId]);
        await writeAccommodationAudit({
            actorId: req.user.userId,
            accommodationId: req.params.id,
            action: "ACCOMMODATION_QUOTATION_UPLOAD",
            after: { quotation_path: req.file.path }
        });
        return res.json({ ok: true, quotation_path: req.file.path });
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.post("/:id/send-to-finance", requireRole(["AUTH_OFFICER", "ADMIN"]), async (req, res, next) => {
    try {
        const row = await getAccommodationById(req.params.id);
        if (!row)
            throw notFound();
        if (row.created_by_id !== req.user.userId && req.user.role !== "ADMIN") {
            throw forbidden("Only the requesting HR user can send this accommodation request to finance");
        }
        if (row.status !== "DRAFT")
            throw badRequest("Only draft accommodation requests can be sent to finance");
        await query(`UPDATE accommodation_requests
          SET status='SUBMITTED',
              updated_at=now()
        WHERE id=$1`, [req.params.id]);
        await writeAccommodationAudit({
            actorId: req.user.userId,
            accommodationId: req.params.id,
            action: "ACCOMMODATION_SEND_TO_FINANCE",
            before: { status: row.status },
            after: { status: "SUBMITTED" }
        });
        return res.json({ ok: true, status: "SUBMITTED" });
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.get("/:id", async (req, res, next) => {
    try {
        const row = await getAccommodationById(req.params.id);
        if (!row)
            throw notFound();
        if (!canViewAccommodation({ role: req.user.role, userId: req.user.userId, row }))
            throw forbidden();
        return res.json(row);
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.post("/:id/mark-paid", requireRole(["FINANCE", "ADMIN"]), async (req, res, next) => {
    try {
        const parsed = MarkPaidSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid payload", parsed.error.flatten());
        const row = await getAccommodationById(req.params.id);
        if (!row)
            throw notFound();
        if (row.status !== "SUBMITTED")
            throw badRequest("Only submitted accommodation requests can be paid");
        await query(`UPDATE accommodation_requests
          SET status='PAID',
              paid_reference=$2,
              paid_at=now(),
              updated_at=now()
        WHERE id=$1`, [req.params.id, parsed.data.paid_reference]);
        await writeAccommodationAudit({
            actorId: req.user.userId,
            accommodationId: req.params.id,
            action: "ACCOMMODATION_MARK_PAID",
            before: { status: row.status },
            after: { status: "PAID", paid_reference: parsed.data.paid_reference }
        });
        return res.json({ ok: true, status: "PAID" });
    }
    catch (err) {
        return next(err);
    }
});
accommodationRouter.post("/:id/reject", requireRole(["FINANCE", "ADMIN"]), async (req, res, next) => {
    try {
        const parsed = RejectSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Comments are required for reject", parsed.error.flatten());
        const row = await getAccommodationById(req.params.id);
        if (!row)
            throw notFound();
        if (row.status !== "SUBMITTED")
            throw badRequest("Only submitted accommodation requests can be rejected");
        await query(`UPDATE accommodation_requests
          SET status='REJECTED',
              rejection_comments=$2,
              updated_at=now()
        WHERE id=$1`, [req.params.id, parsed.data.comments]);
        await writeAccommodationAudit({
            actorId: req.user.userId,
            accommodationId: req.params.id,
            action: "ACCOMMODATION_REJECT",
            before: { status: row.status },
            after: { status: "REJECTED", comments: parsed.data.comments }
        });
        return res.json({ ok: true, status: "REJECTED" });
    }
    catch (err) {
        return next(err);
    }
});
