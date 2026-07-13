/**
 * Reusable modal for searching and selecting an existing user.
 * Used by EXCO, Manager, and CEO onboarding flows.
 */
import React, { useState } from "react";
import { Search, X } from "lucide-react";
import { ROLE_LABELS } from "./roles";

export type PickableUser = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no?: string | null;
  title?: string | null;
  department?: string | null;
  division_name?: string | null;
  role?: string | null;
  is_active?: boolean;
};

type Props = {
  title: string;
  subtitle?: string;
  users: PickableUser[];
  /** Roles to exclude from the candidate list (e.g. already-assigned) */
  excludeRoles?: string[];
  /** Specific user IDs to exclude */
  excludeIds?: string[];
  onSelect: (user: PickableUser) => void;
  onClose: () => void;
  saving?: boolean;
  saveLabel?: string;
  /** Text shown under the selected user (e.g. "will be assigned a new role"). Pass false to hide it. */
  selectedNote?: string | false;
  /** Extra content rendered below the selected-user info (e.g. dept picker) */
  extra?: React.ReactNode;
};

function initials(name: string | null | undefined) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("") || "?";
}

export default function UserPicker({
  title,
  subtitle,
  users,
  excludeRoles = ["ADMIN"],
  excludeIds = [],
  onSelect,
  onClose,
  saving = false,
  saveLabel = "Assign",
  selectedNote = "will be assigned a new role.",
  extra,
}: Props) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const candidates = users.filter((u) => {
    if (u.is_active === false) return false;
    if (excludeRoles.includes(u.role ?? "")) return false;
    if (excludeIds.includes(u.id)) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (u.full_name ?? "").toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.employee_no ?? "").toLowerCase().includes(q) ||
      (u.department ?? "").toLowerCase().includes(q)
    );
  });

  const selected = candidates.find((u) => u.id === selectedId) ?? null;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--surface)", borderRadius: 12, padding: 24, width: 520, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,0.25)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div style={{ position: "relative", marginBottom: 10 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
          <input
            autoFocus
            placeholder="Search by name, email, employee number, department…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", paddingLeft: 32, paddingRight: 10, paddingTop: 8, paddingBottom: 8, border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", fontSize: 13, boxSizing: "border-box" }}
          />
          {search && (
            <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 0 }}>
              <X size={13} />
            </button>
          )}
        </div>

        {/* Candidate list */}
        <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, minHeight: 160, maxHeight: 300 }}>
          {candidates.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
              {search ? "No users match your search." : "No eligible users found."}
            </div>
          ) : (
            candidates.map((u) => {
              const isSelected = u.id === selectedId;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setSelectedId(u.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 12px",
                    border: "none",
                    borderBottom: "1px solid var(--border)",
                    background: isSelected ? "#eff6ff" : "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.1s",
                  }}
                >
                  {/* Radio indicator */}
                  <span style={{
                    width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
                    border: isSelected ? "5px solid #3b82f6" : "2px solid var(--border)",
                    background: isSelected ? "#fff" : "transparent",
                    transition: "border 0.1s",
                  }} />

                  {/* Avatar */}
                  <span style={{
                    width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                    background: "linear-gradient(135deg,#3b82f6,#6366f1)",
                    color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                    fontWeight: 700, fontSize: 12,
                  }}>
                    {initials(u.full_name)}
                  </span>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {u.full_name || u.email}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {u.email}
                      {u.employee_no ? ` · ${u.employee_no}` : ""}
                      {u.department ? ` · ${u.department}` : ""}
                    </div>
                  </div>

                  {/* Current role badge */}
                  <span style={{
                    flexShrink: 0, fontSize: 11, padding: "2px 7px", borderRadius: 99,
                    background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0",
                  }}>
                    {ROLE_LABELS[u.role ?? ""] ?? u.role ?? "Employee"}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Selected user summary */}
        {selected && selectedNote !== false && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, fontSize: 13, color: "#1e40af" }}>
            <strong>{selected.full_name || selected.email}</strong> {selectedNote}
            {selected.role && selected.role !== "EMPLOYEE" && (
              <span style={{ marginLeft: 6, opacity: 0.75 }}>(currently: {ROLE_LABELS[selected.role] ?? selected.role})</span>
            )}
          </div>
        )}

        {/* Extra content (e.g. department picker) */}
        {selected && extra && (
          <div style={{ marginTop: 10 }}>
            {extra}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} disabled={saving} style={{ padding: "7px 16px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>
            Cancel
          </button>
          <button
            onClick={() => selected && onSelect(selected)}
            disabled={!selected || saving}
            style={{ padding: "7px 16px", background: selected ? "#1d4ed8" : "#93c5fd", color: "#fff", border: "none", borderRadius: 6, cursor: selected ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 500 }}
          >
            {saving ? "Saving…" : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
