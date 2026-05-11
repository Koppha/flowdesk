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

export const claimsRouter = Router();
claimsRouter.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replaceAll(" ", "_")}`)
});
const upload = multer({ storage });

type ClaimStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "MANAGER_APPROVED"
  | "CHIEF_OFFICER_APPROVED"
  | "FINANCE_VERIFIED"
  | "SETTLED"
  | "REJECTED";

function nextClaimStatus(current: ClaimStatus, action: "MANAGER_APPROVE" | "CHIEF_APPROVE" | "FINANCE_VERIFY" | "SETTLE") {
  const map: Record<ClaimStatus, Partial<Record<typeof action, ClaimStatus>>> = {
    DRAFT: {},
    SUBMITTED: { MANAGER_APPROVE: "MANAGER_APPROVED" },
    MANAGER_APPROVED: { CHIEF_APPROVE: "CHIEF_OFFICER_APPROVED" },
    CHIEF_OFFICER_APPROVED: { FINANCE_VERIFY: "FINANCE_VERIFIED" },
    FINANCE_VERIFIED: { SETTLE: "SETTLED" },
    SETTLED: {},
    REJECTED: {}
  };
  const next = map[current]?.[action];
  if (!next) throw badRequest(`Invalid transition: ${current} -> ${action}`);
  return next;
}

async function getClaimById(id: string) {
  const claim = (await query<{ id: string; claimant_id: string; status: ClaimStatus }>(`SELECT id, claimant_id, status FROM clearance_claims WHERE id=$1`, [id]))[0];
  return claim ?? null;
}

async function getClaimNotificationContext(claimId: string) {
  return (
    await query<{ full_name: string | null; department: string | null; claim_total: string; status: ClaimStatus }>(
      `SELECT u.full_name, u.department, c.claim_total, c.status
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
        WHERE c.id = $1`,
      [claimId]
    )
  )[0] ?? null;
}

async function getLinkedAdvance(linkedAdvanceId: string, claimantId: string) {
  const adv = (await query<{ id: string; requester_id: string; type: string; status: string; approved_total: string }>(
    `SELECT id, requester_id, type, status, approved_total
       FROM advance_requests
      WHERE id=$1`,
    [linkedAdvanceId]
  ))[0];

  if (!adv) throw badRequest("Linked advance not found");
  if (adv.requester_id !== claimantId) throw forbidden("You can only clear your own advance");
  if (adv.type !== "TRAVEL_SUBSISTENCE") throw badRequest("Only travel advances can be cleared here");
  if (adv.status !== "PAID") throw badRequest("Linked advance must be finance-approved before clearance");
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

function canViewClaim(args: { role: string; claimantId: string; userId: string; status: ClaimStatus }) {
  if (args.role === "ADMIN") return true;
  if (args.claimantId === args.userId) return true;
  if (args.role === "MANAGER" && args.status === "SUBMITTED") return true;
  if (args.role === "CHIEF_OFFICER" && args.status === "MANAGER_APPROVED") return true;
  if (args.role === "AUTH_OFFICER" && ["CHIEF_OFFICER_APPROVED", "FINANCE_VERIFIED"].includes(args.status)) return true;
  if (args.role === "FINANCE" && ["CHIEF_OFFICER_APPROVED", "FINANCE_VERIFIED"].includes(args.status)) return true;
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
    if (!canViewClaim({ role: req.user!.role, claimantId: claim.claimant_id, userId: req.user!.userId, status: claim.status })) {
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
      const linkedAdvance = await getLinkedAdvance(parsed.data.linked_advance_id, req.user!.userId);
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
    const claim = (await query<{ claimant_id: string; status: ClaimStatus; claim_total: string; linked_advance_id: string | null }>(
      `SELECT claimant_id, status, claim_total, linked_advance_id FROM clearance_claims WHERE id=$1`,
      [req.params.id]
    ))[0];
    if (!claim) throw notFound();
    if (claim.claimant_id !== req.user!.userId) throw forbidden("Only claimant can submit");
    if (claim.status !== "DRAFT") throw badRequest("Already submitted");
    if (!claim.linked_advance_id) throw badRequest("Select the approved advance being cleared");
    if (Number(claim.claim_total) <= 0) throw badRequest("Clearance total must be > 0");

    await query(`UPDATE clearance_claims SET status='SUBMITTED', submitted_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
    const notificationContext = await getClaimNotificationContext(req.params.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: req.params.id,
        status: "SUBMITTED",
        claimantName: notificationContext.full_name,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total)
      });
    }
    return res.json({ ok: true, status: "SUBMITTED" });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/manager-approve", async (req: AuthedRequest, res, next) => {
  try {
    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();

    const delegated = await getActiveManagerDelegation(req.user!.userId);
    if (req.user!.role !== "MANAGER" && !delegated) {
      throw forbidden("Only managers or delegated users can approve claims");
    }

    const status = nextClaimStatus(claim.status, "MANAGER_APPROVE");
    await query(`UPDATE clearance_claims SET status=$2, updated_at=now() WHERE id=$1`, [claim.id, status]);
    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status,
        claimantName: notificationContext.full_name,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total)
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/chief-officer-approve", requireRole(["CHIEF_OFFICER", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    const status = nextClaimStatus(claim.status, "CHIEF_APPROVE");
    await query(`UPDATE clearance_claims SET status=$2, updated_at=now() WHERE id=$1`, [claim.id, status]);
    const notificationContext = await getClaimNotificationContext(claim.id);
    if (notificationContext) {
      await notifyClaimTask({
        claimId: claim.id,
        status,
        claimantName: notificationContext.full_name,
        department: notificationContext.department,
        claimTotal: Number(notificationContext.claim_total)
      });
    }
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/finance-verify", requireRole(["FINANCE", "ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const claim = await getClaimById(req.params.id);
    if (!claim) throw notFound();
    const status = nextClaimStatus(claim.status, "FINANCE_VERIFY");
    await query(`UPDATE clearance_claims SET status=$2, updated_at=now() WHERE id=$1`, [claim.id, status]);
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});

claimsRouter.post("/:id/settle", requireRole(["FINANCE", "ADMIN"]), async (req: AuthedRequest, res, next) => {
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
    return res.json({ ok: true, status });
  } catch (err) {
    return next(err);
  }
});
