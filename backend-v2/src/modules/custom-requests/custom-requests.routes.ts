import { Router } from "express";
import { hasDistributionAccess } from "../distributions/distributions.routes.js";
import { z } from "zod";
import fs from "fs";
import multer from "multer";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { notifyChangeRequestPeopleAdded, notifyCustomRequestStep, notifyCustomRequestProgress, notifyCustomRequestDecision, notifyCustomRequestCancelled, notifyChangeRequestFollowUp, notifyCustomRequestUnregisteredAssignee, notifyCustomRequestAssigneeAssigned, notifyCustomRequestTeamAssigned, notifyCustomRequestSectionAssigned, notifySlaReminder } from "../../lib/notifications.js";
import { logger, serializeError } from "../../lib/logger.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";
import { resolveDirectManagerId } from "../reporting-lines/reporting-lines.routes.js";
import { getDelegatedManagerIds } from "../../lib/delegations.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { resolveCustomRequestPdfData, getFieldCatalogFor } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";
import { acknowledgeCollection, createProvisioningTaskForSubmission, getProvisioningStatusForSubmission } from "../it-provisioning/it-provisioning.service.js";
import { baselineBrsDocument, recordBrsRevision, returnBrsDocumentToDraft } from "../brs/brs.service.js";
import { isPeriodLocked } from "../attendance/attendance.routes.js";
import { assertCanSubmit, assigneeLabel, assigneeMatches, crActorRole, crPermissions, describeFieldSave, diffFields, isChangeCollaborator, isSubmissionAssignee, recordCrRevision } from "./change-collab.service.js";

