import { badRequest } from "./errors.js";
import { query } from "./db.js";
import { getNumericSystemSetting, SYSTEM_SETTING_KEYS } from "./systemSettings.js";
const LESOTHO_DISTRICTS = [
    "Butha-Buthe",
    "Leribe",
    "Berea",
    "Maseru",
    "Mafeteng",
    "Mohale's Hoek",
    "Quthing",
    "Qacha's Nek",
    "Mokhotlong",
    "Thaba-Tseka"
];
const RESERVED_ADVANCE_TYPES = new Set(["SALARY", "LOAN"]);
export function normalizeTravelCode(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
}
function toNumber(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
}
function mapTravelType(row) {
    return {
        ...row,
        rate_general_staff: toNumber(row.rate_general_staff),
        rate_exco: toNumber(row.rate_exco),
        rate_ceo: toNumber(row.rate_ceo),
        locations: row.locations || []
    };
}
export async function ensureTravelSchema() {
    await query(`ALTER TABLE advance_requests ALTER COLUMN type DROP DEFAULT`);
    await query(`ALTER TABLE advance_requests ALTER COLUMN type TYPE text USING type::text`);
    await query(`ALTER TABLE advance_requests ALTER COLUMN type SET DEFAULT 'TRAVEL_SUBSISTENCE'`);
    await query(`ALTER TABLE advance_lines ADD COLUMN IF NOT EXISTS travel_meta jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await query(`ALTER TABLE accommodation_hotels ADD COLUMN IF NOT EXISTS country text`);
    await query(`ALTER TABLE accommodation_hotels ADD COLUMN IF NOT EXISTS province text`);
    await query(`ALTER TABLE accommodation_hotels ADD COLUMN IF NOT EXISTS city text`);
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
    await seedDefaultTravelTypes();
}
async function seedDefaultTravelTypes() {
    const localRate = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.mealValue, 0);
    const local = (await query(`INSERT INTO travel_types
        (code, name, location_mode, rate_kind, rate_general_staff, active)
       VALUES ('TRAVEL_SUBSISTENCE', 'Local Travel Allowance', 'DISTRICT', 'MEAL', $1, true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             location_mode = EXCLUDED.location_mode,
             rate_kind = EXCLUDED.rate_kind,
             rate_general_staff = CASE
               WHEN travel_types.rate_general_staff = 0 THEN EXCLUDED.rate_general_staff
               ELSE travel_types.rate_general_staff
             END,
             active = true,
             updated_at = now()
       RETURNING id`, [localRate]))[0];
    const cma = (await query(`INSERT INTO travel_types
        (code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, active)
       VALUES ('CMA', 'Business Travel Allowance (CMA)', 'COUNTRY_CITY', 'DAILY', 600, 800, 1000, true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             location_mode = EXCLUDED.location_mode,
             rate_kind = EXCLUDED.rate_kind,
             rate_general_staff = CASE
               WHEN travel_types.rate_general_staff = 0 THEN EXCLUDED.rate_general_staff
               ELSE travel_types.rate_general_staff
             END,
             rate_exco = CASE WHEN travel_types.rate_exco = 0 THEN EXCLUDED.rate_exco ELSE travel_types.rate_exco END,
             rate_ceo = CASE WHEN travel_types.rate_ceo = 0 THEN EXCLUDED.rate_ceo ELSE travel_types.rate_ceo END,
             active = true,
             updated_at = now()
       RETURNING id`))[0];
    for (const district of LESOTHO_DISTRICTS) {
        await query(`INSERT INTO travel_locations (travel_type_id, district)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [local.id, district]);
    }
    const cmaLocations = [
        { country: "South Africa", province: "Gauteng", city: "Johannesburg" },
        { country: "South Africa", province: "Gauteng", city: "Pretoria" },
        { country: "South Africa", province: "Western Cape", city: "Cape Town" },
        { country: "South Africa", province: "KwaZulu-Natal", city: "Durban" },
        { country: "Namibia", province: "", city: "Windhoek" },
        { country: "Eswatini", province: "", city: "Mbabane" }
    ];
    for (const location of cmaLocations) {
        await query(`INSERT INTO travel_locations (travel_type_id, country, province, city)
       VALUES ($1, $2, NULLIF($3, ''), $4)
       ON CONFLICT DO NOTHING`, [cma.id, location.country, location.province, location.city]);
    }
}
export async function listTravelTypes(includeInactive = false) {
    const rows = await query(`SELECT id, code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, active
       FROM travel_types
      ${includeInactive ? "" : "WHERE active = true"}
      ORDER BY name`);
    const locations = await query(`SELECT id, travel_type_id, district, country, province, city, active
       FROM travel_locations
      WHERE active = true
      ORDER BY country NULLS LAST, province NULLS LAST, city NULLS LAST, district NULLS LAST`);
    return rows.map((row) => mapTravelType({
        ...row,
        locations: locations.filter((location) => location.travel_type_id === row.id)
    }));
}
export async function getTravelTypeByCode(code) {
    const normalized = normalizeTravelCode(code);
    if (!normalized)
        return null;
    const row = (await query(`SELECT id, code, name, location_mode, rate_kind, rate_general_staff, rate_exco, rate_ceo, active
         FROM travel_types
        WHERE code = $1
        LIMIT 1`, [normalized]))[0];
    return row ? mapTravelType(row) : null;
}
export async function isTravelAdvanceType(code) {
    const travelType = await getTravelTypeByCode(code);
    return Boolean(travelType?.active);
}
export async function assertAdvanceTypeAllowed(type) {
    const normalized = normalizeTravelCode(type);
    if (RESERVED_ADVANCE_TYPES.has(normalized))
        return normalized;
    const travelType = await getTravelTypeByCode(normalized);
    if (!travelType?.active)
        throw badRequest("Select an active travel type");
    return normalized;
}
export async function getTravelRateForCode(code) {
    const travelType = await getTravelTypeByCode(code);
    return travelType ? toNumber(travelType.rate_general_staff) : 0;
}
export function isReservedAdvanceType(code) {
    return RESERVED_ADVANCE_TYPES.has(normalizeTravelCode(code));
}
