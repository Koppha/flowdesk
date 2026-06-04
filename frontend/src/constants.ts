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
  active?: boolean;
  locations?: TravelLocation[];
};

export const DEFAULT_TRAVEL_TYPES: TravelType[] = [
  {
    id: "local-default",
    code: "TRAVEL_SUBSISTENCE",
    name: "Local Travel Allowance",
    location_mode: "DISTRICT",
    rate_kind: "MEAL",
    rate_general_staff: 0,
    rate_exco: 0,
    rate_ceo: 0,
    active: true,
    locations: LESOTHO_DISTRICTS.map((district) => ({ district }))
  },
  {
    id: "cma-default",
    code: "CMA",
    name: "Business Travel Allowance (CMA)",
    location_mode: "COUNTRY_CITY",
    rate_kind: "DAILY",
    rate_general_staff: 600,
    rate_exco: 800,
    rate_ceo: 1000,
    active: true,
    locations: []
  }
];

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
