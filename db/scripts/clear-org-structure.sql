-- Clear org structure tables (divisions, departments, sections, teams) before
-- re-importing a fresh list via Administration > Organizational Structure > Import CSV.
--
-- Scope: only the 4 tables that back OrgStructure.tsx. Reporting lines,
-- leadership assignments, and business-partner links are left untouched.
--
-- Run against PRODUCTION manually, e.g.:
--   psql "$DATABASE_URL" -f db/scripts/clear-org-structure.sql
--
-- BEFORE RUNNING: take a backup (e.g. `pg_dump "$DATABASE_URL" -f pre-org-wipe.sql`)
-- so this is recoverable if anything looks wrong afterward.

BEGIN;

-- 0. Sanity check: show what's about to be wiped and how many users/vacancies
--    will have their org assignment cleared, so you can eyeball the counts.
SELECT
  (SELECT count(*) FROM divisions)         AS divisions_to_delete,
  (SELECT count(*) FROM departments)       AS departments_to_delete,
  (SELECT count(*) FROM sections)          AS sections_to_delete,
  (SELECT count(*) FROM teams)             AS teams_to_delete,
  (SELECT count(*) FROM users
     WHERE division_id IS NOT NULL
        OR section_id  IS NOT NULL
        OR team_id     IS NOT NULL)        AS users_to_unassign,
  (SELECT count(*) FROM position_vacancies
     WHERE division_id IS NOT NULL
        OR section_id  IS NOT NULL
        OR team_id     IS NOT NULL)        AS vacancies_to_unassign;

-- 1. Clear dependent FK columns on users and position_vacancies so the
--    deletes below don't hit foreign-key violations. Users keep everything
--    else (role, department free-text field, etc.) — only the structured
--    org links are cleared. Re-map users after the new list is imported.
UPDATE users
   SET division_id = NULL,
       section_id  = NULL,
       team_id     = NULL
 WHERE division_id IS NOT NULL
    OR section_id  IS NOT NULL
    OR team_id     IS NOT NULL;

UPDATE position_vacancies
   SET division_id = NULL,
       section_id  = NULL,
       team_id     = NULL
 WHERE division_id IS NOT NULL
    OR section_id  IS NOT NULL
    OR team_id     IS NOT NULL;

-- 2. Break the circular FK between departments and sections
--    (departments.section_id <-> sections.department_id) before either
--    table can be emptied.
UPDATE departments SET section_id = NULL WHERE section_id IS NOT NULL;
UPDATE sections     SET department_id = NULL WHERE department_id IS NOT NULL;

-- 3. Delete leaf-to-root. section_division_links and
--    department_division_links cascade automatically (ON DELETE CASCADE).
DELETE FROM teams;
DELETE FROM sections;
DELETE FROM departments;
DELETE FROM divisions;

-- 4. Confirm everything is empty before committing.
SELECT
  (SELECT count(*) FROM divisions)   AS divisions_left,
  (SELECT count(*) FROM departments) AS departments_left,
  (SELECT count(*) FROM sections)    AS sections_left,
  (SELECT count(*) FROM teams)       AS teams_left;

COMMIT;
