import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { comparePassword, hashPassword, signToken, type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { env } from "../../config/env.js";
import { badRequest, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { authenticateAgainstAd } from "../../lib/ad.js";
import { logger, serializeError } from "../../lib/logger.js";
import { isProfileComplete } from "../../lib/userProfile.js";
import { createDepartmentGroup, createSectionGroup, deleteDepartmentGroup, deleteSectionGroup, listDepartmentGroups, listDepartmentsWithSections, listSectionGroups, resolveDepartmentGroup, updateDepartmentGroup, updateSectionGroup } from "../../lib/departments.js";

const LoginSchema = z
  .object({
    email: z.string().min(1).optional(),
    userName: z.string().min(1).optional(),
    password: z.string().min(1)
  })
  .refine((v) => !!(v.email || v.userName), {
    message: "email or userName is required",
    path: ["email"]
  });

export const authRouter = Router();

function assertRoleAssignmentAllowed(req: AuthedRequest, target: { department: string | null; role?: string | null }, nextRole: string) {
  if (req.user!.role === "ADMIN") return;
  if (req.user!.role !== "MANAGER" && req.user!.role !== "CHIEF_OFFICER") {
    throw forbidden("Only admins, managers, and chief officers can assign roles");
  }

  const department = String(req.user!.department || "").trim();
  const targetDepartment = String(target.department || "").trim();
  if (!department || !targetDepartment || department !== targetDepartment) {
    throw forbidden("Managers and chief officers can only assign roles within their department");
  }
  if (nextRole === "ADMIN" || target.role === "ADMIN") {
    throw forbidden("Managers and chief officers cannot assign or modify admin roles");
  }
}

const ProfileSchema = z
  .object({
    full_name: z.string().trim().min(1, "Full name is required"),
    department: z.string().trim().min(1, "Department is required"),
    employment_type: z.enum(["PERMANENT", "INTERN", "TEMPORARY"]),
    employee_no: z.string().trim().optional()
  })
  .superRefine((data, ctx) => {
    const employeeNo = String(data.employee_no || "").trim();
    if (data.employment_type === "PERMANENT" && !employeeNo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["employee_no"], message: "Employment number is required for permanent employees" });
    }
  });

const UpdateUserRoleSchema = z.object({
  role: z.enum(["EMPLOYEE", "MANAGER", "HR_MANAGER", "AUTH_OFFICER", "CHIEF_OFFICER", "FINANCE", "ADMIN"]),
  is_active: z.boolean().optional()
});

const UpdateUserDepartmentSchema = z.object({
  department: z.string().trim().min(1, "Department is required")
});

const CreateDelegationSchema = z.object({
  manager_id: z.string().uuid().optional(),
  delegate_id: z.string().uuid(),
  from_date: z.string().optional(),
  to_date: z.string().optional()
});

const CreateDepartmentSchema = z.object({
  name: z.string().trim().min(2, "Department name is required"),
  section_id: z.string().uuid().optional()
});

const UpdateDepartmentSchema = z.object({
  name: z.string().trim().min(2, "Department name is required"),
  section_id: z.string().uuid().optional()
});

const CreateSectionSchema = z.object({
  name: z.string().trim().min(2, "Section name is required")
});

const UpdateSectionSchema = z.object({
  name: z.string().trim().min(2, "Section name is required")
});

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const head = local.slice(0, 2);
  return `${head}***@${domain}`;
}

function fallbackNameFromEmail(email: string) {
  const local = email.split("@")[0] || "User";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function toSyntheticEmail(loginId: string) {
  const local = loginId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^\.+|\.+$/g, "") || "user";
  return `${local}@${env.AD_SYNTHETIC_EMAIL_DOMAIN}`;
}

