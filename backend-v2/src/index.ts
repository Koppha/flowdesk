import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { bootstrapSystem } from "./bootstrap/system.js";
import { sendPendingChangeRequestFollowUps } from "./modules/custom-requests/custom-requests.routes.js";
import { startVendorContractReminderWorker } from "./modules/vendor-contracts/vendor-contracts.routes.js";

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
