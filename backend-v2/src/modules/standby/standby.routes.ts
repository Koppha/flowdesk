/**
 * Standby Roster & Claim Management.
 *
 * Covers roster -> claim -> employee-built approval route -> Finance
 * processing -> paid, plus roster-creation delegation and claim-approval
 * delegation (both reuse the shared manager_delegations system — see
 * lib/delegations.ts), the read-only roster view, reporting, adjustments,
 * and per-Section required-approver-role policy. Not integrated with the
 * shared Payments module — "mark paid" is a self-contained Standby action.
 *
 * "Section" in the FlowDesk solution doc is this app's `teams` table (see
 * the Company/Division/Department/Section -> divisions/departments/
 * sections/teams mapping established for Workflow Builder participants).
 * A roster is owned by a Section (team); the team's leader_user_id is the
 * Section Manager / roster owner.
 */
import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";
import { nextSequentialNumber } from "../../lib/sequentialNumbers.js";
import { getUserOrgPath } from "../../lib/departments.js";
import { isActiveTeamDelegate, getDelegatedManagerIds } from "../../lib/delegations.js";
import { getBooleanSystemSetting, getNumericSystemSetting, setNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { isClaimPeriodOpen } from "../../lib/claimWindow.js";
import { isCompensationFinanceUser } from "../../lib/financeAuthority.js";
import { isHrOperationsUser } from "../../lib/hrAuthority.js";
import { canAccessPdf } from "../../lib/pdf/pdfPermissions.js";
import { resolveStandbyClaimPdfData, getFieldCatalogFor } from "../../lib/pdf/pdfFieldCatalog.js";
import { renderPdfTemplate, type PdfLetterhead } from "../../lib/pdf/genericPdfRenderer.js";
import {
  notifyStandbyRosterPublished,
  notifyStandbyClaimSubmitted,
  notifyStandbyClaimReturned,
  notifyStandbyClaimFinanceReady,
  notifyStandbyClaimProcessed,
  notifyStandbyClaimPaid,
  notifyStandbyCalloutSubmitted,
  notifyStandbyCalloutReturned,
  notifyStandbyCalloutReadyForTreasury
} from "../../lib/notifications.js";

export async function ensureStandbySchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS standby_rosters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id uuid NOT NULL REFERENCES teams(id),
      roster_month date NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT',
      owner_user_id uuid REFERENCES users(id),
      created_by_id uuid REFERENCES users(id),
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (team_id, roster_month)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS standby_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      roster_id uuid NOT NULL REFERENCES standby_rosters(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id),
      standby_date date NOT NULL,
      start_time time NOT NULL,
      end_time time NOT NULL,
      hours numeric(6,2) NOT NULL,
      schedule_type text NOT NULL DEFAULT 'STANDARD',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`ALTER TABLE standby_assignments ADD COLUMN IF NOT EXISTS created_by_id uuid REFERENCES users(id)`);
  await query(`ALTER TABLE standby_assignments ADD COLUMN IF NOT EXISTS override_reason text`);
  await query(`CREATE INDEX IF NOT EXISTS idx_standby_assignments_roster ON standby_assignments(roster_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_standby_assignments_user ON standby_assignments(user_id, standby_date)`);

  await query(`
    CREATE TABLE IF NOT EXISTS standby_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_no text UNIQUE NOT NULL,
      employee_id uuid NOT NULL REFERENCES users(id),
      claim_month date NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT',
      compensation_preference text,
      comments text,
      total_standby_hours numeric(8,2) NOT NULL DEFAULT 0,
      compensable_hours numeric(8,2) NOT NULL DEFAULT 0,
      hourly_rate numeric(12,2),
      calculated_amount numeric(12,2),
      cost_centre text,
      account_project text,
      payroll_period text,
      finance_reference text,
      finance_comments text,
      current_step_order int NOT NULL DEFAULT 0,
      submitted_at timestamptz,
      finance_processed_at timestamptz,
      paid_at timestamptz,
      closed_at timestamptz,
      created_by_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (employee_id, claim_month)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS standby_claim_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_id uuid NOT NULL REFERENCES standby_claims(id) ON DELETE CASCADE,
      assignment_id uuid REFERENCES standby_assignments(id) ON DELETE SET NULL,
      standby_date date NOT NULL,
      start_time time,
      end_time time,
      hours numeric(6,2) NOT NULL
    )
  `);
  // A claim must survive even if its source roster/assignment is later
  // removed (claim integrity outlives the roster) — widen an
  // already-provisioned DB's FK from the implicit RESTRICT default.
  await query(`ALTER TABLE standby_claim_lines DROP CONSTRAINT IF EXISTS standby_claim_lines_assignment_id_fkey`);
  await query(`ALTER TABLE standby_claim_lines ADD CONSTRAINT standby_claim_lines_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES standby_assignments(id) ON DELETE SET NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS standby_approval_steps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_id uuid NOT NULL REFERENCES standby_claims(id) ON DELETE CASCADE,
      step_order int NOT NULL,
      approver_user_id uuid NOT NULL REFERENCES users(id),
      title text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      decided_at timestamptz,
      comments text
    )
  `);
  // "Once submitted, the Approval Route is frozen for audit integrity" — a
  // send-back must not erase the frozen route's decisions, so each attempt
  // gets its own route_version instead of being deleted and rebuilt in
  // place. current_route_version on the claim says which one is live;
  // earlier versions stay queryable as history.
  await query(`ALTER TABLE standby_claims ADD COLUMN IF NOT EXISTS current_route_version int NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE standby_approval_steps ADD COLUMN IF NOT EXISTS route_version int NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE standby_approval_steps DROP CONSTRAINT IF EXISTS standby_approval_steps_claim_id_step_order_key`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_standby_approval_steps_unique ON standby_approval_steps(claim_id, route_version, step_order)`);

  // Call-Outs — a Call-Out is time actually worked *inside* an active
  // standby window (as opposed to Overtime, which is time worked outside
  // one). A completely separate, event-based claim type from the monthly
  // Standby Claim above: no "generate for the month" step, an employee logs
  // one whenever a call-out happens, it's validated against their published
  // standby_assignments, and it follows the same modern (no Finance stage)
  // lifecycle DRAFT -> SUBMITTED -> ... -> CLOSED, closing with
  // converted_hours as the final figure — same route-versioned approval
  // pattern as standby_claims/standby_approval_steps above.
  await query(`
    CREATE TABLE IF NOT EXISTS standby_callout_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_no text UNIQUE NOT NULL,
      employee_id uuid NOT NULL REFERENCES users(id),
      created_by_id uuid NOT NULL REFERENCES users(id),
      standby_assignment_id uuid REFERENCES standby_assignments(id) ON DELETE SET NULL,
      call_date date NOT NULL,
      start_time time NOT NULL,
      end_time time NOT NULL,
      hours numeric(6,2) NOT NULL,
      rate_pct numeric(6,2) NOT NULL,
      converted_hours numeric(10,2) NOT NULL,
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT',
      current_route_version int NOT NULL DEFAULT 1,
      current_step_order int NOT NULL DEFAULT 0,
      comments text,
      submitted_at timestamptz,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS standby_callout_approval_steps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_id uuid NOT NULL REFERENCES standby_callout_claims(id) ON DELETE CASCADE,
      route_version int NOT NULL DEFAULT 1,
      step_order int NOT NULL,
      approver_user_id uuid NOT NULL REFERENCES users(id),
      title text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      decided_at timestamptz,
      comments text
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_standby_callout_steps_unique ON standby_callout_approval_steps(claim_id, route_version, step_order)`);
  // Finance/Payroll's own "picked this up" marker for a claim that closed
  // with no money attached — distinct from standby_claims' old (now-dead)
  // finance_processed_at/paid_at pair. See compensation-claims module.
  await query(`ALTER TABLE standby_claims ADD COLUMN IF NOT EXISTS processed_at timestamptz`);
  await query(`ALTER TABLE standby_claims ADD COLUMN IF NOT EXISTS processed_by_id uuid REFERENCES users(id)`);
  await query(`ALTER TABLE standby_claims ADD COLUMN IF NOT EXISTS treasury_comment text`);
  await query(`ALTER TABLE standby_callout_claims ADD COLUMN IF NOT EXISTS processed_at timestamptz`);
  await query(`ALTER TABLE standby_callout_claims ADD COLUMN IF NOT EXISTS processed_by_id uuid REFERENCES users(id)`);
  await query(`ALTER TABLE standby_callout_claims ADD COLUMN IF NOT EXISTS treasury_comment text`);

  // Governed cost centre / account-project master list Finance picks from
  // during processing, instead of free-typing values that drift out of sync
  // across claims — see the GET/POST/PATCH/DELETE /finance-codes routes.
  await query(`
    CREATE TABLE IF NOT EXISTS standby_finance_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (kind, name)
    )
  `);

  // Roster-creation delegation reuses the app's existing manager_delegations
  // system (see lib/delegations.ts) instead of a bespoke table — delegations
  // here are rows tagged request_type_code='STANDBY_ROSTER' and scoped by
  // manager_delegations.team_id. Drop the earlier bespoke table (unreleased,
  // never held real data).
  await query(`DROP TABLE IF EXISTS standby_roster_delegations`);

  // Per-Section policy: some Sections require an EXCO approver in the
  // Approval Route before a claim can be submitted.
  await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS standby_requires_exco boolean NOT NULL DEFAULT false`);
  // Generalizes the old EXCO-only toggle into an arbitrary set of roles a
  // Section can require in a standby Approval Route (e.g. HOD, FINANCE).
  // One-time backfill from the old boolean into the new array; afterwards
  // standby_requires_exco is unused dead weight but left in place rather
  // than dropped, since dropping a column is a destructive migration.
  await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS standby_required_roles text[] NOT NULL DEFAULT '{}'`);
  // Which org Departments' employees can act as Finance for standby claims
  // (queue, process, return, mark paid, reports) — admin-assigned per
  // Department (the `sections` table — see the Company/Division/Department/
  // Section -> divisions/departments/sections/teams mapping at the top of
  // this file) rather than keyed off the legacy free-text "Finance"
  // department string, so it works with whatever the org actually calls
  // its finance unit(s) (e.g. "Treasury & Financial Accounting"). No
  // fallback to the legacy department string by design — org-structure
  // assignment (users.section_id) is the single source of truth going
  // forward, so an admin must place finance staff into a flagged
  // Department via user management before they show up here.
  await query(`ALTER TABLE sections ADD COLUMN IF NOT EXISTS is_standby_finance boolean NOT NULL DEFAULT false`);
  await query(`UPDATE teams SET standby_required_roles = ARRAY['EXCO'] WHERE standby_requires_exco = true AND array_length(standby_required_roles, 1) IS NULL`);

  // Adjustments — a claim already paid can't be edited (claim integrity),
  // so a correction is a new claim linked back to the original.
  await query(`ALTER TABLE standby_claims ADD COLUMN IF NOT EXISTS is_adjustment boolean NOT NULL DEFAULT false`);
  await query(`ALTER TABLE standby_claims ADD COLUMN IF NOT EXISTS original_claim_id uuid REFERENCES standby_claims(id)`);
  await query(`ALTER TABLE standby_claims ADD COLUMN IF NOT EXISTS adjustment_sequence int NOT NULL DEFAULT 0`);
  // The one-claim-per-employee-per-month rule only applies to normal claims —
  // an employee can have any number of adjustment claims against a given
  // month. Swap the inline UNIQUE constraint for a partial unique index.
  await query(`ALTER TABLE standby_claims DROP CONSTRAINT IF EXISTS standby_claims_employee_id_claim_month_key`);
  // REJECTED is excluded from the uniqueness rule (re-created each boot,
  // rather than a one-off migration, to match this function's existing
  // idempotent-ensure style) — otherwise a rejected claim permanently blocks
  // ever generating a new claim for that employee/month, since the old
  // (rejected) row still "occupies" the slot forever.
  await query(`DROP INDEX IF EXISTS idx_standby_claims_unique_normal`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_standby_claims_unique_normal ON standby_claims(employee_id, claim_month) WHERE NOT is_adjustment AND status <> 'REJECTED'`);

  // Claim periods — mirrors overtime_claim_periods exactly. A month must be
  // explicitly opened here before an employee can submit a Standby Claim
  // for it (checked in POST /claims/:id/submit); replaces the earlier
  // auto-open-after-month-end date check that used to live in
  // POST /claims/generate.
  await query(`
    CREATE TABLE IF NOT EXISTS standby_claim_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      year int NOT NULL,
      month int NOT NULL,
      status text NOT NULL DEFAULT 'OPEN',
      opened_by_id uuid REFERENCES users(id),
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_by_id uuid REFERENCES users(id),
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_standby_claim_periods_year_month ON standby_claim_periods(year, month)`);
}

