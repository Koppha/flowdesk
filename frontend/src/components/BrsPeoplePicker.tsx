import { useState } from "react";
import { Plus } from "lucide-react";
import { ApproverCombobox, type DirectoryUser } from "../shared/ApproverCombobox";
import OrgSearchModal, { OrgEntryChip, orgEntryKey, type OrgEntry } from "./OrgSearchModal";

// Owner (full rights, same as the creator) and co-writers for a BRS - used
// on the "Open a new BRS" form and on the document itself. The creator/owner
// grants each co-writer exactly what they may do.

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
  ownerId: string;
  onOwnerChange: (id: string) => void;
  coWriters: OrgEntry[];
  onCoWritersChange: (entries: OrgEntry[]) => void;
  excludeIds?: string[];
}) {
  const { users, ownerId, onOwnerChange, coWriters, onCoWritersChange, excludeIds = [] } = props;
  const [searching, setSearching] = useState(false);
  const coWriterUserIds = coWriters.filter((c) => c.type === "user").map((c) => c.id);
  const ownerOptions = users.filter((u) => !excludeIds.includes(u.id) && !coWriterUserIds.includes(u.id));

  return (
    <div className="ep-form-row">
      <div className="ep-form-group">
        <label>Owner <span style={{ fontWeight: 400, color: "var(--muted)" }}>— full rights, same as the creator</span></label>
        <ApproverCombobox
          users={ownerOptions}
          value={ownerId}
          onChange={onOwnerChange}
          placeholder="Search the product owner by name or email…"
        />
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
          Full access gives a co-writer the same capabilities as the creator and owner — only the creator and owner can change permissions or remove people.
        </div>
      </div>
      {searching && (
        <OrgSearchModal
          title="Add co-writers"
          subtitle="Search and select employees, or a whole division, department or section — everyone in a group can edit."
          people={users.filter((u) => !excludeIds.includes(u.id) && u.id !== ownerId)}
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
  APPROVER: "Approver",
  ADMIN: "Admin",
  OTHER: "Other"
};
const ROLE_STYLE: Record<string, [string, string]> = {
  CREATOR: ["#dbeafe", "#1d4ed8"],
  OWNER: ["#ede9fe", "#6d28d9"],
  CO_WRITER: ["#d1fae5", "#065f46"],
  CONTRIBUTOR: ["#fef3c7", "#92400e"],
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
