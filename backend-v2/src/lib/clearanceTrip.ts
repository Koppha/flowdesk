import { query } from "./db.js";

// Where and when a clearance's trip actually happened, from the advance it
// clears - not the claimant's duty station (where they're based), which is
// shown separately.
//   destination: a flight's destination airport ("Bloemfontein, South
//     Africa"); for a road trip the places on the route other than where
//     they set off from ("Maseru → Mokhotlong → Thaba-Tseka → Maseru" →
//     "Mokhotlong, Thaba-Tseka").
//   departure_date: the first trip line's date; return_date: the advance's
//     return date, else the last trip line's date.
export type TripDetails = { destination: string | null; departure_date: string | null; return_date: string | null };

function placeName(raw: string): string {
  const s = raw.trim();
  // "Country / Province / City" (or "Country / City") -> "City, Country"
  if (s.includes(" / ")) {
    const parts = s.split(" / ").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 1]}, ${parts[0]}`;
  }
  return s;
}

export function destinationFromLines(locations: string[]): string | null {
  const stops: string[] = [];
  for (const loc of locations) {
    if (!loc?.trim()) continue;
    const legs = loc.split(/\s*(?:→|->)\s*/).map((p) => p.trim()).filter(Boolean);
    for (const leg of legs.length ? legs : [loc]) stops.push(placeName(leg));
  }
  if (!stops.length) return null;
  const origin = stops[0].toLowerCase();
  const seen = new Set<string>();
  const places = stops.filter((p) => {
    const k = p.toLowerCase();
    if (k === origin || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // A trip that never left its starting town (e.g. "Maseru → Maseru").
  return (places.length ? places : [stops[0]]).join(", ");
}

export async function tripDetailsForAdvances(advanceIds: string[]): Promise<Map<string, TripDetails>> {
  const ids = Array.from(new Set(advanceIds.filter(Boolean)));
  const out = new Map<string, TripDetails>();
  if (!ids.length) return out;
  const advances = await query<{ id: string; return_date: string | null; airport_city: string | null; airport_country: string | null }>(
    `SELECT ar.id, to_char(ar.travel_return_date, 'YYYY-MM-DD') AS return_date, a.city AS airport_city, a.country AS airport_country
       FROM advance_requests ar
       LEFT JOIN airports a ON upper(a.iata_code) = upper(ar.travel_destination_iata)
      WHERE ar.id = ANY($1::uuid[])`,
    [ids]
  );
  const lines = await query<{ advance_request_id: string; location: string | null; line_date: string }>(
    `SELECT advance_request_id, location, to_char(line_date, 'YYYY-MM-DD') AS line_date
       FROM advance_lines WHERE advance_request_id = ANY($1::uuid[])
      ORDER BY advance_request_id, line_date, id`,
    [ids]
  );
  for (const a of advances) {
    const own = lines.filter((l) => l.advance_request_id === a.id);
    const dates = own.map((l) => l.line_date).filter(Boolean).sort();
    out.set(a.id, {
      destination: a.airport_city
        ? [a.airport_city, a.airport_country].filter(Boolean).join(", ")
        : destinationFromLines(own.map((l) => l.location || "")),
      departure_date: dates[0] ?? null,
      return_date: a.return_date ?? dates[dates.length - 1] ?? null
    });
  }
  return out;
}

// Adds destination / departure_date / return_date to clearance rows that
// carry linked_advance_id.
export async function withTripDetails<T extends { linked_advance_id: string | null }>(rows: T[]): Promise<Array<T & TripDetails>> {
  const trips = await tripDetailsForAdvances(rows.map((r) => r.linked_advance_id).filter((x): x is string => !!x));
  return rows.map((r) => ({ ...r, ...(trips.get(r.linked_advance_id || "") ?? { destination: null, departure_date: null, return_date: null }) }));
}
