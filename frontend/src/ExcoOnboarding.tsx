import React, { useEffect, useState } from "react";
import { api } from "./api";
import { confirmAction } from "./alerts";
import { ChevronRight, Edit3, Plus, Search, Trash2, UserCheck, UserPlus, Users, X } from "lucide-react";
import UserPicker, { type PickableUser } from "./UserPicker";
import OrgPicker, { type OrgSelection, orgSelectionFromUser } from "./OrgPicker";
import { useStaffDirectory } from "./useStaffDirectory";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EMPTY_ORG: OrgSelection = {
  divisionId: null, divisionName: null,
  department: null, departmentId: null,
  sectionId: null, sectionName: null,
  teamId: null, teamName: null,
};

function orgPath(u: any) {
  return [u.division_name, u.department, u.section_name, u.team_name].filter(Boolean).join(" › ");
}

// ─── ExcoOnboarding ───────────────────────────────────────────────────────────

export default function ExcoOnboarding() {
  const { staff: users, loading, reload } = useStaffDirectory();
  const [search, setSearch] = useState("");
  const [statusView, setStatusView] = useState<"active" | "inactive">("active");

  // Add modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newSurname, setNewSurname] = useState("");
  const [newEmployeeNo, setNewEmployeeNo] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newIsActive, setNewIsActive] = useState(true);
  const [newOrg, setNewOrg] = useState<OrgSelection>(EMPTY_ORG);
  const [creating, setCreating] = useState(false);

  // Assign existing user
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignOrg, setAssignOrg] = useState<OrgSelection>(EMPTY_ORG);
  const [assigning, setAssigning] = useState(false);

  // Vacant positions — earmarked before anyone is assigned; filled later via
  // the same Assign/Create flows above.
  const [vacancies, setVacancies] = useState<any[]>([]);
  const [fillingVacancyId, setFillingVacancyId] = useState<string | null>(null);
  const [showVacancyModal, setShowVacancyModal] = useState(false);
  const [vacancyTitle, setVacancyTitle] = useState("");
  const [vacancyOrg, setVacancyOrg] = useState<OrgSelection>(EMPTY_ORG);
  const [creatingVacancy, setCreatingVacancy] = useState(false);

  async function loadVacancies() {
    try {
      const rows: any = await api.positionVacancies("EXCO");
      setVacancies(Array.isArray(rows) ? rows : []);
    } catch {
      // non-fatal — vacancies are a supplementary list
    }
  }

  useEffect(() => { void loadVacancies(); }, []);

  async function handleCreateVacancy() {
    setCreatingVacancy(true);
    try {
      await api.createPositionVacancy({
        role: "EXCO",
        title: vacancyTitle.trim() || undefined,
        department: vacancyOrg.department || undefined,
        division_id: vacancyOrg.divisionId || undefined,
        section_id: vacancyOrg.sectionId || undefined,
        team_id: vacancyOrg.teamId || undefined
      });
      setVacancyTitle("");
      setVacancyOrg(EMPTY_ORG);
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

  // Edit modal
  const [editingUser, setEditingUser] = useState<any | null>(null);
  const [editingFirstName, setEditingFirstName] = useState("");
  const [editingSurname, setEditingSurname] = useState("");
  const [editingOrg, setEditingOrg] = useState<OrgSelection>(EMPTY_ORG);


  useEffect(() => {
    if (!editingUser) {
      setEditingFirstName(""); setEditingSurname(""); setEditingOrg(EMPTY_ORG);
      return;
    }
    const parts = (editingUser.full_name || "").trim().split(/\s+/);
    setEditingFirstName(parts.shift() || "");
    setEditingSurname(parts.join(" ") || "");
    setEditingOrg(orgSelectionFromUser(editingUser));
  }, [editingUser]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  function resetAddForm() {
    setNewEmail(""); setNewFirstName(""); setNewSurname("");
    setNewEmployeeNo(""); setNewTitle(""); setNewIsActive(true);
    setNewOrg(EMPTY_ORG);
  }

  async function handleCreate() {
    if (!newEmail.trim() || !newFirstName.trim() || !newSurname.trim() || !newTitle.trim()) {
      alert("Please fill in all required fields (name, email, title).");
      return;
    }
    setCreating(true);
    try {
      const fullName = [newFirstName.trim(), newSurname.trim()].filter(Boolean).join(" ");
      if (fillingVacancyId) {
        await api.fillPositionVacancy(fillingVacancyId, {
          email: newEmail.trim(),
          full_name: fullName,
          employee_no: newEmployeeNo.trim() || undefined,
          title: newTitle.trim()
        });
        setFillingVacancyId(null);
        await loadVacancies();
      } else {
        const created: any = await api.createUser({
          email: newEmail.trim(),
          full_name: fullName,
          employee_no: newEmployeeNo.trim() || undefined,
          department: newOrg.department || undefined,
          division_id: newOrg.divisionId || undefined,
          section_id: newOrg.sectionId || undefined,
          team_id: newOrg.teamId || undefined,
          role: "EXCO",
          title: newTitle.trim(),
          is_active: newIsActive,
        });
        // Explicitly save all org fields via updateUser
        if (newOrg.divisionId || newOrg.sectionId || newOrg.teamId) {
          await api.updateUser(created.id, {
            division_id: newOrg.divisionId ?? null,
            section_id: newOrg.sectionId ?? null,
            team_id: newOrg.teamId ?? null,
          });
        }
      }
      resetAddForm();
      setShowAddModal(false);
      await reload();
    } catch (err: any) {
      alert("Error creating user: " + err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveEdit() {
    if (!editingUser) return;
    try {
      const fullName = [editingFirstName.trim(), editingSurname.trim()].filter(Boolean).join(" ");
      await api.updateUser(editingUser.id, {
        full_name: fullName,
        employee_no: editingUser.employee_no,
        title: editingUser.title,
        email: editingUser.email,
        department: editingOrg.department ?? editingUser.department,
        division_id: editingOrg.divisionId ?? null,
        section_id: editingOrg.sectionId ?? null,
        team_id: editingOrg.teamId ?? null,
      });
      setEditingUser(null);
      await reload();
    } catch (e: any) {
      alert("Error saving: " + e.message);
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
        await api.updateUserRole(user.id, { role: "EXCO" });
        await api.updateUser(user.id, {
          department: assignOrg.department ?? undefined,
          division_id: assignOrg.divisionId ?? null,
          section_id: assignOrg.sectionId ?? null,
          team_id: assignOrg.teamId ?? null,
        });
      }
      setShowAssignModal(false);
      setAssignOrg(EMPTY_ORG);
      await reload();
    } catch (e: any) {
      alert("Error assigning EXCO: " + e.message);
    } finally {
      setAssigning(false);
    }
  }

  // ─── Filtered list ────────────────────────────────────────────────────────

  const excoMembers = users.filter((u) => (u.role || "").toUpperCase() === "EXCO");
  const statusCounts = {
    active:   excoMembers.filter((u) => u.is_active !== false).length,
    inactive: excoMembers.filter((u) => u.is_active === false).length,
  };

  const shown = excoMembers.filter((u) => {
    if (statusView === "inactive" ? u.is_active !== false : u.is_active === false) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (u.full_name || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.employee_no || "").toLowerCase().includes(q) ||
      (u.department || "").toLowerCase().includes(q) ||
      (u.division_name || "").toLowerCase().includes(q)
    );
  });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span>Administration</span>
        <ChevronRight size={13} />
        <span>Organizational Structure</span>
        <ChevronRight size={13} />
        <span className="ep-breadcrumb-active">EXCO Members</span>
      </div>

      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">EXCO Members</h1>
          <p className="ep-subtitle">Manage Executive Committee members and their position in the org hierarchy.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => void reload()}>Refresh</button>
          <button className="ep-btn-outline" onClick={() => { setVacancyTitle(""); setVacancyOrg(EMPTY_ORG); setShowVacancyModal(true); }}>
            <Plus size={15} aria-hidden /> Create Vacant Position
          </button>
          <button className="ep-btn-outline" onClick={() => { setFillingVacancyId(null); setAssignOrg(EMPTY_ORG); setShowAssignModal(true); }}>
            <UserCheck size={15} aria-hidden /> Assign Existing User
          </button>
          <button className="ep-btn" onClick={() => { setFillingVacancyId(null); resetAddForm(); setShowAddModal(true); }}>
            <UserPlus size={15} aria-hidden /> Create New Account
          </button>
        </div>
      </div>

      {/* ── Vacant Positions ── */}
      {vacancies.length > 0 && (
        <div className="ep-panel" style={{ marginBottom: 16 }}>
          <div className="ep-panel-head">
            <div className="ep-panel-title">
              Vacant Positions
              <span style={{ marginLeft: 8, fontSize: "0.8rem", color: "var(--muted)", fontWeight: 400 }}>
                {vacancies.length} open
              </span>
            </div>
          </div>
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Org Position</th>
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
                        <strong>{v.title || "EXCO Member"}</strong>
                      </div>
                    </td>
                    <td style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
                      {[v.division_name, v.department, v.section_name, v.team_name].filter(Boolean).join(" › ") || "—"}
                    </td>
                    <td style={{ fontSize: "0.83rem", color: "var(--muted)" }}>
                      {v.created_at ? new Date(v.created_at).toLocaleDateString() : "—"}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="ep-icon-btn" title="Assign existing user" onClick={() => openFillWithAssign(v.id)}>
                          <UserCheck size={13} aria-hidden />
                        </button>
                        <button className="ep-icon-btn" title="Create new account" onClick={() => openFillWithCreate(v.id)}>
                          <UserPlus size={13} aria-hidden />
                        </button>
                        <button className="ep-icon-btn" style={{ color: "#dc2626" }} title="Remove vacancy" onClick={() => void handleRemoveVacancy(v.id)}>
                          <Trash2 size={13} aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="ep-panel">
        {/* Active / Inactive view toggle — deactivated members get their own
            section instead of being mixed into the working roster */}
        <div style={{ display: "flex", gap: 6, padding: "14px 16px 0" }}>
          {([
            { key: "active",   label: `Active (${statusCounts.active})` },
            { key: "inactive", label: `Inactive (${statusCounts.inactive})` },
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
        <div className="ep-panel-head">
          <div className="ep-panel-title">
            EXCO Members
            <span style={{ marginLeft: 8, fontSize: "0.8rem", color: "var(--muted)", fontWeight: 400 }}>
              {shown.length} member{shown.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="ep-search">
            <Search size={14} />
            <input placeholder="Search by name, email, division, department…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : shown.length === 0 ? (
            <div className="ep-empty">
              <Users size={32} style={{ opacity: 0.25 }} />
              <p>{statusView === "inactive" ? "No inactive EXCO members." : "No EXCO members found. Use the buttons above to add one."}</p>
            </div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Employee No</th>
                  <th>Title</th>
                  <th>Org Position</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ width: 36, height: 36, borderRadius: "50%", background: "linear-gradient(135deg,#6d28d9,#9333ea)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "0.85rem", flexShrink: 0 }}>
                          {(u.full_name || u.email).split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()}
                        </span>
                        <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>{u.full_name || u.email}</div>
                      </div>
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: "0.85rem" }}>{u.employee_no || "—"}</td>
                    <td style={{ fontSize: "0.85rem" }}>{u.title || "—"}</td>
                    <td style={{ fontSize: "0.82rem" }}>
                      <span style={{ color: "var(--muted)" }}>
                        {orgPath(u) || u.department || "—"}
                      </span>
                    </td>
                    <td style={{ fontSize: "0.83rem", color: "var(--muted)" }}>{u.email}</td>
                    <td>
                      <span className={`status-pill ${u.is_active ? "status-pill-success" : "status-pill-danger"}`}>
                        {u.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="ep-icon-btn" title="Edit" onClick={() => setEditingUser(u)}>
                          <Edit3 size={13} aria-hidden />
                        </button>
                        {u.is_active !== false ? (
                          <button className="ep-icon-btn" style={{ color: "#dc2626" }} title="Deactivate" onClick={async () => {
                            const confirmed = await confirmAction({
                              title: "Deactivate user?",
                              text: "Deactivate this user?",
                              confirmButtonText: "Deactivate"
                            });
                            if (!confirmed) return;
                            void api.updateUserRole(u.id, { role: u.role || "EMPLOYEE", is_active: false })
                              .then(() => reload())
                              .catch((e: any) => alert("Error: " + e.message));
                          }}>
                            <Trash2 size={13} aria-hidden />
                          </button>
                        ) : (
                          <button className="ep-icon-btn" style={{ color: "#16a34a" }} title="Reactivate" onClick={async () => {
                            const confirmed = await confirmAction({
                              title: "Reactivate user?",
                              text: "Reactivate this user? They will be able to log in again.",
                              confirmButtonText: "Reactivate"
                            });
                            if (!confirmed) return;
                            void api.updateUserRole(u.id, { role: u.role || "EXCO", is_active: true })
                              .then(() => reload())
                              .catch((e: any) => alert("Error: " + e.message));
                          }}>
                            <UserCheck size={13} aria-hidden />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Add EXCO Modal ── */}
      {showAddModal && (
        <div className="ep-modal-overlay" onClick={() => { setShowAddModal(false); setFillingVacancyId(null); }}>
          <div className="ep-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">{fillingVacancyId ? "Fill Vacant Position" : "Add EXCO Member"}</h2>
                <p className="ep-modal-sub">
                  {fillingVacancyId
                    ? "Create an account for the person filling this vacant position. They'll receive an invitation."
                    : "Create a new Executive Committee member and place them in the org hierarchy."}
                </p>
              </div>
              <button className="ep-icon-btn" onClick={() => { setShowAddModal(false); setFillingVacancyId(null); }}><X size={18} /></button>
            </div>

            <div className="ep-modal-body">
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>First Name <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="First name" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Surname <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="Surname" value={newSurname} onChange={(e) => setNewSurname(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Email / Username <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="user@etl.co.ls" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Position / Title <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="e.g. Chief Financial Officer" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Employee Number <span style={{ fontSize: 11, color: "var(--muted)" }}>(optional)</span></label>
                  <input className="ep-form-input" placeholder="EMP-0042" value={newEmployeeNo} onChange={(e) => setNewEmployeeNo(e.target.value)} />
                </div>
                {!fillingVacancyId && (
                  <div className="ep-form-group">
                    <label>Status</label>
                    <select className="ep-form-select" value={newIsActive ? "active" : "inactive"} onChange={(e) => setNewIsActive(e.target.value === "active")}>
                      <option value="active">● Active</option>
                      <option value="inactive">○ Inactive</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Org placement comes from the vacancy itself when filling one */}
              {!fillingVacancyId && (
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
                    Org Placement
                  </div>
                  <OrgPicker value={newOrg} onChange={setNewOrg} showTeam={false} />
                </div>
              )}
            </div>

            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => { setShowAddModal(false); setFillingVacancyId(null); }} disabled={creating}>Cancel</button>
              <button className="ep-btn" disabled={creating} onClick={() => void handleCreate()}>
                {creating ? "Creating…" : fillingVacancyId ? "Fill Position" : "Add EXCO Member"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit EXCO Modal ── */}
      {editingUser && (
        <div className="ep-modal-overlay" onClick={() => setEditingUser(null)}>
          <div className="ep-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">Edit EXCO Member</h2>
                <p className="ep-modal-sub">Update <strong>{editingUser.full_name || editingUser.email}</strong></p>
              </div>
              <button className="ep-icon-btn" onClick={() => setEditingUser(null)}><X size={18} /></button>
            </div>

            <div className="ep-modal-body">
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>First Name</label>
                  <input className="ep-form-input" value={editingFirstName} onChange={(e) => setEditingFirstName(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Surname</label>
                  <input className="ep-form-input" value={editingSurname} onChange={(e) => setEditingSurname(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Email</label>
                  <input className="ep-form-input" value={editingUser.email || ""} onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })} />
                </div>
                <div className="ep-form-group">
                  <label>Position / Title</label>
                  <input className="ep-form-input" value={editingUser.title || ""} onChange={(e) => setEditingUser({ ...editingUser, title: e.target.value })} />
                </div>
              </div>
              <div className="ep-form-group">
                <label>Employee Number</label>
                <input className="ep-form-input" value={editingUser.employee_no || ""} onChange={(e) => setEditingUser({ ...editingUser, employee_no: e.target.value })} />
              </div>

              {/* Org placement */}
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
                  Org Placement
                </div>
                <OrgPicker value={editingOrg} onChange={setEditingOrg} showTeam={false} />
              </div>
            </div>

            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => setEditingUser(null)}>Cancel</button>
              <button className="ep-btn" onClick={() => void handleSaveEdit()}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Assign Existing User ── */}
      {showAssignModal && (
        <UserPicker
          title={fillingVacancyId ? "Fill Vacant Position" : "Assign Existing User as EXCO"}
          subtitle={fillingVacancyId
            ? "Search and select an employee to fill this vacant position. They'll receive an invitation."
            : "Search and select an employee to promote to EXCO."}
          users={users}
          excludeRoles={[]}
          onClose={() => { setShowAssignModal(false); setFillingVacancyId(null); }}
          onSelect={handleAssignExisting}
          saving={assigning}
          saveLabel={fillingVacancyId ? "Fill Position" : "Assign as EXCO"}
          extra={
            !fillingVacancyId ? (
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Org Placement (optional)
                </div>
                <OrgPicker value={assignOrg} onChange={setAssignOrg} showTeam={false} />
              </div>
            ) : undefined
          }
        />
      )}

      {/* ── Create Vacant Position ── */}
      {showVacancyModal && (
        <div className="ep-modal-overlay" onClick={() => setShowVacancyModal(false)}>
          <div className="ep-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">Create Vacant Position</h2>
                <p className="ep-modal-sub">Earmark an EXCO seat before anyone is assigned. Fill it later from this page.</p>
              </div>
              <button className="ep-icon-btn" onClick={() => setShowVacancyModal(false)}><X size={18} /></button>
            </div>

            <div className="ep-modal-body">
              <div className="ep-form-group">
                <label>Title <span style={{ fontSize: 11, color: "var(--muted)" }}>(optional)</span></label>
                <input className="ep-form-input" placeholder="e.g. Chief Financial Officer" value={vacancyTitle} onChange={(e) => setVacancyTitle(e.target.value)} />
              </div>

              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
                  Org Placement
                </div>
                <OrgPicker value={vacancyOrg} onChange={setVacancyOrg} showTeam={false} />
              </div>
            </div>

            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => setShowVacancyModal(false)} disabled={creatingVacancy}>Cancel</button>
              <button className="ep-btn" disabled={creatingVacancy} onClick={() => void handleCreateVacancy()}>
                {creatingVacancy ? "Creating…" : "Create Vacant Position"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
