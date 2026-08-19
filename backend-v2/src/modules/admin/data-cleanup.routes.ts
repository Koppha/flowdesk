import { Router } from "express";
import { z } from "zod";
import pg from "pg";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { query, withTransaction } from "../../lib/db.js";

export const dataCleanupRouter = Router();
dataCleanupRouter.use(requireAuth);

// Deliberately NOT gated via admin_feature_permissions like every other
// module - this deletes production data, so it's ADMIN-only, full stop,
// with no path for an admin to delegate it to another role/group.
dataCleanupRouter.use((req: AuthedRequest, _res, next) => {
  if (req.user!.role !== "ADMIN") return next(forbidden("Only ADMIN can access data cleanup"));
  next();
});

type Category = {
  key: string;
  label: string;
  // Root table whose row count represents "how many of these are there" for
  // display, and whose deletion count is returned as the category's result.
  countTable: string;
  // Ordered leaf-to-root DELETE statements - children before the parents
  // they reference, matching the FK dependency graph.
  deletes: string[];
};

const CATEGORIES: Category[] = [
  {
    key: "advances",
    label: "Advance Requests",
    countTable: "advance_requests",
    deletes: [
      // clearance_claims.linked_advance_id references advance_requests, but
      // Clearance Claims is a separate, independently-selectable category -
      // detach rather than delete so this is safe whether or not it's also
      // selected in the same request.
      "UPDATE clearance_claims SET linked_advance_id = NULL WHERE linked_advance_id IS NOT NULL",
      "DELETE FROM advance_lines",
      "DELETE FROM approvals WHERE doc_type = 'ADVANCE'",
      "DELETE FROM accommodation_quotations WHERE accommodation_request_id IN (SELECT id FROM accommodation_requests WHERE advance_request_id IS NOT NULL)",
      "DELETE FROM accommodation_requests WHERE advance_request_id IS NOT NULL",
      "DELETE FROM advance_requests"
    ]
  },
  {
    key: "clearances",
    label: "Clearance Claims",
    countTable: "clearance_claims",
    deletes: [
      "DELETE FROM claim_trips",
      "DELETE FROM receipts",
      "DELETE FROM approvals WHERE doc_type = 'CLAIM'",
      "DELETE FROM clearance_claims"
    ]
  },
  {
    key: "custom_requests",
    label: "Custom Processes (incl. Computer Requests)",
    countTable: "custom_request_submissions",
    deletes: [
      "DELETE FROM it_provisioning_tasks",
      "DELETE FROM custom_request_attachments",
      "DELETE FROM custom_request_submissions"
    ]
  },
  {
    key: "overtime",
    label: "Overtime Requests & Claims",
    countTable: "overtime_requests",
    deletes: [
      "DELETE FROM overtime_claim_approval_steps",
      "DELETE FROM overtime_claims",
      "DELETE FROM overtime_request_approval_steps",
      "DELETE FROM overtime_requests"
    ]
  },
  {
    key: "standby",
    label: "Standby Claims, Rosters & Assignments",
    countTable: "standby_claims",
    deletes: [
      "DELETE FROM standby_approval_steps",
      "DELETE FROM standby_claims",
      "DELETE FROM standby_assignments",
      "DELETE FROM standby_rosters"
    ]
  },
  {
    key: "accommodation",
    label: "Accommodation Requests",
    countTable: "accommodation_requests",
    deletes: [
      "DELETE FROM accommodation_quotations",
      "DELETE FROM accommodation_requests"
    ]
  },
  {
    key: "deductions",
    label: "Deductions",
    countTable: "deductions",
    deletes: ["DELETE FROM deductions"]
  },
  {
    key: "attendance",
    label: "Attendance Records",
    countTable: "attendance_records",
    deletes: ["DELETE FROM attendance_records"]
  },
  {
    key: "email_action_tokens",
    label: "Email Action Tokens",
    countTable: "email_action_tokens",
    deletes: ["DELETE FROM email_action_tokens"]
  },
  {
    key: "manager_delegations",
    label: "Manager Delegations",
    countTable: "manager_delegations",
    deletes: ["DELETE FROM manager_delegations"]
  },
  {
    key: "reporting_lines",
    label: "Reporting Lines",
    countTable: "reporting_lines",
    deletes: ["DELETE FROM reporting_lines"]
  },
  {
    key: "position_vacancies",
    label: "Position Vacancies",
    countTable: "position_vacancies",
    deletes: ["DELETE FROM position_vacancies"]
  },
  {
    key: "tour_progress",
    label: "Guided Tour Progress",
    countTable: "tour_progress",
    deletes: ["DELETE FROM tour_progress"]
  },
  {
    key: "audit_log",
    label: "Audit Log",
    countTable: "audit_log",
    deletes: ["DELETE FROM audit_log"]
  }
];

