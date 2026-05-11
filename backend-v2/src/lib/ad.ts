import { env } from "../config/env.js";

export type AdProfile = {
  email?: string;
  full_name?: string;
  employee_no?: string;
};

export type AdAuthResult = {
  authenticated: boolean;
  profile?: AdProfile;
  raw?: unknown;
};

function normalizeBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "ok", "success", "authenticated"].includes(v)) return true;
    if (["false", "0", "fail", "failed", "unauthorized", "invalid"].includes(v)) return false;
  }
  return null;
}

function parseAdResult(payload: unknown): AdAuthResult {
  const direct = normalizeBool(payload);
  if (direct !== null) return { authenticated: direct, raw: payload };

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const keys = ["authenticated", "isAuthenticated", "success", "ok", "status"];
    for (const key of keys) {
      const v = normalizeBool(obj[key]);
      if (v !== null) {
        const profile: AdProfile = {
          email: typeof obj.email === "string" ? obj.email : typeof obj.mail === "string" ? obj.mail : undefined,
          full_name:
            typeof obj.full_name === "string"
              ? obj.full_name
              : typeof obj.displayName === "string"
                ? obj.displayName
                : typeof obj.name === "string"
                  ? obj.name
                  : undefined,
          employee_no:
            typeof obj.employee_no === "string"
              ? obj.employee_no
              : typeof obj.employeeNo === "string"
                ? obj.employeeNo
                : typeof obj.employeeNumber === "string"
                  ? obj.employeeNumber
                  : undefined
        };
        return { authenticated: v, profile, raw: payload };
      }
    }
  }

  return { authenticated: false, raw: payload };
}

export async function authenticateAgainstAd(args: { email: string; password: string }): Promise<AdAuthResult> {
  const url = `${env.AD_API_BASE_URL.replace(/\/+$/, "")}/${env.AD_AUTH_PATH.replace(/^\/+/, "")}`;
  const body = JSON.stringify({
    userName: args.email,
    password: args.password
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal
    });
    const text = await res.text();
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })();
    return parseAdResult(parsed);
  } finally {
    clearTimeout(timer);
  }
}
