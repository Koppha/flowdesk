import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;
export const pool = new Pool({ connectionString: env.DATABASE_URL });

export async function query<T = unknown>(text: string, params?: unknown[]) {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
