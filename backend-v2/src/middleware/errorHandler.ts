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

  logger.error("unhandled_error", { ...requestContext(req), error: serializeError(err) });
  return res.status(500).json({ error: "Internal server error" });
}
