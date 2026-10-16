import { useState } from "react";
import { Plus, X } from "lucide-react";
import { ApproverCombobox, type DirectoryUser } from "../shared/ApproverCombobox";
import OrgSearchModal, { OrgEntryChip, orgEntryKey, type OrgEntry } from "./OrgSearchModal";

// Owners (any number, full rights, same as the creator) and co-writers for a
// BRS - used on the "Open a new BRS" form and on the document itself. The
// creator/owners grant each co-writer exactly what they may do. Making a
// co-writer an owner moves them from co-writers to owners.

export const BRS_PERMISSION_OPTIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: "EDIT", label: "Edit content", hint: "Edit sections and Intake" },
  { key: "INVITE", label: "Invite collaborators", hint: "Invite people or groups onto sections" },
  { key: "WORKFLOW", label: "Send on & route for approval", hint: "Move it through Draft to Gate, route it for approval, reopen it" },
  { key: "DISTRIBUTE", label: "Distribute", hint: "Distribute the approved BRS" },
  { key: "AMEND", label: "Amend", hint: "Start an amendment after approval" }
];
const PRESETS: Array<{ key: string; label: string; perms: string[] }> = [
  { key: "VIEW", label: "View only", perms: [] },
  { key: "EDIT", label: "Can edit", perms: ["EDIT"] },
  { key: "EDIT_INVITE", label: "Can edit & invite", perms: ["EDIT", "INVITE"] },
  { key: "FULL", label: "Full access", perms: ["EDIT", "INVITE", "WORKFLOW", "DISTRIBUTE", "AMEND"] }
];
function presetOf(perms: string[]) {
  const sorted = [...perms].sort().join(",");
  return PRESETS.find((p) => [...p.perms].sort().join(",") === sorted)?.key ?? "CUSTOM";
}
export function describeBrsPermissions(perms: string[]) {
  const preset = PRESETS.find((p) => p.key === presetOf(perms));
  if (preset) return preset.label;
  return BRS_PERMISSION_OPTIONS.filter((o) => perms.includes(o.key)).map((o) => o.label).join(", ");
}

