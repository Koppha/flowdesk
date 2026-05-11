import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { forbidden, unauthorized } from "./errors.js";
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
export function requireAuth(req, _res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
        return next(unauthorized("Missing bearer token"));
    try {
        req.user = verifyToken(header.slice("Bearer ".length));
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
