   import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { confirmAction } from "./alerts";
import { Edit3, Mail, RefreshCw, Search, Trash2, UserCheck, UserPlus, X } from "lucide-react";
import UserPicker, { type PickableUser } from "./UserPicker";
import OrgPicker, { type OrgSelection, orgSelectionFromUser } from "./OrgPicker";
import { useEmploymentTypes } from "./useEmploymentTypes";
import { useStaffDirectory } from "./useStaffDirectory";
import { ROLE_LABELS } from "./roles";

const EMPTY_ORG: OrgSelection = {
  divisionId: null, divisionName: null,
  department: null, departmentId: null,
  sectionId: null, sectionName: null,
  teamId: null, teamName: null,
};

type EmployeeRow = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no?: string | null;
  title?: string | null;
  department?: string | null;
  division_id?: string | null;
  division_name?: string | null;
  section_id?: string | null;
  section_name?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  employment_type?: string | null;
  role?: string | null;
  is_active?: boolean;
  profile_completed?: boolean;
};



function orgPath(u: EmployeeRow) {
  return [u.division_name, u.department, u.section_name, u.team_name].filter(Boolean).join(" › ");
}

function splitName(v: string | null | undefined) {
  const parts = String(v || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts.shift() || "", surname: parts.join(" ") };
}

