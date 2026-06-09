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
