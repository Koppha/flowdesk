import { query } from "../../lib/db.js";
import { notifyBrsReturnedToDraft } from "../../lib/notifications.js";

export type BrsSectionRow = {
  id: string;
  document_id: string;
  section_key: string;
  title: string;
  owner_phase: "DRAFT" | "DEPT_INPUT";
  is_required: boolean;
  content_html: string | null;
  status: "PENDING" | "IN_PROGRESS" | "SUBMITTED";
};

// ── Group membership ─────────────────────────────────────────────────────────
// A person, or a whole Department (sections), Section (teams) or Division
// (users.department) can be a co-writer or section assignee. Read live from
// users so a move between teams takes effect at once, not at next login.
export type BrsActorOrg = { userId: string; sectionId: string | null; teamId: string | null; division: string | null };

export async function brsActorOrg(userId: string): Promise<BrsActorOrg> {
  const u = (await query<{ section_id: string | null; team_id: string | null; department: string | null }>(
    `SELECT section_id, team_id, department FROM users WHERE id = $1`, [userId]
  ))[0];
  return { userId, sectionId: u?.section_id ?? null, teamId: u?.team_id ?? null, division: u?.department ?? null };
}

// SQL condition matching a row (alias a) that names the actor or one of
// their groups. $start..$start+3 = userId, sectionId, teamId, division.
export function brsMemberMatch(alias: string, start: number) {
  return `(${alias}.user_id = $${start}
     OR (${alias}.section_ref_id IS NOT NULL AND ${alias}.section_ref_id = $${start + 1})
     OR (${alias}.team_ref_id IS NOT NULL AND ${alias}.team_ref_id = $${start + 2})
     OR (${alias}.division_name IS NOT NULL AND lower(trim(${alias}.division_name)) = lower(trim(coalesce($${start + 3}::text, '')))))`;
}
export function brsMemberParams(org: BrsActorOrg) {
  return [org.userId, org.sectionId, org.teamId, org.division];
}

export async function isBrsCoWriter(documentId: string, userId: string) {
  const org = await brsActorOrg(userId);
  const rows = await query<{ id: string }>(
    `SELECT c.id FROM brs_document_collaborators c WHERE c.document_id = $1 AND ${brsMemberMatch("c", 2)} LIMIT 1`,
    [documentId, ...brsMemberParams(org)]
  );
  return rows.length > 0;
}

export async function isBrsReviewer(documentId: string, userId: string) {
  const org = await brsActorOrg(userId);
  const rows = await query<{ id: string }>(
    `SELECT r.id FROM brs_document_reviewers r WHERE r.document_id = $1 AND ${brsMemberMatch("r", 2)} LIMIT 1`,
    [documentId, ...brsMemberParams(org)]
  );
  return rows.length > 0;
}

export async function isBrsContributor(documentId: string, userId: string, sectionId?: string) {
  const org = await brsActorOrg(userId);
  const rows = await query<{ id: string }>(
    `SELECT a.id FROM brs_document_section_assignees a JOIN brs_document_sections s ON s.id = a.section_id
      WHERE s.document_id = $1 ${sectionId ? "AND s.id = $6" : ""} AND ${brsMemberMatch("a", 2)} LIMIT 1`,
    [documentId, ...brsMemberParams(org), ...(sectionId ? [sectionId] : [])]
  );
  return rows.length > 0;
}

// ── People and roles ─────────────────────────────────────────────────────────
// Owners of a BRS (any number, all with full rights). Falls back to the
// single legacy owner_user_id for a row read before the migration ran.
export type BrsOwnedDoc = { requester_id: string; owner_user_id?: string | null; owner_user_ids?: string[] | null };
export function brsOwnerIds(doc: BrsOwnedDoc): string[] {
  const ids = Array.isArray(doc.owner_user_ids) ? doc.owner_user_ids : [];
  return ids.length ? ids : doc.owner_user_id ? [doc.owner_user_id] : [];
}
export function isBrsOwner(doc: BrsOwnedDoc, userId: string) {
  return brsOwnerIds(doc).includes(userId);
}

