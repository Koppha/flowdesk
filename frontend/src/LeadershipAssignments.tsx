import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  ChevronLeft,
  ChevronRight,
  Edit3,
  Filter,
  MoreVertical,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert,
  UserPlus,
  UserRound,
  UsersRound,
  X
} from "lucide-react";

type LeadershipUser = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no?: string | null;
  department?: string | null;
  role?: string | null;
};

type DepartmentAssignment = {
  id: string;
  name: string;
  section_id: string | null;
  section_name: string | null;
  manager_user_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
  exco_user_id: string | null;
  exco_name: string | null;
  exco_email: string | null;
  section_exco_user_id: string | null;
  section_exco_name: string | null;
  section_exco_email: string | null;
  active: boolean;
};

type PersonSummary = {
  id?: string | null;
  name: string;
  email?: string | null;
  title: string;
};

type AssignmentStatus = "complete" | "no-manager" | "no-exco" | "unassigned" | "inactive";

const PAGE_SIZE = 8;

function initials(value: string | null | undefined) {
  return String(value || "User")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "U";
}

function personFromFields(id: string | null, name: string | null, email: string | null, title: string): PersonSummary | null {
  if (!id && !name && !email) return null;
  return {
    id,
    name: name || email || "Not Assigned",
    email,
    title
  };
}

function findPerson(users: LeadershipUser[], id: string | null, name: string | null, email: string | null, title: string) {
  const match = id ? users.find((user) => user.id === id) : null;
  if (match) {
    return {
      id: match.id,
      name: match.full_name || match.email,
      email: match.email,
      title
    };
  }
  return personFromFields(id, name, email, title);
}

function getManager(department: DepartmentAssignment, users: LeadershipUser[]) {
  return findPerson(users, department.manager_user_id, department.manager_name, department.manager_email, "Manager");
}

function getExco(department: DepartmentAssignment, users: LeadershipUser[]) {
  return findPerson(users, department.exco_user_id, department.exco_name, department.exco_email, "Chief Officer");
}

function statusKey(department: DepartmentAssignment): AssignmentStatus {
  if (!department.active) return "inactive";
  if (!department.manager_user_id && !department.exco_user_id) return "unassigned";
  if (!department.manager_user_id) return "no-manager";
  if (!department.exco_user_id) return "no-exco";
  return "complete";
}

function statusLabel(status: AssignmentStatus) {
  switch (status) {
    case "complete":
      return "Complete";
    case "no-manager":
      return "No Manager";
    case "no-exco":
      return "No EXCO Owner";
    case "inactive":
      return "Inactive";
    default:
      return "Unassigned";
  }
}

function statusClass(status: AssignmentStatus) {
  if (status === "complete") return "status-pill status-pill-success";
  if (status === "inactive") return "status-pill status-pill-neutral";
  return "status-pill status-pill-warning";
}

function departmentCode(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((word) => word[0]).join("").slice(0, 4).toUpperCase();
}

function leadershipDescription(department: DepartmentAssignment) {
  const section = department.section_name || "the organization";
  return `Responsible for ${department.name.toLowerCase()} planning, approvals, reporting, and operational accountability within ${section}.`;
}

function lastUpdatedLabel() {
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
}