function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function toAuthResponse(user: {
  id: string;
  role: any;
  full_name: string | null;
  employee_no: string | null;
  department: string | null;
  employment_type: string | null;
  profile_completed: boolean | null;
}, username: string) {
  const profileCompleted = isProfileComplete(user);
  const token = signToken({
    userId: user.id,
    role: user.role,
    username,
    fullName: user.full_name || undefined,
    employeeNo: user.employee_no ?? null,
    department: user.department ?? null,
    employmentType: user.employment_type ?? "PERMANENT",
    profileCompleted
  });

  return {
    token,
    user: {
      id: user.id,
      role: user.role,
      full_name: user.full_name,
      employee_no: user.employee_no,
      department: user.department ?? null,
      employment_type: user.employment_type ?? "PERMANENT",
      profile_completed: profileCompleted
    }
  };
}

authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      const rawLogin = typeof req.body?.email === "string" ? String(req.body.email) : typeof req.body?.userName === "string" ? String(req.body.userName) : "";
      const loginPreview = rawLogin.split("@")[0]?.trim().toLowerCase() || null;
      logger.warn("auth_login_failed_invalid_payload", {
        login: loginPreview
      });
      throw badRequest("Invalid login payload", parsed.error.flatten());
    }
    const loginRaw = (parsed.data.email || parsed.data.userName || "").trim();
    const loginDisplay = loginRaw;
    const loginUser = loginRaw.split("@")[0].trim().toLowerCase();
    const loginEmail = isEmailLike(loginRaw) ? loginRaw.toLowerCase() : null;
    const password = parsed.data.password;
    logger.info("auth_login_attempt", { login: loginUser, login_email: loginEmail ? maskEmail(loginEmail) : null });

    const users = await query<{
      id: string;
      password_hash: string;
      role: any;
      full_name: string | null;
      employee_no: string | null;
      department: string | null;
      employment_type: string | null;
      profile_completed: boolean | null;
      email: string;
    }>(
      `SELECT id, password_hash, role, full_name, employee_no, department, employment_type, profile_completed, email
       FROM users
       WHERE (
         lower(employee_no)=lower($1)
         OR lower(split_part(email,'@',1))=lower($1)
         OR ($2::text IS NOT NULL AND lower(email)=lower($2))
       )
       AND is_active=true
       ORDER BY updated_at DESC
       LIMIT 1`,
      [loginUser, loginEmail]
    );
    let user = users[0] ?? null;

    if (env.AD_AUTH_ENABLED) {
      try {
        const ad = await authenticateAgainstAd({ email: loginUser, password });
        if (ad.authenticated) {
          if (!user) {
            const syntheticHash = await hashPassword(randomUUID());
            const emailToStore = ad.profile?.email?.trim().toLowerCase() || loginEmail || toSyntheticEmail(loginUser);
            const created = await query<{ id: string; role: any; email: string }>(
              `INSERT INTO users (employee_no, full_name, email, role, password_hash, is_active, employment_type, profile_completed)
               VALUES ($1,$2,$3,'EMPLOYEE',$4,true,'PERMANENT',false)
               RETURNING id, role, email`,
              [
                ad.profile?.employee_no ?? null,
                ad.profile?.full_name ?? fallbackNameFromEmail(ad.profile?.email || loginUser),
                emailToStore,
                syntheticHash
              ]
            );
            user = {
              id: created[0].id,
              role: created[0].role,
              email: created[0].email,
              password_hash: syntheticHash,
              full_name: ad.profile?.full_name ?? null,
              employee_no: ad.profile?.employee_no ?? null,
              department: null,
              employment_type: "PERMANENT",
              profile_completed: false
            };
            logger.info("ad_login_user_created", { login: loginUser, email: maskEmail(user.email), user_id: user.id });
          } else {
            if (ad.profile?.full_name || ad.profile?.employee_no) {
              await query(
                `UPDATE users
                 SET full_name = COALESCE($2, full_name),
                     employee_no = COALESCE($3, employee_no),
                     updated_at = now()
                 WHERE id = $1`,
                [user.id, ad.profile.full_name ?? null, ad.profile.employee_no ?? null]
              );
              user = {
                ...user,
                full_name: ad.profile.full_name ?? user.full_name,
                employee_no: ad.profile.employee_no ?? user.employee_no
              };
            }
          }

          logger.info("auth_login_success_ad", { login: loginUser, email: maskEmail(user.email), user_id: user.id, role: user.role });
          return res.json(toAuthResponse(user, loginDisplay));
        }
        logger.warn("auth_login_failed_ad_false", { login: loginUser, login_email: loginEmail ? maskEmail(loginEmail) : null });
      } catch (adErr) {
        logger.warn("auth_login_failed_ad_error_fallback", { login: loginUser, login_email: loginEmail ? maskEmail(loginEmail) : null, error: serializeError(adErr) });
        if (!env.AD_FALLBACK_LOCAL) throw unauthorized("AD authentication unavailable");
      }
    }

    if (!user) {
      logger.warn("auth_login_failed_local_user_not_found", { login: loginUser, login_email: loginEmail ? maskEmail(loginEmail) : null });
      throw unauthorized("Invalid credentials");
    }
    const ok = await comparePassword(password, user.password_hash);
    if (!ok) {
      logger.warn("auth_login_failed_local_bad_password", { login: loginUser, login_email: loginEmail ? maskEmail(loginEmail) : null, user_id: user.id });
      throw unauthorized("Invalid credentials");
    }

    logger.info("auth_login_success_local", { login: loginUser, email: maskEmail(user.email), user_id: user.id, role: user.role });
    return res.json(toAuthResponse(user, loginDisplay));
  } catch (err) {
    return next(err);
  }
});

