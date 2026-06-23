import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getTravelTypeByCode, isReservedAdvanceType, listTravelTypes, normalizeTravelCode } from "../../lib/travel.js";
const TravelTypeSchema = z.object({
    code: z.string().trim().optional(),
    name: z.string().trim().min(2, "name is required"),
    location_mode: z.enum(["DISTRICT", "COUNTRY_CITY"]).default("DISTRICT"),
    rate_kind: z.enum(["MEAL", "DAILY"]).default("MEAL"),
    rate_general_staff: z.coerce.number().nonnegative().default(0),
    rate_exco: z.coerce.number().nonnegative().default(0),
    rate_ceo: z.coerce.number().nonnegative().default(0),
    currency: z.string().trim().min(2).max(5).default("LSL"),
    active: z.boolean().optional(),
    requires_accommodation: z.boolean().optional(),
    allowed_payment_methods: z.array(z.enum(["ECOCASH", "BANK"])).min(1, "Select at least one payment method").default(["ECOCASH", "BANK"])
});
const TravelTypeUpdateSchema = TravelTypeSchema.partial();
const TravelLocationSchema = z.object({
    travel_type_id: z.string().uuid().optional(),
    travel_type_code: z.string().trim().optional(),
    district: z.string().trim().optional(),
    country: z.string().trim().optional(),
    province: z.string().trim().optional(),
    city: z.string().trim().optional(),
    active: z.boolean().optional()
});
export const travelRouter = Router();
travelRouter.use(requireAuth);
travelRouter.get("/types", async (req, res, next) => {
    try {
        const includeInactive = ["HR_MANAGER", "MANAGER", "ADMIN"].includes(req.user.role);
        return res.json(await listTravelTypes(includeInactive));
    }
    catch (err) {
        return next(err);
    }
});
travelRouter.post("/types", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req, res, next) => {
    try {
        const parsed = TravelTypeSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid travel type payload", parsed.error.flatten());
        const code = normalizeTravelCode(parsed.data.code || parsed.data.name);
        if (!code)
            throw badRequest("Travel type code is required");
        if (isReservedAdvanceType(code))
            throw badRequest("Salary and loan are reserved advance types");
        const row = (await query(`INSERT INTO travel_types
          (code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, currency, active, requires_accommodation, allowed_payment_methods, created_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name,
               location_mode = EXCLUDED.location_mode,
               rate_kind = EXCLUDED.rate_kind,
               rate_general_staff = EXCLUDED.rate_general_staff,
               rate_exco = EXCLUDED.rate_exco,
               rate_ceo = EXCLUDED.rate_ceo,
               currency = EXCLUDED.currency,
               active = EXCLUDED.active,
               requires_accommodation = EXCLUDED.requires_accommodation,
               allowed_payment_methods = EXCLUDED.allowed_payment_methods,
               updated_at = now()
         RETURNING id`, [
            code,
            parsed.data.name,
            parsed.data.location_mode,
            parsed.data.rate_kind,
            Number(parsed.data.rate_general_staff.toFixed(2)),
            Number(parsed.data.rate_exco.toFixed(2)),
            Number(parsed.data.rate_ceo.toFixed(2)),
            parsed.data.currency,
            parsed.data.active ?? true,
            parsed.data.requires_accommodation ?? false,
            parsed.data.allowed_payment_methods,
            req.user.userId
        ]))[0];
        return res.status(201).json({ id: row.id, code });
    }
    catch (err) {
        return next(err);
    }
});
travelRouter.put("/types/:id", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req, res, next) => {
    try {
        const parsed = TravelTypeUpdateSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid travel type payload", parsed.error.flatten());
        const updates = [];
        const params = [];
        const payload = { ...parsed.data };
        if (payload.code !== undefined) {
            const code = normalizeTravelCode(String(payload.code));
            if (!code)
                throw badRequest("Travel type code is required");
            if (isReservedAdvanceType(code))
                throw badRequest("Salary and loan are reserved advance types");
            payload.code = code;
        }
        for (const [key, value] of Object.entries(payload)) {
            if (value === undefined)
                continue;
            params.push(typeof value === "number" ? Number(value.toFixed(2)) : value);
            updates.push(`${key}=$${params.length}`);
        }
        if (updates.length === 0)
            return res.json({ ok: true });
        params.push(req.params.id);
        const rows = await query(`UPDATE travel_types SET ${updates.join(",")}, updated_at=now() WHERE id=$${params.length} RETURNING id`, params);
        if (!rows[0])
            throw notFound();
        return res.json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
travelRouter.delete("/types/:id", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req, res, next) => {
    try {
        const rows = await query(`DELETE FROM travel_types WHERE id=$1 RETURNING id`, [req.params.id]);
        if (!rows[0])
            throw notFound();
        return res.json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
travelRouter.post("/locations", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req, res, next) => {
    try {
        const parsed = TravelLocationSchema.safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid travel location payload", parsed.error.flatten());
        let travelTypeId = parsed.data.travel_type_id || "";
        let locationMode = "";
        if (!travelTypeId && parsed.data.travel_type_code) {
            const travelType = await getTravelTypeByCode(parsed.data.travel_type_code);
            if (!travelType)
                throw badRequest("Travel type not found");
            travelTypeId = travelType.id;
            locationMode = travelType.location_mode;
        }
        else if (travelTypeId) {
            const row = (await query(`SELECT location_mode FROM travel_types WHERE id=$1`, [travelTypeId]))[0];
            if (!row)
                throw badRequest("Travel type not found");
            locationMode = row.location_mode;
        }
        if (!travelTypeId)
            throw badRequest("Travel type is required");
        const district = parsed.data.district || "";
        const country = parsed.data.country || "";
        const province = parsed.data.province || "";
        const city = parsed.data.city || "";
        if (locationMode === "DISTRICT" && !district) {
            throw badRequest("District is required for this travel type");
        }
        if (locationMode === "COUNTRY_CITY") {
            if (!country)
                throw badRequest("Country is required for this travel type");
            if (!city)
                throw badRequest("City is required for this travel type");
            if (country.trim().toLowerCase() === "south africa" && !province) {
                throw badRequest("Province is required when country is South Africa");
            }
        }
        const row = (await query(`INSERT INTO travel_locations
          (travel_type_id, district, country, province, city, active, created_by_id)
         VALUES ($1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING id`, [travelTypeId, district, country, province, city, parsed.data.active ?? true, req.user.userId]))[0];
        return res.status(201).json({ id: row?.id ?? null, ok: true });
    }
    catch (err) {
        return next(err);
    }
});
travelRouter.put("/locations/:id", requireRole(["HR_MANAGER", "MANAGER", "ADMIN"]), async (req, res, next) => {
    try {
        const parsed = TravelLocationSchema.partial().safeParse(req.body);
        if (!parsed.success)
            throw badRequest("Invalid travel location payload", parsed.error.flatten());
        const updates = [];
        const params = [];
        for (const [key, value] of Object.entries(parsed.data)) {
            if (value === undefined || key === "travel_type_code")
                continue;
            params.push(value === "" ? null : value);
            updates.push(`${key}=$${params.length}`);
        }
        if (updates.length === 0)
            return res.json({ ok: true });
        params.push(req.params.id);
        const rows = await query(`UPDATE travel_locations SET ${updates.join(",")}, updated_at=now() WHERE id=$${params.length} RETURNING id`, params);
        if (!rows[0])
            throw notFound();
        return res.json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
