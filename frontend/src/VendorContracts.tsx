import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken, openBlobInNewTab } from "./api";
import { formatMoney } from "./constants";
import {
  FileText, Clock, Wallet, AlertTriangle, Search, Plus, Upload, Download,
  ArrowLeft, Trash2, CheckCircle2, RefreshCw
} from "lucide-react";

// ─── Types (mirror the backend's mapContract/mapPayment/mapDocument shapes) ─
type IncreaseRule = { id?: string; increaseDurationMonths: number; increasePercentage: number };
type VendorContract = {
  id: string;
  contractNumber: string;
  title: string;
  counterpartyName: string;
  contractType: string | null;
  notificationEmail: string | null;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  noticePeriodDate: string | null;
  contractValue: number;
  increaseRules: IncreaseRule[];
  paymentTerms: string | null;
  status: "ACTIVE" | "EXPIRED" | "TERMINATED" | "PENDING_RENEWAL";
  description: string | null;
  isActive: boolean;
  nextPaymentLabel: string | null;
  nextPaymentDueDate: string | null;
  nextPaymentAmount: number | null;
  documentCount: number;
  dueSoonPaymentCount: number;
  overduePaymentCount: number;
  paidPaymentCount: number;
};
type VendorPayment = { id: string; contractId: string; paymentLabel: string | null; amount: number; dueDate: string; status: "PAID" | "DUE_SOON" | "OVERDUE"; paidAt: string | null; notes: string | null };
type VendorDocument = { id: string; fileName: string; fileType: string | null; fileSize: number | null; uploadedAt: string };

const STATUS_STYLE: Record<string, [string, string]> = {
  ACTIVE: ["#d1fae5", "#065f46"],
  EXPIRED: ["#fee2e2", "#991b1b"],
  TERMINATED: ["#f1f5f9", "#475569"],
  PENDING_RENEWAL: ["#fef3c7", "#92400e"]
};
const PAYMENT_STATUS_STYLE: Record<string, [string, string]> = {
  PAID: ["#d1fae5", "#065f46"],
  DUE_SOON: ["#fef3c7", "#92400e"],
  OVERDUE: ["#fee2e2", "#991b1b"]
};

