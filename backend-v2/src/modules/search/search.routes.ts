import { Router } from "express";
import { AuthedRequest, hasFeatureAccess, requireAuth } from "../../lib/auth.js";
import { query } from "../../lib/db.js";

export const searchRouter = Router();
searchRouter.use(requireAuth);

// Dashboard "Quick Search" - live, role-scoped lookup across advances and
// clearance claims. Mirrors the mine-vs-report_advances fork GET /advances
// and GET /claims already use: whoever can run the Advances report searches
// every employee's requests, everyone else only ever searches their own -
// this endpoint never widens what a viewer can already see, it just makes
// the dashboard search box query the real, current data instead of
// filtering whatever the dashboard's own "my requests" KPI cards already
// happened to have loaded.
searchRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const term = String(req.query.q || "").trim();
    if (!term) return res.json({ advances: [], claims: [] });

    const canSearchAll = await hasFeatureAccess(req.user!.userId, req.user!.role, "report_advances", ["ADMIN"]);
    const like = `%${term}%`;

    const advances = await query(
      `SELECT ar.id, ar.status, ar.type, ar.workflow_step_order, ar.approval_chain, ar.created_at,
              ar.requester_id, u.full_name AS requester_name
         FROM advance_requests ar
         JOIN users u ON u.id = ar.requester_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
        WHERE ${canSearchAll ? "true" : "ar.requester_id = $2"}
          AND (u.full_name ILIKE $1 OR ar.type ILIKE $1 OR tt.name ILIKE $1 OR ar.status::text ILIKE $1)
        ORDER BY ar.created_at DESC
        LIMIT 8`,
      canSearchAll ? [like] : [like, req.user!.userId]
    );

    // clearance_claims has no type column of its own - it inherits the
    // trip's travel type from the advance it clears (same join
    // claims.routes.ts's own GET /:id already uses).
    const claims = await query(
      `SELECT cc.id, cc.status, ar.type, cc.created_at,
              cc.claimant_id, u.full_name AS requester_name
         FROM clearance_claims cc
         JOIN users u ON u.id = cc.claimant_id
         LEFT JOIN advance_requests ar ON ar.id = cc.linked_advance_id
         LEFT JOIN travel_types tt ON tt.code = ar.type
        WHERE ${canSearchAll ? "true" : "cc.claimant_id = $2"}
          AND (u.full_name ILIKE $1 OR ar.type ILIKE $1 OR tt.name ILIKE $1 OR cc.status::text ILIKE $1)
        ORDER BY cc.created_at DESC
        LIMIT 8`,
      canSearchAll ? [like] : [like, req.user!.userId]
    );

    return res.json({ advances, claims });
  } catch (err) {
    return next(err);
  }
});
