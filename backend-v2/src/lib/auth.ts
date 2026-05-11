import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { forbidden, unauthorized } from "./errors.js";

export type Role =
  | "EMPLOYEE"
  | "COUNTERSIGN"
  | "MANAGER"
  | "HR_MANAGER"
  | "AUTH_OFFICER"
  | "CHIEF_OFFICER"
  | "FINANCE"
  | "ADMIN";

export type AuthPayload = {
  userId: string;
  role: Role;
  username?: string;
  fullName?: string;
  employeeNo?: string | null;
  department?: string | null;
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

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized("Missing bearer token"));
  try {
    req.user = verifyToken(header.slice("Bearer ".length));
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
