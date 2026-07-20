-- db/schema.sql
-- PostgreSQL schema for Advance + Clearance system

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$ BEGIN
  CREATE TYPE role_type AS ENUM (
    'EMPLOYEE',
    'HOD',
    'MANAGER',
    'HR_MANAGER',
    'AUTH_OFFICER',
    'CHIEF_OFFICER',
    'FINANCE',
    'ADMIN',
    'EXCO',
    'CEO'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('ECOCASH','BANK','CASH','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE decision_type AS ENUM ('APPROVE','REJECT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE doc_type AS ENUM ('ADVANCE','CLAIM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE advance_status AS ENUM (
    'DRAFT','SUBMITTED','CHIEF_OFFICER_REVIEW','HR_MANAGER_REVIEW','HR_REVIEW','HR_OFFICER','APPROVED','PAID','CLOSED','REJECTED','CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE claim_status AS ENUM (
    'DRAFT','SUBMITTED',
    'MANAGER_APPROVED','CHIEF_OFFICER_APPROVED','HR_OFFICER','HR_MANAGER_REVIEW',
    'FINANCE_VERIFIED','PAYMENT_PROCESSING','SETTLED','CLOSED','REJECTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_step AS ENUM (
    'MANAGER','HR_MANAGER','CHIEF_OFFICER','FINANCE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workflow_status AS ENUM ('DRAFT','ACTIVE','INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workflow_request_type AS ENUM ('ADVANCE_REQUEST','CLAIM_REQUEST','OVERTIME_REQUEST','CLEARANCE_REQUEST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_no text UNIQUE,
  full_name text,
  title text,
  department text,
  duty_station text,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role role_type NOT NULL DEFAULT 'EMPLOYEE',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  request_type workflow_request_type NOT NULL DEFAULT 'ADVANCE_REQUEST',
  department text,
  status workflow_status NOT NULL DEFAULT 'DRAFT',
  created_by_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  requires_accommodation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
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
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_rules_workflow ON workflow_rules(workflow_id);

CREATE INDEX IF NOT EXISTS idx_workflows_request_type ON workflows(request_type);
CREATE INDEX IF NOT EXISTS idx_workflows_department ON workflows(department);

CREATE TABLE IF NOT EXISTS sections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text UNIQUE NOT NULL,
  exco_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text UNIQUE NOT NULL,
  section_id uuid REFERENCES sections(id),
  manager_user_id uuid REFERENCES users(id),
  exco_user_id uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advance_requests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  requester_id uuid NOT NULL REFERENCES users(id),
  created_by_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  purpose text,
  project_number text,
  payment_method payment_method NOT NULL DEFAULT 'ECOCASH',
  payment_account text,
  requested_total numeric(12,2) NOT NULL DEFAULT 0,
  approved_total numeric(12,2) NOT NULL DEFAULT 0,
  status advance_status NOT NULL DEFAULT 'DRAFT',

  submitted_at timestamptz,
  approved_at timestamptz,
  paid_at timestamptz,
  paid_reference text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advance_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  advance_request_id uuid NOT NULL REFERENCES advance_requests(id) ON DELETE CASCADE,
  line_date date NOT NULL,
  location text,
  travel_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  meals_count integer NOT NULL DEFAULT 0,
  meal_value numeric(12,2) NOT NULL DEFAULT 0,
  lunch numeric(12,2) NOT NULL DEFAULT 0,
  dinner numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_advance_lines_req ON advance_lines(advance_request_id);

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
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','PAID','REJECTED')),
  paid_reference text,
  paid_at timestamptz,
  rejection_comments text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accommodation_requests_status ON accommodation_requests(status);
CREATE INDEX IF NOT EXISTS idx_accommodation_requests_advance ON accommodation_requests(advance_request_id);

CREATE TABLE IF NOT EXISTS accommodation_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  accommodation_request_id uuid NOT NULL REFERENCES accommodation_requests(id) ON DELETE CASCADE,
  quotation_path text NOT NULL,
  quotation_uploaded_at timestamptz NOT NULL DEFAULT now(),
  quotation_uploaded_by_id uuid NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS accommodation_hotels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  district text,
  country text,
  province text,
  city text,
  address text,
  contact text,
  department text,
  created_by_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accommodation_hotels_district ON accommodation_hotels(district);

CREATE TABLE IF NOT EXISTS system_state (
  key text PRIMARY KEY,
  value text
);

CREATE TABLE IF NOT EXISTS travel_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  location_mode text NOT NULL DEFAULT 'DISTRICT' CHECK (location_mode IN ('DISTRICT','COUNTRY_CITY')),
  rate_kind text NOT NULL DEFAULT 'MEAL' CHECK (rate_kind IN ('MEAL','DAILY')),
  rate_general_staff numeric(12,2) NOT NULL DEFAULT 0,
  rate_exco numeric(12,2) NOT NULL DEFAULT 0,
  rate_ceo numeric(12,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS travel_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  travel_type_id uuid NOT NULL REFERENCES travel_types(id) ON DELETE CASCADE,
  district text,
  country text,
  province text,
  city text,
  active boolean NOT NULL DEFAULT true,
  created_by_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_travel_locations_type ON travel_locations(travel_type_id);

CREATE TABLE IF NOT EXISTS clearance_claims (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  claimant_id uuid NOT NULL REFERENCES users(id),

  month text,
  duty_station text,
  project_number text,

  vehicle_reg text,
  vehicle_type text,
  engine_cc text,
  vehicle_rate numeric(12,2),

  linked_advance_id uuid REFERENCES advance_requests(id),
  status claim_status NOT NULL DEFAULT 'DRAFT',

  claim_total numeric(12,2) NOT NULL DEFAULT 0,
  advance_amount numeric(12,2) NOT NULL DEFAULT 0,
  balance_amount numeric(12,2) NOT NULL DEFAULT 0,

  settled_method payment_method,
  settled_reference text,
  settled_at timestamptz,

  finance_decision text,
  finance_comments text,
  settlement_amount numeric(12,2),
  assignee_user_id uuid REFERENCES users(id),
  assignee_group_name text,
  expected_payment_date date,

  submitted_at timestamptz,
  closed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique_month ON attendance_records(employee_id, month, year);

CREATE TABLE IF NOT EXISTS overtime_requests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
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
);

CREATE TABLE IF NOT EXISTS overtime_claims (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
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
);

CREATE TABLE IF NOT EXISTS claim_trips (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  clearance_claim_id uuid NOT NULL REFERENCES clearance_claims(id) ON DELETE CASCADE,

  trip_date date NOT NULL,
  from_place text,
  to_place text,
  depart_time text,
  arrive_time text,

  km_travelled numeric(12,2) NOT NULL DEFAULT 0,
  petrol_allowance numeric(12,2) NOT NULL DEFAULT 0,

  breakfast numeric(12,2) NOT NULL DEFAULT 0,
  lunch numeric(12,2) NOT NULL DEFAULT 0,
  dinner numeric(12,2) NOT NULL DEFAULT 0,

  other_expenses numeric(12,2) NOT NULL DEFAULT 0,
  purpose text,

  line_total numeric(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_claim_trips_claim ON claim_trips(clearance_claim_id);

CREATE TABLE IF NOT EXISTS receipts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  clearance_claim_id uuid NOT NULL REFERENCES clearance_claims(id) ON DELETE CASCADE,
  file_path text NOT NULL,
  category text,
  amount numeric(12,2),
  notes text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  doc_type doc_type NOT NULL,
  doc_id uuid NOT NULL,

  step approval_step NOT NULL,
  approver_id uuid NOT NULL REFERENCES users(id),

  decision decision_type NOT NULL,
  comments text,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approvals_doc ON approvals(doc_type, doc_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_feature_permissions (
  feature_key text PRIMARY KEY,
  allowed_roles text[] NOT NULL DEFAULT '{}'::text[],
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  INSERT INTO admin_feature_permissions (feature_key, allowed_roles) VALUES
    ('user_management',      ARRAY['ADMIN','MANAGER','EXCO']),
    ('roles_permissions',    ARRAY['ADMIN','MANAGER','EXCO']),
    ('travel_setup',         ARRAY['ADMIN','HR_MANAGER','MANAGER']),
    ('org_structure',        ARRAY['ADMIN']),
    ('team_roster',          ARRAY['ADMIN']),
    ('sections_departments', ARRAY['ADMIN','MANAGER','EXCO']),
    ('ceo_management',       ARRAY['ADMIN']),
    ('employees',            ARRAY['ADMIN']),
    ('exco_members',         ARRAY['ADMIN','MANAGER']),
    ('managers',             ARRAY['ADMIN','MANAGER','EXCO']),
    ('leadership_assignments',ARRAY['ADMIN','MANAGER','EXCO']),
    ('workflow_builder',     ARRAY['ADMIN','MANAGER','EXCO']),
    ('request_types',        ARRAY['ADMIN']),
    ('reporting_lines',      ARRAY['ADMIN','MANAGER','EXCO'])
  ON CONFLICT (feature_key) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
