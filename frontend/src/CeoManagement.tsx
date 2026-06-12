import React, { useCallback, useEffect, useState } from "react";
import { useStaffDirectory } from "./useStaffDirectory";
import { api } from "./api";
import { confirmAction } from "./alerts";
import {
  AlertTriangle,
  ChevronRight,
  Crown,
  Edit3,
  Network,
  Plus,
  Search,
  Shield,
  Star,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";

type User = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  title: string | null;
  department: string | null;
  role: string;
  employment_type: string | null;
  profile_completed: boolean;
  is_active: boolean;
};

function initials(name: string | null | undefined) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

export default function CeoManagement() {
  const [ceoUsers, setCeoUsers] = useState<User[]>([]);
  const { staff: allUsers, reload: reloadStaff } = useStaffDirectory();
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  // Assign existing user modal
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignSearch, setAssignSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [assigning, setAssigning] = useState(false);

  // Create new CEO account modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [newSurname, setNewSurname] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newEmployeeNo, setNewEmployeeNo] = useState("");
  const [newTitle, setNewTitle] = useState("Chief Executive Officer");
  const [creating, setCreating] = useState(false);

  // Reassign modal
  const [reassignUser, setReassignUser] = useState<User | null>(null);
  const [reassignToRole, setReassignToRole] = useState("EXCO");
  const [reassignAction, setReassignAction] = useState<"ROLE" | "DEACTIVATE">("ROLE");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ceos = await api.ceoUsers();
      setCeoUsers(Array.isArray(ceos) ? ceos : []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const assignCandidates = allUsers.filter((u) => {
    if (!u.is_active) return false;
    if (!assignSearch.trim()) return true;
    const q = assignSearch.toLowerCase();
    return (u.full_name || "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.employee_no || "").toLowerCase().includes(q);
  });

  async function handleAssign() {
    if (!selectedUserId) { alert("Select a user to assign as CEO."); return; }
    setAssigning(true);
    try {
      await api.updateUserRole(selectedUserId, { role: "CEO" });
      setShowAssignModal(false);
      setSelectedUserId("");
      setAssignSearch("");
      await Promise.all([load(), reloadStaff()]);
    } catch (e: any) { alert("Error: " + e.message); }
    finally { setAssigning(false); }
  }

  async function handleCreate() {
    if (!newFirstName.trim() || !newSurname.trim() || !newEmail.trim() || !newTitle.trim()) {
      alert("Please fill in all required fields.");
      return;
    }
    setCreating(true);
    try {
      const fullName = [newFirstName.trim(), newSurname.trim()].filter(Boolean).join(" ");
      await api.createUser({ email: newEmail.trim(), full_name: fullName, employee_no: newEmployeeNo.trim() || undefined, role: "CEO", title: newTitle.trim(), is_active: true });
      setShowCreateModal(false);
      setNewFirstName(""); setNewSurname(""); setNewEmail(""); setNewEmployeeNo(""); setNewTitle("Chief Executive Officer");
      await Promise.all([load(), reloadStaff()]);
    } catch (e: any) { alert("Error: " + e.message); }
    finally { setCreating(false); }
  }

  async function handleReassign() {
    if (!reassignUser) return;
    const isLeaving = reassignAction === "DEACTIVATE";
    const confirmed = await confirmAction({
      title: isLeaving ? "Deactivate CEO account?" : "Reassign CEO?",
      text: isLeaving
        ? `This will deactivate ${reassignUser.full_name || reassignUser.email}'s account. They will no longer be able to log in.`
        : `Reassign "${reassignUser.full_name || reassignUser.email}" from CEO to ${reassignToRole}?`,
      confirmButtonText: isLeaving ? "Deactivate" : "Reassign"
    });
    if (!confirmed) return;
    try {
      if (isLeaving) {
        await api.updateUser(reassignUser.id, { is_active: false });
      } else {
        await api.updateUserRole(reassignUser.id, { role: reassignToRole });
      }
      setReassignUser(null);
      setReassignAction("ROLE");
      await Promise.all([load(), reloadStaff()]);
    } catch (e: any) { alert("Error: " + e.message); }
  }

  const shownCeo = ceoUsers.filter((u) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (u.full_name || "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  const activeCeos = ceoUsers.filter((u) => u.is_active);
  const hasMultipleCeos = activeCeos.length > 1;

  return (
    <div className="ep-page">
      {/* ── Breadcrumb ── */}
      <div className="ep-breadcrumb">
        <span>Administration</span>
        <ChevronRight size={13} />
        <span>Organizational Structure</span>
        <ChevronRight size={13} />
        <span className="ep-breadcrumb-active">CEO</span>
      </div>

      {/* ── Header ── */}
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Chief Executive Officer</h1>
          <p className="ep-subtitle">
            The CEO sits at the top of the reporting chain. All EXCO members report to the CEO.
            Only one active CEO is recommended.
          </p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => { void load(); void reloadStaff(); }}>Refresh</button>
          <button className="ep-btn-outline" onClick={() => setShowAssignModal(true)}>
            <UserCheck size={15} /> Assign Existing User
          </button>
          <button className="ep-btn" onClick={() => setShowCreateModal(true)}>
            <UserPlus size={15} /> Create CEO Account
          </button>
        </div>
      </div>

      {/* ── Multiple CEO warning ── */}
      {hasMultipleCeos && (
        <div className="rl-banner rl-banner-warn" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>Multiple active CEOs detected ({activeCeos.length}).</strong>
            <div style={{ fontSize: "0.85rem", marginTop: 4 }}>
              It is recommended to have a single active CEO. Reassign the extra CEO users to a different role.
            </div>
          </div>
        </div>
      )}

      {/* ── KPI Cards ── */}
      <div className="ep-kpi-row ep-kpi-row-3">
        <div className="ep-kpi ep-kpi-indigo">
          <div className="ep-kpi-icon"><Crown size={26} /></div>
          <div>
            <div className="ep-kpi-value">{activeCeos.length}</div>
            <div className="ep-kpi-label">Active CEO{activeCeos.length !== 1 ? "s" : ""}</div>
          </div>
        </div>
        <div className="ep-kpi ep-kpi-purple">
          <div className="ep-kpi-icon"><Network size={26} /></div>
          <div>
            <div className="ep-kpi-value">{allUsers.filter((u) => u.role === "EXCO" && u.is_active).length}</div>
            <div className="ep-kpi-label">EXCO Members (reporting)</div>
          </div>
        </div>
        <div className="ep-kpi ep-kpi-blue">
          <div className="ep-kpi-icon"><Users size={26} /></div>
          <div>
            <div className="ep-kpi-value">{allUsers.filter((u) => u.is_active && u.role !== "ADMIN").length}</div>
            <div className="ep-kpi-label">Total Active Users</div>
          </div>
        </div>
      </div>

      {/* ── Current CEO panel ── */}
      <div className="ep-panel">
        <div className="ep-panel-head">
          <div>
            <div className="ep-panel-title">CEO Profile{ceoUsers.length > 1 ? "s" : ""}</div>
            <div className="ep-panel-sub">User(s) currently assigned the CEO role.</div>
          </div>
          <div className="ep-search">
            <Search size={14} />
            <input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="ep-panel-body">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : shownCeo.length === 0 ? (
            <div className="ep-empty" style={{ padding: "48px 0" }}>
              <Crown size={40} style={{ opacity: 0.15 }} />
              <p style={{ fontSize: "1rem", fontWeight: 600 }}>No CEO assigned yet</p>
              <p style={{ marginTop: 4 }}>
                Click <strong>Assign Existing User</strong> to designate an existing user as CEO,
                or <strong>Create CEO Account</strong> to create a new account.
              </p>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {shownCeo.map((u) => (
                <div key={u.id} className="ceo-card">
                  {/* Avatar */}
                  <div className="ceo-avatar">
                    <Crown size={18} className="ceo-avatar-crown" />
                    {initials(u.full_name)}
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>{u.full_name || u.email}</span>
                      <span className={`status-pill ${u.is_active ? "status-pill-success" : "status-pill-danger"}`}>
                        {u.is_active ? "Active" : "Inactive"}
                      </span>
                      {hasMultipleCeos && u.is_active && (
                        <span className="status-pill status-pill-warning">Multiple CEOs</span>
                      )}
                    </div>
                    <div style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: 4 }}>
                      {u.title || "Chief Executive Officer"}
                      {u.email && <span style={{ marginLeft: 12 }}>{u.email}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 20, marginTop: 8, flexWrap: "wrap" }}>
                      {[
                        ["Employee No", u.employee_no || "—"],
                        ["Department", u.department || "—"],
                        ["Employment", u.employment_type || "Permanent"],
                      ].map(([k, v]) => (
                        <div key={k}>
                          <div style={{ fontSize: "0.72rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{k}</div>
                          <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Reporting chain indicator */}
                  <div className="ceo-chain">
                    <div className="ceo-chain-node ceo-chain-top">
                      <Crown size={13} />CEO
                    </div>
                    <div className="ceo-chain-arrow">↓</div>
                    <div className="ceo-chain-node">EXCO</div>
                    <div className="ceo-chain-arrow">↓</div>
                    <div className="ceo-chain-node">HOD</div>
                    <div className="ceo-chain-arrow">↓</div>
                    <div className="ceo-chain-node">Manager</div>
                    <div className="ceo-chain-arrow">↓</div>
                    <div className="ceo-chain-node">Employees</div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexShrink: 0 }}>
                    <button className="ep-btn-outline" style={{ padding: "6px 12px", fontSize: "0.82rem" }} onClick={() => setReassignUser(u)}>
                      <UserMinus size={13} /> Reassign
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Reporting Structure info ── */}
      <div className="ep-panel">
        <div className="ep-panel-head">
          <div className="ep-panel-title">Reporting Chain — How it works</div>
        </div>
        <div className="ep-panel-body">
          <div className="ceo-info-grid">
            {[
              { icon: <Crown size={20} />, role: "CEO", desc: "Top of the organization. No manager assigned. All EXCO members report here.", color: "#6d28d9" },
              { icon: <Star size={20} />, role: "EXCO Member", desc: "Section heads. Report to the CEO. Own one or more departments/sections.", color: "#7c3aed" },
              { icon: <Shield size={20} />, role: "HOD (Head of Dept)", desc: "Department heads. Report to their EXCO member.", color: "#1d4ed8" },
              { icon: <UserCheck size={20} />, role: "Manager", desc: "Report to HOD if assigned, otherwise to EXCO.", color: "#166534" },
              { icon: <Users size={20} />, role: "Employees", desc: "Report to their department manager.", color: "#b45309" },
            ].map((item) => (
              <div key={item.role} className="ceo-info-item">
                <span className="ceo-info-icon" style={{ background: item.color + "18", color: item.color }}>{item.icon}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>{item.role}</div>
                  <div style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: 2 }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16, padding: "12px 16px", background: "rgba(37,99,235,0.06)", borderRadius: 8, border: "1px solid rgba(37,99,235,0.15)", fontSize: "0.85rem", color: "var(--text)" }}>
            <strong>Tip:</strong> After assigning the CEO, go to <em>Reporting Lines → Auto Generate Lines</em> to automatically wire the full chain: Employees → Manager → HOD → EXCO → CEO.
          </div>
        </div>
      </div>

      {/* ── Assign Existing User Modal ── */}
      {showAssignModal && (
        <div className="ep-modal-overlay" onClick={() => setShowAssignModal(false)}>
          <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">Assign Existing User as CEO</h2>
                <p className="ep-modal-sub">Select an active user to assign the CEO role. Their current role will be replaced.</p>
              </div>
              <button className="ep-icon-btn" onClick={() => setShowAssignModal(false)}><X size={18} /></button>
            </div>
            <div className="ep-modal-body">
              <div className="ep-form-group">
                <label>Search Users</label>
                <div className="ep-search" style={{ width: "100%", boxSizing: "border-box" }}>
                  <Search size={14} />
                  <input
                    placeholder="Name, email or employee number…"
                    value={assignSearch}
                    onChange={(e) => setAssignSearch(e.target.value)}
                    style={{ flex: 1 }}
                  />
                </div>
              </div>
              <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                {assignCandidates.length === 0 ? (
                  <div className="ep-empty" style={{ padding: "32px 0" }}><p>No matching users found.</p></div>
                ) : (
                  assignCandidates.map((u) => (
                    <label key={u.id} className={`ceo-candidate ${selectedUserId === u.id ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="ceo-assign"
                        value={u.id}
                        checked={selectedUserId === u.id}
                        onChange={() => setSelectedUserId(u.id)}
                        style={{ display: "none" }}
                      />
                      <div className="ceo-cand-avatar">{initials(u.full_name)}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>{u.full_name || u.email}</div>
                        <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                          {u.title || u.role} · {u.department || "No department"} · {u.email}
                        </div>
                      </div>
                      <span className={`status-pill ${u.role === "EXCO" ? "status-pill-info" : "status-pill-success"}`}>{u.role}</span>
                    </label>
                  ))
                )}
              </div>
              {selectedUserId && (() => {
                const user = allUsers.find((u) => u.id === selectedUserId);
                return user ? (
                  <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(37,99,235,0.06)", borderRadius: 8, border: "1px solid rgba(37,99,235,0.2)", fontSize: "0.85rem" }}>
                    <strong>{user.full_name || user.email}</strong>'s current role is <strong>{user.role}</strong>. It will be changed to <strong>CEO</strong>.
                  </div>
                ) : null;
              })()}
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => setShowAssignModal(false)}>Cancel</button>
              <button className="ep-btn" onClick={() => void handleAssign()} disabled={assigning || !selectedUserId}>
                {assigning ? "Assigning…" : "Assign as CEO"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create CEO Account Modal ── */}
      {showCreateModal && (
        <div className="ep-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">Create CEO Account</h2>
                <p className="ep-modal-sub">Create a new user account with the CEO role. A welcome email with temporary password will be sent.</p>
              </div>
              <button className="ep-icon-btn" onClick={() => setShowCreateModal(false)}><X size={18} /></button>
            </div>
            <div className="ep-modal-body">
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>First Name <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="e.g. John" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Surname <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="e.g. Mokoena" value={newSurname} onChange={(e) => setNewSurname(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Email / Username <span className="ep-required">*</span></label>
                  <input className="ep-form-input" placeholder="ceo@etl.co.ls" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                </div>
                <div className="ep-form-group">
                  <label>Title <span className="ep-required">*</span></label>
                  <input className="ep-form-input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
                </div>
              </div>
              <div className="ep-form-group">
                <label>Employee Number <span className="ep-optional">(Optional)</span></label>
                <input className="ep-form-input" placeholder="e.g. CEO-001" value={newEmployeeNo} onChange={(e) => setNewEmployeeNo(e.target.value)} />
              </div>
              <div style={{ padding: "10px 14px", background: "rgba(109,40,217,0.06)", borderRadius: 8, border: "1px solid rgba(109,40,217,0.2)", fontSize: "0.83rem", color: "var(--text)" }}>
                <Crown size={13} style={{ display: "inline", marginRight: 6, color: "#6d28d9" }} />
                This account will be created with the <strong>CEO</strong> role and a system-generated temporary password sent to the provided email.
              </div>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button className="ep-btn" onClick={() => void handleCreate()} disabled={creating}>
                {creating ? "Creating…" : "Create CEO Account"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reassign Modal ── */}
      {reassignUser && (
        <div className="ep-modal-overlay" onClick={() => { setReassignUser(null); setReassignAction("ROLE"); }}>
          <div className="ep-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">CEO Role — {reassignUser.full_name || reassignUser.email}</h2>
                <p className="ep-modal-sub">What is happening with this CEO account?</p>
              </div>
              <button className="ep-icon-btn" onClick={() => { setReassignUser(null); setReassignAction("ROLE"); }}><X size={18} /></button>
            </div>
            <div className="ep-modal-body">
              {/* Action toggle */}
              <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
                {([
                  { key: "ROLE",       label: "Changing Role" },
                  { key: "DEACTIVATE", label: "Leaving the Company" },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setReassignAction(key)}
                    style={{
                      flex: 1, padding: "8px 0", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer",
                      border: reassignAction === key ? "2px solid #dc2626" : "1px solid var(--border)",
                      background: reassignAction === key ? "#fff1f2" : "var(--surface-soft)",
                      color: reassignAction === key ? "#dc2626" : "var(--muted)",
                    }}
                  >{label}</button>
                ))}
              </div>

              {reassignAction === "ROLE" ? (
                <div className="ep-form-group">
                  <label>Assign new role <span className="ep-required">*</span></label>
                  <select className="ep-form-select" value={reassignToRole} onChange={(e) => setReassignToRole(e.target.value)}>
                    <option value="EXCO">EXCO Member</option>
                    <option value="MANAGER">Manager</option>
                    <option value="HR_MANAGER">HR Manager</option>
                    <option value="HOD">Head of Department</option>
                    <option value="EMPLOYEE">Employee</option>
                  </select>
                </div>
              ) : (
                <div style={{ padding: "12px 14px", background: "#fff1f2", borderRadius: 8, border: "1px solid #fecaca", fontSize: "0.83rem", color: "#7f1d1d" }}>
                  <strong>Account will be deactivated.</strong> {reassignUser.full_name || reassignUser.email} will lose access immediately and will no longer appear in approval chains or rosters.
                </div>
              )}

              <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(220,38,38,0.06)", borderRadius: 8, border: "1px solid rgba(220,38,38,0.2)", fontSize: "0.83rem" }}>
                <AlertTriangle size={13} style={{ display: "inline", marginRight: 6, color: "#dc2626" }} />
                {reassignAction === "ROLE"
                  ? <>Removes the CEO role from <strong>{reassignUser.full_name || reassignUser.email}</strong> and assigns them as <strong>{reassignToRole}</strong>.</>
                  : <>Deactivates <strong>{reassignUser.full_name || reassignUser.email}</strong>'s account. This cannot be undone without an admin re-activating them.</>
                }
              </div>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => { setReassignUser(null); setReassignAction("ROLE"); }}>Cancel</button>
              <button className="ep-btn-danger" onClick={() => void handleReassign()}>
                {reassignAction === "ROLE" ? "Confirm Reassignment" : "Deactivate Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