async function writeStandbyAudit(args: { actorId: string; entityType: string; entityId: string; action: string; before?: unknown; after?: unknown }) {
  await query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1,$2,$3,$4,$5,$6)`,
    [args.actorId, args.action, args.entityType, args.entityId, args.before ? JSON.stringify(args.before) : null, args.after ? JSON.stringify(args.after) : null]
  );
}

async function getUserContact(userId: string | null | undefined) {
  if (!userId) return null;
  const rows = await query<{ id: string; full_name: string | null; email: string; role: string }>(
    `SELECT id, full_name, email, role FROM users WHERE id=$1`,
    [userId]
  );
  return rows[0] || null;
}

const ASSIGNMENT_SCHEMA = z.object({
  user_id: z.string().uuid(),
  start_date: z.string(),
  end_date: z.string().optional(),
  start_time: z.string().default("17:00"),
  end_time: z.string().default("08:00"),
  schedule_type: z.enum(["STANDARD", "CUSTOM"]).default("STANDARD"),
  // "Only active employees in the selected Section are eligible for roster
  // loading unless an authorized override is provided" — a reason unlocks
  // assigning any active employee outside the Section, and is recorded.
  override_reason: z.string().trim().min(1).max(500).optional()
});

const APPROVAL_ROUTE_SCHEMA = z
  .array(
    z.object({
      approver_user_id: z.string().uuid(),
      title: z.string().trim().min(1)
    })
  )
  .min(1, "At least one approver is required");

function monthToDate(month: string) {
  // "2026-08" -> first-of-month date string
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month;
}

async function nextClaimNo() {
  return nextSequentialNumber("STB", 4);
}

async function computeAssignmentHours(startTime: string, endTime: string) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes <= 0) minutes += 24 * 60; // overnight standby
  return Math.round((minutes / 60) * 100) / 100;
}

export const standbyRouter = Router();
standbyRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Rosters
// ---------------------------------------------------------------------------

standbyRouter.get("/teams", async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user!.role;
    const rows = await query<any>(
      `SELECT t.id, t.name, t.leader_user_id, t.standby_required_roles, u.full_name AS leader_name, s.name AS section_name
         FROM teams t
         LEFT JOIN users u ON u.id = t.leader_user_id
         LEFT JOIN sections s ON s.id = t.section_id
        WHERE t.active = true
        ORDER BY t.name`
    );
    let scoped = rows;
    if (role !== "ADMIN") {
      const delegatedTeamIds = new Set(
        (await query<{ team_id: string }>(
          `SELECT md.team_id
             FROM manager_delegations md
             JOIN delegation_request_types drt ON drt.delegation_id = md.id AND drt.request_type_code = 'STANDBY_ROSTER'
            WHERE md.delegate_id=$1 AND md.active=true AND md.team_id IS NOT NULL
              AND (md.from_date IS NULL OR md.from_date <= CURRENT_DATE) AND (md.to_date IS NULL OR md.to_date >= CURRENT_DATE)`,
          [req.user!.userId]
        )).map((d) => d.team_id)
      );
      scoped = rows.filter((t) => t.leader_user_id === req.user!.userId || delegatedTeamIds.has(t.id));
    }
    return res.json(scoped);
  } catch (err) {
    return next(err);
  }
});

standbyRouter.get("/rosters", async (req: AuthedRequest, res, next) => {
  try {
    const teamId = String(req.query.team_id || "").trim();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (teamId) {
      params.push(teamId);
      filters.push(`sr.team_id=$${params.length}`);
    }
    if (req.user!.role !== "ADMIN") {
      params.push(req.user!.userId);
      filters.push(`t.leader_user_id=$${params.length}`);
    }
    const rows = await query<any>(
      `SELECT sr.*, t.name AS team_name,
              (SELECT count(*)::int FROM standby_assignments sa WHERE sa.roster_id = sr.id) AS assignment_count,
              (SELECT count(DISTINCT sa.user_id)::int FROM standby_assignments sa WHERE sa.roster_id = sr.id) AS employee_count
         FROM standby_rosters sr
         JOIN teams t ON t.id = sr.team_id
        ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY sr.roster_month DESC, t.name`,
      params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/rosters", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.standbyModuleEnabled, true))) {
      throw forbidden("Standby is currently disabled by admin.");
    }
    const body = z.object({ team_id: z.string().uuid(), roster_month: z.string() }).safeParse(req.body);
    if (!body.success) throw badRequest("team_id and roster_month are required", body.error.flatten());

    const team = (await query<{ id: string; leader_user_id: string | null }>(`SELECT id, leader_user_id FROM teams WHERE id=$1`, [body.data.team_id]))[0];
    if (!team) throw notFound("Section not found");
    const canCreate =
      req.user!.role === "ADMIN" ||
      team.leader_user_id === req.user!.userId ||
      (await isActiveTeamDelegate(req.user!.userId, body.data.team_id, "STANDBY_ROSTER"));
    if (!canCreate) {
      throw forbidden("Only the Section Manager or an authorized delegate can create a roster for this Section");
    }

    const existing = (await query<{ id: string }>(
      `SELECT id FROM standby_rosters WHERE team_id=$1 AND roster_month=$2`,
      [body.data.team_id, monthToDate(body.data.roster_month)]
    ))[0];
    if (existing) return res.json({ id: existing.id });

    const rows = await query<{ id: string }>(
      `INSERT INTO standby_rosters (team_id, roster_month, owner_user_id, created_by_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [body.data.team_id, monthToDate(body.data.roster_month), team.leader_user_id || req.user!.userId, req.user!.userId]
    );
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

async function loadRosterDetail(rosterId: string) {
  const roster = (await query<any>(
    `SELECT sr.*, t.name AS team_name, t.leader_user_id, t.section_id, t.standby_required_roles
       FROM standby_rosters sr JOIN teams t ON t.id = sr.team_id
      WHERE sr.id=$1`,
    [rosterId]
  ))[0];
  if (!roster) return null;

  const orgPath = roster.leader_user_id ? await getUserOrgPath(roster.leader_user_id) : null;
  const members = await query<any>(
    `SELECT id, full_name, employee_no, title FROM users
      WHERE team_id=$1 AND is_active=true ORDER BY full_name`,
    [roster.team_id]
  );
  const assignments = await query<any>(
    `SELECT sa.*, u.full_name FROM standby_assignments sa
       JOIN users u ON u.id = sa.user_id
      WHERE sa.roster_id=$1 ORDER BY sa.standby_date, u.full_name`,
    [rosterId]
  );
  return { ...roster, org_path: orgPath, members, assignments };
}

standbyRouter.get("/rosters/:id", async (req: AuthedRequest, res, next) => {
  try {
    const detail = await loadRosterDetail(req.params.id);
    if (!detail) throw notFound();
    return res.json(detail);
  } catch (err) {
    return next(err);
  }
});

// Strict — publish, cancel, and delegation management stay Section-Manager-only.
async function assertRosterOwner(rosterId: string, req: AuthedRequest) {
  const roster = (await query<{ leader_user_id: string | null; status: string; team_id: string }>(
    `SELECT t.leader_user_id, sr.status, sr.team_id FROM standby_rosters sr JOIN teams t ON t.id = sr.team_id WHERE sr.id=$1`,
    [rosterId]
  ))[0];
  if (!roster) throw notFound("Roster not found");
  if (req.user!.role !== "ADMIN" && roster.leader_user_id !== req.user!.userId) {
    throw forbidden("Only the Section Manager can manage this roster");
  }
  return roster;
}

// Looser — a delegated roster creator may build/edit the roster (create,
// assign, remove standby) but never publish, cancel, or manage delegations.
async function assertRosterEditor(rosterId: string, req: AuthedRequest) {
  const roster = (await query<{ leader_user_id: string | null; status: string; team_id: string }>(
    `SELECT t.leader_user_id, sr.status, sr.team_id FROM standby_rosters sr JOIN teams t ON t.id = sr.team_id WHERE sr.id=$1`,
    [rosterId]
  ))[0];
  if (!roster) throw notFound("Roster not found");
  if (req.user!.role === "ADMIN" || roster.leader_user_id === req.user!.userId) return roster;
  if (await isActiveTeamDelegate(req.user!.userId, roster.team_id, "STANDBY_ROSTER")) return roster;
  throw forbidden("Only the Section Manager or an authorized delegate can manage this roster");
}

