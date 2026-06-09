import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getDepartmentLeadership, listDepartmentGroups } from "../../lib/departments.js";

export const reportingLinesRouter = Router();
reportingLinesRouter.use(requireAuth);

// GET /reporting-lines/stats
reportingLinesRouter.get("/stats", requireRole(["ADMIN", "MANAGER", "CHIEF_OFFICER"]), async (_req: AuthedRequest, res, next) => {
  try {
    const [totalRows, managersRows, hodsRows, excoRows] = await Promise.all([
      query<{ count: string }>(`SELECT COUNT(*) FROM users WHERE is_active = true AND role::text != 'ADMIN'`),
      query<{ count: string }>(`SELECT COUNT(*) FROM users WHERE is_active = true AND role::text IN ('MANAGER', 'HR_MANAGER')`),
      query<{ count: string }>(`SELECT COUNT(*) FROM users WHERE is_active = true AND role::text = 'HOD'`),
      query<{ count: string }>(`SELECT COUNT(*) FROM users WHERE is_active = true AND role::text = 'EXCO'`)
    ]);
    return res.json({
      total_employees: parseInt(totalRows[0]?.count || "0"),
      managers: parseInt(managersRows[0]?.count || "0"),
      hods: parseInt(hodsRows[0]?.count || "0"),
      exco_members: parseInt(excoRows[0]?.count || "0")
    });
  } catch (err) {
    return next(err);
  }
});

// GET /reporting-lines
reportingLinesRouter.get("/", requireRole(["ADMIN", "MANAGER", "CHIEF_OFFICER"]), async (req: AuthedRequest, res, next) => {
  try {
    const department = String(req.query.department || "").trim();
    const search = String(req.query.search || "").trim();
    const sectionId = typeof req.query.section_id === "string" ? req.query.section_id.trim() : "";
    const teamId = typeof req.query.team_id === "string" ? req.query.team_id.trim() : "";

    const filters: string[] = ["u.role::text != 'ADMIN'"];
    const params: unknown[] = [];

    if (teamId) {
      params.push(teamId);
      filters.push(`u.team_id = $${params.length}`);
    } else if (sectionId) {
      params.push(sectionId);
      // Match by direct section_id OR via team that belongs to this section
      filters.push(`(u.section_id = $${params.length} OR u.team_id IN (SELECT id FROM teams WHERE section_id = $${params.length}))`);
    } else if (department) {
      params.push(department);
      filters.push(`lower(trim(u.department)) = lower(trim($${params.length}))`);
    }
    if (search) {
      params.push(`%${search}%`);
      filters.push(
        `(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.employee_no ILIKE $${params.length})`
      );
    }

    const rows = await query(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.employee_no,
         u.title,
         u.department,
         u.employment_type,
         u.role,
         u.profile_completed,
         u.is_active,
         rl.id            AS reporting_line_id,
         rl.manager_id,
         rl.effective_from,
         rl.effective_to,
         rl.reason,
         m.full_name      AS manager_name,
         m.email          AS manager_email,
         m.title          AS manager_title,
         m.role           AS manager_role
       FROM users u
       LEFT JOIN reporting_lines rl ON rl.employee_id = u.id AND rl.is_active = true
       LEFT JOIN users m            ON m.id = rl.manager_id
       ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY u.full_name NULLS LAST, u.email`,
      params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /reporting-lines/hierarchy/:department
reportingLinesRouter.get("/hierarchy/:department", requireRole(["ADMIN", "MANAGER", "CHIEF_OFFICER"]), async (req: AuthedRequest, res, next) => {
  try {
    const department = decodeURIComponent(String(req.params.department || "").trim());
    const leadership = await getDepartmentLeadership(department);

    const deptUsers = await query<{
      id: string;
      full_name: string | null;
      email: string;
      title: string | null;
      role: string;
      manager_id: string | null;
      is_active: boolean;
    }>(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.title,
         u.role,
         u.is_active,
         rl.manager_id
       FROM users u
       LEFT JOIN reporting_lines rl ON rl.employee_id = u.id AND rl.is_active = true
       WHERE lower(trim(u.department)) = lower(trim($1))
         AND u.role::text != 'ADMIN'
       ORDER BY u.full_name`,
      [department]
    );

    // Also pull in CEO(s) and the department's assigned EXCO so the full chain is visible
    const extraIds: string[] = [];
    if (leadership.exco_user_id) extraIds.push(leadership.exco_user_id);
    const existingIds = new Set(deptUsers.map(u => u.id));
    const idsToFetch = extraIds.filter(id => !existingIds.has(id));

    const ceoUsers = await query<{
      id: string; full_name: string | null; email: string;
      title: string | null; role: string; manager_id: string | null; is_active: boolean;
    }>(
      `SELECT u.id, u.full_name, u.email, u.title, u.role, u.is_active, rl.manager_id
         FROM users u
         LEFT JOIN reporting_lines rl ON rl.employee_id = u.id AND rl.is_active = true
        WHERE u.role::text = 'CEO' AND u.is_active = true`
    );

    const extraUsers = idsToFetch.length > 0
      ? await query<{
          id: string; full_name: string | null; email: string;
          title: string | null; role: string; manager_id: string | null; is_active: boolean;
        }>(
          `SELECT u.id, u.full_name, u.email, u.title, u.role, u.is_active, rl.manager_id
             FROM users u
             LEFT JOIN reporting_lines rl ON rl.employee_id = u.id AND rl.is_active = true
            WHERE u.id = ANY($1::uuid[])`,
          [idsToFetch]
        )
      : [];

    const allExtraIds = new Set([...deptUsers.map(u => u.id)]);
    const users = [
      ...ceoUsers.filter(u => !allExtraIds.has(u.id)),
      ...extraUsers,
      ...deptUsers,
    ];

    return res.json({ leadership, users, department });
  } catch (err) {
    return next(err);
  }
});

