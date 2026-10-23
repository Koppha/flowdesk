import { query } from "../../lib/db.js";
import { notifyEarlierApprovers } from "../../lib/approvalChanges.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { brsActorOrg, brsMemberMatch, brsMemberParams } from "../brs/brs.service.js";
import { hasDistributionAccess } from "../distributions/distributions.routes.js";

// Change Request collaboration, modelled on BRS: a creator (requester_id),
// any number of owners (full rights, same as the creator), co-writers -
// people or whole groups - with the permissions the creator/owners grant,
// sections (the form's own groups plus sections added to one request),
// comments, and an audit trail of every change with before/after values.

// ── Schema ───────────────────────────────────────────────────────────────────
export async function ensureChangeCollabSchema() {
  await query(`ALTER TABLE custom_request_submissions ADD COLUMN IF NOT EXISTS owner_user_ids uuid[] NOT NULL DEFAULT '{}'`);
  await query(`
    CREATE TABLE IF NOT EXISTS cr_collaborators (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id uuid NOT NULL REFERENCES custom_request_submissions(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      section_ref_id uuid REFERENCES sections(id) ON DELETE CASCADE,
      team_ref_id uuid REFERENCES teams(id) ON DELETE CASCADE,
      division_name text,
      permissions text[] NOT NULL DEFAULT ARRAY['EDIT']::text[],
      added_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cr_collab_sub ON cr_collaborators(submission_id)`);
  await query(`
    CREATE TABLE IF NOT EXISTS cr_custom_sections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id uuid NOT NULL REFERENCES custom_request_submissions(id) ON DELETE CASCADE,
      title text NOT NULL,
      description text,
      content text NOT NULL DEFAULT '',
      sort_order integer NOT NULL DEFAULT 0,
      added_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cr_sections_sub ON cr_custom_sections(submission_id)`);
  await query(`
    CREATE TABLE IF NOT EXISTS cr_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id uuid NOT NULL REFERENCES custom_request_submissions(id) ON DELETE CASCADE,
      section_key text,
      section_title text,
      author_id uuid REFERENCES users(id) ON DELETE SET NULL,
      author_role text,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cr_comments_sub ON cr_comments(submission_id, created_at)`);
  // One row per event. `changes` = [{key, label, before, after}] for edits,
  // so "who changed what" needs no diffing at read time.
  await query(`
    CREATE TABLE IF NOT EXISTS cr_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id uuid NOT NULL REFERENCES custom_request_submissions(id) ON DELETE CASCADE,
      kind text NOT NULL,
      summary text NOT NULL,
      section_key text,
      section_title text,
      changes jsonb,
      status text,
      actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
      actor_role text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cr_revisions_sub ON cr_revisions(submission_id, created_at)`);
  // When each person last opened the request - drives "new since your last visit".
  await query(`
    CREATE TABLE IF NOT EXISTS cr_seen (
      submission_id uuid NOT NULL REFERENCES custom_request_submissions(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (submission_id, user_id)
    )`);
}

// ── Sections ─────────────────────────────────────────────────────────────────
// The Change Request form's fields grouped into sections. A field not listed
// here (e.g. one an admin adds later) lands in "Other details".
export const CR_FORM_SECTIONS: Array<{ key: string; title: string; fields?: string[]; prefixes?: string[] }> = [
  { key: "request", title: "Request details", fields: ["related_brs_document_id", "department", "date_requested", "change_assignee", "is_urgent", "priority"] },
  { key: "type", title: "Change type & category", prefixes: ["change_type_", "category_"] },
  { key: "description", title: "Description & justification", fields: ["description_of_change", "business_justification", "affected_areas", "business_implications"] },
  { key: "technical", title: "Technical details", fields: ["component_name", "platform", "dependencies", "number_of_changes"] },
  { key: "schedule", title: "Schedule & implementor", fields: ["implementation_date", "change_implementor", "time_required", "time_scheduled"] },
  { key: "risk", title: "Risk & impact", fields: ["risk", "impact"] },
  { key: "plan", title: "Implementation & back-out", fields: ["implementation_plan", "back_out_plan", "documentation_required"] },
  { key: "callout", title: "Callout", fields: ["callout_person", "callout_contact_no"] }
];
export const CR_OTHER_SECTION = { key: "other", title: "Other details" };