export const customRequestsRouter = Router();
customRequestsRouter.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeUploadFilename(file.originalname)}`)
});
const uploadAttachments = multer({
  storage: attachmentStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["pdf", "doc", "docx", "jpg", "jpeg", "png", "gif", "webp"])
});

// `roles` lets one step accept several roles (e.g. "IS HOD/CIO" = HOD or EXCO);
// `role` is the original single-role form, still honoured.
// `default_approver_id` pre-fills a ROLE_PICKER step (set by IT in IT
// Provisioning for the Computer Request) - the requester's own pick wins.
type FixedApprovalStep = { title: string; source: "AUTO_MANAGER" | "ROLE_PICKER"; role?: string; roles?: string[]; default_approver_id?: string | null };

function fixedStepRoles(step: FixedApprovalStep): string[] {
  return (step.roles?.length ? step.roles : step.role ? [step.role] : []).map((r) => r.toUpperCase());
}
// An assignee entry is either a person (id and/or email set) or a whole
// team (teamId set, id/email null) — confirmed by any one member of that team.
type AssigneeEntry = {
  id: string | null;
  name: string | null;
  email: string | null;
  teamId: string | null;
  teamName: string | null;
  // A whole Department (sections table) or Division (users.department, by name).
  departmentId?: string | null;
  departmentName?: string | null;
  divisionName?: string | null;
  confirmed: boolean;
  confirmed_at: string | null;
  confirmedBy: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// approver_id/position_name are nullish here because fixed-chain submissions
// don't send them for the AUTO_MANAGER step — the server resolves it instead.
// decision_type distinguishes a step that must formally approve (gates progress
// the same way it always has) from one that's only "noting" the change for the
// record (e.g. GM Internal Audit & Risk on the ECONET Change Control form) —
// currently only surfaced in the UI for Change Request.
const ChainStepSchema = z.object({
  approver_id: z.string().uuid().nullish(),
  position_name: z.string().trim().nullish(),
  decision_type: z.enum(["APPROVE", "NOTE"]).default("APPROVE")
});

// Change Request audit trail (change-collab.service.ts) for events that go
// through this generic router. Never fails the action it records.
async function auditChangeRequest(
  submissionId: string,
  actor: { userId: string; role: string; teamId?: string | null },
  kind: Parameters<typeof recordCrRevision>[0]["kind"],
  summary: string,
  extra: { changes?: ReturnType<typeof diffFields>; sectionKey?: string | null; sectionTitle?: string | null } = {}
) {
  try {
    const sub = (await query<any>(
      `SELECT s.*, rt.code FROM custom_request_submissions s JOIN custom_request_types rt ON rt.id = s.request_type_id WHERE s.id = $1`,
      [submissionId]
    ))[0];
    if (!sub || sub.code !== "CHANGE_REQUEST") return;
    const fields = await query<{ field_key: string; field_type: string }>(
      `SELECT field_key, field_type FROM request_type_fields WHERE request_type_id = $1 AND is_active = true`, [sub.request_type_id]
    );
    await recordCrRevision({ submissionId, kind, actorId: actor.userId, actorRole: await crActorRole(sub, actor, fields), summary, ...extra });
  } catch (e) {
    logger.warn("cr_revision_failed", { submission_id: submissionId, error: serializeError(e) });
  }
}

const CreateSchema = z.object({
  request_type_id: z.string().uuid(),
  data: z.record(z.string(), z.any()).default({}),
  approval_chain: z.array(ChainStepSchema).min(1, "At least one approver is required")
});

const ActionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().trim().nullish()
});

const CloseSchema = z.object({
  implementation_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "implementation_date must be YYYY-MM-DD"),
  closure_notes: z.string().trim().nullish()
});

const CancelSchema = z.object({
  comment: z.string().trim().min(1, "A comment is required to cancel a request")
});

// POST /custom-requests — submit a new request with a requester-defined approval chain.
// Sent as multipart/form-data so the wizard's attachment step can ride along with the
// rest of the form in one request — "data" and "approval_chain" arrive as JSON strings.
customRequestsRouter.post("/", uploadAttachments.array("files", 10), async (req: AuthedRequest, res, next) => {
  try {
    let bodyData: unknown;
    let bodyChain: unknown;
    let bodyOwners: unknown;
    try {
      // Change Request only: co-owners named on the form (full rights, like the requester).
      bodyOwners = typeof req.body.owner_user_ids === "string" ? JSON.parse(req.body.owner_user_ids) : (req.body.owner_user_ids ?? []);
      bodyData = typeof req.body.data === "string" ? JSON.parse(req.body.data) : (req.body.data ?? {});
      bodyChain = typeof req.body.approval_chain === "string" ? JSON.parse(req.body.approval_chain) : (req.body.approval_chain ?? []);
    } catch {
      throw badRequest("Invalid submission payload — data/approval_chain must be valid JSON");
    }

    const parsed = CreateSchema.safeParse({ request_type_id: req.body.request_type_id, data: bodyData, approval_chain: bodyChain });
    if (!parsed.success) throw badRequest("Invalid submission payload", parsed.error.flatten());

    const requestType = (await query<{ id: string; code: string; name: string; status: string; fixed_approval_chain: FixedApprovalStep[] | null; is_internal: boolean }>(
      `SELECT id, code, name, status, fixed_approval_chain, is_internal FROM custom_request_types WHERE id = $1 AND is_active = true`,
      [parsed.data.request_type_id]
    ))[0];
    if (!requestType) throw notFound("Request type not found");
    if (requestType.status !== "ACTIVE") throw badRequest("This request type is not currently active");
    // Internal types (e.g. BRS_APPROVAL) only ever get a submission created
    // programmatically by their owning module - never through this generic
    // submit endpoint, even by an admin poking the API directly.
    if (requestType.is_internal) throw badRequest("This request type cannot be submitted directly");

    await assertCanSubmit(req.user!.userId, req.user!.role, req.user!.department ?? null, req.user!.employmentType ?? null, requestType.id);

    // Change Request only: submitting a draft that owners and co-writers
    // worked on (change-collab.routes.ts) promotes that row in place, so its
    // people, sections, comments and history carry on.
    const draftId = typeof req.body.draft_id === "string" && req.body.draft_id ? req.body.draft_id : null;
    let crDraft: { id: string; requester_id: string; owner_user_ids: string[] | null } | undefined;
    if (draftId) {
      if (requestType.code !== "CHANGE_REQUEST") throw badRequest("Only a Change Request can be submitted from a draft");
      const row = (await query<any>(`SELECT * FROM custom_request_submissions WHERE id = $1 AND request_type_id = $2`, [draftId, requestType.id]))[0];
      if (!row) throw notFound("Draft not found");
      if (row.status !== "DRAFT") throw badRequest("This draft has already been submitted");
      if (!(await crPermissions(row, req.user!)).submit) throw forbidden("You don't have permission to submit this Change Request for approval");
      crDraft = { id: row.id, requester_id: row.requester_id, owner_user_ids: row.owner_user_ids };
    }

    // Attendance Register only: an admin can close a month once payroll
    // processing starts (attendance.routes.ts) - blocks a fresh submission
    // the same way it already blocks new/edited drafts for that month.
    let attendancePeriod: string | null = null;
    if (requestType.code === "ATTENDANCE_REGISTER") {
      attendancePeriod = String((parsed.data.data as Record<string, unknown>)?.month || "").slice(0, 7);
      if (attendancePeriod && (await isPeriodLocked(requestType.id, attendancePeriod))) {
        throw badRequest("This attendance period has been closed for submissions - contact HR/Admin.");
      }
    }

    const fields = await query<{ field_key: string; field_label: string; is_required: boolean; field_type: string }>(
      `SELECT field_key, field_label, is_required, field_type FROM request_type_fields WHERE request_type_id = $1 AND is_active = true`,
      [requestType.id]
    );
    for (const f of fields) {
      if (f.is_required) {
        const val = parsed.data.data[f.field_key];
        const isEmpty = f.field_type === "user_multi" ? !Array.isArray(val) || val.length === 0 : (val === undefined || val === null || val === "");
        if (isEmpty) {
          throw badRequest(`"${f.field_label}" is required`);
        }
      }
    }

    // Resolve "user_multi" fields (e.g. Change Assignee) into full assignee
    // records: matched system users get their id/name/email snapshotted;
    // a team entry gets its current member list snapshotted as emails (so
    // notifications still work later even if membership changes); anyone
    // else must be a valid plain email (invited, no account yet). Each entry
    // starts unconfirmed — sign-off happens individually once the
    // implementation plan is ready (see the approval gate below).
    const teamNotifications: { fieldLabel: string; teamName: string; memberEmails: string[] }[] = [];
    for (const f of fields) {
      if (f.field_type !== "user_multi") continue;
      // The form sends groups as teamId / departmentId / divisionName (the
      // same shape it displays); the API also takes team_id / department_id
      // / division_name. Normalise to the snake_case form here.
      const rawIn = parsed.data.data[f.field_key];
      if (!Array.isArray(rawIn)) continue;
      const raw = rawIn.map((a: any) => ({
        ...a,
        team_id: a?.team_id ?? a?.teamId ?? null,
        department_id: a?.department_id ?? a?.departmentId ?? null,
        division_name: a?.division_name ?? a?.divisionName ?? null
      }));

      const ids = raw.filter((a: any) => a?.id).map((a: any) => a.id);
      const teamIds = raw.filter((a: any) => a?.team_id).map((a: any) => a.team_id);
      const usersFound = ids.length
        ? await query<{ id: string; full_name: string | null; email: string }>(
            `SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`,
            [ids]
          )
        : [];
      const userMap = new Map(usersFound.map((u) => [u.id, u]));
      const teamsFound = teamIds.length
        ? await query<{ id: string; name: string }>(`SELECT id, name FROM teams WHERE id = ANY($1::uuid[]) AND active = true`, [teamIds])
        : [];
      const teamMap = new Map(teamsFound.map((t) => [t.id, t]));

      const resolved: AssigneeEntry[] = [];
      for (const a of raw) {
        if (a?.team_id && teamMap.has(a.team_id)) {
          const t = teamMap.get(a.team_id)!;
          resolved.push({ id: null, name: null, email: null, teamId: t.id, teamName: t.name, confirmed: false, confirmed_at: null, confirmedBy: null });
          const members = await query<{ email: string }>(`SELECT email FROM users WHERE team_id = $1 AND is_active = true`, [t.id]);
          if (members.length) teamNotifications.push({ fieldLabel: f.field_label, teamName: t.name, memberEmails: members.map((m) => m.email) });
          continue;
        }
        if (a?.department_id) {
          const d = (await query<{ id: string; name: string }>(`SELECT id, name FROM sections WHERE id = $1 AND active = true`, [a.department_id]))[0];
          if (!d) throw badRequest(`"${f.field_label}" names a department that no longer exists`);
          resolved.push({ id: null, name: null, email: null, teamId: null, teamName: null, departmentId: d.id, departmentName: d.name, confirmed: false, confirmed_at: null, confirmedBy: null });
          const members = await query<{ email: string }>(`SELECT email FROM users WHERE section_id = $1 AND is_active = true`, [d.id]);
          if (members.length) teamNotifications.push({ fieldLabel: f.field_label, teamName: `${d.name} (Department)`, memberEmails: members.map((m) => m.email) });
          continue;
        }
        if (a?.division_name) {
          const d = (await query<{ name: string }>(`SELECT name FROM departments WHERE lower(trim(name)) = lower(trim($1)) AND active = true`, [a.division_name]))[0];
          if (!d) throw badRequest(`"${f.field_label}" names a division that no longer exists`);
          resolved.push({ id: null, name: null, email: null, teamId: null, teamName: null, divisionName: d.name, confirmed: false, confirmed_at: null, confirmedBy: null });
          const members = await query<{ email: string }>(`SELECT email FROM users WHERE lower(trim(department)) = lower(trim($1)) AND is_active = true`, [d.name]);
          if (members.length) teamNotifications.push({ fieldLabel: f.field_label, teamName: `${d.name} (Division)`, memberEmails: members.map((m) => m.email) });
          continue;
        }
        if (a?.id && userMap.has(a.id)) {
          const u = userMap.get(a.id)!;
          resolved.push({ id: u.id, name: u.full_name, email: u.email, teamId: null, teamName: null, confirmed: false, confirmed_at: null, confirmedBy: null });
          continue;
        }
        const email = String(a?.email || "").trim();
        if (!EMAIL_RE.test(email)) throw badRequest(`"${f.field_label}" has an invalid entry — pick a system user, a section, or enter a valid email`);
        resolved.push({ id: null, name: a?.name ? String(a.name).trim() : null, email, teamId: null, teamName: null, confirmed: false, confirmed_at: null, confirmedBy: null });
      }
      parsed.data.data[f.field_key] = resolved;
    }

    const fixedChain = requestType.fixed_approval_chain;
    let chainInput: { approver_id: string; position_name: string; decision_type: "APPROVE" | "NOTE" }[];

    if (fixedChain?.length) {
      if (parsed.data.approval_chain.length !== fixedChain.length) {
        throw badRequest(`This request type requires exactly ${fixedChain.length} approval steps`);
      }
      chainInput = [];
      for (let i = 0; i < fixedChain.length; i++) {
        const stepDef = fixedChain[i];
        const submitted = parsed.data.approval_chain[i];
        if (stepDef.source === "AUTO_MANAGER") {
          // The form lets the requester pick their manager by hand when the
          // org structure can't resolve one - honour that pick as a fallback.
          const managerId = (await resolveDirectManagerId(req.user!.userId)) ?? submitted?.approver_id ?? null;
          if (!managerId) throw badRequest("No manager is set up for you in the org structure — ask HR/Admin to set your reporting line before submitting");
          chainInput.push({ approver_id: managerId, position_name: stepDef.title, decision_type: "APPROVE" });
        } else {
          const approverId = submitted?.approver_id || stepDef.default_approver_id || null;
          if (!approverId) throw badRequest(`Please select an approver for "${stepDef.title}"`);
          chainInput.push({ approver_id: approverId, position_name: stepDef.title, decision_type: "APPROVE" });
        }
      }
    } else {
      chainInput = parsed.data.approval_chain.map((s) => {
        if (!s.approver_id || !s.position_name?.trim()) throw badRequest("Each approval step requires an approver and a title");
        return { approver_id: s.approver_id, position_name: s.position_name.trim(), decision_type: s.decision_type };
      });
    }

    // A requester can never name themself as their own approver — applies
    // even to a fixed-chain non-AUTO_MANAGER step, since that step's
    // approver is still requester-chosen.
    if (chainInput.some((s) => s.approver_id === req.user!.userId)) {
      throw badRequest("You cannot select yourself as an approver on your own request");
    }
    if (crDraft && chainInput.some((s) => s.approver_id === crDraft!.requester_id)) {
      throw badRequest("The person who started this Change Request cannot also approve it");
    }

    // Co-owners: from the form on a direct submission, or the draft's own.
    let coOwnerIds: string[] = crDraft ? (crDraft.owner_user_ids ?? []) : [];
    if (!crDraft && requestType.code === "CHANGE_REQUEST") {
      const parsedOwners = z.array(z.string().uuid()).max(20).safeParse(bodyOwners);
      if (!parsedOwners.success) throw badRequest("Invalid co-owners");
      coOwnerIds = [...new Set(parsedOwners.data)].filter((id) => id !== req.user!.userId);
      if (coOwnerIds.length) {
        const found = await query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`, [coOwnerIds]);
        if (found.length !== coOwnerIds.length) throw badRequest("One or more co-owners are not active FlowDesk users");
      }
    }
    if (chainInput.some((s) => coOwnerIds.includes(s.approver_id))) {
      throw badRequest("A co-owner can't also be an approver on the same Change Request");
    }

    const approverIds = chainInput.map((s) => s.approver_id);
    const approvers = await query<{ id: string; full_name: string | null; email: string; role: string }>(
      `SELECT id, full_name, email, role FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`,
      [approverIds]
    );
    const approverMap = new Map(approvers.map((a) => [a.id, a]));
    for (const id of approverIds) {
      if (!approverMap.has(id)) throw badRequest("One or more selected approvers are invalid");
    }

    if (fixedChain?.length) {
      for (let i = 0; i < fixedChain.length; i++) {
        const stepDef = fixedChain[i];
        const roles = fixedStepRoles(stepDef);
        if (stepDef.source === "ROLE_PICKER" && roles.length) {
          const approver = approverMap.get(chainInput[i].approver_id)!;
          if (!roles.includes(String(approver.role).toUpperCase())) {
            throw badRequest(`The approver for "${stepDef.title}" must have the role ${roles.join(" or ")}`);
          }
        }
      }
    }

    // The same person on back-to-back steps (e.g. the requester's manager is
    // also the default IT Manager on a Computer Request) acts once, on one
    // step carrying both roles ("Requester's Manager & IT Manager") so the
    // record and PDF still show both were covered. An APPROVE outranks a NOTE.
    const mergedInput: typeof chainInput = [];
    for (const step of chainInput) {
      const prev = mergedInput[mergedInput.length - 1];
      if (prev && prev.approver_id === step.approver_id) {
        prev.position_name = `${prev.position_name} & ${step.position_name}`;
        if (step.decision_type === "APPROVE") prev.decision_type = "APPROVE";
        continue;
      }
      mergedInput.push({ ...step });
    }

    const chain = mergedInput.map((step, idx) => {
      const approver = approverMap.get(step.approver_id)!;
      return {
        step_order: idx,
        approver_id: approver.id,
        approver_name: approver.full_name,
        approver_email: approver.email,
        position_name: step.position_name,
        decision_type: step.decision_type,
        status: "PENDING",
        comment: null as string | null,
        acted_at: null as string | null
      };
    });

    // Attendance Register only: promote an already-autosaved DRAFT row for
    // this requester/month in place, rather than inserting a second row and
    // orphaning the draft - day-by-day progress becomes the real submission.
    const draft = crDraft ?? (attendancePeriod
      ? (await query<{ id: string }>(
          `SELECT id FROM custom_request_submissions
            WHERE requester_id = $1 AND request_type_id = $2 AND status = 'DRAFT' AND data->>'month' LIKE $3
            LIMIT 1`,
          [req.user!.userId, requestType.id, `${attendancePeriod}%`]
        ))[0]
      : undefined);

    const submission = draft
      ? (await query<{ id: string }>(
          `UPDATE custom_request_submissions
              SET data = $1, approval_chain = $2, current_step_order = 0, status = 'IN_PROGRESS', updated_at = now()
            WHERE id = $3
            RETURNING id`,
          [JSON.stringify(parsed.data.data), JSON.stringify(chain), draft.id]
        ))[0]
      : (await query<{ id: string }>(
          `INSERT INTO custom_request_submissions (request_type_id, requester_id, data, approval_chain, current_step_order, status, owner_user_ids)
           VALUES ($1, $2, $3, $4, 0, 'IN_PROGRESS', $5)
           RETURNING id`,
          [requestType.id, req.user!.userId, JSON.stringify(parsed.data.data), JSON.stringify(chain), coOwnerIds]
        ))[0];

    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    for (const file of uploadedFiles) {
      await query(
        `INSERT INTO custom_request_attachments (submission_id, file_path, original_name, content_type, size_bytes, uploaded_by_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [submission.id, file.path, file.originalname, file.mimetype, file.size, req.user!.userId]
      );
    }

    if (requestType.code === "CHANGE_REQUEST") {
      const route = chain.map((c) => `${c.position_name} (${c.approver_name || c.approver_email})`).join(" → ");
      await recordCrRevision({
        submissionId: submission.id, kind: crDraft ? "SUBMITTED" : "CREATED", actorId: req.user!.userId,
        actorRole: crDraft ? await crActorRole(crDraft, req.user!) : "CREATOR",
        summary: `Submitted for approval: ${route}${uploadedFiles.length ? `; ${uploadedFiles.length} attachment(s)` : ""}`
      }).catch((e) => logger.warn("cr_revision_failed", { submission_id: submission.id, error: serializeError(e) }));
    }
    const newCoOwners = !crDraft && coOwnerIds.length
      ? await query<{ id: string; full_name: string | null; email: string }>(`SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[])`, [coOwnerIds])
      : [];
    if (newCoOwners.length) {
      await auditChangeRequest(submission.id, req.user!, "PEOPLE_CHANGED", `Co-owners: ${newCoOwners.map((o) => o.full_name || o.email).join(", ")}`);
    }

    // Respond as soon as the submission itself is durably saved — every
    // notification below is an email/Teams send that can each take seconds,
    // and the requester doesn't need to wait on any of them to know their
    // request went through. Fire them in the background instead; each one
    // already catches and logs its own failures (see notifications.ts), so
    // nothing here needs to be awaited or can crash the process.
    res.status(201).json({ id: submission.id });

    void (async () => {
      try {
        if (newCoOwners.length) {
          await notifyChangeRequestPeopleAdded({
            submissionId: submission.id, title: String(parsed.data.data.description_of_change || "Change Request").slice(0, 120),
            addedBy: req.user!.fullName ?? null, owners: newCoOwners, coWriterEmails: []
          });
        }
        await notifyCustomRequestStep({
          submissionId: submission.id,
          requestTypeName: requestType.name,
          requesterName: req.user!.fullName ?? null,
          approverEmail: chain[0].approver_email,
          approverName: chain[0].approver_name,
          approverId: chain[0].approver_id,
          stepLabel: chain[0].position_name,
          stepOrder: 0
        });
        const requester = (await query<{ email: string; full_name: string | null }>(`SELECT email, full_name FROM users WHERE id = $1`, [req.user!.userId]))[0];
        await notifyCustomRequestProgress({
          submissionId: submission.id,
          requestTypeName: requestType.name,
          requesterEmail: requester?.email ?? null,
          requesterName: requester?.full_name ?? null,
          event: "SUBMITTED",
          nextApproverName: chain[0].approver_name,
          nextStepLabel: chain[0].position_name
        });

        // "user"/"user_multi" fields (e.g. Change Assignee) can be filled in with
        // a plain email instead of a picked system user when the assignee doesn't
        // have an account yet — let them know they were named on this request.
        for (const f of fields) {
          if (f.field_type === "user") {
            const val = String(parsed.data.data[f.field_key] ?? "").trim();
            if (val && EMAIL_RE.test(val)) {
              await notifyCustomRequestUnregisteredAssignee({
                submissionId: submission.id,
                requestTypeName: requestType.name,
                requesterName: req.user!.fullName ?? null,
                fieldLabel: f.field_label,
                assigneeEmail: val
              });
            }
          } else if (f.field_type === "user_multi") {
            const arr = parsed.data.data[f.field_key] as AssigneeEntry[] | undefined;
            for (const a of arr ?? []) {
              if (a.id && a.email) {
                await notifyCustomRequestAssigneeAssigned({
                  submissionId: submission.id,
                  requestTypeName: requestType.name,
                  requesterName: req.user!.fullName ?? null,
                  fieldLabel: f.field_label,
                  assigneeEmail: a.email,
                  assigneeName: a.name
                });
              } else if (!a.id && !a.teamId && !a.departmentId && !a.divisionName && a.email) {
                await notifyCustomRequestUnregisteredAssignee({
                  submissionId: submission.id,
                  requestTypeName: requestType.name,
                  requesterName: req.user!.fullName ?? null,
                  fieldLabel: f.field_label,
                  assigneeEmail: a.email
                });
              }
            }
          }
        }
        for (const t of teamNotifications) {
          await notifyCustomRequestTeamAssigned({
            submissionId: submission.id,
            requestTypeName: requestType.name,
            requesterName: req.user!.fullName ?? null,
            fieldLabel: t.fieldLabel,
            teamName: t.teamName,
            memberEmails: t.memberEmails
          });
        }

        // "section" fields (e.g. Change Implementor) store the section's name —
        // notify everyone currently in that section, since they're the ones
        // expected to carry out the implementation.
        for (const f of fields) {
          if (f.field_type !== "section") continue;
          const sectionName = String(parsed.data.data[f.field_key] ?? "").trim();
          if (!sectionName) continue;
          const section = (await query<{ id: string; name: string }>(
            `SELECT id, name FROM sections WHERE lower(trim(name)) = lower(trim($1)) AND active = true`,
            [sectionName]
          ))[0];
          if (!section) continue;
          const members = await query<{ email: string }>(`SELECT email FROM users WHERE section_id = $1 AND is_active = true`, [section.id]);
          if (!members.length) continue;
          await notifyCustomRequestSectionAssigned({
            submissionId: submission.id,
            requestTypeName: requestType.name,
            requesterName: req.user!.fullName ?? null,
            fieldLabel: f.field_label,
            sectionName: section.name,
            memberEmails: members.map((m) => m.email)
          });
        }
      } catch (bgErr) {
        logger.warn("custom_request_post_submit_notifications_failed", { submission_id: submission.id, error: serializeError(bgErr) });
      }
    })();
  } catch (err) {
    return next(err);
  }
});

// GET /custom-requests/mine — submissions created by the current user
customRequestsRouter.get("/mine", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT s.*, rt.name AS request_type_name, rt.code AS request_type_code,
              COALESCE(
                (SELECT json_agg(json_build_object('id', a.id, 'original_name', a.original_name) ORDER BY a.uploaded_at)
                   FROM custom_request_attachments a WHERE a.submission_id = s.id),
                '[]'
              ) AS attachments,
              (SELECT json_build_object('status', t.status, 'assigned_to_name', ito.full_name, 'asset_number', d.asset_number,
                                        'ready_for_collection_at', t.ready_for_collection_at, 'collection_acknowledged_at', t.collection_acknowledged_at)
                 FROM it_provisioning_tasks t
                 LEFT JOIN users ito ON ito.id = t.assigned_to_id
                 LEFT JOIN it_devices d ON d.id = t.device_id
                WHERE t.submission_id = s.id) AS it_provisioning
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
        WHERE s.requester_id = $1
        ORDER BY s.created_at DESC`,
      [req.user!.userId]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// GET /custom-requests/shared-with-me — approved Change Requests distributed
// to the current user (read-only). Registered before "/:id".
customRequestsRouter.get("/shared-with-me", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT s.*, rt.name AS request_type_name, rt.code AS request_type_code, u.full_name AS requester_name,
              '[]'::json AS attachments,
              x.distributed_at, x.distributed_by_name, x.message AS distribution_message
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
         JOIN users u ON u.id = s.requester_id
         JOIN LATERAL (
           SELECT dd.created_at AS distributed_at, ub.full_name AS distributed_by_name, dd.message
             FROM document_distributions dd LEFT JOIN users ub ON ub.id = dd.distributed_by_id
            WHERE dd.doc_type = 'CHANGE_REQUEST' AND dd.doc_id = s.id AND $1::uuid = ANY(dd.recipient_ids)
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

// GET /custom-requests/assigned-to-me — submissions where the current user
// appears (by id) in any "user_multi" field's assignee array. Scans
// in-progress/approved submissions across types that define such a field —
// there's no per-type index for this, but volumes here are small. Registered
// before "/:id" so Express doesn't treat "assigned-to-me" as an id param.
customRequestsRouter.get("/assigned-to-me", async (req: AuthedRequest, res, next) => {
  try {
    const multiFieldTypes = await query<{ request_type_id: string; field_key: string }>(
      `SELECT DISTINCT request_type_id, field_key FROM request_type_fields WHERE field_type = 'user_multi' AND is_active = true`
    );
    if (!multiFieldTypes.length) return res.json([]);

    const submissions = await query<any>(
      `SELECT s.*, rt.name AS request_type_name, rt.code AS request_type_code, u.full_name AS requester_name
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
         JOIN users u ON u.id = s.requester_id
        WHERE s.request_type_id = ANY($1::uuid[])
        ORDER BY s.created_at DESC`,
      [multiFieldTypes.map((f) => f.request_type_id)]
    );

    const fieldKeysByType = new Map<string, string[]>();
    for (const f of multiFieldTypes) {
      fieldKeysByType.set(f.request_type_id, [...(fieldKeysByType.get(f.request_type_id) || []), f.field_key]);
    }

    const mine = submissions.filter((s: any) => {
      const keys = fieldKeysByType.get(s.request_type_id) || [];
      return keys.some((key) => {
        const arr = s.data?.[key];
        return Array.isArray(arr) && arr.some((a: AssigneeEntry) =>
          assigneeMatches(a, req.user!)
        );
      });
    });

    return res.json(mine);
  } catch (err) {
    return next(err);
  }
});

// GET /custom-requests/:id — detail (requester, chain participant, or admin)
customRequestsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const submission = (await query<any>(
      `SELECT s.*, rt.name AS request_type_name, rt.code AS request_type_code, u.full_name AS requester_name, u.email AS requester_email
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
         JOIN users u ON u.id = s.requester_id
        WHERE s.id = $1`,
      [req.params.id]
    ))[0];
    if (!submission) throw notFound();

    const fields = await query<{ field_key: string; field_label: string; field_type: string }>(
      `SELECT * FROM request_type_fields WHERE request_type_id = $1 AND is_active = true ORDER BY sort_order, created_at`,
      [submission.request_type_id]
    );

    const chain = submission.approval_chain as Array<{ approver_id: string }>;
    const isParticipant = chain.some((s) => s.approver_id === req.user!.userId);
    const isAssignee = isSubmissionAssignee(submission.data, fields, req.user!);
    const isRecipient = submission.request_type_code === "CHANGE_REQUEST"
      && await hasDistributionAccess("CHANGE_REQUEST", submission.id, req.user!.userId);
    // Owners and co-writers of a Change Request (change-collab.routes.ts).
    const isCollaborator = submission.request_type_code === "CHANGE_REQUEST" && await isChangeCollaborator(submission, req.user!.userId);
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId && !isParticipant && !isAssignee && !isRecipient && !isCollaborator) {
      throw forbidden();
    }

    const attachments = await query(
      `SELECT id, original_name, content_type, size_bytes, uploaded_at FROM custom_request_attachments WHERE submission_id = $1 ORDER BY uploaded_at`,
      [submission.id]
    );

    const isOwner = submission.requester_id === req.user!.userId || isCollaborator;
    const can_view_pdf = await canAccessPdf({
      requestType: "CUSTOM_REQUEST", customRequestTypeId: submission.request_type_id,
      userId: req.user!.userId, role: req.user!.role, isOwner: isOwner || isRecipient, action: "view"
    });
    // Computer Request: where IT Provisioning is up to, so the requester can
    // see progress and confirm collection from their own request.
    const it_provisioning = submission.request_type_code === "COMPUTER_REQUEST"
      ? await getProvisioningStatusForSubmission(submission.id)
      : null;
    return res.json({ ...submission, fields, attachments, can_view_pdf, it_provisioning });
  } catch (err) {
    return next(err);
  }
});

