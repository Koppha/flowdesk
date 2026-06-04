import React, { useEffect, useState } from "react";
import { api } from "./api";
import { ChevronLeft, ChevronRight, Edit3, Trash2, UserPlus, X } from "lucide-react";

export default function ExcoOnboarding() {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const filterRole = "EXCO";
  const [sections, setSections] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [newSurname, setNewSurname] = useState("");
  const [newEmployeeNo, setNewEmployeeNo] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [editingFirstName, setEditingFirstName] = useState("");
  const [editingSurname, setEditingSurname] = useState("");
  const [newIsActive, setNewIsActive] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<null | any>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!editingUser) {
      setEditingFirstName("");
      setEditingSurname("");
      return;
    }
    const parts = (editingUser.full_name || "").trim().split(/\s+/);
    setEditingFirstName(parts.shift() || "");
    setEditingSurname(parts.join(" ") || "");
  }, [editingUser]);

  async function load() {
    setLoading(true);
    try {
      const all = await api.adminUsers();
      setUsers(Array.isArray(all) ? all : []);
      const secs = await api.sections();
      setSections(Array.isArray(secs) ? secs.map((s: any) => (typeof s === "string" ? s : s.name || s.id || "")).filter(Boolean) : []);
    } catch (e: any) {
      alert("Error loading users: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function assignExco(userId: string) {
    if (!confirm("Assign EXCO role to this user?")) return;
    try {
      const updated = await api.updateUserRole(userId, { role: "EXCO" });
      setUsers((cur) => cur.map((u) => (u.id === userId ? updated : u)));
      alert("Assigned EXCO role.");
    } catch (e: any) {
      alert("Error assigning EXCO: " + e.message);
    }
  }

  async function removeExco(userId: string) {
    if (!confirm("Remove EXCO role from this user?")) return;
    try {
      const updated = await api.updateUserRole(userId, { role: "EMPLOYEE" });
      setUsers((cur) => cur.map((u) => (u.id === userId ? updated : u)));
      alert("Removed EXCO role.");
    } catch (e: any) {
      alert("Error removing EXCO: " + e.message);
    }
  }

  const shown = users.filter((u) => {
    if (filterRole && (u.role || "").toUpperCase() !== filterRole.toUpperCase()) return false;
    if (!search) return true;
    const needle = search.toLowerCase();
    return (u.full_name || "").toLowerCase().includes(needle) || (u.email || "").toLowerCase().includes(needle) || (u.employee_no || "").toLowerCase().includes(needle);
  });

  return (
    <div style={{ padding: 16 }}>
      <h2>EXCO Onboarding</h2>
      <p className="subtitle">Manage EXCO assignments and onboard EXCO members.</p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <strong>EXCO Members</strong>
          <div className="subtitle">Create and manage Executive Committee (EXCO) members.</div>
        </div>
        <div>
          <button className="button button-primary" onClick={() => setShowForm((s) => !s)}><UserPlus size={17} aria-hidden />{showForm ? 'Close' : 'Add EXCO Member'}</button>
        </div>
      </div>

      {showForm && (
        <div style={{ display: 'grid', gap: 8, marginBottom: 16, background: '#fff', padding: 16, borderRadius: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label>First Name *</label>
              <input placeholder="Enter first name" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} />
            </div>
            <div>
              <label>Surname *</label>
              <input placeholder="Enter surname" value={newSurname} onChange={(e) => setNewSurname(e.target.value)} />
            </div>
            <div>
              <label>Employee Number</label>
              <input placeholder="Enter employee number" value={newEmployeeNo} onChange={(e) => setNewEmployeeNo(e.target.value)} />
            </div>
            <div>
              <label>Position / Title *</label>
              <input placeholder="Enter position or title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 12 }}>
            <div>
              <label>Email *</label>
              <input placeholder="Enter email address" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            </div>
            <div>
              <label>Section *</label>
              <select value={newDepartment} onChange={(e) => setNewDepartment(e.target.value)}>
                <option value="">Select section</option>
                {sections.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                <input type="checkbox" checked={newIsActive} onChange={(e) => setNewIsActive(e.target.checked)} /> Active
              </label>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', gap: 8 }}>
              <button className="button small-button" onClick={() => { setShowForm(false); setNewEmail(''); setNewFirstName(''); setNewSurname(''); setNewEmployeeNo(''); setNewDepartment(''); setNewTitle(''); setNewIsActive(true); }}>Cancel</button>
              <button className="button button-primary" onClick={async () => {
                if (!newEmail.trim() || !newFirstName.trim() || !newSurname.trim() || !newTitle.trim() || !newDepartment.trim()) return alert('Please fill required fields');
                setCreating(true);
                try {
                  const fullName = [newFirstName.trim(), newSurname.trim()].filter(Boolean).join(' ');
                  await api.createUser({ email: newEmail.trim(), full_name: fullName, employee_no: newEmployeeNo.trim() || undefined, section: newDepartment || undefined, role: 'EXCO', title: newTitle.trim(), is_active: !!newIsActive });
                  setNewEmail(''); setNewFirstName(''); setNewSurname(''); setNewEmployeeNo(''); setNewDepartment(''); setNewTitle(''); setNewIsActive(true); setShowForm(false);
                  await load();
                  alert('EXCO member saved.');
                } catch (err: any) {
                  alert('Error creating user: ' + err.message);
                } finally { setCreating(false); }
              }} disabled={creating}>Save EXCO Member</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <input placeholder="Search EXCO members" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="button" onClick={() => void load()}>Refresh</button>
      </div>

      {loading ? <div>Loading...</div> : (
        <div style={{ background: '#fff', padding: 12, borderRadius: 8 }}>
          <table className="table compact" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Employee No</th>
                <th>Position / Title</th>
                <th>Section</th>
                <th>Email</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 18, background: '#eef2ff', display: 'grid', placeItems: 'center', fontWeight: 600 }}>{(u.full_name || u.email).split(' ').map((p: string)=>p[0]).slice(0,2).join('')}</div>
                    <div>
                      <div style={{ fontWeight: 600 }}>{u.full_name || u.email}</div>
                    </div>
                  </td>
                  <td>{u.employee_no || '—'}</td>
                  <td>{u.title || '—'}</td>
                  <td>{u.department || '—'}</td>
                  <td>{u.email}</td>
                  <td>{u.is_active ? <span className="status-pill status-pill-success">Active</span> : <span className="status-pill status-pill-warning">Inactive</span>}</td>
                  <td>
                    <button className="icon-button" title="Edit" onClick={() => setEditingUser(u)} style={{ marginRight: 8 }}>
                      <Edit3 size={16} aria-hidden />
                    </button>
                    <button className="icon-button danger" title="Deactivate" onClick={() => {
                      if (!confirm('Deactivate this user?')) return;
                      api.updateUserRole(u.id, { role: u.role || 'EMPLOYEE', is_active: false }).then((updated) => { setUsers((cur) => cur.map((x) => x.id === u.id ? updated : x)); alert('User deactivated'); }).catch((e) => alert('Error: ' + e.message));
                    }}>
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>Showing {shown.length} entries</div>
            <div>
              <button className="button small-button"><ChevronLeft size={16} aria-hidden /></button>
              <button className="button small-button">1</button>
              <button className="button small-button"><ChevronRight size={16} aria-hidden /></button>
            </div>
          </div>
        </div>
      )}

      {editingUser && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}>
          <div className="card" style={{ width: 720, maxWidth: '95%', padding: 20, position: "relative" }}>
            <h3>Edit EXCO Member</h3>
            <button className="icon-button leadership-icon-button" type="button" onClick={() => setEditingUser(null)} aria-label="Close edit modal" style={{ position: "absolute", right: 16, top: 16 }}>
              <X size={17} aria-hidden />
            </button>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <label>First Name</label>
                  <input value={editingFirstName} onChange={(e) => setEditingFirstName(e.target.value)} />
                </div>
                <div>
                  <label>Surname</label>
                  <input value={editingSurname} onChange={(e) => setEditingSurname(e.target.value)} />
                </div>
                <div>
                  <label>Employee Number</label>
                  <input value={editingUser.employee_no || ''} onChange={(e) => setEditingUser({ ...editingUser, employee_no: e.target.value })} />
                </div>
                <div>
                  <label>Position / Title</label>
                  <input value={editingUser.title || ''} onChange={(e) => setEditingUser({ ...editingUser, title: e.target.value })} />
                </div>
                <div>
                  <label>Section</label>
                  <select value={editingUser.department || ''} onChange={(e) => setEditingUser({ ...editingUser, department: e.target.value })}>
                    <option value="">(No section)</option>
                    {sections.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label>Email</label>
                  <input value={editingUser.email || ''} onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="button small-button" onClick={() => setEditingUser(null)}>Cancel</button>
                <button className="button button-primary" onClick={async () => {
                  try {
                    const fullName = [editingFirstName.trim(), editingSurname.trim()].filter(Boolean).join(' ');
                    const updated = await api.updateUser(editingUser.id, { full_name: fullName, employee_no: editingUser.employee_no, title: editingUser.title, department: editingUser.department, email: editingUser.email });
                    setEditingUser(null);
                    await load();
                    alert('User saved');
                  } catch (e: any) { alert('Error saving: ' + e.message); }
                }}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
