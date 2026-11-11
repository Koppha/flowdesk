import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { notifyChangeRequestPeopleAdded } from "../../lib/notifications.js";
import { renderChangeRequestRecordPdf } from "../../lib/pdf/changeRequestRecordPdf.js";
import type { PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";
import { brsActorOrg, brsMemberMatch, brsMemberParams } from "../brs/brs.service.js";
import { entryEmails, resolveOrgEntries as resolveGroupEntries } from "../brs/brs.routes.js";
import {
  CR_FORM_SECTIONS, CR_OTHER_SECTION, CR_PERMISSIONS, assertBackOutPlan, assertCanSubmit, canViewChangeRequest, changeRequestReference, crActorRole,
  crCoWriterPermissions, crOwnerIds, crPermissions, describeFieldSave, diffFields, formSectionOf,
  isSubmissionAssignee, recordCrRevision
} from "./change-collab.service.js";

// Collaboration on a Change Request - drafts, owners, co-writers, sections,
// comments, history. Mounted on /custom-requests ahead of the generic router;
// anything not matched here falls through to it.
export const changeCollabRouter = Router();
changeCollabRouter.use(requireAuth);

const EDITABLE_STATUSES = ["DRAFT", "IN_PROGRESS"];

const EntrySchema = z.object({
  type: z.enum(["user", "division", "department", "section"]),
  id: z.string().uuid().nullish(),
  name: z.string().trim().nullish(),
  permissions: z.array(z.enum(CR_PERMISSIONS)).optional()
}).refine((e) => (e.type === "division" ? !!e.name : !!e.id), { message: "Each entry needs an id (or a name for a division)" });
type Entry = z.infer<typeof EntrySchema>;

const PeopleSchema = z.object({
  owner_user_ids: z.array(z.string().uuid()).max(20).default([]),
  co_writers: z.array(EntrySchema).max(100).default([])
});

const PERMISSION_LABEL: Record<string, string> = { EDIT: "edit", INVITE: "invite", SUBMIT: "submit for approval", DISTRIBUTE: "distribute" };
const describePerms = (p: string[]) => (p.length ? p.map((x) => PERMISSION_LABEL[x] || x).join(", ") : "view & comment only");
const normalizePerms = (p?: string[] | null) => CR_PERMISSIONS.filter((x) => (p ?? ["EDIT"]).includes(x));
const entryKey = (e: { type: string; id?: string | null; name?: string | null }) => `${e.type}:${e.type === "division" ? (e.name || "").toLowerCase() : e.id}`;

type CollabRow = { id: string; user_id: string | null; section_ref_id: string | null; team_ref_id: string | null; division_name: string | null; permissions: string[]; added_by_id: string | null };
function rowEntry(r: CollabRow): { type: Entry["type"]; id: string | null; name: string | null } {
  if (r.user_id) return { type: "user", id: r.user_id, name: null };
  if (r.section_ref_id) return { type: "department", id: r.section_ref_id, name: null };
  if (r.team_ref_id) return { type: "section", id: r.team_ref_id, name: null };
  return { type: "division", id: null, name: r.division_name };
}

async function loadChangeRequest(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Change Request not found");
  const sub = (await query<any>(
    `SELECT s.*, rt.code AS request_type_code, rt.name AS request_type_name
       FROM custom_request_submissions s JOIN custom_request_types rt ON rt.id = s.request_type_id
      WHERE s.id = $1`,
    [id]
  ))[0];
  if (!sub || sub.request_type_code !== "CHANGE_REQUEST") throw notFound("Change Request not found");
  const fields = await query<{ field_key: string; field_label: string; field_type: string; sort_order: number }>(
    `SELECT field_key, field_label, field_type, sort_order FROM request_type_fields WHERE request_type_id = $1 AND is_active = true ORDER BY sort_order, created_at`,
    [sub.request_type_id]
  );
  return { sub, fields };
}

async function assertView(sub: any, fields: any[], req: AuthedRequest) {
  if (!(await canViewChangeRequest(sub, req.user!, fields))) throw forbidden();
}

function titleOf(sub: any) {
  return String(sub.data?.description_of_change || "Change Request").slice(0, 120);
}

// Writes the co-writer list and returns the entries that are new, for emailing.
async function writeCoWriters(submissionId: string, entries: Array<Entry & { label: string }>, existing: CollabRow[], actorId: string) {
  const existingByKey = new Map(existing.map((r) => [entryKey(rowEntry(r)), r]));
  const wanted = new Set(entries.map(entryKey));
  for (const r of existing) {
    if (!wanted.has(entryKey(rowEntry(r)))) await query(`DELETE FROM cr_collaborators WHERE id = $1`, [r.id]);
  }
  const added: Array<Entry & { label: string }> = [];
  for (const e of entries) {
    const perms = normalizePerms(e.permissions);
    const row = existingByKey.get(entryKey(e));
    if (row) {
      if (normalizePerms(row.permissions).join(",") !== perms.join(",")) {
        await query(`UPDATE cr_collaborators SET permissions = $1 WHERE id = $2`, [perms, row.id]);
      }
      continue;
    }
    await query(
      `INSERT INTO cr_collaborators (submission_id, user_id, section_ref_id, team_ref_id, division_name, permissions, added_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [submissionId, e.type === "user" ? e.id : null, e.type === "department" ? e.id : null, e.type === "section" ? e.id : null,
       e.type === "division" ? e.name : null, perms, actorId]
    );
    added.push(e);
  }
  return added;
}

async function listCoWriters(submissionId: string) {
  return query<any>(
    `SELECT c.id AS entry_id, c.permissions, c.added_by_id, c.created_at, ab.full_name AS added_by_name,
            CASE WHEN c.user_id IS NOT NULL THEN 'user' WHEN c.section_ref_id IS NOT NULL THEN 'department'
                 WHEN c.team_ref_id IS NOT NULL THEN 'section' ELSE 'division' END AS type,
            coalesce(c.user_id, c.section_ref_id, c.team_ref_id) AS id, c.division_name AS name,
            coalesce(u.full_name, u.email, sec.name || ' (Department)', t.name || ' (Section)', c.division_name || ' (Division)') AS label
       FROM cr_collaborators c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN sections sec ON sec.id = c.section_ref_id
       LEFT JOIN teams t ON t.id = c.team_ref_id
       LEFT JOIN users ab ON ab.id = c.added_by_id
      WHERE c.submission_id = $1 ORDER BY c.created_at`,
    [submissionId]
  );
}

async function activeUsers(ids: string[]) {
  if (!ids.length) return [];
  const rows = await query<{ id: string; full_name: string | null; email: string }>(
    `SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`, [ids]
  );
  if (rows.length !== new Set(ids).size) throw badRequest("One or more selected co-owners are not active FlowDesk users");
  return rows;
}

// POST /custom-requests/change-requests/drafts - start a Change Request as a
// draft that owners and co-writers work on before it is submitted.
const DraftSchema = PeopleSchema.extend({ data: z.record(z.string(), z.any()).default({}) });
changeCollabRouter.post("/change-requests/drafts", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = DraftSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid draft", parsed.error.flatten());
    const type = (await query<{ id: string }>(
      `SELECT id FROM custom_request_types WHERE code = 'CHANGE_REQUEST' AND is_active = true AND status = 'ACTIVE'`
    ))[0];
    if (!type) throw notFound("Change Request is not available");
    await assertCanSubmit(req.user!.userId, req.user!.role, req.user!.department ?? null, req.user!.employmentType ?? null, type.id);

    const fields = await query<{ field_key: string }>(`SELECT field_key FROM request_type_fields WHERE request_type_id = $1 AND is_active = true`, [type.id]);
    const known = new Set(fields.map((f) => f.field_key));
    const data = Object.fromEntries(Object.entries(parsed.data.data).filter(([k]) => known.has(k)));

    const ownerIds = [...new Set(parsed.data.owner_user_ids)].filter((id) => id !== req.user!.userId);
    const owners = await activeUsers(ownerIds);
    const entries = (await resolveGroupEntries(parsed.data.co_writers))
      .filter((e) => !(e.type === "user" && (e.id === req.user!.userId || ownerIds.includes(e.id!))));

    const sub = (await query<{ id: string }>(
      `INSERT INTO custom_request_submissions (request_type_id, requester_id, data, approval_chain, current_step_order, status, owner_user_ids)
       VALUES ($1, $2, $3, '[]', 0, 'DRAFT', $4) RETURNING id`,
      [type.id, req.user!.userId, JSON.stringify(data), ownerIds]
    ))[0];
    const added = await writeCoWriters(sub.id, entries, [], req.user!.userId);
    const people = [...owners.map((o) => `${o.full_name || o.email} (co-owner)`), ...added.map((e) => `${e.label} (${describePerms(normalizePerms(e.permissions))})`)];
    await recordCrRevision({
      submissionId: sub.id, kind: "DRAFT_CREATED", actorId: req.user!.userId, actorRole: "CREATOR",
      summary: `Started the draft${people.length ? ` with ${people.join(", ")}` : ""}`
    });
    res.status(201).json({ id: sub.id });

    void (async () => notifyChangeRequestPeopleAdded({
      submissionId: sub.id, title: String(data.description_of_change || "Change Request (draft)").slice(0, 120),
      addedBy: req.user!.fullName ?? null, owners, coWriterEmails: await entryEmails(added)
    }))();
  } catch (err) {
    return next(err);
  }
});

// GET /custom-requests/change-requests/collaborating - Change Requests the
// user owns or co-writes (directly or through a group) but didn't create.
changeCollabRouter.get("/change-requests/collaborating", async (req: AuthedRequest, res, next) => {
  try {
    const org = await brsActorOrg(req.user!.userId);
    const rows = await query<any>(
      `SELECT s.*, rt.name AS request_type_name, rt.code AS request_type_code, u.full_name AS requester_name, '[]'::json AS attachments,
              CASE WHEN $1::uuid = ANY(s.owner_user_ids) THEN 'OWNER' ELSE 'CO_WRITER' END AS my_role
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
         JOIN users u ON u.id = s.requester_id
        WHERE rt.code = 'CHANGE_REQUEST' AND s.requester_id <> $1
          AND ($1::uuid = ANY(s.owner_user_ids)
               OR EXISTS (SELECT 1 FROM cr_collaborators c WHERE c.submission_id = s.id AND ${brsMemberMatch("c", 1)}))
        ORDER BY s.updated_at DESC`,
      brsMemberParams(org)
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /custom-requests/:id/workspace - people, permissions, sections,
// comment counts and recent changes for one Change Request.
changeCollabRouter.get("/:id/workspace", async (req: AuthedRequest, res, next) => {
  try {
    const { sub, fields } = await loadChangeRequest(req.params.id);
    await assertView(sub, fields, req);
    const perms = await crPermissions(sub, req.user!);
    const myRole = await crActorRole(sub, req.user!, fields);

    const creator = (await query(`SELECT id, full_name, email FROM users WHERE id = $1`, [sub.requester_id]))[0] ?? null;
    const owners = crOwnerIds(sub).length
      ? await query(`SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[]) ORDER BY full_name`, [crOwnerIds(sub)])
      : [];
    const coWriters = await listCoWriters(sub.id);
    const customSections = await query(
      `SELECT cs.*, ab.full_name AS added_by_name, ub.full_name AS updated_by_name
         FROM cr_custom_sections cs
         LEFT JOIN users ab ON ab.id = cs.added_by_id
         LEFT JOIN users ub ON ub.id = cs.updated_by_id
        WHERE cs.submission_id = $1 ORDER BY cs.sort_order, cs.created_at`,
      [sub.id]
    );
    // The form's own sections, holding only the fields this form really has.
    const formSections = [...CR_FORM_SECTIONS, CR_OTHER_SECTION]
      .map((s) => ({ key: s.key, title: s.title, field_keys: fields.filter((f) => formSectionOf(f.field_key).key === s.key).map((f) => f.field_key) }))
      .filter((s) => s.field_keys.length);
    const commentCounts = await query<{ section_key: string | null; n: number }>(
      `SELECT section_key, count(*)::int AS n FROM cr_comments WHERE submission_id = $1 GROUP BY section_key`, [sub.id]
    );
    const seen = (await query<{ seen_at: string }>(`SELECT seen_at FROM cr_seen WHERE submission_id = $1 AND user_id = $2`, [sub.id, req.user!.userId]))[0];
    const recent = await query(
      `SELECT r.id, r.kind, r.summary, r.section_key, r.section_title, r.changes, r.status, r.actor_role, r.created_at, u.full_name AS actor_name, r.actor_id
         FROM cr_revisions r LEFT JOIN users u ON u.id = r.actor_id
        WHERE r.submission_id = $1 ORDER BY r.created_at DESC LIMIT 8`,
      [sub.id]
    );
    const unseen = (await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cr_revisions WHERE submission_id = $1 AND (actor_id IS NULL OR actor_id <> $2) AND created_at > coalesce($3::timestamptz, '-infinity')`,
      [sub.id, req.user!.userId, seen?.seen_at ?? null]
    ))[0]?.n ?? 0;

    return res.json({
      status: sub.status,
      my_role: myRole,
      my_permissions: perms,
      can_edit_fields: EDITABLE_STATUSES.includes(sub.status) && (perms.edit || (sub.status === "IN_PROGRESS" && isSubmissionAssignee(sub.data, fields, req.user!))),
      creator, owners, co_writers: coWriters,
      form_sections: formSections,
      custom_sections: customSections,
      comment_counts: Object.fromEntries(commentCounts.map((c) => [c.section_key ?? "_doc", c.n])),
      recent,
      last_seen_at: seen?.seen_at ?? null,
      unseen_count: unseen
    });
  } catch (err) {
    return next(err);
  }
});

