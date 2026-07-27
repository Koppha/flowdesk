/**
 * Unified search modal for adding a position, team, or individual employee
 * as a new step on a workflow being designed in WorkflowBuilder.
 */
import React, { useMemo, useState } from "react";
import { Briefcase, Building2, Info, Layers, Search, Trash2, User, Users, X } from "lucide-react";

export type ParticipantPosition = {
  id: string;
  code: string;
  name: string;
  description: string;
};

export type ParticipantTeam = {
  id: string;
  name: string;
  departmentLabel: string;
  sectionLabel: string;
};

export type ParticipantEmployee = {
  id: string;
  full_name: string | null;
  email: string;
  title?: string | null;
  department?: string | null;
};

type Filters = { division: string; department: string; section: string; team: string };

type Props = {
  positions: ParticipantPosition[];
  teams: ParticipantTeam[];
  employees: ParticipantEmployee[];
  divisionOptions: string[];
  departmentOptions: string[];
  sectionOptions: string[];
  teamOptions: string[];
  onAddPosition: (position: ParticipantPosition, filters: Filters) => void;
  onAddTeam: (team: ParticipantTeam, anyTeamMember: boolean) => void;
  onAddDepartment: (name: string, anyDepartmentMember: boolean) => void;
  onAddEmployee: (employee: ParticipantEmployee) => void;
  onClose: () => void;
};

type Row =
  | { type: "position"; key: string; name: string; subtitle: string; data: ParticipantPosition }
  | { type: "department"; key: string; name: string; subtitle: string; data: string }
  | { type: "team"; key: string; name: string; subtitle: string; data: ParticipantTeam }
  | { type: "employee"; key: string; name: string; subtitle: string; data: ParticipantEmployee };

const BADGE_STYLES: Record<Row["type"], { bg: string; color: string; label: string; iconBg: string; iconColor: string; Icon: any }> = {
  position: { bg: "#ede9fe", color: "#6d28d9", label: "Position", iconBg: "#ede9fe", iconColor: "#6d28d9", Icon: Briefcase },
  department: { bg: "#fce7f3", color: "#be185d", label: "Department", iconBg: "#fce7f3", iconColor: "#be185d", Icon: Building2 },
  team: { bg: "#dcfce7", color: "#15803d", label: "Section", iconBg: "#dcfce7", iconColor: "#15803d", Icon: Users },
  employee: { bg: "#fef3c7", color: "#b45309", label: "Employee", iconBg: "#fef3c7", iconColor: "#b45309", Icon: User }
};

