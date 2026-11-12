// When a paid travel advance has to be cleared by, and when it counts as
// UNCLEARED. One definition, used by the Overdue flag, View Clearances, the
// Clearance Status report and the clearance reminders, so they all agree.
//
// Rule: an advance must be cleared within the clearance window (Settings >
// "clearance duration", 7 days) after the traveller RETURNS. Past that, with
// no clearance submitted (a draft doesn't count; a rejected one doesn't
// either), it is uncleared.
//   - Return date: the last day of the trip - the latest of the advance's
//     return date and its trip lines' dates (same as tripDetailsForAdvances).
//   - Paid after they were already back (late payment)? The window starts on
//     the paid date instead, so nobody is uncleared on the day they're paid.
//   - No trip dates at all: the window starts on the paid date.
// Dates are Lesotho dates (Africa/Maseru).

/** SQL date: the trip's last day (NULL if the advance has no trip dates). GREATEST skips NULLs. */
export function returnDateSql(ar = "ar") {
  return `GREATEST(${ar}.travel_return_date, (SELECT max(al.line_date) FROM advance_lines al WHERE al.advance_request_id = ${ar}.id))`;
}

/** SQL date: the last day to clear. `days` is the clearance window, e.g. ars.clearance_duration_days. */
export function clearanceDueSql(ar = "ar", days = "ars.clearance_duration_days") {
  const paidOn = `(${ar}.paid_at AT TIME ZONE 'Africa/Maseru')::date`;
  return `(GREATEST(COALESCE(${returnDateSql(ar)}, ${paidOn}), ${paidOn}) + (${days})::int)`;
}

/** SQL date: today in Lesotho. */
export const TODAY_SQL = `(now() AT TIME ZONE 'Africa/Maseru')::date`;

/** SQL boolean: no clearance submitted for the advance (drafts and rejected ones don't count). */
export function noClearanceSubmittedSql(ar = "ar") {
  return `NOT EXISTS (SELECT 1 FROM clearance_claims cc WHERE cc.linked_advance_id = ${ar}.id AND cc.status NOT IN ('REJECTED', 'DRAFT'))`;
}

/** SQL boolean: paid, past the deadline and nothing submitted - uncleared. */
export function isUnclearedSql(ar = "ar", days = "ars.clearance_duration_days") {
  return `(${ar}.status = 'PAID' AND ${ar}.paid_at IS NOT NULL
    AND ${TODAY_SQL} > ${clearanceDueSql(ar, days)}
    AND ${noClearanceSubmittedSql(ar)})`;
}
