import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getDepartmentLeadership } from "../../lib/departments.js";
const WorkflowStepSchema = z.object({
    step_order: z.coerce.number().int().min(1),
    position_type_id: z.string().uuid().optional(),
    assigned_user_id: z.string().uuid().optional().nullable(),
    approval_mode: z.enum(["SINGLE", "ANY_ONE"]).optional().default("SINGLE"),
    approval_group_name: z.string().trim().optional().nullable(),
    position_name: z.string().trim().min(1),
    description: z.string().trim().optional(),
    is_required: z.boolean().optional(),
    skip_if_unassigned: z.boolean().optional(),
    allow_delegation: z.boolean().optional(),
    comments_required: z.boolean().optional(),
    escalation_days: z.coerce.number().int().nonnegative().optional(),
    is_final_approval: z.boolean().optional(),
    is_system_step: z.boolean().optional(),
    is_active: z.boolean().optional()
});
const WorkflowRuleSchema = z.object({
    rule_name: z.string().trim().min(1),
    condition_field: z.string().trim().min(1),
    condition_operator: z.string().trim().min(1),
    condition_value: z.string().trim().min(1),
    additional_position_type_id: z.string().uuid().optional(),
    is_active: z.boolean().optional()
});
const CreateWorkflowSchema = z.object({
    name: z.string().trim().min(1, "Workflow name is required"),
    request_type: z.string().trim().min(1, "Request type is required"),
    advance_sub_type: z.string().trim().nullish(),
    department: z.string().trim().nullish(),
    section: z.string().trim().nullish(),
    team: z.string().trim().nullish(),
    description: z.string().trim().nullish(),
    status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).default("DRAFT"),
    steps: z.array(WorkflowStepSchema).min(1, "At least one workflow step is required"),
    rules: z.array(WorkflowRuleSchema).optional()
});
const UpdateWorkflowSchema = z.object({
    name: z.string().trim().min(1).optional(),
    request_type: z.string().trim().min(1).optional(),
    advance_sub_type: z.string().trim().nullish(),
    department: z.string().trim().nullish(),
    section: z.string().trim().nullish(),
    team: z.string().trim().nullish(),
    description: z.string().trim().nullish(),
    status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
    steps: z.array(WorkflowStepSchema).optional(),
    rules: z.array(WorkflowRuleSchema).optional()
});
export const workflowsRouter = Router();
workflowsRouter.use(requireAuth);
async function ensureAssignedUserColumn() {
    await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS assigned_user_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'SINGLE'`);
    await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS approval_group_name text`);
}
async function ensureWorkflowScopeColumns() {
    await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS section text`);
    await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS team text`);
    await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS advance_sub_type text`);
}
async function insertWorkflowSteps(workflowId, steps) {
    if (steps.length === 0)
        return;
    await ensureAssignedUserColumn();
    const values = [];
    const params = [];
    steps.forEach((step) => {
        const baseIndex = params.length + 1;
        params.push(workflowId, step.step_order, step.position_type_id || null, step.assigned_user_id || null, step.approval_mode ?? "SINGLE", step.approval_group_name || null, step.position_name, step.description || null, step.is_required ?? false, step.skip_if_unassigned ?? false, step.allow_delegation ?? false, step.comments_required ?? false, step.escalation_days ?? 0, step.is_final_approval ?? false, step.is_system_step ?? false, step.is_active ?? true);
        values.push(`($${baseIndex},$${baseIndex + 1},$${baseIndex + 2},$${baseIndex + 3},$${baseIndex + 4},$${baseIndex + 5},$${baseIndex + 6},$${baseIndex + 7},$${baseIndex + 8},$${baseIndex + 9},$${baseIndex + 10},$${baseIndex + 11},$${baseIndex + 12},$${baseIndex + 13},$${baseIndex + 14},$${baseIndex + 15})`);
    });
    await query(`INSERT INTO workflow_steps
      (workflow_id, step_order, position_type_id, assigned_user_id, approval_mode, approval_group_name, position_name, description, is_required, skip_if_unassigned, allow_delegation, comments_required, escalation_days, is_final_approval, is_system_step, is_active)
     VALUES ${values.join(",")}`, params);
}
async function insertWorkflowRules(workflowId, rules) {
    if (!rules || rules.length === 0)
        return;
    const values = [];
    const params = [];
    rules.forEach((rule) => {
        const baseIndex = params.length + 1;
        params.push(workflowId, rule.rule_name, rule.condition_field, rule.condition_operator, rule.condition_value, rule.additional_position_type_id || null, rule.is_active ?? true);
        values.push(`($${baseIndex},$${baseIndex + 1},$${baseIndex + 2},$${baseIndex + 3},$${baseIndex + 4},$${baseIndex + 5},$${baseIndex + 6})`);
    });
    await query(`INSERT INTO workflow_rules
      (workflow_id, rule_name, condition_field, condition_operator, condition_value, additional_position_type_id, is_active)
     VALUES ${values.join(",")}`, params);
}
workflowsRouter.get("/", async (req, res, next) => {
    try {
        const requestType = String(req.query.requestType || "").trim();
        const department = String(req.query.department || "").trim();
        const status = String(req.query.status || "").trim().toUpperCase();
        const search = String(req.query.search || "").trim();
        const filters = [];
        const params = [];
        if (requestType) {
            params.push(requestType);
            filters.push(`request_type=$${params.length}`);
        }
        if (department) {
            params.push(department);
            filters.push(`department=$${params.length}`);
        }
        if (status) {
            params.push(status);
            filters.push(`status=$${params.length}`);
        }
        if (search) {
            params.push(`%${search}%`);
            filters.push(`(name ILIKE $${params.length} OR COALESCE(description, '') ILIKE $${params.length})`);
        }
        const queryText = `
      SELECT w.*,
             COUNT(ws.id)::int AS step_count,
             COALESCE(string_agg(ws.position_name, ' → ' ORDER BY ws.step_order) FILTER (WHERE ws.id IS NOT NULL), '') AS approval_flow_preview,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', ws.id,
                   'step_order', ws.step_order,
                   'position_type_id', ws.position_type_id,
                   'position_name', ws.position_name,
                   'description', ws.description,
                   'is_required', ws.is_required,
                   'skip_if_unassigned', ws.skip_if_unassigned,
                   'allow_delegation', ws.allow_delegation,
                   'comments_required', ws.comments_required,
                   'escalation_days', ws.escalation_days,
                   'is_final_approval', ws.is_final_approval,
                   'is_system_step', ws.is_system_step,
                   'is_active', ws.is_active
                 )
                 ORDER BY ws.step_order
               ) FILTER (WHERE ws.id IS NOT NULL),
               '[]'::json
             ) AS steps
        FROM workflows w
        LEFT JOIN workflow_steps ws ON ws.workflow_id = w.id
        ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
       GROUP BY w.id
       ORDER BY w.updated_at DESC, w.created_at DESC`;
        const rows = await query(queryText, params);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
workflowsRouter.get("/active", async (req, res, next) => {
    try {
        const requestType = String(req.query.requestType || "").trim();
        if (!requestType) {
            throw badRequest("requestType query parameter is required");
        }
        const rows = await query(`SELECT * FROM workflows WHERE request_type=$1 AND status='ACTIVE' ORDER BY created_at DESC`, [requestType]);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
workflowsRouter.get("/exco-members", async (_req, res, next) => {
    try {
        await ensureAssignedUserColumn();
        const rows = await query(`SELECT id, full_name, email, title, department, employee_no
         FROM users
        WHERE role = 'EXCO' AND is_active = true
        ORDER BY full_name ASC`);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
workflowsRouter.get("/position-types", async (_req, res, next) => {
    try {
        const rows = await query(`SELECT * FROM position_types WHERE is_active = true ORDER BY name ASC`);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
workflowsRouter.get("/resolve", async (req, res, next) => {
    try {
        const requestType = String(req.query.requestType || "").trim();
        const department = String(req.query.department || "").trim();
        const section = String(req.query.section || "").trim();
        const advanceSubType = String(req.query.advance_sub_type || "").trim();
        const amount = Number(req.query.amount || 0);
        if (!requestType)
            throw badRequest("requestType query parameter is required");
        // Priority (highest → lowest):
        //   0 = section + dept + sub_type exact match
        //   1 = dept + sub_type match (no section constraint)
        //   2 = section + dept match (no sub_type constraint)
        //   3 = dept match only (global for dept)
        //   4 = fully global (no dept/section/sub_type constraint)
        const workflows = await query(`SELECT *
         FROM workflows
        WHERE request_type = $1
          AND status = 'ACTIVE'
          AND (department IS NULL OR trim(department) = '' OR lower(trim(department)) = lower(trim($2)))
          AND (section IS NULL OR trim(section) = '' OR lower(trim(section)) = lower(trim($3)))
          AND (
            advance_sub_type IS NULL OR trim(advance_sub_type) = ''
            OR ($4 <> '' AND lower(trim(advance_sub_type)) = lower(trim($4)))
          )
        ORDER BY
          CASE
            WHEN $4 <> '' AND lower(trim(COALESCE(advance_sub_type,''))) = lower(trim($4))
                 AND lower(trim(COALESCE(section,''))) = lower(trim($3))
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 0
            WHEN $4 <> '' AND lower(trim(COALESCE(advance_sub_type,''))) = lower(trim($4))
                 AND (section IS NULL OR trim(section) = '')
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 1
            WHEN (advance_sub_type IS NULL OR trim(advance_sub_type) = '')
                 AND lower(trim(COALESCE(section,''))) = lower(trim($3))
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 2
            WHEN (advance_sub_type IS NULL OR trim(advance_sub_type) = '')
                 AND (section IS NULL OR trim(section) = '')
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 3
            ELSE 4
          END,
          updated_at DESC, created_at DESC
        LIMIT 1`, [requestType, department, section, advanceSubType]);
        const workflow = workflows[0];
        if (!workflow)
            return res.json({ workflow: null, chain: [], tasks: [], warnings: ["No active workflow found."] });
        const [steps, rules, leadership] = await Promise.all([
            query(`SELECT ws.*, pt.code AS position_type_code,
                u.full_name AS assigned_user_name, u.email AS assigned_user_email
           FROM workflow_steps ws
           LEFT JOIN position_types pt ON pt.id = ws.position_type_id
           LEFT JOIN users u ON u.id = ws.assigned_user_id
          WHERE ws.workflow_id=$1 AND ws.is_active = true
          ORDER BY ws.step_order ASC`, [workflow.id]),
            query(`SELECT wr.*, pt.name AS additional_position_name, pt.code AS additional_position_code
           FROM workflow_rules wr
           LEFT JOIN position_types pt ON pt.id = wr.additional_position_type_id
          WHERE wr.workflow_id=$1 AND wr.is_active = true
          ORDER BY wr.created_at ASC`, [workflow.id]),
            getDepartmentLeadership(department)
        ]);
        const warnings = [];
        const chain = steps.flatMap((step) => {
            const code = step.position_type_code || step.position_name;
            const approverId = code === "HOD"
                ? leadership.hod_user_id
                : code === "MANAGER"
                    ? leadership.manager_user_id
                    : code === "EXCO_OWNER"
                        ? leadership.exco_user_id
                        : step.assigned_user_id || null;
            const approverName = code === "HOD"
                ? leadership.hod_name
                : code === "MANAGER"
                    ? leadership.manager_name
                    : code === "EXCO_OWNER"
                        ? leadership.exco_name
                        : step.assigned_user_name || null;
            if (!approverId && step.is_required && !step.skip_if_unassigned && ["HOD", "MANAGER", "EXCO_OWNER"].includes(code)) {
                warnings.push(`${step.position_name} is required but missing for ${department || "the selected department"}.`);
            }
            if (!approverId && step.skip_if_unassigned)
                return [];
            const positionLabel = code === "EXCO_OWNER" && leadership.exco_title
                ? leadership.exco_title
                : step.position_name;
            return [{
                    step_order: step.step_order,
                    position_name: positionLabel,
                    position_type_code: code,
                    approval_mode: step.approval_mode || "SINGLE",
                    approval_group_name: step.approval_group_name || null,
                    approver_id: approverId,
                    approver_name: approverName || null,
                    required: step.is_required,
                    final_approval: step.is_final_approval
                }];
        });
        const conditionalTasks = rules.flatMap((rule) => {
            const value = Number(rule.condition_value || 0);
            const matched = rule.condition_operator === ">" ? amount > value :
                rule.condition_operator === "<" ? amount < value :
                    amount === value;
            return matched ? [{
                    rule_name: rule.rule_name,
                    position_name: rule.additional_position_name || "Additional Approval",
                    position_type_code: rule.additional_position_code || "",
                    condition: `${rule.condition_field} ${rule.condition_operator} ${rule.condition_value}`
                }] : [];
        });
        return res.json({ workflow, chain, tasks: [...chain, ...conditionalTasks], warnings });
    }
    catch (err) {
        return next(err);
    }
});
workflowsRouter.get("/:id", async (req, res, next) => {
    try {
        const workflowId = String(req.params.id || "").trim();
        if (!workflowId)
            throw notFound();
        const workflowRows = await query(`SELECT * FROM workflows WHERE id=$1`, [workflowId]);
        const workflow = workflowRows[0];
        if (!workflow)
            throw notFound();
        const steps = await query(`SELECT ws.*, pt.code AS position_type_code,
              u.full_name AS assigned_user_name, u.email AS assigned_user_email
         FROM workflow_steps ws
         LEFT JOIN position_types pt ON pt.id = ws.position_type_id
         LEFT JOIN users u ON u.id = ws.assigned_user_id
        WHERE ws.workflow_id=$1 ORDER BY ws.step_order ASC`, [workflowId]);
        const rules = await query(`SELECT * FROM workflow_rules WHERE workflow_id=$1 ORDER BY created_at ASC`, [workflowId]);
        return res.json({ ...workflow, steps, rules });
    }
    catch (err) {
        return next(err);
    }
});
workflowsRouter.post("/", requireRole(["ADMIN"]), async (req, res, next) => {
    try {
        const parsed = CreateWorkflowSchema.safeParse(req.body);
        if (!parsed.success) {
            throw badRequest("Invalid workflow payload", parsed.error.flatten());
        }
        await ensureWorkflowScopeColumns();
        const workflowRow = (await query(`INSERT INTO workflows (name, request_type, advance_sub_type, department, section, team, description, status, created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`, [parsed.data.name, parsed.data.request_type, parsed.data.advance_sub_type || null, parsed.data.department || null, parsed.data.section || null, parsed.data.team || null, parsed.data.description || null, parsed.data.status, req.user.userId]))[0];
        await insertWorkflowSteps(workflowRow.id, parsed.data.steps);
        await insertWorkflowRules(workflowRow.id, parsed.data.rules || []);
        return res.status(201).json({ id: workflowRow.id });
    }
    catch (err) {
        return next(err);
    }
});
workflowsRouter.put("/:id", requireRole(["ADMIN"]), async (req, res, next) => {
    try {
        const parsed = UpdateWorkflowSchema.safeParse(req.body);
        if (!parsed.success) {
            throw badRequest("Invalid workflow payload", parsed.error.flatten());
        }
        await ensureWorkflowScopeColumns();
        const updates = [];
        const params = [];
        if (parsed.data.name !== undefined) {
            updates.push(`name=$${params.length + 1}`);
            params.push(parsed.data.name);
        }
        if (parsed.data.request_type !== undefined) {
            updates.push(`request_type=$${params.length + 1}`);
            params.push(parsed.data.request_type);
        }
        if (parsed.data.advance_sub_type !== undefined) {
            updates.push(`advance_sub_type=$${params.length + 1}`);
            params.push(parsed.data.advance_sub_type || null);
        }
        if (parsed.data.department !== undefined) {
            updates.push(`department=$${params.length + 1}`);
            params.push(parsed.data.department || null);
        }
        if (parsed.data.section !== undefined) {
            updates.push(`section=$${params.length + 1}`);
            params.push(parsed.data.section || null);
        }
        if (parsed.data.team !== undefined) {
            updates.push(`team=$${params.length + 1}`);
            params.push(parsed.data.team || null);
        }
        if (parsed.data.description !== undefined) {
            updates.push(`description=$${params.length + 1}`);
            params.push(parsed.data.description || null);
        }
        if (parsed.data.status !== undefined) {
            updates.push(`status=$${params.length + 1}`);
            params.push(parsed.data.status);
        }
        if (updates.length > 0) {
            params.push(req.params.id);
            const rows = await query(`UPDATE workflows SET ${updates.join(",")}, updated_at=now() WHERE id=$${params.length} RETURNING id`, params);
            if (!rows[0])
                throw notFound();
        }
        if (parsed.data.steps) {
            await query(`DELETE FROM workflow_steps WHERE workflow_id=$1`, [req.params.id]);
            await insertWorkflowSteps(req.params.id, parsed.data.steps);
        }
        if (parsed.data.rules) {
            await query(`DELETE FROM workflow_rules WHERE workflow_id=$1`, [req.params.id]);
            await insertWorkflowRules(req.params.id, parsed.data.rules);
        }
        return res.json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
// Returns users eligible as custom-chain approvers:
// - users from the requester's own department
// - users from any department/section marked is_business_partner = true
// Excludes pure-employee roles so only potential approvers are shown.
workflowsRouter.get("/chain-approvers", async (req, res, next) => {
    try {
        const department = String(req.user.department || "").trim();
        const rows = await query(`SELECT DISTINCT u.id, u.full_name, u.email, u.employee_no, u.department, u.title, u.role
         FROM users u
        WHERE u.is_active = true
          AND u.role NOT IN ('EMPLOYEE','INTERN','TEMP')
          AND (
            ($1 <> '' AND lower(trim(u.department)) = lower(trim($1)))
            OR EXISTS (
              SELECT 1 FROM departments d
               WHERE d.is_business_partner = true
                 AND lower(trim(d.name)) = lower(trim(u.department))
            )
            OR EXISTS (
              SELECT 1 FROM sections s
               WHERE s.is_business_partner = true
                 AND s.department_id IN (
                   SELECT id FROM departments WHERE lower(trim(name)) = lower(trim(u.department))
                 )
            )
          )
        ORDER BY u.full_name NULLS LAST, u.email`, [department]);
        return res.json(rows);
    }
    catch (err) {
        return next(err);
    }
});
workflowsRouter.delete("/:id", requireRole(["ADMIN"]), async (req, res, next) => {
    try {
        const rows = await query(`DELETE FROM workflows WHERE id=$1 RETURNING id`, [req.params.id]);
        if (!rows[0])
            throw notFound();
        return res.json({ ok: true });
    }
    catch (err) {
        return next(err);
    }
});
