import fs from "fs";
import path from "path";
import { query } from "../../lib/db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { stampSignature, stampDocumentFooter, stampSignatureMarkAtPosition, generateVerificationCode, hashBuffer } from "../../lib/pdf/signatureStamp.js";
import { stampTextAnnotations, stampTickMarks, type TickMarkInput } from "../../lib/pdf/textAnnotate.js";
import { getStringSystemSetting, setStringSystemSetting, getBooleanSystemSetting, setBooleanSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { env } from "../../config/env.js";
import { notifySignatureTurn, notifySignatureRejected, notifySignatureCompleted } from "../../lib/notifications.js";
import { readStoredFile, writeStoredFile, ensureLocalFile } from "../../lib/fileStore.js";
import { sendPushToUser } from "../../lib/push.js";

// FlowDesk Mobile push for a routing document - the url opens the app's
// signing screen straight on this document (mobile src/app/sign.tsx).
// Best-effort and alongside the email, never instead of it.
function pushDocument(userId: string, doc: { id: string }, title: string, body: string) {
  void sendPushToUser(userId, { title, body, data: { docType: "SIGNABLE_DOCUMENT", docId: doc.id, url: `/sign?doc=${doc.id}` } });
}

export const signatureUploadDir = path.join(process.env.UPLOAD_DIR || "uploads", "signatures");
if (!fs.existsSync(signatureUploadDir)) fs.mkdirSync(signatureUploadDir, { recursive: true });

export type SignatureNotation = "AI" | "PP";

// The org's configured default, and whether a signer may override it for a
// specific signature - two separate settings, not one, exactly as scoped:
// an admin can lock the notation entirely, or set a default the signer can
// still change at the point of signing.
export async function getSignatureNotationPolicy(): Promise<{ default: SignatureNotation; overridable: boolean }> {
  const raw = await getStringSystemSetting(SYSTEM_SETTING_KEYS.signatureDelegationNotation, "PP");
  const overridable = await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureDelegationNotationOverridable, true);
  return { default: raw === "AI" ? "AI" : "PP", overridable };
}

export async function setSignatureNotationPolicy(input: { notation: SignatureNotation; overridable: boolean }) {
  await setStringSystemSetting(SYSTEM_SETTING_KEYS.signatureDelegationNotation, input.notation);
  await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.signatureDelegationNotationOverridable, input.overridable);
}

export function verificationUrlFor(code: string): string {
  const base = (env.APP_URL || "").replace(/\/$/, "");
  return `${base}/signatures/verify/${code}`;
}

export interface SignDocumentInput {
  title: string;
  originalBuffer: Buffer;
  originalFileName: string;
  contentType: string;
  signerId: string;
  signerName: string;
  signerIp: string | null;
  consentStatement: string;
  typedSignatureText?: string | null;
  signatureImageDataUrl?: string | null;
  // Present only when signing under someone else's authority.
  authorityUserId?: string | null;
  authorityName?: string | null;
  // Only honoured when the org policy allows a per-signature override;
  // otherwise the resolved policy default is used regardless of this value.
  requestedNotation?: SignatureNotation | null;
  sourceType?: string | null;
  sourceId?: string | null;
  // Where the signer placed it (Quick sign "Place it myself"). Without it,
  // the signature block goes at the bottom of the last page as before.
  placement?: { pageNumber: number; xPct: number; yPct: number; widthPct: number } | null;
}

