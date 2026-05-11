import { Router } from "express";
import { AuthedRequest, Role, requireAuth } from "../../lib/auth.js";
import { query } from "../../lib/db.js";
import { getActiveManagerDelegation } from "../../lib/delegations.js";

type InboxRule =
  | "ALL"
  | {
      doc_type: "ADVANCE" | "CLAIM" | "ACCOMMODATION";
      status: string;
      advance_type?: string;
    }
  | Array<{
      doc_type: "ADVANCE" | "CLAIM" | "ACCOMMODATION";
      status: string;
      advance_type?: string;
    }>;

function allowedInboxForRole(role: Role): InboxRule | null {
  switch (role) {
    case "COUNTERSIGN":
      return { doc_type: "ADVANCE", status: "SUBMITTED", advance_type: "TRAVEL_SUBSISTENCE" };
    case "MANAGER":
      return [
        { doc_type: "ADVANCE", status: "COUNTERSIGNED", advance_type: "TRAVEL_SUBSISTENCE" },
        { doc_type: "CLAIM", status: "SUBMITTED" }
      ];
    case "HR_MANAGER":
      return { doc_type: "ADVANCE", status: "HR_MANAGER_REVIEW", advance_type: "TRAVEL_SUBSISTENCE" };
    case "AUTH_OFFICER":
      return [
        { doc_type: "ADVANCE", status: "SUBMITTED", advance_type: "LOAN" },
        { doc_type: "ADVANCE", status: "SUBMITTED", advance_type: "SALARY" },
        { doc_type: "ADVANCE", status: "APPROVED", advance_type: "TRAVEL_SUBSISTENCE" },
        { doc_type: "CLAIM", status: "MANAGER_APPROVED" },
        { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" }
      ];
    case "CHIEF_OFFICER":
      return { doc_type: "CLAIM", status: "MANAGER_APPROVED" };
    case "FINANCE":
      return [
        { doc_type: "ADVANCE", status: "AUTH_OFFICER_APPROVED", advance_type: "SALARY" },
        { doc_type: "ADVANCE", status: "APPROVED" },
        { doc_type: "ACCOMMODATION", status: "SUBMITTED" },
        { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" }
      ];
    case "ADMIN":
      return "ALL";
    default:
      return null;
  }
}

export const inboxRouter = Router();
inboxRouter.use(requireAuth);

inboxRouter.get("/my-actions", async (req: AuthedRequest, res, next) => {
  try {
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;

    const rows = await query<any>(
      `SELECT al.id,
              al.action,
              al.entity_type,
              al.entity_id,
              al.before_json,
              al.after_json,
              al.created_at,
              ar.status AS current_status,
              acc.status AS accommodation_status,
              COALESCE(u.full_name, acc_requester.full_name) AS requester_name
       FROM audit_log al
       LEFT JOIN advance_requests ar
         ON al.entity_type='advance_requests'
        AND ar.id = al.entity_id
       LEFT JOIN users u
         ON u.id = ar.requester_id
       LEFT JOIN accommodation_requests acc
         ON al.entity_type='accommodation_requests'
        AND acc.id = al.entity_id
       LEFT JOIN users acc_requester
         ON acc_requester.id = acc.requester_id
       WHERE al.actor_id = $1
       ORDER BY al.created_at DESC
       LIMIT $2`,
      [req.user!.userId, limit]
    );

    const items = rows.map((r) => ({
      id: r.id,
      action: r.action,
      doc_type: r.entity_type === "advance_requests" ? "ADVANCE" : r.entity_type,
      entity_id: r.entity_id,
      current_status: r.current_status ?? r.accommodation_status ?? null,
      requester_name: r.requester_name ?? null,
      created_at: r.created_at
    }));

    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

inboxRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user!.role;
    const delegation = await getActiveManagerDelegation(req.user!.userId);
    const effectiveRole = delegation && role !== "MANAGER" ? "MANAGER" : role;
    const rule = allowedInboxForRole(effectiveRole);
    if (!rule) return res.json({ items: [] });

    const items: any[] = [];

    const loadAdvanceByStatus = async (status: string, advanceType?: string) => {
      const typeFilter =
        advanceType === "LOAN"
          ? ` AND ar.type = 'LOAN'`
          : advanceType === "TRAVEL_SUBSISTENCE"
            ? ` AND ar.type = 'TRAVEL_SUBSISTENCE'`
            : advanceType === "SALARY"
              ? ` AND ar.type = 'SALARY'`
              : advanceType === "NON_LOAN"
                ? ` AND ar.type <> 'LOAN'`
            : "";
      const rows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose, u.full_name AS requester_name
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         WHERE ar.status = $1${typeFilter}
         ORDER BY ar.created_at DESC`,
        [status]
      );
      for (const a of rows) {
        items.push({
          doc_type: "ADVANCE",
          id: a.id,
          status: a.status,
          advance_type: a.type,
          requested_total: Number(a.requested_total),
          approved_total: Number(a.approved_total),
          purpose: a.purpose,
          requester_name: a.requester_name
        });
      }
    };

    const loadClaimByStatus = async (status: string) => {
      const rows = await query<any>(
        `SELECT c.id, c.status, c.claim_total, c.advance_amount, c.balance_amount, u.full_name AS claimant_name
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         WHERE c.status = $1
         ORDER BY c.created_at DESC`,
        [status]
      );
      for (const c of rows) {
        items.push({
          doc_type: "CLAIM",
          id: c.id,
          status: c.status,
          claim_total: Number(c.claim_total),
          advance_amount: Number(c.advance_amount),
          balance_amount: Number(c.balance_amount),
          claimant_name: c.claimant_name
        });
      }
    };

    const loadAccommodationByStatus = async (status: string) => {
      const rows = await query<any>(
        `SELECT acc.id,
                acc.status,
                acc.amount,
                acc.location,
                acc.provider,
                requester.full_name AS requester_name,
                creator.full_name AS created_by_name
           FROM accommodation_requests acc
           JOIN users requester ON requester.id = acc.requester_id
           JOIN users creator ON creator.id = acc.created_by_id
          WHERE acc.status = $1
          ORDER BY acc.created_at DESC`,
        [status]
      );
      for (const a of rows) {
        items.push({
          doc_type: "ACCOMMODATION",
          id: a.id,
          status: a.status,
          amount: Number(a.amount),
          location: a.location,
          provider: a.provider,
          requester_name: a.requester_name,
          created_by_name: a.created_by_name
        });
      }
    };

    if (rule === "ALL") {
      await loadAdvanceByStatus("SUBMITTED");
      await loadAdvanceByStatus("COUNTERSIGNED");
      await loadAdvanceByStatus("HR_MANAGER_REVIEW");
      await loadAdvanceByStatus("AUTH_OFFICER_APPROVED");
      await loadAdvanceByStatus("APPROVED");
      await loadAccommodationByStatus("SUBMITTED");

      await loadClaimByStatus("SUBMITTED");
      await loadClaimByStatus("MANAGER_APPROVED");
      await loadClaimByStatus("CHIEF_OFFICER_APPROVED");
      await loadClaimByStatus("FINANCE_VERIFIED");

      return res.json({ items });
    }

    const rules = Array.isArray(rule) ? rule : [rule];
    for (const r of rules) {
      if (r.doc_type === "ADVANCE") {
        await loadAdvanceByStatus(r.status, r.advance_type);
      } else if (r.doc_type === "ACCOMMODATION") {
        await loadAccommodationByStatus(r.status);
      } else {
        await loadClaimByStatus(r.status);
      }
    }

    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});
