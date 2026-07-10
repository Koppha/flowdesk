import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { confirmAction } from "./alerts";
import { useEmploymentTypes, refreshEmploymentTypes, type EmploymentType } from "./useEmploymentTypes";
import {
  Edit3, Mail, Plus, RefreshCw, Search, Trash2, Users, X,
} from "lucide-react";
import OrgPicker, { type OrgSelection, orgSelectionFromUser } from "./OrgPicker";

// ─── Types ────────────────────────────────────────────────────────────────────

type UserRow = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  title: string | null;
  department: string | null;
  division_id: string | null;
  division_name: string | null;
  section_id: string | null;
  section_name: string | null;
  team_id: string | null;
  team_name: string | null;
  employment_type: string | null;
  role: string;
  groups: string[];
  is_active: boolean;
  profile_completed: boolean | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLES: { value: string; label: string; color: string; bg: string }[] = [
  { value: "EMPLOYEE",      label: "Employee",      color: "#1d4ed8", bg: "#dbeafe" },
  { value: "MANAGER",       label: "Manager",       color: "#0f766e", bg: "#ccfbf1" },
  { value: "HOD",           label: "HOD",           color: "#6d28d9", bg: "#ede9fe" },
  { value: "FINANCE",       label: "Finance",       color: "#166534", bg: "#dcfce7" },
  { value: "EXCO",          label: "EXCO",          color: "#7c3aed", bg: "#f3e8ff" },
  { value: "CEO",           label: "CEO",           color: "#be185d", bg: "#fce7f3" },
  { value: "ADMIN",         label: "Admin",         color: "#374151", bg: "#f3f4f6" },
];

const ROLE_MAP = Object.fromEntries(ROLES.map(r => [r.value, r]));


const EMPTY_ORG: OrgSelection = {
  divisionId: null, divisionName: null,
  department: null, departmentId: null,
  sectionId: null, sectionName: null,
  teamId: null, teamName: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function initials(name: string | null | undefined) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2)
    .map(p => p[0]?.toUpperCase() || "").join("") || "?";
}

function splitName(v: string | null | undefined) {
  const parts = String(v || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts.shift() || "", surname: parts.join(" ") };
}

function orgPath(u: UserRow) {
  return [u.division_name, u.department, u.section_name, u.team_name].filter(Boolean).join(" › ");
}

function RoleBadge({ role }: { role: string }) {
  const r = ROLE_MAP[role] ?? { label: role, color: "#6b7280", bg: "#f3f4f6" };
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99, color: r.color, background: r.bg, whiteSpace: "nowrap" }}>
      {r.label}
    </span>
  );
}

// ─── Field / label primitives ─────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", border: "1px solid var(--border)",
  borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)",
  fontSize: 13, boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "var(--muted)",
  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5, display: "block",
};

