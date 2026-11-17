/**
 * The sidebar menu as an admin-arrangeable tree.
 *
 * WHERE each link sits (top level, inside a group, groups inside groups, the
 * order, group names/icons, section labels) is data: a MenuLayout saved
 * centrally (GET/PUT /request-types/menu-layout) and edited from
 * Settings > Menu or when a process is activated on the Process page.
 *
 * WHO sees each link is NOT part of the layout - every item keeps its own
 * permission / module-on rules in App.tsx's menu item list, and a group only
 * shows when something inside it is visible. Moving an item never hides it
 * or grants access to it.
 *
 * DEFAULT_LAYOUT is the sidebar exactly as it was hard-coded, so nothing
 * moves until an admin changes it. Any item missing from a saved layout
 * (added in a later release, a newly activated custom process, ...) is put
 * back in its default spot by mergeLayout, so nothing can go missing.
 */

export type MenuItemNode = { type: "item"; id: string };
export type MenuGroupNode = {
  type: "group";
  id: string;
  label: string;
  icon: string;
  children: MenuNode[];
  // Built-in groups whose header opens a page while you're not inside the
  // group (Reports > reports hub, User Management > Users).
  page?: string;
  // Built-in Settings: with only one link visible, show that link alone
  // under the group's name instead of a one-entry group.
  flattenIfSingle?: boolean;
};
export type MenuSectionNode = { type: "section"; id: string; label: string };
export type MenuNode = MenuItemNode | MenuGroupNode | MenuSectionNode;
export type MenuLayout = { version: 1; nodes: MenuNode[] };

const item = (id: string): MenuItemNode => ({ type: "item", id });
const group = (id: string, label: string, icon: string, children: string[], extra: Partial<MenuGroupNode> = {}): MenuGroupNode =>
  ({ type: "group", id, label, icon, children: children.map(item), ...extra });

// Custom processes (Change Request, Computer Request, ...) are one item each,
// "custom:<request type id>", placed in the Custom Processes group by default.
export const CUSTOM_PROCESS_PREFIX = "custom:";

export const DEFAULT_LAYOUT: MenuLayout = {
  version: 1,
  nodes: [
    item("dashboard"),
    item("ai_assistant"),
    group("advances", "Advances", "ClipboardList", ["advance_requests", "clearances"]),
    group("salaries", "Allowances", "Banknote", [
      "salaries_dashboard", "salary_registers", "salaries_attendance", "salaries_ready", "salaries_history",
      "overtime", "standby", "call_out"
    ]),
    group("custom", "Custom Processes", "GitBranch", ["brs", "maintenance"]),
    item("signatures"),
    item("inbox"),
    group("finance", "Finance", "Wallet", ["capture", "payments", "deductions", "view_clearances", "salary_advances", "refundable", "finance_reports"]),
    item("it_provisioning"),
    group("contracts", "Contracts", "FileText", ["vendor_contracts", "service_contracts", "employee_contracts"]),
    group("reports", "Reports", "BarChart3", [
      "report_advances", "report_approval", "report_process_performance", "sla_reports", "report_workflow",
      "report_audit", "report_reconciliation", "report_clearance_status", "report_tour_engagement"
    ], { page: "REPORTS" }),
    { type: "section", id: "administration", label: "Administration" },
    group("users", "User Management", "Users", ["users", "roles_permissions", "manager_delegations", "external_payees"], { page: "USER_MANAGEMENT" }),
    item("my_team"),
    item("travel_setup"),
    item("process"),
    item("brs_templates"),
    group("org", "Organizational Structure", "Network", [
      "org_structure", "org_gaps", "team_roster", "ceo", "employees", "exco", "managers", "leadership",
      "workflow_builder", "reporting_lines"
    ]),
    group("settings", "Settings", "Settings", ["settings_general", "pdf_designer", "mobile_app_config", "ai_assistant_config", "menu_editor"], { flattenIfSingle: true }),
    item("data_cleanup")
  ]
};

export const cloneLayout = (l: MenuLayout): MenuLayout => JSON.parse(JSON.stringify(l));

