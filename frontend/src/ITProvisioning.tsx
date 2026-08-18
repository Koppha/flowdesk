import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  Monitor, Laptop, Clock, Loader2, PackageCheck, CheckCircle2, Search,
  ArrowLeft, RefreshCw, Download, HardDrive, ClipboardList, BarChart3, ChevronDown, UserCheck
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ChecklistItem = { label: string; checked: boolean };
type SoftwareItem = { name: string; status: "INSTALLED" | "PENDING"; is_standard?: boolean };

type Task = {
  id: string;
  status: "AWAITING_PROVISIONING" | "IN_PROGRESS" | "PROVISIONED" | "READY_FOR_COLLECTION" | "COMPLETED";
  assigned_to_id: string | null;
  assigned_to_name: string | null;
  device_source: string | null;
  checklist: ChecklistItem[];
  software: SoftwareItem[];
  replacement_details: any;
  upgrade_details: any;
  handover: any;
  provisioned_by_name: string | null;
  provisioned_at: string | null;
  ready_for_collection_at: string | null;
  handed_over_at: string | null;
  completed_at: string | null;
  created_at: string;
  submission_id: string;
  submitted_at: string;
  approval_chain: Array<{ position_name: string; status: string; approver_name: string | null; acted_at: string | null }>;
  requester_id: string;
  requester_name: string | null;
  requester_email: string | null;
  requester_department: string | null;
  requester_employee_no: string | null;
  position: string | null;
  phone_no: string | null;
  computer_type: string | null;
  request_type: string | null;
  justification: string | null;
  device: {
    asset_number: string; serial_number: string | null; manufacturer: string | null; model: string | null;
    operating_system: string | null; hostname: string | null; network_details: string | null;
    warranty_expiry: string | null; computer_type: string | null;
  } | null;
};

const STATUS_LABEL: Record<string, string> = {
  AWAITING_PROVISIONING: "Awaiting Provisioning",
  IN_PROGRESS: "In Progress",
  PROVISIONED: "Provisioned",
  READY_FOR_COLLECTION: "Ready for Collection",
  COMPLETED: "Completed"
};

const STATUS_STYLE: Record<string, [string, string]> = {
  AWAITING_PROVISIONING: ["#f1f5f9", "#64748b"],
  IN_PROGRESS: ["#fef3c7", "#92400e"],
  PROVISIONED: ["#dbeafe", "#1d4ed8"],
  READY_FOR_COLLECTION: ["#d1fae5", "#065f46"],
  COMPLETED: ["#ede9fe", "#5b21b6"]
};

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{STATUS_LABEL[status] || status}</span>;
}

