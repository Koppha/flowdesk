import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getDepartmentLeadership } from "../../lib/departments.js";
import { normalizeWorkflowRouteCode, workflowRouteLabel } from "../../lib/workflowRouting.js";
import { resolveRequesterManager } from "../../lib/workflowEngine.js";

const WorkflowStepSchema = z.object({
  step_order: z.coerce.number().int().min(1),
  position_type_code: z.string().trim().optional(),
  assigned_user_id: z.string().uuid().optional().nullable(),
  // Multiple people can be assigned to a single step — whoever acts first
  // satisfies it (same "any one approves" semantics as an ANY_ONE group
  // step, just with a hand-picked list instead of a named permission group).
  // When present, this is the source of truth; assigned_user_id above is
  // kept in sync as its first element for older readers.
  assigned_user_ids: z.array(z.string().uuid()).optional().default([]),
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
  is_active: z.boolean().optional(),
  requires_accommodation: z.boolean().optional(),
  parallel_with_previous: z.boolean().optional(),
  action_type: z.string().trim().optional(),
  can_reject: z.boolean().optional(),
  can_rollback: z.boolean().optional()
});

const WorkflowRuleSchema = z.object({
  rule_name: z.string().trim().min(1),
  condition_field: z.string().trim().min(1),
  condition_operator: z.string().trim().min(1),
  condition_value: z.string().trim().min(1),
  additional_position_type_code: z.string().trim().optional(),
  additional_position_name: z.string().trim().optional(),
  additional_assigned_user_id: z.string().uuid().optional().nullable(),
  is_active: z.boolean().optional()
});

const CreateWorkflowSchema = z.object({
  name: z.string().trim().min(1, "Workflow name is required"),
  request_type: z.string().trim().min(1, "Request type is required"),
  advance_sub_type: z.string().trim().nullish(),
  division: z.string().trim().nullish(),
  department: z.string().trim().nullish(),
  section: z.string().trim().nullish(),
  team: z.string().trim().nullish(),
  description: z.string().trim().nullish(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).default("DRAFT"),
  workflow_type: z.enum(["STICKY", "TEMPORARY"]).default("STICKY"),
  valid_from: z.string().datetime({ offset: true }).nullish(),
  valid_until: z.string().datetime({ offset: true }).nullish(),
  requester_roles: z.array(z.enum(["EXCO", "MANAGER", "CEO"])).nullish(),
  steps: z.array(WorkflowStepSchema).min(1, "At least one workflow step is required"),
  rules: z.array(WorkflowRuleSchema).optional()
});

