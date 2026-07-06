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
    await ensureEmailActionTokensSchema();
    await ensurePositionVacanciesSchema();
    await ensurePdfSchema();
    await ensureAdminAccount();
}
// One-click approve/reject-by-email tokens. The JWT carries only a jti;
// every other binding fact (who, which document, which step) lives here so
// the server can re-validate against live state when the link is clicked.
async function ensureEmailActionTokensSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS email_action_tokens (
      id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      jti         uuid        NOT NULL UNIQUE,
      user_id     uuid        NOT NULL REFERENCES users(id),
      doc_type    text        NOT NULL,
      doc_id      uuid        NOT NULL,
      step_order  integer     NOT NULL,
      used_at     timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_eat_doc ON email_action_tokens(doc_type, doc_id)`);
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
    await ensureEnumColumnValue("clearance_claims", "status", "PAYMENT_PROCESSING");
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS finance_decision text`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS finance_comments text`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS settlement_amount numeric(12,2)`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS assignee_user_id uuid REFERENCES users(id)`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS assignee_group_name text`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS expected_payment_date date`);
    // Employee-requested settlement preference and the explanation required when
    // the company owes the employee (balance_amount < 0, i.e. they overspent the
    // advance) — distinct from Finance's own authoritative settled_method/decision.
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS settlement_method_requested text`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS settlement_ecocash_number text`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS settlement_bank_name text`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS settlement_bank_account_number text`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS settlement_bank_branch text`);
    await query(`ALTER TABLE clearance_claims ADD COLUMN IF NOT EXISTS reason_for_overspend text`);
    await query(`ALTER TABLE users ALTER COLUMN employee_no DROP NOT NULL`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS title text`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type text`);
    await query(`ALTER TABLE users ALTER COLUMN employment_type SET DEFAULT 'PERMANENT'`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed boolean NOT NULL DEFAULT false`);
    // Dashboard shortcuts — page keys the user has pinned for quick access.
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_pages text[] NOT NULL DEFAULT '{}'`);
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
    // ── Performance indexes ─────────────────────────────────────────────────────
    // advance_requests — hot columns in inbox, advance list, and workflow queries
    await query(`CREATE INDEX IF NOT EXISTS idx_ar_requester   ON advance_requests(requester_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ar_status      ON advance_requests(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ar_created     ON advance_requests(created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ar_created_by  ON advance_requests(created_by_id)`);
    // clearance_claims — same access patterns
    await query(`CREATE INDEX IF NOT EXISTS idx_cc_claimant    ON clearance_claims(claimant_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cc_status      ON clearance_claims(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cc_created     ON clearance_claims(created_at DESC)`);
    // users — looked up by email (login), role (approver resolution), department
    await query(`CREATE INDEX IF NOT EXISTS idx_users_email      ON users(lower(email))`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_role       ON users(role) WHERE is_active = true`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_active     ON users(is_active)`);
    // Functional index covering all 28+ lower(trim(department)) comparisons
    await query(`CREATE INDEX IF NOT EXISTS idx_users_dept_lower ON users(lower(trim(department))) WHERE is_active = true`);
    // departments — joined via lower(trim(name)) in many queries
    await query(`CREATE INDEX IF NOT EXISTS idx_dept_name_lower  ON departments(lower(trim(name)))`);
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
    const existing = await query(`SELECT id FROM users WHERE lower(email)=lower($1) OR employee_no='ADMIN' LIMIT 1`, [DEFAULT_ADMIN_EMAIL]);
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
// A "vacant position" — a Manager/HOD/EXCO/CEO seat an admin has earmarked
// before anyone is assigned to it. Kept separate from `users` (whose email
// column is NOT NULL UNIQUE, so it can't represent an unfilled seat) and
// from any other roster query — filling one just promotes/creates a real
// user via the normal paths and stamps this row as filled.
async function ensurePositionVacanciesSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS position_vacancies (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      role             text        NOT NULL,
      title            text,
      department       text,
      division_id      uuid        REFERENCES divisions(id),
      section_id       uuid        REFERENCES sections(id),
      team_id          uuid        REFERENCES teams(id),
      notes            text,
      created_by_id    uuid        REFERENCES users(id),
      created_at       timestamptz NOT NULL DEFAULT now(),
      filled_by_user_id uuid       REFERENCES users(id),
      filled_at        timestamptz
    )
  `);
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
    // Groups fields into pages of the submission wizard ("Details", "Implementation", …).
    // The final "Approvals" page is always implicit and not represented here.
    await query(`ALTER TABLE request_type_fields ADD COLUMN IF NOT EXISTS wizard_step integer NOT NULL DEFAULT 1`);
    await query(`
    CREATE TABLE IF NOT EXISTS custom_request_submissions (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      request_type_id  uuid        NOT NULL REFERENCES custom_request_types(id) ON DELETE CASCADE,
      requester_id     uuid        NOT NULL REFERENCES users(id),
      data             jsonb       NOT NULL DEFAULT '{}',
      approval_chain   jsonb       NOT NULL DEFAULT '[]',
      current_step_order integer   NOT NULL DEFAULT 0,
      status           text        NOT NULL DEFAULT 'SUBMITTED',
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_crs_type      ON custom_request_submissions(request_type_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_crs_requester ON custom_request_submissions(requester_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_crs_status    ON custom_request_submissions(status)`);
    await query(`ALTER TABLE custom_request_submissions ADD COLUMN IF NOT EXISTS implementation_date date`);
    await query(`ALTER TABLE custom_request_submissions ADD COLUMN IF NOT EXISTS closure_notes text`);
    await query(`ALTER TABLE custom_request_submissions ADD COLUMN IF NOT EXISTS closed_at timestamptz`);
    await query(`ALTER TABLE custom_request_submissions ADD COLUMN IF NOT EXISTS follow_up_sent boolean NOT NULL DEFAULT false`);
    await query(`CREATE INDEX IF NOT EXISTS idx_crs_followup ON custom_request_submissions(implementation_date) WHERE status = 'CLOSED' AND follow_up_sent = false`);
    // The requester can withdraw their own request while it's still pending approval.
    await query(`ALTER TABLE custom_request_submissions ADD COLUMN IF NOT EXISTS cancel_comment text`);
    await query(`ALTER TABLE custom_request_submissions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`);
    await query(`
    CREATE TABLE IF NOT EXISTS custom_request_attachments (
      id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id   uuid        NOT NULL REFERENCES custom_request_submissions(id) ON DELETE CASCADE,
      file_path       text        NOT NULL,
      original_name   text        NOT NULL,
      content_type    text,
      size_bytes      integer,
      uploaded_by_id  uuid        REFERENCES users(id),
      uploaded_at     timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_cra_submission ON custom_request_attachments(submission_id)`);
    // Whether this request type supports the post-approval "Close Request" /
    // implementation-date capture flow (only Change Request needs this).
    await query(`ALTER TABLE custom_request_types ADD COLUMN IF NOT EXISTS requires_closure boolean NOT NULL DEFAULT false`);
    // Whether the approval-chain approver picker for this request type should
    // be limited to management roles (HOD/MANAGER/EXCO/ADMIN) rather than any staff member.
    await query(`ALTER TABLE custom_request_types ADD COLUMN IF NOT EXISTS restrict_approvers_to_management boolean NOT NULL DEFAULT false`);
    // Admin-configurable list of approval-chain step titles (e.g. "Checked by", "Approved by").
    // When set, the submission form shows a dropdown instead of a free-text title input.
    await query(`ALTER TABLE custom_request_types ADD COLUMN IF NOT EXISTS approver_title_options jsonb`);
    // Lets a permission grant target a specific employment type (e.g. Permanent/Intern/Temporary) instead of/alongside department or named user.
    await query(`ALTER TABLE request_type_permissions ADD COLUMN IF NOT EXISTS employment_type text`);
    // Fixed approval-chain structure: an ordered array of { title, source: "AUTO_MANAGER" | "ROLE_PICKER", role? }.
    // When set, submitters can't add/remove/reorder steps — the server resolves AUTO_MANAGER steps from
    // reporting_lines and validates ROLE_PICKER steps against the chosen approver's role.
    await query(`ALTER TABLE custom_request_types ADD COLUMN IF NOT EXISTS fixed_approval_chain jsonb`);
    await seedChangeRequestType();
    await seedAttendanceRegisterType();
    await seedComputerRequestType();
}
// Seeds the "Change Request" custom request type (ECONET Change Control
// Procedure form), available to all users, with a requester-defined
// approval workflow (no fixed chain — every change request can route
// through a different set of approvers).
async function seedChangeRequestType() {
    const existing = await query(`SELECT id FROM custom_request_types WHERE code = 'CHANGE_REQUEST'`);
    let typeId = existing[0]?.id;
    if (!typeId) {
        const inserted = await query(`INSERT INTO custom_request_types (name, code, description, icon, color, category, status)
       VALUES ('Change Request', 'CHANGE_REQUEST', 'IT/Business change control request', 'GitBranch', '#0ea5e9', 'Change Control', 'ACTIVE')
       RETURNING id`);
        typeId = inserted[0].id;
    }
    await query(`UPDATE custom_request_types SET requires_closure = true WHERE id = $1`, [typeId]);
    const hasFields = await query(`SELECT id FROM request_type_fields WHERE request_type_id = $1 LIMIT 1`, [typeId]);
    if (!hasFields[0]) {
        const fields = [
            { key: "department", label: "Department", type: "text", required: true, placeholder: "Requesting department" },
            { key: "date_requested", label: "Date Requested", type: "date", required: true },
            { key: "change_assignee", label: "Change Assignee", type: "user_multi" },
            { key: "change_type_hardware", label: "Change Type: Hardware", type: "checkbox" },
            { key: "change_type_system_software", label: "Change Type: System Software", type: "checkbox" },
            { key: "change_type_applications", label: "Change Type: Applications", type: "checkbox" },
            { key: "change_type_environment", label: "Change Type: Environment", type: "checkbox" },
            { key: "change_type_network", label: "Change Type: Network", type: "checkbox" },
            { key: "change_type_configuration", label: "Change Type: Configuration", type: "checkbox" },
            { key: "change_type_business_rule", label: "Change Type: Business Rule", type: "checkbox" },
            { key: "category_business_request", label: "Change Category: Business Request", type: "checkbox" },
            { key: "category_fix", label: "Change Category: Fix", type: "checkbox" },
            { key: "category_technical", label: "Change Category: Technical (Hdw/Sw)", type: "checkbox" },
            { key: "is_urgent", label: "Is this Urgent?", type: "checkbox" },
            { key: "description_of_change", label: "Description of proposed change", type: "textarea", required: true },
            { key: "business_justification", label: "Business Justification / Reason for Change", type: "textarea", required: true },
            { key: "affected_areas", label: "Which IS/IT/Business areas will be affected?", type: "textarea" },
            { key: "priority", label: "Priority", type: "select", options: [
                    { label: "High", value: "HIGH" }, { label: "Medium", value: "MEDIUM" }, { label: "Low", value: "LOW" }
                ] },
            { key: "component_name", label: "Component(s) Name", type: "text" },
            { key: "platform", label: "Platform", type: "text" },
            { key: "dependencies", label: "Dependencies", type: "text" },
            { key: "number_of_changes", label: "Number of Changes", type: "number" },
            { key: "implementation_date", label: "Implementation Date", type: "date" },
            { key: "change_implementor", label: "Change Implementor", type: "section" },
            { key: "time_required", label: "Time Required", type: "text", placeholder: "e.g. 1 day" },
            { key: "time_scheduled", label: "Time Scheduled", type: "text", placeholder: "e.g. 00:00 AM" },
            { key: "risk", label: "Risk", type: "select", options: [
                    { label: "High", value: "H" }, { label: "Medium", value: "M" }, { label: "Low", value: "L" }
                ] },
            { key: "impact", label: "Impact", type: "select", options: [
                    { label: "Minor", value: "MINOR" }, { label: "Significant", value: "SIGNIFICANT" }, { label: "Major", value: "MAJOR" }
                ] },
            { key: "implementation_plan", label: "Implementation Plan", type: "textarea" },
            { key: "back_out_plan", label: "Back-out Plan", type: "textarea" },
            { key: "callout_person", label: "Callout Person", type: "text" },
            { key: "callout_contact_no", label: "Callout Contact No", type: "text" },
            { key: "documentation_required", label: "Documentation / Procedures Required", type: "textarea" },
            { key: "business_implications", label: "Business Implications", type: "textarea" }
        ];
        const placeholders = [];
        const params = [];
        fields.forEach((f, i) => {
            const base = params.length + 1;
            params.push(typeId, f.key, f.label, f.type, f.required ?? false, f.placeholder ?? null, f.options ? JSON.stringify(f.options) : null, i);
            placeholders.push(`($${base},$${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
        });
        await query(`INSERT INTO request_type_fields (request_type_id, field_key, field_label, field_type, is_required, placeholder, options, sort_order)
       VALUES ${placeholders.join(",")}`, params);
    }
    // Change Assignee/Implementor types evolved over time (text -> user -> user_multi,
    // text -> section); existing installs already seeded the old type above, so fix
    // them up in place rather than re-inserting (which would lose submitted data).
    await query(`UPDATE request_type_fields SET field_type = 'user_multi' WHERE request_type_id = $1 AND field_key = 'change_assignee'`, [typeId]);
    await query(`UPDATE request_type_fields SET field_type = 'section' WHERE request_type_id = $1 AND field_key = 'change_implementor'`, [typeId]);
    // The Change Type / Change Category checkboxes moved from a flat "Change
    // Type: X" labelling scheme to two grouped boxes with plain labels and
    // extra ECONET-aligned options. Self-heals on every boot: renames existing
    // checkboxes, adds the new ones, and reorders the whole field list.
    const checkboxRelabels = [
        ["change_type_hardware", "Hardware"],
        ["change_type_system_software", "System Software"],
        ["change_type_applications", "Applications"],
        ["change_type_environment", "Environment"],
        ["change_type_network", "Network"],
        ["change_type_configuration", "Configuration"],
        ["change_type_business_rule", "Business Rule"],
        ["category_business_request", "Business Request"],
        ["category_fix", "Fix"],
        ["category_technical", "Technical (Hardware / Software)"]
    ];
    for (const [key, label] of checkboxRelabels) {
        await query(`UPDATE request_type_fields SET field_label = $1 WHERE request_type_id = $2 AND field_key = $3`, [label, typeId, key]);
    }
    const newCheckboxFields = [
        ["change_type_business_request", "Business Request"],
        ["change_type_other", "Other"],
        ["category_enhancement", "Enhancement"],
        ["category_emergency", "Emergency"],
        ["category_security", "Security"],
        ["category_compliance", "Compliance"],
        ["category_other", "Other"]
    ];
    for (const [key, label] of newCheckboxFields) {
        const exists = await query(`SELECT id FROM request_type_fields WHERE request_type_id = $1 AND field_key = $2`, [typeId, key]);
        if (!exists[0]) {
            await query(`INSERT INTO request_type_fields (request_type_id, field_key, field_label, field_type, is_required, sort_order, wizard_step)
         VALUES ($1, $2, $3, 'checkbox', false, 0, 1)`, [typeId, key, label]);
        }
    }
    const fieldOrder = [
        "department", "date_requested", "change_assignee",
        "change_type_hardware", "change_type_configuration", "change_type_system_software", "change_type_business_rule",
        "change_type_applications", "change_type_business_request", "change_type_environment", "change_type_other", "change_type_network",
        "category_business_request", "category_enhancement", "category_fix", "category_emergency",
        "category_technical", "category_security", "category_compliance", "category_other",
        "is_urgent",
        "description_of_change", "business_justification", "affected_areas", "priority", "component_name", "platform", "dependencies",
        "number_of_changes", "implementation_date", "change_implementor", "time_required", "time_scheduled", "risk", "impact",
        "implementation_plan", "back_out_plan", "callout_person", "callout_contact_no", "documentation_required", "business_implications"
    ];
    for (let i = 0; i < fieldOrder.length; i++) {
        await query(`UPDATE request_type_fields SET sort_order = $1 WHERE request_type_id = $2 AND field_key = $3`, [i, typeId, fieldOrder[i]]);
    }
    // Wizard page 2 starts at "Priority" — everything from there on is the
    // technical/implementation half of the ECONET form; page 1 is the
    // request-details half. Re-applied on every boot so it self-heals if an
    // admin's edits ever drop the column back to its default.
    const wizardStepTwoKeys = [
        "priority", "component_name", "platform", "dependencies", "number_of_changes",
        "implementation_date", "change_implementor", "time_required", "time_scheduled",
        "risk", "impact", "implementation_plan", "back_out_plan", "callout_person",
        "callout_contact_no", "documentation_required", "business_implications"
    ];
    await query(`UPDATE request_type_fields SET wizard_step = 2 WHERE request_type_id = $1 AND field_key = ANY($2::text[])`, [typeId, wizardStepTwoKeys]);
    const hasPermission = await query(`SELECT id FROM request_type_permissions WHERE request_type_id = $1 LIMIT 1`, [typeId]);
    if (!hasPermission[0]) {
        await query(`INSERT INTO request_type_permissions (request_type_id, permission_type, can_submit, can_design)
       VALUES ($1, 'ALL', true, false)`, [typeId]);
    }
}
// Seeds the "Attendance Register" custom request type (monthly attendance
// record for temporary staff) — division/section/month header fields plus a
// "table" field rendering one row per employee x one column per day of the
// selected month, with auto-summed leave-type totals.
async function seedAttendanceRegisterType() {
    const existing = await query(`SELECT id FROM custom_request_types WHERE code = 'ATTENDANCE_REGISTER'`);
    let typeId = existing[0]?.id;
    if (!typeId) {
        const inserted = await query(`INSERT INTO custom_request_types (name, code, description, icon, color, category, status)
       VALUES ('Attendance Register', 'ATTENDANCE_REGISTER', 'Monthly attendance record for temporary staff', 'CalendarCheck', '#7c3aed', 'HR', 'ACTIVE')
       RETURNING id`);
        typeId = inserted[0].id;
    }
    // Approvers (Compiled/Checked/Approved by) must be management; consolidation
    // is keyed on division+department+month, which the review console reads
    // straight off this type's fields.
    await query(`UPDATE custom_request_types SET restrict_approvers_to_management = true WHERE id = $1`, [typeId]);
    // Seed once only — admins can edit this list afterwards via the Request
    // Types designer, so don't stomp their changes on every server restart.
    await query(`UPDATE custom_request_types SET approver_title_options = $2 WHERE id = $1 AND approver_title_options IS NULL`, [typeId, JSON.stringify(["Checked by", "Approved by"])]);
    const cellOptions = [
        { value: "R", label: "Regular" },
        { value: "C", label: "Time compensation for overtime work" },
        { value: "S", label: "Sick Leave" },
        { value: "A", label: "Annual Leave (Vacation)" },
        { value: "O", label: "Official trip" },
        { value: "H", label: "Holiday" },
        { value: "E", label: "Emergency" },
        { value: "T", label: "Study Leave / Training" },
        { value: "X", label: "Other Absenteeism" }
    ];
    const summaryColumns = [
        { key: "regular", label: "Regular", countsValue: "R" },
        { key: "holiday", label: "Holiday", countsValue: "H" },
        { key: "annual", label: "Annual", countsValue: "A" },
        { key: "official", label: "Official", countsValue: "O" },
        { key: "sick", label: "Sick Leave", countsValue: "S" }
    ];
    // Each employee fills in only their own row — "SELF" row source, no
    // free-text multi-row entry. Field list (with sort order) is upserted
    // idempotently per field_key so existing installs pick up field changes
    // (e.g. Section/Team replaced by Department) without losing submitted data.
    const fields = [
        { key: "division", label: "Division", type: "text", required: true },
        { key: "department", label: "Department", type: "text", required: true },
        { key: "month", label: "Month", type: "date", required: true, placeholder: "Pick any date within the target month" },
        {
            key: "attendance_grid",
            label: "Attendance Record",
            type: "table",
            required: true,
            options: {
                columnMode: "DAY_OF_MONTH",
                monthFieldKey: "month",
                rowSource: "SELF",
                cellOptions,
                summaryColumns
            }
        }
    ];
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const existingField = await query(`SELECT id FROM request_type_fields WHERE request_type_id = $1 AND field_key = $2`, [typeId, f.key]);
        if (existingField[0]) {
            await query(`UPDATE request_type_fields
            SET field_label = $1, field_type = $2, is_required = $3, placeholder = $4, options = $5, sort_order = $6
          WHERE id = $7`, [f.label, f.type, f.required ?? false, f.placeholder ?? null, f.options ? JSON.stringify(f.options) : null, i, existingField[0].id]);
        }
        else {
            await query(`INSERT INTO request_type_fields (request_type_id, field_key, field_label, field_type, is_required, placeholder, options, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [typeId, f.key, f.label, f.type, f.required ?? false, f.placeholder ?? null, f.options ? JSON.stringify(f.options) : null, i]);
        }
    }
    // Section/Team were replaced by Department — deactivate rather than delete
    // so historical submissions that recorded them keep displaying correctly.
    await query(`UPDATE request_type_fields SET is_active = false WHERE request_type_id = $1 AND field_key IN ('section', 'team')`, [typeId]);
    const hasPermission = await query(`SELECT id FROM request_type_permissions WHERE request_type_id = $1 LIMIT 1`, [typeId]);
    if (!hasPermission[0]) {
        await query(`INSERT INTO request_type_permissions (request_type_id, permission_type, can_submit, can_design)
       VALUES ($1, 'ALL', true, false)`, [typeId]);
    }
}
// Seeds the "Computer Request" custom request type (Econet Computer
// Request Form), available to all users, with a FIXED approval chain
// (Requester's Manager -> IT Manager -> IS HOD/CIO -> CTO). Unlike most
// custom request types, submitters don't build their own chain: step 1
// is auto-resolved from reporting_lines, and steps 2-4 are picked from
// the org structure's Managers/Exco members so the right people sign off
// every time.
async function seedComputerRequestType() {
    const existing = await query(`SELECT id FROM custom_request_types WHERE code = 'COMPUTER_REQUEST'`);
    let typeId = existing[0]?.id;
    if (!typeId) {
        const inserted = await query(`INSERT INTO custom_request_types (name, code, description, icon, color, category, status)
       VALUES ('Computer Request', 'COMPUTER_REQUEST', 'Laptop/desktop request for new, replacement or upgraded computer equipment', 'Monitor', '#3b82f6', 'IT', 'ACTIVE')
       RETURNING id`);
        typeId = inserted[0].id;
    }
    // Seed once only — admins can edit this list afterwards via the Request
    // Types designer, so don't stomp their changes on every server restart.
    await query(`UPDATE custom_request_types SET fixed_approval_chain = $2 WHERE id = $1 AND fixed_approval_chain IS NULL`, [typeId, JSON.stringify([
            { title: "Requester's Manager", source: "AUTO_MANAGER" },
            { title: "IT Manager", source: "ROLE_PICKER", role: "MANAGER" },
            { title: "IS HOD/CIO", source: "ROLE_PICKER", role: "EXCO" },
            { title: "CTO", source: "ROLE_PICKER", role: "EXCO" }
        ])]);
    const fields = [
        { key: "position", label: "Position", type: "text", required: true },
        { key: "department", label: "Department", type: "text", required: true },
        { key: "phone_no", label: "Phone No.", type: "text" },
        { key: "emp_no", label: "Emp No.", type: "text", required: true },
        { key: "computer_type", label: "Type of Computer", type: "select", required: true, options: [
                { label: "Laptop", value: "LAPTOP" }, { label: "Desktop", value: "DESKTOP" }
            ] },
        { key: "request_type", label: "Type of Request", type: "select", required: true, options: [
                { label: "New", value: "NEW" }, { label: "Replacement", value: "REPLACEMENT" }, { label: "Upgrade", value: "UPGRADE" }
            ] },
        { key: "justification", label: "Justification by Supervisor", type: "textarea", required: true,
            placeholder: "Include information about how the computer will be used. If requesting high-end specifications, be explicit about the function that requires and justifies the cost." }
    ];
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const existingField = await query(`SELECT id FROM request_type_fields WHERE request_type_id = $1 AND field_key = $2`, [typeId, f.key]);
        if (existingField[0]) {
            await query(`UPDATE request_type_fields
            SET field_label = $1, field_type = $2, is_required = $3, placeholder = $4, options = $5, sort_order = $6
          WHERE id = $7`, [f.label, f.type, f.required ?? false, f.placeholder ?? null, f.options ? JSON.stringify(f.options) : null, i, existingField[0].id]);
        }
        else {
            await query(`INSERT INTO request_type_fields (request_type_id, field_key, field_label, field_type, is_required, placeholder, options, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [typeId, f.key, f.label, f.type, f.required ?? false, f.placeholder ?? null, f.options ? JSON.stringify(f.options) : null, i]);
        }
    }
    const hasPermission = await query(`SELECT id FROM request_type_permissions WHERE request_type_id = $1 LIMIT 1`, [typeId]);
    if (!hasPermission[0]) {
        await query(`INSERT INTO request_type_permissions (request_type_id, permission_type, can_submit, can_design)
       VALUES ($1, 'ALL', true, false)`, [typeId]);
    }
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
      additional_assigned_user_id uuid REFERENCES users(id),
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
    await query(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS additional_assigned_user_id uuid REFERENCES users(id)`);
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
// The 6 scopes the PDF Designer covers. CUSTOM_REQUEST rows with
// custom_request_type_id = NULL are a generic fallback template/permission
// set usable by any custom request type that hasn't been given its own.
export const PDF_REQUEST_TYPES = [
    "ADVANCE_REQUEST",
    "CLEARANCE_CLAIM",
    "ACCOMMODATION_REQUEST",
    "OVERTIME_REQUEST",
    "OVERTIME_CLAIM",
    "CUSTOM_REQUEST"
];
async function ensurePdfSchema() {
    await query(`
    CREATE TABLE IF NOT EXISTS pdf_letterhead_settings (
      id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      logo_path                   text,
      company_name                text,
      address_lines               jsonb       NOT NULL DEFAULT '[]',
      contact_line                text,
      footer_confidentiality_text text,
      updated_by_id               uuid        REFERENCES users(id),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS pdf_templates (
      id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      name                   text        NOT NULL,
      request_type           text        NOT NULL,
      custom_request_type_id uuid        REFERENCES custom_request_types(id) ON DELETE CASCADE,
      status                 text        NOT NULL DEFAULT 'DRAFT',
      show_letterhead        boolean     NOT NULL DEFAULT true,
      header_title           text,
      footer_text_override   text,
      accent_color           text,
      sections               jsonb       NOT NULL DEFAULT '[]',
      created_by_id          uuid        REFERENCES users(id),
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_pdf_templates_type ON pdf_templates(request_type, custom_request_type_id)`);
    await query(`
    CREATE TABLE IF NOT EXISTS pdf_permissions (
      id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      request_type           text        NOT NULL,
      custom_request_type_id uuid        REFERENCES custom_request_types(id) ON DELETE CASCADE,
      permission_type        text        NOT NULL DEFAULT 'ALL',
      group_name             text,
      user_id                uuid        REFERENCES users(id) ON DELETE CASCADE,
      can_view_pdf           boolean     NOT NULL DEFAULT false,
      can_design_pdf         boolean     NOT NULL DEFAULT false,
      created_by_id          uuid        REFERENCES users(id),
      created_at             timestamptz NOT NULL DEFAULT now()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_pdf_perm_type ON pdf_permissions(request_type, custom_request_type_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pdf_perm_user ON pdf_permissions(user_id)`);
    const hasLetterhead = await query(`SELECT id FROM pdf_letterhead_settings LIMIT 1`);
    if (!hasLetterhead[0]) {
        await query(`INSERT INTO pdf_letterhead_settings (company_name, address_lines, contact_line, footer_confidentiality_text)
       VALUES ($1, $2, $3, $4)`, [
            "Econet Telecom Lesotho",
            JSON.stringify(["Kingsway Road, Maseru"]),
            "+266 2221 1000  |  www.etl.co.ls",
            "CONFIDENTIAL — For internal use only."
        ]);
    }
    await seedDefaultPdfTemplates();
}
function pdfSection(section) {
    return { id: `sec-${Math.random().toString(36).slice(2, 10)}`, ...section };
}
function fieldGridSection(title, fields, opts) {
    return pdfSection({
        type: "field_grid",
        title: title || undefined,
        numbered: title ? (opts?.numbered ?? true) : false,
        columns: opts?.columns ?? 2,
        fields: fields.map((fieldKey) => ({ fieldKey }))
    });
}
function tableSection(title, tableKey, tableColumns, opts) {
    return pdfSection({ type: "table", title, numbered: opts?.numbered ?? true, tableKey, tableColumns });
}
function twoColumnTableSection(title, leftHeader, rightHeader, leftFields, rightFields, opts) {
    return pdfSection({
        type: "two_column_table",
        title: title || undefined,
        numbered: title ? (opts?.numbered ?? true) : false,
        leftHeader, rightHeader,
        leftFields: leftFields.map((f) => ({ fieldKey: f.fieldKey, labelOverride: f.label, checkboxValue: f.checkboxValue })),
        rightFields: rightFields.map((f) => ({ fieldKey: f.fieldKey, labelOverride: f.label, checkboxValue: f.checkboxValue }))
    });
}
function approvalSummarySection(title = "Approval Summary") {
    return pdfSection({ type: "approval_summary", title, numbered: true });
}
function disclaimerSection(title, items) {
    return pdfSection({ type: "disclaimer", title, disclaimerItems: items });
}
const DEFAULT_TEMPLATE_DEFS = {
    ADVANCE_REQUEST: {
        name: "Default Travel Advance Request",
        headerTitle: "Travel Advance Request",
        sections: [
            fieldGridSection("Requester & Traveller Details", ["request_id", "created_at", "created_by_name", "request_type_label", "requester_name", "requester_employee_no", "traveller_type", "status"], { columns: 4 }),
            fieldGridSection("Trip Details", ["type_label", "destination", "departure_date", "return_date", "travel_duration", "accommodation_summary", "meals_summary"], { columns: 2 }),
            fieldGridSection("", ["purpose"], { columns: 1 }),
            fieldGridSection("Payment Details", ["requested_total", "payment_status"], { columns: 2 }),
            twoColumnTableSection("", "ECOCASH WALLET", "BANK ACCOUNT", [
                { fieldKey: "wallet_name", label: "Wallet Name" },
                { fieldKey: "wallet_number", label: "Wallet Number" },
                { fieldKey: "payment_method", label: "Selected", checkboxValue: "ECOCASH" }
            ], [
                { fieldKey: "bank_name", label: "Bank Name" },
                { fieldKey: "bank_account_number", label: "Account Holder" },
                { fieldKey: "payment_method", label: "Selected", checkboxValue: "BANK" }
            ]),
            approvalSummarySection(),
            disclaimerSection("Clearing Requirement & Disclaimer", [
                "The traveller must submit all original receipts and a completed Travel Expense Claim Form to Finance within **seven (7) working days** of return.",
                "Any unspent advance must be returned within the same 7-day period via the original disbursement channel.",
                "Failure to clear within the stipulated period will result in the amount being **deducted from the traveller's next salary** per ETL Financial Policy FP-007.",
                "All claims are subject to Finance verification and audit. ETL reserves the right to reject claims lacking documentation or exceeding policy limits.",
                "By submitting this request, the requester and traveller confirm the information is accurate and that they have read the **ETL Travel & Subsistence Policy**."
            ])
        ]
    },
    CLEARANCE_CLAIM: {
        name: "Default Travel Advance Clearance",
        headerTitle: "TRAVEL ADVANCE CLEARANCE",
        sections: [
            fieldGridSection("Claimant Details", ["claim_id", "submitted_at", "claimant_name", "department", "status"]),
            fieldGridSection("Trip Details", ["month", "duty_station", "project_number", "vehicle_reg", "vehicle_type", "engine_cc", "vehicle_rate"]),
            fieldGridSection("Reconciliation Summary", ["claim_total", "advance_amount", "balance_amount", "reason_for_overspend"]),
            tableSection("Trip Lines", "claim_trips", [
                { key: "trip_date", label: "Date" }, { key: "from_place", label: "From" }, { key: "to_place", label: "To" },
                { key: "km_travelled", label: "KM" }, { key: "breakfast", label: "Breakfast" }, { key: "lunch", label: "Lunch" },
                { key: "dinner", label: "Dinner" }, { key: "other_expenses", label: "Other" }, { key: "line_total", label: "Total" }
            ]),
            approvalSummarySection(),
            fieldGridSection("Settlement", ["settled_method", "settled_reference", "settled_at", "closed_at"], { numbered: false, columns: 2 })
        ]
    },
    ACCOMMODATION_REQUEST: {
        name: "Default Accommodation Request",
        headerTitle: "ACCOMMODATION REQUEST",
        sections: [
            fieldGridSection("Requester Details", ["request_id", "created_at", "requester_name", "department", "status"]),
            fieldGridSection("Accommodation Details", ["location", "provider", "check_in", "check_out", "amount", "notes"]),
            approvalSummarySection(),
            fieldGridSection("Payment", ["paid_reference", "paid_at", "rejection_comments"], { numbered: false })
        ]
    },
    OVERTIME_REQUEST: {
        name: "Default Overtime Request",
        headerTitle: "OVERTIME REQUEST",
        sections: [
            fieldGridSection("Employee Details", ["employee_name", "employee_no", "job_title", "section_name", "year", "month", "status"]),
            fieldGridSection("Details", ["car_reg", "remarks"], { numbered: false }),
            tableSection("Overtime Lines", "lines", [
                { key: "date", label: "Date" }, { key: "day", label: "Day" }, { key: "estimated_start", label: "Est. Start" },
                { key: "estimated_end", label: "Est. End" }, { key: "actual_start", label: "Actual Start" },
                { key: "actual_end", label: "Actual End" }, { key: "reason", label: "Reason" }
            ]),
            approvalSummarySection()
        ]
    },
    OVERTIME_CLAIM: {
        name: "Default Overtime Claim",
        headerTitle: "OVERTIME CLAIM",
        sections: [
            fieldGridSection("Employee Details", ["employee_name", "employee_no", "job_title", "division", "year", "month", "status"]),
            fieldGridSection("Totals", ["total_overtime", "compensated_hours", "pay_days", "hourly_rate", "total_amount"]),
            tableSection("Overtime Lines", "lines", [
                { key: "date", label: "Date" }, { key: "from_time", label: "From" }, { key: "to_time", label: "To" },
                { key: "hours_125", label: "125%" }, { key: "hours_150", label: "150%" }, { key: "hours_200", label: "200%" },
                { key: "activity_name", label: "Activity" }
            ]),
            approvalSummarySection()
        ]
    },
    CUSTOM_REQUEST: {
        name: "Default Custom Request",
        headerTitle: "REQUEST FORM",
        sections: [
            fieldGridSection("Request Details", ["request_type_name", "requester_name", "submitted_at", "status"]),
            fieldGridSection("Submitted Fields", [], { numbered: true }),
            approvalSummarySection()
        ]
    }
};
async function seedDefaultPdfTemplates() {
    for (const requestType of PDF_REQUEST_TYPES) {
        const existing = await query(`SELECT id FROM pdf_templates WHERE request_type = $1 AND custom_request_type_id IS NULL`, [requestType]);
        if (existing[0])
            continue;
        const def = DEFAULT_TEMPLATE_DEFS[requestType];
        const inserted = await query(`INSERT INTO pdf_templates (name, request_type, status, header_title, sections)
       VALUES ($1, $2, 'ACTIVE', $3, $4)
       RETURNING id`, [def.name, requestType, def.headerTitle, JSON.stringify(def.sections)]);
        await query(`INSERT INTO pdf_permissions (request_type, permission_type, can_view_pdf, can_design_pdf)
       VALUES ($1, 'ALL', true, false)`, [requestType]);
        void inserted;
    }
}
