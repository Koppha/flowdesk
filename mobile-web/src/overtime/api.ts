import { req } from "../api";
import type { Approver, ApprovalStep } from "../components/ApprovalRoute";

// Overtime requests and claims - the same endpoints the portal's
// Overtime.tsx uses (backend-v2/src/modules/overtime/overtime.routes.ts,
// mounted at /overtime). Employee and approver flows only; Finance,
// reports and settings stay on the portal.

/** A day of planned overtime on a request (the claim records actual times). */
export type RequestLine = { date: string; day?: string; estimated_start?: string; estimated_end?: string; reason?: string };

export type OtRequest = {
  id: string;
  request_no: string;
  employee_id: string;
  created_by_id: string;
  employee_name: string | null;
  year: number;
  month: number;
  noc: string | null;
  car_reg: string | null;
  remarks: string | null;
  lines: RequestLine[];
  status: string;
  current_step_order: number;
  submitted_at: string | null;
  created_at: string;
  /** List only. */
  current_step_title?: string | null;
  claim_id?: string | null;
  claim_status?: string | null;
};

export type OtRequestDetail = OtRequest & {
  employee_no: string | null;
  job_title: string | null;
  approval_steps: ApprovalStep[];
  route_history: ApprovalStep[];
  org_path: { team_name?: string | null } | null;
  claim: { id: string; claim_no: string; status: string } | null;
  is_owner: boolean;
  is_current_approver: boolean;
  can_view_pdf: boolean;
};

export type ClaimLine = {
  date: string;
  day?: string;
  from_time: string;
  to_time: string;
  ordered_by?: string;
  observed_holiday?: boolean;
  account_number?: string;
  account_name?: string;
  hours_125?: number;
  hours_150?: number;
  hours_200?: number;
  converted_hours?: number;
};

export type OtClaim = {
  id: string;
  claim_no: string;
  employee_id: string;
  created_by_id: string;
  employee_name: string | null;
  year: number;
  month: number;
  lines: ClaimLine[];
  total_overtime: string | number;
  converted_hours: string | number;
  equivalent_days: string | number;
  status: string;
  current_step_order: number;
  submitted_at: string | null;
  created_at: string;
  current_step_title?: string | null;
};

export type OtClaimDetail = OtClaim & {
  employee_no: string | null;
  job_title: string | null;
  hourly_rate: string | number | null;
  total_amount: string | number | null;
  closed_at: string | null;
  approval_steps: ApprovalStep[];
  route_history: ApprovalStep[];
  org_path: { team_name?: string | null } | null;
  source_request: { id: string; request_no: string } | null;
  is_owner: boolean;
  is_current_approver: boolean;
  can_view_pdf: boolean;
};

/** A request or claim waiting on me (or on a manager who delegated to me). */
export type Pending = {
  my_title: string;
  is_delegated?: boolean;
  delegated_from_manager_name?: string | null;
};

type Route = { approver_user_id: string; title: string }[];

const post = (path: string, body?: unknown) => req<{ ok: true; id?: string }>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const otApi = {
  requests: () => req<OtRequest[]>("/overtime/requests"),
  request: (id: string) => req<OtRequestDetail>(`/overtime/requests/${id}`),
  createRequest: (body: { year: number; month: number; noc?: string; car_reg?: string; lines: RequestLine[] }) =>
    req<{ id: string; request_no: string }>("/overtime/requests", { method: "POST", body: JSON.stringify(body) }),
  updateRequest: (id: string, body: Partial<{ year: number; month: number; noc: string; car_reg: string; lines: RequestLine[]; approval_route: Route }>) =>
    req(`/overtime/requests/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  submitRequest: (id: string) => post(`/overtime/requests/${id}/submit`),
  withdrawRequest: (id: string) => post(`/overtime/requests/${id}/withdraw`),
  requestApprovals: () => req<(OtRequest & Pending)[]>("/overtime/request-approvals"),
  decideRequest: (id: string, action: "approve" | "reject" | "send-back", comments: string) =>
    post(`/overtime/requests/${id}/${action}`, { comments: comments || undefined }),
  generateClaim: (requestId: string) => post(`/overtime/requests/${requestId}/generate-claim`) as Promise<{ id: string }>,

  claims: () => req<OtClaim[]>("/overtime/claims"),
  claim: (id: string) => req<OtClaimDetail>(`/overtime/claims/${id}`),
  updateClaim: (id: string, body: Partial<{ lines: ClaimLine[]; approval_route: Route }>) =>
    req(`/overtime/claims/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  submitClaim: (id: string) => post(`/overtime/claims/${id}/submit`),
  withdrawClaim: (id: string) => post(`/overtime/claims/${id}/withdraw`),
  claimApprovals: () => req<(OtClaim & Pending)[]>("/overtime/approvals"),
  decideClaim: (id: string, action: "approve" | "reject" | "send-back", comments: string) =>
    post(`/overtime/claims/${id}/${action}`, { comments: comments || undefined }),

  approvers: (search: string) => req<Approver[]>(`/overtime/eligible-approvers?search=${encodeURIComponent(search)}`)
};

export const otPdf = {
  request: (id: string) => `/overtime/requests/${id}/pdf`,
  claim: (id: string) => `/overtime/claims/${id}/pdf`
};

// Overtime's step "title" is the action taken, not a job title - the PDF
// prints the approver's own job title (portal OVERTIME_TITLE_OPTIONS).
export const OT_TITLES = ["Ordered by", "Checked by", "Approved by"];
