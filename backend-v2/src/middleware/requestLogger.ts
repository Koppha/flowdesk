import { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";

function getClientIp(req: Request) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0];
  }
  return req.socket.remoteAddress || req.ip || null;
}

function statusFamily(status: number) {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  if (status >= 100) return "1xx";
  return "0xx";
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = randomUUID();
  const started = process.hrtime.bigint();
  const startedAt = new Date();
  const reqAny = req as Request & { reqId?: string };
  reqAny.reqId = requestId;
  res.setHeader("x-request-id", requestId);

  const bodyKeys = req.body && typeof req.body === "object" ? Object.keys(req.body as Record<string, unknown>) : [];
  logger.info("http_request_start", {
    request_id: requestId,
    started_at: startedAt.toISOString(),
    method: req.method,
    path: req.originalUrl,
    ip: getClientIp(req),
    user_agent: req.get("user-agent") || null,
    has_auth_header: Boolean(req.get("authorization")),
    content_type: req.get("content-type") || null,
    content_length: req.get("content-length") || null,
    query: req.query || {},
    body_keys: bodyKeys
  });

  res.on("finish", () => {
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
    const responseBytes = res.getHeader("content-length");
    logger.info("http_request", {
      request_id: requestId,
      method: req.method,
      path: req.originalUrl,
      route: (req.route as any)?.path || null,
      status: res.statusCode,
      status_family: statusFamily(res.statusCode),
      duration_ms: Number(elapsed.toFixed(2))
      ,
      ip: getClientIp(req),
      user_agent: req.get("user-agent") || null,
      referer: req.get("referer") || null,
      has_auth_header: Boolean(req.get("authorization")),
      response_content_length: responseBytes ?? null
    });
  });
  next();
}
