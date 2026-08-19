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
  // When set, the advance request form shows an extra-cost amount +
  // description alongside the day-by-day rows (e.g. a ticket/visa/baggage
  // fee not covered by the per-day meal/accommodation rate).
  has_extra_costs?: boolean;
  allowed_payment_methods?: ("ECOCASH" | "BANK")[];
  locations?: TravelLocation[];
};

export function travelTypeLabel(code: string | null | undefined, travelTypes: TravelType[]) {
  if (!code) return "—";
  if (code === "SALARY") return "Salary";
  if (code === "LOAN") return "Loan";
  return travelTypes.find((type) => type.code === code)?.name || code;
}

export function isTravelTypeCode(code: string | null | undefined, travelTypes: TravelType[]) {
  if (!code) return false;
  return travelTypes.some((type) => type.code === code && type.active !== false);
}

export function isFinanceDeptClient(department: string | null | undefined): boolean {
  return String(department || "").trim().toLowerCase() === "finance";
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

export function currentApprovalStepLabel(advance: any): string | null {
  const chain = Array.isArray(advance?.approval_chain) ? advance.approval_chain : [];
  if (!chain.length) return null;
  if (TERMINAL_ADVANCE_STATUSES.includes(String(advance?.status || "").toUpperCase())) return null;

  let idx = typeof advance?.workflow_step_order === "number" ? advance.workflow_step_order : 0;
  while (idx > 0 && chain[idx]?.parallel_with_previous) idx--;
  const step = chain[idx];
  if (!step) return null;

  const positionName: string | undefined = step.position_name;
  return (positionName && displayOrgGroupName(positionName)) || step.approver_title || null;
}
