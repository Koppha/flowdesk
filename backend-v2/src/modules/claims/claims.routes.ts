import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import multer from "multer";
import { AuthedRequest, hasFeatureAccess, requireAuth, requireFinance, requireRole } from "../../lib/auth.js";
import { isCompensationFinanceSection } from "../../lib/financeAuthority.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";
import { assertUserCanRequest } from "../../lib/userProfile.js";
import { notifyClaimTask } from "../../lib/notifications.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";
import { getDelegatedManagerIds } from "../../lib/delegations.js";
import { isTravelAdvanceType } from "../../lib/travel.js";
import { canApproveStep, getPendingGroup, resolveWorkflowChain, type ChainStep } from "../../lib/workflowEngine.js";
import { getManagerChainIds } from "../reporting-lines/reporting-lines.routes.js";
import { getUserGroups } from "../../lib/permissionGroups.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { resolveClaimPdfData, getFieldCatalogFor } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";
import {
  type ClaimStatus,
  type FinanceDecision,
  nextClaimStatus,
  nextStatusForFinanceDecision,
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
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeUploadFilename(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["pdf", "jpg", "jpeg", "png"])
});

export async function getClaimNotificationContext(claimId: string) {
  return (
    await query<{ full_name: string | null; email: string | null; department: string | null; claim_total: string; status: ClaimStatus; claim_type: string | null; currency: string | null }>(
      `SELECT u.full_name, u.email, u.department, c.claim_total, c.status, ar.type AS claim_type, c.currency
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN advance_requests ar ON ar.id = c.linked_advance_id
        WHERE c.id = $1`,
      [claimId]
    )
  )[0] ?? null;
}

