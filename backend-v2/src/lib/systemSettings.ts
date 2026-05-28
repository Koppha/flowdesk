import { query } from "./db.js";

export const SYSTEM_SETTING_KEYS = {
  mealValue: "meal_value"
} as const;

export async function getNumericSystemSetting(key: string, fallback = 0) {
  const row = (
    await query<{ value: string | null }>(
      `SELECT value FROM system_state WHERE key=$1`,
      [key]
    )
  )[0];
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : fallback;
}

export async function setNumericSystemSetting(key: string, value: number) {
  await query(
    `INSERT INTO system_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}
