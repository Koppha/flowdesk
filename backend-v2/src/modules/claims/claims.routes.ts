import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import multer from "multer";
import { AuthedRequest, requireAuth, requireRole } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { assertUserCanRequest } from "../../lib/userProfile.js";
import { notifyClaimTask } from "../../lib/notifications.js";
import { getActiveManagerDelegation } from "../../lib/delegations.js";
import { isTravelAdvanceType } from "../../lib/travel.js";
import { canApproveStep, getPendingGroup, resolveWorkflowChain, type ChainStep } from "../../lib/workflowEngine.js";
import { getManagerChainIds } from "../reporting-lines/reporting-lines.routes.js";
import {
  type ClaimStatus,
  nextClaimStatus,
  chainStepToClaimStatus,
  getClaimById,
  advanceClaimWorkflowStep
} from "./claims.service.js";

export { nextClaimStatus };

export const claimsRouter = Router();
claimsRouter.use(requireAuth);

const ActionCommentSchema = z.object({
  comments: z.string().trim().min(1, "comments are required")
});

const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replaceAll(" ", "_")}`)
});
const upload = multer({ storage });

async function getClaimNotificationContext(claimId: string) {
  return (
    await query<{ full_name: string | null; email: string | null; department: string | null; claim_total: string; status: ClaimStatus }>(
      `SELECT u.full_name, u.email, u.department, c.claim_total, c.status
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
        WHERE c.id = $1`,
      [claimId]
    )
  )[0] ?? null;
}

async function getLinkedAdvance(linkedAdvanceId: string, claimantId: string, excludeClaimId?: string) {
  const adv = (await query<{ id: string; requester_id: string; type: string; status: string; approved_total: string }>(
    `SELECT id, requester_id, type, status, approved_total
       FROM advance_requests
      WHERE id=$1`,
    [linkedAdvanceId]
  ))[0];

  if (!adv) throw badRequest("Linked advance not found");
  if (adv.requester_id !== claimantId) throw forbidden("You can only clear your own advance");
  if (!(await isTravelAdvanceType(adv.type))) throw badRequest("Only travel advances can be cleared here");
  if (adv.status !== "PAID") throw badRequest("Linked advance must be finance-approved before clearance");

  const existing = await query<{ id: string }>(
    `SELECT id FROM clearance_claims WHERE linked_advance_id=$1 AND status != 'REJECTED'`
      + (excludeClaimId ? ` AND id != $2` : ``),
    excludeClaimId ? [linkedAdvanceId, excludeClaimId] : [linkedAdvanceId]
  );
  if (existing.length > 0) throw badRequest("A clearance has already been submitted for this advance");

  return { approvedTotal: Number(adv.approved_total) };
}

async function syncClaimTripsFromAdvance(claimId: string, linkedAdvanceId: string) {
  const advanceLines = await query<{ line_date: string; location: string | null; lunch: string; dinner: string }>(
    `SELECT line_date, location, lunch, dinner
       FROM advance_lines
      WHERE advance_request_id=$1
      ORDER BY line_date`,
    [linkedAdvanceId]
  );

  await query(`DELETE FROM claim_trips WHERE clearance_claim_id=$1`, [claimId]);

  for (const line of advanceLines) {
    const lineTotal = Number(line.lunch || 0) + Number(line.dinner || 0);
    await query(
      `INSERT INTO claim_trips
       (clearance_claim_id, trip_date, from_place, to_place, depart_time, arrive_time, km_travelled, petrol_allowance,
        breakfast, lunch, dinner, other_expenses, purpose, line_total)
       VALUES ($1,$2,$3,null,null,null,0,0,0,$4,$5,0,null,$6)`,
      [
        claimId,
        line.line_date,
        line.location ?? null,
        Number(line.lunch || 0),
        Number(line.dinner || 0),
        lineTotal
      ]
    );
  }

  const claimTotal = Number(
    advanceLines.reduce((sum, line) => sum + Number(line.lunch || 0) + Number(line.dinner || 0), 0).toFixed(2)
  );
  return { claimTotal };
}

export function canViewClaim(args: { role: string; claimantId: string; userId: string; approvalChain?: ChainStep[] | null; managerChainIds?: string[] }) {
  if (args.role === "ADMIN") return true;
  if (args.claimantId === args.userId) return true;

  // Anyone in the workflow's resolved approval chain can view
  if (args.approvalChain?.length) {
    if (args.approvalChain.some(s => s.approver_id === args.userId)) return true;
  }

  // Anyone in the claimant's management chain (org structure) can view
  if (args.managerChainIds?.includes(args.userId)) return true;

  return false;
}

claimsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const mine = req.query.mine === "true";
    if (mine) {
      const rows = await query(`SELECT * FROM clearance_claims WHERE claimant_id=$1 ORDER BY created_at DESC`, [req.user!.userId]);
      return res.json(rows);
    }
    if (req.user!.role !== "ADMIN") throw forbidden("Only admin can list all claims");
    const rows = await query(`SELECT * FROM clearance_claims ORDER BY created_at DESC`);
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    await assertUserCanRequest(req.user!.userId);
    const parsed = z
      .object({
        month: z.string().optional(),
        duty_station: z.string().optional(),
        project_number: z.string().optional(),
        vehicle_reg: z.string().optional(),
        vehicle_type: z.string().optional(),
        engine_cc: z.string().optional(),
        vehicle_rate: z.number().optional(),
        linked_advance_id: z.string().uuid().optional()
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    let advanceAmount = 0;
    let claimTotal = 0;
    if (parsed.data.linked_advance_id) {
      const linkedAdvance = await getLinkedAdvance(parsed.data.linked_advance_id, req.user!.userId);
      advanceAmount = linkedAdvance.approvedTotal;
    }

    const rows = await query<{ id: string }>(
      `INSERT INTO clearance_claims
        (claimant_id, month, duty_station, project_number, vehicle_reg, vehicle_type, engine_cc, vehicle_rate, linked_advance_id, advance_amount, claim_total, balance_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        req.user!.userId,
        parsed.data.month ?? null,
        parsed.data.duty_station ?? null,
        parsed.data.project_number ?? null,
        parsed.data.vehicle_reg ?? null,
        parsed.data.vehicle_type ?? null,
        parsed.data.engine_cc ?? null,
        parsed.data.vehicle_rate ?? null,
        parsed.data.linked_advance_id ?? null,
        advanceAmount,
        claimTotal,
        Number((advanceAmount - claimTotal).toFixed(2))
      ]
    );

    if (parsed.data.linked_advance_id) {
      const synced = await syncClaimTripsFromAdvance(rows[0].id, parsed.data.linked_advance_id);
      claimTotal = synced.claimTotal;
      await query(
        `UPDATE clearance_claims
            SET claim_total=$2,
                balance_amount=$3,
                updated_at=now()
          WHERE id=$1`,
        [rows[0].id, claimTotal, Number((advanceAmount - claimTotal).toFixed(2))]
      );
    }

    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM clearance_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    const managerChainIds = await getManagerChainIds(claim.claimant_id);
    if (!canViewClaim({ role: req.user!.role, claimantId: claim.claimant_id, userId: req.user!.userId, approvalChain: claim.approval_chain, managerChainIds })) {
      throw forbidden();
    }

    const trips = await query<any>(`SELECT * FROM claim_trips WHERE clearance_claim_id=$1 ORDER BY trip_date`, [req.params.id]);
    const receipts = await query<any>(`SELECT * FROM receipts WHERE clearance_claim_id=$1 ORDER BY uploaded_at`, [req.params.id]);
    return res.json({ ...claim, trips, receipts });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await assertUserCanRequest(req.user!.userId);
    const claim = (await query<{ claimant_id: string; status: ClaimStatus; claim_total: string }>(
      `SELECT claimant_id, status, claim_total FROM clearance_claims WHERE id=$1`,
      [req.params.id]
    ))[0];
    if (!claim) throw notFound();
    if (claim.claimant_id !== req.user!.userId) throw forbidden("Only claimant can edit");
    if (claim.status !== "DRAFT") throw badRequest("Cannot edit after submit");

    const parsed = z
      .object({
        month: z.string().optional(),
        duty_station: z.string().optional(),
        project_number: z.string().optional(),
        vehicle_reg: z.string().optional(),
        vehicle_type: z.string().optional(),
        engine_cc: z.string().optional(),
        vehicle_rate: z.number().optional(),
        linked_advance_id: z.string().uuid().optional()
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    let advanceAmount = 0;
    let claimTotal = 0;
    if (parsed.data.linked_advance_id) {
      const linkedAdvance = await getLinkedAdvance(parsed.data.linked_advance_id, req.user!.userId, req.params.id);
      advanceAmount = linkedAdvance.approvedTotal;
      const synced = await syncClaimTripsFromAdvance(req.params.id, parsed.data.linked_advance_id);
      claimTotal = synced.claimTotal;
    } else {
      claimTotal = 0;
      await query(`DELETE FROM claim_trips WHERE clearance_claim_id=$1`, [req.params.id]);
    }

    const balanceAmount = Number((advanceAmount - claimTotal).toFixed(2));
    await query(
      `UPDATE clearance_claims
          SET month=$2,
              duty_station=$3,
              project_number=$4,
              vehicle_reg=$5,
              vehicle_type=$6,
              engine_cc=$7,
              vehicle_rate=$8,
              linked_advance_id=$9,
              advance_amount=$10,
              balance_amount=$11,
              updated_at=now()
        WHERE id=$1`,
      [
        req.params.id,
        parsed.data.month ?? null,
        parsed.data.duty_station ?? null,
        parsed.data.project_number ?? null,
        parsed.data.vehicle_reg ?? null,
        parsed.data.vehicle_type ?? null,
        parsed.data.engine_cc ?? null,
        parsed.data.vehicle_rate ?? null,
        parsed.data.linked_advance_id ?? null,
        advanceAmount,
        balanceAmount
      ]
    );

    return res.json({ ok: true, advance_amount: advanceAmount, balance_amount: balanceAmount });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.put("/:id/trips", async (req: AuthedRequest, res, next) => {
  try {
    await assertUserCanRequest(req.user!.userId);
    const claim = (await query<{ claimant_id: string; status: ClaimStatus; advance_amount: string }>(
      `SELECT claimant_id, status, advance_amount FROM clearance_claims WHERE id=$1`,
      [req.params.id]
    ))[0];
    if (!claim) throw notFound();
    if (claim.claimant_id !== req.user!.userId) throw forbidden("Only claimant can edit");
    if (claim.status !== "DRAFT") throw badRequest("Cannot edit after submit");

    const parsed = z
      .object({
        trips: z.array(
          z.object({
            trip_date: z.string(),
            from_place: z.string().optional(),
            to_place: z.string().optional(),
            depart_time: z.string().optional(),
            arrive_time: z.string().optional(),
            km_travelled: z.number().nonnegative().default(0),
            petrol_allowance: z.number().nonnegative().default(0),
            breakfast: z.number().nonnegative().default(0),
            lunch: z.number().nonnegative().default(0),
            dinner: z.number().nonnegative().default(0),
            other_expenses: z.number().nonnegative().default(0),
            purpose: z.string().optional()
          })
        )
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    await query(`DELETE FROM claim_trips WHERE clearance_claim_id=$1`, [req.params.id]);

    for (const trip of parsed.data.trips) {
      const lineTotal =
        (trip.petrol_allowance || 0) +
        (trip.breakfast || 0) +
        (trip.lunch || 0) +
        (trip.dinner || 0) +
        (trip.other_expenses || 0);

      await query(
        `INSERT INTO claim_trips
         (clearance_claim_id, trip_date, from_place, to_place, depart_time, arrive_time, km_travelled, petrol_allowance,
          breakfast, lunch, dinner, other_expenses, purpose, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          req.params.id,
          trip.trip_date,
          trip.from_place ?? null,
          trip.to_place ?? null,
          trip.depart_time ?? null,
          trip.arrive_time ?? null,
          trip.km_travelled,
          trip.petrol_allowance,
          trip.breakfast,
          trip.lunch,
          trip.dinner,
          trip.other_expenses,
          trip.purpose ?? null,
          lineTotal
        ]
      );
    }

    const claimTotal = Number(
      parsed.data.trips
        .reduce(
          (sum, trip) =>
            sum +
            (trip.petrol_allowance || 0) +
            (trip.breakfast || 0) +
            (trip.lunch || 0) +
            (trip.dinner || 0) +
            (trip.other_expenses || 0),
          0
        )
        .toFixed(2)
    );
    const advanceAmount = Number(claim.advance_amount || 0);
    const balanceAmount = Number((advanceAmount - claimTotal).toFixed(2));

    await query(
      `UPDATE clearance_claims
          SET claim_total=$2,
              balance_amount=$3,
              updated_at=now()
        WHERE id=$1`,
      [req.params.id, claimTotal, balanceAmount]
    );

    return res.json({ ok: true, claim_total: claimTotal, balance_amount: balanceAmount });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/upload-receipt", upload.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<{ claimant_id: string; status: ClaimStatus }>(
      `SELECT claimant_id, status FROM clearance_claims WHERE id=$1`,
      [req.params.id]
    ))[0];
    if (!claim) throw notFound();
    if (claim.claimant_id !== req.user!.userId) throw forbidden("Only claimant can upload");
    if (claim.status !== "DRAFT") throw badRequest("Cannot upload after submit");
    if (!req.file) throw badRequest("Missing file");

    const meta = z
      .object({
        category: z.string().optional(),
        amount: z.coerce.number().optional(),
        notes: z.string().optional()
      })
      .safeParse(req.body);

    const rows = await query<any>(
      `INSERT INTO receipts (clearance_claim_id, file_path, category, amount, notes)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        req.params.id,
        req.file.path,
        meta.success ? meta.data.category ?? null : null,
        meta.success ? meta.data.amount ?? null : null,
        meta.success ? meta.data.notes ?? null : null
      ]
    );

    return res.json({ ok: true, receipt: rows[0] });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    await assertUserCanRequest(req.user!.userId);
    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    if (claim.claimant_id !== req.user!.userId) throw forbidden("Only claimant can submit");
    if (claim.status !== "DRAFT") throw badRequest("Already submitted");
    if (!claim.linked_advance_id) throw badRequest("Select the approved advance being cleared");
    if (Number(claim.claim_total) <= 0) throw badRequest("Clearance total must be > 0");

    // Resolve the workflow for clearance requests in the claimant's department/section.
    const workflowResult = await resolveWorkflowChain({
      requestType: "CLEARANCE_REQUEST",
      department: claim.claimant_department || "",
      section: claim.claimant_section || ""
    });

    let status: ClaimStatus = "SUBMITTED";
    if (workflowResult && workflowResult.chain.length > 0) {
      const { workflowId, chain } = workflowResult;
      status = chainStepToClaimStatus(chain, 0);
      await query(
        `UPDATE clearance_claims SET
           status=$2, submitted_at=now(), updated_at=now(),
           workflow_id=$3, workflow_step_order=$4, approval_chain=$5
         WHERE id=$1`,
        [req.params.id, status, workflowId, 0, JSON.stringify(chain)]
      );
    } else {
      await query(`UPDATE clearance_claims SET status='SUBMITTED', submitted_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
    }

    const notificationContext = await getClaimNotificationContext(req.params.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: req.params.id,
        status,
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total)
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

// Generic workflow-driven approve/reject — used by clearances that follow a
// dynamic workflow (e.g. "Travel Clearance DT") configured in the Workflow
// Builder. Mirrors POST /advances/:id/approve and /:id/reject.
claimsRouter.post("/:id/approve", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    if (!claim.approval_chain?.length) {
      throw badRequest("This clearance does not follow a dynamic approval workflow.");
    }

    const role = req.user!.role;
    const userId = req.user!.userId;
    const delegated = await getActiveManagerDelegation(userId);

    const result = await advanceClaimWorkflowStep({
      claim,
      userId,
      role,
      delegatedManagerId: delegated?.manager_id,
      userDepartment: req.user!.department
    });

    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status: result.nextStatus,
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total)
      });
    }
    return res.json({ ok: true, status: result.nextStatus });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/reject", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ comments: z.string().min(1, "Comments are required") }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for reject", parsed.error.flatten());

    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    if (!claim.approval_chain?.length) {
      throw badRequest("This clearance does not follow a dynamic approval workflow.");
    }

    const chain = claim.approval_chain as ChainStep[];
    const stepIdx = claim.workflow_step_order ?? 0;
    const group = getPendingGroup(chain, stepIdx);
    if (!group.indices.length) throw badRequest("No active workflow step to reject");

    const role = req.user!.role;
    const userId = req.user!.userId;
    const delegated = await getActiveManagerDelegation(userId);
    if (role !== "ADMIN") {
      let currentStep: ChainStep | undefined;
      for (const idx of group.indices) {
        if (await canApproveStep(chain[idx], userId, role, delegated?.manager_id, req.user!.department)) { currentStep = chain[idx]; break; }
      }
      if (!currentStep) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);
    }

    await query(`UPDATE clearance_claims SET status='REJECTED', updated_at=now() WHERE id=$1`, [claim.id]);
    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status: "REJECTED",
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total)
      });
    }
    return res.json({ ok: true, status: "REJECTED" });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/rollback", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = ActionCommentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for rollback", parsed.error.flatten());

    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    if (!claim.approval_chain?.length) {
      throw badRequest("This clearance does not follow a dynamic approval workflow.");
    }

    const chain = claim.approval_chain as ChainStep[];
    const stepIdx = claim.workflow_step_order ?? 0;
    const group = getPendingGroup(chain, stepIdx);
    if (!group.indices.length) throw badRequest("No active workflow step to roll back");

    const role = req.user!.role;
    const userId = req.user!.userId;
    const delegated = await getActiveManagerDelegation(userId);
    if (role !== "ADMIN") {
      let currentStep: ChainStep | undefined;
      for (const idx of group.indices) {
        if (await canApproveStep(chain[idx], userId, role, delegated?.manager_id, req.user!.department)) { currentStep = chain[idx]; break; }
      }
      if (!currentStep) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);
    }

    await query(
      `UPDATE clearance_claims SET
         status='DRAFT', workflow_id=NULL, workflow_step_order=NULL, approval_chain=NULL, updated_at=now()
       WHERE id=$1`,
      [claim.id]
    );

    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status: "DRAFT",
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total)
      });
    }
    return res.json({ ok: true, status: "DRAFT" });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/settle", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ settled_method: z.enum(["ECOCASH", "BANK", "CASH", "OTHER"]), settled_reference: z.string().min(1) }).safeParse(req.body);
    if (!body.success) throw badRequest("Invalid payload", body.error.flatten());

    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    const status = nextClaimStatus(claim.status, "SETTLE");
    await query(
      `UPDATE clearance_claims
       SET status=$2, settled_method=$3, settled_reference=$4, settled_at=now(), updated_at=now()
       WHERE id=$1`,
      [claim.id, status, body.data.settled_method, body.data.settled_reference]
    );
    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status,
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total)
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});
