import { badRequest } from "./errors.js";
import { query } from "./db.js";
import { getBooleanSystemSetting, getNumericSystemSetting, SYSTEM_SETTING_KEYS } from "./systemSettings.js";

export type TravelLocationMode = "DISTRICT" | "COUNTRY_CITY";
export type TravelRateKind = "MEAL" | "DAILY";

export type TravelTypeRow = {
  id: string;
  code: string;
  name: string;
  location_mode: TravelLocationMode;
  rate_kind: TravelRateKind;
  rate_general_staff: string | number;
  rate_exco: string | number;
  rate_ceo: string | number;
  currency: string;
  active: boolean;
  requires_accommodation: boolean;
  allowed_payment_methods: string[];
  // Admin-configured, per travel type - whether this type can be picked for
  // "Apply for Other" (an advance for an external, non-Econet beneficiary).
  // Off by default; an admin opts specific types in (e.g. Local, CAM).
  allow_external_beneficiary: boolean;
};

export type TravelLocationRow = {
  id: string;
  travel_type_id: string;
  district: string | null;
  country: string | null;
  province: string | null;
  city: string | null;
  active: boolean;
};

const RESERVED_ADVANCE_TYPES = new Set(["SALARY", "LOAN"]);

export function normalizeTravelCode(value: string) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function toNumber(value: string | number | null | undefined) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function mapTravelType(row: TravelTypeRow & { locations?: TravelLocationRow[] }) {
  return {
    ...row,
    rate_general_staff: toNumber(row.rate_general_staff),
    rate_exco: toNumber(row.rate_exco),
    rate_ceo: toNumber(row.rate_ceo),
    currency: row.currency || "LSL",
    requires_accommodation: row.requires_accommodation ?? false,
    allowed_payment_methods: row.allowed_payment_methods?.length ? row.allowed_payment_methods : ["ECOCASH", "BANK"],
    allow_external_beneficiary: row.allow_external_beneficiary ?? false,
    locations: row.locations || []
  };
}

