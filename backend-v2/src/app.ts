import compression from "compression";
import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { accommodationRouter } from "./modules/accommodation/accommodation.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { advancesRouter } from "./modules/advances/advances.routes.js";
import { aiRouter } from "./modules/ai/ai.routes.js";
import { attendanceRouter } from "./modules/attendance/attendance.routes.js";
import { claimsRouter } from "./modules/claims/claims.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { inboxRouter } from "./modules/inbox/inbox.routes.js";
import { overtimeRouter } from "./modules/overtime/overtime.routes.js";
import { travelRouter } from "./modules/travel/travel.routes.js";
import { workflowsRouter } from "./modules/workflows/workflows.routes.js";
import { reportingLinesRouter } from "./modules/reporting-lines/reporting-lines.routes.js";
import { requestTypesRouter } from "./modules/request-types/request-types.routes.js";
import { customRequestsRouter } from "./modules/custom-requests/custom-requests.routes.js";
import { emailActionsRouter } from "./modules/email-actions/email-actions.routes.js";

export function createApp() {
  const app = express();

  app.use(compression());
  app.use(
    cors({
      origin: env.CORS_ORIGIN || true,
      credentials: true
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(requestLogger);

  // Short cache for stable reference data — reduces repeat round-trips from
  // the same client without risking stale data on transactional endpoints.
  app.use((req, res, next) => {
    const stale = ["/travel", "/workflows", "/request-types", "/auth/departments", "/auth/directory"];
    if (req.method === "GET" && stale.some((p) => req.path.startsWith(p))) {
      res.setHeader("Cache-Control", "private, max-age=60, stale-while-revalidate=30");
    } else {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  app.use("/health", healthRouter);
  app.use("/auth", authRouter);
  app.use("/advances", advancesRouter);
  app.use("/accommodation-requests", accommodationRouter);
  app.use("/accommodation", accommodationRouter);
  app.use("/claims", claimsRouter);
  app.use("/inbox", inboxRouter);
  app.use("/attendance", attendanceRouter);
  app.use("/overtime", overtimeRouter);
  app.use("/travel", travelRouter);
  app.use("/workflows", workflowsRouter);
  app.use("/reporting-lines", reportingLinesRouter);
  app.use("/request-types", requestTypesRouter);
  app.use("/custom-requests", customRequestsRouter);
  app.use("/email-actions", emailActionsRouter);
  app.use("/ai", aiRouter);

  app.use(errorHandler);
  return app;
}