authRouter.use(requireAuth);

authRouter.get("/me", async (req: AuthedRequest, res, next) => {
  try {
    const user = (
      await query<{
        id: string;
        email: string;
        role: string;
        full_name: string | null;
        employee_no: string | null;
        department: string | null;
        employment_type: string | null;
        profile_completed: boolean | null;
        is_active: boolean;
      }>(
        `SELECT id, email, role, full_name, employee_no, department, employment_type, profile_completed, is_active
         FROM users
         WHERE id=$1`,
        [req.user!.userId]
      )
    )[0];
    if (!user) throw notFound();
    return res.json({ ...user, profile_completed: isProfileComplete(user) });
  } catch (err) {
    return next(err);
  }
});

authRouter.get(["/departments", "/groups"], async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await listDepartmentGroups());
  } catch (err) {
    return next(err);
  }
});

authRouter.post(["/departments", "/groups"], requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateDepartmentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid department payload", parsed.error.flatten());
    return res.status(201).json(await createDepartmentGroup(parsed.data.name, parsed.data.section_id));
  } catch (err) {
    return next(err);
  }
});

authRouter.put(["/departments/:department", "/groups/:department"], requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateDepartmentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid department payload", parsed.error.flatten());
    const updated = await updateDepartmentGroup(req.params.department, parsed.data.name, parsed.data.section_id);
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

authRouter.delete(["/departments/:department", "/groups/:department"], requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    return res.json(await deleteDepartmentGroup(req.params.department));
  } catch (err) {
    return next(err);
  }
});

authRouter.get("/sections", async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await listSectionGroups());
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/sections", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateSectionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid section payload", parsed.error.flatten());
    return res.status(201).json(await createSectionGroup(parsed.data.name));
  } catch (err) {
    return next(err);
  }
});

authRouter.put("/sections/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateSectionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid section payload", parsed.error.flatten());
    return res.json(await updateSectionGroup(req.params.id, parsed.data.name));
  } catch (err) {
    return next(err);
  }
});

authRouter.delete("/sections/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    return res.json(await deleteSectionGroup(req.params.id));
  } catch (err) {
    return next(err);
  }
});

authRouter.get("/departments-with-sections", async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await listDepartmentsWithSections());
  } catch (err) {
    return next(err);
  }
});