// POST /custom-requests/:id/acknowledge-collection - the requester confirms
// they've collected the computer IT provisioned for them; completes the task.
customRequestsRouter.post("/:id/acknowledge-collection", async (req: AuthedRequest, res, next) => {
  try {
    const submission = (await query<{ requester_id: string }>(
      `SELECT requester_id FROM custom_request_submissions WHERE id = $1`, [req.params.id]
    ))[0];
    if (!submission) throw notFound();
    if (submission.requester_id !== req.user!.userId) throw forbidden("Only the requester can confirm collection");
    await acknowledgeCollection(req.params.id, req.user!.userId);
    return res.json({ ok: true, it_provisioning: await getProvisioningStatusForSubmission(req.params.id) });
  } catch (err) {
    return next(err);
  }
});

customRequestsRouter.get("/:id/pdf", async (req: AuthedRequest, res, next) => {
  try {
    const submission = (await query<any>(`SELECT * FROM custom_request_submissions WHERE id = $1`, [req.params.id]))[0];
    if (!submission) throw notFound();

    const fields = await query<{ field_key: string; field_label: string; field_type: string }>(
      `SELECT * FROM request_type_fields WHERE request_type_id = $1 AND is_active = true ORDER BY sort_order, created_at`,
      [submission.request_type_id]
    );
    const chain = submission.approval_chain as Array<{ approver_id: string }>;
    const isParticipant = chain.some((s) => s.approver_id === req.user!.userId);
    const isAssignee = isSubmissionAssignee(submission.data, fields, req.user!);
    const isOwner = submission.requester_id === req.user!.userId;
    // Someone it was distributed to may always view its PDF, like the owner.
    const isRecipient = await hasDistributionAccess("CHANGE_REQUEST", submission.id, req.user!.userId);
    const isCollaborator = await isChangeCollaborator(submission, req.user!.userId);
    if (req.user!.role !== "ADMIN" && !isOwner && !isParticipant && !isAssignee && !isRecipient && !isCollaborator) throw forbidden();
    if (!(await canAccessPdf({ requestType: "CUSTOM_REQUEST", customRequestTypeId: submission.request_type_id, userId: req.user!.userId, role: req.user!.role, isOwner: isOwner || isRecipient || isCollaborator, action: "view" }))) {
      throw forbidden();
    }

    let template = (await query<any>(
      `SELECT * FROM pdf_templates WHERE request_type = 'CUSTOM_REQUEST' AND custom_request_type_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [submission.request_type_id]
    ))[0];
    if (!template) {
      template = (await query<any>(
        `SELECT * FROM pdf_templates WHERE request_type = 'CUSTOM_REQUEST' AND custom_request_type_id IS NULL AND status = 'ACTIVE' LIMIT 1`
      ))[0];
    }
    if (!template) throw badRequest("No PDF template configured for this request type yet.");

    const data = await resolveCustomRequestPdfData(req.params.id);
    const catalog = await getFieldCatalogFor("CUSTOM_REQUEST", submission.request_type_id);
    const letterhead = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
    };
    const doc = renderPdfTemplate(template, letterhead, data, catalog);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="request-${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

// GET /custom-requests/:id/attachments/:attachmentId — download a single attachment.
// Same access rule as the submission detail (requester, chain participant, assignee, or admin).
customRequestsRouter.get("/:id/attachments/:attachmentId", async (req: AuthedRequest, res, next) => {
  try {
    const submission = (await query<any>(`SELECT * FROM custom_request_submissions WHERE id = $1`, [req.params.id]))[0];
    if (!submission) throw notFound();

    const fields = await query<{ field_key: string; field_label: string; field_type: string }>(
      `SELECT field_key, field_label, field_type FROM request_type_fields WHERE request_type_id = $1 AND is_active = true`,
      [submission.request_type_id]
    );
    const chain = submission.approval_chain as Array<{ approver_id: string }>;
    const isParticipant = chain.some((s) => s.approver_id === req.user!.userId);
    const isAssignee = isSubmissionAssignee(submission.data, fields, req.user!);
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId && !isParticipant && !isAssignee
        && !(await isChangeCollaborator(submission, req.user!.userId))) {
      throw forbidden();
    }

    const attachment = (await query<{ file_path: string; original_name: string }>(
      `SELECT file_path, original_name FROM custom_request_attachments WHERE id = $1 AND submission_id = $2`,
      [req.params.attachmentId, submission.id]
    ))[0];
    if (!attachment) throw notFound();

    return res.download(attachment.file_path, attachment.original_name);
  } catch (err) {
    return next(err);
  }
});

// GET /custom-requests/:id/consolidated — sibling submissions (same request
// type, division/department, and calendar month) merged for the approver's
// console. Each employee still submits and is approved individually; this is
// a read-only roll-up so an approver can see the whole team's register together.
customRequestsRouter.get("/:id/consolidated", async (req: AuthedRequest, res, next) => {
  try {
    const submission = (await query<any>(
      `SELECT s.* FROM custom_request_submissions s WHERE s.id = $1`,
      [req.params.id]
    ))[0];
    if (!submission) throw notFound();

    const chain = submission.approval_chain as Array<{ approver_id: string }>;
    const isParticipant = chain.some((s) => s.approver_id === req.user!.userId);
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId && !isParticipant) {
      throw forbidden();
    }

    const division = String(submission.data?.division || "").trim();
    const department = String(submission.data?.department || "").trim();
    const month = submission.data?.month ? new Date(submission.data.month) : null;
    if (!division || !department || !month || Number.isNaN(month.getTime())) {
      return res.json([]);
    }

    const siblings = await query<any>(
      `SELECT s.id, s.status, s.data, u.full_name AS requester_name
         FROM custom_request_submissions s
         JOIN users u ON u.id = s.requester_id
        WHERE s.request_type_id = $1
          AND lower(trim(s.data->>'division')) = lower($2)
          AND lower(trim(s.data->>'department')) = lower($3)
          AND date_trunc('month', (s.data->>'month')::date) = date_trunc('month', $4::date)
        ORDER BY u.full_name`,
      [submission.request_type_id, division, department, month.toISOString()]
    );

    return res.json(siblings);
  } catch (err) {
    return next(err);
  }
});

const AddAssigneeSchema = z.object({
  field_key: z.string().trim().min(1),
  id: z.string().uuid().nullish(),
  email: z.string().trim().email().nullish(),
  name: z.string().trim().nullish(),
  team_id: z.string().uuid().nullish(),
  department_id: z.string().uuid().nullish(),
  division_name: z.string().trim().min(1).nullish()
}).refine((d) => d.id || d.email || d.team_id || d.department_id || d.division_name, { message: "Provide a person, an email, or a section, department or division" });

// POST /custom-requests/:id/assignees — add another assignee (person or whole
// team) to a "user_multi" field. Callable by the requester, an existing
// assignee on that same field (so assignees can pull in help), or an admin.
customRequestsRouter.post("/:id/assignees", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = AddAssigneeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid assignee payload", parsed.error.flatten());

    const submission = (await query<any>(`SELECT * FROM custom_request_submissions WHERE id = $1`, [req.params.id]))[0];
    if (!submission) throw notFound();

    const fields = await query<{ field_key: string; field_label: string; field_type: string }>(
      `SELECT field_key, field_label, field_type FROM request_type_fields WHERE request_type_id = $1 AND is_active = true`,
      [submission.request_type_id]
    );
    const field = fields.find((f) => f.field_key === parsed.data.field_key);
    if (!field || field.field_type !== "user_multi") throw badRequest("That field does not accept multiple assignees");

    const isOwnerOrAssignee = submission.requester_id === req.user!.userId
      || isSubmissionAssignee(submission.data, fields, req.user!)
      || (await crPermissions(submission, req.user!)).edit;
    if (req.user!.role !== "ADMIN" && !isOwnerOrAssignee) throw forbidden("Only the requester, an owner, a co-writer or an existing assignee can add another assignee");

    let entry: AssigneeEntry;
    let teamMemberEmails: string[] = [];
    if (parsed.data.department_id) {
      const d = (await query<{ id: string; name: string }>(`SELECT id, name FROM sections WHERE id = $1 AND active = true`, [parsed.data.department_id]))[0];
      if (!d) throw badRequest("Selected department is invalid");
      entry = { id: null, name: null, email: null, teamId: null, teamName: null, departmentId: d.id, departmentName: d.name, confirmed: false, confirmed_at: null, confirmedBy: null };
      teamMemberEmails = (await query<{ email: string }>(`SELECT email FROM users WHERE section_id = $1 AND is_active = true`, [d.id])).map((m) => m.email);
    } else if (parsed.data.division_name) {
      const d = (await query<{ name: string }>(`SELECT name FROM departments WHERE lower(trim(name)) = lower(trim($1)) AND active = true`, [parsed.data.division_name]))[0];
      if (!d) throw badRequest("Selected division is invalid");
      entry = { id: null, name: null, email: null, teamId: null, teamName: null, divisionName: d.name, confirmed: false, confirmed_at: null, confirmedBy: null };
      teamMemberEmails = (await query<{ email: string }>(`SELECT email FROM users WHERE lower(trim(department)) = lower(trim($1)) AND is_active = true`, [d.name])).map((m) => m.email);
    } else if (parsed.data.team_id) {
      const t = (await query<{ id: string; name: string }>(`SELECT id, name FROM teams WHERE id = $1 AND active = true`, [parsed.data.team_id]))[0];
      if (!t) throw badRequest("Selected section is invalid");
      entry = { id: null, name: null, email: null, teamId: t.id, teamName: t.name, confirmed: false, confirmed_at: null, confirmedBy: null };
      const members = await query<{ email: string }>(`SELECT email FROM users WHERE team_id = $1 AND is_active = true`, [t.id]);
      teamMemberEmails = members.map((m) => m.email);
    } else if (parsed.data.id) {
      const u = (await query<{ id: string; full_name: string | null; email: string }>(
        `SELECT id, full_name, email FROM users WHERE id = $1 AND is_active = true`,
        [parsed.data.id]
      ))[0];
      if (!u) throw badRequest("Selected user is invalid");
      entry = { id: u.id, name: u.full_name, email: u.email, teamId: null, teamName: null, confirmed: false, confirmed_at: null, confirmedBy: null };
    } else {
      entry = { id: null, name: parsed.data.name ?? null, email: parsed.data.email!, teamId: null, teamName: null, confirmed: false, confirmed_at: null, confirmedBy: null };
    }

    const current: AssigneeEntry[] = Array.isArray(submission.data?.[field.field_key]) ? submission.data[field.field_key] : [];
    const alreadyListed = current.some((a) =>
      (entry.teamId && a.teamId === entry.teamId)
      || (entry.departmentId && a.departmentId === entry.departmentId)
      || (entry.divisionName && a.divisionName?.toLowerCase() === entry.divisionName.toLowerCase())
      || (entry.id && a.id === entry.id)
      || (!entry.id && !entry.teamId && !entry.departmentId && !entry.divisionName && !!entry.email && a.email?.toLowerCase() === entry.email?.toLowerCase())
    );
    if (alreadyListed) throw badRequest("That person or section is already listed as an assignee");

    const updatedData = { ...submission.data, [field.field_key]: [...current, entry] };
    await query(`UPDATE custom_request_submissions SET data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(updatedData), submission.id]);
    await auditChangeRequest(submission.id, req.user!, "ASSIGNEE_ADDED",
      `Added ${assigneeLabel(entry)} to ${field.field_label}`);

    const requestType = (await query<{ name: string }>(`SELECT name FROM custom_request_types WHERE id = $1`, [submission.request_type_id]))[0];
    if (entry.id && entry.email) {
      void notifyCustomRequestAssigneeAssigned({
        submissionId: submission.id,
        requestTypeName: requestType?.name ?? "Request",
        requesterName: req.user!.fullName ?? null,
        fieldLabel: field.field_label,
        assigneeEmail: entry.email,
        assigneeName: entry.name
      });
    } else if (!entry.id && !entry.teamId && !entry.departmentId && !entry.divisionName && entry.email) {
      void notifyCustomRequestUnregisteredAssignee({
        submissionId: submission.id,
        requestTypeName: requestType?.name ?? "Request",
        requesterName: req.user!.fullName ?? null,
        fieldLabel: field.field_label,
        assigneeEmail: entry.email
      });
    } else if ((entry.teamId || entry.departmentId || entry.divisionName) && teamMemberEmails.length) {
      void notifyCustomRequestTeamAssigned({
        submissionId: submission.id,
        requestTypeName: requestType?.name ?? "Request",
        requesterName: req.user!.fullName ?? null,
        fieldLabel: field.field_label,
        teamName: entry.teamName || (entry.departmentName ? `${entry.departmentName} (Department)` : `${entry.divisionName} (Division)`),
        memberEmails: teamMemberEmails
      });
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const ConfirmAssigneeSchema = z.object({ field_key: z.string().trim().min(1) });

// POST /custom-requests/:id/assignees/confirm — the current user marks their
// own entry in a "user_multi" field confirmed (e.g. "implementation plan is
// ready"). Once everyone listed has confirmed, approvers can act.
customRequestsRouter.post("/:id/assignees/confirm", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ConfirmAssigneeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const submission = (await query<any>(
      `SELECT s.*, rt.name AS request_type_name, u.full_name AS requester_name
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
         JOIN users u ON u.id = s.requester_id
        WHERE s.id = $1`,
      [req.params.id]
    ))[0];
    if (!submission) throw notFound();

    const current: AssigneeEntry[] = Array.isArray(submission.data?.[parsed.data.field_key]) ? submission.data[parsed.data.field_key] : [];
    const idx = current.findIndex((a) =>
      assigneeMatches(a, req.user!)
    );
    if (idx === -1) throw forbidden("You are not listed as an assignee (or a member of an assigned section) on this field");

    current[idx] = { ...current[idx], confirmed: true, confirmed_at: new Date().toISOString(), confirmedBy: (current[idx].teamId || current[idx].departmentId || current[idx].divisionName) ? req.user!.fullName ?? req.user!.userId : current[idx].confirmedBy };
    const updatedData = { ...submission.data, [parsed.data.field_key]: current };
    await query(`UPDATE custom_request_submissions SET data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(updatedData), submission.id]);
    await auditChangeRequest(submission.id, req.user!, "ASSIGNEE_CONFIRMED",
      `Confirmed the implementation plan is ready${current[idx].id ? "" : ` for ${assigneeLabel(current[idx])}`}`);

    // Once every assignee across every "user_multi" field has confirmed, the
    // implementation plan is ready — let the current-step approver know now,
    // since they may have been notified back at submission time, well before
    // assignees finished (and were therefore blocked from acting until now).
    if (submission.status === "IN_PROGRESS") {
      const multiFields = await query<{ field_key: string }>(
        `SELECT field_key FROM request_type_fields WHERE request_type_id = $1 AND field_type = 'user_multi' AND is_active = true`,
        [submission.request_type_id]
      );
      const allConfirmed = multiFields.every((f) => {
        const arr: AssigneeEntry[] | undefined = f.field_key === parsed.data.field_key ? current : updatedData[f.field_key];
        return Array.isArray(arr) && arr.length > 0 && arr.every((a) => a.confirmed);
      });
      if (allConfirmed) {
        const chain = submission.approval_chain as Array<{ approver_id: string; approver_name: string | null; approver_email: string | null; position_name: string }>;
        const step = chain[submission.current_step_order];
        if (step) {
          void notifyCustomRequestStep({
            submissionId: submission.id,
            requestTypeName: submission.request_type_name,
            requesterName: submission.requester_name,
            approverEmail: step.approver_email,
            approverName: step.approver_name,
            approverId: step.approver_id,
            stepLabel: step.position_name,
            stepOrder: submission.current_step_order
          });
        }
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const UpdateDataSchema = z.object({ data: z.record(z.string(), z.any()) });

// PATCH /custom-requests/:id/data — the requester, an assignee (person or
// team member on any "user_multi" field), or an admin can fill in/update
// implementation-side fields (e.g. Implementation Plan, Callout Person)
// while the request is still in progress. "user_multi" fields themselves
// are off-limits here — those go through the dedicated assignee endpoints.
customRequestsRouter.patch("/:id/data", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = UpdateDataSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    const submission = (await query<any>(`SELECT * FROM custom_request_submissions WHERE id = $1`, [req.params.id]))[0];
    if (!submission) throw notFound();
    if (submission.status !== "IN_PROGRESS") throw badRequest("This request can no longer be edited");

    const fields = await query<{ field_key: string; field_type: string; field_label: string }>(
      `SELECT field_key, field_type, field_label FROM request_type_fields WHERE request_type_id = $1 AND is_active = true`,
      [submission.request_type_id]
    );
    const fieldTypeByKey = new Map(fields.map((f) => [f.field_key, f.field_type]));

    const isOwnerOrAssignee = submission.requester_id === req.user!.userId
      || isSubmissionAssignee(submission.data, fields, req.user!)
      || (await crPermissions(submission, req.user!)).edit;
    if (req.user!.role !== "ADMIN" && !isOwnerOrAssignee) throw forbidden("Only the requester, an owner, a co-writer with edit rights or an assignee can update this request");

    const updates: Record<string, any> = {};
    for (const [key, value] of Object.entries(parsed.data.data)) {
      const type = fieldTypeByKey.get(key);
      if (!type) throw badRequest(`Unknown field "${key}"`);
      if (type === "user_multi") throw badRequest(`"${key}" cannot be edited here — use the assignee endpoints`);
      updates[key] = value;
    }
    if (!Object.keys(updates).length) return res.json({ ok: true });

    const changes = diffFields(submission.data || {}, updates, fields);
    const updatedData = { ...submission.data, ...updates };
    await query(`UPDATE custom_request_submissions SET data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(updatedData), submission.id]);
    if (changes.length) {
      const d = describeFieldSave(changes);
      await auditChangeRequest(submission.id, req.user!, "FIELDS_SAVED", d.summary, { changes, sectionKey: d.sectionKey, sectionTitle: d.sectionTitle });
    }

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Shared by POST /:id/action and the email-approval flow (email-actions.routes.ts).
export async function performCustomRequestAction(
  submissionId: string,
  actor: { userId: string; role: string; fullName: string | null },
  action: "APPROVE" | "REJECT",
  comment?: string | null
): Promise<{ status: string }> {
  const submission = (await query<any>(
    `SELECT s.*, rt.name AS request_type_name, rt.code AS request_type_code, u.full_name AS requester_name, u.email AS requester_email
       FROM custom_request_submissions s
       JOIN custom_request_types rt ON rt.id = s.request_type_id
       JOIN users u ON u.id = s.requester_id
      WHERE s.id = $1`,
    [submissionId]
  ))[0];
  if (!submission) throw notFound();
  if (submission.status !== "IN_PROGRESS") throw badRequest("This request is no longer pending approval");

  const chain = submission.approval_chain as Array<{ approver_id: string; approver_name: string | null; approver_email: string | null; position_name: string; decision_type?: "APPROVE" | "NOTE"; status: string; comment: string | null; acted_at: string | null }>;
  const stepIdx = submission.current_step_order;
  const step = chain[stepIdx];
  if (!step) throw badRequest("This request has no pending step");
  if (actor.role !== "ADMIN" && step.approver_id !== actor.userId) {
    // Accept either a delegation scoped specifically to this custom request
    // type, or one scoped to the broad "Custom Requests" bucket that covers
    // all of them.
    const delegatedManagerIds = await getDelegatedManagerIds(actor.userId, [submission.request_type_code, "CUSTOM_WORKFLOW"]);
    if (!delegatedManagerIds.includes(step.approver_id)) {
      throw forbidden("You are not the approver for the current step");
    }
  }

  // Approval (not rejection) is gated on every assignee in any "user_multi"
  // field (e.g. Change Assignee) individually confirming they're ready —
  // typically once the implementation plan is in place. Rejection is never
  // blocked, since an approver may need to push back before that happens.
  if (action === "APPROVE") {
    const multiFields = await query<{ field_key: string; field_label: string }>(
      `SELECT field_key, field_label FROM request_type_fields WHERE request_type_id = $1 AND field_type = 'user_multi' AND is_active = true`,
      [submission.request_type_id]
    );
    for (const f of multiFields) {
      const assignees = (submission.data?.[f.field_key] ?? []) as AssigneeEntry[];
      const unconfirmed = assignees.filter((a) => !a.confirmed);
      if (unconfirmed.length) {
        throw badRequest(`All assignees for "${f.field_label}" must confirm the implementation plan is ready before this request can be approved (waiting on: ${unconfirmed.map((a) => assigneeLabel(a)).join(", ")})`);
      }
    }
  }

  // A "NOTE" step (e.g. GM Internal Audit & Risk on the ECONET Change Control
  // form) still has to act for the chain to move on, but its affirmative action
  // is recorded as "NOTED" rather than "APPROVED" — it's acknowledging the
  // change for the record, not formally signing off on it.
  step.status = action === "APPROVE" ? (step.decision_type === "NOTE" ? "NOTED" : "APPROVED") : "REJECTED";
  step.comment = comment || null;
  step.acted_at = new Date().toISOString();

  let newStatus = submission.status;
  let newStepOrder = stepIdx;

  if (action === "REJECT") {
    newStatus = "REJECTED";
  } else if (stepIdx + 1 >= chain.length) {
    newStatus = "APPROVED";
  } else {
    newStepOrder = stepIdx + 1;
  }

  await query(
    `UPDATE custom_request_submissions
        SET approval_chain = $1, current_step_order = $2, status = $3, updated_at = now()
      WHERE id = $4`,
    [JSON.stringify(chain), newStepOrder, newStatus, submission.id]
  );

  if (submission.request_type_code === "CHANGE_REQUEST") {
    await auditChangeRequest(submission.id, actor, "APPROVAL_ACTION",
      `${step.position_name}: ${step.status === "NOTED" ? "Noted" : step.status === "APPROVED" ? "Approved" : "Rejected"}${comment ? ` — ${comment}` : ""}${newStatus === "APPROVED" ? " (fully approved)" : ""}`);
  }

  // Computer Request specifically hands off to the IT Provisioning back
  // office once fully approved - every other custom request type is
  // unaffected (no matching submission_id will ever ask for a task).
  if (newStatus === "APPROVED" && submission.request_type_code === "COMPUTER_REQUEST") {
    await createProvisioningTaskForSubmission(submission.id, submission.data?.computer_type);
  }

  // BRS's Approval Routing stage rides entirely on this generic engine (see
  // brs.routes.ts POST /:id/route-approval) — the only BRS-specific code
  // needed here is baselining on approval, or bouncing back to Draft for
  // rework on rejection (never a dead end).
  // BRS audit trail: every approver decision, in the document's own history.
  if (submission.request_type_code === "BRS_APPROVAL" && submission.data?.brs_document_id) {
    await recordBrsRevision({
      documentId: submission.data.brs_document_id, kind: "APPROVAL_ACTION", actorId: actor.userId, actorRole: "APPROVER",
      summary: `${step.position_name}: ${step.status === "NOTED" ? "Noted" : step.status === "APPROVED" ? "Approved" : "Rejected"}${comment ? ` — ${comment}` : ""}`
    }).catch(() => {});
  }
  if (newStatus === "APPROVED" && submission.request_type_code === "BRS_APPROVAL") {
    await baselineBrsDocument(submission.data?.brs_document_id, submission.id, actor.userId);
  }
  if (newStatus === "REJECTED" && submission.request_type_code === "BRS_APPROVAL") {
    await returnBrsDocumentToDraft(submission.data?.brs_document_id, comment ?? null, actor.fullName ?? null);
  }

  // Email/Teams sends are slow relative to a request-response cycle and
  // already self-log on failure — don't make the caller (the action route,
  // or the one-click email-approval link) wait on them.
  // Change Request co-owners hear about every decision, like the requester.
  const coOwners = (submission.owner_user_ids || []).length
    ? await query<{ email: string; full_name: string | null }>(`SELECT email, full_name FROM users WHERE id = ANY($1::uuid[]) AND is_active`, [submission.owner_user_ids])
    : [];
  const requesterAndCoOwners = [{ email: submission.requester_email, full_name: submission.requester_name }, ...coOwners];
  if (action === "REJECT") {
    for (const r of requesterAndCoOwners) void notifyCustomRequestDecision({
      submissionId: submission.id,
      requestTypeName: submission.request_type_name,
      requesterEmail: r.email,
      requesterName: r.full_name,
      decision: "REJECTED",
      decidedBy: actor.fullName ?? null,
      comment: comment ?? null
    });
  } else if (newStatus === "APPROVED") {
    for (const r of requesterAndCoOwners) void notifyCustomRequestDecision({
      submissionId: submission.id,
      requestTypeName: submission.request_type_name,
      requesterEmail: r.email,
      requesterName: r.full_name,
      decision: "APPROVED",
      decidedBy: actor.fullName ?? null,
      comment: comment ?? null,
      nextSteps: submission.request_type_code === "COMPUTER_REQUEST"
        ? "It has now gone to IT for provisioning. We'll email you as it progresses, and when your computer is ready to collect."
        : submission.request_type_code === "CHANGE_REQUEST"
        ? "It has not been sent to anyone else. When you're ready, distribute it from Custom Requests > My Requests > Distribute."
        : submission.request_type_code === "BRS_APPROVAL"
        ? "The BRS is now baselined. It has not been sent to anyone else. When you're ready, distribute it from BRS Studio > Distribute."
        : null
    });
  } else {
    const nextStep = chain[newStepOrder];
    for (const r of requesterAndCoOwners) void notifyCustomRequestProgress({
      submissionId: submission.id,
      requestTypeName: submission.request_type_name,
      requesterEmail: r.email,
      requesterName: r.full_name,
      event: "STEP_APPROVED",
      actedBy: actor.fullName ?? null,
      actedStepLabel: step.position_name,
      comment: comment ?? null,
      nextApproverName: nextStep.approver_name,
      nextStepLabel: nextStep.position_name
    });
    void notifyCustomRequestStep({
      submissionId: submission.id,
      requestTypeName: submission.request_type_name,
      requesterName: submission.requester_name,
      approverEmail: nextStep.approver_email,
      approverName: nextStep.approver_name,
      approverId: nextStep.approver_id,
      stepLabel: nextStep.position_name,
      stepOrder: newStepOrder
    });
  }

  return { status: newStatus };
}

// POST /custom-requests/:id/action — approve/reject the current step
customRequestsRouter.post("/:id/action", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ActionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid action payload", parsed.error.flatten());
    const result = await performCustomRequestAction(
      req.params.id,
      { userId: req.user!.userId, role: req.user!.role, fullName: req.user!.fullName ?? null },
      parsed.data.action,
      parsed.data.comment
    );
    return res.json({ ok: true, status: result.status });
  } catch (err) {
    return next(err);
  }
});

// POST /custom-requests/:id/cancel — requester withdraws their own request while it's
// still pending approval. Terminal — cancelled requests cannot be reopened.
// A manual nudge the requester can fire on demand, rather than waiting for
// the automatic SLA sweep's threshold to elapse (see sla.service.ts). Shares
// that same sla_reminder_log dedupe row (doc_type "CUSTOM_REQUEST") so
// sending one also resets the automatic sweep's clock for this step -
// covers BRS Approval and Change Request alike, since both ride this same
// generic engine.
const MANUAL_REMINDER_COOLDOWN_HOURS = 1;
customRequestsRouter.post("/:id/remind", async (req: AuthedRequest, res, next) => {
  try {
    const submission = (await query<any>(
      `SELECT s.*, rt.name AS request_type_name, u.full_name AS requester_name
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
         JOIN users u ON u.id = s.requester_id
        WHERE s.id = $1`,
      [req.params.id]
    ))[0];
    if (!submission) throw notFound();
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId && !(submission.owner_user_ids || []).includes(req.user!.userId)) {
      throw forbidden("Only the requester (or a co-owner) can send a reminder on this request");
    }
    if (submission.status !== "IN_PROGRESS") throw badRequest("This request is not awaiting approval");

    const chain = submission.approval_chain as Array<{ approver_id: string; approver_name: string | null; approver_email: string | null; position_name: string }>;
    const step = chain[submission.current_step_order];
    if (!step) throw badRequest("This request has no pending approval step");

    const existing = (await query<{ reminded_at: string }>(
      `SELECT reminded_at FROM sla_reminder_log WHERE doc_type='CUSTOM_REQUEST' AND doc_id=$1 AND step_order=$2`,
      [submission.id, submission.current_step_order]
    ))[0];
    if (existing && new Date(existing.reminded_at).getTime() > Date.now() - MANUAL_REMINDER_COOLDOWN_HOURS * 3_600_000) {
      throw badRequest("A reminder was already sent recently for this step — please wait before sending another.");
    }

    let approverEmail = step.approver_email;
    let approverName = step.approver_name;
    if (!approverEmail) {
      const user = (await query<{ email: string; full_name: string | null }>(`SELECT email, full_name FROM users WHERE id = $1`, [step.approver_id]))[0];
      approverEmail = user?.email ?? null;
      approverName = approverName ?? user?.full_name ?? null;
    }
    if (!approverEmail) throw badRequest("The current approver has no email on file — contact Admin");

    await notifySlaReminder({
      docType: "CUSTOM_REQUEST",
      docId: submission.id,
      itemLabel: "Request",
      reference: `${submission.request_type_name || "Custom Request"} — ${submission.requester_name || "Unknown"}`,
      approverEmail,
      approverName,
      hoursPending: (Date.now() - new Date(submission.updated_at).getTime()) / 3_600_000
    });

    await query(
      `INSERT INTO sla_reminder_log (doc_type, doc_id, step_order, reminded_at) VALUES ('CUSTOM_REQUEST',$1,$2,now())
       ON CONFLICT (doc_type, doc_id, step_order) DO UPDATE SET reminded_at = now()`,
      [submission.id, submission.current_step_order]
    );

    return res.json({ ok: true, approver_name: approverName });
  } catch (err) {
    return next(err);
  }
});

customRequestsRouter.post("/:id/cancel", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CancelSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid cancel payload", parsed.error.flatten());

    const submission = (await query<any>(
      `SELECT s.*, rt.name AS request_type_name
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
        WHERE s.id = $1`,
      [req.params.id]
    ))[0];
    if (!submission) throw notFound();
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId && !(submission.owner_user_ids || []).includes(req.user!.userId)) {
      throw forbidden("Only the requester (or a co-owner) can cancel this request");
    }
    if (submission.status !== "IN_PROGRESS") throw badRequest("Only a request that is still pending approval can be cancelled");

    await query(
      `UPDATE custom_request_submissions
          SET status = 'CANCELLED', cancel_comment = $1, cancelled_at = now(), updated_at = now()
        WHERE id = $2`,
      [parsed.data.comment, submission.id]
    );
    await auditChangeRequest(submission.id, req.user!, "CANCELLED", `Cancelled: ${parsed.data.comment}`);

    const chain = submission.approval_chain as Array<{ approver_id: string; approver_name: string | null; approver_email: string | null; position_name: string }>;
    const pendingStep = chain[submission.current_step_order];
    if (pendingStep) {
      void notifyCustomRequestCancelled({
        submissionId: submission.id,
        requestTypeName: submission.request_type_name,
        requesterName: req.user!.fullName ?? null,
        approverEmail: pendingStep.approver_email,
        approverName: pendingStep.approver_name,
        comment: parsed.data.comment
      });
    }

    return res.json({ ok: true, status: "CANCELLED" });
  } catch (err) {
    return next(err);
  }
});