export function BrsPeoplePicker(props: {
  users: DirectoryUser[];
  ownerIds: string[];
  onOwnersChange: (ids: string[]) => void;
  coWriters: OrgEntry[];
  onCoWritersChange: (entries: OrgEntry[]) => void;
  excludeIds?: string[];
}) {
  const { users, ownerIds, onOwnersChange, coWriters, onCoWritersChange, excludeIds = [] } = props;
  const [searching, setSearching] = useState(false);
  const [ownerPick, setOwnerPick] = useState("");
  const ownerOptions = users.filter((u) => !excludeIds.includes(u.id) && !ownerIds.includes(u.id));
  const coWriterUserIds = new Set(coWriters.filter((c) => c.type === "user").map((c) => c.id));

  function addOwner(id: string) {
    setOwnerPick("");
    if (!id || ownerIds.includes(id)) return;
    onOwnersChange([...ownerIds, id]);
    // An owner already has full rights - take them off the co-writers list.
    if (coWriterUserIds.has(id)) onCoWritersChange(coWriters.filter((c) => !(c.type === "user" && c.id === id)));
  }

  return (
    <div className="ep-form-row">
      <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}>
        <label>Owners <span style={{ fontWeight: 400, color: "var(--muted)" }}>— full rights, same as the creator; add as many as needed</span></label>
        {ownerIds.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            {ownerIds.map((id) => {
              const u = users.find((x) => x.id === id);
              return (
                <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 10px", borderRadius: 99, background: "#ede9fe", color: "#6d28d9", fontSize: 12.5, fontWeight: 600 }}>
                  {u?.full_name || u?.email || "Unknown user"}
                  <button type="button" aria-label={`Remove ${u?.full_name || "owner"}`} onClick={() => onOwnersChange(ownerIds.filter((x) => x !== id))}
                    style={{ border: "none", background: "transparent", cursor: "pointer", color: "inherit", display: "inline-flex", padding: 0 }}><X size={13} /></button>
                </span>
              );
            })}
          </div>
        )}
        <ApproverCombobox
          users={ownerOptions}
          value={ownerPick}
          onChange={addOwner}
          placeholder={ownerIds.length ? "Add another owner…" : "Search an owner by name or email…"}
        />
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>A co-writer can be made an owner too — they move from co-writers to owners.</div>
      </div>
      <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}>
        <label>Co-writers <span style={{ fontWeight: 400, color: "var(--muted)" }}>— people or whole groups; choose what each may do</span></label>
        {coWriters.length > 0 && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8 }}>
            {coWriters.map((c) => {
              const perms = c.permissions ?? ["EDIT"];
              const setPerms = (next: string[]) => onCoWritersChange(coWriters.map((x) => (orgEntryKey(x) === orgEntryKey(c) ? { ...x, permissions: next } : x)));
              const preset = presetOf(perms);
              return (
                <div key={orgEntryKey(c)} style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <OrgEntryChip entry={c} />
                    <select
                      className="ep-form-select"
                      style={{ width: "auto", fontSize: 12.5, padding: "4px 8px" }}
                      value={preset}
                      onChange={(e) => { const p = PRESETS.find((x) => x.key === e.target.value); if (p) setPerms(p.perms); }}
                      aria-label="Permission level"
                    >
                      {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                      {preset === "CUSTOM" && <option value="CUSTOM">Custom</option>}
                    </select>
                    <button
                      type="button"
                      onClick={() => onCoWritersChange(coWriters.filter((x) => orgEntryKey(x) !== orgEntryKey(c)))}
                      style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 12 }}
                    >
                      Remove
                    </button>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 8 }}>
                    {BRS_PERMISSION_OPTIONS.map((o) => (
                      <label key={o.key} title={o.hint} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={perms.includes(o.key)}
                          onChange={(e) => setPerms(e.target.checked ? [...perms, o.key] : perms.filter((p) => p !== o.key))}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <button type="button" className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 10px", display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => setSearching(true)}>
          <Plus size={13} /> Add co-writers
        </button>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
          Full access gives a co-writer the same capabilities as the creator and owners — only the creator and owners can change permissions or remove people.
        </div>
      </div>
      {searching && (
        <OrgSearchModal
          title="Add co-writers"
          subtitle="Search and select employees, or a whole division, department or section — everyone in a group can edit."
          people={users.filter((u) => !excludeIds.includes(u.id) && !ownerIds.includes(u.id))}
          excludeKeys={coWriters.map(orgEntryKey)}
          onAdd={(entries) => onCoWritersChange([
            ...coWriters,
            ...entries.filter((e) => !coWriters.some((c) => orgEntryKey(c) === orgEntryKey(e))).map((e) => ({ ...e, permissions: e.permissions ?? ["EDIT"] }))
          ])}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  );
}

// A role badge for the audit trail / people list.
export const BRS_ROLE_LABEL: Record<string, string> = {
  CREATOR: "Creator",
  OWNER: "Owner",
  CO_WRITER: "Co-writer",
  CONTRIBUTOR: "Contributor",
  REVIEWER: "Reviewer",
  APPROVER: "Approver",
  ADMIN: "Admin",
  OTHER: "Other"
};
const ROLE_STYLE: Record<string, [string, string]> = {
  CREATOR: ["#dbeafe", "#1d4ed8"],
  OWNER: ["#ede9fe", "#6d28d9"],
  CO_WRITER: ["#d1fae5", "#065f46"],
  CONTRIBUTOR: ["#fef3c7", "#92400e"],
  REVIEWER: ["#e0f2fe", "#075985"],
  APPROVER: ["#fce7f3", "#9d174d"],
  ADMIN: ["#f1f5f9", "#334155"]
};
export function BrsRoleBadge({ role }: { role: string | null | undefined }) {
  if (!role) return null;
  const [bg, color] = ROLE_STYLE[role] || ["#f1f5f9", "#64748b"];
  return (
    <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>
      {BRS_ROLE_LABEL[role] || role}
    </span>
  );
}
