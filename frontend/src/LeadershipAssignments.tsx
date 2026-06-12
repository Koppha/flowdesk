import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  ChevronLeft,
  ChevronRight,
  Edit3,
  Filter,
  MoreVertical,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert,
  UserPlus,
  UserRound,
  Users,
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
  division_id: string | null;
  division_name: string | null;
  hod_user_id: string | null;
  hod_name: string | null;
  hod_email: string | null;
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

type AssignmentStatus = "complete" | "no-hod" | "no-manager" | "no-exco" | "unassigned" | "inactive";

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

function getHod(department: DepartmentAssignment, users: LeadershipUser[]) {
  return findPerson(users, department.hod_user_id, department.hod_name, department.hod_email, "HOD");
}

function getExco(department: DepartmentAssignment, users: LeadershipUser[]) {
  return findPerson(users, department.exco_user_id, department.exco_name, department.exco_email, "Chief Officer");
}

function statusKey(department: DepartmentAssignment): AssignmentStatus {
  if (!department.active) return "inactive";
  if (!department.hod_user_id && !department.manager_user_id && !department.exco_user_id) return "unassigned";
  if (!department.hod_user_id) return "no-hod";
  if (!department.manager_user_id) return "no-manager";
  if (!department.exco_user_id) return "no-exco";
  return "complete";
}

