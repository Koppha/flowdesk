export const LESOTHO_DISTRICTS = [
  "Butha-Buthe",
  "Leribe",
  "Berea",
  "Maseru",
  "Mafeteng",
  "Mohale's Hoek",
  "Quthing",
  "Qacha's Nek",
  "Mokhotlong",
  "Thaba-Tseka"
] as const;

export const SOUTH_AFRICA_PROVINCES = [
  "Eastern Cape",
  "Free State",
  "Gauteng",
  "KwaZulu-Natal",
  "Limpopo",
  "Mpumalanga",
  "Northern Cape",
  "North West",
  "Western Cape"
] as const;

// The Common Monetary Area - the real-world currency union underlying the
// "CMA" travel advance type.
export const CMA_COUNTRIES = [
  "South Africa",
  "Namibia",
  "Eswatini",
  "Lesotho"
] as const;

// Every other African country - the "Rest of Africa Excluding CMA" travel
// type. Mirrors backend-v2/src/lib/travelRegions.ts, which enforces it.
export const REST_OF_AFRICA_COUNTRIES = [
  "Algeria", "Angola", "Benin", "Botswana", "Burkina Faso", "Burundi", "Cabo Verde", "Cameroon", "Central African Republic",
  "Chad", "Comoros", "Côte d'Ivoire", "DR Congo", "Djibouti", "Egypt", "Equatorial Guinea", "Eritrea", "Ethiopia", "Gabon",
  "Gambia", "Ghana", "Guinea", "Guinea-Bissau", "Kenya", "Liberia", "Libya", "Madagascar", "Malawi", "Mali", "Mauritania",
  "Mauritius", "Morocco", "Mozambique", "Niger", "Nigeria", "Republic of the Congo", "Rwanda", "São Tomé and Príncipe",
  "Senegal", "Seychelles", "Sierra Leone", "Somalia", "South Sudan", "Sudan", "Tanzania", "Togo", "Tunisia", "Uganda",
  "Zambia", "Zimbabwe"
] as const;

// The airport list's older names -> the names above.
const COUNTRY_ALIASES: Record<string, string> = {
  "swaziland": "Eswatini", "cape verde": "Cabo Verde", "cote d'ivoire": "Côte d'Ivoire",
  "congo (brazzaville)": "Republic of the Congo", "congo (kinshasa)": "DR Congo", "sao tome and principe": "São Tomé and Príncipe"
};
export function canonicalCountry(name: string | null | undefined): string {
  const raw = String(name ?? "").trim();
  return COUNTRY_ALIASES[raw.toLowerCase()] ?? raw;
}

// The countries a regional travel type covers (null = any destination).
// Codes differ between UAT and PROD, so matched loosely.
export function travelTypeCountries(typeCode: string | null | undefined): readonly string[] | null {
  const code = String(typeCode ?? "").toUpperCase();
  if (code.includes("AFRICA")) return REST_OF_AFRICA_COUNTRIES;
  if (code.includes("CMA")) return CMA_COUNTRIES;
  return null;
}

export type TravelLocationMode = "DISTRICT" | "COUNTRY_CITY";
export type TravelRateKind = "MEAL" | "DAILY";

export const CURRENCIES = [
  { code: "LSL", symbol: "M",   name: "Lesotho Maloti" },
  { code: "ZAR", symbol: "R",   name: "South African Rand" },
  { code: "USD", symbol: "$",   name: "US Dollar" },
  { code: "EUR", symbol: "€",   name: "Euro" },
  { code: "GBP", symbol: "£",   name: "British Pound" },
  { code: "BWP", symbol: "P",   name: "Botswana Pula" },
  { code: "MZN", symbol: "MT",  name: "Mozambican Metical" },
  { code: "ZMW", symbol: "K",   name: "Zambian Kwacha" },
  { code: "NAD", symbol: "N$",  name: "Namibian Dollar" },
  { code: "MWK", symbol: "MK",  name: "Malawian Kwacha" },
] as const;

export type CurrencyCode = typeof CURRENCIES[number]["code"];

export function getCurrencySymbol(code?: string | null): string {
  return CURRENCIES.find(c => c.code === code)?.symbol ?? (code ?? "M");
}

// Lets an employee file a request for a trip they already took (requested
// late instead of in advance) - a trip/departure date can be up to this many
// days in the past. Admin-configurable from Travel Setup (api.travelSettings());
// this default only applies before that setting has loaded.
export const DEFAULT_BACKDATE_GRACE_DAYS = 14;
export function earliestAllowedTripDate(graceDays: number = DEFAULT_BACKDATE_GRACE_DAYS): string {
  const d = new Date();
  d.setDate(d.getDate() - graceDays);
  return d.toISOString().slice(0, 10);
}

