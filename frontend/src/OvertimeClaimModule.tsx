import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { showNotice } from "./alerts";
import { lesothoHolidayName } from "./lesothoHolidays";
import { HolidayCalendarModal } from "./HolidayCalendar";

type OvertimeClaimModuleProps = {
  profile: any;
  requestDirectory: { id: string; full_name: string | null; email: string; employee_no: string | null; department: string | null; title?: string | null; role?: string | null }[];
  onBack: () => void;
};

type ClaimLine = {
  date: string;
  day: string;
  from_time: string;
  to_time: string;
  ordered_by: string;
  hours_125: number;
  hours_150: number;
  hours_200: number;
  converted_hours: number;
  account_or_project: string;
  activity_name: string;
  observed_holiday: boolean;
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function dayFromDate(d: string) {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "" : DAY_NAMES[dt.getDay()];
}

// 125% weekday, 150% Saturday, 200% Sunday, Lesotho public holiday,
// or a Monday that the approver has marked as the observed holiday
// (when a holiday falls on a weekend it's sometimes observed the following Monday)
function rateForDate(date: string, day: string, observedHoliday?: boolean): 125 | 150 | 200 {
  if (day === "Sunday" || lesothoHolidayName(date) || observedHoliday) return 200;
  if (day === "Saturday") return 150;
  return 125;
}

// Hours worked between from/to (handles overtime that crosses midnight)
function hoursBetween(from: string, to: string): number {
  if (!from || !to) return 0;
  const [sh, sm] = from.split(":").map(Number);
  const [eh, em] = to.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return 0;
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

function applyRate(line: ClaimLine): ClaimLine {
  const day = line.day || dayFromDate(line.date);
  const rate = rateForDate(line.date, day, day === "Monday" && line.observed_holiday);
  const hrs = hoursBetween(line.from_time, line.to_time);
  return {
    ...line,
    day,
    hours_125: rate === 125 ? hrs : 0,
    hours_150: rate === 150 ? hrs : 0,
    hours_200: rate === 200 ? hrs : 0,
    converted_hours: parseFloat((hrs * (rate / 100)).toFixed(2))
  };
}

function buildLinesFromRequest(req: any): ClaimLine[] {
  const lines: any[] = Array.isArray(req.lines) ? req.lines : [];
  return lines.map((l: any) => applyRate({
    date: l.date || "",
    day: l.day || dayFromDate(l.date || ""),
    from_time: l.actual_start || l.estimated_start || "",
    to_time: l.actual_end || l.estimated_end || "",
    ordered_by: "",
    hours_125: 0,
    hours_150: 0,
    hours_200: 0,
    converted_hours: 0,
    account_or_project: "",
    activity_name: l.reason || "",
    observed_holiday: false
  }));
}

const EMPTY_LINE: ClaimLine = {
  date: "", day: "", from_time: "", to_time: "", ordered_by: "",
  hours_125: 0, hours_150: 0, hours_200: 0, converted_hours: 0,
  account_or_project: "", activity_name: "", observed_holiday: false
};

const th: React.CSSProperties = { background: "var(--surface-soft)", padding: "7px 8px", textAlign: "left", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", border: "1px solid var(--border)", color: "var(--text)" };
const td: React.CSSProperties = { padding: "3px 5px", border: "1px solid var(--border)", verticalAlign: "middle", color: "var(--text)" };
const inp: React.CSSProperties = { width: "100%", border: "none", background: "transparent", color: "var(--text)", fontSize: 12, padding: "2px 3px", outline: "none", minWidth: 0 };
const numInp: React.CSSProperties = { ...inp, width: 52, textAlign: "right" };

export default function OvertimeClaimModule({ profile, requestDirectory, onBack }: OvertimeClaimModuleProps) {
  const [tab, setTab] = useState<"CLAIM" | "RECORDS">("CLAIM");
  const [approvedRequests, setApprovedRequests] = useState<any[]>([]);
  const [records, setRecords] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const canPickEmployee = ["ADMIN", "MANAGER"].includes(String(profile?.role || "").toUpperCase());
  const isHR = ["HR_MANAGER", "ADMIN"].includes(String(profile?.role || "").toUpperCase());
  const isFinance =
    String(profile?.role || "").toUpperCase() === "ADMIN" ||
    String(profile?.department || "").trim().toLowerCase() === "finance";

  // Header
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [employeeId, setEmployeeId] = useState(profile?.id || "");
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [division, setDivision] = useState(profile?.department || "");
  const [jobTitle, setJobTitle] = useState(profile?.title || "");

  // Lines
  const [lines, setLines] = useState<ClaimLine[]>([{ ...EMPTY_LINE }]);

  // Footer
  const [compensationType, setCompensationType] = useState<"PAY" | "DAYS">("PAY");

  // Holiday calendar modal
  const [showCalendar, setShowCalendar] = useState(false);
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth() + 1);

  const selectedEmployee = useMemo(
    () => requestDirectory.find((u) => u.id === employeeId),
    [employeeId, requestDirectory]
  );

  // Totals
  const totalOvertime = useMemo(
    () => lines.reduce((s, l) => s + Number(l.converted_hours || 0), 0),
    [lines]
  );

  async function loadData() {
    try {
      const [reqs, claims] = await Promise.all([api.overtimeRequests(), api.overtimeClaims()]);
      setApprovedRequests((Array.isArray(reqs) ? reqs : []).filter((r: any) => r.status === "APPROVED"));
      setRecords(Array.isArray(claims) ? claims : []);
    } catch { /* silent */ }
  }

  useEffect(() => { void loadData(); }, []);

  async function downloadOvertimeClaimPdf(id: string) {
    try {
      const blob = await api.overtimeClaimPdf(id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err: any) {
      void showNotice(err?.message || "Failed to generate PDF.");
    }
  }

  function handleRequestSelect(reqId: string) {
    setSelectedRequestId(reqId);
    if (!reqId) { setLines([{ ...EMPTY_LINE }]); return; }
    const req = approvedRequests.find((r) => r.id === reqId);
    if (!req) return;
    setEmployeeId(req.employee_id || employeeId);
    setYear(req.year);
    setMonth(req.month);
    setDivision(req.section_name || req.division || profile?.department || "");
    setJobTitle(req.job_title || profile?.title || "");
    const built = buildLinesFromRequest(req);
    setLines(built.length ? built : [{ ...EMPTY_LINE }]);
  }

  function updateLine(idx: number, field: keyof ClaimLine, value: string | number | boolean) {
    setLines((prev) => prev.map((l, i) => {
      if (i !== idx) return l;
      const updated = { ...l, [field]: value };
      if (field === "date") {
        updated.day = dayFromDate(String(value));
      }
      // Auto-classify hours into 125/150/200 based on day type once date, times, or the
      // approver's "observed holiday" override are known
      if (["date", "from_time", "to_time", "observed_holiday"].includes(field as string)) {
        return applyRate(updated);
      }
      return updated;
    }));
  }

  function addLine() { setLines((prev) => [...prev, { ...EMPTY_LINE }]); }
  function removeLine(idx: number) {
    setLines((prev) => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));
  }

  async function save(status: "DRAFT" | "SUBMITTED") {
    if (!employeeId) { void showNotice("Select an employee."); return; }
    setSubmitting(true);
    try {
      const empName = canPickEmployee ? (selectedEmployee?.full_name || "") : (profile?.full_name || "");
      const empNo   = canPickEmployee ? (selectedEmployee?.employee_no || "") : (profile?.employee_no || "");
      await api.saveOvertimeClaim({
        overtime_request_id: selectedRequestId || undefined,
        employee_id: employeeId,
        employee_name: empName,
        employee_no: empNo,
        job_title: jobTitle,
        division,
        year, month,
        lines,
        total_overtime: totalOvertime,
        compensated_hours: totalOvertime,
        pay_days: compensationType === "DAYS" ? totalOvertime : 0,
        status
      });
      await loadData();
      void showNotice(status === "SUBMITTED" ? "Claim submitted for manager authorisation." : "Draft saved.");
      if (status === "SUBMITTED") {
        setLines([{ ...EMPTY_LINE }]);
        setSelectedRequestId("");
        setTab("RECORDS");
      }
    } catch (e: any) {
      void showNotice("Error: " + (e as any).message);
    } finally {
      setSubmitting(false);
    }
  }

  const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 3 };
  const fieldStyle: React.CSSProperties = { width: "100%", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", fontSize: 13, background: "var(--surface)", color: "var(--text)", boxSizing: "border-box" };

  const STATUS_STEPS = [
    { key: "SUBMITTED",         label: "Submitted" },
    { key: "MANAGER_AUTHORISED",label: "Manager Authorised" },
    { key: "HR_NOTED",          label: "HR Noted" },
    { key: "FINANCE_VERIFIED",  label: "Finance Verified" },
    { key: "EARNINGS_RECORDED", label: "Earnings Recorded" },
    { key: "SUMMARY_TRANSFERRED", label: "Summary Transferred" },
  ];

  function statusColor(s: string) {
    if (s === "SUMMARY_TRANSFERRED") return { bg: "rgba(22, 163, 74, 0.14)", color: "var(--success)" };
    if (s === "DRAFT") return { bg: "rgba(100, 116, 139, 0.14)", color: "var(--muted)" };
    if (s === "SUBMITTED") return { bg: "rgba(217, 119, 6, 0.14)", color: "var(--warning)" };
    return { bg: "rgba(37, 99, 235, 0.14)", color: "var(--primary, #1d4ed8)" };
  }

  return (
    <div style={{ padding: "0 0 40px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Overtime Allowance Claim</h2>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>Claim overtime payment or compensation days for approved overtime worked.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setCalYear(year); setCalMonth(month); setShowCalendar(true); }}
            style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>
            View Calendar
          </button>
          <button onClick={() => setTab(tab === "CLAIM" ? "RECORDS" : "CLAIM")}
            style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>
            {tab === "CLAIM" ? "View Records" : "New Claim"}
          </button>
          <button onClick={onBack} style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Back</button>
        </div>
      </div>

      {showCalendar && (
        <HolidayCalendarModal
          year={calYear}
          month={calMonth}
          onYearChange={setCalYear}
          onMonthChange={setCalMonth}
          onClose={() => setShowCalendar(false)}
        />
      )}

      {tab === "RECORDS" ? (
        <div className="card" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-soft)", borderBottom: "2px solid var(--border)" }}>
                {["Employee","Division","Month","Year","Total Hrs","Status",""].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No claims yet.</td></tr>
              ) : records.map((r) => {
                const sc = statusColor(r.status);
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 14px", fontSize: 13 }}>{r.employee_name || "—"}</td>
                    <td style={{ padding: "10px 14px", fontSize: 13, color: "var(--muted)" }}>{r.division || "—"}</td>
                    <td style={{ padding: "10px 14px", fontSize: 13 }}>{MONTHS[(r.month ?? 1) - 1]}</td>
                    <td style={{ padding: "10px 14px", fontSize: 13 }}>{r.year}</td>
                    <td style={{ padding: "10px 14px", fontSize: 13 }}>{Number(r.total_overtime || 0).toFixed(1)}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 600, background: sc.bg, color: sc.color }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <button
                        onClick={() => void downloadOvertimeClaimPdf(r.id)}
                        style={{ fontSize: 12, padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer" }}
                      >
                        PDF
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card" style={{ padding: 28 }}>

          {/* Link to approved request */}
          <div style={{ marginBottom: 16, padding: "12px 14px", background: "var(--primary-soft)", borderRadius: 8, border: "1px solid rgba(116, 164, 255, 0.32)" }}>
            <label style={{ ...labelStyle, color: "var(--primary, #1d4ed8)" }}>Link to Approved Overtime Request (optional)</label>
            <select value={selectedRequestId} onChange={(e) => handleRequestSelect(e.target.value)} style={fieldStyle}>
              <option value="">— Select an approved request to pre-fill lines —</option>
              {approvedRequests.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.employee_name} · {MONTHS[(r.month ?? 1) - 1]} {r.year} · {r.section_name || r.division || ""}
                </option>
              ))}
            </select>
          </div>

          {/* Header fields */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div>
              <label style={labelStyle}>Names</label>
              {canPickEmployee ? (
                <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={fieldStyle}>
                  <option value="">Select employee</option>
                  {requestDirectory.map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name || u.email}{u.employee_no ? ` (${u.employee_no})` : ""}</option>
                  ))}
                </select>
              ) : (
                <input value={profile?.full_name || ""} readOnly style={{ ...fieldStyle, opacity: 0.85 }} />
              )}
            </div>
            <div>
              <label style={labelStyle}>E/N</label>
              <input value={canPickEmployee ? (selectedEmployee?.employee_no || "") : (profile?.employee_no || "")} readOnly style={{ ...fieldStyle, opacity: 0.7 }} />
            </div>
            <div>
              <label style={labelStyle}>Title</label>
              <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} style={fieldStyle} placeholder="e.g. Backend Developer" />
            </div>
            <div>
              <label style={labelStyle}>Division</label>
              <input value={division} onChange={(e) => setDivision(e.target.value)} style={fieldStyle} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={labelStyle}>Year</label>
                <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={fieldStyle} />
              </div>
              <div>
                <label style={labelStyle}>Month</label>
                <select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={fieldStyle}>
                  {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Lines table */}
          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>Day</th>
                  <th style={{ ...th, textAlign: "center" }} colSpan={2}>Overtime</th>
                  <th style={th}>Ordered By</th>
                  <th style={{ ...th, textAlign: "center" }}>125%</th>
                  <th style={{ ...th, textAlign: "center" }}>150%</th>
                  <th style={{ ...th, textAlign: "center" }}>200%</th>
                  <th style={{ ...th, textAlign: "center" }}>Converted Hrs</th>
                  <th style={th}>Account No.</th>
                  <th style={th}>Project/Activity</th>
                  <th style={{ ...th, width: 28 }}></th>
                </tr>
                <tr style={{ background: "var(--surface-soft)" }}>
                  <th style={th}></th><th style={th}></th>
                  <th style={{ ...th, fontSize: 10, color: "var(--muted)" }}>From</th>
                  <th style={{ ...th, fontSize: 10, color: "var(--muted)" }}>To</th>
                  <th style={th}></th><th style={th}></th><th style={th}></th><th style={th}></th><th style={th}></th><th style={th}></th><th style={th}></th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  const day = line.day || dayFromDate(line.date);
                  const holiday = lesothoHolidayName(line.date);
                  const rate = rateForDate(line.date, day, day === "Monday" && line.observed_holiday);
                  return (
                  <tr key={idx} style={{ background: idx % 2 === 0 ? "var(--surface)" : "var(--surface-soft)" }}>
                    <td style={{ ...td, minWidth: 120 }}>
                      <input type="date" value={line.date} onChange={(e) => updateLine(idx, "date", e.target.value)} style={inp} />
                    </td>
                    <td style={{ ...td, minWidth: 80, color: "var(--muted)", fontSize: 11 }}>
                      {day || <span style={{ opacity: 0.35 }}>auto</span>}
                      {holiday && <div style={{ fontSize: 10, color: "var(--danger)", fontWeight: 700 }}>{holiday}</div>}
                      {!holiday && day === "Monday" && (
                        <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--warning)", fontWeight: 600, marginTop: 2, cursor: "pointer" }}
                          title="Tick if a weekend public holiday is being observed on this Monday (pays at 200%)">
                          <input type="checkbox" checked={line.observed_holiday}
                            onChange={(e) => updateLine(idx, "observed_holiday", e.target.checked)}
                            style={{ width: 11, height: 11, margin: 0 }} />
                          Observed holiday
                        </label>
                      )}
                    </td>
                    <td style={{ ...td, minWidth: 65 }}>
                      <input type="time" value={line.from_time} onChange={(e) => updateLine(idx, "from_time", e.target.value)} style={{ ...inp, width: 65 }} />
                    </td>
                    <td style={{ ...td, minWidth: 65 }}>
                      <input type="time" value={line.to_time} onChange={(e) => updateLine(idx, "to_time", e.target.value)} style={{ ...inp, width: 65 }} />
                    </td>
                    <td style={{ ...td, minWidth: 110 }}>
                      <input value={line.ordered_by} onChange={(e) => updateLine(idx, "ordered_by", e.target.value)} style={inp} placeholder="Ordered by…" />
                    </td>
                    <td style={{ ...td, background: rate === 125 ? "rgba(22, 163, 74, 0.12)" : "transparent" }}>
                      <input type="number" min={0} step={0.5} value={line.hours_125 || ""} onChange={(e) => updateLine(idx, "hours_125", Number(e.target.value))} style={numInp} />
                    </td>
                    <td style={{ ...td, background: rate === 150 ? "rgba(217, 119, 6, 0.12)" : "transparent" }}>
                      <input type="number" min={0} step={0.5} value={line.hours_150 || ""} onChange={(e) => updateLine(idx, "hours_150", Number(e.target.value))} style={numInp} />
                    </td>
                    <td style={{ ...td, background: rate === 200 ? "rgba(220, 38, 38, 0.12)" : "transparent" }}>
                      <input type="number" min={0} step={0.5} value={line.hours_200 || ""} onChange={(e) => updateLine(idx, "hours_200", Number(e.target.value))} style={numInp} />
                    </td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 600, fontSize: 12, color: "var(--primary, #1d4ed8)" }}>
                      {Number(line.converted_hours || 0).toFixed(2)}
                    </td>
                    <td style={{ ...td, minWidth: 80 }}>
                      <input value={line.account_or_project} onChange={(e) => updateLine(idx, "account_or_project", e.target.value)} style={inp} placeholder="ACC-001" />
                    </td>
                    <td style={{ ...td, minWidth: 160 }}>
                      <input value={line.activity_name} onChange={(e) => updateLine(idx, "activity_name", e.target.value)} style={inp} placeholder="Activity / reason…" />
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <button onClick={() => removeLine(idx)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", fontSize: 15, padding: "1px 3px" }}>×</button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: "var(--surface-soft)" }}>
                  <td colSpan={8} style={{ ...td, textAlign: "right", fontWeight: 700, fontSize: 12, paddingRight: 8 }}>Total Overtime:</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 700, color: "var(--primary, #1d4ed8)" }}>{totalOvertime.toFixed(2)}</td>
                  <td colSpan={3} style={td}></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <button onClick={addLine}
            style={{ marginBottom: 24, padding: "5px 12px", border: "1px dashed var(--border-strong, var(--border))", borderRadius: 6, background: "transparent", cursor: "pointer", fontSize: 12, color: "var(--muted)" }}>
            + Add Row
          </button>

          {/* Compensation type + actions */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 18, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 8 }}>Number of Hours to be Compensated by:</div>
              <div style={{ display: "flex", gap: 16 }}>
                {(["PAY", "DAYS"] as const).map((opt) => (
                  <label key={opt} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: compensationType === opt ? 700 : 400 }}>
                    <input type="radio" name="compType" value={opt} checked={compensationType === opt}
                      onChange={() => setCompensationType(opt)}
                      style={{ width: 14, height: 14, flexShrink: 0, margin: 0 }} />
                    {opt === "PAY" ? "Pay" : "Days off"}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => void save("DRAFT")} disabled={submitting}
                style={{ padding: "9px 20px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", cursor: submitting ? "not-allowed" : "pointer", fontSize: 13 }}>
                Save Draft
              </button>
              <button onClick={() => void save("SUBMITTED")} disabled={submitting}
                style={{ padding: "9px 22px", border: "none", borderRadius: 6, background: submitting ? "rgba(147, 197, 253, 0.72)" : "var(--primary, #1d4ed8)", color: "#fff", cursor: submitting ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}>
                {submitting ? "Submitting…" : "Submit Claim"}
              </button>
            </div>
          </div>

          {/* HR / Finance read-only panel (only visible to HR/Finance) */}
          {(isHR || isFinance) && (
            <div style={{ marginTop: 24, borderTop: "2px solid var(--border)", paddingTop: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>HR & Finance Actions (back-office only)</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {isHR && <span style={{ fontSize: 12, color: "var(--muted)" }}>Use the Approval Inbox to take action on submitted claims at each workflow stage.</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
