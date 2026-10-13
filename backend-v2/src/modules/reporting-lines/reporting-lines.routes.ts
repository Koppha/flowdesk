import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { getDepartmentLeadership, getSectionLeadership, getTeamLeadership, listDepartmentGroups } from "../../lib/departments.js";
import { getDelegationsForManager } from "../../lib/delegations.js";

const OPEN_ADVANCE_STATUSES = "('SUBMITTED','COUNTERSIGNED','HR_REVIEW','HR_OFFICER','APPROVED')";
const OPEN_CLAIM_STATUSES = "('SUBMITTED','MANAGER_APPROVED','EXCO_APPROVED','FINANCE_VERIFIED','HR_OFFICER','PAYMENT_PROCESSING')";

// Falls back to leadership when no reporting_lines row exists yet, mirroring
// resolveRequesterManager in workflowEngine.ts: EXCO -> CEO, otherwise the
// closest available leadership first - the requester's TEAM (users.team_id,
// the UI's "Section" field - the closest possible unit; several departments
// now have more than one active MANAGER/HOD, each actually running a
// different team under it, so matching team_id first finds the right one
// instead of an arbitrary department-wide pick) - then their SECTION
// (users.section_id, the UI's "Department" field - a broader unit than
// team, e.g. Technical's four sections each have their own real HOD) - then
// their department as a broader last resort. HOD -> EXCO, MANAGER ->
// HOD/EXCO, everyone else -> MANAGER/HOD/EXCO at each level.
// (/reporting-lines/auto-generate is a separate bulk admin tool that
// doesn't go through this function and is department-only today - not
// updated here, out of scope for this fix.)
async function getFallbackManagerId(userId: string): Promise<string | null> {
  const userRows = await query<{ role: string; department: string | null; section_id: string | null; team_id: string | null }>(
    `SELECT role::text AS role, department, section_id, team_id FROM users WHERE id = $1`,
    [userId]
  );
  const user = userRows[0];
  if (!user) return null;

  if (user.role === "EXCO") {
    const ceoRows = await query<{ id: string }>(
      `SELECT id FROM users WHERE role::text = 'CEO' AND is_active = true ORDER BY full_name LIMIT 1`
    );
    return ceoRows[0]?.id ?? null;
  }

  const fallbackId = (leadership: { hod_user_id: string | null; manager_user_id: string | null; exco_user_id: string | null }) => {
    if (user.role === "HOD") return leadership.exco_user_id ?? null;
    if (user.role === "MANAGER") return leadership.hod_user_id ?? leadership.exco_user_id ?? null;
    return leadership.manager_user_id ?? leadership.hod_user_id ?? leadership.exco_user_id ?? null;
  };

  if (user.team_id) {
    const teamId = fallbackId(await getTeamLeadership(user.team_id));
    if (teamId) return teamId;
  }
  if (user.section_id) {
    const sectionId = fallbackId(await getSectionLeadership(user.section_id));
    if (sectionId) return sectionId;
  }
  if (!user.department) return null;
  return fallbackId(await getDepartmentLeadership(user.department));
}

export const reportingLinesRouter = Router();
reportingLinesRouter.use(requireAuth);

// Walks reporting_lines upward from employeeId, returning the ordered chain
// of manager IDs (immediate manager first) up to the root.
export async function getManagerChainIds(employeeId: string): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>([employeeId]);
  let currentId = employeeId;

  while (true) {
    const rows = await query<{ manager_id: string | null }>(
      `SELECT manager_id FROM reporting_lines WHERE employee_id = $1 AND is_active = true LIMIT 1`,
      [currentId]
    );
    const managerId = rows[0]?.manager_id;
    if (!managerId || seen.has(managerId)) break;
    chain.push(managerId);
    seen.add(managerId);
    currentId = managerId;
  }

  return chain;
}

// The user's direct manager: their explicit reporting line, else the
// org-structure leadership fallback. Shared by /my-manager (what the form
// shows) and fixed-chain submission (who actually gets the step), so the
// two can never disagree.
export async function resolveDirectManagerId(userId: string): Promise<string | null> {
  let managerId: string | null = (await getManagerChainIds(userId))[0] ?? null;
  if (!managerId || managerId === userId) {
    managerId = await getFallbackManagerId(userId);
  }
  return managerId && managerId !== userId ? managerId : null;
}

