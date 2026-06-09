import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type DirectoryUser = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  department: string | null;
  title?: string | null;       // API returns 'title' (job title)
  role?: string | null;
};

type OvertimeModuleProps = {
  profile: any;
  requestDirectory: DirectoryUser[];
  onBack: () => void;
};

type RequestLine = {
  date: string;
  day: string;
  estimated_start: string;
  estimated_end: string;
  actual_start: string;
  actual_end: string;
  reason: string;
  noc: string;
  car_reg: string;
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

const EMPTY_LINE: RequestLine = {
  date: "", day: "", estimated_start: "", estimated_end: "",
  actual_start: "", actual_end: "", reason: "", noc: "", car_reg: ""
};

function dayFromDate(dateStr: string) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? "" : DAY_NAMES[d.getDay()];
}

function employeeLabel(u: DirectoryUser) {
  const name = u.full_name || u.email;
  return u.employee_no ? `${name} (${u.employee_no})` : name;
}

const th: React.CSSProperties = {
  background: "#f1f5f9", padding: "8px 10px", textAlign: "left",
  fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
  border: "1px solid #e2e8f0"
};
const td: React.CSSProperties = {
  padding: "4px 6px", border: "1px solid #e2e8f0", verticalAlign: "middle"
};
const inp: React.CSSProperties = {
  width: "100%", border: "none", background: "transparent",
  fontSize: 13, padding: "3px 4px", outline: "none", minWidth: 0
};
const timeInp: React.CSSProperties = { ...inp, width: 72 };

