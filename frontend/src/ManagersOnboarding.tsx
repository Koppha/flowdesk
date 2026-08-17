import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { confirmAction } from "./alerts";
import { useStaffDirectory } from "./useStaffDirectory";
import { CheckCircle2, ChevronRight, Edit3, Layers, Plus, RefreshCw, Search, Trash2, UserCheck, UserPlus, UserRoundCheck, X } from "lucide-react";
import UserPicker, { type PickableUser } from "./UserPicker";
import OrgPicker, { type OrgSelection, orgSelectionFromUser } from "./OrgPicker";
import { roleLabel } from "./roles";

const EMPTY_ORG: OrgSelection = {
  divisionId: null, divisionName: null,
  department: null, departmentId: null,
  sectionId: null, sectionName: null,
  teamId: null, teamName: null,
};

// ─── Types ───────────────────────────────────────────────────────────────────

type UserRow = {
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
  manager_type_id?: string | null;
  manager_type_name?: string | null;
  manager_type_role?: string | null;
  role?: string | null;
  is_active?: boolean;
};

type DepartmentRow = {
  id?: string;
  name: string;
  division_id?: string | null;
  division_name?: string | null;
  manager_user_id?: string | null;
  hod_user_id?: string | null;
};

type SectionRow = {
  id: string;
  name: string;
  department_id?: string | null;
  manager_user_id?: string | null;
  hod_user_id?: string | null;
};

type OrgDivision = { id: string; name: string; active: boolean };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitName(value: string | null | undefined) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts.shift() || "", surname: parts.join(" ") };
}

function initials(value: string | null | undefined) {
  return String(value || "M")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("") || "M";
}

function resetForm(setters: Array<(v: string) => void>) {
  setters.forEach((s) => s(""));
}

const ROLE_COLOR: Record<string, string> = {
  HOD:     "#1d4ed8",
  MANAGER: "#15803d",
};

