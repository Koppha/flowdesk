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
  maintenance: z.boolean().default(false),
  // Managers' My Team tile (MANAGER/HOD/EXCO/CEO/ADMIN only, enforced by the app and the endpoint).
  myTeam: z.boolean().default(false),
  // Delegating one's own approvals (managers, and anyone on a step that allows delegation).
  delegation: z.boolean().default(false)
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
  maintenance: false,
  myTeam: false,
  delegation: false
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

// Extra Home tiles for processes built on the server: each opens a screen of
// the mobile server page (/web?go=<go>), so a new process shows up in the app
// with no release. Icon is a name from the app's Home WEB_TILE_ICONS.
const WebTileSchema = z.object({
  go: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().trim().min(1).max(30),
  icon: z.string().trim().max(30).optional(),
  color: z.enum(["accent", "good", "warn", "bad", "info", "purple"]).optional()
});
const WebTilesSchema = z.array(WebTileSchema).max(20);
const WEB_TILES_KEY = "mobile_app_web_tiles";

async function currentWebTiles() {
  const raw = await getStringSystemSetting(WEB_TILES_KEY, null);
  if (!raw) return [];
  try {
    const parsed = WebTilesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

// Modules whose screens live on the mobile server page. App builds from
// before 19 Nov 2026 draw these Home tiles with nowhere to go (greyed, taps do
// nothing), but every build since 1.0.6 draws server tiles - so while the
// module is on, the app is also sent a tile that opens the server screen by
// name. Builds that open these natively hide the duplicate (same `go`).
const MODULE_WEB_TILES: { module: keyof Modules; tile: z.infer<typeof WebTileSchema> }[] = [
  { module: "customProcesses", tile: { go: "custom-processes", label: "Custom Processes", icon: "git-branch", color: "purple" } },
  { module: "overtime", tile: { go: "overtime", label: "Overtime", icon: "clock", color: "warn" } },
  { module: "standby", tile: { go: "standby", label: "Standby", icon: "radio", color: "info" } }
];

// Read access is any authenticated user (the mobile app itself needs this on
// every load); only ADMIN can change it - same split as sla-settings.routes.ts.
mobileConfigRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const modules = await currentModules();
    let webTiles = await currentWebTiles();
    // Only for the app itself: the portal's admin page edits the saved tiles,
    // and must not save these back as if an admin had added them.
    if (req.headers["x-flowdesk-client"] === "mobile") {
      const extra = MODULE_WEB_TILES.filter((m) => modules[m.module] && !webTiles.some((t) => t.go === m.tile.go)).map((m) => m.tile);
      webTiles = [...extra, ...webTiles].slice(0, 20);
    }
    return res.json({ modules, tabs: await currentTabs(), webTiles });
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

    let webTiles = await currentWebTiles();
    if (req.body?.webTiles !== undefined) {
      const tilesParsed = WebTilesSchema.safeParse(req.body.webTiles);
      if (!tilesParsed.success) throw badRequest("Invalid Home tiles", tilesParsed.error.flatten());
      await setStringSystemSetting(WEB_TILES_KEY, JSON.stringify(tilesParsed.data));
      webTiles = tilesParsed.data;
    }

    return res.json({ modules, tabs, webTiles });
  } catch (err) {
    return next(err);
  }
});
