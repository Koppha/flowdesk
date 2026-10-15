import { Router } from "express";
import { hasDistributionAccess } from "../distributions/distributions.routes.js";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { notifyBrsPeopleAdded, notifyBrsSectionAssigned, notifyCustomRequestStep } from "../../lib/notifications.js";
import {
  brsActorOrg, brsActorRole, brsMemberMatch, brsMemberParams, brsPermissions, BRS_PERMISSIONS, canManageBrs, canWriteBrs, checkConsistencyGate,
  isBrsContributor, isBrsCoWriter,
  nextBrsReferenceNo, recordBrsRevision, reopenBrsDocumentForEditing, startBrsAmendment
} from "./brs.service.js";
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
  const org = await brsActorOrg(actor.userId);
  const rows = await query<{ id: string }>(
    `SELECT a.id FROM brs_document_section_assignees a WHERE a.section_id = $1 AND ${brsMemberMatch("a", 2)}`,
    [sectionId, ...brsMemberParams(org)]
  );
  return rows.length > 0;
}

// A co-writer / assignee entry: one person, or a whole group - a Division
// (by name), a Department (sections row) or a Section (teams row).
const GroupEntrySchema = z.object({
  type: z.enum(["user", "division", "department", "section"]),
  id: z.string().uuid().nullish(),
  name: z.string().trim().nullish(),
  // Co-writers only: what the creator/owner grants. Default: edit content.
  permissions: z.array(z.enum(BRS_PERMISSIONS)).optional()
}).refine((e) => (e.type === "division" ? !!e.name : !!e.id), { message: "Each entry needs an id (or a name for a division)" });
type GroupEntry = z.infer<typeof GroupEntrySchema>;

// Validates entries against the org and returns them with display labels.
async function resolveGroupEntries(entries: GroupEntry[]) {
  const out: Array<GroupEntry & { label: string; email?: string }> = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.type}:${e.type === "division" ? (e.name || "").toLowerCase() : e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.type === "user") {
      const u = (await query<{ full_name: string | null; email: string }>(`SELECT full_name, email FROM users WHERE id = $1 AND is_active = true`, [e.id]))[0];
      if (!u) throw badRequest("One or more selected people are not active FlowDesk users");
      out.push({ ...e, label: u.full_name || u.email, email: u.email });
    } else if (e.type === "department") {
      const r = (await query<{ name: string }>(`SELECT name FROM sections WHERE id = $1`, [e.id]))[0];
      if (!r) throw badRequest("A selected department no longer exists");
      out.push({ ...e, label: `${r.name} (Department)` });
    } else if (e.type === "section") {
      const r = (await query<{ name: string }>(`SELECT name FROM teams WHERE id = $1`, [e.id]))[0];
      if (!r) throw badRequest("A selected section no longer exists");
      out.push({ ...e, label: `${r.name} (Section)` });
    } else {
      const r = (await query<{ name: string }>(`SELECT name FROM departments WHERE lower(trim(name)) = lower(trim($1)) AND active = true`, [e.name]))[0];
      if (!r) throw badRequest("A selected division no longer exists");
      out.push({ ...e, name: r.name, label: `${r.name} (Division)` });
    }
  }
  return out;
}

// Everyone currently in a set of entries, for emailing them.
async function entryEmails(entries: GroupEntry[]) {
  const emails = new Set<string>();
  for (const e of entries) {
    const rows = await query<{ email: string }>(
      e.type === "user" ? `SELECT email FROM users WHERE id = $1 AND is_active`
        : e.type === "department" ? `SELECT email FROM users WHERE section_id = $1 AND is_active`
        : e.type === "section" ? `SELECT email FROM users WHERE team_id = $1 AND is_active`
        : `SELECT email FROM users WHERE lower(trim(department)) = lower(trim($1)) AND is_active`,
      [e.type === "division" ? e.name : e.id]
    );
    rows.forEach((r) => r.email && emails.add(r.email));
  }
  return [...emails];
}

