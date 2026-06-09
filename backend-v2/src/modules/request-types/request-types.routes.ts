import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";

export const requestTypesRouter = Router();
requestTypesRouter.use(requireAuth);

// ── Zod Schemas ───────────────────────────────────────────────────────────────

const FieldSchema = z.object({
  field_key: z.string().trim().min(1),
  field_label: z.string().trim().min(1),
  field_type: z.enum(["text", "number", "date", "select", "textarea", "checkbox", "file"]),
  is_required: z.boolean().optional().default(false),
  placeholder: z.string().nullish(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  sort_order: z.number().int().nonnegative().optional().default(0)
});

const CreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  code: z.string().trim().min(1, "Code is required").regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, digits or underscores"),
  description: z.string().trim().nullish(),
  icon: z.string().trim().nullish(),
  color: z.string().trim().nullish(),
  category: z.string().trim().nullish(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).default("DRAFT"),
  fields: z.array(FieldSchema).optional()
});

const UpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().nullish(),
  icon: z.string().trim().nullish(),
  color: z.string().trim().nullish(),
  category: z.string().trim().nullish(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional()
});

const PermissionSchema = z.object({
  permission_type: z.enum(["ALL", "DEPARTMENT", "USER"]),
  department: z.string().trim().nullish(),
  user_id: z.string().uuid().nullish(),
  can_submit: z.boolean().optional().default(true),
  can_design: z.boolean().optional().default(false)
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function assertCanManage(req: AuthedRequest, requestTypeId: string) {
  if (req.user!.role === "ADMIN") return;
  const perm = await query<{ id: string }>(
    `SELECT id FROM request_type_permissions
     WHERE request_type_id = $1 AND can_design = true
       AND (
         permission_type = 'ALL'
         OR (permission_type = 'USER' AND user_id = $2)
         OR (permission_type = 'DEPARTMENT' AND lower(trim(department)) = lower(trim($3)))
       )
     LIMIT 1`,
    [requestTypeId, req.user!.userId, req.user!.department ?? ""]
  );
  if (!perm[0]) throw forbidden("You do not have design access to this request type");
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /request-types
requestTypesRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const isAdmin = req.user!.role === "ADMIN";
    const userId = req.user!.userId;
    const dept = String(req.user!.department ?? "").trim();

    // Admin sees all; others see types they have submit or design permission for
    const rows = await query(
      `SELECT rt.*,
              COUNT(DISTINCT rtf.id)::int AS field_count,
              COUNT(DISTINCT rtp.id)::int AS permission_count
         FROM custom_request_types rt
         LEFT JOIN request_type_fields rtf ON rtf.request_type_id = rt.id AND rtf.is_active = true
         LEFT JOIN request_type_permissions rtp ON rtp.request_type_id = rt.id
         WHERE rt.is_active = true
           AND ($1::boolean = true
                OR EXISTS (
                  SELECT 1 FROM request_type_permissions p
                  WHERE p.request_type_id = rt.id
                    AND (
                      p.permission_type = 'ALL'
                      OR (p.permission_type = 'USER' AND p.user_id = $2)
                      OR (p.permission_type = 'DEPARTMENT' AND lower(trim(p.department)) = lower(trim($3)))
                    )
                ))
         GROUP BY rt.id
         ORDER BY rt.name`,
      [isAdmin, userId, dept]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /request-types/:id
requestTypesRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const rt = (await query(`SELECT * FROM custom_request_types WHERE id = $1 AND is_active = true`, [req.params.id]))[0];
    if (!rt) throw notFound();
    const fields = await query(
      `SELECT * FROM request_type_fields WHERE request_type_id = $1 AND is_active = true ORDER BY sort_order, created_at`,
      [req.params.id]
    );
    const permissions = await query(
      `SELECT rtp.*, u.full_name AS user_name, u.email AS user_email
         FROM request_type_permissions rtp
         LEFT JOIN users u ON u.id = rtp.user_id
        WHERE rtp.request_type_id = $1
        ORDER BY rtp.created_at`,
      [req.params.id]
    );
    return res.json({ ...rt, fields, permissions });
  } catch (err) {
    return next(err);
  }
});

// POST /request-types — admin only
requestTypesRouter.post("/", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request type payload", parsed.error.flatten());

    const exists = await query(`SELECT id FROM custom_request_types WHERE upper(trim(code)) = upper(trim($1))`, [parsed.data.code]);
    if (exists[0]) throw badRequest("A request type with that code already exists");

    const rt = (await query<{ id: string }>(
      `INSERT INTO custom_request_types (id, name, code, description, icon, color, category, status, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [randomUUID(), parsed.data.name, parsed.data.code.toUpperCase(), parsed.data.description ?? null,
       parsed.data.icon ?? null, parsed.data.color ?? null, parsed.data.category ?? null,
       parsed.data.status, req.user!.userId]
    ))[0];

    if (parsed.data.fields?.length) {
      await insertFields(rt.id, parsed.data.fields);
    }
    return res.status(201).json({ id: rt.id });
  } catch (err) {
    return next(err);
  }
});

// PUT /request-types/:id — admin or designer
requestTypesRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await assertCanManage(req, req.params.id);
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request type payload", parsed.error.flatten());

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (parsed.data.name !== undefined) { fields.push(`name=$${idx++}`); values.push(parsed.data.name); }
    if (parsed.data.description !== undefined) { fields.push(`description=$${idx++}`); values.push(parsed.data.description ?? null); }
    if (parsed.data.icon !== undefined) { fields.push(`icon=$${idx++}`); values.push(parsed.data.icon ?? null); }
    if (parsed.data.color !== undefined) { fields.push(`color=$${idx++}`); values.push(parsed.data.color ?? null); }
    if (parsed.data.category !== undefined) { fields.push(`category=$${idx++}`); values.push(parsed.data.category ?? null); }
    if (parsed.data.status !== undefined) { fields.push(`status=$${idx++}`); values.push(parsed.data.status); }
    if (!fields.length) return res.json({ ok: true });

    values.push(req.params.id);
    const rows = await query(
      `UPDATE custom_request_types SET ${fields.join(",")}, updated_at = now() WHERE id = $${idx} RETURNING id`,
      values
    );
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// DELETE /request-types/:id — admin only
requestTypesRouter.delete("/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `UPDATE custom_request_types SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// PUT /request-types/:id/fields — admin or designer replaces all fields
requestTypesRouter.put("/:id/fields", async (req: AuthedRequest, res, next) => {
  try {
    await assertCanManage(req, req.params.id);
    const parsed = z.array(FieldSchema).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid fields payload", parsed.error.flatten());

    await query(`UPDATE request_type_fields SET is_active = false WHERE request_type_id = $1`, [req.params.id]);
    await insertFields(req.params.id, parsed.data);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// GET /request-types/:id/permissions
requestTypesRouter.get("/:id/permissions", async (req: AuthedRequest, res, next) => {
  try {
    await assertCanManage(req, req.params.id);
    const rows = await query(
      `SELECT rtp.*, u.full_name AS user_name, u.email AS user_email
         FROM request_type_permissions rtp
         LEFT JOIN users u ON u.id = rtp.user_id
        WHERE rtp.request_type_id = $1
        ORDER BY rtp.created_at`,
      [req.params.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// POST /request-types/:id/permissions — admin only
requestTypesRouter.post("/:id/permissions", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = PermissionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid permission payload", parsed.error.flatten());
    const rows = await query(
      `INSERT INTO request_type_permissions (id, request_type_id, permission_type, department, user_id, can_submit, can_design, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [randomUUID(), req.params.id, parsed.data.permission_type,
       parsed.data.department ?? null, parsed.data.user_id ?? null,
       parsed.data.can_submit ?? true, parsed.data.can_design ?? false, req.user!.userId]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

// DELETE /request-types/:id/permissions/:permId — admin only
requestTypesRouter.delete("/:id/permissions/:permId", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `DELETE FROM request_type_permissions WHERE id = $1 AND request_type_id = $2 RETURNING id`,
      [req.params.permId, req.params.id]
    );
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertFields(requestTypeId: string, fields: z.infer<typeof FieldSchema>[]) {
  if (!fields.length) return;
  const placeholders: string[] = [];
  const params: unknown[] = [];
  fields.forEach((f, i) => {
    const base = params.length + 1;
    params.push(
      randomUUID(), requestTypeId,
      f.field_key, f.field_label, f.field_type,
      f.is_required ?? false, f.placeholder ?? null,
      f.options ? JSON.stringify(f.options) : null,
      f.sort_order ?? i
    );
    placeholders.push(`($${base},$${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`);
  });
  await query(
    `INSERT INTO request_type_fields (id, request_type_id, field_key, field_label, field_type, is_required, placeholder, options, sort_order)
     VALUES ${placeholders.join(",")}`,
    params
  );
}
