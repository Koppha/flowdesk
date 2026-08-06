-- Full production reset: org structure + all users + all transactional
-- history, preserving exactly ONE admin account so someone can log back in
-- and start re-importing org structure + users.
--
-- Kept untouched (config/definitions, not "user data"): workflows,
-- workflow_rules, workflow_steps, custom_request_types (+ fields/
-- permissions), permission_groups, travel_types, travel_locations,
-- manager_types, pdf_templates, pdf_permissions, pdf_letterhead_settings,
-- clearance_sla_thresholds, advance_recovery_settings,
-- deduction_access_groups. Their nullable created_by_id/updated_by_id/
-- assigned_user_id/user_id columns are set to NULL rather than deleting
-- the row, since the row itself is still needed for the system to function.
--
-- Preserved account: pmo@etl.co.ls (must already exist and be unique).
--
-- Run against PRODUCTION manually, e.g.:
--   psql "$DATABASE_URL" -f db/scripts/full-reset-keep-admin.sql
--
-- BEFORE RUNNING: take a backup (`pg_dump "$DATABASE_URL" -f pre-full-reset.sql`).
-- This deletes essentially the entire operational history of the system
-- (advance requests, claims, approvals, overtime, accommodation, deductions,
-- attendance, reporting lines) and every user except the one preserved.
-- It is not recoverable without that backup.

BEGIN;

-- 0. Resolve the one admin account to keep; abort if not found or not unique.
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM users WHERE email = 'pmo@etl.co.ls';
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 user with email pmo@etl.co.ls, found %', cnt;
  END IF;
END $$;

CREATE TEMP TABLE preserved_admin ON COMMIT DROP AS
  SELECT id FROM users WHERE email = 'pmo@etl.co.ls';

-- 1. Informational: what's about to be wiped.
SELECT
  (SELECT count(*) FROM users) - 1                    AS users_to_delete,
  (SELECT count(*) FROM advance_requests)              AS advance_requests_to_delete,
  (SELECT count(*) FROM clearance_claims)               AS clearance_claims_to_delete,
  (SELECT count(*) FROM overtime_requests)              AS overtime_requests_to_delete,
  (SELECT count(*) FROM accommodation_requests)         AS accommodation_requests_to_delete,
  (SELECT count(*) FROM deductions)                     AS deductions_to_delete,
  (SELECT count(*) FROM attendance_records)             AS attendance_records_to_delete,
  (SELECT count(*) FROM custom_request_submissions)     AS custom_request_submissions_to_delete,
  (SELECT count(*) FROM reporting_lines)                AS reporting_lines_to_delete,
  (SELECT count(*) FROM divisions)                      AS divisions_to_delete,
  (SELECT count(*) FROM departments)                    AS departments_to_delete,
  (SELECT count(*) FROM sections)                       AS sections_to_delete,
  (SELECT count(*) FROM teams)                          AS teams_to_delete;

-- === Org structure ===================================================

UPDATE users SET division_id = NULL, section_id = NULL, team_id = NULL
 WHERE division_id IS NOT NULL OR section_id IS NOT NULL OR team_id IS NOT NULL;

UPDATE position_vacancies SET division_id = NULL, section_id = NULL, team_id = NULL
 WHERE division_id IS NOT NULL OR section_id IS NOT NULL OR team_id IS NOT NULL;

UPDATE departments SET section_id = NULL WHERE section_id IS NOT NULL;
UPDATE sections     SET department_id = NULL WHERE department_id IS NOT NULL;

DELETE FROM teams;
DELETE FROM sections;
DELETE FROM departments;
DELETE FROM divisions;

-- === Detach kept config/definition tables from users =================
-- (these rows survive; only their "who touched this" links are cleared)

UPDATE workflows                SET created_by_id = NULL              WHERE created_by_id IS NOT NULL;
UPDATE workflow_rules           SET additional_assigned_user_id = NULL WHERE additional_assigned_user_id IS NOT NULL;
UPDATE workflow_steps           SET assigned_user_id = NULL           WHERE assigned_user_id IS NOT NULL;
UPDATE custom_request_types     SET created_by_id = NULL              WHERE created_by_id IS NOT NULL;
UPDATE request_type_permissions SET user_id = NULL, created_by_id = NULL
 WHERE user_id IS NOT NULL OR created_by_id IS NOT NULL;
UPDATE pdf_templates            SET created_by_id = NULL              WHERE created_by_id IS NOT NULL;
UPDATE pdf_permissions          SET created_by_id = NULL, user_id = NULL
 WHERE created_by_id IS NOT NULL OR user_id IS NOT NULL;
UPDATE pdf_letterhead_settings  SET updated_by_id = NULL              WHERE updated_by_id IS NOT NULL;
UPDATE clearance_sla_thresholds SET updated_by_id = NULL              WHERE updated_by_id IS NOT NULL;
UPDATE advance_recovery_settings SET updated_by_id = NULL             WHERE updated_by_id IS NOT NULL;
UPDATE deduction_access_groups  SET granted_by_id = NULL              WHERE granted_by_id IS NOT NULL;
UPDATE travel_types             SET created_by_id = NULL              WHERE created_by_id IS NOT NULL;
UPDATE travel_locations         SET created_by_id = NULL              WHERE created_by_id IS NOT NULL;

-- === Transactional history, leaf-to-root ==============================

DELETE FROM accommodation_quotations;
DELETE FROM claim_trips;
DELETE FROM receipts;
DELETE FROM custom_request_attachments;
DELETE FROM advance_lines;
DELETE FROM overtime_claims;
DELETE FROM accommodation_requests;
DELETE FROM accommodation_hotels;
DELETE FROM clearance_claims;
DELETE FROM custom_request_submissions;
DELETE FROM overtime_requests;
DELETE FROM attendance_records;
DELETE FROM deductions;
DELETE FROM reporting_lines;
DELETE FROM position_vacancies;
DELETE FROM audit_log;
DELETE FROM email_action_tokens;
DELETE FROM manager_delegations;
DELETE FROM user_permission_groups;
DELETE FROM approvals;
DELETE FROM advance_requests;

-- === Users =============================================================

DELETE FROM users WHERE id NOT IN (SELECT id FROM preserved_admin);

-- Invalidate any outstanding sessions/tokens for anyone still holding a
-- JWT issued before this reset (matches the pattern used elsewhere in
-- bootstrap/system.ts).
INSERT INTO system_state (key, value) VALUES ('sessions_cleared_at', now()::timestamptz::text)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 2. Final verification: everything should be 0 except users = 1.
SELECT
  (SELECT count(*) FROM users)                     AS users_left,
  (SELECT count(*) FROM advance_requests)          AS advance_requests_left,
  (SELECT count(*) FROM clearance_claims)          AS clearance_claims_left,
  (SELECT count(*) FROM overtime_requests)         AS overtime_requests_left,
  (SELECT count(*) FROM accommodation_requests)    AS accommodation_requests_left,
  (SELECT count(*) FROM deductions)                AS deductions_left,
  (SELECT count(*) FROM attendance_records)        AS attendance_records_left,
  (SELECT count(*) FROM custom_request_submissions) AS custom_request_submissions_left,
  (SELECT count(*) FROM reporting_lines)           AS reporting_lines_left,
  (SELECT count(*) FROM divisions)                 AS divisions_left,
  (SELECT count(*) FROM departments)               AS departments_left,
  (SELECT count(*) FROM sections)                  AS sections_left,
  (SELECT count(*) FROM teams)                     AS teams_left;

COMMIT;
