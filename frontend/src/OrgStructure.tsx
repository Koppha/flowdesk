import React, { useEffect, useState, useCallback, useRef } from "react";
import { api } from "./api";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Download,
  Edit3,
  FileText,
  Layers,
  Network,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
  X,
  Check,
  Briefcase,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type Division = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
};

type Department = {
  id: string;
  name: string;
  division_id: string | null;
  hod_user_id: string | null;
  hod_name: string | null;
  manager_user_id: string | null;
  manager_name: string | null;
  active: boolean;
  is_business_partner: boolean;
  division_ids: string[];
};

type Section = {
  id: string;
  name: string;
  department_id: string | null;
  active: boolean;
  is_business_partner: boolean;
  division_ids: string[];
};

type Team = {
  id: string;
  name: string;
  section_id: string | null;
  leader_user_id: string | null;
  leader_name: string | null;
  active: boolean;
};

type OrgData = {
  divisions: Division[];
  departments: Department[];
  sections: Section[];
  teams: Team[];
};

type ModalMode = "division" | "department" | "section" | "team";

type FormState = {
  mode: ModalMode;
  editing: boolean;
  id?: string;
  originalName?: string;
  parentId?: string;
  homeDivisionId?: string | null;
  name: string;
  description: string;
  active: boolean;
  isBP: boolean;
  bpDivisionIds: string[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<ModalMode, { bg: string; badge: string; dot: string }> = {
  division: { bg: "#eff6ff", badge: "#1d4ed8", dot: "#3b82f6" },
  department: { bg: "#f0fdf4", badge: "#15803d", dot: "#22c55e" },
  section: { bg: "#fefce8", badge: "#92400e", dot: "#f59e0b" },
  team: { bg: "#fdf4ff", badge: "#7e22ce", dot: "#a855f7" },
};

const LEVEL_LABELS: Record<ModalMode, string> = {
  division: "Company",
  department: "Division",
  section: "Department",
  team: "Section",
};

function Badge({ mode }: { mode: ModalMode }) {
  const c = LEVEL_COLORS[mode];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: 99,
        fontSize: 11,
        fontWeight: 600,
        background: c.bg,
        color: c.badge,
        border: `1px solid ${c.badge}33`,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {LEVEL_LABELS[mode]}
    </span>
  );
}

// ─── Import types ─────────────────────────────────────────────────────────────

type ImportRow = {
  type: "Company" | "Division" | "Department" | "Section";
  name: string;
  division: string;
  department: string;
  section: string;
  description: string;
  active: boolean;
  isBusinessPartner: boolean;
};

type ImportResult = { done: boolean; created: number; skipped: number; errors: string[] };

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && inQ && line[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') { inQ = !inQ; }
    else if (c === "," && !inQ) { result.push(cell); cell = ""; }
    else { cell += c; }
  }
  result.push(cell);
  return result;
}

function csvCell(v: string) { return `"${v.replace(/"/g, '""')}"`; }

// ─── OrgStructure Component ───────────────────────────────────────────────────

