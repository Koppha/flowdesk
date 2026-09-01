import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";

export const brsAdminRouter = Router();
brsAdminRouter.use(requireAuth);

const SectionSchema = z.object({
  section_key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().nullish(),
  owner_phase: z.enum(["DRAFT", "DEPT_INPUT"]),
  default_department: z.string().trim().nullish(),
  is_required: z.boolean().optional().default(true),
  sla_hours: z.number().int().positive().nullish(),
  sort_order: z.number().int().nonnegative().optional().default(0)
});

const CreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  code: z.string().trim().min(1, "Code is required").regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, digits or underscores"),
  description: z.string().trim().nullish(),
  icon: z.string().trim().nullish(),
  color: z.string().trim().nullish(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).default("DRAFT"),
  sections: z.array(SectionSchema).optional()
});

const UpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().nullish(),
  icon: z.string().trim().nullish(),
  color: z.string().trim().nullish(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional()
});

const PermissionSchema = z.object({
  permission_type: z.enum(["ALL", "DEPARTMENT", "USER", "EMPLOYMENT_TYPE"]),
  department: z.string().trim().nullish(),
  user_id: z.string().uuid().nullish(),
  employment_type: z.string().trim().nullish(),
  can_submit: z.boolean().optional().default(true),
  can_design: z.boolean().optional().default(false)
});

async function assertCanManage(req: AuthedRequest, brsTypeId: string) {
  if (req.user!.role === "ADMIN") return;
  const perm = await query<{ id: string }>(
    `SELECT id FROM brs_type_permissions
      WHERE brs_type_id = $1 AND can_design = true
        AND (
          permission_type = 'ALL'
          OR (permission_type = 'USER' AND user_id = $2)
          OR (permission_type = 'DEPARTMENT' AND lower(trim(department)) = lower(trim($3)))
          OR (permission_type = 'EMPLOYMENT_TYPE' AND upper(trim(employment_type)) = upper(trim($4)))
        )
      LIMIT 1`,
    [brsTypeId, req.user!.userId, req.user!.department ?? "", req.user!.employmentType ?? ""]
  );
  if (!perm[0]) throw forbidden("You do not have design access to this BRS type");
}

async function insertSections(brsTypeId: string, sections: z.infer<typeof SectionSchema>[]) {
  if (!sections.length) return;
  const placeholders: string[] = [];
  const params: unknown[] = [];
  sections.forEach((s, i) => {
    const base = params.length + 1;
    params.push(
      randomUUID(), brsTypeId,
      s.section_key, s.title, s.description ?? null, s.owner_phase,
      s.default_department ?? null, s.is_required ?? true, s.sla_hours ?? null, s.sort_order ?? i
    );
    placeholders.push(`($${base},$${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`);
  });
  await query(
    `INSERT INTO brs_type_sections (id, brs_type_id, section_key, title, description, owner_phase, default_department, is_required, sla_hours, sort_order)
     VALUES ${placeholders.join(",")}`,
    params
  );
}

