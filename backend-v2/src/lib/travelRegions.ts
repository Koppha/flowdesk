// Which destinations each regional travel type covers. A CMA advance is
// paid in maloti, a Rest of Africa one in US dollars, so a destination must
// match its type: CMA = the Common Monetary Area (rand union); Rest of
// Africa = every other African country. Mirrored in frontend/src/constants.ts.

export const CMA_COUNTRIES = ["South Africa", "Namibia", "Eswatini", "Lesotho"] as const;

export const REST_OF_AFRICA_COUNTRIES = [
  // Southern
  "Botswana", "Malawi", "Mozambique", "Zambia", "Zimbabwe",
  // East
  "Burundi", "Comoros", "Djibouti", "Eritrea", "Ethiopia", "Kenya", "Madagascar", "Mauritius", "Rwanda",
  "Seychelles", "Somalia", "South Sudan", "Tanzania", "Uganda",
  // Central
  "Angola", "Cameroon", "Central African Republic", "Chad", "Republic of the Congo", "DR Congo",
  "Equatorial Guinea", "Gabon", "São Tomé and Príncipe",
  // West
  "Benin", "Burkina Faso", "Cabo Verde", "Côte d'Ivoire", "Gambia", "Ghana", "Guinea", "Guinea-Bissau",
  "Liberia", "Mali", "Mauritania", "Niger", "Nigeria", "Senegal", "Sierra Leone", "Togo",
  // North
  "Algeria", "Egypt", "Libya", "Morocco", "Sudan", "Tunisia"
] as const;

// Other spellings in use (the airport list's older names, and what people
// have typed by hand) -> the name above.
const ALIASES: Record<string, string> = {
  "swaziland": "Eswatini",
  "s.a": "South Africa", "sa": "South Africa", "rsa": "South Africa", "s.a.": "South Africa", "republic of south africa": "South Africa",
  "cape verde": "Cabo Verde",
  "cote d'ivoire": "Côte d'Ivoire", "côte d’ivoire": "Côte d'Ivoire", "ivory coast": "Côte d'Ivoire",
  "congo (brazzaville)": "Republic of the Congo", "congo-brazzaville": "Republic of the Congo", "congo": "Republic of the Congo",
  "congo (kinshasa)": "DR Congo", "drc": "DR Congo", "democratic republic of the congo": "DR Congo", "congo-kinshasa": "DR Congo",
  "sao tome and principe": "São Tomé and Príncipe",
  "the gambia": "Gambia",
  "united republic of tanzania": "Tanzania"
};

const CANONICAL = new Map<string, string>(
  [...CMA_COUNTRIES, ...REST_OF_AFRICA_COUNTRIES].map((c) => [c.toLowerCase(), c])
);

export function canonicalCountry(name: string | null | undefined): string | null {
  const key = String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  return CANONICAL.get(key) ?? ALIASES[key] ?? String(name).trim();
}

export type TravelRegion = "CMA" | "REST_OF_AFRICA";

// By code, matched loosely - UAT and PROD have used different codes for the
// same type ("CMA" vs "COMMON_MONETARY_AREA_CMA").
export function travelRegionOf(typeCode: string | null | undefined): TravelRegion | null {
  const code = String(typeCode ?? "").toUpperCase();
  if (code.includes("AFRICA")) return "REST_OF_AFRICA";
  if (code.includes("CMA")) return "CMA";
  return null;
}

// null when the country is fine for this travel type (or the type isn't regional).
export function destinationProblem(typeCode: string | null | undefined, country: string | null | undefined): string | null {
  const region = travelRegionOf(typeCode);
  if (!region || !String(country ?? "").trim()) return null;
  const c = canonicalCountry(country)!;
  if (region === "CMA" && !(CMA_COUNTRIES as readonly string[]).includes(c)) {
    return (REST_OF_AFRICA_COUNTRIES as readonly string[]).includes(c)
      ? `${c} isn't in the Common Monetary Area — use "Rest of Africa Excluding CMA" for this trip`
      : `${c} isn't in the Common Monetary Area (South Africa, Namibia, Eswatini, Lesotho)`;
  }
  if (region === "REST_OF_AFRICA" && !(REST_OF_AFRICA_COUNTRIES as readonly string[]).includes(c)) {
    return (CMA_COUNTRIES as readonly string[]).includes(c)
      ? `${c} is in the Common Monetary Area — use "Common Monetary Area (CMA)" for this trip`
      : `${c} isn't an African country outside the CMA`;
  }
  return null;
}
