import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type DirectoryUser = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  department: string | null;
};

type OvertimeModuleProps = {
  profile: any;
  requestDirectory: DirectoryUser[];
  onBack: () => void;
};

function employeeLabel(user: DirectoryUser) {
  const base = user.full_name || user.email;
  return user.employee_no ? `${base} (${user.employee_no})` : base;
}

export default function OvertimeModule(props: OvertimeModuleProps) {
  const [tab, setTab] = useState<"REQUEST" | "CLAIM">("REQUEST");
  const [requests, setRequests] = useState<any[]>([]);
  const [claims, setClaims] = useState<any[]>([]);
  const [employeeId, setEmployeeId] = useState(props.profile?.id || "");
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [jobTitle, setJobTitle] = useState("");
  const [sectionName, setSectionName] = useState(props.profile?.department || "");
  const [carReg, setCarReg] = useState("");
  const [remarks, setRemarks] = useState("");
  const [requestLines, setRequestLines] = useState([{ date: "", day: "", estimated_hours: "", actual_hours: "", reason: "", car_reg: "" }]);
  const [claimRequestId, setClaimRequestId] = useState("");
  const [claimLines, setClaimLines] = useState([{ date: "", day: "", from_time: "", to_time: "", ordered_by: "", hours_125: 0, hours_150: 0, hours_200: 0, converted_hours: 0, account_or_project: "", activity_name: "" }]);
  const [hourlyRate, setHourlyRate] = useState("0");
  const [checkedBySupervisor, setCheckedBySupervisor] = useState("");
  const [approvedByManager, setApprovedByManager] = useState("");
  const [approvedByCto, setApprovedByCto] = useState("");
  const [authorisedBy, setAuthorisedBy] = useState("");
  const [notationHr, setNotationHr] = useState("");

  useEffect(() => {
    if (!employeeId && props.profile?.id) setEmployeeId(props.profile.id);
  }, [employeeId, props.profile]);

  async function refresh() {
    const [requestRows, claimRows] = await Promise.all([api.overtimeRequests(), api.overtimeClaims()]);
    setRequests(requestRows);
    setClaims(claimRows);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const selectedEmployee = useMemo(
    () => props.requestDirectory.find((user) => user.id === employeeId),
    [employeeId, props.requestDirectory]
  );

  const totalOvertime = claimLines.reduce((sum, line) => sum + Number(line.converted_hours || 0), 0);
  const totalAmount = Number((totalOvertime * Number(hourlyRate || 0)).toFixed(2));

  async function saveRequest(status: "DRAFT" | "SUBMITTED") {
    if (!employeeId) {
      alert("Select an employee first.");
      return;
    }
    await api.saveOvertimeRequest({
      employee_id: employeeId,
      employee_name: selectedEmployee?.full_name || "",
      employee_no: selectedEmployee?.employee_no || "",
      job_title: jobTitle,
      section_name: sectionName,
      year,
      month,
      car_reg: carReg,
      remarks,
      lines: requestLines,
      status
    });
    await refresh();
    alert(status === "SUBMITTED" ? "Overtime request submitted." : "Overtime request saved.");
  }

  async function saveClaim(status: "DRAFT" | "SUBMITTED") {
    if (!employeeId) {
      alert("Select an employee first.");
      return;
    }
    await api.saveOvertimeClaim({
      overtime_request_id: claimRequestId || undefined,
      employee_id: employeeId,
      employee_name: selectedEmployee?.full_name || "",
      employee_no: selectedEmployee?.employee_no || "",
      job_title: jobTitle,
      division: sectionName,
      year,
      month,
      lines: claimLines,
      total_overtime: totalOvertime,
      compensated_hours: totalOvertime,
      pay_days: totalOvertime,
      authorised_by: authorisedBy,
      checked_by_supervisor: checkedBySupervisor,
      approved_by_manager: approvedByManager,
      approved_by_cto: approvedByCto,
      notation_hr: notationHr,
      hourly_rate: Number(hourlyRate || 0),
      total_amount: totalAmount,
      status
    });
    await refresh();
    alert(status === "SUBMITTED" ? "Overtime allowance claim submitted." : "Overtime allowance claim saved.");
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0 }}>Overtime Module</h2>
          <div style={{ opacity: 0.75 }}>Create overtime requests and overtime allowance claims for staff.</div>
        </div>
        <button className="button small-button" onClick={props.onBack}>Back</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <button className="button" onClick={() => setTab("REQUEST")}>Overtime Request</button>
        <button className="button" onClick={() => setTab("CLAIM")}>Allowance Claim</button>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div className="form-grid-3">
          <div className="form-field">
            <label>Employee</label>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Select employee</option>
              {props.requestDirectory.map((user) => (
                <option key={user.id} value={user.id}>
                  {employeeLabel(user)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear())} />
          </div>
          <div className="form-field">
            <label>Month</label>
            <input type="number" min={1} max={12} value={month} onChange={(e) => setMonth(Number(e.target.value) || 1)} />
          </div>
        </div>

        <div className="form-grid-3">
          <div className="form-field">
            <label>Job Title</label>
            <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Section / Division</label>
            <input value={sectionName} onChange={(e) => setSectionName(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Car Reg</label>
            <input value={carReg} onChange={(e) => setCarReg(e.target.value)} />
          </div>
        </div>

        {tab === "REQUEST" ? (
          <>
            <div className="form-field">
              <label>Remarks</label>
              <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Estimated Hours</th>
                    <th>Actual Hours</th>
                    <th>Reason for Overtime</th>
                  </tr>
                </thead>
                <tbody>
                  {requestLines.map((line, index) => (
                    <tr key={index}>
                      <td><input type="date" value={line.date} onChange={(e) => setRequestLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, date: e.target.value } : item))} /></td>
                      <td><input value={line.day} onChange={(e) => setRequestLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, day: e.target.value } : item))} /></td>
                      <td><input value={line.estimated_hours} onChange={(e) => setRequestLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, estimated_hours: e.target.value } : item))} /></td>
                      <td><input value={line.actual_hours} onChange={(e) => setRequestLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, actual_hours: e.target.value } : item))} /></td>
                      <td><input value={line.reason} onChange={(e) => setRequestLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, reason: e.target.value } : item))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="footer-buttons">
              <button className="button" onClick={() => setRequestLines((current) => [...current, { date: "", day: "", estimated_hours: "", actual_hours: "", reason: "", car_reg: "" }])}>Add Row</button>
              <button className="button" onClick={() => void saveRequest("DRAFT")}>Save Draft</button>
              <button className="button" onClick={() => void saveRequest("SUBMITTED")}>Submit</button>
            </div>
          </>
        ) : (
          <>
            <div className="form-field">
              <label>Linked Overtime Request</label>
              <select value={claimRequestId} onChange={(e) => setClaimRequestId(e.target.value)}>
                <option value="">Select request</option>
                {requests.map((request) => (
                  <option key={request.id} value={request.id}>
                    {request.employee_name || request.employee_no || "Employee"} - {request.month}/{request.year}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Ordered By</th>
                    <th>125%</th>
                    <th>150%</th>
                    <th>200%</th>
                    <th>Converted Hours</th>
                    <th>Account / Project</th>
                    <th>Name</th>
                  </tr>
                </thead>
                <tbody>
                  {claimLines.map((line, index) => (
                    <tr key={index}>
                      <td><input type="date" value={line.date} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, date: e.target.value } : item))} /></td>
                      <td><input value={line.day} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, day: e.target.value } : item))} /></td>
                      <td><input value={line.from_time} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, from_time: e.target.value } : item))} /></td>
                      <td><input value={line.to_time} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, to_time: e.target.value } : item))} /></td>
                      <td><input value={line.ordered_by} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ordered_by: e.target.value } : item))} /></td>
                      <td><input type="number" value={line.hours_125} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, hours_125: Number(e.target.value) || 0 } : item))} /></td>
                      <td><input type="number" value={line.hours_150} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, hours_150: Number(e.target.value) || 0 } : item))} /></td>
                      <td><input type="number" value={line.hours_200} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, hours_200: Number(e.target.value) || 0 } : item))} /></td>
                      <td><input type="number" value={line.converted_hours} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, converted_hours: Number(e.target.value) || 0 } : item))} /></td>
                      <td><input value={line.account_or_project} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, account_or_project: e.target.value } : item))} /></td>
                      <td><input value={line.activity_name} onChange={(e) => setClaimLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, activity_name: e.target.value } : item))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-grid-3" style={{ marginTop: 16 }}>
              <div className="form-field">
                <label>Supervisor</label>
                <input value={checkedBySupervisor} onChange={(e) => setCheckedBySupervisor(e.target.value)} />
              </div>
              <div className="form-field">
                <label>Manager</label>
                <input value={approvedByManager} onChange={(e) => setApprovedByManager(e.target.value)} />
              </div>
              <div className="form-field">
                <label>CTO</label>
                <input value={approvedByCto} onChange={(e) => setApprovedByCto(e.target.value)} />
              </div>
            </div>
            <div className="form-grid-3">
              <div className="form-field">
                <label>Authorised By</label>
                <input value={authorisedBy} onChange={(e) => setAuthorisedBy(e.target.value)} />
              </div>
              <div className="form-field">
                <label>HR Notation</label>
                <input value={notationHr} onChange={(e) => setNotationHr(e.target.value)} />
              </div>
              <div className="form-field">
                <label>Hourly Rate</label>
                <input type="number" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} />
              </div>
            </div>
            <div className="card-container" style={{ marginTop: 16 }}>
              <div className="card"><div className="title">Converted Hours</div><div className="value">{totalOvertime}</div></div>
              <div className="card"><div className="title">Total Amount</div><div className="value">M{totalAmount.toFixed(2)}</div></div>
            </div>
            <div className="footer-buttons">
              <button className="button" onClick={() => setClaimLines((current) => [...current, { date: "", day: "", from_time: "", to_time: "", ordered_by: "", hours_125: 0, hours_150: 0, hours_200: 0, converted_hours: 0, account_or_project: "", activity_name: "" }])}>Add Row</button>
              <button className="button" onClick={() => void saveClaim("DRAFT")}>Save Draft</button>
              <button className="button" onClick={() => void saveClaim("SUBMITTED")}>Submit</button>
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ padding: 20, marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>Recent Overtime Records</h3>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Employee</th>
                <th>Month</th>
                <th>Year</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[...requests.map((item) => ({ ...item, record_type: "Request" })), ...claims.map((item) => ({ ...item, record_type: "Claim" }))].map((record) => (
                <tr key={`${record.record_type}-${record.id}`}>
                  <td>{record.record_type}</td>
                  <td>{record.employee_name || "—"}</td>
                  <td>{record.month}</td>
                  <td>{record.year}</td>
                  <td>{record.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
