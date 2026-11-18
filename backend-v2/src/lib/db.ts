import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

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

// The PROD database server is shared with other systems and often has no
// connection slots left (Nov 2026: max_connections 100, ~70 used by other
// apps). Each FlowDesk node therefore keeps a few connections open for good
// (`min`) instead of handing every one back after 30 s idle and then having
// to win a slot again; extra connections opened for a busy moment still go
// back after 30 s, so FlowDesk never holds more than it did before.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,                   // up from default 10 — handles concurrent requests
  min: 5,                    // kept open for good (see above)
  idleTimeoutMillis: 30_000, // release connections above `min` after 30 s idle
  connectionTimeoutMillis: 3_000, // fail fast if pool is exhausted
  keepAlive: true            // notice a dropped long-lived connection instead of hanging on it
});

// A kept-open connection can be cut by the database side (restart, admin
// kill, network). pg reports that as an 'error' event on the pool, which
// would crash the server if nobody listens; the pool already drops that
// connection and opens a fresh one when needed.
pool.on("error", (err) => {
  logger.warn("Idle database connection lost", { error: err.message });
});

// "too many clients already" / "remaining connection slots are reserved"
// (SQLSTATE 53300) happens while connecting, before anything is sent, so
// waiting briefly and trying again is safe for writes too. Slots usually
// free up within a second.
const TOO_MANY_CONNECTIONS = "53300";
const CONNECT_RETRY_DELAYS_MS = [150, 400, 1000];

async function retryWhenDatabaseFull<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string })?.code !== TOO_MANY_CONNECTIONS || attempt >= CONNECT_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function query<T = unknown>(text: string, params?: unknown[]) {
  const res = await retryWhenDatabaseFull(() => pool.query(text, params));
  return res.rows as T[];
}

// For multi-statement read-modify-write sequences that need row-level
// locking (e.g. SELECT ... FOR UPDATE) so concurrent callers serialize
// instead of racing on a stale in-memory read.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await retryWhenDatabaseFull(() => pool.connect());
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
