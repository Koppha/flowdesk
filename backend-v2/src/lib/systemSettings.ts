import { query } from "./db.js";

export const SYSTEM_SETTING_KEYS = {
  mealValue: "meal_value",
  // JSON-encoded { advances, clearances, overtime, standby, customProcesses,
  // signADocument } (all boolean) - which module tiles FlowDesk Mobile's
  // Home screen shows. See the "Mobile App Configuration" admin panel
  // (frontend/src/MobileAppConfig.tsx) and mobile/src/app/(tabs)/index.tsx.
  mobileAppModules: "mobile_app_modules",
  // JSON-encoded ordered array of { key: "home"|"inbox"|"profile", enabled }
  // - which tabs FlowDesk Mobile's bottom tab bar shows, and in what order.
  mobileAppTabs: "mobile_app_tabs",
  standbyCompensableRatePct: "standby_compensable_rate_pct",
  standbyDefaultHourlyRate: "standby_default_hourly_rate",
  standbyCalloutRateWeekdayPct: "standby_callout_rate_weekday_pct",
  standbyCalloutRateWeekendHolidayPct: "standby_callout_rate_weekend_holiday_pct",
  overtimeRateWeekdayPct: "overtime_rate_weekday_pct",
  overtimeRateSaturdayPct: "overtime_rate_saturday_pct",
  overtimeRateSundayHolidayPct: "overtime_rate_sunday_holiday_pct",
  workingHoursPerDay: "working_hours_per_day",
  overtimeModuleEnabled: "overtime_module_enabled",
  standbyModuleEnabled: "standby_module_enabled",
  overtimeClaimWindowBeforeDays: "overtime_claim_window_before_days",
  overtimeClaimWindowAfterDays: "overtime_claim_window_after_days",
  standbyClaimWindowBeforeDays: "standby_claim_window_before_days",
  standbyClaimWindowAfterDays: "standby_claim_window_after_days",
  vendorContractsModuleEnabled: "vendor_contracts_module_enabled",
  serviceContractsModuleEnabled: "service_contracts_module_enabled",
  signatureModuleEnabled: "signature_module_enabled",
  maintenanceModuleEnabled: "maintenance_module_enabled",
  // Push + email reminders to travellers to clear their advances (ai/clearance-reminders.ts). Off until an admin switches it on.
  clearanceRemindersEnabled: "clearance_reminders_enabled",
  salaryAdvanceEnabled: "salary_advance_enabled",
  loanAdvanceEnabled: "loan_advance_enabled",
  salaryAdvanceMaxPaybackMonths: "salary_advance_max_payback_months",
  loanAdvanceMaxPaybackMonths: "loan_advance_max_payback_months",
  // The day of the month a Salary Advance FOR that same calendar month
  // opens for applications (e.g. 5 - "you can apply for September after
  // the 5th of September"). Applying for a past or future month is never
  // restricted by this - only a request whose own Salary Month is the
  // current calendar month.
  salaryAdvanceApplicationOpenDay: "salary_advance_application_open_day",
  defaultItProvisioningAssigneeIds: "default_it_provisioning_assignee_ids",
  // Delegated-signature notation ("AI" = a.i./ad interim, "PP" = p.p./per
  // procurationem) shown when someone signs a document under another
  // person's authority rather than their own - see signatures.routes.ts.
  signatureDelegationNotation: "signature_delegation_notation",
  // When true, the signer can override the org default per signature;
  // when false, every delegated signature uses the admin's chosen notation
  // with no per-signature choice offered.
  signatureDelegationNotationOverridable: "signature_delegation_notation_overridable",
  // Signers must draw or upload a signature; a typed name is no longer
  // enough. Off until an admin switches it on (Sign a Document policy).
  signatureRequireImage: "signature_require_image",
  // Hours a step can sit with no action before the current approver gets a
  // reminder email (SLA reminder worker - see lib/slaReminders.ts). Purely
  // a nudge, never a reassignment.
  slaReminderThresholdHours: "sla_reminder_threshold_hours",
  slaRemindersEnabled: "sla_reminders_enabled",
  // How many days in the past a trip/departure date on a new advance
  // request is allowed to be - lets an employee file for a trip they
  // already took instead of only ones planned ahead, without opening the
  // door to arbitrarily old backdating. Configured from Travel Setup
  // (travel.routes.ts), not a code constant, so an admin can change it
  // without a deploy.
  advanceBackdatingGraceDays: "advance_backdating_grace_days",
  // Service Contracts expiry reminders - a global digest (not per-contract,
  // since the migrated contracts' key_account_manager field is often blank
  // or unreliable free text - see service-contracts.routes.ts's reminder
  // worker). Gated behind its own feature permission
  // (service_contracts_notifications), separate from general manage access.
  serviceContractsNotificationsEnabled: "service_contracts_notifications_enabled",
  // Comma-separated email addresses the digest goes to.
  serviceContractsNotificationRecipients: "service_contracts_notification_recipients",
  // Comma-separated whole numbers - how many days before expiry_date to
  // send a reminder (e.g. "90,30,7,1,0" - 0 means "expires today").
  serviceContractsNotificationDaysBefore: "service_contracts_notification_days_before"
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