export default function OrgStructure() {
  const [data, setData] = useState<OrgData>({ divisions: [], departments: [], sections: [], teams: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ mode: ModalMode; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteUnassignedConfirm, setDeleteUnassignedConfirm] = useState(false);
  const [deletingUnassigned, setDeletingUnassigned] = useState(false);

  // Import/Export state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null);
  const [importProcessing, setImportProcessing] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.orgStructure();
      setData(d);
    } catch (e: any) {
      setError(e.message || "Failed to load org structure");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ─── Export ─────────────────────────────────────────────────────────────────

  function exportCSV() {
    const header = ["Type", "Name", "Company", "Division", "Department", "Description", "Active", "BusinessPartner"];
    const rows: string[][] = [header];

    for (const div of data.divisions) {
      rows.push(["Company", div.name, "", "", "", div.description ?? "", String(div.active), "false"]);
    }
    for (const dept of data.departments) {
      const divName = data.divisions.find(d => d.id === dept.division_id)?.name ?? "";
      rows.push(["Division", dept.name, divName, "", "", "", String(dept.active), String(dept.is_business_partner)]);
    }
    for (const sec of data.sections) {
      const dept = data.departments.find(d => d.id === sec.department_id);
      const deptName = dept?.name ?? "";
      const divName = dept ? (data.divisions.find(d => d.id === dept.division_id)?.name ?? "") : "";
      rows.push(["Department", sec.name, divName, deptName, "", "", String(sec.active), String(sec.is_business_partner)]);
    }
    for (const team of data.teams) {
      const sec = data.sections.find(s => s.id === team.section_id);
      const secName = sec?.name ?? "";
      const dept = sec ? data.departments.find(d => d.id === sec.department_id) : null;
      const deptName = dept?.name ?? "";
      const divName = dept ? (data.divisions.find(d => d.id === dept.division_id)?.name ?? "") : "";
      rows.push(["Section", team.name, divName, deptName, secName, "", String(team.active), "false"]);
    }

    const csv = rows.map(r => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `org-structure-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ─── Import ─────────────────────────────────────────────────────────────────

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { setImportRows([]); return; }
      const parsed: ImportRow[] = [];
      for (const line of lines.slice(1)) {
        const cells = parseCsvLine(line);
        const type = cells[0]?.trim() as ImportRow["type"];
        const name = cells[1]?.trim() ?? "";
        if (!name || !["Company", "Division", "Department", "Section"].includes(type)) continue;
        parsed.push({
          type,
          name,
          division: cells[2]?.trim() ?? "",
          department: cells[3]?.trim() ?? "",
          section: cells[4]?.trim() ?? "",
          description: cells[5]?.trim() ?? "",
          active: (cells[6]?.trim() ?? "true").toLowerCase() !== "false",
          isBusinessPartner: (cells[7]?.trim() ?? "false").toLowerCase() === "true",
        });
      }
      setImportRows(parsed);
      setImportResult(null);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function runImport() {
    if (!importRows?.length) return;
    setImportProcessing(true);
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    try {
      // 1. Companies
      for (const row of importRows.filter(r => r.type === "Company")) {
        if (data.divisions.some(d => d.name.toLowerCase() === row.name.toLowerCase())) { skipped++; continue; }
        try { await api.createDivision(row.name, row.description || null); created++; }
        catch (e: any) { errors.push(`Company "${row.name}": ${e.message}`); }
      }

      let fresh: OrgData = await api.orgStructure();

      // 2. Divisions
      for (const row of importRows.filter(r => r.type === "Division")) {
        if (fresh.departments.some((d: Department) => d.name.toLowerCase() === row.name.toLowerCase())) { skipped++; continue; }
        try { await api.createDepartment(row.name, undefined, undefined, undefined, row.active, undefined); created++; }
        catch (e: any) { errors.push(`Division "${row.name}": ${e.message}`); }
      }

      fresh = await api.orgStructure();

      // Link departments to divisions
      for (const row of importRows.filter(r => r.type === "Division" && r.division)) {
        const dept = fresh.departments.find((d: Department) => d.name.toLowerCase() === row.name.toLowerCase());
        const div = fresh.divisions.find((d: Division) => d.name.toLowerCase() === row.division.toLowerCase());
        if (dept && div && !dept.division_id) {
          try { await api.updateDepartment(dept.name, { name: dept.name, division_id: div.id, is_business_partner: row.isBusinessPartner, division_ids: [] }); }
          catch (e: any) { errors.push(`Link dept "${row.name}": ${e.message}`); }
        }
      }

      fresh = await api.orgStructure();

      // 3. Departments
      for (const row of importRows.filter(r => r.type === "Department")) {
        if (fresh.sections.some((s: Section) => s.name.toLowerCase() === row.name.toLowerCase())) { skipped++; continue; }
        const deptId = fresh.departments.find((d: Department) => d.name.toLowerCase() === row.department.toLowerCase())?.id ?? null;
        try { await api.createSection(row.name, null, deptId, row.isBusinessPartner, []); created++; }
        catch (e: any) { errors.push(`Department "${row.name}": ${e.message}`); }
      }

      fresh = await api.orgStructure();

      // 4. Sections
      for (const row of importRows.filter(r => r.type === "Section")) {
        if (fresh.teams.some((t: Team) => t.name.toLowerCase() === row.name.toLowerCase())) { skipped++; continue; }
        const secId = fresh.sections.find((s: Section) => s.name.toLowerCase() === row.section.toLowerCase())?.id ?? null;
        try { await api.createTeam(row.name, secId, null); created++; }
        catch (e: any) { errors.push(`Section "${row.name}": ${e.message}`); }
      }

      fresh = await api.orgStructure();
      setData(fresh);
      setImportResult({ done: true, created, skipped, errors });
    } catch (e: any) {
      errors.push(`Unexpected: ${e.message}`);
      setImportResult({ done: true, created, skipped, errors });
    } finally {
      setImportProcessing(false);
    }
  }

  function toggleCollapse(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function openAdd(mode: ModalMode, parentId?: string) {
    setForm({ mode, editing: false, parentId, homeDivisionId: parentId ?? null, name: "", description: "", active: true, isBP: false, bpDivisionIds: [] });
  }

  function openEdit(mode: ModalMode, item: { id: string; name: string; description?: string | null; active: boolean; is_business_partner?: boolean; division_ids?: string[]; division_id?: string | null }, parentId?: string) {
    const homeDivisionId = mode === "department" ? (item.division_id ?? parentId ?? null) : null;
    const isBP = (mode === "department" || mode === "section") ? (item.is_business_partner ?? false) : false;
    const bpDivisionIds = (mode === "department" || mode === "section") ? (item.division_ids ?? []) : [];
    setForm({ mode, editing: true, id: item.id, originalName: item.name, parentId, homeDivisionId, name: item.name, description: item.description ?? "", active: item.active, isBP, bpDivisionIds });
  }

  async function handleSave() {
    if (!form) return;
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (form.mode === "division") {
        if (form.editing && form.id) {
          await api.updateDivision(form.id, { name: form.name.trim(), description: form.description || null, active: form.active });
        } else {
          await api.createDivision(form.name.trim(), form.description || null);
        }
      } else if (form.mode === "department") {
        const divIds = form.isBP ? form.bpDivisionIds : [];
        // For regular departments, division_id comes from form.homeDivisionId (user-selected)
        const homeDivId = form.isBP
          ? (form.homeDivisionId ?? form.parentId ?? null)
          : (form.homeDivisionId ?? form.parentId ?? null);
        if (form.editing && form.id) {
          await api.updateDepartment(form.originalName ?? form.name.trim(), {
            name: form.name.trim(),
            division_id: homeDivId,
            active: form.active,
            is_business_partner: form.isBP,
            division_ids: divIds
          });
        } else {
          await api.createDepartment(form.name.trim(), undefined, undefined, undefined, form.active, undefined);
          const fresh = await api.orgStructure();
          const created = fresh.departments.find((d: Department) => d.name.toLowerCase() === form.name.trim().toLowerCase());
          if (created) {
            await api.updateDepartment(created.name, {
              name: created.name,
              division_id: homeDivId,
              is_business_partner: form.isBP,
              division_ids: divIds
            });
          }
        }
      } else if (form.mode === "section") {
        const secDivIds = form.isBP ? form.bpDivisionIds : [];
        if (form.editing && form.id) {
          await api.updateSection(form.id, { name: form.name.trim(), department_id: form.isBP ? null : (form.parentId ?? null), active: form.active, is_business_partner: form.isBP, division_ids: secDivIds });
        } else {
          await api.createSection(form.name.trim(), null, form.isBP ? null : (form.parentId ?? null), form.isBP, secDivIds);
        }
      } else if (form.mode === "team") {
        if (form.editing && form.id) {
          await api.updateTeam(form.id, { name: form.name.trim(), section_id: form.parentId ?? null, active: form.active });
        } else {
          await api.createTeam(form.name.trim(), form.parentId, null);
        }
      }
      setForm(null);
      await load();
    } catch (e: any) {
      alert(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      if (deleteConfirm.mode === "division") await api.deleteDivision(deleteConfirm.id);
      else if (deleteConfirm.mode === "department") await api.deleteDepartment(deleteConfirm.name);
      else if (deleteConfirm.mode === "section") await api.deleteSection(deleteConfirm.id);
      else if (deleteConfirm.mode === "team") await api.deleteTeam(deleteConfirm.id);
      setDeleteConfirm(null);
      await load();
    } catch (e: any) {
      alert(e.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteUnassigned() {
    setDeletingUnassigned(true);
    try {
      const result = await api.deleteUnassignedOrg();
      setDeleteUnassignedConfirm(false);
      await load();
      const d = result.deleted;
      const total = d.departments + d.sections + d.teams;
      const skippedDepts = result.skipped?.departments ?? [];
      const msg = total === 0
        ? "No unassigned items could be deleted."
        : `Deleted ${total} item(s): ${d.departments} department(s), ${d.sections} section(s), ${d.teams} team(s).` +
          (skippedDepts.length ? `\n\nSkipped (have assigned users): ${skippedDepts.join(", ")}` : "");
      alert(msg);
    } catch (e: any) {
      alert(e.message || "Delete failed");
    } finally {
      setDeletingUnassigned(false);
    }
  }

  // Filter helpers
  const q = search.toLowerCase().trim();
  function matchDiv(d: Division) { return !q || d.name.toLowerCase().includes(q); }
  function matchDept(d: Department) { return !q || d.name.toLowerCase().includes(q); }
  function matchSec(s: Section) { return !q || s.name.toLowerCase().includes(q); }
  function matchTeam(t: Team) { return !q || t.name.toLowerCase().includes(q); }

  // Unassigned items (no parent set); BP departments are intentionally division-less
  const unassignedDepts = data.departments.filter(d => !d.division_id && !d.is_business_partner && matchDept(d));
  const unassignedSections = data.sections.filter(s => !s.department_id && !s.is_business_partner && matchSec(s));
  const unassignedTeams = data.teams.filter(t => !t.section_id && matchTeam(t));

  const totalNodes =
    data.divisions.length + data.departments.length + data.sections.length + data.teams.length;

  // ─── Render helpers ──────────────────────────────────────────────────────────

  function renderTeams(sectionId: string) {
    const items = data.teams.filter(t => t.section_id === sectionId && matchTeam(t));
    if (!items.length) return null;
    return (
      <div style={{ marginLeft: 24, marginTop: 4 }}>
        {items.map(team => (
          <NodeRow
            key={team.id}
            mode="team"
            id={team.id}
            name={team.name}
            active={team.active}
            subtitle={team.leader_name ? `Leader: ${team.leader_name}` : undefined}
            onEdit={() => openEdit("team", { id: team.id, name: team.name, active: team.active }, sectionId)}
            onDelete={() => setDeleteConfirm({ mode: "team", id: team.id, name: team.name })}
          />
        ))}
      </div>
    );
  }

  function renderSections(deptId: string) {
    const items = data.sections.filter(s => s.department_id === deptId && matchSec(s));
    const isOpen = !collapsed.has(`sec-${deptId}`);
    if (!items.length && !q) return null;
    if (!items.length) return null;
    return (
      <div style={{ marginLeft: 24, marginTop: 4 }}>
        {items.map(sec => {
          const teamCount = data.teams.filter(t => t.section_id === sec.id).length;
          return (
            <div key={sec.id}>
              <NodeRow
                mode="section"
                id={sec.id}
                name={sec.name}
                active={sec.active}
                childCount={teamCount}
                collapsed={collapsed.has(`sec-${sec.id}`)}
                onToggle={() => toggleCollapse(`sec-${sec.id}`)}
                onEdit={() => openEdit("section", { id: sec.id, name: sec.name, active: sec.active, is_business_partner: sec.is_business_partner, division_ids: sec.division_ids }, deptId)}
                onDelete={() => setDeleteConfirm({ mode: "section", id: sec.id, name: sec.name })}
                addChildLabel="Add Section"
                onAddChild={() => openAdd("team", sec.id)}
              />
              {!collapsed.has(`sec-${sec.id}`) && renderTeams(sec.id)}
            </div>
          );
        })}
      </div>
    );
  }

  function renderBPDepartments(divId: string) {
    const items = data.departments.filter(d => d.is_business_partner && (d.division_ids ?? []).includes(divId) && matchDept(d));
    if (!items.length) return null;
    return (
      <div style={{ marginLeft: 24, marginTop: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#1d4ed8", textTransform: "uppercase" as const, letterSpacing: "0.06em", padding: "2px 0 4px 4px", opacity: 0.7 }}>
          Business Partner Divisions
        </div>
        {items.map(dept => {
          const secCount = data.sections.filter(s => s.department_id === dept.id).length;
          return (
            <div key={dept.id}>
              <NodeRow
                mode="department"
                id={dept.id}
                name={dept.name}
                active={dept.active}
                subtitle="Business Partner"
                childCount={secCount}
                collapsed={collapsed.has(`dept-${dept.id}`)}
                onToggle={() => toggleCollapse(`dept-${dept.id}`)}
                onEdit={() => openEdit("department", { id: dept.id, name: dept.name, active: dept.active, is_business_partner: dept.is_business_partner, division_ids: dept.division_ids, division_id: dept.division_id })}
                onDelete={() => setDeleteConfirm({ mode: "department", id: dept.id, name: dept.name })}
                addChildLabel="Add Department"
                onAddChild={() => openAdd("section", dept.id)}
              />
              {!collapsed.has(`dept-${dept.id}`) && renderSections(dept.id)}
            </div>
          );
        })}
      </div>
    );
  }

  function renderBPSections(divId: string) {
    const items = data.sections.filter(s => s.is_business_partner && (s.division_ids ?? []).includes(divId) && matchSec(s));
    if (!items.length) return null;
    return (
      <div style={{ marginLeft: 24, marginTop: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#1d4ed8", textTransform: "uppercase" as const, letterSpacing: "0.06em", padding: "2px 0 4px 4px", opacity: 0.7 }}>
          Business Partner Departments
        </div>
        {items.map(sec => {
          const teamCount = data.teams.filter(t => t.section_id === sec.id).length;
          return (
            <div key={sec.id}>
              <NodeRow
                mode="section"
                id={sec.id}
                name={sec.name}
                active={sec.active}
                subtitle="Business Partner"
                childCount={teamCount}
                collapsed={collapsed.has(`sec-${sec.id}`)}
                onToggle={() => toggleCollapse(`sec-${sec.id}`)}
                onEdit={() => openEdit("section", { id: sec.id, name: sec.name, active: sec.active, is_business_partner: sec.is_business_partner, division_ids: sec.division_ids })}
                onDelete={() => setDeleteConfirm({ mode: "section", id: sec.id, name: sec.name })}
                addChildLabel="Add Section"
                onAddChild={() => openAdd("team", sec.id)}
              />
              {!collapsed.has(`sec-${sec.id}`) && renderTeams(sec.id)}
            </div>
          );
        })}
      </div>
    );
  }

  function renderDepartments(divId: string) {
    const items = data.departments.filter(d => d.division_id === divId && matchDept(d));
    if (!items.length) return null;
    return (
      <div style={{ marginLeft: 24, marginTop: 4 }}>
        {items.map(dept => {
          const secCount = data.sections.filter(s => s.department_id === dept.id).length;
          const bpLabel = dept.is_business_partner ? "Business Partner" : undefined;
          const hodLabel = dept.hod_name ? `HOD: ${dept.hod_name}` : dept.manager_name ? `Manager: ${dept.manager_name}` : "Leadership: Vacant";
          const subtitle = [bpLabel, hodLabel].filter(Boolean).join(" · ") || undefined;
          return (
            <div key={dept.id}>
              <NodeRow
                mode="department"
                id={dept.id}
                name={dept.name}
                active={dept.active}
                subtitle={subtitle}
                childCount={secCount}
                collapsed={collapsed.has(`dept-${dept.id}`)}
                onToggle={() => toggleCollapse(`dept-${dept.id}`)}
                onEdit={() => openEdit("department", { id: dept.id, name: dept.name, active: dept.active, is_business_partner: dept.is_business_partner, division_ids: dept.division_ids, division_id: dept.division_id }, divId)}
                onDelete={() => setDeleteConfirm({ mode: "department", id: dept.id, name: dept.name })}
                addChildLabel="Add Department"
                onAddChild={() => openAdd("section", dept.id)}
              />
              {!collapsed.has(`dept-${dept.id}`) && renderSections(dept.id)}
            </div>
          );
        })}
      </div>
    );
  }

  // ─── Main render ─────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Network size={22} color="#3b82f6" />
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: "var(--text)" }}>Org Structure</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>
              {totalNodes} nodes · Companies → Divisions → Departments → Sections
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ position: "relative" }}>
            <Search size={14} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
            <input
              placeholder="Search…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6, border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 13, width: 180 }}
            />
            {search && (
              <button onClick={() => setSearch("")} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 0, display: "flex" }}>
                <X size={13} />
              </button>
            )}
          </div>
          <button onClick={load} disabled={loading} style={btnSecondary}>
            <RefreshCw size={13} style={{ animation: loading ? "spin 1s linear infinite" : undefined }} />
            Refresh
          </button>
          <button onClick={exportCSV} disabled={!totalNodes} style={btnSecondary} title="Export to CSV">
            <Download size={13} /> Export
          </button>
          <button onClick={() => { setShowImportModal(true); setImportRows(null); setImportResult(null); }} style={btnSecondary} title="Import from CSV">
            <Upload size={13} /> Import
          </button>
          <button onClick={() => openAdd("division")} style={btnPrimary}>
            <Plus size={14} /> New Company
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><Building2 size={28} /></span>
          <div><div className="stat-value">{data.divisions.length}</div><div className="stat-label">Companies</div></div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Briefcase size={28} /></span>
          <div><div className="stat-value">{data.departments.length}</div><div className="stat-label">Divisions</div></div>
        </div>
        <div className="stat-card stat-card-rose">
          <span className="stat-icon"><Layers size={28} /></span>
          <div><div className="stat-value">{data.sections.length}</div><div className="stat-label">Departments</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><Users size={28} /></span>
          <div><div className="stat-value">{data.teams.length}</div><div className="stat-label">Sections</div></div>
        </div>
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, color: "#dc2626", marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading && !totalNodes ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", fontSize: 14 }}>Loading…</div>
      ) : (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>

          {/* Organization root */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 12, borderBottom: "1px solid var(--border)", marginBottom: 12 }}>
            <Building2 size={18} color="#64748b" />
            <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>Organization</span>
            <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 4 }}>{data.divisions.length} companies</span>
          </div>

          {/* Divisions */}
          {data.divisions.filter(matchDiv).map(div => {
            const deptCount = data.departments.filter(d => d.division_id === div.id).length;
            return (
              <div key={div.id} style={{ marginBottom: 4 }}>
                <NodeRow
                  mode="division"
                  id={div.id}
                  name={div.name}
                  active={div.active}
                  subtitle={div.description ?? undefined}
                  childCount={deptCount}
                  collapsed={collapsed.has(`div-${div.id}`)}
                  onToggle={() => toggleCollapse(`div-${div.id}`)}
                  onEdit={() => openEdit("division", { id: div.id, name: div.name, description: div.description, active: div.active })}
                  onDelete={() => setDeleteConfirm({ mode: "division", id: div.id, name: div.name })}
                  addChildLabel="Add Division"
                  onAddChild={() => openAdd("department", div.id)}
                />
                {!collapsed.has(`div-${div.id}`) && renderDepartments(div.id)}
                {!collapsed.has(`div-${div.id}`) && renderBPDepartments(div.id)}
                {!collapsed.has(`div-${div.id}`) && renderBPSections(div.id)}
              </div>
            );
          })}

          {!data.divisions.length && !q && (
            <div style={{ textAlign: "center", padding: "32px 0", color: "var(--muted)", fontSize: 13 }}>
              No divisions yet.{" "}
              <button onClick={() => openAdd("division")} style={{ background: "none", border: "none", color: "#3b82f6", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}>
                Create the first division
              </button>
            </div>
          )}

          {/* Unassigned nodes */}
          {(unassignedDepts.length > 0 || unassignedSections.length > 0 || unassignedTeams.length > 0) && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px dashed var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Unassigned
                </div>
                <button onClick={() => setDeleteUnassignedConfirm(true)} style={{ ...btnSecondary, color: "#dc2626", borderColor: "#fca5a5", fontSize: 12, padding: "3px 10px" }}>
                  <Trash2 size={12} /> Delete All Unassigned
                </button>
              </div>
              {unassignedDepts.map(dept => (
                <NodeRow
                  key={dept.id}
                  mode="department"
                  id={dept.id}
                  name={dept.name}
                  active={dept.active}
                  onEdit={() => openEdit("department", { id: dept.id, name: dept.name, active: dept.active, is_business_partner: dept.is_business_partner, division_ids: dept.division_ids, division_id: dept.division_id })}
                  onDelete={() => setDeleteConfirm({ mode: "department", id: dept.id, name: dept.name })}
                />
              ))}
              {unassignedSections.map(sec => (
                <NodeRow
                  key={sec.id}
                  mode="section"
                  id={sec.id}
                  name={sec.name}
                  active={sec.active}
                  onEdit={() => openEdit("section", { id: sec.id, name: sec.name, active: sec.active, is_business_partner: sec.is_business_partner, division_ids: sec.division_ids })}
                  onDelete={() => setDeleteConfirm({ mode: "section", id: sec.id, name: sec.name })}
                />
              ))}
              {unassignedTeams.map(team => (
                <NodeRow
                  key={team.id}
                  mode="team"
                  id={team.id}
                  name={team.name}
                  active={team.active}
                  onEdit={() => openEdit("team", { id: team.id, name: team.name, active: team.active })}
                  onDelete={() => setDeleteConfirm({ mode: "team", id: team.id, name: team.name })}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Modal */}
      {form && (
        <Modal title={`${form.editing ? "Edit" : "New"} ${LEVEL_LABELS[form.mode]}`} onClose={() => setForm(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label style={labelStyle}>
              Name *
              <input
                autoFocus
                value={form.name}
                onChange={e => setForm(f => f ? { ...f, name: e.target.value } : f)}
                placeholder={`${LEVEL_LABELS[form.mode]} name`}
                style={inputStyle}
                onKeyDown={e => e.key === "Enter" && handleSave()}
              />
            </label>
            {form.mode === "division" && (
              <label style={labelStyle}>
                Description
                <input
                  value={form.description}
                  onChange={e => setForm(f => f ? { ...f, description: e.target.value } : f)}
                  placeholder="Optional description"
                  style={inputStyle}
                />
              </label>
            )}
            {(form.mode === "department" || form.mode === "section") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Division assignment for regular (non-BP) departments */}
                {form.mode === "department" && !form.isBP && (
                  <label style={labelStyle}>
                    Parent Company
                    <select
                      value={form.homeDivisionId ?? ""}
                      onChange={e => setForm(f => f ? { ...f, homeDivisionId: e.target.value || null } : f)}
                      style={inputStyle}
                    >
                      <option value="">— Unassigned —</option>
                      {data.divisions.map(div => (
                        <option key={div.id} value={div.id}>{div.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text)", padding: "8px 10px", background: form.isBP ? "#eff6ff" : "var(--surface-soft)", border: "1px solid", borderColor: form.isBP ? "#3b82f6" : "var(--border)", borderRadius: 7 }}>
                  <input
                    type="checkbox"
                    checked={form.isBP}
                    onChange={e => setForm(f => f ? { ...f, isBP: e.target.checked, bpDivisionIds: e.target.checked ? f.bpDivisionIds : [] } : f)}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>Business Partner {form.mode === "section" ? "Department" : "Division"}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>This {LEVEL_LABELS[form.mode].toLowerCase()} serves multiple companies</div>
                  </div>
                </label>
                {form.isBP && (
                  <div style={{ padding: "10px 12px", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 7 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 8 }}>
                      Choose Companies
                    </div>
                    {data.divisions.length === 0 && (
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>No companies available.</div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {data.divisions.filter(div => div.id !== (form.homeDivisionId ?? form.parentId)).map(div => (
                        <label key={div.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
                          <input
                            type="checkbox"
                            checked={form.bpDivisionIds.includes(div.id)}
                            onChange={e => setForm(f => {
                              if (!f) return f;
                              const ids = e.target.checked
                                ? [...f.bpDivisionIds, div.id]
                                : f.bpDivisionIds.filter(id => id !== div.id);
                              return { ...f, bpDivisionIds: ids };
                            })}
                          />
                          {div.name}
                          {!div.active && <span style={{ fontSize: 11, color: "#94a3b8" }}>(inactive)</span>}
                        </label>
                      ))}
                      {data.divisions.filter(div => div.id !== form.parentId).length === 0 && (
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>No other divisions available to partner with.</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            {form.editing && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={e => setForm(f => f ? { ...f, active: e.target.checked } : f)}
                />
                Active
              </label>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button onClick={() => setForm(null)} style={btnSecondary} disabled={saving}>Cancel</button>
              <button onClick={handleSave} style={btnPrimary} disabled={saving || !form.name.trim()}>
                {saving ? "Saving…" : form.editing ? "Save Changes" : `Create ${LEVEL_LABELS[form.mode]}`}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirm && (
        <Modal title={`Delete ${LEVEL_LABELS[deleteConfirm.mode]}`} onClose={() => setDeleteConfirm(null)}>
          <div style={{ fontSize: 14, color: "var(--text)", marginBottom: 20 }}>
            Delete <strong>"{deleteConfirm.name}"</strong>? This cannot be undone. Child nodes must be reassigned first.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setDeleteConfirm(null)} style={btnSecondary} disabled={deleting}>Cancel</button>
            <button onClick={handleDelete} disabled={deleting} style={{ ...btnPrimary, background: "#dc2626" }}>
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </Modal>
      )}

      {/* Delete All Unassigned Confirm Modal */}
      {deleteUnassignedConfirm && (
        <Modal title="Delete All Unassigned" onClose={() => setDeleteUnassignedConfirm(false)}>
          <div style={{ fontSize: 14, color: "var(--text)", marginBottom: 20 }}>
            Delete all unassigned departments, sections, and teams? Items with assigned users will be skipped. This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setDeleteUnassignedConfirm(false)} style={btnSecondary} disabled={deletingUnassigned}>Cancel</button>
            <button onClick={handleDeleteUnassigned} disabled={deletingUnassigned} style={{ ...btnPrimary, background: "#dc2626" }}>
              {deletingUnassigned ? "Deleting…" : "Delete All Unassigned"}
            </button>
          </div>
        </Modal>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <Modal title="Import Org Structure" onClose={() => { if (!importProcessing) { setShowImportModal(false); setImportRows(null); setImportResult(null); } }}>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: "none" }}
            onChange={handleImportFile}
          />

          {/* Format hint */}
          {!importRows && !importResult && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ padding: "10px 12px", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  <FileText size={13} /> Expected CSV format
                </div>
                <code style={{ fontSize: 11, display: "block", whiteSpace: "pre" }}>
                  {"Type,Name,Company,Division,Department,Description,Active,BusinessPartner\n"}
                  {"Company,Higherlife,,,,Top-level entity,true,false\n"}
                  {"Division,Technical,Higherlife,,,,true,false\n"}
                  {"Department,Billing & IS,,Technical,,,true,false\n"}
                  {"Section,Applications,,,Billing & IS,,true,false"}
                </code>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                <button onClick={() => fileInputRef.current?.click()} style={btnPrimary}>
                  <Upload size={13} /> Choose CSV File
                </button>
                <button onClick={() => { setShowImportModal(false); }} style={btnSecondary}>Cancel</button>
              </div>
            </div>
          )}

          {/* Preview */}
          {importRows && !importResult && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {(["Company", "Division", "Department", "Section"] as ImportRow["type"][]).map(t => {
                  const count = importRows.filter(r => r.type === t).length;
                  return (
                    <div key={t} style={{ padding: "8px 12px", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13 }}>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{count}</span>
                      <span style={{ color: "var(--muted)", marginLeft: 6 }}>{LEVEL_LABELS[t.toLowerCase() as ModalMode]}{count !== 1 ? "s" : ""}</span>
                    </div>
                  );
                })}
              </div>
              {importRows.length === 0 ? (
                <div style={{ fontSize: 13, color: "#dc2626" }}>No valid rows found in the file. Check the format.</div>
              ) : (
                <div style={{ fontSize: 13, color: "var(--muted)" }}>
                  {importRows.length} row{importRows.length !== 1 ? "s" : ""} ready to import. Existing items with the same name will be skipped.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
                <button onClick={() => { setImportRows(null); fileInputRef.current?.click(); }} style={btnSecondary} disabled={importProcessing}>
                  Choose Different File
                </button>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { setImportRows(null); setShowImportModal(false); }} style={btnSecondary} disabled={importProcessing}>Cancel</button>
                  <button onClick={runImport} style={btnPrimary} disabled={importProcessing || importRows.length === 0}>
                    {importProcessing ? "Importing…" : "Confirm Import"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Result */}
          {importResult && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ padding: "10px 14px", background: importResult.errors.length ? "#fef2f2" : "#f0fdf4", border: `1px solid ${importResult.errors.length ? "#fca5a5" : "#86efac"}`, borderRadius: 7, fontSize: 13 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, color: importResult.errors.length ? "#dc2626" : "#16a34a" }}>
                  {importResult.errors.length ? "Import completed with errors" : "Import successful"}
                </div>
                <div style={{ color: "var(--text)" }}>
                  {importResult.created} created · {importResult.skipped} skipped (already exist)
                </div>
              </div>
              {importResult.errors.length > 0 && (
                <div style={{ maxHeight: 140, overflowY: "auto", fontSize: 12, color: "#dc2626", display: "flex", flexDirection: "column", gap: 3 }}>
                  {importResult.errors.map((e, i) => <div key={i}>• {e}</div>)}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button onClick={() => { setShowImportModal(false); setImportRows(null); setImportResult(null); }} style={btnPrimary}>Done</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// ─── NodeRow ─────────────────────────────────────────────────────────────────

function NodeRow({
  mode,
  id,
  name,
  active,
  subtitle,
  childCount,
  collapsed,
  onToggle,
  onEdit,
  onDelete,
  addChildLabel,
  onAddChild,
}: {
  mode: ModalMode;
  id: string;
  name: string;
  active: boolean;
  subtitle?: string;
  childCount?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  addChildLabel?: string;
  onAddChild?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const c = LEVEL_COLORS[mode];
  const hasChildren = typeof childCount === "number";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 6px",
        borderRadius: 6,
        background: hover ? "var(--surface-soft)" : "transparent",
        transition: "background 0.12s",
        marginBottom: 2,
      }}
    >
      {/* Collapse toggle */}
      <button
        onClick={hasChildren && onToggle ? onToggle : undefined}
        style={{
          background: "none",
          border: "none",
          cursor: hasChildren && onToggle ? "pointer" : "default",
          padding: 0,
          display: "flex",
          width: 16,
          flexShrink: 0,
          color: "var(--muted)",
        }}
      >
        {hasChildren && onToggle ? (
          collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />
        ) : (
          <span style={{ width: 14, display: "inline-block" }} />
        )}
      </button>

      {/* Colored dot */}
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: active ? c.dot : "#94a3b8",
          flexShrink: 0,
        }}
      />

      {/* Name + subtitle */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: active ? "var(--text)" : "var(--muted)" }}>{name}</span>
        {!active && <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 6 }}>(inactive)</span>}
        {subtitle && <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8 }}>{subtitle}</span>}
        {hasChildren && (
          <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8 }}>
            {childCount} {childCount === 1 ? LEVEL_LABELS[nextLevel(mode)] : LEVEL_LABELS[nextLevel(mode)] + "s"}
          </span>
        )}
      </div>

      {/* Actions (visible on hover) */}
      {(hover || true) && (
        <div style={{ display: "flex", gap: 4, alignItems: "center", opacity: hover ? 1 : 0, transition: "opacity 0.1s", pointerEvents: hover ? "auto" : "none" }}>
          {addChildLabel && onAddChild && (
            <button onClick={onAddChild} title={addChildLabel} style={iconBtn("#22c55e")}>
              <Plus size={12} />
            </button>
          )}
          <button onClick={onEdit} title="Edit" style={iconBtn("#3b82f6")}>
            <Edit3 size={12} />
          </button>
          <button onClick={onDelete} title="Delete" style={iconBtn("#ef4444")}>
            <Trash2 size={12} />
          </button>
        </div>
      )}

      {/* Level badge */}
      <Badge mode={mode} />
    </div>
  );
}

function nextLevel(mode: ModalMode): ModalMode {
  if (mode === "division") return "department";
  if (mode === "department") return "section";
  return "team";
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--surface)", borderRadius: 12, padding: 24, width: 400, maxWidth: "95vw", boxShadow: "0 16px 48px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>{title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 4 }}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const btnPrimary: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  padding: "6px 14px",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const btnSecondary: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  padding: "6px 12px",
  background: "var(--surface-soft)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
};

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  fontSize: 13,
  fontWeight: 500,
  color: "var(--text)",
};

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-soft)",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

function iconBtn(color: string): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: `${color}18`,
    border: `1px solid ${color}44`,
    borderRadius: 4,
    cursor: "pointer",
    color,
    padding: 0,
  };
}