const PERMISSION_LABEL: Record<string, string> = {
  EDIT: "edit", INVITE: "invite", WORKFLOW: "send on & route", DISTRIBUTE: "distribute", AMEND: "amend"
};
function describePermissions(perms: string[]) {
  return perms.length ? perms.map((p) => PERMISSION_LABEL[p] || p).join(", ") : "view only";
}
function normalizePermissions(perms: string[] | undefined | null) {
  return BRS_PERMISSIONS.filter((p) => (perms ?? ["EDIT"]).includes(p));
}

function entryColumns(e: GroupEntry) {
  return {
    permissions: normalizePermissions(e.permissions),
    user_id: e.type === "user" ? e.id! : null,
    section_ref_id: e.type === "department" ? e.id! : null,
    team_ref_id: e.type === "section" ? e.id! : null,
    division_name: e.type === "division" ? e.name! : null
  };
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

// Active users only; returns them keyed by id (throws on any unknown id).
async function loadActiveUsers(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, { id: string; full_name: string | null; email: string }>();
  const rows = await query<{ id: string; full_name: string | null; email: string }>(
    `SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`, [unique]
  );
  if (rows.length !== unique.length) throw badRequest("One or more selected people are not active FlowDesk users");
  return new Map(rows.map((r) => [r.id, r]));
}

// What a section save/edit is allowed to touch: a writer (creator, owner,
// co-writer, admin) can edit any section; a section assignee only theirs.
async function assertCanEditSection(doc: any, sectionId: string, actor: { userId: string; role: string; sectionId?: string | null }) {
  if (await canWriteBrs(doc, actor)) return;
  if (await isSectionAssignee(sectionId, actor)) return;
  throw forbidden("You are not a writer on this BRS or an assignee of this section");
}

async function assertCanViewDocument(doc: any, actor: { userId: string; role: string; sectionId?: string | null }) {
  if (actor.role === "ADMIN" || doc.requester_id === actor.userId) return;
  if (doc.owner_user_id === actor.userId) return;
  // Any co-writer - including view-only ones - can open it.
  if (await isBrsCoWriter(doc.id, actor.userId)) return;
  if (await isBrsContributor(doc.id, actor.userId)) return;
  if (doc.brs_approval_submission_id) {
    const onChain = (await query<{ id: string }>(
      `SELECT id FROM custom_request_submissions WHERE id = $1 AND approval_chain @> $2::jsonb`,
      [doc.brs_approval_submission_id, JSON.stringify([{ approver_id: actor.userId }])]
    ))[0];
    if (onChain) return;
  }
  // Read-only access for anyone the approved BRS was distributed to.
  if (await hasDistributionAccess("BRS", doc.id, actor.userId)) return;
  throw forbidden("You do not have access to this BRS");
}

// POST /brs — Intake: create a document from an active brs_type, immediately
// entering Draft (Intake is just the opening form, not a separate wait state).
const CreateSchema = z.object({
  brs_type_id: z.string().uuid(),
  title: z.string().trim().min(1, "Title is required"),
  intake_data: z.record(z.string(), z.any()).default({}),
  // Picked from FlowDesk users; full rights, same as the creator.
  owner_user_id: z.string().uuid().nullish(),
  // Can edit content from the start: people and/or whole groups.
  co_writer_ids: z.array(z.string().uuid()).default([]),
  co_writers: z.array(GroupEntrySchema).default([])
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

    const ownerId = parsed.data.owner_user_id || null;
    const coWriterEntries = await resolveGroupEntries([
      ...parsed.data.co_writer_ids.map((id) => ({ type: "user" as const, id })),
      ...parsed.data.co_writers
    ].filter((e) => !(e.type === "user" && (e.id === req.user!.userId || e.id === ownerId))));
    const people = await loadActiveUsers(ownerId ? [ownerId] : []);
    // Kept in intake_data too, so the cover page / PDF read the owner's name.
    const intake = { ...parsed.data.intake_data, product_owner: ownerId ? people.get(ownerId)!.full_name : (parsed.data.intake_data.product_owner ?? null) };

    const referenceNo = await nextBrsReferenceNo();
    const doc = (await query<{ id: string }>(
      `INSERT INTO brs_documents (brs_type_id, title, reference_no, requester_id, owner_user_id, phase, intake_data)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6)
       RETURNING id`,
      [brsType.id, parsed.data.title, referenceNo, req.user!.userId, ownerId, JSON.stringify(intake)]
    ))[0];
    for (const e of coWriterEntries) {
      const c = entryColumns(e);
      await query(
        `INSERT INTO brs_document_collaborators (document_id, user_id, section_ref_id, team_ref_id, division_name, role, added_by_id, permissions)
         VALUES ($1, $2, $3, $4, $5, 'CO_WRITER', $6, $7::text[]) ON CONFLICT DO NOTHING`,
        [doc.id, c.user_id, c.section_ref_id, c.team_ref_id, c.division_name, req.user!.userId, c.permissions]
      );
    }

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

    await recordBrsRevision({
      documentId: doc.id, kind: "CREATED", actorId: req.user!.userId, actorRole: "CREATOR",
      summary: `Created${ownerId ? ` — owner ${people.get(ownerId)!.full_name}` : ""}${coWriterEntries.length ? `; co-writers: ${coWriterEntries.map((e) => `${e.label} (${describePermissions(normalizePermissions(e.permissions))})`).join(", ")}` : ""}`,
      intakeData: intake
    });
    void (async () => notifyBrsPeopleAdded({
      documentId: doc.id, brsTitle: parsed.data.title, addedBy: req.user!.fullName ?? null,
      owner: ownerId ? people.get(ownerId)! : null,
      coWriters: (await entryEmails(coWriterEntries)).filter((em) => !ownerId || em !== people.get(ownerId)!.email).map((email) => ({ email, full_name: null }))
    }))();

    return res.status(201).json({ id: doc.id, reference_no: referenceNo });
  } catch (err) {
    return next(err);
  }
});

