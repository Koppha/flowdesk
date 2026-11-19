import { query } from "./db.js";

// Where and when a clearance's trip actually happened, from the advance it
// clears - not the claimant's duty station (where they're based), which is
// shown separately.
//   destination: a flight's destination airport ("Bloemfontein, South
//     Africa"); for a road trip the places on the route other than where
//     they set off from ("Maseru → Mokhotlong → Thaba-Tseka → Maseru" →
//     "Mokhotlong, Thaba-Tseka").
//   departure_date: the first trip line's date; return_date: the last day of
//     the trip - the later of the advance's return date and its last trip
//     line's date (lib/clearanceDue.ts uses the same for the clearance deadline).
//   origin: where they set off from - the flight's departure airport, else the
//     first place on the route ("Maseru").
export type TripDetails = { origin: string | null; destination: string | null; departure_date: string | null; return_date: string | null };

function placeName(raw: string): string {
  const s = raw.trim();
  // "Country / Province / City" (or "Country / City") -> "City, Country"
  if (s.includes(" / ")) {
    const parts = s.split(" / ").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 1]}, ${parts[0]}`;
  }
  return s;
}

// Only a route ("Maseru → Quthing") says where a trip began; a line that is
// just the destination ("South Africa / Free State / Bloemfontein") doesn't,
// so that gives no starting place rather than repeating the destination.
export function originFromLines(locations: string[]): string | null {
  for (const loc of locations) {
    if (!loc || !/(→|->)/.test(loc)) continue;
    const first = loc.split(/\s*(?:→|->)\s*/).map((p) => p.trim()).filter(Boolean)[0];
    if (first) return placeName(first);
  }
  return null;
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
  const advances = await query<{ id: string; return_date: string | null; airport_city: string | null; airport_country: string | null; origin_city: string | null; origin_country: string | null; origin_text: string | null }>(
    `SELECT ar.id, to_char(ar.travel_return_date, 'YYYY-MM-DD') AS return_date, a.city AS airport_city, a.country AS airport_country,
            o.city AS origin_city, o.country AS origin_country, nullif(trim(ar.travel_origin_text), '') AS origin_text
       FROM advance_requests ar
       LEFT JOIN airports a ON upper(a.iata_code) = upper(ar.travel_destination_iata)
       LEFT JOIN airports o ON upper(o.iata_code) = upper(ar.travel_origin_iata)
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
      origin: a.origin_city
        ? [a.origin_city, a.origin_country].filter(Boolean).join(", ")
        : a.origin_text ?? originFromLines(own.map((l) => l.location || "")),
      destination: a.airport_city
        ? [a.airport_city, a.airport_country].filter(Boolean).join(", ")
        : destinationFromLines(own.map((l) => l.location || "")),
      departure_date: dates[0] ?? null,
      // The last day of the trip: the later of the return date and the last trip line.
      return_date: [a.return_date, dates[dates.length - 1]].filter((d): d is string => !!d).sort().pop() ?? null
    });
  }
  return out;
}

// A claim (no advance): its trip is its own trip lines.
async function tripDetailsForClaims(claimIds: string[]): Promise<Map<string, TripDetails>> {
  const ids = Array.from(new Set(claimIds.filter(Boolean)));
  const out = new Map<string, TripDetails>();
  if (!ids.length) return out;
  const lines = await query<{ clearance_claim_id: string; from_place: string | null; to_place: string | null; trip_date: string }>(
    `SELECT clearance_claim_id, from_place, to_place, to_char(trip_date, 'YYYY-MM-DD') AS trip_date
       FROM claim_trips WHERE clearance_claim_id = ANY($1::uuid[]) ORDER BY clearance_claim_id, trip_date, id`,
    [ids]
  );
  for (const id of ids) {
    const own = lines.filter((l) => l.clearance_claim_id === id);
    if (!own.length) continue;
    const dates = own.map((l) => l.trip_date).filter(Boolean).sort();
    const stops = own.map((l) => [l.from_place, l.to_place].filter(Boolean).join(" → "));
    out.set(id, { origin: own[0].from_place || originFromLines(stops), destination: destinationFromLines(stops), departure_date: dates[0] ?? null, return_date: dates[dates.length - 1] ?? null });
  }
  return out;
}

// Adds destination / departure_date / return_date to clearance rows that
// carry linked_advance_id - or, for a claim (no advance), from its own trip lines.
export async function withTripDetails<T extends { linked_advance_id: string | null }>(rows: T[]): Promise<Array<T & TripDetails>> {
  const trips = await tripDetailsForAdvances(rows.map((r) => r.linked_advance_id).filter((x): x is string => !!x));
  const claimTrips = await tripDetailsForClaims(rows.filter((r) => !r.linked_advance_id).map((r) => String((r as { id?: unknown }).id ?? "")));
  const none = { origin: null, destination: null, departure_date: null, return_date: null };
  return rows.map((r) => ({ ...r, ...(r.linked_advance_id ? trips.get(r.linked_advance_id) ?? none : claimTrips.get(String((r as { id?: unknown }).id ?? "")) ?? none) }));
}