function initials(v: string | null | undefined) {
  return String(v || "?").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function EmployeesOnboarding() {
  const empTypes = useEmploymentTypes();
  const { staff, loading, reload } = useStaffDirectory();
  const users = staff as EmployeeRow[];
  const [creating, setCreating] = useState(false);
  const [search, setSearch]     = useState("");
  const [divFilter, setDivFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");

  // ── Add modal ─────────────────────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false);
  const [newFirst, setNewFirst]         = useState("");
  const [newSurname, setNewSurname]     = useState("");
  const [newEmail, setNewEmail]         = useState("");
  const [newEmpNo, setNewEmpNo]         = useState("");
  const [newTitle, setNewTitle]         = useState("");
  const [newEmpType, setNewEmpType]     = useState("PERMANENT");
  const [newIsActive, setNewIsActive]   = useState(true);
  const [newOrg, setNewOrg]             = useState<OrgSelection>(EMPTY_ORG);

  // ── Edit modal ────────────────────────────────────────────────────────────
  const [editing, setEditing]         = useState<EmployeeRow | null>(null);
  const [editFirst, setEditFirst]     = useState("");
  const [editSurname, setEditSurname] = useState("");
  const [editEmpNo, setEditEmpNo]     = useState("");
  const [editTitle, setEditTitle]     = useState("");
  const [editEmpType, setEditEmpType] = useState("PERMANENT");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editOrg, setEditOrg]           = useState<OrgSelection>(EMPTY_ORG);
  const [editSaving, setEditSaving]     = useState(false);

  // ── Assign existing user modal ────────────────────────────────────────────
  const [showAssign, setShowAssign] = useState(false);
  const [assignOrg, setAssignOrg]   = useState<OrgSelection>(EMPTY_ORG);
  const [assigning, setAssigning]   = useState(false);

  // ─── Data loading ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!editing) {
      setEditFirst(""); setEditSurname(""); setEditEmpNo("");
      setEditTitle(""); setEditEmpType("PERMANENT"); setEditIsActive(true);
      setEditOrg(EMPTY_ORG);
      return;
    }
    const { first, surname } = splitName(editing.full_name);
    setEditFirst(first);
    setEditSurname(surname);
    setEditEmpNo(editing.employee_no || "");
    setEditTitle(editing.title || "");
    setEditEmpType(editing.employment_type || "PERMANENT");
    setEditIsActive(editing.is_active !== false);
    setEditOrg(orgSelectionFromUser(editing));
  }, [editing]);

  // ─── Derived data ─────────────────────────────────────────────────────────

  // The roster is the single source of truth for all staff — every role (HOD,
  // MANAGER, …) is "still an Employee" and must be visible here, not just
  // accounts with role===EMPLOYEE. Active/inactive get their own views so
  // deactivated accounts don't clutter the working roster.
  const employees = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return users.filter((u) => {
      if (divFilter !== "ALL" && (u.division_name ?? "Unassigned") !== divFilter) return false;
      if (typeFilter !== "ALL" && (u.employment_type ?? "PERMANENT") !== typeFilter) return false;
      if (!needle) return true;
      return [u.full_name, u.email, u.employee_no, u.title, u.department, u.division_name, u.role]
        .some((v) => String(v ?? "").toLowerCase().includes(needle));
    });
  }, [users, search, divFilter, typeFilter]);

  const divisionNames = useMemo(() => {
    const s = new Set<string>();
    users.forEach((u) => s.add(u.division_name ?? "Unassigned"));
    return Array.from(s).sort();
  }, [users]);

  const stats = useMemo(() => {
    const active = users.filter((u) => u.is_active !== false);
    return {
      total:    users.length,
      active:   active.length,
      inactive: users.length - active.length,
      pending:  active.filter((u) => !u.profile_completed).length,
    };
  }, [users]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  function resetAddForm() {
    setNewFirst(""); setNewSurname(""); setNewEmail(""); setNewEmpNo("");
    setNewTitle(""); setNewEmpType("PERMANENT"); setNewIsActive(true); setNewOrg(EMPTY_ORG);
  }

  async function createEmployee() {
    if (!newFirst.trim() || !newSurname.trim() || !newEmail.trim()) {
      alert("First name, surname and email are required."); return;
    }
    setCreating(true);
    try {
      await api.createUser({
        email:           newEmail.trim(),
        full_name:       `${newFirst.trim()} ${newSurname.trim()}`,
        employee_no:     newEmpNo.trim() || undefined,
        title:           newTitle.trim() || undefined,
        department:      newOrg.department || undefined,
        division_id:     newOrg.divisionId ?? null,
        section_id:      newOrg.sectionId  ?? null,
        team_id:         newOrg.teamId     ?? null,
        employment_type: newEmpType,
        role:            "EMPLOYEE",
        is_active:       newIsActive,
      });
      resetAddForm();
      setShowAdd(false);
      await reload();
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setCreating(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editFirst.trim() || !editSurname.trim()) {
      alert("First name and surname are required."); return;
    }
    setEditSaving(true);
    try {
      await api.updateUser(editing.id, {
        full_name:       `${editFirst.trim()} ${editSurname.trim()}`,
        employee_no:     editEmpNo.trim() || "",
        title:           editTitle.trim() || "",
        email:           editing.email,
        department:      editOrg.department || editing.department || "",
        division_id:     editOrg.divisionId  ?? null,
        section_id:      editOrg.sectionId   ?? null,
        team_id:         editOrg.teamId      ?? null,
        employment_type: editEmpType,
        is_active:       editIsActive,
      });
      setEditing(null);
      await reload();
    } catch (e: any) {
      alert("Error saving: " + e.message);
    } finally {
      setEditSaving(false);
    }
  }

  async function deleteEmployee(u: EmployeeRow) {
    const confirmed = await confirmAction({
      title: "Deactivate employee?",
      text: `Deactivate ${u.full_name || u.email}? They will no longer be able to log in.`,
      confirmButtonText: "Deactivate"
    });
    if (!confirmed) return;
    try {
      await api.deleteUser(u.id);
      await reload();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  async function reactivateEmployee(u: EmployeeRow) {
    const confirmed = await confirmAction({
      title: "Reactivate employee?",
      text: `Reactivate ${u.full_name || u.email}? They will be able to log in again.`,
      confirmButtonText: "Reactivate"
    });
    if (!confirmed) return;
    try {
      await api.updateUser(u.id, { is_active: true });
      await reload();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  async function handleAssignExisting(user: PickableUser) {
    setAssigning(true);
    try {
      await api.updateUserRole(user.id, { role: "EMPLOYEE" });
      if (assignOrg.department) {
        await api.updateUser(user.id, {
          department:  assignOrg.department,
          division_id: assignOrg.divisionId  ?? null,
          section_id:  assignOrg.sectionId   ?? null,
          team_id:     assignOrg.teamId      ?? null,
        });
      }
      setShowAssign(false);
      setAssignOrg(EMPTY_ORG);
      await reload();
    } catch (e: any) {
      alert("Error assigning: " + e.message);
    } finally {
      setAssigning(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="ep-page">

      {/* Breadcrumb */}
      <div className="ep-breadcrumb">
        <span>Administration</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Employee Management</span>
      </div>

      {/* Header */}
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Employee Management</h1>
          <p className="ep-subtitle">Onboard, edit and manage all staff accounts across the organisation.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => void reload()} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="ep-btn-outline" onClick={() => { setShowAssign(true); setAssignOrg(EMPTY_ORG); }}>
            <UserCheck size={15} /> Assign Existing
          </button>
          <button className="ep-btn" onClick={() => { resetAddForm(); setShowAdd(true); }}>
            <UserPlus size={15} /> Add Employee
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="ep-kpi-row">
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><UserPlus size={28} /></span>
          <div><div className="stat-value">{stats.total}</div><div className="stat-label">Total Staff</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><UserCheck size={28} /></span>
          <div><div className="stat-value">{stats.active}</div><div className="stat-label">Active</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><Trash2 size={28} /></span>
          <div><div className="stat-value">{stats.inactive}</div><div className="stat-label">Inactive</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Mail size={28} /></span>
          <div><div className="stat-value">{stats.pending}</div><div className="stat-label">Pending Profile</div></div>
        </div>
      </div>

      {/* Panel */}
      <div className="ep-panel">
        {/* Panel header + filters */}
        <div className="ep-panel-head" style={{ flexWrap: "wrap", gap: 10 }}>
          <div className="ep-panel-title">
            Staff Roster
            <span style={{ marginLeft: 8, fontSize: "0.8rem", color: "var(--muted)", fontWeight: 400 }}>
              {employees.length} record{employees.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div className="ep-search">
              <Search size={14} />
              <input placeholder="Search by name, email, employee no…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {divisionNames.length > 1 && (
              <select className="ep-form-select" value={divFilter} onChange={(e) => setDivFilter(e.target.value)} style={{ minWidth: 140 }}>
                <option value="ALL">All Companies</option>
                {divisionNames.map((d) => <option key={d}>{d}</option>)}
              </select>
            )}
            <select className="ep-form-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ minWidth: 130 }}>
              <option value="ALL">All Types</option>
              {empTypes.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          </div>
        </div>

        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : employees.length === 0 ? (
            <div className="ep-empty">
              <UserPlus size={32} style={{ opacity: 0.25 }} />
              <p>{search || divFilter !== "ALL" || typeFilter !== "ALL"
                ? "No staff match your filters."
                : "No staff yet. Add one above."}</p>
            </div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Role</th>
                  <th>Org Path</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((u) => {
                  const isActive = u.is_active !== false;
                  const statusLabel = !isActive ? "Inactive" : !u.profile_completed ? "Pending Profile" : "Active";
                  const statusCls = !isActive ? "status-pill-danger" : !u.profile_completed ? "status-pill-warning" : "status-pill-success";
                  const path = orgPath(u);
                  return (
                    <tr key={u.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{
                            width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                            background: isActive ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "#e5e7eb",
                            color: isActive ? "#fff" : "#9ca3af",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontWeight: 700, fontSize: "0.85rem",
                          }}>
                            {initials(u.full_name)}
                          </span>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>{u.full_name || "—"}</div>
                            <div style={{ fontSize: "0.78rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}>
                              <Mail size={10} />{u.email}{u.employee_no && <> · {u.employee_no}</>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "#eef2ff", color: "#4338ca", border: "1px solid #e0e7ff", fontWeight: 600 }}>
                          {ROLE_LABELS[u.role ?? ""] ?? u.role ?? "—"}
                        </span>
                      </td>
                      <td style={{ fontSize: "0.82rem", color: "var(--muted)" }}>{path || "—"}</td>
                      <td>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0", fontWeight: 500 }}>
                          {empTypes.find(t => t.code === (u.employment_type ?? "PERMANENT"))?.name ?? u.employment_type ?? "—"}
                        </span>
                      </td>
                      <td>
                        <span className={`status-pill ${statusCls}`}>{statusLabel}</span>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button className="ep-icon-btn" title="Edit" onClick={() => setEditing(u)}>
                            <Edit3 size={13} />
                          </button>
                          {isActive ? (
                            <button className="ep-icon-btn" style={{ color: "#dc2626" }} title="Deactivate" onClick={() => void deleteEmployee(u)}>
                              <Trash2 size={13} />
                            </button>
                          ) : (
                            <button className="ep-icon-btn" style={{ color: "#16a34a" }} title="Reactivate" onClick={() => void reactivateEmployee(u)}>
                              <UserCheck size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Add Employee Modal ─────────────────────────────────────────────── */}
      {showAdd && (
        <div className="ep-modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="ep-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">Add Employee</h2>
                <p className="ep-modal-sub">An invitation email will be sent to the new employee.</p>
              </div>
              <button className="ep-icon-btn" onClick={() => setShowAdd(false)}><X size={18} /></button>
            </div>
            <div className="ep-modal-body">
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>First Name <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="First name" value={newFirst} onChange={(e) => setNewFirst(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Surname <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="Surname" value={newSurname} onChange={(e) => setNewSurname(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-group">
                <label>Email Address <span className="ep-required">*</span></label>
                <input className="ep-form-input" type="email" placeholder="employee@example.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Employee No.</label>
                  <input className="ep-form-input" placeholder="e.g. ETL-001" value={newEmpNo} onChange={(e) => setNewEmpNo(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Job Title</label>
                  <input className="ep-form-input" placeholder="e.g. Software Engineer" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Employment Type</label>
                  <select className="ep-form-select" value={newEmpType} onChange={(e) => setNewEmpType(e.target.value)}>
                    {empTypes.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
                  </select>
                </div>
                <div className="ep-form-group">
                  <label>Status</label>
                  <select className="ep-form-select" value={newIsActive ? "active" : "inactive"} onChange={(e) => setNewIsActive(e.target.value === "active")}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div className="ep-form-group">
                <label>Org Placement</label>
                <OrgPicker value={newOrg} onChange={setNewOrg} />
              </div>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="ep-btn" onClick={() => void createEmployee()} disabled={creating}>
                {creating ? "Creating…" : "Add & Send Invitation"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Employee Modal ────────────────────────────────────────────── */}
      {editing && (
        <div className="ep-modal-overlay" onClick={() => setEditing(null)}>
          <div className="ep-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">Edit Employee</h2>
                <p className="ep-modal-sub">{editing.full_name || editing.email}</p>
              </div>
              <button className="ep-icon-btn" onClick={() => setEditing(null)}><X size={18} /></button>
            </div>
            <div className="ep-modal-body">
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>First Name <span className="ep-required">*</span></label>
                  <input className="ep-form-input" value={editFirst} onChange={(e) => setEditFirst(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Surname <span className="ep-required">*</span></label>
                  <input className="ep-form-input" value={editSurname} onChange={(e) => setEditSurname(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-group">
                <label>Email</label>
                <input className="ep-form-input" value={editing.email} readOnly style={{ opacity: 0.6 }} />
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Employee No.</label>
                  <input className="ep-form-input" value={editEmpNo} onChange={(e) => setEditEmpNo(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Job Title</label>
                  <input className="ep-form-input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Employment Type</label>
                  <select className="ep-form-select" value={editEmpType} onChange={(e) => setEditEmpType(e.target.value)}>
                    {empTypes.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
                  </select>
                </div>
                <div className="ep-form-group">
                  <label>Status</label>
                  <select className="ep-form-select" value={editIsActive ? "active" : "inactive"} onChange={(e) => setEditIsActive(e.target.value === "active")}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div className="ep-form-group">
                <label>Org Placement</label>
                <OrgPicker value={editOrg} onChange={setEditOrg} />
              </div>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => setEditing(null)}>Cancel</button>
              <button className="ep-btn" onClick={() => void saveEdit()} disabled={editSaving}>
                {editSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Assign Existing User Modal ─────────────────────────────────────── */}
      {showAssign && (
        <UserPicker
          title="Assign Existing User as Employee"
          subtitle="Select a user and optionally update their org placement."
          users={users}
          excludeRoles={[]}
          onSelect={handleAssignExisting}
          onClose={() => { setShowAssign(false); setAssignOrg(EMPTY_ORG); }}
          saving={assigning}
          saveLabel="Assign as Employee"
          extra={
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>Org Placement (optional)</div>
              <OrgPicker value={assignOrg} onChange={setAssignOrg} />
            </div>
          }
        />
      )}
    </div>
  );
}
