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
    `UPDATE brs_documents SET phase = 'BASELINE', current_version_id = $1, updated_at = now() WHERE id = $2`,
    [version.id, documentId]
  );
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
