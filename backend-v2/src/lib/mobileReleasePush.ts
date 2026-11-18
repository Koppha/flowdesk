import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";
import { sendPushToUser } from "./push.js";

// The phone side of the portal's "New mobile app release" tip
// (frontend/src/components/MobileReleaseTip.tsx): when an admin uploads a new
// version on Get the App, everyone with FlowDesk Mobile registered for push
// hears about it. Tapping it opens the app, whose UpdateBanner offers the
// download. sendPushToUser skips anyone who switched push off.
export function releasePushMessage(version: string) {
  return {
    title: "New mobile app release",
    body: `FlowDesk Mobile ${version} is out. Open the app to update.`,
    data: { type: "APP_RELEASE", version }
  };
}

// Best-effort and sequential (a few hundred users at most): never throws, so
// it can't fail the upload that triggered it.
export async function notifyMobileRelease(version: string, onlyUserIds?: string[]) {
  try {
    const rows = await query<{ user_id: string }>(
      onlyUserIds
        ? `SELECT DISTINCT user_id FROM mobile_push_tokens WHERE user_id = ANY($1::uuid[])`
        : `SELECT DISTINCT user_id FROM mobile_push_tokens`,
      onlyUserIds ? [onlyUserIds] : []
    );
    const message = releasePushMessage(version);
    for (const r of rows) await sendPushToUser(r.user_id, message);
    logger.info("mobile_release_push_sent", { version, users: rows.length });
    return rows.length;
  } catch (error) {
    logger.warn("mobile_release_push_failed", { version, error: serializeError(error) });
    return 0;
  }
}