export default function OvertimeModule({ profile, requestDirectory, onBack }: OvertimeModuleProps) {
  const [tab, setTab] = useState<"REQUEST" | "RECORDS">("REQUEST");
  const [records, setRecords] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Only ADMIN and MANAGER can pick a different employee
  const canPickEmployee = ["ADMIN", "MANAGER"].includes(String(profile?.role || "").toUpperCase());

  // Header fields — seed from profile
  const [employeeId, setEmployeeId] = useState(profile?.id || "");
  const [year, setYear]   = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [jobTitle, setJobTitle] = useState(profile?.title || "");
  const [section, setSection]   = useState(profile?.department || "");

  // Lines
  const [lines, setLines] = useState<RequestLine[]>([{ ...EMPTY_LINE }]);
  const [remarks, setRemarks] = useState("");

  const selectedEmployee = useMemo(
    () => requestDirectory.find((u) => u.id === employeeId),
    [employeeId, requestDirectory]
  );

  // Sync job title & section when selection changes (admin/manager picking someone)
  useEffect(() => {
    if (selectedEmployee) {
      setJobTitle(selectedEmployee.title || profile?.title || "");
      setSection(selectedEmployee.department || profile?.department || "");
    }
  }, [selectedEmployee]);

  async function loadRecords() {
    try {
      const rows = await api.overtimeRequests();
      setRecords(Array.isArray(rows) ? rows : []);
    } catch { /* silent */ }
  }

  useEffect(() => { void loadRecords(); }, []);

  function updateLine(idx: number, field: keyof RequestLine, value: string) {
    setLines((prev) => prev.map((l, i) => {
      if (i !== idx) return l;
      const updated = { ...l, [field]: value };
      if (field === "date") updated.day = dayFromDate(value);
      return updated;
    }));
  }

  function addLine() { setLines((prev) => [...prev, { ...EMPTY_LINE }]); }
  function removeLine(idx: number) {
    setLines((prev) => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));
  }

  async function save(status: "DRAFT" | "SUBMITTED") {
    if (!employeeId) { alert("Select an employee."); return; }
    setSubmitting(true);
    try {
      await api.saveOvertimeRequest({
        employee_id: employeeId,
        employee_name: canPickEmployee ? (selectedEmployee?.full_name || "") : (profile?.full_name || ""),
        employee_no: canPickEmployee ? (selectedEmployee?.employee_no || "") : (profile?.employee_no || ""),
        job_title: jobTitle,
        section_name: section,
        year, month, remarks, lines, status
      });
      await loadRecords();
      alert(status === "SUBMITTED" ? "Overtime request submitted for approval." : "Draft saved.");
      if (status === "SUBMITTED") {
        setLines([{ ...EMPTY_LINE }]);
        setRemarks("");
        setTab("RECORDS");
      }
    } catch (e: any) {
      alert("Error: " + (e as any).message);
    } finally {
      setSubmitting(false);
    }
  }

  const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 3 };
  const fieldStyle: React.CSSProperties = { width: "100%", border: "1px solid #cbd5e1", borderRadius: 6, padding: "7px 10px", fontSize: 13, background: "var(--surface-soft)", color: "var(--text)", boxSizing: "border-box" };

  return (
    <div style={{ padding: "0 0 40px" }}>
      {/* Page header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Overtime Request</h2>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>Submit overtime worked for supervisor and management approval.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setTab(tab === "REQUEST" ? "RECORDS" : "REQUEST")}
            style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>
            {tab === "REQUEST" ? "View Records" : "New Request"}
          </button>
          <button onClick={onBack} style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: "pointer", fontSize: 13 }}>Back</button>
        </div>
      </div>

      {tab === "RECORDS" ? (
        <div className="card" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-soft)", borderBottom: "2px solid var(--border)" }}>
                {["Employee","E/N","Section","Month","Year","Status"].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No overtime requests yet.</td></tr>
              ) : records.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 14px", fontSize: 13 }}>{r.employee_name || "—"}</td>
                  <td style={{ padding: "10px 14px", fontSize: 13, color: "var(--muted)" }}>{r.employee_no || "—"}</td>
                  <td style={{ padding: "10px 14px", fontSize: 13, color: "var(--muted)" }}>{r.section_name || "—"}</td>
                  <td style={{ padding: "10px 14px", fontSize: 13 }}>{MONTHS[(r.month ?? 1) - 1]}</td>
                  <td style={{ padding: "10px 14px", fontSize: 13 }}>{r.year}</td>
                  <td style={{ padding: "10px 14px" }}>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 600,
                      background: r.status === "SUBMITTED" ? "#dcfce7" : "#fef9c3",
                      color: r.status === "SUBMITTED" ? "#15803d" : "#a16207" }}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card" style={{ padding: 28 }}>

          {/* ── Header fields ──────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div>
              <label style={labelStyle}>Names</label>
              {canPickEmployee ? (
                <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={fieldStyle}>
                  <option value="">Select employee</option>
                  {requestDirectory.map((u) => (
                    <option key={u.id} value={u.id}>{employeeLabel(u)}</option>
                  ))}
                </select>
              ) : (
                <input value={profile?.full_name || ""} readOnly style={{ ...fieldStyle, opacity: 0.85 }} />
              )}
            </div>
            <div>
              <label style={labelStyle}>E/N</label>
              <input
                value={canPickEmployee
                  ? (selectedEmployee?.employee_no || "")
                  : (profile?.employee_no || "")}
                readOnly
                style={{ ...fieldStyle, opacity: 0.7 }}
              />
            </div>
            <div>
              <label style={labelStyle}>Job Title</label>
              <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} style={fieldStyle} placeholder="e.g. Intern" />
            </div>
            <div>
              <label style={labelStyle}>Section</label>
              <input value={section} onChange={(e) => setSection(e.target.value)} style={fieldStyle} placeholder="e.g. Digital Transformation" />
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

          {/* ── Lines table ────────────────────────────────── */}
          <div style={{ overflowX: "auto", marginBottom: 24 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>Day</th>
                  <th style={{ ...th, textAlign: "center" }} colSpan={2}>Estimated Hours</th>
                  <th style={{ ...th, textAlign: "center" }} colSpan={2}>Actual Hours</th>
                  <th style={th}>Reason for Overtime</th>
                  <th style={th}>NOC</th>
                  <th style={th}>Car Reg</th>
                  <th style={{ ...th, width: 32 }}></th>
                </tr>
                <tr style={{ background: "#f8fafc" }}>
                  <th style={th}></th>
                  <th style={th}></th>
                  <th style={{ ...th, fontSize: 11, color: "#94a3b8" }}>Start</th>
                  <th style={{ ...th, fontSize: 11, color: "#94a3b8" }}>End</th>
                  <th style={{ ...th, fontSize: 11, color: "#94a3b8" }}>Start</th>
                  <th style={{ ...th, fontSize: 11, color: "#94a3b8" }}>End</th>
                  <th style={th}></th>
                  <th style={th}></th>
                  <th style={th}></th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={idx} style={{ background: idx % 2 === 0 ? "#fff" : "#f8fafc" }}>
                    <td style={{ ...td, minWidth: 130 }}>
                      <input type="date" value={line.date} onChange={(e) => updateLine(idx, "date", e.target.value)} style={inp} />
                    </td>
                    <td style={{ ...td, minWidth: 90, color: "#64748b" }}>
                      {line.day || <span style={{ opacity: 0.35 }}>auto</span>}
                    </td>
                    <td style={{ ...td, minWidth: 75 }}>
                      <input type="time" value={line.estimated_start} onChange={(e) => updateLine(idx, "estimated_start", e.target.value)} style={timeInp} />
                    </td>
                    <td style={{ ...td, minWidth: 75 }}>
                      <input type="time" value={line.estimated_end} onChange={(e) => updateLine(idx, "estimated_end", e.target.value)} style={timeInp} />
                    </td>
                    <td style={{ ...td, minWidth: 75 }}>
                      <input type="time" value={line.actual_start} onChange={(e) => updateLine(idx, "actual_start", e.target.value)} style={timeInp} />
                    </td>
                    <td style={{ ...td, minWidth: 75 }}>
                      <input type="time" value={line.actual_end} onChange={(e) => updateLine(idx, "actual_end", e.target.value)} style={timeInp} />
                    </td>
                    <td style={{ ...td, minWidth: 220 }}>
                      <textarea value={line.reason} onChange={(e) => updateLine(idx, "reason", e.target.value)}
                        rows={2} style={{ ...inp, resize: "vertical", lineHeight: 1.4 }} placeholder="Reason for overtime…" />
                    </td>
                    <td style={{ ...td, minWidth: 80 }}>
                      <input value={line.noc} onChange={(e) => updateLine(idx, "noc", e.target.value)} style={inp} placeholder="NOC ref" />
                    </td>
                    <td style={{ ...td, minWidth: 90 }}>
                      <input value={line.car_reg} onChange={(e) => updateLine(idx, "car_reg", e.target.value)} style={inp} placeholder="ABC 123" />
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <button onClick={() => removeLine(idx)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", fontSize: 16, lineHeight: 1, padding: "2px 4px" }}
                        title="Remove row">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button onClick={addLine}
            style={{ marginBottom: 28, padding: "6px 14px", border: "1px dashed #94a3b8", borderRadius: 6, background: "transparent", cursor: "pointer", fontSize: 13, color: "#64748b" }}>
            + Add Row
          </button>

          {/* ── Remarks + action buttons ───────────────────── */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20, marginBottom: 24 }}>
            <label style={labelStyle}>Remarks</label>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3}
              style={{ ...fieldStyle, resize: "vertical", marginBottom: 0 }} placeholder="Any additional remarks…" />
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--muted)" }}>
              After submitting, this request will be routed to your supervisor for recommendation, then HOD, then CTO for final approval.
            </p>
          </div>

          {/* ── Action buttons ─────────────────────────────── */}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={() => void save("DRAFT")} disabled={submitting}
              style={{ padding: "9px 20px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", cursor: submitting ? "not-allowed" : "pointer", fontSize: 13 }}>
              Save Draft
            </button>
            <button onClick={() => void save("SUBMITTED")} disabled={submitting}
              style={{ padding: "9px 22px", border: "none", borderRadius: 6, background: submitting ? "#93c5fd" : "#1d4ed8", color: "#fff", cursor: submitting ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}>
              {submitting ? "Submitting…" : "Submit Request"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
