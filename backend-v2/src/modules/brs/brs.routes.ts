import { Router } from "express";
import { hasDistributionAccess } from "../distributions/distributions.routes.js";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { notifyBrsPeopleAdded, notifyBrsReviewersAdded, notifyBrsSectionAssigned, notifyCustomRequestStep } from "../../lib/notifications.js";
import {
  brsActorOrg, brsActorRole, brsOwnerIds, isBrsOwner, brsMemberMatch, brsMemberParams, brsPermissions, BRS_PERMISSIONS, canManageBrs, canWriteBrs, checkConsistencyGate,
  isBrsContributor, isBrsCoWriter, isBrsReviewer,
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
  return resolveOrgEntries(entries);
}
// Shared with Change Request collaboration (change-collab.routes.ts).
export async function resolveOrgEntries<E extends { type: GroupEntry["type"]; id?: string | null; name?: string | null }>(entries: E[]) {
  const out: Array<E & { label: string; email?: string }> = [];
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
export async function entryEmails(entries: Array<{ type: GroupEntry["type"]; id?: string | null; name?: string | null }>) {
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
// ── Requesting departments ──────────────────────────────────────────────────
// Org Structure units (a Division, or a Department within one), filled in
// automatically from the creator, owners and co-writers. Stored on
// intake_data.departments; intake_data.department keeps the names as text for
// the cover page/PDF and older readers.
type OrgUnit = { type: "division" | "department"; id: string | null; name: string; parent: string | null; company: string | null };
const unitKey = (u: { type: string; id?: string | null; name?: string | null }) =>
  u.type === "division" ? `division:${(u.name || "").toLowerCase()}` : `department:${u.id}`;

async function orgUnitsFor(userIds: string[], groups: Array<{ type: string; id?: string | null; name?: string | null }>): Promise<OrgUnit[]> {
  const out: OrgUnit[] = [];
  const push = (u: OrgUnit | null) => { if (u && u.name && !out.some((x) => unitKey(x) === unitKey(u))) out.push(u); };
  const sectionUnit = async (sectionId: string) => {
    const r = (await query<{ id: string; name: string; division: string | null; company: string | null }>(
      `SELECT s.id, s.name, d.name AS division, v.name AS company FROM sections s
         LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN divisions v ON v.id = d.division_id WHERE s.id = $1`, [sectionId]
    ))[0];
    return r ? { type: "department" as const, id: r.id, name: r.name, parent: r.division, company: r.company } : null;
  };
  const divisionUnit = async (name: string) => {
    const r = (await query<{ name: string; company: string | null }>(
      `SELECT d.name, v.name AS company FROM departments d LEFT JOIN divisions v ON v.id = d.division_id
        WHERE lower(trim(d.name)) = lower(trim($1)) ORDER BY d.active DESC LIMIT 1`, [name]
    ))[0];
    return r ? { type: "division" as const, id: null, name: r.name, parent: null, company: r.company } : null;
  };
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length) {
    const users = await query<{ id: string; section_id: string | null; department: string | null }>(
      `SELECT id, section_id, department FROM users WHERE id = ANY($1::uuid[])`, [ids]
    );
    for (const id of ids) {
      const u = users.find((x) => x.id === id);
      if (!u) continue;
      push(u.section_id ? await sectionUnit(u.section_id) : u.department ? await divisionUnit(u.department) : null);
    }
  }
  for (const g of groups) {
    if (g.type === "division" && g.name) push(await divisionUnit(g.name));
    else if (g.type === "department" && g.id) push(await sectionUnit(g.id));
    else if (g.type === "section" && g.id) {
      const t = (await query<{ section_id: string | null }>(`SELECT section_id FROM teams WHERE id = $1`, [g.id]))[0];
      if (t?.section_id) push(await sectionUnit(t.section_id));
    }
  }
  return out;
}

// The BRS's current units - from intake_data.departments, or for a BRS made
// before that existed, its single department name looked up as a Division.
async function currentUnits(intake: any): Promise<OrgUnit[]> {
  if (Array.isArray(intake?.departments)) return intake.departments;
  if (intake?.department) return orgUnitsFor([], [{ type: "division", name: intake.department }]).then((u) => u.length ? u : [{ type: "division", id: null, name: intake.department, parent: null, company: null }]);
  return [];
}
function withUnits(intake: any, units: OrgUnit[]) {
  return { ...intake, departments: units, department: units.map((u) => u.name).join(", ") || null };
}
const OrgUnitSchema = z.object({
  type: z.enum(["division", "department"]),
  id: z.string().uuid().nullish(),
  name: z.string().trim().min(1).max(200),
  parent: z.string().nullish(),
  company: z.string().nullish()
});

async function ownerNames(ids: string[]) {
  if (!ids.length) return null;
  const rows = await query<{ id: string; full_name: string | null }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  return ids.map((id) => rows.find((r) => r.id === id)?.full_name).filter(Boolean).join(", ") || null;
}

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
  if (isBrsOwner(doc, actor.userId)) return;
  // Any co-writer - including view-only ones - can open it.
  if (await isBrsCoWriter(doc.id, actor.userId)) return;
  if (await isBrsContributor(doc.id, actor.userId)) return;
  // Reviewers (a person, or anyone in a reviewing Department/Section) can open it to comment.
  if (await isBrsReviewer(doc.id, actor.userId)) return;
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
  owner_user_ids: z.array(z.string().uuid()).max(20).default([]),
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

    const ownerIds = Array.from(new Set([...parsed.data.owner_user_ids, ...(parsed.data.owner_user_id ? [parsed.data.owner_user_id] : [])]))
      .filter((id) => id !== req.user!.userId);
    // An owner who was also picked as a co-writer is just an owner.
    const coWriterEntries = await resolveGroupEntries([
      ...parsed.data.co_writer_ids.map((id) => ({ type: "user" as const, id })),
      ...parsed.data.co_writers
    ].filter((e) => !(e.type === "user" && (e.id === req.user!.userId || ownerIds.includes(e.id!)))));
    const people = await loadActiveUsers(ownerIds);
    // Requesting departments fill in from the creator, owners and co-writers.
    const units = await orgUnitsFor(
      [req.user!.userId, ...ownerIds, ...coWriterEntries.filter((e) => e.type === "user").map((e) => e.id!)],
      coWriterEntries.filter((e) => e.type !== "user")
    );
    // Owner names kept in intake_data too, so the cover page / PDF read them.
    const intake = withUnits(
      { ...parsed.data.intake_data, product_owner: ownerIds.length ? ownerIds.map((id) => people.get(id)!.full_name).join(", ") : (parsed.data.intake_data.product_owner ?? null) },
      units
    );

    const referenceNo = await nextBrsReferenceNo();
    const doc = (await query<{ id: string }>(
      `INSERT INTO brs_documents (brs_type_id, title, reference_no, requester_id, owner_user_id, owner_user_ids, phase, intake_data)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[], 'DRAFT', $7)
       RETURNING id`,
      [brsType.id, parsed.data.title, referenceNo, req.user!.userId, ownerIds[0] ?? null, ownerIds, JSON.stringify(intake)]
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
      summary: `Created${ownerIds.length ? ` — owner${ownerIds.length > 1 ? "s" : ""} ${ownerIds.map((id) => people.get(id)!.full_name).join(", ")}` : ""}${coWriterEntries.length ? `; co-writers: ${coWriterEntries.map((e) => `${e.label} (${describePermissions(normalizePermissions(e.permissions))})`).join(", ")}` : ""}`,
      intakeData: intake
    });
    void (async () => notifyBrsPeopleAdded({
      documentId: doc.id, brsTitle: parsed.data.title, addedBy: req.user!.fullName ?? null,
      owners: ownerIds.map((id) => people.get(id)!),
      coWriters: (await entryEmails(coWriterEntries)).filter((em) => !ownerIds.some((id) => people.get(id)!.email === em)).map((email) => ({ email, full_name: null }))
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
      `SELECT d.*, bt.name AS brs_type_name, u.full_name AS requester_name,
              (SELECT string_agg(ow.full_name, ', ' ORDER BY array_position(d.owner_user_ids, ow.id)) FROM users ow WHERE ow.id = ANY(d.owner_user_ids)) AS owner_name,
              CASE WHEN d.requester_id = $1 THEN 'CREATOR' WHEN $1::uuid = ANY(d.owner_user_ids) THEN 'OWNER' ELSE 'CO_WRITER' END AS my_role
         FROM brs_documents d
         JOIN brs_types bt ON bt.id = d.brs_type_id
         JOIN users u ON u.id = d.requester_id
        WHERE d.requester_id = $1 OR $1::uuid = ANY(d.owner_user_ids)
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
      `SELECT d.*, bt.name AS brs_type_name, u.full_name AS requester_name,
              CASE WHEN EXISTS (SELECT 1 FROM brs_document_sections s JOIN brs_document_section_assignees a ON a.section_id = s.id
                                 WHERE s.document_id = d.id AND ${brsMemberMatch("a", 1)}) THEN 'CONTRIBUTOR' ELSE 'REVIEWER' END AS my_role
         FROM brs_documents d
         JOIN brs_types bt ON bt.id = d.brs_type_id
         JOIN users u ON u.id = d.requester_id
        WHERE EXISTS (SELECT 1 FROM brs_document_sections s JOIN brs_document_section_assignees a ON a.section_id = s.id
                       WHERE s.document_id = d.id AND ${brsMemberMatch("a", 1)})
           OR EXISTS (SELECT 1 FROM brs_document_reviewers r WHERE r.document_id = d.id AND ${brsMemberMatch("r", 1)})
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
    const ownerIdList = brsOwnerIds(doc);
    const ownerRows = ownerIdList.length
      ? await query<{ id: string; full_name: string | null; email: string }>(`SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[])`, [ownerIdList])
      : [];
    const owners = ownerIdList.map((id) => ownerRows.find((r) => r.id === id)).filter(Boolean);
    const owner = owners[0] ?? null;
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

    const reviewers = await query(
      `SELECT r.id AS entry_id,
              CASE WHEN r.user_id IS NOT NULL THEN 'user' WHEN r.section_ref_id IS NOT NULL THEN 'department' WHEN r.team_ref_id IS NOT NULL THEN 'section' ELSE 'division' END AS type,
              coalesce(r.user_id, r.section_ref_id, r.team_ref_id)::text AS ref_id, r.division_name,
              coalesce(u.full_name, sec.name, tm.name, r.division_name) AS label
         FROM brs_document_reviewers r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN sections sec ON sec.id = r.section_ref_id
         LEFT JOIN teams tm ON tm.id = r.team_ref_id
        WHERE r.document_id = $1 ORDER BY 2, 5`,
      [doc.id]
    );
    const commentCount = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM brs_document_comments WHERE document_id = $1`, [doc.id]))[0].n;

    return res.json({
      ...doc,
      reviewers,
      comment_count: commentCount,
      creator,
      owner,
      owners,
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

    let updated = { ...doc.intake_data, ...parsed.data.intake_data };
    if (parsed.data.intake_data.departments !== undefined) {
      const units = z.array(OrgUnitSchema).max(50).safeParse(parsed.data.intake_data.departments);
      if (!units.success) throw badRequest("Invalid requesting departments");
      // Fill in each unit's division/company from Org Structure.
      const resolved = await orgUnitsFor([], units.data.map((u) => ({ type: u.type, id: u.id ?? null, name: u.name })));
      const enriched = (units.data as OrgUnit[])
        .map((u) => resolved.find((r) => unitKey(r) === unitKey(u)) ?? { ...u, id: u.id ?? null, parent: u.parent ?? null, company: u.company ?? null })
        .filter((u, i, all) => all.findIndex((x) => unitKey(x) === unitKey(u)) === i);
      updated = withUnits(updated, enriched);
    }
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

// POST /brs/:id/assignees — invite people and/or whole groups onto several
// sections at once. Anyone already on a section is skipped there; each
// person gets one email listing all of their new sections.
const BulkInviteSchema = z.object({
  entries: z.array(GroupEntrySchema).min(1, "Choose at least one person or group"),
  section_ids: z.array(z.string().uuid()).min(1, "Tick at least one section")
});
brsRouter.post("/:id/assignees", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = BulkInviteSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid invitation", parsed.error.flatten());
    const doc = await loadDocumentOr404(req.params.id);
    if (doc.phase === "BASELINE") throw badRequest("This BRS is approved — use Amend before inviting more collaborators");

    const sections = await query<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM brs_document_sections WHERE document_id = $1 AND id = ANY($2::uuid[]) ORDER BY sort_order`,
      [doc.id, parsed.data.section_ids]
    );
    if (sections.length !== new Set(parsed.data.section_ids).size) throw badRequest("One or more ticked sections are not part of this BRS");

    // Invite permission covers every section; otherwise only sections the
    // actor is already an assignee of.
    if (!(await brsPermissions(doc, req.user!)).invite) {
      for (const sec of sections) {
        if (!(await isSectionAssignee(sec.id, req.user!))) throw forbidden(`You don't have permission to invite people onto "${sec.title}"`);
      }
    }

    const entries = await resolveGroupEntries(parsed.data.entries);
    const added: Array<{ entry: (typeof entries)[number]; sections: string[] }> = entries.map((entry) => ({ entry, sections: [] }));
    for (const sec of sections) {
      for (const item of added) {
        const c = entryColumns(item.entry);
        const exists = (await query<{ id: string }>(
          `SELECT id FROM brs_document_section_assignees
            WHERE section_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND section_ref_id IS NOT DISTINCT FROM $3
              AND team_ref_id IS NOT DISTINCT FROM $4 AND lower(coalesce(division_name,'')) = lower(coalesce($5::text,''))`,
          [sec.id, c.user_id, c.section_ref_id, c.team_ref_id, c.division_name]
        ))[0];
        if (exists) continue;
        await query(
          `INSERT INTO brs_document_section_assignees (section_id, user_id, section_ref_id, team_ref_id, division_name, added_by_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sec.id, c.user_id, c.section_ref_id, c.team_ref_id, c.division_name, req.user!.userId]
        );
        item.sections.push(sec.title);
      }
      await query(
        `UPDATE brs_document_sections SET status = CASE WHEN status = 'PENDING' THEN 'IN_PROGRESS' ELSE status END,
                due_at = CASE WHEN due_at IS NULL AND sla_hours IS NOT NULL THEN now() + (sla_hours || ' hours')::interval ELSE due_at END,
                updated_at = now()
          WHERE id = $1`,
        [sec.id]
      );
    }

    const done = added.filter((a) => a.sections.length);
    if (done.length) {
      await recordBrsRevision({
        documentId: doc.id, kind: "PEOPLE_CHANGED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
        summary: `Invited ${done.map((a) => `${a.entry.label} onto ${a.sections.map((t) => `"${t}"`).join(", ")}`).join("; ")}`
      });
      for (const a of done) {
        void (async () => notifyBrsSectionAssigned({
          documentId: doc.id, brsTitle: doc.title, requesterName: req.user!.fullName ?? null,
          sectionTitle: a.sections.join(", "), assigneeEmails: await entryEmails([a.entry])
        }))();
      }
    }
    const invitations = done.reduce((n, a) => n + a.sections.length, 0);
    return res.status(201).json({ ok: true, invitations, skipped: entries.length * sections.length - invitations });
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

// Replaces the reviewer list; emails anyone newly added; logs the change.
async function setBrsReviewers(doc: any, entriesIn: GroupEntry[], actor: { userId: string; role: string; fullName?: string }) {
  const wanted = await resolveGroupEntries(entriesIn);
  const keyOf = (e: { type: string; id?: string | null; name?: string | null }) => `${e.type}:${e.type === "division" ? (e.name || "").toLowerCase() : e.id}`;
  const before = await query<{ id: string; user_id: string | null; section_ref_id: string | null; team_ref_id: string | null; division_name: string | null; label: string }>(
    `SELECT r.id, r.user_id, r.section_ref_id, r.team_ref_id, r.division_name,
            coalesce(u.full_name, sec.name || ' (Department)', tm.name || ' (Section)', r.division_name || ' (Division)') AS label
       FROM brs_document_reviewers r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN sections sec ON sec.id = r.section_ref_id LEFT JOIN teams tm ON tm.id = r.team_ref_id
      WHERE r.document_id = $1`, [doc.id]
  );
  const beforeKey = (b: (typeof before)[number]) => b.user_id ? `user:${b.user_id}` : b.section_ref_id ? `department:${b.section_ref_id}` : b.team_ref_id ? `section:${b.team_ref_id}` : `division:${(b.division_name || "").toLowerCase()}`;
  const added = wanted.filter((e) => !before.some((b) => beforeKey(b) === keyOf(e)));
  const removed = before.filter((b) => !wanted.some((e) => keyOf(e) === beforeKey(b)));
  if (!added.length && !removed.length) return { added: 0, removed: 0 };
  if (removed.length) await query(`DELETE FROM brs_document_reviewers WHERE id = ANY($1::uuid[])`, [removed.map((r) => r.id)]);
  for (const e of added) {
    const c = entryColumns(e);
    await query(
      `INSERT INTO brs_document_reviewers (document_id, user_id, section_ref_id, team_ref_id, division_name, added_by_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [doc.id, c.user_id, c.section_ref_id, c.team_ref_id, c.division_name, actor.userId]
    );
  }
  const parts: string[] = [];
  if (added.length) parts.push(`Reviewers added: ${added.map((e) => e.label).join(", ")}`);
  if (removed.length) parts.push(`Reviewers removed: ${removed.map((r) => r.label).join(", ")}`);
  await recordBrsRevision({ documentId: doc.id, kind: "REVIEWERS_CHANGED", actorId: actor.userId, actorRole: await brsActorRole(doc, actor), summary: parts.join("; ") });
  if (added.length) {
    void (async () => notifyBrsReviewersAdded({ documentId: doc.id, brsTitle: doc.title, addedBy: actor.fullName ?? null, emails: await entryEmails(added) }))();
  }
  return { added: added.length, removed: removed.length };
}

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
  approval_chain: z.array(ChainStepSchema).min(1, "At least one approver is required"),
  // Comment-only reviewers (Departments / Sections) routed alongside the approvers.
  reviewers: z.array(GroupEntrySchema).optional()
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
    if (parsed.data.reviewers?.length) {
      await setBrsReviewers(doc, parsed.data.reviewers, req.user!);
    }

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
      product_owner: (await ownerNames(brsOwnerIds(doc))) ?? doc.intake_data?.product_owner ?? null,
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
  owner_user_ids: z.array(z.string().uuid()).max(20).optional(),
  owner_user_id: z.string().uuid().nullish(),
  co_writer_ids: z.array(z.string().uuid()).default([]),
  co_writers: z.array(GroupEntrySchema).default([])
});
brsRouter.put("/:id/people", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = PeopleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const doc = await loadDocumentOr404(req.params.id);
    if (!canManageBrs(doc, req.user!)) throw forbidden("Only the creator or owner can change who works on this BRS");

    const ownerIds = Array.from(new Set(parsed.data.owner_user_ids ?? (parsed.data.owner_user_id ? [parsed.data.owner_user_id] : [])));
    if (ownerIds.includes(doc.requester_id)) throw badRequest("The creator already has full rights — choose someone else as owner");
    const prevOwners = brsOwnerIds(doc);
    const people = await loadActiveUsers(Array.from(new Set([...ownerIds, ...prevOwners])).filter((id) => ownerIds.includes(id)));
    const prevOwnerNames = prevOwners.length
      ? new Map((await query<{ id: string; full_name: string | null }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [prevOwners])).map((r) => [r.id, r.full_name]))
      : new Map<string, string | null>();
    // Making a co-writer an owner moves them: an owner is never also listed as a co-writer.
    const wanted = await resolveGroupEntries([
      ...parsed.data.co_writer_ids.map((id) => ({ type: "user" as const, id })),
      ...parsed.data.co_writers
    ].filter((e) => !(e.type === "user" && (e.id === doc.requester_id || ownerIds.includes(e.id!)))));
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
    const ownersAdded = ownerIds.filter((id) => !prevOwners.includes(id));
    const ownersRemoved = prevOwners.filter((id) => !ownerIds.includes(id));
    const ownerChanged = ownersAdded.length > 0 || ownersRemoved.length > 0 || ownerIds.join(",") !== prevOwners.join(",");
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

    // Newly added people's departments join the requesting departments
    // (ones already there, or removed by hand, are left as they are).
    const unitsBefore = await currentUnits(doc.intake_data);
    const newUnits = (await orgUnitsFor(
      [...ownersAdded, ...added.filter((e) => e.type === "user").map((e) => e.id!)],
      added.filter((e) => e.type !== "user")
    )).filter((u) => !unitsBefore.some((b) => unitKey(b) === unitKey(u)));
    const intakePatch = {
      product_owner: ownerIds.length ? ownerIds.map((id) => people.get(id)!.full_name).join(", ") : null,
      ...(newUnits.length ? { departments: [...unitsBefore, ...newUnits], department: [...unitsBefore, ...newUnits].map((u) => u.name).join(", ") } : {})
    };
    await query(`UPDATE brs_documents SET owner_user_id = $1, owner_user_ids = $2::uuid[], intake_data = intake_data || $3::jsonb, updated_at = now() WHERE id = $4`,
      [ownerIds[0] ?? null, ownerIds, JSON.stringify(intakePatch), doc.id]);
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
    if (ownersAdded.length) parts.push(`Owners added: ${ownersAdded.map((id) => people.get(id)!.full_name).join(", ")}`);
    if (ownersRemoved.length) parts.push(`Owners removed: ${ownersRemoved.map((id) => prevOwnerNames.get(id) || "—").join(", ")}`);
    if (newUnits.length) parts.push(`Requesting departments added: ${newUnits.map((u) => u.name).join(", ")}`);
    if (added.length) parts.push(`Co-writers added: ${added.map((e) => `${e.label} (${describePermissions(normalizePermissions(e.permissions))})`).join(", ")}`);
    if (permChanged.length) parts.push(`Permissions changed: ${permChanged.map((x) => `${x.e.label} ${describePermissions(normalizePermissions(x.prev!.row.permissions))} → ${describePermissions(normalizePermissions(x.e.permissions))}`).join("; ")}`);
    if (removedLabels.length) parts.push(`Co-writers removed: ${removedLabels.join(", ")}`);
    await recordBrsRevision({ documentId: doc.id, kind: "PEOPLE_CHANGED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!), summary: parts.join("; ") });

    void (async () => notifyBrsPeopleAdded({
      documentId: doc.id, brsTitle: doc.title, addedBy: req.user!.fullName ?? null,
      owners: ownersAdded.map((id) => people.get(id)!),
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

// PUT /brs/:id/reviewers — the comment-only reviewers (creator, owner, or a
// co-writer allowed to route). Can change at any point before approval.
const ReviewersSchema = z.object({ reviewers: z.array(GroupEntrySchema) });
brsRouter.put("/:id/reviewers", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ReviewersSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid reviewers", parsed.error.flatten());
    const doc = await loadDocumentOr404(req.params.id);
    if (!(await brsPermissions(doc, req.user!)).workflow) throw forbidden("You don't have permission to change the reviewers");
    if (doc.phase === "BASELINE") throw badRequest("This BRS is approved — use Amend before changing reviewers");
    return res.json({ ok: true, ...(await setBrsReviewers(doc, parsed.data.reviewers, req.user!)) });
  } catch (err) {
    return next(err);
  }
});

// GET /brs/:id/comments — everyone who can open the BRS can read them.
brsRouter.get("/:id/comments", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);
    const rows = await query(
      `SELECT c.id, c.section_id, s.title AS section_title, c.body, c.author_role, c.created_at, u.full_name AS author_name
         FROM brs_document_comments c
         LEFT JOIN users u ON u.id = c.author_id
         LEFT JOIN brs_document_sections s ON s.id = c.section_id
        WHERE c.document_id = $1 ORDER BY c.created_at ASC`,
      [doc.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/comments — reviewers' main tool, open to everyone involved.
const CommentSchema = z.object({ body: z.string().trim().min(1, "Write a comment first").max(5000), section_id: z.string().uuid().nullish() });
brsRouter.post("/:id/comments", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid comment", parsed.error.flatten());
    const doc = await loadDocumentOr404(req.params.id);
    await assertCanViewDocument(doc, req.user!);
    let sectionTitle: string | null = null;
    if (parsed.data.section_id) {
      const sec = (await query<{ title: string }>(`SELECT title FROM brs_document_sections WHERE id = $1 AND document_id = $2`, [parsed.data.section_id, doc.id]))[0];
      if (!sec) throw badRequest("That section isn't part of this BRS");
      sectionTitle = sec.title;
    }
    const role = await brsActorRole(doc, req.user!);
    const row = (await query<{ id: string }>(
      `INSERT INTO brs_document_comments (document_id, section_id, author_id, author_role, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [doc.id, parsed.data.section_id ?? null, req.user!.userId, role, parsed.data.body]
    ))[0];
    await recordBrsRevision({
      documentId: doc.id, kind: "COMMENTED", actorId: req.user!.userId, actorRole: role,
      summary: `Comment${sectionTitle ? ` on "${sectionTitle}"` : ""}: ${parsed.data.body.length > 140 ? parsed.data.body.slice(0, 140) + "…" : parsed.data.body}`
    });
    return res.status(201).json({ id: row.id });
  } catch (err) {
    return next(err);
  }
});

// POST /brs/:id/sections — the creator (owner/admin) adds a section of their
// own to this BRS, beyond the template's.
const AddSectionSchema = z.object({
  title: z.string().trim().min(1, "Give the section a title").max(200),
  description: z.string().trim().max(1000).nullish(),
  owner_phase: z.enum(["DRAFT", "DEPT_INPUT"]).default("DRAFT"),
  is_required: z.boolean().default(false)
});
brsRouter.post("/:id/sections", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AddSectionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid section", parsed.error.flatten());
    const doc = await loadDocumentOr404(req.params.id);
    if (!canManageBrs(doc, req.user!)) throw forbidden("Only the creator or owner can add sections");
    if (doc.phase === "BASELINE") throw badRequest("This BRS is approved — use Amend before adding sections");
    const key = `custom_${parsed.data.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)}_${Date.now().toString(36)}`;
    const row = (await query<{ id: string }>(
      `INSERT INTO brs_document_sections (document_id, section_key, title, description, owner_phase, is_required, sort_order, added_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(sort_order), -1) + 1 FROM brs_document_sections WHERE document_id = $1), $7)
       RETURNING id`,
      [doc.id, key, parsed.data.title, parsed.data.description || null, parsed.data.owner_phase, parsed.data.is_required, req.user!.userId]
    ))[0];
    await recordBrsRevision({
      documentId: doc.id, kind: "SECTION_ADDED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: `Section added: "${parsed.data.title}" (${parsed.data.owner_phase === "DRAFT" ? "Draft" : "Department Input"}, ${parsed.data.is_required ? "required" : "optional"})`,
      sectionId: row.id, sectionTitle: parsed.data.title
    });
    return res.status(201).json({ id: row.id });
  } catch (err) {
    return next(err);
  }
});

// DELETE /brs/:id/sections/:sectionId — only a section added to this BRS
// (not a template one), and only while it's still empty.
brsRouter.delete("/:id/sections/:sectionId", async (req: AuthedRequest, res, next) => {
  try {
    const doc = await loadDocumentOr404(req.params.id);
    if (!canManageBrs(doc, req.user!)) throw forbidden("Only the creator or owner can remove sections");
    if (doc.phase === "BASELINE") throw badRequest("This BRS is approved — use Amend before removing sections");
    const sec = (await query<{ id: string; title: string; type_section_id: string | null; content_html: string | null }>(
      `SELECT id, title, type_section_id, content_html FROM brs_document_sections WHERE id = $1 AND document_id = $2`, [req.params.sectionId, doc.id]
    ))[0];
    if (!sec) throw notFound("Section not found");
    if (sec.type_section_id) throw badRequest("Sections from the BRS template can't be removed — only ones added to this BRS");
    if ((sec.content_html || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim()) {
      throw badRequest("This section already has content — clear it first if you really want to remove it");
    }
    await query(`DELETE FROM brs_document_sections WHERE id = $1`, [sec.id]);
    await recordBrsRevision({
      documentId: doc.id, kind: "SECTION_REMOVED", actorId: req.user!.userId, actorRole: await brsActorRole(doc, req.user!),
      summary: `Section removed: "${sec.title}"`
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