// POST /custom-requests/:id/close — requester closes an approved request after implementation
customRequestsRouter.post("/:id/close", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = CloseSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid close payload", parsed.error.flatten());

    const submission = (await query<any>(
      `SELECT s.*, rt.name AS request_type_name, u.full_name AS requester_name, u.email AS requester_email
         FROM custom_request_submissions s
         JOIN custom_request_types rt ON rt.id = s.request_type_id
         JOIN users u ON u.id = s.requester_id
        WHERE s.id = $1`,
      [req.params.id]
    ))[0];
    if (!submission) throw notFound();
    if (submission.status !== "APPROVED") throw badRequest("Only approved requests can be closed");
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId && !(submission.owner_user_ids || []).includes(req.user!.userId)) {
      throw forbidden("Only the requester (or a co-owner) can close this request");
    }

    await query(
      `UPDATE custom_request_submissions
          SET status = 'CLOSED',
              implementation_date = $1,
              closure_notes = $2,
              closed_at = now(),
              follow_up_sent = false,
              updated_at = now()
        WHERE id = $3`,
      [parsed.data.implementation_date, parsed.data.closure_notes ?? null, submission.id]
    );
    await auditChangeRequest(submission.id, req.user!, "CLOSED",
      `Closed — implemented ${parsed.data.implementation_date}${parsed.data.closure_notes ? `: ${parsed.data.closure_notes}` : ""}`);

    return res.json({ ok: true, status: "CLOSED" });
  } catch (err) {
    return next(err);
  }
});

