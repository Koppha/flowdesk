// Public holidays observed in Lesotho.
// Fixed-date holidays plus Easter-based ones (Good Friday, Easter Monday),
// computed using the Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
// Note: if the government gazettes a one-off change (e.g. shifting a holiday
// that falls on a weekend), this list won't reflect that — treat it as a
// sensible default that can still be overridden on the claim line.

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function buildHolidays(year: number): Record<string, string> {
  const easter = easterSunday(year);
  const goodFriday = addDays(easter, -2);
  const easterMonday = addDays(easter, 1);
  return {
    [`${year}-01-01`]: "New Year's Day",
    [`${year}-03-11`]: "Moshoeshoe's Day",
    [fmt(goodFriday)]: "Good Friday",
    [fmt(easterMonday)]: "Easter Monday",
    [`${year}-05-01`]: "Workers' Day",
    [`${year}-05-25`]: "Africa Day",
    [`${year}-07-17`]: "King's Birthday",
    [`${year}-10-04`]: "Independence Day",
    [`${year}-12-25`]: "Christmas Day",
    [`${year}-12-26`]: "Boxing Day"
  };
}

const holidayCache = new Map<number, Record<string, string>>();

function holidaysForYear(year: number): Record<string, string> {
  let cached = holidayCache.get(year);
  if (!cached) {
    cached = buildHolidays(year);
    holidayCache.set(year, cached);
  }
  return cached;
}

// Returns the holiday name for a "YYYY-MM-DD" date, or null if it's not a public holiday.
export function lesothoHolidayName(dateStr: string): string | null {
  if (!dateStr || dateStr.length < 10) return null;
  const year = Number(dateStr.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return holidaysForYear(year)[dateStr.slice(0, 10)] || null;
}

export function isLesothoHoliday(dateStr: string): boolean {
  return lesothoHolidayName(dateStr) !== null;
}