function fieldStyle(): React.CSSProperties {
  return { width: "100%", padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", fontSize: 13 };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>{label}</label>
      {children}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ITProvisioning({ initialStatus }: { initialStatus?: string } = {}) {
  const [view, setView] = useState<"dashboard" | "detail" | "assets" | "reports">("dashboard");
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState(initialStatus || "");
  const [computerTypeFilter, setComputerTypeFilter] = useState("");
  const [requestTypeFilter, setRequestTypeFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [search, setSearch] = useState("");

  const [staff, setStaff] = useState<Array<{ id: string; full_name: string | null }>>([]);
  const [defaultAssigneeIds, setDefaultAssigneeIds] = useState<string[]>([]);
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [savingDefaultAssignees, setSavingDefaultAssignees] = useState(false);

  useEffect(() => {
    api.adminUsers().then((rows: any[]) => setStaff(Array.isArray(rows) ? rows.filter((u) => u.is_active !== false) : [])).catch(() => {});
    api.itProvisioningDefaultAssignees().then((r: any) => setDefaultAssigneeIds((r?.assignees || []).map((a: any) => a.id))).catch(() => {});
  }, []);

  async function saveDefaultAssignees(ids: string[]) {
    setDefaultAssigneeIds(ids);
    setSavingDefaultAssignees(true);
    try {
      await api.itProvisioningSetDefaultAssignees(ids);
    } catch (e: any) {
      alert(e.message || "Failed to save default assignees");
    } finally {
      setSavingDefaultAssignees(false);
    }
  }

  function toggleDefaultAssignee(id: string) {
    const next = defaultAssigneeIds.includes(id) ? defaultAssigneeIds.filter((x) => x !== id) : [...defaultAssigneeIds, id];
    void saveDefaultAssignees(next);
  }

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.itProvisioningList({
        status: statusFilter, computer_type: computerTypeFilter, request_type: requestTypeFilter,
        department: departmentFilter, search
      });
      setItems(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (view === "dashboard") void loadList(); }, [view, statusFilter, computerTypeFilter, requestTypeFilter, departmentFilter]);
  useEffect(() => {
    const t = setTimeout(() => { if (view === "dashboard") void loadList(); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const kpis = useMemo(() => {
    const count = (s: string) => items.filter((i) => i.status === s).length;
    return {
      awaiting: count("AWAITING_PROVISIONING"),
      inProgress: count("IN_PROGRESS"),
      ready: count("READY_FOR_COLLECTION"),
      completed: count("COMPLETED")
    };
  }, [items]);

  const uniqueDepartments = useMemo(() => Array.from(new Set(items.map((i) => i.requester_department).filter(Boolean))).sort() as string[], [items]);

  function openDetail(id: string) {
    setSelectedId(id);
    setView("detail");
  }

  if (view === "assets") return <AssetHistory onBack={() => setView("dashboard")} />;
  if (view === "reports") return <ReportsView onBack={() => setView("dashboard")} />;
  if (view === "detail" && selectedId) {
    return <TaskDetail id={selectedId} onBack={() => { setView("dashboard"); void loadList(); }} />;
  }

  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">IT Provisioning Dashboard</h1>
          <p className="ep-subtitle">Manage approved computer requests and provisioning activities.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => setView("assets")}><HardDrive size={14} /> Asset History</button>
          <button className="ep-btn-outline" onClick={() => setView("reports")}><BarChart3 size={14} /> Reports</button>
          <button className="ep-btn-outline" onClick={() => void loadList()} disabled={loading}><RefreshCw size={14} /> Refresh</button>
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div className="ep-kpi-row">
        <div className="ep-kpi ep-kpi-blue" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("AWAITING_PROVISIONING")}>
          <div className="ep-kpi-icon"><ClipboardList size={26} /></div>
          <div><div className="ep-kpi-value">{kpis.awaiting}</div><div className="ep-kpi-label">Awaiting Provisioning</div></div>
        </div>
        <div className="ep-kpi ep-kpi-gold" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("IN_PROGRESS")}>
          <div className="ep-kpi-icon"><Loader2 size={26} /></div>
          <div><div className="ep-kpi-value">{kpis.inProgress}</div><div className="ep-kpi-label">In Progress</div></div>
        </div>
        <div className="ep-kpi ep-kpi-green" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("READY_FOR_COLLECTION")}>
          <div className="ep-kpi-icon"><PackageCheck size={26} /></div>
          <div><div className="ep-kpi-value">{kpis.ready}</div><div className="ep-kpi-label">Ready for Collection</div></div>
        </div>
        <div className="ep-kpi ep-kpi-purple" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("COMPLETED")}>
          <div className="ep-kpi-icon"><CheckCircle2 size={26} /></div>
          <div><div className="ep-kpi-value">{kpis.completed}</div><div className="ep-kpi-label">Completed</div></div>
        </div>
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "12px 20px", alignItems: "center", position: "relative" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Default Assignees:</span>
          <button
            type="button"
            className="ep-btn-outline"
            style={{ minWidth: 220, justifyContent: "space-between", display: "inline-flex", alignItems: "center" }}
            onClick={() => setShowAssigneePicker((v) => !v)}
          >
            <span>
              {defaultAssigneeIds.length === 0
                ? "None — new requests land unassigned"
                : defaultAssigneeIds.map((id) => staff.find((s) => s.id === id)?.full_name || id).join(", ")}
            </span>
            <ChevronDown size={14} />
          </button>
          {showAssigneePicker && (
            <div
              style={{
                position: "absolute", top: "100%", left: 130, marginTop: 4, zIndex: 20,
                background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
                boxShadow: "0 4px 16px rgba(0,0,0,0.12)", padding: 8, minWidth: 240, maxHeight: 280, overflowY: "auto"
              }}
            >
              {staff.map((u) => (
                <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", fontSize: 13, cursor: "pointer", borderRadius: 6 }}>
                  <input type="checkbox" checked={defaultAssigneeIds.includes(u.id)} disabled={savingDefaultAssignees} onChange={() => toggleDefaultAssignee(u.id)} />
                  {u.full_name || u.id}
                </label>
              ))}
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 6, textAlign: "right" }}>
                <button className="ep-btn-outline" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setShowAssigneePicker(false)}>Done</button>
              </div>
            </div>
          )}
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {defaultAssigneeIds.length <= 1
              ? "Every new Computer Request is pre-assigned to this IT Officer automatically."
              : "New requests are left unassigned but claimable by any of these officers — first to claim it gets it."}
          </span>
        </div>
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr repeat(4, 1fr) auto", gap: 10, padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ minWidth: 0 }}>
            <Search size={14} />
            <input placeholder="Search requests, employee, asset…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="ep-form-select" style={{ minWidth: 0 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Status</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="ep-form-select" style={{ minWidth: 0 }} value={computerTypeFilter} onChange={(e) => setComputerTypeFilter(e.target.value)}>
            <option value="">All Computer Types</option>
            <option value="LAPTOP">Laptop</option>
            <option value="DESKTOP">Desktop</option>
          </select>
          <select className="ep-form-select" style={{ minWidth: 0 }} value={requestTypeFilter} onChange={(e) => setRequestTypeFilter(e.target.value)}>
            <option value="">All Processes</option>
            <option value="NEW">New</option>
            <option value="REPLACEMENT">Replacement</option>
            <option value="UPGRADE">Upgrade</option>
          </select>
          <select className="ep-form-select" style={{ minWidth: 0 }} value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
            <option value="">All Departments</option>
            {uniqueDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {(statusFilter || computerTypeFilter || requestTypeFilter || departmentFilter || search) && (
            <button className="ep-btn-outline" onClick={() => { setStatusFilter(""); setComputerTypeFilter(""); setRequestTypeFilter(""); setDepartmentFilter(""); setSearch(""); }}>Clear</button>
          )}
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><RefreshCw size={20} className="rl-spin" /><p>Loading requests…</p></div>
          ) : items.length === 0 ? (
            <div className="ep-empty"><Monitor size={32} style={{ opacity: 0.25 }} /><p>No computer requests match your filters.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Request No.</th><th>Employee</th><th>Department</th><th>Computer</th>
                  <th>Process</th><th>Approved On</th><th>Status</th><th>Assigned To</th><th />
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => openDetail(t.id)}>
                    <td style={{ fontWeight: 600, color: "#2563eb", fontSize: 13 }}>CR-{t.submission_id.slice(0, 8).toUpperCase()}</td>
                    <td style={{ fontSize: 13 }}>{t.requester_name || "—"}</td>
                    <td style={{ fontSize: 13, color: "var(--muted)" }}>{t.requester_department || "—"}</td>
                    <td style={{ fontSize: 13 }}>{t.computer_type === "LAPTOP" ? <><Laptop size={13} style={{ marginRight: 4, verticalAlign: -2 }} />Laptop</> : t.computer_type === "DESKTOP" ? <><Monitor size={13} style={{ marginRight: 4, verticalAlign: -2 }} />Desktop</> : "—"}</td>
                    <td style={{ fontSize: 13 }}>{t.request_type ? t.request_type.charAt(0) + t.request_type.slice(1).toLowerCase() : "—"}</td>
                    <td style={{ fontSize: 13 }}>{fmtDate(t.submitted_at)}</td>
                    <td><StatusBadge status={t.status} /></td>
                    <td style={{ fontSize: 13, color: "var(--muted)" }}>{t.assigned_to_name || "—"}</td>
                    <td><button className="ep-btn-outline" style={{ padding: "3px 8px" }} onClick={(e) => { e.stopPropagation(); openDetail(t.id); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Task Detail ────────────────────────────────────────────────────────────

function TaskDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const t = await api.itProvisioningDetail(id);
      setTask(t);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [id]);

  if (loading || !task) return <div className="ep-page"><p>Loading request…</p></div>;

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>IT Provisioning</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Request Details</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            Computer Request <StatusBadge status={task.status} />
          </h1>
          <p className="ep-subtitle">CR-{task.submission_id.slice(0, 8).toUpperCase()}</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

          <div className="ep-panel">
            <div className="ep-panel-head"><div className="ep-panel-title">Request Information</div></div>
            <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Field label="Requester"><div style={{ fontWeight: 600 }}>{task.requester_name || "—"}</div></Field>
              <Field label="Department"><div>{task.requester_department || "—"}</div></Field>
              <Field label="Position"><div>{task.position || "—"}</div></Field>
              <Field label="Computer Type"><div>{task.computer_type || "—"}</div></Field>
              <Field label="Employee No."><div>{task.requester_employee_no || "—"}</div></Field>
              <Field label="Process"><div>{task.request_type || "—"}</div></Field>
              <Field label="Phone"><div>{task.phone_no || "—"}</div></Field>
              <Field label="Submitted On"><div>{fmtDate(task.submitted_at)}</div></Field>
            </div>
            {task.justification && (
              <div style={{ padding: "0 20px 18px" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>Justification</div>
                <div style={{ fontSize: 13, background: "var(--surface-soft)", padding: 10, borderRadius: 6 }}>{task.justification}</div>
              </div>
            )}
          </div>

          {task.status !== "COMPLETED" ? (
            <ProvisioningForm task={task} onChange={setTask} onReload={load} saving={saving} setSaving={setSaving} />
          ) : (
            <CompletedSummary task={task} />
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="ep-panel">
            <div className="ep-panel-head"><div className="ep-panel-title">Approval History</div></div>
            <div style={{ padding: "10px 20px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
              {task.approval_chain.map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ marginTop: 2 }}>
                    {step.status === "APPROVED" || step.status === "NOTED"
                      ? <CheckCircle2 size={16} color="#059669" />
                      : step.status === "REJECTED"
                      ? <span style={{ color: "#dc2626", fontWeight: 700 }}>✕</span>
                      : <Clock size={16} color="#d97706" />}
                  </span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{step.position_name}{step.approver_name ? ` — ${step.approver_name}` : ""}</div>
                    {step.acted_at && <div style={{ fontSize: 11, color: "var(--muted)" }}>{fmtDate(step.acted_at)}</div>}
                  </div>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ marginTop: 2 }}>
                  {task.status === "COMPLETED" ? <CheckCircle2 size={16} color="#059669" /> : <span style={{ width: 8, height: 8, borderRadius: 99, background: "#2563eb", display: "inline-block", marginTop: 4 }} />}
                </span>
                <div style={{ fontSize: 13, fontWeight: 600, color: task.status === "COMPLETED" ? "var(--text)" : "#2563eb" }}>
                  IT Provisioning {task.status !== "COMPLETED" && <div style={{ fontSize: 11, fontWeight: 400, color: "var(--muted)" }}>Awaiting action</div>}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Provisioning form (in-progress states) ─────────────────────────────────

function ProvisioningForm({ task, onChange, onReload, saving, setSaving }: {
  task: Task; onChange: (t: Task) => void; onReload: () => void; saving: boolean; setSaving: (b: boolean) => void;
}) {
  const [assignedTo, setAssignedTo] = useState(task.assigned_to_id || "");
  const [deviceSource, setDeviceSource] = useState(task.device_source || "NEW_STOCK");
  const [staff, setStaff] = useState<Array<{ id: string; full_name: string | null }>>([]);

  const [assetNumber, setAssetNumber] = useState(task.device?.asset_number || "");
  const [serialNumber, setSerialNumber] = useState(task.device?.serial_number || "");
  const [manufacturer, setManufacturer] = useState(task.device?.manufacturer || "");
  const [model, setModel] = useState(task.device?.model || "");
  const [os, setOs] = useState(task.device?.operating_system || "");
  const [hostname, setHostname] = useState(task.device?.hostname || "");
  const [network, setNetwork] = useState(task.device?.network_details || "");
  const [warranty, setWarranty] = useState(task.device?.warranty_expiry ? String(task.device.warranty_expiry).slice(0, 10) : "");

  const [checklist, setChecklist] = useState<ChecklistItem[]>(task.checklist);
  const [software, setSoftware] = useState<SoftwareItem[]>(task.software);
  const [newSoftware, setNewSoftware] = useState("");

  const [replPrevAsset, setReplPrevAsset] = useState(task.replacement_details?.previous_asset_number || "");
  const [replReason, setReplReason] = useState(task.replacement_details?.reason || "");
  const [replReturned, setReplReturned] = useState(Boolean(task.replacement_details?.old_device_returned));
  const [replCondition, setReplCondition] = useState(task.replacement_details?.old_device_condition || "");
  const [replDisposition, setReplDisposition] = useState(task.replacement_details?.old_device_disposition || "");

  const [upgExisting, setUpgExisting] = useState(task.upgrade_details?.existing_asset_number || "");
  const [upgRam, setUpgRam] = useState(Boolean(task.upgrade_details?.upgrade_ram));
  const [upgSsd, setUpgSsd] = useState(Boolean(task.upgrade_details?.upgrade_ssd));
  const [upgOs, setUpgOs] = useState(Boolean(task.upgrade_details?.upgrade_os));
  const [upgOther, setUpgOther] = useState(Boolean(task.upgrade_details?.upgrade_other));
  const [upgCurrentSpec, setUpgCurrentSpec] = useState(task.upgrade_details?.current_specification || "");
  const [upgNewSpec, setUpgNewSpec] = useState(task.upgrade_details?.new_specification || "");

  const [handoverReceivedBy, setHandoverReceivedBy] = useState(task.requester_name || "");
  const [handoverDate, setHandoverDate] = useState(new Date().toISOString().slice(0, 10));
  const [accCharger, setAccCharger] = useState(true);
  const [accBag, setAccBag] = useState(true);
  const [accMouse, setAccMouse] = useState(true);
  const [accDocking, setAccDocking] = useState(false);
  const [accOther, setAccOther] = useState("");
  const [handoverComments, setHandoverComments] = useState("");

  useEffect(() => {
    api.adminUsers().then((rows: any[]) => setStaff(Array.isArray(rows) ? rows.filter((u) => u.is_active !== false) : [])).catch(() => {});
  }, []);

  async function saveAssignment() {
    setSaving(true);
    try {
      await api.itProvisioningAssign(task.id, { assigned_to_id: assignedTo || null, device_source: deviceSource as any });
      onReload();
    } catch (e: any) {
      alert(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function saveDevice() {
    if (!assetNumber.trim()) { alert("Asset number is required"); return; }
    setSaving(true);
    try {
      await api.itProvisioningSetDevice(task.id, {
        asset_number: assetNumber.trim(), serial_number: serialNumber || null, manufacturer: manufacturer || null,
        model: model || null, operating_system: os || null, hostname: hostname || null,
        network_details: network || null, warranty_expiry: warranty || null
      });
      onReload();
    } catch (e: any) {
      alert(e.message || "Failed to save device");
    } finally {
      setSaving(false);
    }
  }

  async function saveChecklist(next: ChecklistItem[]) {
    setChecklist(next);
    try { await api.itProvisioningSetChecklist(task.id, next); } catch (e: any) { alert(e.message || "Failed to save checklist"); }
  }

  async function saveSoftware(next: SoftwareItem[]) {
    setSoftware(next);
    try { await api.itProvisioningSetSoftware(task.id, next); } catch (e: any) { alert(e.message || "Failed to save software"); }
  }

  async function saveReplacementDetails() {
    setSaving(true);
    try {
      await api.itProvisioningSetReplacementDetails(task.id, {
        previous_asset_number: replPrevAsset || null, reason: replReason || null,
        old_device_returned: replReturned, old_device_condition: replCondition || null, old_device_disposition: replDisposition || null
      });
      onReload();
    } catch (e: any) { alert(e.message || "Failed to save"); } finally { setSaving(false); }
  }

  async function saveUpgradeDetails() {
    setSaving(true);
    try {
      await api.itProvisioningSetUpgradeDetails(task.id, {
        existing_asset_number: upgExisting || null, upgrade_ram: upgRam, upgrade_ssd: upgSsd, upgrade_os: upgOs, upgrade_other: upgOther,
        current_specification: upgCurrentSpec || null, new_specification: upgNewSpec || null
      });
      onReload();
    } catch (e: any) { alert(e.message || "Failed to save"); } finally { setSaving(false); }
  }

  async function claimTask() {
    setSaving(true);
    try {
      await api.itProvisioningClaim(task.id);
      onReload();
    } catch (e: any) { alert(e.message || "Failed to claim this request"); } finally { setSaving(false); }
  }

  async function markProvisioned() {
    setSaving(true);
    try {
      await api.itProvisioningMarkProvisioned(task.id);
      onReload();
    } catch (e: any) { alert(e.message || "Failed to mark as provisioned"); } finally { setSaving(false); }
  }

  async function markReady() {
    setSaving(true);
    try { await api.itProvisioningReadyForCollection(task.id); onReload(); }
    catch (e: any) { alert(e.message || "Failed"); } finally { setSaving(false); }
  }

  async function confirmHandover() {
    if (!handoverReceivedBy.trim() || !handoverDate) { alert("Received by and date are required"); return; }
    setSaving(true);
    try {
      await api.itProvisioningHandover(task.id, {
        received_by_name: handoverReceivedBy.trim(), handover_date: handoverDate,
        accessories: { charger: accCharger, laptop_bag: accBag, mouse: accMouse, docking_station: accDocking, other: accOther || null },
        comments: handoverComments || null
      });
      onReload();
    } catch (e: any) { alert(e.message || "Failed to confirm handover"); } finally { setSaving(false); }
  }

  const checklistComplete = checklist.length > 0 && checklist.every((c) => c.checked);
  const canMarkProvisioned = Boolean(assignedTo) && Boolean(assetNumber.trim()) && checklistComplete;

  return (
    <>
      {!task.assigned_to_id && (
        <div className="ep-panel" style={{ background: "#eff6ff", borderColor: "#bfdbfe" }}>
          <div style={{ padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <UserCheck size={20} color="#2563eb" />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>This request is unassigned</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>If you're one of the preset IT Officers, claim it to start working on it.</div>
              </div>
            </div>
            <button className="ep-btn" onClick={claimTask} disabled={saving}>Claim this request</button>
          </div>
        </div>
      )}
      <div className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Provisioning Details</div></div>
        <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Assigned To">
            <select style={fieldStyle()} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Select IT Officer</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.id}</option>)}
            </select>
          </Field>
          <Field label="Provisioning Status"><div style={{ padding: "7px 0" }}><StatusBadge status={task.status} /></div></Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Device Source">
              <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
                {[["NEW_STOCK", "New Stock"], ["EXISTING_STOCK", "Existing Stock"], ["REPLACEMENT_DEVICE", "Replacement Device"]].map(([v, l]) => (
                  <label key={v} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
                    <input type="radio" checked={deviceSource === v} onChange={() => setDeviceSource(v)} /> {l}
                  </label>
                ))}
              </div>
            </Field>
          </div>
        </div>
        <div style={{ padding: "0 20px 16px" }}>
          <button className="ep-btn" onClick={saveAssignment} disabled={saving}>Save Assignment</button>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Device Information</div></div>
        <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Asset Number *"><input style={fieldStyle()} value={assetNumber} onChange={(e) => setAssetNumber(e.target.value)} placeholder="ETL-LAP-00482" /></Field>
          <Field label="Serial Number"><input style={fieldStyle()} value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} /></Field>
          <Field label="Manufacturer"><input style={fieldStyle()} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="Lenovo" /></Field>
          <Field label="Model"><input style={fieldStyle()} value={model} onChange={(e) => setModel(e.target.value)} placeholder="ThinkPad T14 Gen 5" /></Field>
          <Field label="Operating System"><input style={fieldStyle()} value={os} onChange={(e) => setOs(e.target.value)} placeholder="Windows 11 Enterprise" /></Field>
          <Field label="Hostname"><input style={fieldStyle()} value={hostname} onChange={(e) => setHostname(e.target.value)} /></Field>
          <Field label="IP / Network Details"><input style={fieldStyle()} value={network} onChange={(e) => setNetwork(e.target.value)} /></Field>
          <Field label="Warranty Expiry"><input type="date" style={fieldStyle()} value={warranty} onChange={(e) => setWarranty(e.target.value)} /></Field>
        </div>
        <div style={{ padding: "0 20px 16px" }}>
          <button className="ep-btn" onClick={saveDevice} disabled={saving}>Save Device Info</button>
        </div>
      </div>

      {task.request_type === "REPLACEMENT" && (
        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Replacement Information</div></div>
          <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="Previous Asset Number"><input style={fieldStyle()} value={replPrevAsset} onChange={(e) => setReplPrevAsset(e.target.value)} /></Field>
            <Field label="Reason"><input style={fieldStyle()} value={replReason} onChange={(e) => setReplReason(e.target.value)} placeholder="Device failure / obsolete" /></Field>
            <Field label="Old Device Returned">
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={replReturned} onChange={(e) => setReplReturned(e.target.checked)} /> Yes
              </label>
            </Field>
            <Field label="Old Device Condition">
              <select style={fieldStyle()} value={replCondition} onChange={(e) => setReplCondition(e.target.value)}>
                <option value="">Select</option><option value="Working">Working</option><option value="Damaged">Damaged</option><option value="Obsolete">Obsolete</option>
              </select>
            </Field>
            <Field label="Old Device Disposition">
              <select style={fieldStyle()} value={replDisposition} onChange={(e) => setReplDisposition(e.target.value)}>
                <option value="">Select</option><option value="Repair">Repair</option><option value="Store">Store</option><option value="Dispose">Dispose</option>
              </select>
            </Field>
          </div>
          <div style={{ padding: "0 20px 16px" }}><button className="ep-btn" onClick={saveReplacementDetails} disabled={saving}>Save Replacement Details</button></div>
        </div>
      )}

      {task.request_type === "UPGRADE" && (
        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Upgrade Details</div></div>
          <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="Existing Asset"><input style={fieldStyle()} value={upgExisting} onChange={(e) => setUpgExisting(e.target.value)} /></Field>
            <Field label="Upgrade Type">
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
                {[["RAM", upgRam, setUpgRam], ["SSD", upgSsd, setUpgSsd], ["Operating System", upgOs, setUpgOs], ["Other", upgOther, setUpgOther]].map(([label, val, setter]: any) => (
                  <label key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}>
                    <input type="checkbox" checked={val} onChange={(e) => setter(e.target.checked)} /> {label}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Current Specification"><input style={fieldStyle()} value={upgCurrentSpec} onChange={(e) => setUpgCurrentSpec(e.target.value)} placeholder="8GB RAM / 256GB SSD" /></Field>
            <Field label="New Specification"><input style={fieldStyle()} value={upgNewSpec} onChange={(e) => setUpgNewSpec(e.target.value)} placeholder="16GB RAM / 512GB SSD" /></Field>
          </div>
          <div style={{ padding: "0 20px 16px" }}><button className="ep-btn" onClick={saveUpgradeDetails} disabled={saving}>Save Upgrade Details</button></div>
        </div>
      )}

      <div className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Provisioning Checklist</div></div>
        <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {checklist.map((c, i) => (
            <label key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={c.checked} onChange={(e) => {
                const next = checklist.map((item, idx) => idx === i ? { ...item, checked: e.target.checked } : item);
                void saveChecklist(next);
              }} />
              {c.label}
            </label>
          ))}
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Software Installed</div></div>
        <div style={{ padding: "14px 20px" }}>
          <table className="ep-table">
            <thead><tr><th>Software</th><th style={{ width: 120 }}>Status</th></tr></thead>
            <tbody>
              {software.map((s, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 13 }}>{s.name}</td>
                  <td>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                      <input type="checkbox" checked={s.status === "INSTALLED"} onChange={(e) => {
                        const next = software.map((item, idx) => idx === i ? { ...item, status: (e.target.checked ? "INSTALLED" : "PENDING") as "INSTALLED" | "PENDING" } : item);
                        void saveSoftware(next);
                      }} />
                      {s.status === "INSTALLED" ? <span style={{ color: "#059669", fontWeight: 600 }}>Installed</span> : <span style={{ color: "var(--muted)" }}>Pending</span>}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input style={{ ...fieldStyle(), flex: 1 }} placeholder="Additional software" value={newSoftware} onChange={(e) => setNewSoftware(e.target.value)} />
            <button className="ep-btn-outline" onClick={() => {
              if (!newSoftware.trim()) return;
              const next = [...software, { name: newSoftware.trim(), status: "PENDING" as const, is_standard: false }];
              setNewSoftware("");
              void saveSoftware(next);
            }}>+ Add Software</button>
          </div>
        </div>
      </div>

      {(task.status === "AWAITING_PROVISIONING" || task.status === "IN_PROGRESS") && (
        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Provisioning Validation</div></div>
          <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 6 }}>
            <ValidationRow ok={Boolean(assetNumber.trim())} label="Asset Number captured" />
            <ValidationRow ok={Boolean(assignedTo)} label="Assigned IT Officer" />
            <ValidationRow ok={checklistComplete} label={`Required Checklist Completed (${checklist.filter((c) => c.checked).length}/${checklist.length})`} />
            <div style={{ marginTop: 8 }}>
              <button className="ep-btn" onClick={markProvisioned} disabled={saving || !canMarkProvisioned}>Mark as Provisioned</button>
            </div>
          </div>
        </div>
      )}

      {task.status === "PROVISIONED" && (
        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Ready for Collection</div></div>
          <div style={{ padding: "14px 20px" }}>
            <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 0 }}>Notify the employee their device is ready, or go straight to handover below.</p>
            <button className="ep-btn" onClick={markReady} disabled={saving}>Mark Ready for Collection</button>
          </div>
        </div>
      )}

      {(task.status === "PROVISIONED" || task.status === "READY_FOR_COLLECTION") && (
        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Device Handover</div></div>
          <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="Employee"><div style={{ fontWeight: 600 }}>{task.requester_name}</div></Field>
            <Field label="Asset Number"><div>{assetNumber || "—"}</div></Field>
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Accessories">
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}><input type="checkbox" checked={accCharger} onChange={(e) => setAccCharger(e.target.checked)} /> Charger</label>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}><input type="checkbox" checked={accBag} onChange={(e) => setAccBag(e.target.checked)} /> Laptop Bag</label>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}><input type="checkbox" checked={accMouse} onChange={(e) => setAccMouse(e.target.checked)} /> Mouse</label>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}><input type="checkbox" checked={accDocking} onChange={(e) => setAccDocking(e.target.checked)} /> Docking Station</label>
                </div>
              </Field>
            </div>
            <Field label="Other Accessory"><input style={fieldStyle()} value={accOther} onChange={(e) => setAccOther(e.target.value)} placeholder="Type other accessory" /></Field>
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Handover Comments">
                <textarea style={{ ...fieldStyle(), minHeight: 60 }} value={handoverComments} onChange={(e) => setHandoverComments(e.target.value)} />
              </Field>
            </div>
            <Field label="Received By (Employee) *"><input style={fieldStyle()} value={handoverReceivedBy} onChange={(e) => setHandoverReceivedBy(e.target.value)} /></Field>
            <Field label="Date *"><input type="date" style={fieldStyle()} value={handoverDate} onChange={(e) => setHandoverDate(e.target.value)} /></Field>
          </div>
          <div style={{ padding: "0 20px 18px" }}>
            <button className="ep-btn" onClick={confirmHandover} disabled={saving}>Confirm Handover</button>
          </div>
        </div>
      )}
    </>
  );
}

function ValidationRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      {ok ? <CheckCircle2 size={16} color="#059669" /> : <span style={{ width: 16, height: 16, borderRadius: 99, border: "1.5px solid var(--border)", display: "inline-block" }} />}
      <span style={{ color: ok ? "var(--text)" : "var(--muted)" }}>{label}</span>
    </div>
  );
}

// ─── Completed summary ───────────────────────────────────────────────────────

function CompletedSummary({ task }: { task: Task }) {
  return (
    <>
      <div className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Device Information</div></div>
        <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Asset Number"><div style={{ fontWeight: 600 }}>{task.device?.asset_number || "—"}</div></Field>
          <Field label="Serial Number"><div>{task.device?.serial_number || "—"}</div></Field>
          <Field label="Model"><div>{[task.device?.manufacturer, task.device?.model].filter(Boolean).join(" ") || "—"}</div></Field>
          <Field label="OS"><div>{task.device?.operating_system || "—"}</div></Field>
          <Field label="Hostname"><div>{task.device?.hostname || "—"}</div></Field>
          <Field label="Warranty Expiry"><div>{fmtDate(task.device?.warranty_expiry)}</div></Field>
        </div>
      </div>
      <div className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Handover</div></div>
        <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Received By"><div>{task.handover?.received_by_name || "—"}</div></Field>
          <Field label="Handover Date"><div>{fmtDate(task.handover?.handover_date)}</div></Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Accessories">
              <div style={{ fontSize: 13 }}>
                {[
                  task.handover?.accessories?.charger && "Charger",
                  task.handover?.accessories?.laptop_bag && "Laptop Bag",
                  task.handover?.accessories?.mouse && "Mouse",
                  task.handover?.accessories?.docking_station && "Docking Station",
                  task.handover?.accessories?.other
                ].filter(Boolean).join(", ") || "—"}
              </div>
            </Field>
          </div>
        </div>
      </div>
      <div className="ep-panel">
        <div className="ep-panel-head"><div className="ep-panel-title">Timeline</div></div>
        <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
          <TimelineRow label="Provisioned" ts={task.provisioned_at} by={task.provisioned_by_name} />
          <TimelineRow label="Ready for Collection" ts={task.ready_for_collection_at} />
          <TimelineRow label="Handover Completed" ts={task.handed_over_at} />
          <TimelineRow label="Completed" ts={task.completed_at} />
        </div>
      </div>
    </>
  );
}

