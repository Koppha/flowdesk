import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";

// ─── Types ───────────────────────────────────────────────────────────────────

type Division   = { id: string; name: string; active: boolean };
type Department = { id: string; name: string; division_id: string | null; active: boolean; is_business_partner?: boolean; division_ids?: string[] };
type Section    = { id: string; name: string; department_id: string | null; active: boolean };
type Team       = { id: string; name: string; section_id: string | null; active: boolean };

export type OrgSelection = {
  /** UUID of the selected division */
  divisionId:   string | null;
  divisionName: string | null;
  /** Department text name — used throughout the system for routing */
  department:   string | null;
  /** UUID of the selected department */
  departmentId: string | null;
  sectionId:    string | null;
  sectionName:  string | null;
  teamId:       string | null;
  teamName:     string | null;
};

type Props = {
  value:            OrgSelection;
  onChange:         (selection: OrgSelection) => void;
  requireDivision?: boolean;
  requireSection?:  boolean;
  showTeam?:        boolean;
  disabled?:        boolean;
  inputClassName?:  string;
};

// ─── OrgPicker ────────────────────────────────────────────────────────────────

export default function OrgPicker({
  value,
  onChange,
  requireDivision = false,
  requireSection  = false,
  showTeam        = true,
  disabled        = false,
  inputClassName  = "",
}: Props) {
  const [divisions,   setDivisions]   = useState<Division[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sections,    setSections]    = useState<Section[]>([]);
  const [teams,       setTeams]       = useState<Team[]>([]);
  const [loading,     setLoading]     = useState(true);

  // Load the full org tree once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.orgStructure();
        if (cancelled) return;
        setDivisions((data.divisions   ?? []).filter((d: Division) => d.active !== false));
        setDepartments(data.departments ?? []);
        setSections(data.sections       ?? []);
        setTeams(data.teams             ?? []);
      } catch {
        try {
          const depts = await api.departments();
          if (cancelled) return;
          // Flat fallback — use name as id so selects still work
          setDepartments((depts as string[]).map((name: string) => ({
            id: name, name, division_id: null, active: true,
          })));
        } catch { /* ignore */ }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Resolve missing IDs / names from loaded data ──────────────────────────
  //
  // A user record may arrive with IDs but no names, or with a department text
  // name but no UUID (department_id). We compute "effective" values here so
  // every select is pre-populated correctly without touching onChange.

  const resolved = useMemo(() => {
    // Department first — match by UUID, then by text name
    const dept =
      (value.departmentId ? departments.find(d => d.id === value.departmentId) : null) ??
      (value.department   ? departments.find(d =>
          d.name.trim().toLowerCase() === (value.department ?? "").trim().toLowerCase()
        ) : null) ??
      null;

    // Division — match by ID/name, then fall back to the dept's parent division
    const div =
      (value.divisionId   ? divisions.find(d => d.id === value.divisionId)   : null) ??
      (value.divisionName ? divisions.find(d => d.name === value.divisionName) : null) ??
      (dept?.division_id  ? divisions.find(d => d.id === dept.division_id)   : null) ??
      null;

    // Section
    const sec =
      (value.sectionId   ? sections.find(s => s.id === value.sectionId)   : null) ??
      (value.sectionName ? sections.find(s => s.name === value.sectionName) : null) ??
      null;

    // Team
    const team =
      (value.teamId   ? teams.find(t => t.id === value.teamId)   : null) ??
      (value.teamName ? teams.find(t => t.name === value.teamName) : null) ??
      null;

    return {
      divisionId:   div?.id   ?? value.divisionId   ?? null,
      divisionName: div?.name ?? value.divisionName ?? null,
      departmentId: dept?.id   ?? value.departmentId ?? null,
      department:   dept?.name ?? value.department   ?? null,
      sectionId:    sec?.id    ?? value.sectionId    ?? null,
      sectionName:  sec?.name  ?? value.sectionName  ?? null,
      teamId:       team?.id   ?? value.teamId       ?? null,
      teamName:     team?.name ?? value.teamName     ?? null,
    };
  }, [value, divisions, departments, sections, teams]);

  // ─── Filtered lists (driven by resolved IDs) ─────────────────────────────

  const activeDivisionId = resolved.divisionId;
  const filteredDepts = activeDivisionId
    ? departments.filter(d =>
        d.division_id === activeDivisionId ||
        (d.is_business_partner && (d.division_ids ?? []).includes(activeDivisionId))
      )
    : departments;

  const filteredSections = resolved.departmentId
    ? sections.filter(s => s.department_id === resolved.departmentId)
    : [];

  const filteredTeams = resolved.sectionId
    ? teams.filter(t => t.section_id === resolved.sectionId)
    : [];

  // A saved Department/Section that doesn't sit under the chosen parent (e.g.
  // an SEFS user placed in MNO's same-named "Finance Operations" department).
  // Without an option for it the select would *display* "— None —" while the
  // old value stays selected underneath - so choosing "— None —" changed
  // nothing and Save kept the wrong placement. Shown as a flagged option
  // instead, so the user can see it and actually pick something else.
  const orphanSection = resolved.sectionId && !filteredSections.some(s => s.id === resolved.sectionId)
    ? (sections.find(s => s.id === resolved.sectionId) ?? null)
    : null;
  const orphanTeam = resolved.teamId && !filteredTeams.some(t => t.id === resolved.teamId)
    ? (teams.find(t => t.id === resolved.teamId) ?? null)
    : null;
  const orphanParentName = (sec: { department_id?: string | null } | null) => {
    const parent = sec?.department_id ? departments.find(d => d.id === sec.department_id) : null;
    if (!parent) return "another division";
    const company = parent.division_id ? divisions.find(d => d.id === parent.division_id)?.name : null;
    return company ? `${parent.name} (${company})` : parent.name;
  };

  // ─── Handlers ────────────────────────────────────────────────────────────

  function handleDivisionChange(divId: string) {
    const div = divisions.find(d => d.id === divId) ?? null;
    onChange({
      divisionId:   divId || null,
      divisionName: div?.name ?? null,
      department:   null,
      departmentId: null,
      sectionId:    null,
      sectionName:  null,
      teamId:       null,
      teamName:     null,
    });
  }

  function handleDepartmentChange(deptId: string) {
    const dept = departments.find(d => d.id === deptId) ?? null;
    // If changing division mid-flow, keep the resolved divisionId that matches
    const divId   = dept?.division_id ?? resolved.divisionId ?? null;
    const divName = divisions.find(d => d.id === divId)?.name ?? resolved.divisionName ?? null;
    onChange({
      divisionId:   divId,
      divisionName: divName,
      department:   dept?.name   ?? null,
      departmentId: deptId || null,
      sectionId:    null,
      sectionName:  null,
      teamId:       null,
      teamName:     null,
    });
  }

  function handleSectionChange(secId: string) {
    const sec = sections.find(s => s.id === secId) ?? null;
    onChange({
      ...resolved,
      sectionId:   secId || null,
      sectionName: sec?.name ?? null,
      teamId:      null,
      teamName:    null,
    });
  }

  function handleTeamChange(teamId: string) {
    const team = teams.find(t => t.id === teamId) ?? null;
    // Auto-resolve section from the team's parent so section_id is always populated
    const parentSection = team?.section_id ? (sections.find(s => s.id === team.section_id) ?? null) : null;
    onChange({
      ...resolved,
      teamId: teamId || null,
      teamName: team?.name ?? null,
      sectionId: parentSection?.id ?? resolved.sectionId ?? null,
      sectionName: parentSection?.name ?? resolved.sectionName ?? null,
    });
  }

  // ─── Styles ──────────────────────────────────────────────────────────────

  const sel: React.CSSProperties = {
    width: "100%",
    padding: "7px 10px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--surface-soft)",
    color: "var(--text)",
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
  };

  if (loading) {
    return <div style={{ color: "var(--muted)", fontSize: 13 }}>Loading org structure…</div>;
  }

  const hasDivisions = divisions.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

      {/* Division */}
      {hasDivisions && (
        <div>
          <label style={labelStyle}>Company{requireDivision ? " *" : ""}</label>
          <select
            className={inputClassName}
            style={sel}
            value={resolved.divisionId ?? ""}
            onChange={e => handleDivisionChange(e.target.value)}
            disabled={disabled}
          >
            <option value="">— Select Company —</option>
            {divisions.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Department */}
      <div>
        <label style={labelStyle}>Division (optional)</label>
        <select
          className={inputClassName}
          style={sel}
          value={resolved.departmentId ?? ""}
          onChange={e => handleDepartmentChange(e.target.value)}
          disabled={disabled || (hasDivisions && !resolved.divisionId && requireDivision)}
        >
          <option value="">
            {hasDivisions && !resolved.divisionId
              ? "Select a company first"
              : filteredDepts.length === 0
                ? "No divisions available"
                : "— Select Division —"}
          </option>
          {filteredDepts.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      {/* Section — shown when dept is chosen AND sections exist for it */}
      {(filteredSections.length > 0 || resolved.sectionId) && (
        <div>
          <label style={labelStyle}>
            Department{requireSection ? " *" : " (optional)"}
          </label>
          <select
            className={inputClassName}
            style={sel}
            value={resolved.sectionId ?? ""}
            onChange={e => handleSectionChange(e.target.value)}
            disabled={disabled}
          >
            <option value="">— None —</option>
            {orphanSection && (
              <option value={orphanSection.id}>{orphanSection.name} — belongs to {orphanParentName(orphanSection)}</option>
            )}
            {filteredSections.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {orphanSection && (
            <div style={{ fontSize: 12, color: "#b45309", marginTop: 4 }}>
              This department belongs to {orphanParentName(orphanSection)}, not the division chosen above. Choose "— None —" or one of this division's departments.
            </div>
          )}
        </div>
      )}

      {/* Team — shown when section is chosen AND teams exist for it */}
      {showTeam && (filteredTeams.length > 0 || resolved.teamId) && (
        <div>
          <label style={labelStyle}>Section (optional)</label>
          <select
            className={inputClassName}
            style={sel}
            value={resolved.teamId ?? ""}
            onChange={e => handleTeamChange(e.target.value)}
            disabled={disabled}
          >
            <option value="">— None —</option>
            {orphanTeam && (
              <option value={orphanTeam.id}>{orphanTeam.name} — belongs to another department</option>
            )}
            {filteredTeams.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {orphanTeam && (
            <div style={{ fontSize: 12, color: "#b45309", marginTop: 4 }}>
              This section isn't under the department chosen above. Choose "— None —" or one of its sections.
            </div>
          )}
        </div>
      )}

      {/* Breadcrumb preview */}
      {(resolved.divisionName || resolved.department) && (
        <div style={{
          fontSize: 11, color: "var(--muted)",
          display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap",
          marginTop: 2,
        }}>
          {resolved.divisionName && (
            <span style={crumb("#3b82f6")}>{resolved.divisionName}</span>
          )}
          {resolved.divisionName && resolved.department && (
            <span style={{ color: "var(--muted)" }}>›</span>
          )}
          {resolved.department && (
            <span style={crumb("#22c55e")}>{resolved.department}</span>
          )}
          {resolved.sectionName && (
            <><span style={{ color: "var(--muted)" }}>›</span>
              <span style={crumb("#f59e0b")}>{resolved.sectionName}</span></>
          )}
          {resolved.teamName && (
            <><span style={{ color: "var(--muted)" }}>›</span>
              <span style={crumb("#a855f7")}>{resolved.teamName}</span></>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared style helpers ─────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--muted)",
  marginBottom: 3,
};

function crumb(color: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "1px 7px",
    borderRadius: 99,
    background: `${color}18`,
    border: `1px solid ${color}44`,
    color,
    fontSize: 11,
    fontWeight: 500,
  };
}

// ─── orgSelectionFromUser ─────────────────────────────────────────────────────
//
// Build an OrgSelection from a flat user record.
// Works even when the user row has names but no IDs, or IDs but no names —
// OrgPicker resolves the gaps from the loaded org data.

export function orgSelectionFromUser(user: {
  department?:    string | null;
  division_id?:   string | null;
  division_name?: string | null;
  section_id?:    string | null;
  section_name?:  string | null;
  team_id?:       string | null;
  team_name?:     string | null;
}): OrgSelection {
  return {
    divisionId:   user.division_id   ?? null,
    divisionName: user.division_name ?? null,
    department:   user.department    ?? null,
    departmentId: null,                        // resolved by OrgPicker from dept text name
    sectionId:    user.section_id    ?? null,
    sectionName:  user.section_name  ?? null,
    teamId:       user.team_id       ?? null,
    teamName:     user.team_name     ?? null,
  };
}
