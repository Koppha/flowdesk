import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth, requireFeatureAccess, requireRole } from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { conversationForDisplay, streamChat, usedToday } from "./assistant.js";
import {
  AI_SERVICES, AiModelsSchema, AiServiceSchema, AiSettingsSchema, addAiKey, aiConfigured, listAiModels, loadAiConfig, modelChoices,
  publicAiConfig, removeAiKey, resolveTarget, saveAiSettings, setUserModelPick, testAiModel, userModelPick
} from "./ai-settings.js";

function startOfCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function parsePrompt(prompt: string) {
  const value = prompt.toLowerCase();
  return {
    rejected: value.includes("rejected"),
    salary: value.includes("salary"),
    thisMonth: value.includes("this month"),
    byDepartment: value.includes("by department"),
    byStatus: value.includes("by status")
  };
}

function extractDate(text: string) {
  const match = text.match(/\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}[\/-]\d{2}[\/-]\d{2})\b/);
  return match?.[1] || null;
}

function extractAmount(text: string) {
  const match = text.match(/\b(?:M|LSL|ZAR)?\s?([0-9]{1,3}(?:[,\s][0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2})?)\b/i);
  if (!match) return null;
  return Number(match[1].replace(/[,\s]/g, ""));
}

function extractReference(text: string) {
  const labelled = text.match(/(?:reference|ref|voucher|txn|transaction)[\s:#-]*([A-Z0-9-]{5,})/i);
  if (labelled) return labelled[1];
  const fallback = text.match(/\b[A-Z0-9]{8,}\b/);
  return fallback?.[0] || null;
}

export const aiRouter = Router();
aiRouter.use(requireAuth);

// Both routes below expose company-wide names/departments/amounts — same
// class of data every other reporting endpoint in the app restricts to
// ADMIN/Finance (see e.g. advances.routes.ts's /payments, /reconciliation-report).
aiRouter.get("/anomalies", requireFeatureAccess("ai_insights", ["ADMIN", "Department: Finance"]), async (_req: AuthedRequest, res, next) => {
  try {
    const duplicateClaims = await query(
      `SELECT u.department, u.full_name AS claimant_name, c.month, c.linked_advance_id, COUNT(*)::int AS duplicate_count
       FROM clearance_claims c
       JOIN users u ON u.id = c.claimant_id
       WHERE c.status <> 'REJECTED'
       GROUP BY u.department, u.full_name, c.month, c.linked_advance_id
       HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC, u.full_name`
    );
    const unusualAdvances = await query(
      `WITH baseline AS (
         SELECT COALESCE(AVG(requested_total), 0) AS avg_amount
         FROM advance_requests
         WHERE status <> 'REJECTED'
       )
       SELECT u.department, u.full_name AS requester_name, ar.type, ar.requested_total
       FROM advance_requests ar
       JOIN users u ON u.id = ar.requester_id
       CROSS JOIN baseline b
       WHERE ar.requested_total >= GREATEST(10000, b.avg_amount * 2)
       ORDER BY ar.requested_total DESC
       LIMIT 20`
    );
    const repeatedRollbacks = await query(
      `SELECT al.entity_id AS advance_id, u.full_name AS requester_name, COUNT(*)::int AS rollback_count
       FROM audit_log al
       LEFT JOIN advance_requests ar ON ar.id = al.entity_id
       LEFT JOIN users u ON u.id = ar.requester_id
       WHERE al.action = 'ADVANCE_ROLLBACK'
       GROUP BY al.entity_id, u.full_name
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC, u.full_name`
    );
    return res.json({ duplicateClaims, unusualAdvances, repeatedRollbacks });
  } catch (err) {
    return next(err);
  }
});

aiRouter.post("/nl-report", requireFeatureAccess("ai_insights", ["ADMIN", "Department: Finance"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ prompt: z.string().trim().min(3) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid report prompt", parsed.error.flatten());
    const intent = parsePrompt(parsed.data.prompt);

    if (intent.rejected && intent.salary && intent.byDepartment) {
      const params: unknown[] = [];
      let dateFilter = "";
      if (intent.thisMonth) {
        params.push(startOfCurrentMonth());
        dateFilter = ` AND ar.created_at >= $${params.length}`;
      }
      const rows = await query(
        `SELECT COALESCE(u.department, 'Unknown') AS department,
                COUNT(*)::int AS total_requests,
                COALESCE(SUM(ar.requested_total), 0) AS total_amount
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         WHERE ar.status='REJECTED'
           AND ar.type='SALARY'${dateFilter}
         GROUP BY COALESCE(u.department, 'Unknown')
         ORDER BY total_requests DESC, department`,
        params
      );
      return res.json({
        interpretation: "Rejected salary advances grouped by department",
        rows
      });
    }

    const rows = await query(
      `SELECT ar.type,
              ar.status,
              COUNT(*)::int AS total_requests,
              COALESCE(SUM(ar.requested_total), 0) AS total_amount
       FROM advance_requests ar
       GROUP BY ar.type, ar.status
       ORDER BY total_requests DESC, ar.type, ar.status`
    );
    return res.json({
      interpretation: "General advance request summary by type and status",
      rows
    });
  } catch (err) {
    return next(err);
  }
});

aiRouter.post("/ocr-extract", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ text: z.string().trim().min(3) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid OCR extraction payload", parsed.error.flatten());
    const text = parsed.data.text;
    return res.json({
      extracted_date: extractDate(text),
      extracted_amount: extractAmount(text),
      extracted_reference: extractReference(text)
    });
  } catch (err) {
    return next(err);
  }
});

