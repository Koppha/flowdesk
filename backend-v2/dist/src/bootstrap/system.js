import { hashPassword } from "../lib/auth.js";
import { query } from "../lib/db.js";
import { env } from "../config/env.js";
import { ensureDepartmentGroups, ensureManagerTypesTable, ensureUserOrgColumns } from "../lib/departments.js";
import { ensureTravelSchema } from "../lib/travel.js";
const DEFAULT_ADMIN_EMAIL = env.ADMIN_SEED_EMAIL || "admin@example.com";
const DEFAULT_ADMIN_PASSWORD = env.ADMIN_SEED_PASSWORD || "pass123";
export async function bootstrapSystem() {
    await ensureUserSchema();
    await ensureDepartmentGroups();
    await ensureUserOrgColumns();
    await ensureManagerTypesTable();
    await ensureFeatureSchema();
    await ensureWorkflowSchema();
    await ensureTravelSchema();
    await ensureReportingLinesSchema();
    await ensureRequestTypesSchema();
    await ensureEmploymentTypesSchema();
    await ensureAdminAccount();
}
async function ensureUserSchema() {
    await ensureEnumColumnValue("users", "role", "EXCO");
    await ensureEnumColumnValue("users", "role", "HOD");
    await ensureEnumColumnValue("users", "role", "HR_MANAGER");
    await ensureEnumColumnValue("users", "role", "CEO");
    await ensureEnumColumnValue("advance_requests", "status", "HR_OFFICER");
    await ensureEnumColumnValue("advance_requests", "status", "HR_MANAGER_REVIEW");
    await ensureEnumColumnValue("advance_requests", "status", "HR_REVIEW");
    await ensureEnumColumnValue("advance_requests", "status", "COUNTERSIGNED");
    await ensureEnumColumnValue("advance_requests", "status", "CANCELLED");
    await ensureEnumColumnValue("clearance_claims", "status", "HR_OFFICER");
    await ensureEnumColumnValue("clearance_claims", "status", "HR_MANAGER_REVIEW");
    await query(`ALTER TABLE users ALTER COLUMN employee_no DROP NOT NULL`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS title text`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type text`);
    await query(`ALTER TABLE users ALTER COLUMN employment_type SET DEFAULT 'PERMANENT'`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed boolean NOT NULL DEFAULT false`);
    await query(`ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS created_by_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE advance_lines ADD COLUMN IF NOT EXISTS location text`);
    await query(`ALTER TABLE advance_lines ADD COLUMN IF NOT EXISTS meals_count integer NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE advance_lines ADD COLUMN IF NOT EXISTS meal_value numeric(12,2) NOT NULL DEFAULT 0`);
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
    await query(`DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE c.conname = 'accommodation_requests_status_check'
        AND t.relname = 'accommodation_requests'
    ) THEN
      ALTER TABLE accommodation_requests
      ADD CONSTRAINT accommodation_requests_status_check CHECK (status IN ('DRAFT','SUBMITTED','PAID','REJECTED'));
    END IF;
  END$$`);
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
    await query(`UPDATE advance_requests SET status='HR_MANAGER_REVIEW', updated_at=now() WHERE status::text='CHIEF_OFFICER_REVIEW'`);
    await query(`ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS workflow_id uuid REFERENCES workflows(id)`);
    await query(`ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS workflow_step_order int`);
    await query(`ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS approval_chain jsonb`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS workflow_id uuid REFERENCES workflows(id)`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS workflow_step_order int`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS approval_chain jsonb`);
    await query(`UPDATE users
        SET employment_type = COALESCE(NULLIF(employment_type, ''), 'PERMANENT')`);
    await query(`UPDATE users
        SET role='EMPLOYEE',
            updated_at=now()
      WHERE role::text='COUNTERSIGN'`);
    await query(`UPDATE users
        SET role='EXCO',
            updated_at=now()
      WHERE role::text='CHIEF_OFFICER'`);
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
async function ensureEnumTypeValue(typeName, value) {
    const safeType = typeName.replace(/'/g, "''");
    const safeValue = value.replace(/'/g, "''");
    await query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = '${safeType}') THEN
        EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', '${safeType}', '${safeValue}');
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
    await query(`
    CREATE TABLE IF NOT EXISTS accommodation_hotels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      district text,
      address text,
      contact text,
      created_by_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS recommended_by_supervisor text`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS supervisor_date text`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS approved_by_hod text`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS approved_by_cto text`);
    // Workflow audit columns for overtime_requests
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS supervisor_approved_by_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS supervisor_approved_at timestamptz`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS hod_approved_by_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS hod_approved_at timestamptz`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS cto_approved_by_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS cto_approved_at timestamptz`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS rejected_by_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS rejected_at timestamptz`);
    await query(`ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS rejection_reason text`);
    // Workflow audit columns for overtime_claims
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS compensation_type text`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS salary_class text`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS number_of_hours numeric(12,2)`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS calculated_by text`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS checked_noted_earning_by text`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS transferred_to_summary_by text`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS manager_authorised_by_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS manager_authorised_at timestamptz`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS hr_noted_at timestamptz`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS finance_verified_at timestamptz`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS earnings_recorded_at timestamptz`);
    await query(`ALTER TABLE overtime_claims ADD COLUMN IF NOT EXISTS summary_transferred_at timestamptz`);
    await query(`ALTER TABLE accommodation_hotels ADD COLUMN IF NOT EXISTS district text`);
    await query(`ALTER TABLE accommodation_hotels DROP COLUMN IF EXISTS department`);
    await query(`CREATE INDEX IF NOT EXISTS idx_accommodation_hotels_district ON accommodation_hotels(district)`);
    // lightweight key/value for system state (used to expire sessions)
    await query(`
    CREATE TABLE IF NOT EXISTS system_state (
      key text PRIMARY KEY,
      value text
    )
  `);
    await query(`INSERT INTO system_state (key, value) VALUES ('meal_value', '0')
     ON CONFLICT (key) DO NOTHING`);
    await query(`ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS override_chain jsonb`);
    // Force-clear sessions so users must login from scratch
    await query(`INSERT INTO system_state (key, value) VALUES ('sessions_cleared_at', now()::timestamptz::text)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}
async function ensureRequestTypesSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS custom_request_types (
      id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      name         text        NOT NULL,
      code         text        NOT NULL,
      description  text,
      icon         text,
      color        text,
      category     text,
      status       text        NOT NULL DEFAULT 'DRAFT',
      is_active    boolean     NOT NULL DEFAULT true,
      created_by_id uuid       REFERENCES users(id),
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT custom_request_types_code_uq UNIQUE (code)
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS request_type_fields (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      request_type_id  uuid        NOT NULL REFERENCES custom_request_types(id) ON DELETE CASCADE,
      field_key        text        NOT NULL,
      field_label      text        NOT NULL,
      field_type       text        NOT NULL DEFAULT 'text',
      is_required      boolean     NOT NULL DEFAULT false,
      placeholder      text,
      options          jsonb,
      sort_order       integer     NOT NULL DEFAULT 0,
      is_active        boolean     NOT NULL DEFAULT true,
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS request_type_permissions (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      request_type_id  uuid        NOT NULL REFERENCES custom_request_types(id) ON DELETE CASCADE,
      permission_type  text        NOT NULL DEFAULT 'ALL',
      department       text,
      user_id          uuid        REFERENCES users(id) ON DELETE CASCADE,
      can_submit       boolean     NOT NULL DEFAULT true,
      can_design       boolean     NOT NULL DEFAULT false,
      created_by_id    uuid        REFERENCES users(id),
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_rtf_type   ON request_type_fields(request_type_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_rtp_type   ON request_type_permissions(request_type_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_rtp_user   ON request_type_permissions(user_id)`);
}
async function ensureReportingLinesSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS reporting_lines (
      id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      manager_id     uuid        REFERENCES users(id),
      effective_from date        NOT NULL DEFAULT CURRENT_DATE,
      effective_to   date,
      reason         text,
      is_active      boolean     NOT NULL DEFAULT true,
      created_by_id  uuid        REFERENCES users(id),
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_reporting_lines_employee ON reporting_lines(employee_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_reporting_lines_manager  ON reporting_lines(manager_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_reporting_lines_active   ON reporting_lines(is_active)`);
}
async function ensureWorkflowSchema() {
    await query(`DO $$ BEGIN CREATE TYPE workflow_status AS ENUM ('DRAFT','ACTIVE','INACTIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await query(`DO $$ BEGIN CREATE TYPE workflow_request_type AS ENUM ('ADVANCE_REQUEST','CLAIM_REQUEST','OVERTIME_REQUEST','CLEARANCE_REQUEST','TRAVEL_REQUEST','ACCOMMODATION_REQUEST','PROCUREMENT_REQUEST','PETTY_CASH_REQUEST','CUSTOM_WORKFLOW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    for (const requestType of [
        "ADVANCE_REQUEST",
        "TRAVEL_REQUEST",
        "ACCOMMODATION_REQUEST",
        "OVERTIME_REQUEST",
        "PROCUREMENT_REQUEST",
        "CLEARANCE_REQUEST",
        "PETTY_CASH_REQUEST",
        "CUSTOM_WORKFLOW",
        "CLAIM_REQUEST"
    ]) {
        await ensureEnumTypeValue("workflow_request_type", requestType);
    }
    await query(`
    CREATE TABLE IF NOT EXISTS workflows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      request_type workflow_request_type NOT NULL DEFAULT 'ADVANCE_REQUEST',
      department text,
      description text,
      status workflow_status NOT NULL DEFAULT 'DRAFT',
      created_by_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS description text`);
    await query(`
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      step_order integer NOT NULL,
      position_type_code text NOT NULL DEFAULT 'CUSTOM',
      position_name text NOT NULL,
      description text,
      is_required boolean NOT NULL DEFAULT false,
      skip_if_unassigned boolean NOT NULL DEFAULT false,
      allow_delegation boolean NOT NULL DEFAULT false,
      comments_required boolean NOT NULL DEFAULT false,
      escalation_days integer NOT NULL DEFAULT 0,
      is_final_approval boolean NOT NULL DEFAULT false,
      is_system_step boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS workflow_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      rule_name text NOT NULL,
      condition_field text NOT NULL,
      condition_operator text NOT NULL,
      condition_value text NOT NULL,
      additional_position_type_code text,
      additional_position_name text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow ON workflow_steps(workflow_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_workflow_rules_workflow ON workflow_rules(workflow_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_workflows_request_type ON workflows(request_type)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_workflows_department ON workflows(department)`);
    await query(`ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS position_type_code text`);
    await query(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS additional_position_type_code text`);
    await query(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS additional_position_name text`);
    await query(`
    DO $$
    BEGIN
      IF to_regclass('public.position_types') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'workflow_steps' AND column_name = 'position_type_id'
         ) THEN
        EXECUTE $migration$
          UPDATE workflow_steps ws
             SET position_type_code = COALESCE(NULLIF(trim(ws.position_type_code), ''), pt.code, NULLIF(trim(ws.position_name), ''), 'CUSTOM')
            FROM position_types pt
           WHERE ws.position_type_id = pt.id
             AND (ws.position_type_code IS NULL OR trim(ws.position_type_code) = '')
        $migration$;
      END IF;

      IF to_regclass('public.position_types') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'workflow_rules' AND column_name = 'additional_position_type_id'
         ) THEN
        EXECUTE $migration$
          UPDATE workflow_rules wr
             SET additional_position_type_code = COALESCE(NULLIF(trim(wr.additional_position_type_code), ''), pt.code),
                 additional_position_name = COALESCE(NULLIF(trim(wr.additional_position_name), ''), pt.name)
            FROM position_types pt
           WHERE wr.additional_position_type_id = pt.id
             AND (
               wr.additional_position_type_code IS NULL OR trim(wr.additional_position_type_code) = ''
               OR wr.additional_position_name IS NULL OR trim(wr.additional_position_name) = ''
             )
        $migration$;
      END IF;
    END $$;
  `);
    await query(`UPDATE workflow_steps SET position_type_code = COALESCE(NULLIF(trim(position_type_code), ''), NULLIF(trim(position_name), ''), 'CUSTOM')`);
    await query(`ALTER TABLE workflow_steps ALTER COLUMN position_type_code SET DEFAULT 'CUSTOM'`);
    await query(`ALTER TABLE workflow_steps ALTER COLUMN position_type_code SET NOT NULL`);
    await query(`ALTER TABLE workflow_steps DROP CONSTRAINT IF EXISTS workflow_steps_position_type_id_fkey`);
    await query(`ALTER TABLE workflow_rules DROP CONSTRAINT IF EXISTS workflow_rules_additional_position_type_id_fkey`);
    await query(`ALTER TABLE workflow_steps DROP COLUMN IF EXISTS position_type_id`);
    await query(`ALTER TABLE workflow_rules DROP COLUMN IF EXISTS additional_position_type_id`);
    await query(`DROP INDEX IF EXISTS idx_position_types_code`);
    await query(`DROP TABLE IF EXISTS position_types`);
    // Sticky workflows are permanent defaults; Temporary workflows have a bounded validity window
    await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS workflow_type text NOT NULL DEFAULT 'STICKY'`);
    await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS valid_from  timestamptz`);
    await query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS valid_until timestamptz`);
}
async function ensureEmploymentTypesSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS employment_types (
      id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      code       text        UNIQUE NOT NULL,
      name       text        NOT NULL,
      active     boolean     NOT NULL DEFAULT true,
      sort_order integer     NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    INSERT INTO employment_types (code, name, sort_order) VALUES
      ('PERMANENT', 'Permanent', 1),
      ('INTERN',    'Intern',    2),
      ('TEMPORARY', 'Temporary', 3)
    ON CONFLICT (code) DO NOTHING
  `);
}
