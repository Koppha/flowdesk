import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { forbidden, unauthorized } from "./errors.js";
import { query } from "./db.js";
import { getUserGroups } from "./permissionGroups.js";

export type Role =
  | "EMPLOYEE"
  | "HOD"
  | "MANAGER"
  | "HR_MANAGER"
  | "FINANCE"
  | "ADMIN"
  | "EXCO"
  | "CEO";

export type AuthPayload = {
  userId: string;
  role: Role;
  username?: string;
  fullName?: string;
  employeeNo?: string | null;
  department?: string | null;
  divisionId?: string | null;
  sectionId?: string | null;
  teamId?: string | null;
  employmentType?: string | null;
  profileCompleted?: boolean;
};

export type AuthedRequest = Request & {
  user?: AuthPayload;
  file?: Express.Multer.File;
};

export function signToken(payload: AuthPayload) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "12h" });
}

export function verifyToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as AuthPayload & { iat: number; exp: number };
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized("Missing bearer token"));
  try {
    const token = header.slice("Bearer ".length);
    const payload = verifyToken(token);
    req.user = payload;

    // Invalidate tokens issued before the global sessions_cleared_at timestamp
    try {
      const rows = await query<{ value: string }>(`SELECT value FROM system_state WHERE key='sessions_cleared_at' LIMIT 1`);
      const row = rows[0];
      if (row && row.value) {
        const clearedAt = Date.parse(row.value) / 1000; // seconds
        const iat = (payload as any).iat || 0;
        if (iat <= clearedAt) return next(unauthorized("Session expired"));
      }
    } catch (err) {
      // ignore if system_state table missing
    }

    return next();
  } catch {
    return next(unauthorized("Invalid token"));
  }
}

export function requireRole(roles: Role[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    return next();
  };
}

// Finance approval authority now comes from org structure (Department: Finance)
// rather than a dedicated FINANCE role.
export function isFinanceDept(department?: string | null): boolean {
  return String(department || "").trim().toLowerCase() === "finance";
}

export function requireFinance(req: AuthedRequest, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== "ADMIN" && !isFinanceDept(req.user.department)) return next(forbidden());
  return next();
}

// Generic admin-configurable feature-permission check: ADMIN always passes;
// otherwise checks the admin_feature_permissions table (role or
// permission-group match), falling back to fallbackRoles if no row exists
// yet for this feature. Shared by requireFeatureAccess (route gate) and any
// call site that needs the same check inline (e.g. to decide what to include
// in a response rather than reject the whole request).
export async function hasFeatureAccess(userId: string, role: string, featureKey: string, fallbackRoles: string[]): Promise<boolean> {
  if (role === "ADMIN") return true;
  try {
    const rows = await query<{ allowed_roles: string[] }>(
      `SELECT allowed_roles FROM admin_feature_permissions WHERE feature_key = $1 LIMIT 1`,
      [featureKey]
    );
    const allowed: string[] = rows[0]?.allowed_roles ?? fallbackRoles;
    if (allowed.includes(role)) return true;
    const groups = await getUserGroups(userId);
    return allowed.some((g) => groups.includes(g));
  } catch {
    return false;
  }
}

// Generic admin-configurable feature-permission gate: ADMIN always passes; otherwise
// checks the admin_feature_permissions table (role or permission-group match), falling
// back to fallbackRoles if no row exists yet for this feature.
export function requireFeatureAccess(featureKey: string, fallbackRoles: string[]) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    const allowed = await hasFeatureAccess(req.user.userId, req.user.role, featureKey, fallbackRoles);
    if (allowed) return next();
    return next(forbidden());
  };
}
