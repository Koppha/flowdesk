import { query } from "../db.js";
import { formatDate, formatDateTime, formatMoney, formatRequestNumber } from "./pdfHelpers.js";
import { getNumericSystemSetting, SYSTEM_SETTING_KEYS } from "../systemSettings.js";
import type { ChainStep } from "../workflowEngine.js";

export const PDF_REQUEST_TYPES = [
  "ADVANCE_REQUEST",
  "CLEARANCE_CLAIM",
  "ACCOMMODATION_REQUEST",
  "OVERTIME_REQUEST",
  "OVERTIME_CLAIM",
  "STANDBY_CLAIM",
  "CUSTOM_REQUEST"
] as const;
export type PdfRequestType = (typeof PDF_REQUEST_TYPES)[number];

export interface ApprovalChainDisplayItem {
  title: string;
  approverName: string;
  decision?: string;
  decidedAt?: string;
}

export interface ResolvedPdfData {
  scalars: Record<string, string>;
  tables: Record<string, Record<string, string>[]>;
  approvalChain: ApprovalChainDisplayItem[];
  meta: { id: string; requestType: PdfRequestType; generatedAt: string };
}

export interface PdfFieldCatalogEntry {
  key: string;
  label: string;
  group: string;
}

const BUILTIN_CATALOG: Record<Exclude<PdfRequestType, "CUSTOM_REQUEST">, PdfFieldCatalogEntry[]> = {
  ADVANCE_REQUEST: [
    { key: "reference_code", label: "Reference Code", group: "Requester" },
    { key: "request_id", label: "Request ID", group: "Requester" },
    { key: "created_at", label: "Created", group: "Requester" },
    { key: "created_by_name", label: "Created By", group: "Requester" },
    { key: "request_type_label", label: "Request Type", group: "Requester" },
    { key: "requester_name", label: "Employee Name", group: "Requester" },
    { key: "requester_employee_no", label: "Employee No.", group: "Requester" },
    { key: "traveller_type", label: "Employment Type", group: "Requester" },
    { key: "department", label: "Division", group: "Requester" },
    { key: "status", label: "Status", group: "Requester" },
    { key: "type_label", label: "Type of Travel", group: "Trip" },
    { key: "destination", label: "Destination", group: "Trip" },
    { key: "departure_date", label: "Departure Date", group: "Trip" },
    { key: "return_date", label: "Return Date", group: "Trip" },
    { key: "travel_duration", label: "Travel Duration", group: "Trip" },
    { key: "accommodation_summary", label: "Accommodation", group: "Trip" },
    { key: "meals_summary", label: "Meals", group: "Trip" },
    { key: "purpose", label: "Purpose", group: "Trip" },
    { key: "project_number", label: "Project Number", group: "Trip" },
    { key: "extra_cost_amount", label: "Extra Cost Amount", group: "Trip" },
    { key: "extra_cost_description", label: "Justification", group: "Trip" },
    { key: "requested_total", label: "Requested Amount", group: "Payment" },
    { key: "approved_total", label: "Approved Amount", group: "Payment" },
    { key: "payment_status", label: "Payment Status", group: "Payment" },
    { key: "payment_method", label: "Payment Method", group: "Payment" },
    { key: "payment_account", label: "Payment Account", group: "Payment" },
    { key: "wallet_name", label: "Wallet Name", group: "Payment" },
    { key: "wallet_number", label: "Wallet Number", group: "Payment" },
    { key: "bank_name", label: "Bank Name", group: "Payment" },
    { key: "bank_account_number", label: "Account Holder", group: "Payment" },
    { key: "submitted_at", label: "Submitted At", group: "Dates" },
    { key: "approved_at", label: "Approved At", group: "Dates" },
    { key: "paid_at", label: "Paid At", group: "Dates" },
    { key: "paid_reference", label: "Paid Reference", group: "Dates" }
  ],
  CLEARANCE_CLAIM: [
    { key: "claim_id", label: "Claim ID", group: "Claimant" },
    { key: "submitted_at", label: "Submitted", group: "Claimant" },
    { key: "claimant_name", label: "Claimant Name", group: "Claimant" },
    { key: "department", label: "Division", group: "Claimant" },
    { key: "status", label: "Status", group: "Claimant" },
    { key: "month", label: "Month", group: "Trip" },
    { key: "duty_station", label: "Duty Station", group: "Trip" },
    { key: "project_number", label: "Project Number", group: "Trip" },
    { key: "vehicle_reg", label: "Vehicle Reg", group: "Vehicle" },
    { key: "vehicle_type", label: "Vehicle Type", group: "Vehicle" },
    { key: "engine_cc", label: "Engine CC", group: "Vehicle" },
    { key: "vehicle_rate", label: "Vehicle Rate", group: "Vehicle" },
    { key: "claim_total", label: "Claim Total", group: "Reconciliation" },
    { key: "advance_amount", label: "Advance Received", group: "Reconciliation" },
    { key: "balance_amount", label: "Balance (Over/Under)", group: "Reconciliation" },
    { key: "reason_for_overspend", label: "Reason For Overspend", group: "Reconciliation" },
    { key: "settled_method", label: "Settled Method", group: "Settlement" },
    { key: "settled_reference", label: "Settled Reference", group: "Settlement" },
    { key: "settled_at", label: "Settled At", group: "Settlement" },
    { key: "closed_at", label: "Closed At", group: "Settlement" }
  ],
  ACCOMMODATION_REQUEST: [
    { key: "request_id", label: "Request ID", group: "Requester" },
    { key: "created_at", label: "Created", group: "Requester" },
    { key: "requester_name", label: "Requester Name", group: "Requester" },
    { key: "department", label: "Division", group: "Requester" },
    { key: "status", label: "Status", group: "Requester" },
    { key: "location", label: "Location", group: "Accommodation" },
    { key: "provider", label: "Provider", group: "Accommodation" },
    { key: "check_in", label: "Check In", group: "Accommodation" },
    { key: "check_out", label: "Check Out", group: "Accommodation" },
    { key: "amount", label: "Amount", group: "Accommodation" },
    { key: "notes", label: "Notes", group: "Accommodation" },
    { key: "paid_reference", label: "Paid Reference", group: "Payment" },
    { key: "paid_at", label: "Paid At", group: "Payment" },
    { key: "rejection_comments", label: "Rejection Comments", group: "Payment" }
  ],
  OVERTIME_REQUEST: [
    { key: "request_no", label: "Request No.", group: "Employee" },
    { key: "employee_name", label: "Employee Name", group: "Employee" },
    { key: "employee_no", label: "Employee No", group: "Employee" },
    { key: "job_title", label: "Job Title", group: "Employee" },
    { key: "section_name", label: "Section", group: "Employee" },
    { key: "year", label: "Year", group: "Employee" },
    { key: "month", label: "Month", group: "Employee" },
    { key: "status", label: "Status", group: "Employee" },
    { key: "noc", label: "NOC", group: "Details" },
    { key: "car_reg", label: "Car Reg", group: "Details" },
    { key: "remarks", label: "Remarks", group: "Details" },
    { key: "submitted_at", label: "Submitted At", group: "Dates" }
  ],
  OVERTIME_CLAIM: [
    { key: "claim_no", label: "Claim No.", group: "Employee" },
    { key: "employee_name", label: "Employee Name", group: "Employee" },
    { key: "employee_no", label: "Employee No", group: "Employee" },
    { key: "job_title", label: "Job Title", group: "Employee" },
    { key: "section_name", label: "Section", group: "Employee" },
    { key: "year", label: "Year", group: "Employee" },
    { key: "month", label: "Month", group: "Employee" },
    { key: "status", label: "Status", group: "Employee" },
    { key: "source_request_no", label: "Source Request No.", group: "Employee" },
    { key: "total_overtime", label: "Total Overtime", group: "Totals" },
    { key: "converted_hours", label: "Converted to Number of Hours", group: "Totals" },
    { key: "equivalent_days", label: "Equivalent Days", group: "Totals" },
    { key: "compensation_preference", label: "Pay / Days", group: "Totals" },
    { key: "hourly_rate", label: "Hourly Rate", group: "Totals" },
    { key: "total_amount", label: "Total Amount", group: "Totals" },
    { key: "cost_centre", label: "Cost Centre", group: "Finance" },
    { key: "account_project", label: "Account / Project", group: "Finance" },
    { key: "payroll_period", label: "Payroll Period", group: "Finance" },
    { key: "finance_reference", label: "Finance Reference", group: "Finance" },
    { key: "finance_comments", label: "Finance Comments", group: "Finance" },
    { key: "submitted_at", label: "Submitted At", group: "Dates" },
    { key: "finance_processed_at", label: "Finance Processed At", group: "Dates" },
    { key: "paid_at", label: "Settled At", group: "Dates" }
  ],
  STANDBY_CLAIM: [
    { key: "claim_no", label: "Claim No.", group: "Employee" },
    { key: "employee_name", label: "Employee Name", group: "Employee" },
    { key: "employee_no", label: "Employee No", group: "Employee" },
    { key: "job_title", label: "Job Title", group: "Employee" },
    { key: "division_name", label: "Company", group: "Employee" },
    { key: "section_name", label: "Division", group: "Employee" },
    { key: "team_name", label: "Section", group: "Employee" },
    { key: "claim_month", label: "Claim Month", group: "Employee" },
    { key: "status", label: "Status", group: "Employee" },
    { key: "compensation_preference", label: "Compensation Preference", group: "Employee" },
    { key: "comments", label: "Comments", group: "Employee" },
    { key: "is_adjustment", label: "Adjustment Claim", group: "Employee" },
    { key: "original_claim_no", label: "Original Claim No.", group: "Employee" },
    { key: "total_standby_hours", label: "Total Standby Hours", group: "Totals" },
    { key: "compensable_hours", label: "Compensable Hours", group: "Totals" },
    { key: "equivalent_days", label: "Equivalent Days", group: "Totals" },
    { key: "hourly_rate", label: "Hourly Rate", group: "Totals" },
    { key: "calculated_amount", label: "Calculated Amount", group: "Totals" },
    { key: "cost_centre", label: "Cost Centre", group: "Finance" },
    { key: "account_project", label: "Account / Project", group: "Finance" },
    { key: "payroll_period", label: "Payroll Period", group: "Finance" },
    { key: "finance_reference", label: "Finance Reference", group: "Finance" },
    { key: "finance_comments", label: "Finance Comments", group: "Finance" },
    { key: "submitted_at", label: "Submitted At", group: "Dates" },
    { key: "finance_processed_at", label: "Finance Processed At", group: "Dates" },
    { key: "paid_at", label: "Paid At", group: "Dates" },
    { key: "closed_at", label: "Closed At", group: "Dates" }
  ]
};

