import pg from "pg";
import { env } from "../config/env.js";

const { Pool, types } = pg;

// node-postgres's default DATE parser (OID 1082) builds a JS Date at LOCAL
// midnight in the server process's own timezone, then every JSON response
// serializes that Date via toISOString() (UTC) - on this server (Africa/
// Maseru, +02:00) a stored date of 2026-08-23 round-trips as
// "2026-08-22T22:00:00.000Z", landing on the 22nd for any client that reads
// the date portion of that string (e.g. Inbox.tsx's normalizeDateInputValue
// slicing at "T"). A plain SQL date has no time or timezone component to
// begin with, so hand it back as the raw "YYYY-MM-DD" string pg already
// parsed it from - no Date object, no conversion, no drift.
types.setTypeParser(1082, (value) => value);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,                   // up from default 10 — handles concurrent requests
  idleTimeoutMillis: 30_000, // release idle connections after 30 s
  connectionTimeoutMillis: 3_000 // fail fast if pool is exhausted
});

export async function query<T = unknown>(text: string, params?: unknown[]) {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// For multi-statement read-modify-write sequences that need row-level
// locking (e.g. SELECT ... FOR UPDATE) so concurrent callers serialize
// instead of racing on a stale in-memory read.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
