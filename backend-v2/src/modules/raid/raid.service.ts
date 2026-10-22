import { query } from "../../lib/db.js";
import { hasFeatureAccess } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { brsOwnerIds, isBrsCoWriter, isBrsContributor, isBrsReviewer, recordBrsRevision, brsActorRole } from "../brs/brs.service.js";
import { hasDistributionAccess } from "../distributions/distributions.routes.js";
import { canManageChangeRequest, crActorRole, isChangeCollaborator, isSubmissionAssignee, recordCrRevision } from "../custom-requests/change-collab.service.js";
import { isInProvisioningPool } from "../it-provisioning/it-provisioning.service.js";

// A RAID log (Risks, Assumptions, Issues, Dependencies) on one BRS, Change
// Request or Computer Request. Items are numbered per document and type
// (R1, A1, I1, D1...) and every change also lands in the document's history.

export const RAID_DOC_TYPES = ["BRS", "CHANGE_REQUEST", "COMPUTER_REQUEST"] as const;
export type RaidDocType = (typeof RAID_DOC_TYPES)[number];
export const RAID_TYPES = ["RISK", "ASSUMPTION", "ISSUE", "DEPENDENCY"] as const;
export const RAID_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export const RAID_STATUSES = ["OPEN", "IN_PROGRESS", "MONITORING", "CLOSED"] as const;
export const RAID_PREFIX: Record<string, string> = { RISK: "R", ASSUMPTION: "A", ISSUE: "I", DEPENDENCY: "D" };
export const DOC_LABEL: Record<RaidDocType, string> = { BRS: "BRS", CHANGE_REQUEST: "Change Request", COMPUTER_REQUEST: "Computer Request" };

export async function ensureRaidSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS raid_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_type text NOT NULL CHECK (doc_type IN ('BRS','CHANGE_REQUEST','COMPUTER_REQUEST')),
      doc_id uuid NOT NULL,
      item_type text NOT NULL CHECK (item_type IN ('RISK','ASSUMPTION','ISSUE','DEPENDENCY')),
      ref_no integer NOT NULL,
      title text NOT NULL,
      description text,
      likelihood text CHECK (likelihood IN ('HIGH','MEDIUM','LOW')),
      impact text CHECK (impact IN ('HIGH','MEDIUM','LOW')),
      action text,
      owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      owner_text text,
      due_date date,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','MONITORING','CLOSED')),
      closed_at timestamptz,
      created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT raid_items_ref_uq UNIQUE (doc_type, doc_id, item_type, ref_no)
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_raid_items_doc ON raid_items(doc_type, doc_id)`);
}

type Actor = { userId: string; role: string; teamId?: string | null; sectionId?: string | null; department?: string | null };
export type RaidDoc = { docType: RaidDocType; id: string; reference: string; title: string; row: any };

// The document behind a RAID log, checked against its type.
export async function loadRaidDoc(docType: RaidDocType, docId: string): Promise<RaidDoc> {
  if (docType === "BRS") {
    const row = (await query<any>(`SELECT * FROM brs_documents WHERE id = $1`, [docId]))[0];
    if (!row) throw notFound("BRS not found");
    return { docType, id: row.id, reference: row.reference_no || "", title: row.title, row };
  }
  const row = (await query<any>(
    `SELECT s.*, rt.code AS request_type_code FROM custom_request_submissions s JOIN custom_request_types rt ON rt.id = s.request_type_id WHERE s.id = $1`,
    [docId]
  ))[0];
  if (!row || row.request_type_code !== docType) throw notFound(`${DOC_LABEL[docType]} not found`);
  const title = docType === "CHANGE_REQUEST"
    ? String(row.data?.description_of_change || "Change Request")
    : `Computer Request${row.data?.computer_type ? ` — ${row.data.computer_type}` : ""}`;
  return { docType, id: row.id, reference: `${docType === "CHANGE_REQUEST" ? "CHG" : "CR"}-${String(row.id).slice(0, 8).toUpperCase()}`, title: title.slice(0, 200), row };
}

async function fieldsOf(requestTypeId: string) {
  return query<{ field_key: string; field_type: string }>(
    `SELECT field_key, field_type FROM request_type_fields WHERE request_type_id = $1 AND is_active = true`, [requestTypeId]
  );
}

// view: may read the log and export it. edit: may add and update items
// (everyone working on the document - not someone it was only distributed
// to). manage: may also delete other people's items.
export async function raidAccess(doc: RaidDoc, actor: Actor): Promise<{ view: boolean; edit: boolean; manage: boolean }> {
  const isAdmin = actor.role === "ADMIN";
  const r = doc.row;
  if (doc.docType === "BRS") {
    const manage = isAdmin || r.requester_id === actor.userId || brsOwnerIds(r).includes(actor.userId);
    let working = manage
      || await isBrsCoWriter(r.id, actor.userId) || await isBrsContributor(r.id, actor.userId) || await isBrsReviewer(r.id, actor.userId);
    if (!working && r.brs_approval_submission_id) {
      working = !!(await query(`SELECT 1 FROM custom_request_submissions WHERE id = $1 AND approval_chain @> $2::jsonb`,
        [r.brs_approval_submission_id, JSON.stringify([{ approver_id: actor.userId }])]))[0];
    }
    const view = working || await hasDistributionAccess("BRS", r.id, actor.userId);
    return { view, edit: working, manage };
  }
  const onChain = (r.approval_chain || []).some((s: any) => s.approver_id === actor.userId);
  if (doc.docType === "CHANGE_REQUEST") {
    const manage = canManageChangeRequest(r, actor);
    const working = manage || onChain || isSubmissionAssignee(r.data, await fieldsOf(r.request_type_id), actor) || await isChangeCollaborator(r, actor.userId);
    const view = working || await hasDistributionAccess("CHANGE_REQUEST", r.id, actor.userId);
    return { view, edit: working && r.status !== "CANCELLED", manage };
  }
  // Computer Request: the requester, its approvers and IT Provisioning.
  const it = await hasFeatureAccess(actor.userId, actor.role, "it_provisioning", ["ADMIN"]) || await isInProvisioningPool(actor.userId);
  const manage = isAdmin || r.requester_id === actor.userId || it;
  const working = manage || onChain;
  return { view: working, edit: working && r.status !== "CANCELLED", manage };
}

export function raidRef(item: { item_type: string; ref_no: number }) {
  return `${RAID_PREFIX[item.item_type] || "?"}${item.ref_no}`;
}

// The same event in the document's own history (BRS, or the custom request's).
export async function recordRaidHistory(doc: RaidDoc, actor: Actor, summary: string, changes?: Array<{ key: string; label: string; before: unknown; after: unknown }>) {
  if (doc.docType === "BRS") {
    await recordBrsRevision({ documentId: doc.id, kind: "RAID_CHANGED", actorId: actor.userId, actorRole: await brsActorRole(doc.row, actor), summary });
    return;
  }
  const role = doc.docType === "CHANGE_REQUEST"
    ? await crActorRole(doc.row, actor, await fieldsOf(doc.row.request_type_id))
    : doc.row.requester_id === actor.userId ? "CREATOR" : (doc.row.approval_chain || []).some((s: any) => s.approver_id === actor.userId) ? "APPROVER" : actor.role === "ADMIN" ? "ADMIN" : "OTHER";
  await recordCrRevision({ submissionId: doc.id, kind: "RAID_CHANGED", actorId: actor.userId, actorRole: role, summary, sectionTitle: "RAID log", changes: changes ?? null });
}