export default function LeadershipAssignments() {
  const [departments, setDepartments] = useState<DepartmentAssignment[]>([]);
  const [managers, setManagers] = useState<LeadershipUser[]>([]);
  const [excoUsers, setExcoUsers] = useState<LeadershipUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [draftDepartmentId, setDraftDepartmentId] = useState("");
  const [draftManagerId, setDraftManagerId] = useState("");
  const [draftExcoId, setDraftExcoId] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [departmentRows, leaders] = await Promise.all([
        api.departmentsWithSections(),
        api.leadershipUsers()
      ]);
      const nextDepartments = Array.isArray(departmentRows) ? departmentRows : [];
      setDepartments(nextDepartments);
      setManagers(Array.isArray(leaders?.managers) ? leaders.managers : []);
      setExcoUsers(Array.isArray(leaders?.exco) ? leaders.exco : []);
      setSelectedId((current) => current || nextDepartments[0]?.id || null);
    } catch (err: any) {
      setError(err?.message || "Unable to load leadership assignments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const sections = useMemo(() => {
    return Array.from(new Set(departments.map((department) => department.section_name || "Unassigned Section"))).sort((a, b) => a.localeCompare(b));
  }, [departments]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return departments.filter((department) => {
      const manager = getManager(department, managers);
      const exco = getExco(department, excoUsers);
      const section = department.section_name || "Unassigned Section";
      const status = statusKey(department);
      if (sectionFilter !== "ALL" && section !== sectionFilter) return false;
      if (statusFilter === "INCOMPLETE" && status === "complete") return false;
      if (statusFilter !== "ALL" && statusFilter !== "INCOMPLETE" && status !== statusFilter) return false;
      if (!query) return true;
      return [
        department.name,
        section,
        manager?.name,
        manager?.email,
        exco?.name,
        exco?.email
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [departments, excoUsers, managers, search, sectionFilter, statusFilter]);

  useEffect(() => {
    setPage(1);
  }, [search, sectionFilter, statusFilter]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((department) => department.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const boundedPage = Math.min(page, totalPages);
  const pagedDepartments = filtered.slice((boundedPage - 1) * PAGE_SIZE, boundedPage * PAGE_SIZE);
  const selectedDepartment = departments.find((department) => department.id === selectedId) || filtered[0] || null;
  const selectedManager = selectedDepartment ? getManager(selectedDepartment, managers) : null;
  const selectedExco = selectedDepartment ? getExco(selectedDepartment, excoUsers) : null;

  const stats = useMemo(() => {
    return {
      total: departments.length,
      withManager: departments.filter((department) => Boolean(department.manager_user_id)).length,
      withExco: departments.filter((department) => Boolean(department.exco_user_id)).length,
      unassigned: departments.filter((department) => statusKey(department) !== "complete").length
    };
  }, [departments]);

  function openAssignment(department?: DepartmentAssignment | null) {
    const target = department || selectedDepartment || departments[0] || null;
    setDraftDepartmentId(target?.id || "");
    setDraftManagerId(target?.manager_user_id || "");
    setDraftExcoId(target?.exco_user_id || "");
    setModalOpen(true);
  }

  async function saveAssignment() {
    const department = departments.find((item) => item.id === draftDepartmentId);
    if (!department) {
      alert("Choose a department first.");
      return;
    }
    setSaving(true);
    try {
      await api.updateDepartment(department.name, {
        name: department.name,
        manager_user_id: draftManagerId || null,
        exco_user_id: draftExcoId || null
      });
      setModalOpen(false);
      await load();
      setSelectedId(department.id);
    } catch (err: any) {
      alert("Error saving leadership assignment: " + (err?.message || err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="leadership-page">
      <div className="leadership-heading">
        <div>
          <h2>Leadership Assignments</h2>
          <p>Assign Managers and EXCO Owners to departments. These assignments drive the approval workflow.</p>
        </div>
        <div className="leadership-breadcrumb">
          <span>Administration</span>
          <span>Organizational Structure</span>
          <strong>Leadership Assignments</strong>
        </div>
      </div>

      {error && <div className="leadership-error">{error}</div>}

      <div className="leadership-stat-row">
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("ALL")}>
          <span className="leadership-stat-icon blue"><UsersRound size={22} aria-hidden /></span>
          <span><strong>{stats.total}</strong><small>Total Departments</small></span>
        </button>
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("ALL")}>
          <span className="leadership-stat-icon green"><UserRound size={22} aria-hidden /></span>
          <span><strong>{stats.withManager}</strong><small>Departments with Manager</small></span>
        </button>
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("ALL")}>
          <span className="leadership-stat-icon violet"><UserRound size={22} aria-hidden /></span>
          <span><strong>{stats.withExco}</strong><small>Departments with EXCO Owner</small></span>
        </button>
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("INCOMPLETE")}>
          <span className="leadership-stat-icon amber"><TriangleAlert size={22} aria-hidden /></span>
          <span><strong>{stats.unassigned}</strong><small>Unassigned Departments</small></span>
          <em>View</em>
        </button>
      </div>

      <div className="leadership-toolbar">
        <div className="leadership-search">
          <Search size={18} aria-hidden />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search department..." />
        </div>
        <select value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)}>
          <option value="ALL">All Sections</option>
          {sections.map((section) => <option key={section} value={section}>{section}</option>)}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="ALL">All Statuses</option>
          <option value="complete">Complete</option>
          <option value="INCOMPLETE">Needs Assignment</option>
          <option value="no-manager">No Manager</option>
          <option value="no-exco">No EXCO Owner</option>
          <option value="unassigned">Unassigned</option>
          <option value="inactive">Inactive</option>
        </select>
        <button className="button small-button button-subtle" type="button"><Filter size={16} aria-hidden /> Filters</button>
        <button className="icon-button leadership-icon-button" type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh assignments" title="Refresh assignments">
          <RefreshCw size={17} aria-hidden />
        </button>
        <button className="button button-primary leadership-assign-button" type="button" onClick={() => openAssignment()}>
          <UserPlus size={17} aria-hidden /> Assign Leadership
        </button>
        <button className="icon-button leadership-icon-button" type="button" aria-label="More actions" title="More actions"><MoreVertical size={17} aria-hidden /></button>
      </div>

      <div className="leadership-layout">
        <section className="leadership-table-card">
          <div className="leadership-table-scroll">
            <table className="leadership-table">
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Section</th>
                  <th>Manager</th>
                  <th>EXCO Owner</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && !departments.length ? (
                  <tr><td colSpan={6} className="leadership-empty">Loading assignments...</td></tr>
                ) : pagedDepartments.length === 0 ? (
                  <tr><td colSpan={6} className="leadership-empty">No departments match the selected filters.</td></tr>
                ) : (
                  pagedDepartments.map((department) => {
                    const manager = getManager(department, managers);
                    const exco = getExco(department, excoUsers);
                    const status = statusKey(department);
                    const selected = department.id === selectedDepartment?.id;
                    return (
                      <tr key={department.id} className={selected ? "is-selected" : ""} onClick={() => setSelectedId(department.id)}>
                        <td><strong>{department.name}</strong></td>
                        <td>{department.section_name || "Unassigned Section"}</td>
                        <td>
                          {manager ? (
                            <div className="leadership-person">
                              <span className="leadership-avatar">{initials(manager.name)}</span>
                              <span><strong>{manager.name}</strong><small>{manager.title}</small></span>
                            </div>
                          ) : (
                            <button className="leadership-inline-assign" type="button" onClick={(event) => { event.stopPropagation(); openAssignment(department); }}>
                              <span><Plus size={16} aria-hidden /></span> Assign Manager
                            </button>
                          )}
                        </td>
                        <td>
                          {exco ? (
                            <div className="leadership-person">
                              <span className="leadership-avatar dark">{initials(exco.name)}</span>
                              <span><strong>{exco.name}</strong><small>{exco.title}</small></span>
                            </div>
                          ) : (
                            <button className="leadership-inline-assign" type="button" onClick={(event) => { event.stopPropagation(); openAssignment(department); }}>
                              <span><Plus size={16} aria-hidden /></span> Assign EXCO Owner
                            </button>
                          )}
                        </td>
                        <td><span className={statusClass(status)}>{statusLabel(status)}</span></td>
                        <td>
                          <div className="leadership-row-actions">
                            <button className="icon-button leadership-icon-button" type="button" onClick={(event) => { event.stopPropagation(); openAssignment(department); }} aria-label={`Edit ${department.name}`} title="Edit assignment">
                              <Edit3 size={16} aria-hidden />
                            </button>
                            <button className="icon-button leadership-icon-button" type="button" onClick={(event) => { event.stopPropagation(); setSelectedId(department.id); }} aria-label={`View ${department.name}`} title="View details">
                              <RotateCcw size={16} aria-hidden />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="leadership-pagination">
            <span>Showing {filtered.length === 0 ? 0 : (boundedPage - 1) * PAGE_SIZE + 1} to {Math.min(boundedPage * PAGE_SIZE, filtered.length)} of {filtered.length} departments</span>
            <div>
              <button className="icon-button leadership-icon-button" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={boundedPage === 1} aria-label="Previous page"><ChevronLeft size={16} aria-hidden /></button>
              {Array.from({ length: totalPages }).slice(0, 3).map((_, index) => (
                <button key={index + 1} className={`leadership-page-button ${boundedPage === index + 1 ? "active" : ""}`} type="button" onClick={() => setPage(index + 1)}>{index + 1}</button>
              ))}
              <button className="icon-button leadership-icon-button" type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={boundedPage === totalPages} aria-label="Next page"><ChevronRight size={16} aria-hidden /></button>
            </div>
            <select value={PAGE_SIZE} disabled>
              <option>{PAGE_SIZE} per page</option>
            </select>
          </div>
        </section>

        <aside className="leadership-details">
          <div className="leadership-details-head">
            <h3>Department Details</h3>
            <button className="icon-button leadership-icon-button" type="button" onClick={() => setSelectedId(null)} aria-label="Close details"><X size={17} aria-hidden /></button>
          </div>
          {selectedDepartment ? (
            <>
              <div className="leadership-detail-main">
                <span className="leadership-stat-icon green"><UsersRound size={22} aria-hidden /></span>
                <div>
                  <h4>{selectedDepartment.name}</h4>
                  <p>{selectedDepartment.section_name || "Unassigned Section"}</p>
                </div>
                <span className="status-pill status-pill-success">{selectedDepartment.active ? "Active" : "Inactive"}</span>
              </div>
              <dl className="leadership-detail-list">
                <dt>Department Code</dt>
                <dd>{departmentCode(selectedDepartment.name)}</dd>
                <dt>Description</dt>
                <dd>{leadershipDescription(selectedDepartment)}</dd>
                <dt>Cost Center</dt>
                <dd>CC-{departmentCode(selectedDepartment.name)} - {selectedDepartment.name}</dd>
                <dt>Status</dt>
                <dd><span className={statusClass(statusKey(selectedDepartment))}>{statusLabel(statusKey(selectedDepartment))}</span></dd>
              </dl>
              <div className="leadership-assignment-card">
                <div className="leadership-assignment-head">
                  <h4>Leadership Assignment</h4>
                  <button className="button small-button button-subtle" type="button" onClick={() => openAssignment(selectedDepartment)}>Edit</button>
                </div>
                <div className="leadership-assignment-list">
                  <div>
                    <span>Manager</span>
                    {selectedManager ? (
                      <div className="leadership-person">
                        <span className="leadership-avatar">{initials(selectedManager.name)}</span>
                        <span><strong>{selectedManager.name}</strong><small>{selectedManager.title}</small></span>
                        <em>Active</em>
                      </div>
                    ) : <p>Not Assigned</p>}
                  </div>
                  <div>
                    <span>EXCO Owner</span>
                    {selectedExco ? (
                      <div className="leadership-person">
                        <span className="leadership-avatar dark">{initials(selectedExco.name)}</span>
                        <span><strong>{selectedExco.name}</strong><small>{selectedExco.title}</small></span>
                        <em>Active</em>
                      </div>
                    ) : <p>Not Assigned</p>}
                  </div>
                  <small>Last Updated<br />{lastUpdatedLabel()} by System Administrator</small>
                </div>
              </div>
            </>
          ) : (
            <div className="leadership-empty">Select a department to view details.</div>
          )}
        </aside>
      </div>

      {modalOpen && (
        <div className="leadership-modal-backdrop">
          <div className="leadership-modal">
            <div className="leadership-modal-head">
              <h3>Assign Leadership</h3>
              <button className="icon-button leadership-icon-button" type="button" onClick={() => setModalOpen(false)} aria-label="Close assignment modal"><X size={17} aria-hidden /></button>
            </div>
            <div className="leadership-modal-grid">
              <label>
                <span>Department</span>
                <select value={draftDepartmentId} onChange={(event) => {
                  const department = departments.find((item) => item.id === event.target.value);
                  setDraftDepartmentId(event.target.value);
                  setDraftManagerId(department?.manager_user_id || "");
                  setDraftExcoId(department?.exco_user_id || "");
                }}>
                  <option value="">Select department</option>
                  {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                </select>
              </label>
              <label>
                <span>Manager</span>
                <select value={draftManagerId} onChange={(event) => setDraftManagerId(event.target.value)}>
                  <option value="">No manager</option>
                  {managers.map((user) => <option key={user.id} value={user.id}>{user.full_name || user.email}</option>)}
                </select>
              </label>
              <label>
                <span>EXCO Owner</span>
                <select value={draftExcoId} onChange={(event) => setDraftExcoId(event.target.value)}>
                  <option value="">No EXCO owner</option>
                  {excoUsers.map((user) => <option key={user.id} value={user.id}>{user.full_name || user.email}</option>)}
                </select>
              </label>
            </div>
            <div className="leadership-modal-actions">
              <button className="button small-button button-subtle" type="button" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="button button-primary" type="button" onClick={() => void saveAssignment()} disabled={saving}>{saving ? "Saving..." : "Save Assignment"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