export async function ensureTravelSchema() {
  // Guarded rather than run unconditionally on every boot: once this column
  // is already text, re-running the ALTER (even to the same type) is
  // rejected by Postgres if anything now depends on it - e.g.
  // reporting_advances_flat (see reporting.schema.ts), which selects this
  // column directly. Only ever needs to run once per environment.
  const [current] = await query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns WHERE table_name = 'advance_requests' AND column_name = 'type'`
  );
  if (current?.data_type !== "text") {
    await query(`ALTER TABLE advance_requests ALTER COLUMN type DROP DEFAULT`);
    await query(`ALTER TABLE advance_requests ALTER COLUMN type TYPE text USING type::text`);
  }
  await query(`ALTER TABLE advance_lines ADD COLUMN IF NOT EXISTS travel_meta jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE accommodation_hotels ADD COLUMN IF NOT EXISTS country text`);
  await query(`ALTER TABLE accommodation_hotels ADD COLUMN IF NOT EXISTS province text`);
  await query(`ALTER TABLE accommodation_hotels ADD COLUMN IF NOT EXISTS city text`);
  await query(`ALTER TABLE accommodation_hotels DROP COLUMN IF EXISTS department`);

  await query(`
    CREATE TABLE IF NOT EXISTS travel_types (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text UNIQUE NOT NULL,
      name text NOT NULL,
      location_mode text NOT NULL DEFAULT 'DISTRICT',
      rate_kind text NOT NULL DEFAULT 'MEAL',
      rate_general_staff numeric(12,2) NOT NULL DEFAULT 0,
      rate_exco numeric(12,2) NOT NULL DEFAULT 0,
      rate_ceo numeric(12,2) NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_by_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT travel_types_location_mode_check CHECK (location_mode IN ('DISTRICT','COUNTRY_CITY')),
      CONSTRAINT travel_types_rate_kind_check CHECK (rate_kind IN ('MEAL','DAILY'))
    )
  `);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS location_mode text NOT NULL DEFAULT 'DISTRICT'`);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS rate_kind text NOT NULL DEFAULT 'MEAL'`);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS rate_general_staff numeric(12,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS rate_exco numeric(12,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS rate_ceo numeric(12,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'LSL'`);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS requires_accommodation boolean NOT NULL DEFAULT false`);
  // Superseded by an unconditional extra-cost field on every travel advance
  // (advance_requests.extra_cost_amount/description) - no longer a per-type toggle.
  await query(`ALTER TABLE travel_types DROP COLUMN IF EXISTS has_extra_costs`);
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS allowed_payment_methods text[] NOT NULL DEFAULT ARRAY['ECOCASH','BANK']`);
  // Admin-configured, per travel type - see the "Apply for Other" advance
  // flow (advances.routes.ts). Off by default; an admin opts specific
  // types in.
  await query(`ALTER TABLE travel_types ADD COLUMN IF NOT EXISTS allow_external_beneficiary boolean NOT NULL DEFAULT false`);

  await query(`
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
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_travel_locations_type ON travel_locations(travel_type_id)`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_locations_unique
      ON travel_locations (
        travel_type_id,
        COALESCE(district, ''),
        COALESCE(country, ''),
        COALESCE(province, ''),
        COALESCE(city, '')
      )
  `);
}

export async function listTravelTypes(includeInactive = false) {
  const rows = await query<TravelTypeRow>(
    `SELECT id, code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, currency, active, requires_accommodation, allowed_payment_methods, allow_external_beneficiary
       FROM travel_types
      ${includeInactive ? "" : "WHERE active = true"}
      ORDER BY name`
  );
  const locations = await query<TravelLocationRow>(
    `SELECT id, travel_type_id, district, country, province, city, active
       FROM travel_locations
      WHERE active = true
      ORDER BY country NULLS LAST, province NULLS LAST, city NULLS LAST, district NULLS LAST`
  );
  return rows.map((row) =>
    mapTravelType({
      ...row,
      locations: locations.filter((location) => location.travel_type_id === row.id)
    })
  );
}

export async function getTravelTypeByCode(code: string) {
  const normalized = normalizeTravelCode(code);
  if (!normalized) return null;
  const row = (
    await query<TravelTypeRow>(
      `SELECT id, code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, currency, active, requires_accommodation, allowed_payment_methods, allow_external_beneficiary
         FROM travel_types
        WHERE code = $1
        LIMIT 1`,
      [normalized]
    )
  )[0];
  return row ? mapTravelType(row) : null;
}

export async function isTravelAdvanceType(code: string) {
  const travelType = await getTravelTypeByCode(code);
  return Boolean(travelType?.active);
}

export async function assertAdvanceTypeAllowed(type: string) {
  const normalized = normalizeTravelCode(type);
  if (normalized === "SALARY" && !(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.salaryAdvanceEnabled, true))) {
    throw badRequest("Salary advances are currently disabled");
  }
  if (normalized === "LOAN" && !(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.loanAdvanceEnabled, true))) {
    throw badRequest("Loan advances are currently disabled");
  }
  if (RESERVED_ADVANCE_TYPES.has(normalized)) return normalized;
  const travelType = await getTravelTypeByCode(normalized);
  if (!travelType?.active) throw badRequest("Select an active travel type");
  return normalized;
}

// SALARY/LOAN only - admin sets a per-type max via
// SYSTEM_SETTING_KEYS.salary/loanAdvanceMaxPaybackMonths (default 6,
// matching the previous hardcoded max). Returns the validated month count.
export async function assertPaybackMonthsAllowed(type: string, months: number | undefined) {
  const normalized = normalizeTravelCode(type);
  if (!RESERVED_ADVANCE_TYPES.has(normalized)) return null;
  const key = normalized === "SALARY" ? SYSTEM_SETTING_KEYS.salaryAdvanceMaxPaybackMonths : SYSTEM_SETTING_KEYS.loanAdvanceMaxPaybackMonths;
  const max = await getNumericSystemSetting(key, 6);
  if (!Number.isInteger(months) || (months as number) < 1) {
    throw badRequest("Please choose a payback duration.");
  }
  if ((months as number) > max) {
    throw badRequest(`Payback duration cannot exceed ${max} month${max === 1 ? "" : "s"}`);
  }
  return months as number;
}

// SALARY only - admin sets which day of the month a Salary Advance FOR
// that same calendar month opens on (e.g. 5 - "you can apply for
// September after the 5th of September"), via
// SYSTEM_SETTING_KEYS.salaryAdvanceApplicationOpenDay (default 1, i.e. no
// restriction). Only gates a request whose own Salary Month is the
// current calendar month - applying for a past or future month is never
// restricted by this setting.
export async function assertSalaryMonthWindowAllowed(type: string, salaryMonth: string | undefined) {
  if (normalizeTravelCode(type) !== "SALARY") return;
  if (!salaryMonth) return;
  const openDay = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.salaryAdvanceApplicationOpenDay, 1);
  if (openDay <= 1) return;
  const today = new Date();
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  if (salaryMonth.slice(0, 7) !== currentMonth) return;
  if (today.getDate() < openDay) {
    throw badRequest(`Salary Advance requests for the current month open on day ${openDay} - please try again then, or pick a different month.`);
  }
}

export async function getTravelRateForCode(code: string, requesterRole?: string | null) {
  const travelType = await getTravelTypeByCode(code);
  if (!travelType) return 0;
  if (requesterRole === "CEO") return toNumber(travelType.rate_ceo);
  if (requesterRole === "EXCO") return toNumber(travelType.rate_exco);
  return toNumber(travelType.rate_general_staff);
}

export function isReservedAdvanceType(code: string) {
  return RESERVED_ADVANCE_TYPES.has(normalizeTravelCode(code));
}