// GET /reporting-lines/my-manager — the current user's direct manager (any
// authenticated user), used to auto-resolve "Requester's Manager" steps in
// fixed approval chains (e.g. Computer Request) without exposing the org chart.
reportingLinesRouter.get("/my-manager", async (req: AuthedRequest, res, next) => {
  try {
    const managerId = await resolveDirectManagerId(req.user!.userId);
    if (!managerId) return res.json(null);
    const manager = (await query<{ id: string; full_name: string | null; email: string; title: string | null }>(
      `SELECT id, full_name, email, title FROM users WHERE id = $1 AND is_active = true`,
      [managerId]
    ))[0];
    return res.json(manager ?? null);
  } catch (err) {
    return next(err);
  }
});

// GET /reporting-lines/stats
reportingLinesRouter.get("/stats", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (_req: AuthedRequest, res, next) => {
  try {
    const [totalRows, managersRows, hodsRows, excoRows] = await Promise.all([
      query<{ count: string }>(`SELECT COUNT(*) FROM users WHERE is_active = true AND role::text != 'ADMIN'`),
      query<{ count: string }>(`SELECT COUNT(*) FROM users WHERE is_active = true AND role::text = 'MANAGER'`),
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
reportingLinesRouter.get("/", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
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
reportingLinesRouter.get("/hierarchy/:department", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
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
    const processedEmployeeIds = new Set<string>();

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
        processedEmployeeIds.add(emp.id);
      }
    }

    // EXCO members placed directly at Division level (no department under
    // them at all - e.g. SEFS's single EXCO covering every SEFS
    // department) never match the per-department loop above, since it only
    // finds employees via users.department. Wire any leftover active EXCO
    // straight to the CEO too, same as their department-scoped peers.
    if (ceoId) {
      const orphanedExco = await query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM users WHERE role::text = 'EXCO' AND is_active = true`
      );
      for (const exco of orphanedExco) {
        if (processedEmployeeIds.has(exco.id)) continue;
        await query(
          `UPDATE reporting_lines SET is_active = false, updated_at = now() WHERE employee_id = $1 AND is_active = true`,
          [exco.id]
        );
        await query(
          `INSERT INTO reporting_lines (id, employee_id, manager_id, effective_from, reason, created_by_id)
           VALUES ($1, $2, $3, CURRENT_DATE, 'Auto-generated (Division-level EXCO)', $4)`,
          [randomUUID(), exco.id, ceoId, req.user!.userId]
        );
        generated++;
        processedEmployeeIds.add(exco.id);
      }
    }

    return res.json({ ok: true, generated, warnings });
  } catch (err) {
    return next(err);
  }
});

// GET /reporting-lines/my-team — the calling manager/HOD/EXCO/CEO's own
// direct reports plus enough real, computed data to power a "My Team"
// overview: pending/open request counts per member, this manager's own
// active outgoing delegation (if any), and recent activity by team members.
// Deliberately self-scoped (only ever the caller's own reports) so it's
// safe for any of these roles, unlike the full org-wide "/" listing above.
reportingLinesRouter.get("/my-team", requireRole(["MANAGER", "HOD", "EXCO", "CEO", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const managerId = req.user!.userId;
    const members = await query<any>(
      `WITH viewer AS (SELECT id, role::text AS role, department, section_id, team_id FROM users WHERE id = $1),
            explicit_reports AS (
              SELECT u.id FROM users u
              JOIN reporting_lines rl ON rl.employee_id = u.id AND rl.is_active = true
              WHERE rl.manager_id = $1
            ),
            -- Closest possible tier: the viewer's own team (users.team_id,
            -- the UI's "Section" field). Several departments now have more
            -- than one active MANAGER/HOD, each actually running a
            -- different team under it (e.g. Operations: one manager per
            -- team - Transmission, NOC, IP Core Network, Network Quality) -
            -- matching team_id first attributes an unassigned employee to
            -- the manager who actually runs their team, instead of every
            -- manager who merely shares the same department.
            team_fallback AS (
              SELECT u.id FROM users u, viewer v
              WHERE v.team_id IS NOT NULL AND u.team_id = v.team_id AND u.id <> v.id
                AND NOT EXISTS (SELECT 1 FROM reporting_lines rl WHERE rl.employee_id = u.id AND rl.is_active = true)
                AND (
                  (u.role::text = 'EMPLOYEE' AND v.role = 'MANAGER') OR
                  (u.role::text = 'MANAGER' AND v.role = 'HOD') OR
                  (u.role::text = 'HOD' AND v.role = 'EXCO')
                )
            ),
            -- Same role-tier fallback resolveRequesterManager uses at
            -- submit time (EMPLOYEE -> section MANAGER, MANAGER -> section
            -- HOD, HOD -> section EXCO) - anyone without a personal
            -- reporting_lines row who'd resolve to this viewer as their
            -- approver belongs on their team too, or "My Team" stays empty
            -- for every manager who only has fallback-resolved reports.
            -- Skipped for an employee whose own team already has a
            -- dedicated leader of the right tier - team_fallback above
            -- attributes them to that specific manager instead, the same
            -- team-before-section cascade resolveRequesterManager uses.
            section_fallback AS (
              SELECT u.id FROM users u, viewer v
              WHERE u.section_id = v.section_id AND u.id <> v.id
                AND NOT EXISTS (SELECT 1 FROM reporting_lines rl WHERE rl.employee_id = u.id AND rl.is_active = true)
                AND NOT EXISTS (
                  SELECT 1 FROM users tm
                  WHERE tm.team_id = u.team_id AND tm.is_active = true
                    AND (
                      (u.role::text = 'EMPLOYEE' AND tm.role::text = 'MANAGER') OR
                      (u.role::text = 'MANAGER' AND tm.role::text = 'HOD') OR
                      (u.role::text = 'HOD' AND tm.role::text = 'EXCO')
                    )
                )
                AND (
                  (u.role::text = 'EMPLOYEE' AND v.role = 'MANAGER') OR
                  (u.role::text = 'MANAGER' AND v.role = 'HOD') OR
                  (u.role::text = 'HOD' AND v.role = 'EXCO')
                )
            ),
            -- Department-level tier only for employees with no section of
            -- their own to be resolved through first. Unlike section_fallback
            -- above, getDepartmentLeadership does NOT derive this live from
            -- role+department - it reads departments.manager_user_id/
            -- hod_user_id/exco_user_id, a single explicitly-set column per
            -- role. Matching that exactly (instead of "any manager in the
            -- same department") avoids showing the same unassigned employees
            -- under every manager who happens to share that department, and
            -- avoids attributing them to the wrong one when the department's
            -- real designated fallback is someone else entirely.
            department_fallback AS (
              SELECT u.id FROM users u, viewer v, departments d
              WHERE u.department = v.department AND u.department = d.name
                AND u.id <> v.id AND u.section_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM reporting_lines rl WHERE rl.employee_id = u.id AND rl.is_active = true)
                AND (
                  (u.role::text = 'EMPLOYEE' AND v.role = 'MANAGER' AND d.manager_user_id = v.id) OR
                  (u.role::text = 'MANAGER' AND v.role = 'HOD' AND d.hod_user_id = v.id) OR
                  (u.role::text = 'HOD' AND v.role = 'EXCO' AND d.exco_user_id = v.id)
                )
            ),
            team_ids AS (
              SELECT id FROM explicit_reports
              UNION SELECT id FROM team_fallback
              UNION SELECT id FROM section_fallback
              UNION SELECT id FROM department_fallback
            )
       SELECT u.id, u.full_name, u.email, u.title, u.role::text AS role, u.department, u.is_active,
              (SELECT COUNT(*) FROM advance_requests ar WHERE ar.requester_id = u.id AND ar.status::text IN ${OPEN_ADVANCE_STATUSES}) AS pending_advances,
              (SELECT COUNT(*) FROM clearance_claims cc WHERE cc.claimant_id = u.id AND cc.status::text IN ${OPEN_CLAIM_STATUSES}) AS pending_claims,
              (SELECT COUNT(*) FROM advance_requests ar WHERE ar.requester_id = u.id) AS total_advances,
              (SELECT COUNT(*) FROM clearance_claims cc WHERE cc.claimant_id = u.id) AS total_claims,
              GREATEST(
                (SELECT MAX(ar.updated_at) FROM advance_requests ar WHERE ar.requester_id = u.id),
                (SELECT MAX(cc.updated_at) FROM clearance_claims cc WHERE cc.claimant_id = u.id)
              ) AS last_activity
         FROM users u
         JOIN team_ids t ON t.id = u.id
        ORDER BY u.full_name NULLS LAST, u.email`,
      [managerId]
    );
    const memberIds = members.map((m: any) => m.id);

    const [delegations, recentActivity] = await Promise.all([
      getDelegationsForManager(managerId),
      memberIds.length
        ? query<any>(
            `SELECT al.id, al.action, al.entity_type, al.created_at, u.full_name AS actor_name
               FROM audit_log al
               JOIN users u ON u.id = al.actor_id
              WHERE al.actor_id = ANY($1::uuid[])
              ORDER BY al.created_at DESC
              LIMIT 10`,
            [memberIds]
          )
        : Promise.resolve([])
    ]);

    return res.json({
      members: members.map((m: any) => ({
        ...m,
        pending_requests: Number(m.pending_advances) + Number(m.pending_claims),
        total_requests: Number(m.total_advances) + Number(m.total_claims)
      })),
      active_delegation: delegations.find((d) => d.active) ?? null,
      recent_activity: recentActivity
    });
  } catch (err) {
    return next(err);
  }
});
