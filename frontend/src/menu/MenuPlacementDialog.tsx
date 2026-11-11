import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../api";
import { applyPlacement, listGroups, locationOf, mergeLayout, type MenuLayout, type Placement } from "./menuModel";
import { GROUP_ICONS } from "./menuIcons";

// Asked when a process is activated on the Process page: where its link(s)
// go in the sidebar - keep the current place, the main menu, an existing
// group (any depth), or a new group (in the main menu or inside a group).
export default function MenuPlacementDialog({ title, itemIds, onClose, onSaved }: {
  title: string;
  itemIds: string[];
  onClose: () => void;
  onSaved: (layout: MenuLayout) => void;
}) {
  const [layout, setLayout] = useState<MenuLayout | null>(null);
  const [kind, setKind] = useState<Placement["kind"]>("keep");
  const [groupId, setGroupId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newIcon, setNewIcon] = useState("Folder");
  const [newParent, setNewParent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.menuLayout()
      .then((r: any) => setLayout(mergeLayout(r?.layout ?? null, itemIds)))
      .catch(() => setLayout(mergeLayout(null, itemIds)));
  }, [itemIds.join(",")]);

  if (!layout) return null;
  const groups = listGroups(layout);
  const where = locationOf(layout, itemIds[0]);

  async function confirm() {
    if (!layout) return;
    let placement: Placement;
    if (kind === "group") {
      if (!groupId) { setError("Choose a group."); return; }
      placement = { kind, groupId };
    } else if (kind === "new-group") {
      if (!newLabel.trim()) { setError("Give the new group a name."); return; }
      placement = { kind, label: newLabel, icon: newIcon, parentId: newParent || null };
    } else {
      placement = { kind } as Placement;
    }
    if (placement.kind === "keep") { onClose(); return; }
    setSaving(true);
    try {
      const next = applyPlacement(layout, itemIds, placement);
      await api.saveMenuLayout(next);
      onSaved(next);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Could not save the menu");
    } finally {
      setSaving(false);
    }
  }

  const radio = (value: Placement["kind"], label: string) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: kind === value ? 700 : 500, cursor: "pointer" }}>
      <input type="radio" name="menu-placement" checked={kind === value} onChange={() => { setKind(value); setError(null); }} />
      {label}
    </label>
  );

  return (
    <div className="ep-modal-overlay" onClick={onClose}>
      <div className="ep-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="ep-modal-head">
          <div>
            <h2 className="ep-modal-title">Where should {title} appear in the menu?</h2>
            <p className="ep-modal-sub">Now: {where}. You can rearrange everything later in Settings &gt; Menu.</p>
          </div>
          <button className="ep-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="ep-modal-body" style={{ display: "grid", gap: 12 }}>
          {radio("keep", `Keep it where it is (${where})`)}
          {radio("main", "Main menu (its own link at the top level)")}
          {radio("group", "Inside an existing group")}
          {kind === "group" && (
            <select className="ep-form-select" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ marginLeft: 26 }}>
              <option value="">Choose a group…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.path}</option>)}
            </select>
          )}
          {radio("new-group", "In a new group")}
          {kind === "new-group" && (
            <div style={{ display: "grid", gap: 8, marginLeft: 26 }}>
              <input className="ep-form-input" placeholder="Group name (e.g. Facilities)" maxLength={40} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} autoFocus />
              <div style={{ display: "flex", gap: 8 }}>
                <select className="ep-form-select" value={newIcon} onChange={(e) => setNewIcon(e.target.value)} title="Icon">
                  {Object.keys(GROUP_ICONS).map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <select className="ep-form-select" value={newParent} onChange={(e) => setNewParent(e.target.value)} title="Where the new group goes">
                  <option value="">In the main menu</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>Inside {g.path}</option>)}
                </select>
              </div>
            </div>
          )}
          {error && <div style={{ color: "#dc2626", fontSize: 12 }}>{error}</div>}
        </div>
        <div className="ep-modal-footer">
          <button className="ep-btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="ep-btn" onClick={() => void confirm()} disabled={saving}>{saving ? "Saving…" : "Done"}</button>
        </div>
      </div>
    </div>
  );
}