// Called by the daily scheduler — sends D+1 follow-up emails and marks follow_up_sent
export async function sendPendingChangeRequestFollowUps(): Promise<void> {
  const due = await query<any>(
    `SELECT s.id, s.implementation_date, s.closure_notes, s.approval_chain,
            rt.name AS request_type_name,
            u.full_name AS requester_name, u.email AS requester_email
       FROM custom_request_submissions s
       JOIN custom_request_types rt ON rt.id = s.request_type_id
       JOIN users u ON u.id = s.requester_id
      WHERE s.status = 'CLOSED'
        AND s.follow_up_sent = false
        AND s.implementation_date IS NOT NULL
        AND s.implementation_date < CURRENT_DATE`
  );

  for (const row of due) {
    try {
      const chain: Array<{ approver_email: string | null; approver_name: string | null }> = row.approval_chain ?? [];
      await notifyChangeRequestFollowUp({
        submissionId: row.id,
        requestTypeName: row.request_type_name,
        requesterName: row.requester_name,
        requesterEmail: row.requester_email,
        implementationDate: row.implementation_date,
        closureNotes: row.closure_notes ?? null,
        approvers: chain.map((s) => ({ name: s.approver_name, email: s.approver_email }))
      });
      await query(
        `UPDATE custom_request_submissions SET follow_up_sent = true, updated_at = now() WHERE id = $1`,
        [row.id]
      );
    } catch (err) {
      logger.warn("change_request_followup_failed", {
        submission_id: row.id,
        error: serializeError(err)
      });
      // leave follow_up_sent = false so it retries on the next daily run
    }
  }
}
