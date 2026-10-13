import { query } from "../../lib/db.js";

// Flattened, read-only views for the Power BI integration (see the "Power BI
// Integration for FlowDesk" proposal) - built ahead of the replica IT is
// provisioning so there's no per-view engineering step left once it exists:
// streaming replication copies view definitions along with the rest of the
// schema, so these show up on the replica automatically. Power BI's
// DirectQuery connector is meant to point at these views, never at the raw
// application tables directly.
//
// Column naming follows the UI's org labels, not the raw column names -
// users.department is labelled "Division" in the app, users.section_id
// resolves to "Department", users.team_id resolves to "Section" (the naming
// is shifted one level between the DB and the UI - see feedback_org_field_naming).
export async function ensureReportingViewsSchema() {
  await query(`
    CREATE OR REPLACE VIEW reporting_advances_flat AS
    SELECT
      ar.id,
      ar.type,
      ar.purpose,
      ar.status::text AS status,
      ar.requested_total,
      ar.approved_total,
      ar.payment_method::text AS payment_method,
      ar.salary_month,
      ar.submitted_at,
      ar.countersigned_at,
      ar.approved_at,
      ar.paid_at,
      ar.created_at,
      ar.updated_at,
      u.id AS requester_id,
      u.full_name AS requester_name,
      u.employee_no AS requester_employee_no,
      u.department AS division,
      sec.name AS department_name,
      tm.name AS section_name,
      w.name AS workflow_name
    FROM advance_requests ar
    JOIN users u ON u.id = ar.requester_id
    LEFT JOIN sections sec ON sec.id = u.section_id
    LEFT JOIN teams tm ON tm.id = u.team_id
    LEFT JOIN workflows w ON w.id = ar.workflow_id
  `);

  await query(`
    CREATE OR REPLACE VIEW reporting_clearances_flat AS
    SELECT
      cc.id,
      cc.month,
      cc.status::text AS status,
      cc.claim_total,
      cc.advance_amount,
      cc.balance_amount,
      cc.settled_method::text AS settled_method,
      cc.settled_at,
      cc.submitted_at,
      cc.closed_at,
      cc.financial_outcome,
      cc.employee_clearance_status,
      cc.treasury_settlement_status,
      cc.linked_advance_id,
      cc.created_at,
      cc.updated_at,
      u.id AS claimant_id,
      u.full_name AS claimant_name,
      u.employee_no AS claimant_employee_no,
      u.department AS division,
      sec.name AS department_name,
      tm.name AS section_name
    FROM clearance_claims cc
    JOIN users u ON u.id = cc.claimant_id
    LEFT JOIN sections sec ON sec.id = u.section_id
    LEFT JOIN teams tm ON tm.id = u.team_id
  `);
}
