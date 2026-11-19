import { useEffect, useState } from "react";
import { req } from "../api";
import type { Approver, ApprovalStep } from "../components/ApprovalRoute";

// Standby - my published roster, the monthly standby claim and call-outs -
// with the same endpoints the portal's Standby.tsx uses
// (backend-v2/src/modules/standby/standby.routes.ts, mounted at /standby).
// Rosters, Finance, reports and settings stay on the portal.

export type Assignment = { id: string; standby_date: string; start_time: string; end_time: string; hours: string | number; schedule_type?: string };

export type MyStandby = {
  month: string;
  assignments: Assignment[];
  total_standby_hours: number;
  claim: { id: string; status: string } | null;
};

export type SbClaim = {
  id: string;
  claim_no: string;
  employee_id: string;
  created_by_id: string | null;
  employee_name: string | null;
  /** "YYYY-MM-DD", the first of the month. */
  claim_month: string;
  status: string;
  total_standby_hours: string | number;
  compensable_hours: string | number;
  calculated_amount: string | number | null;
  comments: string | null;
  current_step_order: number;
  submitted_at: string | null;
  closed_at: string | null;
  created_at: string;
  is_adjustment?: boolean;
};

export type SbClaimDetail = SbClaim & {
  employee_no: string | null;
  job_title: string | null;
  lines: { id: string; standby_date: string; start_time: string | null; end_time: string | null; hours: string | number }[];
  approval_steps: ApprovalStep[];
  route_history: ApprovalStep[];
  org_path: { team_name?: string | null; section_name?: string | null } | null;
  original_claim: { id: string; claim_no: string } | null;
  is_current_approver: boolean;
};

export type Callout = {
  id: string;
  claim_no: string;
  employee_id: string;
  created_by_id: string;
  employee_name: string | null;
  call_date: string;
  start_time: string;
  end_time: string;
  hours: string | number;
  rate_pct: string | number;
  converted_hours: string | number;
  reason: string;
  status: string;
  current_step_order: number;
  submitted_at: string | null;
  closed_at: string | null;
  created_at: string;
};

export type CalloutDetail = Callout & {
  approval_steps: ApprovalStep[];
  route_history: ApprovalStep[];
  is_owner: boolean;
  is_current_approver: boolean;
};

export type Eligibility = {
  eligible: boolean;
  insideStandbyAssignment: boolean;
  message: string | null;
  hours: number;
  ratePct: number;
  convertedHours: number;
  day: string;
};

export type Pending = { my_title: string; is_delegated?: boolean; delegated_from_manager_name?: string | null };

type Route = { approver_user_id: string; title: string }[];
type CalloutBody = { call_date: string; start_time: string; end_time: string; reason: string; approval_route?: Route };

const post = (path: string, body?: unknown) => req<{ ok: true }>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const sbApi = {
  my: (month: string) => req<MyStandby>(`/standby/my?month=${month}`),
  generateClaim: (month: string) => req<{ id: string }>("/standby/claims/generate", { method: "POST", body: JSON.stringify({ month }) }),

  claims: () => req<SbClaim[]>("/standby/claims"),
  claim: (id: string) => req<SbClaimDetail>(`/standby/claims/${id}`),
  updateClaim: (id: string, body: { comments?: string; approval_route?: Route }) =>
    req(`/standby/claims/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  submitClaim: (id: string) => post(`/standby/claims/${id}/submit`),
  claimApprovals: () => req<(SbClaim & Pending)[]>("/standby/approvals"),
  decideClaim: (id: string, action: "approve" | "reject" | "send-back", comments: string) =>
    post(`/standby/claims/${id}/${action}`, { comments: comments || undefined }),

  eligibility: (date: string, start: string, end: string) =>
    req<Eligibility>(`/standby/callouts/eligibility?date=${date}&start=${start}&end=${end}`),
  callouts: () => req<Callout[]>("/standby/callouts"),
  callout: (id: string) => req<CalloutDetail>(`/standby/callouts/${id}`),
  createCallout: (body: CalloutBody) => req<{ id: string }>("/standby/callouts", { method: "POST", body: JSON.stringify(body) }),
  updateCallout: (id: string, body: Partial<CalloutBody>) => req(`/standby/callouts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  submitCallout: (id: string) => post(`/standby/callouts/${id}/submit`),
  withdrawCallout: (id: string) => post(`/standby/callouts/${id}/withdraw`),
  calloutApprovals: () => req<(Callout & Pending)[]>("/standby/callouts-approvals"),
  decideCallout: (id: string, action: "approve" | "reject" | "send-back", comments: string) =>
    post(`/standby/callouts/${id}/${action}`, { comments: comments || undefined }),

  approvers: (search: string) => req<Approver[]>(`/standby/eligible-approvers?search=${encodeURIComponent(search)}`),
  managerTypes: () => req<{ name: string; active: boolean }[]>("/auth/manager-types")
};

export const sbPdf = { claim: (id: string) => `/standby/claims/${id}/pdf` };

// Standby's step titles are the org's manager types (Head of Department,
// Manager, ...) plus "Other" - the portal's useApprovalTitleOptions.
const FALLBACK_TITLES = ["Manager", "Other"];
let titlesPromise: Promise<string[]> | null = null;
export function useStandbyTitles() {
  const [titles, setTitles] = useState<string[]>(FALLBACK_TITLES);
  useEffect(() => {
    if (!titlesPromise) titlesPromise = sbApi.managerTypes()
      .then((rows) => {
        const names = (rows || []).filter((r) => r.active).map((r) => r.name);
        return names.length ? [...names, "Other"] : FALLBACK_TITLES;
      })
      .catch(() => FALLBACK_TITLES);
    void titlesPromise.then(setTitles);
  }, []);
  return titles;
}

/** "2026-11" for this month, in local time. */
export function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-11" or "2026-11-01" -> "November 2026". */
export function sbMonthLabel(month: string) {
  const [y, m] = String(month).slice(0, 7).split("-").map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "";
}