function TimelineRow({ label, ts, by }: { label: string; ts: string | null; by?: string | null }) {
  if (!ts) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <CheckCircle2 size={15} color="#059669" />
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ color: "var(--muted)" }}>{fmtDateTime(ts)}{by ? ` — ${by}` : ""}</span>
    </div>
  );
}

// ─── Asset History ────────────────────────────────────────────────────────────

function AssetHistory({ onBack }: { onBack: () => void }) {
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.itProvisioningDevices().then((r: any) => setDevices(r.items || [])).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return devices;
    return devices.filter((d) =>
      (d.asset_number || "").toLowerCase().includes(q) ||
      (d.serial_number || "").toLowerCase().includes(q) ||
      (d.assigned_user_name || "").toLowerCase().includes(q)
    );
  }, [devices, search]);

  function exportCsv() {
    const headers = ["Asset Number", "Serial Number", "Manufacturer", "Model", "Type", "OS", "Assigned To", "Department", "Status", "Warranty Expiry"];
    const rows = filtered.map((d) => [d.asset_number, d.serial_number || "", d.manufacturer || "", d.model || "", d.computer_type || "", d.operating_system || "", d.assigned_user_name || "", d.assigned_user_department || "", d.status, fmtDate(d.warranty_expiry)]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `it-asset-history-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>IT Provisioning</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Asset History</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Asset History</h1>
          <p className="ep-subtitle">Every device issued through IT Provisioning.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={onBack}><ArrowLeft size={14} /> Back</button>
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export</button>
        </div>
      </div>
      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ padding: "14px 20px" }}>
          <div className="ep-search" style={{ maxWidth: 320 }}>
            <Search size={14} />
            <input placeholder="Search asset, serial, employee…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="ep-panel">
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><RefreshCw size={20} className="rl-spin" /><p>Loading assets…</p></div>
          ) : filtered.length === 0 ? (
            <div className="ep-empty"><HardDrive size={32} style={{ opacity: 0.25 }} /><p>No devices recorded yet.</p></div>
          ) : (
            <table className="ep-table">
              <thead><tr><th>Asset Number</th><th>Serial</th><th>Model</th><th>Type</th><th>Assigned To</th><th>Department</th><th>Status</th><th>Warranty</th></tr></thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{d.asset_number}</td>
                    <td style={{ fontSize: 13 }}>{d.serial_number || "—"}</td>
                    <td style={{ fontSize: 13 }}>{[d.manufacturer, d.model].filter(Boolean).join(" ") || "—"}</td>
                    <td style={{ fontSize: 13 }}>{d.computer_type || "—"}</td>
                    <td style={{ fontSize: 13 }}>{d.assigned_user_name || "—"}</td>
                    <td style={{ fontSize: 13, color: "var(--muted)" }}>{d.assigned_user_department || "—"}</td>
                    <td style={{ fontSize: 13 }}>{d.status}</td>
                    <td style={{ fontSize: 13 }}>{fmtDate(d.warranty_expiry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Reports ──────────────────────────────────────────────────────────────────

function ReportsView({ onBack }: { onBack: () => void }) {
  const [summary, setSummary] = useState<any>(null);
  const [tab, setTab] = useState<"status" | "department" | "computerType" | "process">("status");
  useEffect(() => { api.itProvisioningReportsSummary().then(setSummary).catch(() => {}); }, []);

  function Bars({ title, rows, keyName, valueName }: { title: string; rows: any[]; keyName: string; valueName: string }) {
    const max = Math.max(1, ...rows.map((r) => r[valueName]));
    return (
      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div className="ep-panel-head"><div className="ep-panel-title">{title}</div></div>
        <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.length === 0 && <div style={{ fontSize: 13, color: "var(--muted)" }}>No data yet.</div>}
          {rows.map((r) => (
            <div key={r[keyName]} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 160, fontSize: 12, color: "var(--muted)" }}>{STATUS_LABEL[r[keyName]] || r[keyName]}</div>
              <div style={{ flex: 1, height: 10, background: "var(--surface-soft)", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ width: `${(r[valueName] / max) * 100}%`, height: "100%", background: "#2563eb", borderRadius: 99 }} />
              </div>
              <div style={{ width: 30, fontSize: 12, fontWeight: 700, textAlign: "right" }}>{r[valueName]}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>IT Provisioning</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Reports</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Reports</h1>
          <p className="ep-subtitle">Provisioning activity at a glance.</p>
        </div>
        <div className="ep-actions"><button className="ep-btn-outline" onClick={onBack}><ArrowLeft size={14} /> Back</button></div>
      </div>
      {!summary ? <p>Loading…</p> : (
        <>
          <div className="ep-tabs">
            {([
              { key: "status", label: "By Status" },
              { key: "department", label: "By Department" },
              { key: "computerType", label: "By Computer Type" },
              { key: "process", label: "By Process" }
            ] as const).map((t) => (
              <button key={t.key} type="button" className={`ep-tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === "status" && <Bars title="By Status" rows={summary.byStatus} keyName="status" valueName="count" />}
          {tab === "department" && <Bars title="By Department" rows={summary.byDepartment} keyName="department" valueName="count" />}
          {tab === "computerType" && <Bars title="By Computer Type" rows={summary.byComputerType} keyName="computerType" valueName="count" />}
          {tab === "process" && <Bars title="By Process" rows={summary.byRequestType} keyName="requestType" valueName="count" />}
        </>
      )}
    </div>
  );
}