export async function getFieldCatalogFor(requestType: PdfRequestType, customRequestTypeId?: string | null): Promise<PdfFieldCatalogEntry[]> {
  if (requestType !== "CUSTOM_REQUEST") return BUILTIN_CATALOG[requestType];

  const meta: PdfFieldCatalogEntry[] = [
    { key: "request_type_name", label: "Request Type", group: "Meta" },
    { key: "requester_name", label: "Requester Name", group: "Meta" },
    { key: "submitted_at", label: "Submitted", group: "Meta" },
    { key: "status", label: "Status", group: "Meta" }
  ];
  if (!customRequestTypeId) return meta;

  const fields = await query<{ field_key: string; field_label: string }>(
    `SELECT field_key, field_label FROM request_type_fields WHERE request_type_id = $1 AND is_active = true ORDER BY sort_order`,
    [customRequestTypeId]
  );
  return [...meta, ...fields.map((f) => ({ key: f.field_key, label: f.field_label, group: "Submitted Fields" }))];
}

// Parses the pipe-delimited encoding advances.routes.ts's toPaymentAccount()
// writes into advance_requests.payment_account for BANK disbursements:
// "BANK:<name>;ACCOUNT:<number>;BRANCH:<branch>". ECOCASH disbursements just
// store the raw wallet number in that same column.
function parseBankAccount(paymentAccount: string | null | undefined): { bankName: string; accountNumber: string } {
  const raw = String(paymentAccount || "");
  if (!raw.startsWith("BANK:")) return { bankName: "", accountNumber: "" };
  const bankMatch = raw.match(/BANK:([^;]*)/);
  const accountMatch = raw.match(/ACCOUNT:([^;]*)/);
  return { bankName: bankMatch?.[1]?.trim() || "", accountNumber: accountMatch?.[1]?.trim() || "" };
}

