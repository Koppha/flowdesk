import { query } from "./db.js";

let ensured = false;
async function ensureSequenceTable() {
  if (ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS sequential_number_counters (
      prefix text NOT NULL,
      year int NOT NULL,
      next_seq int NOT NULL DEFAULT 1,
      PRIMARY KEY (prefix, year)
    )
  `);
  ensured = true;
}

// Atomically allocates the next sequence number for a given prefix+year
// (e.g. "STB-2026-0007") via INSERT ... ON CONFLICT DO UPDATE, which
// serializes concurrent callers at the row level — unlike counting existing
// rows and using count+1, which two concurrent generate calls can both read
// as the same count and both try to insert the same number, one of them
// failing on the unique constraint.
//
// The row stores the *next* value to hand out, one ahead of what's
// returned, so a single statement can both allocate and advance the counter
// atomically: on first use for a prefix+year the row is inserted at 2 and
// this call returns 1; on every call after, the row is incremented and this
// call returns the value it held just before the increment.
export async function nextSequentialNumber(prefix: string, digits: number, year = new Date().getFullYear()): Promise<string> {
  await ensureSequenceTable();
  const rows = await query<{ seq: number }>(
    `INSERT INTO sequential_number_counters (prefix, year, next_seq)
     VALUES ($1, $2, 2)
     ON CONFLICT (prefix, year) DO UPDATE SET next_seq = sequential_number_counters.next_seq + 1
     RETURNING next_seq - 1 AS seq`,
    [prefix, year]
  );
  const seq = rows[0].seq;
  return `${prefix}-${year}-${String(seq).padStart(digits, "0")}`;
}
