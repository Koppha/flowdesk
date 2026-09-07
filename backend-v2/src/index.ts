import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { bootstrapSystem } from "./bootstrap/system.js";
import { sendPendingChangeRequestFollowUps } from "./modules/custom-requests/custom-requests.routes.js";
import { startVendorContractReminderWorker } from "./modules/vendor-contracts/vendor-contracts.routes.js";
import { reassignAllPendingApprovals } from "./lib/approvalReassignment.js";

await bootstrapSystem();

// Run once at startup then every 24 h to send D+1 post-implementation review emails
async function runFollowUpScheduler() {
  try {
    await sendPendingChangeRequestFollowUps();
  } catch (err) {
    logger.warn("change_request_followup_scheduler_failed", { error: String(err) });
  }
}
runFollowUpScheduler();
setInterval(runFollowUpScheduler, 24 * 60 * 60 * 1000);

// Automatic sweep disabled per explicit request (stopped 2026-09-07) - was:
// run once at startup then every 24h, re-checking every pending advance/
// claim's currently dynamically-resolved approval step against who that
// position actually resolves to today, reassigning + notifying when it
// changed (e.g. a manager becoming available after a request was already
// submitted against the old resolution). The underlying function is
// untouched and still reachable on demand via the admin-only
// POST /admin/approval-maintenance/reassign route
// (modules/admin/approval-maintenance.routes.ts) - only the automatic
// every-24h trigger is off. Re-enable by restoring the two lines below.
// runApprovalReassignmentSweep();
// setInterval(runApprovalReassignmentSweep, 24 * 60 * 60 * 1000);
async function runApprovalReassignmentSweep() {
  try {
    const { reassignments, warnings } = await reassignAllPendingApprovals();
    logger.info("approval_reassignment_sweep_completed", {
      reassigned_count: reassignments.length,
      warning_count: warnings.length,
      reassignments,
      warnings
    });
  } catch (err) {
    logger.warn("approval_reassignment_sweep_failed", { error: String(err) });
  }
}
void runApprovalReassignmentSweep; // retained for the admin route / re-enabling later; not auto-invoked

startVendorContractReminderWorker();

const app = createApp();
app.listen(env.PORT, "0.0.0.0", () => {
  logger.info("api_started", {
    host: "0.0.0.0",
    port: env.PORT,
    node_env: env.NODE_ENV,
    cors_origin: env.CORS_ORIGIN || "*",
    ad_auth_enabled: env.AD_AUTH_ENABLED,
    ad_auth_url: env.AD_AUTH_URL || null,
    ad_api_base_url: env.AD_API_BASE_URL,
    ad_auth_path: env.AD_AUTH_PATH,
    ad_fallback_local: env.AD_FALLBACK_LOCAL
  });
});