function StatusBadge({ status, styleMap }: { status: string; styleMap: Record<string, [string, string]> }) {
  const [bg, color] = styleMap[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{status.replace(/_/g, " ")}</span>;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const el = document.createElement("a");
  el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  el.download = filename;
  el.click();
}

const EMPTY_FORM = {
  title: "", counterpartyName: "", contractType: "", notificationEmail: "",
  startDate: "", endDate: "", renewalDate: "", noticePeriodDate: "",
  contractValue: "", paymentTerms: "", status: "ACTIVE" as VendorContract["status"], description: "",
  increaseRules: [] as IncreaseRule[]
};

export default function VendorContracts() {
  const me = getUserFromToken();
  const [canManage, setCanManage] = useState(false);
  const [view, setView] = useState<"DASHBOARD" | "LIST" | "REPORTS">("DASHBOARD");

  const [items, setItems] = useState<VendorContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dashboard, setDashboard] = useState<any>(null);
  const [mailReport, setMailReport] = useState<any[]>([]);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ contract: VendorContract; payments: VendorPayment[]; documents: VendorDocument[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [formMode, setFormMode] = useState<"NONE" | "CREATE" | "EDIT">("NONE");
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [paymentForm, setPaymentForm] = useState({ paymentLabel: "", amount: "", dueDate: "", notes: "" });
  const [busy, setBusy] = useState(false);

  async function refreshList() {
    setError(null);
    try {
      const resp = await api.vendorContracts();
      setItems(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  }

  async function refreshDashboard() {
    try {
      setDashboard(await api.vendorContractsDashboard());
    } catch (e: any) {
      setError(String(e.message));
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const access = await api.vendorContractsAccess();
        setCanManage(Boolean(access.canManage));
      } catch {}
    })();
    refreshList();
    refreshDashboard();
  }, []);

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await api.vendorContractDetail(id));
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
  }

  function startCreate() {
    setForm(EMPTY_FORM);
    setSaveError(null);
    setFormMode("CREATE");
  }

  function startEdit(c: VendorContract) {
    setForm({
      title: c.title, counterpartyName: c.counterpartyName, contractType: c.contractType || "",
      notificationEmail: c.notificationEmail || "", startDate: c.startDate?.slice(0, 10) || "",
      endDate: c.endDate?.slice(0, 10) || "", renewalDate: c.renewalDate?.slice(0, 10) || "",
      noticePeriodDate: c.noticePeriodDate?.slice(0, 10) || "", contractValue: String(c.contractValue),
      paymentTerms: c.paymentTerms || "", status: c.status, description: c.description || "",
      increaseRules: c.increaseRules.map((r) => ({ increaseDurationMonths: r.increaseDurationMonths, increasePercentage: r.increasePercentage }))
    });
    setSaveError(null);
    setFormMode("EDIT");
  }

  function addIncreaseRule() {
    setForm((f) => ({ ...f, increaseRules: [...f.increaseRules, { increaseDurationMonths: 12, increasePercentage: 0 }] }));
  }
  function removeIncreaseRule(idx: number) {
    setForm((f) => ({ ...f, increaseRules: f.increaseRules.filter((_, i) => i !== idx) }));
  }
  function updateIncreaseRule(idx: number, patch: Partial<IncreaseRule>) {
    setForm((f) => ({ ...f, increaseRules: f.increaseRules.map((r, i) => (i === idx ? { ...r, ...patch } : r)) }));
  }

  async function saveContract() {
    setSaveError(null);
    if (!form.title.trim() || !form.counterpartyName.trim() || !form.startDate || !form.endDate) {
      setSaveError("Title, counterparty, start date and end date are required.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        counterpartyName: form.counterpartyName.trim(),
        contractType: form.contractType.trim() || undefined,
        notificationEmail: form.notificationEmail.trim() || undefined,
        startDate: form.startDate,
        endDate: form.endDate,
        renewalDate: form.renewalDate || undefined,
        noticePeriodDate: form.noticePeriodDate || undefined,
        contractValue: Number(form.contractValue) || 0,
        paymentTerms: form.paymentTerms.trim() || undefined,
        status: form.status,
        description: form.description.trim() || undefined,
        increaseRules: form.increaseRules
      };
      if (formMode === "CREATE") {
        const created = await api.createVendorContract(payload);
        setFormMode("NONE");
        await refreshList();
        await refreshDashboard();
        openDetail(created.id);
      } else if (formMode === "EDIT" && selectedId) {
        await api.updateVendorContract(selectedId, payload);
        setFormMode("NONE");
        await refreshList();
        await refreshDashboard();
        openDetail(selectedId);
      }
    } catch (e: any) {
      setSaveError(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(c: VendorContract) {
    setBusy(true);
    try {
      await api.setVendorContractActive(c.id, !c.isActive);
      await refreshList();
      if (selectedId === c.id) openDetail(c.id);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  async function addPayment() {
    if (!selectedId || !paymentForm.amount || !paymentForm.dueDate) return;
    setBusy(true);
    try {
      await api.createVendorContractPayment(selectedId, {
        paymentLabel: paymentForm.paymentLabel.trim() || undefined,
        amount: Number(paymentForm.amount),
        dueDate: paymentForm.dueDate,
        notes: paymentForm.notes.trim() || undefined
      });
      setPaymentForm({ paymentLabel: "", amount: "", dueDate: "", notes: "" });
      openDetail(selectedId);
      refreshDashboard();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  async function markPaid(paymentId: string) {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api.markVendorContractPaymentPaid(selectedId, paymentId);
      openDetail(selectedId);
      refreshDashboard();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  async function uploadDocument(file: File) {
    if (!selectedId) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api.uploadVendorContractDocument(selectedId, form);
      openDetail(selectedId);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  function viewDocument(doc: VendorDocument) {
    if (!selectedId) return;
    void openBlobInNewTab(() => api.vendorContractDocumentBlob(selectedId, doc.id));
  }

  async function loadMailReport() {
    try {
      const resp = await api.vendorContractsMailReport();
      setMailReport(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    }
  }

  useEffect(() => {
    if (view === "REPORTS") loadMailReport();
  }, [view]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.counterpartyName.toLowerCase().includes(q) ||
        c.contractNumber.toLowerCase().includes(q)
      );
    });
  }, [items, search, statusFilter]);

  if (loading) return <div className="ep-page"><p>Loading vendor contracts…</p></div>;

  // ── Detail overlay ──────────────────────────────────────────────────────
  if (selectedId) {
    return (
      <div className="ep-page">
        <div className="ep-header">
          <div className="ep-header-text">
            <button className="ep-btn-outline" onClick={closeDetail} style={{ marginBottom: 10 }}><ArrowLeft size={14} /> Back to Contracts</button>
            <h1 className="ep-title">{detail?.contract.title || "Contract"}</h1>
            <p className="ep-subtitle">{detail?.contract.contractNumber} &middot; {detail?.contract.counterpartyName}</p>
          </div>
          {canManage && detail && (
            <div className="ep-actions" style={{ gap: 8 }}>
              <button className="button small-button button-subtle" onClick={() => startEdit(detail.contract)}>Edit</button>
              <button className="button small-button button-subtle" onClick={() => toggleActive(detail.contract)} disabled={busy}>
                {detail.contract.isActive ? "Hide from Portal" : "Restore Visibility"}
              </button>
            </div>
          )}
        </div>

        {error && <pre className="inbox-error">{error}</pre>}

        {detailLoading || !detail ? <p>Loading…</p> : (
          <>
            <div className="ep-kpi-row">
              <div className="ep-kpi ep-kpi-blue">
                <div className="ep-kpi-icon"><Wallet size={26} /></div>
                <div>
                  <div className="ep-kpi-value">{formatMoney(detail.contract.contractValue)}</div>
                  <div className="ep-kpi-label">Contract Value</div>
                </div>
              </div>
              <div className="ep-kpi ep-kpi-gold">
                <div className="ep-kpi-icon"><Clock size={26} /></div>
                <div>
                  <div className="ep-kpi-value">{fmtDate(detail.contract.endDate)}</div>
                  <div className="ep-kpi-label">End Date</div>
                </div>
              </div>
              <div className="ep-kpi ep-kpi-green">
                <div className="ep-kpi-icon"><CheckCircle2 size={26} /></div>
                <div>
                  <div className="ep-kpi-value">{detail.contract.paidPaymentCount}</div>
                  <div className="ep-kpi-label">Payments Paid</div>
                </div>
              </div>
              <div className="ep-kpi ep-kpi-purple">
                <div className="ep-kpi-icon"><AlertTriangle size={26} /></div>
                <div>
                  <div className="ep-kpi-value">{detail.contract.overduePaymentCount}</div>
                  <div className="ep-kpi-label">Overdue Payments</div>
                </div>
              </div>
            </div>

            <div className="ep-panel" style={{ marginTop: 14, padding: 18 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <StatusBadge status={detail.contract.status} styleMap={STATUS_STYLE} />
                {!detail.contract.isActive && <StatusBadge status="HIDDEN" styleMap={{ HIDDEN: ["#f1f5f9", "#64748b"] }} />}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, fontSize: 13.5 }}>
                <div><div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Contract Type</div>{detail.contract.contractType || "—"}</div>
                <div><div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Start Date</div>{fmtDate(detail.contract.startDate)}</div>
                <div><div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Renewal Date</div>{fmtDate(detail.contract.renewalDate)}</div>
                <div><div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Notice Period Date</div>{fmtDate(detail.contract.noticePeriodDate)}</div>
                <div><div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Payment Terms</div>{detail.contract.paymentTerms || "—"}</div>
                <div><div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Notification Email</div>{detail.contract.notificationEmail || "—"}</div>
              </div>
              {detail.contract.description && <p style={{ marginTop: 14, fontSize: 13.5, color: "var(--muted)" }}>{detail.contract.description}</p>}
              {detail.contract.increaseRules.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>Escalation Rules</div>
                  {detail.contract.increaseRules.map((r, i) => (
                    <span key={i} style={{ display: "inline-block", marginRight: 10, fontSize: 13 }}>+{r.increasePercentage}% every {r.increaseDurationMonths}mo</span>
                  ))}
                </div>
              )}
            </div>

            <div className="ep-panel" style={{ marginTop: 14 }}>
              <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
                <h3 style={{ margin: 0 }}>Payment Schedule</h3>
              </div>
              <div className="ep-table-wrap">
                <table className="ep-table">
                  <thead><tr><th>Label</th><th>Amount</th><th>Due Date</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {detail.payments.length === 0 ? (
                      <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No payments scheduled yet.</td></tr>
                    ) : detail.payments.map((p) => (
                      <tr key={p.id}>
                        <td>{p.paymentLabel || "—"}</td>
                        <td style={{ fontWeight: 600 }}>{formatMoney(p.amount)}</td>
                        <td>{fmtDate(p.dueDate)}</td>
                        <td><StatusBadge status={p.status} styleMap={PAYMENT_STATUS_STYLE} /></td>
                        <td>
                          {canManage && p.status !== "PAID" && (
                            <button className="button small-button button-primary" disabled={busy} onClick={() => markPaid(p.id)}>Mark Paid</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canManage && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
                  <input placeholder="Label" value={paymentForm.paymentLabel} onChange={(e) => setPaymentForm((f) => ({ ...f, paymentLabel: e.target.value }))} style={{ maxWidth: 160 }} />
                  <input placeholder="Amount" type="number" value={paymentForm.amount} onChange={(e) => setPaymentForm((f) => ({ ...f, amount: e.target.value }))} style={{ maxWidth: 120 }} />
                  <input type="date" value={paymentForm.dueDate} onChange={(e) => setPaymentForm((f) => ({ ...f, dueDate: e.target.value }))} style={{ maxWidth: 160 }} />
                  <input placeholder="Notes (optional)" value={paymentForm.notes} onChange={(e) => setPaymentForm((f) => ({ ...f, notes: e.target.value }))} style={{ maxWidth: 200 }} />
                  <button className="button small-button button-primary" disabled={busy} onClick={addPayment}><Plus size={14} /> Add Payment</button>
                </div>
              )}
            </div>

            <div className="ep-panel" style={{ marginTop: 14 }}>
              <div className="ep-panel-header" style={{ padding: "14px 20px", display: "flex", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0 }}>Documents{detail.documents.length > 0 ? ` (${detail.documents.length})` : ""}</h3>
                {canManage && (
                  <label className="ep-btn-outline" style={{ cursor: "pointer" }}>
                    <Upload size={14} /> Upload
                    <input type="file" style={{ display: "none" }} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) uploadDocument(f); e.currentTarget.value = ""; }} />
                  </label>
                )}
              </div>
              <div style={{ padding: "0 20px 16px" }}>
                {detail.documents.length === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 13 }}>No documents uploaded yet.</div>
                ) : detail.documents.map((d) => (
                  <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <FileText size={16} style={{ color: "var(--accent, #2563eb)", flexShrink: 0 }} />
                    <div style={{ flex: 1, fontSize: 13 }}>{d.fileName}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{fmtDate(d.uploadedAt)}</div>
                    <button className="ep-icon-btn" title="View" onClick={() => viewDocument(d)}><Download size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Create/Edit form ────────────────────────────────────────────────────
  if (formMode !== "NONE") {
    return (
      <div className="ep-page">
        <div className="ep-header">
          <div className="ep-header-text">
            <button className="ep-btn-outline" onClick={() => setFormMode("NONE")} style={{ marginBottom: 10 }}><ArrowLeft size={14} /> Cancel</button>
            <h1 className="ep-title">{formMode === "CREATE" ? "New Vendor Contract" : "Edit Vendor Contract"}</h1>
          </div>
        </div>
        {saveError && <pre className="inbox-error">{saveError}</pre>}
        <div className="ep-panel" style={{ padding: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
            <label>Title *<input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} /></label>
            <label>Counterparty *<input value={form.counterpartyName} onChange={(e) => setForm((f) => ({ ...f, counterpartyName: e.target.value }))} /></label>
            <label>Contract Type<input value={form.contractType} onChange={(e) => setForm((f) => ({ ...f, contractType: e.target.value }))} /></label>
            <label>Notification Email(s)<input value={form.notificationEmail} onChange={(e) => setForm((f) => ({ ...f, notificationEmail: e.target.value }))} placeholder="a@b.com; c@d.com" /></label>
            <label>Start Date *<input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} /></label>
            <label>End Date *<input type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} /></label>
            <label>Renewal Date<input type="date" value={form.renewalDate} onChange={(e) => setForm((f) => ({ ...f, renewalDate: e.target.value }))} /></label>
            <label>Notice Period Date<input type="date" value={form.noticePeriodDate} onChange={(e) => setForm((f) => ({ ...f, noticePeriodDate: e.target.value }))} /></label>
            <label>Contract Value<input type="number" value={form.contractValue} onChange={(e) => setForm((f) => ({ ...f, contractValue: e.target.value }))} /></label>
            <label>Payment Terms<input value={form.paymentTerms} onChange={(e) => setForm((f) => ({ ...f, paymentTerms: e.target.value }))} /></label>
            <label>Status
              <select className="ep-form-select" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as any }))}>
                <option value="ACTIVE">Active</option>
                <option value="PENDING_RENEWAL">Pending Renewal</option>
                <option value="EXPIRED">Expired</option>
                <option value="TERMINATED">Terminated</option>
              </select>
            </label>
          </div>
          <label style={{ display: "block", marginTop: 16 }}>Description<textarea rows={3} style={{ width: "100%" }} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></label>

          <div style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Escalation Rules (optional)</div>
              <button className="ep-btn-outline" onClick={addIncreaseRule} type="button"><Plus size={14} /> Add Rule</button>
            </div>
            {form.increaseRules.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>Every</span>
                <input type="number" style={{ maxWidth: 90 }} value={r.increaseDurationMonths} onChange={(e) => updateIncreaseRule(i, { increaseDurationMonths: Number(e.target.value) })} />
                <span style={{ fontSize: 13, color: "var(--muted)" }}>months, increase by</span>
                <input type="number" style={{ maxWidth: 90 }} value={r.increasePercentage} onChange={(e) => updateIncreaseRule(i, { increasePercentage: Number(e.target.value) })} />
                <span style={{ fontSize: 13, color: "var(--muted)" }}>%</span>
                <button className="ep-icon-btn danger" onClick={() => removeIncreaseRule(i)} type="button"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 24, display: "flex", gap: 10 }}>
            <button className="button button-primary" disabled={saving} onClick={saveContract}>{saving ? "Saving…" : "Save Contract"}</button>
            <button className="button button-subtle" onClick={() => setFormMode("NONE")}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Dashboard / List / Reports ──────────────────────────────────────────
  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Vendor Contracts</h1>
          <p className="ep-subtitle">Procurement and counterparty agreements — payment schedules, escalation terms, and renewals.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => { refreshList(); refreshDashboard(); }}><RefreshCw size={14} /> Refresh</button>
          {canManage && view !== "DASHBOARD" && <button className="button button-primary" onClick={startCreate}><Plus size={14} /> New Contract</button>}
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div className="ep-tabs">
        {(["DASHBOARD", "LIST", "REPORTS"] as const).map((v) => (
          <button key={v} className={`ep-tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
            {v === "DASHBOARD" ? "Dashboard" : v === "LIST" ? "Contracts" : "Reports"}
          </button>
        ))}
      </div>

      {view === "DASHBOARD" && dashboard && (
        <>
          <div className="ep-kpi-row">
            {dashboard.stats.map((s: any) => (
              <div key={s.label} className={`ep-kpi ep-kpi-${s.tone === "red" ? "purple" : s.tone === "yellow" ? "gold" : s.tone === "green" ? "green" : "blue"}`}>
                <div className="ep-kpi-icon">{s.tone === "red" ? <AlertTriangle size={26} /> : s.tone === "yellow" ? <Clock size={26} /> : <Wallet size={26} />}</div>
                <div><div className="ep-kpi-value">{s.value}</div><div className="ep-kpi-label">{s.label}</div></div>
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
            <div className="ep-panel">
              <div className="ep-panel-header" style={{ padding: "14px 20px" }}><h3 style={{ margin: 0 }}>Upcoming Payments</h3></div>
              <div className="ep-table-wrap"><table className="ep-table">
                <thead><tr><th>Contract</th><th>Vendor</th><th>Due</th><th>Amount</th></tr></thead>
                <tbody>{dashboard.upcomingPayments.length === 0 ? <tr><td colSpan={4} style={{ color: "var(--muted)" }}>Nothing due soon.</td></tr> :
                  dashboard.upcomingPayments.map((p: any, i: number) => <tr key={i}><td>{p.contract}</td><td>{p.vendor}</td><td>{fmtDate(p.dueDate)}</td><td>{formatMoney(p.amount)}</td></tr>)}
                </tbody>
              </table></div>
            </div>
            <div className="ep-panel">
              <div className="ep-panel-header" style={{ padding: "14px 20px" }}><h3 style={{ margin: 0 }}>Expiring Contracts</h3></div>
              <div className="ep-table-wrap"><table className="ep-table">
                <thead><tr><th>Contract</th><th>Vendor</th><th>End Date</th></tr></thead>
                <tbody>{dashboard.expiringContracts.length === 0 ? <tr><td colSpan={3} style={{ color: "var(--muted)" }}>Nothing expiring in the next 90 days.</td></tr> :
                  dashboard.expiringContracts.map((c: any, i: number) => <tr key={i}><td>{c.contract}</td><td>{c.vendor}</td><td>{fmtDate(c.endDate)}</td></tr>)}
                </tbody>
              </table></div>
            </div>
          </div>
        </>
      )}

      {view === "LIST" && (
        <div className="ep-panel" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
            <div className="ep-search" style={{ flex: "1 1 220px" }}>
              <Search size={14} />
              <input placeholder="Search title, vendor, contract number…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select className="ep-form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ minWidth: 160 }}>
              <option value="">All Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING_RENEWAL">Pending Renewal</option>
              <option value="EXPIRED">Expired</option>
              <option value="TERMINATED">Terminated</option>
            </select>
          </div>
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Contract</th><th>Vendor</th><th>Value</th><th>End Date</th><th>Status</th><th>Next Payment</th></tr></thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={6} style={{ color: "var(--muted)" }}>No contracts match your filters.</td></tr>
                ) : filtered.map((c) => (
                  <tr key={c.id} onClick={() => openDetail(c.id)} style={{ cursor: "pointer", opacity: c.isActive ? 1 : 0.55 }}>
                    <td style={{ fontWeight: 600 }}>{c.title}<div style={{ fontSize: 11, color: "var(--muted)" }}>{c.contractNumber}</div></td>
                    <td>{c.counterpartyName}</td>
                    <td>{formatMoney(c.contractValue)}</td>
                    <td>{fmtDate(c.endDate)}</td>
                    <td><StatusBadge status={c.status} styleMap={STATUS_STYLE} /></td>
                    <td>{c.nextPaymentDueDate ? `${formatMoney(c.nextPaymentAmount || 0)} on ${fmtDate(c.nextPaymentDueDate)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === "REPORTS" && (
        <div className="ep-panel" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 10, padding: "14px 20px", flexWrap: "wrap" }}>
            <button className="ep-btn-outline" onClick={() => downloadCsv("vendor-contracts.csv", ["Number", "Title", "Vendor", "Value", "Start", "End", "Status"], items.map((c) => [c.contractNumber, c.title, c.counterpartyName, c.contractValue, c.startDate, c.endDate, c.status]))}>
              <Download size={14} /> Export Contracts
            </button>
          </div>
          <div className="ep-panel-header" style={{ padding: "0 20px 8px" }}><h3 style={{ margin: 0 }}>Expiry Reminder Send Log</h3></div>
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Contract</th><th>Notification Type</th><th>Sent</th><th>Status</th></tr></thead>
              <tbody>
                {mailReport.length === 0 ? (
                  <tr><td colSpan={4} style={{ color: "var(--muted)" }}>No reminders sent yet.</td></tr>
                ) : mailReport.map((m: any) => (
                  <tr key={m.id}>
                    <td>{m.contract_title} <span style={{ color: "var(--muted)", fontSize: 11 }}>({m.contract_number})</span></td>
                    <td>{String(m.notification_type).replace(/_/g, " ")}</td>
                    <td>{m.sent_at ? fmtDate(m.sent_at) : "—"}</td>
                    <td><StatusBadge status={m.status} styleMap={{ SENT: ["#d1fae5", "#065f46"], FAILED: ["#fee2e2", "#991b1b"] }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
