import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { confirmAction } from "./alerts";
import SlaReminderSettings from "./SlaReminderSettings";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Edit3,
  Eye,
  FileText,
  Layers,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Trash2,
  UserCheck,
  Users,
  X,
  Zap,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type RTStatus = "DRAFT" | "ACTIVE" | "INACTIVE";

type RequestType = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  category: string | null;
  status: RTStatus;
  field_count: number;
  permission_count: number;
  created_at: string;
  updated_at: string;
};

type TableFieldConfig = {
  columnMode: "DAY_OF_MONTH" | "FIXED";
  monthFieldKey?: string;
  columns?: { key: string; label: string }[];
  rowSource: "FREE_TEXT" | "SELF";
  cellOptions: { value: string; label: string }[];
  summaryColumns: { key: string; label: string; countsValue: string }[];
};

function emptyTableConfig(): TableFieldConfig {
  return { columnMode: "DAY_OF_MONTH", monthFieldKey: "", rowSource: "FREE_TEXT", cellOptions: [], summaryColumns: [] };
}

type FormField = {
  id?: string;
  field_key: string;
  field_label: string;
  field_type: "text" | "number" | "date" | "select" | "textarea" | "checkbox" | "file" | "table";
  is_required: boolean;
  placeholder: string;
  options: { label: string; value: string }[];
  table_config?: TableFieldConfig;
  sort_order: number;
};

type Permission = {
  id: string;
  permission_type: "ALL" | "DEPARTMENT" | "USER" | "EMPLOYMENT_TYPE";
  department: string | null;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  employment_type: string | null;
  can_submit: boolean;
  can_design: boolean;
};

type Tab = "details" | "fields" | "permissions" | "preview";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIELD_TYPES = ["text", "number", "date", "select", "textarea", "checkbox", "file", "table"] as const;
const FIELD_TYPE_LABELS: Record<string, string> = {
  text: "Text Input", number: "Number", date: "Date Picker",
  select: "Dropdown Select", textarea: "Long Text", checkbox: "Checkbox", file: "File Upload",
  table: "Table / Grid"
};
type DeptRow = { id: string; name: string; section_id: string | null; section_name: string | null };
const COLORS = ["#2563eb", "#7c3aed", "#059669", "#d97706", "#dc2626", "#0891b2", "#be185d"];
const ICONS = ["📋", "✈️", "🏨", "💼", "📊", "🔧", "📝", "💰", "🏢", "📦"];

function statusPill(s: RTStatus) {
  const cls = s === "ACTIVE" ? "status-pill status-pill-success" : s === "DRAFT" ? "status-pill status-pill-warning" : "status-pill status-pill-danger";
  return <span className={cls}>{s}</span>;
}

function emptyField(order: number): FormField {
  return { field_key: "", field_label: "", field_type: "text", is_required: false, placeholder: "", options: [], sort_order: order };
}

