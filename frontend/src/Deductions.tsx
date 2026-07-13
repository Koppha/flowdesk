import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken } from "./api";
import { formatMoney } from "./constants";
import UserPicker, { type PickableUser } from "./UserPicker";
import {
  Clock, Hourglass, CheckCircle, Wallet, Search, Plus, X, MoreHorizontal,
  Shield, ChevronLeft, ChevronRight, Download, ArrowUpDown
} from "lucide-react";

const DEDUCTION_TYPES = ["Late Clearance", "No Clearance"] as const;
type DeductionType = typeof DEDUCTION_TYPES[number];

const TYPE_STYLE: Record<string, [string, string]> = {
  "Late Clearance": ["#ffedd5", "#c2410c"],
  "No Clearance":   ["#fee2e2", "#dc2626"]
};

const STATUS_STYLE: Record<string, [string, string]> = {
  PENDING:    ["#fef3c7", "#92400e"],
  PROCESSING: ["#dbeafe", "#1d4ed8"],
  PROCESSED:  ["#d1fae5", "#065f46"]
};

interface DeductionItem {
  id: string;
  deduction_type: DeductionType;
  employee_id: string;
  employee_name: string | null;
  department: string | null;
  amount: string | number;
  deduction_date: string;
  reason: string | null;
  status: "PENDING" | "PROCESSING" | "PROCESSED";
  requested_by_id: string;
  requested_by_name: string | null;
  created_at: string;
  updated_at: string;
}

