import { useEffect, useState } from "react";
import { api } from "./api";
import { showNotice } from "./alerts";
import { FileText, Trash2 } from "lucide-react";

type BrsSectionDraft = {
  id?: string;
  section_key: string;
  title: string;
  description: string;
  owner_phase: "DRAFT" | "DEPT_INPUT";
  default_department: string;
  is_required: boolean;
  sla_hours: string;
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

function slugify(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function emptySection(order: number): BrsSectionDraft {
  return { section_key: "", title: "", description: "", owner_phase: "DRAFT", default_department: "", is_required: true, sla_hours: "", sort_order: order };
}

// There's no admin-facing "types" concept for BRS — every BRS opens against
// the same single structure, so this page edits that structure directly
// (fetched/auto-created via GET /brs-types/default) rather than presenting
// a list to choose between.
export default function BrsAdmin({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [status, setStatus] = useState<"DRAFT" | "ACTIVE" | "INACTIVE">("DRAFT");
  const [sections, setSections] = useState<BrsSectionDraft[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    api.brsDefaultType()
      .then((t: any) => {
        setTypeId(t.id);
        setStatus(t.status);
        setSections((t.sections || []).map((s: any) => ({
          id: s.id, section_key: s.section_key, title: s.title, description: s.description || "",
          owner_phase: s.owner_phase, default_department: s.default_department || "",
          is_required: s.is_required, sla_hours: s.sla_hours ? String(s.sla_hours) : "", sort_order: s.sort_order
        })));
        setPermissions(t.permissions || []);
      })
      .catch((e: any) => void showNotice(e?.message || "Failed to load the BRS structure"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function sectionPayload(s: BrsSectionDraft, i: number) {
    return {
      section_key: s.section_key.trim() || slugify(s.title) || `section_${i}`,
      title: s.title.trim(),
      description: s.description.trim() || null,
      owner_phase: s.owner_phase,
      default_department: s.default_department.trim() || null,
      is_required: s.is_required,
      sla_hours: s.sla_hours.trim() ? Number(s.sla_hours) : null,
      sort_order: i
    };
  }

  async function saveDetails() {
    if (!typeId) return;
    setSaving(true);
    try {
      await api.brsTypeUpdate(typeId, { status });
      await api.brsTypeSetSections(typeId, sections.filter((s) => s.title.trim()).map((s, i) => sectionPayload(s, i)));
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function updateSection(idx: number, patch: Partial<BrsSectionDraft>) {
    setSections((prev) => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
  }

  async function addPermission(permission_type: Permission["permission_type"]) {
    if (!typeId) return;
    try {
      const row = await api.brsTypeAddPermission(typeId, { permission_type, can_submit: true, can_design: false });
      setPermissions((prev) => [...prev, row]);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to add permission");
    }
  }

  async function removePermission(permId: string) {
    if (!typeId) return;
    try {
      await api.brsTypeRemovePermission(typeId, permId);
      setPermissions((prev) => prev.filter((p) => p.id !== permId));
    } catch (e: any) {
      void showNotice(e?.message || "Failed to remove permission");
    }
  }

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon"><FileText size={18} /></span>
            <h2>BRS Structure</h2>
          </div>
          <p className="custom-requests-subtitle">The section structure every BRS opens with, and who can open one.</p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      {loading ? (
        <div className="ep-loading"><p>Loading…</p></div>
      ) : (
        <>
          <div className="ep-panel" style={{ marginBottom: 16 }}>
            <div className="ep-panel-head"><div className="ep-panel-title">Availability</div></div>
            <div className="ep-panel-body">
              <div className="ep-form-group" style={{ maxWidth: 280 }}>
                <label>Status</label>
                <select className="ep-form-select" value={status} onChange={(e) => setStatus(e.target.value as any)}>
                  <option value="DRAFT">Draft (BRS Studio hidden)</option>
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive (BRS Studio hidden)</option>
                </select>
              </div>
            </div>
          </div>

          <div className="ep-panel" style={{ marginBottom: 16 }}>
            <div className="ep-panel-head">
              <div className="ep-panel-title">Sections</div>
              <div className="ep-panel-sub">Draft sections are filled by the requester; Department Input sections are handed off in parallel.</div>
            </div>
            <div className="ep-panel-body">
              {sections.map((s, idx) => (
                <div key={idx} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
                  <div className="ep-form-row">
                    <div className="ep-form-group">
                      <label>Title</label>
                      <input className="ep-form-input" value={s.title} onChange={(e) => updateSection(idx, { title: e.target.value })} />
                    </div>
                    <div className="ep-form-group">
                      <label>Owner phase</label>
                      <select className="ep-form-select" value={s.owner_phase} onChange={(e) => updateSection(idx, { owner_phase: e.target.value as any })}>
                        <option value="DRAFT">Draft (requester)</option>
                        <option value="DEPT_INPUT">Department Input</option>
                      </select>
                    </div>
                  </div>
                  <div className="ep-form-row">
                    <div className="ep-form-group">
                      <label>Default department (optional)</label>
                      <input className="ep-form-input" value={s.default_department} onChange={(e) => updateSection(idx, { default_department: e.target.value })} />
                    </div>
                    <div className="ep-form-group">
                      <label>SLA hours (optional)</label>
                      <input className="ep-form-input" type="number" value={s.sla_hours} onChange={(e) => updateSection(idx, { sla_hours: e.target.value })} />
                    </div>
                  </div>
                  <label className="ep-checkbox-label">
                    <input type="checkbox" checked={s.is_required} onChange={(e) => updateSection(idx, { is_required: e.target.checked })} />
                    Required (blocks the Consistency Gate if left blank)
                  </label>
                  <button className="ep-icon-btn" style={{ marginTop: 8 }} onClick={() => setSections((prev) => prev.filter((_, i) => i !== idx))} title="Remove section">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button className="ep-btn-outline" onClick={() => setSections((prev) => [...prev, emptySection(prev.length)])}>+ Add section</button>
            </div>
          </div>

          <div className="ep-panel" style={{ marginBottom: 16 }}>
            <div className="ep-panel-head"><div className="ep-panel-title">Who can open a BRS</div></div>
            <div className="ep-panel-body">
              {permissions.map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontSize: 13 }}>
                    {p.permission_type === "ALL" ? "Everyone" : p.permission_type === "DEPARTMENT" ? `Department: ${p.department}` : p.permission_type === "USER" ? `User: ${p.user_name || p.user_email}` : `Employment type: ${p.employment_type}`}
                  </span>
                  <button className="ep-icon-btn" onClick={() => removePermission(p.id)}><Trash2 size={14} /></button>
                </div>
              ))}
              {!permissions.length && <div className="ep-empty"><p>Nobody can open a new BRS yet.</p></div>}
              <button className="ep-btn-outline" style={{ marginTop: 8 }} onClick={() => addPermission("ALL")}>+ Allow everyone</button>
            </div>
          </div>

          <button className="ep-btn" disabled={saving} onClick={saveDetails}>{saving ? "Saving…" : "Save"}</button>
        </>
      )}
    </div>
  );
}