// ── default positions (for putting missing items back) ───────────────────
type DefaultSpot = { parent: string | null; order: number };
const DEFAULT_SPOTS: Map<string, DefaultSpot> = (() => {
  const m = new Map<string, DefaultSpot>();
  let order = 0;
  const walk = (nodes: MenuNode[], parent: string | null) => {
    for (const n of nodes) {
      m.set(n.id, { parent, order: order++ });
      if (n.type === "group") walk(n.children, n.id);
    }
  };
  walk(DEFAULT_LAYOUT.nodes, null);
  return m;
})();

function defaultSpot(id: string): DefaultSpot | null {
  if (id.startsWith(CUSTOM_PROCESS_PREFIX)) {
    // Custom processes sit at the top of Custom Processes, before BRS Studio.
    const brs = DEFAULT_SPOTS.get("brs")!;
    return { parent: "custom", order: brs.order - 0.5 };
  }
  return DEFAULT_SPOTS.get(id) ?? null;
}

// ── tree helpers ──────────────────────────────────────────────────────────
export function findNode(nodes: MenuNode[], id: string): { node: MenuNode; siblings: MenuNode[]; index: number; parent: MenuGroupNode | null } | null {
  const walk = (list: MenuNode[], parent: MenuGroupNode | null): ReturnType<typeof findNode> => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { node: n, siblings: list, index: i, parent };
      if (n.type === "group") {
        const hit = walk(n.children, n);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(nodes, null);
}

export function allNodeIds(nodes: MenuNode[]): string[] {
  const out: string[] = [];
  const walk = (list: MenuNode[]) => list.forEach((n) => { out.push(n.id); if (n.type === "group") walk(n.children); });
  walk(nodes);
  return out;
}

export function itemIdsIn(node: MenuNode): string[] {
  if (node.type === "item") return [node.id];
  if (node.type === "group") return node.children.flatMap(itemIdsIn);
  return [];
}

// Every group with its path ("Processes ▸ Facilities") and depth - for the
// "Move to" / "Inside a group" pickers.
export function listGroups(layout: MenuLayout): Array<{ id: string; label: string; path: string; depth: number }> {
  const out: Array<{ id: string; label: string; path: string; depth: number }> = [];
  const walk = (list: MenuNode[], trail: string[]) => {
    for (const n of list) {
      if (n.type !== "group") continue;
      const path = [...trail, n.label];
      out.push({ id: n.id, label: n.label, path: path.join(" ▸ "), depth: trail.length });
      walk(n.children, path);
    }
  };
  walk(layout.nodes, []);
  return out;
}

export function locationOf(layout: MenuLayout, id: string): string {
  const hit = findNode(layout.nodes, id);
  if (!hit) return "Not in the menu yet";
  if (!hit.parent) return "Main menu";
  return listGroups(layout).find((g) => g.id === hit.parent!.id)?.path ?? hit.parent.label;
}

// True if `maybeChild` is `groupId` itself or anywhere inside it.
export function isInside(layout: MenuLayout, groupId: string, maybeChild: string): boolean {
  const g = findNode(layout.nodes, groupId)?.node;
  return Boolean(g && (g.id === maybeChild || (g.type === "group" && allNodeIds(g.children).includes(maybeChild))));
}

// Moves a node (with everything inside it) to the end of `parentId`'s
// children, or of the main menu when parentId is null. Returns a new layout.
export function moveNode(layout: MenuLayout, id: string, parentId: string | null, index?: number): MenuLayout {
  if (parentId && isInside(layout, id, parentId)) return layout; // can't put a group inside itself
  const next = cloneLayout(layout);
  const hit = findNode(next.nodes, id);
  if (!hit) return layout;
  hit.siblings.splice(hit.index, 1);
  const target = parentId ? findNode(next.nodes, parentId)?.node : null;
  const list = target && target.type === "group" ? target.children : next.nodes;
  list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, hit.node);
  return next;
}

