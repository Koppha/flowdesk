import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { forbidden, unauthorized } from "./errors.js";
import { query } from "./db.js";
export function signToken(payload) {
    return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "12h" });
}
export function verifyToken(token) {
    return jwt.verify(token, env.JWT_SECRET);
}
export async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}
export async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}
export async function requireAuth(req, _res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
        return next(unauthorized("Missing bearer token"));
    try {
        const token = header.slice("Bearer ".length);
        const payload = verifyToken(token);
        req.user = payload;
        // Invalidate tokens issued before the global sessions_cleared_at timestamp
        try {
            const rows = await query(`SELECT value FROM system_state WHERE key='sessions_cleared_at' LIMIT 1`);
            const row = rows[0];
            if (row && row.value) {
                const clearedAt = Date.parse(row.value) / 1000; // seconds
                const iat = payload.iat || 0;
                if (iat <= clearedAt)
                    return next(unauthorized("Session expired"));
            }
        }
        catch (err) {
            // ignore if system_state table missing
        }
        return next();
    }
    catch {
        return next(unauthorized("Invalid token"));
    }
}
export function requireRole(roles) {
    return (req, _res, next) => {
        if (!req.user)
            return next(unauthorized());
        if (!roles.includes(req.user.role))
            return next(forbidden());
        return next();
    };
}
// Finance approval authority now comes from org structure (Department: Finance)
// rather than a dedicated FINANCE role.
export function isFinanceDept(department) {
    return String(department || "").trim().toLowerCase() === "finance";
}
export function requireFinance(req, _res, next) {
    if (!req.user)
        return next(unauthorized());
    if (req.user.role !== "ADMIN" && !isFinanceDept(req.user.department))
        return next(forbidden());
    return next();
}