export async function performSignDocument(input: SignDocumentInput) {
  if (input.authorityUserId && !input.authorityName) throw badRequest("Authority user name is required when signing on behalf of someone else");

  let notation: SignatureNotation | null = null;
  if (input.authorityUserId) {
    const policy = await getSignatureNotationPolicy();
    notation = policy.overridable && input.requestedNotation ? input.requestedNotation : policy.default;
  }

  if (!input.typedSignatureText && !input.signatureImageDataUrl) {
    throw badRequest("A typed name or a drawn signature is required to sign");
  }

  const verificationCode = generateVerificationCode();
  const signedAt = new Date();

  const placed = input.placement
    ? await (async () => {
        // The verification code goes in the footer; the signature where they put it.
        const footer = await stampDocumentFooter(input.originalBuffer, { verificationCode, verificationUrl: verificationUrlFor(verificationCode) });
        const displayName = input.authorityName && notation ? `${input.signerName} (${notation === "AI" ? "a.i." : "p.p."})` : input.signerName;
        return stampSignatureMarkAtPosition(footer.buffer, {
          ...input.placement!, signerName: displayName, signedAt,
          signatureImageDataUrl: input.signatureImageDataUrl ?? null, typedSignatureText: input.typedSignatureText ?? null
        });
      })()
    : null;
  const { buffer: signedBuffer, contentHash } = placed ?? await stampSignature(input.originalBuffer, {
    signerName: input.signerName,
    authorityName: input.authorityName ?? null,
    notation,
    signedAt,
    verificationCode,
    verificationUrl: verificationUrlFor(verificationCode),
    signatureImageDataUrl: input.signatureImageDataUrl ?? null,
    typedSignatureText: input.typedSignatureText ?? null
  });

  const originalFilePath = path.join(signatureUploadDir, `${Date.now()}-original-${sanitizeName(input.originalFileName)}`);
  const signedFilePath = path.join(signatureUploadDir, `${Date.now()}-signed-${sanitizeName(input.originalFileName)}`);
  await writeStoredFile(originalFilePath, input.originalBuffer);
  await writeStoredFile(signedFilePath, signedBuffer);

  const row = (await query<{ id: string }>(
    `INSERT INTO document_signatures
       (verification_code, title, source_type, source_id, signer_id, authority_user_id, delegation_notation,
        signature_typed_name, signature_image, consent_statement, original_file_path, original_file_name,
        signed_file_path, content_hash, signer_ip, signed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      verificationCode, input.title, input.sourceType ?? null, input.sourceId ?? null,
      input.signerId, input.authorityUserId ?? null, notation,
      input.typedSignatureText ?? null, input.signatureImageDataUrl ?? null, input.consentStatement,
      originalFilePath, input.originalFileName, signedFilePath, contentHash, input.signerIp, signedAt
    ]
  ))[0];

  return { id: row.id, verificationCode, contentHash, signedFilePath };
}

function sanitizeName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150) || "document.pdf";
}

export async function getSignatureRecord(id: string) {
  const row = (await query<any>(`SELECT * FROM document_signatures WHERE id = $1`, [id]))[0];
  if (!row) throw notFound();
  return row;
}

export async function getSignatureByCode(code: string) {
  return (await query<any>(`SELECT * FROM document_signatures WHERE verification_code = $1`, [code.trim().toUpperCase()]))[0] ?? null;
}

// Recomputes the hash of whatever is on disk right now and compares it
// against what was recorded at signing time - the actual tamper check.
// A mismatch here means the file changed after it was signed.
export async function verifyFileIntegrity(filePath: string, recordedHash: string): Promise<boolean> {
  const localPath = await ensureLocalFile(filePath);
  if (!localPath) return false;
  return hashBuffer(fs.readFileSync(localPath)) === recordedHash;
}

export interface SavedSignature {
  signatureType: "type" | "draw";
  typedName: string | null;
  imageDataUrl: string | null;
}

export async function getSavedSignature(userId: string): Promise<SavedSignature | null> {
  const row = (await query<any>(`SELECT signature_type, typed_name, image_data_url FROM user_saved_signatures WHERE user_id = $1`, [userId]))[0];
  if (!row) return null;
  return { signatureType: row.signature_type, typedName: row.typed_name, imageDataUrl: row.image_data_url };
}

export async function saveSavedSignature(userId: string, input: SavedSignature): Promise<void> {
  await query(
    `INSERT INTO user_saved_signatures (user_id, signature_type, typed_name, image_data_url, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (user_id) DO UPDATE SET signature_type = $2, typed_name = $3, image_data_url = $4, updated_at = now()`,
    [userId, input.signatureType, input.typedName, input.imageDataUrl]
  );
}

export async function clearSavedSignature(userId: string): Promise<void> {
  await query(`DELETE FROM user_saved_signatures WHERE user_id = $1`, [userId]);
}

// ---------------------------------------------------------------------
// Routing documents - one shared PDF, multiple signers over time, each
// placing their mark at a spot they pick on the rendered page (built for
// paper-style multi-GM sign-off sheets). Distributed purely by sharing the
// document's link/code - there's no per-recipient inbox or notification
// here, matching the standalone-module scope this was built to.
// ---------------------------------------------------------------------

export interface RoutingChainStep {
  approver_id: string;
  approver_name: string;
  status: "PENDING" | "SIGNED" | "REJECTED";
  comment: string | null;
  acted_at: string | null;
}

export interface CreateSignableDocumentInput {
  title: string;
  originalBuffer: Buffer;
  originalFileName: string;
  createdById: string;
  // Ordered list of approvers the creator picked, already resolved to
  // real users (id + name) by the route handler - empty/omitted keeps the
  // original free-for-all behavior, where anyone with the link can sign in
  // any order.
  approvalChain?: { approverId: string; approverName: string }[];
}

export async function createSignableDocument(input: CreateSignableDocumentInput) {
  const verificationCode = generateVerificationCode();
  const { buffer: stampedBuffer, contentHash } = await stampDocumentFooter(input.originalBuffer, {
    verificationCode,
    verificationUrl: verificationUrlFor(verificationCode)
  });

  const originalFilePath = path.join(signatureUploadDir, `${Date.now()}-routing-original-${sanitizeName(input.originalFileName)}`);
  const currentFilePath = path.join(signatureUploadDir, `${Date.now()}-routing-current-${sanitizeName(input.originalFileName)}`);
  await writeStoredFile(originalFilePath, input.originalBuffer);
  await writeStoredFile(currentFilePath, stampedBuffer);

  const chain: RoutingChainStep[] = (input.approvalChain || []).map((s) => ({
    approver_id: s.approverId, approver_name: s.approverName, status: "PENDING", comment: null, acted_at: null
  }));

  const row = (await query<{ id: string }>(
    `INSERT INTO signable_documents
       (verification_code, title, original_file_path, original_file_name, current_file_path, current_content_hash, created_by_id, approval_chain)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [verificationCode, input.title, originalFilePath, input.originalFileName, currentFilePath, contentHash, input.createdById, JSON.stringify(chain)]
  ))[0];

  const doc = await getSignableDocument(row.id);
  // No email when the creator signs first - they're already on the document.
  if (chain.length > 0) await notifyStepApprover(doc, chain, 0);
  return doc;
}

// Emails whoever sits at `stepIndex` that a document is waiting on them -
// used both when a route first opens (step 0) and every time signing
// advances current_step_order to a new person.
async function notifyStepApprover(doc: any, chain: RoutingChainStep[], stepIndex: number) {
  const step = chain[stepIndex];
  if (!step) return;
  // Never email the creator about a turn on their own document - it's in
  // their Inbox and they started it.
  if (step.approver_id === doc.created_by_id) return;
  const user = (await query<{ email: string; full_name: string | null }>(`SELECT email, full_name FROM users WHERE id = $1`, [step.approver_id]))[0];
  if (!user) return;
  await notifySignatureTurn({
    documentId: doc.id, documentTitle: doc.title,
    approverEmail: user.email, approverName: user.full_name,
    stepLabel: `step ${stepIndex + 1} of ${chain.length}`,
    verificationUrl: verificationUrlFor(doc.verification_code)
  });
  pushDocument(step.approver_id, doc, "Document awaiting your signature", doc.title);
}

// Chain rules: an empty chain means free-for-all (anyone with the link can
// sign) until the creator finishes it - then it's COMPLETED and closed. A
// non-empty chain restricts action to whoever sits at current_step_order,
// and only while the document is still OPEN - once REJECTED or COMPLETED,
// nobody can act.
export function assertCanActOnDocument(doc: any, userId: string): RoutingChainStep[] {
  const chain: RoutingChainStep[] = Array.isArray(doc.approval_chain) ? doc.approval_chain : [];
  if (chain.length === 0) {
    if (doc.status !== "OPEN") throw forbidden(doc.status === "DELETED" ? "This document was deleted." : "Signing on this document has been finished - it can't be signed or changed any more.");
    return chain;
  }
  if (doc.status !== "OPEN") throw forbidden(doc.status === "DELETED" ? "This document was deleted." : doc.status === "REJECTED" ? "This document was rejected and is no longer open for signing." : "This document's approval route is already complete.");
  const current = chain[doc.current_step_order];
  if (!current || current.approver_id !== userId) {
    throw forbidden("It isn't your turn to act on this document yet.");
  }
  return chain;
}

export async function getSignableDocument(id: string) {
  const row = (await query<any>(`SELECT * FROM signable_documents WHERE id = $1`, [id]))[0];
  if (!row) throw notFound();
  return row;
}

export async function getSignableDocumentByCode(code: string) {
  return (await query<any>(`SELECT * FROM signable_documents WHERE verification_code = $1`, [code.trim().toUpperCase()]))[0] ?? null;
}

export async function listSignableDocumentsForUser(userId: string) {
  return query<any>(
    `SELECT DISTINCT d.id, d.title, d.verification_code, d.created_at, d.updated_at, d.created_by_id,
            cb.full_name AS created_by_name,
            d.status, d.current_step_order, d.approval_chain,
            (d.created_by_id = $1) AS created_by_me,
            (
              d.status = 'OPEN'
              AND jsonb_array_length(d.approval_chain) > d.current_step_order
              AND (d.approval_chain -> d.current_step_order ->> 'approver_id') = $1::text
            ) AS is_my_turn
       FROM signable_documents d
       JOIN users cb ON cb.id = d.created_by_id
       LEFT JOIN document_signature_placements p ON p.document_id = d.id AND p.signer_id = $1
      WHERE d.status <> 'DELETED'
        AND (d.created_by_id = $1
         OR p.id IS NOT NULL
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.approval_chain) elem WHERE elem->>'approver_id' = $1::text))
      ORDER BY d.updated_at DESC`,
    [userId]
  );
}

// Admin oversight: every open, chain-based routing document company-wide,
// not just ones where it's literally the viewer's turn - mirrors the same
// "ADMIN sees everything, not just their own approvals" backstop every
// other request type already gives ADMIN. Signing itself still enforces
// strict turn order with no admin bypass (see assertCanActOnDocument) -
// this is visibility only, not a queue-jump.
export async function listOpenSignableDocumentsForAdmin() {
  return query<any>(
    `SELECT d.id, d.title, d.verification_code, d.created_at, d.updated_at, d.created_by_id,
            cb.full_name AS created_by_name,
            d.status, d.current_step_order, d.approval_chain
       FROM signable_documents d
       JOIN users cb ON cb.id = d.created_by_id
      WHERE d.status = 'OPEN' AND jsonb_array_length(d.approval_chain) > 0
      ORDER BY d.updated_at DESC`
  );
}

export async function listPlacementsForDocument(documentId: string) {
  return query<any>(
    `SELECT p.*, u.full_name AS signer_name, au.full_name AS authority_name
       FROM document_signature_placements p
       JOIN users u ON u.id = p.signer_id
       LEFT JOIN users au ON au.id = p.authority_user_id
      WHERE p.document_id = $1
      ORDER BY p.signed_at ASC`,
    [documentId]
  );
}

export interface AddSignaturePlacementInput {
  documentId: string;
  signerId: string;
  signerName: string;
  signerIp: string | null;
  consentStatement: string;
  pageNumber: number;
  xPct: number;
  yPct: number;
  widthPct: number;
  typedSignatureText?: string | null;
  signatureImageDataUrl?: string | null;
  authorityUserId?: string | null;
  authorityName?: string | null;
  requestedNotation?: SignatureNotation | null;
}

export async function addSignaturePlacement(input: AddSignaturePlacementInput) {
  if (!input.typedSignatureText && !input.signatureImageDataUrl) {
    throw badRequest("A typed name or a drawn signature is required to sign");
  }
  if (input.authorityUserId && !input.authorityName) throw badRequest("Authority user name is required when signing on behalf of someone else");

  const doc = await getSignableDocument(input.documentId);
  const chain = assertCanActOnDocument(doc, input.signerId);

  let notation: SignatureNotation | null = null;
  if (input.authorityUserId) {
    const policy = await getSignatureNotationPolicy();
    notation = policy.overridable && input.requestedNotation ? input.requestedNotation : policy.default;
  }

  const signedAt = new Date();
  const currentBuffer = await readStoredFile(doc.current_file_path);
  const displayName = input.authorityUserId && notation
    ? `${input.signerName} (${notation === "AI" ? "a.i." : "p.p."})`
    : input.signerName;
  const { buffer: stampedBuffer, contentHash } = await stampSignatureMarkAtPosition(currentBuffer, {
    pageNumber: input.pageNumber,
    xPct: input.xPct,
    yPct: input.yPct,
    widthPct: input.widthPct,
    signerName: displayName,
    signedAt,
    signatureImageDataUrl: input.signatureImageDataUrl ?? null,
    typedSignatureText: input.typedSignatureText ?? null
  });

  const nextFilePath = path.join(signatureUploadDir, `${Date.now()}-routing-current-${sanitizeName(doc.original_file_name)}`);
  await writeStoredFile(nextFilePath, stampedBuffer);

  const row = (await query<{ id: string }>(
    `INSERT INTO document_signature_placements
       (document_id, signer_id, authority_user_id, delegation_notation, signature_typed_name, signature_image,
        consent_statement, page_number, x_pct, y_pct, mark_width_pct, signer_ip, signed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.documentId, input.signerId, input.authorityUserId ?? null, notation,
      input.typedSignatureText ?? null, input.signatureImageDataUrl ?? null, input.consentStatement,
      input.pageNumber, input.xPct, input.yPct, input.widthPct, input.signerIp, signedAt
    ]
  ))[0];

  if (chain.length === 0) {
    await query(
      `UPDATE signable_documents SET current_file_path = $1, current_content_hash = $2, updated_at = now() WHERE id = $3`,
      [nextFilePath, contentHash, input.documentId]
    );
  } else {
    // Advance the route: mark the acting step SIGNED and move to the next
    // one - once the last step signs, the document is COMPLETED and
    // nobody can act on it further.
    const nextChain = chain.map((s, i) => i === doc.current_step_order ? { ...s, status: "SIGNED" as const, acted_at: signedAt.toISOString() } : s);
    const nextStepOrder = doc.current_step_order + 1;
    const nextStatus = nextStepOrder >= nextChain.length ? "COMPLETED" : "OPEN";
    await query(
      `UPDATE signable_documents
          SET current_file_path = $1, current_content_hash = $2, approval_chain = $3,
              current_step_order = $4, status = $5, updated_at = now()
        WHERE id = $6`,
      [nextFilePath, contentHash, JSON.stringify(nextChain), nextStepOrder, nextStatus, input.documentId]
    );

    if (nextStatus === "OPEN") {
      await notifyStepApprover(doc, nextChain, nextStepOrder);
    } else if (doc.created_by_id !== input.signerId) {
      // The creator signing last already knows it's complete.
      const creator = (await query<{ email: string; full_name: string | null }>(`SELECT email, full_name FROM users WHERE id = $1`, [doc.created_by_id]))[0];
      await notifySignatureCompleted({ documentId: doc.id, documentTitle: doc.title, creatorEmail: creator?.email ?? null, creatorName: creator?.full_name ?? null });
      pushDocument(doc.created_by_id, doc, "Document fully signed", doc.title);
    }
  }

  return { id: row.id, documentId: input.documentId, contentHash };
}

// The creator (or an admin) ends signing on a document with no route.
// A routed document ends on its own when the last approver signs.
export async function finishSignableDocument(documentId: string, actor: { userId: string; role: string }) {
  const doc = await getSignableDocument(documentId);
  const chain = Array.isArray(doc.approval_chain) ? doc.approval_chain : [];
  if (chain.length) throw badRequest("This document follows an approval route - it finishes when the last approver signs.");
  if (doc.status !== "OPEN") throw badRequest("Signing on this document has already been finished.");
  if (actor.role !== "ADMIN" && doc.created_by_id !== actor.userId) throw forbidden("Only the person who started this document can finish signing.");
  await query(
    `UPDATE signable_documents SET status = 'COMPLETED', closed_at = now(), closed_by_id = $2, updated_at = now() WHERE id = $1 AND status = 'OPEN'`,
    [documentId, actor.userId]
  );
}

export interface RejectSignableDocumentInput {
  documentId: string;
  signerId: string;
  signerName: string;
  comment: string;
}

// A rejection stops the route outright - no placement is recorded (nothing
// was signed), just the chain step's own status, so the audit trail shows
// exactly who declined and why without inventing a fake signature event.
export async function rejectSignableDocument(input: RejectSignableDocumentInput) {
  const doc = await getSignableDocument(input.documentId);
  const chain = assertCanActOnDocument(doc, input.signerId);
  if (chain.length === 0) throw badRequest("This document has no approval route to reject - it's open for anyone to sign freely.");

  const actedAt = new Date().toISOString();
  const nextChain = chain.map((s, i) => i === doc.current_step_order ? { ...s, status: "REJECTED" as const, comment: input.comment, acted_at: actedAt } : s);
  await query(
    `UPDATE signable_documents SET approval_chain = $1, status = 'REJECTED', updated_at = now() WHERE id = $2`,
    [JSON.stringify(nextChain), input.documentId]
  );

  // The reason goes to the creator and to everyone who already signed on
  // the route - never back to whoever rejected it.
  const earlierSigners = chain.filter((s, i) => i < doc.current_step_order && s.status === "SIGNED").map((s) => s.approver_id);
  const recipientIds = [...new Set([doc.created_by_id, ...earlierSigners])].filter((id) => id !== input.signerId);
  if (!recipientIds.length) return;
  const people = await query<{ id: string; email: string; full_name: string | null }>(`SELECT id, email, full_name FROM users WHERE id = ANY($1::uuid[])`, [recipientIds]);
  for (const p of people) {
    await notifySignatureRejected({
      documentId: doc.id, documentTitle: doc.title,
      creatorEmail: p.email, creatorName: p.full_name,
      rejectedByName: input.signerName, comment: input.comment,
      signedEarlier: p.id !== doc.created_by_id
    });
    pushDocument(p.id, doc, "Document rejected", `${doc.title} - ${input.signerName || "an approver"}: ${input.comment}`);
  }
}

export interface AddTextToDocumentInput {
  documentId: string;
  actorId: string;
  pageNumber: number;
  xPct: number;
  yPct: number;
  text: string;
  fontSize: number;
  color: string;
}

// Plain text, not a signature - same "is it your turn" gate as signing
// (so a routing document mid-approval can't be scribbled on by whoever
// gets the link), but doesn't touch the approval_chain/placements at all.
// Lets a signer add the odd missing note or fill in a cell by hand before
// or alongside placing their mark.
export async function addTextToDocument(input: AddTextToDocumentInput) {
  const doc = await getSignableDocument(input.documentId);
  assertCanActOnDocument(doc, input.actorId);

  const currentBuffer = await readStoredFile(doc.current_file_path);
  const buffer = await stampTextAnnotations(currentBuffer, [{
    pageNumber: input.pageNumber, xPct: input.xPct, yPct: input.yPct,
    text: input.text, fontSize: input.fontSize, color: input.color
  }]);
  const contentHash = hashBuffer(buffer);
  const nextFilePath = path.join(signatureUploadDir, `${Date.now()}-routing-current-${sanitizeName(doc.original_file_name)}`);
  await writeStoredFile(nextFilePath, buffer);
  await query(
    `UPDATE signable_documents SET current_file_path = $1, current_content_hash = $2, updated_at = now() WHERE id = $3`,
    [nextFilePath, contentHash, input.documentId]
  );
  await recordEdit(doc, input.actorId, "TEXT", nextFilePath, `text "${input.text.slice(0, 40)}"`);
  return { contentHash };
}

// A tick or cross (e.g. in a form's checkbox) - same "is it your turn" gate
// as adding text; doesn't touch the route or signatures.
export async function addTickToDocument(input: { documentId: string; actorId: string } & TickMarkInput) {
  const doc = await getSignableDocument(input.documentId);
  assertCanActOnDocument(doc, input.actorId);
  const buffer = await stampTickMarks(await readStoredFile(doc.current_file_path), [{
    pageNumber: input.pageNumber, xPct: input.xPct, yPct: input.yPct, sizePct: input.sizePct, kind: input.kind, color: input.color
  }]);
  const contentHash = hashBuffer(buffer);
  const nextFilePath = path.join(signatureUploadDir, `${Date.now()}-routing-current-${sanitizeName(doc.original_file_name)}`);
  await writeStoredFile(nextFilePath, buffer);
  await query(
    `UPDATE signable_documents SET current_file_path = $1, current_content_hash = $2, updated_at = now() WHERE id = $3`,
    [nextFilePath, contentHash, input.documentId]
  );
  await recordEdit(doc, input.actorId, "TICK", nextFilePath, input.kind === "CHECK" ? "tick" : "cross");
  return { contentHash };
}

// Records a text/tick change so it can be undone (see undoLastEdit).
async function recordEdit(doc: any, actorId: string, kind: "TEXT" | "TICK", newFilePath: string, summary: string) {
  await query(
    `INSERT INTO signable_document_edits (document_id, kind, actor_id, previous_file_path, previous_content_hash, new_file_path, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [doc.id, kind, actorId, doc.current_file_path, doc.current_content_hash, newFilePath, summary]
  );
}

// Undo: puts back the file from before the actor's latest text or tick -
// only while that change is still the document's latest (nothing signed or
// added since) and it's still their turn. Signatures can't be undone.
export async function undoLastEdit(documentId: string, actorId: string) {
  const doc = await getSignableDocument(documentId);
  assertCanActOnDocument(doc, actorId);
  const last = (await query<any>(
    `SELECT * FROM signable_document_edits WHERE document_id = $1 AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1`, [documentId]
  ))[0];
  if (!last || last.new_file_path !== doc.current_file_path) throw badRequest("There's nothing to undo - the last change was a signature, or nothing has been added yet.");
  if (last.actor_id !== actorId) throw forbidden("You can only undo your own changes.");
  await query(
    `UPDATE signable_documents SET current_file_path = $1, current_content_hash = $2, updated_at = now() WHERE id = $3`,
    [last.previous_file_path, last.previous_content_hash, documentId]
  );
  await query(`UPDATE signable_document_edits SET undone_at = now() WHERE id = $1`, [last.id]);
  return { undone: last.summary as string | null };
}

// How many of this person's text/tick changes can be undone right now.
export async function undoableEditCount(doc: any, actorId: string) {
  const rows = await query<any>(
    `SELECT actor_id, new_file_path FROM signable_document_edits WHERE document_id = $1 AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1`, [doc.id]
  );
  return rows[0] && rows[0].actor_id === actorId && rows[0].new_file_path === doc.current_file_path ? 1 : 0;
}

// Delete: the creator (or an admin) removes a document. It's hidden from
// every list and the Inbox and can't be signed; the record, its files and
// an audit_log entry (who, when, why, and its state at the time) are kept.
export async function deleteSignableDocument(documentId: string, actor: { userId: string; role: string }, reason: string) {
  const doc = await getSignableDocument(documentId);
  if (doc.status === "DELETED") throw badRequest("This document has already been deleted.");
  if (actor.role !== "ADMIN" && doc.created_by_id !== actor.userId) throw forbidden("Only the person who started this document can delete it.");
  const signatures = await query<{ n: number }>(`SELECT count(*)::int AS n FROM document_signature_placements WHERE document_id = $1`, [documentId]);
  await query(
    `UPDATE signable_documents SET status = 'DELETED', deleted_at = now(), deleted_by_id = $2, delete_reason = $3, updated_at = now() WHERE id = $1`,
    [documentId, actor.userId, reason]
  );
  await query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json)
     VALUES ($1, 'SIGNABLE_DOCUMENT_DELETED', 'signable_document', $2, $3, $4)`,
    [actor.userId, documentId,
     JSON.stringify({ title: doc.title, status: doc.status, verification_code: doc.verification_code, approval_chain: doc.approval_chain,
       current_step_order: doc.current_step_order, signatures: signatures[0]?.n ?? 0, current_file_path: doc.current_file_path, created_at: doc.created_at }),
     JSON.stringify({ status: "DELETED", reason })]
  );
}