// Admin: clear all sessions (force logout)
authRouter.post("/admin/clear-sessions", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    await query(`INSERT INTO system_state (key, value) VALUES ('sessions_cleared_at', now()::timestamptz::text) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Admin: reset profiles for non-admin users and clear sessions
authRouter.post("/admin/reset-profiles", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    await query(
      `UPDATE users
          SET profile_completed = false,
              full_name = NULL,
              employee_no = NULL,
              department = NULL,
              updated_at = now()
        WHERE role IS NULL OR role != 'ADMIN'`
    );

    await query(`INSERT INTO system_state (key, value) VALUES ('sessions_cleared_at', now()::timestamptz::text) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/complete-profile", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ProfileSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid profile payload", parsed.error.flatten());

    const employeeNo = String(parsed.data.employee_no || "").trim() || null;
    const department = await resolveDepartmentGroup(parsed.data.department);

    const rows = await query<{
      id: string;
      role: string;
      full_name: string | null;
      employee_no: string | null;
      department: string | null;
      employment_type: string | null;
      profile_completed: boolean | null;
    }>(
      `UPDATE users
          SET full_name=$2,
              department=$3,
              employment_type=$4,
              employee_no=$5,
              profile_completed=true,
              updated_at=now()
        WHERE id=$1
        RETURNING id, role, full_name, employee_no, department, employment_type, profile_completed`,
      [req.user!.userId, parsed.data.full_name, department, parsed.data.employment_type, employeeNo]
    );

    return res.json(toAuthResponse(rows[0], req.user?.username || req.user?.fullName || "user"));
  } catch (err) {
    return next(err);
  }
});

