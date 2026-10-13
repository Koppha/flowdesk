import { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors.js";
import { logger, serializeError } from "../lib/logger.js";

function requestContext(req: Request) {
  const r = req as Request & { reqId?: string; user?: { userId?: string; role?: string } };
  return {
    request_id: r.reqId || null,
    method: req.method,
    path: req.originalUrl,
    route: (req.route as any)?.path || null,
    user_id: r.user?.userId || null,
    role: r.user?.role || null
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    logger.warn("http_error_response", {
      ...requestContext(req),
      status: err.statusCode,
      error_message: err.message,
      error_details: err.details ?? null
    });
    return res.status(err.statusCode).json({ error: err.message, details: err.details ?? null });
  }

  // Postgres constraint violations a route didn't pre-check are conflicts
  // with existing data, not server faults - say so instead of a bare 500.
  const pgCode = (err as { code?: unknown } | null)?.code;
  if (pgCode === "23505" || pgCode === "23503") {
    const message = pgCode === "23505"
      ? "That value is already in use by another record"
      : "This record is still linked to other data and can't be changed or removed";
    logger.warn("http_error_response", {
      ...requestContext(req),
      status: 409,
      error_message: message,
      error_details: { pg_code: pgCode, constraint: (err as { constraint?: string }).constraint ?? null, detail: (err as { detail?: string }).detail ?? null }
    });
    return res.status(409).json({ error: message, details: null });
  }

  logger.error("unhandled_error", { ...requestContext(req), error: serializeError(err) });
  return res.status(500).json({ error: "Internal server error" });
}
