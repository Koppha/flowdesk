import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import { getStringSystemSetting, setStringSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";

export const mobileConfigRouter = Router();
mobileConfigRouter.use(requireAuth);

const ModulesSchema = z.object({
  advances: z.boolean(),
  clearances: z.boolean(),
  // Mobile "New" buttons. .default(false) so settings saved before these keys
  // existed still parse - a parse failure would reset every module to DEFAULT_MODULES.
  createAdvance: z.boolean().default(false),
  createClearance: z.boolean().default(false),
  overtime: z.boolean(),
  standby: z.boolean(),
  customProcesses: z.boolean(),
  signADocument: z.boolean(),
  // .default(false): settings saved before Maintenance existed still parse.
  maintenance: z.boolean().default(false)
});
type Modules = z.infer<typeof ModulesSchema>;

const DEFAULT_MODULES: Modules = {
  advances: true,
  clearances: true,
  createAdvance: false,
  createClearance: false,
  overtime: false,
  standby: false,
  customProcesses: false,
  signADocument: false,
  maintenance: false
};

async function currentModules(): Promise<Modules> {
  const raw = await getStringSystemSetting(SYSTEM_SETTING_KEYS.mobileAppModules, null);
  if (!raw) return DEFAULT_MODULES;
  try {
    const parsed = ModulesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_MODULES;
  } catch {
    return DEFAULT_MODULES;
  }
}

// The bottom tab bar's tabs, in display order - a tab with enabled=false is
// hidden from the bar (Expo Router's documented `options.href = null`
// pattern: https://docs.expo.dev/router/advanced/tabs/) but its screen stays
// reachable, so hiding one never breaks navigation. mobile/src/app/(tabs)/
// _layout.tsx enforces "at least one tab visible" itself as a fail-safe, in
// case every tab is ever saved disabled.
const TAB_KEYS = ["home", "inbox", "profile"] as const;
const TabSchema = z.object({ key: z.enum(TAB_KEYS), enabled: z.boolean() });
const TabsSchema = z.array(TabSchema).min(1).refine(
  (tabs) => new Set(tabs.map((t) => t.key)).size === TAB_KEYS.length && TAB_KEYS.every((k) => tabs.some((t) => t.key === k)),
  { message: "Must include every tab key exactly once" }
);
type Tabs = z.infer<typeof TabsSchema>;

const DEFAULT_TABS: Tabs = TAB_KEYS.map((key) => ({ key, enabled: true }));

async function currentTabs(): Promise<Tabs> {
  const raw = await getStringSystemSetting(SYSTEM_SETTING_KEYS.mobileAppTabs, null);
  if (!raw) return DEFAULT_TABS;
  try {
    const parsed = TabsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_TABS;
  } catch {
    return DEFAULT_TABS;
  }
}

// Read access is any authenticated user (the mobile app itself needs this on
// every load); only ADMIN can change it - same split as sla-settings.routes.ts.
mobileConfigRouter.get("/", async (_req: AuthedRequest, res, next) => {
  try {
    return res.json({ modules: await currentModules(), tabs: await currentTabs() });
  } catch (err) {
    return next(err);
  }
});

mobileConfigRouter.put("/", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    // Partial + merge: an admin page that doesn't know a key yet keeps its saved value.
    const modulesParsed = ModulesSchema.partial().safeParse(req.body?.modules);
    if (!modulesParsed.success) throw badRequest("Invalid payload", modulesParsed.error.flatten());
    const sent = Object.fromEntries(Object.entries(modulesParsed.data).filter(([, v]) => v !== undefined)) as Partial<Modules>;
    const modules: Modules = { ...(await currentModules()), ...sent };
    await setStringSystemSetting(SYSTEM_SETTING_KEYS.mobileAppModules, JSON.stringify(modules));

    let tabs = await currentTabs();
    if (req.body?.tabs !== undefined) {
      const tabsParsed = TabsSchema.safeParse(req.body.tabs);
      if (!tabsParsed.success) throw badRequest("Invalid tab bar payload", tabsParsed.error.flatten());
      if (!tabsParsed.data.some((t) => t.enabled)) throw badRequest("At least one tab must stay visible");
      await setStringSystemSetting(SYSTEM_SETTING_KEYS.mobileAppTabs, JSON.stringify(tabsParsed.data));
      tabs = tabsParsed.data;
    }

    return res.json({ modules, tabs });
  } catch (err) {
    return next(err);
  }
});