authRouter.get("/users", requireRole(["ADMIN", "MANAGER", "CHIEF_OFFICER"]), async (req: AuthedRequest, res, next) => {
  try {
    const isAdmin = req.user!.role === "ADMIN";
    const rows = await query(
      `SELECT id, full_name, email, employee_no, department, employment_type, role, profile_completed, is_active, created_at, updated_at
       FROM users
       WHERE ($1::boolean = true OR trim(department) = $2)
       ORDER BY full_name NULLS LAST, email`,
      [isAdmin, String(req.user!.department || "").trim()]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

authRouter.get("/request-directory", async (req: AuthedRequest, res, next) => {
  try {
    const department = String(req.user!.department || "").trim();
    if (!department) return res.json([]);
    const rows = await query(
      `SELECT id, full_name, email, employee_no, department, employment_type, role, profile_completed
       FROM users
       WHERE is_active = true
         AND trim(department) = $1
       ORDER BY full_name NULLS LAST, email`,
      [department]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

authRouter.post(["/users/:id/department", "/users/:id/group"], requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateUserDepartmentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid department payload", parsed.error.flatten());
    const department = await resolveDepartmentGroup(parsed.data.department);

    const rows = await query(
      `UPDATE users
          SET department=$2,
              profile_completed =
                CASE
                  WHEN coalesce(nullif(trim(full_name), ''), '') = '' THEN false
                  WHEN coalesce(nullif(trim($2::text), ''), '') = '' THEN false
                  WHEN coalesce(nullif(employment_type, ''), 'PERMANENT') IN ('INTERN', 'TEMPORARY') THEN true
                  WHEN coalesce(nullif(trim(employee_no), ''), '') = '' THEN false
                  ELSE true
                END,
              updated_at=now()
        WHERE id=$1
        RETURNING id, full_name, email, employee_no, department, employment_type, role, profile_completed, is_active, created_at, updated_at`,
      [req.params.id, department]
    );
    if (!rows[0]) throw notFound();
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

authRouter.get("/delegations", requireRole(["ADMIN", "MANAGER"]), async (req: AuthedRequest, res, next) => {
  try {
    const isAdmin = req.user!.role === "ADMIN";
    const condition = isAdmin ? `` : `WHERE md.manager_id = $1`;
    const params = isAdmin ? [] : [req.user!.userId];
    const rows = await query(
      `SELECT md.id,
              md.manager_id,
              manager.full_name AS manager_name,
              md.delegate_id,
              delegate.full_name AS delegate_name,
              md.department,
              md.from_date,
              md.to_date,
              md.active,
              md.created_at,
              md.updated_at
         FROM manager_delegations md
         JOIN users manager ON manager.id = md.manager_id
         JOIN users delegate ON delegate.id = md.delegate_id
         ${condition}
        ORDER BY md.created_at DESC`,
      params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/delegations", requireRole(["ADMIN", "MANAGER"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateDelegationSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid delegation payload", parsed.error.flatten());

    const managerId = req.user!.role === "MANAGER" ? req.user!.userId : parsed.data.manager_id;
    if (!managerId) throw badRequest("Manager is required for delegation");

    const users = await query<{ id: string; role: string; department: string | null }>(
      `SELECT id, role, department FROM users WHERE id IN ($1, $2)`,
      [managerId, parsed.data.delegate_id]
    );
    const manager = users.find((user) => user.id === managerId);
    const delegate = users.find((user) => user.id === parsed.data.delegate_id);
    if (!manager || manager.role !== "MANAGER") throw badRequest("Manager user not found or not a manager");
    if (!delegate) throw badRequest("Delegate user not found");
    if (delegate.id === manager.id) throw badRequest("Delegate cannot be the same user");

    const managerDept = String(manager.department || "").trim();
    const delegateDept = String(delegate.department || "").trim();
    if (!managerDept || managerDept !== delegateDept) {
      throw badRequest("Delegate must be in the same department as the manager");
    }

    const rows = await query(
      `INSERT INTO manager_delegations (id, manager_id, delegate_id, department, from_date, to_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, manager_id, delegate_id, department, from_date, to_date, active, created_at, updated_at`,
      [randomUUID(), manager.id, delegate.id, managerDept, parsed.data.from_date ?? null, parsed.data.to_date ?? null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/delegations/:id/end", requireRole(["ADMIN", "MANAGER"]), async (req: AuthedRequest, res, next) => {
  try {
    const delegation = (await query<{ id: string; manager_id: string }>(`SELECT id, manager_id FROM manager_delegations WHERE id=$1`, [req.params.id]))[0];
    if (!delegation) throw notFound();
    if (req.user!.role === "MANAGER" && delegation.manager_id !== req.user!.userId) {
      throw forbidden("Managers can only end their own delegations");
    }

    const rows = await query(
      `UPDATE manager_delegations
          SET active=false,
              updated_at=now()
        WHERE id=$1
        RETURNING id, manager_id, delegate_id, department, from_date, to_date, active, created_at, updated_at`,
      [req.params.id]
    );
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/users/:id/role", requireRole(["ADMIN", "MANAGER", "CHIEF_OFFICER"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateUserRoleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid user update payload", parsed.error.flatten());

    const existing = await query<{ id: string; department: string | null; role: string | null }>(
      `SELECT id, department, role
       FROM users
       WHERE id=$1`,
      [req.params.id]
    );
    if (!existing[0]) throw notFound();
    assertRoleAssignmentAllowed(req, existing[0], parsed.data.role);

    const rows = await query(
      `UPDATE users
          SET role=$2,
              is_active=COALESCE($3, is_active),
              updated_at=now()
        WHERE id=$1
        RETURNING id, full_name, email, employee_no, department, employment_type, role, profile_completed, is_active, created_at, updated_at`,
      [req.params.id, parsed.data.role, parsed.data.is_active ?? null]
    );
    if (!rows[0]) throw notFound();
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/departments/:department/role", requireRole(["ADMIN", "MANAGER", "CHIEF_OFFICER"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateUserRoleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid department role payload", parsed.error.flatten());

    const department = await resolveDepartmentGroup(String(req.params.department || ""));
    assertRoleAssignmentAllowed(req, { department }, parsed.data.role);

    const rows = await query(
      `UPDATE users
          SET role=$2,
              updated_at=now()
        WHERE trim(department) = $1
          AND ($3::boolean = true OR role <> 'ADMIN')
        RETURNING id`,
      [department, parsed.data.role, req.user!.role === "ADMIN"]
    );

    return res.json({ ok: true, updated_count: rows.length, department, role: parsed.data.role });
  } catch (err) {
    return next(err);
  }
});
