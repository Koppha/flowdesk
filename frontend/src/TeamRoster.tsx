/**
 * Team Roster — admin view of employees grouped by team.
 * Admin can move any employee to a different team / org position.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { ArrowRight, Building2, ChevronDown, ChevronRight, Network, Pencil, RefreshCw, Search, Users, X } from "lucide-react";
import OrgPicker, { type OrgSelection, orgSelectionFromUser } from "./OrgPicker";
import { useEmploymentTypes } from "./useEmploymentTypes";

// ─── Types ────────────────────────────────────────────────────────────────────

type Employee = {
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
  is_active: boolean;
};


type OrgTeam  = { id: string; name: string; section_id: string | null; leader_name: string | null; active: boolean };
type OrgSec   = { id: string; name: string; department_id: string | null; active: boolean };
type OrgDept  = { id: string; name: string; division_id: string | null; active: boolean };
type OrgDiv   = { id: string; name: string; active: boolean };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function initials(name: string | null | undefined) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase() || "").join("") || "?";
}

function orgLabel(emp: Employee) {
  return [emp.division_name, emp.department, emp.section_name, emp.team_name].filter(Boolean).join(" › ") || "Unassigned";
}

// ─── TeamRoster ───────────────────────────────────────────────────────────────

export default function TeamRoster() {
  const empTypes = useEmploymentTypes();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [orgData, setOrgData] = useState<{ divisions: OrgDiv[]; departments: OrgDept[]; sections: OrgSec[]; teams: OrgTeam[] }>({ divisions: [], departments: [], sections: [], teams: [] });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [divisionFilter, setDivisionFilter] = useState("ALL");

  // Collapse state for tree nodes (key = "div-X", "dept-X", "sec-X", "team-X", "unassigned")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Move-to-team modal
  const [movingEmployee, setMovingEmployee] = useState<Employee | null>(null);
  const [moveOrg, setMoveOrg] = useState<OrgSelection>({ divisionId: null, divisionName: null, department: null, departmentId: null, sectionId: null, sectionName: null, teamId: null, teamName: null });
  const [moving, setMoving] = useState(false);

  // Edit employee modal
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmpNo, setEditEmpNo] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editEmpType, setEditEmpType] = useState("PERMANENT");
  const [editActive, setEditActive] = useState(true);
  const [saving, setSaving] = useState(false);

  // ─── Load ───────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [emps, org] = await Promise.all([
        api.adminUsers(),
        api.orgStructure(),
      ]);
      setEmployees(Array.isArray(emps) ? emps : []);
      setOrgData(org ?? { divisions: [], departments: [], sections: [], teams: [] });
    } catch (e: any) {
      alert("Error loading data: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ─── Derived lists ──────────────────────────────────────────────────────────

  const q = search.toLowerCase().trim();

  const filteredEmployees = useMemo(() => {
    return employees.filter((e) => {
      if (divisionFilter !== "ALL" && (e.division_name ?? "Unassigned") !== divisionFilter) return false;
      if (!q) return true;
      return [e.full_name, e.email, e.employee_no, e.department, e.team_name, e.section_name, e.division_name]
        .some(v => (v ?? "").toLowerCase().includes(q));
    });
  }, [employees, divisionFilter, q]);

  // Group employees: division → department → section → team
  const tree = useMemo(() => {
    type TeamNode  = { id: string | null; name: string; members: Employee[] };
    type SecNode   = { id: string | null; name: string; teams: Map<string, TeamNode> };
    type DeptNode  = { id: string | null; name: string; sections: Map<string, SecNode> };
    type DivNode   = { id: string | null; name: string; departments: Map<string, DeptNode> };

    const divMap = new Map<string, DivNode>();

    for (const emp of filteredEmployees) {
      const divKey  = emp.division_id  ?? "__none_div__";
      const divName = emp.division_name ?? "Unassigned Company";
      const deptKey  = emp.department ?? "__none_dept__";
      const deptName = emp.department ?? "Unassigned Division";
      const secKey  = emp.section_id  ?? "__none_sec__";
      const secName = emp.section_name ?? "Unassigned Department";
      const teamKey  = emp.team_id    ?? "__none_team__";
      const teamName = emp.team_name  ?? "Unassigned Section";

      if (!divMap.has(divKey))  divMap.set(divKey,  { id: emp.division_id, name: divName, departments: new Map() });
      const div = divMap.get(divKey)!;
      if (!div.departments.has(deptKey)) div.departments.set(deptKey, { id: null, name: deptName, sections: new Map() });
      const dept = div.departments.get(deptKey)!;
      if (!dept.sections.has(secKey)) dept.sections.set(secKey, { id: emp.section_id, name: secName, teams: new Map() });
      const sec = dept.sections.get(secKey)!;
      if (!sec.teams.has(teamKey)) sec.teams.set(teamKey, { id: emp.team_id, name: teamName, members: [] });
      sec.teams.get(teamKey)!.members.push(emp);
    }

    return divMap;
  }, [filteredEmployees]);

  const divisionNames = useMemo(() =>
    Array.from(new Set(employees.map(e => e.division_name ?? "Unassigned"))).sort(),
  [employees]);

  // ─── Collapse helpers ────────────────────────────────────────────────────────

  function toggle(key: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function isOpen(key: string) { return !collapsed.has(key); }

  // ─── Move employee ───────────────────────────────────────────────────────────

  async function handleMove() {
    if (!movingEmployee) return;
    if (!moveOrg.department && !moveOrg.teamId) {
      alert("Select at least a department or section to move this employee to.");
      return;
    }
    setMoving(true);
    try {
      await api.updateUserDepartment(movingEmployee.id, {
        department: moveOrg.department ?? movingEmployee.department ?? "",
        division_id: moveOrg.divisionId ?? null,
        section_id: moveOrg.sectionId ?? null,
        team_id: moveOrg.teamId ?? null,
      });
      setMovingEmployee(null);
      await load();
    } catch (e: any) {
      alert("Error moving employee: " + e.message);
    } finally {
      setMoving(false);
    }
  }

  // ─── Edit employee ───────────────────────────────────────────────────────────

  function openEdit(emp: Employee) {
    setEditingEmployee(emp);
    setEditName(emp.full_name ?? "");
    setEditEmpNo(emp.employee_no ?? "");
    setEditTitle(emp.title ?? "");
    setEditEmpType(emp.employment_type ?? "PERMANENT");
    setEditActive(emp.is_active);
  }

  async function handleSaveEdit() {
    if (!editingEmployee) return;
    if (!editName.trim()) { alert("Full name is required."); return; }
    setSaving(true);
    try {
      await api.updateUser(editingEmployee.id, {
        full_name: editName.trim(),
        employee_no: editEmpNo.trim() || null,
        title: editTitle.trim() || null,
        employment_type: editEmpType,
        is_active: editActive,
      });
      setEditingEmployee(null);
      await load();
    } catch (e: any) {
      alert("Error saving employee: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  const totalShown = filteredEmployees.length;

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Users size={22} color="#3b82f6" />
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: "var(--text)" }}>Section Roster</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>
              {totalShown} employee{totalShown !== 1 ? "s" : ""} · grouped by Company → Division → Department → Section
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Search */}
          <div style={{ position: "relative" }}>
            <Search size={13} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
            <input
              placeholder="Search employees…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 28, paddingRight: 8, paddingTop: 6, paddingBottom: 6, border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 13, width: 200 }}
            />
            {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 0, display: "flex" }}><X size={12} /></button>}
          </div>

          {/* Division filter */}
          {divisionNames.length > 1 && (
            <select
              value={divisionFilter}
              onChange={e => setDivisionFilter(e.target.value)}
              style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 13 }}
            >
              <option value="ALL">All Companies</option>
              {divisionNames.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}

          <button onClick={load} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 13 }}>
            <RefreshCw size={13} style={{ animation: loading ? "spin 1s linear infinite" : undefined }} />
            Refresh
          </button>
        </div>
      </div>

      {loading && !employees.length ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>Loading…</div>
      ) : totalShown === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>No employees match the current filters.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[...tree.entries()].map(([divKey, div]) => (
            <div key={divKey} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              {/* Division header */}
              <button
                onClick={() => toggle(divKey)}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "#eff6ff", border: "none", cursor: "pointer", textAlign: "left", borderBottom: isOpen(divKey) ? "1px solid #bfdbfe" : "none" }}
              >
                {isOpen(divKey) ? <ChevronDown size={16} color="#1d4ed8" /> : <ChevronRight size={16} color="#1d4ed8" />}
                <Network size={16} color="#1d4ed8" />
                <span style={{ fontWeight: 700, fontSize: 14, color: "#1e40af" }}>
                  {div.name}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#3b82f6", fontWeight: 500 }}>
                  {[...div.departments.values()].reduce((t, d) => t + [...d.sections.values()].reduce((tt, s) => tt + [...s.teams.values()].reduce((ttt, tm) => ttt + tm.members.length, 0), 0), 0)} employees
                </span>
              </button>

              {isOpen(divKey) && (
                <div>
                  {[...div.departments.entries()].map(([deptKey, dept]) => (
                    <div key={deptKey} style={{ borderBottom: "1px solid var(--border)" }}>
                      {/* Department row */}
                      <button
                        onClick={() => toggle(`dept-${deptKey}`)}
                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 20px", background: "var(--surface-soft)", border: "none", cursor: "pointer", textAlign: "left" }}
                      >
                        {isOpen(`dept-${deptKey}`) ? <ChevronDown size={13} color="var(--muted)" /> : <ChevronRight size={13} color="var(--muted)" />}
                        <Building2 size={13} color="#22c55e" />
                        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{dept.name}</span>
                      </button>

                      {isOpen(`dept-${deptKey}`) && (
                        <div>
                          {[...dept.sections.entries()].map(([secKey, sec]) => (
                            <div key={secKey} style={{ paddingLeft: 16 }}>
                              {/* Section header */}
                              <button
                                onClick={() => toggle(`sec-${secKey}`)}
                                style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 16px", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", cursor: "pointer", textAlign: "left" }}
                              >
                                {isOpen(`sec-${secKey}`) ? <ChevronDown size={12} color="var(--muted)" /> : <ChevronRight size={12} color="var(--muted)" />}
                                <span style={{ fontSize: 11, fontWeight: 600, color: "#f59e0b", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                                  {sec.name}
                                </span>
                              </button>

                              {isOpen(`sec-${secKey}`) && (
                                <div>
                                  {[...sec.teams.entries()].map(([teamKey, team]) => (
                                    <div key={teamKey} style={{ paddingLeft: 16 }}>
                                      {/* Team header */}
                                      <button
                                        onClick={() => toggle(`team-${teamKey}`)}
                                        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", cursor: "pointer", textAlign: "left" }}
                                      >
                                        {isOpen(`team-${teamKey}`) ? <ChevronDown size={12} color="var(--muted)" /> : <ChevronRight size={12} color="var(--muted)" />}
                                        <span style={{ fontSize: 12, fontWeight: 600, color: "#a855f7" }}>
                                          {team.name}
                                        </span>
                                        <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6 }}>
                                          {team.members.length} member{team.members.length !== 1 ? "s" : ""}
                                        </span>
                                      </button>

                                      {isOpen(`team-${teamKey}`) && (
                                        <div>
                                          {team.members.map(emp => (
                                            <EmployeeRow
                                              key={emp.id}
                                              emp={emp}
                                              onMove={() => {
                                                setMoveOrg(orgSelectionFromUser(emp));
                                                setMovingEmployee(emp);
                                              }}
                                              onEdit={() => openEdit(emp)}
                                            />
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Edit employee modal */}
      {editingEmployee && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setEditingEmployee(null)}>
          <div style={{ background: "var(--surface)", borderRadius: 12, padding: 24, width: 420, maxWidth: "95vw", boxShadow: "0 16px 48px rgba(0,0,0,0.25)" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Edit Employee</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{editingEmployee.email}</div>
              </div>
              <button onClick={() => setEditingEmployee(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 4 }}><X size={16} /></button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Full Name *</span>
                <input value={editName} onChange={e => setEditName(e.target.value)} style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 13 }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Employee No.</span>
                <input value={editEmpNo} onChange={e => setEditEmpNo(e.target.value)} style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 13 }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Job Title</span>
                <input value={editTitle} onChange={e => setEditTitle(e.target.value)} style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 13 }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Employment Type</span>
                <select value={editEmpType} onChange={e => setEditEmpType(e.target.value)} style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 13 }}>
                  {empTypes.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={editActive} onChange={e => setEditActive(e.target.checked)} />
                <span style={{ fontSize: 13 }}>Active employee</span>
              </label>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button onClick={() => setEditingEmployee(null)} disabled={saving} style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={handleSaveEdit} disabled={saving || !editName.trim()} style={{ padding: "7px 14px", background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move-to-team modal */}
      {movingEmployee && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setMovingEmployee(null)}>
          <div style={{ background: "var(--surface)", borderRadius: 12, padding: 24, width: 440, maxWidth: "95vw", boxShadow: "0 16px 48px rgba(0,0,0,0.25)" }} onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Move Employee</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                  {movingEmployee.full_name || movingEmployee.email}
                </div>
              </div>
              <button onClick={() => setMovingEmployee(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 4 }}><X size={16} /></button>
            </div>

            {/* Current position */}
            <div style={{ padding: "8px 12px", background: "var(--surface-soft)", borderRadius: 7, marginBottom: 14, fontSize: 12, color: "var(--muted)" }}>
              <strong style={{ color: "var(--text)" }}>Current:</strong> {orgLabel(movingEmployee)}
            </div>

            {/* Arrow */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
              <ArrowRight size={14} color="var(--muted)" />
              <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
            </div>

            {/* New position picker */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Move to</div>
              <OrgPicker value={moveOrg} onChange={setMoveOrg} />
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setMovingEmployee(null)} disabled={moving} style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={handleMove} disabled={moving || (!moveOrg.department && !moveOrg.teamId)} style={{ padding: "7px 14px", background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
                {moving ? "Moving…" : "Move Employee"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── EmployeeRow ─────────────────────────────────────────────────────────────

function EmployeeRow({ emp, onMove, onEdit }: { emp: Employee; onMove: () => void; onEdit: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 28px", borderBottom: "1px solid var(--border)", background: hover ? "var(--surface-soft)" : "transparent", transition: "background 0.1s" }}
    >
      <span style={{ width: 28, height: 28, borderRadius: "50%", background: emp.is_active ? "#dbeafe" : "#f1f5f9", color: emp.is_active ? "#1d4ed8" : "#94a3b8", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11, flexShrink: 0 }}>
        {initials(emp.full_name)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: emp.is_active ? "var(--text)" : "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {emp.full_name || emp.email}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {emp.title || emp.role} {emp.employee_no ? `· ${emp.employee_no}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, opacity: hover ? 1 : 0, transition: "opacity 0.1s", pointerEvents: hover ? "auto" : "none" }}>
        <button
          onClick={onEdit}
          title="Edit employee details"
          style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 5, color: "#15803d", cursor: "pointer", fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" }}
        >
          <Pencil size={11} /> Edit
        </button>
        <button
          onClick={onMove}
          title="Move to another section"
          style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 5, color: "#1d4ed8", cursor: "pointer", fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" }}
        >
          <ArrowRight size={11} /> Move
        </button>
      </div>
    </div>
  );
}
