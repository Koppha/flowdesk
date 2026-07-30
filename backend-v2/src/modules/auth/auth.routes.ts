import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { comparePassword, hashPassword, signToken, type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { loginLimiter } from "../../middleware/rateLimit.js";
import { env } from "../../config/env.js";
import { badRequest, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { query, pool } from "../../lib/db.js";
import { authenticateAgainstAd } from "../../lib/ad.js";
import { logger, serializeError } from "../../lib/logger.js";
import { isProfileComplete } from "../../lib/userProfile.js";
import { createDepartmentGroup, createDivision, createManagerType, createSectionGroup, createTeam, deleteDepartmentGroup, deleteDivision, deleteManagerType, deleteSectionGroup, deleteTeam, ensureUserOrgColumns, listDepartmentGroups, listDepartmentsWithSections, listDivisions, listEligibleLeadershipUsers, listManagerTypes, listOrgStructure, listSectionGroups, listTeams, resolveDepartmentGroup, setSectionOwner, updateDepartmentGroup, updateDivision, updateManagerType, updateSectionGroup, updateTeam } from "../../lib/departments.js";
import { notifyProfileCompleted, notifyUserOnboarded, notifyUserReactivated, notifyUserRoleChanged, notifyDelegationAssigned, notifyDelegationEnded, notifyPositionAssigned } from "../../lib/notifications.js";
import { addGroupMember, createPermissionGroup, deletePermissionGroup, ensurePermissionGroupTables, getUserGroups, isOrgStructureGroupName, listGroupMembers, listPermissionGroups, removeGroupMember, setGroupVisibility, setUserGroups } from "../../lib/permissionGroups.js";
import { generateDelegationReference, getDelegationRequestTypes, setDelegationRequestTypes, writeDelegationAudit } from "../../lib/delegations.js";

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
  if (req.user!.role !== "MANAGER" && req.user!.role !== "EXCO") {
    throw forbidden("Only admins, managers, and EXCO members can assign roles");
  }

  const department = String(req.user!.department || "").trim();
  const targetDepartment = String(target.department || "").trim();
  if (!department || !targetDepartment || department !== targetDepartment) {
    throw forbidden("Managers and chief officers can only assign roles within their division");
  }
  if (nextRole === "ADMIN" || target.role === "ADMIN" || nextRole === "CEO" || target.role === "CEO") {
    throw forbidden("Only system administrators can assign or modify the ADMIN or CEO role");
  }
}

const ProfileSchema = z
  .object({
    full_name: z.string().trim().min(1, "Full name is required"),
    department: z.string().trim().min(1, "Division is required"),
    division_id: z.string().uuid().nullable().optional(),
    section_id: z.string().uuid().nullable().optional(),
    team_id: z.string().uuid().nullable().optional(),
    employment_type: z.string().trim().min(1).default("PERMANENT"),
    employee_no: z.string().trim().optional()
  })
  .superRefine((data, ctx) => {
    const employeeNo = String(data.employee_no || "").trim();
    if (data.employment_type === "PERMANENT" && !employeeNo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["employee_no"], message: "Employment number is required for permanent employees" });
    }
  });

const UpdateUserRoleSchema = z.object({
  role: z.enum(["EMPLOYEE", "HOD", "MANAGER", "FINANCE", "ADMIN", "EXCO", "CEO"]),
  is_active: z.boolean().optional()
});

const CreateUserSchema = z.object({
  email: z.string().trim().min(3, "Email is required"),
  full_name: z.string().trim().min(1).optional(),
  employee_no: z.string().trim().optional(),
  title: z.string().trim().optional(),
  department: z.string().trim().optional(),
  section: z.string().trim().optional(),
  division_id: z.string().uuid().nullable().optional(),
  section_id: z.string().uuid().nullable().optional(),
  team_id: z.string().uuid().nullable().optional(),
  manager_type_id: z.string().uuid().nullable().optional(),
  employment_type: z.string().trim().optional(),
  role: z.enum(["EMPLOYEE", "HOD", "MANAGER", "FINANCE", "ADMIN", "EXCO", "CEO"]).optional(),
  is_active: z.boolean().optional(),
  groups: z.array(z.string().trim().min(1)).optional()
});

const CreatePositionVacancySchema = z.object({
  role: z.enum(["HOD", "MANAGER", "EXCO", "CEO"]),
  title: z.string().trim().optional(),
  department: z.string().trim().optional(),
  division_id: z.string().uuid().nullable().optional(),
  section_id: z.string().uuid().nullable().optional(),
  team_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().optional()
});

const FillPositionVacancySchema = z.object({
  existing_user_id: z.string().uuid().optional(),
  email: z.string().trim().optional(),
  full_name: z.string().trim().optional(),
  employee_no: z.string().trim().optional(),
  title: z.string().trim().optional(),
  employment_type: z.string().trim().optional()
}).refine((data) => !!data.existing_user_id || !!data.email, {
  message: "Either existing_user_id or email is required"
});

const UpdateUserSchema = z.object({
  full_name: z.string().trim().min(1).optional(),
  email: z.string().trim().min(3).optional(),
  employee_no: z.string().trim().nullable().optional(),
  title: z.string().trim().nullable().optional(),
  department: z.string().trim().optional(),
  division_id: z.string().uuid().nullable().optional(),
  section_id: z.string().uuid().nullable().optional(),
  team_id: z.string().uuid().nullable().optional(),
  manager_type_id: z.string().uuid().nullable().optional(),
  employment_type: z.string().trim().optional(),
  is_active: z.boolean().optional(),
  groups: z.array(z.string().trim().min(1)).optional()
});

const UpdateUserDepartmentSchema = z.object({
  department: z.string().trim().min(1, "Division is required"),
  division_id: z.string().uuid().nullable().optional(),
  section_id: z.string().uuid().nullable().optional(),
  team_id: z.string().uuid().nullable().optional()
});

const CreateDelegationSchema = z.object({
  manager_id: z.string().uuid().optional(),
  delegate_id: z.string().uuid(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  reason: z.string().trim().max(200).optional(),
  comments: z.string().trim().max(2000).optional(),
  // Empty/omitted means "all request types" — the original, unscoped behavior.
  request_types: z.array(z.string()).optional()
});

const EndDelegationSchema = z.object({ reason: z.string().trim().max(1000).optional() });

const CreateDepartmentSchema = z.object({
  name: z.string().trim().min(2, "Division name is required"),
  section_id: z.string().uuid().nullable().optional(),
  division_id: z.string().uuid().nullable().optional(),
  hod_user_id: z.string().uuid().nullable().optional(),
  hodUserId: z.string().uuid().nullable().optional(),
  manager_user_id: z.string().uuid().nullable().optional(),
  managerUserId: z.string().uuid().nullable().optional(),
  exco_user_id: z.string().uuid().nullable().optional(),
  excoUserId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
  is_business_partner: z.boolean().optional(),
  division_ids: z.array(z.string().uuid()).optional()
});

const UpdateDepartmentSchema = z.object({
  name: z.string().trim().min(2, "Division name is required"),
  section_id: z.string().uuid().nullable().optional(),
  division_id: z.string().uuid().nullable().optional(),
  hod_user_id: z.string().uuid().nullable().optional(),
  hodUserId: z.string().uuid().nullable().optional(),
  manager_user_id: z.string().uuid().nullable().optional(),
  managerUserId: z.string().uuid().nullable().optional(),
  exco_user_id: z.string().uuid().nullable().optional(),
  excoUserId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
  is_business_partner: z.boolean().optional(),
  division_ids: z.array(z.string().uuid()).optional()
});

const CreateSectionSchema = z.object({
  name: z.string().trim().min(2, "Department name is required"),
  department_id: z.string().uuid().nullable().optional(),
  exco_user_id: z.string().uuid().nullable().optional(),
  excoUserId: z.string().uuid().nullable().optional(),
  is_business_partner: z.boolean().optional(),
  division_ids: z.array(z.string().uuid()).optional()
});

const UpdateSectionSchema = z.object({
  name: z.string().trim().min(2, "Department name is required"),
  department_id: z.string().uuid().nullable().optional(),
  exco_user_id: z.string().uuid().nullable().optional(),
  excoUserId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
  is_business_partner: z.boolean().optional(),
  division_ids: z.array(z.string().uuid()).optional()
});

const CreateDivisionSchema = z.object({
  name: z.string().trim().min(2, "Company name is required"),
  description: z.string().trim().optional().nullable()
});

const UpdateDivisionSchema = z.object({
  name: z.string().trim().min(2, "Company name is required"),
  description: z.string().trim().optional().nullable(),
  active: z.boolean().optional()
});

const CreateTeamSchema = z.object({
  name: z.string().trim().min(2, "Section name is required"),
  section_id: z.string().uuid().nullable().optional(),
  leader_user_id: z.string().uuid().nullable().optional()
});

const UpdateTeamSchema = z.object({
  name: z.string().trim().min(2, "Section name is required"),
  section_id: z.string().uuid().nullable().optional(),
  leader_user_id: z.string().uuid().nullable().optional(),
  active: z.boolean().optional()
});

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const head = local.slice(0, 2);
  return `${head}***@${domain}`;
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

function normalizeEmailForStorage(value: string) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) throw badRequest("Email is required");
  if (isEmailLike(raw)) return raw;
  if (raw.includes("@")) throw badRequest("Enter a valid email address or username");
  return toSyntheticEmail(raw);
}