function Field({ label, children, span }: { label: string; children: React.ReactNode; span?: boolean }) {
  return (
    <div style={{ gridColumn: span ? "1 / -1" : undefined, display: "flex", flexDirection: "column" }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function UserManagement() {
  const empTypes = useEmploymentTypes();
  const [users, setUsers]     = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch]         = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [divFilter, setDivFilter]   = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");

  // Add modal
  const [showAdd, setShowAdd]   = useState(false);
  const [addFirst, setAddFirst] = useState("");
  const [addSurname, setAddSurname] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addEmpNo, setAddEmpNo] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addEmpType, setAddEmpType] = useState("PERMANENT");
  const [addRole, setAddRole]   = useState("EMPLOYEE");
  const [addActive, setAddActive] = useState(true);
  const [addOrg, setAddOrg]     = useState<OrgSelection>(EMPTY_ORG);
  const [addGroups, setAddGroups] = useState<string[]>([]);
  const [adding, setAdding]     = useState(false);

  // Edit modal
  const [editing, setEditing]       = useState<UserRow | null>(null);
  const [editFirst, setEditFirst]   = useState("");
  const [editSurname, setEditSurname] = useState("");
  const [editEmail, setEditEmail]   = useState("");
  const [editEmpNo, setEditEmpNo]   = useState("");
  const [editTitle, setEditTitle]   = useState("");
  const [editEmpType, setEditEmpType] = useState("PERMANENT");
  const [editRole, setEditRole]     = useState("EMPLOYEE");
  const [editActive, setEditActive] = useState(true);
  const [editOrg, setEditOrg]       = useState<OrgSelection>(EMPTY_ORG);
  const [editGroups, setEditGroups] = useState<string[]>([]);
  const [saving, setSaving]         = useState(false);

  // Permission groups (for membership assignment)
  const [availableGroups, setAvailableGroups] = useState<{ name: string; member_count: string; dynamic?: boolean }[]>([]);

  // ─── Load ─────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.adminUsers();
      setUsers(Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      alert("Error loading users: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const rows = await api.permissionGroups();
        setAvailableGroups(Array.isArray(rows) ? rows : []);
      } catch { /* ignore */ }
    })();
  }, []);

  // Populate edit form when a user is selected
  useEffect(() => {
    if (!editing) return;
    const { first, surname } = splitName(editing.full_name);
    setEditFirst(first);
    setEditSurname(surname);
    setEditEmail(editing.email);
    setEditEmpNo(editing.employee_no ?? "");
    setEditTitle(editing.title ?? "");
    setEditEmpType(editing.employment_type ?? "PERMANENT");
    setEditRole(editing.role ?? "EMPLOYEE");
    setEditActive(editing.is_active !== false);
    setEditOrg(orgSelectionFromUser(editing));
    setEditGroups(Array.isArray(editing.groups) ? editing.groups : []);
  }, [editing]);

  // ─── Derived ──────────────────────────────────────────────────────────────

  const q = search.trim().toLowerCase();

  const filtered = useMemo(() => users.filter(u => {
    if (roleFilter !== "ALL" && u.role !== roleFilter) return false;
    if (divFilter !== "ALL" && (u.division_name ?? "Unassigned") !== divFilter) return false;
    if (statusFilter === "ACTIVE" && !u.is_active) return false;
    if (statusFilter === "INACTIVE" && u.is_active) return false;
    if (!q) return true;
    return [u.full_name, u.email, u.employee_no, u.title, u.department, u.division_name, u.team_name]
      .some(v => (v ?? "").toLowerCase().includes(q));
  }), [users, roleFilter, divFilter, statusFilter, q]);

  const divisionNames = useMemo(() =>
    Array.from(new Set(users.map(u => u.division_name ?? "Unassigned"))).sort()
  , [users]);

  const stats = useMemo(() => ({
    total:    users.length,
    active:   users.filter(u => u.is_active).length,
    inactive: users.filter(u => !u.is_active).length,
    byRole:   ROLES.map(r => ({ ...r, count: users.filter(u => u.role === r.value).length })).filter(r => r.count > 0),
  }), [users]);

  // ─── Actions ──────────────────────────────────────────────────────────────

  function resetAddForm() {
    setAddFirst(""); setAddSurname(""); setAddEmail(""); setAddEmpNo("");
    setAddTitle(""); setAddEmpType("PERMANENT"); setAddRole("EMPLOYEE");
    setAddActive(true); setAddOrg(EMPTY_ORG); setAddGroups([]);
  }

  async function handleAdd() {
    if (!addFirst.trim() || !addSurname.trim()) { alert("First name and surname are required."); return; }
    if (!addEmail.trim()) { alert("Email is required."); return; }
    setAdding(true);
    try {
      await api.createUser({
        email:           addEmail.trim(),
        full_name:       `${addFirst.trim()} ${addSurname.trim()}`,
        employee_no:     addEmpNo.trim() || undefined,
        title:           addTitle.trim() || undefined,
        department:      addOrg.department || undefined,
        division_id:     addOrg.divisionId ?? null,
        section_id:      addOrg.sectionId  ?? null,
        team_id:         addOrg.teamId     ?? null,
        employment_type: addEmpType,
        role:            addRole,
        is_active:       addActive,
        groups:          addGroups,
      });
      resetAddForm();
      setShowAdd(false);
      await load();
    } catch (e: any) {
      alert("Error creating user: " + e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveEdit() {
    if (!editing) return;
    if (!editFirst.trim() || !editSurname.trim()) { alert("First name and surname are required."); return; }
    if (!editEmail.trim()) { alert("Email is required."); return; }
    setSaving(true);
    try {
      await api.updateUser(editing.id, {
        full_name:       `${editFirst.trim()} ${editSurname.trim()}`,
        email:           editEmail.trim(),
        employee_no:     editEmpNo.trim() || null,
        title:           editTitle.trim() || null,
        department:      editOrg.department || editing.department || null,
        division_id:     editOrg.divisionId  ?? null,
        section_id:      editOrg.sectionId   ?? null,
        team_id:         editOrg.teamId      ?? null,
        employment_type: editEmpType,
        is_active:       editActive,
        groups:          editGroups,
      });
      // Role change goes through its own endpoint
      if (editRole !== editing.role) {
        await api.updateUserRole(editing.id, { role: editRole });
      }
      setEditing(null);
      await load();
    } catch (e: any) {
      alert("Error saving user: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(u: UserRow) {
    const confirmed = await confirmAction({
      title: `Deactivate ${u.full_name || u.email}?`,
      text: "They will no longer be able to log in. This can be reversed by editing the user.",
      confirmButtonText: "Deactivate",
    });
    if (!confirmed) return;
    try {
      await api.deleteUser(u.id);
      await load();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  async function handleDeletePermanent(u: UserRow) {
    const confirmed = await confirmAction({
      title: `Permanently delete ${u.full_name || u.email}?`,
      text: "This removes the account completely and cannot be undone. It is blocked if the user has any requests, claims or approval history (deactivate those users instead).",
      confirmButtonText: "Delete permanently",
    });
    if (!confirmed) return;
    try {
      await api.deleteUserPermanent(u.id);
      await load();
    } catch (e: any) {
      alert(e.message || "Could not delete user.");
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24 }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Users size={22} color="#3b82f6" />
          <div>
            <div style={{ fontWeight: 700, fontSize: 20, color: "var(--text)" }}>User Management</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>
              {stats.total} users · {stats.active} active · {stats.inactive} inactive
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={load} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 13px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 13 }}>
            <RefreshCw size={13} style={{ animation: loading ? "spin 1s linear infinite" : undefined }} /> Refresh
          </button>
          <button onClick={() => { resetAddForm(); setShowAdd(true); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            <Plus size={14} /> Add User
          </button>
        </div>
      </div>

      {/* ── Stats ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          { label: "Total Users",   value: stats.total,    color: "#3b82f6" },
          { label: "Active",        value: stats.active,   color: "#16a34a" },
          { label: "Inactive",      value: stats.inactive, color: "#ef4444" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ flex: "1 1 120px", padding: "14px 18px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)", textAlign: "center" }}>
            <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{label}</div>
          </div>
        ))}
        {stats.byRole.slice(0, 5).map(r => (
          <div key={r.value} style={{ flex: "1 1 100px", padding: "14px 18px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)", textAlign: "center" }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: r.color }}>{r.count}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{r.label}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 220px" }}>
          <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none" }} />
          <input
            placeholder="Search name, email, emp no…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...fieldStyle, paddingLeft: 30 }}
          />
          {search && (
            <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 0, display: "flex" }}>
              <X size={12} />
            </button>
          )}
        </div>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} style={{ ...fieldStyle, width: "auto", minWidth: 140 }}>
          <option value="ALL">All Roles</option>
          {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        {divisionNames.length > 1 && (
          <select value={divFilter} onChange={e => setDivFilter(e.target.value)} style={{ ...fieldStyle, width: "auto", minWidth: 150 }}>
            <option value="ALL">All Companies</option>
            {divisionNames.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ ...fieldStyle, width: "auto", minWidth: 120 }}>
          <option value="ALL">All Statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
        <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
          {filtered.length} result{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Table ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        {loading && !users.length ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>
            {users.length === 0 ? "No users yet. Click Add User to create one." : "No users match the current filters."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-soft)", borderBottom: "2px solid var(--border)" }}>
                  {["User", "Role", "Org Path", "Emp Type", "Status", ""].map(h => (
                    <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(u => {
                  const isActive = u.is_active !== false;
                  return (
                    <tr
                      key={u.id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-soft)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}
                    >
                      {/* User cell */}
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{
                            width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                            background: isActive ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "#e5e7eb",
                            color: isActive ? "#fff" : "#9ca3af",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontWeight: 700, fontSize: 13,
                          }}>
                            {initials(u.full_name)}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: isActive ? "var(--text)" : "var(--muted)", whiteSpace: "nowrap" }}>
                              {u.full_name || <span style={{ color: "var(--muted)", fontStyle: "italic" }}>No name</span>}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4, marginTop: 1 }}>
                              <Mail size={10} />
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{u.email}</span>
                              {u.employee_no && <span style={{ color: "var(--border-strong, #94a3b8)" }}>· {u.employee_no}</span>}
                            </div>
                            {u.title && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{u.title}</div>}
                          </div>
                        </div>
                      </td>

                      {/* Role */}
                      <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                        <RoleBadge role={u.role} />
                      </td>

                      {/* Org Path */}
                      <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--muted)", maxWidth: 240 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                          {orgPath(u) || <span style={{ fontStyle: "italic" }}>Unassigned</span>}
                        </span>
                      </td>

                      {/* Emp Type */}
                      <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0", fontWeight: 500 }}>
                          {empTypes.find(t => t.code === u.employment_type)?.name ?? (u.employment_type || "Permanent")}
                        </span>
                      </td>

                      {/* Status */}
                      <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                        {isActive ? (
                          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99, background: "#dcfce7", color: "#16a34a" }}>Active</span>
                        ) : (
                          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99, background: "#fee2e2", color: "#b91c1c" }}>Inactive</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button
                            onClick={() => setEditing(u)}
                            title="Edit user"
                            style={{ padding: "5px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", cursor: "pointer", color: "#3b82f6", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
                          >
                            <Edit3 size={13} /> Edit
                          </button>
                          {isActive && (
                            <button
                              onClick={() => handleDelete(u)}
                              title="Deactivate user"
                              style={{ padding: "5px 9px", border: "1px solid #fecaca", borderRadius: 6, background: "#fff5f5", cursor: "pointer", color: "#ef4444", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
                            >
                              <Trash2 size={13} /> Deactivate
                            </button>
                          )}
                          {u.role !== "ADMIN" && (
                            <button
                              onClick={() => handleDeletePermanent(u)}
                              title="Permanently delete user (cannot be undone)"
                              style={{ padding: "5px 9px", border: "1px solid #dc2626", borderRadius: 6, background: "#dc2626", cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
                            >
                              <Trash2 size={13} /> Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add User Modal ── */}
      {showAdd && (
        <ModalOverlay onClose={() => setShowAdd(false)}>
          <ModalBox title="Add User" subtitle="A login invitation will be sent to the new user's email." onClose={() => setShowAdd(false)}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Field label="First Name *">
                <input value={addFirst} onChange={e => setAddFirst(e.target.value)} placeholder="First name" style={fieldStyle} />
              </Field>
              <Field label="Surname *">
                <input value={addSurname} onChange={e => setAddSurname(e.target.value)} placeholder="Surname" style={fieldStyle} />
              </Field>
              <Field label="Email Address *" span>
                <input type="email" value={addEmail} onChange={e => setAddEmail(e.target.value)} placeholder="user@example.com" style={fieldStyle} />
              </Field>
              <Field label="Employee No.">
                <input value={addEmpNo} onChange={e => setAddEmpNo(e.target.value)} placeholder="e.g. ETL-001" style={fieldStyle} />
              </Field>
              <Field label="Job Title">
                <input value={addTitle} onChange={e => setAddTitle(e.target.value)} placeholder="e.g. Analyst" style={fieldStyle} />
              </Field>
              <Field label="Employment Type">
                <select value={addEmpType} onChange={e => setAddEmpType(e.target.value)} style={fieldStyle}>
                  {empTypes.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="System Role">
                <select value={addRole} onChange={e => setAddRole(e.target.value)} style={fieldStyle}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select value={addActive ? "active" : "inactive"} onChange={e => setAddActive(e.target.value === "active")} style={fieldStyle}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </Field>
              <Field label="Org Placement" span>
                <OrgPicker value={addOrg} onChange={setAddOrg} />
              </Field>
              <Field label="Permission Groups" span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
                  {availableGroups.filter(g => !g.dynamic).map(g => (
                    <label key={g.name} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: g.name === "ADMIN" ? "default" : "pointer" }}>
                      <input
                        type="checkbox"
                        checked={addGroups.includes(g.name)}
                        disabled={g.name === "ADMIN"}
                        onChange={() => setAddGroups(prev => prev.includes(g.name) ? prev.filter(n => n !== g.name) : [...prev, g.name])}
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                  Leave unselected to default to the group matching the chosen System Role.
                </div>
              </Field>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
              <button onClick={() => setShowAdd(false)} style={{ padding: "8px 18px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={handleAdd} disabled={adding} style={{ padding: "8px 20px", background: adding ? "#93c5fd" : "#1d4ed8", color: "#fff", border: "none", borderRadius: 7, cursor: adding ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}>
                {adding ? "Creating…" : "Create User"}
              </button>
            </div>
          </ModalBox>
        </ModalOverlay>
      )}

      {/* ── Edit User Modal ── */}
      {editing && (
        <ModalOverlay onClose={() => setEditing(null)}>
          <ModalBox title="Edit User" subtitle={editing.email} onClose={() => setEditing(null)}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Field label="First Name *">
                <input value={editFirst} onChange={e => setEditFirst(e.target.value)} style={fieldStyle} />
              </Field>
              <Field label="Surname *">
                <input value={editSurname} onChange={e => setEditSurname(e.target.value)} style={fieldStyle} />
              </Field>
              <Field label="Email Address *" span>
                <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} style={fieldStyle} />
              </Field>
              <Field label="Employee No.">
                <input value={editEmpNo} onChange={e => setEditEmpNo(e.target.value)} style={fieldStyle} />
              </Field>
              <Field label="Job Title">
                <input value={editTitle} onChange={e => setEditTitle(e.target.value)} style={fieldStyle} />
              </Field>
              <Field label="Employment Type">
                <select value={editEmpType} onChange={e => setEditEmpType(e.target.value)} style={fieldStyle}>
                  {empTypes.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="System Role">
                <select value={editRole} onChange={e => setEditRole(e.target.value)} style={fieldStyle}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select value={editActive ? "active" : "inactive"} onChange={e => setEditActive(e.target.value === "active")} style={fieldStyle}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </Field>
              <Field label="Org Placement" span>
                <OrgPicker value={editOrg} onChange={setEditOrg} />
              </Field>
              <Field label="Permission Groups" span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
                  {availableGroups.filter(g => !g.dynamic).map(g => (
                    <label key={g.name} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: g.name === "ADMIN" ? "default" : "pointer" }}>
                      <input
                        type="checkbox"
                        checked={editGroups.includes(g.name)}
                        disabled={g.name === "ADMIN"}
                        onChange={() => setEditGroups(prev => prev.includes(g.name) ? prev.filter(n => n !== g.name) : [...prev, g.name])}
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
                {editGroups.filter(n => availableGroups.find(g => g.name === n)?.dynamic).length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
                      Also a member of (based on role &amp; org placement):
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {editGroups.filter(n => availableGroups.find(g => g.name === n)?.dynamic).map(n => (
                        <span key={n} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "var(--surface-soft)", border: "1px solid var(--border)" }}>{n}</span>
                      ))}
                    </div>
                  </div>
                )}
              </Field>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
              <button onClick={() => setEditing(null)} style={{ padding: "8px 18px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={handleSaveEdit} disabled={saving} style={{ padding: "8px 20px", background: saving ? "#93c5fd" : "#1d4ed8", color: "#fff", border: "none", borderRadius: 7, cursor: saving ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </ModalBox>
        </ModalOverlay>
      )}
      {/* ── Employment Types panel ── */}
      <EmploymentTypesPanel />
    </div>
  );
}

// ─── Employment Types admin panel ────────────────────────────────────────────

function EmploymentTypesPanel() {
  const [types, setTypes]     = useState<EmploymentType[]>([]);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding]   = useState(false);
  const [editId, setEditId]   = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  async function reload() {
    try { setTypes(await api.employmentTypes()); } catch { /* ignore */ }
  }

  useEffect(() => { void reload(); }, []);

  async function mutate(fn: () => Promise<void>) {
    await fn();
    await reload();
    await refreshEmploymentTypes();
  }

  async function handleAdd() {
    if (!newCode.trim() || !newName.trim()) { alert("Code and name are required."); return; }
    setAdding(true);
    try {
      await mutate(() => api.createEmploymentType({ code: newCode.trim(), name: newName.trim() }));
      setNewCode(""); setNewName("");
    } catch (e: any) { alert("Error: " + e.message); }
    finally { setAdding(false); }
  }

  async function handleSave(id: string) {
    if (!editName.trim()) return;
    setSavingId(id);
    try {
      await mutate(() => api.updateEmploymentType(id, { name: editName.trim() }));
      setEditId(null);
    } catch (e: any) { alert("Error: " + e.message); }
    finally { setSavingId(null); }
  }

  async function handleToggle(id: string, active: boolean) {
    try { await mutate(() => api.updateEmploymentType(id, { active: !active })); }
    catch (e: any) { alert("Error: " + e.message); }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try { await mutate(() => api.deleteEmploymentType(id)); }
    catch (e: any) { alert("Error: " + e.message); }
  }

  return (
    <div style={{ marginTop: 40, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface-soft)" }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Employment Types</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>Manage the employment types available across the system.</div>
      </div>

      {/* Add row */}
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Code</label>
          <input value={newCode} onChange={e => setNewCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} placeholder="e.g. CONTRACT" maxLength={40}
            style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", fontSize: 13, width: 150 }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 160 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Display Name</label>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Contract"
            style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", fontSize: 13 }} />
        </div>
        <button onClick={handleAdd} disabled={adding || !newCode.trim() || !newName.trim()}
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 16px", background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" as const }}>
          <Plus size={13} /> {adding ? "Adding…" : "Add Type"}
        </button>
      </div>

      {/* List */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "var(--surface-soft)" }}>
            {["Code", "Display Name", "Status", ""].map(h => (
              <th key={h} style={{ padding: "8px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {types.map(t => (
            <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-soft)")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}>
              <td style={{ padding: "10px 16px", fontSize: 12, fontFamily: "monospace", color: "var(--muted)" }}>{t.code}</td>
              <td style={{ padding: "10px 16px" }}>
                {editId === t.id
                  ? <input value={editName} onChange={e => setEditName(e.target.value)} autoFocus
                      style={{ padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", color: "var(--text)", fontSize: 13 }} />
                  : <span style={{ fontSize: 13, fontWeight: 500 }}>{t.name}</span>}
              </td>
              <td style={{ padding: "10px 16px" }}>
                <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: t.active ? "#dcfce7" : "#fee2e2", color: t.active ? "#15803d" : "#b91c1c" }}>
                  {t.active ? "Active" : "Inactive"}
                </span>
              </td>
              <td style={{ padding: "10px 16px" }}>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  {editId === t.id ? (
                    <>
                      <button onClick={() => handleSave(t.id)} disabled={savingId === t.id}
                        style={{ padding: "4px 10px", background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12 }}>
                        {savingId === t.id ? "Saving…" : "Save"}
                      </button>
                      <button onClick={() => setEditId(null)}
                        style={{ padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", fontSize: 12 }}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setEditId(t.id); setEditName(t.name); }} title="Rename"
                        style={{ padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface)", cursor: "pointer", color: "#3b82f6", display: "flex" }}>
                        <Edit3 size={13} />
                      </button>
                      <button onClick={() => handleToggle(t.id, t.active)}
                        style={{ padding: "4px 8px", border: `1px solid ${t.active ? "#fecaca" : "#bbf7d0"}`, borderRadius: 5, background: t.active ? "#fff5f5" : "#f0fdf4", cursor: "pointer", color: t.active ? "#ef4444" : "#16a34a", fontSize: 12 }}>
                        {t.active ? "Deactivate" : "Activate"}
                      </button>
                      <button onClick={() => handleDelete(t.id, t.name)} title="Delete"
                        style={{ padding: "4px 8px", border: "1px solid #fecaca", borderRadius: 5, background: "#fff5f5", cursor: "pointer", color: "#ef4444", display: "flex" }}>
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {types.length === 0 && (
            <tr><td colSpan={4} style={{ padding: "24px 16px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No employment types yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Modal primitives ─────────────────────────────────────────────────────────

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.48)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={onClose}
    >
      {children}
    </div>
  );
}

function ModalBox({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{ background: "var(--surface)", borderRadius: 14, padding: 28, width: 580, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.28)" }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{subtitle}</div>}
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 4, marginTop: -2 }}><X size={17} /></button>
      </div>
      {children}
    </div>
  );
}