// ── AI Assistant ─────────────────────────────────────────────────────────
// Available to everyone by default; an admin can restrict it from Roles &
// Permissions ("AI Assistant"). Which AI service it uses is set from
// Settings > AI Assistant (ai-settings.ts).
export const AI_ASSISTANT_DEFAULT_ROLES = ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"];
const requireAssistant = requireFeatureAccess("ai_assistant", AI_ASSISTANT_DEFAULT_ROLES);

aiRouter.get("/assistant/status", requireAssistant, async (req: AuthedRequest, res, next) => {
  try {
    const cfg = await loadAiConfig();
    const choosing = cfg.settings.user_choice;
    return res.json({
      configured: aiConfigured(cfg), enabled: cfg.settings.enabled, daily_limit: cfg.settings.daily_limit, used_today: await usedToday(req.user!.userId),
      // The models this person may pick from, and their pick (null = the admin's order).
      user_choice: choosing,
      models: choosing ? modelChoices(cfg) : [],
      my_model: choosing ? await userModelPick(req.user!.userId) : null
    });
  } catch (err) { return next(err); }
});

// My own model, from the admin's list - or null to go back to the default.
aiRouter.put("/assistant/my-model", requireAssistant, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ service: z.enum(AI_SERVICES), model: z.string().trim().min(1).max(120) }).nullable().safeParse(req.body?.pick ?? null);
    if (!parsed.success) throw badRequest("Pick a model from the list");
    const cfg = await loadAiConfig();
    if (!cfg.settings.user_choice) throw badRequest("Choosing your own model is switched off");
    const pick = parsed.data;
    if (pick && !modelChoices(cfg).some((m) => m.service === pick.service && m.model === pick.model)) throw badRequest("That model isn't on the list any more");
    await setUserModelPick(req.user!.userId, pick);
    return res.json({ my_model: pick });
  } catch (err) { return next(err); }
});

// Settings > AI Assistant (ADMIN only). Keys are write-only: never returned,
// only which services have one and its last 4 characters.
aiRouter.get("/assistant/settings", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    return res.json(await publicAiConfig(await loadAiConfig()));
  } catch (err) { return next(err); }
});

// Services (each with the key it uses), models, user choice, limit, on/off.
// Keys themselves are added and removed below.
aiRouter.put("/assistant/settings", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AiSettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid AI settings", parsed.error.flatten());
    await saveAiSettings(parsed.data);
    logger.info("ai_settings_updated", {
      by: req.user!.userId, enabled: parsed.data.enabled, user_choice: parsed.data.user_choice,
      services: parsed.data.services.map((s) => `${s.service}${s.key_id ? `:${s.key_id}` : ""}`), models: parsed.data.models.map((m) => `${m.service}:${m.model}`)
    });
    return res.json(await publicAiConfig(await loadAiConfig()));
  } catch (err) { return next(err); }
});

