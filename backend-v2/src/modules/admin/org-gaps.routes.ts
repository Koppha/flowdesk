import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireFeatureAccess } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";

// RAID Advances R3: active users with a Division but no Department (59 on
// PROD in Oct 2026) - their reports and department-based approvals are
// incomplete. Lists them with the Departments of their own Division, and sets
// one with a click (recorded in audit_log). Admins, or whoever an admin grants
// "Missing Department" to (e.g. HR).
// Naming: UI Division = users.department / departments table; UI Department
// = users.section_id / sections table (sections.department_id -> division).
export const orgGapsRouter = Router();
orgGapsRouter.use(requireAuth, requireFeatureAccess("org_data_gaps", ["ADMIN"]));

orgGapsRouter.get("/", async (_req: AuthedRequest, res, next) => {
  try {
    const users = await query<any>(
      `SELECT u.id, u.full_name, u.email, u.employee_no, u.title, u.role::text AS role, u.department AS division, u.created_at,
              d.id AS division_ref_id
         FROM users u
         LEFT JOIN departments d ON lower(trim(d.name)) = lower(trim(u.department))
        WHERE u.is_active AND u.role::text <> 'ADMIN'
          AND coalesce(trim(u.department), '') <> '' AND u.section_id IS NULL
        ORDER BY u.department, u.full_name`
    );
    const departments = await query<{ id: string; name: string; division_ref_id: string | null; division: string | null; members: number }>(
      `SELECT s.id, s.name, s.department_id AS division_ref_id, d.name AS division,
              (SELECT count(*)::int FROM users m WHERE m.section_id = s.id AND m.is_active) AS members
         FROM sections s LEFT JOIN departments d ON d.id = s.department_id
        WHERE coalesce(s.active, true)
        ORDER BY d.name NULLS LAST, s.name`
    );
    return res.json({ users, departments });
  } catch (err) {
    return next(err);
  }
});

orgGapsRouter.post("/:userId", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ section_id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Choose a department");
    const user = (await query<any>(`SELECT id, full_name, department, section_id, team_id FROM users WHERE id = $1`, [req.params.userId]))[0];
    if (!user) throw notFound("User not found");
    const section = (await query<{ id: string; name: string }>(`SELECT id, name FROM sections WHERE id = $1`, [parsed.data.section_id]))[0];
    if (!section) throw badRequest("That department no longer exists");
    // Keep their Section (team) only if it belongs to the new Department.
    const keepTeam = user.team_id
      ? (await query(`SELECT 1 FROM teams WHERE id = $1 AND section_id = $2`, [user.team_id, section.id]))[0] != null
      : false;
    await query(`UPDATE users SET section_id = $2, team_id = $3, updated_at = now() WHERE id = $1`, [user.id, section.id, keepTeam ? user.team_id : null]);
    await query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json)
       VALUES ($1, 'USER_DEPARTMENT_SET', 'user', $2, $3, $4)`,
      [req.user!.userId, user.id, JSON.stringify({ section_id: user.section_id, team_id: user.team_id }),
       JSON.stringify({ section_id: section.id, department: section.name, team_id: keepTeam ? user.team_id : null, via: "Missing Department" })]
    );
    return res.json({ ok: true, department: section.name });
  } catch (err) {
    return next(err);
  }
});
