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
import { overtimeReportsRouter } from "./modules/overtime/overtime-reports.routes.js";
import { travelRouter } from "./modules/travel/travel.routes.js";
import { workflowsRouter } from "./modules/workflows/workflows.routes.js";
import { reportingLinesRouter } from "./modules/reporting-lines/reporting-lines.routes.js";
import { requestTypesRouter } from "./modules/request-types/request-types.routes.js";
import { customRequestsRouter } from "./modules/custom-requests/custom-requests.routes.js";
import { changeCollabRouter } from "./modules/custom-requests/change-collab.routes.js";
import { raidRouter } from "./modules/raid/raid.routes.js";
import { brsRouter } from "./modules/brs/brs.routes.js";
import { brsAdminRouter } from "./modules/brs/brs-admin.routes.js";
import { distributionsRouter } from "./modules/distributions/distributions.routes.js";
import { emailActionsRouter } from "./modules/email-actions/email-actions.routes.js";
import { pdfTemplatesRouter } from "./modules/pdf-templates/pdf-templates.routes.js";
import { deductionsRouter } from "./modules/deductions/deductions.routes.js";
import { refundableRouter } from "./modules/refundable/refundable.routes.js";
import { salariesRouter } from "./modules/salaries/salaries.routes.js";
import { attendanceRouter } from "./modules/attendance/attendance.routes.js";
import { compensationClaimsRouter } from "./modules/compensation-claims/compensation-claims.routes.js";
import { treasuryRouter } from "./modules/treasury/treasury.routes.js";
import { treasuryReportsRouter } from "./modules/treasury/treasury-reports.routes.js";
import { itProvisioningRouter } from "./modules/it-provisioning/it-provisioning.routes.js";
import { standbyRouter } from "./modules/standby/standby.routes.js";
import { standbyReportsRouter } from "./modules/standby/standby-reports.routes.js";
import { dataCleanupRouter } from "./modules/admin/data-cleanup.routes.js";
import { approvalMaintenanceRouter } from "./modules/admin/approval-maintenance.routes.js";
import { slaSettingsRouter } from "./modules/admin/sla-settings.routes.js";
import { mobileConfigRouter } from "./modules/admin/mobile-config.routes.js";
import { mobileAppRouter } from "./modules/mobile-app/mobile-app.routes.js";
import { mobileSignPageRouter } from "./modules/mobile-app/mobile-sign-page.routes.js";
import { paAssignmentsRouter } from "./modules/admin/pa-assignments.routes.js";
import { vendorContractsRouter } from "./modules/vendor-contracts/vendor-contracts.routes.js";
import { scheduleReportingLineSync } from "./lib/reportingLineSync.js";
import { employeeContractsRouter } from "./modules/employee-contracts/employee-contracts.routes.js";
import { serviceContractsRouter } from "./modules/service-contracts/service-contracts.routes.js";
import { serviceContractsExternalRouter } from "./modules/service-contracts/service-contracts.external.routes.js";
import { searchRouter } from "./modules/search/search.routes.js";
import { signaturesRouter, signatureVerifyRouter } from "./modules/signatures/signatures.routes.js";
import { pdfEditRouter } from "./modules/pdf-edit/pdf-edit.routes.js";

export function createApp() {
  const app = express();
  // nginx reverse-proxies every request to this process over loopback (see
  // deploy/nginx-advance-clearance.conf.example), so without this every
  // req.ip is just 127.0.0.1 regardless of which real client sent it -
  // express-rate-limit's default per-IP key then groups EVERY user's login
  // attempts into one shared bucket, so once 20 attempts happen anywhere in
  // the company within the 15-minute window, loginLimiter (rateLimit.ts)
  // locks out every other user too, including ones who never got their
  // password wrong - a real incident on PROD. Trusting exactly one hop
  // reads the real client IP from X-Forwarded-For (which nginx already
  // sets) instead, without trusting arbitrary spoofed hops from further out.
  app.set("trust proxy", 1);

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
  // Org Structure, a user's placement/role, or a reporting line changed:
  // bring the automatic reporting lines up to date (debounced).
  app.use((req, res, next) => {
    if (req.method !== "GET" && /^\/(auth\/(users|departments|groups|sections|teams|divisions|org-structure|position-vacancies|complete-profile|resolve-or-invite-approver|admin\/reset-profiles)|admin\/data-cleanup|reporting-lines\/?$)/.test(req.path)) {
      res.on("finish", () => { if (res.statusCode < 400) scheduleReportingLineSync(); });
    }
    next();
  });
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
  app.use("/overtime-reports", overtimeReportsRouter);
  app.use("/standby", standbyRouter);
  app.use("/standby-reports", standbyReportsRouter);
  app.use("/vendor-contracts", vendorContractsRouter);
  app.use("/employee-contracts", employeeContractsRouter);
  app.use("/service-contracts", serviceContractsRouter);
  // Public path is https://flowdesk.etl.co.ls/api/v1/service-contracts/... -
  // PROD's nginx strips the /api/ prefix before proxying to this backend
  // (see deploy/nginx conf: `location /api/ { proxy_pass .../; }`), so the
  // path that actually reaches Express is /v1/service-contracts/..., not
  // /api/v1/service-contracts/... Mounting under plain /v1 here is what
  // makes the OpenAPI spec's published server URL resolve correctly.
  app.use("/v1/service-contracts", serviceContractsExternalRouter);
  app.use("/travel", travelRouter);
  app.use("/workflows", workflowsRouter);
  app.use("/reporting-lines", reportingLinesRouter);
  app.use("/request-types", requestTypesRouter);
  // Change Request collaboration routes first; the rest fall through.
  app.use("/custom-requests", changeCollabRouter);
  app.use("/custom-requests", customRequestsRouter);
  app.use("/raid", raidRouter);
  app.use("/brs", brsRouter);
  app.use("/brs-types", brsAdminRouter);
  app.use("/distributions", distributionsRouter);
  app.use("/email-actions", emailActionsRouter);
  app.use("/pdf-templates", pdfTemplatesRouter);
  app.use("/deductions", deductionsRouter);
  app.use("/refundable", refundableRouter);
  app.use("/salaries", salariesRouter);
  app.use("/attendance", attendanceRouter);
  app.use("/compensation-claims", compensationClaimsRouter);
  app.use("/treasury", treasuryRouter);
  app.use("/treasury-reports", treasuryReportsRouter);
  app.use("/it-provisioning", itProvisioningRouter);
  app.use("/admin/data-cleanup", dataCleanupRouter);
  app.use("/admin/approval-maintenance", approvalMaintenanceRouter);
  app.use("/admin/sla-settings", slaSettingsRouter);
  app.use("/admin/mobile-config", mobileConfigRouter);
  // Public static page - must precede mobileAppRouter (requireAuth).
  app.use("/mobile-app/sign", mobileSignPageRouter);
  app.use("/mobile-app", mobileAppRouter);
  app.use("/pa-assignments", paAssignmentsRouter);
  app.use("/ai", aiRouter);
  app.use("/search", searchRouter);
  // signatureVerifyRouter (public, no auth) must be registered before
  // signaturesRouter (requireAuth) — Express matches by prefix in
  // registration order, and /signatures/verify is a prefix of /signatures.
  app.use("/signatures/verify", signatureVerifyRouter);
  app.use("/signatures", signaturesRouter);
  app.use("/pdf-edit", pdfEditRouter);

  app.use(errorHandler);
  return app;
}
