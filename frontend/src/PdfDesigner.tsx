import React, { useEffect, useState } from "react";
import { api } from "./api";
import { confirmAction, showNotice } from "./alerts";
import { ArrowDown, ArrowUp, FileText, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";

type PdfRequestType = "ADVANCE_REQUEST" | "CLEARANCE_CLAIM" | "ACCOMMODATION_REQUEST" | "OVERTIME_REQUEST" | "OVERTIME_CLAIM" | "CUSTOM_REQUEST";

const REQUEST_TYPE_LABELS: Record<PdfRequestType, string> = {
  ADVANCE_REQUEST: "Travel Advance Request",
  CLEARANCE_CLAIM: "Clearance Claim",
  ACCOMMODATION_REQUEST: "Accommodation Request",
  OVERTIME_REQUEST: "Overtime Request",
  OVERTIME_CLAIM: "Overtime Claim",
  CUSTOM_REQUEST: "Custom Request"
};
const REQUEST_TYPES = Object.keys(REQUEST_TYPE_LABELS) as PdfRequestType[];

type SectionType = "heading" | "field_grid" | "table" | "two_column_table" | "approval_summary" | "disclaimer" | "spacer";

interface SectionField { fieldKey: string; labelOverride?: string; checkboxValue?: string }

interface Section {
  id: string;
  type: SectionType;
  title?: string;
  numbered?: boolean;
  columns?: 1 | 2 | 3 | 4;
  fields?: SectionField[];
  tableKey?: string;
  tableColumns?: { key: string; label: string }[];
  leftHeader?: string;
  rightHeader?: string;
  leftFields?: SectionField[];
  rightFields?: SectionField[];
  disclaimerItems?: string[];
}

interface Template {
  id: string;
  name: string;
  request_type: PdfRequestType;
  custom_request_type_id: string | null;
  status: "DRAFT" | "ACTIVE" | "INACTIVE";
  show_letterhead: boolean;
  header_title: string | null;
  footer_text_override: string | null;
  sections: Section[];
}

interface CatalogEntry { key: string; label: string; group: string }

interface PermissionRow {
  id: string;
  permission_type: "ALL" | "GROUP" | "USER";
  group_name: string | null;
  user_id: string | null;
  user_name?: string | null;
  user_email?: string | null;
  can_view_pdf: boolean;
  can_design_pdf: boolean;
}

function newSectionId() {
  return `sec-${Math.random().toString(36).slice(2, 10)}`;
}

export default function PdfDesigner() {
  const [screen, setScreen] = useState<"LIST" | "DESIGNER" | "PERMISSIONS" | "LETTERHEAD">("LIST");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTemplate, setActiveTemplate] = useState<Template | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadTemplates = async () => {
    setLoading(true);
    try {
      const rows = await api.pdfTemplates();
      setTemplates(rows);
    } catch (err: any) {
      void showNotice(err?.message || "Failed to load PDF templates.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadTemplates(); }, []);

  const openTemplate = async (id: string) => {
    try {
      const detail = await api.pdfTemplateDetail(id);
      const cat = await api.pdfFieldCatalog(detail.request_type, detail.custom_request_type_id || undefined);
      setActiveTemplate(detail);
      setCatalog(cat);
      setSelectedSectionId(detail.sections?.[0]?.id || null);
      setScreen("DESIGNER");
    } catch (err: any) {
      void showNotice(err?.message || "Failed to load template.");
    }
  };

  const createTemplate = async (requestType: PdfRequestType) => {
    try {
      const created = await api.createPdfTemplate({
        name: `${REQUEST_TYPE_LABELS[requestType]} Template`,
        request_type: requestType,
        status: "DRAFT",
        show_letterhead: true,
        header_title: REQUEST_TYPE_LABELS[requestType].toUpperCase(),
        sections: []
      });
      await loadTemplates();
      await openTemplate(created.id);
    } catch (err: any) {
      void showNotice(err?.message || "Failed to create template.");
    }
  };

  const deleteTemplate = async (id: string) => {
    const ok = await confirmAction({ title: "Delete PDF template?", text: "This cannot be undone.", confirmButtonText: "Delete" });
    if (!ok) return;
    try {
      await api.deletePdfTemplate(id);
      await loadTemplates();
    } catch (err: any) {
      void showNotice(err?.message || "Failed to delete template.");
    }
  };

  const saveTemplate = async () => {
    if (!activeTemplate) return;
    setSaving(true);
    try {
      await api.updatePdfTemplate(activeTemplate.id, {
        name: activeTemplate.name,
        status: activeTemplate.status,
        show_letterhead: activeTemplate.show_letterhead,
        header_title: activeTemplate.header_title,
        footer_text_override: activeTemplate.footer_text_override,
        sections: activeTemplate.sections
      });
      await loadTemplates();
    } catch (err: any) {
      void showNotice(err?.message || "Failed to save template.");
    } finally {
      setSaving(false);
    }
  };

  // Previews against the most recent real record of this type automatically
  // (falling back to placeholder data server-side if none exist yet) — no
  // need to go find and paste in a record id.
  const preview = async () => {
    if (!activeTemplate) return;
    try {
      const blob = await api.pdfTemplatePreviewBlob(activeTemplate.id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err: any) {
      void showNotice(err?.message || "Failed to render preview.");
    }
  };

  const updateSections = (sections: Section[]) => {
    if (!activeTemplate) return;
    setActiveTemplate({ ...activeTemplate, sections });
  };

  const addSection = (type: SectionType) => {
    if (!activeTemplate) return;
    const section: Section = { id: newSectionId(), type, numbered: type === "field_grid" || type === "table" || type === "two_column_table" || type === "approval_summary" };
    if (type === "field_grid") { section.columns = 2; section.fields = []; }
    if (type === "table") { section.tableColumns = []; }
    if (type === "two_column_table") { section.leftHeader = ""; section.rightHeader = ""; section.leftFields = []; section.rightFields = []; }
    if (type === "disclaimer") { section.disclaimerItems = []; }
    updateSections([...activeTemplate.sections, section]);
    setSelectedSectionId(section.id);
  };

  const moveSection = (index: number, dir: -1 | 1) => {
    if (!activeTemplate) return;
    const sections = [...activeTemplate.sections];
    const target = index + dir;
    if (target < 0 || target >= sections.length) return;
    [sections[index], sections[target]] = [sections[target], sections[index]];
    updateSections(sections);
  };

  const removeSection = (id: string) => {
    if (!activeTemplate) return;
    updateSections(activeTemplate.sections.filter((s) => s.id !== id));
    if (selectedSectionId === id) setSelectedSectionId(null);
  };

  const updateSection = (id: string, patch: Partial<Section>) => {
    if (!activeTemplate) return;
    updateSections(activeTemplate.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  if (screen === "LIST") {
    return (
      <div className="ep-page">
        <div className="ep-breadcrumb">
          <span>Administration</span><X size={0} />
          <span className="ep-breadcrumb-active">PDF Designer</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>PDF Templates</h2>
          <button className="button small-button" type="button" onClick={() => setScreen("LETTERHEAD")}>Edit Letterhead</button>
        </div>

        {loading ? (
          <div className="tracking-loading"><RefreshCw className="rl-spin" size={20} /> Loading...</div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table className="ep-table">
              <thead><tr><th>Request Type</th><th>Name</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {REQUEST_TYPES.map((rt) => {
                  const rows = templates.filter((t) => t.request_type === rt);
                  if (rows.length === 0) {
                    return (
                      <tr key={rt}>
                        <td>{REQUEST_TYPE_LABELS[rt]}</td>
                        <td style={{ color: "var(--muted)" }}>No template yet</td>
                        <td>—</td>
                        <td><button className="ep-icon-btn" title="Create" onClick={() => createTemplate(rt)}><Plus size={15} /></button></td>
                      </tr>
                    );
                  }
                  return rows.map((t) => (
                    <tr key={t.id}>
                      <td>{REQUEST_TYPE_LABELS[rt]}</td>
                      <td>{t.name}</td>
                      <td><span className={`status-pill ${t.status === "ACTIVE" ? "status-pill-success" : "status-pill-neutral"}`}>{t.status}</span></td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="ep-icon-btn" title="Edit" onClick={() => openTemplate(t.id)}><FileText size={15} /></button>
                          <button className="ep-icon-btn" title="Delete" onClick={() => deleteTemplate(t.id)}><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  if (screen === "LETTERHEAD") {
    return <LetterheadScreen onBack={() => setScreen("LIST")} />;
  }

  if (!activeTemplate) return null;

  if (screen === "PERMISSIONS") {
    return (
      <PermissionsScreen
        template={activeTemplate}
        onBack={() => setScreen("DESIGNER")}
      />
    );
  }

  const selectedSection = activeTemplate.sections.find((s) => s.id === selectedSectionId) || null;

  return (
    <div className="ep-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <button className="button small-button button-subtle" type="button" onClick={() => setScreen("LIST")} style={{ marginBottom: 8 }}>&larr; Back</button>
          <h2 style={{ margin: 0 }}>{activeTemplate.name}</h2>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>{REQUEST_TYPE_LABELS[activeTemplate.request_type]}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={activeTemplate.status} onChange={(e) => setActiveTemplate({ ...activeTemplate, status: e.target.value as Template["status"] })}>
            <option value="DRAFT">Draft</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <button className="button small-button" type="button" onClick={() => setScreen("PERMISSIONS")}>Permissions</button>
          <button className="button small-button" type="button" onClick={preview}>Preview</button>
          <button className="button" type="button" onClick={saveTemplate} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
        </div>
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 18 }}>
        <div className="form-grid-3">
          <div className="form-field">
            <label>Template Name</label>
            <input value={activeTemplate.name} onChange={(e) => setActiveTemplate({ ...activeTemplate, name: e.target.value })} />
          </div>
          <div className="form-field">
            <label>Header Title</label>
            <input value={activeTemplate.header_title || ""} onChange={(e) => setActiveTemplate({ ...activeTemplate, header_title: e.target.value })} />
          </div>
          <div className="form-field">
            <label>Show Letterhead</label>
            <select value={activeTemplate.show_letterhead ? "yes" : "no"} onChange={(e) => setActiveTemplate({ ...activeTemplate, show_letterhead: e.target.value === "yes" })}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 18 }}>
        <section className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Sections</h3>
          <p style={{ fontSize: 12, color: "var(--muted)" }}>Reorder with the arrows; click a section to edit it.</p>
          {activeTemplate.sections.map((s, idx) => (
            <div
              key={s.id}
              onClick={() => setSelectedSectionId(s.id)}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px",
                marginBottom: 6, borderRadius: 8, cursor: "pointer",
                border: selectedSectionId === s.id ? "2px solid #2563eb" : "1px solid var(--border, #e2e8f0)"
              }}
            >
              <div>
                <strong style={{ textTransform: "capitalize" }}>{s.type.replace(/_/g, " ")}</strong>
                {s.title && <div style={{ fontSize: 12, color: "var(--muted)" }}>{s.title}</div>}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="ep-icon-btn" title="Move up" onClick={(e) => { e.stopPropagation(); moveSection(idx, -1); }}><ArrowUp size={13} /></button>
                <button className="ep-icon-btn" title="Move down" onClick={(e) => { e.stopPropagation(); moveSection(idx, 1); }}><ArrowDown size={13} /></button>
                <button className="ep-icon-btn" title="Remove" onClick={(e) => { e.stopPropagation(); removeSection(s.id); }}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          {activeTemplate.sections.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No sections yet — add one from the right.</div>}
        </section>

        <section className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Section Details</h3>
          {!selectedSection ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Select a section to edit it.</div>
          ) : (
            <SectionEditor section={selectedSection} catalog={catalog} onChange={(patch) => updateSection(selectedSection.id, patch)} />
          )}
        </section>

        <section className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Add Section</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button className="button small-button" type="button" onClick={() => addSection("heading")}>+ Heading</button>
            <button className="button small-button" type="button" onClick={() => addSection("field_grid")}>+ Field Grid</button>
            <button className="button small-button" type="button" onClick={() => addSection("table")}>+ Table</button>
            <button className="button small-button" type="button" onClick={() => addSection("two_column_table")}>+ Two-Column Table</button>
            <button className="button small-button" type="button" onClick={() => addSection("approval_summary")}>+ Approval Summary</button>
            <button className="button small-button" type="button" onClick={() => addSection("disclaimer")}>+ Disclaimer</button>
            <button className="button small-button" type="button" onClick={() => addSection("spacer")}>+ Spacer</button>
          </div>
          <h4 style={{ marginTop: 18 }}>Available Fields</h4>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            {Object.entries(
              catalog.reduce<Record<string, CatalogEntry[]>>((acc, f) => {
                (acc[f.group] = acc[f.group] || []).push(f);
                return acc;
              }, {})
            ).map(([group, fields]) => (
              <div key={group} style={{ marginBottom: 8 }}>
                <strong>{group}</strong>
                <div>{fields.map((f) => f.label).join(", ")}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function SectionEditor({ section, catalog, onChange }: { section: Section; catalog: CatalogEntry[]; onChange: (patch: Partial<Section>) => void }) {
  if (section.type === "heading") {
    return (
      <div className="form-field">
        <label>Title</label>
        <input value={section.title || ""} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
    );
  }

  if (section.type === "field_grid") {
    const selected = new Set((section.fields || []).map((f) => f.fieldKey));
    return (
      <div>
        <div className="form-field">
          <label>Title</label>
          <input value={section.title || ""} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
        <div className="form-field">
          <label>Columns</label>
          <select value={section.columns || 2} onChange={(e) => onChange({ columns: Number(e.target.value) as 1 | 2 | 3 | 4 })}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </div>
        <label style={{ display: "block", marginTop: 10, marginBottom: 4 }}>Fields</label>
        <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border, #e2e8f0)", borderRadius: 8, padding: 8 }}>
          {catalog.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Leave empty to show every submitted field (custom requests only).</div>}
          {catalog.map((f) => (
            <label key={f.key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, padding: "3px 0" }}>
              <input
                type="checkbox"
                checked={selected.has(f.key)}
                onChange={(e) => {
                  const fields = section.fields || [];
                  if (e.target.checked) onChange({ fields: [...fields, { fieldKey: f.key }] });
                  else onChange({ fields: fields.filter((x) => x.fieldKey !== f.key) });
                }}
              />
              {f.label}
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (section.type === "table") {
    const cols = section.tableColumns || [];
    return (
      <div>
        <div className="form-field">
          <label>Title</label>
          <input value={section.title || ""} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
        <div className="form-field">
          <label>Table Data Key</label>
          <input placeholder="e.g. advance_lines, claim_trips, lines" value={section.tableKey || ""} onChange={(e) => onChange({ tableKey: e.target.value })} />
        </div>
        <label style={{ display: "block", marginTop: 10, marginBottom: 4 }}>Columns (key: label, one per line)</label>
        <textarea
          rows={5}
          value={cols.map((c) => `${c.key}: ${c.label}`).join("\n")}
          onChange={(e) => {
            const parsed = e.target.value.split("\n").map((line) => {
              const [key, ...rest] = line.split(":");
              return { key: (key || "").trim(), label: (rest.join(":") || "").trim() };
            }).filter((c) => c.key);
            onChange({ tableColumns: parsed });
          }}
        />
      </div>
    );
  }

  if (section.type === "two_column_table") {
    const renderSide = (side: "left" | "right") => {
      const header = side === "left" ? section.leftHeader : section.rightHeader;
      const fields = (side === "left" ? section.leftFields : section.rightFields) || [];
      const setFields = (next: SectionField[]) => onChange(side === "left" ? { leftFields: next } : { rightFields: next });
      return (
        <div style={{ flex: 1 }}>
          <div className="form-field">
            <label>{side === "left" ? "Left" : "Right"} Column Header</label>
            <input
              value={header || ""}
              onChange={(e) => onChange(side === "left" ? { leftHeader: e.target.value } : { rightHeader: e.target.value })}
            />
          </div>
          <label style={{ display: "block", marginBottom: 4, fontSize: 12 }}>Rows (fieldKey: Label, one per line — add "= VALUE" to render a ☑/☐ checkbox that checks when that field equals VALUE, e.g. payment_method: Selected = ECOCASH)</label>
          <textarea
            rows={4}
            value={fields.map((f) => `${f.fieldKey}: ${f.labelOverride || ""}${f.checkboxValue !== undefined ? ` = ${f.checkboxValue}` : ""}`).join("\n")}
            onChange={(e) => {
              const parsed = e.target.value.split("\n").map((line) => {
                const [keyPart, ...rest] = line.split(":");
                const fieldKey = (keyPart || "").trim();
                let labelAndCheckbox = rest.join(":").trim();
                let checkboxValue: string | undefined;
                const eqIdx = labelAndCheckbox.indexOf("=");
                if (eqIdx >= 0) {
                  checkboxValue = labelAndCheckbox.slice(eqIdx + 1).trim();
                  labelAndCheckbox = labelAndCheckbox.slice(0, eqIdx).trim();
                }
                const field: SectionField = { fieldKey, labelOverride: labelAndCheckbox || undefined, checkboxValue };
                return fieldKey ? field : null;
              }).filter((f): f is SectionField => f !== null);
              setFields(parsed);
            }}
          />
        </div>
      );
    };
    return (
      <div>
        <div className="form-field">
          <label>Title</label>
          <input value={section.title || ""} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {renderSide("left")}
          {renderSide("right")}
        </div>
        <p style={{ fontSize: 12, color: "var(--muted)" }}>Available field keys for this request type are listed in the "Available Fields" panel on the right.</p>
      </div>
    );
  }

  if (section.type === "approval_summary") {
    return (
      <div className="form-field">
        <label>Title</label>
        <input value={section.title || ""} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
    );
  }

  if (section.type === "disclaimer") {
    return (
      <div>
        <div className="form-field">
          <label>Title</label>
          <input value={section.title || ""} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
        <label style={{ display: "block", marginTop: 10, marginBottom: 4 }}>Items (one per line)</label>
        <textarea
          rows={6}
          value={(section.disclaimerItems || []).join("\n")}
          onChange={(e) => onChange({ disclaimerItems: e.target.value.split("\n").filter(Boolean) })}
        />
      </div>
    );
  }

  return <div style={{ color: "var(--muted)", fontSize: 13 }}>This section type has no configurable options.</div>;
}

function PermissionsScreen({ template, onBack }: { template: Template; onBack: () => void }) {
  const [rows, setRows] = useState<PermissionRow[]>([]);
  const [groups, setGroups] = useState<{ name: string }[]>([]);
  const [directory, setDirectory] = useState<{ id: string; full_name: string; email: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [permType, setPermType] = useState<"ALL" | "GROUP" | "USER">("ALL");
  const [groupName, setGroupName] = useState("");
  const [userId, setUserId] = useState("");
  const [canView, setCanView] = useState(true);
  const [canDesign, setCanDesign] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [permRows, groupRows, dir] = await Promise.all([
        api.pdfTemplatePermissions(template.id),
        api.permissionGroups(),
        api.companyDirectory()
      ]);
      setRows(permRows);
      setGroups(groupRows);
      setDirectory(dir);
    } catch (err: any) {
      void showNotice(err?.message || "Failed to load permissions.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [template.id]);

  const addPermission = async () => {
    try {
      await api.addPdfTemplatePermission(template.id, {
        permission_type: permType,
        group_name: permType === "GROUP" ? groupName : undefined,
        user_id: permType === "USER" ? userId : undefined,
        can_view_pdf: canView,
        can_design_pdf: canDesign
      });
      setGroupName(""); setUserId(""); setCanView(true); setCanDesign(false);
      await load();
    } catch (err: any) {
      void showNotice(err?.message || "Failed to add permission.");
    }
  };

  const removePermission = async (permId: string) => {
    try {
      await api.removePdfTemplatePermission(template.id, permId);
      await load();
    } catch (err: any) {
      void showNotice(err?.message || "Failed to remove permission.");
    }
  };

  return (
    <div className="ep-page">
      <button className="button small-button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 8 }}>&larr; Back</button>
      <h2 style={{ marginTop: 0 }}>PDF Permissions — {REQUEST_TYPE_LABELS[template.request_type]}</h2>
      <p style={{ fontSize: 13, color: "var(--muted)" }}>
        Who can view or design PDFs for this request type — independent of who can view or approve the request itself.
        A person can always view the PDF of their own submitted request.
      </p>

      <div className="card" style={{ padding: 18, marginBottom: 18 }}>
        <div className="form-grid-3">
          <div className="form-field">
            <label>Grant To</label>
            <select value={permType} onChange={(e) => setPermType(e.target.value as any)}>
              <option value="ALL">Everyone</option>
              <option value="GROUP">Team / Group / Role</option>
              <option value="USER">Specific Person</option>
            </select>
          </div>
          {permType === "GROUP" && (
            <div className="form-field">
              <label>Group</label>
              <select value={groupName} onChange={(e) => setGroupName(e.target.value)}>
                <option value="">Select a group</option>
                {groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
              </select>
            </div>
          )}
          {permType === "USER" && (
            <div className="form-field">
              <label>Person</label>
              <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Select a person</option>
                {directory.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
              </select>
            </div>
          )}
          <div className="form-field">
            <label>Can View PDF</label>
            <select value={canView ? "yes" : "no"} onChange={(e) => setCanView(e.target.value === "yes")}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
          <div className="form-field">
            <label>Can Design Templates</label>
            <select value={canDesign ? "yes" : "no"} onChange={(e) => setCanDesign(e.target.value === "yes")}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
        </div>
        <button className="button small-button" type="button" onClick={addPermission} style={{ marginTop: 10 }}>
          <Plus size={14} style={{ marginRight: 4 }} />Add Grant
        </button>
      </div>

      {loading ? (
        <div className="tracking-loading"><RefreshCw className="rl-spin" size={20} /> Loading...</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="ep-table">
            <thead><tr><th>Grant</th><th>Can View</th><th>Can Design</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.permission_type === "ALL" && "Everyone"}
                    {r.permission_type === "GROUP" && r.group_name}
                    {r.permission_type === "USER" && (r.user_name || r.user_email)}
                  </td>
                  <td><span className={`status-pill ${r.can_view_pdf ? "status-pill-success" : "status-pill-danger"}`}>{r.can_view_pdf ? "Yes" : "No"}</span></td>
                  <td><span className={`status-pill ${r.can_design_pdf ? "status-pill-info" : "status-pill"}`}>{r.can_design_pdf ? "Yes" : "No"}</span></td>
                  <td><button className="ep-icon-btn" title="Remove" onClick={() => removePermission(r.id)}><Trash2 size={14} /></button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} style={{ color: "var(--muted)" }}>No grants yet — nobody outside ADMIN can view or design these PDFs.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LetterheadScreen({ onBack }: { onBack: () => void }) {
  const [companyName, setCompanyName] = useState("");
  const [addressLines, setAddressLines] = useState("");
  const [contactLine, setContactLine] = useState("");
  const [footerText, setFooterText] = useState("");
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.pdfLetterhead();
        if (data) {
          setCompanyName(data.company_name || "");
          setAddressLines((data.address_lines || []).join("\n"));
          setContactLine(data.contact_line || "");
          setFooterText(data.footer_confidentiality_text || "");
          setLogoPath(data.logo_path || null);
        }
      } catch (err: any) {
        void showNotice(err?.message || "Failed to load letterhead.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const refreshPreview = async (fields: { company_name: string; address_lines: string; contact_line: string; footer_text: string }) => {
    setPreviewLoading(true);
    try {
      const blob = await api.pdfLetterheadPreviewBlob(fields);
      const url = URL.createObjectURL(blob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch {
      // preview is a nice-to-have — a failure here shouldn't block editing
    } finally {
      setPreviewLoading(false);
    }
  };

  // Debounced live preview: regenerate ~600ms after the admin stops typing,
  // and once as soon as the saved letterhead first loads.
  useEffect(() => {
    if (loading) return;
    const handle = setTimeout(() => {
      void refreshPreview({ company_name: companyName, address_lines: addressLines, contact_line: contactLine, footer_text: footerText });
    }, 600);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, companyName, addressLines, contactLine, footerText, logoPath]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const save = async () => {
    setSaving(true);
    try {
      await api.updatePdfLetterhead({
        company_name: companyName,
        address_lines: addressLines.split("\n").filter(Boolean),
        contact_line: contactLine,
        footer_confidentiality_text: footerText
      });
      void showNotice("Letterhead saved.");
    } catch (err: any) {
      void showNotice(err?.message || "Failed to save letterhead.");
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (file: File) => {
    try {
      const result = await api.uploadPdfLetterheadLogo(file);
      setLogoPath(result.logo_path);
      await refreshPreview({ company_name: companyName, address_lines: addressLines, contact_line: contactLine, footer_text: footerText });
    } catch (err: any) {
      void showNotice(err?.message || "Failed to upload logo.");
    }
  };

  if (loading) return <div className="ep-page"><div className="tracking-loading"><RefreshCw className="rl-spin" size={20} /> Loading...</div></div>;

  return (
    <div className="ep-page">
      <button className="button small-button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 8 }}>&larr; Back</button>
      <h2 style={{ marginTop: 0 }}>Letterhead</h2>
      <p style={{ fontSize: 13, color: "var(--muted)" }}>Shared across every PDF template — editing this updates the header/footer on all of them.</p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 480px) 1fr", gap: 18, alignItems: "start" }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="form-field">
            <label>Logo</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {logoPath && <span style={{ fontSize: 12, color: "var(--muted)" }}>Logo uploaded</span>}
              <label className="button small-button" style={{ cursor: "pointer" }}>
                <Upload size={14} style={{ marginRight: 4 }} />Upload
                <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} />
              </label>
            </div>
          </div>
          <div className="form-field">
            <label>Company Name</label>
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Address (one line per row)</label>
            <textarea rows={3} value={addressLines} onChange={(e) => setAddressLines(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Contact Line</label>
            <input value={contactLine} onChange={(e) => setContactLine(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Footer Confidentiality Text</label>
            <input value={footerText} onChange={(e) => setFooterText(e.target.value)} />
          </div>
          <button className="button" type="button" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save Letterhead"}</button>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>A4 Preview</h3>
            {previewLoading && <RefreshCw className="rl-spin" size={14} />}
          </div>
          {previewUrl ? (
            <div style={{ border: "1px solid var(--border, #e2e8f0)", borderRadius: 8, overflow: "hidden", aspectRatio: "1 / 1.414", maxWidth: 480, margin: "0 auto", background: "#fff" }}>
              <iframe title="Letterhead preview" src={previewUrl} style={{ width: "100%", height: "100%", border: "none" }} />
            </div>
          ) : (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Generating preview...</div>
          )}
          <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>
            Updates automatically as you edit — the logo shown is always the last uploaded one, even before you save the text fields.
          </p>
        </div>
      </div>
    </div>
  );
}
