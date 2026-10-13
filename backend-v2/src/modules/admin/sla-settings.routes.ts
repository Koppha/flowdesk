import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import { getBooleanSystemSetting, getNumericSystemSetting, setBooleanSystemSetting, setNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";

export const slaSettingsRouter = Router();
slaSettingsRouter.use(requireAuth);

async function currentSettings() {
  const [enabled, thresholdHours] = await Promise.all([
    getBooleanSystemSetting(SYSTEM_SETTING_KEYS.slaRemindersEnabled, true),
    getNumericSystemSetting(SYSTEM_SETTING_KEYS.slaReminderThresholdHours, 48)
  ]);
  return { enabled, thresholdHours };
}

// Read access is any authenticated user (low-sensitivity, informational);
// only ADMIN can change it.
slaSettingsRouter.get("/", async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await currentSettings());
  } catch (err) {
    return next(err);
  }
});

const SlaSettingsSchema = z.object({ enabled: z.boolean(), thresholdHours: z.number().int().min(1).max(24 * 30) });
slaSettingsRouter.put("/", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SlaSettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.slaRemindersEnabled, parsed.data.enabled);
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.slaReminderThresholdHours, parsed.data.thresholdHours);
    return res.json(await currentSettings());
  } catch (err) {
    return next(err);
  }
});