const UpdateWorkflowSchema = z.object({
  name: z.string().trim().min(1).optional(),
  request_type: z.string().trim().min(1).optional(),
  advance_sub_type: z.string().trim().nullish(),
  division: z.string().trim().nullish(),
  department: z.string().trim().nullish(),
  section: z.string().trim().nullish(),
  team: z.string().trim().nullish(),
  description: z.string().trim().nullish(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
  workflow_type: z.enum(["STICKY", "TEMPORARY"]).optional(),
  valid_from: z.string().datetime({ offset: true }).nullish(),
  valid_until: z.string().datetime({ offset: true }).nullish(),
  requester_roles: z.array(z.enum(["EXCO", "MANAGER", "CEO"])).nullish(),
  steps: z.array(WorkflowStepSchema).optional(),
  rules: z.array(WorkflowRuleSchema).optional()
});

export const workflowsRouter = Router();
workflowsRouter.use(requireAuth);

async function ensureActionTypesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS workflow_action_types (
      id        serial      PRIMARY KEY,
      code      text        NOT NULL UNIQUE,
      label     text        NOT NULL,
      is_system boolean     NOT NULL DEFAULT false,
      is_active boolean     NOT NULL DEFAULT true,
      sort_order int        NOT NULL DEFAULT 0
    )
  `);
  // Seed built-in types (idempotent)
  await query(`
    INSERT INTO workflow_action_types (code, label, is_system, sort_order) VALUES
      ('APPROVE',       'Approver',         true, 1),
      ('COUNTER_SIGN',  'Counter Signer',   true, 2),
      ('MARK_PAID',     'Payment Officer',  true, 3)
    ON CONFLICT (code) DO NOTHING
  `);
}

async function ensureAssignedUserColumn() {
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS position_type_code text`);
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS assigned_user_id uuid REFERENCES users(id)`);
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS assigned_user_ids uuid[] NOT NULL DEFAULT '{}'`);
  await query(`UPDATE workflow_steps SET assigned_user_ids = ARRAY[assigned_user_id] WHERE assigned_user_id IS NOT NULL AND (assigned_user_ids IS NULL OR array_length(assigned_user_ids, 1) IS NULL)`);
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'SINGLE'`);
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS approval_group_name text`);
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS requires_accommodation boolean NOT NULL DEFAULT false`);
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS parallel_with_previous boolean NOT NULL DEFAULT false`);
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS can_reject boolean NOT NULL DEFAULT true`);
  await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS can_rollback boolean NOT NULL DEFAULT true`);
  const actionTypeColumn = await query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_steps' AND column_name='action_type') AS exists`
  );
  if (!actionTypeColumn[0]?.exists) {
    await query(`ALTER TABLE workflow_steps ADD COLUMN action_type text NOT NULL DEFAULT 'APPROVE'`);
    // Preserve prior behavior: the Manager step's approval previously transitioned
    // status to COUNTERSIGNED and was always labeled "Counter Sign" in the UI.
    await query(`UPDATE workflow_steps SET action_type = 'COUNTER_SIGN' WHERE position_type_code = 'MANAGER'`);
  }
  await query(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS additional_position_type_code text`);
  await query(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS additional_position_name text`);
  await query(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS additional_assigned_user_id uuid REFERENCES users(id)`);
  await query(`UPDATE workflow_steps SET position_type_code = COALESCE(NULLIF(trim(position_type_code), ''), NULLIF(trim(position_name), ''), 'CUSTOM')`);
}

async function ensureWorkflowScopeColumns() {
  await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS division text`);
  await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS section text`);
  await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS team text`);
  await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS advance_sub_type text`);
  // Optional restriction so a workflow only resolves for requesters holding one of
  // these roles (e.g. a dedicated EXCO/Manager/CEO travel advance workflow) — NULL
  // means the workflow applies to any requester, same as before this column existed.
  await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS requester_roles text[]`);
}

async function insertWorkflowSteps(workflowId: string, steps: z.infer<typeof WorkflowStepSchema>[]) {
  if (steps.length === 0) return;
  await ensureAssignedUserColumn();
  const values: string[] = [];
  const params: unknown[] = [];
  steps.forEach((step) => {
    const baseIndex = params.length + 1;
    // assigned_user_ids is the source of truth; assigned_user_id (singular,
    // kept for older readers) is always its first element.
    const assignedUserIds = Array.from(new Set(
      step.assigned_user_ids?.length ? step.assigned_user_ids : (step.assigned_user_id ? [step.assigned_user_id] : [])
    ));
    params.push(
      workflowId,
      step.step_order,
      normalizeWorkflowRouteCode(step.position_type_code, step.position_name),
      assignedUserIds[0] || null,
      assignedUserIds,
      step.approval_mode ?? "SINGLE",
      step.approval_group_name || null,
      step.position_name,
      step.description || null,
      step.is_required ?? false,
      step.skip_if_unassigned ?? false,
      step.allow_delegation ?? false,
      step.comments_required ?? false,
      step.escalation_days ?? 0,
      step.is_final_approval ?? false,
      step.is_system_step ?? false,
      step.is_active ?? true,
      step.requires_accommodation ?? false,
      step.parallel_with_previous ?? false,
      step.action_type ?? "APPROVE",
      step.can_reject ?? true,
      step.can_rollback ?? true
    );
    values.push(
      `($${baseIndex},$${baseIndex+1},$${baseIndex+2},$${baseIndex+3},$${baseIndex+4},$${baseIndex+5},$${baseIndex+6},$${baseIndex+7},$${baseIndex+8},$${baseIndex+9},$${baseIndex+10},$${baseIndex+11},$${baseIndex+12},$${baseIndex+13},$${baseIndex+14},$${baseIndex+15},$${baseIndex+16},$${baseIndex+17},$${baseIndex+18},$${baseIndex+19},$${baseIndex+20},$${baseIndex+21})`
    );
  });

  await query(
    `INSERT INTO workflow_steps
      (workflow_id, step_order, position_type_code, assigned_user_id, assigned_user_ids, approval_mode, approval_group_name, position_name, description, is_required, skip_if_unassigned, allow_delegation, comments_required, escalation_days, is_final_approval, is_system_step, is_active, requires_accommodation, parallel_with_previous, action_type, can_reject, can_rollback)
     VALUES ${values.join(",")}`,
    params
  );
}

