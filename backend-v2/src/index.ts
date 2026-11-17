import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { bootstrapSystem } from "./bootstrap/system.js";
import { sendPendingChangeRequestFollowUps } from "./modules/custom-requests/custom-requests.routes.js";
import { startVendorContractReminderWorker } from "./modules/vendor-contracts/vendor-contracts.routes.js";
import { startServiceContractReminderWorker } from "./modules/service-contracts/service-contracts.routes.js";
import { startReportingLineSyncWorker } from "./lib/reportingLineSync.js";
import { startEmployeeContractReminderWorker } from "./modules/employee-contracts/employee-contracts.routes.js";
import { startSlaReminderWorker } from "./modules/sla/sla.service.js";
import { reassignAllPendingApprovals } from "./lib/approvalReassignment.js";
import { sendCollectionReminders } from "./modules/it-provisioning/it-provisioning.service.js";
import { runMaintenanceAutoClose } from "./modules/maintenance/maintenance.service.js";
import { runClearanceReminderCycle } from "./modules/ai/clearance-reminders.js";

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

// Computer Requests: remind requesters to confirm collecting their computer
// (every 2 days, IT officer told from the 3rd reminder). Checked every 6 h.
async function runCollectionReminders() {
  try {
    const { sent } = await sendCollectionReminders();
    if (sent) logger.info("it_collection_reminders_sent", { sent });
  } catch (err) {
    logger.warn("it_collection_reminders_failed", { error: String(err) });
  }
}
runCollectionReminders();
setInterval(runCollectionReminders, 6 * 60 * 60 * 1000);

// Maintenance: requests waiting on the requester's confirmation close by
// themselves after N working days (FR-08). Checked hourly.
void runMaintenanceAutoClose();
setInterval(() => void runMaintenanceAutoClose(), 60 * 60 * 1000);

// Travellers: "clear your advance by <date>" push + email - 3 days and
// 1 day before, then weekly (3 times) while overdue. Only when switched on
// (Processes > Clearance Reminders). Checked hourly, sends 08:00-17:00.
async function runClearanceReminders() {
  try {
    const { sent } = await runClearanceReminderCycle();
    if (sent) logger.info("clearance_reminders_sent", { sent });
  } catch (err) {
    logger.warn("clearance_reminders_failed", { error: String(err) });
  }
}
setTimeout(() => void runClearanceReminders(), 60_000);
setInterval(() => void runClearanceReminders(), 60 * 60 * 1000);

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
startServiceContractReminderWorker();
startEmployeeContractReminderWorker();
startReportingLineSyncWorker();
startSlaReminderWorker();

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
