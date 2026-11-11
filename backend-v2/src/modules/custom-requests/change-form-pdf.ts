import { query } from "../../lib/db.js";
import type { CrFormCheck, CrFormPdfData } from "../../lib/pdf/changeRequestFormPdf.js";
import { assigneeLabel, changeRequestReference } from "./change-collab.service.js";

// Everything the printed Change Control form shows for one Change Request,
// with values already turned into what a reader expects (option labels,
// names, Yes/No).

// The paper form's order for change types; any type added later follows.
const TYPE_ORDER = ["hardware", "system_software", "applications", "environment", "network", "configuration", "business_rule"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadChangeRequestFormData(submissionId: string): Promise<CrFormPdfData> {
  const sub = (await query<any>(
    `SELECT s.*, to_char(s.implementation_date, 'YYYY-MM-DD') AS closed_implementation_date,
            u.full_name AS requester_name, u.department AS requester_department
       FROM custom_request_submissions s JOIN users u ON u.id = s.requester_id
      WHERE s.id = $1`,
    [submissionId]
  ))[0];
  const fields = await query<{ field_key: string; field_label: string; field_type: string; options: any }>(
    `SELECT field_key, field_label, field_type, options FROM request_type_fields WHERE request_type_id = $1 AND is_active = true ORDER BY sort_order, created_at`,
    [sub.request_type_id]
  );
  const d = sub.data || {};
  const text = (key: string) => (d[key] === undefined || d[key] === null || d[key] === "" ? null : String(d[key]));
  const option = (key: string) => {
    const f = fields.find((x) => x.field_key === key);
    return (Array.isArray(f?.options) ? f!.options : []).find((o: any) => o.value === d[key])?.label ?? text(key);
  };
  const checks = (prefix: string, order: string[] = []): CrFormCheck[] => {
    const rank = (key: string) => { const i = order.indexOf(key.slice(prefix.length)); return i < 0 ? order.length : i; };
    return fields
      .filter((f) => f.field_type === "checkbox" && f.field_key.startsWith(prefix))
      .map((f, i) => ({ f, i }))
      .sort((a, b) => rank(a.f.field_key) - rank(b.f.field_key) || a.i - b.i)
      .map(({ f }) => ({ label: f.field_label, checked: !!d[f.field_key] }));
  };

  let relatedBrs: string | null = null;
  if (UUID.test(String(d.related_brs_document_id || ""))) {
    const brs = (await query<{ reference_no: string | null; title: string }>(`SELECT reference_no, title FROM brs_documents WHERE id = $1`, [d.related_brs_document_id]))[0];
    if (brs) relatedBrs = [brs.reference_no, brs.title].filter(Boolean).join(" — ");
  }
  const extraSections = await query<{ title: string; content: string }>(
    `SELECT title, content FROM cr_custom_sections WHERE submission_id = $1 ORDER BY sort_order, created_at`, [sub.id]
  );
  const closedBy = sub.closed_at
    ? (await query<{ name: string | null }>(
        `SELECT u.full_name AS name FROM cr_revisions r LEFT JOIN users u ON u.id = r.actor_id
          WHERE r.submission_id = $1 AND r.kind = 'CLOSED' ORDER BY r.created_at DESC LIMIT 1`, [sub.id]
      ))[0]?.name ?? null
    : null;

  const chain: any[] = Array.isArray(sub.approval_chain) ? sub.approval_chain : [];
  return {
    reference: changeRequestReference(sub.id),
    date: new Date(sub.created_at).toISOString(),
    status: sub.status,
    requested_by: sub.requester_name,
    department: text("department") ?? sub.requester_department ?? null,
    related_brs: relatedBrs,
    date_requested: text("date_requested"),
    assignees: Array.isArray(d.change_assignee) && d.change_assignee.length ? d.change_assignee.map(assigneeLabel).join(", ") : null,
    change_types: checks("change_type_", TYPE_ORDER),
    categories: checks("category_"),
    urgent: !!d.is_urgent,
    description: text("description_of_change"),
    justification: text("business_justification"),
    affected_areas: text("affected_areas"),
    priority: option("priority"),
    component: text("component_name"),
    platform: text("platform"),
    dependencies: text("dependencies"),
    number_of_changes: text("number_of_changes"),
    implementation_date: text("implementation_date"),
    implementor: text("change_implementor"),
    time_required: text("time_required"),
    time_scheduled: text("time_scheduled"),
    risk: option("risk"),
    impact: option("impact"),
    implementation_plan: text("implementation_plan"),
    back_out_plan: text("back_out_plan"),
    callout_person: text("callout_person"),
    callout_contact: text("callout_contact_no"),
    documentation: text("documentation_required"),
    business_implications: text("business_implications"),
    extra_sections: extraSections,
    approvals: chain.map((s, i) => ({
      position: String(s.position_name || "Approver"),
      name: s.approver_name ?? null,
      decision: s.decision_type === "NOTE" ? "NOTE" : "APPROVE",
      status: s.status ?? null,
      acted_at: s.acted_at ?? null,
      comment: s.comment ?? null,
      current: sub.status === "IN_PROGRESS" && i === sub.current_step_order
    })),
    closure: sub.closed_at
      ? { closed_at: new Date(sub.closed_at).toISOString(), closed_by: closedBy, implementation_date: sub.closed_implementation_date, notes: sub.closure_notes ?? null }
      : null
  };
}