function statusLabel(status: AssignmentStatus) {
  switch (status) {
    case "complete":
      return "Complete";
    case "no-hod":
      return "No HOD";
    case "no-manager":
      return "No Manager";
    case "no-exco":
      return "No EXCO Member";
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
  const [hods, setHods] = useState<LeadershipUser[]>([]);
  const [managers, setManagers] = useState<LeadershipUser[]>([]);
  const [excoUsers, setExcoUsers] = useState<LeadershipUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [divisionFilter, setDivisionFilter] = useState("ALL");
  const [sectionFilter, setSectionFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [draftDepartmentId, setDraftDepartmentId] = useState("");
  const [draftHodId, setDraftHodId] = useState("");
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
      setHods(Array.isArray(leaders?.hods) ? leaders.hods : Array.isArray(leaders?.managers) ? leaders.managers : []);
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

  const divisions = useMemo(() => {
    return Array.from(new Set(departments.map((d) => d.division_name || "No Division"))).sort((a, b) => a.localeCompare(b));
  }, [departments]);

  const sections = useMemo(() => {
    const source = divisionFilter === "ALL" ? departments : departments.filter(d => (d.division_name || "No Division") === divisionFilter);
    return Array.from(new Set(source.map((department) => department.section_name || "Unassigned Section"))).sort((a, b) => a.localeCompare(b));
  }, [departments, divisionFilter]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return departments.filter((department) => {
      const manager = getManager(department, managers);
      const hod = getHod(department, hods);
      const exco = getExco(department, excoUsers);
      const section = department.section_name || "Unassigned Section";
      const division = department.division_name || "No Division";
      const status = statusKey(department);
      if (divisionFilter !== "ALL" && division !== divisionFilter) return false;
      if (sectionFilter !== "ALL" && section !== sectionFilter) return false;
      if (statusFilter === "INCOMPLETE" && status === "complete") return false;
      if (statusFilter !== "ALL" && statusFilter !== "INCOMPLETE" && status !== statusFilter) return false;
      if (!query) return true;
      return [
        department.name,
        section,
        hod?.name,
        hod?.email,
        manager?.name,
        manager?.email,
        exco?.name,
        exco?.email
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [departments, divisionFilter, excoUsers, hods, managers, search, sectionFilter, statusFilter]);

  useEffect(() => {
    setPage(1);
  }, [search, divisionFilter, sectionFilter, statusFilter]);

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
  const selectedHod = selectedDepartment ? getHod(selectedDepartment, hods) : null;
  const selectedManager = selectedDepartment ? getManager(selectedDepartment, managers) : null;
  const selectedExco = selectedDepartment ? getExco(selectedDepartment, excoUsers) : null;

  const stats = useMemo(() => {
    return {
      total: departments.length,
      withHod: departments.filter((department) => Boolean(department.hod_user_id)).length,
      withManager: departments.filter((department) => Boolean(department.manager_user_id)).length,
      withExco: departments.filter((department) => Boolean(department.exco_user_id)).length,
      unassigned: departments.filter((department) => statusKey(department) !== "complete").length
    };
  }, [departments]);

  function openAssignment(department?: DepartmentAssignment | null) {
    const target = department || selectedDepartment || departments[0] || null;
    setDraftDepartmentId(target?.id || "");
    setDraftHodId(target?.hod_user_id || "");
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
        hod_user_id: draftHodId || null,
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
    <div className="leadership-page ep-page">
      <div className="ep-breadcrumb">
        <span>Administration</span><ChevronRight size={13} /><span>Organizational Structure</span><ChevronRight size={13} /><span className="ep-breadcrumb-active">Leadership Assignments</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Leadership Assignments</h1>
          <p className="ep-subtitle">Assign HODs, Managers, and EXCO Members to departments. These assignments drive the approval workflow.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" type="button" onClick={() => void load()}><RefreshCw size={14} />Refresh</button>
        </div>
      </div>

      {error && <div className="leadership-error">{error}</div>}

      <div className="leadership-stat-row">
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("ALL")}>
          <span className="leadership-stat-icon"><UsersRound size={26} aria-hidden /></span>
          <div><strong>{stats.total}</strong><small>Total Departments</small></div>
        </button>
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("ALL")}>
          <span className="leadership-stat-icon"><UserRound size={26} aria-hidden /></span>
          <div><strong>{stats.withHod}</strong><small>With HOD</small></div>
        </button>
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("ALL")}>
          <span className="leadership-stat-icon"><Users size={26} aria-hidden /></span>
          <div><strong>{stats.withManager}</strong><small>With Manager</small></div>
        </button>
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("ALL")}>
          <span className="leadership-stat-icon"><Network size={26} aria-hidden /></span>
          <div><strong>{stats.withExco}</strong><small>With EXCO Member</small></div>
        </button>
        <button className="leadership-stat" type="button" onClick={() => setStatusFilter("INCOMPLETE")}>
          <span className="leadership-stat-icon"><TriangleAlert size={26} aria-hidden /></span>
          <div><strong>{stats.unassigned}</strong><small>Unassigned</small></div>
        </button>
      </div>

      <div className="leadership-toolbar">
        <div className="leadership-search">
          <Search size={18} aria-hidden />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search department..." />
        </div>
        {divisions.length > 1 && (
          <select value={divisionFilter} onChange={(event) => { setDivisionFilter(event.target.value); setSectionFilter("ALL"); }}>
            <option value="ALL">All Divisions</option>
            {divisions.map((div) => <option key={div} value={div}>{div}</option>)}
          </select>
        )}
        <select value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)}>
          <option value="ALL">All Sections</option>
          {sections.map((section) => <option key={section} value={section}>{section}</option>)}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="ALL">All Statuses</option>
          <option value="complete">Complete</option>
          <option value="INCOMPLETE">Needs Assignment</option>
          <option value="no-hod">No HOD</option>
          <option value="no-manager">No Manager</option>
          <option value="no-exco">No EXCO Member</option>
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
	                  <th>Division › Section</th>
	                  <th>HOD</th>
	                  <th>Manager</th>
	                  <th>Division EXCO</th>
	                  <th>Section Leader</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && !departments.length ? (
	                  <tr><td colSpan={8} className="leadership-empty">Loading assignments...</td></tr>
	                ) : pagedDepartments.length === 0 ? (
	                  <tr><td colSpan={8} className="leadership-empty">No departments match the selected filters.</td></tr>
                ) : (
                  pagedDepartments.map((department) => {
	                    const manager = getManager(department, managers);
	                    const hod = getHod(department, hods);
	                    const exco = getExco(department, excoUsers);
                    const status = statusKey(department);
                    const selected = department.id === selectedDepartment?.id;
                    return (
                      <tr key={department.id} className={selected ? "is-selected" : ""} onClick={() => setSelectedId(department.id)}>
	                        <td><strong>{department.name}</strong></td>
	                        <td>{[department.division_name, department.section_name].filter(Boolean).join(" › ") || "Unassigned"}</td>
	                        <td>
	                          {hod ? (
	                            <div className="leadership-person">
	                              <span className="leadership-avatar">{initials(hod.name)}</span>
	                              <span><strong>{hod.name}</strong><small>{hod.title}</small></span>
	                            </div>
	                          ) : (
	                            <button className="leadership-inline-assign" type="button" onClick={(event) => { event.stopPropagation(); openAssignment(department); }}>
	                              <span><Plus size={16} aria-hidden /></span> Assign HOD
	                            </button>
	                          )}
	                        </td>
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
                              <span><Plus size={16} aria-hidden /></span> Assign EXCO
                            </button>
                          )}
                        </td>
                        <td>
                          {department.section_exco_name ? (
                            <div className="leadership-person">
                              <span className="leadership-avatar">{initials(department.section_exco_name)}</span>
                              <span><strong>{department.section_exco_name}</strong><small>{department.section_name ?? "Section"}</small></span>
                            </div>
                          ) : (
                            <span style={{ color: "var(--muted)", fontSize: 12 }}>
                              {department.section_name ? `${department.section_name} —` : "—"}
                            </span>
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
                  <p>
                    {[selectedDepartment.division_name, selectedDepartment.section_name].filter(Boolean).join(" › ") || "Unassigned"}
                  </p>
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
                    <span>HOD</span>
                    {selectedHod ? (
                      <div className="leadership-person">
                        <span className="leadership-avatar">{initials(selectedHod.name)}</span>
                        <span><strong>{selectedHod.name}</strong><small>{selectedHod.title}</small></span>
                        <em>Active</em>
                      </div>
                    ) : <p>Not Assigned</p>}
                  </div>
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
                    <span>Division EXCO</span>
                    {selectedExco ? (
                      <div className="leadership-person">
                        <span className="leadership-avatar dark">{initials(selectedExco.name)}</span>
                        <span><strong>{selectedExco.name}</strong><small>{selectedExco.title}</small></span>
                        <em>Active</em>
                      </div>
                    ) : <p>Not Assigned</p>}
                  </div>
                  {selectedDepartment?.section_name && (
                    <div>
                      <span>Section Leader <small style={{ fontWeight: 400 }}>({selectedDepartment.section_name})</small></span>
                      {selectedDepartment.section_exco_name ? (
                        <div className="leadership-person">
                          <span className="leadership-avatar">{initials(selectedDepartment.section_exco_name)}</span>
                          <span><strong>{selectedDepartment.section_exco_name}</strong><small>{selectedDepartment.section_exco_email}</small></span>
                          <em>Active</em>
                        </div>
                      ) : <p>Not Assigned</p>}
                    </div>
                  )}
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
                <span>Department <span style={{ fontSize: 11, fontWeight: 400, color: "var(--muted)" }}>(grouped by Division)</span></span>
                <select value={draftDepartmentId} onChange={(event) => {
	                  const department = departments.find((item) => item.id === event.target.value);
	                  setDraftDepartmentId(event.target.value);
	                  setDraftHodId(department?.hod_user_id || "");
	                  setDraftManagerId(department?.manager_user_id || "");
                  setDraftExcoId(department?.exco_user_id || "");
                }}>
                  <option value="">Select department</option>
                  {Array.from(
                    departments.reduce((map, d) => {
                      const key = d.division_name ?? "Unassigned Division";
                      return map.set(key, [...(map.get(key) ?? []), d]);
                    }, new Map<string, typeof departments>())
                  ).map(([divName, depts]) => (
                    <optgroup key={divName} label={`── ${divName}`}>
                      {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label>
                <span>HOD</span>
                <select value={draftHodId} onChange={(event) => setDraftHodId(event.target.value)}>
                  <option value="">No HOD</option>
                  {(hods.length ? hods : managers).map((user) => <option key={user.id} value={user.id}>{user.full_name || user.email}</option>)}
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
                <span>EXCO Member</span>
                <select value={draftExcoId} onChange={(event) => setDraftExcoId(event.target.value)}>
                  <option value="">No EXCO member</option>
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