async function getLinkedAdvance(linkedAdvanceId: string, claimantId: string, excludeClaimId?: string) {
  const adv = (await query<{ id: string; requester_id: string; type: string; status: string; approved_total: string; currency: string | null }>(
    `SELECT ar.id, ar.requester_id, ar.type, ar.status, ar.approved_total, tt.currency
       FROM advance_requests ar
       LEFT JOIN travel_types tt ON tt.code = ar.type
      WHERE ar.id=$1`,
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

  // A clearance always sticks with the currency the linked advance was
  // requested in — never a separate/default currency.
  return { approvedTotal: Number(adv.approved_total), currency: adv.currency || "LSL" };
}

async function syncClaimTripsFromAdvance(claimId: string, linkedAdvanceId: string) {
  const advanceLines = await query<{ line_date: string; location: string | null; lunch: string; dinner: string }>(
    `SELECT line_date, location, lunch, dinner
       FROM advance_lines
      WHERE advance_request_id=$1
      ORDER BY line_date`,
    [linkedAdvanceId]
  );

  // Delete + per-line insert run in one transaction — previously separate
  // unwrapped calls, so a crash/restart mid-loop could leave the claim with
  // only some of its trip lines while claim_total (computed below from the
  // full set) is written as if all of them were persisted.
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM claim_trips WHERE clearance_claim_id=$1`, [claimId]);

    for (const line of advanceLines) {
      const lineTotal = Number(line.lunch || 0) + Number(line.dinner || 0);
      await client.query(
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
  });

  const claimTotal = Number(
    advanceLines.reduce((sum, line) => sum + Number(line.lunch || 0) + Number(line.dinner || 0), 0).toFixed(2)
  );
  return { claimTotal };
}

export async function canViewClaim(args: { role: string; sectionId?: string | null; status?: string; claimantId: string; userId: string; approvalChain?: ChainStep[] | null; workflowStepOrder?: number | null; managerChainIds?: string[]; delegatedManagerIds?: string[] | null }) {
  if (args.role === "ADMIN") return true;
  if (args.claimantId === args.userId) return true;

  // Anyone in the workflow's resolved approval chain can view — but only
  // once the chain has actually reached them, same "reached, not future"
  // cutoff as canViewAdvance (advances.routes.ts) and for the same reason:
  // without it, an approver named several stages ahead could open the
  // claim's full detail before anyone earlier in the chain had acted.
  if (args.approvalChain?.length) {
    const chain = args.approvalChain;
    const group = getPendingGroup(chain, args.workflowStepOrder ?? 0);
    const maxReachedIdx = group.indices.length ? Math.max(...group.indices) : chain.length - 1;
    const reached = chain.slice(0, maxReachedIdx + 1);
    if (reached.some(s => s.approver_id === args.userId)) return true;
    // A delegate can view any reached step whose assigned approver(s)
    // delegated to them - same match rule as canApproveStep, so a delegate
    // never gets a "forbidden" screen for the exact claim they're standing
    // in for their manager on.
    if (args.delegatedManagerIds?.length) {
      const isDelegatedStep = reached.some(s => {
        const assignedIds = s.approver_ids?.length ? s.approver_ids : [s.approver_id];
        return args.delegatedManagerIds!.some(id => assignedIds.includes(id));
      });
      if (isDelegatedStep) return true;
    }
    // "Team: X" (ANY_ONE) steps list the department HOD as approver_id for
    // routing purposes, but any member of that permission group is a real
    // participant in the chain and should be able to track the request —
    // once reached, same cutoff as above.
    if (reached.some(s => s.approval_group_name)) {
      const groups = await getUserGroups(args.userId);
      if (reached.some(s => s.approval_group_name && groups.includes(s.approval_group_name))) return true;
    }
  }

  // FINANCE_VERIFIED/PAYMENT_PROCESSING/CLOSED claims have left the active
  // workflow chain and now sit with Finance/HR/EXCO/Managers awaiting (or
  // having completed) settlement — those are the same roles allowedInboxForRole
  // lists this status for, so let them view it.
  if (["FINANCE_VERIFIED", "PAYMENT_PROCESSING", "CLOSED"].includes(args.status || "") && ((await isCompensationFinanceSection(args.sectionId)) || ["MANAGER", "EXCO"].includes(args.role))) {
    return true;
  }

  // NOTE: this used to also grant view access to anyone in the claimant's
  // management chain (org structure), unconditionally - removed for the
  // same reason as canViewAdvance's equivalent grant: it let a department's
  // EXCO/HOD see a subordinate's claim before the workflow had reached
  // them. managerChainIds is kept as a parameter (now unused here) rather
  // than removed from every call site.

  return false;
}

claimsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const mine = req.query.mine === "true";
    if (mine) {
      const rows = await query(
        `SELECT cc.*, u.full_name AS requester_name, u.full_name AS claimant_name, u.department AS department
           FROM clearance_claims cc
           JOIN users u ON u.id = cc.claimant_id
          WHERE cc.claimant_id=$1
          ORDER BY cc.created_at DESC`,
        [req.user!.userId]
      );
      return res.json(rows);
    }
    const allowed = await hasFeatureAccess(req.user!.userId, req.user!.role, "report_advances", ["ADMIN"]);
    if (!allowed) throw forbidden("Not authorized to list all claims");
    const rows = await query(
      `SELECT cc.*, u.full_name AS requester_name, u.full_name AS claimant_name, u.department AS department
         FROM clearance_claims cc
         JOIN users u ON u.id = cc.claimant_id
        ORDER BY cc.created_at DESC`
    );
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
        linked_advance_id: z.string().uuid().optional(),
        settlement_method_requested: z.string().optional(),
        settlement_ecocash_number: z.string().optional(),
        settlement_bank_name: z.string().optional(),
        settlement_bank_account_number: z.string().optional(),
        settlement_bank_branch: z.string().optional(),
        reason_for_overspend: z.string().optional()
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    let advanceAmount = 0;
    let claimTotal = 0;
    let currency: string | null = null;
    if (parsed.data.linked_advance_id) {
      const linkedAdvance = await getLinkedAdvance(parsed.data.linked_advance_id, req.user!.userId);
      advanceAmount = linkedAdvance.approvedTotal;
      currency = linkedAdvance.currency;
    }

    const rows = await query<{ id: string }>(
      `INSERT INTO clearance_claims
        (claimant_id, month, duty_station, project_number, vehicle_reg, vehicle_type, engine_cc, vehicle_rate, linked_advance_id, advance_amount, claim_total, balance_amount, currency, settlement_method_requested, settlement_ecocash_number, settlement_bank_name, settlement_bank_account_number, settlement_bank_branch, reason_for_overspend)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
        Number((advanceAmount - claimTotal).toFixed(2)),
        currency,
        parsed.data.settlement_method_requested ?? null,
        parsed.data.settlement_ecocash_number ?? null,
        parsed.data.settlement_bank_name ?? null,
        parsed.data.settlement_bank_account_number ?? null,
        parsed.data.settlement_bank_branch ?? null,
        parsed.data.reason_for_overspend ?? null
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
    const delegatedManagerIds = await getDelegatedManagerIds(req.user!.userId, "CLEARANCE_REQUEST");
    if (!(await canViewClaim({ role: req.user!.role, sectionId: req.user!.sectionId, status: claim.status, claimantId: claim.claimant_id, userId: req.user!.userId, approvalChain: claim.approval_chain, workflowStepOrder: claim.workflow_step_order, managerChainIds, delegatedManagerIds }))) {
      throw forbidden();
    }

    const trips = await query<any>(`SELECT * FROM claim_trips WHERE clearance_claim_id=$1 ORDER BY trip_date`, [req.params.id]);
    const receiptRows = await query<any>(`SELECT * FROM receipts WHERE clearance_claim_id=$1 ORDER BY uploaded_at`, [req.params.id]);
    const receipts = receiptRows.map((r) => {
      let size_bytes: number | null = null;
      try {
        size_bytes = fs.statSync(r.file_path).size;
      } catch {
        size_bytes = null;
      }
      return { ...r, file_name: path.basename(r.file_path).replace(/^\d+-/, ""), size_bytes };
    });
    const isOwner = claim.claimant_id === req.user!.userId;
    const can_view_pdf = await canAccessPdf({ requestType: "CLEARANCE_CLAIM", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" });
    return res.json({ ...claim, trips, receipts, can_view_pdf });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.get("/:id/receipts/:receiptId/file", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM clearance_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    const managerChainIds = await getManagerChainIds(claim.claimant_id);
    const delegatedManagerIds = await getDelegatedManagerIds(req.user!.userId, "CLEARANCE_REQUEST");
    if (!(await canViewClaim({ role: req.user!.role, sectionId: req.user!.sectionId, status: claim.status, claimantId: claim.claimant_id, userId: req.user!.userId, approvalChain: claim.approval_chain, workflowStepOrder: claim.workflow_step_order, managerChainIds, delegatedManagerIds }))) {
      throw forbidden();
    }
    const receipt = (await query<any>(`SELECT * FROM receipts WHERE id=$1 AND clearance_claim_id=$2`, [req.params.receiptId, req.params.id]))[0];
    if (!receipt) throw notFound();
    if (!fs.existsSync(receipt.file_path)) throw notFound();

    const ext = path.extname(receipt.file_path).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    };
    const fileName = path.basename(receipt.file_path).replace(/^\d+-/, "");
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", contentTypes[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", `${disposition}; filename="${fileName}"`);
    fs.createReadStream(receipt.file_path).pipe(res);
  } catch (err) {
    return next(err);
  }
});

claimsRouter.get("/:id/pdf", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM clearance_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    const managerChainIds = await getManagerChainIds(claim.claimant_id);
    const delegatedManagerIds = await getDelegatedManagerIds(req.user!.userId, "CLEARANCE_REQUEST");
    if (!(await canViewClaim({ role: req.user!.role, sectionId: req.user!.sectionId, status: claim.status, claimantId: claim.claimant_id, userId: req.user!.userId, approvalChain: claim.approval_chain, workflowStepOrder: claim.workflow_step_order, managerChainIds, delegatedManagerIds }))) {
      throw forbidden();
    }
    const isOwner = claim.claimant_id === req.user!.userId;
    if (!(await canAccessPdf({ requestType: "CLEARANCE_CLAIM", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" }))) {
      throw forbidden();
    }

    const template = (await query<any>(`SELECT * FROM pdf_templates WHERE request_type = 'CLEARANCE_CLAIM' AND status = 'ACTIVE' LIMIT 1`))[0];
    if (!template) throw badRequest("No PDF template configured for clearance claims yet.");

    const data = await resolveClaimPdfData(req.params.id);
    const catalog = await getFieldCatalogFor("CLEARANCE_CLAIM");
    const letterhead = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
    };
    const doc = renderPdfTemplate(template, letterhead, data, catalog);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="clearance-${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.end();
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
        linked_advance_id: z.string().uuid().optional(),
        settlement_method_requested: z.string().optional(),
        settlement_ecocash_number: z.string().optional(),
        settlement_bank_name: z.string().optional(),
        settlement_bank_account_number: z.string().optional(),
        settlement_bank_branch: z.string().optional(),
        reason_for_overspend: z.string().optional()
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());

    let advanceAmount = 0;
    let claimTotal = 0;
    let currency: string | null = null;
    if (parsed.data.linked_advance_id) {
      const linkedAdvance = await getLinkedAdvance(parsed.data.linked_advance_id, req.user!.userId, req.params.id);
      advanceAmount = linkedAdvance.approvedTotal;
      currency = linkedAdvance.currency;
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
              currency=$12,
              settlement_method_requested=$13,
              settlement_ecocash_number=$14,
              settlement_bank_name=$15,
              settlement_bank_account_number=$16,
              settlement_bank_branch=$17,
              reason_for_overspend=$18,
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
        balanceAmount,
        currency,
        parsed.data.settlement_method_requested ?? null,
        parsed.data.settlement_ecocash_number ?? null,
        parsed.data.settlement_bank_name ?? null,
        parsed.data.settlement_bank_account_number ?? null,
        parsed.data.settlement_bank_branch ?? null,
        parsed.data.reason_for_overspend ?? null
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

// Lets the claimant remove a wrongly-attached file while the claim is still
// a DRAFT — mirrors the upload route's same ownership/status gate.
claimsRouter.delete("/:id/receipts/:receiptId", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<{ claimant_id: string; status: ClaimStatus }>(
      `SELECT claimant_id, status FROM clearance_claims WHERE id=$1`,
      [req.params.id]
    ))[0];
    if (!claim) throw notFound();
    if (claim.claimant_id !== req.user!.userId) throw forbidden("Only claimant can remove a receipt");
    if (claim.status !== "DRAFT") throw badRequest("Cannot remove a receipt after submit");

    const rows = await query<{ file_path: string }>(
      `DELETE FROM receipts WHERE id=$1 AND clearance_claim_id=$2 RETURNING file_path`,
      [req.params.receiptId, req.params.id]
    );
    if (!rows[0]) throw notFound();

    fs.unlink(rows[0].file_path, () => {
      // best-effort — the DB row is already gone either way
    });

    return res.json({ ok: true });
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
    // balance_amount < 0 means actual expenditure exceeded the advance (the
    // company owes the employee) — require an explanation before submitting.
    if (Number(claim.balance_amount || 0) < 0 && !String(claim.reason_for_overspend || "").trim()) {
      throw badRequest("Please provide a reason for the overspend before submitting.");
    }

    // Resolve the workflow for clearance requests in the claimant's department/section.
    // A clearance always sticks with the linked advance's travel type — passed
    // through as advanceSubType so a workflow scoped to a specific travel type
    // (e.g. an "International Clearance" workflow for TRAVEL_TO_EUROPE/USA/etc.)
    // outranks the generic "TRAVEL" clearance bucket, mirroring how advance
    // requests themselves are routed.
    const linkedAdvance = (await query<{ type: string }>(
      `SELECT type FROM advance_requests WHERE id = $1`,
      [claim.linked_advance_id]
    ))[0];
    const workflowResult = await resolveWorkflowChain({
      requestType: "CLEARANCE_REQUEST",
      department: claim.claimant_department || "",
      section: claim.claimant_section || "",
      advanceSubType: linkedAdvance?.type,
      requesterId: claim.claimant_id
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
        claimTotal: Number(notificationContext.claim_total),
        currency: notificationContext.currency,
        claimType: notificationContext.claim_type
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
// Shared by POST /:id/approve and the email-approval flow (email-actions.routes.ts).
export async function performClaimApprove(
  claimId: string,
  actor: { userId: string; role: string; sectionId: string | null }
): Promise<{ status: string }> {
  const claim = await getClaimById(claimId);
  if (!claim) throw notFound();
  if (!claim.approval_chain?.length) {
    throw badRequest("This clearance does not follow a dynamic approval workflow.");
  }

  const { role, userId, sectionId } = actor;
  const delegatedManagerIds = await getDelegatedManagerIds(userId, "CLEARANCE_REQUEST");

  const result = await advanceClaimWorkflowStep({
    claim,
    userId,
    role,
    delegatedManagerIds,
    userSectionId: sectionId
  });

  const notificationContext = await getClaimNotificationContext(claim.id);
  if (notificationContext) {
    await notifyClaimTask({
      claimId: claim.id,
      status: result.nextStatus,
      claimantName: notificationContext.full_name,
      claimantEmail: notificationContext.email,
      department: notificationContext.department,
      claimTotal: Number(notificationContext.claim_total),
      currency: notificationContext.currency,
      claimType: notificationContext.claim_type,
      nextApprover: result.nextApprover,
      stepOrder: result.newStepOrder
    });
    // A step can have more than one assigned person — notify the rest of
    // the pending stage too, not just the first (mirrors performAdvanceApprove).
    for (const extra of result.nextApprovers.slice(1)) {
      if (!extra.email) continue;
      await notifyClaimTask({
        claimId: claim.id,
        status: result.nextStatus,
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total),
        currency: notificationContext.currency,
        claimType: notificationContext.claim_type,
        nextApprover: extra,
        stepOrder: result.newStepOrder
      });
    }
  }
  return { status: result.nextStatus };
}

claimsRouter.post("/:id/approve", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const result = await performClaimApprove(req.params.id, {
      userId: req.user!.userId, role: req.user!.role, sectionId: req.user!.sectionId ?? null
    });
    return res.json({ ok: true, status: result.status });
  } catch (err) {
    return next(err);
  }
});

// Shared by POST /:id/reject and the email-approval flow (email-actions.routes.ts).
export async function performClaimReject(
  claimId: string,
  actor: { userId: string; role: string; sectionId: string | null },
  comments: string
): Promise<{ status: string }> {
  const claim = await getClaimById(claimId);
  if (!claim) throw notFound();
  if (!claim.approval_chain?.length) {
    throw badRequest("This clearance does not follow a dynamic approval workflow.");
  }

  const chain = claim.approval_chain as ChainStep[];
  const stepIdx = claim.workflow_step_order ?? 0;
  const group = getPendingGroup(chain, stepIdx);
  if (!group.indices.length) throw badRequest("No active workflow step to reject");

  const { role, userId, sectionId } = actor;
  const delegatedManagerIds = await getDelegatedManagerIds(userId, "CLEARANCE_REQUEST");
  if (role !== "ADMIN") {
    let currentStep: ChainStep | undefined;
    for (const idx of group.indices) {
      if (await canApproveStep(chain[idx], userId, role, delegatedManagerIds, sectionId)) { currentStep = chain[idx]; break; }
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
      claimTotal: Number(notificationContext.claim_total),
      currency: notificationContext.currency,
      claimType: notificationContext.claim_type
    });
  }
  return { status: "REJECTED" };
}

claimsRouter.post("/:id/reject", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ comments: z.string().min(1, "Comments are required") }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Comments are required for reject", parsed.error.flatten());
    const result = await performClaimReject(
      req.params.id,
      { userId: req.user!.userId, role: req.user!.role, sectionId: req.user!.sectionId ?? null },
      parsed.data.comments
    );
    return res.json({ ok: true, status: result.status });
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

    const role = req.user!.role;
    const userId = req.user!.userId;

    // Finance "Request Correction": the claim has already left the dynamic
    // workflow chain (status FINANCE_VERIFIED) by the time Finance acts on
    // it, so there's no pending chain step to gate against — Finance/Admin
    // can send it straight back to DRAFT, same as canViewClaim's Finance access.
    const isFinanceCorrection = claim.status === "FINANCE_VERIFIED" && (role === "ADMIN" || (await isCompensationFinanceSection(req.user!.sectionId)));

    if (!isFinanceCorrection) {
      if (!claim.approval_chain?.length) {
        throw badRequest("This clearance does not follow a dynamic approval workflow.");
      }

      const chain = claim.approval_chain as ChainStep[];
      const stepIdx = claim.workflow_step_order ?? 0;
      const group = getPendingGroup(chain, stepIdx);
      if (!group.indices.length) throw badRequest("No active workflow step to roll back");

      const delegatedManagerIds = await getDelegatedManagerIds(userId, "CLEARANCE_REQUEST");
      if (role !== "ADMIN") {
        let currentStep: ChainStep | undefined;
        for (const idx of group.indices) {
          if (await canApproveStep(chain[idx], userId, role, delegatedManagerIds, req.user!.sectionId)) { currentStep = chain[idx]; break; }
        }
        if (!currentStep) throw forbidden(`You are not the assigned approver for step: ${chain[group.indices[0]].position_name}`);
      }
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
        claimTotal: Number(notificationContext.claim_total),
        currency: notificationContext.currency,
        claimType: notificationContext.claim_type
      });
    }
    return res.json({ ok: true, status: "DRAFT" });
  } catch (err) {
    return next(err);
  }
});

