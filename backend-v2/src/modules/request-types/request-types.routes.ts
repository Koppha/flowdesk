import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getBooleanSystemSetting, setBooleanSystemSetting, getNumericSystemSetting, setNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { logger } from "../../lib/logger.js";
import { loadAiConfig, setAiAssistantEnabled } from "../ai/ai-settings.js";

export const requestTypesRouter = Router();
requestTypesRouter.use(requireAuth);

// ── Zod Schemas ───────────────────────────────────────────────────────────────

const FieldSchema = z.object({
  field_key: z.string().trim().min(1),
  field_label: z.string().trim().min(1),
  // "user" stores the id of a system user picked from the company directory (e.g. Change Assignee).
  // "user_multi" stores an array of { id, name, email, confirmed, confirmed_at } — multiple assignees,
  // each of whom must individually confirm before any approval step can proceed (see custom-requests.routes.ts).
  // "section" is a dropdown sourced live from the org structure's Sections list (not static options).
  field_type: z.enum(["text", "number", "date", "select", "textarea", "checkbox", "file", "table", "user", "user_multi", "section"]),
  is_required: z.boolean().optional().default(false),
  placeholder: z.string().nullish(),
  // "select" stores {label,value}[]; "table" stores a structured grid config object.
  options: z.union([z.array(z.object({ label: z.string(), value: z.string() })), z.record(z.string(), z.any())]).optional(),
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
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
  approver_title_options: z.array(z.string().trim().min(1)).nullish()
});

const PermissionSchema = z.object({
  permission_type: z.enum(["ALL", "DEPARTMENT", "USER", "EMPLOYMENT_TYPE"]),
  department: z.string().trim().nullish(),
  user_id: z.string().uuid().nullish(),
  employment_type: z.string().trim().nullish(),
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
         OR (permission_type = 'EMPLOYMENT_TYPE' AND upper(trim(employment_type)) = upper(trim($4)))
       )
     LIMIT 1`,
    [requestTypeId, req.user!.userId, req.user!.department ?? "", req.user!.employmentType ?? ""]
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
    const employmentType = String(req.user!.employmentType ?? "").trim();

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
                      OR (p.permission_type = 'EMPLOYMENT_TYPE' AND upper(trim(p.employment_type)) = upper(trim($4)))
                    )
                ))
         GROUP BY rt.id
         ORDER BY rt.name`,
      [isAdmin, userId, dept, employmentType]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /request-types/module-flags — any authed user (used to gate nav). Fixed
// path, must precede /:id so it isn't swallowed by the :id param.
requestTypesRouter.get("/module-flags", async (_req: AuthedRequest, res, next) => {
  try {
    const [overtime_enabled, standby_enabled, salary_advance_enabled, loan_advance_enabled, salary_advance_max_payback_months, loan_advance_max_payback_months, vendor_contracts_enabled, service_contracts_enabled, signature_enabled] = await Promise.all([
      getBooleanSystemSetting(SYSTEM_SETTING_KEYS.overtimeModuleEnabled, true),
      getBooleanSystemSetting(SYSTEM_SETTING_KEYS.standbyModuleEnabled, true),
      getBooleanSystemSetting(SYSTEM_SETTING_KEYS.salaryAdvanceEnabled, true),
      getBooleanSystemSetting(SYSTEM_SETTING_KEYS.loanAdvanceEnabled, true),
      getNumericSystemSetting(SYSTEM_SETTING_KEYS.salaryAdvanceMaxPaybackMonths, 6),
      getNumericSystemSetting(SYSTEM_SETTING_KEYS.loanAdvanceMaxPaybackMonths, 6),
      getBooleanSystemSetting(SYSTEM_SETTING_KEYS.vendorContractsModuleEnabled, true),
      getBooleanSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsModuleEnabled, true),
      getBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureModuleEnabled, true)
    ]);
    // The AI Assistant's own on/off (Settings > AI Assistant), shown and
    // switched here too - one setting, two screens.
    const ai_assistant_enabled = (await loadAiConfig()).settings.enabled;
    return res.json({
      overtime_enabled, standby_enabled,
      salary_advance_enabled, loan_advance_enabled,
      salary_advance_max_payback_months, loan_advance_max_payback_months,
      vendor_contracts_enabled, service_contracts_enabled,
      signature_enabled, ai_assistant_enabled
    });
  } catch (err) {
    return next(err);
  }
});

// PUT /request-types/module-flags — admin only. Fixed path, must precede /:id.
requestTypesRouter.put("/module-flags", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({
      overtime_enabled: z.boolean().optional(),
      standby_enabled: z.boolean().optional(),
      salary_advance_enabled: z.boolean().optional(),
      loan_advance_enabled: z.boolean().optional(),
      salary_advance_max_payback_months: z.number().int().positive().max(360).optional(),
      loan_advance_max_payback_months: z.number().int().positive().max(360).optional(),
      vendor_contracts_enabled: z.boolean().optional(),
      service_contracts_enabled: z.boolean().optional(),
      signature_enabled: z.boolean().optional(),
      ai_assistant_enabled: z.boolean().optional()
    }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    if (parsed.data.overtime_enabled !== undefined) {
      await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.overtimeModuleEnabled, parsed.data.overtime_enabled);
    }
    if (parsed.data.standby_enabled !== undefined) {
      await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.standbyModuleEnabled, parsed.data.standby_enabled);
    }
    if (parsed.data.salary_advance_enabled !== undefined) {
      await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.salaryAdvanceEnabled, parsed.data.salary_advance_enabled);
    }
    if (parsed.data.loan_advance_enabled !== undefined) {
      await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.loanAdvanceEnabled, parsed.data.loan_advance_enabled);
    }
    if (parsed.data.salary_advance_max_payback_months !== undefined) {
      await setNumericSystemSetting(SYSTEM_SETTING_KEYS.salaryAdvanceMaxPaybackMonths, parsed.data.salary_advance_max_payback_months);
    }
    if (parsed.data.loan_advance_max_payback_months !== undefined) {
      await setNumericSystemSetting(SYSTEM_SETTING_KEYS.loanAdvanceMaxPaybackMonths, parsed.data.loan_advance_max_payback_months);
    }
    if (parsed.data.vendor_contracts_enabled !== undefined) {
      await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.vendorContractsModuleEnabled, parsed.data.vendor_contracts_enabled);
    }
    if (parsed.data.service_contracts_enabled !== undefined) {
      await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsModuleEnabled, parsed.data.service_contracts_enabled);
    }
    if (parsed.data.signature_enabled !== undefined) {
      await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureModuleEnabled, parsed.data.signature_enabled);
    }
    if (parsed.data.ai_assistant_enabled !== undefined) {
      try {
        await setAiAssistantEnabled(parsed.data.ai_assistant_enabled);
      } catch (e: any) {
        throw badRequest(e?.message || "Could not switch the AI Assistant");
      }
      logger.info("ai_settings_updated", { by: req.user!.userId, enabled: parsed.data.ai_assistant_enabled, from: "process_page" });
    }
    return res.json({ ok: true });
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
    if (parsed.data.approver_title_options !== undefined) {
      fields.push(`approver_title_options=$${idx++}`);
      values.push(parsed.data.approver_title_options ? JSON.stringify(parsed.data.approver_title_options) : null);
    }
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
      `INSERT INTO request_type_permissions (id, request_type_id, permission_type, department, user_id, employment_type, can_submit, can_design, created_by_id)
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
