import { query } from "./db.js";
import { AIRPORTS_SEED } from "../data/airportsSeed.js";

// Backs the "Where From" / "Where To" airport picker on the international
// ("Plan Your Trip") advance-request flow — a real, curated IATA airport
// list rather than free-text city entry. Seeded once from a public dataset
// (see airportsSeed.ts); the table itself is never edited through the app,
// so there's no admin CRUD here, just search.
export async function ensureAirportsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS airports (
      id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      iata_code  text        NOT NULL UNIQUE,
      name       text        NOT NULL,
      city       text        NOT NULL,
      country    text        NOT NULL DEFAULT ''
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_airports_city ON airports (lower(city))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_airports_country ON airports (lower(country))`);

  const [{ count }] = await query<{ count: string }>(`SELECT count(*)::text AS count FROM airports`);
  if (Number(count) > 0) return; // already seeded - this table is never hand-edited, so a non-empty table means "done"

  // Batched, not one INSERT per row - 6000+ rows one at a time would be slow
  // enough at boot to matter; ~500 rows per statement keeps each query well
  // under Postgres's parameter limit.
  const BATCH = 500;
  for (let i = 0; i < AIRPORTS_SEED.length; i += BATCH) {
    const batch = AIRPORTS_SEED.slice(i, i + BATCH);
    const values: string[] = [];
    const params: string[] = [];
    batch.forEach((a, idx) => {
      const base = idx * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(a.iata, a.name, a.city, a.country);
    });
    await query(
      `INSERT INTO airports (iata_code, name, city, country) VALUES ${values.join(", ")} ON CONFLICT (iata_code) DO NOTHING`,
      params
    );
  }
}

export interface AirportSearchRow {
  iata_code: string;
  name: string;
  city: string;
  country: string;
}

// No query = the whole table. At ~6000 rows that's a perfectly reasonable
// one-time payload (same idea as the company directory fetched in full
// elsewhere) - the frontend's airport picker loads it once and filters
// client-side, same pattern as ApproverCombobox, rather than round-tripping
// on every keystroke. A `q` is still accepted for a ranked, capped search if
// something ever needs one server-side.
export async function searchAirports(q: string, limit = 10000): Promise<AirportSearchRow[]> {
  const term = q.trim();
  if (!term) {
    return query<AirportSearchRow>(`SELECT iata_code, name, city, country FROM airports ORDER BY city LIMIT $1`, [limit]);
  }
  const like = `%${term}%`;
  const iataLike = `${term.toUpperCase()}%`;
  return query<AirportSearchRow>(
    `SELECT iata_code, name, city, country FROM airports
      WHERE iata_code ILIKE $1 OR city ILIKE $2 OR country ILIKE $2 OR name ILIKE $2
      ORDER BY
        (iata_code = $3) DESC,
        (iata_code ILIKE $1) DESC,
        (city ILIKE $4) DESC,
        city ASC
      LIMIT $5`,
    [iataLike, like, term.toUpperCase(), `${term}%`, limit]
  );
}