export function formSectionOf(fieldKey: string) {
  return CR_FORM_SECTIONS.find((s) => s.fields?.includes(fieldKey) || s.prefixes?.some((p) => fieldKey.startsWith(p))) ?? CR_OTHER_SECTION;
}

// ── Assignees and submit rights (shared with custom-requests.routes.ts) ──────
// A "user_multi" assignee (e.g. Change Assignee) is one person (id, or an
// invited email), or a whole group: a Section (teams), a Department
// (sections) or a Division (users.department, by name). Any one member of a
// group can confirm for it.
export type AssigneeActor = { userId: string; teamId?: string | null; sectionId?: string | null; department?: string | null };

export function assigneeMatches(a: any, actor: AssigneeActor) {
  if (!a) return false;
  if (a.id && a.id === actor.userId) return true;
  if (a.teamId && actor.teamId && a.teamId === actor.teamId) return true;
  if (a.departmentId && actor.sectionId && a.departmentId === actor.sectionId) return true;
  if (a.divisionName && actor.department && String(a.divisionName).trim().toLowerCase() === String(actor.department).trim().toLowerCase()) return true;
  return false;
}

export function assigneeLabel(a: any) {
  if (a?.teamId) return `Section: ${a.teamName}`;
  if (a?.departmentId) return `Department: ${a.departmentName}`;
  if (a?.divisionName) return `Division: ${a.divisionName}`;
  return a?.name || a?.email || "—";
}

// True if the actor (themselves, or through a group they're in) appears in
// any "user_multi" field's assignee array on this submission.
export function isSubmissionAssignee(
  data: Record<string, any>,
  fields: Array<{ field_key: string; field_type: string }>,
  actor: AssigneeActor
): boolean {
  return fields.some((f) => {
    if (f.field_type !== "user_multi") return false;
    const arr = data?.[f.field_key];
    return Array.isArray(arr) && arr.some((a: any) => assigneeMatches(a, actor));
  });
}

export async function assertCanSubmit(userId: string, role: string, department: string | null, employmentType: string | null, requestTypeId: string) {
  if (role === "ADMIN") return;
  const perm = await query<{ id: string }>(
    `SELECT id FROM request_type_permissions
      WHERE request_type_id = $1 AND can_submit = true
        AND (
          permission_type = 'ALL'
          OR (permission_type = 'USER' AND user_id = $2)
          OR (permission_type = 'DEPARTMENT' AND lower(trim(department)) = lower(trim($3)))
          OR (permission_type = 'EMPLOYMENT_TYPE' AND upper(trim(employment_type)) = upper(trim($4)))
        )
      LIMIT 1`,
    [requestTypeId, userId, department ?? "", employmentType ?? ""]
  );
  if (!perm[0]) throw forbidden("You do not have permission to submit this request type");
}

// ── People and permissions ───────────────────────────────────────────────────
export const CR_PERMISSIONS = ["EDIT", "INVITE", "SUBMIT", "DISTRIBUTE"] as const;
export type CrPermission = (typeof CR_PERMISSIONS)[number];

type OwnedSubmission = { id: string; requester_id: string; owner_user_ids?: string[] | null };

export function crOwnerIds(sub: OwnedSubmission): string[] {
  return Array.isArray(sub.owner_user_ids) ? sub.owner_user_ids : [];
}

export function canManageChangeRequest(sub: OwnedSubmission, actor: { userId: string; role: string }) {
  return actor.role === "ADMIN" || sub.requester_id === actor.userId || crOwnerIds(sub).includes(actor.userId);
}