// POST /custom-requests/:id/seen - marks recent changes as read for this user.
changeCollabRouter.post("/:id/seen", async (req: AuthedRequest, res, next) => {
  try {
    const { sub, fields } = await loadChangeRequest(req.params.id);
    await assertView(sub, fields, req);
    await query(
      `INSERT INTO cr_seen (submission_id, user_id, seen_at) VALUES ($1, $2, now())
       ON CONFLICT (submission_id, user_id) DO UPDATE SET seen_at = now()`,
      [sub.id, req.user!.userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// PUT /custom-requests/:id/people - owners and co-writers. The creator and
// owners change anything; a co-writer with "invite" may add people (with no
// more rights than their own) and remove only the people they added.
changeCollabRouter.put("/:id/people", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = PeopleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid people list", parsed.error.flatten());
    const { sub, fields } = await loadChangeRequest(req.params.id);
    if (["REJECTED", "CANCELLED"].includes(sub.status)) throw badRequest("This Change Request is closed to changes");
    const perms = await crPermissions(sub, req.user!);
    if (!perms.manage && !perms.invite) throw forbidden("Only the creator, a co-owner or a co-writer allowed to invite can add people");

    const existing = await query<CollabRow>(`SELECT * FROM cr_collaborators WHERE submission_id = $1`, [sub.id]);
    const before = crOwnerIds(sub);
    let ownerIds = [...new Set(parsed.data.owner_user_ids)].filter((id) => id !== sub.requester_id);
    let entries = (await resolveGroupEntries(parsed.data.co_writers))
      .filter((e) => !(e.type === "user" && (e.id === sub.requester_id || ownerIds.includes(e.id!))));

    if (!perms.manage) {
      // Owners stay as they are; existing entries stay unless this person added them.
      ownerIds = before;
      const mine = (await crCoWriterPermissions(sub.id, req.user!.userId)).perms;
      const incoming = new Map(entries.map((e) => [entryKey(e), e]));
      for (const r of existing) {
        const e = incoming.get(entryKey(rowEntry(r)));
        const changed = !e || normalizePerms(e.permissions).join(",") !== normalizePerms(r.permissions).join(",");
        if (changed && r.added_by_id !== req.user!.userId) throw forbidden("You can only change or remove people you added");
      }
      for (const e of entries) {
        if (normalizePerms(e.permissions).some((p) => !mine.has(p))) throw forbidden("You can't give anyone more rights than you have");
      }
      entries = entries.filter((e) => !(e.type === "user" && ownerIds.includes(e.id!)));
    }

    const approverIds = (sub.approval_chain || []).map((st: any) => st.approver_id);
    if (ownerIds.some((id) => !before.includes(id) && approverIds.includes(id))) {
      throw badRequest("An approver on this Change Request can't also be a co-owner");
    }
    const newOwners = await activeUsers(ownerIds.filter((id) => !before.includes(id)));
    if (ownerIds.join(",") !== before.join(",")) {
      await activeUsers(ownerIds);
      await query(`UPDATE custom_request_submissions SET owner_user_ids = $1, updated_at = now() WHERE id = $2`, [ownerIds, sub.id]);
    }
    const existingLabels = new Map((await query<{ id: string; label: string }>(
      `SELECT c.id, coalesce(u.full_name, u.email, sec.name || ' (Department)', t.name || ' (Section)', c.division_name || ' (Division)') AS label
         FROM cr_collaborators c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN sections sec ON sec.id = c.section_ref_id
         LEFT JOIN teams t ON t.id = c.team_ref_id WHERE c.submission_id = $1`, [sub.id]
    )).map((r) => [r.id, r.label]));
    const added = await writeCoWriters(sub.id, entries, existing, req.user!.userId);

    // Before → after, in words, for the audit trail.
    const lines: string[] = [];
    const nameOf = async (ids: string[]) => ids.length
      ? (await query<{ n: string }>(`SELECT coalesce(full_name, email) AS n FROM users WHERE id = ANY($1::uuid[])`, [ids])).map((r) => r.n) : [];
    const ownersAdded = await nameOf(ownerIds.filter((id) => !before.includes(id)));
    const ownersRemoved = await nameOf(before.filter((id) => !ownerIds.includes(id)));
    if (ownersAdded.length) lines.push(`Co-owners added: ${ownersAdded.join(", ")}`);
    if (ownersRemoved.length) lines.push(`Co-owners removed: ${ownersRemoved.join(", ")}`);
    if (added.length) lines.push(`Added: ${added.map((e) => `${e.label} (${describePerms(normalizePerms(e.permissions))})`).join(", ")}`);
    const wanted = new Map(entries.map((e) => [entryKey(e), e]));
    const removed = existing.filter((r) => !wanted.has(entryKey(rowEntry(r))));
    if (removed.length) lines.push(`Removed: ${removed.map((r) => existingLabels.get(r.id) || "someone").join(", ")}`);
    for (const r of existing) {
      const e = wanted.get(entryKey(rowEntry(r)));
      if (e && normalizePerms(e.permissions).join(",") !== normalizePerms(r.permissions).join(",")) {
        lines.push(`${existingLabels.get(r.id) || e.label}: ${describePerms(normalizePerms(r.permissions))} → ${describePerms(normalizePerms(e.permissions))}`);
      }
    }
    if (lines.length) {
      await recordCrRevision({
        submissionId: sub.id, kind: "PEOPLE_CHANGED", actorId: req.user!.userId,
        actorRole: await crActorRole(sub, req.user!, fields), summary: lines.join("; ")
      });
    }
    res.json({ ok: true });

    if (newOwners.length || added.length) {
      void (async () => notifyChangeRequestPeopleAdded({
        submissionId: sub.id, title: titleOf(sub), addedBy: req.user!.fullName ?? null, owners: newOwners,
        coWriterEmails: await entryEmails(added)
      }))();
    }
  } catch (err) {
    return next(err);
  }
});

// PATCH /custom-requests/:id/fields - save form fields, with each changed
// field's before/after kept in the history. While a draft, anyone with edit
// rights changes anything; once submitted, Change Assignees go through the
// assignee endpoints and the form's assignees may still fill in the
// implementation side, as before.
changeCollabRouter.patch("/:id/fields", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ data: z.record(z.string(), z.any()) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const { sub, fields } = await loadChangeRequest(req.params.id);
    if (!EDITABLE_STATUSES.includes(sub.status)) throw badRequest("This Change Request can no longer be edited");
    const perms = await crPermissions(sub, req.user!);
    const assignee = sub.status === "IN_PROGRESS" && isSubmissionAssignee(sub.data, fields, req.user!);
    if (!perms.edit && !assignee) throw forbidden("You don't have edit rights on this Change Request");

    const typeOf = new Map(fields.map((f) => [f.field_key, f.field_type]));
    const updates: Record<string, any> = {};
    for (const [key, value] of Object.entries(parsed.data.data)) {
      const type = typeOf.get(key);
      if (!type) throw badRequest(`Unknown field "${key}"`);
      if (type === "user_multi" && sub.status !== "DRAFT") throw badRequest(`"${key}" is changed through the assignee list once submitted`);
      updates[key] = value;
    }
    const changes = diffFields(sub.data || {}, updates, fields);
    if (!changes.length) return res.json({ ok: true, unchanged: true });
    // Drafts can be incomplete; once submitted, the plan can't be dropped.
    if (sub.status !== "DRAFT") assertBackOutPlan({ ...sub.data, ...updates });

    await query(`UPDATE custom_request_submissions SET data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify({ ...sub.data, ...updates }), sub.id]);
    const d = describeFieldSave(changes);
    await recordCrRevision({
      submissionId: sub.id, kind: "FIELDS_SAVED", actorId: req.user!.userId, actorRole: await crActorRole(sub, req.user!, fields),
      summary: d.summary, sectionKey: d.sectionKey, sectionTitle: d.sectionTitle, changes
    });
    return res.json({ ok: true, changed: changes.length });
  } catch (err) {
    return next(err);
  }
});

// Sections added to one Change Request (on top of the form's own sections).
const SectionSchema = z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().max(500).nullish() });

changeCollabRouter.post("/:id/sections", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = SectionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Give the section a title (up to 120 characters)");
    const { sub, fields } = await loadChangeRequest(req.params.id);
    if (!EDITABLE_STATUSES.includes(sub.status)) throw badRequest("Sections can no longer be added");
    if (!(await crPermissions(sub, req.user!)).manage) throw forbidden("Only the creator or a co-owner can add sections");
    const nextOrder = (await query<{ n: number }>(`SELECT coalesce(max(sort_order), 0) + 1 AS n FROM cr_custom_sections WHERE submission_id = $1`, [sub.id]))[0].n;
    const row = (await query<{ id: string }>(
      `INSERT INTO cr_custom_sections (submission_id, title, description, sort_order, added_by_id, updated_by_id)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
      [sub.id, parsed.data.title, parsed.data.description ?? null, nextOrder, req.user!.userId]
    ))[0];
    await recordCrRevision({
      submissionId: sub.id, kind: "SECTION_ADDED", actorId: req.user!.userId, actorRole: await crActorRole(sub, req.user!, fields),
      summary: `Added the section "${parsed.data.title}"`, sectionKey: row.id, sectionTitle: parsed.data.title
    });
    return res.status(201).json({ id: row.id });
  } catch (err) {
    return next(err);
  }
});

