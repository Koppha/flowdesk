import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import {
  Monitor, Laptop, Clock, Loader2, PackageCheck, CheckCircle2, Search,
  ArrowLeft, RefreshCw, Download, HardDrive, ClipboardList, BarChart3, ChevronDown, UserCheck, Plus, Pencil, Users, User, X
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ChecklistItem = { label: string; checked: boolean };
type SoftwareItem = { name: string; status: "INSTALLED" | "PENDING"; is_standard?: boolean };

type Task = {
  id: string;
  status: "AWAITING_PROVISIONING" | "IN_PROGRESS" | "PROVISIONED" | "READY_FOR_COLLECTION" | "HANDED_OVER" | "COMPLETED";
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
  collection_acknowledged_at: string | null;
  collection_acknowledged_by_name: string | null;
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
  HANDED_OVER: "Awaiting Employee Confirmation",
  COMPLETED: "Completed"
};

const STATUS_STYLE: Record<string, [string, string]> = {
  AWAITING_PROVISIONING: ["#f1f5f9", "#64748b"],
  IN_PROGRESS: ["#fef3c7", "#92400e"],
  PROVISIONED: ["#dbeafe", "#1d4ed8"],
  READY_FOR_COLLECTION: ["#d1fae5", "#065f46"],
  HANDED_OVER: ["#ccfbf1", "#115e59"],
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
  const [view, setView] = useState<"dashboard" | "detail" | "inventory" | "reports">("dashboard");
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState(initialStatus || "");
  const [computerTypeFilter, setComputerTypeFilter] = useState("");
  const [requestTypeFilter, setRequestTypeFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [search, setSearch] = useState("");

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
      ready: count("READY_FOR_COLLECTION") + count("HANDED_OVER"),
      completed: count("COMPLETED")
    };
  }, [items]);

  const uniqueDepartments = useMemo(() => Array.from(new Set(items.map((i) => i.requester_department).filter(Boolean))).sort() as string[], [items]);

  function openDetail(id: string) {
    setSelectedId(id);
    setView("detail");
  }

  if (view === "inventory") return <Inventory onBack={() => setView("dashboard")} />;
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
          <button className="ep-btn-outline" onClick={() => setView("inventory")}><HardDrive size={14} /> Inventory</button>
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

      <ProvisioningPoolPanel />

      <ApproverDefaultsPanel />

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div className="ep-filter-bar" style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px" }}>
            <Search size={14} />
            <input placeholder="Search requests, employee, asset…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="ep-form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Status</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="ep-form-select" value={computerTypeFilter} onChange={(e) => setComputerTypeFilter(e.target.value)}>
            <option value="">All Computer Types</option>
            <option value="LAPTOP">Laptop</option>
            <option value="DESKTOP">Desktop</option>
          </select>
          <select className="ep-form-select" value={requestTypeFilter} onChange={(e) => setRequestTypeFilter(e.target.value)}>
            <option value="">All Processes</option>
            <option value="NEW">New</option>
            <option value="REPLACEMENT">Replacement</option>
            <option value="UPGRADE">Upgrade</option>
          </select>
          <select className="ep-form-select" value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
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

          {task.status === "HANDED_OVER" && (
            <AwaitingConfirmation task={task} text={`Handover recorded. Waiting for ${task.requester_name || "the employee"} to confirm collection in FlowDesk — the request completes once they do.`} />
          )}
          {task.status !== "COMPLETED" && task.status !== "HANDED_OVER" ? (
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
  const [replTransferTo, setReplTransferTo] = useState(task.replacement_details?.transfer_to_user_id || "");
  const [directory, setDirectory] = useState<Array<{ id: string; full_name: string | null; email: string }>>([]);

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
    api.itProvisioningItStaff().then((rows: any[]) => setStaff(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (task.request_type !== "REPLACEMENT") return;
    api.companyDirectory().then((rows: any) => setDirectory(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [task.request_type]);

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
        old_device_returned: replReturned, old_device_condition: replCondition || null, old_device_disposition: replDisposition || null,
        transfer_to_user_id: replDisposition === "Transfer" ? (replTransferTo || null) : null
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
      <AssignmentWizard
        task={task}
        staff={staff}
        assignedTo={assignedTo} setAssignedTo={setAssignedTo}
        deviceSource={deviceSource} setDeviceSource={setDeviceSource}
        assetNumber={assetNumber} setAssetNumber={setAssetNumber}
        serialNumber={serialNumber} setSerialNumber={setSerialNumber}
        manufacturer={manufacturer} setManufacturer={setManufacturer}
        model={model} setModel={setModel}
        os={os} setOs={setOs}
        hostname={hostname} setHostname={setHostname}
        network={network} setNetwork={setNetwork}
        warranty={warranty} setWarranty={setWarranty}
        checklist={checklist} onSaveChecklist={saveChecklist}
        software={software} newSoftware={newSoftware} setNewSoftware={setNewSoftware} onSaveSoftware={saveSoftware}
        saving={saving}
        onSaveAssignment={async () => {
          setSaving(true);
          try {
            await api.itProvisioningAssign(task.id, { assigned_to_id: assignedTo || null, device_source: deviceSource as any });
            await api.itProvisioningSetDevice(task.id, {
              asset_number: assetNumber.trim(), serial_number: serialNumber || null, manufacturer: manufacturer || null,
              model: model || null, operating_system: os || null, hostname: hostname || null,
              network_details: network || null, warranty_expiry: warranty || null
            });
            onReload();
          } catch (e: any) {
            alert(e.message || "Failed to save");
          } finally {
            setSaving(false);
          }
        }}
      />

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
                <option value="">Select</option><option value="Repair">Repair</option><option value="Store">Store</option><option value="Dispose">Dispose</option><option value="Transfer">Transfer</option>
              </select>
            </Field>
            {replDisposition === "Transfer" && (
              <Field label="Transfer To *">
                <select style={fieldStyle()} value={replTransferTo} onChange={(e) => setReplTransferTo(e.target.value)}>
                  <option value="">Select employee</option>
                  {[...directory].sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email)).map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <div style={{ padding: "0 20px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button className="ep-btn" onClick={saveReplacementDetails} disabled={saving || (replDisposition === "Transfer" && !replTransferTo)}>Save Replacement Details</button>
            {replPrevAsset.trim() && replDisposition && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>Saving also updates asset {replPrevAsset.trim()} in the inventory.</span>
            )}
          </div>
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

      {(task.status === "AWAITING_PROVISIONING" || task.status === "IN_PROGRESS") && (
        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Complete Provisioning</div></div>
          <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>
              To finish: capture the device, tick every checklist item as you set the computer up, then mark it provisioned. The employee is emailed to collect it.
            </div>
            <ValidationRow ok={Boolean(assetNumber.trim())} label="1. Device captured (asset number)" />
            <ValidationRow ok={Boolean(assignedTo)} label="2. IT officer assigned" />
            <ValidationRow ok={checklistComplete} label={`3. Provisioning checklist — ${checklist.filter((c) => c.checked).length} of ${checklist.length} done`} />
            <div style={{ marginLeft: 22, border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "4px 16px" }}>
                {checklist.map((c, i) => (
                  <label key={c.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "3px 0", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={c.checked}
                      disabled={saving}
                      onChange={(e) => void saveChecklist(checklist.map((x, k) => (k === i ? { ...x, checked: e.target.checked } : x)))}
                    />
                    <span style={{ textDecoration: c.checked ? "line-through" : undefined, color: c.checked ? "var(--muted)" : undefined }}>{c.label}</span>
                  </label>
                ))}
              </div>
              {!checklistComplete && checklist.length > 0 && (
                <button className="ep-btn-outline" style={{ marginTop: 8, padding: "3px 10px", fontSize: 12 }} disabled={saving} onClick={() => void saveChecklist(checklist.map((x) => ({ ...x, checked: true })))}>
                  Tick all
                </button>
              )}
            </div>
            <div style={{ marginTop: 4 }}>
              <button className="ep-btn" onClick={markProvisioned} disabled={saving || !canMarkProvisioned}>Mark as Provisioned &amp; Notify Employee</button>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                {canMarkProvisioned ? "The employee is emailed to collect the device and confirm collection in FlowDesk." : "Complete the steps above to enable this."}
              </div>
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

      {task.status === "READY_FOR_COLLECTION" && (
        <AwaitingConfirmation task={task} text={`${task.requester_name || "The employee"} was emailed${task.ready_for_collection_at ? ` on ${fmtDateTime(task.ready_for_collection_at)}` : ""} to collect the device. The request completes when they confirm collection in FlowDesk.`} />
      )}

      {(task.status === "PROVISIONED" || task.status === "READY_FOR_COLLECTION") && (
        <div className="ep-panel">
          <div className="ep-panel-head"><div className="ep-panel-title">Record Handover (optional)</div></div>
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
            <button className="ep-btn" onClick={confirmHandover} disabled={saving}>Record Handover</button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Assignment wizard (Assign Officer → Device Source → Confirm Device) ────

const WIZARD_STEPS = [
  { key: "info", label: "Request Information", sub: "Review request", desc: "Confirm the request details before starting provisioning." },
  { key: "officer", label: "Assign Officer", sub: "Assign & start", desc: "Assign this request to an IT officer to begin provisioning." },
  { key: "source", label: "Device Source", sub: "Select device", desc: "Choose whether this device comes from new stock, existing stock, or a replacement." },
  { key: "device", label: "Confirm Device", sub: "Enter device info", desc: "Capture the asset details for the device being provisioned." },
  { key: "checklist", label: "Checklist", sub: "Complete checklist", desc: "Work through the provisioning checklist for this device." },
  { key: "software", label: "Software", sub: "Confirm software", desc: "Confirm installed software and add anything else required." },
] as const;
const STEP_INFO = 0, STEP_OFFICER = 1, STEP_SOURCE = 2, STEP_DEVICE = 3, STEP_CHECKLIST = 4, STEP_SOFTWARE = 5;

function AssignmentWizard(props: {
  task: Task;
  staff: Array<{ id: string; full_name: string | null }>;
  assignedTo: string; setAssignedTo: (v: string) => void;
  deviceSource: string; setDeviceSource: (v: string) => void;
  assetNumber: string; setAssetNumber: (v: string) => void;
  serialNumber: string; setSerialNumber: (v: string) => void;
  manufacturer: string; setManufacturer: (v: string) => void;
  model: string; setModel: (v: string) => void;
  os: string; setOs: (v: string) => void;
  hostname: string; setHostname: (v: string) => void;
  network: string; setNetwork: (v: string) => void;
  warranty: string; setWarranty: (v: string) => void;
  checklist: ChecklistItem[]; onSaveChecklist: (next: ChecklistItem[]) => void;
  software: SoftwareItem[]; newSoftware: string; setNewSoftware: (v: string) => void; onSaveSoftware: (next: SoftwareItem[]) => void;
  saving: boolean;
  onSaveAssignment: () => void | Promise<void>;
}) {
  const { task, staff, assignedTo, setAssignedTo, deviceSource, setDeviceSource,
    assetNumber, setAssetNumber, serialNumber, setSerialNumber, manufacturer, setManufacturer,
    model, setModel, os, setOs, hostname, setHostname, network, setNetwork, warranty, setWarranty,
    checklist, onSaveChecklist, software, newSoftware, setNewSoftware, onSaveSoftware,
    saving, onSaveAssignment } = props;

  const alreadySet = Boolean(task.assigned_to_id && task.device?.asset_number);
  const [editing, setEditing] = useState(!alreadySet);
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);

  if (!editing) {
    return (
      <div className="ep-panel">
        <div className="ep-panel-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="ep-panel-title">Provisioning Setup</div>
          <button className="ep-btn-outline" onClick={() => { setStep(0); setFurthest(WIZARD_STEPS.length - 1); setEditing(true); }}>Edit</button>
        </div>
        <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Assigned To"><div style={{ fontWeight: 600 }}>{task.assigned_to_name || "—"}</div></Field>
          <Field label="Provisioning Status"><div style={{ padding: "7px 0" }}><StatusBadge status={task.status} /></div></Field>
          <Field label="Device Source"><div>{deviceSource.replace(/_/g, " ")}</div></Field>
          <Field label="Asset Number"><div>{assetNumber || "—"}</div></Field>
          <Field label="Checklist"><div>{checklist.filter((c) => c.checked).length}/{checklist.length} complete</div></Field>
          <Field label="Software"><div>{software.filter((s) => s.status === "INSTALLED").length}/{software.length} installed</div></Field>
        </div>
      </div>
    );
  }

  const canProceedFromOfficer = Boolean(assignedTo);
  const canLeaveDevice = Boolean(assetNumber.trim());

  function goTo(i: number) {
    if (i > furthest) return;
    setStep(i);
  }
  async function next() {
    if (step === STEP_OFFICER && !canProceedFromOfficer) { alert("Select an IT Officer to continue"); return; }
    if (step === STEP_DEVICE) {
      if (!canLeaveDevice) { alert("Asset number is required"); return; }
      await onSaveAssignment();
    }
    const nextStep = Math.min(step + 1, WIZARD_STEPS.length - 1);
    setStep(nextStep);
    setFurthest((f) => Math.max(f, nextStep));
  }
  function back() {
    setStep((s) => Math.max(s - 1, 0));
  }
  function finish() {
    setEditing(false);
  }

  return (
    <div className="ep-panel">
      <div className="ep-panel-head"><div className="ep-panel-title">Provisioning Setup</div></div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "16px 20px 0", flexWrap: "wrap" }}>
        {WIZARD_STEPS.map((s, i) => (
          <React.Fragment key={s.key}>
            <div
              style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0, cursor: i <= furthest ? "pointer" : "default" }}
              onClick={() => goTo(i)}
            >
              {i < step
                ? <span style={{ width: 32, height: 32, borderRadius: 99, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#d1fae5" }}><CheckCircle2 size={18} color="#059669" /></span>
                : <span style={{
                    width: 32, height: 32, borderRadius: 99, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700, color: i === step ? "#fff" : "var(--muted)",
                    background: i === step ? "#2563eb" : "transparent", border: i === step ? "none" : "1.5px solid var(--border)",
                  }}>{i + 1}</span>}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: i === step ? "#2563eb" : "var(--text)", whiteSpace: "nowrap" }}>{s.label}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap" }}>{s.sub}</div>
              </div>
            </div>
            {i < WIZARD_STEPS.length - 1 && <div style={{ flex: 1, height: 1, background: "var(--border)", marginTop: 16, minWidth: 16 }} />}
          </React.Fragment>
        ))}
      </div>

      <div style={{ padding: "18px 20px 0" }}>
        <div style={{ fontSize: 14.5, fontWeight: 700 }}>Step {step + 1} of {WIZARD_STEPS.length}: {WIZARD_STEPS[step].label}</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{WIZARD_STEPS[step].desc}</div>
      </div>

      {step === STEP_INFO && (
        <div style={{ padding: "14px 20px 18px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Requester"><div style={{ fontWeight: 600 }}>{task.requester_name || "—"}</div></Field>
          <Field label="Department"><div>{task.requester_department || "—"}</div></Field>
          <Field label="Position"><div>{task.position || "—"}</div></Field>
          <Field label="Computer Type"><div>{task.computer_type || "—"}</div></Field>
          <Field label="Employee No."><div>{task.requester_employee_no || "—"}</div></Field>
          <Field label="Process"><div>{task.request_type || "—"}</div></Field>
          <Field label="Phone"><div>{task.phone_no || "—"}</div></Field>
          <Field label="Submitted On"><div>{fmtDate(task.submitted_at)}</div></Field>
          {task.justification && (
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Justification"><div style={{ background: "var(--surface-soft)", padding: 10, borderRadius: 6 }}>{task.justification}</div></Field>
            </div>
          )}
        </div>
      )}

      {step === STEP_OFFICER && (
        <div style={{ padding: "14px 20px 18px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Assigned To">
            <select style={fieldStyle()} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Select IT Officer</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.id}</option>)}
            </select>
          </Field>
          <Field label="Provisioning Status"><div style={{ padding: "7px 0" }}><StatusBadge status={task.status} /></div></Field>
        </div>
      )}

      {step === STEP_SOURCE && (
        <div style={{ padding: "14px 20px 18px" }}>
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
      )}

      {step === STEP_DEVICE && (
        <div style={{ padding: "14px 20px 18px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Asset Number *"><input style={fieldStyle()} value={assetNumber} onChange={(e) => setAssetNumber(e.target.value)} placeholder="ETL-LAP-00482" /></Field>
          <Field label="Serial Number"><input style={fieldStyle()} value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} /></Field>
          <Field label="Manufacturer"><input style={fieldStyle()} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="Lenovo" /></Field>
          <Field label="Model"><input style={fieldStyle()} value={model} onChange={(e) => setModel(e.target.value)} placeholder="ThinkPad T14 Gen 5" /></Field>
          <Field label="Operating System"><input style={fieldStyle()} value={os} onChange={(e) => setOs(e.target.value)} placeholder="Windows 11 Enterprise" /></Field>
          <Field label="Hostname"><input style={fieldStyle()} value={hostname} onChange={(e) => setHostname(e.target.value)} /></Field>
          <Field label="IP / Network Details"><input style={fieldStyle()} value={network} onChange={(e) => setNetwork(e.target.value)} /></Field>
          <Field label="Warranty Expiry"><input type="date" style={fieldStyle()} value={warranty} onChange={(e) => setWarranty(e.target.value)} /></Field>
        </div>
      )}

      {step === STEP_CHECKLIST && (
        <div style={{ padding: "14px 20px 18px" }}>
          {checklist.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>No checklist items for this request.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {checklist.map((c, i) => (
                <label key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={c.checked} onChange={(e) => {
                    onSaveChecklist(checklist.map((item, idx) => (idx === i ? { ...item, checked: e.target.checked } : item)));
                  }} />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {step === STEP_SOFTWARE && (
        <div style={{ padding: "14px 20px 18px" }}>
          <table className="ep-table">
            <thead><tr><th>Software</th><th style={{ width: 120 }}>Status</th></tr></thead>
            <tbody>
              {software.map((s, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 13 }}>{s.name}</td>
                  <td>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                      <input type="checkbox" checked={s.status === "INSTALLED"} onChange={(e) => {
                        onSaveSoftware(software.map((item, idx) => (idx === i ? { ...item, status: (e.target.checked ? "INSTALLED" : "PENDING") as "INSTALLED" | "PENDING" } : item)));
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
              onSaveSoftware(next);
            }}>+ Add Software</button>
          </div>
        </div>
      )}

      <div style={{ padding: "0 20px 18px", display: "flex", gap: 8 }}>
        {step > 0 && <button className="ep-btn-outline" onClick={back} disabled={saving}>Back</button>}
        {step < WIZARD_STEPS.length - 1 && <button className="ep-btn" onClick={next} disabled={saving}>Next</button>}
        {step === WIZARD_STEPS.length - 1 && <button className="ep-btn" onClick={finish} disabled={saving}>Finish</button>}
        {alreadySet && <button className="ep-btn-outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>}
      </div>
    </div>
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
          <TimelineRow label="Handed Over" ts={task.handed_over_at} />
          <TimelineRow label="Collection Confirmed by Employee" ts={task.collection_acknowledged_at} by={task.collection_acknowledged_by_name} />
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

// ─── Waiting on the employee ──────────────────────────────────────────────────

function AwaitingConfirmation({ task, text }: { task: Task; text: string }) {
  return (
    <div className="ep-panel" style={{ background: "#f0fdfa", borderColor: "#99f6e4" }}>
      <div style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        <PackageCheck size={20} color="#0f766e" />
        <div style={{ fontSize: 13 }}>
          <div style={{ fontWeight: 600 }}>Waiting for {task.requester_name || "the employee"}</div>
          <div style={{ color: "var(--muted)" }}>{text}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Who provisions Computer Requests (set once) ──────────────────────────────

function ProvisioningPoolPanel() {
  const [userIds, setUserIds] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [members, setMembers] = useState<Array<{ id: string; full_name: string | null }>>([]);
  const [teamOptions, setTeamOptions] = useState<Array<{ id: string; name: string; members: number }>>([]);
  const [directory, setDirectory] = useState<Array<{ id: string; full_name: string | null; email: string }>>([]);
  const [menu, setMenu] = useState<{ top: number; left: number; width: number } | null>(null);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  async function load() {
    const r: any = await api.itProvisioningDefaultAssignees();
    setUserIds((r?.users || []).map((u: any) => u.id));
    setTeamIds((r?.teams || []).map((t: any) => t.id));
    setMembers(r?.assignees || []);
    setTeamOptions(r?.team_options || []);
  }
  useEffect(() => {
    void load().catch(() => {});
    api.companyDirectory().then((rows: any) => setDirectory(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);

  // The menu is portalled to <body> with fixed positioning so no panel's
  // overflow can clip it; it closes on outside click, Escape, scroll or resize.
  useEffect(() => {
    if (!menu) return;
    const close = () => { setMenu(null); setFilter(""); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onScroll = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  function openMenu() {
    if (menu) { setMenu(null); return; }
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(360, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16));
    const top = window.innerHeight - r.bottom > 300 ? r.bottom + 4 : Math.max(16, r.top - 364);
    setFilter("");
    setMenu({ top, left, width });
  }

  async function save(nextUsers: string[], nextTeams: string[]) {
    setUserIds(nextUsers);
    setTeamIds(nextTeams);
    setSaving(true);
    try {
      await api.itProvisioningSetDefaultAssignees(nextUsers, nextTeams);
      await load();
    } catch (e: any) {
      alert(e.message || "Failed to save");
      await load().catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const q = filter.toLowerCase().trim();
  const teams = teamOptions.filter((t) => !q || t.name.toLowerCase().includes(q));
  const people = [...directory]
    .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email))
    .filter((u) => !q || (u.full_name || u.email).toLowerCase().includes(q))
    .slice(0, q ? 50 : 30);
  const chips = [
    ...teamOptions.filter((t) => teamIds.includes(t.id)).map((t) => ({ kind: "team" as const, id: t.id, label: `${t.name} team`, sub: `${t.members}` })),
    ...userIds.map((id) => ({ kind: "user" as const, id, label: directory.find((u) => u.id === id)?.full_name || members.find((m) => m.id === id)?.full_name || "…", sub: "" }))
  ];

  const summary = members.length === 0
    ? "Nobody yet — new requests arrive unassigned."
    : members.length === 1
    ? `Every new request is assigned to ${members[0].full_name} automatically.`
    : `New requests are emailed to all ${members.length} people; the first to claim one does the provisioning.`;

  const row = (key: string, checked: boolean, onChange: () => void, icon: React.ReactNode, label: string, sub?: string) => (
    <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", fontSize: 13, cursor: "pointer", borderRadius: 6 }}>
      <input type="checkbox" checked={checked} disabled={saving} onChange={onChange} />
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {sub && <span style={{ color: "var(--muted)", fontSize: 12 }}>{sub}</span>}
    </label>
  );
  const groupTitle = (t: string) => (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--muted)", padding: "8px 8px 4px" }}>{t}</div>
  );

  return (
    <div className="ep-panel" style={{ marginBottom: 14 }}>
      <div style={{ padding: "12px 20px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Who provisions Computer Requests</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
          Set this once. Approved Computer Requests go straight to these teams and people — no need to assign each one.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, border: "1px solid var(--border)", borderRadius: 8, padding: 6, background: "var(--surface)" }}>
          {chips.map((c) => (
            <span key={c.kind + c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, background: c.kind === "team" ? "#e0e7ff" : "#f1f5f9", color: c.kind === "team" ? "#3730a3" : "#0f172a" }}>
              {c.kind === "team" ? <Users size={13} /> : <User size={13} />}
              {c.label}
              {c.sub && <span style={{ fontWeight: 400, opacity: 0.75 }}>· {c.sub}</span>}
              <button
                type="button"
                aria-label={`Remove ${c.label}`}
                disabled={saving}
                onClick={() => void (c.kind === "team" ? save(userIds, teamIds.filter((x) => x !== c.id)) : save(userIds.filter((x) => x !== c.id), teamIds))}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: 2, display: "inline-flex", color: "inherit" }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <button ref={buttonRef} type="button" className="ep-btn-outline" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", fontSize: 12 }} onClick={openMenu}>
            <Plus size={13} /> Add team or person
          </button>
        </div>
        <div style={{ fontSize: 12, marginTop: 8, color: members.length ? "#065f46" : "#b45309" }}>
          {summary}
          {members.length > 1 && <span style={{ color: "var(--muted)" }}> ({members.map((m) => m.full_name).join(", ")})</span>}
        </div>
      </div>

      {menu && createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed", top: menu.top, left: menu.left, width: menu.width, zIndex: 10000,
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10,
            boxShadow: "0 12px 32px rgba(15,23,42,0.18)", display: "flex", flexDirection: "column", maxHeight: 360
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
            <div className="ep-search">
              <Search size={14} />
              <input placeholder="Search teams and people…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
            </div>
          </div>
          <div style={{ overflowY: "auto", padding: "0 4px 6px" }}>
            {teams.length > 0 && groupTitle("Teams")}
            {teams.map((t) => row("t" + t.id, teamIds.includes(t.id), () => void save(userIds, toggle(teamIds, t.id)), <Users size={14} color="#4f46e5" />, t.name, `${t.members} ${t.members === 1 ? "person" : "people"}`))}
            {people.length > 0 && groupTitle("People")}
            {people.map((u) => row("u" + u.id, userIds.includes(u.id), () => void save(toggle(userIds, u.id), teamIds), <User size={14} color="#64748b" />, u.full_name || u.email))}
            {!teams.length && !people.length && <div style={{ padding: 12, fontSize: 13, color: "var(--muted)" }}>No teams or people match "{filter}".</div>}
            {!q && directory.length > people.length && <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--muted)" }}>Type to search all {directory.length} people.</div>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Computer Request default approvers ───────────────────────────────────────

type ApproverDefaultStep = {
  index: number;
  title: string;
  roles: string[];
  default_approver_id: string | null;
  candidates: Array<{ id: string; full_name: string | null; title: string | null; role: string }>;
};

// Pre-fills the Computer Request's IT Manager / IS HOD/CIO / CTO steps for
// every requester; they can still pick someone else on the form.
function ApproverDefaultsPanel() {
  const [steps, setSteps] = useState<ApproverDefaultStep[]>([]);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

  useEffect(() => {
    api.itProvisioningApproverDefaults().then((r: any) => setSteps(r?.steps || [])).catch(() => setSteps([]));
  }, []);

  async function save(index: number, approverId: string) {
    const previous = steps;
    setSteps((prev) => prev.map((st) => (st.index === index ? { ...st, default_approver_id: approverId || null } : st)));
    setSavingIndex(index);
    try {
      await api.itProvisioningSetApproverDefaults([{ index, approver_id: approverId || null }]);
    } catch (e: any) {
      setSteps(previous);
      alert(e.message || "Failed to save default approver");
    } finally {
      setSavingIndex(null);
    }
  }

  if (!steps.length) return null;
  return (
    <div className="ep-panel" style={{ marginBottom: 14 }}>
      <div style={{ padding: "12px 20px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Computer Request Approvers</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
          Pre-selected on every new Computer Request. The requester's manager is found automatically; requesters can still change any of these.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {steps.map((st) => (
            <Field key={st.index} label={st.title}>
              <select style={fieldStyle()} value={st.default_approver_id || ""} disabled={savingIndex === st.index} onChange={(e) => void save(st.index, e.target.value)}>
                <option value="">No default — requester picks</option>
                {st.candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.full_name || c.id}{c.title ? ` — ${c.title}` : ""}</option>
                ))}
              </select>
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Inventory ────────────────────────────────────────────────────────────────

const DEVICE_STATUS_LABEL: Record<string, string> = {
  IN_STOCK: "In Stock",
  ASSIGNED: "Assigned",
  IN_REPAIR: "In Repair",
  DISPOSED: "Disposed"
};
const DEVICE_STATUS_STYLE: Record<string, [string, string]> = {
  IN_STOCK: ["#dbeafe", "#1d4ed8"],
  ASSIGNED: ["#d1fae5", "#065f46"],
  IN_REPAIR: ["#fef3c7", "#92400e"],
  DISPOSED: ["#f1f5f9", "#64748b"]
};

function DeviceStatusBadge({ status }: { status: string }) {
  const [bg, color] = DEVICE_STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{DEVICE_STATUS_LABEL[status] || status}</span>;
}

type DeviceForm = {
  id?: string;
  asset_number: string; serial_number: string; manufacturer: string; model: string; computer_type: string;
  operating_system: string; hostname: string; warranty_expiry: string; location: string; notes: string;
  status: string; assigned_user_id: string;
};

const EMPTY_DEVICE: DeviceForm = {
  asset_number: "", serial_number: "", manufacturer: "", model: "", computer_type: "LAPTOP",
  operating_system: "", hostname: "", warranty_expiry: "", location: "", notes: "", status: "IN_STOCK", assigned_user_id: ""
};

function Inventory({ onBack }: { onBack: () => void }) {
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [editing, setEditing] = useState<DeviceForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [directory, setDirectory] = useState<Array<{ id: string; full_name: string | null; email: string }>>([]);

  async function load() {
    setLoading(true);
    try {
      const r: any = await api.itProvisioningDevices();
      setDevices(r.items || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    api.companyDirectory().then((rows: any) => setDirectory(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { IN_STOCK: 0, ASSIGNED: 0, IN_REPAIR: 0, DISPOSED: 0 };
    for (const d of devices) c[d.status] = (c[d.status] || 0) + 1;
    return c;
  }, [devices]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return devices.filter((d) =>
      (!statusFilter || d.status === statusFilter) &&
      (!typeFilter || d.computer_type === typeFilter) &&
      (!q ||
        (d.asset_number || "").toLowerCase().includes(q) ||
        (d.serial_number || "").toLowerCase().includes(q) ||
        (d.model || "").toLowerCase().includes(q) ||
        (d.assigned_user_name || "").toLowerCase().includes(q))
    );
  }, [devices, search, statusFilter, typeFilter]);

  const sortedDirectory = useMemo(
    () => [...directory].sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email)),
    [directory]
  );

  function openEdit(d: any) {
    setFormError(null);
    setEditing({
      id: d.id, asset_number: d.asset_number || "", serial_number: d.serial_number || "", manufacturer: d.manufacturer || "",
      model: d.model || "", computer_type: d.computer_type || "", operating_system: d.operating_system || "", hostname: d.hostname || "",
      warranty_expiry: d.warranty_expiry ? String(d.warranty_expiry).slice(0, 10) : "", location: d.location || "", notes: d.notes || "",
      status: d.status || "IN_STOCK", assigned_user_id: d.assigned_user_id || ""
    });
  }

  async function saveDevice() {
    if (!editing) return;
    setSaving(true);
    setFormError(null);
    const payload = {
      ...editing,
      computer_type: editing.computer_type || null,
      warranty_expiry: editing.warranty_expiry || null,
      assigned_user_id: editing.status === "ASSIGNED" ? editing.assigned_user_id || null : null
    };
    delete (payload as any).id;
    try {
      if (editing.id) await api.itProvisioningUpdateDevice(editing.id, payload);
      else await api.itProvisioningCreateDevice(payload);
      setEditing(null);
      await load();
    } catch (e: any) {
      setFormError(e.message || "Failed to save device");
    } finally {
      setSaving(false);
    }
  }

  function exportCsv() {
    const headers = ["Asset Number", "Serial Number", "Manufacturer", "Model", "Type", "OS", "Hostname", "Status", "Assigned To", "Department", "Location", "Warranty Expiry", "Notes"];
    const rows = filtered.map((d) => [d.asset_number, d.serial_number || "", d.manufacturer || "", d.model || "", d.computer_type || "", d.operating_system || "", d.hostname || "", DEVICE_STATUS_LABEL[d.status] || d.status, d.assigned_user_name || "", d.assigned_user_department || "", d.location || "", fmtDate(d.warranty_expiry), d.notes || ""]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `it-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  const set = (patch: Partial<DeviceForm>) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>IT Provisioning</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Inventory</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Inventory</h1>
          <p className="ep-subtitle">Every computer IT holds or has issued: stock, assigned, in repair and disposed.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={onBack}><ArrowLeft size={14} /> Back</button>
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export</button>
          <button className="ep-btn" onClick={() => { setFormError(null); setEditing({ ...EMPTY_DEVICE }); }}><Plus size={14} /> Add Device</button>
        </div>
      </div>

      <div className="ep-kpi-row">
        {(["IN_STOCK", "ASSIGNED", "IN_REPAIR", "DISPOSED"] as const).map((st) => (
          <div key={st} className="ep-kpi" style={{ cursor: "pointer", outline: statusFilter === st ? "2px solid #2563eb" : undefined }} onClick={() => setStatusFilter(statusFilter === st ? "" : st)}>
            <div><div className="ep-kpi-value">{counts[st] || 0}</div><div className="ep-kpi-label">{DEVICE_STATUS_LABEL[st]}</div></div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="ep-panel" style={{ marginBottom: 14 }}>
          <div className="ep-panel-head"><div className="ep-panel-title">{editing.id ? `Edit ${editing.asset_number}` : "Add Device"}</div></div>
          <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            <Field label="Asset Number *"><input style={fieldStyle()} value={editing.asset_number} onChange={(e) => set({ asset_number: e.target.value })} /></Field>
            <Field label="Serial Number"><input style={fieldStyle()} value={editing.serial_number} onChange={(e) => set({ serial_number: e.target.value })} /></Field>
            <Field label="Type">
              <select style={fieldStyle()} value={editing.computer_type} onChange={(e) => set({ computer_type: e.target.value })}>
                <option value="">—</option><option value="LAPTOP">Laptop</option><option value="DESKTOP">Desktop</option>
              </select>
            </Field>
            <Field label="Manufacturer"><input style={fieldStyle()} value={editing.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} /></Field>
            <Field label="Model"><input style={fieldStyle()} value={editing.model} onChange={(e) => set({ model: e.target.value })} /></Field>
            <Field label="Operating System"><input style={fieldStyle()} value={editing.operating_system} onChange={(e) => set({ operating_system: e.target.value })} /></Field>
            <Field label="Hostname"><input style={fieldStyle()} value={editing.hostname} onChange={(e) => set({ hostname: e.target.value })} /></Field>
            <Field label="Warranty Expiry"><input type="date" style={fieldStyle()} value={editing.warranty_expiry} onChange={(e) => set({ warranty_expiry: e.target.value })} /></Field>
            <Field label="Location"><input style={fieldStyle()} value={editing.location} onChange={(e) => set({ location: e.target.value })} placeholder="e.g. IT store room" /></Field>
            <Field label="Status *">
              <select style={fieldStyle()} value={editing.status} onChange={(e) => set({ status: e.target.value })}>
                {Object.entries(DEVICE_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            {editing.status === "ASSIGNED" && (
              <Field label="Assigned To *">
                <select style={fieldStyle()} value={editing.assigned_user_id} onChange={(e) => set({ assigned_user_id: e.target.value })}>
                  <option value="">Select employee</option>
                  {sortedDirectory.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
                </select>
              </Field>
            )}
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Notes"><textarea style={{ ...fieldStyle(), minHeight: 50 }} value={editing.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
            </div>
          </div>
          {formError && <div style={{ color: "#b91c1c", fontSize: 13, padding: "0 20px 8px" }}>{formError}</div>}
          <div style={{ padding: "0 20px 16px", display: "flex", gap: 8 }}>
            <button className="ep-btn" onClick={() => void saveDevice()} disabled={saving || !editing.asset_number.trim() || (editing.status === "ASSIGNED" && !editing.assigned_user_id)}>{saving ? "Saving…" : "Save Device"}</button>
            <button className="ep-btn-outline" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
          </div>
        </div>
      )}

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ padding: "14px 20px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px", maxWidth: 320 }}>
            <Search size={14} />
            <input placeholder="Search asset, serial, model, employee…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="ep-form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            {Object.entries(DEVICE_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="ep-form-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All Types</option><option value="LAPTOP">Laptop</option><option value="DESKTOP">Desktop</option>
          </select>
        </div>
      </div>
      <div className="ep-panel">
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><RefreshCw size={20} className="rl-spin" /><p>Loading inventory…</p></div>
          ) : filtered.length === 0 ? (
            <div className="ep-empty"><HardDrive size={32} style={{ opacity: 0.25 }} /><p>{devices.length ? "No devices match your filters." : "No devices recorded yet. Add stock with Add Device."}</p></div>
          ) : (
            <table className="ep-table">
              <thead><tr><th>Asset Number</th><th>Serial</th><th>Model</th><th>Type</th><th>Status</th><th>Assigned To</th><th>Location</th><th>Warranty</th><th /></tr></thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{d.asset_number}</td>
                    <td style={{ fontSize: 13 }}>{d.serial_number || "—"}</td>
                    <td style={{ fontSize: 13 }}>{[d.manufacturer, d.model].filter(Boolean).join(" ") || "—"}</td>
                    <td style={{ fontSize: 13 }}>{d.computer_type === "LAPTOP" ? "Laptop" : d.computer_type === "DESKTOP" ? "Desktop" : "—"}</td>
                    <td><DeviceStatusBadge status={d.status} /></td>
                    <td style={{ fontSize: 13 }}>{d.assigned_user_name || "—"}{d.assigned_user_department ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{d.assigned_user_department}</div> : null}</td>
                    <td style={{ fontSize: 13 }}>{d.location || "—"}</td>
                    <td style={{ fontSize: 13 }}>{fmtDate(d.warranty_expiry)}</td>
                    <td><button className="ep-btn-outline" style={{ padding: "3px 8px" }} onClick={() => openEdit(d)}><Pencil size={13} /> Edit</button></td>
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
