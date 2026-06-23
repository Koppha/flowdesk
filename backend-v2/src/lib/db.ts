import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;
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
