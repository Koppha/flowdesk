import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";

const WorkflowStepSchema = z.object({
  step_order: z.coerce.number().int().min(1),
  position_type_id: z.string().uuid().optional(),
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
  department: z.string().trim().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).default("DRAFT"),
  steps: z.array(WorkflowStepSchema).min(1, "At least one workflow step is required"),
  rules: z.array(WorkflowRuleSchema).optional()
});

const UpdateWorkflowSchema = z.object({
  name: z.string().trim().min(1).optional(),
  request_type: z.string().trim().min(1).optional(),
  department: z.string().trim().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
  steps: z.array(WorkflowStepSchema).optional(),
  rules: z.array(WorkflowRuleSchema).optional()
});

export const workflowsRouter = Router();
workflowsRouter.use(requireAuth);

async function insertWorkflowSteps(workflowId: string, steps: z.infer<typeof WorkflowStepSchema>[]) {
  if (steps.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  steps.forEach((step, index) => {
    const baseIndex = params.length + 1;
    params.push(
      workflowId,
      step.step_order,
      step.position_type_id || null,
      step.position_name,
      step.description || null,
      step.is_required ?? false,
      step.skip_if_unassigned ?? false,
      step.allow_delegation ?? false,
      step.comments_required ?? false,
      step.escalation_days ?? 0,
      step.is_final_approval ?? false,
      step.is_system_step ?? false,
      step.is_active ?? true
    );
    values.push(
      `($${baseIndex},$${baseIndex + 1},$${baseIndex + 2},$${baseIndex + 3},$${baseIndex + 4},$${baseIndex + 5},$${baseIndex + 6},$${baseIndex + 7},$${baseIndex + 8},$${baseIndex + 9},$${baseIndex + 10},$${baseIndex + 11},$${baseIndex + 12})`
    );
  });

  await query(
    `INSERT INTO workflow_steps
      (workflow_id, step_order, position_type_id, position_name, description, is_required, skip_if_unassigned, allow_delegation, comments_required, escalation_days, is_final_approval, is_system_step, is_active)
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
      rule.additional_position_type_id || null,
      rule.is_active ?? true
    );
    values.push(
      `($${baseIndex},$${baseIndex + 1},$${baseIndex + 2},$${baseIndex + 3},$${baseIndex + 4},$${baseIndex + 5},$${baseIndex + 6})`
    );
  });

  await query(
    `INSERT INTO workflow_rules
      (workflow_id, rule_name, condition_field, condition_operator, condition_value, additional_position_type_id, is_active)
     VALUES ${values.join(",")}`,
    params
  );
}

workflowsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const requestType = String(req.query.requestType || "").trim();
    const department = String(req.query.department || "").trim();
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

    const queryText = `SELECT * FROM workflows${filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY created_at DESC`;
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

workflowsRouter.get("/position-types", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT * FROM position_types WHERE is_active = true ORDER BY name ASC`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const workflowId = String(req.params.id || "").trim();
    if (!workflowId) throw notFound();

    const workflowRows = await query(`SELECT * FROM workflows WHERE id=$1`, [workflowId]);
    const workflow = workflowRows[0];
    if (!workflow) throw notFound();

    const steps = await query(`SELECT * FROM workflow_steps WHERE workflow_id=$1 ORDER BY step_order ASC`, [workflowId]);
    const rules = await query(`SELECT * FROM workflow_rules WHERE workflow_id=$1 ORDER BY created_at ASC`, [workflowId]);

    return res.json({ ...workflow, steps, rules });
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.post("/", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid workflow payload", parsed.error.flatten());
    }

    const workflowRow = (
      await query<{ id: string }>(
        `INSERT INTO workflows (name, request_type, department, status, created_by_id)
           VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [parsed.data.name, parsed.data.request_type, parsed.data.department || null, parsed.data.status, req.user!.userId]
      )
    )[0];

    await insertWorkflowSteps(workflowRow.id, parsed.data.steps);
    await insertWorkflowRules(workflowRow.id, parsed.data.rules || []);

    return res.status(201).json({ id: workflowRow.id });
  } catch (err) {
    return next(err);
  }
});

workflowsRouter.put("/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid workflow payload", parsed.error.flatten());
    }

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
    if (parsed.data.department !== undefined) {
      updates.push(`department=$${params.length + 1}`);
      params.push(parsed.data.department || null);
    }
    if (parsed.data.status !== undefined) {
      updates.push(`status=$${params.length + 1}`);
      params.push(parsed.data.status);
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

workflowsRouter.delete("/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `DELETE FROM workflows WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