// GET /brs-types — admin sees all, others see types they have submit/design access to
brsAdminRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const isAdmin = req.user!.role === "ADMIN";
    const rows = await query(
      `SELECT bt.*,
              COUNT(DISTINCT bts.id)::int AS section_count
         FROM brs_types bt
         LEFT JOIN brs_type_sections bts ON bts.brs_type_id = bt.id AND bts.is_active = true
        WHERE bt.is_active = true
          AND ($1::boolean = true
               OR EXISTS (
                 SELECT 1 FROM brs_type_permissions p
                 WHERE p.brs_type_id = bt.id
                   AND (
                     p.permission_type = 'ALL'
                     OR (p.permission_type = 'USER' AND p.user_id = $2)
                     OR (p.permission_type = 'DEPARTMENT' AND lower(trim(p.department)) = lower(trim($3)))
                     OR (p.permission_type = 'EMPLOYMENT_TYPE' AND upper(trim(p.employment_type)) = upper(trim($4)))
                   )
               ))
        GROUP BY bt.id
        ORDER BY bt.name`,
      [isAdmin, req.user!.userId, req.user!.department ?? "", req.user!.employmentType ?? ""]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /brs-types/module-flag — any authed user, used to gate BRS nav visibility.
brsAdminRouter.get("/module-flag", async (_req: AuthedRequest, res, next) => {
  try {
    const active = (await query<{ id: string }>(`SELECT id FROM brs_types WHERE status = 'ACTIVE' AND is_active = true LIMIT 1`))[0];
    return res.json({ brs_enabled: !!active });
  } catch (err) {
    return next(err);
  }
});

// GET /brs-types/default — there is exactly one BRS structure in this system
// (no admin-facing "types" concept) - this finds it, auto-creating it (with
// a default "everyone can submit" permission, same as POST / below) the
// first time anyone asks, so neither BrsStudio.tsx's "New BRS" form nor
// BrsAdmin.tsx's structure editor ever needs a list/create step.
brsAdminRouter.get("/default", async (req: AuthedRequest, res, next) => {
  try {
    let bt = (await query<any>(`SELECT * FROM brs_types WHERE is_active = true ORDER BY created_at LIMIT 1`))[0];
    if (!bt) {
      const inserted = (await query<{ id: string }>(
        `INSERT INTO brs_types (id, name, code, status, created_by_id)
         VALUES ($1, 'Business Requirement Specification', 'DEFAULT', 'ACTIVE', $2)
         RETURNING id`,
        [randomUUID(), req.user!.userId]
      ))[0];
      await query(
        `INSERT INTO brs_type_permissions (brs_type_id, permission_type, can_submit, can_design, created_by_id)
         VALUES ($1, 'ALL', true, false, $2)`,
        [inserted.id, req.user!.userId]
      );
      bt = (await query<any>(`SELECT * FROM brs_types WHERE id = $1`, [inserted.id]))[0];
    }
    const sections = await query(
      `SELECT * FROM brs_type_sections WHERE brs_type_id = $1 AND is_active = true ORDER BY sort_order, created_at`,
      [bt.id]
    );
    const permissions = await query(
      `SELECT p.*, u.full_name AS user_name, u.email AS user_email
         FROM brs_type_permissions p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.brs_type_id = $1
        ORDER BY p.created_at`,
      [bt.id]
    );
    return res.json({ ...bt, sections, permissions });
  } catch (err) {
    return next(err);
  }
});

// GET /brs-types/:id
brsAdminRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const bt = (await query(`SELECT * FROM brs_types WHERE id = $1 AND is_active = true`, [req.params.id]))[0];
    if (!bt) throw notFound();
    const sections = await query(
      `SELECT * FROM brs_type_sections WHERE brs_type_id = $1 AND is_active = true ORDER BY sort_order, created_at`,
      [req.params.id]
    );
    const permissions = await query(
      `SELECT p.*, u.full_name AS user_name, u.email AS user_email
         FROM brs_type_permissions p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.brs_type_id = $1
        ORDER BY p.created_at`,
      [req.params.id]
    );
    return res.json({ ...bt, sections, permissions });
  } catch (err) {
    return next(err);
  }
});

