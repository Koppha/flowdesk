-- db/schema.sql
-- PostgreSQL schema for Advance + Clearance system


DO $$ BEGIN
  CREATE TYPE role_type AS ENUM (
    'EMPLOYEE',
    'MANAGER',
    'HR_MANAGER',
    'AUTH_OFFICER',
    'CHIEF_OFFICER',
    'FINANCE',
    'ADMIN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE advance_type AS ENUM ('TRAVEL_SUBSISTENCE','SALARY','LOAN');
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
    'MANAGER_APPROVED','CHIEF_OFFICER_APPROVED','HR_OFFICER',
    'FINANCE_VERIFIED','SETTLED','CLOSED','REJECTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_step AS ENUM (
    'MANAGER','HR_MANAGER','AUTH_OFFICER','CHIEF_OFFICER','FINANCE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_no text UNIQUE NOT NULL,
  full_name text NOT NULL,
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

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id),
  created_by_id uuid NOT NULL REFERENCES users(id),
  type advance_type NOT NULL DEFAULT 'TRAVEL_SUBSISTENCE',
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_request_id uuid NOT NULL REFERENCES advance_requests(id) ON DELETE CASCADE,
  line_date date NOT NULL,
  location text,
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

CREATE TABLE IF NOT EXISTS clearance_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

  submitted_at timestamptz,
  closed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clearance_claim_id uuid NOT NULL REFERENCES clearance_claims(id) ON DELETE CASCADE,
  file_path text NOT NULL,
  category text,
  amount numeric(12,2),
  notes text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
