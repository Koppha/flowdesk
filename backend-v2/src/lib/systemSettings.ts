import { query } from "./db.js";

export const SYSTEM_SETTING_KEYS = {
  mealValue: "meal_value",
  standbyCompensableRatePct: "standby_compensable_rate_pct",
  standbyDefaultHourlyRate: "standby_default_hourly_rate",
  overtimeRateWeekdayPct: "overtime_rate_weekday_pct",
  overtimeRateSaturdayPct: "overtime_rate_saturday_pct",
  overtimeRateSundayHolidayPct: "overtime_rate_sunday_holiday_pct",
  workingHoursPerDay: "working_hours_per_day",
  overtimeModuleEnabled: "overtime_module_enabled",
  standbyModuleEnabled: "standby_module_enabled",
  salaryAdvanceEnabled: "salary_advance_enabled",
  loanAdvanceEnabled: "loan_advance_enabled",
  salaryAdvanceMaxPaybackMonths: "salary_advance_max_payback_months",
  loanAdvanceMaxPaybackMonths: "loan_advance_max_payback_months",
  defaultItProvisioningAssigneeId: "default_it_provisioning_assignee_id"
} as const;

export async function getStringSystemSetting(key: string, fallback: string | null = null) {
  const row = (
    await query<{ value: string | null }>(
      `SELECT value FROM system_state WHERE key=$1`,
      [key]
    )
  )[0];
  return row?.value ?? fallback;
}

export async function setStringSystemSetting(key: string, value: string | null) {
  if (value === null) {
    await query(`DELETE FROM system_state WHERE key=$1`, [key]);
    return;
  }
  await query(
    `INSERT INTO system_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

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

// No row = enabled, so this defaults to a no-op for every existing
// environment until an admin explicitly flips a module off.
export async function getBooleanSystemSetting(key: string, fallback = true) {
  const row = (
    await query<{ value: string | null }>(
      `SELECT value FROM system_state WHERE key=$1`,
      [key]
    )
  )[0];
  if (row?.value === undefined || row?.value === null) return fallback;
  return row.value === "true";
}

export async function setBooleanSystemSetting(key: string, value: boolean) {
  await query(
    `INSERT INTO system_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}