const FinanceDecisionSchema = z.object({
  finance_decision: z.enum(["ACCEPTED", "REFUND_FROM_EMPLOYEE", "REIMBURSE_EMPLOYEE"]),
  finance_comments: z.string().trim().min(1, "Finance comments are required"),
  settlement_amount: z.number().optional(),
  settled_method: z.enum(["PAYROLL", "ECOCASH", "BANK", "CASH", "OTHER"]).optional(),
  settled_reference: z.string().optional(),
  assignee_user_id: z.string().uuid().optional(),
  assignee_group_name: z.string().optional(),
  expected_payment_date: z.string().optional()
});

// Finance's decision on a FINANCE_VERIFIED clearance. "ACCEPTED" (no money
// owed either way) closes the claim immediately; the two settlement
// decisions move it into PAYMENT_PROCESSING, where /:id/mark-settled later
// closes it once payment has actually been made.
claimsRouter.post("/:id/settle", requireFinance, async (req: AuthedRequest, res, next) => {
  try {
    const body = FinanceDecisionSchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid payload", body.error.flatten());

    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    if (claim.status !== "FINANCE_VERIFIED") throw badRequest(`Cannot record a finance decision from status ${claim.status}`);

    const decision: FinanceDecision = body.data.finance_decision;
    if (decision !== "ACCEPTED" && (!body.data.settled_method || !body.data.settled_reference)) {
      throw badRequest("Settlement method and reference are required for this decision");
    }
    const status = nextStatusForFinanceDecision(decision);

    await query(
      `UPDATE clearance_claims
       SET status=$2, finance_decision=$3, finance_comments=$4, settlement_amount=$5,
           settled_method=$6, settled_reference=$7, settled_at=CASE WHEN $6 IS NOT NULL THEN now() ELSE settled_at END,
           assignee_user_id=$8, assignee_group_name=$9, expected_payment_date=$10,
           closed_at=CASE WHEN $2='CLOSED' THEN now() ELSE closed_at END,
           updated_at=now()
       WHERE id=$1`,
      [
        claim.id, status, decision, body.data.finance_comments, body.data.settlement_amount ?? null,
        body.data.settled_method ?? null, body.data.settled_reference ?? null,
        body.data.assignee_user_id ?? null, body.data.assignee_group_name ?? null, body.data.expected_payment_date ?? null
      ]
    );
    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status,
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total),
        currency: notificationContext.currency,
        claimType: notificationContext.claim_type
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

// Finance confirms payment has actually been made for a PAYMENT_PROCESSING
// clearance, closing it out. Mirrors "Mark Advance Paid" for advances.
claimsRouter.post("/:id/mark-settled", requireFinance, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      settled_method: z.enum(["PAYROLL", "ECOCASH", "BANK", "CASH", "OTHER"]).optional(),
      settled_reference: z.string().optional()
    }).safeParse(req.body);
    if (!body.success) throw badRequest("Invalid payload", body.error.flatten());

    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    const status = nextClaimStatus(claim.status, "MARK_SETTLED");

    await query(
      `UPDATE clearance_claims
       SET status=$2,
           settled_method=COALESCE($3, settled_method),
           settled_reference=COALESCE($4, settled_reference),
           settled_at=COALESCE(settled_at, now()),
           closed_at=now(),
           updated_at=now()
       WHERE id=$1`,
      [claim.id, status, body.data.settled_method ?? null, body.data.settled_reference ?? null]
    );
    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status,
        claimantName: notificationContext.full_name,
        claimantEmail: notificationContext.email,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total),
        currency: notificationContext.currency,
        claimType: notificationContext.claim_type
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});
