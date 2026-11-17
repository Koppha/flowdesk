import Constants from "expo-constants";
import { clearToken, getToken } from "./secure-storage";

// The app is private (not reachable from a phone off the corporate
// network/VPN), so this goes through dt-externalproxy-1.etl.co.ls's
// general-purpose /flowdesk/uat/ block instead of hitting flowdeskuat.etl.co.ls
// directly - same pattern already used for email-action links (see
// deploy/nginx-email-action-proxy.conf.example). That block forwards
// everything straight through to this same UAT box's nginx vhost (which
// itself sends any non-asset path to the backend with no /api prefix - see
// /etc/nginx/conf.d/flowdesk.conf, NOT the /api/-prefixed pattern the PROD
// example config uses), so paths below are unchanged, only the host/prefix is.
// app.json's extra.apiUrl defaults to UAT, matching this project's standing
// rule of only ever deploying to UAT unless explicitly asked - a PROD build
// overrides this via an EAS build profile's environment config, not by
// editing this default.
const API = (Constants.expoConfig?.extra?.apiUrl as string) || "https://dt-externalproxy-1.etl.co.ls/flowdesk/uat";

function formatApiError(json: any, fallback: string) {
  const message = typeof json?.error === "string" ? json.error : fallback;
  const fieldErrors = json?.details?.fieldErrors;
  if (fieldErrors && typeof fieldErrors === "object") {
    const details = Object.entries(fieldErrors)
      .flatMap(([field, errors]) => (Array.isArray(errors) ? errors.map((e) => `${field}: ${e}`) : []))
      .join("; ");
    if (details) return `${message}: ${details}`;
  }
  return message;
}

// Mirrors frontend/src/api.ts's req() exactly - same base URL pattern,
// same bearer-token header, same error shape - so the mobile app talks to
// the identical backend-v2 endpoints the web app already uses, no new API
// surface (see the FlowDesk Mobile write-up's "How it fits" section).
async function req(path: string, options: RequestInit = {}) {
  const token = await getToken();
  const headers: any = { Accept: "application/json", ...(options.headers || {}) };
  headers["Content-Type"] = "application/json";
  // Lets the backend tell a mobile login apart from a web login for the
  // admin Analytics tab - see auth.routes.ts's trackMobileLoginIfNeeded().
  headers["X-Flowdesk-Client"] = "mobile";
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...options, headers });
  const json = await res.json().catch(() => ({}));

  if (res.status === 401) {
    await clearToken();
  }
  if (!res.ok) {
    const error = new Error(formatApiError(json, res.statusText)) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return json;
}

export type AdvanceInboxItem = {
  doc_type: "ADVANCE";
  id: string;
  status: string;
  requested_total: number;
  approved_total: number;
  purpose: string | null;
  requester_name: string;
  advance_type?: string;
  current_step_position_name?: string | null;
  current_step_actionable_by_me?: boolean;
};

export type ClaimInboxItem = {
  doc_type: "CLAIM";
  id: string;
  status: string;
  claim_total: number;
  advance_amount: number;
  balance_amount: number;
  claimant_name: string;
  current_step_position_name?: string | null;
  current_step_actionable_by_me?: boolean;
};

export type CustomRequestInboxItem = {
  doc_type: "CUSTOM_REQUEST";
  id: string;
  status: string;
  request_type_name: string;
  requester_name?: string;
  current_step_position_name?: string | null;
  current_step_actionable_by_me?: boolean;
};

export type InboxItem = AdvanceInboxItem | ClaimInboxItem | CustomRequestInboxItem;

export const api = {
  login: (email: string, password: string) =>
    req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }) as Promise<{ token: string }>,

  inbox: () => req("/inbox") as Promise<{ items: InboxItem[] }>,

  myAdvances: () => req("/advances?mine=true"),
  myClearances: () => req("/claims?mine=true"),
  advanceDetail: (id: string) => req(`/advances/${id}`),
  claimDetail: (id: string) => req(`/claims/${id}`),

  approveAdvance: (id: string, approved_total: number, comments?: string) =>
    req(`/advances/${id}/approve`, { method: "POST", body: JSON.stringify({ approved_total, comments }) }),
  rejectAdvance: (id: string, comments: string) =>
    req(`/advances/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),

  approveClaim: (id: string, comments?: string) =>
    req(`/claims/${id}/approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  rejectClaim: (id: string, comments: string) =>
    req(`/claims/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),

  registerPushToken: (expoPushToken: string) =>
    req("/auth/push-token", { method: "POST", body: JSON.stringify({ expoPushToken }) }),

  mobileConfig: () =>
    req("/admin/mobile-config") as Promise<{
      modules: Record<ModuleKey, boolean>;
      tabs: { key: "home" | "inbox" | "profile"; enabled: boolean }[];
    }>
};

export type ModuleKey = "advances" | "clearances" | "overtime" | "standby" | "customProcesses" | "signADocument";
