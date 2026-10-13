import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { notifyBrsSectionAssigned, notifyCustomRequestStep } from "../../lib/notifications.js";
import { checkConsistencyGate, nextBrsReferenceNo, reopenBrsDocumentForEditing } from "./brs.service.js";
import { renderBrsPdf } from "../../lib/pdf/brsDocumentPdfRenderer.js";
import type { PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";

export const brsRouter = Router();
brsRouter.use(requireAuth);

async function assertCanSubmit(userId: string, role: string, department: string | null, employmentType: string | null, brsTypeId: string) {
  if (role === "ADMIN") return;
  const perm = await query<{ id: string }>(
    `SELECT id FROM brs_type_permissions
      WHERE brs_type_id = $1 AND can_submit = true
        AND (
          permission_type = 'ALL'
          OR (permission_type = 'USER' AND user_id = $2)
          OR (permission_type = 'DEPARTMENT' AND lower(trim(department)) = lower(trim($3)))
          OR (permission_type = 'EMPLOYMENT_TYPE' AND upper(trim(employment_type)) = upper(trim($4)))
        )
      LIMIT 1`,
    [brsTypeId, userId, department ?? "", employmentType ?? ""]
  );
  if (!perm[0]) throw forbidden("You do not have permission to open a BRS of this type");
}

// True if the actor is one of this section's assignees — a matching user_id,
// or membership (by section_id) in a matching section_ref_id entry.
async function isSectionAssignee(sectionId: string, actor: { userId: string; sectionId?: string | null }): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM brs_document_section_assignees
      WHERE section_id = $1 AND (user_id = $2 OR (section_ref_id IS NOT NULL AND section_ref_id = $3))`,
    [sectionId, actor.userId, actor.sectionId ?? null]
  );
  return rows.length > 0;
}

async function loadDocumentOr404(id: string) {
  const doc = (await query<any>(
    `SELECT d.*, bt.name AS brs_type_name, bt.code AS brs_type_code
       FROM brs_documents d
       JOIN brs_types bt ON bt.id = d.brs_type_id
      WHERE d.id = $1`,
    [id]
  ))[0];
  if (!doc) throw notFound();
  return doc;
}

async function assertCanViewDocument(doc: any, actor: { userId: string; role: string; sectionId?: string | null }) {
  if (actor.role === "ADMIN" || doc.requester_id === actor.userId) return;
  const assignedSection = (await query<{ id: string }>(
    `SELECT s.id FROM brs_document_sections s
       JOIN brs_document_section_assignees a ON a.section_id = s.id
      WHERE s.document_id = $1 AND (a.user_id = $2 OR (a.section_ref_id IS NOT NULL AND a.section_ref_id = $3))
      LIMIT 1`,
    [doc.id, actor.userId, actor.sectionId ?? null]
  ))[0];
  if (assignedSection) return;
  if (doc.brs_approval_submission_id) {
    const onChain = (await query<{ id: string }>(
      `SELECT id FROM custom_request_submissions WHERE id = $1 AND approval_chain @> $2::jsonb`,
      [doc.brs_approval_submission_id, JSON.stringify([{ approver_id: actor.userId }])]
    ))[0];
    if (onChain) return;
  }
  throw forbidden("You do not have access to this BRS");
}

// POST /brs — Intake: create a document from an active brs_type, immediately
// entering Draft (Intake is just the opening form, not a separate wait state).
const CreateSchema = z.object({
  brs_type_id: z.string().uuid(),
  title: z.string().trim().min(1, "Title is required"),
  intake_data: z.record(z.string(), z.any()).default({})
});
brsRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid BRS payload", parsed.error.flatten());

    const brsType = (await query<{ id: string; status: string }>(
      `SELECT id, status FROM brs_types WHERE id = $1 AND is_active = true`, [parsed.data.brs_type_id]
    ))[0];
    if (!brsType) throw notFound("BRS type not found");
    if (brsType.status !== "ACTIVE") throw badRequest("This BRS type is not currently active");

    await assertCanSubmit(req.user!.userId, req.user!.role, req.user!.department ?? null, req.user!.employmentType ?? null, brsType.id);

    const typeSections = await query<{
      id: string; section_key: string; title: string; description: string | null;
      owner_phase: string; is_required: boolean; sla_hours: number | null; sort_order: number;
    }>(
      `SELECT id, section_key, title, description, owner_phase, is_required, sla_hours, sort_order
         FROM brs_type_sections WHERE brs_type_id = $1 AND is_active = true ORDER BY sort_order`,
      [brsType.id]
    );
    if (!typeSections.length) throw badRequest("This BRS type has no sections configured yet");

    const referenceNo = await nextBrsReferenceNo();
    const doc = (await query<{ id: string }>(
      `INSERT INTO brs_documents (brs_type_id, title, reference_no, requester_id, phase, intake_data)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5)
       RETURNING id`,
      [brsType.id, parsed.data.title, referenceNo, req.user!.userId, JSON.stringify(parsed.data.intake_data)]
    ))[0];

    // Snapshot the type's sections onto the document — a later admin edit to
    // the template must never mutate an in-flight document.
    const placeholders: string[] = [];
    const params: unknown[] = [];
    typeSections.forEach((s, i) => {
      const base = params.length + 1;
      params.push(doc.id, s.id, s.section_key, s.title, s.description, s.owner_phase, s.is_required, s.sla_hours, i);
      placeholders.push(`($${base},$${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`);
    });
    await query(
      `INSERT INTO brs_document_sections
         (document_id, type_section_id, section_key, title, description, owner_phase, is_required, sla_hours, sort_order)
       VALUES ${placeholders.join(",")}`,
      params
    );

    return res.status(201).json({ id: doc.id, reference_no: referenceNo });
  } catch (err) {
    return next(err);
  }
});

// GET /brs/mine
brsRouter.get("/mine", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT d.*, bt.name AS brs_type_name, u.full_name AS requester_name
         FROM brs_documents d
         JOIN brs_types bt ON bt.id = d.brs_type_id
         JOIN users u ON u.id = d.requester_id
        WHERE d.requester_id = $1
        ORDER BY d.created_at DESC`,
      [req.user!.userId]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /brs/assigned-to-me — documents where the current user (or their
// section) is assigned to at least one section.
brsRouter.get("/assigned-to-me", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT DISTINCT d.*, bt.name AS brs_type_name, u.full_name AS requester_name
         FROM brs_documents d
         JOIN brs_types bt ON bt.id = d.brs_type_id
         JOIN users u ON u.id = d.requester_id
         JOIN brs_document_sections s ON s.document_id = d.id
         JOIN brs_document_section_assignees a ON a.section_id = s.id
        WHERE a.user_id = $1 OR (a.section_ref_id IS NOT NULL AND a.section_ref_id = $2)
        ORDER BY d.created_at DESC`,
      [req.user!.userId, req.user!.sectionId ?? null]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /brs/:id — document detail, sections, assignees, live gate status.
brsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);

    const sections = await query(
      `SELECT * FROM brs_document_sections WHERE document_id = $1 ORDER BY sort_order`,
      [doc.id]
    );
    const sectionIds = sections.map((s: any) => s.id);
    const assignees = sectionIds.length
      ? await query(
          `SELECT a.*, u.full_name AS user_name, u.email AS user_email, sec.name AS section_name
             FROM brs_document_section_assignees a
             LEFT JOIN users u ON u.id = a.user_id
             LEFT JOIN sections sec ON sec.id = a.section_ref_id
            WHERE a.section_id = ANY($1::uuid[])`,
          [sectionIds]
        )
      : [];
    const gate = await checkConsistencyGate(doc.id);

    return res.json({
      ...doc,
      sections: sections.map((s: any) => ({
        ...s,
        assignees: assignees.filter((a: any) => a.section_id === s.id)
      })),
      gate
    });
  } catch (err) {
    return next(err);
  }
});

// DELETE /brs/:id — only the requester (or ADMIN) may delete, and only
// while still in Draft: once it's reached Department Input a contributor may
// already be relying on it, and once routed for Approval or baselined it has
// real approval history that must never just vanish - "Reopen for editing"
// (back to Draft) plus this delete covers every legitimate cleanup case
// without ever discarding a decision that was actually made. Cascades
// through sections/assignees/versions via the FKs' own ON DELETE CASCADE.
brsRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    if (req.user!.role !== "ADMIN" && doc.requester_id !== req.user!.userId) {
      throw forbidden("Only the requester can delete this BRS");
    }
    if (doc.phase !== "DRAFT") {
      throw badRequest("Only a BRS still in Draft can be deleted - reopen it for editing first if it's past that.");
    }
    await query(`DELETE FROM brs_documents WHERE id = $1`, [doc.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// PATCH /brs/:id/intake — the requester can come back and fill in/correct
// what was captured at Intake (department, owner, target quarter, programme
// type, business justification) any time before Approval Routing locks the
// document down for signing - Intake isn't a workflow step with its own
// gate like Draft/Department Input, just the document's cover-page metadata,
// so there's no "current step" restriction here beyond that.
const UpdateIntakeSchema = z.object({ intake_data: z.record(z.string(), z.any()) });
brsRouter.patch("/:id/intake", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateIntakeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid intake payload", parsed.error.flatten());

    const doc = await loadDocumentOr404(req.params.id);
    if (doc.phase === "APPROVAL" || doc.phase === "BASELINE") {
      throw badRequest("This BRS is no longer editable in its current phase");
    }
    if (req.user!.role !== "ADMIN" && doc.requester_id !== req.user!.userId) {
      throw forbidden("Only the requester can edit Intake");
    }

    const updated = { ...doc.intake_data, ...parsed.data.intake_data };
    await query(`UPDATE brs_documents SET intake_data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(updated), doc.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// PATCH /brs/:id/sections/:sectionId — write a section's content.
const UpdateSectionSchema = z.object({ content_html: z.string() });
brsRouter.patch("/:id/sections/:sectionId", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateSectionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid section payload", parsed.error.flatten());

    const doc = await loadDocumentOr404(req.params.id);
    if (doc.phase === "APPROVAL" || doc.phase === "BASELINE") {
      throw badRequest("This BRS is no longer editable in its current phase");
    }
    const section = (await query<any>(
      `SELECT * FROM brs_document_sections WHERE id = $1 AND document_id = $2`,
      [req.params.sectionId, doc.id]
    ))[0];
    if (!section) throw notFound();

    // The requester can always edit their own document's sections; anyone
    // else needs to actually be invited onto that section first (via the
    // assignee endpoints below) - true for Draft sections too, not just
    // Department Input ones, so the requester can bring in collaborators
    // (e.g. Legal, a co-author) to help draft without handing them the
    // whole document.
    const isOwner = doc.requester_id === req.user!.userId || (await isSectionAssignee(section.id, req.user!));
    if (req.user!.role !== "ADMIN" && !isOwner) throw forbidden("You are not the owner of this section");

    await query(
      `UPDATE brs_document_sections
          SET content_html = $1, status = CASE WHEN status = 'PENDING' THEN 'IN_PROGRESS' ELSE status END, updated_at = now()
        WHERE id = $2`,
      [parsed.data.content_html, section.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/sections/:sectionId/submit — the owner marks a section done.
brsRouter.post("/:id/sections/:sectionId/submit", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    const section = (await query<any>(
      `SELECT * FROM brs_document_sections WHERE id = $1 AND document_id = $2`,
      [req.params.sectionId, doc.id]
    ))[0];
    if (!section) throw notFound();

    const isOwner = section.owner_phase === "DRAFT"
      ? doc.requester_id === req.user!.userId
      : await isSectionAssignee(section.id, req.user!);
    if (req.user!.role !== "ADMIN" && !isOwner) throw forbidden("You are not the owner of this section");

    if (section.is_required && !section.content_html?.trim()) {
      throw badRequest("This section is required and can't be submitted empty");
    }

    await query(
      `UPDATE brs_document_sections SET status = 'SUBMITTED', submitted_by_id = $1, submitted_at = now(), updated_at = now() WHERE id = $2`,
      [req.user!.userId, section.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/sections/:sectionId/assignees — assign a person or a whole
// section/department to a Department Input section. Requester, an existing
// assignee, or an admin can add more.
const AddAssigneeSchema = z.object({
  user_id: z.string().uuid().nullish(),
  section_ref_id: z.string().uuid().nullish()
}).refine((d) => d.user_id || d.section_ref_id, { message: "Provide a user or a section" });
brsRouter.post("/:id/sections/:sectionId/assignees", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AddAssigneeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid assignee payload", parsed.error.flatten());

    const doc = await loadDocumentOr404(req.params.id);
    const section = (await query<any>(
      `SELECT * FROM brs_document_sections WHERE id = $1 AND document_id = $2`,
      [req.params.sectionId, doc.id]
    ))[0];
    if (!section) throw notFound();

    const isOwnerOrAssignee = doc.requester_id === req.user!.userId || (await isSectionAssignee(section.id, req.user!));
    if (req.user!.role !== "ADMIN" && !isOwnerOrAssignee) throw forbidden("Only the requester or an existing assignee can add another assignee");

    let assigneeEmails: string[] = [];
    if (parsed.data.user_id) {
      const u = (await query<{ id: string; email: string; full_name: string | null }>(
        `SELECT id, email, full_name FROM users WHERE id = $1 AND is_active = true`, [parsed.data.user_id]
      ))[0];
      if (!u) throw badRequest("Selected user is invalid");
      await query(
        `INSERT INTO brs_document_section_assignees (section_id, user_id) VALUES ($1, $2)`,
        [section.id, u.id]
      );
      assigneeEmails = [u.email];
    } else {
      const s = (await query<{ id: string; name: string }>(
        `SELECT id, name FROM sections WHERE id = $1 AND active = true`, [parsed.data.section_ref_id]
      ))[0];
      if (!s) throw badRequest("Selected section is invalid");
      await query(
        `INSERT INTO brs_document_section_assignees (section_id, section_ref_id) VALUES ($1, $2)`,
        [section.id, s.id]
      );
      const members = await query<{ email: string }>(`SELECT email FROM users WHERE section_id = $1 AND is_active = true`, [s.id]);
      assigneeEmails = members.map((m) => m.email);
    }

    await query(
      `UPDATE brs_document_sections SET status = CASE WHEN status = 'PENDING' THEN 'IN_PROGRESS' ELSE status END,
              due_at = CASE WHEN due_at IS NULL AND sla_hours IS NOT NULL THEN now() + (sla_hours || ' hours')::interval ELSE due_at END,
              updated_at = now()
        WHERE id = $1`,
      [section.id]
    );

    void notifyBrsSectionAssigned({
      documentId: doc.id,
      brsTitle: doc.title,
      requesterName: req.user!.fullName ?? null,
      sectionTitle: section.title,
      assigneeEmails
    });

    return res.status(201).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/sections/:sectionId/assignees/confirm — the current user
// confirms their own assignee entry (individually, or via section membership).
brsRouter.post("/:id/sections/:sectionId/assignees/confirm", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    const rows = await query<{ id: string }>(
      `SELECT id FROM brs_document_section_assignees
        WHERE section_id = $1 AND (user_id = $2 OR (section_ref_id IS NOT NULL AND section_ref_id = $3)) AND confirmed = false`,
      [req.params.sectionId, req.user!.userId, req.user!.sectionId ?? null]
    );
    if (!rows.length) throw forbidden("You are not listed as an assignee (or a member of an assigned section) on this section, or it's already confirmed");

    await query(
      `UPDATE brs_document_section_assignees SET confirmed = true, confirmed_at = now(), confirmed_by_id = $1 WHERE id = ANY($2::uuid[])`,
      [req.user!.userId, rows.map((r) => r.id)]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/advance-phase — Draft -> Department Input -> Gate.
brsRouter.post("/:id/advance-phase", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    if (req.user!.role !== "ADMIN" && doc.requester_id !== req.user!.userId) {
      throw forbidden("Only the requester can advance this BRS");
    }

    if (doc.phase === "DRAFT") {
      const draftSections = await query<{ id: string; title: string; content_html: string | null }>(
        `SELECT id, title, content_html FROM brs_document_sections WHERE document_id = $1 AND owner_phase = 'DRAFT' AND is_required = true`,
        [doc.id]
      );
      const blank = draftSections.filter((s) => !s.content_html?.trim());
      if (blank.length) throw badRequest(`Fill in required Draft sections before continuing: ${blank.map((s) => s.title).join(", ")}`);

      const hasDeptSections = (await query<{ id: string }>(
        `SELECT id FROM brs_document_sections WHERE document_id = $1 AND owner_phase = 'DEPT_INPUT' LIMIT 1`, [doc.id]
      ))[0];
      const nextPhase = hasDeptSections ? "DEPT_INPUT" : "GATE";
      await query(`UPDATE brs_documents SET phase = $1, updated_at = now() WHERE id = $2`, [nextPhase, doc.id]);
      return res.json({ ok: true, phase: nextPhase });
    }

    if (doc.phase === "DEPT_INPUT") {
      const deptSections = await query<{ id: string; title: string; status: string; is_required: boolean }>(
        `SELECT id, title, status, is_required FROM brs_document_sections WHERE document_id = $1 AND owner_phase = 'DEPT_INPUT'`,
        [doc.id]
      );
      const notSubmitted = deptSections.filter((s) => s.is_required && s.status !== "SUBMITTED");
      if (notSubmitted.length) throw badRequest(`Waiting on Department Input for: ${notSubmitted.map((s) => s.title).join(", ")}`);

      await query(`UPDATE brs_documents SET phase = 'GATE', updated_at = now() WHERE id = $1`, [doc.id]);
      return res.json({ ok: true, phase: "GATE" });
    }

    throw badRequest(`Cannot advance a BRS from its current phase (${doc.phase})`);
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/reopen — the requester decides, on their own initiative, to
// go back and fix content or the approval chain rather than waiting for an
// approver to reject it. Only makes sense past Draft, and a Baselined
// document is final (a Change Request is the real path to amend it).
// Discards any approval routing in flight - every approval already given
// is cleared along with it, matching the same reset a rejection triggers.
const ReopenSchema = z.object({ comment: z.string().trim().max(2000).optional() });
brsRouter.post("/:id/reopen", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    if (req.user!.role !== "ADMIN" && doc.requester_id !== req.user!.userId) {
      throw forbidden("Only the requester can reopen this BRS");
    }
    if (doc.phase === "DRAFT") throw badRequest("This BRS is already open for editing");
    if (doc.phase === "BASELINE") throw badRequest("A baselined BRS can't be reopened this way - raise a Change Request instead");
    const parsed = ReopenSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await reopenBrsDocumentForEditing(doc.id, parsed.data.comment ?? null, req.user!.fullName ?? null);
    return res.json({ ok: true, phase: "DRAFT" });
  } catch (err) {
    return next(err);
  }
});

// GET /brs/:id/gate-check — read-only, also used internally by route-approval.
brsRouter.get("/:id/gate-check", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);
    const gate = await checkConsistencyGate(doc.id);
    return res.json(gate);
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/route-approval — the single reuse seam: spins up a real
// custom_request_submissions row under the BRS_APPROVAL type so the entire
// existing free-form chain/approve/reject/notify/email-one-click machinery
// is inherited with no duplicated code (see performCustomRequestAction in
// custom-requests.routes.ts for the post-approval baseline hook).
const ChainStepSchema = z.object({
  approver_id: z.string().uuid(),
  position_name: z.string().trim().min(1),
  decision_type: z.enum(["APPROVE", "NOTE"]).default("APPROVE")
});
const RouteApprovalSchema = z.object({
  approval_chain: z.array(ChainStepSchema).min(1, "At least one approver is required")
});
brsRouter.post("/:id/route-approval", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = RouteApprovalSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid approval chain", parsed.error.flatten());

    const doc = await loadDocumentOr404(req.params.id);
    if (req.user!.role !== "ADMIN" && doc.requester_id !== req.user!.userId) {
      throw forbidden("Only the requester can route this BRS for approval");
    }
    if (doc.phase !== "GATE") throw badRequest(`This BRS must reach the Consistency Gate before routing for approval (currently: ${doc.phase})`);

    const gate = await checkConsistencyGate(doc.id);
    if (!gate.passed) {
      throw badRequest(`Consistency Gate not passed — required sections still blank: ${gate.blockingSections.map((s) => s.title).join(", ")}`, gate);
    }

    if (parsed.data.approval_chain.some((s) => s.approver_id === req.user!.userId)) {
      throw badRequest("You cannot select yourself as an approver on your own BRS");
    }

    const approverIds = parsed.data.approval_chain.map((s) => s.approver_id);
    const approvers = await query<{ id: string; full_name: string | null; email: string }>(
      `SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`, [approverIds]
    );
    const approverMap = new Map(approvers.map((a) => [a.id, a]));
    for (const id of approverIds) {
      if (!approverMap.has(id)) throw badRequest("One or more selected approvers are invalid");
    }

    const brsApprovalType = (await query<{ id: string }>(
      `SELECT id FROM custom_request_types WHERE code = 'BRS_APPROVAL'`
    ))[0];
    if (!brsApprovalType) throw badRequest("BRS approval routing is not set up — contact Admin");

    const chain = parsed.data.approval_chain.map((step, idx) => {
      const approver = approverMap.get(step.approver_id)!;
      return {
        step_order: idx,
        approver_id: approver.id,
        approver_name: approver.full_name,
        approver_email: approver.email,
        position_name: step.position_name.trim(),
        decision_type: step.decision_type,
        status: "PENDING",
        comment: null as string | null,
        acted_at: null as string | null
      };
    });

    const submission = (await query<{ id: string }>(
      `INSERT INTO custom_request_submissions (request_type_id, requester_id, data, approval_chain, current_step_order, status)
       VALUES ($1, $2, $3, $4, 0, 'IN_PROGRESS')
       RETURNING id`,
      [
        brsApprovalType.id,
        doc.requester_id,
        JSON.stringify({ brs_document_id: doc.id, brs_reference_no: doc.reference_no, brs_title: doc.title }),
        JSON.stringify(chain)
      ]
    ))[0];

    await query(
      `UPDATE brs_documents SET phase = 'APPROVAL', brs_approval_submission_id = $1, return_comment = NULL, updated_at = now() WHERE id = $2`,
      [submission.id, doc.id]
    );

    void notifyCustomRequestStep({
      submissionId: submission.id,
      requestTypeName: "BRS Approval",
      requesterName: req.user!.fullName ?? null,
      approverEmail: chain[0].approver_email,
      approverName: chain[0].approver_name,
      approverId: chain[0].approver_id,
      stepLabel: chain[0].position_name,
      stepOrder: 0
    });

    return res.status(201).json({ ok: true, submission_id: submission.id });
  } catch (err) {
    return next(err);
  }
});

// GET /brs/:id/pdf — renders the current section content (pre-baseline) or,
// once baselined, the frozen version snapshot.
brsRouter.get("/:id/pdf", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);

    const requester = (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [doc.requester_id]))[0];

    let sections: Array<{ title: string; content_html: string | null }>;
    let baselinedAt: string | null = null;
    if (doc.phase === "BASELINE" && doc.current_version_id) {
      const version = (await query<{ snapshot: any; baselined_at: string }>(
        `SELECT snapshot, baselined_at FROM brs_document_versions WHERE id = $1`, [doc.current_version_id]
      ))[0];
      sections = version?.snapshot?.sections ?? [];
      baselinedAt = version?.baselined_at ?? null;
    } else {
      sections = await query(`SELECT title, content_html FROM brs_document_sections WHERE document_id = $1 ORDER BY sort_order`, [doc.id]);
    }

    const letterhead = (await query<PdfLetterhead>(
      `SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`
    ))[0] || { logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null };

    // Every department that actually contributed a Department Input section -
    // a direct department assignment (section_ref_id) or a person assignment
    // resolved to their own department, deduplicated. Distinct from the
    // single "Requesting Department" captured at Intake.
    const departmentRows = await query<{ department: string | null }>(
      `SELECT DISTINCT COALESCE(sec.name, usec.name) AS department
         FROM brs_document_section_assignees a
         JOIN brs_document_sections s ON s.id = a.section_id
         LEFT JOIN sections sec ON sec.id = a.section_ref_id
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN sections usec ON usec.id = u.section_id
        WHERE s.document_id = $1`,
      [doc.id]
    );
    const departmentsIncluded = departmentRows.map((r) => r.department).filter((d): d is string => Boolean(d)).sort();

    // The approval chain, once this BRS has actually been routed - not
    // reflected until then, same as the Approval Routing panel in BRS Studio.
    let approvers: Array<{ position_name: string | null; approver_name: string | null; status: string | null; acted_at: string | null }> = [];
    if (doc.brs_approval_submission_id) {
      const submission = (await query<{ approval_chain: any }>(
        `SELECT approval_chain FROM custom_request_submissions WHERE id = $1`, [doc.brs_approval_submission_id]
      ))[0];
      approvers = (submission?.approval_chain || []).map((step: any) => ({
        position_name: step.position_name ?? null,
        approver_name: step.approver_name ?? null,
        status: step.status ?? null,
        acted_at: step.acted_at ?? null
      }));
    }

    const pdfDoc = renderBrsPdf(letterhead, {
      title: doc.title,
      reference_no: doc.reference_no,
      requester_name: requester?.full_name ?? null,
      phase: doc.phase,
      baselined_at: baselinedAt,
      sections,
      brs_type_name: doc.brs_type_name ?? null,
      department: doc.intake_data?.department ?? null,
      product_owner: doc.intake_data?.product_owner ?? null,
      target_quarter: doc.intake_data?.target_quarter ?? null,
      departments_included: departmentsIncluded,
      approvers
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="brs-${doc.reference_no || doc.id}.pdf"`);
    pdfDoc.pipe(res);
    pdfDoc.end();
  } catch (err) {
    return next(err);
  }
});

// GET /brs/:id/versions
brsRouter.get("/:id/versions", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);
    const rows = await query(
      `SELECT id, version_number, baselined_at, baselined_by_id FROM brs_document_versions WHERE document_id = $1 ORDER BY version_number DESC`,
      [doc.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /brs/:id/versions/:versionId
brsRouter.get("/:id/versions/:versionId", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);
    const version = (await query<any>(
      `SELECT * FROM brs_document_versions WHERE id = $1 AND document_id = $2`, [req.params.versionId, doc.id]
    ))[0];
    if (!version) throw notFound();
    return res.json(version);
  } catch (err) {
    return next(err);
  }
});
