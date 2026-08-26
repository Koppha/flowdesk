import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";

export const paAssignmentsRouter = Router();
paAssignmentsRouter.use(requireAuth);

// Any authenticated user can see who they're a PA for - this is what
// populates their own "Request For" beneficiary list. Managing the
// assignments themselves (create/end) is ADMIN-only, below.
paAssignmentsRouter.get("/my-principals", async (req: AuthedRequest, res, next) => {
  try {
    // Full org placement (role, section, division), not just department -
    // the advance form needs all of it to resolve the boss's actual rate
    // tier and approval chain, not the PA's own (see App.tsx's
    // selectedRequestUser / travellerRole / the resolveWorkflow effect).
    const rows = await query(
      `SELECT u.id, u.full_name, u.email, u.employee_no, u.employment_type, u.department, u.profile_completed,
              u.role, u.section_id, s.name AS section_name, u.division_id, dv.name AS division_name
         FROM pa_assignments pa
         JOIN users u ON u.id = pa.principal_user_id
         LEFT JOIN sections s ON s.id = u.section_id
         LEFT JOIN divisions dv ON dv.id = u.division_id
        WHERE pa.pa_user_id = $1 AND pa.is_active = true AND u.is_active = true
        ORDER BY u.full_name NULLS LAST`,
      [req.user!.userId]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

paAssignmentsRouter.get("/", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT pa.id, pa.is_active, pa.created_at,
              pa_u.id AS pa_user_id, pa_u.full_name AS pa_user_name, pa_u.email AS pa_user_email,
              pr_u.id AS principal_user_id, pr_u.full_name AS principal_user_name, pr_u.email AS principal_user_email
         FROM pa_assignments pa
         JOIN users pa_u ON pa_u.id = pa.pa_user_id
         JOIN users pr_u ON pr_u.id = pa.principal_user_id
        WHERE pa.is_active = true
        ORDER BY pa.created_at DESC`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

const CreateSchema = z.object({
  pa_user_id: z.string().uuid(),
  principal_user_id: z.string().uuid()
});

paAssignmentsRouter.post("/", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const body = CreateSchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid PA assignment payload", body.error.flatten());
    if (body.data.pa_user_id === body.data.principal_user_id) throw badRequest("A person can't be their own PA");

    const users = await query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM users WHERE id IN ($1, $2)`,
      [body.data.pa_user_id, body.data.principal_user_id]
    );
    if (users.length < 2) throw badRequest("PA or principal user not found");
    if (users.some((u) => !u.is_active)) throw badRequest("Both users must be active");

    const rows = await query<{ id: string }>(
      `INSERT INTO pa_assignments (pa_user_id, principal_user_id, created_by_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (pa_user_id, principal_user_id) WHERE is_active DO NOTHING
       RETURNING id`,
      [body.data.pa_user_id, body.data.principal_user_id, req.user!.userId]
    );
    if (!rows[0]) throw badRequest("This PA assignment already exists");
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

paAssignmentsRouter.delete("/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<{ id: string }>(
      `UPDATE pa_assignments SET is_active=false, updated_at=now() WHERE id=$1 AND is_active=true RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound("PA assignment not found");
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
