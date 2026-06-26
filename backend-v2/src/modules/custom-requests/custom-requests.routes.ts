import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import multer from "multer";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { notifyCustomRequestStep, notifyCustomRequestDecision, notifyCustomRequestCancelled, notifyChangeRequestFollowUp, notifyCustomRequestUnregisteredAssignee, notifyCustomRequestAssigneeAssigned, notifyCustomRequestTeamAssigned, notifyCustomRequestSectionAssigned } from "../../lib/notifications.js";
import { logger, serializeError } from "../../lib/logger.js";
import { getManagerChainIds } from "../reporting-lines/reporting-lines.routes.js";

export const customRequestsRouter = Router();
customRequestsRouter.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replaceAll(" ", "_")}`)
});
const uploadAttachments = multer({ storage: attachmentStorage, limits: { fileSize: 25 * 1024 * 1024 } });

type FixedApprovalStep = { title: string; source: "AUTO_MANAGER" | "ROLE_PICKER"; role?: string };
// An assignee entry is either a person (id and/or email set) or a whole
// team (teamId set, id/email null) — confirmed by any one member of that team.
type AssigneeEntry = {
  id: string | null;
  name: string | null;
  email: string | null;
  teamId: string | null;
  teamName: string | null;
  confirmed: boolean;
  confirmed_at: string | null;
  confirmedBy: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// True if the actor (by id, or by team membership for team entries) appears
// in any "user_multi" field's assignee array on this submission — used to
// gate the add/confirm assignee endpoints.
function isSubmissionAssignee(
  data: Record<string, any>,
  fields: Array<{ field_key: string; field_type: string }>,
  actor: { userId: string; teamId?: string | null }
): boolean {
  return fields.some((f) => {
    if (f.field_type !== "user_multi") return false;
    const arr = data[f.field_key];
    return Array.isArray(arr) && arr.some((a: AssigneeEntry) =>
      a?.id === actor.userId || (a?.teamId && actor.teamId && a.teamId === actor.teamId)
    );
  });
}

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

async function assertCanSubmit(userId: string, role: string, department: string | null, employmentType: string | null, requestTypeId: string) {
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

// POST /custom-requests — submit a new request with a requester-defined approval chain.
// Sent as multipart/form-data so the wizard's attachment step can ride along with the
// rest of the form in one request — "data" and "approval_chain" arrive as JSON strings.
customRequestsRouter.post("/", uploadAttachments.array("files", 10), async (req: AuthedRequest, res, next) => {
  try {
    let bodyData: unknown;
    let bodyChain: unknown;
    try {
      bodyData = typeof req.body.data === "string" ? JSON.parse(req.body.data) : (req.body.data ?? {});
      bodyChain = typeof req.body.approval_chain === "string" ? JSON.parse(req.body.approval_chain) : (req.body.approval_chain ?? []);
    } catch {
      throw badRequest("Invalid submission payload — data/approval_chain must be valid JSON");
    }

    const parsed = CreateSchema.safeParse({ request_type_id: req.body.request_type_id, data: bodyData, approval_chain: bodyChain });
    if (!parsed.success) throw badRequest("Invalid submission payload", parsed.error.flatten());

    const requestType = (await query<{ id: string; name: string; status: string; fixed_approval_chain: FixedApprovalStep[] | null }>(
      `SELECT id, name, status, fixed_approval_chain FROM custom_request_types WHERE id = $1 AND is_active = true`,
      [parsed.data.request_type_id]
    ))[0];
    if (!requestType) throw notFound("Request type not found");
    if (requestType.status !== "ACTIVE") throw badRequest("This request type is not currently active");

    await assertCanSubmit(req.user!.userId, req.user!.role, req.user!.department ?? null, req.user!.employmentType ?? null, requestType.id);

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
      const raw = parsed.data.data[f.field_key];
      if (!Array.isArray(raw)) continue;

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
        if (a?.id && userMap.has(a.id)) {
          const u = userMap.get(a.id)!;
          resolved.push({ id: u.id, name: u.full_name, email: u.email, teamId: null, teamName: null, confirmed: false, confirmed_at: null, confirmedBy: null });
          continue;
        }
        const email = String(a?.email || "").trim();
        if (!EMAIL_RE.test(email)) throw badRequest(`"${f.field_label}" has an invalid entry — pick a system user, a team, or enter a valid email`);
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
          const managerId = (await getManagerChainIds(req.user!.userId))[0];
          if (!managerId) throw badRequest("No manager is set up for you in the org structure — ask HR/Admin to set your reporting line before submitting");
          chainInput.push({ approver_id: managerId, position_name: stepDef.title, decision_type: "APPROVE" });
        } else {
          if (!submitted?.approver_id) throw badRequest(`Please select an approver for "${stepDef.title}"`);
          chainInput.push({ approver_id: submitted.approver_id, position_name: stepDef.title, decision_type: "APPROVE" });
        }
      }
    } else {
      chainInput = parsed.data.approval_chain.map((s) => {
        if (!s.approver_id || !s.position_name?.trim()) throw badRequest("Each approval step requires an approver and a title");
        return { approver_id: s.approver_id, position_name: s.position_name.trim(), decision_type: s.decision_type };
      });
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
        if (stepDef.source === "ROLE_PICKER" && stepDef.role) {
          const approver = approverMap.get(chainInput[i].approver_id)!;
          if (String(approver.role).toUpperCase() !== stepDef.role.toUpperCase()) {
            throw badRequest(`The approver for "${stepDef.title}" must have the role ${stepDef.role}`);
          }
        }
      }
    }

    const chain = chainInput.map((step, idx) => {
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

    const submission = (await query<{ id: string }>(
      `INSERT INTO custom_request_submissions (request_type_id, requester_id, data, approval_chain, current_step_order, status)
       VALUES ($1, $2, $3, $4, 0, 'IN_PROGRESS')
       RETURNING id`,
      [requestType.id, req.user!.userId, JSON.stringify(parsed.data.data), JSON.stringify(chain)]
    ))[0];

    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    for (const file of uploadedFiles) {
      await query(
        `INSERT INTO custom_request_attachments (submission_id, file_path, original_name, content_type, size_bytes, uploaded_by_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [submission.id, file.path, file.originalname, file.mimetype, file.size, req.user!.userId]
      );
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
              } else if (!a.id && !a.teamId && a.email) {
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
              ) AS attachments
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
          a?.id === req.user!.userId || (a?.teamId && req.user!.teamId && a.teamId === req.user!.teamId)
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
    const isAssignee = isSubmissionAssignee(submission.data, fields, { userId: req.user!.userId, teamId: req.user!.teamId });
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId && !isParticipant && !isAssignee) {
      throw forbidden();
    }

    const attachments = await query(
      `SELECT id, original_name, content_type, size_bytes, uploaded_at FROM custom_request_attachments WHERE submission_id = $1 ORDER BY uploaded_at`,
      [submission.id]
    );

    return res.json({ ...submission, fields, attachments });
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
    const isAssignee = isSubmissionAssignee(submission.data, fields, { userId: req.user!.userId, teamId: req.user!.teamId });
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId && !isParticipant && !isAssignee) {
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
  team_id: z.string().uuid().nullish()
}).refine((d) => d.id || d.email || d.team_id, { message: "Provide a system user id, an email, or a team id" });

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
      || isSubmissionAssignee(submission.data, fields, { userId: req.user!.userId, teamId: req.user!.teamId });
    if (req.user!.role !== "ADMIN" && !isOwnerOrAssignee) throw forbidden("Only the requester or an existing assignee can add another assignee");

    let entry: AssigneeEntry;
    let teamMemberEmails: string[] = [];
    if (parsed.data.team_id) {
      const t = (await query<{ id: string; name: string }>(`SELECT id, name FROM teams WHERE id = $1 AND active = true`, [parsed.data.team_id]))[0];
      if (!t) throw badRequest("Selected team is invalid");
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
      || (entry.id && a.id === entry.id)
      || (!entry.id && !entry.teamId && a.email?.toLowerCase() === entry.email?.toLowerCase())
    );
    if (alreadyListed) throw badRequest("That person or team is already listed as an assignee");

    const updatedData = { ...submission.data, [field.field_key]: [...current, entry] };
    await query(`UPDATE custom_request_submissions SET data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(updatedData), submission.id]);

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
    } else if (!entry.id && !entry.teamId && entry.email) {
      void notifyCustomRequestUnregisteredAssignee({
        submissionId: submission.id,
        requestTypeName: requestType?.name ?? "Request",
        requesterName: req.user!.fullName ?? null,
        fieldLabel: field.field_label,
        assigneeEmail: entry.email
      });
    } else if (entry.teamId && teamMemberEmails.length) {
      void notifyCustomRequestTeamAssigned({
        submissionId: submission.id,
        requestTypeName: requestType?.name ?? "Request",
        requesterName: req.user!.fullName ?? null,
        fieldLabel: field.field_label,
        teamName: entry.teamName!,
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
      a.id === req.user!.userId || (a.teamId && req.user!.teamId && a.teamId === req.user!.teamId)
    );
    if (idx === -1) throw forbidden("You are not listed as an assignee (or a member of an assigned team) on this field");

    current[idx] = { ...current[idx], confirmed: true, confirmed_at: new Date().toISOString(), confirmedBy: current[idx].teamId ? req.user!.fullName ?? req.user!.userId : current[idx].confirmedBy };
    const updatedData = { ...submission.data, [parsed.data.field_key]: current };
    await query(`UPDATE custom_request_submissions SET data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(updatedData), submission.id]);

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

    const fields = await query<{ field_key: string; field_type: string }>(
      `SELECT field_key, field_type FROM request_type_fields WHERE request_type_id = $1 AND is_active = true`,
      [submission.request_type_id]
    );
    const fieldTypeByKey = new Map(fields.map((f) => [f.field_key, f.field_type]));

    const isOwnerOrAssignee = submission.requester_id === req.user!.userId
      || isSubmissionAssignee(submission.data, fields, { userId: req.user!.userId, teamId: req.user!.teamId });
    if (req.user!.role !== "ADMIN" && !isOwnerOrAssignee) throw forbidden("Only the requester or an assignee can update this request");

    const updates: Record<string, any> = {};
    for (const [key, value] of Object.entries(parsed.data.data)) {
      const type = fieldTypeByKey.get(key);
      if (!type) throw badRequest(`Unknown field "${key}"`);
      if (type === "user_multi") throw badRequest(`"${key}" cannot be edited here — use the assignee endpoints`);
      updates[key] = value;
    }
    if (!Object.keys(updates).length) return res.json({ ok: true });

    const updatedData = { ...submission.data, ...updates };
    await query(`UPDATE custom_request_submissions SET data = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(updatedData), submission.id]);

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
    `SELECT s.*, rt.name AS request_type_name, u.full_name AS requester_name, u.email AS requester_email
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
    throw forbidden("You are not the approver for the current step");
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
        throw badRequest(`All assignees for "${f.field_label}" must confirm the implementation plan is ready before this request can be approved (waiting on: ${unconfirmed.map((a) => (a.teamId ? `Team: ${a.teamName}` : a.name || a.email)).join(", ")})`);
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

  // Email/Teams sends are slow relative to a request-response cycle and
  // already self-log on failure — don't make the caller (the action route,
  // or the one-click email-approval link) wait on them.
  if (action === "REJECT") {
    void notifyCustomRequestDecision({
      submissionId: submission.id,
      requestTypeName: submission.request_type_name,
      requesterEmail: submission.requester_email,
      requesterName: submission.requester_name,
      decision: "REJECTED",
      decidedBy: actor.fullName ?? null,
      comment: comment ?? null
    });
  } else if (newStatus === "APPROVED") {
    void notifyCustomRequestDecision({
      submissionId: submission.id,
      requestTypeName: submission.request_type_name,
      requesterEmail: submission.requester_email,
      requesterName: submission.requester_name,
      decision: "APPROVED",
      decidedBy: actor.fullName ?? null,
      comment: comment ?? null
    });
  } else {
    const nextStep = chain[newStepOrder];
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
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId) {
      throw forbidden("Only the requester can cancel this request");
    }
    if (submission.status !== "IN_PROGRESS") throw badRequest("Only a request that is still pending approval can be cancelled");

    await query(
      `UPDATE custom_request_submissions
          SET status = 'CANCELLED', cancel_comment = $1, cancelled_at = now(), updated_at = now()
        WHERE id = $2`,
      [parsed.data.comment, submission.id]
    );

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
    if (req.user!.role !== "ADMIN" && submission.requester_id !== req.user!.userId) {
      throw forbidden("Only the requester can close this request");
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