export function formatMoney(value: number | string | null | undefined, currencyCode?: string | null): string {
  const symbol = getCurrencySymbol(currencyCode);
  return `${symbol} ${Number(value || 0).toLocaleString("en-LS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type TravelLocation = {
  id?: string;
  travel_type_id?: string;
  district?: string | null;
  country?: string | null;
  province?: string | null;
  city?: string | null;
  active?: boolean;
};

export type TravelType = {
  id: string;
  code: string;
  name: string;
  location_mode: TravelLocationMode;
  rate_kind: TravelRateKind;
  rate_general_staff: number;
  rate_exco: number;
  rate_ceo: number;
  currency?: string;
  active?: boolean;
  requires_accommodation?: boolean;
  allowed_payment_methods?: ("ECOCASH" | "BANK")[];
  allow_external_beneficiary?: boolean;
  locations?: TravelLocation[];
};

export function travelTypeLabel(code: string | null | undefined, travelTypes: TravelType[]) {
  if (!code) return "—";
  if (code === "SALARY") return "Salary";
  if (code === "LOAN") return "Loan";
  if (code === "OTHER") return "Apply for Other";
  return travelTypes.find((type) => type.code === code)?.name || code;
}

export function isTravelTypeCode(code: string | null | undefined, travelTypes: TravelType[]) {
  if (!code) return false;
  return travelTypes.some((type) => type.code === code && type.active !== false);
}

export function travelTypeCurrency(code: string | null | undefined, travelTypes: TravelType[]) {
  return travelTypes.find((type) => type.code === code)?.currency ?? "LSL";
}

// "Finance" is MNO's free-text department name for this role; SEFS's own
// finance team uses "Finance Operations" instead - both need to pass this
// check (Payments/Deductions/Refundable's mark-paid/deducted/refunded
// buttons), or SEFS staff can view these queues but never act on them.
const FINANCE_DEPT_NAMES = ["finance", "finance operations"];
export function isFinanceDeptClient(department: string | null | undefined): boolean {
  return FINANCE_DEPT_NAMES.includes(String(department || "").trim().toLowerCase());
}

const TERMINAL_ADVANCE_STATUSES = ["DRAFT", "PAID", "APPROVED", "REJECTED", "CANCELLED"];

// The step actually waiting on approval, per this request's own configured
// workflow (approval_chain) - independent of advance_requests.status, which
// is a fixed legacy bucket (SUBMITTED/COUNTERSIGNED/HR_OFFICER/...)
// that can't represent every position type a workflow might use (e.g. EXCO,
// CEO, or a custom position land in the same bucket as HOD), so it doesn't
// reliably reflect what's actually configured in the Workflow Builder.
// Returns null when there's no chain to derive from (draft/legacy/terminal),
// so callers can fall back to the status-based label.
// Steps assigned to a whole org-level group are stored with a
// position_name/approval_group_name prefix derived from the legacy table
// name (divisions/departments/sections/teams) so existing saved workflow
// steps keep matching, but the org hierarchy now calls those levels
// Company/Division/Department/Section respectively.
const ORG_GROUP_PREFIX_MAP: Record<string, string> = {
  "Division: ": "Company: ",
  "Department: ": "Division: ",
  "Section: ": "Department: ",
  "Team: ": "Section: ",
};
export function displayOrgGroupName(name: string): string {
  for (const [raw, display] of Object.entries(ORG_GROUP_PREFIX_MAP)) {
    if (name.startsWith(raw)) return display + name.slice(raw.length);
  }
  return name;
}

// A completed step's status word depends on what kind of action it actually
// was - "Approved" is right for a COUNTER_SIGN/APPROVE decision, but wrong
// for DEPT_CAPTURE (data entry, not a judgment call), DEPT_ACCOMODATION
// (a booking), or MARK_PAID (a payment) - each gets its own accurate word.
export function stepDoneStatusLabel(actionType: string | null | undefined): string {
  switch (actionType) {
    case "DEPT_CAPTURE": return "Captured";
    case "DEPT_ACCOMODATION": return "Booked";
    case "MARK_PAID": return "Paid";
    case "COUNTER_SIGN": return "Countersigned";
    default: return "Approved";
  }
}

// Steps that happen *after* approval is already decided - capturing travel
// form data, booking accommodation, recording payment - not another
// judgment call, so "pending approval"-flavored wording is wrong for them.
const POST_APPROVAL_ACTION_TYPES = new Set(["DEPT_ACCOMODATION", "DEPT_CAPTURE", "CAPTURE", "BOOK_ACC", "MARK_PAID"]);

// True once a workflow-driven advance has passed every real approval-type
// step (COUNTER_SIGN/APPROVE/HR_*/EXCO/...) and is only waiting on
// post-approval processing (Accommodation/Capture/Payment) - advance_requests.status
// often still reads a stale pre-approval bucket (e.g. "SUBMITTED") at this
// point for workflow-driven requests, since it isn't updated on every chain
// step transition, only at a few fixed milestones.
export function isAdvancePastApproval(advance: any): boolean {
  const chain = Array.isArray(advance?.approval_chain) ? advance.approval_chain : [];
  if (!chain.length) return false;
  const lastApprovalIdx = chain.reduce(
    (last: number, step: any, idx: number) => (!POST_APPROVAL_ACTION_TYPES.has(step.action_type) ? idx : last),
    -1
  );
  if (lastApprovalIdx === -1) return false;
  const stepOrder = typeof advance?.workflow_step_order === "number" ? advance.workflow_step_order : 0;
  return stepOrder > lastApprovalIdx;
}

export function currentApprovalStepLabel(advance: any): string | null {
  const chain = Array.isArray(advance?.approval_chain) ? advance.approval_chain : [];
  if (!chain.length) return null;
  if (TERMINAL_ADVANCE_STATUSES.includes(String(advance?.status || "").toUpperCase())) return null;
  if (isAdvancePastApproval(advance)) return null;

  let idx = typeof advance?.workflow_step_order === "number" ? advance.workflow_step_order : 0;
  while (idx > 0 && chain[idx]?.parallel_with_previous) idx--;
  const step = chain[idx];
  if (!step) return null;
  if (POST_APPROVAL_ACTION_TYPES.has(step.action_type)) return null;

  const positionName: string | undefined = step.position_name;
  return (positionName && displayOrgGroupName(positionName)) || step.approver_title || null;
}
