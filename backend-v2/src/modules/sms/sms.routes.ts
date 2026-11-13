import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import { getSmsSettings, normalizeMsisdn, saveSmsSettings, sendSms, smsStats } from "../../lib/sms.js";

// Admin: SMS gateway settings, a test SMS, and how many people can get SMS.
export const smsRouter = Router();
smsRouter.use(requireAuth, requireRole(["ADMIN"]));

const view = (s: Awaited<ReturnType<typeof getSmsSettings>>) => ({
  enabled: s.enabled, notify: s.notify, url: s.url, sender: s.sender, username: s.username, has_password: Boolean(s.password)
});

smsRouter.get("/settings", async (_req, res, next) => {
  try { return res.json({ ...view(await getSmsSettings(true)), stats: await smsStats() }); } catch (err) { return next(err); }
});

const SettingsSchema = z.object({
  enabled: z.boolean().optional(),
  notify: z.boolean().optional(),
  url: z.string().trim().url().max(500).optional(),
  sender: z.string().trim().min(1).max(11).optional(),
  username: z.string().trim().max(100).optional(),
  password: z.string().max(200).optional()
});
smsRouter.put("/settings", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid SMS settings");
    const p = { ...parsed.data };
    if (p.password === "") delete p.password; // blank = keep the saved one
    return res.json(view(await saveSmsSettings(p, req.user!.userId)));
  } catch (err) { return next(err); }
});

smsRouter.post("/test", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ msisdn: z.string().trim().min(8).max(20), msg: z.string().trim().max(160).optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Give a phone number to send the test to");
    if (!normalizeMsisdn(parsed.data.msisdn)) throw badRequest("That isn't a Lesotho mobile number (8 digits, or 266 and 8 digits)");
    const r = await sendSms(parsed.data.msisdn, parsed.data.msg || "FlowDesk test SMS. Notifications will reach you here.", { kind: "TEST", userId: req.user!.userId });
    return res.json(r);
  } catch (err) { return next(err); }
});
