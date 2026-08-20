import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { accommodationRouter } from "./modules/accommodation/accommodation.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { advancesRouter } from "./modules/advances/advances.routes.js";
import { aiRouter } from "./modules/ai/ai.routes.js";
import { claimsRouter } from "./modules/claims/claims.routes.js";
import { claimsSlaRouter } from "./modules/claims/claims-sla.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { inboxRouter } from "./modules/inbox/inbox.routes.js";
import { overtimeRouter } from "./modules/overtime/overtime.routes.js";
import { travelRouter } from "./modules/travel/travel.routes.js";
import { workflowsRouter } from "./modules/workflows/workflows.routes.js";
import { reportingLinesRouter } from "./modules/reporting-lines/reporting-lines.routes.js";
import { requestTypesRouter } from "./modules/request-types/request-types.routes.js";
import { customRequestsRouter } from "./modules/custom-requests/custom-requests.routes.js";
import { emailActionsRouter } from "./modules/email-actions/email-actions.routes.js";
import { pdfTemplatesRouter } from "./modules/pdf-templates/pdf-templates.routes.js";
import { deductionsRouter } from "./modules/deductions/deductions.routes.js";
import { refundableRouter } from "./modules/refundable/refundable.routes.js";
import { itProvisioningRouter } from "./modules/it-provisioning/it-provisioning.routes.js";
import { standbyRouter } from "./modules/standby/standby.routes.js";
import { dataCleanupRouter } from "./modules/admin/data-cleanup.routes.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(compression());
  // CORS_ORIGIN may be a comma-separated list — lets a TLS cutover allow both
  // the old and new origin during the transition instead of forcing a
  // single-instant switch that breaks whoever hasn't reloaded yet.
  const allowedOrigins = env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean) : null;
  app.use(
    cors({
      origin: allowedOrigins && allowedOrigins.length ? allowedOrigins : env.CORS_ORIGIN || true,
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
  // claimsSlaRouter's fixed paths (/sla-report, /sla-thresholds) must be
  // registered before claimsRouter's GET /:id, or that route would swallow
  // them (treating "sla-report" as a claim id).
  app.use("/claims", claimsSlaRouter);
  app.use("/claims", claimsRouter);
  app.use("/inbox", inboxRouter);
  app.use("/overtime", overtimeRouter);
  app.use("/standby", standbyRouter);
  app.use("/travel", travelRouter);
  app.use("/workflows", workflowsRouter);
  app.use("/reporting-lines", reportingLinesRouter);
  app.use("/request-types", requestTypesRouter);
  app.use("/custom-requests", customRequestsRouter);
  app.use("/email-actions", emailActionsRouter);
  app.use("/pdf-templates", pdfTemplatesRouter);
  app.use("/deductions", deductionsRouter);
  app.use("/refundable", refundableRouter);
  app.use("/it-provisioning", itProvisioningRouter);
  app.use("/admin/data-cleanup", dataCleanupRouter);
  app.use("/ai", aiRouter);

  app.use(errorHandler);
  return app;
}
