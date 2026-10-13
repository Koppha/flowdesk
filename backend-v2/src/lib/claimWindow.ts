// Whether today falls within a claim period's submission window - replaces
// the old manual per-month Open/Close panel (overtime_claim_periods /
// standby_claim_periods) with a recurring rule an admin configures once:
// "opens N days before month-end, stays open M days into the next month."
// Both N and M can be 0 - e.g. N=2,M=0 is "last 2 days of the month";
// N=0,M=5 is "first 5 days of the following month" (the common payroll
// cutoff); N=2,M=3 is "last 2 days + first 3 days," a window straddling
// the month boundary. JS Date's day-overflow rollover (day 0 of a month
// = the last day of the previous month, day N+1 past month-end rolls into
// the next month) does the calendar math correctly without special-casing
// month length or year-end.
export function isClaimPeriodOpen(year: number, month: number, beforeDays: number, afterDays: number, today: Date = new Date()): boolean {
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const windowStart = new Date(year, month - 1, lastDayOfMonth - beforeDays + 1);
  const windowEnd = new Date(year, month, afterDays);
  windowStart.setHours(0, 0, 0, 0);
  windowEnd.setHours(23, 59, 59, 999);
  const t = new Date(today);
  t.setHours(12, 0, 0, 0);
  return t >= windowStart && t <= windowEnd;
}