export default function WorkflowAddParticipantModal({
  positions,
  teams,
  employees,
  divisionOptions,
  departmentOptions,
  sectionOptions,
  teamOptions,
  onAddPosition,
  onAddTeam,
  onAddDepartment,
  onAddEmployee,
  onClose
}: Props) {
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>({ division: "", department: "", section: "", team: "" });
  const [anyTeamMember, setAnyTeamMember] = useState(false);
  const [multiSelect, setMultiSelect] = useState(false);
  const [picked, setPicked] = useState<Row[]>([]);

  const rows: Row[] = useMemo(() => {
    const positionRows: Row[] = positions.map((p) => ({
      type: "position", key: `position-${p.id}`, name: p.name, subtitle: p.description, data: p
    }));
    const departmentRows: Row[] = departmentOptions
      .filter((d) => !filters.department || d === filters.department)
      .map((d) => ({ type: "department", key: `department-${d}`, name: d, subtitle: "Department", data: d }));
    const teamRows: Row[] = teams
      .filter((t) => (!filters.department || t.departmentLabel === filters.department) && (!filters.section || t.sectionLabel === filters.section) && (!filters.team || t.name === filters.team))
      .map((t) => ({ type: "team", key: `team-${t.id}`, name: t.name, subtitle: [t.departmentLabel, t.sectionLabel].filter(Boolean).join(" • ") || "Section", data: t }));
    const employeeRows: Row[] = employees
      .filter((e) => !filters.department || e.department === filters.department)
      .map((e) => ({ type: "employee", key: `employee-${e.id}`, name: e.full_name || e.email, subtitle: [e.department, e.title].filter(Boolean).join(" • "), data: e }));

    const all = [...positionRows, ...departmentRows, ...teamRows, ...employeeRows];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => r.name.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q));
  }, [positions, departmentOptions, teams, employees, query, filters]);

  function isPicked(row: Row) {
    return picked.some((p) => p.key === row.key);
  }

  function commitRow(row: Row) {
    if (row.type === "position") onAddPosition(row.data, filters);
    else if (row.type === "team") onAddTeam(row.data, anyTeamMember);
    else if (row.type === "department") onAddDepartment(row.data, anyTeamMember);
    else onAddEmployee(row.data);
  }

  function handleRowAction(row: Row) {
    if (!multiSelect) {
      commitRow(row);
      return;
    }
    setPicked((prev) => (prev.some((p) => p.key === row.key) ? prev.filter((p) => p.key !== row.key) : [...prev, row]));
  }

  function addSelected() {
    picked.forEach(commitRow);
    setPicked([]);
  }

  function clearSearch() {
    setQuery("");
    setFilters({ division: "", department: "", section: "", team: "" });
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--surface)", borderRadius: 14, padding: 24, width: 620, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,0.25)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "#dbeafe", color: "#1d4ed8", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Layers size={18} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: "var(--text)" }}>Add Workflow Participant</div>
              <div style={{ fontSize: 12, color: "var(--muted, #6b7280)", marginTop: 2 }}>
                Search and select a position, department, section or employee to add to this step.
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 4 }} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Search */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <Search size={15} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
          <input
            autoFocus
            placeholder="Search position, department, section or employee"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%", paddingLeft: 36, paddingRight: 10, paddingTop: 10, paddingBottom: 10, border: "1px solid #93c5fd", borderRadius: 8, background: "var(--surface)", color: "var(--text)", fontSize: 14, boxSizing: "border-box" }}
          />
        </div>

        {/* Results header + Filters */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>Results</span>
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", cursor: "pointer" }}
          >
            Filters
          </button>
        </div>

        {filtersOpen && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <select value={filters.division} onChange={(e) => setFilters((f) => ({ ...f, division: e.target.value, department: "", section: "", team: "" }))} style={{ flex: 1, minWidth: 110, fontSize: 13 }}>
              <option value="">All companies…</option>
              {divisionOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={filters.department} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value, section: "", team: "" }))} style={{ flex: 1, minWidth: 140, fontSize: 13 }}>
              <option value="">All divisions…</option>
              {departmentOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={filters.section} onChange={(e) => setFilters((f) => ({ ...f, section: e.target.value, team: "" }))} disabled={!filters.department} style={{ flex: 1, minWidth: 120, fontSize: 13 }}>
              <option value="">All departments…</option>
              {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filters.team} onChange={(e) => setFilters((f) => ({ ...f, team: e.target.value }))} disabled={!filters.department} style={{ flex: 1, minWidth: 110, fontSize: 13 }}>
              <option value="">All sections…</option>
              {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}

        {/* Results list */}
        <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10, minHeight: 180, maxHeight: 320 }}>
          {rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
              {query || filters.department ? "No matches found." : "Start typing to see results."}
            </div>
          ) : (
            rows.map((row) => {
              const badge = BADGE_STYLES[row.type];
              const Icon = badge.Icon;
              const selected = isPicked(row);
              const disabled = (row.type === "team" || row.type === "department") && !anyTeamMember;
              return (
                <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ width: 38, height: 38, borderRadius: 9, background: badge.iconBg, color: badge.iconColor, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={17} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: badge.bg, color: badge.color }}>{badge.label}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted, #6b7280)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.subtitle}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRowAction(row)}
                    disabled={disabled}
                    title={disabled ? "Enable \"Any section/department member\" to add a whole section or department" : undefined}
                    style={{
                      width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                      border: `1px solid ${selected ? "#1d4ed8" : "#93c5fd"}`,
                      background: selected ? "#1d4ed8" : "var(--surface)",
                      color: selected ? "#fff" : "#1d4ed8",
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled ? 0.4 : 1,
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 600
                    }}
                  >
                    {multiSelect ? (selected ? "✓" : "+") : "+"}
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer controls */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text)" }}>
            <input type="checkbox" checked={anyTeamMember} onChange={(e) => setAnyTeamMember(e.target.checked)} />
            Any section/department member
            <Info size={13} style={{ color: "var(--muted)" }} aria-label="When enabled, adding a Section or Department adds it as 'any one member of this group may approve'." />
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => { setMultiSelect((v) => !v); setPicked([]); }}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "7px 12px", border: `1px solid ${multiSelect ? "#1d4ed8" : "var(--border)"}`, borderRadius: 7, background: multiSelect ? "#eff6ff" : "var(--surface-soft)", color: multiSelect ? "#1d4ed8" : "var(--text)", cursor: "pointer" }}
            >
              <Users size={14} /> Multiple selection
            </button>
            <button type="button" onClick={clearSearch} title="Clear search & filters" style={{ width: 34, height: 34, borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface-soft)", color: "#dc2626", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {multiSelect && picked.length > 0 && (
          <button
            type="button"
            onClick={addSelected}
            style={{ marginTop: 12, padding: "9px 14px", background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            Add Selected ({picked.length})
          </button>
        )}

        <div style={{ marginTop: 14, padding: "10px 14px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, fontSize: 12, color: "#1e40af" }}>
          You can search by position name, department name, section name, employee name or employee number. Start typing to see results.
        </div>
      </div>
    </div>
  );
}