// Union of every co-writer entry naming the actor (themselves or a group they're in).
export async function crCoWriterPermissions(submissionId: string, userId: string): Promise<{ isCoWriter: boolean; perms: Set<CrPermission> }> {
  const org = await brsActorOrg(userId);
  const rows = await query<{ permissions: string[] }>(
    `SELECT c.permissions FROM cr_collaborators c WHERE c.submission_id = $1 AND ${brsMemberMatch("c", 2)}`,
    [submissionId, ...brsMemberParams(org)]
  );
  const perms = new Set<CrPermission>();
  for (const r of rows) for (const p of r.permissions || []) if ((CR_PERMISSIONS as readonly string[]).includes(p)) perms.add(p as CrPermission);
  return { isCoWriter: rows.length > 0, perms };
}

export async function crPermissions(sub: OwnedSubmission, actor: { userId: string; role: string }) {
  if (canManageChangeRequest(sub, actor)) {
    return { manage: true, edit: true, invite: true, submit: true, distribute: true, coWriter: false };
  }
  const { isCoWriter, perms } = await crCoWriterPermissions(sub.id, actor.userId);
  return { manage: false, edit: perms.has("EDIT"), invite: perms.has("INVITE"), submit: perms.has("SUBMIT"), distribute: perms.has("DISTRIBUTE"), coWriter: isCoWriter };
}

export type CrActorRole = "CREATOR" | "OWNER" | "CO_WRITER" | "CONTRIBUTOR" | "APPROVER" | "ADMIN" | "OTHER";

// The capacity someone acted in, kept on every audit entry. An assignee on
// the form (Change Assignee) shows as a Contributor.
export async function crActorRole(
  sub: OwnedSubmission & { approval_chain?: Array<{ approver_id: string }> | null; data?: any },
  actor: { userId: string; role: string } & AssigneeActor,
  fields?: Array<{ field_key: string; field_type: string }>
): Promise<CrActorRole> {
  if (sub.requester_id === actor.userId) return "CREATOR";
  if (crOwnerIds(sub).includes(actor.userId)) return "OWNER";
  if ((await crCoWriterPermissions(sub.id, actor.userId)).isCoWriter) return "CO_WRITER";
  if (fields && isSubmissionAssignee(sub.data, fields, actor)) return "CONTRIBUTOR";
  if ((sub.approval_chain || []).some((s) => s.approver_id === actor.userId)) return "APPROVER";
  return actor.role === "ADMIN" ? "ADMIN" : "OTHER";
}

// Owners and co-writers (including through a group) may open the request.
export async function isChangeCollaborator(sub: OwnedSubmission, userId: string) {
  if (crOwnerIds(sub).includes(userId)) return true;
  return (await crCoWriterPermissions(sub.id, userId)).isCoWriter;
}

// Everyone who may open a Change Request: admin, creator, owners, co-writers,
// approvers on the chain, assignees on the form, and distribution recipients.
export async function canViewChangeRequest(
  sub: OwnedSubmission & { approval_chain?: Array<{ approver_id: string }> | null; data?: any },
  actor: { userId: string; role: string } & AssigneeActor,
  fields: Array<{ field_key: string; field_type: string }>
) {
  if (actor.role === "ADMIN" || sub.requester_id === actor.userId) return true;
  if ((sub.approval_chain || []).some((s) => s.approver_id === actor.userId)) return true;
  if (isSubmissionAssignee(sub.data, fields, actor)) return true;
  if (await isChangeCollaborator(sub, actor.userId)) return true;
  return hasDistributionAccess("CHANGE_REQUEST", sub.id, actor.userId);
}