// CREATOR (requester_id) and OWNERS (owner_user_ids) have full rights; a
// CO_WRITER edits content; a CONTRIBUTOR is a section assignee; APPROVER is
// on the approval chain. Recorded on every audit entry so the trail shows the
// capacity each person acted in, not just their name.
export type BrsActorRole = "CREATOR" | "OWNER" | "CO_WRITER" | "CONTRIBUTOR" | "REVIEWER" | "APPROVER" | "ADMIN" | "OTHER";

export async function brsActorRole(
  doc: { id: string; brs_approval_submission_id?: string | null } & BrsOwnedDoc,
  actor: { userId: string; role: string; sectionId?: string | null }
): Promise<BrsActorRole> {
  if (doc.requester_id === actor.userId) return "CREATOR";
  if (isBrsOwner(doc, actor.userId)) return "OWNER";
  if (await isBrsCoWriter(doc.id, actor.userId)) return "CO_WRITER";
  if (await isBrsContributor(doc.id, actor.userId)) return "CONTRIBUTOR";
  if (await isBrsReviewer(doc.id, actor.userId)) return "REVIEWER";
  if (doc.brs_approval_submission_id) {
    const onChain = await query<{ id: string }>(
      `SELECT id FROM custom_request_submissions WHERE id = $1 AND approval_chain @> $2::jsonb`,
      [doc.brs_approval_submission_id, JSON.stringify([{ approver_id: actor.userId }])]
    );
    if (onChain[0]) return "APPROVER";
  }
  return actor.role === "ADMIN" ? "ADMIN" : "OTHER";
}

// ── Co-writer permissions ───────────────────────────────────────────────────
export const BRS_PERMISSIONS = ["EDIT", "INVITE", "WORKFLOW", "DISTRIBUTE", "AMEND"] as const;
export type BrsPermission = (typeof BRS_PERMISSIONS)[number];

// Union of every co-writer entry that names the actor (themselves or a
// group they're in).
export async function brsCoWriterPermissions(documentId: string, userId: string): Promise<{ isCoWriter: boolean; perms: Set<BrsPermission> }> {
  const org = await brsActorOrg(userId);
  const rows = await query<{ permissions: string[] }>(
    `SELECT c.permissions FROM brs_document_collaborators c WHERE c.document_id = $1 AND ${brsMemberMatch("c", 2)}`,
    [documentId, ...brsMemberParams(org)]
  );
  const perms = new Set<BrsPermission>();
  for (const r of rows) for (const p of r.permissions || []) if ((BRS_PERMISSIONS as readonly string[]).includes(p)) perms.add(p as BrsPermission);
  return { isCoWriter: rows.length > 0, perms };
}

// What the actor may do on this BRS. Creator, owner and admin can do
// everything, and only they manage people/permissions; co-writers get
// exactly what they were granted.
export async function brsPermissions(
  doc: { id: string } & BrsOwnedDoc,
  actor: { userId: string; role: string }
) {
  if (canManageBrs(doc, actor)) {
    return { manage: true, edit: true, invite: true, workflow: true, distribute: true, amend: true };
  }
  const { perms } = await brsCoWriterPermissions(doc.id, actor.userId);
  return { manage: false, edit: perms.has("EDIT"), invite: perms.has("INVITE"), workflow: perms.has("WORKFLOW"), distribute: perms.has("DISTRIBUTE"), amend: perms.has("AMEND") };
}

// Full rights: drive the workflow, route, distribute, amend, manage people.
export function canManageBrs(doc: BrsOwnedDoc, actor: { userId: string; role: string }) {
  return actor.role === "ADMIN" || doc.requester_id === actor.userId || isBrsOwner(doc, actor.userId);
}

// Content rights: everyone with full rights, plus co-writers granted EDIT.
export async function canWriteBrs(doc: { id: string } & BrsOwnedDoc, actor: { userId: string; role: string }) {
  if (canManageBrs(doc, actor)) return true;
  return (await brsCoWriterPermissions(doc.id, actor.userId)).perms.has("EDIT");
}

