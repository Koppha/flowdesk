import { hashPassword } from "../lib/auth.js";
import { query } from "../lib/db.js";
import { env } from "../config/env.js";
import { ensureDepartmentGroups } from "../lib/departments.js";
const DEFAULT_ADMIN_EMAIL = env.ADMIN_SEED_EMAIL || "admin@example.com";
const DEFAULT_ADMIN_PASSWORD = env.ADMIN_SEED_PASSWORD || "pass123";
export async function bootstrapSystem() {
    await ensureUserSchema();
    await ensureDepartmentGroups();
    await ensureFeatureSchema();
    await ensureAdminAccount();
}
async function ensureUserSchema() {
    await ensureEnumColumnValue("users", "role", "HR_MANAGER");
    await ensureEnumColumnValue("advance_requests", "status", "HR_OFFICER");
    await ensureEnumColumnValue("advance_requests", "status", "HR_MANAGER_REVIEW");
    await ensureEnumColumnValue("advance_requests", "status", "HR_REVIEW");
    await ensureEnumColumnValue("advance_requests", "status", "CHIEF_OFFICER_REVIEW");
    await ensureEnumColumnValue("advance_requests", "status", "CANCELLED");
    await ensureEnumColumnValue("clearance_claims", "status", "HR_OFFICER");
    await query(`ALTER TABLE users ALTER COLUMN employee_no DROP NOT NULL`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type text`);
    await query(`ALTER TABLE users ALTER COLUMN employment_type SET DEFAULT 'PERMANENT'`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed boolean NOT NULL DEFAULT false`);
    await query(`ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS created_by_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE advance_lines ADD COLUMN IF NOT EXISTS location text`);
    await query(`
    CREATE TABLE IF NOT EXISTS accommodation_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      advance_request_id uuid NOT NULL REFERENCES advance_requests(id) ON DELETE CASCADE,
      requester_id uuid NOT NULL REFERENCES users(id),
      created_by_id uuid NOT NULL REFERENCES users(id),
      location text NOT NULL,
      provider text,
      check_in date,
      check_out date,
      amount numeric(12,2) NOT NULL DEFAULT 0,
      notes text,
      quotation_path text,
      quotation_uploaded_at timestamptz,
      quotation_uploaded_by_id uuid REFERENCES users(id),
      status text NOT NULL DEFAULT 'DRAFT',
      paid_reference text,
      paid_at timestamptz,
      rejection_comments text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT accommodation_requests_status_check CHECK (status IN ('DRAFT','SUBMITTED','PAID','REJECTED'))
    )
  `);
    await query(`ALTER TABLE accommodation_requests ADD COLUMN IF NOT EXISTS quotation_path text`);
    await query(`ALTER TABLE accommodation_requests ADD COLUMN IF NOT EXISTS quotation_uploaded_at timestamptz`);
    await query(`ALTER TABLE accommodation_requests ADD COLUMN IF NOT EXISTS quotation_uploaded_by_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE accommodation_requests DROP CONSTRAINT IF EXISTS accommodation_requests_status_check`);
    await query(`ALTER TABLE accommodation_requests ADD CONSTRAINT accommodation_requests_status_check CHECK (status IN ('DRAFT','SUBMITTED','PAID','REJECTED'))`);
    await query(`CREATE INDEX IF NOT EXISTS idx_accommodation_requests_status ON accommodation_requests(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_accommodation_requests_advance ON accommodation_requests(advance_request_id)`);
    await query(`
    CREATE TABLE IF NOT EXISTS accommodation_quotations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      accommodation_request_id uuid NOT NULL REFERENCES accommodation_requests(id) ON DELETE CASCADE,
      quotation_path text NOT NULL,
      quotation_uploaded_at timestamptz NOT NULL DEFAULT now(),
      quotation_uploaded_by_id uuid NOT NULL REFERENCES users(id)
    )
  `);
    await query(`UPDATE advance_requests SET created_by_id = requester_id WHERE created_by_id IS NULL`);
    await query(`UPDATE advance_requests SET status='SUBMITTED', updated_at=now() WHERE status::text='COUNTERSIGNED'`);
    await query(`UPDATE users
        SET employment_type = COALESCE(NULLIF(employment_type, ''), 'PERMANENT')`);
    await query(`UPDATE users
        SET role='EMPLOYEE',
            updated_at=now()
      WHERE role::text='COUNTERSIGN'`);
    await query(`UPDATE users
        SET profile_completed =
          CASE
            WHEN coalesce(nullif(trim(full_name), ''), '') = '' THEN false
            WHEN coalesce(nullif(trim(department), ''), '') = '' THEN false
            WHEN employment_type IN ('INTERN', 'TEMPORARY') THEN true
            WHEN coalesce(nullif(trim(employee_no), ''), '') = '' THEN false
            ELSE true
          END`);
}
async function ensureEnumColumnValue(tableName, columnName, value) {
    const safeTable = tableName.replace(/'/g, "''");
    const safeColumn = columnName.replace(/'/g, "''");
    const safeValue = value.replace(/'/g, "''");
    await query(`
    DO $$
    DECLARE
      enum_type regtype;
    BEGIN
      SELECT a.atttypid::regtype
        INTO enum_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_type t ON t.oid = a.atttypid
       WHERE c.relname = '${safeTable}'
         AND a.attname = '${safeColumn}'
         AND t.typtype = 'e'
         AND a.attnum > 0
         AND NOT a.attisdropped
       LIMIT 1;

      IF enum_type IS NOT NULL THEN
        EXECUTE format('ALTER TYPE %s ADD VALUE IF NOT EXISTS %L', enum_type, '${safeValue}');
      END IF;
    END $$;
  `);
}
async function ensureAdminAccount() {
    const existing = await query(`SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`, [DEFAULT_ADMIN_EMAIL]);
    if (existing[0]) {
        await query(`UPDATE users
          SET role='ADMIN',
              is_active=true,
              department=COALESCE(NULLIF(trim(department), ''), 'Administration'),
              employment_type=COALESCE(NULLIF(employment_type, ''), 'PERMANENT'),
              profile_completed=true,
              updated_at=now()
        WHERE id=$1`, [existing[0].id]);
        return;
    }
    const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
    await query(`INSERT INTO users
      (employee_no, full_name, department, email, password_hash, role, is_active, employment_type, profile_completed)
     VALUES ($1,$2,$3,$4,$5,'ADMIN',true,'PERMANENT',true)`, ["ADMIN", "System Administrator", "Administration", DEFAULT_ADMIN_EMAIL, passwordHash]);
}
async function ensureFeatureSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES users(id),
      compiled_by_id uuid NOT NULL REFERENCES users(id),
      division text,
      section_name text,
      month integer NOT NULL,
      year integer NOT NULL,
      account_project_no text,
      day_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
      regular_days integer NOT NULL DEFAULT 0,
      holidays integer NOT NULL DEFAULT 0,
      annual_leave integer NOT NULL DEFAULT 0,
      official_trips integer NOT NULL DEFAULT 0,
      sick_leave integer NOT NULL DEFAULT 0,
      checked_by text,
      checked_date date,
      approved_by text,
      approved_date date,
      status text NOT NULL DEFAULT 'DRAFT',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique_month ON attendance_records(employee_id, month, year)`);
    await query(`
    CREATE TABLE IF NOT EXISTS manager_delegations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      manager_id uuid NOT NULL REFERENCES users(id),
      delegate_id uuid NOT NULL REFERENCES users(id),
      department text NOT NULL,
      from_date date,
      to_date date,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS overtime_requests (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES users(id),
      created_by_id uuid NOT NULL REFERENCES users(id),
      employee_name text,
      employee_no text,
      job_title text,
      section_name text,
      year integer NOT NULL,
      month integer NOT NULL,
      car_reg text,
      remarks text,
      lines jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'DRAFT',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS overtime_claims (
      id uuid PRIMARY KEY,
      employee_id uuid NOT NULL REFERENCES users(id),
      created_by_id uuid NOT NULL REFERENCES users(id),
      overtime_request_id uuid REFERENCES overtime_requests(id),
      employee_name text,
      employee_no text,
      job_title text,
      division text,
      year integer NOT NULL,
      month integer NOT NULL,
      lines jsonb NOT NULL DEFAULT '[]'::jsonb,
      total_overtime numeric(12,2) NOT NULL DEFAULT 0,
      compensated_hours numeric(12,2) NOT NULL DEFAULT 0,
      pay_days numeric(12,2) NOT NULL DEFAULT 0,
      authorised_by text,
      checked_by_supervisor text,
      approved_by_manager text,
      approved_by_cto text,
      notation_hr text,
      hourly_rate numeric(12,2) NOT NULL DEFAULT 0,
      total_amount numeric(12,2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'DRAFT',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    // lightweight key/value for system state (used to expire sessions)
    await query(`
    CREATE TABLE IF NOT EXISTS system_state (
      key text PRIMARY KEY,
      value text
    )
  `);
    // Force-clear sessions so users must login from scratch
    await query(`INSERT INTO system_state (key, value) VALUES ('sessions_cleared_at', now()::timestamptz::text)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}