// GET /reporting-lines/employee/:id/history
reportingLinesRouter.get("/employee/:id/history", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT
         rl.*,
         m.full_name  AS manager_name,
         m.title      AS manager_title,
         cb.full_name AS created_by_name
       FROM reporting_lines rl
       LEFT JOIN users m  ON m.id  = rl.manager_id
       LEFT JOIN users cb ON cb.id = rl.created_by_id
       WHERE rl.employee_id = $1
       ORDER BY rl.created_at DESC`,
      [req.params.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

const UpsertSchema = z.object({
  employee_id: z.string().uuid(),
  manager_id: z.string().uuid().nullable().optional(),
  effective_from: z.string().nullish(),
  effective_to: z.string().nullish(),
  reason: z.string().nullish()
});

// POST /reporting-lines
reportingLinesRouter.post("/", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpsertSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid reporting line payload", parsed.error.flatten());
    const { employee_id, manager_id, effective_from, effective_to, reason } = parsed.data;

    if (manager_id === employee_id) throw badRequest("An employee cannot report to themselves");

    await query(
      `UPDATE reporting_lines SET is_active = false, updated_at = now() WHERE employee_id = $1 AND is_active = true`,
      [employee_id]
    );

    if (manager_id !== undefined) {
      const rows = await query(
        `INSERT INTO reporting_lines (id, employee_id, manager_id, effective_from, effective_to, reason, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          randomUUID(),
          employee_id,
          manager_id ?? null,
          effective_from ?? new Date().toISOString().slice(0, 10),
          effective_to ?? null,
          reason ?? null,
          req.user!.userId
        ]
      );
      return res.status(201).json(rows[0]);
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /reporting-lines/auto-generate
reportingLinesRouter.post("/auto-generate", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const departments = await listDepartmentGroups();
    const warnings: string[] = [];
    let generated = 0;

    // Find the active CEO (top of the entire chain)
    const ceoUsers = await query<{ id: string; full_name: string | null }>(
      `SELECT id, full_name FROM users WHERE role::text = 'CEO' AND is_active = true ORDER BY full_name LIMIT 1`
    );
    const ceoId: string | null = ceoUsers[0]?.id ?? null;

    if (!ceoId) {
      warnings.push("No active CEO found — EXCO members will have no reporting manager");
    }

    // Wire CEO → no one (top of chain)
    if (ceoId) {
      await query(
        `UPDATE reporting_lines SET is_active = false, updated_at = now() WHERE employee_id = $1 AND is_active = true`,
        [ceoId]
      );
    }

    for (const dept of departments as any[]) {
      if (!dept.name) continue;

      const employees = await query<{ id: string; role: string; full_name: string | null }>(
        `SELECT id, role::text AS role, full_name FROM users
         WHERE lower(trim(department)) = lower(trim($1))
           AND is_active = true
           AND role::text NOT IN ('ADMIN', 'CEO')`,
        [dept.name]
      );

      if (employees.length === 0) continue;

      const managerId: string | null = dept.manager_user_id ?? null;
      const hodId: string | null = dept.hod_user_id ?? null;
      const excoId: string | null = dept.exco_user_id ?? null;

      if (!managerId && !hodId) {
        warnings.push(`${dept.name}: no manager or HOD assigned — employees skipped`);
      }

      for (const emp of employees) {
        let reportsTo: string | null = null;

        if (emp.role === "EXCO" || emp.id === excoId) {
          // EXCO reports to CEO
          reportsTo = ceoId;
          if (!reportsTo) warnings.push(`${dept.name}: EXCO "${emp.full_name || emp.id}" has no CEO to report to`);
        } else if (emp.role === "HOD" || emp.id === hodId) {
          // HOD reports to EXCO
          reportsTo = excoId;
          if (!reportsTo) warnings.push(`${dept.name}: HOD "${emp.full_name || emp.id}" has no EXCO to report to`);
        } else if (emp.role === "MANAGER" || emp.id === managerId) {
          // Manager reports to HOD, or EXCO if no HOD
          reportsTo = hodId ?? excoId ?? null;
          if (!reportsTo) warnings.push(`${dept.name}: Manager "${emp.full_name || emp.id}" has no HOD or EXCO to report to`);
        } else {
          // All other employees report to manager
          reportsTo = managerId ?? null;
          if (!reportsTo) warnings.push(`${dept.name}: No manager for employee "${emp.full_name || emp.id}"`);
        }

        if (!reportsTo) continue;

        const mgr = await query<{ id: string; is_active: boolean }>(`SELECT id, is_active FROM users WHERE id = $1`, [reportsTo]);
        if (!mgr[0]?.is_active) {
          warnings.push(`"${emp.full_name || emp.id}": assigned manager is inactive — skipped`);
          continue;
        }

        await query(
          `UPDATE reporting_lines SET is_active = false, updated_at = now() WHERE employee_id = $1 AND is_active = true`,
          [emp.id]
        );
        await query(
          `INSERT INTO reporting_lines (id, employee_id, manager_id, effective_from, reason, created_by_id)
           VALUES ($1, $2, $3, CURRENT_DATE, 'Auto-generated', $4)`,
          [randomUUID(), emp.id, reportsTo, req.user!.userId]
        );
        generated++;
      }
    }

    return res.json({ ok: true, generated, warnings });
  } catch (err) {
    return next(err);
  }
});