function RoleBadge({ role, label }: { role: string | null | undefined; label?: string }) {
  const text = label ?? roleLabel(role);
  const color = ROLE_COLOR[role ?? ""] ?? "#6b7280";
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 99,
      fontSize: 11,
      fontWeight: 600,
      background: `${color}18`,
      color,
      border: `1px solid ${color}44`,
    }}>
      {text}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ManagersOnboarding() {
  const { staff: users, loading: staffLoading, reload: reloadStaff } = useStaffDirectory();
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [departmentRows, setDepartmentRows] = useState<DepartmentRow[]>([]);
  const [sectionRows, setSectionRows] = useState<SectionRow[]>([]);
  const [divisions, setDivisions] = useState<OrgDivision[]>([]);
  const [search, setSearch] = useState("");
  const [divisionFilter, setDivisionFilter] = useState("ALL");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [statusView, setStatusView] = useState<"active" | "inactive">("active");
  const [showAddModal, setShowAddModal] = useState(false);

  // Add-form state
  const [newEmail, setNewEmail] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newSurname, setNewSurname] = useState("");
  const [newEmployeeNo, setNewEmployeeNo] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [newTitle, setNewTitle] = useState("Division Manager");
  const [newRole, setNewRole] = useState<"HOD" | "MANAGER">("MANAGER");
  const [newIsActive, setNewIsActive] = useState(true);
  const [assignAsDepartmentManager, setAssignAsDepartmentManager] = useState(true);
  const [newOrg, setNewOrg] = useState<OrgSelection>(EMPTY_ORG);

  // Edit state
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [editingFirstName, setEditingFirstName] = useState("");
  const [editingSurname, setEditingSurname] = useState("");
  const [editingSetAsDeptManager, setEditingSetAsDeptManager] = useState(false);
  const [editingOrg, setEditingOrg] = useState<OrgSelection>(EMPTY_ORG);
  const [editingTypeId, setEditingTypeId] = useState("");
  const [editingRole, setEditingRole] = useState<"HOD" | "MANAGER">("MANAGER");
  const [savingManager, setSavingManager] = useState(false);

  // Per-row "add another department" selection in the management table
  const [addDeptSelection, setAddDeptSelection] = useState<Record<string, string>>({});

  // Assign existing user state
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignRole, setAssignRole] = useState<"HOD" | "MANAGER">("MANAGER");
  const [assignDept, setAssignDept] = useState("");
  const [assignOrg, setAssignOrg] = useState<OrgSelection>(EMPTY_ORG);
  const [assigning, setAssigning] = useState(false);

  // Vacant positions — earmarked before anyone is assigned; filled later via
  // the same Assign/Create flows above.
  const [vacancies, setVacancies] = useState<any[]>([]);
  const [fillingVacancyId, setFillingVacancyId] = useState<string | null>(null);
  const [showVacancyModal, setShowVacancyModal] = useState(false);
  const [vacancyTitle, setVacancyTitle] = useState("");
  const [vacancyRole, setVacancyRole] = useState<"HOD" | "MANAGER">("MANAGER");
  const [vacancyTypeId, setVacancyTypeId] = useState("");
  const [vacancyOrg, setVacancyOrg] = useState<OrgSelection>(EMPTY_ORG);
  const [creatingVacancy, setCreatingVacancy] = useState(false);

  async function loadVacancies() {
    try {
      const rows: any = await api.positionVacancies();
      setVacancies(Array.isArray(rows) ? rows.filter((v: any) => v.role === "HOD" || v.role === "MANAGER") : []);
    } catch {
      // non-fatal — vacancies are a supplementary list
    }
  }

  useEffect(() => { void loadVacancies(); }, []);

  function resetVacancyForm() {
    setVacancyTitle("");
    setVacancyRole("MANAGER");
    setVacancyOrg(EMPTY_ORG);
    if (managerTypes.length > 0) setVacancyTypeId(managerTypes[0].id);
  }

  function resolvedVacancyRole(): "HOD" | "MANAGER" {
    const t = managerTypes.find((x) => x.id === vacancyTypeId);
    return (t?.role as "HOD" | "MANAGER") || vacancyRole;
  }

  async function handleCreateVacancy() {
    setCreatingVacancy(true);
    try {
      const selectedTypeName = managerTypes.find((x) => x.id === vacancyTypeId)?.name;
      await api.createPositionVacancy({
        role: resolvedVacancyRole(),
        title: vacancyTitle.trim() || selectedTypeName || undefined,
        department: vacancyOrg.department || undefined,
        division_id: vacancyOrg.divisionId || undefined,
        section_id: vacancyOrg.sectionId || undefined,
        team_id: vacancyOrg.teamId || undefined
      });
      resetVacancyForm();
      setShowVacancyModal(false);
      await loadVacancies();
    } catch (e: any) {
      alert("Error creating vacant position: " + e.message);
    } finally {
      setCreatingVacancy(false);
    }
  }

  async function handleRemoveVacancy(id: string) {
    const confirmed = await confirmAction({ title: "Remove vacant position?", text: "This cannot be undone.", confirmButtonText: "Remove" });
    if (!confirmed) return;
    try {
      await api.deletePositionVacancy(id);
      await loadVacancies();
    } catch (e: any) {
      alert("Error removing vacant position: " + e.message);
    }
  }

  function openFillWithAssign(vacancyId: string) {
    setFillingVacancyId(vacancyId);
    setAssignOrg(EMPTY_ORG);
    setShowAssignModal(true);
  }

  function openFillWithCreate(vacancyId: string) {
    setFillingVacancyId(vacancyId);
    resetAddForm();
    setShowAddModal(true);
  }

  // Manager types
  type MgrType = { id: string; name: string; role: string; description: string | null; active: boolean };
  const [activeTab, setActiveTab] = useState<"MANAGERS" | "TYPES">("MANAGERS");
  const [managerTypes, setManagerTypes] = useState<MgrType[]>([]);
  const [selectedNewTypeId, setSelectedNewTypeId] = useState("");
  const [selectedAssignTypeId, setSelectedAssignTypeId] = useState("");
  // Type add/edit
  const [showAddTypeModal, setShowAddTypeModal] = useState(false);
  const [editingType, setEditingType] = useState<MgrType | null>(null);
  const [typeFormName, setTypeFormName] = useState("");
  const [typeFormRole, setTypeFormRole] = useState<"MANAGER" | "HOD">("MANAGER");
  const [typeFormDesc, setTypeFormDesc] = useState("");
  const [typeFormActive, setTypeFormActive] = useState(true);
  const [typeSaving, setTypeSaving] = useState(false);

  // ─── Data loading ─────────────────────────────────────────────────────────

  async function load() {
    setLoading(true);
    try {
      const [departmentAssignmentRows, sectionAssignmentRows, divData, typeData] = await Promise.all([
        api.departmentsWithSections(),
        api.sections().catch(() => []),
        api.divisions().catch(() => []),
        api.managerTypes().catch(() => [])
      ]);
      setDepartmentRows(Array.isArray(departmentAssignmentRows) ? departmentAssignmentRows : []);
      setSectionRows(Array.isArray(sectionAssignmentRows) ? sectionAssignmentRows : []);
      setDivisions(Array.isArray(divData) ? divData : []);
      const types = Array.isArray(typeData) ? typeData : [];
      setManagerTypes(types);
      if (types.length > 0 && !selectedNewTypeId) setSelectedNewTypeId(types[0].id);
      if (types.length > 0 && !selectedAssignTypeId) setSelectedAssignTypeId(types[0].id);
    } catch (error: any) {
      alert("Error loading data: " + error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!editingUser) {
      setEditingFirstName("");
      setEditingSurname("");
      setEditingSetAsDeptManager(false);
      setEditingOrg(EMPTY_ORG);
      setEditingTypeId("");
      setEditingRole("MANAGER");
      return;
    }
    const parts = splitName(editingUser.full_name);
    setEditingFirstName(parts.first);
    setEditingSurname(parts.surname);
    setEditingOrg(orgSelectionFromUser(editingUser));
    setEditingSetAsDeptManager(
      Boolean(editingUser.department && departmentRows.some(
        (d) => d.name === editingUser.department && d.manager_user_id === editingUser.id
      ))
    );
    const role = (editingUser.role === "HOD" ? "HOD" : "MANAGER") as "HOD" | "MANAGER";
    setEditingRole(role);
    setEditingTypeId(editingUser.manager_type_id ?? "");
    // Only re-initialize when switching to a different user — re-running on every
    // keystroke (editingUser mutates on each field change) would wipe out the
    // org placement the admin just picked in OrgPicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingUser?.id]);

  // ─── Derived data ─────────────────────────────────────────────────────────

  const managers = useMemo(
    () => users.filter((u) => u.role === "MANAGER" || u.role === "HOD"),
    [users]
  );

  const managerStatusCounts = useMemo(() => ({
    active:   managers.filter((u) => u.is_active !== false).length,
    inactive: managers.filter((u) => u.is_active === false).length,
  }), [managers]);

  const managementRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return managers
      .filter((u) => (statusView === "inactive" ? u.is_active === false : u.is_active !== false))
      .filter((u) => {
        if (divisionFilter !== "ALL" && (u.division_name ?? "Unassigned") !== divisionFilter) return false;
        if (roleFilter !== "ALL") {
          if (roleFilter.startsWith("TYPE:")) {
            if ((u.manager_type_name ?? "") !== roleFilter.slice(5)) return false;
          } else if (u.role !== roleFilter) {
            return false;
          }
        }
        if (!needle) return true;
        return [u.full_name, u.email, u.employee_no, u.title, u.department, u.division_name]
          .some((v) => String(v ?? "").toLowerCase().includes(needle));
      });
  }, [managers, search, divisionFilter, roleFilter, statusView]);

  // Department options grouped by division for the dropdown
  const deptsByDivision = useMemo(() => {
    const groups = new Map<string, DepartmentRow[]>();
    for (const d of departmentRows) {
      const key = d.division_name ?? "Unassigned Company";
      const arr = groups.get(key) ?? [];
      arr.push(d);
      groups.set(key, arr);
    }
    return groups;
  }, [departmentRows]);

  // Unique division names from management users for filter
  const divisionNames = useMemo(() => {
    const names = new Set<string>();
    managers.forEach((u) => names.add(u.division_name ?? "Unassigned"));
    return Array.from(names).sort();
  }, [managers]);

  // Unique manager type names (e.g. "Senior Manager", "Senior Operations
  // Manager") currently in use, for the role filter - lets admins filter
  // by the finer-grained type instead of just the blunt HOD/Manager role.
  const managerTypeNames = useMemo(() => {
    const names = new Set<string>();
    managers.forEach((u) => { if (u.manager_type_name) names.add(u.manager_type_name); });
    return Array.from(names).sort();
  }, [managers]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  function assignedDepartments(userId: string) {
    return departmentRows
      .filter((d) => d.manager_user_id === userId || d.hod_user_id === userId)
      .map((d) => d.name);
  }

  async function setDepartmentManager(departmentName: string, userId: string, role: "HOD" | "MANAGER", opts: { setPrimary?: boolean } = {}) {
    const dept = departmentRows.find((d) => d.name === departmentName);
    const patch = role === "HOD"
      ? { name: departmentName, hod_user_id: userId }
      : { name: departmentName, manager_user_id: userId };
    await api.updateDepartment(departmentName, patch);
    // Keep the manager's own Company in sync with the department they now
    // own — otherwise a manager assigned here via "Add division…" keeps
    // whatever (possibly blank) division_id they had before, and silently
    // drifts from the department's actual parent company.
    if (dept?.id && opts.setPrimary) {
      await api.updateUser(userId, { department: departmentName, division_id: dept.division_id ?? null });
    }
  }

  async function unassignDepartmentManager(departmentName: string, role: "HOD" | "MANAGER") {
    const patch = role === "HOD"
      ? { name: departmentName, hod_user_id: null }
      : { name: departmentName, manager_user_id: null };
    await api.updateDepartment(departmentName, patch);
  }

  function assignedSections(userId: string) {
    return sectionRows
      .filter((s) => s.manager_user_id === userId || s.hod_user_id === userId)
      .map((s) => s.name);
  }

  async function setSectionManager(sectionId: string, userId: string | null, role: "HOD" | "MANAGER") {
    await api.setSectionOwner(sectionId, { role, user_id: userId });
  }

  // Automatically assign a manager/HOD as the owner of the department and
  // section in their org placement, mirroring how their org path is set.
  async function autoAssignOrgPlacement(userId: string, role: "HOD" | "MANAGER", org: OrgSelection, opts: { setPrimary?: boolean } = {}) {
    if (org.department) {
      await setDepartmentManager(org.department, userId, role, opts);
    }
    if (org.sectionId) {
      await setSectionManager(org.sectionId, userId, role);
    }
  }

  async function handleAssignExisting(user: PickableUser) {
    setAssigning(true);
    try {
      if (fillingVacancyId) {
        await api.fillPositionVacancy(fillingVacancyId, { existing_user_id: user.id });
        setFillingVacancyId(null);
        await loadVacancies();
      } else {
        await api.updateUserRole(user.id, { role: assignRole });
        const dept = assignOrg.department || assignDept;
        if (dept) await autoAssignOrgPlacement(user.id, assignRole, { ...assignOrg, department: dept }, { setPrimary: true });
        // Save org IDs
        await api.updateUser(user.id, {
          division_id: assignOrg.divisionId ?? null,
          section_id: assignOrg.sectionId ?? null,
          team_id: assignOrg.teamId ?? null,
        });
      }
      setShowAssignModal(false);
      setAssignDept("");
      setAssignOrg(EMPTY_ORG);
      await Promise.all([load(), reloadStaff()]);
    } catch (e: any) {
      alert("Error assigning: " + e.message);
    } finally {
      setAssigning(false);
    }
  }

  function resetAddForm() {
    resetForm([setNewEmail, setNewFirstName, setNewSurname, setNewEmployeeNo]);
    setNewDepartment("");
    setNewTitle("Division Manager");
    setNewRole("MANAGER");
    setNewIsActive(true);
    setAssignAsDepartmentManager(true);
    setNewOrg(EMPTY_ORG);
    if (managerTypes.length > 0) setSelectedNewTypeId(managerTypes[0].id);
  }

  // ─── Manager Type helpers ─────────────────────────────────────────────────

  function resolvedNewRole(): "HOD" | "MANAGER" {
    const t = managerTypes.find((x) => x.id === selectedNewTypeId);
    return (t?.role as "HOD" | "MANAGER") || newRole;
  }

  function resolvedAssignRole(): "HOD" | "MANAGER" {
    const t = managerTypes.find((x) => x.id === selectedAssignTypeId);
    return (t?.role as "HOD" | "MANAGER") || assignRole;
  }

  function openAddTypeModal(type?: MgrType) {
    if (type) {
      setEditingType(type);
      setTypeFormName(type.name);
      setTypeFormRole(type.role as "HOD" | "MANAGER");
      setTypeFormDesc(type.description || "");
      setTypeFormActive(type.active);
    } else {
      setEditingType(null);
      setTypeFormName(""); setTypeFormRole("MANAGER"); setTypeFormDesc(""); setTypeFormActive(true);
    }
    setShowAddTypeModal(true);
  }

  async function saveType() {
    if (!typeFormName.trim()) { alert("Name is required."); return; }
    setTypeSaving(true);
    try {
      if (editingType) {
        await api.updateManagerType(editingType.id, { name: typeFormName.trim(), role: typeFormRole, description: typeFormDesc.trim() || null, active: typeFormActive });
      } else {
        await api.createManagerType({ name: typeFormName.trim(), role: typeFormRole, description: typeFormDesc.trim() || null });
      }
      setShowAddTypeModal(false);
      await load();
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setTypeSaving(false);
    }
  }

  async function deleteType(t: MgrType) {
    const confirmed = await confirmAction({ title: "Deactivate type?", text: `Deactivate "${t.name}"? Existing managers will keep their roles.`, confirmButtonText: "Deactivate" });
    if (!confirmed) return;
    try {
      await api.deleteManagerType(t.id);
      await load();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  async function createManager() {
    if (fillingVacancyId) {
      if (!newFirstName.trim() || !newSurname.trim() || !newEmail.trim()) {
        alert("Please fill first name, surname, and email.");
        return;
      }
      setCreating(true);
      try {
        const fullName = `${newFirstName.trim()} ${newSurname.trim()}`;
        await api.fillPositionVacancy(fillingVacancyId, {
          email: newEmail.trim(),
          full_name: fullName,
          employee_no: newEmployeeNo.trim() || undefined,
          title: newTitle.trim() || undefined
        });
        setFillingVacancyId(null);
        resetAddForm();
        setShowAddModal(false);
        await Promise.all([load(), reloadStaff(), loadVacancies()]);
        alert("Saved.");
      } catch (e: any) {
        alert("Error: " + e.message);
      } finally {
        setCreating(false);
      }
      return;
    }

    const effectiveDept = newOrg.department || newDepartment;
    if (!newFirstName.trim() || !newSurname.trim() || !newEmail.trim() || !effectiveDept.trim()) {
      alert("Please fill first name, surname, email, and division.");
      return;
    }
    setCreating(true);
    try {
      const fullName = `${newFirstName.trim()} ${newSurname.trim()}`;
      const effectiveRole = resolvedNewRole();
      const selectedTypeName = managerTypes.find((x) => x.id === selectedNewTypeId)?.name;
      const created: UserRow = await api.createUser({
        email: newEmail.trim(),
        full_name: fullName,
        employee_no: newEmployeeNo.trim() || undefined,
        department: effectiveDept,
        division_id: newOrg.divisionId ?? null,
        section_id: newOrg.sectionId ?? null,
        team_id: newOrg.teamId ?? null,
        role: effectiveRole,
        title: newTitle.trim() || selectedTypeName || "Division Manager",
        is_active: newIsActive,
        manager_type_id: selectedNewTypeId || null,
      });
      if (assignAsDepartmentManager) {
        await autoAssignOrgPlacement(created.id, effectiveRole, { ...newOrg, department: effectiveDept }, { setPrimary: true });
      }
      resetAddForm();
      setShowAddModal(false);
      await Promise.all([load(), reloadStaff()]);
      alert("Saved.");
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setCreating(false);
    }
  }

  async function saveManager() {
    if (!editingUser) return;
    if (!editingFirstName.trim() || !editingSurname.trim() || !editingUser.email?.trim() || !editingUser.department?.trim()) {
      alert("Please fill all required fields.");
      return;
    }
    setSavingManager(true);
    try {
      const fullName = `${editingFirstName.trim()} ${editingSurname.trim()}`;
      const effectiveDept = editingOrg.department || editingUser.department;
      await api.updateUser(editingUser.id, {
        full_name: fullName,
        employee_no: editingUser.employee_no?.trim() || null,
        title: editingUser.title || "Division Manager",
        department: effectiveDept,
        division_id: editingOrg.divisionId ?? null,
        section_id: editingOrg.sectionId ?? null,
        team_id: editingOrg.teamId ?? null,
        email: editingUser.email,
        is_active: editingUser.is_active !== false,
        manager_type_id: editingTypeId || null,
      });
      if (editingRole !== editingUser.role) {
        await api.updateUserRole(editingUser.id, { role: editingRole });
      }
      if (editingSetAsDeptManager && editingUser.department) {
        await setDepartmentManager(editingUser.department, editingUser.id, editingRole);
      }
      setEditingUser(null);
      await Promise.all([load(), reloadStaff()]);
      alert("Saved.");
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setSavingManager(false);
    }
  }

  async function deactivate(user: UserRow) {
    const confirmed = await confirmAction({
      title: "Deactivate user?",
      text: `Deactivate ${user.full_name || user.email}?`,
      confirmButtonText: "Deactivate"
    });
    if (!confirmed) return;
    try {
      await api.updateUser(user.id, { is_active: false });
      await reloadStaff();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  async function reactivate(user: UserRow) {
    const confirmed = await confirmAction({
      title: "Reactivate user?",
      text: `Reactivate ${user.full_name || user.email}? They will be able to log in again.`,
      confirmButtonText: "Reactivate"
    });
    if (!confirmed) return;
    try {
      await api.updateUser(user.id, { is_active: true });
      await reloadStaff();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  // ─── Dept dropdown with option groups ────────────────────────────────────

  function DeptSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select division</option>
        {[...deptsByDivision.entries()].map(([divName, depts]) => (
          <optgroup key={divName} label={`── ${divName}`}>
            {depts.map((d) => (
              <option key={d.name} value={d.name}>{d.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const fieldSt: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", fontSize: 13, boxSizing: "border-box" };

  return (
    <div className="onboarding-page ep-page">
      <div className="ep-breadcrumb">
        <span>Administration</span>
        <ChevronRight size={13} />
        <span>Organizational Structure</span>
        <ChevronRight size={13} />
        <span className="ep-breadcrumb-active">Management</span>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid var(--border)", paddingBottom: 0 }}>
        {([["MANAGERS", "Managers"], ["TYPES", "Manager Types"]] as const).map(([tab, label]) => (
          <button key={tab} type="button" onClick={() => setActiveTab(tab)} style={{
            padding: "8px 20px", border: "none", borderBottom: activeTab === tab ? "2px solid #1d4ed8" : "2px solid transparent",
            background: "none", cursor: "pointer", fontWeight: activeTab === tab ? 700 : 500,
            color: activeTab === tab ? "#1d4ed8" : "var(--muted)", fontSize: 14, marginBottom: -2,
          }}>
            {tab === "TYPES" && <Layers size={13} style={{ marginRight: 5, verticalAlign: "middle" }} />}
            {label}
          </button>
        ))}
      </div>

      {/* ── Manager Types panel ──────────────────────────────────────────────── */}
      {activeTab === "TYPES" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Manager Types</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>Define the types of managers in your organisation. These appear as options when onboarding managers.</div>
            </div>
            <button type="button" onClick={() => openAddTypeModal()} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
              <Plus size={14} /> Add Type
            </button>
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-soft)", borderBottom: "2px solid var(--border)" }}>
                  {["Type Name", "Maps To Role", "Description", "Status", ""].map((h) => (
                    <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {managerTypes.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>No manager types configured yet.</td></tr>
                ) : managerTypes.map((t) => (
                  <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13 }}>{t.name}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 600, background: t.role === "HOD" ? "#dbeafe" : "#dcfce7", color: t.role === "HOD" ? "#1d4ed8" : "#15803d" }}>{t.role}</span>
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--muted)" }}>{t.description || "—"}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 600, background: t.active ? "#dcfce7" : "#fee2e2", color: t.active ? "#15803d" : "#b91c1c" }}>
                        {t.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button type="button" onClick={() => openAddTypeModal(t)} style={{ padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", cursor: "pointer", color: "var(--muted)", display: "flex" }}><Edit3 size={13} /></button>
                        {t.active && <button type="button" onClick={() => void deleteType(t)} style={{ padding: "5px 8px", border: "1px solid #fecaca", borderRadius: 6, background: "#fff5f5", cursor: "pointer", color: "#ef4444", display: "flex" }}><Trash2 size={13} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add/Edit type modal */}
          {showAddTypeModal && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowAddTypeModal(false)}>
              <div style={{ background: "var(--surface)", borderRadius: 12, padding: 28, width: 440, maxWidth: "95vw", boxShadow: "0 16px 48px rgba(0,0,0,0.22)" }} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{editingType ? "Edit Manager Type" : "Add Manager Type"}</div>
                  <button onClick={() => setShowAddTypeModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}><X size={16} /></button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 4 }}>Type Name *</label>
                    <input value={typeFormName} onChange={(e) => setTypeFormName(e.target.value)} placeholder="e.g. Senior Manager" style={fieldSt} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 4 }}>Maps To System Role *</label>
                    <select value={typeFormRole} onChange={(e) => setTypeFormRole(e.target.value as "HOD" | "MANAGER")} style={fieldSt}>
                      <option value="MANAGER">MANAGER — Division Manager</option>
                      <option value="HOD">HOD — Head of Division</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 4 }}>Description</label>
                    <input value={typeFormDesc} onChange={(e) => setTypeFormDesc(e.target.value)} placeholder="Optional description" style={fieldSt} />
                  </div>
                  {editingType && (
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 4 }}>Status</label>
                      <select value={typeFormActive ? "active" : "inactive"} onChange={(e) => setTypeFormActive(e.target.value === "active")} style={fieldSt}>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
                  <button onClick={() => setShowAddTypeModal(false)} style={{ padding: "7px 16px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
                  <button onClick={() => void saveType()} disabled={typeSaving} style={{ padding: "7px 18px", background: typeSaving ? "#93c5fd" : "#1d4ed8", color: "#fff", border: "none", borderRadius: 6, cursor: typeSaving ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}>
                    {typeSaving ? "Saving…" : editingType ? "Save Changes" : "Add Type"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Managers panel (existing) ────────────────────────────────────────── */}
      {activeTab === "MANAGERS" && (
      <div style={{ display: "contents" }}>

      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Management</h1>
          <p className="ep-subtitle">Manage Heads of Division (HOD) and Managers and connect them to divisions for approval routing.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" type="button" onClick={() => { resetVacancyForm(); setShowVacancyModal(true); }}>
            <Plus size={15} aria-hidden /> Create Vacant Position
          </button>
          <button className="ep-btn-outline" type="button" onClick={() => { setFillingVacancyId(null); setAssignDept(""); setAssignRole("MANAGER"); setSelectedAssignTypeId(managerTypes[0]?.id || ""); setShowAssignModal(true); }}>
            <UserCheck size={15} aria-hidden /> Assign Existing User
          </button>
          <button className="ep-btn" type="button" onClick={() => { setFillingVacancyId(null); resetAddForm(); setShowAddModal(true); }}>
            <UserPlus size={15} aria-hidden /> Create New Account
          </button>
        </div>
      </div>

      {/* Vacant Positions */}
      {vacancies.length > 0 && (
        <section className="onboarding-panel" style={{ marginBottom: 16 }}>
          <div className="onboarding-table-wrap">
            <table className="table onboarding-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Role</th>
                  <th>Org Path</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {vacancies.map((v) => (
                  <tr key={v.id} style={{ background: "var(--surface-soft)" }}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="status-pill" style={{ background: "#fef3c7", color: "#92400e" }}>Vacant</span>
                        <strong>{v.title || "Manager"}</strong>
                      </div>
                    </td>
                    <td><RoleBadge role={v.role} /></td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>
                      {[v.division_name, v.department, v.section_name, v.team_name].filter(Boolean).join(" › ") || "—"}
                    </td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>
                      {v.created_at ? new Date(v.created_at).toLocaleDateString() : "—"}
                    </td>
                    <td>
                      <div className="onboarding-row-actions">
                        <button className="icon-button leadership-icon-button" type="button" title="Assign existing user" onClick={() => openFillWithAssign(v.id)}><UserCheck size={16} aria-hidden /></button>
                        <button className="icon-button leadership-icon-button" type="button" title="Create new account" onClick={() => openFillWithCreate(v.id)}><UserPlus size={16} aria-hidden /></button>
                        <button className="icon-button leadership-icon-button danger" type="button" title="Remove vacancy" onClick={() => void handleRemoveVacancy(v.id)}><Trash2 size={16} aria-hidden /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Add modal */}
      {showAddModal && (
        <div className="leadership-modal-backdrop" onClick={() => !creating && (setShowAddModal(false), setFillingVacancyId(null))}>
          <div className="leadership-modal onboarding-modal" onClick={(e) => e.stopPropagation()}>
            <div className="leadership-modal-head">
              <h3>{fillingVacancyId ? "Fill Vacant Position" : "Add Manager / HOD"}</h3>
              <button className="icon-button leadership-icon-button" type="button" onClick={() => { setShowAddModal(false); setFillingVacancyId(null); }} disabled={creating} aria-label="Close"><X size={17} aria-hidden /></button>
            </div>
            <div className="onboarding-form-grid onboarding-form-grid-2">
              <label><span>First Name *</span><input value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} placeholder="First name" /></label>
              <label><span>Surname *</span><input value={newSurname} onChange={(e) => setNewSurname(e.target.value)} placeholder="Surname" /></label>
              <label><span>Employee Number</span><input value={newEmployeeNo} onChange={(e) => setNewEmployeeNo(e.target.value)} placeholder="Employee No." /></label>
              {!fillingVacancyId && (
                <label>
                  <span>Manager Type *</span>
                  {managerTypes.filter((t) => t.active).length > 0 ? (
                    <select value={selectedNewTypeId} onChange={(e) => {
                      setSelectedNewTypeId(e.target.value);
                      const t = managerTypes.find((x) => x.id === e.target.value);
                      if (t) { setNewRole(t.role as "HOD" | "MANAGER"); setNewTitle(t.name); }
                    }}>
                      {managerTypes.filter((t) => t.active).map((t) => (
                        <option key={t.id} value={t.id}>{t.name} ({t.role})</option>
                      ))}
                    </select>
                  ) : (
                    <select value={newRole} onChange={(e) => setNewRole(e.target.value as "HOD" | "MANAGER")}>
                      <option value="MANAGER">Manager</option>
                      <option value="HOD">Head of Division (HOD)</option>
                    </select>
                  )}
                </label>
              )}
              <label><span>Position / Title</span><input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Division Manager" /></label>
              <label><span>Username or Email *</span><input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@etl.co.ls" /></label>
              {!fillingVacancyId && (
                <>
                  <label className="onboarding-check"><input type="checkbox" checked={newIsActive} onChange={(e) => setNewIsActive(e.target.checked)} /> Active</label>
                  <label className="onboarding-check"><input type="checkbox" checked={assignAsDepartmentManager} onChange={(e) => setAssignAsDepartmentManager(e.target.checked)} /> Assign as division {newRole === "HOD" ? "HOD" : "manager"}</label>
                  <div style={{ gridColumn: "1/-1", borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Org Placement *</div>
                    <OrgPicker value={newOrg} onChange={(sel) => { setNewOrg(sel); if (sel.department) setNewDepartment(sel.department); }} />
                  </div>
                </>
              )}
            </div>
            <div className="leadership-modal-actions">
              <button className="button small-button button-subtle" type="button" onClick={() => { setShowAddModal(false); setFillingVacancyId(null); }} disabled={creating}>Cancel</button>
              <button className="button button-primary" type="button" onClick={() => void createManager()} disabled={creating}>{creating ? "Saving…" : fillingVacancyId ? "Fill Position" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Table panel */}
      <section className="onboarding-panel">
        {/* Active / Inactive view toggle — deactivated managers get their own
            section instead of being mixed into the working roster */}
        <div style={{ display: "flex", gap: 6, padding: "12px 16px 0" }}>
          {([
            { key: "active",   label: `Active (${managerStatusCounts.active})` },
            { key: "inactive", label: `Inactive (${managerStatusCounts.inactive})` },
          ] as const).map(({ key, label }) => (
            <button key={key} type="button" onClick={() => setStatusView(key)}
              style={{
                padding: "6px 14px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer",
                border: statusView === key ? "1px solid #3b82f6" : "1px solid var(--border)",
                background: statusView === key ? "#eff6ff" : "var(--surface-soft)",
                color: statusView === key ? "#1d4ed8" : "var(--muted)",
              }}>
              {label}
            </button>
          ))}
        </div>
        <div className="onboarding-toolbar">
          <div className="onboarding-search">
            <Search size={18} aria-hidden />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, email, division…" />
          </div>

          {/* Division filter */}
          {divisionNames.length > 1 && (
            <select value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)} style={{ fontSize: 13, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)" }}>
              <option value="ALL">All Companies</option>
              {divisionNames.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}

          {/* Role filter */}
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={{ fontSize: 13, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)" }}>
            <option value="ALL">All Roles</option>
            <option value="HOD">HOD Only</option>
            <option value="MANAGER">Manager Only</option>
            {managerTypeNames.length > 0 && (
              <optgroup label="By Type">
                {managerTypeNames.map((name) => (
                  <option key={name} value={`TYPE:${name}`}>{name}</option>
                ))}
              </optgroup>
            )}
          </select>

          <button className="button small-button button-subtle" type="button" onClick={() => { void load(); void reloadStaff(); }} disabled={loading || staffLoading}>
            <RefreshCw size={16} aria-hidden />
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        <div className="onboarding-table-wrap">
          <table className="table onboarding-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Org Path</th>
                <th>Title</th>
                <th>Email</th>
                <th>Assignment</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {managementRows.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: "center" }}>{loading || staffLoading ? "Loading…" : statusView === "inactive" ? "No inactive managers." : "No results found."}</td></tr>
              ) : managementRows.map((mgr: UserRow) => {
                const assigned = assignedDepartments(mgr.id);
                const orgPath = [mgr.division_name, mgr.department, mgr.section_name, mgr.team_name]
                  .filter(Boolean).join(" › ");
                return (
                  <tr key={mgr.id}>
                    <td>
                      <div className="onboarding-person">
                        <span className="onboarding-avatar"><UserRoundCheck size={16} aria-hidden /></span>
                        <span>
                          <strong>{mgr.full_name || mgr.email}</strong>
                          <small style={{ display: "block", color: "var(--muted)", fontSize: 11 }}>{initials(mgr.full_name)}</small>
                        </span>
                      </div>
                    </td>
                    <td>
                      {mgr.manager_type_name
                        ? <RoleBadge role={mgr.manager_type_role} label={mgr.manager_type_name} />
                        : <RoleBadge role={mgr.role} />}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        {orgPath || mgr.department || "—"}
                      </span>
                    </td>
                    <td>{mgr.title || "—"}</td>
                    <td>{mgr.email}</td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                        {assigned.map((deptName) => (
                          <span key={deptName} className="status-pill status-pill-success" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <CheckCircle2 size={13} aria-hidden /> {deptName}
                            <button
                              className="icon-button"
                              type="button"
                              title={`Remove from ${deptName}`}
                              style={{ width: 16, height: 16, padding: 0 }}
                              onClick={() => void unassignDepartmentManager(deptName, (mgr.role ?? "MANAGER") as "HOD" | "MANAGER").then(() => Promise.all([load(), reloadStaff()]))}
                            >
                              <X size={11} aria-hidden />
                            </button>
                          </span>
                        ))}
                        <div style={{ display: "flex", gap: 4 }}>
                          <select
                            value={addDeptSelection[mgr.id] ?? ""}
                            onChange={(e) => setAddDeptSelection((prev) => ({ ...prev, [mgr.id]: e.target.value }))}
                            style={{ fontSize: 11, padding: "2px 4px", maxWidth: 140 }}
                          >
                            <option value="">Add division…</option>
                            {[...deptsByDivision.entries()].map(([divName, depts]) => (
                              <optgroup key={divName} label={divName}>
                                {depts.filter((d) => !assigned.includes(d.name)).map((d) => (
                                  <option key={d.name} value={d.name}>{d.name}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <button
                            className="link-button"
                            type="button"
                            disabled={!addDeptSelection[mgr.id]}
                            onClick={() => {
                              const deptName = addDeptSelection[mgr.id];
                              if (!deptName) return;
                              void setDepartmentManager(deptName, mgr.id, (mgr.role ?? "MANAGER") as "HOD" | "MANAGER", { setPrimary: assigned.length === 0 })
                                .then(() => {
                                  setAddDeptSelection((prev) => ({ ...prev, [mgr.id]: "" }));
                                  return Promise.all([load(), reloadStaff()]);
                                });
                            }}
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </td>
                    <td>
                      {mgr.is_active !== false
                        ? <span className="status-pill status-pill-success">Active</span>
                        : <span className="status-pill status-pill-warning">Inactive</span>}
                    </td>
                    <td>
                      <div className="onboarding-row-actions">
                        <button className="icon-button leadership-icon-button" type="button" title="Edit" onClick={() => setEditingUser(mgr)}><Edit3 size={16} aria-hidden /></button>
                        {mgr.is_active !== false ? (
                          <button className="icon-button leadership-icon-button danger" type="button" title="Deactivate" onClick={() => void deactivate(mgr)}><Trash2 size={16} aria-hidden /></button>
                        ) : (
                          <button className="icon-button leadership-icon-button" type="button" title="Reactivate" onClick={() => void reactivate(mgr)}><UserCheck size={16} aria-hidden /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Edit modal */}
      {editingUser && (
        <div className="leadership-modal-backdrop">
          <div className="leadership-modal onboarding-modal">
            <div className="leadership-modal-head">
              <h3>Edit — {editingUser.full_name || editingUser.email}</h3>
              <button className="icon-button leadership-icon-button" type="button" onClick={() => setEditingUser(null)} disabled={savingManager} aria-label="Close"><X size={17} aria-hidden /></button>
            </div>
            <div className="onboarding-form-grid onboarding-form-grid-2">
              <label><span>First Name *</span><input value={editingFirstName} onChange={(e) => setEditingFirstName(e.target.value)} /></label>
              <label><span>Surname *</span><input value={editingSurname} onChange={(e) => setEditingSurname(e.target.value)} /></label>
              <label><span>Employee Number</span><input value={editingUser.employee_no || ""} onChange={(e) => setEditingUser({ ...editingUser, employee_no: e.target.value })} /></label>
              <label>
                <span>Manager Type *</span>
                {managerTypes.filter((t) => t.active).length > 0 ? (
                  <select value={editingTypeId} onChange={(e) => {
                    setEditingTypeId(e.target.value);
                    const t = managerTypes.find((x) => x.id === e.target.value);
                    if (t) { setEditingRole(t.role as "HOD" | "MANAGER"); setEditingUser({ ...editingUser, title: t.name }); }
                  }}>
                    <option value="">— None (show role only: {editingUser.role === "HOD" ? "HOD" : "MANAGER"}) —</option>
                    {managerTypes.filter((t) => t.active).map((t) => (
                      <option key={t.id} value={t.id}>{t.name} ({t.role})</option>
                    ))}
                  </select>
                ) : (
                  <select value={editingRole} onChange={(e) => setEditingRole(e.target.value as "HOD" | "MANAGER")}>
                    <option value="MANAGER">Manager</option>
                    <option value="HOD">Head of Division (HOD)</option>
                  </select>
                )}
              </label>
              <label><span>Position / Title</span><input value={editingUser.title || ""} onChange={(e) => setEditingUser({ ...editingUser, title: e.target.value })} /></label>
              <label><span>Username or Email *</span><input value={editingUser.email || ""} onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })} /></label>
              <label className="onboarding-check"><input type="checkbox" checked={editingUser.is_active !== false} onChange={(e) => setEditingUser({ ...editingUser, is_active: e.target.checked })} /> Active</label>
              <label className="onboarding-check"><input type="checkbox" checked={editingSetAsDeptManager} onChange={(e) => setEditingSetAsDeptManager(e.target.checked)} /> Update division assignment</label>
              <div style={{ gridColumn: "1/-1", borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Org Placement</div>
                <OrgPicker value={editingOrg} onChange={(sel) => { setEditingOrg(sel); if (sel.department) setEditingUser({ ...editingUser, department: sel.department }); }} />
              </div>
            </div>
            <div className="leadership-modal-actions">
              <button className="button small-button button-subtle" type="button" onClick={() => setEditingUser(null)} disabled={savingManager}>Cancel</button>
              <button className="button button-primary" type="button" onClick={() => void saveManager()} disabled={savingManager}>{savingManager ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Assign existing user as Manager / HOD */}
      {showAssignModal && (
        <UserPicker
          title={fillingVacancyId ? "Fill Vacant Position" : "Assign Existing User as Manager / HOD"}
          subtitle={fillingVacancyId
            ? "Search and select an employee to fill this vacant position. They'll receive an invitation."
            : "Pick an employee to promote to Manager or HOD and connect them to a division."}
          users={users}
          excludeRoles={[]}
          onClose={() => { setShowAssignModal(false); setFillingVacancyId(null); }}
          onSelect={handleAssignExisting}
          saving={assigning}
          saveLabel={fillingVacancyId ? "Fill Position" : `Assign as ${resolvedAssignRole() === "HOD" ? "HOD" : "Manager"}`}
          extra={
            fillingVacancyId ? undefined : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--muted)", marginBottom: 4 }}>Manager Type *</label>
                {managerTypes.filter((t) => t.active).length > 0 ? (
                  <select
                    value={selectedAssignTypeId}
                    onChange={(e) => {
                      setSelectedAssignTypeId(e.target.value);
                      const t = managerTypes.find((x) => x.id === e.target.value);
                      if (t) setAssignRole(t.role as "HOD" | "MANAGER");
                    }}
                    style={{ width: "100%", padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", fontSize: 13 }}
                  >
                    {managerTypes.filter((t) => t.active).map((t) => (
                      <option key={t.id} value={t.id}>{t.name} ({t.role})</option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={assignRole}
                    onChange={(e) => setAssignRole(e.target.value as "HOD" | "MANAGER")}
                    style={{ width: "100%", padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", fontSize: 13 }}
                  >
                    <option value="MANAGER">Manager</option>
                    <option value="HOD">Head of Division (HOD)</option>
                  </select>
                )}
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Org Placement (optional)</div>
                <OrgPicker value={assignOrg} onChange={(sel) => { setAssignOrg(sel); if (sel.department) setAssignDept(sel.department); }} />
              </div>
            </div>
            )
          }
        />
      )}

      {/* Create Vacant Position */}
      {showVacancyModal && (
        <div className="leadership-modal-backdrop" onClick={() => !creatingVacancy && setShowVacancyModal(false)}>
          <div className="leadership-modal onboarding-modal" onClick={(e) => e.stopPropagation()}>
            <div className="leadership-modal-head">
              <h3>Create Vacant Position</h3>
              <button className="icon-button leadership-icon-button" type="button" onClick={() => setShowVacancyModal(false)} disabled={creatingVacancy} aria-label="Close"><X size={17} aria-hidden /></button>
            </div>
            <div className="onboarding-form-grid onboarding-form-grid-2">
              <label>
                <span>Manager Type / Role *</span>
                {managerTypes.filter((t) => t.active).length > 0 ? (
                  <select value={vacancyTypeId} onChange={(e) => {
                    setVacancyTypeId(e.target.value);
                    const t = managerTypes.find((x) => x.id === e.target.value);
                    if (t) setVacancyRole(t.role as "HOD" | "MANAGER");
                  }}>
                    {managerTypes.filter((t) => t.active).map((t) => (
                      <option key={t.id} value={t.id}>{t.name} ({t.role})</option>
                    ))}
                  </select>
                ) : (
                  <select value={vacancyRole} onChange={(e) => setVacancyRole(e.target.value as "HOD" | "MANAGER")}>
                    <option value="MANAGER">Manager</option>
                    <option value="HOD">Head of Division (HOD)</option>
                  </select>
                )}
              </label>
              <label><span>Title <span style={{ fontWeight: 400, color: "var(--muted)" }}>(optional)</span></span><input value={vacancyTitle} onChange={(e) => setVacancyTitle(e.target.value)} placeholder="Division Manager" /></label>
              <div style={{ gridColumn: "1/-1", borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Org Placement</div>
                <OrgPicker value={vacancyOrg} onChange={setVacancyOrg} />
              </div>
            </div>
            <div className="leadership-modal-actions">
              <button className="button small-button button-subtle" type="button" onClick={() => setShowVacancyModal(false)} disabled={creatingVacancy}>Cancel</button>
              <button className="button button-primary" type="button" onClick={() => void handleCreateVacancy()} disabled={creatingVacancy}>{creatingVacancy ? "Saving…" : "Create Vacant Position"}</button>
            </div>
          </div>
        </div>
      )}

      </div>
      )}
    </div>
  );
}