export function moveUpDown(layout: MenuLayout, id: string, dir: -1 | 1): MenuLayout {
  const next = cloneLayout(layout);
  const hit = findNode(next.nodes, id);
  if (!hit) return layout;
  const j = hit.index + dir;
  if (j < 0 || j >= hit.siblings.length) return layout;
  [hit.siblings[hit.index], hit.siblings[j]] = [hit.siblings[j], hit.siblings[hit.index]];
  return next;
}

export function addGroup(layout: MenuLayout, parentId: string | null, label: string, icon: string): { layout: MenuLayout; id: string } {
  const next = cloneLayout(layout);
  const id = `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const node: MenuGroupNode = { type: "group", id, label: label.trim().slice(0, 40), icon, children: [] };
  const target = parentId ? findNode(next.nodes, parentId)?.node : null;
  (target && target.type === "group" ? target.children : next.nodes).push(node);
  return { layout: next, id };
}

export function addSection(layout: MenuLayout, label: string): MenuLayout {
  const next = cloneLayout(layout);
  next.nodes.push({ type: "section", id: `s_${Date.now().toString(36)}`, label: label.trim().slice(0, 40) });
  return next;
}

// Removes a group or section; a group's contents move up to where it was,
// so nothing inside it is lost.
export function removeNode(layout: MenuLayout, id: string): MenuLayout {
  const next = cloneLayout(layout);
  const hit = findNode(next.nodes, id);
  if (!hit || hit.node.type === "item") return layout;
  const inner = hit.node.type === "group" ? hit.node.children : [];
  hit.siblings.splice(hit.index, 1, ...inner);
  return next;
}

export function updateNode(layout: MenuLayout, id: string, patch: { label?: string; icon?: string }): MenuLayout {
  const next = cloneLayout(layout);
  const n = findNode(next.nodes, id)?.node;
  if (!n || n.type === "item") return layout;
  if (patch.label !== undefined) n.label = patch.label.slice(0, 40);
  if (patch.icon !== undefined && n.type === "group") n.icon = patch.icon;
  return next;
}

// The layout to show: the saved one (or the default), with any known item
// that isn't in it yet put back at its default spot, and duplicates dropped.
export function mergeLayout(saved: MenuLayout | null | undefined, knownItemIds: string[]): MenuLayout {
  const layout = saved && saved.version === 1 && Array.isArray(saved.nodes) ? cloneLayout(saved) : cloneLayout(DEFAULT_LAYOUT);

  const seen = new Set<string>();
  const dedupe = (list: MenuNode[]): MenuNode[] => list.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    if (n.type === "group") n.children = dedupe(n.children);
    return true;
  });
  layout.nodes = dedupe(layout.nodes);

  for (const id of knownItemIds) {
    if (seen.has(id)) continue;
    const spot = defaultSpot(id);
    const parent = spot?.parent ? findNode(layout.nodes, spot.parent)?.node : null;
    const list = parent && parent.type === "group" ? parent.children : layout.nodes;
    // Before the first sibling that comes after it in the default menu.
    let at = list.length;
    if (spot) {
      const i = list.findIndex((n) => {
        const s = defaultSpot(n.id);
        return s !== null && s.order > spot.order;
      });
      if (i >= 0) at = i;
    }
    list.splice(at, 0, { type: "item", id });
    seen.add(id);
  }
  return layout;
}

// Puts the given items (one process can have several links, e.g. Standby +
// Call-Out) where the admin chose when activating it.
export type Placement =
  | { kind: "keep" }
  | { kind: "main" }
  | { kind: "group"; groupId: string }
  | { kind: "new-group"; label: string; icon: string; parentId: string | null };

export function applyPlacement(layout: MenuLayout, itemIds: string[], placement: Placement): MenuLayout {
  if (placement.kind === "keep") return layout;
  let next = mergeLayout(layout, itemIds);
  let target: string | null = null;
  if (placement.kind === "group") target = placement.groupId;
  if (placement.kind === "new-group") {
    const added = addGroup(next, placement.parentId, placement.label, placement.icon);
    next = added.layout;
    target = added.id;
  }
  for (const id of itemIds) next = moveNode(next, id, target);
  return next;
}