// POST /brs-types — admin only
brsAdminRouter.post("/", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid BRS type payload", parsed.error.flatten());

    const exists = await query(`SELECT id FROM brs_types WHERE upper(trim(code)) = upper(trim($1))`, [parsed.data.code]);
    if (exists[0]) throw badRequest("A BRS type with that code already exists");

    const bt = (await query<{ id: string }>(
      `INSERT INTO brs_types (id, name, code, description, icon, color, status, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [randomUUID(), parsed.data.name, parsed.data.code.toUpperCase(), parsed.data.description ?? null,
       parsed.data.icon ?? null, parsed.data.color ?? null, parsed.data.status, req.user!.userId]
    ))[0];

    if (parsed.data.sections?.length) {
      await insertSections(bt.id, parsed.data.sections);
    }

    // Every custom_request_types seed grants a default "everyone can submit"
    // permission row so a freshly-created type isn't invisible to anyone but
    // ADMIN (GET /brs-types filters by permission the same way GET
    // /request-types does) - do the same here so a new BRS type actually
    // works out of the box, with the admin free to narrow it afterward via
    // the "Who can open this type" panel.
    await query(
      `INSERT INTO brs_type_permissions (brs_type_id, permission_type, can_submit, can_design, created_by_id)
       VALUES ($1, 'ALL', true, false, $2)`,
      [bt.id, req.user!.userId]
    );

    return res.status(201).json({ id: bt.id });
  } catch (err) {
    return next(err);
  }
});

// PUT /brs-types/:id
brsAdminRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await assertCanManage(req, req.params.id);
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid BRS type payload", parsed.error.flatten());

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (parsed.data.name !== undefined) { fields.push(`name=$${idx++}`); values.push(parsed.data.name); }
    if (parsed.data.description !== undefined) { fields.push(`description=$${idx++}`); values.push(parsed.data.description ?? null); }
    if (parsed.data.icon !== undefined) { fields.push(`icon=$${idx++}`); values.push(parsed.data.icon ?? null); }
    if (parsed.data.color !== undefined) { fields.push(`color=$${idx++}`); values.push(parsed.data.color ?? null); }
    if (parsed.data.status !== undefined) { fields.push(`status=$${idx++}`); values.push(parsed.data.status); }
    if (!fields.length) return res.json({ ok: true });

    values.push(req.params.id);
    const rows = await query(
      `UPDATE brs_types SET ${fields.join(",")}, updated_at = now() WHERE id = $${idx} RETURNING id`,
      values
    );
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// DELETE /brs-types/:id — admin only
brsAdminRouter.delete("/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(`UPDATE brs_types SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// PUT /brs-types/:id/sections — admin or designer replaces the whole section list.
// Only touches the template, never brs_document_sections — in-flight documents
// keep their own snapshot regardless of what happens here (see brs.schema.ts).
brsAdminRouter.put("/:id/sections", async (req: AuthedRequest, res, next) => {
  try {
    await assertCanManage(req, req.params.id);
    const parsed = z.array(SectionSchema).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid sections payload", parsed.error.flatten());

    await query(`UPDATE brs_type_sections SET is_active = false WHERE brs_type_id = $1`, [req.params.id]);
    await insertSections(req.params.id, parsed.data);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// GET /brs-types/:id/permissions
brsAdminRouter.get("/:id/permissions", async (req: AuthedRequest, res, next) => {
  try {
    await assertCanManage(req, req.params.id);
    const rows = await query(
      `SELECT p.*, u.full_name AS user_name, u.email AS user_email
         FROM brs_type_permissions p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.brs_type_id = $1
        ORDER BY p.created_at`,
      [req.params.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// POST /brs-types/:id/permissions — admin only
brsAdminRouter.post("/:id/permissions", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = PermissionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid permission payload", parsed.error.flatten());
    const rows = await query(
      `INSERT INTO brs_type_permissions (id, brs_type_id, permission_type, department, user_id, employment_type, can_submit, can_design, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [randomUUID(), req.params.id, parsed.data.permission_type,
       parsed.data.department ?? null, parsed.data.user_id ?? null, parsed.data.employment_type ?? null,
       parsed.data.can_submit ?? true, parsed.data.can_design ?? false, req.user!.userId]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

// DELETE /brs-types/:id/permissions/:permId — admin only
brsAdminRouter.delete("/:id/permissions/:permId", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `DELETE FROM brs_type_permissions WHERE id = $1 AND brs_type_id = $2 RETURNING id`,
      [req.params.permId, req.params.id]
    );
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
