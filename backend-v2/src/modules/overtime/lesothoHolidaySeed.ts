// One-time seed data for the admin-managed public_holidays table (see
// ensureOvertimeSchema in overtime.routes.ts) — only used to populate the
// table on first boot when it's empty. From then on public_holidays is the
// live source of truth; this file is never read again at runtime for an
// existing install. Mirrors frontend/src/lesothoHolidays.ts's algorithm
// (fixed dates + Easter-based, Anonymous Gregorian / Meeus-Jones-Butcher).

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
  const month = Math.floor((h + l - 7 * m + 114) / 31);
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

function buildYear(year: number): { date: string; name: string }[] {
  const easter = easterSunday(year);
  return [
    { date: `${year}-01-01`, name: "New Year's Day" },
    { date: `${year}-03-11`, name: "Moshoeshoe's Day" },
    { date: fmt(addDays(easter, -2)), name: "Good Friday" },
    { date: fmt(addDays(easter, 1)), name: "Easter Monday" },
    { date: `${year}-05-01`, name: "Workers' Day" },
    { date: `${year}-05-25`, name: "Africa Day" },
    { date: `${year}-07-17`, name: "King's Birthday" },
    { date: `${year}-10-04`, name: "Independence Day" },
    { date: `${year}-12-25`, name: "Christmas Day" },
    { date: `${year}-12-26`, name: "Boxing Day" }
  ];
}

const currentYear = new Date().getFullYear();
export const LESOTHO_HOLIDAY_SEED: { date: string; name: string }[] = [
  ...buildYear(currentYear - 1),
  ...buildYear(currentYear),
  ...buildYear(currentYear + 1),
  ...buildYear(currentYear + 2)
];