function slugify(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// ─── Form Field Designer Row ─────────────────────────────────────────────────

function FieldRow({ field, index, total, allFields, onChange, onRemove, onMove }: {
  field: FormField;
  index: number;
  total: number;
  allFields: FormField[];
  onChange: (f: FormField) => void;
  onRemove: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const [showOptions, setShowOptions] = useState(false);
  const [newOptLabel, setNewOptLabel] = useState("");
  const [newOptValue, setNewOptValue] = useState("");
  const [newCellLabel, setNewCellLabel] = useState("");
  const [newCellValue, setNewCellValue] = useState("");
  const [newSummaryLabel, setNewSummaryLabel] = useState("");
  const [newSummaryCounts, setNewSummaryCounts] = useState("");

  const table = field.table_config ?? emptyTableConfig();
  function updateTable(patch: Partial<TableFieldConfig>) {
    onChange({ ...field, table_config: { ...table, ...patch } });
  }
  const siblingDateFields = allFields.filter((f) => f.field_type === "date" && f.field_key && f !== field);

  return (
    <div className="rt-field-row">
      <div className="rt-field-row-head">
        <span className="rt-field-order">{index + 1}</span>
        <div className="rt-field-row-body">
          <div className="ep-form-row" style={{ marginBottom: 8 }}>
            <div className="ep-form-group" style={{ marginBottom: 0 }}>
              <label>Label <span className="ep-required">*</span></label>
              <input
                className="ep-form-input"
                value={field.field_label}
                placeholder="e.g. Purpose of travel"
                onChange={(e) => {
                  const label = e.target.value;
                  onChange({ ...field, field_label: label, field_key: field.field_key || slugify(label) });
                }}
              />
            </div>
            <div className="ep-form-group" style={{ marginBottom: 0 }}>
              <label>Field Key <span className="ep-required">*</span></label>
              <input
                className="ep-form-input"
                value={field.field_key}
                placeholder="PURPOSE_OF_TRAVEL"
                onChange={(e) => onChange({ ...field, field_key: slugify(e.target.value) })}
              />
            </div>
          </div>
          <div className="ep-form-row">
            <div className="ep-form-group" style={{ marginBottom: 0 }}>
              <label>Type</label>
              <select
                className="ep-form-select"
                value={field.field_type}
                onChange={(e) => {
                  const nextType = e.target.value as FormField["field_type"];
                  onChange({ ...field, field_type: nextType, table_config: nextType === "table" ? (field.table_config ?? emptyTableConfig()) : field.table_config });
                }}
              >
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div className="ep-form-group" style={{ marginBottom: 0 }}>
              <label>Placeholder</label>
              <input className="ep-form-input" value={field.placeholder} placeholder="Hint text…" onChange={(e) => onChange({ ...field, placeholder: e.target.value })} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.83rem", cursor: "pointer" }}>
              <input type="checkbox" checked={field.is_required} onChange={(e) => onChange({ ...field, is_required: e.target.checked })} />
              Required field
            </label>
            {field.field_type === "select" && (
              <button type="button" className="ep-btn-outline" style={{ padding: "4px 10px", fontSize: "0.8rem" }} onClick={() => setShowOptions((v) => !v)}>
                {showOptions ? "Hide" : "Edit"} Options ({field.options.length})
              </button>
            )}
          </div>
          {field.field_type === "select" && showOptions && (
            <div className="rt-options-box">
              {field.options.map((opt, oi) => (
                <div key={oi} className="rt-option-row">
                  <span>{opt.label}</span><span className="rt-option-value">{opt.value}</span>
                  <button type="button" onClick={() => onChange({ ...field, options: field.options.filter((_, i) => i !== oi) })}><X size={12} /></button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input className="ep-form-input" style={{ flex: 1 }} placeholder="Label" value={newOptLabel} onChange={(e) => setNewOptLabel(e.target.value)} />
                <input className="ep-form-input" style={{ flex: 1 }} placeholder="Value" value={newOptValue} onChange={(e) => setNewOptValue(e.target.value)} />
                <button type="button" className="ep-btn" style={{ padding: "6px 12px" }} onClick={() => {
                  if (!newOptLabel.trim()) return;
                  onChange({ ...field, options: [...field.options, { label: newOptLabel.trim(), value: newOptValue.trim() || slugify(newOptLabel.trim()) }] });
                  setNewOptLabel(""); setNewOptValue("");
                }}>Add</button>
              </div>
            </div>
          )}
          {field.field_type === "table" && (
            <div className="rt-options-box" style={{ display: "grid", gap: 12 }}>
              <div className="ep-form-row">
                <div className="ep-form-group" style={{ marginBottom: 0 }}>
                  <label>Columns</label>
                  <select className="ep-form-select" value={table.columnMode} onChange={(e) => updateTable({ columnMode: e.target.value as TableFieldConfig["columnMode"] })}>
                    <option value="DAY_OF_MONTH">One column per day of month</option>
                    <option value="FIXED">Fixed column list</option>
                  </select>
                </div>
                {table.columnMode === "DAY_OF_MONTH" && (
                  <div className="ep-form-group" style={{ marginBottom: 0 }}>
                    <label>Month comes from field</label>
                    <select className="ep-form-select" value={table.monthFieldKey || ""} onChange={(e) => updateTable({ monthFieldKey: e.target.value })}>
                      <option value="">Select a date field…</option>
                      {siblingDateFields.map((f) => <option key={f.field_key} value={f.field_key}>{f.field_label || f.field_key}</option>)}
                    </select>
                  </div>
                )}
                <div className="ep-form-group" style={{ marginBottom: 0 }}>
                  <label>Row source</label>
                  <select className="ep-form-select" value={table.rowSource} onChange={(e) => updateTable({ rowSource: e.target.value as TableFieldConfig["rowSource"] })}>
                    <option value="SELF">Each employee fills only their own row</option>
                    <option value="FREE_TEXT">Free-text rows (requester adds anyone)</option>
                  </select>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 700, fontSize: "0.83rem", marginBottom: 6 }}>Cell codes ({table.cellOptions.length})</div>
                {table.cellOptions.map((opt, oi) => (
                  <div key={oi} className="rt-option-row">
                    <span>{opt.value}</span><span className="rt-option-value">{opt.label}</span>
                    <button type="button" onClick={() => updateTable({ cellOptions: table.cellOptions.filter((_, i) => i !== oi) })}><X size={12} /></button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <input className="ep-form-input" style={{ flex: "0 0 70px" }} placeholder="Code" value={newCellValue} onChange={(e) => setNewCellValue(e.target.value)} />
                  <input className="ep-form-input" style={{ flex: 1 }} placeholder="Meaning" value={newCellLabel} onChange={(e) => setNewCellLabel(e.target.value)} />
                  <button type="button" className="ep-btn" style={{ padding: "6px 12px" }} onClick={() => {
                    if (!newCellValue.trim() || !newCellLabel.trim()) return;
                    updateTable({ cellOptions: [...table.cellOptions, { value: newCellValue.trim().toUpperCase(), label: newCellLabel.trim() }] });
                    setNewCellValue(""); setNewCellLabel("");
                  }}>Add</button>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 700, fontSize: "0.83rem", marginBottom: 6 }}>Auto-summed columns ({table.summaryColumns.length})</div>
                {table.summaryColumns.map((opt, oi) => (
                  <div key={oi} className="rt-option-row">
                    <span>{opt.label}</span><span className="rt-option-value">counts "{opt.countsValue}"</span>
                    <button type="button" onClick={() => updateTable({ summaryColumns: table.summaryColumns.filter((_, i) => i !== oi) })}><X size={12} /></button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <input className="ep-form-input" style={{ flex: 1 }} placeholder="Column label (e.g. Sick Leave)" value={newSummaryLabel} onChange={(e) => setNewSummaryLabel(e.target.value)} />
                  <select className="ep-form-select" style={{ flex: "0 0 140px" }} value={newSummaryCounts} onChange={(e) => setNewSummaryCounts(e.target.value)}>
                    <option value="">Counts code…</option>
                    {table.cellOptions.map((o) => <option key={o.value} value={o.value}>{o.value} — {o.label}</option>)}
                  </select>
                  <button type="button" className="ep-btn" style={{ padding: "6px 12px" }} onClick={() => {
                    if (!newSummaryLabel.trim() || !newSummaryCounts) return;
                    updateTable({ summaryColumns: [...table.summaryColumns, { key: slugify(newSummaryLabel.trim()).toLowerCase(), label: newSummaryLabel.trim(), countsValue: newSummaryCounts }] });
                    setNewSummaryLabel(""); setNewSummaryCounts("");
                  }}>Add</button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="rt-field-row-actions">
          <button type="button" className="ep-icon-btn" onClick={() => onMove("up")} disabled={index === 0} title="Move up"><ArrowUp size={13} /></button>
          <button type="button" className="ep-icon-btn" onClick={() => onMove("down")} disabled={index === total - 1} title="Move down"><ArrowDown size={13} /></button>
          <button type="button" className="ep-icon-btn" style={{ color: "#dc2626" }} onClick={onRemove} title="Remove field"><Trash2 size={13} /></button>
        </div>
      </div>
    </div>
  );
}

// ─── Form Preview ─────────────────────────────────────────────────────────────

function FormPreview({ fields }: { fields: FormField[] }) {
  if (!fields.length) return (
    <div className="ep-empty"><FileText size={28} style={{ opacity: 0.25 }} /><p>No fields defined yet. Add fields in the Form Designer tab.</p></div>
  );
  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 560 }}>
      {fields.map((f) => (
        <div key={f.field_key || f.sort_order} className="ep-form-group" style={{ marginBottom: 0 }}>
          <label>{f.field_label || "(untitled)"}{f.is_required && <span className="ep-required"> *</span>}</label>
          {f.field_type === "text" && <input className="ep-form-input" placeholder={f.placeholder || ""} disabled />}
          {f.field_type === "number" && <input type="number" className="ep-form-input" placeholder={f.placeholder || ""} disabled />}
          {f.field_type === "date" && <input type="date" className="ep-form-input" disabled />}
          {f.field_type === "textarea" && <textarea className="ep-form-textarea" rows={3} placeholder={f.placeholder || ""} disabled />}
          {f.field_type === "checkbox" && <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "0.88rem" }}><input type="checkbox" disabled />{f.placeholder || f.field_label}</label>}
          {f.field_type === "file" && <input type="file" className="ep-form-input" disabled />}
          {f.field_type === "select" && (
            <select className="ep-form-select" disabled>
              <option>{f.placeholder || "Select…"}</option>
              {f.options.map((o) => <option key={o.value}>{o.label}</option>)}
            </select>
          )}
          {f.field_type === "table" && (
            <div className="ep-table-wrap">
              <table className="ep-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    {(f.table_config?.columnMode === "DAY_OF_MONTH" ? [1, 2, 3, "…"] : (f.table_config?.columns || []).map((c) => c.label)).map((c, i) => <th key={i}>{c}</th>)}
                    {(f.table_config?.summaryColumns || []).map((c) => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Sample Employee</td>
                    {(f.table_config?.columnMode === "DAY_OF_MONTH" ? [1, 2, 3, "…"] : (f.table_config?.columns || [])).map((_, i) => <td key={i} style={{ color: "var(--muted)" }}>—</td>)}
                    {(f.table_config?.summaryColumns || []).map((c) => <td key={c.key}>0</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RequestTypes({ onNavigate, isAdmin }: { onNavigate?: (page: string) => void; isAdmin?: boolean }) {
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const [moduleFlags, setModuleFlags] = useState<{
    overtime_enabled: boolean; standby_enabled: boolean;
    salary_advance_enabled: boolean; loan_advance_enabled: boolean;
    salary_advance_max_payback_months: number; loan_advance_max_payback_months: number;
    vendor_contracts_enabled: boolean; service_contracts_enabled: boolean;
    signature_enabled: boolean; ai_assistant_enabled: boolean;
  }>({
    overtime_enabled: true, standby_enabled: true,
    salary_advance_enabled: true, loan_advance_enabled: true,
    salary_advance_max_payback_months: 6, loan_advance_max_payback_months: 6,
    vendor_contracts_enabled: true, service_contracts_enabled: true,
    signature_enabled: true, ai_assistant_enabled: true
  });
  const [savingMaxMonths, setSavingMaxMonths] = useState<"salary_advance_max_payback_months" | "loan_advance_max_payback_months" | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCode, setCreateCode] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createCategory, setCreateCategory] = useState("");
  const [createColor, setCreateColor] = useState(COLORS[0]);
  const [createIcon, setCreateIcon] = useState(ICONS[0]);
  const [createStatus, setCreateStatus] = useState<RTStatus>("DRAFT");
  const [creating, setCreating] = useState(false);

  // Detail modal
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [detailTab, setDetailTab] = useState<Tab>("details");
  const [detailLoading, setDetailLoading] = useState(false);
  const [fields, setFields] = useState<FormField[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [savingFields, setSavingFields] = useState(false);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [allDepts, setAllDepts] = useState<string[]>([]);
  const [allEmploymentTypes, setAllEmploymentTypes] = useState<{ code: string; name: string }[]>([]);
  const [newPermType, setNewPermType] = useState<"ALL" | "DEPARTMENT" | "USER" | "EMPLOYMENT_TYPE">("ALL");
  const [newPermDept, setNewPermDept] = useState("");
  const [newPermEmploymentType, setNewPermEmploymentType] = useState("");
  const [newPermUserId, setNewPermUserId] = useState("");
  const [newPermSubmit, setNewPermSubmit] = useState(true);
  const [newPermDesign, setNewPermDesign] = useState(false);
  const [addingPerm, setAddingPerm] = useState(false);
  const [editMeta, setEditMeta] = useState(false);
  const [editMetaData, setEditMetaData] = useState<any>({});
  const [newApproverTitle, setNewApproverTitle] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [deptSections, setDeptSections] = useState<DeptRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, ds, flags] = await Promise.all([
        api.requestTypes(),
        api.departmentsWithSections().catch(() => []),
        api.moduleFlags().catch(() => ({
          overtime_enabled: true, standby_enabled: true,
          salary_advance_enabled: true, loan_advance_enabled: true,
          salary_advance_max_payback_months: 6, loan_advance_max_payback_months: 6,
          vendor_contracts_enabled: true, service_contracts_enabled: true,
          signature_enabled: true, ai_assistant_enabled: true
        }))
      ]);
      setRequestTypes(Array.isArray(data) ? data : []);
      setDeptSections(Array.isArray(ds) ? ds : []);
      setModuleFlags({
        overtime_enabled: flags?.overtime_enabled !== false,
        standby_enabled: flags?.standby_enabled !== false,
        salary_advance_enabled: flags?.salary_advance_enabled !== false,
        loan_advance_enabled: flags?.loan_advance_enabled !== false,
        salary_advance_max_payback_months: Number(flags?.salary_advance_max_payback_months) || 6,
        loan_advance_max_payback_months: Number(flags?.loan_advance_max_payback_months) || 6,
        vendor_contracts_enabled: flags?.vendor_contracts_enabled !== false,
        service_contracts_enabled: flags?.service_contracts_enabled !== false,
        signature_enabled: flags?.signature_enabled !== false,
        ai_assistant_enabled: flags?.ai_assistant_enabled !== false
      });
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggleModule(key: "overtime_enabled" | "standby_enabled" | "salary_advance_enabled" | "loan_advance_enabled" | "vendor_contracts_enabled" | "service_contracts_enabled" | "signature_enabled" | "ai_assistant_enabled") {
    const next = !moduleFlags[key];
    setModuleFlags((f) => ({ ...f, [key]: next }));
    try {
      await api.updateModuleFlags({ [key]: next });
    } catch (err: any) {
      setModuleFlags((f) => ({ ...f, [key]: !next }));
      alert(err?.message || "Failed to update module status.");
    }
  }

  async function saveMaxMonths(key: "salary_advance_max_payback_months" | "loan_advance_max_payback_months", value: number) {
    if (!Number.isInteger(value) || value < 1) return;
    const previous = moduleFlags[key];
    setModuleFlags((f) => ({ ...f, [key]: value }));
    setSavingMaxMonths(key);
    try {
      await api.updateModuleFlags({ [key]: value });
    } catch (err: any) {
      setModuleFlags((f) => ({ ...f, [key]: previous }));
      alert(err?.message || "Failed to update payback duration.");
    } finally {
      setSavingMaxMonths(null);
    }
  }

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setRowMenuId(null);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  async function openDetail(id: string) {
    setDetailId(id);
    setDetailTab("details");
    setDetailLoading(true);
    try {
      const [detail, users, depts, empTypes] = await Promise.all([
        api.requestTypeDetail(id),
        api.adminUsers(),
        api.departments(),
        api.employmentTypes(),
      ]);
      setAllEmploymentTypes(Array.isArray(empTypes) ? empTypes : []);
      setDetailData(detail);
      setFields(detail.fields?.map((f: any, i: number) => ({
        ...f,
        options: f.field_type === "table" ? [] : (f.options || []),
        table_config: f.field_type === "table" ? (f.options || emptyTableConfig()) : undefined,
        sort_order: f.sort_order ?? i,
        placeholder: f.placeholder || "",
      })) || []);
      setPermissions(detail.permissions || []);
      setAllUsers(Array.isArray(users) ? users : []);
      setAllDepts(Array.isArray(depts) ? depts.map((d: any) => d.name).filter(Boolean) : []);
      setEditMetaData({ name: detail.name, description: detail.description || "", icon: detail.icon || ICONS[0], color: detail.color || COLORS[0], category: detail.category || "", status: detail.status, approver_title_options: detail.approver_title_options || [] });
    } catch { /* ignore */ }
    finally { setDetailLoading(false); }
  }

  function closeDetail() { setDetailId(null); setDetailData(null); setEditMeta(false); }

  async function handleCreate() {
    if (!createName.trim() || !createCode.trim()) { alert("Name and Code are required."); return; }
    setCreating(true);
    try {
      await api.createRequestType({ name: createName, code: createCode, description: createDesc || null, icon: createIcon, color: createColor, category: createCategory || null, status: createStatus });
      setShowCreate(false);
      setCreateName(""); setCreateCode(""); setCreateDesc(""); setCreateCategory(""); setCreateStatus("DRAFT");
      await load();
    } catch (e: any) { alert("Error: " + e.message); }
    finally { setCreating(false); }
  }

  async function handleSaveFields() {
    if (!detailId) return;
    setSavingFields(true);
    try {
      const payload = fields.map((f) => ({
        ...f,
        options: f.field_type === "table" ? f.table_config : f.options
      }));
      await api.updateRequestTypeFields(detailId, payload);
      alert("Fields saved.");
      await openDetail(detailId);
    } catch (e: any) { alert("Error: " + e.message); }
    finally { setSavingFields(false); }
  }

  async function handleSaveMeta() {
    if (!detailId) return;
    setSavingMeta(true);
    try {
      await api.updateRequestType(detailId, editMetaData);
      setEditMeta(false);
      await openDetail(detailId);
      await load();
    } catch (e: any) { alert("Error: " + e.message); }
    finally { setSavingMeta(false); }
  }

  async function handleAddPermission() {
    if (!detailId) return;
    setAddingPerm(true);
    try {
      await api.addRequestTypePermission(detailId, {
        permission_type: newPermType,
        department: newPermType === "DEPARTMENT" ? newPermDept : null,
        user_id: newPermType === "USER" ? newPermUserId : null,
        employment_type: newPermType === "EMPLOYMENT_TYPE" ? newPermEmploymentType : null,
        can_submit: newPermSubmit,
        can_design: newPermDesign,
      });
      await openDetail(detailId);
      setNewPermType("ALL"); setNewPermDept(""); setNewPermUserId(""); setNewPermEmploymentType("");
    } catch (e: any) { alert("Error: " + e.message); }
    finally { setAddingPerm(false); }
  }

  async function handleRemovePermission(permId: string) {
    if (!detailId) return;
    const confirmed = await confirmAction({
      title: "Remove permission?",
      text: "Remove this permission?",
      confirmButtonText: "Remove"
    });
    if (!confirmed) return;
    try {
      await api.removeRequestTypePermission(detailId, permId);
      await openDetail(detailId);
    } catch (e: any) { alert("Error: " + e.message); }
  }

  async function handleDelete(id: string, name: string) {
    const confirmed = await confirmAction({
      title: "Delete process?",
      text: `Delete "${name}"? This cannot be undone.`,
      confirmButtonText: "Delete"
    });
    if (!confirmed) return;
    try {
      await api.deleteRequestType(id);
      await load();
    } catch (e: any) { alert("Error: " + e.message); }
  }

  function addField() {
    setFields((prev) => [...prev, emptyField(prev.length)]);
  }

  function updateField(index: number, f: FormField) {
    setFields((prev) => prev.map((p, i) => i === index ? f : p));
  }

  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index).map((f, i) => ({ ...f, sort_order: i })));
  }

  function moveField(index: number, dir: "up" | "down") {
    setFields((prev) => {
      const next = [...prev];
      const swap = dir === "up" ? index - 1 : index + 1;
      if (swap < 0 || swap >= next.length) return prev;
      [next[index], next[swap]] = [next[swap], next[index]];
      return next.map((f, i) => ({ ...f, sort_order: i }));
    });
  }

  const filtered = useMemo(() => {
    let rows = requestTypes;
    if (search.trim()) { const q = search.toLowerCase(); rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q) || (r.category || "").toLowerCase().includes(q)); }
    if (categoryFilter) rows = rows.filter((r) => r.category === categoryFilter);
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    return rows;
  }, [requestTypes, search, categoryFilter, statusFilter]);

  const categories = useMemo(() => [...new Set(requestTypes.map((r) => r.category).filter(Boolean))], [requestTypes]);

  const categoryOptionNodes = useMemo(() => {
    if (!deptSections.length) return null;
    const sectionMap = new Map<string, string[]>();
    const noSection: string[] = [];
    for (const d of deptSections) {
      if (d.section_name) {
        const arr = sectionMap.get(d.section_name) ?? [];
        arr.push(d.name);
        sectionMap.set(d.section_name, arr);
      } else {
        noSection.push(d.name);
      }
    }
    return (
      <>
        {[...sectionMap.entries()].map(([sec, depts]) => (
          <optgroup key={sec} label={sec}>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </optgroup>
        ))}
        {noSection.length > 0 && (
          sectionMap.size > 0
            ? <optgroup label="Other Divisions">{noSection.map((d) => <option key={d} value={d}>{d}</option>)}</optgroup>
            : noSection.map((d) => <option key={d} value={d}>{d}</option>)
        )}
      </>
    );
  }, [deptSections]);
  const stats = useMemo(() => ({
    total: requestTypes.length,
    active: requestTypes.filter((r) => r.status === "ACTIVE").length,
    draft: requestTypes.filter((r) => r.status === "DRAFT").length,
    withFields: requestTypes.filter((r) => r.field_count > 0).length,
  }), [requestTypes]);

  return (
    <div className="ep-page">
      {/* ── Breadcrumb ── */}
      <div className="ep-breadcrumb">
        <span>Administration</span><ChevronRight size={13} /><span className="ep-breadcrumb-active">Process</span>
      </div>

      {/* ── Header ── */}
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Process</h1>
          <p className="ep-subtitle">Define custom processes and design their input forms. Assign users or divisions who can submit or design each type.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => void load()}><RefreshCw size={14} />Refresh</button>
          <button className="ep-btn" onClick={() => setShowCreate(true)}><Plus size={15} />New Process</button>
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div className="ep-kpi-row">
        <div className="ep-kpi ep-kpi-blue"><div className="ep-kpi-icon"><Layers size={26} /></div><div><div className="ep-kpi-value">{stats.total}</div><div className="ep-kpi-label">Total Types</div></div></div>
        <div className="ep-kpi ep-kpi-green"><div className="ep-kpi-icon"><Zap size={26} /></div><div><div className="ep-kpi-value">{stats.active}</div><div className="ep-kpi-label">Active</div></div></div>
        <div className="ep-kpi ep-kpi-gold"><div className="ep-kpi-icon"><Edit3 size={26} /></div><div><div className="ep-kpi-value">{stats.draft}</div><div className="ep-kpi-label">Draft</div></div></div>
        <div className="ep-kpi ep-kpi-purple"><div className="ep-kpi-icon"><ClipboardList size={26} /></div><div><div className="ep-kpi-value">{stats.withFields}</div><div className="ep-kpi-label">With Form Fields</div></div></div>
      </div>

      {/* ── Built-in Processes ── */}
      <div className="ep-panel" style={{ marginBottom: 20 }}>
        <div className="ep-panel-head">
          <div className="ep-panel-title">Built-in Processes</div>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>System modules — toggle on/off, admin-only</span>
        </div>
        <div style={{ display: "flex", gap: 12, padding: "14px 18px", flexWrap: "wrap" }}>
          {[
            { icon: "💼", label: "Advance Requests", desc: "Request cash advances for travel and expenses.", page: "MY_REQUESTS", flagKey: null, maxMonthsKey: null },
            { icon: "⏱️", label: "Overtime Requests", desc: "Submit overtime hours for supervisor and management approval.", page: "OVERTIME", flagKey: "overtime_enabled" as const, maxMonthsKey: null },
            { icon: "📞", label: "Standby Requests", desc: "Schedule and claim compensation for standby duty.", page: "STANDBY", flagKey: "standby_enabled" as const, maxMonthsKey: null },
            { icon: "💰", label: "Salary Advance", desc: "Request an advance against salary, repaid over a set number of months.", page: "MY_REQUESTS", flagKey: "salary_advance_enabled" as const, maxMonthsKey: "salary_advance_max_payback_months" as const },
            { icon: "🏦", label: "Loan Advance", desc: "Request a loan, repaid over a set number of months.", page: "MY_REQUESTS", flagKey: "loan_advance_enabled" as const, maxMonthsKey: "loan_advance_max_payback_months" as const },
            { icon: "📄", label: "Vendor Contracts", desc: "Track procurement agreements, payment schedules, and renewals.", page: "VENDOR_CONTRACTS", flagKey: "vendor_contracts_enabled" as const, maxMonthsKey: null },
            { icon: "📶", label: "Service Contracts", desc: "Track individual and company telecom service contracts and their renewals.", page: "SERVICE_CONTRACTS", flagKey: "service_contracts_enabled" as const, maxMonthsKey: null },
            { icon: "✍️", label: "Electronic Signature", desc: "Sign uploaded documents and verify signatures publicly by code.", page: "SIGNATURES", flagKey: "signature_enabled" as const, maxMonthsKey: null },
            // Same on/off as Settings > AI Assistant (which also picks the AI service).
            { icon: "✨", label: "AI Assistant", desc: "Answers questions about requests and drafts them in plain language. The AI service it uses is set in Settings > AI Assistant.", page: "AI_ASSISTANT_CONFIG", flagKey: "ai_assistant_enabled" as const, maxMonthsKey: null },
          ].map((t) => {
            const active = t.flagKey ? moduleFlags[t.flagKey] : true;
            return (
              <div key={t.page + t.label}
                onClick={() => onNavigate?.(t.page)}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px",
                  border: "1px solid var(--border)", borderRadius: 8, cursor: onNavigate ? "pointer" : "default",
                  background: "var(--surface-soft)", flex: "1 1 220px", minWidth: 200, maxWidth: 320,
                  transition: "border-color 0.15s", opacity: active ? 1 : 0.65
                }}
                onMouseEnter={(e) => { if (onNavigate) (e.currentTarget as HTMLDivElement).style.borderColor = "#2563eb"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)"; }}
              >
                <span style={{ fontSize: 24 }}>{t.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{t.label}</div>
                    {t.flagKey && (
                      isAdmin ? (
                        <label
                          onClick={(e) => e.stopPropagation()}
                          style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 500, color: active ? "#059669" : "var(--muted)", cursor: "pointer" }}
                        >
                          <input type="checkbox" checked={active} onChange={() => void toggleModule(t.flagKey!)} style={{ cursor: "pointer" }} />
                          {active ? "Active" : "Inactive"}
                        </label>
                      ) : (
                        <span style={{ fontSize: 11, fontWeight: 500, color: active ? "#059669" : "var(--muted)" }}>{active ? "Active" : "Inactive"}</span>
                      )
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{t.desc}</div>
                  {t.maxMonthsKey && active && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: "var(--muted)" }}
                    >
                      <span>Max payback:</span>
                      {isAdmin ? (
                        <>
                          <input
                            type="number"
                            min={1}
                            max={360}
                            value={moduleFlags[t.maxMonthsKey]}
                            onChange={(e) => setModuleFlags((f) => ({ ...f, [t.maxMonthsKey!]: Number(e.target.value) || 1 }))}
                            onBlur={(e) => void saveMaxMonths(t.maxMonthsKey!, Number(e.target.value) || 1)}
                            disabled={savingMaxMonths === t.maxMonthsKey}
                            style={{ width: 48, padding: "2px 4px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4 }}
                          />
                          <span>months</span>
                        </>
                      ) : (
                        <strong>{moduleFlags[t.maxMonthsKey]} months</strong>
                      )}
                    </div>
                  )}
                  {onNavigate && <div style={{ fontSize: 12, color: "#2563eb", marginTop: 6, fontWeight: 500 }}>Open →</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <SlaReminderSettings isAdmin={isAdmin} />

      {/* ── Custom Processes Table ── */}
      <div className="ep-panel">
        <div className="ep-panel-head">
          <div className="ep-panel-title">All Processes</div>
          <div className="ep-filter-bar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div className="ep-search"><Search size={14} /><input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            <select className="ep-select" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">All Categories</option>
              {categories.map((c) => <option key={String(c)}>{String(c)}</option>)}
            </select>
            <select className="ep-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All Status</option>
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </div>
        </div>

        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><RefreshCw size={20} className="rl-spin" /><p>Loading processes…</p></div>
          ) : filtered.length === 0 ? (
            <div className="ep-empty"><Layers size={32} style={{ opacity: 0.25 }} /><p>No processes yet.<br />Click <strong>New Process</strong> to create one.</p></div>
          ) : (
            <table className="ep-table">
              <thead><tr><th>Process</th><th>Code</th><th>Category</th><th>Form Fields</th><th>Permissions</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {filtered.map((rt) => (
                  <tr key={rt.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ width: 32, height: 32, borderRadius: 8, background: rt.color || "#2563eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{rt.icon || "📋"}</span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>{rt.name}</div>
                          {rt.description && <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>{rt.description}</div>}
                        </div>
                      </div>
                    </td>
                    <td><code style={{ fontSize: "0.78rem", background: "var(--surface-soft)", padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border)" }}>{rt.code}</code></td>
                    <td><span style={{ fontSize: "0.83rem", color: "var(--muted)" }}>{rt.category || "—"}</span></td>
                    <td><span style={{ fontSize: "0.83rem" }}>{rt.field_count} field{rt.field_count !== 1 ? "s" : ""}</span></td>
                    <td><span style={{ fontSize: "0.83rem" }}>{rt.permission_count}</span></td>
                    <td>{statusPill(rt.status)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="ep-icon-btn" title="Open designer" onClick={() => void openDetail(rt.id)}><Settings size={13} /></button>
                        <div style={{ position: "relative" }} ref={rowMenuId === rt.id ? menuRef : undefined}>
                          <button className="ep-icon-btn" onClick={(e) => { e.stopPropagation(); setRowMenuId((id) => id === rt.id ? null : rt.id); }}><MoreVertical size={13} /></button>
                          {rowMenuId === rt.id && (
                            <div className="ep-dropdown">
                              <button className="ep-dropdown-item" onClick={() => { void openDetail(rt.id); setRowMenuId(null); }}><Edit3 size={13} />Edit / Design</button>
                              <button className="ep-dropdown-item danger" onClick={() => { void handleDelete(rt.id, rt.name); setRowMenuId(null); }}><Trash2 size={13} />Delete</button>
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

      {/* ── Create Modal ── */}
      {showCreate && (
        <div className="ep-modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div><h2 className="ep-modal-title">New Process</h2><p className="ep-modal-sub">Define a custom process and its basic information.</p></div>
              <button className="ep-icon-btn" onClick={() => setShowCreate(false)}><X size={18} /></button>
            </div>
            <div className="ep-modal-body">
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Name <span className="ep-required">*</span></label>
                  <input className="ep-form-input" value={createName} placeholder="e.g. Petty Cash Request" onChange={(e) => { setCreateName(e.target.value); if (!createCode) setCreateCode(slugify(e.target.value)); }} />
                </div>
                <div className="ep-form-group">
                  <label>Code <span className="ep-required">*</span></label>
                  <input className="ep-form-input" value={createCode} placeholder="PETTY_CASH_REQUEST" onChange={(e) => setCreateCode(slugify(e.target.value))} />
                </div>
              </div>
              <div className="ep-form-group">
                <label>Description</label>
                <textarea className="ep-form-textarea" rows={2} value={createDesc} placeholder="Describe this process…" onChange={(e) => setCreateDesc(e.target.value)} />
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Category</label>
                  <select className="ep-form-select" value={createCategory} onChange={(e) => setCreateCategory(e.target.value)}>
                    <option value="">— Select category —</option>
                    {categoryOptionNodes}
                  </select>
                </div>
                <div className="ep-form-group">
                  <label>Status</label>
                  <select className="ep-form-select" value={createStatus} onChange={(e) => setCreateStatus(e.target.value as RTStatus)}>
                    <option value="DRAFT">Draft</option>
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                  </select>
                </div>
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Icon</label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {ICONS.map((ic) => (
                      <button key={ic} type="button" className="ep-icon-btn" style={{ width: 36, height: 36, fontSize: 18, background: createIcon === ic ? "var(--surface-soft)" : "var(--surface)", borderColor: createIcon === ic ? "#2563eb" : "var(--border)" }} onClick={() => setCreateIcon(ic)}>{ic}</button>
                    ))}
                  </div>
                </div>
                <div className="ep-form-group">
                  <label>Color</label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {COLORS.map((col) => (
                      <button key={col} type="button" style={{ width: 28, height: 28, borderRadius: "50%", background: col, border: createColor === col ? "3px solid var(--text)" : "2px solid transparent", cursor: "pointer" }} onClick={() => setCreateColor(col)} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="ep-btn" onClick={handleCreate} disabled={creating}>{creating ? "Creating…" : "Create Process"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Detail / Designer Modal ── */}
      {detailId && (
        <div className="ep-modal-overlay" onClick={closeDetail}>
          <div className="ep-modal ep-modal-lg" style={{ maxHeight: "92vh" }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                {detailData && (
                  <span style={{ width: 40, height: 40, borderRadius: 10, background: detailData.color || "#2563eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{detailData.icon || "📋"}</span>
                )}
                <div>
                  <h2 className="ep-modal-title">{detailData?.name || "Loading…"}</h2>
                  <p className="ep-modal-sub"><code style={{ fontSize: "0.78rem" }}>{detailData?.code}</code> · {detailData && statusPill(detailData.status)}</p>
                </div>
              </div>
              <button className="ep-icon-btn" onClick={closeDetail}><X size={18} /></button>
            </div>

            <div className="ep-tabs" style={{ padding: "0 24px", marginBottom: 0 }}>
              {(["details", "fields", "permissions", "preview"] as Tab[]).map((t) => (
                <button key={t} className={`ep-tab ${detailTab === t ? "active" : ""}`} onClick={() => setDetailTab(t)}>
                  {t === "details" && <Settings size={14} />}
                  {t === "fields" && <Edit3 size={14} />}
                  {t === "permissions" && <Shield size={14} />}
                  {t === "preview" && <Eye size={14} />}
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                  {t === "fields" && fields.length > 0 && <span className="rl-tree-count">{fields.length}</span>}
                  {t === "permissions" && permissions.length > 0 && <span className="rl-tree-count">{permissions.length}</span>}
                </button>
              ))}
            </div>

            <div className="ep-modal-body" style={{ paddingTop: 16 }}>
              {detailLoading ? (
                <div className="ep-loading"><RefreshCw size={20} className="rl-spin" /></div>
              ) : (
                <>
                  {/* Details Tab */}
                  {detailTab === "details" && detailData && (
                    <div>
                      {/* ── Setup Checklist ── */}
                      {!editMeta && (() => {
                        const hasFields = detailData.field_count > 0;
                        const hasPerms  = detailData.permission_count > 0;
                        const isActive  = detailData.status === "ACTIVE";
                        const allDone   = hasFields && hasPerms && isActive;
                        if (allDone) return null;
                        const steps = [
                          {
                            done: hasFields,
                            label: "Add form fields",
                            detail: hasFields ? `${detailData.field_count} field${detailData.field_count !== 1 ? "s" : ""} defined` : "No fields yet — users won't have a form to fill in.",
                            action: () => setDetailTab("fields"),
                            actionLabel: "Go to Fields",
                          },
                          {
                            done: hasPerms,
                            label: "Set permissions",
                            detail: hasPerms ? `${detailData.permission_count} permission rule${detailData.permission_count !== 1 ? "s" : ""} set` : "No permissions — only admins can submit this type.",
                            action: () => setDetailTab("permissions"),
                            actionLabel: "Go to Permissions",
                          },
                          {
                            done: isActive,
                            label: "Activate the process",
                            detail: isActive ? "Status is Active" : `Currently ${detailData.status.toLowerCase()} — users cannot submit until it is set to Active.`,
                            action: () => setEditMeta(true),
                            actionLabel: "Edit Details",
                          },
                          {
                            done: false,
                            info: true,
                            label: "Set up an approval workflow",
                            detail: "Go to Approval Workflow Builder and create a workflow for this process so submissions have an approval chain.",
                            action: null,
                            actionLabel: null,
                          },
                        ];
                        return (
                          <div style={{ marginBottom: 18, border: "1px solid #fbbf24", borderRadius: 10, overflow: "hidden", background: "var(--surface)" }}>
                            <div style={{ background: "#fef3c7", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
                              <AlertTriangle size={15} style={{ color: "#d97706", flexShrink: 0 }} />
                              <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "#92400e" }}>Setup incomplete — complete these steps before this process is usable</span>
                            </div>
                            <div style={{ padding: "4px 0" }}>
                              {steps.map((step, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 16px", borderTop: i === 0 ? "none" : "1px solid var(--border)" }}>
                                  <div style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center", background: step.done ? "#dcfce7" : step.info ? "#eff6ff" : "#fee2e2", border: `1.5px solid ${step.done ? "#16a34a" : step.info ? "#3b82f6" : "#ef4444"}` }}>
                                    {step.done
                                      ? <span style={{ color: "#16a34a", fontWeight: 900, fontSize: 13 }}>✓</span>
                                      : step.info
                                        ? <span style={{ color: "#3b82f6", fontWeight: 900, fontSize: 12 }}>i</span>
                                        : <span style={{ color: "#ef4444", fontWeight: 900, fontSize: 13 }}>!</span>}
                                  </div>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: "0.85rem", color: step.done ? "var(--muted)" : "var(--text)", textDecoration: step.done ? "line-through" : "none" }}>{step.label}</div>
                                    <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 2 }}>{step.detail}</div>
                                  </div>
                                  {!step.done && step.action && (
                                    <button className="ep-btn-outline" style={{ fontSize: "0.78rem", padding: "4px 10px", flexShrink: 0 }} onClick={step.action}>{step.actionLabel}</button>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                      {!editMeta ? (
                        <div>
                          <div className="ep-panel" style={{ marginBottom: 16 }}>
                            <div className="ep-panel-head">
                              <span className="ep-panel-title">Process Information</span>
                              <button className="ep-btn-outline" style={{ padding: "5px 10px", fontSize: "0.82rem" }} onClick={() => setEditMeta(true)}><Edit3 size={13} />Edit</button>
                            </div>
                            <div className="ep-panel-body">
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                                {[["Name", detailData.name], ["Code", detailData.code], ["Category", detailData.category || "—"], ["Status", detailData.status], ["Description", detailData.description || "—"], ["Created", new Date(detailData.created_at).toLocaleDateString()]].map(([k, v]) => (
                                  <div key={k}><div style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{k}</div><div style={{ fontWeight: 600, fontSize: "0.88rem" }}>{v}</div></div>
                                ))}
                              </div>
                            </div>
                          </div>
                          <div className="ep-panel">
                            <div className="ep-panel-head"><span className="ep-panel-title">Summary</span></div>
                            <div className="ep-panel-body">
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                                {[["Form Fields", detailData.field_count, "#2563eb"], ["Permissions", detailData.permission_count, "#7c3aed"], ["Status", detailData.status === "ACTIVE" ? "Live" : "Not Live", detailData.status === "ACTIVE" ? "#059669" : "#d97706"]].map(([label, val, color]) => (
                                  <div key={String(label)} style={{ padding: 14, border: "1px solid var(--border)", borderRadius: 8, textAlign: "center" }}>
                                    <div style={{ fontSize: "1.6rem", fontWeight: 800, color: String(color) }}>{String(val)}</div>
                                    <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>{String(label)}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="ep-panel">
                          <div className="ep-panel-head"><span className="ep-panel-title">Edit Details</span></div>
                          <div className="ep-panel-body">
                            <div className="ep-form-row">
                              <div className="ep-form-group"><label>Name</label><input className="ep-form-input" value={editMetaData.name || ""} onChange={(e) => setEditMetaData((d: any) => ({ ...d, name: e.target.value }))} /></div>
                              <div className="ep-form-group"><label>Category</label><select className="ep-form-select" value={editMetaData.category || ""} onChange={(e) => setEditMetaData((d: any) => ({ ...d, category: e.target.value || null }))}><option value="">—</option>{categoryOptionNodes}</select></div>
                            </div>
                            <div className="ep-form-group"><label>Description</label><textarea className="ep-form-textarea" rows={3} value={editMetaData.description || ""} onChange={(e) => setEditMetaData((d: any) => ({ ...d, description: e.target.value }))} /></div>
                            <div className="ep-form-row">
                              <div className="ep-form-group"><label>Status</label><select className="ep-form-select" value={editMetaData.status || "DRAFT"} onChange={(e) => setEditMetaData((d: any) => ({ ...d, status: e.target.value }))}><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></div>
                              <div className="ep-form-group"><label>Icon</label><div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{ICONS.map((ic) => <button key={ic} type="button" className="ep-icon-btn" style={{ fontSize: 16, width: 34, height: 34, background: editMetaData.icon === ic ? "var(--surface-soft)" : "var(--surface)", borderColor: editMetaData.icon === ic ? "#2563eb" : "var(--border)" }} onClick={() => setEditMetaData((d: any) => ({ ...d, icon: ic }))}>{ic}</button>)}</div></div>
                            </div>
                            <div className="ep-form-group">
                              <label>Approver Titles</label>
                              <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: 6 }}>
                                If set, the approval-chain step title becomes a dropdown of these options instead of free text. Leave empty to keep free text.
                              </div>
                              <div className="rt-options-box">
                                {(editMetaData.approver_title_options || []).map((title: string, ti: number) => (
                                  <div key={ti} className="rt-option-row">
                                    <span>{title}</span>
                                    <button type="button" onClick={() => setEditMetaData((d: any) => ({ ...d, approver_title_options: d.approver_title_options.filter((_: string, i: number) => i !== ti) }))}><X size={12} /></button>
                                  </div>
                                ))}
                                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                                  <input className="ep-form-input" style={{ flex: 1 }} placeholder="e.g. Compiled by" value={newApproverTitle} onChange={(e) => setNewApproverTitle(e.target.value)} />
                                  <button type="button" className="ep-btn" style={{ padding: "6px 12px" }} onClick={() => {
                                    if (!newApproverTitle.trim()) return;
                                    setEditMetaData((d: any) => ({ ...d, approver_title_options: [...(d.approver_title_options || []), newApproverTitle.trim()] }));
                                    setNewApproverTitle("");
                                  }}>Add</button>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="ep-modal-footer" style={{ padding: "12px 18px" }}>
                            <button className="ep-btn-outline" onClick={() => setEditMeta(false)}>Cancel</button>
                            <button className="ep-btn" onClick={handleSaveMeta} disabled={savingMeta}>{savingMeta ? "Saving…" : "Save Changes"}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Fields Tab */}
                  {detailTab === "fields" && (
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>Form Designer</div>
                          <div style={{ fontSize: "0.82rem", color: "var(--muted)" }}>Define the input fields that users will fill in when submitting this process.</div>
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="ep-btn-outline" onClick={addField}><Plus size={14} />Add Field</button>
                          <button className="ep-btn" onClick={handleSaveFields} disabled={savingFields}>{savingFields ? "Saving…" : "Save Fields"}</button>
                        </div>
                      </div>
                      {fields.length === 0 ? (
                        <div className="ep-empty" style={{ padding: "40px 0" }}>
                          <Edit3 size={28} style={{ opacity: 0.25 }} />
                          <p>No fields yet. Click <strong>Add Field</strong> to start designing the form.</p>
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {fields.map((f, i) => (
                            <FieldRow key={i} field={f} index={i} total={fields.length} allFields={fields} onChange={(nf) => updateField(i, nf)} onRemove={() => removeField(i)} onMove={(dir) => moveField(i, dir)} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Permissions Tab */}
                  {detailTab === "permissions" && (
                    <div>
                      <div className="ep-panel" style={{ marginBottom: 16 }}>
                        <div className="ep-panel-head"><span className="ep-panel-title">Add Permission</span></div>
                        <div className="ep-panel-body">
                          <div className="ep-form-row" style={{ marginBottom: 10 }}>
                            <div className="ep-form-group" style={{ marginBottom: 0 }}>
                              <label>Grant To</label>
                              <select className="ep-form-select" value={newPermType} onChange={(e) => setNewPermType(e.target.value as "ALL" | "DEPARTMENT" | "USER" | "EMPLOYMENT_TYPE")}>
                                <option value="ALL">All Users</option>
                                <option value="DEPARTMENT">Division</option>
                                <option value="EMPLOYMENT_TYPE">Employment Type</option>
                                <option value="USER">Specific User</option>
                              </select>
                            </div>
                            {newPermType === "DEPARTMENT" && (
                              <div className="ep-form-group" style={{ marginBottom: 0 }}>
                                <label>Division</label>
                                <select className="ep-form-select" value={newPermDept} onChange={(e) => setNewPermDept(e.target.value)}>
                                  <option value="">Select division</option>
                                  {allDepts.map((d) => <option key={d}>{d}</option>)}
                                </select>
                              </div>
                            )}
                            {newPermType === "EMPLOYMENT_TYPE" && (
                              <div className="ep-form-group" style={{ marginBottom: 0 }}>
                                <label>Employment Type</label>
                                <select className="ep-form-select" value={newPermEmploymentType} onChange={(e) => setNewPermEmploymentType(e.target.value)}>
                                  <option value="">Select employment type</option>
                                  {allEmploymentTypes.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
                                </select>
                              </div>
                            )}
                            {newPermType === "USER" && (
                              <div className="ep-form-group" style={{ marginBottom: 0 }}>
                                <label>User</label>
                                <select className="ep-form-select" value={newPermUserId} onChange={(e) => setNewPermUserId(e.target.value)}>
                                  <option value="">Select user</option>
                                  {allUsers.filter((u) => u.is_active).sort((a: any, b: any) => (a.full_name || "").localeCompare(b.full_name || "")).map((u: any) => (
                                    <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 12 }}>
                            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.83rem", cursor: "pointer" }}><input type="checkbox" checked={newPermSubmit} onChange={(e) => setNewPermSubmit(e.target.checked)} />Can Submit</label>
                            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.83rem", cursor: "pointer" }}><input type="checkbox" checked={newPermDesign} onChange={(e) => setNewPermDesign(e.target.checked)} />Can Design Form</label>
                          </div>
                          <button className="ep-btn" onClick={handleAddPermission} disabled={addingPerm}><UserCheck size={14} />{addingPerm ? "Adding…" : "Add Permission"}</button>
                        </div>
                      </div>

                      {permissions.length === 0 ? (
                        <div className="ep-empty" style={{ padding: "32px 0" }}>
                          <Shield size={28} style={{ opacity: 0.25 }} />
                          <p>No permissions set. Add a permission above to control who can submit or design this process.</p>
                        </div>
                      ) : (
                        <div className="ep-table-wrap">
                          <table className="ep-table">
                            <thead><tr><th>Granted To</th><th>Can Submit</th><th>Can Design</th><th></th></tr></thead>
                            <tbody>
                              {permissions.map((p) => (
                                <tr key={p.id}>
                                  <td>
                                    {p.permission_type === "ALL" && <span style={{ display: "flex", gap: 6, alignItems: "center" }}><Users size={14} />All Users</span>}
                                    {p.permission_type === "DEPARTMENT" && <span style={{ display: "flex", gap: 6, alignItems: "center" }}><Shield size={14} />{p.department}</span>}
                                    {p.permission_type === "EMPLOYMENT_TYPE" && <span style={{ display: "flex", gap: 6, alignItems: "center" }}><Shield size={14} />{allEmploymentTypes.find((t) => t.code === p.employment_type)?.name || p.employment_type}</span>}
                                    {p.permission_type === "USER" && <span style={{ display: "flex", gap: 6, alignItems: "center" }}><UserCheck size={14} />{p.user_name || p.user_email}</span>}
                                  </td>
                                  <td><span className={p.can_submit ? "status-pill status-pill-success" : "status-pill status-pill-danger"}>{p.can_submit ? "Yes" : "No"}</span></td>
                                  <td><span className={p.can_design ? "status-pill status-pill-info" : "status-pill"}>{p.can_design ? "Yes" : "No"}</span></td>
                                  <td><button className="ep-icon-btn" style={{ color: "#dc2626" }} onClick={() => void handleRemovePermission(p.id)}><Trash2 size={13} /></button></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Preview Tab */}
                  {detailTab === "preview" && (
                    <div>
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>Form Preview</div>
                        <div style={{ fontSize: "0.82rem", color: "var(--muted)" }}>This is how the form will appear to users when submitting this process.</div>
                      </div>
                      <div className="ep-panel">
                        <div className="ep-panel-head">
                          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            <span style={{ width: 32, height: 32, borderRadius: 8, background: detailData?.color || "#2563eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>{detailData?.icon || "📋"}</span>
                            <div><div className="ep-panel-title">{detailData?.name}</div>{detailData?.description && <div className="ep-panel-sub">{detailData.description}</div>}</div>
                          </div>
                        </div>
                        <div className="ep-panel-body"><FormPreview fields={fields} /></div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