function toAuthResponse(user: {
  id: string;
  role: any;
  full_name: string | null;
  employee_no: string | null;
  department: string | null;
  division_id?: string | null;
  section_id?: string | null;
  team_id?: string | null;
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
    divisionId: user.division_id ?? null,
    sectionId: user.section_id ?? null,
    teamId: user.team_id ?? null,
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
      division_id: user.division_id ?? null,
      section_id: user.section_id ?? null,
      team_id: user.team_id ?? null,
      employment_type: user.employment_type ?? "PERMANENT",
      profile_completed: profileCompleted
    }
  };
}

authRouter.post("/login", loginLimiter, async (req, res, next) => {
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
    const loginEmail = normalizeEmailForStorage(loginRaw);
    const password = parsed.data.password;
    logger.info("auth_login_attempt", { login: loginUser, login_email: loginEmail ? maskEmail(loginEmail) : null });

    const users = await query<{
      id: string;
      password_hash: string;
      role: any;
      full_name: string | null;
      employee_no: string | null;
      department: string | null;
      division_id: string | null;
      section_id: string | null;
      team_id: string | null;
      employment_type: string | null;
      profile_completed: boolean | null;
      email: string;
    }>(
      `SELECT id, password_hash, role, full_name, employee_no, department, division_id, section_id, team_id, employment_type, profile_completed, email
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
          const adProfile = ad.profile;
          const emailFromAdOrLogin = normalizeEmailForStorage(adProfile?.email || loginRaw);
          if (!user) {
            const syntheticHash = await hashPassword(randomUUID());
            const created = await query<{ id: string; role: any; email: string }>(
              `INSERT INTO users (employee_no, full_name, email, role, password_hash, is_active, employment_type, profile_completed)
               VALUES ($1,$2,$3,'EMPLOYEE',$4,true,'PERMANENT',false)
              RETURNING id, role, email`,
              [
                adProfile?.employee_no ?? null,
                adProfile?.full_name ?? null,
                emailFromAdOrLogin,
                syntheticHash
              ]
            );
            user = {
              id: created[0].id,
              role: created[0].role,
              email: created[0].email,
              password_hash: syntheticHash,
              full_name: adProfile?.full_name ?? null,
              employee_no: adProfile?.employee_no ?? null,
              department: null,
              division_id: null,
              section_id: null,
              team_id: null,
              employment_type: "PERMANENT",
              profile_completed: false
            };
            logger.info("ad_login_user_created", { login: loginUser, email: maskEmail(user.email), user_id: user.id });
          } else {
            const shouldUpdateEmail = emailFromAdOrLogin !== user.email.toLowerCase() && user.email.split("@")[0].toLowerCase() === loginUser;
            const emailConflict = shouldUpdateEmail
              ? await query<{ id: string }>(`SELECT id FROM users WHERE lower(email)=lower($1) AND id <> $2 LIMIT 1`, [emailFromAdOrLogin, user.id])
              : [];
            if (adProfile?.full_name || adProfile?.employee_no || (shouldUpdateEmail && !emailConflict[0])) {
              await query(
                `UPDATE users
                 SET full_name = COALESCE($2, full_name),
                     employee_no = COALESCE($3, employee_no),
                     email = COALESCE($4, email),
                     updated_at = now()
                 WHERE id = $1`,
                [user.id, adProfile?.full_name ?? null, adProfile?.employee_no ?? null, shouldUpdateEmail && !emailConflict[0] ? emailFromAdOrLogin : null]
              );
              user = {
                ...user,
                full_name: adProfile?.full_name ?? user.full_name,
                employee_no: adProfile?.employee_no ?? user.employee_no,
                email: shouldUpdateEmail && !emailConflict[0] ? emailFromAdOrLogin : user.email
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
        title: string | null;
        division_id: string | null;
        division_name: string | null;
        section_id: string | null;
        section_name: string | null;
        team_id: string | null;
        team_name: string | null;
        employment_type: string | null;
        profile_completed: boolean | null;
        is_active: boolean;
        favorite_pages: string[] | null;
      }>(
        `SELECT u.id, u.email, u.role, u.full_name, u.employee_no, u.department, u.title,
                u.division_id, dv.name AS division_name,
                u.section_id, s.name AS section_name,
                u.team_id, t.name AS team_name,
                u.employment_type, u.profile_completed, u.is_active, u.favorite_pages
           FROM users u
           LEFT JOIN divisions dv ON dv.id = u.division_id
           LEFT JOIN sections s ON s.id = u.section_id
           LEFT JOIN teams t ON t.id = u.team_id
          WHERE u.id=$1`,
        [req.user!.userId]
      )
    )[0];
    if (!user) throw notFound();
    const groups = await getUserGroups(user.id);
    return res.json({ ...user, favorite_pages: user.favorite_pages ?? [], groups, profile_completed: isProfileComplete(user) });
  } catch (err) {
    return next(err);
  }
});

const FavoritePagesSchema = z.object({ favorite_pages: z.array(z.string().trim().min(1)).max(20) });

// PATCH /auth/me/favorites — replace the requesting user's dashboard shortcut list.
authRouter.patch("/me/favorites", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = FavoritePagesSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid favorites payload", parsed.error.flatten());

    const deduped = [...new Set(parsed.data.favorite_pages)];
    await query(`UPDATE users SET favorite_pages = $1 WHERE id = $2`, [deduped, req.user!.userId]);
    return res.json({ favorite_pages: deduped });
  } catch (err) {
    return next(err);
  }
});

const VerifyPasswordSchema = z.object({ password: z.string().min(1) });

authRouter.post("/verify-password", async (req: AuthedRequest, res, next) => {
  try {
    const { password } = VerifyPasswordSchema.parse(req.body);
    const user = (
      await query<{ email: string; password_hash: string }>(`SELECT email, password_hash FROM users WHERE id=$1`, [req.user!.userId])
    )[0];
    if (!user) throw notFound();

    // AD-authenticated users have a synthetic, unknowable local password_hash
    // (see the login route above) — their real password is whatever they log
    // in with via AD, so verify against AD first, same as login does.
    if (env.AD_AUTH_ENABLED) {
      try {
        const ad = await authenticateAgainstAd({ email: user.email.split("@")[0], password });
        if (ad.authenticated) return res.json({ verified: true });
      } catch (adErr) {
        logger.warn("verify_password_ad_error_fallback", { user_id: req.user!.userId, error: serializeError(adErr) });
        if (!env.AD_FALLBACK_LOCAL) throw unauthorized("AD authentication unavailable");
      }
    }

    const ok = await comparePassword(password, user.password_hash);
    if (!ok) throw unauthorized("Invalid password");
    return res.json({ verified: true });
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
    if (!parsed.success) throw badRequest("Invalid division payload", parsed.error.flatten());
    return res.status(201).json(await createDepartmentGroup(parsed.data.name, {
      sectionId: parsed.data.section_id,
      divisionId: parsed.data.division_id,
      hodUserId: parsed.data.hod_user_id ?? parsed.data.hodUserId,
      managerUserId: parsed.data.manager_user_id ?? parsed.data.managerUserId,
      excoUserId: parsed.data.exco_user_id ?? parsed.data.excoUserId,
      active: parsed.data.active,
      isBusinessPartner: parsed.data.is_business_partner,
      divisionIds: parsed.data.division_ids
    }));
  } catch (err) {
    return next(err);
  }
});

authRouter.put(["/departments/:department", "/groups/:department"], requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateDepartmentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid division payload", parsed.error.flatten());
    const updated = await updateDepartmentGroup(req.params.department, parsed.data.name, {
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "section_id") ? { sectionId: parsed.data.section_id } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "division_id") ? { divisionId: parsed.data.division_id } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "hod_user_id") || Object.prototype.hasOwnProperty.call(parsed.data, "hodUserId")
        ? { hodUserId: parsed.data.hod_user_id ?? parsed.data.hodUserId ?? null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "manager_user_id") || Object.prototype.hasOwnProperty.call(parsed.data, "managerUserId")
        ? { managerUserId: parsed.data.manager_user_id ?? parsed.data.managerUserId ?? null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "exco_user_id") || Object.prototype.hasOwnProperty.call(parsed.data, "excoUserId")
        ? { excoUserId: parsed.data.exco_user_id ?? parsed.data.excoUserId ?? null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "active") ? { active: parsed.data.active } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "is_business_partner") ? { isBusinessPartner: parsed.data.is_business_partner } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "division_ids") ? { divisionIds: parsed.data.division_ids } : {})
    });
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
    if (!parsed.success) throw badRequest("Invalid department payload", parsed.error.flatten());
    return res.status(201).json(await createSectionGroup(
      parsed.data.name,
      parsed.data.exco_user_id ?? parsed.data.excoUserId,
      parsed.data.department_id,
      parsed.data.is_business_partner,
      parsed.data.division_ids
    ));
  } catch (err) {
    return next(err);
  }
});

authRouter.put("/sections/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateSectionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid department payload", parsed.error.flatten());
    const excoUserId = Object.prototype.hasOwnProperty.call(parsed.data, "exco_user_id") || Object.prototype.hasOwnProperty.call(parsed.data, "excoUserId")
      ? parsed.data.exco_user_id ?? parsed.data.excoUserId ?? null
      : undefined;
    const deptId = Object.prototype.hasOwnProperty.call(parsed.data, "department_id") ? parsed.data.department_id ?? null : undefined;
    const divisionIds = Object.prototype.hasOwnProperty.call(parsed.data, "division_ids") ? parsed.data.division_ids : undefined;
    return res.json(await updateSectionGroup(req.params.id, parsed.data.name, excoUserId, deptId, parsed.data.active, parsed.data.is_business_partner, divisionIds));
  } catch (err) {
    return next(err);
  }
});

const SectionOwnerSchema = z.object({
  role: z.enum(["HOD", "MANAGER"]),
  user_id: z.string().uuid().nullable(),
});

authRouter.put("/sections/:id/owner", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SectionOwnerSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid department owner payload", parsed.error.flatten());
    return res.json(await setSectionOwner(req.params.id, parsed.data.role, parsed.data.user_id));
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

authRouter.get("/leadership-users", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await listEligibleLeadershipUsers());
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Divisions
// ---------------------------------------------------------------------------

authRouter.get("/divisions", async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await listDivisions());
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/divisions", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateDivisionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid company payload", parsed.error.flatten());
    return res.status(201).json(await createDivision(parsed.data.name, parsed.data.description));
  } catch (err) {
    return next(err);
  }
});

authRouter.put("/divisions/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateDivisionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid company payload", parsed.error.flatten());
    return res.json(await updateDivision(req.params.id, parsed.data.name, parsed.data.description, parsed.data.active));
  } catch (err) {
    return next(err);
  }
});

authRouter.delete("/divisions/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    return res.json(await deleteDivision(req.params.id));
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

authRouter.get("/teams", async (req: AuthedRequest, res, next) => {
  try {
    const sectionId = typeof req.query.section_id === "string" ? req.query.section_id : undefined;
    return res.json(await listTeams(sectionId));
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/teams", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateTeamSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid section payload", parsed.error.flatten());
    return res.status(201).json(await createTeam(parsed.data.name, parsed.data.section_id, parsed.data.leader_user_id));
  } catch (err) {
    return next(err);
  }
});

authRouter.put("/teams/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateTeamSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid section payload", parsed.error.flatten());
    return res.json(await updateTeam(req.params.id, parsed.data.name, parsed.data.section_id, parsed.data.leader_user_id, parsed.data.active));
  } catch (err) {
    return next(err);
  }
});

authRouter.delete("/teams/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    return res.json(await deleteTeam(req.params.id));
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Full org structure tree
// ---------------------------------------------------------------------------

authRouter.get("/org-structure", async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await listOrgStructure());
  } catch (err) {
    return next(err);
  }
});

// DELETE /auth/org-structure/unassigned — bulk-delete all unassigned nodes
authRouter.delete("/org-structure/unassigned", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    // Teams with no section
    const unassignedTeams = await query<{ id: string; name: string }>(
      `SELECT id, name FROM teams WHERE section_id IS NULL`
    );
    let teamsDeleted = 0;
    const teamSkipped: string[] = [];
    for (const t of unassignedTeams) {
      try { await deleteTeam(t.id); teamsDeleted++; } catch { teamSkipped.push(t.name); }
    }

    // Sections with no department_id and no departments pointing to them
    const unassignedSections = await query<{ id: string; name: string }>(
      `SELECT id, name FROM sections WHERE department_id IS NULL`
    );
    let sectionsDeleted = 0;
    const sectionSkipped: string[] = [];
    for (const s of unassignedSections) {
      try { await deleteSectionGroup(s.id); sectionsDeleted++; } catch { sectionSkipped.push(s.name); }
    }

    // Departments with no division_id
    const unassignedDepts = await query<{ id: string; name: string }>(
      `SELECT id, name FROM departments WHERE division_id IS NULL`
    );
    let deptsDeleted = 0;
    const deptSkipped: string[] = [];
    for (const d of unassignedDepts) {
      try { await deleteDepartmentGroup(d.name); deptsDeleted++; } catch { deptSkipped.push(d.name); }
    }

    return res.json({
      deleted: { departments: deptsDeleted, sections: sectionsDeleted, teams: teamsDeleted },
      skipped: { departments: deptSkipped, sections: sectionSkipped, teams: teamSkipped },
    });
  } catch (err) {
    return next(err);
  }
});

// GET /auth/ceo — fetch CEO user(s)
authRouter.get("/ceo", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT id, full_name, email, employee_no, title, department, employment_type, role, profile_completed, is_active
         FROM users
        WHERE role::text = 'CEO'
        ORDER BY is_active DESC, full_name NULLS LAST`
    );
    return res.json(rows);
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
    await ensureUserOrgColumns();

    // If team_id is provided but section_id is missing, resolve section from team
    let sectionId = parsed.data.section_id ?? null;
    const teamId = parsed.data.team_id ?? null;
    if (teamId && !sectionId) {
      const teamRows = await query<{ section_id: string | null }>(`SELECT section_id FROM teams WHERE id=$1`, [teamId]);
      sectionId = teamRows[0]?.section_id ?? null;
    }

    const rows = await query<{
      id: string;
      role: string;
      full_name: string | null;
      employee_no: string | null;
      department: string | null;
      division_id: string | null;
      section_id: string | null;
      team_id: string | null;
      employment_type: string | null;
      profile_completed: boolean | null;
    }>(
      `UPDATE users
          SET full_name=$2,
              department=$3,
              employment_type=$4,
              employee_no=$5,
              division_id=$6,
              section_id=$7,
              team_id=$8,
              profile_completed=true,
              updated_at=now()
        WHERE id=$1
        RETURNING id, role, full_name, employee_no, department, division_id, section_id, team_id, employment_type, profile_completed`,
      [req.user!.userId, parsed.data.full_name, department, parsed.data.employment_type, employeeNo,
       parsed.data.division_id ?? null, sectionId, teamId]
    );

    const saved = rows[0];
    // Fire-and-forget: notify user of completion + notify HR
    void notifyProfileCompleted({
      userId: saved.id,
      fullName: saved.full_name,
      email: (await query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [saved.id]))[0]?.email ?? "",
      department: saved.department,
      employmentType: saved.employment_type ?? "PERMANENT",
      employeeNo: saved.employee_no
    });

    return res.json(toAuthResponse(saved, req.user?.username || req.user?.fullName || "user"));
  } catch (err) {
    return next(err);
  }
});

