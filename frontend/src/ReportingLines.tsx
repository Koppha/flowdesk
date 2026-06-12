import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { confirmAction } from "./alerts";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronRight,
  Download,
  Edit3,
  GitBranch,
  History,
  Maximize2,
  MoreVertical,
  Network,
  RefreshCw,
  Search,
  Shuffle,
  Upload,
  UserCheck,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type Stats = { total_employees: number; managers: number; hods: number; exco_members: number };

type Department = {
  id: string;
  name: string;
  section_id: string | null;
  section_name: string | null;
  division_id: string | null;
  division_name: string | null;
  hod_user_id: string | null;
  hod_name: string | null;
  manager_user_id: string | null;
  manager_name: string | null;
  exco_user_id: string | null;
  exco_name: string | null;
  active: boolean;
};

type ReportingRow = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  title: string | null;
  department: string | null;
  employment_type: string | null;
  role: string;
  profile_completed: boolean;
  is_active: boolean;
  reporting_line_id: string | null;
  manager_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
  manager_title: string | null;
  manager_role: string | null;
  effective_from: string | null;
  effective_to: string | null;
  reason: string | null;
};

type OrgSection = {
  id: string;
  name: string;
  department_id: string | null;
  active: boolean;
};

type OrgTeam = {
  id: string;
  name: string;
  section_id: string | null;
  active: boolean;
};

type HierarchyUser = {
  id: string;
  full_name: string | null;
  email: string;
  title: string | null;
  role: string;
  is_active: boolean;
  manager_id: string | null;
};

type TreeNode = HierarchyUser & { children: TreeNode[] };

type HistoryRow = {
  id: string;
  effective_from: string | null;
  effective_to: string | null;
  reason: string | null;
  is_active: boolean;
  manager_name: string | null;
  manager_title: string | null;
  created_by_name: string | null;
  created_at: string;
};

type EditForm = {
  manager_id: string;
  effective_from: string;
  effective_to: string;
  reason: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function initials(name: string | null | undefined) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("") || "?";
}

function avatarColor(name: string | null | undefined) {
  const colors = [
    "linear-gradient(135deg,#1e40af,#3b82f6)",
    "linear-gradient(135deg,#065f46,#10b981)",
    "linear-gradient(135deg,#7c3aed,#a78bfa)",
    "linear-gradient(135deg,#9d174d,#ec4899)",
    "linear-gradient(135deg,#92400e,#f59e0b)",
    "linear-gradient(135deg,#1e3a5f,#0ea5e9)",
  ];
  const idx = (name || "?").charCodeAt(0) % colors.length;
  return colors[idx];
}