function referenceNumber(item: DeductionItem) {
  const created = new Date(item.created_at || Date.now());
  const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear();
  const digits = String(item.id || "").replace(/\D/g, "").slice(-4);
  const fallback = String(item.id || "0000").replace(/-/g, "").slice(0, 4).toUpperCase();
  return `DED-${year}-${(digits || fallback || "0000").padStart(4, "0")}`;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function isThisMonth(s: string | null | undefined) {
  if (!s) return false;
  const d = new Date(s);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function TypeBadge({ type }: { type: string }) {
  const [bg, color] = TYPE_STYLE[type] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{type}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{label}</span>;
}

type SortKey = "reference" | "type" | "employee" | "department" | "amount" | "date" | "status" | "requestedBy";

const PAGE_SIZE_OPTIONS = [10, 25, 50];

export default function Deductions() {
  const me = getUserFromToken();
  const isAdmin = me?.role === "ADMIN";

  const [items, setItems] = useState<DeductionItem[]>([]);
  const [directory, setDirectory] = useState<PickableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<"pending" | "processing" | "processed" | "all">("pending");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const [editing, setEditing] = useState<DeductionItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showUserPicker, setShowUserPicker] = useState(false);
  const [formEmployee, setFormEmployee] = useState<PickableUser | null>(null);
  const [formType, setFormType] = useState<DeductionType>("Late Clearance");
  const [formAmount, setFormAmount] = useState("");
  const [formDate, setFormDate] = useState("");
  const [formReason, setFormReason] = useState("");

  const [showAccessModal, setShowAccessModal] = useState(false);
  const [accessGroups, setAccessGroups] = useState<{ name: string; member_count: string; hidden: boolean; dynamic: boolean }[]>([]);
  const [grantedGroups, setGrantedGroups] = useState<string[]>([]);
  const [savingAccess, setSavingAccess] = useState(false);

  async function refresh() {
    setError(null);
    try {
      const resp = await api.deductions();
      setItems(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    api.companyDirectory().then(setDirectory).catch(() => {});
  }, []);

  useEffect(() => {
    function closeMenu() { setOpenMenuId(null); }
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  const stats = useMemo(() => {
    const pending = items.filter((i) => i.status === "PENDING");
    const processing = items.filter((i) => i.status === "PROCESSING");
    const processedThisMonth = items.filter((i) => i.status === "PROCESSED" && isThisMonth(i.updated_at));
    const sum = (arr: DeductionItem[]) => arr.reduce((s, i) => s + Number(i.amount || 0), 0);
    return {
      pendingCount: pending.length,
      pendingValue: sum(pending),
      processingCount: processing.length,
      processingValue: sum(processing),
      processedCount: processedThisMonth.length,
      processedValue: sum(processedThisMonth),
      totalDeductedValue: sum(processedThisMonth)
    };
  }, [items]);

  const uniqueDepts = useMemo(() => Array.from(new Set(items.map((i) => i.department).filter(Boolean))).sort() as string[], [items]);

  const tabFiltered = useMemo(() => {
    if (tab === "all") return items;
    return items.filter((i) => i.status === tab.toUpperCase());
  }, [items, tab]);

  const filtered = useMemo(() => {
    return tabFiltered.filter((i) => {
      if (filterType && i.deduction_type !== filterType) return false;
      if (filterDept && i.department !== filterDept) return false;
      if (dateFrom && i.deduction_date < dateFrom) return false;
      if (dateTo && i.deduction_date > dateTo) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          referenceNumber(i).toLowerCase().includes(q) ||
          (i.employee_name || "").toLowerCase().includes(q) ||
          (i.department || "").toLowerCase().includes(q) ||
          (i.requested_by_name || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [tabFiltered, filterType, filterDept, dateFrom, dateTo, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      switch (sortKey) {
        case "reference": return referenceNumber(a).localeCompare(referenceNumber(b)) * dir;
        case "type": return a.deduction_type.localeCompare(b.deduction_type) * dir;
        case "employee": return (a.employee_name || "").localeCompare(b.employee_name || "") * dir;
        case "department": return (a.department || "").localeCompare(b.department || "") * dir;
        case "amount": return (Number(a.amount) - Number(b.amount)) * dir;
        case "status": return a.status.localeCompare(b.status) * dir;
        case "requestedBy": return (a.requested_by_name || "").localeCompare(b.requested_by_name || "") * dir;
        case "date":
        default: return (new Date(a.deduction_date).getTime() - new Date(b.deduction_date).getTime()) * dir;
      }
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  function resetForm() {
    setEditing(null);
    setFormEmployee(null);
    setFormType("Late Clearance");
    setFormAmount("");
    setFormDate("");
    setFormReason("");
  }

  function openCreate() {
    resetForm();
    setShowForm(true);
  }

  function openEdit(item: DeductionItem) {
    setEditing(item);
    const emp = directory.find((u) => u.id === item.employee_id) || null;
    setFormEmployee(emp || { id: item.employee_id, full_name: item.employee_name, email: "", department: item.department });
    setFormType(item.deduction_type);
    setFormAmount(String(item.amount));
    setFormDate(item.deduction_date ? item.deduction_date.slice(0, 10) : "");
    setFormReason(item.reason || "");
    setShowForm(true);
    setOpenMenuId(null);
  }

  async function saveForm() {
    if (!formEmployee || !formAmount || !formDate) {
      setError("Employee, amount, and deduction date are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        employee_id: formEmployee.id,
        deduction_type: formType,
        amount: Number(formAmount),
        deduction_date: formDate,
        reason: formReason.trim() || undefined
      };
      if (editing) await api.updateDeduction(editing.id, payload);
      else await api.createDeduction(payload);
      setShowForm(false);
      resetForm();
      await refresh();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  async function advanceStatus(item: DeductionItem, status: "PENDING" | "PROCESSING" | "PROCESSED") {
    setBusy(true);
    setError(null);
    try {
      await api.updateDeductionStatus(item.id, status);
      await refresh();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
      setOpenMenuId(null);
    }
  }

  async function removeDeduction(item: DeductionItem) {
    if (!window.confirm(`Delete deduction ${referenceNumber(item)} for ${item.employee_name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteDeduction(item.id);
      await refresh();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
      setOpenMenuId(null);
    }
  }

  async function openAccessModal() {
    setShowAccessModal(true);
    try {
      const resp = await api.deductionAccessGroups();
      setAccessGroups((resp.available || []).filter((g: any) => g.name !== "ADMIN"));
      setGrantedGroups(resp.granted || []);
    } catch (e: any) {
      setError(String(e.message));
    }
  }

  async function saveAccessGroups() {
    setSavingAccess(true);
    setError(null);
    try {
      await api.setDeductionAccessGroups(grantedGroups);
      setShowAccessModal(false);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setSavingAccess(false);
    }
  }

  function exportCsv() {
    const headers = ["Deduction Reference", "Deduction Type", "Employee", "Department", "Amount (LSL)", "Deduction Date", "Status", "Requested By"];
    const rows = sorted.map((i) => [
      referenceNumber(i), i.deduction_type, i.employee_name || "", i.department || "",
      Number(i.amount || 0).toFixed(2), fmtDate(i.deduction_date), i.status, i.requested_by_name || ""
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `deductions-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
  }

  const SortableHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(sortKeyName)}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label} <ArrowUpDown size={12} style={{ opacity: sortKey === sortKeyName ? 1 : 0.35 }} />
      </span>
    </th>
  );

  if (loading) return <div className="ep-page"><p>Loading deductions…</p></div>;

  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Deductions</h1>
          <p className="ep-subtitle">Payroll deductions raised against employees who owe the company.</p>
        </div>
        <div className="ep-actions">
          {isAdmin && (
            <button className="ep-btn-outline" onClick={openAccessModal}>
              <Shield size={14} /> Manage Access
            </button>
          )}
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!sorted.length}>
            <Download size={14} /> Export
          </button>
          <button className="button button-primary" onClick={openCreate}>
            <Plus size={14} /> New Deduction
          </button>
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div className="ep-kpi-row">
        <div className="stat-card stat-card-blue">
          <span className="stat-icon"><Clock size={28} /></span>
          <div>
            <div className="stat-value">{stats.pendingCount}</div>
            <div className="stat-label">Total Pending Deductions</div>
            <small>{formatMoney(stats.pendingValue)}</small>
          </div>
        </div>
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Hourglass size={28} /></span>
          <div>
            <div className="stat-value">{stats.processingCount}</div>
            <div className="stat-label">Processing Deductions</div>
            <small>{formatMoney(stats.processingValue)}</small>
          </div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle size={28} /></span>
          <div>
            <div className="stat-value">{stats.processedCount}</div>
            <div className="stat-label">Processed (This Month)</div>
            <small>{formatMoney(stats.processedValue)}</small>
          </div>
        </div>
        <div className="stat-card stat-card-purple">
          <span className="stat-icon"><Wallet size={28} /></span>
          <div>
            <div className="stat-value">{formatMoney(stats.totalDeductedValue)}</div>
            <div className="stat-label">Total Deducted (This Month)</div>
            <small>Across {stats.processedCount} deductions</small>
          </div>
        </div>
      </div>

      <div className="ep-tabs">
        {([
          { key: "pending", label: "Pending", count: items.filter((i) => i.status === "PENDING").length },
          { key: "processing", label: "Processing", count: items.filter((i) => i.status === "PROCESSING").length },
          { key: "processed", label: "Processed", count: items.filter((i) => i.status === "PROCESSED").length },
          { key: "all", label: "All Deductions", count: items.length }
        ] as const).map((t) => (
          <button key={t.key} type="button" className={`ep-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => { setTab(t.key); setPage(1); }}>
            {t.label} <span className="inbox-count-chip">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px" }}>
            <Search size={14} />
            <input placeholder="Search deductions…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="ep-form-select" value={filterType} onChange={(e) => { setFilterType(e.target.value); setPage(1); }}>
            <option value="">All Types</option>
            {DEDUCTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="ep-form-select" value={filterDept} onChange={(e) => { setFilterDept(e.target.value); setPage(1); }} style={{ minWidth: 160 }}>
            <option value="">All Departments</option>
            {uniqueDepts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <input type="date" className="ep-form-select" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
          <input type="date" className="ep-form-select" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} title="To date" />
          {(search || filterType || filterDept || dateFrom || dateTo) && (
            <button className="ep-btn-outline" onClick={() => { setSearch(""); setFilterType(""); setFilterDept(""); setDateFrom(""); setDateTo(""); setPage(1); }}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {sorted.length === 0 ? (
            <div className="ep-empty"><p>No deductions match your filters.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <SortableHeader label="Deduction Reference" sortKeyName="reference" />
                  <SortableHeader label="Deduction Type" sortKeyName="type" />
                  <SortableHeader label="Employee" sortKeyName="employee" />
                  <SortableHeader label="Department" sortKeyName="department" />
                  <SortableHeader label="Amount (LSL)" sortKeyName="amount" />
                  <SortableHeader label="Deduction Date" sortKeyName="date" />
                  <SortableHeader label="Status" sortKeyName="status" />
                  <SortableHeader label="Requested By" sortKeyName="requestedBy" />
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {paged.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{referenceNumber(item)}</strong></td>
                    <td><TypeBadge type={item.deduction_type} /></td>
                    <td style={{ fontWeight: 600, fontSize: "0.87rem" }}>{item.employee_name || "—"}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{item.department || "—"}</td>
                    <td style={{ fontWeight: 600 }}>{Number(item.amount || 0).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(item.deduction_date)}</td>
                    <td><StatusBadge status={item.status} /></td>
                    <td style={{ fontSize: 13 }}>{item.requested_by_name || "—"}</td>
                    <td className="ep-dropdown-wrap">
                      <button
                        className="ep-icon-btn"
                        onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === item.id ? null : item.id); }}
                        aria-label="Row actions"
                      >
                        <MoreHorizontal size={16} />
                      </button>
                      {openMenuId === item.id && (
                        <div className="ep-dropdown" onClick={(e) => e.stopPropagation()}>
                          {item.status === "PENDING" && (
                            <>
                              <button className="ep-dropdown-item" onClick={() => openEdit(item)}>Edit</button>
                              <button className="ep-dropdown-item" onClick={() => advanceStatus(item, "PROCESSING")} disabled={busy}>Move to Processing</button>
                              <button className="ep-dropdown-item danger" onClick={() => removeDeduction(item)} disabled={busy}>Delete</button>
                            </>
                          )}
                          {item.status === "PROCESSING" && (
                            <>
                              <button className="ep-dropdown-item" onClick={() => advanceStatus(item, "PENDING")} disabled={busy}>Move back to Pending</button>
                              <button className="ep-dropdown-item" onClick={() => advanceStatus(item, "PROCESSED")} disabled={busy}>Mark Processed</button>
                            </>
                          )}
                          {item.status === "PROCESSED" && (
                            <button className="ep-dropdown-item" onClick={() => advanceStatus(item, "PROCESSING")} disabled={busy}>Move back to Processing</button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {sorted.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, sorted.length)} of {sorted.length} entries
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <select className="ep-form-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}><ChevronLeft size={14} /></button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 7).map((n) => (
                <button key={n} className={`button small-button ${currentPage === n ? "button-primary" : "button-subtle"}`} onClick={() => setPage(n)}>{n}</button>
              ))}
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>

      {showForm && (
        <div className="ep-modal-overlay" onClick={() => !busy && setShowForm(false)}>
          <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">{editing ? "Edit Deduction" : "New Deduction"}</h2>
                <p className="ep-modal-sub">{editing ? "Only pending deductions can be edited." : "Record a deduction against an employee who owes the company."}</p>
              </div>
              <button className="ep-icon-btn" onClick={() => setShowForm(false)} disabled={busy}><X size={18} /></button>
            </div>
            <div className="ep-modal-body">
              <div className="ep-form-group">
                <label>Employee <span className="ep-required">*</span></label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input className="ep-form-input" readOnly value={formEmployee?.full_name || ""} placeholder="Select an employee…" style={{ flex: 1 }} />
                  <button type="button" className="button small-button button-subtle" onClick={() => setShowUserPicker(true)}>Choose</button>
                </div>
              </div>
              <div className="ep-form-row">
                <div className="ep-form-group">
                  <label>Deduction Type <span className="ep-required">*</span></label>
                  <select className="ep-form-select" value={formType} onChange={(e) => setFormType(e.target.value as DeductionType)}>
                    {DEDUCTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="ep-form-group">
                  <label>Amount (LSL) <span className="ep-required">*</span></label>
                  <input className="ep-form-input" type="number" min="0" step="0.01" value={formAmount} onChange={(e) => setFormAmount(e.target.value)} placeholder="0.00" />
                </div>
              </div>
              <div className="ep-form-group">
                <label>Deduction Date <span className="ep-required">*</span></label>
                <input className="ep-form-input" type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} />
              </div>
              <div className="ep-form-group">
                <label>Reason</label>
                <textarea className="ep-form-textarea" value={formReason} onChange={(e) => setFormReason(e.target.value)} placeholder="Why this employee owes the company…" rows={3} />
              </div>
            </div>
            <div className="ep-modal-footer">
              <button className="button small-button button-subtle" onClick={() => setShowForm(false)} disabled={busy}>Cancel</button>
              <button className="button button-primary" onClick={() => void saveForm()} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {showUserPicker && (
        <UserPicker
          title="Select Employee"
          subtitle="Search and select the employee this deduction applies to."
          users={directory}
          excludeRoles={[]}
          saveLabel="Select"
          selectedNote="will be selected for this deduction."
          onClose={() => setShowUserPicker(false)}
          onSelect={(u) => { setFormEmployee(u); setShowUserPicker(false); }}
        />
      )}

      {showAccessModal && (
        <div className="ep-modal-overlay" onClick={() => !savingAccess && setShowAccessModal(false)}>
          <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">Manage Deductions Access</h2>
                <p className="ep-modal-sub">Admins always have access. Choose which additional roles, divisions, departments, sections, or teams can view and manage Deductions.</p>
              </div>
              <button className="ep-icon-btn" onClick={() => setShowAccessModal(false)} disabled={savingAccess}><X size={18} /></button>
            </div>
            <div className="ep-modal-body" style={{ display: "grid", gap: 4 }}>
              {accessGroups.map((g) => (
                <label key={g.name} className="ep-checkbox-label">
                  <input
                    type="checkbox"
                    checked={grantedGroups.includes(g.name)}
                    onChange={(e) => setGrantedGroups((prev) => e.target.checked ? [...prev, g.name] : prev.filter((n) => n !== g.name))}
                  />
                  {g.name} <span style={{ color: "var(--muted)", fontSize: 11 }}>({g.member_count} members)</span>
                </label>
              ))}
            </div>
            <div className="ep-modal-footer">
              <button className="button small-button button-subtle" onClick={() => setShowAccessModal(false)} disabled={savingAccess}>Cancel</button>
              <button className="button button-primary" onClick={() => void saveAccessGroups()} disabled={savingAccess}>{savingAccess ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