// ── Audit trail ──────────────────────────────────────────────────────────────
export async function recordBrsRevision(args: {
  documentId: string;
  kind: "CREATED" | "SECTION_ADDED" | "SECTION_REMOVED" | "REVIEWERS_CHANGED" | "COMMENTED" | "SECTION_SAVED" | "INTAKE_SAVED" | "PEOPLE_CHANGED" | "PHASE" | "ROUTED" | "APPROVAL_ACTION" | "BASELINED" | "RETURNED" | "REOPENED" | "AMENDMENT_STARTED";
  actorId: string | null;
  actorRole: BrsActorRole | null;
  summary: string;
  sectionId?: string | null;
  sectionTitle?: string | null;
  contentHtml?: string | null;
  intakeData?: unknown;
}) {
  const phase = (await query<{ phase: string }>(`SELECT phase FROM brs_documents WHERE id = $1`, [args.documentId]))[0]?.phase ?? null;
  await query(
    `INSERT INTO brs_document_revisions (document_id, kind, section_id, section_title, content_html, intake_data, summary, phase, actor_id, actor_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [args.documentId, args.kind, args.sectionId ?? null, args.sectionTitle ?? null, args.contentHtml ?? null,
     args.intakeData === undefined ? null : JSON.stringify(args.intakeData), args.summary, phase, args.actorId, args.actorRole]
  );
}

// An approved BRS reopened for amendment: back to Draft, the approved
// version stays on record, re-approval baselines the next version.
export async function startBrsAmendment(documentId: string) {
  const doc = (await query<{ current_version_id: string | null }>(`SELECT current_version_id FROM brs_documents WHERE id = $1`, [documentId]))[0];
  const current = doc?.current_version_id
    ? (await query<{ version_number: number }>(`SELECT version_number FROM brs_document_versions WHERE id = $1`, [doc.current_version_id]))[0]?.version_number ?? null
    : null;
  await query(
    `UPDATE brs_document_sections SET status = 'IN_PROGRESS', updated_at = now() WHERE document_id = $1 AND status = 'SUBMITTED'`,
    [documentId]
  );
  await query(
    `UPDATE brs_documents SET phase = 'DRAFT', amending_from_version = $1, brs_approval_submission_id = NULL, return_comment = NULL, updated_at = now() WHERE id = $2`,
    [current, documentId]
  );
  return current;
}

// Generates the next human-readable reference number, e.g. "BRS-2026-0007".
// Backed by a real sequence (see ensureBrsSchema) so concurrent Intake
// submissions never collide.
export async function nextBrsReferenceNo(): Promise<string> {
  const row = (await query<{ n: string }>(`SELECT nextval('brs_reference_seq')::text AS n`))[0];
  const year = new Date().getFullYear();
  return `BRS-${year}-${row.n.padStart(4, "0")}`;
}

// A required section counts as blank for gate purposes whether it's never
// been touched or was filled with only whitespace/empty markup.
function isSectionContentBlank(html: string | null | undefined): boolean {
  if (!html) return true;
  const stripped = html.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
  return stripped.length === 0;
}

// Re-checked server-side every time — never trust the client's word that the
// gate already passed. Required sections block regardless of which phase
// owns them (a still-blank Draft section blocks just as much as a still-blank
// Department Input one).
export async function checkConsistencyGate(documentId: string): Promise<{
  passed: boolean;
  blockingSections: Array<{ id: string; title: string; ownerPhase: string }>;
}> {
  const sections = await query<BrsSectionRow>(
    `SELECT id, document_id, section_key, title, owner_phase, is_required, content_html, status
       FROM brs_document_sections WHERE document_id = $1`,
    [documentId]
  );
  const blocking = sections.filter((s) => s.is_required && isSectionContentBlank(s.content_html));
  return {
    passed: blocking.length === 0,
    blockingSections: blocking.map((s) => ({ id: s.id, title: s.title, ownerPhase: s.owner_phase }))
  };
}

// Called once, right when a BRS_APPROVAL submission's approval chain
// completes (see performCustomRequestAction in custom-requests.routes.ts).
// Freezes the document's current content into a new version, locks it, and
// leaves brs_documents.phase = 'BASELINE'.
export async function baselineBrsDocument(documentId: string | null | undefined, submissionId: string, baselinedById: string | null): Promise<void> {
  if (!documentId) return;
  const doc = (await query<{ id: string; title: string; intake_data: any }>(
    `SELECT id, title, intake_data FROM brs_documents WHERE id = $1`, [documentId]
  ))[0];
  if (!doc) return;

  const sections = await query<BrsSectionRow>(
    `SELECT id, document_id, section_key, title, owner_phase, is_required, content_html, status
       FROM brs_document_sections WHERE document_id = $1 ORDER BY sort_order`,
    [documentId]
  );

  const nextVersion = (await query<{ n: number }>(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM brs_document_versions WHERE document_id = $1`,
    [documentId]
  ))[0].n;

  const snapshot = {
    title: doc.title,
    intake_data: doc.intake_data,
    sections: sections.map((s) => ({ section_key: s.section_key, title: s.title, content_html: s.content_html }))
  };

  const version = (await query<{ id: string }>(
    `INSERT INTO brs_document_versions (document_id, version_number, snapshot, baselined_by_id, baselined_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [documentId, nextVersion, JSON.stringify(snapshot), baselinedById]
  ))[0];

  await query(
    `UPDATE brs_documents SET phase = 'BASELINE', current_version_id = $1, amending_from_version = NULL, updated_at = now() WHERE id = $2`,
    [version.id, documentId]
  );
  await recordBrsRevision({
    documentId, kind: "BASELINED", actorId: baselinedById, actorRole: "APPROVER",
    summary: `Fully approved — baselined as version ${nextVersion}`
  });
}

// Called when a BRS_APPROVAL submission is rejected at any step — bounces
// the document back to Draft for rework. Nothing is wiped: section content
// stays exactly as it was, so the requester only has to fix what the
// rejecting approver flagged, not start over.
export async function returnBrsDocumentToDraft(
  documentId: string | null | undefined,
  comment: string | null,
  returnedBy: string | null
): Promise<void> {
  if (!documentId) return;
  const doc = (await query<{ id: string; title: string; requester_id: string }>(
    `SELECT id, title, requester_id FROM brs_documents WHERE id = $1`, [documentId]
  ))[0];
  if (!doc) return;

  await query(
    `UPDATE brs_documents SET phase = 'DRAFT', return_comment = $1, brs_approval_submission_id = NULL, updated_at = now() WHERE id = $2`,
    [comment, documentId]
  );
  await recordBrsRevision({
    documentId, kind: "RETURNED", actorId: null, actorRole: "APPROVER",
    summary: `Returned to Draft by ${returnedBy || "an approver"}${comment ? `: ${comment}` : ""}`
  });

  const requester = (await query<{ email: string; full_name: string | null }>(
    `SELECT email, full_name FROM users WHERE id = $1`, [doc.requester_id]
  ))[0];
  void notifyBrsReturnedToDraft({
    documentId: doc.id,
    brsTitle: doc.title,
    requesterEmail: requester?.email ?? null,
    requesterName: requester?.full_name ?? null,
    returnedBy,
    comment
  });
}

// Called when the REQUESTER themselves decides to go back and fix content
// or the approval chain, rather than waiting for an approver to reject it.
// Unlike returnBrsDocumentToDraft (which leaves section content untouched
// because the approval chain rejecting it is itself already terminal), this
// also has to actively withdraw any approval routing still in flight - the
// document is jumping back to Draft on its own initiative, so any approvals
// already given are discarded along with it, and any section a contributor
// had locked in as SUBMITTED is reopened for editing (otherwise going back
// to Draft/Department Input would still render it permanently read-only).
export async function reopenBrsDocumentForEditing(
  documentId: string,
  comment: string | null,
  _reopenedBy: string | null
): Promise<void> {
  const doc = (await query<{ id: string; brs_approval_submission_id: string | null }>(
    `SELECT id, brs_approval_submission_id FROM brs_documents WHERE id = $1`, [documentId]
  ))[0];
  if (!doc) return;

  if (doc.brs_approval_submission_id) {
    await query(
      `UPDATE custom_request_submissions
          SET status = 'CANCELLED', cancel_comment = $1, cancelled_at = now(), updated_at = now()
        WHERE id = $2 AND status = 'IN_PROGRESS'`,
      [comment || "Reopened by requester for further edits", doc.brs_approval_submission_id]
    );
  }

  await query(
    `UPDATE brs_document_sections SET status = 'IN_PROGRESS', updated_at = now()
      WHERE document_id = $1 AND status = 'SUBMITTED'`,
    [documentId]
  );

  await query(
    `UPDATE brs_documents SET phase = 'DRAFT', return_comment = $1, brs_approval_submission_id = NULL, updated_at = now() WHERE id = $2`,
    [comment, documentId]
  );
}