// GET /brs/mine
brsRouter.get("/mine", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT d.*, bt.name AS brs_type_name, u.full_name AS requester_name, ow.full_name AS owner_name,
              CASE WHEN d.requester_id = $1 THEN 'CREATOR' WHEN d.owner_user_id = $1 THEN 'OWNER' ELSE 'CO_WRITER' END AS my_role
         FROM brs_documents d
         JOIN brs_types bt ON bt.id = d.brs_type_id
         JOIN users u ON u.id = d.requester_id
         LEFT JOIN users ow ON ow.id = d.owner_user_id
        WHERE d.requester_id = $1 OR d.owner_user_id = $1
           OR EXISTS (SELECT 1 FROM brs_document_collaborators c WHERE c.document_id = d.id AND ${brsMemberMatch("c", 1)})
        ORDER BY d.created_at DESC`,
      brsMemberParams(await brsActorOrg(req.user!.userId))
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /brs/shared-with-me — approved BRS documents distributed to the
// current user (read-only), newest distribution first.
brsRouter.get("/shared-with-me", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT d.*, bt.name AS brs_type_name, u.full_name AS requester_name,
              x.distributed_at, x.distributed_by_name, x.message AS distribution_message
         FROM brs_documents d
         JOIN brs_types bt ON bt.id = d.brs_type_id
         JOIN users u ON u.id = d.requester_id
         JOIN LATERAL (
           SELECT dd.created_at AS distributed_at, ub.full_name AS distributed_by_name, dd.message
             FROM document_distributions dd LEFT JOIN users ub ON ub.id = dd.distributed_by_id
            WHERE dd.doc_type = 'BRS' AND dd.doc_id = d.id AND $1::uuid = ANY(dd.recipient_ids)
            ORDER BY dd.created_at DESC LIMIT 1
         ) x ON true
        ORDER BY x.distributed_at DESC`,
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
        WHERE ${brsMemberMatch("a", 1)}
        ORDER BY d.created_at DESC`,
      brsMemberParams(await brsActorOrg(req.user!.userId))
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
          `SELECT a.*, u.full_name AS user_name, u.email AS user_email, sec.name AS section_name, tm.name AS team_name, ab.full_name AS added_by_name
             FROM brs_document_section_assignees a
             LEFT JOIN users u ON u.id = a.user_id
             LEFT JOIN users ab ON ab.id = a.added_by_id
             LEFT JOIN sections sec ON sec.id = a.section_ref_id
             LEFT JOIN teams tm ON tm.id = a.team_ref_id
            WHERE a.section_id = ANY($1::uuid[])`,
          [sectionIds]
        )
      : [];
    const gate = await checkConsistencyGate(doc.id);
    const owner = doc.owner_user_id
      ? (await query<{ id: string; full_name: string | null; email: string }>(`SELECT id, full_name, email FROM users WHERE id = $1`, [doc.owner_user_id]))[0] ?? null
      : null;
    const perms = await brsPermissions(doc, req.user!);
    const creator = (await query<{ id: string; full_name: string | null; email: string }>(`SELECT id, full_name, email FROM users WHERE id = $1`, [doc.requester_id]))[0] ?? null;
    const coWriters = await query(
      `SELECT c.id AS entry_id, c.user_id AS id, u.full_name, u.email, c.created_at, c.permissions,
              CASE WHEN c.user_id IS NOT NULL THEN 'user' WHEN c.section_ref_id IS NOT NULL THEN 'department' WHEN c.team_ref_id IS NOT NULL THEN 'section' ELSE 'division' END AS type,
              coalesce(c.user_id, c.section_ref_id, c.team_ref_id)::text AS ref_id, c.division_name,
              coalesce(u.full_name, sec.name, tm.name, c.division_name) AS label
         FROM brs_document_collaborators c
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN sections sec ON sec.id = c.section_ref_id
         LEFT JOIN teams tm ON tm.id = c.team_ref_id
        WHERE c.document_id = $1 ORDER BY 7, 10`,
      [doc.id]
    );
    const versions = await query(
      `SELECT v.id, v.version_number, v.baselined_at, u.full_name AS baselined_by_name
         FROM brs_document_versions v LEFT JOIN users u ON u.id = v.baselined_by_id
        WHERE v.document_id = $1 ORDER BY v.version_number DESC`,
      [doc.id]
    );

    return res.json({
      ...doc,
      creator,
      owner,
      co_writers: coWriters,
      versions,
      my_role: await brsActorRole(doc, req.user!),
      my_permissions: perms,
      can_manage: perms.manage,
      can_write: perms.edit,
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
    if (!canManageBrs(doc, req.user!)) {
      throw forbidden("Only the creator or owner can delete this BRS");
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
    // Editable during Approval too, so an approver's comments can be fixed
    // without restarting; only an approved (baselined) BRS needs Amend first.
    if (doc.phase === "BASELINE") {
      throw badRequest("This BRS is approved — use Amend to make changes");
    }
    if (!(await canWriteBrs(doc, req.user!))) {
      throw forbidden("Only the creator, owner or a co-writer can edit Intake");
    }

    const updated = { ...doc.intake_data, ...parsed.data.intake_data };
    if (JSON.stringify(updated) === JSON.stringify(doc.intake_data)) return res.json({ ok: true, unchanged: true });
    await query(`UPDATE brs_documents SET intake_data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(updated), doc.id]);
    await recordBrsRevision({
      documentId: doc.id, kind: "INTAKE_SAVED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: doc.phase === "APPROVAL" ? "Intake updated during approval" : "Intake updated", intakeData: updated
    });
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
    // Editable during Approval (approval carries on, no restart); an
    // approved BRS needs Amend first.
    if (doc.phase === "BASELINE") {
      throw badRequest("This BRS is approved — use Amend to make changes");
    }
    const section = (await query<any>(
      `SELECT * FROM brs_document_sections WHERE id = $1 AND document_id = $2`,
      [req.params.sectionId, doc.id]
    ))[0];
    if (!section) throw notFound();

    // Writers (creator, owner, co-writers, admin) edit any section; anyone
    // else must be an assignee of this section.
    await assertCanEditSection(doc, section.id, req.user!);

    // Unchanged content isn't a new version.
    if ((section.content_html ?? "") === parsed.data.content_html) return res.json({ ok: true, unchanged: true });

    await query(
      `UPDATE brs_document_sections
          SET content_html = $1, status = CASE WHEN status = 'PENDING' THEN 'IN_PROGRESS' ELSE status END, updated_at = now()
        WHERE id = $2`,
      [parsed.data.content_html, section.id]
    );
    await recordBrsRevision({
      documentId: doc.id, kind: "SECTION_SAVED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: `${doc.phase === "APPROVAL" ? "Edited during approval" : "Saved"}: ${section.title}`,
      sectionId: section.id, sectionTitle: section.title, contentHtml: parsed.data.content_html
    });
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
      ? await canWriteBrs(doc, req.user!)
      : (await isSectionAssignee(section.id, req.user!)) || (await canWriteBrs(doc, req.user!));
    if (!isOwner) throw forbidden("You are not the owner of this section");

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
  section_ref_id: z.string().uuid().nullish(),
  team_ref_id: z.string().uuid().nullish(),
  division_name: z.string().trim().nullish()
}).refine((d) => d.user_id || d.section_ref_id || d.team_ref_id || d.division_name, { message: "Provide a person, division, department or section" });
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

    const mayInvite = (await brsPermissions(doc, req.user!)).invite || (await isSectionAssignee(section.id, req.user!));
    if (!mayInvite) throw forbidden("You don't have permission to invite people onto this section");

    let assigneeEmails: string[] = [];
    if (parsed.data.team_ref_id || parsed.data.division_name) {
      const entry: GroupEntry = parsed.data.team_ref_id
        ? { type: "section", id: parsed.data.team_ref_id }
        : { type: "division", name: parsed.data.division_name! };
      const [resolved] = await resolveGroupEntries([entry]);
      const c = entryColumns(resolved);
      await query(
        `INSERT INTO brs_document_section_assignees (section_id, team_ref_id, division_name, added_by_id) VALUES ($1, $2, $3, $4)`,
        [section.id, c.team_ref_id, c.division_name, req.user!.userId]
      );
      assigneeEmails = await entryEmails([resolved]);
    } else if (parsed.data.user_id) {
      const u = (await query<{ id: string; email: string; full_name: string | null }>(
        `SELECT id, email, full_name FROM users WHERE id = $1 AND is_active = true`, [parsed.data.user_id]
      ))[0];
      if (!u) throw badRequest("Selected user is invalid");
      await query(
        `INSERT INTO brs_document_section_assignees (section_id, user_id, added_by_id) VALUES ($1, $2, $3)`,
        [section.id, u.id, req.user!.userId]
      );
      assigneeEmails = [u.email];
    } else {
      const s = (await query<{ id: string; name: string }>(
        `SELECT id, name FROM sections WHERE id = $1 AND active = true`, [parsed.data.section_ref_id]
      ))[0];
      if (!s) throw badRequest("Selected section is invalid");
      await query(
        `INSERT INTO brs_document_section_assignees (section_id, section_ref_id, added_by_id) VALUES ($1, $2, $3)`,
        [section.id, s.id, req.user!.userId]
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

    await recordBrsRevision({
      documentId: doc.id, kind: "PEOPLE_CHANGED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: `Invited onto "${section.title}": ${parsed.data.user_id ? "a person" : parsed.data.section_ref_id ? "a department" : parsed.data.team_ref_id ? "a section" : `${parsed.data.division_name} (Division)`}`,
      sectionId: section.id, sectionTitle: section.title
    });
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
      `SELECT a.id FROM brs_document_section_assignees a
        WHERE a.section_id = $1 AND ${brsMemberMatch("a", 2)} AND a.confirmed = false`,
      [req.params.sectionId, ...brsMemberParams(await brsActorOrg(req.user!.userId))]
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

// DELETE /brs/:id/sections/:sectionId/assignees/:assigneeId — cancel a
// section invitation. Allowed for the creator/owner (any invitation) and
// for whoever sent that particular invitation.
brsRouter.delete("/:id/sections/:sectionId/assignees/:assigneeId", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    const row = (await query<{ id: string; added_by_id: string | null; title: string; label: string | null }>(
      `SELECT a.id, a.added_by_id, s.title,
              coalesce(u.full_name, sec.name || ' (Department)', tm.name || ' (Section)', a.division_name || ' (Division)') AS label
         FROM brs_document_section_assignees a
         JOIN brs_document_sections s ON s.id = a.section_id
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN sections sec ON sec.id = a.section_ref_id
         LEFT JOIN teams tm ON tm.id = a.team_ref_id
        WHERE a.id = $1 AND a.section_id = $2 AND s.document_id = $3`,
      [req.params.assigneeId, req.params.sectionId, doc.id]
    ))[0];
    if (!row) throw notFound("Invitation not found");
    if (!canManageBrs(doc, req.user!) && row.added_by_id !== req.user!.userId) {
      throw forbidden("Only the creator, the owner, or whoever sent this invitation can cancel it");
    }
    await query(`DELETE FROM brs_document_section_assignees WHERE id = $1`, [row.id]);
    await recordBrsRevision({
      documentId: doc.id, kind: "PEOPLE_CHANGED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: `Invitation cancelled on "${row.title}": ${row.label || "—"}`, sectionId: req.params.sectionId, sectionTitle: row.title
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/advance-phase — Draft -> Department Input -> Gate.
brsRouter.post("/:id/advance-phase", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    if (!(await brsPermissions(doc, req.user!)).workflow) {
      throw forbidden("You don't have permission to send this BRS on");
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
      await recordBrsRevision({ documentId: doc.id, kind: "PHASE", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
        summary: `Sent on to ${nextPhase === "DEPT_INPUT" ? "Department Input" : "Consistency Gate"}` });
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
      await recordBrsRevision({ documentId: doc.id, kind: "PHASE", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
        summary: "Sent on to Consistency Gate" });
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
    if (!(await brsPermissions(doc, req.user!)).workflow) {
      throw forbidden("You don't have permission to reopen this BRS");
    }
    if (doc.phase === "DRAFT") throw badRequest("This BRS is already open for editing");
    if (doc.phase === "BASELINE") throw badRequest("An approved BRS is changed with Amend, not Reopen");
    const parsed = ReopenSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await reopenBrsDocumentForEditing(doc.id, parsed.data.comment ?? null, req.user!.fullName ?? null);
    await recordBrsRevision({ documentId: doc.id, kind: "REOPENED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: `Reopened for editing${doc.phase === "APPROVAL" ? " (approval withdrawn)" : ""}${parsed.data.comment ? `: ${parsed.data.comment}` : ""}` });
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
    if (!(await brsPermissions(doc, req.user!)).workflow) {
      throw forbidden("You don't have permission to route this BRS for approval");
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
    await recordBrsRevision({ documentId: doc.id, kind: "ROUTED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: `Routed for approval: ${chain.map((c) => `${c.approver_name} (${c.position_name})`).join(" → ")}` });

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
      `SELECT DISTINCT COALESCE(sec.name, tm.name, a.division_name, usec.name) AS department
         FROM brs_document_section_assignees a
         JOIN brs_document_sections s ON s.id = a.section_id
         LEFT JOIN sections sec ON sec.id = a.section_ref_id
         LEFT JOIN teams tm ON tm.id = a.team_ref_id
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
      product_owner: doc.owner_user_id
        ? ((await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [doc.owner_user_id]))[0]?.full_name ?? doc.intake_data?.product_owner ?? null)
        : (doc.intake_data?.product_owner ?? null),
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

// PUT /brs/:id/people — set the owner (full rights, one person) and the
// co-writers (people and/or whole groups).
const PeopleSchema = z.object({
  owner_user_id: z.string().uuid().nullable(),
  co_writer_ids: z.array(z.string().uuid()).default([]),
  co_writers: z.array(GroupEntrySchema).default([])
});
brsRouter.put("/:id/people", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = PeopleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const doc = await loadDocumentOr404(req.params.id);
    if (!canManageBrs(doc, req.user!)) throw forbidden("Only the creator or owner can change who works on this BRS");

    const ownerId = parsed.data.owner_user_id;
    if (ownerId === doc.requester_id) throw badRequest("The creator already has full rights — choose someone else as owner, or leave it empty");
    const people = await loadActiveUsers(ownerId ? [ownerId] : []);
    const wanted = await resolveGroupEntries([
      ...parsed.data.co_writer_ids.map((id) => ({ type: "user" as const, id })),
      ...parsed.data.co_writers
    ].filter((e) => !(e.type === "user" && (e.id === doc.requester_id || e.id === ownerId))));
    const keyOf = (e: { type: string; id?: string | null; name?: string | null }) =>
      `${e.type}:${e.type === "division" ? (e.name || "").toLowerCase() : e.id}`;

    const before = await query<{ id: string; user_id: string | null; section_ref_id: string | null; team_ref_id: string | null; division_name: string | null; permissions: string[] }>(
      `SELECT id, user_id, section_ref_id, team_ref_id, division_name, permissions FROM brs_document_collaborators WHERE document_id = $1`, [doc.id]
    );
    const beforeKeyed = before.map((b) => ({
      row: b,
      key: b.user_id ? `user:${b.user_id}` : b.section_ref_id ? `department:${b.section_ref_id}` : b.team_ref_id ? `section:${b.team_ref_id}` : `division:${(b.division_name || "").toLowerCase()}`
    }));
    const wantedKeys = new Set(wanted.map(keyOf));
    const beforeKeys = new Set(beforeKeyed.map((b) => b.key));
    const added = wanted.filter((e) => !beforeKeys.has(keyOf(e)));
    const removed = beforeKeyed.filter((b) => !wantedKeys.has(b.key));
    const ownerChanged = (doc.owner_user_id ?? null) !== (ownerId ?? null);
    // Kept entries whose granted permissions changed.
    const permChanged = wanted
      .map((e) => ({ e, prev: beforeKeyed.find((b) => b.key === keyOf(e)) }))
      .filter((x) => x.prev && normalizePermissions(x.e.permissions).join(",") !== normalizePermissions(x.prev.row.permissions).join(","));
    if (!added.length && !removed.length && !ownerChanged && !permChanged.length) return res.json({ ok: true, unchanged: true });

    const removedLabels = removed.length
      ? (await query<{ label: string }>(
          `SELECT coalesce(u.full_name, sec.name || ' (Department)', tm.name || ' (Section)', c.division_name || ' (Division)') AS label
             FROM brs_document_collaborators c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN sections sec ON sec.id = c.section_ref_id LEFT JOIN teams tm ON tm.id = c.team_ref_id
            WHERE c.id = ANY($1::uuid[])`, [removed.map((r) => r.row.id)]
        )).map((r) => r.label)
      : [];

    await query(`UPDATE brs_documents SET owner_user_id = $1, intake_data = intake_data || $2::jsonb, updated_at = now() WHERE id = $3`,
      [ownerId, JSON.stringify({ product_owner: ownerId ? people.get(ownerId)!.full_name : null }), doc.id]);
    if (removed.length) await query(`DELETE FROM brs_document_collaborators WHERE id = ANY($1::uuid[])`, [removed.map((r) => r.row.id)]);
    for (const e of added) {
      const c = entryColumns(e);
      await query(
        `INSERT INTO brs_document_collaborators (document_id, user_id, section_ref_id, team_ref_id, division_name, role, added_by_id, permissions)
         VALUES ($1, $2, $3, $4, $5, 'CO_WRITER', $6, $7::text[]) ON CONFLICT DO NOTHING`,
        [doc.id, c.user_id, c.section_ref_id, c.team_ref_id, c.division_name, req.user!.userId, c.permissions]
      );
    }

    for (const x of permChanged) {
      await query(`UPDATE brs_document_collaborators SET permissions = $1::text[] WHERE id = $2`, [normalizePermissions(x.e.permissions), x.prev!.row.id]);
    }
    const parts: string[] = [];
    if (ownerChanged) parts.push(ownerId ? `Owner set to ${people.get(ownerId)!.full_name}` : "Owner removed");
    if (added.length) parts.push(`Co-writers added: ${added.map((e) => `${e.label} (${describePermissions(normalizePermissions(e.permissions))})`).join(", ")}`);
    if (permChanged.length) parts.push(`Permissions changed: ${permChanged.map((x) => `${x.e.label} ${describePermissions(normalizePermissions(x.prev!.row.permissions))} → ${describePermissions(normalizePermissions(x.e.permissions))}`).join("; ")}`);
    if (removedLabels.length) parts.push(`Co-writers removed: ${removedLabels.join(", ")}`);
    await recordBrsRevision({ documentId: doc.id, kind: "PEOPLE_CHANGED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!), summary: parts.join("; ") });

    void (async () => notifyBrsPeopleAdded({
      documentId: doc.id, brsTitle: doc.title, addedBy: req.user!.fullName ?? null,
      owner: ownerChanged && ownerId ? people.get(ownerId)! : null,
      coWriters: (await entryEmails(added)).map((email) => ({ email, full_name: null }))
    }))();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/amend — reopen an approved BRS for amendment. The approved
// version stays on record; re-approval baselines the next version.
const AmendSchema = z.object({ reason: z.string().trim().max(2000).optional() });
brsRouter.post("/:id/amend", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AmendSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const doc = await loadDocumentOr404(req.params.id);
    if (!(await brsPermissions(doc, req.user!)).amend) throw forbidden("You don't have permission to amend this BRS");
    if (doc.phase !== "BASELINE") throw badRequest("Only an approved BRS can be amended — it is still in progress, edit it directly");
    const fromVersion = await startBrsAmendment(doc.id);
    await recordBrsRevision({ documentId: doc.id, kind: "AMENDMENT_STARTED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: `Amendment started from version ${fromVersion ?? "?"}${parsed.data.reason ? `: ${parsed.data.reason}` : ""}` });
    return res.json({ ok: true, phase: "DRAFT", amending_from_version: fromVersion });
  } catch (err) {
    return next(err);
  }
});

// GET /brs/:id/history — the audit trail, oldest first. Content is fetched
// per entry (below) so the list stays light.
brsRouter.get("/:id/history", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);
    const rows = await query(
      `SELECT r.id, r.kind, r.section_id, r.section_title, r.summary, r.phase, r.actor_role, r.created_at,
              u.full_name AS actor_name,
              (r.content_html IS NOT NULL OR r.intake_data IS NOT NULL) AS has_content
         FROM brs_document_revisions r LEFT JOIN users u ON u.id = r.actor_id
        WHERE r.document_id = $1
        ORDER BY r.created_at ASC`,
      [doc.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

brsRouter.get("/:id/history/:revisionId", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);
    const row = (await query<any>(
      `SELECT r.*, u.full_name AS actor_name FROM brs_document_revisions r LEFT JOIN users u ON u.id = r.actor_id
        WHERE r.id = $1 AND r.document_id = $2`,
      [req.params.revisionId, doc.id]
    ))[0];
    if (!row) throw notFound();
    // The previous saved version of the same section, so the UI can show
    // what changed.
    const previous = row.section_id
      ? (await query<{ content_html: string | null; created_at: string; actor_name: string | null }>(
          `SELECT r.content_html, r.created_at, u.full_name AS actor_name FROM brs_document_revisions r LEFT JOIN users u ON u.id = r.actor_id
            WHERE r.document_id = $1 AND r.section_id = $2 AND r.kind = 'SECTION_SAVED' AND r.created_at < $3
            ORDER BY r.created_at DESC LIMIT 1`,
          [doc.id, row.section_id, row.created_at]
        ))[0] ?? null
      : null;
    return res.json({ ...row, previous });
  } catch (err) {
    return next(err);
  }
});
