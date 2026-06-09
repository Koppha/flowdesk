import { Router } from "express";
import { AuthedRequest, Role, requireAuth } from "../../lib/auth.js";
import { query } from "../../lib/db.js";
import { getActiveManagerDelegation } from "../../lib/delegations.js";

type InboxRule =
  | "ALL"
  | {
      doc_type: "ADVANCE" | "CLAIM" | "ACCOMMODATION" | "OVERTIME_REQUEST" | "OVERTIME_CLAIM";
      status: string;
      advance_type?: string;
    }
  | Array<{
      doc_type: "ADVANCE" | "CLAIM" | "ACCOMMODATION" | "OVERTIME_REQUEST" | "OVERTIME_CLAIM";
      status: string;
      advance_type?: string;
    }>;

function allowedInboxForRole(role: Role): InboxRule | null {
  switch (role) {
    case "MANAGER":
      return [
        { doc_type: "ADVANCE", status: "SUBMITTED" },
        { doc_type: "ADVANCE", status: "HR_MANAGER_REVIEW" },
        { doc_type: "ADVANCE", status: "HR_REVIEW" },
        { doc_type: "ADVANCE", status: "CHIEF_OFFICER_REVIEW" },
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" },
        { doc_type: "CLAIM", status: "SUBMITTED" },
        { doc_type: "CLAIM", status: "MANAGER_APPROVED" },
        { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" },
        { doc_type: "CLAIM", status: "HR_OFFICER" },
        { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
        { doc_type: "OVERTIME_REQUEST", status: "SUBMITTED" },
        { doc_type: "OVERTIME_REQUEST", status: "SUPERVISOR_APPROVED" },
        { doc_type: "OVERTIME_CLAIM", status: "SUBMITTED" }
      ];
    case "HR_MANAGER":
      return [
        { doc_type: "ADVANCE", status: "HR_MANAGER_REVIEW" },
        { doc_type: "ADVANCE", status: "HR_REVIEW" },
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" },
        { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" },
        { doc_type: "CLAIM", status: "HR_OFFICER" },
        { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
        { doc_type: "OVERTIME_CLAIM", status: "MANAGER_AUTHORISED" },
        { doc_type: "OVERTIME_CLAIM", status: "FINANCE_VERIFIED" },
        { doc_type: "OVERTIME_CLAIM", status: "EARNINGS_RECORDED" }
      ];
    case "AUTH_OFFICER":
      return [
        { doc_type: "ADVANCE", status: "HR_REVIEW" },
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" },
        { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" },
        { doc_type: "CLAIM", status: "HR_OFFICER" },
        { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" }
      ];
    case "CHIEF_OFFICER":
      return [
        { doc_type: "CLAIM", status: "MANAGER_APPROVED" },
        { doc_type: "CLAIM", status: "CHIEF_OFFICER_APPROVED" },
        { doc_type: "CLAIM", status: "HR_OFFICER" },
        { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
        { doc_type: "ADVANCE", status: "CHIEF_OFFICER_REVIEW" },
        { doc_type: "ADVANCE", status: "HR_MANAGER_REVIEW" },
        { doc_type: "ADVANCE", status: "HR_REVIEW" },
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" },
        { doc_type: "OVERTIME_REQUEST", status: "HOD_APPROVED" }
      ];
    case "FINANCE":
      return [
        { doc_type: "ADVANCE", status: "HR_OFFICER" },
        { doc_type: "ADVANCE", status: "APPROVED" },
        { doc_type: "ACCOMMODATION", status: "SUBMITTED" },
        { doc_type: "CLAIM", status: "HR_OFFICER" },
        { doc_type: "CLAIM", status: "HR_MANAGER_REVIEW" },
        { doc_type: "CLAIM", status: "FINANCE_VERIFIED" },
        { doc_type: "OVERTIME_CLAIM", status: "HR_NOTED" }
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
      const params: unknown[] = [status];
      let typeFilter = "";
      if (advanceType === "NON_LOAN") {
        typeFilter = ` AND ar.type <> 'LOAN'`;
      } else if (advanceType) {
        params.push(advanceType);
        typeFilter = ` AND ar.type = $${params.length}`;
      }
      let ownershipFilter = "";
      if (effectiveRole === "MANAGER" && status === "SUBMITTED") {
        params.push(delegation?.manager_id || req.user!.userId);
        ownershipFilter = ` AND d.manager_user_id = $${params.length}`;
      }
      if (role === "CHIEF_OFFICER" && status === "CHIEF_OFFICER_REVIEW") {
        params.push(req.user!.userId);
        ownershipFilter = ` AND d.exco_user_id = $${params.length}`;
      }
      const rows = await query<any>(
        `SELECT ar.id, ar.status, ar.type, ar.requested_total, ar.approved_total, ar.purpose, u.full_name AS requester_name
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         LEFT JOIN departments d ON lower(trim(d.name)) = lower(trim(u.department))
         WHERE ar.status = $1${typeFilter}${ownershipFilter}
         ORDER BY ar.created_at DESC`,
        params
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
      const params: unknown[] = [status];
      let ownershipFilter = "";
      if (effectiveRole === "MANAGER" && status === "SUBMITTED") {
        params.push(delegation?.manager_id || req.user!.userId);
        ownershipFilter = ` AND d.manager_user_id = $${params.length}`;
      }
      const rows = await query<any>(
        `SELECT c.id, c.status, c.claim_total, c.advance_amount, c.balance_amount, u.full_name AS claimant_name
         FROM clearance_claims c
         JOIN users u ON u.id = c.claimant_id
         LEFT JOIN departments d ON lower(trim(d.name)) = lower(trim(u.department))
         WHERE c.status = $1${ownershipFilter}
         ORDER BY c.created_at DESC`,
        params
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

    const loadOvertimeRequestByStatus = async (status: string) => {
      const rows = await query<any>(
        `SELECT o.id, o.status, o.employee_name, o.section_name, o.year, o.month,
                u.full_name AS created_by_name
         FROM overtime_requests o
         JOIN users u ON u.id = o.created_by_id
         WHERE o.status = $1
         ORDER BY o.created_at DESC`,
        [status]
      );
      for (const o of rows) {
        items.push({
          doc_type: "OVERTIME_REQUEST",
          id: o.id,
          status: o.status,
          employee_name: o.employee_name,
          section_name: o.section_name,
          year: o.year,
          month: o.month
        });
      }
    };

    const loadOvertimeClaimByStatus = async (status: string) => {
      const rows = await query<any>(
        `SELECT o.id, o.status, o.employee_name, o.division, o.year, o.month, o.total_amount
         FROM overtime_claims o
         WHERE o.status = $1
         ORDER BY o.created_at DESC`,
        [status]
      );
      for (const o of rows) {
        items.push({
          doc_type: "OVERTIME_CLAIM",
          id: o.id,
          status: o.status,
          employee_name: o.employee_name,
          division: o.division,
          year: o.year,
          month: o.month,
          total_amount: Number(o.total_amount)
        });
      }
    };

    if (rule === "ALL") {
      await loadAdvanceByStatus("SUBMITTED");
      await loadAdvanceByStatus("CHIEF_OFFICER_REVIEW");
      await loadAdvanceByStatus("HR_MANAGER_REVIEW");
      await loadAdvanceByStatus("HR_REVIEW");
      await loadAdvanceByStatus("HR_OFFICER");
      await loadAdvanceByStatus("APPROVED");
      await loadAccommodationByStatus("SUBMITTED");

      await loadClaimByStatus("SUBMITTED");
      await loadClaimByStatus("MANAGER_APPROVED");
      await loadClaimByStatus("CHIEF_OFFICER_APPROVED");
      await loadClaimByStatus("HR_OFFICER");
      await loadClaimByStatus("HR_MANAGER_REVIEW");
      await loadClaimByStatus("FINANCE_VERIFIED");

      await loadOvertimeRequestByStatus("SUBMITTED");
      await loadOvertimeRequestByStatus("SUPERVISOR_APPROVED");
      await loadOvertimeRequestByStatus("HOD_APPROVED");
      await loadOvertimeClaimByStatus("SUBMITTED");
      await loadOvertimeClaimByStatus("MANAGER_AUTHORISED");
      await loadOvertimeClaimByStatus("HR_NOTED");
      await loadOvertimeClaimByStatus("FINANCE_VERIFIED");
      await loadOvertimeClaimByStatus("EARNINGS_RECORDED");

      return res.json({ items });
    }

    const rules = Array.isArray(rule) ? rule : [rule];
    for (const r of rules) {
      if (r.doc_type === "ADVANCE") {
        await loadAdvanceByStatus(r.status, r.advance_type);
      } else if (r.doc_type === "ACCOMMODATION") {
        await loadAccommodationByStatus(r.status);
      } else if (r.doc_type === "OVERTIME_REQUEST") {
        await loadOvertimeRequestByStatus(r.status);
      } else if (r.doc_type === "OVERTIME_CLAIM") {
        await loadOvertimeClaimByStatus(r.status);
      } else {
        await loadClaimByStatus(r.status);
      }
    }

    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});