const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.key, c]));

// GET /admin/data-cleanup/categories — list + live row counts, for the UI to render checkboxes against.
dataCleanupRouter.get("/categories", async (_req, res, next) => {
  try {
    const counts = await Promise.all(
      CATEGORIES.map(async (c) => {
        const rows = await query<{ count: string }>(`SELECT count(*)::text AS count FROM ${c.countTable}`);
        return { key: c.key, label: c.label, count: Number(rows[0]?.count || 0) };
      })
    );
    return res.json({ categories: counts });
  } catch (err) {
    return next(err);
  }
});

const WIPE_SCHEMA = z.object({
  categories: z.array(z.string()).min(1),
  confirm: z.literal("WIPE")
});

// POST /admin/data-cleanup — deletes only the selected categories' data.
// Requires the literal string "WIPE" so this can never fire from a stray
// click; the frontend makes the user type it.
dataCleanupRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = WIPE_SCHEMA.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request", parsed.error.flatten());

    const unknown = parsed.data.categories.filter((k) => !CATEGORY_MAP.has(k));
    if (unknown.length) throw badRequest(`Unknown categories: ${unknown.join(", ")}`);
    const selected = new Set(parsed.data.categories);

    const deleted: Record<string, number> = {};
    await withTransaction(async (client: pg.PoolClient) => {
      // Iterate CATEGORIES in its own fixed order, not whatever order the
      // client sent - some categories decouple/detach cross-references to
      // others (see "advances"), and that only works if it isn't at the
      // mercy of client-supplied ordering.
      for (const category of CATEGORIES) {
        if (!selected.has(category.key)) continue;
        const before = await client.query(`SELECT count(*)::text AS count FROM ${category.countTable}`);
        for (const stmt of category.deletes) {
          await client.query(stmt);
        }
        deleted[category.key] = Number(before.rows[0]?.count || 0);
      }
    });

    return res.json({ ok: true, deleted });
  } catch (err) {
    return next(err);
  }
});

const RESET_SCHEMA = z.object({
  confirm: z.literal("RESET EVERYTHING"),
  keepAdminEmail: z.string().email()
});

