import { Router } from "express";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { forbidden } from "../../lib/errors.js";
import { reassignAllPendingApprovals } from "../../lib/approvalReassignment.js";

export const approvalMaintenanceRouter = Router();
approvalMaintenanceRouter.use(requireAuth);
approvalMaintenanceRouter.use((req: AuthedRequest, _res, next) => {
  if (req.user!.role !== "ADMIN") return next(forbidden("Only ADMIN can run approval maintenance"));
  next();
});

// Same sweep the daily background job runs (see index.ts) - exposed here so
// an admin can trigger it on demand (e.g. right after fixing a workflow or
// reporting-line issue) instead of waiting for the next scheduled run.
approvalMaintenanceRouter.post("/reassign-pending-approvals", async (req: AuthedRequest, res, next) => {
  try {
    const result = await reassignAllPendingApprovals();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
