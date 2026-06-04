import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { CheckCircle2, Edit3, RefreshCw, Search, Trash2, UserPlus, UserRoundCheck, X } from "lucide-react";

type UserRow = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no?: string | null;
  title?: string | null;
  department?: string | null;
  role?: string | null;
  is_active?: boolean;
};

type DepartmentRow = {
  id?: string;
  name: string;
  manager_user_id?: string | null;
};

function splitName(value: string | null | undefined) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts.shift() || "", surname: parts.join(" ") };
}

function initials(value: string | null | undefined) {
  return String(value || "Manager")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "M";
}

function resetForm(setters: Array<(value: string) => void>) {
  setters.forEach((setter) => setter(""));
}

export default function ManagersOnboarding() {
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [departmentRows, setDepartmentRows] = useState<DepartmentRow[]>([]);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newSurname, setNewSurname] = useState("");
  const [newEmployeeNo, setNewEmployeeNo] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [newTitle, setNewTitle] = useState("Department Manager");
  const [newIsActive, setNewIsActive] = useState(true);
  const [assignAsDepartmentManager, setAssignAsDepartmentManager] = useState(true);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [editingFirstName, setEditingFirstName] = useState("");
  const [editingSurname, setEditingSurname] = useState("");
  const [editingSetAsDepartmentManager, setEditingSetAsDepartmentManager] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [allUsers, departmentNames, departmentAssignmentRows] = await Promise.all([
        api.adminUsers(),
        api.departments(),
        api.departmentsWithSections()
      ]);
      setUsers(Array.isArray(allUsers) ? allUsers : []);
      setDepartments(Array.isArray(departmentNames) ? departmentNames : []);
      setDepartmentRows(Array.isArray(departmentAssignmentRows) ? departmentAssignmentRows : []);
    } catch (error: any) {
      alert("Error loading managers: " + error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!editingUser) {
      setEditingFirstName("");
      setEditingSurname("");
      setEditingSetAsDepartmentManager(false);
      return;
    }
    const parts = splitName(editingUser.full_name);
    setEditingFirstName(parts.first);
    setEditingSurname(parts.surname);
    setEditingSetAsDepartmentManager(
      Boolean(editingUser.department && departmentRows.some((department) => department.name === editingUser.department && department.manager_user_id === editingUser.id))
    );
  }, [departmentRows, editingUser]);

  const managerRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return users
      .filter((user) => String(user.role || "").toUpperCase() === "MANAGER")
      .filter((user) => {
        if (!needle) return true;
        return [user.full_name, user.email, user.employee_no, user.title, user.department]
          .some((value) => String(value || "").toLowerCase().includes(needle));
      });
  }, [search, users]);

  function assignedDepartments(userId: string) {
    return departmentRows.filter((department) => department.manager_user_id === userId).map((department) => department.name);
  }

  async function setDepartmentManager(departmentName: string, userId: string) {
    await api.updateDepartment(departmentName, { name: departmentName, manager_user_id: userId });
  }

  async function createManager() {
    if (!newFirstName.trim() || !newSurname.trim() || !newEmail.trim() || !newDepartment.trim()) {
      alert("Please fill first name, surname, username/email, and department.");
      return;
    }
    setCreating(true);
    try {
      const fullName = [newFirstName.trim(), newSurname.trim()].join(" ");
      const created: UserRow = await api.createUser({
        email: newEmail.trim(),
        full_name: fullName,
        employee_no: newEmployeeNo.trim() || undefined,
        department: newDepartment,
        role: "MANAGER",
        title: newTitle.trim() || "Department Manager",
        is_active: newIsActive
      });
      if (assignAsDepartmentManager) {
        await setDepartmentManager(newDepartment, created.id);
      }
      resetForm([setNewEmail, setNewFirstName, setNewSurname, setNewEmployeeNo]);
      setNewDepartment("");
      setNewTitle("Department Manager");
      setNewIsActive(true);
      setAssignAsDepartmentManager(true);
      setShowForm(false);
      await load();
      alert("Manager saved.");
    } catch (error: any) {
      alert("Error creating manager: " + error.message);
    } finally {
      setCreating(false);
    }
  }

  async function saveManager() {
    if (!editingUser) return;
    if (!editingFirstName.trim() || !editingSurname.trim() || !editingUser.email?.trim() || !editingUser.department?.trim()) {
      alert("Please fill first name, surname, username/email, and department.");
      return;
    }
    try {
      const fullName = [editingFirstName.trim(), editingSurname.trim()].join(" ");
      await api.updateUser(editingUser.id, {
        full_name: fullName,
        employee_no: editingUser.employee_no || "",
        title: editingUser.title || "Department Manager",
        department: editingUser.department,
        email: editingUser.email,
        is_active: editingUser.is_active !== false
      });
      if (editingSetAsDepartmentManager && editingUser.department) {
        await setDepartmentManager(editingUser.department, editingUser.id);
      }
      setEditingUser(null);
      await load();
      alert("Manager saved.");
    } catch (error: any) {
      alert("Error saving manager: " + error.message);
    }
  }

  async function deactivateManager(user: UserRow) {
    if (!confirm(`Deactivate ${user.full_name || user.email}?`)) return;
    try {
      const updated: UserRow = await api.updateUser(user.id, { is_active: false });
      setUsers((current) => current.map((item) => item.id === user.id ? updated : item));
    } catch (error: any) {
      alert("Error deactivating manager: " + error.message);
    }
  }

  return (
    <div className="onboarding-page">
      <div className="onboarding-heading">
        <div>
          <h2>Managers</h2>
          <p>Onboard department managers and connect them to departments for approval routing.</p>
        </div>
        <button className="button button-primary" type="button" onClick={() => setShowForm((current) => !current)}>
          <UserPlus size={17} aria-hidden />
          {showForm ? "Close" : "Add Manager"}
        </button>
      </div>

      {showForm && (
        <section className="onboarding-panel">
          <div className="onboarding-form-grid onboarding-form-grid-4">
            <label><span>First Name *</span><input value={newFirstName} onChange={(event) => setNewFirstName(event.target.value)} placeholder="Enter first name" /></label>
            <label><span>Surname *</span><input value={newSurname} onChange={(event) => setNewSurname(event.target.value)} placeholder="Enter surname" /></label>
            <label><span>Employee Number</span><input value={newEmployeeNo} onChange={(event) => setNewEmployeeNo(event.target.value)} placeholder="Enter employee number" /></label>
            <label><span>Position / Title</span><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Department Manager" /></label>
          </div>
          <div className="onboarding-form-grid onboarding-form-grid-actions">
            <label><span>Username or Email *</span><input value={newEmail} onChange={(event) => setNewEmail(event.target.value)} placeholder="username or user@etl.co.ls" /></label>
            <label>
              <span>Department *</span>
              <select value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)}>
                <option value="">Select department</option>
                {departments.map((department) => <option key={department} value={department}>{department}</option>)}
              </select>
            </label>
            <label className="onboarding-check"><input type="checkbox" checked={newIsActive} onChange={(event) => setNewIsActive(event.target.checked)} /> Active</label>
            <label className="onboarding-check"><input type="checkbox" checked={assignAsDepartmentManager} onChange={(event) => setAssignAsDepartmentManager(event.target.checked)} /> Set as department manager</label>
            <div className="onboarding-actions">
              <button className="button small-button button-subtle" type="button" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="button button-primary" type="button" onClick={() => void createManager()} disabled={creating}>{creating ? "Saving..." : "Save Manager"}</button>
            </div>
          </div>
        </section>
      )}

      <section className="onboarding-panel">
        <div className="onboarding-toolbar">
          <div className="onboarding-search">
            <Search size={18} aria-hidden />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search managers..." />
          </div>
          <button className="button small-button button-subtle" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} aria-hidden />
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>

        <div className="onboarding-table-wrap">
          <table className="table onboarding-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Employee No</th>
                <th>Title</th>
                <th>Department</th>
                <th>Email</th>
                <th>Assignment</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {managerRows.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: "center" }}>{loading ? "Loading managers..." : "No managers found."}</td></tr>
              ) : managerRows.map((manager) => {
                const assigned = assignedDepartments(manager.id);
                return (
                  <tr key={manager.id}>
                    <td>
                      <div className="onboarding-person">
                        <span className="onboarding-avatar"><UserRoundCheck size={16} aria-hidden /></span>
                        <span><strong>{manager.full_name || manager.email}</strong><small>{initials(manager.full_name || manager.email)}</small></span>
                      </div>
                    </td>
                    <td>{manager.employee_no || "-"}</td>
                    <td>{manager.title || "Department Manager"}</td>
                    <td>{manager.department || "-"}</td>
                    <td>{manager.email}</td>
                    <td>
                      {assigned.length ? (
                        <span className="status-pill status-pill-success"><CheckCircle2 size={13} aria-hidden /> {assigned.join(", ")}</span>
                      ) : (
                        <button className="link-button" type="button" disabled={!manager.department} onClick={() => manager.department && void setDepartmentManager(manager.department, manager.id).then(load)}>
                          Set department manager
                        </button>
                      )}
                    </td>
                    <td>{manager.is_active !== false ? <span className="status-pill status-pill-success">Active</span> : <span className="status-pill status-pill-warning">Inactive</span>}</td>
                    <td>
                      <div className="onboarding-row-actions">
                        <button className="icon-button leadership-icon-button" type="button" title="Edit manager" aria-label="Edit manager" onClick={() => setEditingUser(manager)}><Edit3 size={16} aria-hidden /></button>
                        <button className="icon-button leadership-icon-button danger" type="button" title="Deactivate manager" aria-label="Deactivate manager" onClick={() => void deactivateManager(manager)}><Trash2 size={16} aria-hidden /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {editingUser && (
        <div className="leadership-modal-backdrop">
          <div className="leadership-modal onboarding-modal">
            <div className="leadership-modal-head">
              <h3>Edit Manager</h3>
              <button className="icon-button leadership-icon-button" type="button" onClick={() => setEditingUser(null)} aria-label="Close edit modal"><X size={17} aria-hidden /></button>
            </div>
            <div className="onboarding-form-grid onboarding-form-grid-2">
              <label><span>First Name *</span><input value={editingFirstName} onChange={(event) => setEditingFirstName(event.target.value)} /></label>
              <label><span>Surname *</span><input value={editingSurname} onChange={(event) => setEditingSurname(event.target.value)} /></label>
              <label><span>Employee Number</span><input value={editingUser.employee_no || ""} onChange={(event) => setEditingUser({ ...editingUser, employee_no: event.target.value })} /></label>
              <label><span>Position / Title</span><input value={editingUser.title || ""} onChange={(event) => setEditingUser({ ...editingUser, title: event.target.value })} /></label>
              <label>
                <span>Department *</span>
                <select value={editingUser.department || ""} onChange={(event) => setEditingUser({ ...editingUser, department: event.target.value })}>
                  <option value="">Select department</option>
                  {departments.map((department) => <option key={department} value={department}>{department}</option>)}
                </select>
              </label>
              <label><span>Username or Email *</span><input value={editingUser.email || ""} onChange={(event) => setEditingUser({ ...editingUser, email: event.target.value })} /></label>
              <label className="onboarding-check"><input type="checkbox" checked={editingUser.is_active !== false} onChange={(event) => setEditingUser({ ...editingUser, is_active: event.target.checked })} /> Active</label>
              <label className="onboarding-check"><input type="checkbox" checked={editingSetAsDepartmentManager} onChange={(event) => setEditingSetAsDepartmentManager(event.target.checked)} /> Set as department manager</label>
            </div>
            <div className="leadership-modal-actions">
              <button className="button small-button button-subtle" type="button" onClick={() => setEditingUser(null)}>Cancel</button>
              <button className="button button-primary" type="button" onClick={() => void saveManager()}>Save Manager</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