standbyRouter.post("/rosters/:id/assignments", async (req: AuthedRequest, res, next) => {
  try {
    const roster = await assertRosterEditor(req.params.id, req);
    const body = ASSIGNMENT_SCHEMA.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid assignment", body.error.flatten());

    const member = (await query<{ id: string }>(
      `SELECT u.id FROM users u JOIN standby_rosters sr ON sr.team_id = u.team_id
        WHERE sr.id=$1 AND u.id=$2 AND u.is_active=true`,
      [req.params.id, body.data.user_id]
    ))[0];
    if (!member) {
      // Not a Section member — only proceed if an override reason was given,
      // and the target is still at least an active user somewhere in FlowDesk.
      if (!body.data.override_reason) {
        throw badRequest("That employee is not an active member of this Section — provide an override reason to assign them anyway");
      }
      const activeUser = (await query<{ id: string }>(`SELECT id FROM users WHERE id=$1 AND is_active=true`, [body.data.user_id]))[0];
      if (!activeUser) throw badRequest("That employee is not an active FlowDesk user");
    }

    const hours = await computeAssignmentHours(body.data.start_time, body.data.end_time);
    const start = new Date(body.data.start_date);
    const end = body.data.end_date ? new Date(body.data.end_date) : start;
    if (end < start) throw badRequest("End date must be on or after start date");

    const created: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const rows = await query<{ id: string }>(
        `INSERT INTO standby_assignments (roster_id, user_id, standby_date, start_time, end_time, hours, schedule_type, created_by_id, override_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [req.params.id, body.data.user_id, dateStr, body.data.start_time, body.data.end_time, hours, body.data.schedule_type, req.user!.userId, body.data.override_reason || null]
      );
      created.push(rows[0].id);
    }
    await writeStandbyAudit({
      actorId: req.user!.userId,
      entityType: "standby_rosters",
      entityId: req.params.id,
      action: roster.status === "PUBLISHED" ? "ASSIGNMENT_ADDED_POST_PUBLISH" : "ASSIGNMENT_ADDED",
      after: { ...body.data, roster_status: roster.status, days: created.length }
    });
    return res.status(201).json({ created: created.length, ids: created });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.delete("/rosters/:id/assignments/:assignmentId", async (req: AuthedRequest, res, next) => {
  try {
    const roster = await assertRosterEditor(req.params.id, req);
    const removed = (await query<any>(`SELECT * FROM standby_assignments WHERE id=$1 AND roster_id=$2`, [req.params.assignmentId, req.params.id]))[0];
    await query(`DELETE FROM standby_assignments WHERE id=$1 AND roster_id=$2`, [req.params.assignmentId, req.params.id]);
    if (removed) {
      await writeStandbyAudit({
        actorId: req.user!.userId,
        entityType: "standby_rosters",
        entityId: req.params.id,
        action: roster.status === "PUBLISHED" ? "ASSIGNMENT_REMOVED_POST_PUBLISH" : "ASSIGNMENT_REMOVED",
        before: removed
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/rosters/:id/publish", async (req: AuthedRequest, res, next) => {
  try {
    await assertRosterOwner(req.params.id, req);
    await query(`UPDATE standby_rosters SET status='PUBLISHED', published_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_rosters", entityId: req.params.id, action: "ROSTER_PUBLISHED" });

    const roster = (await query<{ team_name: string; roster_month: string }>(
      `SELECT t.name AS team_name, sr.roster_month::text AS roster_month FROM standby_rosters sr JOIN teams t ON t.id=sr.team_id WHERE sr.id=$1`,
      [req.params.id]
    ))[0];
    const recipients = await query<{ full_name: string | null; email: string }>(
      `SELECT DISTINCT u.full_name, u.email FROM standby_assignments sa JOIN users u ON u.id = sa.user_id WHERE sa.roster_id=$1 AND u.email IS NOT NULL`,
      [req.params.id]
    );
    void notifyStandbyRosterPublished({
      rosterId: req.params.id,
      teamName: roster?.team_name || null,
      month: roster?.roster_month ? roster.roster_month.slice(0, 7) : "",
      recipients: recipients.map((r) => ({ name: r.full_name, email: r.email }))
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Only a DRAFT roster can be cancelled — once published, employees may
// already be relying on it and claims can only ever be generated from
// published assignments, so there's nothing to protect by blocking this.
standbyRouter.delete("/rosters/:id", async (req: AuthedRequest, res, next) => {
  try {
    const roster = await assertRosterOwner(req.params.id, req);
    if (roster.status !== "DRAFT") throw badRequest("Only a draft roster can be cancelled");
    await query(`DELETE FROM standby_rosters WHERE id=$1`, [req.params.id]);
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_rosters", entityId: req.params.id, action: "ROSTER_CANCELLED" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Roster-creation delegation is handled entirely by the existing
// /auth/delegations* endpoints (see auth.routes.ts) — Standby's frontend
// calls those directly with request_types: ["STANDBY_ROSTER"] and a
// team_id, rather than a separate standby-specific delegation API.

// ---------------------------------------------------------------------------
// My Standby / claim generation
// ---------------------------------------------------------------------------

standbyRouter.get("/my", async (req: AuthedRequest, res, next) => {
  try {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    const assignments = await query<any>(
      `SELECT sa.*, sr.status AS roster_status
         FROM standby_assignments sa
         JOIN standby_rosters sr ON sr.id = sa.roster_id
        WHERE sa.user_id=$1 AND sr.status='PUBLISHED'
          AND date_trunc('month', sa.standby_date) = date_trunc('month', $2::date)
        ORDER BY sa.standby_date`,
      [req.user!.userId, monthToDate(month)]
    );
    const totalHours = assignments.reduce((sum: number, a: any) => sum + Number(a.hours), 0);
    const existingClaim = (await query<{ id: string; status: string }>(
      `SELECT id, status FROM standby_claims WHERE employee_id=$1 AND claim_month=$2`,
      [req.user!.userId, monthToDate(month)]
    ))[0];
    return res.json({
      month,
      assignments,
      total_standby_hours: totalHours,
      claim: existingClaim || null
    });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/claims/generate", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ month: z.string() }).safeParse(req.body);
    if (!body.success) throw badRequest("month is required");
    const claimMonth = monthToDate(body.data.month);

    // Drafting is unrestricted — only actual submission is gated by
    // standby_claim_periods (see POST /claims/:id/submit), matching
    // Overtime's model exactly.

    // REJECTED is excluded so a formally-rejected claim doesn't permanently
    // block ever generating a new one for that month — the unique index
    // (idx_standby_claims_unique_normal) has the matching exclusion so this
    // INSERT below can actually succeed once the old claim is REJECTED.
    const existing = (await query<{ id: string }>(
      `SELECT id FROM standby_claims WHERE employee_id=$1 AND claim_month=$2 AND status <> 'REJECTED'`,
      [req.user!.userId, claimMonth]
    ))[0];
    if (existing) return res.json({ id: existing.id });

    const assignments = await query<any>(
      `SELECT sa.* FROM standby_assignments sa
         JOIN standby_rosters sr ON sr.id = sa.roster_id
        WHERE sa.user_id=$1 AND sr.status='PUBLISHED'
          AND date_trunc('month', sa.standby_date) = date_trunc('month', $2::date)
        ORDER BY sa.standby_date`,
      [req.user!.userId, claimMonth]
    );
    if (!assignments.length) throw badRequest("No published standby assignments found for that month");

    const totalHours = assignments.reduce((sum: number, a: any) => sum + Number(a.hours), 0);
    const compensableRatePct = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyCompensableRatePct, 10);
    const compensableHours = Math.round(totalHours * (compensableRatePct / 100) * 100) / 100;
    const claimNo = await nextClaimNo();

    const claim = (await query<{ id: string }>(
      `INSERT INTO standby_claims (claim_no, employee_id, claim_month, total_standby_hours, compensable_hours, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [claimNo, req.user!.userId, claimMonth, totalHours, compensableHours, req.user!.userId]
    ))[0];

    for (const a of assignments) {
      await query(
        `INSERT INTO standby_claim_lines (claim_id, assignment_id, standby_date, start_time, end_time, hours)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [claim.id, a.id, a.standby_date, a.start_time, a.end_time, a.hours]
      );
    }
    return res.status(201).json({ id: claim.id });
  } catch (err) {
    return next(err);
  }
});

async function loadClaimDetail(claimId: string) {
  const claim = (await query<any>(
    `SELECT sc.*, u.full_name AS employee_name, u.employee_no, u.title AS job_title
       FROM standby_claims sc JOIN users u ON u.id = sc.employee_id
      WHERE sc.id=$1`,
    [claimId]
  ))[0];
  if (!claim) return null;
  const lines = await query<any>(`SELECT * FROM standby_claim_lines WHERE claim_id=$1 ORDER BY standby_date`, [claimId]);
  const steps = await query<any>(
    `SELECT sas.*, u.full_name AS approver_name FROM standby_approval_steps sas
       JOIN users u ON u.id = sas.approver_user_id
      WHERE sas.claim_id=$1 AND sas.route_version=$2 ORDER BY sas.step_order`,
    [claimId, claim.current_route_version]
  );
  // Prior route attempts (before a send-back), kept for audit — "fully
  // auditable" per the spec, even though only the current version is live.
  const routeHistory =
    claim.current_route_version > 1
      ? await query<any>(
          `SELECT sas.*, u.full_name AS approver_name FROM standby_approval_steps sas
             JOIN users u ON u.id = sas.approver_user_id
            WHERE sas.claim_id=$1 AND sas.route_version < $2 ORDER BY sas.route_version, sas.step_order`,
          [claimId, claim.current_route_version]
        )
      : [];
  const orgPath = await getUserOrgPath(claim.employee_id);
  const originalClaim = claim.original_claim_id
    ? (await query<{ id: string; claim_no: string }>(`SELECT id, claim_no FROM standby_claims WHERE id=$1`, [claim.original_claim_id]))[0]
    : null;
  const adjustments = !claim.is_adjustment
    ? await query<{ id: string; claim_no: string; status: string; calculated_amount: string | null }>(`SELECT id, claim_no, status, calculated_amount FROM standby_claims WHERE original_claim_id=$1 ORDER BY adjustment_sequence`, [claimId])
    : [];
  return { ...claim, lines, approval_steps: steps, route_history: routeHistory, org_path: orgPath, original_claim: originalClaim, adjustments };
}

function isClaimOwner(claim: any, userId: string) {
  return claim.employee_id === userId || claim.created_by_id === userId;
}

// Finance authority is shared with Overtime — see lib/financeAuthority.ts.

standbyRouter.get("/claims", async (req: AuthedRequest, res, next) => {
  try {
    const rows =
      req.user!.role === "ADMIN"
        ? await query<any>(`SELECT sc.*, u.full_name AS employee_name FROM standby_claims sc JOIN users u ON u.id = sc.employee_id ORDER BY sc.created_at DESC`)
        : await query<any>(
            `SELECT sc.*, u.full_name AS employee_name FROM standby_claims sc JOIN users u ON u.id = sc.employee_id
              WHERE sc.employee_id=$1 ORDER BY sc.created_at DESC`,
            [req.user!.userId]
          );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

standbyRouter.get("/claims/:id", async (req: AuthedRequest, res, next) => {
  try {
    const claim = await loadClaimDetail(req.params.id);
    if (!claim) throw notFound();
    const isOwner = isClaimOwner(claim, req.user!.userId);
    const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "STANDBY_CLAIM");
    const isApprover = (claim.approval_steps as any[]).some((s) => s.approver_user_id === req.user!.userId || delegatedFor.includes(s.approver_user_id));
    const isFinance = await isCompensationFinanceUser(req);
    if (!isOwner && !isApprover && !isFinance && req.user!.role !== "ADMIN") throw forbidden();
    const currentStep = (claim.approval_steps as any[]).find((s) => s.step_order === claim.current_step_order);
    const isCurrentApprover = Boolean(currentStep && (currentStep.approver_user_id === req.user!.userId || delegatedFor.includes(currentStep.approver_user_id)));
    return res.json({ ...claim, is_current_approver: isCurrentApprover });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.get("/claims/:id/pdf", async (req: AuthedRequest, res, next) => {
  try {
    const claim = await loadClaimDetail(req.params.id);
    if (!claim) throw notFound();
    const isOwner = isClaimOwner(claim, req.user!.userId);
    const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "STANDBY_CLAIM");
    const isApprover = (claim.approval_steps as any[]).some((s) => s.approver_user_id === req.user!.userId || delegatedFor.includes(s.approver_user_id));
    const isFinance = await isCompensationFinanceUser(req);
    if (!isOwner && !isApprover && !isFinance && req.user!.role !== "ADMIN") throw forbidden();
    if (!(await canAccessPdf({ requestType: "STANDBY_CLAIM", userId: req.user!.userId, role: req.user!.role, isOwner, action: "view" }))) {
      throw forbidden();
    }

    const template = (await query<any>(`SELECT * FROM pdf_templates WHERE request_type = 'STANDBY_CLAIM' AND status = 'ACTIVE' LIMIT 1`))[0];
    if (!template) throw badRequest("No PDF template configured for standby claims yet.");

    const data = await resolveStandbyClaimPdfData(req.params.id);
    const catalog = await getFieldCatalogFor("STANDBY_CLAIM");
    const letterhead = (await query<PdfLetterhead>(`SELECT logo_path, logo_data, company_name, address_lines, contact_line, footer_confidentiality_text FROM pdf_letterhead_settings LIMIT 1`))[0] || {
      logo_path: null, logo_data: null, company_name: null, address_lines: [], contact_line: null, footer_confidentiality_text: null
    };
    const doc = renderPdfTemplate(template, letterhead, data, catalog);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="standby-claim-${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
});

standbyRouter.patch("/claims/:id", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM standby_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!isClaimOwner(claim, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (claim.status !== "DRAFT") throw badRequest("Only a draft claim can be edited");

    const body = z
      .object({
        compensation_preference: z.string().optional(),
        comments: z.string().optional(),
        approval_route: APPROVAL_ROUTE_SCHEMA.optional()
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid claim update", body.error.flatten());

    if (body.data.compensation_preference !== undefined || body.data.comments !== undefined) {
      await query(
        `UPDATE standby_claims SET compensation_preference=COALESCE($1,compensation_preference), comments=COALESCE($2,comments), updated_at=now() WHERE id=$3`,
        [body.data.compensation_preference ?? null, body.data.comments ?? null, req.params.id]
      );
    }

    if (body.data.approval_route) {
      // A claim owner can never name themself (or whoever prepared the claim
      // on their behalf) as their own approver.
      if (body.data.approval_route.some((step) => step.approver_user_id === claim.employee_id || step.approver_user_id === claim.created_by_id)) {
        throw badRequest("You cannot select yourself as an approver on your own claim");
      }
      // Only ever touches the claim's *current* route_version — any earlier
      // version (from a prior send-back) is frozen history, never edited.
      await query(`DELETE FROM standby_approval_steps WHERE claim_id=$1 AND route_version=$2`, [req.params.id, claim.current_route_version]);
      let order = 1;
      for (const step of body.data.approval_route) {
        await query(
          `INSERT INTO standby_approval_steps (claim_id, route_version, step_order, approver_user_id, title) VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, claim.current_route_version, order, step.approver_user_id, step.title]
        );
        order += 1;
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/claims/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM standby_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!isClaimOwner(claim, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (claim.status !== "DRAFT") throw badRequest("Claim has already been submitted");

    // claim_month comes back as a raw "YYYY-MM-DD" string (see the DATE
    // type-parser override in lib/db.ts) — split it directly rather than
    // going through `new Date(...)`, which would reinterpret it in local
    // time and risk an off-by-one month at the boundary.
    const [claimYear, claimMonthNum] = String(claim.claim_month).slice(0, 7).split("-").map(Number);
    const beforeDays = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyClaimWindowBeforeDays, 0);
    const afterDays = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyClaimWindowAfterDays, 0);
    if (!isClaimPeriodOpen(claimYear, claimMonthNum, beforeDays, afterDays)) {
      throw badRequest(`The claim window for ${claimMonthNum}/${claimYear} is currently closed — check the configured submission window with HR/Finance/Admin.`);
    }

    const steps = await query<any>(
      `SELECT sas.*, u.role AS approver_role FROM standby_approval_steps sas JOIN users u ON u.id = sas.approver_user_id WHERE sas.claim_id=$1 AND sas.route_version=$2 ORDER BY sas.step_order`,
      [req.params.id, claim.current_route_version]
    );
    if (!steps.length) throw badRequest("Add at least one approver to the Approval Route before submitting");

    // Section policy: some Sections require specific approver roles in the route.
    const employeeTeam = (await query<{ team_id: string | null }>(`SELECT team_id FROM users WHERE id=$1`, [claim.employee_id]))[0];
    if (employeeTeam?.team_id) {
      const team = (await query<{ standby_required_roles: string[]; name: string }>(`SELECT standby_required_roles, name FROM teams WHERE id=$1`, [employeeTeam.team_id]))[0];
      const missingRoles = (team?.standby_required_roles || []).filter((role) => !steps.some((s: any) => s.approver_role === role));
      if (missingRoles.length) {
        throw badRequest(`${team.name}'s policy requires a ${missingRoles.join(", ")} approver in the Approval Route before submission`);
      }
    }

    await query(
      `UPDATE standby_claims SET status='SUBMITTED', current_step_order=1, submitted_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id]
    );
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_claims", entityId: req.params.id, action: "CLAIM_SUBMITTED" });

    const employee = await getUserContact(claim.employee_id);
    const firstApprover = await getUserContact(steps[0].approver_user_id);
    void notifyStandbyClaimSubmitted({
      claimId: req.params.id,
      claimNo: claim.claim_no,
      employeeName: employee?.full_name || null,
      approverName: firstApprover?.full_name || null,
      approverEmail: firstApprover?.email || null,
      title: steps[0].title,
      approverId: steps[0].approver_user_id,
      stepOrder: 1,
      routeVersion: claim.current_route_version
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

standbyRouter.get("/approvals", async (req: AuthedRequest, res, next) => {
  try {
    // Includes claims awaiting anyone whose approval authority is currently
    // delegated to this user (request_type STANDBY_CLAIM), not just claims
    // directly assigned to them. Delegated items are flagged (is_delegated
    // / delegated_from_manager_name) rather than silently merged in, same
    // as the generic Inbox does for Advance/Clearance.
    const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "STANDBY_CLAIM");
    const approverIds = [req.user!.userId, ...delegatedFor];
    const rows = await query<any>(
      `SELECT sc.*, u.full_name AS employee_name, sas.title AS my_title, sas.approver_user_id
         FROM standby_claims sc
         JOIN standby_approval_steps sas ON sas.claim_id = sc.id AND sas.step_order = sc.current_step_order AND sas.route_version = sc.current_route_version
         JOIN users u ON u.id = sc.employee_id
        WHERE sas.approver_user_id = ANY($1::uuid[]) AND sas.status='PENDING'
        ORDER BY sc.submitted_at`,
      [approverIds]
    );
    const delegatingManagerNames = delegatedFor.length
      ? new Map((await query<{ id: string; full_name: string | null }>(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [delegatedFor])).map((u) => [u.id, u.full_name]))
      : new Map<string, string | null>();
    return res.json(rows.map((r) => ({
      ...r,
      is_delegated: r.approver_user_id !== req.user!.userId,
      delegated_from_manager_name: r.approver_user_id !== req.user!.userId ? delegatingManagerNames.get(r.approver_user_id) ?? null : null
    })));
  } catch (err) {
    return next(err);
  }
});

// Locks the claim row (SELECT ... FOR UPDATE) inside the caller's
// transaction and re-reads current_step_order/current_route_version fresh
// from it, rather than a separate unlocked read — otherwise two concurrent
// approve calls (a double-click, or a race between an approver and their
// active delegate) can each pass this check for the same step and each
// proceed to increment current_step_order, skipping the next approver.
async function assertCurrentApprover(claimId: string, actor: { userId: string; role: string }, client: PoolClient) {
  const claimRows = await client.query<any>(`SELECT * FROM standby_claims WHERE id=$1 FOR UPDATE`, [claimId]);
  const claim = claimRows.rows[0];
  if (!claim) throw notFound();
  const stepRows = await client.query<any>(
    `SELECT * FROM standby_approval_steps WHERE claim_id=$1 AND route_version=$2 AND step_order=$3`,
    [claimId, claim.current_route_version, claim.current_step_order]
  );
  const step = stepRows.rows[0];
  if (!step || step.approver_user_id !== actor.userId) {
    const delegatedFor = actor.role !== "ADMIN" ? await getDelegatedManagerIds(actor.userId, "STANDBY_CLAIM") : [];
    const isDelegate = Boolean(step && delegatedFor.includes(step.approver_user_id));
    if (!isDelegate && actor.role !== "ADMIN") throw forbidden("You are not the current approver for this claim");
  }
  return { claim, step };
}

// Shared by POST /claims/:id/approve and the email-approval flow.
export async function performStandbyClaimApprove(claimId: string, actor: { userId: string; role: string }, comments?: string | null) {
  const { claim, isFinal } = await withTransaction(async (client) => {
    const { claim, step } = await assertCurrentApprover(claimId, actor, client);
    if (claim.status !== "SUBMITTED") throw badRequest("Claim is not awaiting approval");
    if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

    await client.query(`UPDATE standby_approval_steps SET status='APPROVED', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, comments ?? null]);

    const totalStepsRows = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM standby_approval_steps WHERE claim_id=$1 AND route_version=$2`, [claimId, claim.current_route_version]);
    const isFinal = claim.current_step_order >= Number(totalStepsRows.rows[0].count);

    if (isFinal) {
      await client.query(`UPDATE standby_claims SET status='AWAITING_TREASURY', updated_at=now() WHERE id=$1`, [claimId]);
    } else {
      await client.query(`UPDATE standby_claims SET current_step_order=current_step_order+1, updated_at=now() WHERE id=$1`, [claimId]);
    }
    return { claim, isFinal };
  });

  await writeStandbyAudit({ actorId: actor.userId, entityType: "standby_claims", entityId: claimId, action: "CLAIM_STEP_APPROVED", after: { step_order: claim.current_step_order, comments } });

  if (isFinal) {
    const employee = await getUserContact(claim.employee_id);
    void notifyStandbyClaimFinanceReady({ claimId, claimNo: claim.claim_no, employeeName: employee?.full_name || null });
  } else {
    const nextStep = (await query<any>(`SELECT * FROM standby_approval_steps WHERE claim_id=$1 AND route_version=$2 AND step_order=$3`, [claimId, claim.current_route_version, claim.current_step_order + 1]))[0];
    const employee = await getUserContact(claim.employee_id);
    const nextApprover = nextStep ? await getUserContact(nextStep.approver_user_id) : null;
    if (nextStep && nextApprover) {
      void notifyStandbyClaimSubmitted({
        claimId,
        claimNo: claim.claim_no,
        employeeName: employee?.full_name || null,
        approverName: nextApprover.full_name,
        approverEmail: nextApprover.email,
        title: nextStep.title,
        approverId: nextStep.approver_user_id,
        stepOrder: claim.current_step_order + 1,
        routeVersion: claim.current_route_version
      });
    }
  }
  return { status: isFinal ? "AWAITING_TREASURY" : "SUBMITTED", isFinal };
}

standbyRouter.post("/claims/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const comments = String(req.body?.comments || "").trim() || null;
    const { isFinal } = await performStandbyClaimApprove(req.params.id, { userId: req.user!.userId, role: req.user!.role }, comments);
    return res.json({ ok: true, finance: isFinal });
  } catch (err) {
    return next(err);
  }
});

// Shared by POST /claims/:id/reject and the email-approval flow.
export async function performStandbyClaimReject(claimId: string, actor: { userId: string; role: string }, comments: string) {
  const { claim } = await withTransaction(async (client) => {
    const { claim, step } = await assertCurrentApprover(claimId, actor, client);
    if (claim.status !== "SUBMITTED") throw badRequest("Claim is not awaiting approval");
    if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

    await client.query(`UPDATE standby_approval_steps SET status='REJECTED', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, comments]);
    await client.query(`UPDATE standby_claims SET status='REJECTED', updated_at=now() WHERE id=$1`, [claimId]);
    return { claim };
  });
  await writeStandbyAudit({ actorId: actor.userId, entityType: "standby_claims", entityId: claimId, action: "CLAIM_REJECTED", after: { comments } });

  const employee = await getUserContact(claim.employee_id);
  void notifyStandbyClaimReturned({
    claimId, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
    reason: comments, action: "REJECTED"
  });
  return { status: "REJECTED" };
}

standbyRouter.post("/claims/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ comments: z.string().trim().min(1, "Comments are required") }).safeParse(req.body);
    if (!body.success) throw badRequest("Comments are required to reject");
    await performStandbyClaimReject(req.params.id, { userId: req.user!.userId, role: req.user!.role }, body.data.comments);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/claims/:id/send-back", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ comments: z.string().trim().min(1, "Comments are required") }).safeParse(req.body);
    if (!body.success) throw badRequest("Comments are required to send back");

    const { claim } = await withTransaction(async (client) => {
      const { claim, step } = await assertCurrentApprover(req.params.id, { userId: req.user!.userId, role: req.user!.role }, client);
      if (claim.status !== "SUBMITTED") throw badRequest("Claim is not awaiting approval");
      if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

      await client.query(`UPDATE standby_approval_steps SET status='SENT_BACK', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, body.data.comments]);
      // Bump the route version instead of deleting steps, so this route's full
      // history (who approved what, and where it was sent back) stays queryable
      // via route_history rather than being erased. The employee's next PATCH
      // rebuilds the route under the new version; the old version's rows never
      // change again.
      await client.query(
        `UPDATE standby_claims SET status='DRAFT', current_route_version=current_route_version+1, current_step_order=0, updated_at=now() WHERE id=$1`,
        [req.params.id]
      );
      return { claim };
    });
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_claims", entityId: req.params.id, action: "CLAIM_SENT_BACK", after: { comments: body.data.comments } });

    const employee = await getUserContact(claim.employee_id);
    void notifyStandbyClaimReturned({
      claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
      reason: body.data.comments, action: "RETURNED"
    });
    return res.json({ ok: true, comments: body.data.comments });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Call-Outs — see the standby_callout_claims schema comment above for the
// concept. Rate classification mirrors Overtime's exactly (server-side,
// authoritative, configurable via system settings, using the same shared
// public_holidays table) but with Call-Out's own two-bucket rate (weekday /
// weekend-or-holiday) instead of Overtime's three.
// ---------------------------------------------------------------------------

async function getCalloutRateSettings() {
  const [weekdayPct, weekendHolidayPct] = await Promise.all([
    getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyCalloutRateWeekdayPct, 150),
    getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyCalloutRateWeekendHolidayPct, 200)
  ]);
  return { weekdayPct, weekendHolidayPct };
}

async function getActiveHolidayDatesForCallout(): Promise<Set<string>> {
  const rows = await query<{ holiday_date: string; observed_date: string | null }>(
    `SELECT holiday_date::text AS holiday_date, observed_date::text AS observed_date FROM public_holidays WHERE active=true`
  );
  const dates = new Set<string>();
  for (const r of rows) {
    dates.add(r.holiday_date);
    if (r.observed_date) dates.add(r.observed_date);
  }
  return dates;
}

function calloutDayOfWeekName(dateStr: string): string {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const d = new Date(`${dateStr}T00:00:00`);
  return names[d.getDay()] ?? "";
}

function calloutHours(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes <= 0) minutes += 24 * 60; // wraps past midnight
  return Math.round((minutes / 60) * 100) / 100;
}

async function classifyCallout(callDate: string, startTime: string, endTime: string) {
  const [holidays, rates] = await Promise.all([getActiveHolidayDatesForCallout(), getCalloutRateSettings()]);
  const day = calloutDayOfWeekName(callDate);
  const hours = calloutHours(startTime, endTime);
  const isWeekendOrHoliday = day === "Saturday" || day === "Sunday" || holidays.has(callDate);
  const ratePct = isWeekendOrHoliday ? rates.weekendHolidayPct : rates.weekdayPct;
  const convertedHours = Math.round(hours * (ratePct / 100) * 100) / 100;
  return { hours, ratePct, convertedHours, day, isWeekendOrHoliday };
}

// "YYYY-MM-DD"+"HH:MM" -> minutes on a monotonic (not real-time) scale, used
// only to compare two wall-clock intervals against each other — never
// treated as an actual timestamp, so there's no timezone conversion risk.
function calloutAbsoluteMinutes(dateStr: string, timeStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi) / 60000;
}

function calloutInterval(dateStr: string, startTime: string, endTime: string): [number, number] {
  const start = calloutAbsoluteMinutes(dateStr, startTime);
  let end = calloutAbsoluteMinutes(dateStr, endTime);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// Does this employee have a PUBLISHED standby assignment whose window
// overlaps the given call-out time range? Checks both the call-out's own
// date and the day before it, since a standard standby assignment (e.g.
// 17:00 -> 08:00 the next day) is logged against the day it *starts*, not
// every day it covers.
async function findOverlappingStandbyAssignment(userId: string, callDate: string, startTime: string, endTime: string) {
  const candidates = await query<any>(
    `SELECT sa.* FROM standby_assignments sa
       JOIN standby_rosters sr ON sr.id = sa.roster_id AND sr.status='PUBLISHED'
      WHERE sa.user_id=$1 AND sa.standby_date IN ($2::date, $3::date)`,
    [userId, callDate, addDaysToDateString(callDate, -1)]
  );
  const [calloutStart, calloutEnd] = calloutInterval(callDate, startTime, endTime);
  for (const a of candidates) {
    const [aStart, aEnd] = calloutInterval(a.standby_date, a.start_time, a.end_time);
    if (calloutStart < aEnd && aStart < calloutEnd) return a;
  }
  return null;
}

function isCalloutOwner(claim: any, userId: string) {
  return claim.employee_id === userId || claim.created_by_id === userId;
}

const CALLOUT_SCHEMA = z.object({
  call_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}$/),
  reason: z.string().trim().min(1, "Reason is required"),
  approval_route: APPROVAL_ROUTE_SCHEMA.optional()
});

// Live check the frontend calls as the employee fills in the form, before
// ever creating a claim. Overtime, Standby and Call-Out are no longer
// gated against each other - a Call-Out can be requested at any time,
// whether or not it falls inside a published standby assignment - so this
// is now purely informational: it still tells the employee whether the
// time overlaps one of their standby assignments (shown as a note, not a
// block) and reports the rate/hours classification either way.
standbyRouter.get("/callouts/eligibility", async (req: AuthedRequest, res, next) => {
  try {
    const query_ = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).safeParse(req.query);
    if (!query_.success) throw badRequest("date, start, and end are required");
    const assignment = await findOverlappingStandbyAssignment(req.user!.userId, query_.data.date, query_.data.start, query_.data.end);
    const classified = await classifyCallout(query_.data.date, query_.data.start, query_.data.end);
    return res.json({
      eligible: true,
      insideStandbyAssignment: Boolean(assignment),
      message: assignment
        ? null
        : "This time doesn't fall inside any of your published standby assignments - you can still submit it as a Call-Out, or claim it as Overtime instead.",
      ...classified,
      standby_assignment_id: assignment?.id ?? null
    });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.get("/callouts", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT cc.*, u.full_name AS employee_name FROM standby_callout_claims cc
         JOIN users u ON u.id = cc.employee_id
        WHERE cc.employee_id=$1 OR $2 = 'ADMIN'
        ORDER BY cc.created_at DESC`,
      [req.user!.userId, req.user!.role]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

async function loadCalloutDetail(claimId: string) {
  const claim = (await query<any>(`SELECT * FROM standby_callout_claims WHERE id=$1`, [claimId]))[0];
  if (!claim) return null;
  const steps = await query<any>(
    `SELECT cas.*, u.full_name AS approver_name FROM standby_callout_approval_steps cas
       JOIN users u ON u.id = cas.approver_user_id
      WHERE cas.claim_id=$1 AND cas.route_version=$2 ORDER BY cas.step_order`,
    [claimId, claim.current_route_version]
  );
  const routeHistory = claim.current_route_version > 1
    ? await query<any>(
        `SELECT cas.*, u.full_name AS approver_name FROM standby_callout_approval_steps cas
           JOIN users u ON u.id = cas.approver_user_id
          WHERE cas.claim_id=$1 AND cas.route_version < $2 ORDER BY cas.route_version, cas.step_order`,
        [claimId, claim.current_route_version]
      )
    : [];
  const employee = await getUserContact(claim.employee_id);
  return { ...claim, employee_name: employee?.full_name, approval_steps: steps, route_history: routeHistory };
}

standbyRouter.get("/callouts/:id", async (req: AuthedRequest, res, next) => {
  try {
    const claim = await loadCalloutDetail(req.params.id);
    if (!claim) throw notFound();
    const isOwner = isCalloutOwner(claim, req.user!.userId);
    const isCurrentApprover = claim.approval_steps.some((s: any) => s.step_order === claim.current_step_order && s.approver_user_id === req.user!.userId);
    if (!isOwner && !isCurrentApprover && req.user!.role !== "ADMIN") throw forbidden();
    return res.json({ ...claim, is_owner: isOwner, is_current_approver: isCurrentApprover });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/callouts", async (req: AuthedRequest, res, next) => {
  try {
    const body = CALLOUT_SCHEMA.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid call-out payload", body.error.flatten());
    // Not gated against a published standby assignment - Overtime, Standby
    // and Call-Out can each be requested at any time, independently.
    // standby_assignment_id is still recorded when the time does happen to
    // fall inside one, purely for cross-reference; it stays null otherwise.
    const assignment = await findOverlappingStandbyAssignment(req.user!.userId, body.data.call_date, body.data.start_time, body.data.end_time);
    const classified = await classifyCallout(body.data.call_date, body.data.start_time, body.data.end_time);
    const claimNo = await nextSequentialNumber("STBCO", 4);
    const claim = (await query<{ id: string }>(
      `INSERT INTO standby_callout_claims
         (claim_no, employee_id, created_by_id, standby_assignment_id, call_date, start_time, end_time, hours, rate_pct, converted_hours, reason)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [claimNo, req.user!.userId, assignment?.id ?? null, body.data.call_date, body.data.start_time, body.data.end_time, classified.hours, classified.ratePct, classified.convertedHours, body.data.reason]
    ))[0];
    if (body.data.approval_route?.length) {
      let order = 1;
      for (const step of body.data.approval_route) {
        await query(
          `INSERT INTO standby_callout_approval_steps (claim_id, step_order, approver_user_id, title) VALUES ($1,$2,$3,$4)`,
          [claim.id, order++, step.approver_user_id, step.title]
        );
      }
    }
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_callout_claims", entityId: claim.id, action: "CALLOUT_CREATED", after: body.data });
    return res.status(201).json({ id: claim.id });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.patch("/callouts/:id", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM standby_callout_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!isCalloutOwner(claim, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (claim.status !== "DRAFT") throw badRequest("Only a Draft call-out can be edited");

    const body = CALLOUT_SCHEMA.partial().safeParse(req.body);
    if (!body.success) throw badRequest("Invalid call-out payload", body.error.flatten());

    const callDate = body.data.call_date ?? claim.call_date;
    const startTime = body.data.start_time ?? claim.start_time;
    const endTime = body.data.end_time ?? claim.end_time;
    if (body.data.call_date || body.data.start_time || body.data.end_time) {
      const assignment = await findOverlappingStandbyAssignment(req.user!.userId, callDate, startTime, endTime);
      const classified = await classifyCallout(callDate, startTime, endTime);
      await query(
        `UPDATE standby_callout_claims SET standby_assignment_id=$1, call_date=$2, start_time=$3, end_time=$4, hours=$5, rate_pct=$6, converted_hours=$7, updated_at=now() WHERE id=$8`,
        [assignment?.id ?? null, callDate, startTime, endTime, classified.hours, classified.ratePct, classified.convertedHours, claim.id]
      );
    }
    if (body.data.reason !== undefined) {
      await query(`UPDATE standby_callout_claims SET reason=$1, updated_at=now() WHERE id=$2`, [body.data.reason, claim.id]);
    }
    if (body.data.approval_route) {
      await query(`DELETE FROM standby_callout_approval_steps WHERE claim_id=$1 AND route_version=$2`, [claim.id, claim.current_route_version]);
      let order = 1;
      for (const step of body.data.approval_route) {
        await query(
          `INSERT INTO standby_callout_approval_steps (claim_id, route_version, step_order, approver_user_id, title) VALUES ($1,$2,$3,$4,$5)`,
          [claim.id, claim.current_route_version, order++, step.approver_user_id, step.title]
        );
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/callouts/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM standby_callout_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!isCalloutOwner(claim, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (claim.status !== "DRAFT") throw badRequest("Call-out has already been submitted");

    const steps = await query<any>(
      `SELECT cas.* FROM standby_callout_approval_steps cas WHERE cas.claim_id=$1 AND cas.route_version=$2 ORDER BY cas.step_order`,
      [claim.id, claim.current_route_version]
    );
    if (!steps.length) throw badRequest("Add at least one approver to the Approval Route before submitting");

    await query(
      `UPDATE standby_callout_claims SET status='SUBMITTED', current_step_order=1, submitted_at=now(), updated_at=now() WHERE id=$1`,
      [claim.id]
    );
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_callout_claims", entityId: claim.id, action: "CALLOUT_SUBMITTED" });

    const employee = await getUserContact(claim.employee_id);
    const firstApprover = await getUserContact(steps[0].approver_user_id);
    void notifyStandbyCalloutSubmitted({
      claimId: claim.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null,
      approverName: firstApprover?.full_name || null, approverEmail: firstApprover?.email || null, title: steps[0].title
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/callouts/:id/withdraw", async (req: AuthedRequest, res, next) => {
  try {
    const claim = (await query<any>(`SELECT * FROM standby_callout_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!isCalloutOwner(claim, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (!["DRAFT", "SUBMITTED"].includes(claim.status)) throw badRequest("This call-out can no longer be withdrawn");
    await query(`UPDATE standby_callout_claims SET status='WITHDRAWN', updated_at=now() WHERE id=$1`, [claim.id]);
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_callout_claims", entityId: claim.id, action: "CALLOUT_WITHDRAWN" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.get("/callouts-approvals", async (req: AuthedRequest, res, next) => {
  try {
    const delegatedFor = await getDelegatedManagerIds(req.user!.userId, "STANDBY_CALLOUT");
    const approverIds = [req.user!.userId, ...delegatedFor];
    const rows = await query<any>(
      `SELECT cc.*, u.full_name AS employee_name, cas.title AS my_title, cas.approver_user_id
         FROM standby_callout_claims cc
         JOIN standby_callout_approval_steps cas ON cas.claim_id = cc.id AND cas.step_order = cc.current_step_order AND cas.route_version = cc.current_route_version
         JOIN users u ON u.id = cc.employee_id
        WHERE cas.approver_user_id = ANY($1::uuid[]) AND cas.status='PENDING'
        ORDER BY cc.submitted_at`,
      [approverIds]
    );
    return res.json(rows.map((r) => ({ ...r, is_delegated: r.approver_user_id !== req.user!.userId })));
  } catch (err) {
    return next(err);
  }
});

async function assertCurrentCalloutApprover(claimId: string, actor: { userId: string; role: string }, client: PoolClient) {
  const claimRows = await client.query<any>(`SELECT * FROM standby_callout_claims WHERE id=$1 FOR UPDATE`, [claimId]);
  const claim = claimRows.rows[0];
  if (!claim) throw notFound();
  const stepRows = await client.query<any>(
    `SELECT * FROM standby_callout_approval_steps WHERE claim_id=$1 AND route_version=$2 AND step_order=$3`,
    [claimId, claim.current_route_version, claim.current_step_order]
  );
  const step = stepRows.rows[0];
  if (!step || step.approver_user_id !== actor.userId) {
    const delegatedFor = actor.role !== "ADMIN" ? await getDelegatedManagerIds(actor.userId, "STANDBY_CALLOUT") : [];
    const isDelegate = Boolean(step && delegatedFor.includes(step.approver_user_id));
    if (!isDelegate && actor.role !== "ADMIN") throw forbidden("You are not the current approver for this call-out");
  }
  return { claim, step };
}

standbyRouter.post("/callouts/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const comments = String(req.body?.comments || "").trim() || null;
    const { claim, isFinal } = await withTransaction(async (client) => {
      const { claim, step } = await assertCurrentCalloutApprover(req.params.id, { userId: req.user!.userId, role: req.user!.role }, client);
      if (claim.status !== "SUBMITTED") throw badRequest("Call-out is not awaiting approval");
      if (step.status !== "PENDING") throw badRequest("This step has already been actioned");

      await client.query(`UPDATE standby_callout_approval_steps SET status='APPROVED', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, comments]);
      const totalStepsRows = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM standby_callout_approval_steps WHERE claim_id=$1 AND route_version=$2`, [req.params.id, claim.current_route_version]);
      const isFinal = claim.current_step_order >= Number(totalStepsRows.rows[0].count);

      if (isFinal) {
        await client.query(`UPDATE standby_callout_claims SET status='AWAITING_TREASURY', updated_at=now() WHERE id=$1`, [req.params.id]);
      } else {
        await client.query(`UPDATE standby_callout_claims SET current_step_order=current_step_order+1, updated_at=now() WHERE id=$1`, [req.params.id]);
      }
      return { claim, isFinal };
    });
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_callout_claims", entityId: req.params.id, action: "CALLOUT_STEP_APPROVED", after: { comments } });

    const employee = await getUserContact(claim.employee_id);
    if (isFinal) {
      void notifyStandbyCalloutReadyForTreasury({ claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null });
    } else {
      const nextStep = (await query<any>(`SELECT * FROM standby_callout_approval_steps WHERE claim_id=$1 AND route_version=$2 AND step_order=$3`, [req.params.id, claim.current_route_version, claim.current_step_order + 1]))[0];
      const nextApprover = nextStep ? await getUserContact(nextStep.approver_user_id) : null;
      if (nextStep && nextApprover) {
        void notifyStandbyCalloutSubmitted({
          claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null,
          approverName: nextApprover.full_name, approverEmail: nextApprover.email, title: nextStep.title
        });
      }
    }
    return res.json({ ok: true, status: isFinal ? "AWAITING_TREASURY" : "SUBMITTED" });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/callouts/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ comments: z.string().trim().min(1, "Comments are required") }).safeParse(req.body);
    if (!body.success) throw badRequest("Comments are required to reject");
    const { claim } = await withTransaction(async (client) => {
      const { claim, step } = await assertCurrentCalloutApprover(req.params.id, { userId: req.user!.userId, role: req.user!.role }, client);
      if (claim.status !== "SUBMITTED") throw badRequest("Call-out is not awaiting approval");
      if (step.status !== "PENDING") throw badRequest("This step has already been actioned");
      await client.query(`UPDATE standby_callout_approval_steps SET status='REJECTED', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, body.data.comments]);
      await client.query(`UPDATE standby_callout_claims SET status='REJECTED', updated_at=now() WHERE id=$1`, [req.params.id]);
      return { claim };
    });
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_callout_claims", entityId: req.params.id, action: "CALLOUT_REJECTED", after: { comments: body.data.comments } });
    const employee = await getUserContact(claim.employee_id);
    void notifyStandbyCalloutReturned({
      claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
      reason: body.data.comments, action: "REJECTED"
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/callouts/:id/send-back", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ comments: z.string().trim().min(1, "Comments are required") }).safeParse(req.body);
    if (!body.success) throw badRequest("Comments are required to send back");
    const { claim } = await withTransaction(async (client) => {
      const { claim, step } = await assertCurrentCalloutApprover(req.params.id, { userId: req.user!.userId, role: req.user!.role }, client);
      if (claim.status !== "SUBMITTED") throw badRequest("Call-out is not awaiting approval");
      if (step.status !== "PENDING") throw badRequest("This step has already been actioned");
      await client.query(`UPDATE standby_callout_approval_steps SET status='SENT_BACK', decided_at=now(), comments=$2 WHERE id=$1`, [step.id, body.data.comments]);
      await client.query(
        `UPDATE standby_callout_claims SET status='DRAFT', current_route_version=current_route_version+1, current_step_order=0, updated_at=now() WHERE id=$1`,
        [req.params.id]
      );
      return { claim };
    });
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_callout_claims", entityId: req.params.id, action: "CALLOUT_SENT_BACK", after: { comments: body.data.comments } });
    const employee = await getUserContact(claim.employee_id);
    void notifyStandbyCalloutReturned({
      claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
      reason: body.data.comments, action: "RETURNED"
    });
    return res.json({ ok: true, comments: body.data.comments });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

standbyRouter.get("/finance/queue", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();
    const status = String(req.query.status || "").trim().toUpperCase();
    const filters = ["sc.status IN ('FINANCE_PROCESSING','PAYMENT_PENDING','PAID','CLOSED')"];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      filters.push(`sc.status=$${params.length}`);
    }
    const rows = await query<any>(
      `SELECT sc.*, u.full_name AS employee_name, t.name AS team_name
         FROM standby_claims sc
         JOIN users u ON u.id = sc.employee_id
         LEFT JOIN teams t ON t.id = u.team_id
        WHERE ${filters.join(" AND ")}
        ORDER BY sc.submitted_at`,
      params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/claims/:id/finance-process", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();
    const claim = (await query<any>(`SELECT * FROM standby_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (claim.status !== "FINANCE_PROCESSING") throw badRequest("Claim is not awaiting Finance processing");

    const body = z
      .object({
        hourly_rate: z.coerce.number().nonnegative(),
        cost_centre: z.string().trim().optional(),
        account_project: z.string().trim().optional(),
        payroll_period: z.string().trim().optional(),
        finance_reference: z.string().trim().optional(),
        finance_comments: z.string().trim().optional()
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid finance processing payload", body.error.flatten());

    // Governed list: once an admin has configured active codes for a kind,
    // Finance must pick from that list rather than free-typing a value that
    // could drift out of sync with the rest of the codes in use. Before any
    // codes are configured, free text still works so this doesn't block
    // Finance on day one.
    for (const [kind, value] of [
      ["COST_CENTRE", body.data.cost_centre],
      ["ACCOUNT_PROJECT", body.data.account_project]
    ] as const) {
      if (!value) continue;
      const activeCodes = await query<{ name: string }>(`SELECT name FROM standby_finance_codes WHERE kind=$1 AND active=true`, [kind]);
      if (activeCodes.length > 0 && !activeCodes.some((c) => c.name === value)) {
        throw badRequest(`"${value}" is not a configured ${kind === "COST_CENTRE" ? "cost centre" : "account/project"}`);
      }
    }

    const calculatedAmount = Math.round(Number(claim.compensable_hours) * body.data.hourly_rate * 100) / 100;

    await query(
      `UPDATE standby_claims SET
         hourly_rate=$1, calculated_amount=$2, cost_centre=$3, account_project=$4,
         payroll_period=$5, finance_reference=$6, finance_comments=$7,
         status='PAYMENT_PENDING', finance_processed_at=now(), updated_at=now()
       WHERE id=$8`,
      [
        body.data.hourly_rate,
        calculatedAmount,
        body.data.cost_centre || null,
        body.data.account_project || null,
        body.data.payroll_period || null,
        body.data.finance_reference || null,
        body.data.finance_comments || null,
        req.params.id
      ]
    );
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_claims", entityId: req.params.id, action: "CLAIM_FINANCE_PROCESSED", after: { ...body.data, calculated_amount: calculatedAmount } });

    const employee = await getUserContact(claim.employee_id);
    void notifyStandbyClaimProcessed({ claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null, amount: calculatedAmount });
    return res.json({ ok: true, calculated_amount: calculatedAmount });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/claims/:id/finance-return", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();
    const body = z.object({ comments: z.string().trim().min(1, "A reason is required") }).safeParse(req.body);
    if (!body.success) throw badRequest("A reason is required to return a claim");
    const claim = (await query<any>(`SELECT * FROM standby_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (!["FINANCE_PROCESSING", "PAYMENT_PENDING"].includes(claim.status)) throw badRequest("Claim is not with Finance");

    // Back to DRAFT (same as an approver send-back) rather than a dead-end
    // "RETURNED" status — the employee corrects and resubmits, which bumps
    // the route version so the already-completed approval history stays
    // intact and queryable while a fresh route is built for the resubmission.
    await query(
      `UPDATE standby_claims SET status='DRAFT', finance_comments=$2, current_route_version=current_route_version+1, current_step_order=0, updated_at=now() WHERE id=$1`,
      [req.params.id, body.data.comments]
    );
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_claims", entityId: req.params.id, action: "CLAIM_FINANCE_RETURNED", after: { comments: body.data.comments } });

    const employee = await getUserContact(claim.employee_id);
    void notifyStandbyClaimReturned({
      claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null,
      reason: body.data.comments, action: "RETURNED"
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Reuses the existing "mark paid" concept from the app's other payment
// flows rather than the full generic Payments queue, which is scoped to
// advance_requests today — see solution-scope note at top of file.
standbyRouter.post("/claims/:id/mark-paid", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();
    const claim = (await query<any>(`SELECT * FROM standby_claims WHERE id=$1`, [req.params.id]))[0];
    if (!claim) throw notFound();
    if (claim.status !== "PAYMENT_PENDING") throw badRequest("Claim is not awaiting payment");

    await query(
      `UPDATE standby_claims SET status='CLOSED', paid_at=now(), closed_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id]
    );
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_claims", entityId: req.params.id, action: "CLAIM_PAID" });

    const employee = await getUserContact(claim.employee_id);
    void notifyStandbyClaimPaid({ claimId: req.params.id, claimNo: claim.claim_no, employeeName: employee?.full_name || null, employeeEmail: employee?.email || null, amount: Number(claim.calculated_amount || 0) });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Adjustments — a claim can't be edited once paid (claim integrity), so a
// missed day or an overpayment is corrected via a new claim linked back to
// the original. Adjustment claims reuse the exact same submit/approve/
// finance/paid lifecycle as a normal claim — only their creation differs.
// ---------------------------------------------------------------------------

const ADJUSTMENT_LINE_SCHEMA = z.object({
  standby_date: z.string(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  hours: z.coerce.number()
});

standbyRouter.get("/claims/:id/adjustments", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT sc.* FROM standby_claims sc WHERE sc.original_claim_id=$1 ORDER BY sc.adjustment_sequence`,
      [req.params.id]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/claims/:id/adjustments", async (req: AuthedRequest, res, next) => {
  try {
    const original = (await query<any>(`SELECT * FROM standby_claims WHERE id=$1`, [req.params.id]))[0];
    if (!original) throw notFound();
    if (!isClaimOwner(original, req.user!.userId) && req.user!.role !== "ADMIN") throw forbidden();
    if (original.status !== "CLOSED") throw badRequest("Adjustments can only be raised against a paid, closed claim");

    const body = z
      .object({
        reason: z.string().trim().min(1, "A reason is required"),
        lines: z.array(ADJUSTMENT_LINE_SCHEMA).min(1, "At least one line is required")
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid adjustment payload", body.error.flatten());

    const seqRow = (await query<{ count: string }>(`SELECT count(*)::text AS count FROM standby_claims WHERE original_claim_id=$1`, [req.params.id]))[0];
    const seq = Number(seqRow.count) + 1;
    const claimNo = `${original.claim_no}-A${String(seq).padStart(2, "0")}`;

    const totalHours = body.data.lines.reduce((sum, l) => sum + Number(l.hours), 0);
    const compensableRatePct = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyCompensableRatePct, 10);
    const compensableHours = Math.round(totalHours * (compensableRatePct / 100) * 100) / 100;

    const created = (await query<{ id: string }>(
      `INSERT INTO standby_claims (claim_no, employee_id, claim_month, total_standby_hours, compensable_hours, comments, is_adjustment, original_claim_id, adjustment_sequence, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9) RETURNING id`,
      [claimNo, original.employee_id, original.claim_month, totalHours, compensableHours, body.data.reason, req.params.id, seq, req.user!.userId]
    ))[0];

    for (const line of body.data.lines) {
      await query(
        `INSERT INTO standby_claim_lines (claim_id, standby_date, start_time, end_time, hours) VALUES ($1,$2,$3,$4,$5)`,
        [created.id, line.standby_date, line.start_time || null, line.end_time || null, line.hours]
      );
    }
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_claims", entityId: created.id, action: "ADJUSTMENT_CREATED", after: { original_claim_id: req.params.id, reason: body.data.reason } });
    return res.status(201).json({ id: created.id, claim_no: claimNo });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Approver search (for the Approval Route builder)
// ---------------------------------------------------------------------------

standbyRouter.get("/eligible-approvers", async (req: AuthedRequest, res, next) => {
  try {
    const search = String(req.query.search || "").trim();
    if (search.length < 2) return res.json([]);
    const rows = await query<any>(
      `SELECT id, full_name, employee_no, title, role, department
         FROM users
        WHERE is_active=true AND id <> $1
          AND (full_name ILIKE $2 OR employee_no ILIKE $2)
        ORDER BY full_name LIMIT 20`,
      [req.user!.userId, `%${search}%`]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Read-only published-roster view (7.12) — every employee can see who's on
// standby without any create/edit/publish/delete capability.
// ---------------------------------------------------------------------------

standbyRouter.get("/roster-view", async (req: AuthedRequest, res, next) => {
  try {
    const scope = String(req.query.scope || "SECTION").toUpperCase();
    const range = String(req.query.range || "TODAY").toUpperCase();
    const dateParam = String(req.query.date || new Date().toISOString().slice(0, 10));
    const anchor = new Date(dateParam);
    if (Number.isNaN(anchor.getTime())) throw badRequest("Invalid date");

    let rangeStart = dateParam;
    let rangeEnd = dateParam;
    if (range === "WEEK") {
      const start = new Date(anchor);
      start.setDate(anchor.getDate() - anchor.getDay());
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      rangeStart = start.toISOString().slice(0, 10);
      rangeEnd = end.toISOString().slice(0, 10);
    } else if (range === "MONTH") {
      const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      rangeStart = start.toISOString().slice(0, 10);
      rangeEnd = end.toISOString().slice(0, 10);
    }

    const params: unknown[] = [rangeStart, rangeEnd];
    let scopeFilter = "";
    if (scope !== "ALL") {
      const orgPath = await getUserOrgPath(req.user!.userId);
      if (scope === "SECTION" && orgPath?.team_id) {
        params.push(orgPath.team_id);
        scopeFilter = `AND t.id=$${params.length}`;
      } else if (scope === "DEPARTMENT" && orgPath?.section_id) {
        params.push(orgPath.section_id);
        scopeFilter = `AND t.section_id=$${params.length}`;
      } else if (scope === "DIVISION" && orgPath?.division_id) {
        params.push(orgPath.division_id);
        scopeFilter = `AND EXISTS (SELECT 1 FROM section_division_links sdl WHERE sdl.section_id = t.section_id AND sdl.division_id=$${params.length})`;
      } else {
        // No org placement at that level for this viewer — nothing to show.
        return res.json([]);
      }
    }

    const rows = await query<any>(
      `SELECT sa.id, sa.standby_date, sa.start_time, sa.end_time, sa.hours, u.full_name, u.title, u.email, u.phone, t.name AS team_name
         FROM standby_assignments sa
         JOIN standby_rosters sr ON sr.id = sa.roster_id AND sr.status='PUBLISHED'
         JOIN teams t ON t.id = sr.team_id
         JOIN users u ON u.id = sa.user_id
        WHERE sa.standby_date BETWEEN $1 AND $2 ${scopeFilter}
        ORDER BY sa.standby_date, u.full_name`,
      params
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Section standby policy (ADMIN only)
// ---------------------------------------------------------------------------

const STANDBY_POLICY_ROLES = ["MANAGER", "HOD", "EXCO", "FINANCE", "CEO"] as const;

standbyRouter.patch("/teams/:id/settings", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can change Section policy");
    const body = z.object({ required_roles: z.array(z.enum(STANDBY_POLICY_ROLES)).max(STANDBY_POLICY_ROLES.length) }).safeParse(req.body);
    if (!body.success) throw badRequest("Invalid payload", body.error.flatten());
    const dedupedRoles = [...new Set(body.data.required_roles)];
    await query(`UPDATE teams SET standby_required_roles=$1 WHERE id=$2`, [dedupedRoles, req.params.id]);
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "teams", entityId: req.params.id, action: "STANDBY_POLICY_UPDATED", after: { required_roles: dedupedRoles } });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Which Departments (sections table) have compensation Finance authority —
// shared with Overtime, see lib/financeAuthority.ts.
standbyRouter.get("/finance-sections", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can view Finance section assignment");
    const rows = await query<any>(
      `SELECT s.id, s.name, s.is_compensation_finance, d.name AS division_name
         FROM sections s
         LEFT JOIN departments d ON d.id = s.department_id
        WHERE s.active = true
        ORDER BY s.name`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

standbyRouter.patch("/finance-sections/:id", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can change Finance section assignment");
    const body = z.object({ is_compensation_finance: z.boolean() }).safeParse(req.body);
    if (!body.success) throw badRequest("Invalid payload", body.error.flatten());
    await query(`UPDATE sections SET is_compensation_finance=$1 WHERE id=$2`, [body.data.is_compensation_finance, req.params.id]);
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "sections", entityId: req.params.id, action: "COMPENSATION_FINANCE_SECTION_UPDATED", after: body.data });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// Compensation formulas/rates must be "configurable and should not be
// embedded in UI code" — a global compensable-hours percentage and a
// default hourly rate Finance can accept or override per claim.
// The claim window replaces the old manual per-month Open/Close claim-
// periods panel with a recurring rule (see lib/claimWindow.ts): configure
// once, applies to every month automatically.
standbyRouter.get("/settings", async (req: AuthedRequest, res, next) => {
  try {
    const [compensableRatePct, defaultHourlyRate, claimWindowBeforeDays, claimWindowAfterDays] = await Promise.all([
      getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyCompensableRatePct, 10),
      getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyDefaultHourlyRate, 0),
      getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyClaimWindowBeforeDays, 0),
      getNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyClaimWindowAfterDays, 0)
    ]);
    return res.json({
      compensable_rate_pct: compensableRatePct,
      default_hourly_rate: defaultHourlyRate,
      claim_window_before_days: claimWindowBeforeDays,
      claim_window_after_days: claimWindowAfterDays
    });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.put("/settings", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN" && !(await isHrOperationsUser(req))) throw forbidden("Only an administrator or HR Operations can change Standby settings");
    // default_hourly_rate is accepted but no longer sent by the UI — there's
    // no Finance/money stage left to seed a rate for.
    const body = z
      .object({
        compensable_rate_pct: z.coerce.number().min(0).max(100),
        default_hourly_rate: z.coerce.number().min(0).optional(),
        claim_window_before_days: z.coerce.number().int().min(0).max(31),
        claim_window_after_days: z.coerce.number().int().min(0).max(31)
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid settings payload", body.error.flatten());
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyCompensableRatePct, body.data.compensable_rate_pct);
    if (body.data.default_hourly_rate !== undefined) {
      await setNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyDefaultHourlyRate, body.data.default_hourly_rate);
    }
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyClaimWindowBeforeDays, body.data.claim_window_before_days);
    await setNumericSystemSetting(SYSTEM_SETTING_KEYS.standbyClaimWindowAfterDays, body.data.claim_window_after_days);
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_settings", entityId: req.user!.userId, action: "SETTINGS_UPDATED", after: body.data });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Governed cost centre / account-project master list for Finance processing
// ---------------------------------------------------------------------------

const FINANCE_CODE_KINDS = ["COST_CENTRE", "ACCOUNT_PROJECT"] as const;

standbyRouter.get("/finance-codes", async (req: AuthedRequest, res, next) => {
  try {
    const kind = z.enum(FINANCE_CODE_KINDS).optional().parse(req.query.kind || undefined);
    const includeInactive = req.user!.role === "ADMIN" && req.query.all === "true";
    const rows = await query<any>(
      `SELECT * FROM standby_finance_codes
        WHERE ($1::text IS NULL OR kind=$1) AND ($2::boolean OR active=true)
        ORDER BY kind, name`,
      [kind ?? null, includeInactive]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

standbyRouter.post("/finance-codes", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can manage the finance code list");
    const body = z.object({ kind: z.enum(FINANCE_CODE_KINDS), name: z.string().trim().min(1).max(120) }).safeParse(req.body);
    if (!body.success) throw badRequest("Invalid finance code payload", body.error.flatten());
    const rows = await query<{ id: string }>(
      `INSERT INTO standby_finance_codes (kind, name) VALUES ($1,$2) ON CONFLICT (kind, name) DO UPDATE SET active=true RETURNING id`,
      [body.data.kind, body.data.name]
    );
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_finance_codes", entityId: rows[0].id, action: "FINANCE_CODE_CREATED", after: body.data });
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.patch("/finance-codes/:id", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can manage the finance code list");
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), active: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) throw badRequest("Invalid finance code payload", body.error.flatten());
    await query(
      `UPDATE standby_finance_codes SET name=COALESCE($1,name), active=COALESCE($2,active) WHERE id=$3`,
      [body.data.name ?? null, body.data.active ?? null, req.params.id]
    );
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_finance_codes", entityId: req.params.id, action: "FINANCE_CODE_UPDATED", after: body.data });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

standbyRouter.delete("/finance-codes/:id", async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can manage the finance code list");
    await query(`DELETE FROM standby_finance_codes WHERE id=$1`, [req.params.id]);
    await writeStandbyAudit({ actorId: req.user!.userId, entityType: "standby_finance_codes", entityId: req.params.id, action: "FINANCE_CODE_DELETED" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Reporting (13. Reporting, Audit and Controls)
// ---------------------------------------------------------------------------

standbyRouter.get("/reports/operational", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();

    const rosterCoverage = await query<any>(
      `SELECT t.name AS section, sr.roster_month::text AS month, count(DISTINCT sa.user_id)::int AS employees_covered
         FROM standby_rosters sr JOIN teams t ON t.id=sr.team_id
         LEFT JOIN standby_assignments sa ON sa.roster_id=sr.id
        WHERE sr.status='PUBLISHED'
        GROUP BY t.name, sr.roster_month ORDER BY sr.roster_month DESC, t.name`
    );

    const notSubmitted = await query<any>(
      `SELECT DISTINCT u.full_name, u.employee_no, sr.roster_month::text AS month, t.name AS section
         FROM standby_rosters sr
         JOIN teams t ON t.id = sr.team_id
         JOIN standby_assignments sa ON sa.roster_id = sr.id
         JOIN users u ON u.id = sa.user_id
        WHERE sr.status='PUBLISHED'
          AND NOT EXISTS (
            SELECT 1 FROM standby_claims sc WHERE sc.employee_id = sa.user_id AND sc.claim_month = sr.roster_month AND NOT sc.is_adjustment
          )
        ORDER BY sr.roster_month DESC, u.full_name`
    );

    const byStage = await query<any>(`SELECT status, count(*)::int AS count FROM standby_claims WHERE NOT is_adjustment GROUP BY status`);

    return res.json({ roster_coverage: rosterCoverage, not_submitted: notSubmitted, by_stage: byStage });
  } catch (err) {
    return next(err);
  }
});

// No more Finance/money stage — every closed claim already carries its
// compensable hours, so this reports on hours rather than an amount paid.
standbyRouter.get("/reports/financial", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isCompensationFinanceUser(req))) throw forbidden();

    const byMonth = await query<any>(
      `SELECT claim_month::text AS month, sum(compensable_hours)::numeric(14,2) AS total
         FROM standby_claims WHERE status = 'CLOSED'
        GROUP BY claim_month ORDER BY claim_month DESC`
    );

    const bySection = await query<any>(
      `SELECT COALESCE(t.name,'Unassigned') AS section, sum(sc.compensable_hours)::numeric(14,2) AS total
         FROM standby_claims sc JOIN users u ON u.id=sc.employee_id LEFT JOIN teams t ON t.id=u.team_id
        WHERE sc.status = 'CLOSED'
        GROUP BY t.name ORDER BY total DESC`
    );

    const totalCompensableHours = (await query<{ total: string }>(
      `SELECT COALESCE(SUM(compensable_hours), 0)::numeric(14,2) AS total FROM standby_claims WHERE status = 'CLOSED'`
    ))[0];

    const adjustments = await query<any>(
      `SELECT sc.claim_no, oc.claim_no AS original_claim_no, sc.status, sc.compensable_hours, sc.comments, sc.created_at
         FROM standby_claims sc LEFT JOIN standby_claims oc ON oc.id = sc.original_claim_id
        WHERE sc.is_adjustment=true ORDER BY sc.created_at DESC`
    );

    return res.json({ by_month: byMonth, by_section: bySection, total_compensable_hours: Number(totalCompensableHours.total), adjustments });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

standbyRouter.get("/dashboard", async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user!.role;
    const scopeClause = role === "ADMIN" ? "" : "AND t.leader_user_id = $1";
    const params = role === "ADMIN" ? [] : [req.user!.userId];

    const activeRosters = (await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM standby_rosters sr JOIN teams t ON t.id=sr.team_id WHERE sr.status='PUBLISHED' ${scopeClause}`,
      params
    ))[0];
    // 'RETURNED' is never actually set — send-back reverts a claim straight
    // to 'DRAFT' (see /claims/:id/send-back), so DRAFT alone covers it.
    const awaitingClaims = (await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM standby_claims WHERE status = 'DRAFT'`
    ))[0];
    const inApproval = (await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM standby_claims WHERE status='SUBMITTED'`
    ))[0];
    const closedThisMonth = (await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM standby_claims WHERE status='CLOSED' AND closed_at >= date_trunc('month', now())`
    ))[0];

    const orgPath = await getUserOrgPath(req.user!.userId);
    const onStandbyToday =
      role === "ADMIN" || orgPath?.team_id
        ? await query<any>(
            `SELECT u.full_name, u.title, u.email, u.phone, sa.start_time, sa.end_time
               FROM standby_assignments sa
               JOIN standby_rosters sr ON sr.id = sa.roster_id AND sr.status='PUBLISHED'
               JOIN users u ON u.id = sa.user_id
              WHERE sa.standby_date = CURRENT_DATE ${role === "ADMIN" ? "" : "AND sr.team_id = $1"}
              ORDER BY u.full_name`,
            role === "ADMIN" ? [] : [orgPath!.team_id]
          )
        : [];

    return res.json({
      active_rosters: Number(activeRosters.count),
      awaiting_claims: Number(awaitingClaims.count),
      in_approval: Number(inApproval.count),
      closed_this_month: Number(closedThisMonth.count),
      on_standby_today: onStandbyToday,
      is_finance: await isCompensationFinanceUser(req),
      is_hr: await isHrOperationsUser(req)
    });
  } catch (err) {
    return next(err);
  }
});
