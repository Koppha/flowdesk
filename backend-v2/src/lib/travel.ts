import { badRequest } from "./errors.js";
import { query } from "./db.js";

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
    locations: row.locations || []
  };
}

export async function ensureTravelSchema() {
  await query(`ALTER TABLE advance_requests ALTER COLUMN type DROP DEFAULT`);
  await query(`ALTER TABLE advance_requests ALTER COLUMN type TYPE text USING type::text`);
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
    `SELECT id, code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, currency, active, requires_accommodation
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
      `SELECT id, code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, currency, active, requires_accommodation
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
  if (RESERVED_ADVANCE_TYPES.has(normalized)) return normalized;
  const travelType = await getTravelTypeByCode(normalized);
  if (!travelType?.active) throw badRequest("Select an active travel type");
  return normalized;
}

export async function getTravelRateForCode(code: string) {
  const travelType = await getTravelTypeByCode(code);
  return travelType ? toNumber(travelType.rate_general_staff) : 0;
}

export function isReservedAdvanceType(code: string) {
  return RESERVED_ADVANCE_TYPES.has(normalizeTravelCode(code));
}