async function insertWorkflowRules(workflowId: string, rules: z.infer<typeof WorkflowRuleSchema>[]) {
  if (!rules || rules.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  rules.forEach((rule) => {
    const baseIndex = params.length + 1;
    params.push(
      workflowId,
      rule.rule_name,
      rule.condition_field,
      rule.condition_operator,
      rule.condition_value,
      normalizeWorkflowRouteCode(rule.additional_position_type_code, rule.additional_position_name),
      rule.additional_position_name || workflowRouteLabel(rule.additional_position_type_code, null),
      rule.additional_assigned_user_id || null,
      rule.is_active ?? true
    );
    values.push(
      `($${baseIndex},$${baseIndex + 1},$${baseIndex + 2},$${baseIndex + 3},$${baseIndex + 4},$${baseIndex + 5},$${baseIndex + 6},$${baseIndex + 7},$${baseIndex + 8})`
    );
  });

  await query(
    `INSERT INTO workflow_rules
      (workflow_id, rule_name, condition_field, condition_operator, condition_value, additional_position_type_code, additional_position_name, additional_assigned_user_id, is_active)
     VALUES ${values.join(",")}`,
    params
  );
}

workflowsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    await ensureAssignedUserColumn();
    const requestType = String(req.query.requestType || "").trim();
    const department = String(req.query.department || "").trim();
    const status = String(req.query.status || "").trim().toUpperCase();
    const search = String(req.query.search || "").trim();
    const filters: string[] = [];
    const params: unknown[] = [];

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
                   'position_type_code', ws.position_type_code,
                   'position_name', ws.position_name,
                   'description', ws.description,
                   'is_required', ws.is_required,
                   'skip_if_unassigned', ws.skip_if_unassigned,
                   'allow_delegation', ws.allow_delegation,
                   'comments_required', ws.comments_required,
                   'escalation_days', ws.escalation_days,
                   'is_final_approval', ws.is_final_approval,
                   'is_system_step', ws.is_system_step,
                   'is_active', ws.is_active,
                   'requires_accommodation', ws.requires_accommodation,
                   'parallel_with_previous', ws.parallel_with_previous,
                   'action_type', ws.action_type,
                   'can_reject', ws.can_reject,
                   'can_rollback', ws.can_rollback
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
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.get("/active", async (req: AuthedRequest, res, next) => {
  try {
    const requestType = String(req.query.requestType || "").trim();
    if (!requestType) {
      throw badRequest("requestType query parameter is required");
    }

    const rows = await query(
      `SELECT * FROM workflows WHERE request_type=$1 AND status='ACTIVE' ORDER BY created_at DESC`,
      [requestType]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.get("/resolve", async (req: AuthedRequest, res, next) => {
  try {
    const requestType = String(req.query.requestType || "").trim();
    const department = String(req.query.department || "").trim();
    const section = String(req.query.section || "").trim();
    const advanceSubType = String(req.query.advance_sub_type || "").trim();
    const requesterRole = String(req.query.requester_role || "").trim();
    const amount = Number(req.query.amount || 0);
    if (!requestType) throw badRequest("requestType query parameter is required");

    // Priority (highest → lowest):
    //   A workflow restricted to the requester's role (requester_roles) always
    //   outranks an unrestricted one, regardless of dept/section/sub_type specificity.
    //   0 = section + dept + sub_type exact match
    //   1 = dept + sub_type match (no section constraint)
    //   2 = section + dept match (no sub_type constraint)
    //   3 = dept match only (global for dept)
    //   4 = fully global (no dept/section/sub_type constraint)
    const workflows = await query<{ id: string }>(
      `SELECT *
         FROM workflows
        WHERE request_type = $1
          AND status = 'ACTIVE'
          AND (department IS NULL OR trim(department) = '' OR lower(trim(department)) = lower(trim($2)))
          AND (section IS NULL OR trim(section) = '' OR lower(trim(section)) = lower(trim($3)))
          AND (
            advance_sub_type IS NULL OR trim(advance_sub_type) = ''
            OR ($4 <> '' AND lower(trim(advance_sub_type)) = lower(trim($4)))
            -- "TRAVEL" sub-type covers all travel advance types (anything other than SALARY/LOAN)
            OR ($4 <> '' AND lower(trim(advance_sub_type)) = 'travel' AND upper(trim($4)) NOT IN ('SALARY','LOAN'))
          )
          AND (requester_roles IS NULL OR ($5 <> '' AND $5 = ANY(requester_roles)))
        ORDER BY
          CASE WHEN requester_roles IS NOT NULL THEN 0 ELSE 1 END,
          CASE
            WHEN $4 <> '' AND lower(trim(COALESCE(advance_sub_type,''))) = lower(trim($4))
                 AND lower(trim(COALESCE(section,''))) = lower(trim($3))
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 0
            WHEN $4 <> '' AND lower(trim(COALESCE(advance_sub_type,''))) = lower(trim($4))
                 AND (section IS NULL OR trim(section) = '')
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 1
            WHEN $4 <> '' AND upper(trim($4)) NOT IN ('SALARY','LOAN') AND lower(trim(COALESCE(advance_sub_type,''))) = 'travel'
                 AND lower(trim(COALESCE(section,''))) = lower(trim($3))
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 2
            WHEN $4 <> '' AND upper(trim($4)) NOT IN ('SALARY','LOAN') AND lower(trim(COALESCE(advance_sub_type,''))) = 'travel'
                 AND (section IS NULL OR trim(section) = '')
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 3
            WHEN (advance_sub_type IS NULL OR trim(advance_sub_type) = '')
                 AND lower(trim(COALESCE(section,''))) = lower(trim($3))
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 4
            WHEN (advance_sub_type IS NULL OR trim(advance_sub_type) = '')
                 AND (section IS NULL OR trim(section) = '')
                 AND lower(trim(COALESCE(department,''))) = lower(trim($2)) THEN 5
            ELSE 6
          END,
          updated_at DESC, created_at DESC
        LIMIT 1`,
      [requestType, department, section, advanceSubType, requesterRole]
    );
    const workflow = workflows[0];
    if (!workflow) return res.json({ workflow: null, chain: [], tasks: [], warnings: ["No active workflow found."] });

    const [steps, rules] = await Promise.all([
      query<any>(
        `SELECT ws.*,
                u.full_name AS assigned_user_name, u.email AS assigned_user_email
           FROM workflow_steps ws
           LEFT JOIN users u ON u.id = ws.assigned_user_id
          WHERE ws.workflow_id=$1 AND ws.is_active = true
          ORDER BY ws.step_order ASC`,
        [workflow.id]
      ),
      query<any>(
        `SELECT wr.*,
                u.full_name AS additional_assigned_user_name,
                u.title AS additional_assigned_user_title,
                u.email AS additional_assigned_user_email
           FROM workflow_rules wr
           LEFT JOIN users u ON u.id = wr.additional_assigned_user_id
          WHERE wr.workflow_id=$1 AND wr.is_active = true
          ORDER BY wr.created_at ASC`,
        [workflow.id]
      )
    ]);
    const hasHrStep = steps.some((step) => normalizeWorkflowRouteCode(step.position_type_code, step.position_name).startsWith("HR_"));
    const hrLeadership = hasHrStep ? await getDepartmentLeadership("Human Resource") : null;

    // A step can now have more than one assigned person (first to act
    // satisfies it) — resolve every id referenced across all steps in one pass.
    const allAssignedIds = Array.from(new Set(steps.flatMap((step) => (step.assigned_user_ids as string[] | null) || [])));
    const assignedUserMap = allAssignedIds.length
      ? new Map((await query<{ id: string; full_name: string | null; email: string | null }>(
          `SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[])`,
          [allAssignedIds]
        )).map((u) => [u.id, u]))
      : new Map<string, { id: string; full_name: string | null; email: string | null }>();

    // MANAGER/HOD steps with no explicit assignee resolve dynamically to the
    // requester's own reporting_lines manager (mirrors resolveWorkflowChain
    // in workflowEngine.ts — this route is only a preview of that same
    // chain, so it must resolve the same way or the preview lies about what
    // actually happens on submit). If the chain also has a separate,
    // dynamically-resolved MANAGER step, the HOD step escalates one level
    // further up rather than repeating the same person on both steps.
    const isDynamicManagerOrHod = (step: (typeof steps)[number]) => {
      const code = normalizeWorkflowRouteCode(step.position_type_code, step.position_name);
      const hasAssignee = !!(step.assigned_user_ids as string[] | null)?.length || !!step.assigned_user_id;
      const isGroupStep = step.approval_mode === "ANY_ONE" && !!step.approval_group_name;
      return { code, isManager: code === "MANAGER" && !hasAssignee && !isGroupStep, isHod: code === "HOD" && !hasAssignee && !isGroupStep };
    };
    const hasUnassignedManagerStep = steps.some((step) => isDynamicManagerOrHod(step).isManager);
    const hasUnassignedHodStep = steps.some((step) => isDynamicManagerOrHod(step).isHod);
    const requesterManager = (hasUnassignedManagerStep || hasUnassignedHodStep) ? await resolveRequesterManager(req.user!.userId) : null;
    const hodEscalatedManager = (hasUnassignedManagerStep && hasUnassignedHodStep && requesterManager)
      ? await resolveRequesterManager(requesterManager.id)
      : null;

    const warnings: string[] = [];
    const chain = steps.flatMap((step) => {
      const code = normalizeWorkflowRouteCode(step.position_type_code, step.position_name);
      const isHrCode = code.startsWith("HR_");
      const { isManager: isDynamicManager, isHod: isDynamicHod } = isDynamicManagerOrHod(step);
      const dynamicManager = isDynamicManager ? requesterManager : isDynamicHod ? (hasUnassignedManagerStep ? hodEscalatedManager : requesterManager) : null;
      const stepAssignedIds: string[] = (step.assigned_user_ids as string[] | null)?.length
        ? (step.assigned_user_ids as string[])
        : (step.assigned_user_id ? [step.assigned_user_id] : []);
      const approverIds =
        isHrCode
          ? (hrLeadership?.hod_user_id ? [hrLeadership.hod_user_id] : hrLeadership?.manager_user_id ? [hrLeadership.manager_user_id] : [])
          : (isDynamicManager || isDynamicHod)
          ? (dynamicManager?.id ? [dynamicManager.id] : [])
          : stepAssignedIds;
      const approverId = approverIds[0] || null;
      const approverName =
        isHrCode
          ? (hrLeadership?.hod_name ?? hrLeadership?.manager_name ?? null)
          : (isDynamicManager || isDynamicHod)
          ? (dynamicManager?.full_name ?? null)
          : approverIds.map((id) => assignedUserMap.get(id)?.full_name || assignedUserMap.get(id)?.email).filter(Boolean).join(", ") || null;

      if (!approverId && step.is_required && !step.skip_if_unassigned && isHrCode) {
        warnings.push(`${step.position_name} is required but the Human Resource department has no Manager/HOD assigned.`);
      }
      if (!approverId && step.skip_if_unassigned) return [];

      return [{
        step_order: step.step_order,
        position_name: step.position_name,
        position_type_code: code,
        approver_ids: approverIds,
        approval_mode: step.approval_mode || "SINGLE",
        approval_group_name: step.approval_group_name || null,
        approver_id: approverId,
        approver_name: approverName || null,
        required: step.is_required,
        final_approval: step.is_final_approval,
        action_type: step.action_type || "APPROVE"
      }];
    });

    const conditionalTasks = rules.flatMap((rule) => {
      const value = Number(rule.condition_value || 0);
      const matched =
        rule.condition_operator === ">" ? amount > value :
        rule.condition_operator === "<" ? amount < value :
        amount === value;
      const code = normalizeWorkflowRouteCode(rule.additional_position_type_code, rule.additional_position_name);
      const approverId = rule.additional_assigned_user_id || null;
      const approverName = rule.additional_assigned_user_id ? rule.additional_assigned_user_name : null;
      return matched ? [{
        rule_name: rule.rule_name,
        position_name: rule.additional_position_name || workflowRouteLabel(rule.additional_position_type_code, "Additional Approval"),
        position_type_code: code,
        approver_id: approverId,
        approver_name: approverName || null,
        condition: `${rule.condition_field} ${rule.condition_operator} ${rule.condition_value}`
      }] : [];
    });

    return res.json({ workflow, chain, tasks: [...chain, ...conditionalTasks], warnings });
  } catch (err) {
    return next(err);
  }
});

// ── Fixed-path routes — must all be registered BEFORE /:id ───────────────────

workflowsRouter.get("/chain-approvers", async (req: AuthedRequest, res, next) => {
  try {
    const department = String(req.user!.department || "").trim();
    const rows = await query<{
      id: string; full_name: string | null; email: string;
      employee_no: string | null; department: string | null;
      title: string | null; role: string;
    }>(
      `SELECT DISTINCT u.id, u.full_name, u.email, u.employee_no, u.department, u.title, u.role
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
        ORDER BY u.full_name NULLS LAST, u.email`,
      [department]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ── Workflow Action Types ─────────────────────────────────────────────────────

workflowsRouter.get("/action-types", async (_req: AuthedRequest, res, next) => {
  try {
    await ensureActionTypesTable();
    const rows = await query<{ id: number; code: string; label: string; is_system: boolean; is_active: boolean; sort_order: number }>(
      `SELECT id, code, label, is_system, is_active, sort_order
         FROM workflow_action_types
        ORDER BY sort_order, id`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

const ActionTypeSchema = z.object({
  code:       z.string().trim().min(1).toUpperCase().regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, digits and underscores only"),
  label:      z.string().trim().min(1),
  is_active:  z.boolean().optional(),
  sort_order: z.coerce.number().int().optional()
});

workflowsRouter.post("/action-types", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    await ensureActionTypesTable();
    const parsed = ActionTypeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const { code, label, is_active = true, sort_order = 99 } = parsed.data;
    const rows = await query<{ id: number }>(
      `INSERT INTO workflow_action_types (code, label, is_system, is_active, sort_order)
       VALUES ($1, $2, false, $3, $4)
       ON CONFLICT (code) DO UPDATE SET label=$2, is_active=$3, sort_order=$4
       RETURNING id`,
      [code, label, is_active, sort_order]
    );
    return res.status(201).json({ id: rows[0].id, code, label });
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.put("/action-types/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    await ensureActionTypesTable();
    const UpdateSchema = z.object({
      label:      z.string().trim().min(1).optional(),
      is_active:  z.boolean().optional(),
      sort_order: z.coerce.number().int().optional()
    });
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const updates: string[] = [];
    const params: unknown[] = [];
    if (parsed.data.label      !== undefined) { params.push(parsed.data.label);      updates.push(`label=$${params.length}`); }
    if (parsed.data.is_active  !== undefined) { params.push(parsed.data.is_active);  updates.push(`is_active=$${params.length}`); }
    if (parsed.data.sort_order !== undefined) { params.push(parsed.data.sort_order); updates.push(`sort_order=$${params.length}`); }
    if (!updates.length) return res.json({ ok: true });
    params.push(req.params.id);
    const rows = await query(`UPDATE workflow_action_types SET ${updates.join(",")} WHERE id=$${params.length} RETURNING id`, params);
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.delete("/action-types/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    await ensureActionTypesTable();
    const rows = await query<{ is_system: boolean }>(
      `SELECT is_system FROM workflow_action_types WHERE id=$1`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound();
    if (rows[0].is_system) throw badRequest("Built-in action types cannot be deleted");
    await query(`DELETE FROM workflow_action_types WHERE id=$1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

workflowsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await ensureAssignedUserColumn();
    const workflowId = String(req.params.id || "").trim();
    if (!workflowId) throw notFound();

    const workflowRows = await query(`SELECT * FROM workflows WHERE id=$1`, [workflowId]);
    const workflow = workflowRows[0];
    if (!workflow) throw notFound();

    const steps = await query(
      `SELECT ws.*,
              u.full_name AS assigned_user_name, u.email AS assigned_user_email
         FROM workflow_steps ws
         LEFT JOIN users u ON u.id = ws.assigned_user_id
        WHERE ws.workflow_id=$1 ORDER BY ws.step_order ASC`,
      [workflowId]
    );
    const rules = await query(`SELECT * FROM workflow_rules WHERE workflow_id=$1 ORDER BY created_at ASC`, [workflowId]);

    return res.json({ ...workflow, steps, rules });
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.post("/", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid workflow payload", parsed.error.flatten());
    }

    await ensureWorkflowScopeColumns();
    const workflowRow = (
      await query<{ id: string }>(
        `INSERT INTO workflows (name, request_type, advance_sub_type, division, department, section, team, description, status, workflow_type, valid_from, valid_until, requester_roles, created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [parsed.data.name, parsed.data.request_type, parsed.data.advance_sub_type || null, parsed.data.division || null, parsed.data.department || null, parsed.data.section || null, parsed.data.team || null, parsed.data.description || null, parsed.data.status, parsed.data.workflow_type ?? "STICKY", parsed.data.valid_from || null, parsed.data.valid_until || null, parsed.data.requester_roles?.length ? parsed.data.requester_roles : null, req.user!.userId]
      )
    )[0];

    await insertWorkflowSteps(workflowRow.id, parsed.data.steps);
    await insertWorkflowRules(workflowRow.id, parsed.data.rules || []);

    return res.status(201).json({ id: workflowRow.id });
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.put("/:id", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid workflow payload", parsed.error.flatten());
    }

    await ensureWorkflowScopeColumns();
    const updates: string[] = [];
    const params: unknown[] = [];
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
    if (parsed.data.division !== undefined) {
      updates.push(`division=$${params.length + 1}`);
      params.push(parsed.data.division || null);
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
    if (parsed.data.workflow_type !== undefined) {
      updates.push(`workflow_type=$${params.length + 1}`);
      params.push(parsed.data.workflow_type);
    }
    if (parsed.data.valid_from !== undefined) {
      updates.push(`valid_from=$${params.length + 1}`);
      params.push(parsed.data.valid_from || null);
    }
    if (parsed.data.valid_until !== undefined) {
      updates.push(`valid_until=$${params.length + 1}`);
      params.push(parsed.data.valid_until || null);
    }
    if (parsed.data.requester_roles !== undefined) {
      updates.push(`requester_roles=$${params.length + 1}`);
      params.push(parsed.data.requester_roles?.length ? parsed.data.requester_roles : null);
    }
    if (updates.length > 0) {
      params.push(req.params.id);
      const rows = await query(
        `UPDATE workflows SET ${updates.join(",")}, updated_at=now() WHERE id=$${params.length} RETURNING id`,
        params
      );
      if (!rows[0]) throw notFound();
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
  } catch (err) {
    return next(err);
  }
});

// Returns users eligible as custom-chain approvers:
// - users from the requester's own department
// - users from any department/section marked is_business_partner = true
// Excludes pure-employee roles so only potential approvers are shown.
workflowsRouter.delete("/:id", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `DELETE FROM workflows WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err: any) {
    // Workflows already referenced by submitted advance requests can't be
    // deleted outright (advance_requests.workflow_id FK) — guide the admin
    // to deactivate instead of surfacing a raw 500.
    if (err?.code === "23503") {
      return next(badRequest("This workflow has already been used for submitted requests and can't be deleted. Deactivate it instead."));
    }
    return next(err);
  }
});

