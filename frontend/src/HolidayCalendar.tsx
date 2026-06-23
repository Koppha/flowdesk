import { useState } from "react";
import { lesothoHolidayName } from "./lesothoHolidays";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export function HolidayCalendarModal({
  year, month, onYearChange, onMonthChange, onClose
}: {
  year: number; month: number;
  onYearChange: (y: number) => void;
  onMonthChange: (m: number) => void;
  onClose: () => void;
}) {
  const firstOfMonth = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeekday = firstOfMonth.getDay(); // 0 = Sunday

  const cells: { date: string; day: number; weekday: number }[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push({ date: "", day: 0, weekday: i });
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(month).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    cells.push({ date: `${year}-${mm}-${dd}`, day: d, weekday: (startWeekday + d - 1) % 7 });
  }

  const holidaysThisMonth = cells
    .filter((c) => c.date && lesothoHolidayName(c.date))
    .map((c) => ({ date: c.date, name: lesothoHolidayName(c.date) as string }));

  function shiftMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    onMonthChange(m);
    onYearChange(y);
  }

  function cellStyle(c: { date: string; day: number; weekday: number }): React.CSSProperties {
    if (!c.date) return { background: "transparent" };
    const holiday = lesothoHolidayName(c.date);
    if (holiday) return { background: "#fee2e2", color: "#991b1b", fontWeight: 700 };
    if (c.weekday === 0) return { background: "#fef2f2" }; // Sunday — 200%
    if (c.weekday === 6) return { background: "#fefce8" }; // Saturday — 150%
    return { background: "#f0fdf4" }; // weekday — 125%
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}>
      <div className="card" style={{ background: "var(--surface)", padding: 24, borderRadius: 10, width: 420, maxWidth: "90vw" }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <button onClick={() => shiftMonth(-1)} style={{ border: "1px solid var(--border)", background: "var(--surface-soft)", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>‹</button>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{MONTHS[month - 1]} {year}</div>
          <button onClick={() => shiftMonth(1)} style={{ border: "1px solid var(--border)", background: "var(--surface-soft)", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>›</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
          {DAY_NAMES.map((d) => (
            <div key={d} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>{d.slice(0, 3)}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 16 }}>
          {cells.map((c, i) => (
            <div key={i} style={{ ...cellStyle(c), borderRadius: 6, padding: "6px 0", textAlign: "center", fontSize: 12, minHeight: 28 }}
              title={c.date ? (lesothoHolidayName(c.date) || "") : ""}>
              {c.day || ""}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11, color: "#64748b", marginBottom: 16 }}>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#f0fdf4", border: "1px solid #d1fae5", borderRadius: 2, marginRight: 4, verticalAlign: "middle" }} />Weekday · 125%</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#fefce8", border: "1px solid #fde68a", borderRadius: 2, marginRight: 4, verticalAlign: "middle" }} />Saturday · 150%</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 2, marginRight: 4, verticalAlign: "middle" }} />Sunday / Holiday · 200%</span>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>Lesotho Public Holidays — {year}</div>
          {holidaysThisMonth.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>No public holidays this month.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
              {holidaysThisMonth.map((h) => (
                <li key={h.date}>{h.date} — {h.name}</li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ textAlign: "right" }}>
          <button onClick={onClose} style={{ padding: "7px 16px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Self-contained "View Calendar" button + modal — drop in anywhere with no state wiring needed.
export function HolidayCalendarButton({ style }: { style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);

  return (
    <>
      <button onClick={() => setOpen(true)}
        style={style ?? { padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>
        View Calendar
      </button>
      {open && (
        <HolidayCalendarModal
          year={year} month={month}
          onYearChange={setYear} onMonthChange={setMonth}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