// Save another named key for a service (saved at once, encrypted; the key
// itself is never sent back). The page then picks it for the service.
aiRouter.post("/assistant/settings/keys", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AiServiceSchema.extend({ name: z.string().trim().min(1, "Give the key a name").max(60), key: z.string().trim().min(8, "Paste the API key").max(500) }).safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid key");
    const id = await addAiKey(parsed.data);
    logger.info("ai_key_added", { by: req.user!.userId, service: parsed.data.service, id, name: parsed.data.name });
    return res.status(201).json({ id, settings: await publicAiConfig(await loadAiConfig()) });
  } catch (err) { return next(err); }
});

aiRouter.delete("/assistant/settings/keys/:id", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    if (!(await removeAiKey(req.params.id))) return res.status(404).json({ error: "Key not found" });
    logger.info("ai_key_removed", { by: req.user!.userId, id: req.params.id });
    return res.json(await publicAiConfig(await loadAiConfig()));
  } catch (err) { return next(err); }
});

// "Load models" / "Test connection" on the not-yet-saved form use the key
// typed in, or the one available for that exact service and address.
const TargetSchema = AiServiceSchema.extend({ api_key: z.string().max(500).optional() }).refine(
  (t) => t.service === "anthropic" || /^https?:\/\/\S+$/i.test(t.base_url),
  { message: "A service address (http:// or https://) is required" }
);

aiRouter.post("/assistant/settings/models", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = TargetSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid AI service details");
    try {
      return res.json({ models: await listAiModels(await resolveTarget(parsed.data)) });
    } catch (err: any) {
      return res.status(400).json({ error: `Couldn't load models: ${err?.message || err}` });
    }
  } catch (err) { return next(err); }
});

aiRouter.post("/assistant/settings/test", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ services: z.array(TargetSchema).min(1).max(AI_SERVICES.length), models: AiModelsSchema.min(1) }).safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Add at least one model to test");
    const results = [];
    for (const m of parsed.data.models) {
      const service = parsed.data.services.find((s) => s.service === m.service);
      if (!service) { results.push({ service: m.service, model: m.model, ok: false, ms: 0, message: "Its service isn't in the list" }); continue; }
      results.push(await testAiModel(await resolveTarget(service), m.model));
    }
    return res.json({ results });
  } catch (err) { return next(err); }
});

aiRouter.get("/assistant/conversations", requireAssistant, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT id, title, updated_at FROM ai_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20`, [req.user!.userId]
    );
    return res.json({ items: rows });
  } catch (err) { return next(err); }
});

aiRouter.get("/assistant/conversations/:id", requireAssistant, async (req: AuthedRequest, res, next) => {
  try {
    const c = await conversationForDisplay(req.params.id, req.user!.userId);
    if (!c) return res.status(404).json({ error: "Conversation not found" });
    return res.json(c);
  } catch (err) { return next(err); }
});

aiRouter.delete("/assistant/conversations/:id", requireAssistant, async (req: AuthedRequest, res, next) => {
  try {
    await query(`DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2`, [req.params.id, req.user!.userId]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

aiRouter.post("/assistant/chat", requireAssistant, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ message: z.string().trim().min(1).max(4000), conversation_id: z.string().uuid().nullish() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Type a question first");
    const cfg = await loadAiConfig();
    if (!aiConfigured(cfg)) return res.status(503).json({ error: cfg.settings.enabled ? "The AI assistant hasn't been set up yet." : "The AI assistant is switched off." });
    if ((await usedToday(req.user!.userId)) >= cfg.settings.daily_limit) {
      return res.status(429).json({ error: `You've reached today's limit of ${cfg.settings.daily_limit} questions - it resets at midnight.` });
    }
    await streamChat({
      res,
      userId: req.user!.userId,
      token: String(req.headers.authorization || ""),
      user: { fullName: req.user!.fullName ?? null, role: req.user!.role },
      conversationId: parsed.data.conversation_id ?? null,
      message: parsed.data.message,
      // The person closed the panel / lost connection before the answer finished.
      onClose: (fn) => res.on("close", () => { if (!res.writableEnded) fn(); })
    });
  } catch (err) { return next(err); }
});
