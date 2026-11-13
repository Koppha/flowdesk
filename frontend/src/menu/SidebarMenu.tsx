import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { menuTipFor, type MenuTip } from "./menuTips";
import type { LucideIcon } from "lucide-react";
import { ChevronDown } from "lucide-react";
import type { MenuGroupNode, MenuLayout, MenuNode } from "./menuModel";
import { groupIcon } from "./menuIcons";

// One sidebar link. Its show/hide rule (permissions, module on/off) lives
// here, in code - the layout only decides where it sits.
export type MenuItemDef = {
  label: string;
  icon: LucideIcon;
  visible: boolean;
  active: boolean;
  onClick: () => void;
  // Shown on the link (a pill at the top level, a chip inside a group).
  badge?: number;
  // Added to the enclosing groups' header total (default: badge).
  groupCount?: number;
  // Whether being on this link's page opens/highlights its groups
  // (default: active). Finance's "Reports" shortcut sets false, so Finance
  // doesn't spring open on every report page.
  groupActive?: boolean;
};

type Props = {
  layout: MenuLayout;
  items: Record<string, MenuItemDef>;
  navItemClass: (active: boolean) => string;
  groupOpen: (key: string, inGroup: boolean) => boolean;
  toggleGroup: (key: string, inGroup: boolean) => void;
  // Extra "you're inside this group" signals for pages with no link of their
  // own (e.g. the report pages reached from the Reports hub).
  groupExtraActive: Record<string, boolean>;
  onOpenPage: (page: string) => void;
};

type Stat = { visible: boolean; active: boolean; count: number; leaves: string[]; subgroups: number };

export default function SidebarMenu({ layout, items, navItemClass, groupOpen, toggleGroup, groupExtraActive, onOpenPage }: Props) {
  // Hover tips: what a page is for, shown beside the link after a short pause
  // (not on phones, where the menu is a drawer).
  const [tip, setTip] = useState<{ tip: MenuTip; rect: DOMRect } | null>(null);
  const tipTimer = useRef<number | null>(null);
  const clearTip = () => { if (tipTimer.current) window.clearTimeout(tipTimer.current); tipTimer.current = null; };
  const showTip = (id: string, label: string) => (e: { currentTarget: HTMLElement }) => {
    const t = menuTipFor(id, label);
    clearTip();
    if (!t || window.innerWidth < 760) return;
    const el = e.currentTarget;
    tipTimer.current = window.setTimeout(() => setTip({ tip: t, rect: el.getBoundingClientRect() }), 350);
  };
  const hideTip = () => { clearTip(); setTip(null); };
  useEffect(() => {
    if (!tip) return;
    window.addEventListener("scroll", hideTip, true);
    return () => window.removeEventListener("scroll", hideTip, true);
  }, [tip]);
  useEffect(() => () => clearTip(), []);

  // What each node contains that this user can see - computed bottom-up so a
  // group is only drawn when something inside it is visible.
  const stats = new Map<string, Stat>();
  const stat = (n: MenuNode): Stat => {
    const cached = stats.get(n.id);
    if (cached) return cached;
    let s: Stat;
    if (n.type === "item") {
      const d = items[n.id];
      const visible = Boolean(d?.visible);
      s = {
        visible,
        active: visible && Boolean(d.groupActive ?? d.active),
        count: visible ? (d.groupCount ?? d.badge ?? 0) : 0,
        leaves: visible ? [n.id] : [],
        subgroups: 0
      };
    } else if (n.type === "group") {
      const kids = n.children.map(stat);
      s = {
        visible: kids.some((k) => k.visible),
        active: kids.some((k) => k.active) || Boolean(groupExtraActive[n.id]),
        count: kids.reduce((sum, k) => sum + k.count, 0),
        leaves: kids.flatMap((k) => k.leaves),
        subgroups: n.children.filter((c) => c.type === "group" && stat(c).visible).length
      };
    } else {
      s = { visible: true, active: false, count: 0, leaves: [], subgroups: 0 };
    }
    stats.set(n.id, s);
    return s;
  };

  const link = (key: string, depth: number, Icon: LucideIcon, label: string, active: boolean, onClick: () => void, badge?: number, trailing?: ReactNode) => (
    <a key={key} href="#" className={navItemClass(active)} onClick={(e) => { e.preventDefault(); hideTip(); onClick(); }}
      onMouseEnter={showTip(key, label)} onMouseLeave={hideTip} onFocus={showTip(key, label)} onBlur={hideTip}>
      {depth === 0 ? <span className="sidebar-nav-icon"><Icon size={18} aria-hidden /></span> : <Icon size={14} aria-hidden />}
      {label}
      {badge !== undefined && (depth === 0 ? <b>{badge}</b> : <span className="inbox-count-chip">{badge}</span>)}
      {trailing}
    </a>
  );

  const renderGroup = (g: MenuGroupNode, depth: number): ReactNode => {
    const s = stat(g);
    if (!s.visible) return null;
    const Icon = groupIcon(g.icon);
    // Built-in Settings with only "General" visible: one plain link, as before.
    if (g.flattenIfSingle && s.leaves.length === 1 && s.subgroups === 0) {
      const only = items[s.leaves[0]];
      return link(g.id, depth, Icon, g.label, only.active, only.onClick);
    }
    const open = groupOpen(g.id, s.active);
    const onHeader = () => {
      if (g.page && !s.active) onOpenPage(g.page);
      else toggleGroup(g.id, s.active);
    };
    const total = s.count > 0 ? s.count : undefined;
    return (
      <div key={g.id} className={`sidebar-group ${open ? "open" : ""}`}>
        {link(`${g.id}-header`, depth, Icon, g.label, s.active, onHeader, total, <strong><ChevronDown size={depth === 0 ? 14 : 12} aria-hidden /></strong>)}
        <div className="sidebar-subnav">{g.children.map((c) => render(c, depth + 1))}</div>
      </div>
    );
  };

  const render = (n: MenuNode, depth: number): ReactNode => {
    if (n.type === "section") return depth === 0 ? <div key={n.id} className="sidebar-section-label">{n.label}</div> : null;
    if (n.type === "group") return renderGroup(n, depth);
    const d = items[n.id];
    if (!d?.visible) return null;
    return link(n.id, depth, d.icon, d.label, d.active, d.onClick, d.badge);
  };

  const tipCard = tip && createPortal(
    <div role="tooltip" style={{
      position: "fixed", zIndex: 2500, left: tip.rect.right + 10, top: Math.max(8, Math.min(tip.rect.top - 6, window.innerHeight - 230)),
      width: 300, background: "var(--surface, #fff)", color: "var(--text, #111827)", border: "1px solid var(--border, #e5e7eb)",
      borderRadius: 12, boxShadow: "0 14px 34px rgba(0,0,0,.18)", padding: "12px 14px", pointerEvents: "none", fontSize: 12.5, lineHeight: 1.45
    }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{tip.tip.title}</div>
      <div style={{ color: "var(--muted, #6b7280)", marginBottom: 6 }}>{tip.tip.text}</div>
      <ul style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 3 }}>
        {tip.tip.points.map((p) => <li key={p}>{p}</li>)}
      </ul>
    </div>,
    document.body
  );

  return <>{layout.nodes.map((n) => render(n, 0))}{tipCard}</>;
}
