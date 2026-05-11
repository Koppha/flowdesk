import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type DirectoryUser = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  department: string | null;
  employment_type: string | null;
};

type AttendanceModuleProps = {
  profile: any;
  requestDirectory: DirectoryUser[];
  onBack: () => void;
};

const CODE_OPTIONS = ["", "R", "C", "S", "A", "O", "H", "E", "T", "X"];

function fmtLabel(user: DirectoryUser) {
  const base = user.full_name || user.email;
  return user.employee_no ? `${base} (${user.employee_no})` : base;
}

type DayInfo = {
  day: number;
  code: string;
  date: Date;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
};

function padNumber(value: number) {
  return String(value).padStart(2, "0");
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
}

function getEasterDate(year: number) {
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

function getLesothoHolidays(year: number) {
  const holidays = new Map<string, string>();
  const addHoliday = (month: number, day: number, name: string) => {
    holidays.set(`${year}-${padNumber(month)}-${padNumber(day)}`, name);
  };

  addHoliday(1, 1, "New Year's Day");
  addHoliday(3, 11, "Moshoeshoe's Day");
  addHoliday(5, 1, "Workers' Day");
  addHoliday(5, 25, "Africa Day");
  addHoliday(7, 17, "King's Birthday");
  addHoliday(10, 4, "Independence Day");
  addHoliday(12, 25, "Christmas Day");
  addHoliday(12, 26, "Day of Goodwill");

  const easter = getEasterDate(year);
  const addEasterOffset = (offset: number, name: string) => {
    const date = new Date(easter);
    date.setDate(date.getDate() + offset);
    holidays.set(dateKey(date), name);
  };

  addEasterOffset(-2, "Good Friday");
  addEasterOffset(1, "Easter Monday");
  addEasterOffset(39, "Ascension Day");

  return holidays;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getCellClassName(day: DayInfo) {
  if (day.isHoliday) return "attendance-cell--holiday";
  if (day.isWeekend) return "attendance-cell--weekend";
  return "";
}

export default function AttendanceModule(props: AttendanceModuleProps) {
  const [records, setRecords] = useState<any[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [division, setDivision] = useState("MNO");
  const [sectionName, setSectionName] = useState(props.profile?.department || "");
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [accountProjectNo, setAccountProjectNo] = useState("");
  const [checkedBy, setCheckedBy] = useState("");
  const [checkedDate, setCheckedDate] = useState("");
  const [approvedBy, setApprovedBy] = useState("");
  const [approvedDate, setApprovedDate] = useState("");
  const [status, setStatus] = useState<"DRAFT" | "SUBMITTED">("DRAFT");
  const [dayCodes, setDayCodes] = useState<Array<{ day: number; code: string }>>([]);

  const dayInfos = useMemo(() => {
    const daysInMonth = new Date(year, month, 0).getDate();
    const codeByDay = new Map(dayCodes.map((item) => [item.day, item.code || ""]));
    const holidays = getLesothoHolidays(year);

    return Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const date = new Date(year, month - 1, day);
      const key = dateKey(date);
      const holidayName = holidays.get(key);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      return {
        day,
        code: codeByDay.get(day) || "",
        date,
        isWeekend,
        isHoliday: Boolean(holidayName),
        holidayName
      };
    });
  }, [year, month, dayCodes]);

  const eligibleUsers = useMemo(
    () =>
      props.requestDirectory.filter((user) =>
        ["INTERN", "TEMPORARY"].includes(String(user.employment_type || "").toUpperCase())
      ),
    [props.requestDirectory]
  );

  useEffect(() => {
    if (!selectedEmployeeId && eligibleUsers[0]) setSelectedEmployeeId(eligibleUsers[0].id);
  }, [eligibleUsers, selectedEmployeeId]);

  useEffect(() => {
    const daysInMonth = new Date(year, month, 0).getDate();
    setDayCodes((current) =>
      Array.from({ length: daysInMonth }, (_, index) => ({
        day: index + 1,
        code: current.find((item) => item.day === index + 1)?.code || ""
      }))
    );
  }, [month, year]);

  async function refresh() {
    const rows = await api.attendance();
    setRecords(rows);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const totals = dayInfos.reduce(
    (acc, item) => {
      if (item.code === "R") acc.regular += 1;
      if (item.code === "H") acc.holiday += 1;
      if (item.code === "A") acc.annual += 1;
      if (item.code === "O") acc.official += 1;
      if (item.code === "S") acc.sick += 1;
      return acc;
    },
    { regular: 0, holiday: 0, annual: 0, official: 0, sick: 0 }
  );
  const weekendCount = dayInfos.filter((item) => item.isWeekend).length;
  const holidayDateCount = dayInfos.filter((item) => item.isHoliday).length;

  async function saveRecord(nextStatus: "DRAFT" | "SUBMITTED") {
    if (!selectedEmployeeId) {
      alert("Select an employee first.");
      return;
    }
    await api.saveAttendance({
      employee_id: selectedEmployeeId,
      division,
      section_name: sectionName,
      month,
      year,
      account_project_no: accountProjectNo,
      day_codes: dayCodes,
      checked_by: checkedBy,
      checked_date: checkedDate || undefined,
      approved_by: approvedBy,
      approved_date: approvedDate || undefined,
      status: nextStatus
    });
    setStatus(nextStatus);
    await refresh();
    alert(nextStatus === "SUBMITTED" ? "Attendance record submitted." : "Attendance record saved.");
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0 }}>Attendance Record</h2>
          <div style={{ opacity: 0.75 }}>Temporary staff and intern attendance register.</div>
        </div>
        <button className="button small-button" onClick={props.onBack}>Back</button>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div className="form-grid-3">
          <div className="form-field">
            <label>Employee</label>
            <select value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)}>
              <option value="">Select employee</option>
              {eligibleUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {fmtLabel(user)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label>Division</label>
            <input value={division} onChange={(e) => setDivision(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Section</label>
            <input value={sectionName} onChange={(e) => setSectionName(e.target.value)} />
          </div>
        </div>

        <div className="form-grid-3">
          <div className="form-field">
            <label>Month</label>
            <input type="number" min={1} max={12} value={month} onChange={(e) => setMonth(Number(e.target.value) || 1)} />
          </div>
          <div className="form-field">
            <label>Year</label>
            <input type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear())} />
          </div>
          <div className="form-field">
            <label>Acc. No. / Project No.</label>
            <input value={accountProjectNo} onChange={(e) => setAccountProjectNo(e.target.value)} />
          </div>
        </div>

        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                {dayInfos.map((item) => (
                  <th key={item.day} className={getCellClassName(item)} title={item.isHoliday ? item.holidayName : WEEKDAY_LABELS[item.date.getDay()]}>
                    <div className="attendance-day-label">
                      <div>{item.day}</div>
                      <div>{WEEKDAY_LABELS[item.date.getDay()]}</div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {dayInfos.map((item, index) => (
                  <td key={item.day} className={getCellClassName(item)}>
                    <select
                      value={item.code}
                      onChange={(e) =>
                        setDayCodes((current) => current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, code: e.target.value } : entry)))
                      }
                    >
                      {CODE_OPTIONS.map((code) => (
                        <option key={code || "blank"} value={code}>
                          {code || "-"}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        <div className="attendance-legend">
          <div className="attendance-legend-item">
            <span className="attendance-legend-swatch attendance-legend-swatch--weekend" /> Weekend
          </div>
          <div className="attendance-legend-item">
            <span className="attendance-legend-swatch attendance-legend-swatch--holiday" /> Lesotho public holiday
          </div>
        </div>

        <div className="card-container" style={{ marginTop: 16 }}>
          <div className="card"><div className="title">Regular</div><div className="value">{totals.regular}</div></div>
          <div className="card"><div className="title">Holiday</div><div className="value">{totals.holiday}</div></div>
          <div className="card"><div className="title">Holiday dates</div><div className="value">{holidayDateCount}</div></div>
          <div className="card"><div className="title">Weekend days</div><div className="value">{weekendCount}</div></div>
          <div className="card"><div className="title">Annual</div><div className="value">{totals.annual}</div></div>
          <div className="card"><div className="title">Official</div><div className="value">{totals.official}</div></div>
          <div className="card"><div className="title">Sick</div><div className="value">{totals.sick}</div></div>
        </div>

        <div className="form-grid-2" style={{ marginTop: 16 }}>
          <div className="form-field">
            <label>Checked By</label>
            <input value={checkedBy} onChange={(e) => setCheckedBy(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Checked Date</label>
            <input type="date" value={checkedDate} onChange={(e) => setCheckedDate(e.target.value)} />
          </div>
        </div>

        <div className="form-grid-2">
          <div className="form-field">
            <label>Approved By</label>
            <input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Approved Date</label>
            <input type="date" value={approvedDate} onChange={(e) => setApprovedDate(e.target.value)} />
          </div>
        </div>

        <div className="footer-buttons">
          <button className="button" onClick={() => void saveRecord("DRAFT")}>Save Draft</button>
          <button className="button" onClick={() => void saveRecord("SUBMITTED")}>Submit</button>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>Recent Attendance Records</h3>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Month</th>
                <th>Year</th>
                <th>Regular</th>
                <th>Holiday</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: "center" }}>No attendance records yet.</td></tr>
              ) : (
                records.map((record) => (
                  <tr key={record.id}>
                    <td>{record.employee_name || "—"}</td>
                    <td>{record.month}</td>
                    <td>{record.year}</td>
                    <td>{record.regular_days}</td>
                    <td>{record.holidays}</td>
                    <td>{record.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