function roleLabel(role: string) {
  const map: Record<string, string> = {
    EMPLOYEE: "Employee",
    HOD: "Head of Department",
    MANAGER: "Manager",
    HR_MANAGER: "HR Manager",
    FINANCE: "Finance",
    EXCO: "EXCO Member",
    CEO: "Chief Executive Officer",
    ADMIN: "Administrator",
  };
  return map[role] || role;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Build a tree from flat user list
function buildTree(users: HierarchyUser[], _deptName: string): TreeNode[] {
  const deptUsers = users.filter(
    (u) => u.role !== "ADMIN"
  );

  const byId = new Map(deptUsers.map((u) => [u.id, { ...u, children: [] as TreeNode[] }]));

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    if (!node.manager_id || !byId.has(node.manager_id)) {
      roots.push(node as TreeNode);
    } else {
      const parent = byId.get(node.manager_id)!;
      parent.children.push(node as TreeNode);
    }
  }
  return roots;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Avatar({ name, size = 36 }: { name: string | null; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: avatarColor(name),
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: size * 0.38,
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {initials(name)}
    </span>
  );
}

function HierarchyNodeBox({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div
        className="rl-hier-box"
        onClick={() => node.children.length > 0 && setCollapsed((c) => !c)}
        style={{ cursor: node.children.length > 0 ? "pointer" : "default" }}
      >
        <Avatar name={node.full_name} size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rl-hier-box-name">{node.full_name || node.email}</div>
          <div className="rl-hier-box-title">{node.title || roleLabel(node.role)}</div>
        </div>
        {node.children.length > 0 && (
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>
        )}
      </div>
      {!collapsed && node.children.length > 0 && (
        <div className="rl-hier-children">
          {node.children.map((child) => (
            <HierarchyNodeBox key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function HierarchyChain({ users }: { users: HierarchyUser[] }) {
  if (!users.length) return null;
  return (
    <div className="rl-hier-chain">
      {users.map((u, i) => (
        <React.Fragment key={u.id}>
          <div className="rl-hier-chain-node">
            <Avatar name={u.full_name} size={36} />
            <div>
              <div className="rl-hier-chain-name">{u.full_name || u.email}</div>
              <div className="rl-hier-chain-title">{u.title || roleLabel(u.role)}</div>
            </div>
          </div>
          {i < users.length - 1 && (
            <ArrowRight size={18} style={{ color: "var(--muted)", flexShrink: 0 }} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ReportingLines() {
  const [stats, setStats] = useState<Stats>({ total_employees: 0, managers: 0, hods: 0, exco_members: 0 });
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [employees, setEmployees] = useState<ReportingRow[]>([]);
  const [allUsers, setAllUsers] = useState<ReportingRow[]>([]);
  const [treeSearch, setTreeSearch] = useState("");
  const [divisionFilter, setDivisionFilter] = useState("ALL");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [orgSections, setOrgSections] = useState<OrgSection[]>([]);
  const [orgTeams, setOrgTeams] = useState<OrgTeam[]>([]);
  const [tableSearch, setTableSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ generated: number; warnings: string[] } | null>(null);
  const [editRow, setEditRow] = useState<ReportingRow | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ manager_id: "", effective_from: today(), effective_to: "", reason: "" });
  const [historyRow, setHistoryRow] = useState<ReportingRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hierarchyData, setHierarchyData] = useState<{ users: HierarchyUser[]; leadership: any } | null>(null);
  const [zoom, setZoom] = useState(100);
  const [showTopMore, setShowTopMore] = useState(false);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const topMoreRef = useRef<HTMLDivElement>(null);

  // ─── Data Loading ───────────────────────────────────────────────────────────

  const loadStats = useCallback(async () => {
    try {
      const s = await api.reportingLineStats();
      setStats(s);
    } catch { /* ignore */ }
  }, []);

  const loadDepartments = useCallback(async () => {
    try {
      const data = await api.departmentsWithSections();
      setDepartments(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  const loadAllUsers = useCallback(async () => {
    try {
      const data = await api.reportingLines();
      setAllUsers(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  const loadEmployees = useCallback(async (dept: string | null, sectionId?: string | null, teamId?: string | null) => {
    setLoading(true);
    try {
      const data = await api.reportingLines(dept ?? undefined, undefined, sectionId ?? undefined, teamId ?? undefined);
      setEmployees(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  const loadHierarchy = useCallback(async (dept: string) => {
    try {
      const data = await api.reportingLineHierarchy(dept);
      setHierarchyData(data);
    } catch { setHierarchyData(null); }
  }, []);

  useEffect(() => {
    void loadStats();
    void loadDepartments();
    void loadAllUsers();
    void loadEmployees(null, null, null);
    api.orgStructure().then((d: any) => {
      setOrgSections(Array.isArray(d?.sections) ? d.sections : []);
      setOrgTeams(Array.isArray(d?.teams) ? d.teams : []);
    }).catch(() => {});
  }, [loadStats, loadDepartments, loadAllUsers, loadEmployees]);

  // Dismiss menus on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      setRowMenuId(null);
      if (topMoreRef.current && !topMoreRef.current.contains(e.target as Node)) {
        setShowTopMore(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  // ─── Tree ───────────────────────────────────────────────────────────────────

  // Group departments by Division for the tree
  const divisionMap = useMemo(() => {
    const map = new Map<string, Department[]>();
    const source = divisionFilter === "ALL"
      ? departments
      : departments.filter(d => (d.division_name ?? "__none__") === divisionFilter);
    for (const dept of source) {
      const key = dept.division_name ?? "__none__";
      const arr = map.get(key) ?? [];
      arr.push(dept);
      map.set(key, arr);
    }
    return map;
  }, [departments, divisionFilter]);

  const filteredDivisionMap = useMemo(() => {
    if (!treeSearch.trim()) return divisionMap;
    const q = treeSearch.toLowerCase();
    const filtered = new Map<string, Department[]>();
    for (const [div, depts] of divisionMap) {
      const matched = depts.filter((d) =>
        d.name.toLowerCase().includes(q) ||
        (d.division_name ?? "").toLowerCase().includes(q)
      );
      if (matched.length > 0) filtered.set(div, matched);
    }
    return filtered;
  }, [divisionMap, treeSearch]);

  // Unique division names for the filter dropdown
  const divisionNames = useMemo(() => {
    return Array.from(
      new Set(departments.map(d => d.division_name).filter(Boolean))
    ).sort() as string[];
  }, [departments]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function handleSelectDept(deptName: string) {
    setSelectedDept(deptName);
    setSelectedSectionId(null);
    setSelectedTeamId(null);
    setSelectedLabel(deptName);
    void loadEmployees(deptName, null, null);
    void loadHierarchy(deptName);
  }

  function handleSelectSection(deptName: string, sectionId: string, sectionName: string) {
    setSelectedDept(deptName);
    setSelectedSectionId(sectionId);
    setSelectedTeamId(null);
    setSelectedLabel(sectionName);
    void loadEmployees(deptName, sectionId, null);
    void loadHierarchy(deptName);
  }

  function handleSelectTeam(deptName: string, sectionId: string, teamId: string, teamName: string) {
    setSelectedDept(deptName);
    setSelectedSectionId(sectionId);
    setSelectedTeamId(teamId);
    setSelectedLabel(teamName);
    void loadEmployees(deptName, null, teamId);
    void loadHierarchy(deptName);
  }

  // ─── Table Filtering ────────────────────────────────────────────────────────

  const filteredEmployees = useMemo(() => {
    let rows = employees;
    if (tableSearch.trim()) {
      const q = tableSearch.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.full_name || "").toLowerCase().includes(q) ||
          r.email.toLowerCase().includes(q) ||
          (r.employee_no || "").toLowerCase().includes(q) ||
          (r.title || "").toLowerCase().includes(q)
      );
    }
    if (roleFilter) rows = rows.filter((r) => r.role === roleFilter);
    if (statusFilter === "active") rows = rows.filter((r) => r.is_active);
    if (statusFilter === "inactive") rows = rows.filter((r) => !r.is_active);
    if (statusFilter === "unassigned") rows = rows.filter((r) => !r.manager_id);
    return rows;
  }, [employees, tableSearch, roleFilter, statusFilter]);

  // ─── Edit Modal ─────────────────────────────────────────────────────────────

  function openEdit(row: ReportingRow) {
    setEditRow(row);
    setEditForm({
      manager_id: row.manager_id ?? "",
      effective_from: row.effective_from ?? today(),
      effective_to: row.effective_to ?? "",
      reason: row.reason ?? "",
    });
  }

  function closeEdit() {
    setEditRow(null);
  }

  async function handleSave() {
    if (!editRow) return;
    setSaving(true);
    try {
      await api.upsertReportingLine({
        employee_id: editRow.id,
        manager_id: editForm.manager_id || null,
        effective_from: editForm.effective_from || today(),
        effective_to: editForm.effective_to || null,
        reason: editForm.reason || null,
      });
      closeEdit();
      await Promise.all([
        loadEmployees(selectedDept, selectedSectionId, selectedTeamId),
        loadAllUsers(),
        loadStats(),
        selectedDept ? loadHierarchy(selectedDept) : Promise.resolve(),
      ]);
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  // ─── History Modal ──────────────────────────────────────────────────────────

  async function openHistory(row: ReportingRow) {
    setHistoryRow(row);
    setHistoryLoading(true);
    setHistory([]);
    try {
      const data = await api.reportingLineHistory(row.id);
      setHistory(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
    finally { setHistoryLoading(false); }
  }

  // ─── Auto Generate ──────────────────────────────────────────────────────────

  async function handleAutoGenerate() {
    const confirmed = await confirmAction({
      title: "Auto-generate reporting lines?",
      text: "This will replace existing active reporting lines based on leadership assignments.",
      confirmButtonText: "Generate"
    });
    if (!confirmed) return;
    setGenerating(true);
    setGenResult(null);
    try {
      const result = await api.autoGenerateReportingLines();
      setGenResult(result);
      await Promise.all([
        loadEmployees(selectedDept, selectedSectionId, selectedTeamId),
        loadAllUsers(),
        loadStats(),
        selectedDept ? loadHierarchy(selectedDept) : Promise.resolve(),
      ]);
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setGenerating(false);
    }
  }

  // ─── Hierarchy Preview (modal) ──────────────────────────────────────────────

  const previewChain = useMemo<HierarchyUser[]>(() => {
    if (!editRow || !editForm.manager_id) return [];
    const chain: HierarchyUser[] = [];
    const byId = new Map(allUsers.map((u) => [u.id, u]));

    let current: ReportingRow | undefined = byId.get(editForm.manager_id);
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      chain.unshift({
        id: current.id,
        full_name: current.full_name,
        email: current.email,
        title: current.title,
        role: current.role,
        is_active: current.is_active,
        manager_id: current.manager_id,
      });
      current = current.manager_id ? byId.get(current.manager_id) : undefined;
    }
    chain.push({
      id: editRow.id,
      full_name: editRow.full_name,
      email: editRow.email,
      title: editRow.title,
      role: editRow.role,
      is_active: editRow.is_active,
      manager_id: editForm.manager_id,
    });
    return chain;
  }, [editRow, editForm.manager_id, allUsers]);

  // ─── Hierarchy chart data ───────────────────────────────────────────────────

  const treeRoots = useMemo(() => {
    if (!hierarchyData) return [];
    let users = hierarchyData.users;
    if (selectedTeamId || selectedSectionId) {
      const visibleIds = new Set(employees.map(e => e.id));
      const managerIds = new Set(employees.map(e => e.manager_id).filter(Boolean) as string[]);
      users = users.filter(u => visibleIds.has(u.id) || managerIds.has(u.id));
    }
    return buildTree(users, selectedDept || "");
  }, [hierarchyData, selectedDept, selectedTeamId, selectedSectionId, employees]);

  // ─── Unique roles for filter ────────────────────────────────────────────────

  const uniqueRoles = useMemo(() => {
    const roles = [...new Set(employees.map((e) => e.role))].sort();
    return roles;
  }, [employees]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="rl-page">
      {/* ── Breadcrumb ── */}
      <div className="rl-breadcrumb">
        <span>Administration</span>
        <ChevronRight size={14} />
        <span>Organizational Structure</span>
        <ChevronRight size={14} />
        <span className="rl-breadcrumb-active">Reporting Lines</span>
      </div>

      {/* ── Page Header ── */}
      <div className="rl-header">
        <div>
          <h1 className="rl-title">Reporting Lines</h1>
          <p className="rl-subtitle">Manage employee reporting relationships and organizational hierarchy.</p>
        </div>
        <div className="rl-header-actions">
          <button className="rl-btn-outline">
            <Upload size={15} /> Import
          </button>
          <button className="rl-btn-outline">
            <Download size={15} /> Export
          </button>
          <button
            className="rl-btn-primary"
            onClick={handleAutoGenerate}
            disabled={generating}
          >
            <Shuffle size={15} />
            {generating ? "Generating…" : "Auto Generate Lines"}
          </button>
        </div>
      </div>

      {/* ── Gen Result Banner ── */}
      {genResult && (
        <div className={`rl-banner ${genResult.warnings.length > 0 ? "rl-banner-warn" : "rl-banner-ok"}`}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {genResult.warnings.length > 0 ? <AlertTriangle size={16} /> : null}
            <strong>{genResult.generated} reporting lines generated.</strong>
            {genResult.warnings.length > 0 && <span>{genResult.warnings.length} warning(s).</span>}
          </div>
          {genResult.warnings.length > 0 && (
            <ul className="rl-banner-list">
              {genResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <button className="rl-banner-close" onClick={() => setGenResult(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── KPI Cards ── */}
      <div className="ep-kpi-row">
        <div className="ep-kpi ep-kpi-blue">
          <div className="ep-kpi-icon"><Users size={26} /></div>
          <div><div className="ep-kpi-value">{stats.total_employees}</div><div className="ep-kpi-label">Total Employees</div></div>
        </div>
        <div className="ep-kpi ep-kpi-green">
          <div className="ep-kpi-icon"><UserCheck size={26} /></div>
          <div><div className="ep-kpi-value">{stats.managers}</div><div className="ep-kpi-label">Managers</div></div>
        </div>
        <div className="ep-kpi ep-kpi-gold">
          <div className="ep-kpi-icon"><Building2 size={26} /></div>
          <div><div className="ep-kpi-value">{stats.hods}</div><div className="ep-kpi-label">HODs</div></div>
        </div>
        <div className="ep-kpi ep-kpi-purple">
          <div className="ep-kpi-icon"><Network size={26} /></div>
          <div>
            <div className="ep-kpi-value">{stats.exco_members}</div>
            <div className="ep-kpi-label">EXCO Members</div>
          </div>
        </div>
      </div>

      {/* ── Main 2-column grid ── */}
      <div className="rl-main-grid">
        {/* ── LEFT: Org Tree ── */}
        <div className="rl-tree-panel">
          <div className="rl-panel-head">
            <span className="rl-panel-title">Organization Structure</span>
          </div>
          <div className="rl-tree-search">
            <Search size={14} className="rl-tree-search-icon" />
            <input
              type="text"
              placeholder="Search departments…"
              value={treeSearch}
              onChange={(e) => setTreeSearch(e.target.value)}
              className="rl-tree-search-input"
            />
          </div>

          {/* Division filter */}
          {divisionNames.length > 0 && (
            <div style={{ padding: "4px 10px 2px" }}>
              <select
                value={divisionFilter}
                onChange={(e) => setDivisionFilter(e.target.value)}
                style={{ width: "100%", fontSize: 12, padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", color: "var(--text)" }}
              >
                <option value="ALL">All Divisions</option>
                {divisionNames.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}

          <div className="rl-tree">
            {/* Root node */}
            <div className="rl-tree-root">
              <Network size={14} style={{ flexShrink: 0 }} />
              <span>Company</span>
            </div>

            {[...filteredDivisionMap.entries()].map(([divKey, depts]) => {
              const divOpen = treeSearch.trim() ? true : expanded.has(`div-${divKey}`);
              const label = divKey === "__none__" ? "Unassigned Division" : divKey;
              return (
                <div key={divKey} className="rl-tree-section">
                  <button
                    className="rl-tree-section-btn"
                    onClick={() => toggleExpanded(`div-${divKey}`)}
                  >
                    {divOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <Building2 size={13} />
                    <span>{label}</span>
                    <span className="rl-tree-count">{depts.length}</span>
                  </button>
                  {divOpen && (
                    <div className="rl-tree-dept-list">
                      {depts.map((dept) => {
                        const deptSections = orgSections.filter(s => s.department_id === dept.id);
                        const deptOpen = treeSearch.trim() ? true : expanded.has(`dept-${dept.id}`);
                        const hasSections = deptSections.length > 0;
                        return (
                          <div key={dept.id}>
                            <div style={{ display: "flex", alignItems: "center" }}>
                              {hasSections ? (
                                <button
                                  style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: "var(--muted)", display: "flex", alignItems: "center" }}
                                  onClick={() => toggleExpanded(`dept-${dept.id}`)}
                                >
                                  {deptOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                </button>
                              ) : (
                                <span style={{ width: 15, flexShrink: 0 }} />
                              )}
                              <button
                                className={`rl-tree-dept-btn ${selectedDept === dept.name && !selectedSectionId && !selectedTeamId ? "selected" : ""}`}
                                style={{ flex: 1 }}
                                onClick={() => handleSelectDept(dept.name)}
                              >
                                <span className="rl-tree-dept-dot" />
                                <span style={{ flex: 1, textAlign: "left" }}>{dept.name}</span>
                              </button>
                            </div>
                            {hasSections && deptOpen && (
                              <div style={{ paddingLeft: 20 }}>
                                {deptSections.map((sec) => {
                                  const secTeams = orgTeams.filter(t => t.section_id === sec.id);
                                  const secOpen = treeSearch.trim() ? true : expanded.has(`sec-${sec.id}`);
                                  return (
                                    <div key={sec.id}>
                                      <div style={{ display: "flex", alignItems: "center" }}>
                                        {secTeams.length > 0 ? (
                                          <button
                                            style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: "var(--muted)", display: "flex", alignItems: "center" }}
                                            onClick={() => toggleExpanded(`sec-${sec.id}`)}
                                          >
                                            {secOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                          </button>
                                        ) : (
                                          <span style={{ width: 15, flexShrink: 0 }} />
                                        )}
                                        <button
                                          className={`rl-tree-dept-btn ${selectedSectionId === sec.id && !selectedTeamId ? "selected" : ""}`}
                                          style={{ flex: 1, opacity: 0.9 }}
                                          onClick={() => handleSelectSection(dept.name, sec.id, sec.name)}
                                        >
                                          <span className="rl-tree-dept-dot" style={{ background: "#f59e0b" }} />
                                          <span style={{ flex: 1, textAlign: "left", fontSize: 11 }}>{sec.name}</span>
                                        </button>
                                      </div>
                                      {secTeams.length > 0 && secOpen && (
                                        <div style={{ paddingLeft: 20 }}>
                                          {secTeams.map((team) => (
                                            <button
                                              key={team.id}
                                              className={`rl-tree-dept-btn ${selectedTeamId === team.id ? "selected" : ""}`}
                                              style={{ width: "100%", opacity: 0.85 }}
                                              onClick={() => handleSelectTeam(dept.name, sec.id, team.id, team.name)}
                                            >
                                              <span className="rl-tree-dept-dot" style={{ background: "#a855f7" }} />
                                              <span style={{ flex: 1, textAlign: "left", fontSize: 11 }}>{team.name}</span>
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── RIGHT: Employee Table ── */}
        <div className="rl-right-panel">
          <div className="rl-right-head">
            <div className="rl-right-head-left">
              <span className="rl-panel-title">
                {selectedLabel || "All Departments"}
              </span>
              {selectedLabel && selectedLabel !== selectedDept && (
                <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 4 }}>{selectedDept}</span>
              )}
              <span className="rl-emp-count">{filteredEmployees.length} employees</span>
            </div>
            <div className="rl-right-head-actions">
              {/* Search */}
              <div className="rl-table-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="Search employees…"
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                />
              </div>
              {/* Position filter */}
              <select
                className="rl-filter-select"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
              >
                <option value="">All Positions</option>
                {uniqueRoles.map((r) => (
                  <option key={r} value={r}>{roleLabel(r)}</option>
                ))}
              </select>
              {/* Status filter */}
              <select
                className="rl-filter-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="unassigned">No Manager</option>
              </select>
              {/* Assign Manager */}
              <button className="rl-btn-primary" style={{ whiteSpace: "nowrap" }}>
                <UserCheck size={14} /> Assign Manager
              </button>
              {/* More Actions */}
              <div className="rl-more-wrap" ref={topMoreRef}>
                <button
                  className="rl-btn-outline"
                  onClick={() => setShowTopMore((v) => !v)}
                >
                  More Actions <ChevronDown size={13} />
                </button>
                {showTopMore && (
                  <div className="rl-dropdown">
                    <button className="rl-dropdown-item"><Users size={13} />Bulk Assign</button>
                    <button className="rl-dropdown-item"><X size={13} />Clear Assignments</button>
                    <button className="rl-dropdown-item"><History size={13} />View History</button>
                    <button className="rl-dropdown-item"><Download size={13} />Export Selected</button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="rl-table-wrap">
            {loading ? (
              <div className="rl-loading">
                <RefreshCw size={20} className="rl-spin" />
                <span>Loading employees…</span>
              </div>
            ) : filteredEmployees.length === 0 ? (
              <div className="rl-empty">
                <GitBranch size={32} style={{ opacity: 0.3 }} />
                <p>{selectedDept ? "No employees found in this department." : "Select a department from the tree or search to view employees."}</p>
              </div>
            ) : (
              <table className="rl-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Position</th>
                    <th>Reports To</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEmployees.map((row) => (
                    <tr key={row.id}>
                      {/* Employee */}
                      <td>
                        <div className="rl-emp-cell">
                          <Avatar name={row.full_name} size={36} />
                          <div>
                            <div className="rl-emp-name">{row.full_name || row.email}</div>
                            <div className="rl-emp-sub">{row.title || roleLabel(row.role)}</div>
                          </div>
                        </div>
                      </td>
                      {/* Position */}
                      <td>
                        <span className="rl-role-pill">{roleLabel(row.role)}</span>
                      </td>
                      {/* Reports To */}
                      <td>
                        {row.manager_id ? (
                          <div className="rl-emp-cell">
                            <Avatar name={row.manager_name} size={28} />
                            <div>
                              <div className="rl-emp-name" style={{ fontSize: "0.85rem" }}>{row.manager_name || row.manager_email}</div>
                              <div className="rl-emp-sub">{row.manager_title || (row.manager_role ? roleLabel(row.manager_role) : "")}</div>
                            </div>
                          </div>
                        ) : (
                          <span className="rl-unassigned">— Not assigned</span>
                        )}
                      </td>
                      {/* Department */}
                      <td>
                        <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{row.department || "—"}</span>
                      </td>
                      {/* Status */}
                      <td>
                        <span className={`status-pill ${row.is_active ? "status-pill-success" : "status-pill-danger"}`}>
                          {row.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      {/* Actions */}
                      <td>
                        <div className="rl-row-actions">
                          <button
                            className="rl-icon-btn"
                            title="Edit reporting line"
                            onClick={() => openEdit(row)}
                          >
                            <Edit3 size={14} />
                          </button>
                          <button
                            className="rl-icon-btn"
                            title="View history"
                            onClick={() => void openHistory(row)}
                          >
                            <RefreshCw size={14} />
                          </button>
                          <div style={{ position: "relative" }}>
                            <button
                              className="rl-icon-btn"
                              title="More actions"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRowMenuId((id) => (id === row.id ? null : row.id));
                              }}
                            >
                              <MoreVertical size={14} />
                            </button>
                            {rowMenuId === row.id && (
                              <div className="rl-dropdown rl-dropdown-right">
                                <button className="rl-dropdown-item" onClick={() => openEdit(row)}>
                                  <Edit3 size={13} />Edit Reporting Line
                                </button>
                                <button className="rl-dropdown-item" onClick={() => void openHistory(row)}>
                                  <History size={13} />View History
                                </button>
                                <button className="rl-dropdown-item rl-dropdown-danger">
                                  <X size={13} />Clear Assignment
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* ── Hierarchy Chart ── */}
      {selectedDept && (
        <div className="rl-chart-panel">
          <div className="rl-chart-head">
            <div>
              <span className="rl-panel-title">Reporting Hierarchy</span>
              <span style={{ fontSize: "0.8rem", color: "var(--muted)", marginLeft: 8 }}>{selectedLabel || selectedDept}</span>
            </div>
            <div className="rl-chart-controls">
              <select className="rl-filter-select" style={{ width: "auto" }}>
                <option>Layout</option>
                <option>Top-Down</option>
                <option>Left-Right</option>
              </select>
              <button className="rl-icon-btn" onClick={() => setZoom((z) => Math.min(z + 20, 200))} title="Zoom in">
                <ZoomIn size={14} />
              </button>
              <span className="rl-zoom-label">{zoom}%</span>
              <button className="rl-icon-btn" onClick={() => setZoom((z) => Math.max(z - 20, 40))} title="Zoom out">
                <ZoomOut size={14} />
              </button>
              <button className="rl-icon-btn" onClick={() => setZoom(100)} title="Reset zoom">
                <Maximize2 size={14} />
              </button>
            </div>
          </div>

          <div className="rl-chart-body">
            {/* Chain preview based on leadership */}
            {hierarchyData && (
              <>
                {/* Linear chain for simple view */}
                {(() => {
                  const ld = hierarchyData.leadership;
                  const users = hierarchyData.users;
                  const byId = new Map(users.map((u: HierarchyUser) => [u.id, u]));
                  const chain: HierarchyUser[] = [];
                  if (ld.exco_user_id) {
                    const u = byId.get(ld.exco_user_id);
                    if (u) chain.push(u);
                  }
                  if (ld.hod_user_id) {
                    const u = byId.get(ld.hod_user_id);
                    if (u) chain.push(u);
                  }
                  if (ld.manager_user_id) {
                    const u = byId.get(ld.manager_user_id);
                    if (u) chain.push(u);
                  }
                  return chain.length > 0 ? (
                    <div className="rl-chain-wrap" style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top left" }}>
                      <HierarchyChain users={chain} />
                    </div>
                  ) : null;
                })()}

                {/* Full tree */}
                {treeRoots.length > 0 && (
                  <div className="rl-tree-chart-wrap" style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top left" }}>
                    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start", paddingTop: 16 }}>
                      {treeRoots.map((root) => (
                        <HierarchyNodeBox key={root.id} node={root} />
                      ))}
                    </div>
                  </div>
                )}

                {treeRoots.length === 0 && (
                  <div className="rl-empty" style={{ padding: "40px 0" }}>
                    <GitBranch size={28} style={{ opacity: 0.25 }} />
                    <p>No reporting lines configured for {selectedTeamId ? "this team" : selectedSectionId ? "this section" : "this department"} yet.<br />Use <strong>Auto Generate Lines</strong> or assign managers manually.</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Edit Modal ── */}
      {editRow && (
        <div className="rl-modal-overlay" onClick={closeEdit}>
          <div className="rl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rl-modal-head">
              <div>
                <h2 className="rl-modal-title">Edit Reporting Line</h2>
                <p className="rl-modal-sub">Update the reporting relationship for the selected employee.</p>
              </div>
              <button className="rl-icon-btn" onClick={closeEdit}><X size={18} /></button>
            </div>

            <div className="rl-modal-body">
              <div className="rl-modal-cols">
                {/* LEFT: Employee Info */}
                <div className="rl-modal-col">
                  <div className="rl-modal-section-title">Employee Information</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                    <Avatar name={editRow.full_name} size={44} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "1rem" }}>{editRow.full_name || editRow.email}</div>
                      <div style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{editRow.title || roleLabel(editRow.role)}</div>
                      <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{editRow.department}</div>
                    </div>
                  </div>
                  <div className="rl-info-grid">
                    <div className="rl-info-row">
                      <span>Employee ID</span>
                      <strong>{editRow.employee_no || "—"}</strong>
                    </div>
                    <div className="rl-info-row">
                      <span>Email</span>
                      <strong>{editRow.email}</strong>
                    </div>
                    <div className="rl-info-row">
                      <span>Employment Type</span>
                      <strong>{editRow.employment_type || "Permanent"}</strong>
                    </div>
                    <div className="rl-info-row">
                      <span>Role</span>
                      <strong>{roleLabel(editRow.role)}</strong>
                    </div>
                  </div>
                </div>

                {/* RIGHT: Reporting Manager + Settings */}
                <div className="rl-modal-col">
                  <div className="rl-modal-section-title">Reporting Manager</div>
                  <div className="rl-form-group">
                    <label>Reports To <span style={{ color: "var(--danger)" }}>*</span></label>
                    <select
                      className="rl-form-select"
                      value={editForm.manager_id}
                      onChange={(e) => setEditForm((f) => ({ ...f, manager_id: e.target.value }))}
                    >
                      <option value="">— Select manager —</option>
                      {(() => {
                        const LEADERSHIP_ROLES = ["CEO", "EXCO", "HOD", "MANAGER", "HR_MANAGER"];
                        const rolePriority: Record<string, number> = { CEO: 0, EXCO: 1, HOD: 2, MANAGER: 3, HR_MANAGER: 4 };
                        const sameTeamIds = new Set(employees.map(e => e.id));
                        const leadership = allUsers
                          .filter(u => u.id !== editRow.id && u.is_active && LEADERSHIP_ROLES.includes(u.role))
                          .sort((a, b) =>
                            (rolePriority[a.role] ?? 9) - (rolePriority[b.role] ?? 9) ||
                            (a.full_name || a.email).localeCompare(b.full_name || b.email)
                          );
                        const teamMembers = allUsers
                          .filter(u => u.id !== editRow.id && u.is_active && !LEADERSHIP_ROLES.includes(u.role) && sameTeamIds.has(u.id))
                          .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
                        return (
                          <>
                            {leadership.length > 0 && (
                              <optgroup label="Leadership">
                                {leadership.map(u => (
                                  <option key={u.id} value={u.id}>
                                    {u.full_name || u.email} ({roleLabel(u.role)})
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {teamMembers.length > 0 && (
                              <optgroup label={`${selectedLabel || editRow.department || "Team"} Members`}>
                                {teamMembers.map(u => (
                                  <option key={u.id} value={u.id}>
                                    {u.full_name || u.email} ({u.title || roleLabel(u.role)})
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </>
                        );
                      })()}
                    </select>
                  </div>

                  {editForm.manager_id && (() => {
                    const mgr = allUsers.find((u) => u.id === editForm.manager_id);
                    return mgr ? (
                      <div className="rl-manager-preview">
                        <div className="rl-info-row">
                          <span>Position</span>
                          <strong>{mgr.title || roleLabel(mgr.role)}</strong>
                        </div>
                        <div className="rl-info-row">
                          <span>Department</span>
                          <strong>{mgr.department || "—"}</strong>
                        </div>
                      </div>
                    ) : null;
                  })()}

                  <div className="rl-modal-section-title" style={{ marginTop: 20 }}>Additional Settings</div>
                  <div className="rl-form-row">
                    <div className="rl-form-group">
                      <label>Effective From <span style={{ color: "var(--danger)" }}>*</span></label>
                      <input
                        type="date"
                        className="rl-form-input"
                        value={editForm.effective_from}
                        onChange={(e) => setEditForm((f) => ({ ...f, effective_from: e.target.value }))}
                      />
                    </div>
                    <div className="rl-form-group">
                      <label>Effective To <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>(Optional)</span></label>
                      <input
                        type="date"
                        className="rl-form-input"
                        value={editForm.effective_to}
                        onChange={(e) => setEditForm((f) => ({ ...f, effective_to: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="rl-form-group">
                    <label>Reason for Change <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>(Optional)</span></label>
                    <textarea
                      className="rl-form-textarea"
                      rows={3}
                      maxLength={250}
                      placeholder="e.g. Change in reporting structure"
                      value={editForm.reason}
                      onChange={(e) => setEditForm((f) => ({ ...f, reason: e.target.value }))}
                    />
                    <div style={{ textAlign: "right", fontSize: "0.75rem", color: "var(--muted)" }}>
                      {editForm.reason.length} / 250
                    </div>
                  </div>
                </div>
              </div>

              {/* Hierarchy Preview */}
              {previewChain.length > 0 && (
                <div className="rl-preview-section">
                  <div className="rl-modal-section-title">Reporting Hierarchy Preview</div>
                  <p style={{ fontSize: "0.8rem", color: "var(--muted)", margin: "0 0 12px" }}>
                    This is how the reporting line will look after the update.
                  </p>
                  <HierarchyChain users={previewChain} />
                </div>
              )}
            </div>

            <div className="rl-modal-footer">
              <button className="rl-btn-outline" onClick={closeEdit} disabled={saving}>Cancel</button>
              <button className="rl-btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── History Modal ── */}
      {historyRow && (
        <div className="rl-modal-overlay" onClick={() => setHistoryRow(null)}>
          <div className="rl-modal rl-modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="rl-modal-head">
              <div>
                <h2 className="rl-modal-title">Reporting Line History</h2>
                <p className="rl-modal-sub">{historyRow.full_name || historyRow.email}</p>
              </div>
              <button className="rl-icon-btn" onClick={() => setHistoryRow(null)}><X size={18} /></button>
            </div>
            <div className="rl-modal-body">
              {historyLoading ? (
                <div className="rl-loading"><RefreshCw size={18} className="rl-spin" /><span>Loading…</span></div>
              ) : history.length === 0 ? (
                <div className="rl-empty"><History size={24} style={{ opacity: 0.3 }} /><p>No history found.</p></div>
              ) : (
                <div className="rl-history-list">
                  {history.map((h) => (
                    <div key={h.id} className={`rl-history-item ${h.is_active ? "rl-history-active" : ""}`}>
                      <div className="rl-history-row">
                        <span className="rl-history-manager">{h.manager_name || "— Cleared"}</span>
                        {h.is_active && <span className="status-pill status-pill-success" style={{ fontSize: "0.7rem" }}>Current</span>}
                      </div>
                      {h.manager_title && <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{h.manager_title}</div>}
                      <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 4 }}>
                        {h.effective_from ? `From: ${h.effective_from}` : ""}
                        {h.effective_to ? ` → ${h.effective_to}` : ""}
                        {h.reason ? <span style={{ marginLeft: 8 }}>· {h.reason}</span> : ""}
                      </div>
                      <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: 2 }}>
                        By {h.created_by_name || "system"} · {new Date(h.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