// Middleware: allow ADMIN always, otherwise check the user_management feature permission
async function requireUserManagementAccess(req: AuthedRequest, res: any, next: any) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role === "ADMIN") return next();
  try {
    const rows = await query<{ allowed_roles: string[] }>(
      `SELECT allowed_roles FROM admin_feature_permissions WHERE feature_key = 'user_management' LIMIT 1`,
      []
    );
    const allowed: string[] = rows[0]?.allowed_roles ?? ["ADMIN", "MANAGER", "EXCO"];
    if (allowed.includes(req.user.role)) return next();
    const groups = await getUserGroups(req.user.userId);
    if (allowed.some((g) => groups.includes(g))) return next();
    return res.status(403).json({ error: "Forbidden" });
  } catch {
    return res.status(403).json({ error: "Forbidden" });
  }
}

authRouter.get("/users", requireAuth, requireUserManagementAccess, async (req: AuthedRequest, res, next) => {
  try {
    await ensurePermissionGroupTables();
    await ensureUserOrgColumns();
    const divisionFilter = typeof req.query.division_id === "string" ? req.query.division_id : null;
    const rows = await query(
      `SELECT u.id, u.full_name, u.email, u.employee_no, u.title, u.department,
              u.division_id, dv.name AS division_name,
              u.section_id, s.name AS section_name,
              u.team_id, t.name AS team_name,
              u.manager_type_id, mt.name AS manager_type_name, mt.role AS manager_type_role,
              u.employment_type, u.role, u.profile_completed, u.is_active, u.created_at, u.updated_at,
              COALESCE(
                (SELECT array_agg(upg.group_name ORDER BY upg.group_name) FROM user_permission_groups upg WHERE upg.user_id = u.id),
                '{}'
              ) AS groups
         FROM users u
         LEFT JOIN divisions dv ON dv.id = u.division_id
         LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN sections s ON s.id = COALESCE(u.section_id, t.section_id)
         LEFT JOIN manager_types mt ON mt.id = u.manager_type_id
        WHERE ($1::uuid IS NULL OR u.division_id = $1::uuid)
        ORDER BY u.full_name NULLS LAST, u.email`,
      [divisionFilter]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

authRouter.get("/request-directory", async (req: AuthedRequest, res, next) => {
  try {
    // scope=company returns everyone, company-wide — used by approval-chain
    // pickers (e.g. Change Request, Attendance Register) where the signer
    // can come from any division. Default (no scope) stays department-only,
    // used by "submit on behalf of my team" flows (Attendance/Overtime).
    if (req.query.scope === "company") {
      const rows = await query(
        `SELECT id, full_name, email, employee_no, title, department, employment_type, role, profile_completed
           FROM users
          WHERE is_active = true
          ORDER BY full_name NULLS LAST, email`
      );
      return res.json(rows);
    }

    const department = String(req.user!.department || "").trim();
    if (!department) return res.json([]);
    const rows = await query(
      `SELECT id, full_name, email, employee_no, title, department, employment_type, role, profile_completed
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
    if (!parsed.success) throw badRequest("Invalid division payload", parsed.error.flatten());
    const department = await resolveDepartmentGroup(parsed.data.department);
    await ensureUserOrgColumns();

    // If team_id is provided but section_id is missing, resolve section from team
    let deptSectionId = parsed.data.section_id ?? null;
    const deptTeamId = parsed.data.team_id ?? null;
    if (deptTeamId && !deptSectionId) {
      const teamRows = await query<{ section_id: string | null }>(`SELECT section_id FROM teams WHERE id=$1`, [deptTeamId]);
      deptSectionId = teamRows[0]?.section_id ?? null;
    }

    const rows = await query(
      `UPDATE users
          SET department=$2,
              division_id=$3,
              section_id=$4,
              team_id=$5,
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
        RETURNING id, full_name, email, employee_no, title, department, division_id, section_id, team_id, employment_type, role, profile_completed, is_active, created_at, updated_at`,
      [req.params.id, department, parsed.data.division_id ?? null, deptSectionId, deptTeamId]
    );
    if (!rows[0]) throw notFound();
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

// Whether the current user is assigned to at least one active workflow step
// with "Allow Delegation" enabled — gates self-service delegation visibility.
authRouter.get("/delegations/eligibility", requireRole(["ADMIN", "MANAGER", "HOD", "EXCO", "CEO"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<{ eligible: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM workflow_steps ws
           JOIN workflows w ON w.id = ws.workflow_id
          WHERE ws.assigned_user_id = $1
            AND ws.allow_delegation = true
            AND ws.is_active = true
            AND w.status = 'ACTIVE'
       ) AS eligible`,
      [req.user!.userId]
    );
    return res.json({ eligible: rows[0]?.eligible ?? false });
  } catch (err) {
    return next(err);
  }
});

authRouter.get("/delegations", requireRole(["ADMIN", "MANAGER", "HOD", "EXCO", "CEO"]), async (req: AuthedRequest, res, next) => {
  try {
    const isAdmin = req.user!.role === "ADMIN";
    const condition = isAdmin ? `` : `WHERE md.manager_id = $1`;
    const params = isAdmin ? [] : [req.user!.userId];
    const rows = await query<any>(
      `SELECT md.id,
              md.manager_id,
              manager.full_name AS manager_name,
              manager.department AS manager_department,
              md.delegate_id,
              delegate.full_name AS delegate_name,
              md.department,
              md.from_date,
              md.to_date,
              md.active,
              md.reference,
              md.reason,
              md.comments,
              md.created_by,
              creator.full_name AS created_by_name,
              md.created_source,
              md.ended_by,
              ender.full_name AS ended_by_name,
              md.ended_at,
              md.end_reason,
              md.created_at,
              md.updated_at,
              COALESCE(
                (SELECT array_agg(drt.request_type_code ORDER BY drt.request_type_code) FROM delegation_request_types drt WHERE drt.delegation_id = md.id),
                '{}'
              ) AS request_types
         FROM manager_delegations md
         JOIN users manager ON manager.id = md.manager_id
         JOIN users delegate ON delegate.id = md.delegate_id
         LEFT JOIN users creator ON creator.id = md.created_by
         LEFT JOIN users ender ON ender.id = md.ended_by
         ${condition}
        ORDER BY md.created_at DESC`,
      params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/delegations", requireRole(["ADMIN", "MANAGER", "HOD", "EXCO", "CEO"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateDelegationSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid delegation payload", parsed.error.flatten());

    const managerId = req.user!.role !== "ADMIN" ? req.user!.userId : parsed.data.manager_id;
    if (!managerId) throw badRequest("Manager is required for delegation");

    const users = await query<{ id: string; role: string; department: string | null; section_id: string | null; full_name: string | null; email: string }>(
      `SELECT id, role, department, section_id, full_name, email FROM users WHERE id IN ($1, $2)`,
      [managerId, parsed.data.delegate_id]
    );
    const manager = users.find((user) => user.id === managerId);
    const delegate = users.find((user) => user.id === parsed.data.delegate_id);
    if (!manager || !["MANAGER", "HOD", "EXCO", "CEO"].includes(manager.role)) {
      throw badRequest("User must be a Manager, Exco member, or CEO to delegate");
    }
    if (!delegate) throw badRequest("Delegate user not found");
    if (delegate.id === manager.id) throw badRequest("Delegate cannot be the same user");

    // CEO is an org-wide role with no single department, so any active delegate
    // is acceptable; everyone else's delegate must share the manager's
    // department or section.
    let managerDept = String(manager.department || "").trim();
    if (manager.role !== "CEO") {
      const delegateDept = String(delegate.department || "").trim();
      const sameDept = Boolean(managerDept) && managerDept === delegateDept;
      const sameSection = Boolean(manager.section_id) && manager.section_id === delegate.section_id;
      if (!sameDept && !sameSection) {
        throw badRequest("Delegate must be in the same department or section as the manager");
      }
    } else {
      managerDept = String(delegate.department || "").trim() || managerDept || "ORG-WIDE";
    }

    const reference = await generateDelegationReference();
    const createdSource = req.user!.role === "ADMIN" && managerId !== req.user!.userId ? "ADMIN" : "MANAGER_SELF_SERVICE";
    const rows = await query(
      `INSERT INTO manager_delegations (id, manager_id, delegate_id, department, from_date, to_date, reference, reason, comments, created_by, created_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, manager_id, delegate_id, department, from_date, to_date, active, reference, reason, comments, created_by, created_source, created_at, updated_at`,
      [randomUUID(), manager.id, delegate.id, managerDept, parsed.data.from_date ?? null, parsed.data.to_date ?? null,
       reference, parsed.data.reason ?? null, parsed.data.comments ?? null, req.user!.userId, createdSource]
    );
    const delegation = rows[0] as any;
    if (parsed.data.request_types?.length) {
      await setDelegationRequestTypes(delegation.id, parsed.data.request_types);
    }
    void writeDelegationAudit({
      actorId: req.user!.userId,
      delegationId: delegation.id,
      action: "CREATED",
      after: { ...delegation, request_types: parsed.data.request_types ?? [] }
    });
    void notifyDelegationAssigned({
      delegationId: delegation.id,
      managerName:  manager.full_name,
      managerEmail: manager.email,
      delegateName: delegate.full_name,
      delegateEmail: delegate.email,
      department:   managerDept,
      fromDate:     delegation.from_date ?? null,
      toDate:       delegation.to_date ?? null
    });
    return res.status(201).json({ ...delegation, request_types: parsed.data.request_types ?? [] });
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/delegations/:id/end", requireRole(["ADMIN", "MANAGER", "HOD", "EXCO", "CEO"]), async (req: AuthedRequest, res, next) => {
  try {
    const endParsed = EndDelegationSchema.safeParse(req.body ?? {});
    const delegation = (await query<{ id: string; manager_id: string; delegate_id: string; department: string }>(
      `SELECT id, manager_id, delegate_id, department FROM manager_delegations WHERE id=$1`,
      [req.params.id]
    ))[0];
    if (!delegation) throw notFound();
    if (req.user!.role !== "ADMIN" && delegation.manager_id !== req.user!.userId) {
      throw forbidden("You can only end your own delegations");
    }

    const [rows, users] = await Promise.all([
      query(
        `UPDATE manager_delegations
            SET active=false,
                updated_at=now(),
                ended_by=$2,
                ended_at=now(),
                end_reason=$3
          WHERE id=$1
          RETURNING id, manager_id, delegate_id, department, from_date, to_date, active, reference, reason, comments, ended_by, ended_at, end_reason, created_at, updated_at`,
        [req.params.id, req.user!.userId, endParsed.success ? endParsed.data.reason ?? null : null]
      ),
      query<{ id: string; full_name: string | null; email: string }>(
        `SELECT id, full_name, email FROM users WHERE id IN ($1, $2)`,
        [delegation.manager_id, delegation.delegate_id]
      )
    ]);

    void writeDelegationAudit({
      actorId: req.user!.userId,
      delegationId: delegation.id,
      action: "ENDED",
      after: rows[0]
    });

    const mgr = users.find((u) => u.id === delegation.manager_id);
    const dlg = users.find((u) => u.id === delegation.delegate_id);
    if (mgr && dlg) {
      void notifyDelegationEnded({
        delegationId: delegation.id,
        managerName:  mgr.full_name,
        managerEmail: mgr.email,
        delegateName: dlg.full_name,
        delegateEmail: dlg.email,
        department:   delegation.department,
        endedBy:      req.user!.fullName ?? null
      });
    }

    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

authRouter.get("/delegations/:id/audit", requireRole(["ADMIN", "MANAGER", "HOD", "EXCO", "CEO"]), async (req: AuthedRequest, res, next) => {
  try {
    const delegation = (await query<{ manager_id: string }>(`SELECT manager_id FROM manager_delegations WHERE id=$1`, [req.params.id]))[0];
    if (!delegation) throw notFound();
    if (req.user!.role !== "ADMIN" && delegation.manager_id !== req.user!.userId) throw forbidden();

    const rows = await query<any>(
      `SELECT al.id, al.action, al.before_json, al.after_json, al.created_at, u.full_name AS actor_name, u.role AS actor_role
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.actor_id
        WHERE al.entity_type='manager_delegations' AND al.entity_id=$1
        ORDER BY al.created_at ASC`,
      [req.params.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/users/:id/role", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
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

    const rows = await query<{
      id: string;
      full_name: string | null;
      email: string;
      department: string | null;
      role: string;
    }>(
      `UPDATE users
          SET role=$2,
              is_active=COALESCE($3, is_active),
              updated_at=now()
        WHERE id=$1
        RETURNING id, full_name, email, employee_no, title, department, employment_type, role, profile_completed, is_active, created_at, updated_at`,
      [req.params.id, parsed.data.role, parsed.data.is_active ?? null]
    );
    if (!rows[0]) throw notFound();

    if (parsed.data.role !== existing[0].role) {
      void notifyUserRoleChanged({
        userId: rows[0].id,
        email: rows[0].email,
        fullName: rows[0].full_name,
        role: rows[0].role,
        sectionOrDepartment: rows[0].department
      });
    }

    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

// Vacant positions — a Manager/HOD/EXCO/CEO seat earmarked before anyone is
// assigned. Listed separately from `users` and merged client-side; filling
// one promotes an existing user or creates a new account via the same paths
// as the routes above, then stamps the vacancy filled.
authRouter.get("/position-vacancies", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const role = String(req.query.role || "").trim();
    const rows = await query(
      `SELECT pv.*, d.name AS division_name, s.name AS section_name, t.name AS team_name
         FROM position_vacancies pv
         LEFT JOIN divisions d ON d.id = pv.division_id
         LEFT JOIN sections s ON s.id = pv.section_id
         LEFT JOIN teams t ON t.id = pv.team_id
        WHERE pv.filled_by_user_id IS NULL
          AND ($1 = '' OR pv.role = $1)
        ORDER BY pv.created_at DESC`,
      [role]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/position-vacancies", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreatePositionVacancySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid position vacancy payload", parsed.error.flatten());
    const rows = await query(
      `INSERT INTO position_vacancies (role, title, department, division_id, section_id, team_id, notes, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        parsed.data.role,
        parsed.data.title || null,
        parsed.data.department || null,
        parsed.data.division_id || null,
        parsed.data.section_id || null,
        parsed.data.team_id || null,
        parsed.data.notes || null,
        req.user!.userId
      ]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

authRouter.delete("/position-vacancies/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `DELETE FROM position_vacancies WHERE id=$1 AND filled_by_user_id IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/position-vacancies/:id/fill", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
  try {
    const vacancyRows = await query<{
      id: string; role: string; title: string | null; department: string | null;
      division_id: string | null; section_id: string | null; team_id: string | null;
    }>(`SELECT id, role, title, department, division_id, section_id, team_id FROM position_vacancies WHERE id=$1 AND filled_by_user_id IS NULL`, [req.params.id]);
    const vacancy = vacancyRows[0];
    if (!vacancy) throw notFound();

    const parsed = FillPositionVacancySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid fill payload", parsed.error.flatten());

    if (vacancy.role === "CEO" && req.user!.role !== "ADMIN") {
      throw forbidden("Only system administrators can fill a CEO position");
    }

    let userId: string;
    let userFullName: string | null;
    let userEmail: string;

    if (parsed.data.existing_user_id) {
      const existing = await query<{ id: string; department: string | null; role: string | null }>(
        `SELECT id, department, role FROM users WHERE id=$1`,
        [parsed.data.existing_user_id]
      );
      if (!existing[0]) throw badRequest("User not found");
      assertRoleAssignmentAllowed(req, existing[0], vacancy.role);

      const updated = await query<{ id: string; full_name: string | null; email: string; department: string | null; role: string }>(
        `UPDATE users
            SET role=$2,
                department=COALESCE($3, department),
                division_id=COALESCE($4, division_id),
                section_id=COALESCE($5, section_id),
                team_id=COALESCE($6, team_id),
                updated_at=now()
          WHERE id=$1
        RETURNING id, full_name, email, department, role`,
        [parsed.data.existing_user_id, vacancy.role, vacancy.department, vacancy.division_id, vacancy.section_id, vacancy.team_id]
      );
      const u = updated[0];
      userId = u.id; userFullName = u.full_name; userEmail = u.email;
      if (vacancy.role !== existing[0].role) {
        void notifyUserRoleChanged({ userId: u.id, email: u.email, fullName: u.full_name, role: u.role, sectionOrDepartment: u.department });
      }
    } else {
      if (!parsed.data.email) throw badRequest("email is required to create a new account");
      const email = normalizeEmailForStorage(parsed.data.email);
      const existingEmail = await query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [email]);
      if (existingEmail[0]) throw badRequest("A user with that email already exists");

      const pwd = randomUUID();
      const hash = await hashPassword(pwd);
      const employeeNo = parsed.data.employee_no?.trim() || null;
      const title = parsed.data.title || vacancy.title || null;
      const employmentType = parsed.data.employment_type ?? "PERMANENT";
      const profileCompleted = Boolean(
        parsed.data.full_name &&
        vacancy.department &&
        (vacancy.role === "EXCO" || employmentType !== "PERMANENT" || employeeNo)
      );

      const created = await query<{ id: string; full_name: string | null; email: string; department: string | null; role: string }>(
        `INSERT INTO users (id, employee_no, full_name, title, department, division_id, section_id, team_id, email, role, password_hash, is_active, employment_type, profile_completed, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,now(),now())
       RETURNING id, full_name, email, department, role`,
        [randomUUID(), employeeNo, parsed.data.full_name ?? null, title, vacancy.department, vacancy.division_id, vacancy.section_id, vacancy.team_id, email, vacancy.role, hash, employmentType, profileCompleted]
      );
      const u = created[0];
      userId = u.id; userFullName = u.full_name; userEmail = u.email;
      await setUserGroups(userId, [vacancy.role]);
      await notifyUserOnboarded({ userId, email, fullName: u.full_name, role: vacancy.role, sectionOrDepartment: u.department, temporaryPassword: pwd });
    }

    await query(`UPDATE position_vacancies SET filled_by_user_id=$2, filled_at=now() WHERE id=$1`, [vacancy.id, userId]);

    void notifyPositionAssigned({
      assigneeName: userFullName,
      assigneeEmail: userEmail,
      positionLabel: vacancy.title || vacancy.role,
      groupLabel: vacancy.department || "the organisation",
      groupType: "Division"
    });

    return res.json({ ok: true, user_id: userId });
  } catch (err) {
    return next(err);
  }
});

// Admin: create a user (for onboarding EXCO members or other admin-created accounts)
authRouter.post("/users", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateUserSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid user payload", parsed.error.flatten());

    const email = normalizeEmailForStorage(parsed.data.email);
    const existing = await query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [email]);
    if (existing[0]) throw badRequest("A user with that email already exists");

    const pwd = randomUUID();
    const hash = await hashPassword(pwd);
    const role = parsed.data.role ?? "EXCO";
    const employeeNo = parsed.data.employee_no?.trim() || null;
    const sectionOrDepartment = parsed.data.section ?? parsed.data.department ?? "";
    const department = sectionOrDepartment
      ? await resolveDepartmentGroup(sectionOrDepartment)
      : null;
    const title = parsed.data.title || null;
    const employmentType = parsed.data.employment_type ?? "PERMANENT";
    const isActive = parsed.data.is_active ?? true;
    const managerTypeId = parsed.data.manager_type_id ?? null;
    const profileCompleted = Boolean(
      parsed.data.full_name &&
      department &&
      (role === "EXCO" || employmentType !== "PERMANENT" || employeeNo)
    );

    await ensureUserOrgColumns();
    const rows = await query<{
      id: string;
      full_name: string | null;
      email: string;
      employee_no: string | null;
      title: string | null;
      department: string | null;
      employment_type: string | null;
      role: string;
      profile_completed: boolean;
      is_active: boolean;
      manager_type_id: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `INSERT INTO users (id, employee_no, full_name, title, department, email, role, password_hash, is_active, employment_type, profile_completed, manager_type_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
       RETURNING id, full_name, email, employee_no, title, department, employment_type, role, profile_completed, is_active, manager_type_id, created_at, updated_at`,
      [randomUUID(), employeeNo, parsed.data.full_name ?? null, title, department, email, role, hash, isActive, employmentType, profileCompleted, managerTypeId]
    );

    const created = rows[0];
    await setUserGroups(created.id, parsed.data.groups?.length ? parsed.data.groups : [role]);
    await notifyUserOnboarded({
      userId: created.id,
      email: created.email,
      fullName: created.full_name,
      role: created.role,
      sectionOrDepartment: created.department,
      temporaryPassword: pwd
    });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

// Admin: update user attributes
authRouter.put("/users/:id", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateUserSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid user payload", parsed.error.flatten());

    const existingUser = await query<{ is_active: boolean }>(
      `SELECT is_active FROM users WHERE id=$1`, [req.params.id]
    );
    if (!existingUser[0]) throw notFound();
    const wasReactivated = existingUser[0].is_active === false && parsed.data.is_active === true;

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (parsed.data.full_name !== undefined) { fields.push(`full_name=$${idx++}`); values.push(parsed.data.full_name); }
    if (parsed.data.email !== undefined) { fields.push(`email=$${idx++}`); values.push(normalizeEmailForStorage(parsed.data.email)); }
    // employee_no is UNIQUE - an empty string (rather than null) collides
    // with every other blank-employee_no user on the second such save, so
    // normalize blank to null the same way user creation already does.
    if (parsed.data.employee_no !== undefined) { fields.push(`employee_no=$${idx++}`); values.push(parsed.data.employee_no?.trim() || null); }
    if (parsed.data.title !== undefined) { fields.push(`title=$${idx++}`); values.push(parsed.data.title); }
    if (parsed.data.department !== undefined) {
      const organization = parsed.data.department.trim();
      const existing = await query<{ role: string }>(`SELECT role::text AS role FROM users WHERE id=$1`, [req.params.id]);
      if (!existing[0]) throw notFound();
      const department = organization
        ? await resolveDepartmentGroup(organization)
        : null;
      fields.push(`department=$${idx++}`);
      values.push(department);
    }
    if (parsed.data.employment_type !== undefined) { fields.push(`employment_type=$${idx++}`); values.push(parsed.data.employment_type); }
    if (parsed.data.is_active !== undefined) { fields.push(`is_active=$${idx++}`); values.push(parsed.data.is_active); }
    if (Object.prototype.hasOwnProperty.call(parsed.data, "division_id")) { fields.push(`division_id=$${idx++}`); values.push(parsed.data.division_id ?? null); }
    if (Object.prototype.hasOwnProperty.call(parsed.data, "section_id")) { fields.push(`section_id=$${idx++}`); values.push(parsed.data.section_id ?? null); }
    if (Object.prototype.hasOwnProperty.call(parsed.data, "team_id")) { fields.push(`team_id=$${idx++}`); values.push(parsed.data.team_id ?? null); }
    if (Object.prototype.hasOwnProperty.call(parsed.data, "manager_type_id")) { fields.push(`manager_type_id=$${idx++}`); values.push(parsed.data.manager_type_id ?? null); }

    if (parsed.data.groups !== undefined) {
      await setUserGroups(req.params.id, parsed.data.groups);
    }

    if (fields.length === 0) {
      const rows = await query(`SELECT id, full_name, email, employee_no, title, department, division_id, section_id, team_id, manager_type_id, employment_type, role, profile_completed, is_active, created_at, updated_at FROM users WHERE id=$1`, [req.params.id]);
      if (!rows[0]) throw notFound();
      return res.json({ ...rows[0], groups: await getUserGroups(req.params.id) });
    }

    const sql = `UPDATE users SET ${fields.join(', ')}, updated_at=now() WHERE id=$${idx} RETURNING id, full_name, email, employee_no, title, department, division_id, section_id, team_id, manager_type_id, employment_type, role, profile_completed, is_active, created_at, updated_at`;
    values.push(req.params.id);
    const rows = await query<{
      id: string;
      full_name: string | null;
      email: string;
      role: string;
      department: string | null;
    }>(sql, values);
    if (!rows[0]) throw notFound();

    if (wasReactivated) {
      await notifyUserReactivated({
        userId: rows[0].id,
        email: rows[0].email,
        fullName: rows[0].full_name,
        role: rows[0].role,
        sectionOrDepartment: rows[0].department
      });
    }

    return res.json({ ...rows[0], groups: await getUserGroups(req.params.id) });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Delete user (soft-delete)
// ---------------------------------------------------------------------------

authRouter.delete("/users/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    if (req.params.id === req.user!.userId) throw badRequest("You cannot delete your own account");
    const rows = await query<{ role: string }>(
      `SELECT role::text AS role FROM users WHERE id=$1`, [req.params.id]
    );
    if (!rows[0]) throw notFound("User not found");
    if (rows[0].role === "ADMIN") throw forbidden("Cannot deactivate admin accounts");
    await query(`UPDATE users SET is_active=false, updated_at=now() WHERE id=$1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Permanently delete a user (hard delete). Blocked when the user has real
// transactional/financial/audit records — those would be destroyed, so the
// admin is told to deactivate instead. Otherwise operational artifacts are
// removed, every disassociable reference is nulled, and the row is deleted.
authRouter.delete("/users/:id/permanent", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const id = req.params.id;
    if (id === req.user!.userId) throw badRequest("You cannot delete your own account");
    const existing = await query<{ role: string }>(`SELECT role::text AS role FROM users WHERE id=$1`, [id]);
    if (!existing[0]) throw notFound("User not found");
    if (existing[0].role === "ADMIN") throw forbidden("Cannot permanently delete admin accounts");

    // Records whose deletion would destroy financial / approval / audit
    // history — refuse if any exist.
    const blockers: Array<[string, string]> = [
      ["advance_requests", "requester_id = $1 OR created_by_id = $1"],
      ["clearance_claims", "claimant_id = $1"],
      ["accommodation_requests", "requester_id = $1 OR created_by_id = $1"],
      ["accommodation_quotations", "quotation_uploaded_by_id = $1"],
      ["approvals", "approver_id = $1"],
      ["attendance_records", "employee_id = $1 OR compiled_by_id = $1"],
      ["custom_request_submissions", "requester_id = $1"],
      ["overtime_requests", "employee_id = $1 OR created_by_id = $1"],
      ["overtime_claims", "employee_id = $1 OR created_by_id = $1"]
    ];
    const found: string[] = [];
    for (const [table, where] of blockers) {
      const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, [id]);
      if (Number(rows[0].n) > 0) found.push(`${table.replace(/_/g, " ")} (${rows[0].n})`);
    }
    if (found.length) {
      throw badRequest(`This user has records that can't be permanently deleted: ${found.join(", ")}. Deactivate the user instead to preserve history.`);
    }

    // Nullable references that don't auto-clear on delete (NO ACTION) — set
    // them to NULL so the user row can be removed without losing the parent rows.
    const nullables: Array<[string, string[]]> = [
      ["accommodation_hotels", ["created_by_id"]],
      ["accommodation_requests", ["quotation_uploaded_by_id"]],
      ["advance_requests", ["created_by_id"]],
      ["audit_log", ["actor_id"]],
      ["clearance_claims", ["assignee_user_id"]],
      ["custom_request_attachments", ["uploaded_by_id"]],
      ["custom_request_types", ["created_by_id"]],
      ["departments", ["exco_user_id", "hod_user_id", "manager_user_id"]],
      ["overtime_claims", ["manager_authorised_by_id"]],
      ["overtime_requests", ["cto_approved_by_id", "hod_approved_by_id", "rejected_by_id", "supervisor_approved_by_id"]],
      ["position_vacancies", ["created_by_id", "filled_by_user_id"]],
      ["reporting_lines", ["created_by_id", "manager_id"]],
      ["request_type_permissions", ["created_by_id"]],
      ["sections", ["exco_user_id", "hod_user_id", "manager_user_id"]],
      ["teams", ["leader_user_id"]],
      ["travel_locations", ["created_by_id"]],
      ["travel_types", ["created_by_id"]],
      ["workflow_rules", ["additional_assigned_user_id"]],
      ["workflow_steps", ["assigned_user_id"]],
      ["workflows", ["created_by_id"]]
    ];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Operational artifacts (no history value) — safe to drop outright.
      await client.query(`DELETE FROM email_action_tokens WHERE user_id=$1`, [id]);
      await client.query(`DELETE FROM manager_delegations WHERE manager_id=$1 OR delegate_id=$1`, [id]);
      for (const [table, cols] of nullables) {
        const sets = cols.map((col) => `${col} = NULL`).join(", ");
        const where = cols.map((col) => `${col} = $1`).join(" OR ");
        await client.query(`UPDATE ${table} SET ${sets} WHERE ${where}`, [id]);
      }
      // CASCADE FKs (reporting_lines.employee_id, request_type_permissions.user_id,
      // user_permission_groups.user_id) are removed automatically.
      await client.query(`DELETE FROM users WHERE id=$1`, [id]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Manager Types
// ---------------------------------------------------------------------------

const CreateManagerTypeSchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
  role: z.enum(["MANAGER", "HOD"]).default("MANAGER"),
  description: z.string().trim().optional().nullable()
});

const UpdateManagerTypeSchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
  role: z.enum(["MANAGER", "HOD"]),
  description: z.string().trim().optional().nullable(),
  active: z.boolean().optional()
});

authRouter.get("/manager-types", async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await listManagerTypes());
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/manager-types", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateManagerTypeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid manager type payload", parsed.error.flatten());
    return res.status(201).json(await createManagerType(parsed.data.name, parsed.data.role, parsed.data.description));
  } catch (err) {
    return next(err);
  }
});

authRouter.put("/manager-types/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateManagerTypeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid manager type payload", parsed.error.flatten());
    return res.json(await updateManagerType(req.params.id, parsed.data.name, parsed.data.role, parsed.data.description, parsed.data.active));
  } catch (err) {
    return next(err);
  }
});

authRouter.delete("/manager-types/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    await deleteManagerType(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------

authRouter.post("/departments/:department/role", requireRole(["ADMIN", "MANAGER", "EXCO"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateUserRoleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid division role payload", parsed.error.flatten());

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

// ─── Employment Types ─────────────────────────────────────────────────────────

const EmpTypeSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  active: z.boolean().optional(),
  sort_order: z.coerce.number().int().optional(),
});

authRouter.get("/employment-types", async (_req, res, next) => {
  try {
    const rows = await query<{ id: string; code: string; name: string; active: boolean; sort_order: number }>(
      `SELECT id, code, name, active, sort_order FROM employment_types ORDER BY sort_order, name`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/employment-types", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = EmpTypeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid employment type", parsed.error.flatten());
    const code = parsed.data.code.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
    const row = (await query<{ id: string }>(
      `INSERT INTO employment_types (code, name, active, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE
         SET name=$2, active=$3, sort_order=$4, updated_at=now()
       RETURNING id`,
      [code, parsed.data.name, parsed.data.active ?? true, parsed.data.sort_order ?? 99]
    ))[0];
    return res.status(201).json({ id: row.id, code });
  } catch (err) {
    return next(err);
  }
});

authRouter.put("/employment-types/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = EmpTypeSchema.partial().safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid employment type", parsed.error.flatten());
    const updates: string[] = [];
    const params: unknown[] = [];
    if (parsed.data.name       !== undefined) { params.push(parsed.data.name);       updates.push(`name=$${params.length}`); }
    if (parsed.data.active     !== undefined) { params.push(parsed.data.active);     updates.push(`active=$${params.length}`); }
    if (parsed.data.sort_order !== undefined) { params.push(parsed.data.sort_order); updates.push(`sort_order=$${params.length}`); }
    if (updates.length === 0) return res.json({ ok: true });
    params.push(req.params.id);
    const rows = await query(`UPDATE employment_types SET ${updates.join(",")},updated_at=now() WHERE id=$${params.length} RETURNING id`, params);
    if (!rows[0]) throw badRequest("Employment type not found");
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

authRouter.delete("/employment-types/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(`DELETE FROM employment_types WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows[0]) throw badRequest("Employment type not found");
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const FEATURE_KEYS = [
  "user_management", "roles_permissions", "travel_setup", "org_structure",
  "team_roster", "ceo_management", "employees",
  "exco_members", "managers", "leadership_assignments", "workflow_builder",
  "request_types", "reporting_lines", "advance_pdf", "report_reconciliation", "pdf_designer",
  "claims_sla_report", "advance_recovery_settings", "manager_delegations", "deductions",
  "overtime_request", "overtime_claim"
] as const;

const FEATURE_DEFAULTS: Record<string, string[]> = {
  user_management:       ["ADMIN", "MANAGER", "EXCO"],
  roles_permissions:     ["ADMIN", "MANAGER", "EXCO"],
  travel_setup:          ["ADMIN", "MANAGER"],
  org_structure:         ["ADMIN"],
  team_roster:           ["ADMIN"],
  ceo_management:        ["ADMIN"],
  employees:             ["ADMIN"],
  exco_members:          ["ADMIN", "MANAGER"],
  managers:              ["ADMIN", "MANAGER", "EXCO"],
  leadership_assignments:["ADMIN", "MANAGER", "EXCO"],
  workflow_builder:      ["ADMIN", "MANAGER", "EXCO"],
  request_types:         ["ADMIN"],
  reporting_lines:       ["ADMIN", "MANAGER", "EXCO"],
  advance_pdf:           ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"],
  report_reconciliation: ["ADMIN", "FINANCE"],
  pdf_designer:          ["ADMIN"],
  claims_sla_report:     ["ADMIN", "FINANCE", "HR_MANAGER"],
  advance_recovery_settings: ["ADMIN", "FINANCE"],
  manager_delegations:   ["ADMIN"],
  deductions:            ["ADMIN"],
  overtime_request:      ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"],
  overtime_claim:        ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"]
};

authRouter.get("/admin-feature-permissions", requireAuth, async (_req: AuthedRequest, res, next) => {
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS admin_feature_permissions (
         feature_key text PRIMARY KEY,
         allowed_roles text[] NOT NULL DEFAULT '{}'::text[],
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      []
    );
    const rows = await query<{ feature_key: string; allowed_roles: string[] }>(
      `SELECT feature_key, allowed_roles FROM admin_feature_permissions ORDER BY feature_key`,
      []
    );
    const features: Record<string, string[]> = { ...FEATURE_DEFAULTS };
    for (const row of rows) {
      features[row.feature_key] = row.allowed_roles;
    }
    return res.json({ features });
  } catch (err) {
    return next(err);
  }
});

authRouter.put("/admin-feature-permissions", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const body = req.body as { features?: Record<string, string[]> };
    if (!body.features || typeof body.features !== "object") throw badRequest("features object is required");

    await query(
      `CREATE TABLE IF NOT EXISTS admin_feature_permissions (
         feature_key text PRIMARY KEY,
         allowed_roles text[] NOT NULL DEFAULT '{}'::text[],
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      []
    );

    for (const key of FEATURE_KEYS) {
      const rawRoles = body.features[key];
      if (!Array.isArray(rawRoles)) continue;
      // ADMIN always has access — ensure it's always included
      const roles = Array.from(new Set([...rawRoles, "ADMIN"])).filter((r) => typeof r === "string");
      await query(
        `INSERT INTO admin_feature_permissions (feature_key, allowed_roles, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (feature_key) DO UPDATE
           SET allowed_roles = $2, updated_at = now()`,
        [key, roles]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Permission Groups — admin-defined columns for the Feature Access matrix
// ---------------------------------------------------------------------------

const CreatePermissionGroupSchema = z.object({
  name: z.string().trim().min(1, "Group name is required").max(64)
});

authRouter.get("/permission-groups", requireAuth, async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await listPermissionGroups());
  } catch (err) {
    return next(err);
  }
});

authRouter.post("/permission-groups", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreatePermissionGroupSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid group payload", parsed.error.flatten());
    await createPermissionGroup(parsed.data.name.trim().toUpperCase());
    return res.status(201).json(await listPermissionGroups());
  } catch (err) {
    return next(err);
  }
});

authRouter.delete("/permission-groups/:name", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    if (req.params.name.toUpperCase() === "ADMIN") throw badRequest("The Admin group cannot be removed");
    await deletePermissionGroup(req.params.name);
    return res.json(await listPermissionGroups());
  } catch (err) {
    return next(err);
  }
});

const SetGroupVisibilitySchema = z.object({ hidden: z.boolean() });

authRouter.put("/permission-groups/:name/visibility", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    if (req.params.name.toUpperCase() === "ADMIN") throw badRequest("The Admin group is always visible");
    const parsed = SetGroupVisibilitySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid visibility payload", parsed.error.flatten());
    await setGroupVisibility(req.params.name, parsed.data.hidden);
    return res.json(await listPermissionGroups());
  } catch (err) {
    return next(err);
  }
});

// Individual membership for a custom group - lets an admin grant a feature to
// specific people rather than only whole roles/departments/etc. Org-derived
// groups (roles, Division/Department/Section/Team) reject direct membership
// edits since their membership is computed live from org structure.
authRouter.get("/permission-groups/:name/members", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    return res.json(await listGroupMembers(req.params.name));
  } catch (err) {
    return next(err);
  }
});

const AddGroupMemberSchema = z.object({ user_id: z.string().uuid() });

authRouter.post("/permission-groups/:name/members", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    if (await isOrgStructureGroupName(req.params.name)) {
      throw badRequest("Membership for this group is derived automatically and can't be edited directly");
    }
    const exists = await query(`SELECT 1 FROM permission_groups WHERE name=$1`, [req.params.name]);
    if (!exists[0]) throw notFound("Group not found");
    const parsed = AddGroupMemberSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid member payload", parsed.error.flatten());
    await addGroupMember(req.params.name, parsed.data.user_id);
    return res.status(201).json(await listGroupMembers(req.params.name));
  } catch (err) {
    return next(err);
  }
});

authRouter.delete("/permission-groups/:name/members/:userId", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    if (await isOrgStructureGroupName(req.params.name)) {
      throw badRequest("Membership for this group is derived automatically and can't be edited directly");
    }
    await removeGroupMember(req.params.name, req.params.userId);
    return res.json(await listGroupMembers(req.params.name));
  } catch (err) {
    return next(err);
  }
});

// Idle-session timeout: how long a user can go without activity before the
// frontend warns them, then logs them out. GET is open to any authenticated
// user (everyone's client needs to know the current values to enforce
// them); only ADMIN can change them.
authRouter.get("/session-settings", requireAuth, async (_req: AuthedRequest, res, next) => {
  try {
    const row = (await query<any>(`SELECT idle_timeout_minutes, warning_seconds, updated_at FROM session_settings LIMIT 1`))[0];
    return res.json(row || { idle_timeout_minutes: 30, warning_seconds: 60 });
  } catch (err) {
    return next(err);
  }
});

const SessionSettingsSchema = z.object({
  idle_timeout_minutes: z.coerce.number().int().min(1).max(1440),
  warning_seconds: z.coerce.number().int().min(10).max(600)
});

authRouter.put("/session-settings", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SessionSettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid session settings payload", parsed.error.flatten());
    if (parsed.data.warning_seconds >= parsed.data.idle_timeout_minutes * 60) {
      throw badRequest("Warning period must be shorter than the idle timeout");
    }
    await query(
      `UPDATE session_settings SET idle_timeout_minutes=$1, warning_seconds=$2, updated_by_id=$3, updated_at=now()`,
      [parsed.data.idle_timeout_minutes, parsed.data.warning_seconds, req.user!.userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