export async function resolveAdvancePdfData(id: string): Promise<ResolvedPdfData> {
  const rows = await query<any>(
    `SELECT ar.*, u.full_name AS requester_name, u.department AS department, u.employee_no AS requester_employee_no,
            u.employment_type AS requester_employment_type,
            creator.full_name AS created_by_name, tt.name AS travel_type_name, tt.currency AS currency,
            tt.rate_kind AS travel_rate_kind
       FROM advance_requests ar
       JOIN users u ON u.id = ar.requester_id
       JOIN users creator ON creator.id = ar.created_by_id
       LEFT JOIN travel_types tt ON tt.code = ar.type
      WHERE ar.id = $1`,
    [id]
  );
  const adv = rows[0];
  if (!adv) throw new Error("Advance not found");
  const currency = adv.currency || "LSL";

  const lines = await query<any>(
    `SELECT line_date, location, breakfast, lunch, dinner, line_total, meals_count FROM advance_lines WHERE advance_request_id=$1 ORDER BY line_date`,
    [id]
  );
  const accommodation = await query<{ check_in: string; check_out: string }>(
    `SELECT check_in, check_out FROM accommodation_requests WHERE advance_request_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [id]
  );

  const chain = Array.isArray(adv.approval_chain) ? (adv.approval_chain as ChainStep[]) : [];

  const employmentTypeRow = adv.requester_employment_type
    ? (await query<{ name: string }>(`SELECT name FROM employment_types WHERE code = $1`, [adv.requester_employment_type]))[0]
    : null;

  // Already chronological - the query above orders by line_date. A bare
  // .sort() here previously re-sorted these (pg returns `date` columns as JS
  // Date objects) by their default toString(), which starts with the
  // day-of-week name (e.g. "Mon Aug 03" vs "Sat Aug 01") - alphabetical by
  // weekday, not chronological - so departure/return could come out as any
  // scrambled order depending on which weekdays the trip's dates fell on.
  const dates = lines.map((l) => l.line_date).filter(Boolean);
  const dateFrom = dates[0];
  // DAILY-rate rows (CMA/international per diem) can each represent several
  // days on a single line_date now, so the trip's real length is the sum of
  // each row's day count, not the span between the first and last row's
  // dates - a single 5-day row would otherwise print as "1 day".
  const isDailyRateTrip = adv.travel_rate_kind === "DAILY";
  const totalDays = isDailyRateTrip
    ? lines.reduce((sum: number, l: any) => sum + Math.max(1, Number(l.meals_count) || 1), 0)
    : null;
  const dateTo = isDailyRateTrip && dateFrom && totalDays
    ? new Date(new Date(dateFrom).getTime() + (totalDays - 1) * 86400000).toISOString().slice(0, 10)
    : dates[dates.length - 1];
  const durationDays = isDailyRateTrip
    ? totalDays
    : (dateFrom && dateTo ? Math.max(1, Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86400000) + 1) : null);
  const locations = Array.from(new Set(lines.map((l) => l.location).filter(Boolean))) as string[];
  const breakfastCount = lines.filter((l) => Number(l.breakfast) > 0).length;
  const lunchCount = lines.filter((l) => Number(l.lunch) > 0).length;
  const dinnerCount = lines.filter((l) => Number(l.dinner) > 0).length;

  const stay = accommodation[0];
  const nights = stay?.check_in && stay?.check_out
    ? Math.max(0, Math.round((new Date(stay.check_out).getTime() - new Date(stay.check_in).getTime()) / 86400000))
    : null;

  const onBehalfOf = adv.created_by_id !== adv.requester_id;
  const isEcocash = adv.payment_method === "ECOCASH";
  const isBank = adv.payment_method === "BANK";
  const { bankName, accountNumber } = parseBankAccount(adv.payment_account);
  const requestId = formatRequestNumber("ADV", adv.id, adv.created_at);

  return {
    scalars: {
      reference_code: `ETL-FIN-${requestId}`,
      request_id: requestId,
      created_at: formatDateTime(adv.created_at),
      created_by_name: adv.created_by_name || "",
      request_type_label: onBehalfOf ? "On Behalf of" : "Self",
      requester_name: adv.requester_name || "",
      requester_employee_no: adv.requester_employee_no || "",
      traveller_type: employmentTypeRow?.name || adv.requester_employment_type || "",
      department: adv.department || "",
      status: adv.status || "",
      type_label: adv.travel_type_name || adv.type || "",
      destination: locations.join(", "),
      departure_date: formatDateTime(dateFrom),
      return_date: formatDateTime(dateTo),
      travel_duration: durationDays ? `${durationDays} day${durationDays === 1 ? "" : "s"}` : "",
      accommodation_summary: nights != null ? `${nights} night${nights === 1 ? "" : "s"}` : "",
      // DAILY-rate travel types (per diem, e.g. international travel) pay a
      // flat daily rate, not per-meal amounts, so there's no meal breakdown
      // to show — leave this blank and the renderer drops the row entirely.
      meals_summary: adv.travel_rate_kind === "DAILY" ? "" : `Breakfast x ${breakfastCount} | Lunch x ${lunchCount} | Dinner x ${dinnerCount}`,
      purpose: adv.purpose || "",
      project_number: adv.project_number || "",
      extra_cost_amount: Number(adv.extra_cost_amount || 0) > 0 ? formatMoney(adv.extra_cost_amount, currency) : "",
      extra_cost_description: adv.extra_cost_description || "",
      requested_total: formatMoney(adv.requested_total, currency),
      approved_total: formatMoney(adv.approved_total, currency),
      payment_status: adv.paid_at ? "Paid" : "",
      payment_method: adv.payment_method || "",
      payment_account: adv.payment_account || "",
      wallet_name: isEcocash ? adv.requester_name || "" : "",
      wallet_number: isEcocash ? adv.payment_account || "" : "",
      bank_name: isBank ? bankName : "",
      bank_account_number: isBank ? accountNumber : "",
      submitted_at: formatDateTime(adv.submitted_at),
      approved_at: formatDateTime(adv.approved_at),
      paid_at: formatDateTime(adv.paid_at),
      paid_reference: adv.paid_reference || ""
    },
    tables: {
      advance_lines: lines.map((l) => ({
        line_date: formatDate(l.line_date), location: l.location || "",
        breakfast: formatMoney(l.breakfast, currency), lunch: formatMoney(l.lunch, currency), dinner: formatMoney(l.dinner, currency),
        line_total: formatMoney(l.line_total, currency)
      }))
    },
    approvalChain: chain.map((s) => ({ title: s.position_name, approverName: s.approver_name || "", decision: s.approved ? "Approved" : "Pending" })),
    meta: { id, requestType: "ADVANCE_REQUEST", generatedAt: new Date().toISOString() }
  };
}

export async function resolveClaimPdfData(id: string): Promise<ResolvedPdfData> {
  const rows = await query<any>(
    `SELECT cc.*, u.full_name AS claimant_name, u.department AS department
       FROM clearance_claims cc
       JOIN users u ON u.id = cc.claimant_id
      WHERE cc.id = $1`,
    [id]
  );
  const claim = rows[0];
  if (!claim) throw new Error("Claim not found");
  // A claim sticks with the currency it was requested in via its linked advance.
  const currency = claim.currency || "LSL";

  const trips = await query<any>(
    `SELECT trip_date, from_place, to_place, km_travelled, breakfast, lunch, dinner, other_expenses, line_total
       FROM claim_trips WHERE clearance_claim_id=$1 ORDER BY trip_date`,
    [id]
  );
  const receipts = await query<any>(`SELECT category, amount, notes FROM receipts WHERE clearance_claim_id=$1 ORDER BY uploaded_at`, [id]);

  const chain = Array.isArray(claim.approval_chain) ? (claim.approval_chain as ChainStep[]) : [];

  return {
    scalars: {
      claim_id: formatRequestNumber("CL", claim.id, claim.created_at),
      submitted_at: formatDateTime(claim.submitted_at),
      claimant_name: claim.claimant_name || "",
      department: claim.department || "",
      status: claim.status || "",
      month: claim.month || "",
      duty_station: claim.duty_station || "",
      project_number: claim.project_number || "",
      vehicle_reg: claim.vehicle_reg || "",
      vehicle_type: claim.vehicle_type || "",
      engine_cc: claim.engine_cc || "",
      vehicle_rate: claim.vehicle_rate != null ? formatMoney(claim.vehicle_rate, currency) : "",
      claim_total: formatMoney(claim.claim_total, currency),
      advance_amount: formatMoney(claim.advance_amount, currency),
      balance_amount: formatMoney(claim.balance_amount, currency),
      reason_for_overspend: claim.reason_for_overspend || "",
      settled_method: claim.settled_method || "",
      settled_reference: claim.settled_reference || "",
      settled_at: formatDateTime(claim.settled_at),
      closed_at: formatDateTime(claim.closed_at)
    },
    tables: {
      claim_trips: trips.map((t) => ({
        trip_date: formatDate(t.trip_date), from_place: t.from_place || "", to_place: t.to_place || "",
        km_travelled: String(t.km_travelled ?? "0"), breakfast: formatMoney(t.breakfast, currency), lunch: formatMoney(t.lunch, currency),
        dinner: formatMoney(t.dinner, currency), other_expenses: formatMoney(t.other_expenses, currency), line_total: formatMoney(t.line_total, currency)
      })),
      receipts: receipts.map((r) => ({ category: r.category || "", amount: formatMoney(r.amount, currency), notes: r.notes || "" }))
    },
    approvalChain: chain.map((s) => ({ title: s.position_name, approverName: s.approver_name || "", decision: s.approved ? "Approved" : "Pending" })),
    meta: { id, requestType: "CLEARANCE_CLAIM", generatedAt: new Date().toISOString() }
  };
}

export async function resolveAccommodationPdfData(id: string): Promise<ResolvedPdfData> {
  const rows = await query<any>(
    `SELECT acc.*, u.full_name AS requester_name, u.department AS department
       FROM accommodation_requests acc
       JOIN users u ON u.id = acc.requester_id
      WHERE acc.id = $1`,
    [id]
  );
  const acc = rows[0];
  if (!acc) throw new Error("Accommodation request not found");

  return {
    scalars: {
      request_id: formatRequestNumber("ACC", acc.id, acc.created_at),
      created_at: formatDateTime(acc.created_at),
      requester_name: acc.requester_name || "",
      department: acc.department || "",
      status: acc.status || "",
      location: acc.location || "",
      provider: acc.provider || "",
      check_in: formatDate(acc.check_in),
      check_out: formatDate(acc.check_out),
      amount: formatMoney(acc.amount),
      notes: acc.notes || "",
      paid_reference: acc.paid_reference || "",
      paid_at: formatDateTime(acc.paid_at),
      rejection_comments: acc.rejection_comments || ""
    },
    tables: {},
    approvalChain: [],
    meta: { id, requestType: "ACCOMMODATION_REQUEST", generatedAt: new Date().toISOString() }
  };
}

export async function resolveOvertimeRequestPdfData(id: string): Promise<ResolvedPdfData> {
  const rows = await query<any>(
    `SELECT r.*, u.full_name AS employee_name, u.employee_no, u.title AS job_title, t.name AS section_name
       FROM overtime_requests r
       JOIN users u ON u.id = r.employee_id
       LEFT JOIN teams t ON t.id = u.team_id
      WHERE r.id = $1`,
    [id]
  );
  const req = rows[0];
  if (!req) throw new Error("Overtime request not found");
  const lines = Array.isArray(req.lines) ? req.lines : [];

  const steps = await query<any>(
    `SELECT s.title, s.status, s.decided_at, u.full_name AS approver_name, u.title AS approver_job_title
       FROM overtime_request_approval_steps s JOIN users u ON u.id = s.approver_user_id
      WHERE s.request_id=$1 AND s.route_version=$2 ORDER BY s.step_order`,
    [id, req.current_route_version]
  );

  return {
    scalars: {
      request_no: req.request_no || "",
      employee_name: req.employee_name || "", employee_no: req.employee_no || "", job_title: req.job_title || "",
      section_name: req.section_name || "", year: String(req.year ?? ""), month: String(req.month ?? ""),
      status: req.status || "", noc: req.noc || "", car_reg: req.car_reg || "", remarks: req.remarks || "",
      submitted_at: formatDateTime(req.submitted_at)
    },
    tables: {
      lines: lines.map((l: any) => ({
        date: l.date || "", day: l.day || "", estimated_start: l.estimated_start || "", estimated_end: l.estimated_end || "",
        actual_start: l.actual_start || "", actual_end: l.actual_end || "", reason: l.reason || ""
      }))
    },
    // The route step only ever records the action taken (Checked by /
    // Approved by / Ordered by) - the position printed alongside it (e.g.
    // "CHECKED BY Supervisor") is always the approver's own current job
    // title, pulled live rather than typed in when the route was built.
    approvalChain: steps.map((s) => ({
      title: [s.title, s.approver_job_title].filter(Boolean).join(" "),
      approverName: s.approver_name || "",
      decision: s.status,
      decidedAt: s.decided_at ? formatDateTime(s.decided_at) : undefined
    })),
    meta: { id, requestType: "OVERTIME_REQUEST", generatedAt: new Date().toISOString() }
  };
}

export async function resolveOvertimeClaimPdfData(id: string): Promise<ResolvedPdfData> {
  const rows = await query<any>(
    `SELECT c.*, u.full_name AS employee_name, u.employee_no, u.title AS job_title, t.name AS section_name,
            orq.request_no AS source_request_no
       FROM overtime_claims c
       JOIN users u ON u.id = c.employee_id
       LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN overtime_requests orq ON orq.id = c.overtime_request_id
      WHERE c.id = $1`,
    [id]
  );
  const claim = rows[0];
  if (!claim) throw new Error("Overtime claim not found");
  const lines = Array.isArray(claim.lines) ? claim.lines : [];

  const steps = await query<any>(
    `SELECT s.title, s.status, s.decided_at, u.full_name AS approver_name, u.title AS approver_job_title
       FROM overtime_claim_approval_steps s JOIN users u ON u.id = s.approver_user_id
      WHERE s.claim_id=$1 AND s.route_version=$2 ORDER BY s.step_order`,
    [id, claim.current_route_version]
  );

  const workingHoursPerDay = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.workingHoursPerDay, 8);

  return {
    scalars: {
      claim_no: claim.claim_no || "",
      employee_name: claim.employee_name || "", employee_no: claim.employee_no || "", job_title: claim.job_title || "",
      section_name: claim.section_name || "", year: String(claim.year ?? ""), month: String(claim.month ?? ""),
      status: claim.status || "", source_request_no: claim.source_request_no || "",
      total_overtime: String(claim.total_overtime ?? "0"),
      converted_hours: String(claim.converted_hours ?? "0"),
      equivalent_days: String(claim.equivalent_days ?? (workingHoursPerDay > 0 ? Math.round((Number(claim.converted_hours || 0) / workingHoursPerDay) * 1000) / 1000 : 0)),
      compensation_preference: claim.compensation_preference || "",
      hourly_rate: claim.hourly_rate != null ? formatMoney(claim.hourly_rate) : "",
      total_amount: claim.total_amount != null ? formatMoney(claim.total_amount) : "",
      cost_centre: claim.cost_centre || "",
      account_project: claim.account_project || "",
      payroll_period: claim.payroll_period || "",
      finance_reference: claim.finance_reference || "",
      finance_comments: claim.finance_comments || "",
      submitted_at: formatDateTime(claim.submitted_at),
      finance_processed_at: formatDateTime(claim.finance_processed_at),
      paid_at: formatDateTime(claim.paid_at)
    },
    tables: {
      lines: lines.map((l: any) => ({
        date: l.date || "", day: l.day || "", from_time: l.from_time || "", to_time: l.to_time || "", ordered_by: l.ordered_by || "",
        hours_125: String(l.hours_125 ?? "0"), hours_150: String(l.hours_150 ?? "0"), hours_200: String(l.hours_200 ?? "0"),
        converted_hours: String(l.converted_hours ?? "0"), account_number: l.account_number || "", account_name: l.account_name || ""
      }))
    },
    approvalChain: steps.map((s) => ({
      title: [s.title, s.approver_job_title].filter(Boolean).join(" "),
      approverName: s.approver_name || "",
      decision: s.status,
      decidedAt: s.decided_at ? formatDateTime(s.decided_at) : undefined
    })),
    meta: { id, requestType: "OVERTIME_CLAIM", generatedAt: new Date().toISOString() }
  };
}

export async function resolveStandbyClaimPdfData(id: string): Promise<ResolvedPdfData> {
  const rows = await query<any>(
    `SELECT sc.*, u.full_name AS employee_name, u.employee_no, u.title AS job_title,
            dv.name AS division_name, s.name AS section_name, t.name AS team_name,
            oc.claim_no AS original_claim_no
       FROM standby_claims sc
       JOIN users u ON u.id = sc.employee_id
       LEFT JOIN divisions dv ON dv.id = u.division_id
       LEFT JOIN sections s ON s.id = u.section_id
       LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN standby_claims oc ON oc.id = sc.original_claim_id
      WHERE sc.id = $1`,
    [id]
  );
  const claim = rows[0];
  if (!claim) throw new Error("Standby claim not found");

  const lines = await query<any>(`SELECT standby_date, start_time, end_time, hours FROM standby_claim_lines WHERE claim_id=$1 ORDER BY standby_date`, [id]);
  const steps = await query<any>(
    `SELECT sas.title, sas.status, sas.decided_at, u.full_name AS approver_name
       FROM standby_approval_steps sas JOIN users u ON u.id = sas.approver_user_id
      WHERE sas.claim_id=$1 AND sas.route_version=$2 ORDER BY sas.step_order`,
    [id, claim.current_route_version]
  );
  const workingHoursPerDay = await getNumericSystemSetting(SYSTEM_SETTING_KEYS.workingHoursPerDay, 8);
  const equivalentDays = workingHoursPerDay > 0 ? Math.round((Number(claim.compensable_hours || 0) / workingHoursPerDay) * 1000) / 1000 : 0;

  return {
    scalars: {
      claim_no: claim.claim_no || "",
      employee_name: claim.employee_name || "",
      employee_no: claim.employee_no || "",
      job_title: claim.job_title || "",
      division_name: claim.division_name || "",
      section_name: claim.section_name || "",
      team_name: claim.team_name || "",
      claim_month: formatDate(claim.claim_month),
      status: claim.status || "",
      compensation_preference: claim.compensation_preference || "",
      comments: claim.comments || "",
      is_adjustment: claim.is_adjustment ? "Yes" : "No",
      original_claim_no: claim.original_claim_no || "",
      total_standby_hours: String(claim.total_standby_hours ?? "0"),
      compensable_hours: String(claim.compensable_hours ?? "0"),
      equivalent_days: String(equivalentDays),
      hourly_rate: claim.hourly_rate != null ? formatMoney(claim.hourly_rate) : "",
      calculated_amount: claim.calculated_amount != null ? formatMoney(claim.calculated_amount) : "",
      cost_centre: claim.cost_centre || "",
      account_project: claim.account_project || "",
      payroll_period: claim.payroll_period || "",
      finance_reference: claim.finance_reference || "",
      finance_comments: claim.finance_comments || "",
      submitted_at: formatDateTime(claim.submitted_at),
      finance_processed_at: formatDateTime(claim.finance_processed_at),
      paid_at: formatDateTime(claim.paid_at),
      closed_at: formatDateTime(claim.closed_at)
    },
    tables: {
      lines: lines.map((l) => ({
        standby_date: formatDate(l.standby_date), start_time: l.start_time || "", end_time: l.end_time || "", hours: String(l.hours ?? "0")
      }))
    },
    approvalChain: steps.map((s) => ({ title: s.title, approverName: s.approver_name || "", decision: s.status, decidedAt: s.decided_at ? formatDateTime(s.decided_at) : undefined })),
    meta: { id, requestType: "STANDBY_CLAIM", generatedAt: new Date().toISOString() }
  };
}

export async function resolveCustomRequestPdfData(id: string): Promise<ResolvedPdfData> {
  const rows = await query<any>(
    `SELECT s.*, rt.name AS request_type_name, u.full_name AS requester_name
       FROM custom_request_submissions s
       JOIN custom_request_types rt ON rt.id = s.request_type_id
       JOIN users u ON u.id = s.requester_id
      WHERE s.id = $1`,
    [id]
  );
  const sub = rows[0];
  if (!sub) throw new Error("Request not found");

  const fields = await query<{ field_key: string; field_label: string; field_type: string }>(
    `SELECT field_key, field_label, field_type FROM request_type_fields WHERE request_type_id = $1 AND is_active = true ORDER BY sort_order`,
    [sub.request_type_id]
  );
  const data = sub.data || {};
  const scalars: Record<string, string> = {
    request_type_name: sub.request_type_name || "",
    requester_name: sub.requester_name || "",
    submitted_at: formatDateTime(sub.created_at),
    status: sub.status || ""
  };
  for (const f of fields) {
    const value = data[f.field_key];
    if (value == null) scalars[f.field_key] = "";
    else if (f.field_type === "user" && typeof value === "object") scalars[f.field_key] = value.name || value.full_name || "";
    else if (f.field_type === "user_multi" && Array.isArray(value)) scalars[f.field_key] = value.map((v: any) => v.name || v.full_name || "").join(", ");
    else if (typeof value === "boolean") scalars[f.field_key] = value ? "Yes" : "No";
    else if (typeof value === "object") scalars[f.field_key] = JSON.stringify(value);
    else scalars[f.field_key] = String(value);
  }

  const chain = Array.isArray(sub.approval_chain) ? sub.approval_chain : [];

  return {
    scalars,
    tables: {},
    approvalChain: chain.map((s: any) => ({ title: s.title || s.position_name || "", approverName: s.approver_name || "", decision: s.approved ? "Approved" : "Pending" })),
    meta: { id, requestType: "CUSTOM_REQUEST", generatedAt: new Date().toISOString() }
  };
}

export async function resolvePdfData(requestType: PdfRequestType, id: string): Promise<ResolvedPdfData> {
  switch (requestType) {
    case "ADVANCE_REQUEST": return resolveAdvancePdfData(id);
    case "CLEARANCE_CLAIM": return resolveClaimPdfData(id);
    case "ACCOMMODATION_REQUEST": return resolveAccommodationPdfData(id);
    case "OVERTIME_REQUEST": return resolveOvertimeRequestPdfData(id);
    case "OVERTIME_CLAIM": return resolveOvertimeClaimPdfData(id);
    case "STANDBY_CLAIM": return resolveStandbyClaimPdfData(id);
    case "CUSTOM_REQUEST": return resolveCustomRequestPdfData(id);
  }
}

// Picks an existing record of the given type (most recently created) so the
// designer's Preview button works with zero setup — no admin has to go find
// and paste in a real record id.
export async function pickSampleRecordId(requestType: PdfRequestType, customRequestTypeId?: string | null): Promise<string | null> {
  switch (requestType) {
    case "ADVANCE_REQUEST": {
      const rows = await query<{ id: string }>(`SELECT id FROM advance_requests ORDER BY created_at DESC LIMIT 1`);
      return rows[0]?.id ?? null;
    }
    case "CLEARANCE_CLAIM": {
      const rows = await query<{ id: string }>(`SELECT id FROM clearance_claims ORDER BY created_at DESC LIMIT 1`);
      return rows[0]?.id ?? null;
    }
    case "ACCOMMODATION_REQUEST": {
      const rows = await query<{ id: string }>(`SELECT id FROM accommodation_requests ORDER BY created_at DESC LIMIT 1`);
      return rows[0]?.id ?? null;
    }
    case "OVERTIME_REQUEST": {
      const rows = await query<{ id: string }>(`SELECT id FROM overtime_requests ORDER BY created_at DESC LIMIT 1`);
      return rows[0]?.id ?? null;
    }
    case "OVERTIME_CLAIM": {
      const rows = await query<{ id: string }>(`SELECT id FROM overtime_claims ORDER BY created_at DESC LIMIT 1`);
      return rows[0]?.id ?? null;
    }
    case "STANDBY_CLAIM": {
      const rows = await query<{ id: string }>(`SELECT id FROM standby_claims ORDER BY created_at DESC LIMIT 1`);
      return rows[0]?.id ?? null;
    }
    case "CUSTOM_REQUEST": {
      const rows = customRequestTypeId
        ? await query<{ id: string }>(`SELECT id FROM custom_request_submissions WHERE request_type_id = $1 ORDER BY created_at DESC LIMIT 1`, [customRequestTypeId])
        : await query<{ id: string }>(`SELECT id FROM custom_request_submissions ORDER BY created_at DESC LIMIT 1`);
      return rows[0]?.id ?? null;
    }
  }
}

// Fallback when no real record of this type exists yet: every catalog field
// gets a placeholder value so the admin can still see the layout take shape.
export function buildDummyPdfData(requestType: PdfRequestType, catalog: PdfFieldCatalogEntry[]): ResolvedPdfData {
  const scalars: Record<string, string> = {};
  for (const field of catalog) scalars[field.key] = `Sample ${field.label}`;
  return {
    scalars,
    tables: {},
    approvalChain: [
      { title: "Approver 1", approverName: "Jane Sample", decision: "Approved" },
      { title: "Approver 2", approverName: "John Sample", decision: "Pending" }
    ],
    meta: { id: "dummy", requestType, generatedAt: new Date().toISOString() }
  };
}