// POST /admin/data-cleanup/full-reset — the nuclear option: wipes every
// category above PLUS every user except keepAdminEmail PLUS the entire org
// structure (divisions/departments/sections/teams). Mirrors
// db/scripts/full-reset-keep-admin.sql, extended to cover tables that
// script predates (standby, IT provisioning, tour progress). Kept as a
// separate route with its own stronger confirmation phrase and an
// explicit, caller-supplied admin email (never defaulted) so this can't be
// triggered by the same click path as an ordinary category wipe.
dataCleanupRouter.post("/full-reset", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = RESET_SCHEMA.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request", parsed.error.flatten());

    const summary = await withTransaction(async (client: pg.PoolClient) => {
      const adminRows = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        [parsed.data.keepAdminEmail]
      );
      if (adminRows.rows.length !== 1) {
        throw badRequest(`Expected exactly 1 user with email ${parsed.data.keepAdminEmail}, found ${adminRows.rows.length}`);
      }
      const keepId = adminRows.rows[0].id;

      const usersBefore = await client.query(`SELECT count(*)::text AS count FROM users`);

      // Detach org structure from users first (FKs), then delete every
      // category's transactional data, then org structure, then users.
      await client.query(`UPDATE users SET division_id = NULL, section_id = NULL, team_id = NULL WHERE division_id IS NOT NULL OR section_id IS NOT NULL OR team_id IS NOT NULL`);
      await client.query(`UPDATE position_vacancies SET division_id = NULL, section_id = NULL, team_id = NULL WHERE division_id IS NOT NULL OR section_id IS NOT NULL OR team_id IS NOT NULL`);
      await client.query(`UPDATE departments SET section_id = NULL WHERE section_id IS NOT NULL`);
      await client.query(`UPDATE sections SET department_id = NULL WHERE department_id IS NOT NULL`);

      // Detach kept config/definition tables from users (rows survive, only
      // "who touched this" links are cleared) - same set as the standalone script.
      await client.query(`UPDATE workflows SET created_by_id = NULL WHERE created_by_id IS NOT NULL`);
      await client.query(`UPDATE workflow_rules SET additional_assigned_user_id = NULL WHERE additional_assigned_user_id IS NOT NULL`);
      await client.query(`UPDATE workflow_steps SET assigned_user_id = NULL, assigned_user_ids = '{}' WHERE assigned_user_id IS NOT NULL OR array_length(assigned_user_ids, 1) IS NOT NULL`);
      await client.query(`UPDATE custom_request_types SET created_by_id = NULL WHERE created_by_id IS NOT NULL`);
      await client.query(`UPDATE request_type_permissions SET user_id = NULL, created_by_id = NULL WHERE user_id IS NOT NULL OR created_by_id IS NOT NULL`);
      await client.query(`UPDATE pdf_templates SET created_by_id = NULL WHERE created_by_id IS NOT NULL`);
      await client.query(`UPDATE pdf_permissions SET created_by_id = NULL, user_id = NULL WHERE created_by_id IS NOT NULL OR user_id IS NOT NULL`);
      await client.query(`UPDATE pdf_letterhead_settings SET updated_by_id = NULL WHERE updated_by_id IS NOT NULL`);
      await client.query(`UPDATE clearance_sla_thresholds SET updated_by_id = NULL WHERE updated_by_id IS NOT NULL`);
      await client.query(`UPDATE advance_recovery_settings SET updated_by_id = NULL WHERE updated_by_id IS NOT NULL`);
      await client.query(`UPDATE deduction_access_groups SET granted_by_id = NULL WHERE granted_by_id IS NOT NULL`);
      await client.query(`UPDATE travel_types SET created_by_id = NULL WHERE created_by_id IS NOT NULL`);
      await client.query(`UPDATE travel_locations SET created_by_id = NULL WHERE created_by_id IS NOT NULL`);
      await client.query(`UPDATE accommodation_hotels SET created_by_id = NULL WHERE created_by_id IS NOT NULL`);
      await client.query(`UPDATE it_devices SET assigned_user_id = NULL WHERE assigned_user_id IS NOT NULL`);

      for (const category of CATEGORIES) {
        for (const stmt of category.deletes) {
          await client.query(stmt);
        }
      }
      await client.query(`DELETE FROM accommodation_hotels`);
      await client.query(`DELETE FROM it_devices`);
      await client.query(`DELETE FROM user_permission_groups`);

      await client.query(`DELETE FROM teams`);
      await client.query(`DELETE FROM sections`);
      await client.query(`DELETE FROM departments`);
      await client.query(`DELETE FROM divisions`);

      await client.query(`DELETE FROM users WHERE id <> $1`, [keepId]);

      await client.query(
        `INSERT INTO system_state (key, value) VALUES ('sessions_cleared_at', now()::timestamptz::text)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
      );

      return { usersDeleted: Number(usersBefore.rows[0]?.count || 0) - 1, keptAdminId: keepId };
    });

    return res.json({ ok: true, ...summary });
  } catch (err) {
    return next(err);
  }
});