// ── Audit trail ──────────────────────────────────────────────────────────────
export type CrRevisionKind =
  | "CREATED" | "DRAFT_CREATED" | "SUBMITTED" | "FIELDS_SAVED" | "SECTION_ADDED" | "SECTION_REMOVED" | "SECTION_SAVED"
  | "PEOPLE_CHANGED" | "COMMENTED" | "ASSIGNEE_ADDED" | "ASSIGNEE_CONFIRMED" | "APPROVAL_ACTION"
  | "CANCELLED" | "CLOSED" | "DISTRIBUTED" | "RAID_CHANGED";

export type FieldChange = { key: string; label: string; before: unknown; after: unknown };

export async function recordCrRevision(args: {
  submissionId: string;
  kind: CrRevisionKind;
  actorId: string | null;
  actorRole: CrActorRole | null;
  summary: string;
  sectionKey?: string | null;
  sectionTitle?: string | null;
  changes?: FieldChange[] | null;
}) {
  const status = (await query<{ status: string }>(`SELECT status FROM custom_request_submissions WHERE id = $1`, [args.submissionId]))[0]?.status ?? null;
  await query(
    `INSERT INTO cr_revisions (submission_id, kind, summary, section_key, section_title, changes, status, actor_id, actor_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [args.submissionId, args.kind, args.summary, args.sectionKey ?? null, args.sectionTitle ?? null,
     args.changes ? JSON.stringify(args.changes) : null, status, args.actorId, args.actorRole]
  );
  // Edited while out for approval: tell anyone who already approved.
  if (status === "IN_PROGRESS" && ["FIELDS_SAVED", "SECTION_SAVED", "SECTION_ADDED", "SECTION_REMOVED"].includes(args.kind)) {
    const sub = (await query<any>(`SELECT approval_chain, data FROM custom_request_submissions WHERE id = $1`, [args.submissionId]))[0];
    if (sub) {
      void notifyEarlierApprovers({
        docType: "CHANGE_REQUEST", docId: args.submissionId, title: String(sub.data?.description_of_change || "Change Request").slice(0, 120),
        chain: sub.approval_chain || [], actorId: args.actorId, summary: args.summary
      });
    }
  }
}

function sameValue(a: unknown, b: unknown) {
  const norm = (v: unknown) => (v === undefined || v === null || v === "" || v === false ? null : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// The fields whose value actually changed, with labels, for the audit trail.
export function diffFields(
  before: Record<string, any>,
  updates: Record<string, any>,
  fields: Array<{ field_key: string; field_label: string }>
): FieldChange[] {
  const labelOf = new Map(fields.map((f) => [f.field_key, f.field_label]));
  const out: FieldChange[] = [];
  for (const [key, after] of Object.entries(updates)) {
    if (sameValue(before?.[key], after)) continue;
    out.push({ key, label: labelOf.get(key) || key, before: before?.[key] ?? null, after: after ?? null });
  }
  return out;
}

// One audit row for a save: which section(s) it touched and a short summary.
export function describeFieldSave(changes: FieldChange[]) {
  const sections = [...new Map(changes.map((c) => { const s = formSectionOf(c.key); return [s.key, s]; })).values()];
  const labels = changes.map((c) => c.label);
  const summary = `Edited ${labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`}`;
  return { summary, sectionKey: sections.length === 1 ? sections[0].key : null, sectionTitle: sections.map((s) => s.title).join(", ") };
}

// RAID CR R3: a change with Significant or Major impact must say how it
// will be backed out if it goes wrong.
export const BACK_OUT_REQUIRED_IMPACTS = ["SIGNIFICANT", "MAJOR"];
export function assertBackOutPlan(data: Record<string, any> | null | undefined) {
  const impact = String(data?.impact || "").toUpperCase();
  if (BACK_OUT_REQUIRED_IMPACTS.includes(impact) && !String(data?.back_out_plan || "").trim()) {
    throw badRequest(`A Back-out Plan is required when Impact is ${impact === "MAJOR" ? "Major" : "Significant"} - say how the change will be undone if it goes wrong.`);
  }
}