changeCollabRouter.patch("/:id/sections/:sid", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ content: z.string().max(20000).optional(), title: z.string().trim().min(1).max(120).optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid section", parsed.error.flatten());
    const { sub, fields } = await loadChangeRequest(req.params.id);
    if (!EDITABLE_STATUSES.includes(sub.status)) throw badRequest("This Change Request can no longer be edited");
    const perms = await crPermissions(sub, req.user!);
    if (!perms.edit) throw forbidden("You don't have edit rights on this Change Request");
    if (parsed.data.title !== undefined && !perms.manage) throw forbidden("Only the creator or a co-owner can rename sections");
    const section = (await query<any>(`SELECT * FROM cr_custom_sections WHERE id = $1 AND submission_id = $2`, [req.params.sid, sub.id]))[0];
    if (!section) throw notFound("Section not found");

    const changes = [];
    if (parsed.data.title !== undefined && parsed.data.title !== section.title) changes.push({ key: "title", label: "Section title", before: section.title, after: parsed.data.title });
    if (parsed.data.content !== undefined && parsed.data.content !== section.content) changes.push({ key: "content", label: section.title, before: section.content, after: parsed.data.content });
    if (!changes.length) return res.json({ ok: true, unchanged: true });

    await query(
      `UPDATE cr_custom_sections SET title = coalesce($1, title), content = coalesce($2, content), updated_by_id = $3, updated_at = now() WHERE id = $4`,
      [parsed.data.title ?? null, parsed.data.content ?? null, req.user!.userId, section.id]
    );
    await query(`UPDATE custom_request_submissions SET updated_at = now() WHERE id = $1`, [sub.id]);
    await recordCrRevision({
      submissionId: sub.id, kind: "SECTION_SAVED", actorId: req.user!.userId, actorRole: await crActorRole(sub, req.user!, fields),
      summary: `Edited the section "${parsed.data.title ?? section.title}"`, sectionKey: section.id, sectionTitle: parsed.data.title ?? section.title, changes
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

changeCollabRouter.delete("/:id/sections/:sid", async (req: AuthedRequest, res, next) => {
  try {
    const { sub, fields } = await loadChangeRequest(req.params.id);
    if (!EDITABLE_STATUSES.includes(sub.status)) throw badRequest("Sections can no longer be removed");
    if (!(await crPermissions(sub, req.user!)).manage) throw forbidden("Only the creator or a co-owner can remove sections");
    const section = (await query<any>(`DELETE FROM cr_custom_sections WHERE id = $1 AND submission_id = $2 RETURNING *`, [req.params.sid, sub.id]))[0];
    if (!section) throw notFound("Section not found");
    // Its last text stays in the history, so removing a section loses nothing.
    await recordCrRevision({
      submissionId: sub.id, kind: "SECTION_REMOVED", actorId: req.user!.userId, actorRole: await crActorRole(sub, req.user!, fields),
      summary: `Removed the section "${section.title}"`, sectionKey: section.id, sectionTitle: section.title,
      changes: section.content ? [{ key: "content", label: section.title, before: section.content, after: null }] : null
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Comments - on the whole Change Request or on one section. Anyone who can
// open it may comment, approvers included.
changeCollabRouter.get("/:id/comments", async (req: AuthedRequest, res, next) => {
  try {
    const { sub, fields } = await loadChangeRequest(req.params.id);
    await assertView(sub, fields, req);
    const rows = await query(
      `SELECT c.id, c.section_key, c.section_title, c.body, c.author_role, c.created_at, c.author_id, u.full_name AS author_name
         FROM cr_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.submission_id = $1 ORDER BY c.created_at`,
      [sub.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

changeCollabRouter.post("/:id/comments", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ body: z.string().trim().min(1).max(5000), section_key: z.string().trim().max(64).nullish() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Write a comment (up to 5,000 characters)");
    const { sub, fields } = await loadChangeRequest(req.params.id);
    await assertView(sub, fields, req);

    let sectionTitle: string | null = null;
    const key = parsed.data.section_key || null;
    if (key) {
      const form = [...CR_FORM_SECTIONS, CR_OTHER_SECTION].find((s) => s.key === key);
      if (form) sectionTitle = form.title;
      else if (z.string().uuid().safeParse(key).success) {
        sectionTitle = (await query<{ title: string }>(`SELECT title FROM cr_custom_sections WHERE id = $1 AND submission_id = $2`, [key, sub.id]))[0]?.title ?? null;
      }
      if (!sectionTitle) throw badRequest("That section doesn't exist on this Change Request");
    }
    const role = await crActorRole(sub, req.user!, fields);
    const row = (await query<{ id: string }>(
      `INSERT INTO cr_comments (submission_id, section_key, section_title, author_id, author_role, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [sub.id, key, sectionTitle, req.user!.userId, role, parsed.data.body]
    ))[0];
    await recordCrRevision({
      submissionId: sub.id, kind: "COMMENTED", actorId: req.user!.userId, actorRole: role,
      summary: `Commented on ${sectionTitle ? `"${sectionTitle}"` : "the Change Request"}: ${parsed.data.body.slice(0, 140)}${parsed.data.body.length > 140 ? "…" : ""}`,
      sectionKey: key, sectionTitle
    });
    return res.status(201).json({ id: row.id });
  } catch (err) {
    return next(err);
  }
});

// GET /custom-requests/:id/history - the full audit trail, newest first.
changeCollabRouter.get("/:id/history", async (req: AuthedRequest, res, next) => {
  try {
    const { sub, fields } = await loadChangeRequest(req.params.id);
    await assertView(sub, fields, req);
    const rows = await query(
      `SELECT r.id, r.kind, r.summary, r.section_key, r.section_title, r.changes, r.status, r.actor_role, r.created_at, r.actor_id, u.full_name AS actor_name
         FROM cr_revisions r LEFT JOIN users u ON u.id = r.actor_id
        WHERE r.submission_id = $1 ORDER BY r.created_at DESC`,
      [sub.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

type FieldDef = { field_key: string; field_type: string; options: any };

// A stored value as the workspace shows it: names for people, labels for choices.
function displayValue(f: FieldDef | undefined, v: any, names: Map<string, string>): string {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return "—";
  if (!f) return typeof v === "string" ? v : JSON.stringify(v);
  if (f.field_type === "checkbox") return v ? "Yes" : "No";
  if (f.field_type === "user") return names.get(String(v)) || String(v);
  if (f.field_type === "select") return (Array.isArray(f.options) ? f.options : []).find((o: any) => o.value === v)?.label || String(v);
  if (f.field_type === "user_multi" && Array.isArray(v)) {
    return v.map((a: any) => (a.teamName ? `${a.teamName} (Section)` : a.departmentName ? `${a.departmentName} (Department)` : a.divisionName ? `${a.divisionName} (Division)`
      : a.name || a.email || (a.id && names.get(a.id)) || "—") + (a.confirmed ? " (confirmed)" : "")).join(", ");
  }
  if (f.field_type === "date") return String(v).slice(0, 10);
  return typeof v === "string" ? v : JSON.stringify(v);
}

const ACCESS_PRESET: Record<string, string> = { "": "View & comment", EDIT: "Can edit", "EDIT,INVITE": "Can edit & invite", "DISTRIBUTE,EDIT,INVITE,SUBMIT": "Full access" };
function describeAccess(p?: string[] | null) {
  const perms = normalizePerms(p);
  const preset = ACCESS_PRESET[[...perms].sort().join(",")];
  if (preset) return preset;
  const list = describePerms(perms);
  return list.charAt(0).toUpperCase() + list.slice(1);
}

// GET /custom-requests/:id/comments-history.pdf - every comment and the full
// history as one PDF to keep, oldest first. Anyone who can open the request
// can download it, as they can read both tabs.
changeCollabRouter.get("/:id/comments-history.pdf", async (req: AuthedRequest, res, next) => {
  try {
    const { sub, fields } = await loadChangeRequest(req.params.id);
    await assertView(sub, fields, req);

    const comments = await query<any>(
      `SELECT c.section_title, c.body, c.author_role, c.created_at, coalesce(u.full_name, u.email) AS author_name
         FROM cr_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.submission_id = $1 ORDER BY c.created_at`,
      [sub.id]
    );
    const revisions = await query<any>(
      `SELECT r.kind, r.summary, r.section_title, r.changes, r.actor_role, r.created_at, coalesce(u.full_name, u.email) AS actor_name
         FROM cr_revisions r LEFT JOIN users u ON u.id = r.actor_id
        WHERE r.submission_id = $1 ORDER BY r.created_at`,
      [sub.id]
    );
    // Every field the form has had (active last, so it wins), so values of a
    // since-removed field still read properly.
    const allFields = await query<FieldDef>(
      `SELECT field_key, field_type, options FROM request_type_fields WHERE request_type_id = $1 ORDER BY is_active`, [sub.request_type_id]
    );
    const fieldByKey = new Map(allFields.map((f) => [f.field_key, f]));

    // Names for the creator, co-owners and anyone picked in a people field.
    const ids = new Set<string>([sub.requester_id, ...crOwnerIds(sub)]);
    for (const r of revisions) {
      for (const c of r.changes || []) {
        const f = fieldByKey.get(c.key);
        for (const v of [c.before, c.after]) {
          if (f?.field_type === "user" && v) ids.add(String(v));
          if (f?.field_type === "user_multi" && Array.isArray(v)) for (const a of v) if (a?.id) ids.add(String(a.id));
        }
      }
    }
    const names = new Map((await query<{ id: string; name: string }>(
      `SELECT id, coalesce(full_name, email) AS name FROM users WHERE id = ANY($1::uuid[])`,
      [[...ids].filter((id) => z.string().uuid().safeParse(id).success)]
    )).map((u) => [u.id, u.name]));

    const letterhead = (await query<PdfLetterhead>(
      `SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`
    ))[0] || { logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null };

    const reference = changeRequestReference(sub.id);
    const doc = renderChangeRequestRecordPdf(letterhead, {
      reference,
      title: titleOf(sub),
      status: sub.status,
      creator: names.get(sub.requester_id) ?? null,
      created_at: sub.created_at,
      owners: crOwnerIds(sub).map((id) => names.get(id)).filter((n): n is string => !!n).sort(),
      co_writers: (await listCoWriters(sub.id)).map((c) => ({ label: c.label, access: describeAccess(c.permissions) })),
      downloaded_by: req.user!.fullName ?? null,
      comments: comments.map((c) => ({ author: c.author_name || "Someone", role: c.author_role, section: c.section_title, body: c.body, created_at: c.created_at })),
      history: revisions.map((r) => ({
        actor: r.actor_name || "System", role: r.actor_role, kind: r.kind, section: r.section_title, summary: r.summary, created_at: r.created_at,
        changes: (r.changes || []).map((c: any) => {
          const f = fieldByKey.get(c.key);
          return { label: c.label || c.key, before: displayValue(f, c.before, names), after: displayValue(f, c.after, names) };
        })
      }))
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${reference}-comments-and-history.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

// DELETE /custom-requests/:id/draft - discard a draft (creator or owner).
changeCollabRouter.delete("/:id/draft", async (req: AuthedRequest, res, next) => {
  try {
    const { sub } = await loadChangeRequest(req.params.id);
    if (sub.status !== "DRAFT") throw badRequest("Only a draft can be discarded");
    if (!(await crPermissions(sub, req.user!)).manage) throw forbidden("Only the creator or a co-owner can discard this draft");
    await query(`DELETE FROM custom_request_submissions WHERE id = $1 AND status = 'DRAFT'`, [sub.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
