import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDown, ArrowUp, FolderPlus, ListTree, RotateCcw, Save, SeparatorHorizontal, Trash2 } from "lucide-react";
import { api } from "../api";
import { showNotice, confirmAction } from "../alerts";
import {
  DEFAULT_LAYOUT, addGroup, addSection, cloneLayout, isInside, listGroups, mergeLayout, moveNode, moveUpDown,
  removeNode, updateNode, type MenuLayout, type MenuNode
} from "./menuModel";
import { GROUP_ICONS, groupIcon } from "./menuIcons";

type ItemInfo = { label: string; icon: LucideIcon; visible: boolean };

// Settings > Menu (admins): arrange the sidebar for everyone. Only WHERE
// links sit is set here - who sees each link still follows permissions and
// whether its process is active.
export default function MenuEditor({ layout, items, onSaved }: {
  layout: MenuLayout;
  items: Record<string, ItemInfo>;
  onSaved: (layout: MenuLayout | null) => void;
}) {
  const [draft, setDraft] = useState<MenuLayout>(() => cloneLayout(layout));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newGroup, setNewGroup] = useState<{ label: string; icon: string; parentId: string } | null>(null);

  // Pick up the live layout when nothing has been changed here yet.
  useEffect(() => { if (!dirty) setDraft(cloneLayout(layout)); }, [layout, dirty]);

  const groups = useMemo(() => listGroups(draft), [draft]);
  const change = (next: MenuLayout) => { setDraft(next); setDirty(true); };

  async function save() {
    setSaving(true);
    try {
      await api.saveMenuLayout(draft);
      onSaved(draft);
      setDirty(false);
      void showNotice("Menu saved. Everyone sees the new arrangement the next time their page loads.");
    } catch (e: any) {
      void showNotice(e?.message || "Could not save the menu");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    const ok = await confirmAction({ title: "Reset the menu to the default?", text: "Every link and group goes back to where it was originally. Groups you created are removed (their links return to their default places)." });
    if (!ok) return;
    setSaving(true);
    try {
      await api.saveMenuLayout(null);
      onSaved(null);
      setDraft(mergeLayout(DEFAULT_LAYOUT, Object.keys(items)));
      setDirty(false);
    } catch (e: any) {
      void showNotice(e?.message || "Could not reset the menu");
    } finally {
      setSaving(false);
    }
  }

  function createGroup() {
    if (!newGroup || !newGroup.label.trim()) { void showNotice("Give the group a name."); return; }
    change(addGroup(draft, newGroup.parentId || null, newGroup.label, newGroup.icon).layout);
    setNewGroup(null);
  }

  async function deleteGroup(n: MenuNode) {
    if (n.type === "group" && n.children.length) {
      const ok = await confirmAction({ title: `Remove the "${n.label}" group?`, text: "Its links and groups move up to where the group was - nothing is removed from the menu." });
      if (!ok) return;
    }
    change(removeNode(draft, n.id));
  }

  const btn = (title: string, Icon: LucideIcon, onClick: () => void, disabled = false) => (
    <button type="button" className="ep-icon-btn" title={title} aria-label={title} disabled={disabled} onClick={onClick}><Icon size={14} /></button>
  );

  const moveTo = (n: MenuNode, parentId: string | null) => (
    <select
      className="ep-select"
      style={{ fontSize: 12, padding: "3px 6px", maxWidth: 210 }}
      value={parentId ?? ""}
      onChange={(e) => change(moveNode(draft, n.id, e.target.value || null))}
      title="Move to"
    >
      <option value="">Main menu</option>
      {groups
        .filter((g) => !(n.type === "group" && isInside(draft, n.id, g.id)))
        .map((g) => <option key={g.id} value={g.id}>{"  ".repeat(g.depth)}{g.path}</option>)}
    </select>
  );

  const rows = (nodes: MenuNode[], depth: number, parentId: string | null): ReactElement[] => nodes.flatMap((n, i) => {
    const first = i === 0;
    const last = i === nodes.length - 1;
    const indent = { paddingLeft: 12 + depth * 24 };
    const controls = (
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
        {btn("Move up", ArrowUp, () => change(moveUpDown(draft, n.id, -1)), first)}
        {btn("Move down", ArrowDown, () => change(moveUpDown(draft, n.id, 1)), last)}
        {n.type !== "section" && moveTo(n, parentId)}
        {n.type !== "item" && btn(n.type === "group" ? "Remove group (keeps its links)" : "Remove label", Trash2, () => void deleteGroup(n))}
      </div>
    );
    const rowStyle = { display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", borderBottom: "1px solid var(--border)", ...indent };

    if (n.type === "section") {
      return [
        <div key={n.id} style={{ ...rowStyle, background: "var(--surface-soft)" }}>
          <SeparatorHorizontal size={14} style={{ color: "var(--muted)" }} />
          <input className="ep-form-input" style={{ flex: 1, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }} value={n.label}
            onChange={(e) => change(updateNode(draft, n.id, { label: e.target.value }))} aria-label="Section label" />
          {controls}
        </div>
      ];
    }
    if (n.type === "group") {
      const Icon = groupIcon(n.icon);
      return [
        <div key={n.id} style={{ ...rowStyle, background: "var(--surface-soft)" }}>
          <Icon size={16} />
          <input className="ep-form-input" style={{ flex: 1, fontWeight: 700, fontSize: 13 }} value={n.label}
            onChange={(e) => change(updateNode(draft, n.id, { label: e.target.value }))} aria-label="Group name" />
          <select className="ep-select" style={{ fontSize: 12, padding: "3px 6px" }} value={n.icon} title="Group icon"
            onChange={(e) => change(updateNode(draft, n.id, { icon: e.target.value }))}>
            {Object.keys(GROUP_ICONS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          {controls}
        </div>,
        ...(n.children.length
          ? rows(n.children, depth + 1, n.id)
          : [<div key={`${n.id}-empty`} style={{ padding: "6px 12px", paddingLeft: 12 + (depth + 1) * 24, fontSize: 12, color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>Empty - move links here with "Move to". Empty groups don't show in the menu.</div>])
      ];
    }
    const info = items[n.id];
    const Icon = info?.icon ?? ListTree;
    return [
      <div key={n.id} style={rowStyle}>
        <Icon size={15} style={{ opacity: info ? 1 : 0.4 }} />
        <span style={{ flex: 1, fontSize: 13, opacity: info ? 1 : 0.55 }}>
          {info?.label ?? "(not available now)"}
          {info && !info.visible && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>hidden for you (permission or inactive)</span>}
          {!info && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>e.g. a deactivated process - keeps its place for when it's back</span>}
        </span>
        {controls}
      </div>
    ];
  });

  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Menu</h1>
          <p className="ep-subtitle">Arrange the sidebar for everyone: order, groups and groups inside groups. Who sees each link still follows Roles &amp; Permissions and whether its process is active - a group only shows when something inside it is visible.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => setNewGroup({ label: "", icon: "Folder", parentId: "" })}><FolderPlus size={14} /> New group</button>
          <button className="ep-btn-outline" onClick={() => change(addSection(draft, "New section"))}><SeparatorHorizontal size={14} /> New section label</button>
          <button className="ep-btn-outline" onClick={() => void resetToDefault()} disabled={saving}><RotateCcw size={14} /> Reset to default</button>
          <button className="ep-btn" onClick={() => void save()} disabled={!dirty || saving}><Save size={14} /> {saving ? "Saving…" : "Save menu"}</button>
        </div>
      </div>

      {newGroup && (
        <div className="ep-panel" style={{ padding: 14, marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <strong style={{ fontSize: 13 }}>New group</strong>
          <input className="ep-form-input" autoFocus placeholder="Group name (e.g. Facilities)" maxLength={40} value={newGroup.label}
            onChange={(e) => setNewGroup({ ...newGroup, label: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") createGroup(); }} />
          <select className="ep-select" value={newGroup.icon} onChange={(e) => setNewGroup({ ...newGroup, icon: e.target.value })} title="Icon">
            {Object.keys(GROUP_ICONS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select className="ep-select" value={newGroup.parentId} onChange={(e) => setNewGroup({ ...newGroup, parentId: e.target.value })} title="Where">
            <option value="">In the main menu</option>
            {groups.map((g) => <option key={g.id} value={g.id}>Inside {g.path}</option>)}
          </select>
          <button className="ep-btn" onClick={createGroup}>Add group</button>
          <button className="ep-btn-outline" onClick={() => setNewGroup(null)}>Cancel</button>
        </div>
      )}

      {dirty && <div style={{ fontSize: 12, color: "#92400e", marginBottom: 8 }}>Unsaved changes - press Save menu to apply them for everyone.</div>}
      <div className="ep-panel" style={{ padding: 0 }}>{rows(draft.nodes, 0, null)}</div>
    </div>
  );
}
