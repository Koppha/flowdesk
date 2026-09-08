import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { confirmAction } from "./alerts";
import { Building2, Edit3, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type PayeeRow = {
  id: string;
  full_name: string;
  id_number: string | null;
  category: string | null;
  organisation: string | null;
  phone: string | null;
  email: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_branch: string | null;
  active: boolean;
  created_by_name: string | null;
  created_at: string;
  usage_count: string | number;
};

type PayeeForm = {
  full_name: string;
  id_number: string;
  category: string;
  organisation: string;
  phone: string;
  email: string;
  bank_name: string;
  bank_account_number: string;
  bank_branch: string;
};

const EMPTY_FORM: PayeeForm = {
  full_name: "", id_number: "", category: "", organisation: "",
  phone: "", email: "", bank_name: "", bank_account_number: "", bank_branch: "",
};

// ─── Field / label primitives (matches UserManagement.tsx's conventions) ──────

const fieldStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", border: "1px solid var(--border)",
  borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)",
  fontSize: 13, boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "var(--muted)",
  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5, display: "block",
};

function Field({ label, children, span }: { label: string; children: React.ReactNode; span?: boolean }) {
  return (
    <div style={{ gridColumn: span ? "1 / -1" : undefined, display: "flex", flexDirection: "column" }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function initials(name: string) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2)
    .map(p => p[0]?.toUpperCase() || "").join("") || "?";
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ExternalPayees() {
  const [payees, setPayees] = useState<PayeeRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<PayeeForm>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);

  const [editing, setEditing] = useState<PayeeRow | null>(null);
  const [editForm, setEditForm] = useState<PayeeForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.allExternalPayees();
      setPayees(Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      alert("Error loading external payees: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!editing) return;
    setEditForm({
      full_name: editing.full_name || "",
      id_number: editing.id_number || "",
      category: editing.category || "",
      organisation: editing.organisation || "",
      phone: editing.phone || "",
      email: editing.email || "",
      bank_name: editing.bank_name || "",
      bank_account_number: editing.bank_account_number || "",
      bank_branch: editing.bank_branch || "",
    });
  }, [editing]);

  const q = search.trim().toLowerCase();

  const filtered = useMemo(() => payees.filter(p => {
    if (statusFilter === "ACTIVE" && !p.active) return false;
    if (statusFilter === "INACTIVE" && p.active) return false;
    if (!q) return true;
    return [p.full_name, p.id_number, p.category, p.organisation, p.phone, p.email]
      .some(v => (v ?? "").toLowerCase().includes(q));
  }), [payees, statusFilter, q]);

  const stats = useMemo(() => ({
    total: payees.length,
    active: payees.filter(p => p.active).length,
    inactive: payees.filter(p => !p.active).length,
    inUse: payees.filter(p => Number(p.usage_count) > 0).length,
  }), [payees]);

  async function handleAdd() {
    if (!addForm.full_name.trim()) { alert("Name is required."); return; }
    setAdding(true);
    try {
      await api.createExternalPayee({
        full_name: addForm.full_name.trim(),
        id_number: addForm.id_number.trim() || undefined,
        category: addForm.category.trim() || undefined,
        organisation: addForm.organisation.trim() || undefined,
        phone: addForm.phone.trim() || undefined,
        email: addForm.email.trim() || undefined,
        bank_name: addForm.bank_name.trim() || undefined,
        bank_account_number: addForm.bank_account_number.trim() || undefined,
        bank_branch: addForm.bank_branch.trim() || undefined,
      });
      setAddForm(EMPTY_FORM);
      setShowAdd(false);
      await load();
    } catch (e: any) {
      alert("Error creating payee: " + e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveEdit() {
    if (!editing) return;
    if (!editForm.full_name.trim()) { alert("Name is required."); return; }
    setSaving(true);
    try {
      await api.updateExternalPayee(editing.id, {
        full_name: editForm.full_name.trim(),
        id_number: editForm.id_number.trim() || undefined,
        category: editForm.category.trim() || undefined,
        organisation: editForm.organisation.trim() || undefined,
        phone: editForm.phone.trim() || undefined,
        email: editForm.email.trim() || undefined,
        bank_name: editForm.bank_name.trim() || undefined,
        bank_account_number: editForm.bank_account_number.trim() || undefined,
        bank_branch: editForm.bank_branch.trim() || undefined,
      });
      setEditing(null);
      await load();
    } catch (e: any) {
      alert("Error saving payee: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(p: PayeeRow) {
    const confirmed = await confirmAction({
      title: `Deactivate ${p.full_name}?`,
      text: "They will no longer appear as an option under \"Apply for Other\" on new advance requests. This does not affect any existing request already linked to them, and can be reversed.",
      confirmButtonText: "Deactivate",
    });
    if (!confirmed) return;
    try {
      await api.updateExternalPayee(p.id, { active: false });
      await load();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  async function handleReactivate(p: PayeeRow) {
    try {
      await api.updateExternalPayee(p.id, { active: true });
      await load();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  return (
    <div style={{ padding: 24 }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Building2 size={22} color="#3b82f6" />
          <div>
            <div style={{ fontWeight: 700, fontSize: 20, color: "var(--text)" }}>External Payees</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 1 }}>
              The shared directory of non-Econet beneficiaries available under "Apply for Other". {stats.total} payees · {stats.active} active · {stats.inactive} inactive
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={load} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 13px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 13 }}>
            <RefreshCw size={13} style={{ animation: loading ? "spin 1s linear infinite" : undefined }} /> Refresh
          </button>
          <button onClick={() => { setAddForm(EMPTY_FORM); setShowAdd(true); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            <Plus size={14} /> Add Payee
          </button>
        </div>
      </div>

      {/* ── Stats ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          { label: "Total Payees", value: stats.total, color: "#3b82f6" },
          { label: "Active", value: stats.active, color: "#16a34a" },
          { label: "Inactive", value: stats.inactive, color: "#ef4444" },
          { label: "Used on a Request", value: stats.inUse, color: "#7c3aed" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ flex: "1 1 140px", padding: "14px 18px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)", textAlign: "center" }}>
            <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 220px" }}>
          <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none" }} />
          <input
            placeholder="Search name, ID, category, organisation…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...fieldStyle, paddingLeft: 30 }}
          />
          {search && (
            <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 0, display: "flex" }}>
              <X size={12} />
            </button>
          )}
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ ...fieldStyle, width: "auto", minWidth: 120 }}>
          <option value="ALL">All Statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
        <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
          {filtered.length} result{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Table ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        {loading && !payees.length ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>
            {payees.length === 0 ? "No external payees yet. Click Add Payee to create one." : "No payees match the current filters."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-soft)", borderBottom: "2px solid var(--border)" }}>
                  {["Payee", "Category", "Contact", "Used On", "Status", ""].map(h => (
                    <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => {
                  const usageCount = Number(p.usage_count) || 0;
                  return (
                    <tr
                      key={p.id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-soft)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}
                    >
                      {/* Payee cell */}
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{
                            width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                            background: p.active ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "#e5e7eb",
                            color: p.active ? "#fff" : "#9ca3af",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontWeight: 700, fontSize: 13,
                          }}>
                            {initials(p.full_name)}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: p.active ? "var(--text)" : "var(--muted)", whiteSpace: "nowrap" }}>
                              {p.full_name}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>
                              {p.id_number || <span style={{ fontStyle: "italic" }}>No ID / passport on file</span>}
                              {p.organisation && <span> · {p.organisation}</span>}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Category */}
                      <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                        {p.category
                          ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0", fontWeight: 500 }}>{p.category}</span>
                          : <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>}
                      </td>

                      {/* Contact */}
                      <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--muted)", maxWidth: 220 }}>
                        {p.phone || p.email
                          ? <>{p.phone}{p.phone && p.email && " · "}{p.email}</>
                          : "—"}
                      </td>

                      {/* Used on */}
                      <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                        {usageCount > 0
                          ? <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99, background: "#ede9fe", color: "#6d28d9" }}>{usageCount} request{usageCount !== 1 ? "s" : ""}</span>
                          : <span style={{ color: "var(--muted)", fontSize: 12 }}>Not used yet</span>}
                      </td>

                      {/* Status */}
                      <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                        {p.active ? (
                          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99, background: "#dcfce7", color: "#16a34a" }}>Active</span>
                        ) : (
                          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 99, background: "#fee2e2", color: "#b91c1c" }}>Inactive</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button
                            onClick={() => setEditing(p)}
                            title="Edit payee"
                            style={{ padding: "5px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", cursor: "pointer", color: "#3b82f6", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
                          >
                            <Edit3 size={13} /> Edit
                          </button>
                          {p.active ? (
                            <button
                              onClick={() => handleDeactivate(p)}
                              title="Deactivate payee"
                              style={{ padding: "5px 9px", border: "1px solid #fecaca", borderRadius: 6, background: "#fff5f5", cursor: "pointer", color: "#ef4444", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
                            >
                              <Trash2 size={13} /> Deactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => handleReactivate(p)}
                              title="Reactivate payee"
                              style={{ padding: "5px 9px", border: "1px solid #bbf7d0", borderRadius: 6, background: "#f0fdf4", cursor: "pointer", color: "#16a34a", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}
                            >
                              <RotateCcw size={13} /> Reactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add Payee Modal ── */}
      {showAdd && (
        <ModalOverlay onClose={() => setShowAdd(false)}>
          <ModalBox title="Add External Payee" subtitle="Adds a person to the shared directory available under &quot;Apply for Other&quot;." onClose={() => setShowAdd(false)}>
            <PayeeFormFields form={addForm} setForm={setAddForm} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
              <button onClick={() => setShowAdd(false)} style={{ padding: "8px 18px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={handleAdd} disabled={adding} style={{ padding: "8px 20px", background: adding ? "#93c5fd" : "#1d4ed8", color: "#fff", border: "none", borderRadius: 7, cursor: adding ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}>
                {adding ? "Creating…" : "Create Payee"}
              </button>
            </div>
          </ModalBox>
        </ModalOverlay>
      )}

      {/* ── Edit Payee Modal ── */}
      {editing && (
        <ModalOverlay onClose={() => setEditing(null)}>
          <ModalBox title="Edit External Payee" subtitle={editing.full_name} onClose={() => setEditing(null)}>
            <PayeeFormFields form={editForm} setForm={setEditForm} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
              <button onClick={() => setEditing(null)} style={{ padding: "8px 18px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={handleSaveEdit} disabled={saving} style={{ padding: "8px 20px", background: saving ? "#93c5fd" : "#1d4ed8", color: "#fff", border: "none", borderRadius: 7, cursor: saving ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </ModalBox>
        </ModalOverlay>
      )}
    </div>
  );
}

// ─── Shared form fields (Add + Edit) ───────────────────────────────────────────

function PayeeFormFields({ form, setForm }: { form: PayeeForm; setForm: React.Dispatch<React.SetStateAction<PayeeForm>> }) {
  const set = (key: keyof PayeeForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(prev => ({ ...prev, [key]: e.target.value }));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <Field label="Full Name *" span>
        <input value={form.full_name} onChange={set("full_name")} placeholder="e.g. Karabo Ntsane" style={fieldStyle} />
      </Field>
      <Field label="ID / Passport No.">
        <input value={form.id_number} onChange={set("id_number")} style={fieldStyle} />
      </Field>
      <Field label="Category">
        <input value={form.category} onChange={set("category")} placeholder="e.g. Contractor, Vendor, Guest" style={fieldStyle} />
      </Field>
      <Field label="Organisation">
        <input value={form.organisation} onChange={set("organisation")} placeholder="optional" style={fieldStyle} />
      </Field>
      <Field label="Phone">
        <input value={form.phone} onChange={set("phone")} placeholder="optional" style={fieldStyle} />
      </Field>
      <Field label="Email" span>
        <input type="email" value={form.email} onChange={set("email")} placeholder="optional" style={fieldStyle} />
      </Field>
      <Field label="Bank Name">
        <input value={form.bank_name} onChange={set("bank_name")} placeholder="optional" style={fieldStyle} />
      </Field>
      <Field label="Bank Account No.">
        <input value={form.bank_account_number} onChange={set("bank_account_number")} placeholder="optional" style={fieldStyle} />
      </Field>
      <Field label="Bank Branch" span>
        <input value={form.bank_branch} onChange={set("bank_branch")} placeholder="optional" style={fieldStyle} />
      </Field>
      <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--muted)", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 7, padding: "8px 10px" }}>
        Bank details are reference-only. The advance is always paid to the requester who submitted it on this person's behalf — never directly to the external payee.
      </div>
    </div>
  );
}

// ─── Modal primitives (matches UserManagement.tsx's conventions) ─────────────

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.48)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={onClose}
    >
      {children}
    </div>
  );
}

function ModalBox({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{ background: "var(--surface)", borderRadius: 14, padding: 28, width: 580, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.28)" }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{subtitle}</div>}
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 4, marginTop: -2 }}><X size={17} /></button>
      </div>
      {children}
    </div>
  );
}
