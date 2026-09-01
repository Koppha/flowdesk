const API = (import.meta.env.VITE_API as string) || window.location.origin;

export function getToken() {
  return localStorage.getItem("token");
}
export function setToken(t: string) {
  localStorage.setItem("token", t);
}
export function clearToken() {
  localStorage.removeItem("token");
}

export function getTheme() {
  return localStorage.getItem("theme");
}

export function setTheme(theme: "light" | "dark") {
  localStorage.setItem("theme", theme);
}

const UI_SCALE_KEY = "uiScale";
const UI_SCALE_DEFAULT = 1.0;

export function getUiScale(): number {
  const raw = localStorage.getItem(UI_SCALE_KEY);
  const n = raw ? parseFloat(raw) : UI_SCALE_DEFAULT;
  return Number.isFinite(n) ? Math.min(1.3, Math.max(0.8, n)) : UI_SCALE_DEFAULT;
}

export function saveUiScale(scale: number) {
  localStorage.setItem(UI_SCALE_KEY, String(scale));
}

function decodeJwt(token: string): any {
  const payload = token.split(".")[1];
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json);
}

export function getUserFromToken() {
  const t = getToken();
  if (!t) return null;
  try {
    const p = decodeJwt(t);
    return {
      userId: p.userId as string,
      role: p.role as string,
      username: (p.username as string) || "",
      fullName: (p.fullName as string) || "",
      employeeNo: (p.employeeNo as string) || "",
      department: (p.department as string) || "",
      divisionId: (p.divisionId as string) || null,
      sectionId: (p.sectionId as string) || null,
      teamId: (p.teamId as string) || null,
      employmentType: (p.employmentType as string) || "",
      profileCompleted: Boolean(p.profileCompleted)
    };
  } catch {
    return null;
  }
}

function formatApiError(json: any, fallback: string) {
  const message = typeof json?.error === "string" ? json.error : fallback;
  const fieldErrors = json?.details?.fieldErrors;
  if (fieldErrors && typeof fieldErrors === "object") {
    const details = Object.entries(fieldErrors)
      .flatMap(([field, errors]) => (Array.isArray(errors) ? errors.map((error) => `${field}: ${error}`) : []))
      .join("; ");
    if (details) return `${message}: ${details}`;
  }
  return message;
}

async function req(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: any = { Accept: "application/json", ...(options.headers || {}) };

  const isForm = options.body instanceof FormData;
  if (!isForm) headers["Content-Type"] = "application/json";

  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers, cache: options.cache ?? "no-store" });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(formatApiError(json, res.statusText));
    (error as any).status = res.status;
    throw error;
  }
  return json;
}

async function fetchBlob(path: string) {
  const token = getToken();
  const headers: any = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { headers, cache: "no-store" });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const error = new Error(formatApiError(json, res.statusText));
    (error as any).status = res.status;
    throw error;
  }
  return res.blob();
}

// Opens a blank tab *synchronously* (before the async fetch below runs) so
// browsers still count this as a direct result of the click. Fetching the
// blob first and calling window.open(url) afterwards — the previous
// pattern — loses that "user gesture" chain by the time the promise
// resolves, so strict popup blockers (Firefox in particular) silently
// swallow the window.open() and no tab ever appears, even though the PDF
// downloaded fine.
// Opens a blank tab immediately (synchronously, within the click handler's
// call stack) - browsers only allow window.open without treating it as a
// blocked popup when it happens directly in response to a user gesture, not
// after an intervening await. Callers that need to run other async work
// (e.g. capturing a step) before the PDF is ready must call this FIRST, then
// navigateTabToBlob once the blob is available - see handleApproveAdvance in
// Inbox.tsx for why this two-step form exists.
export function openBlankTab(): Window | null {
  return window.open("", "_blank");
}

export async function navigateTabToBlob(tab: Window | null, fetcher: () => Promise<Blob>) {
  try {
    const blob = await fetcher();
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    if (tab) tab.close();
    throw err;
  }
}

export async function openBlobInNewTab(fetcher: () => Promise<Blob>) {
  const tab = openBlankTab();
  await navigateTabToBlob(tab, fetcher);
}

// Triggers an actual file download (CSV exports) rather than opening a new
// tab - used by the Treasury reports' export button.
export async function downloadBlob(fetcher: () => Promise<Blob>, filename: string) {
  const blob = await fetcher();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const api = {
  login: (email: string, password: string) => req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => req("/auth/me"),
  roles: () => req("/auth/roles"),
  updateFavoritePages: (favorite_pages: string[]) => req("/auth/me/favorites", { method: "PATCH", body: JSON.stringify({ favorite_pages }) }),
  updateMyProfileContact: (data: { phone: string }) => req("/auth/me/profile", { method: "PATCH", body: JSON.stringify(data) }),
  verifyPassword: (password: string) => req("/auth/verify-password", { method: "POST", body: JSON.stringify({ password }) }),
  departments: () => req("/auth/departments"),
  groups: () => req("/auth/groups"),
  requestDirectory: (scope?: "company") => req(`/auth/request-directory${scope ? `?scope=${scope}` : ""}`),
  companyDirectory: () => req("/auth/request-directory?scope=company"),
  createDepartment: (name: string, sectionId?: string | null, managerUserId?: string | null, excoUserId?: string | null, active = true, hodUserId?: string | null) =>
    req("/auth/departments", { method: "POST", body: JSON.stringify({ name, section_id: sectionId, hod_user_id: hodUserId, manager_user_id: managerUserId, exco_user_id: excoUserId, active }) }),
  updateDepartment: (department: string, data: { name: string; section_id?: string | null; division_id?: string | null; hod_user_id?: string | null; manager_user_id?: string | null; exco_user_id?: string | null; active?: boolean; is_business_partner?: boolean; division_ids?: string[] }) =>
    req(`/auth/departments/${encodeURIComponent(department)}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteDepartment: (department: string) => req(`/auth/departments/${encodeURIComponent(department)}`, { method: "DELETE" }),
  completeProfile: (data: { full_name: string; department: string; division_id?: string | null; section_id?: string | null; team_id?: string | null; employment_type: string; employee_no?: string }) => req("/auth/complete-profile", { method: "POST", body: JSON.stringify(data) }),
  adminUsers: (divisionId?: string | null) => req(`/auth/users${divisionId ? `?division_id=${encodeURIComponent(divisionId)}` : ""}`),
  resolveOrInviteApprover: (email: string, declaredRole: "MANAGER" | "HOD" | "EXCO") =>
    req("/auth/resolve-or-invite-approver", { method: "POST", body: JSON.stringify({ email, declaredRole }) }),
  createUser: (data: any) => req("/auth/users", { method: "POST", body: JSON.stringify(data) }),
  updateUser: (id: string, data: any) => req(`/auth/users/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteUser: (id: string) => req(`/auth/users/${id}`, { method: "DELETE" }),
  deleteUserPermanent: (id: string) => req(`/auth/users/${id}/permanent`, { method: "DELETE" }),
  updateUserRole: (id: string, data: any) => req(`/auth/users/${id}/role`, { method: "POST", body: JSON.stringify(data) }),
  updateUserDepartment: (id: string, data: { department: string; division_id?: string | null; section_id?: string | null; team_id?: string | null }) => req(`/auth/users/${id}/department`, { method: "POST", body: JSON.stringify(data) }),
  updateUserGroup: (id: string, data: any) => req(`/auth/users/${id}/group`, { method: "POST", body: JSON.stringify(data) }),
  positionVacancies: (role?: string) => req(`/auth/position-vacancies${role ? `?role=${encodeURIComponent(role)}` : ""}`),
  createPositionVacancy: (data: any) => req("/auth/position-vacancies", { method: "POST", body: JSON.stringify(data) }),
  deletePositionVacancy: (id: string) => req(`/auth/position-vacancies/${id}`, { method: "DELETE" }),
  fillPositionVacancy: (id: string, data: any) => req(`/auth/position-vacancies/${id}/fill`, { method: "POST", body: JSON.stringify(data) }),
  updateDepartmentRole: (department: string, data: any) =>
    req(`/auth/departments/${encodeURIComponent(department)}/role`, { method: "POST", body: JSON.stringify(data) }),
  departmentsWithSections: () => req("/auth/departments-with-sections"),
  sections: () => req("/auth/sections"),
  leadershipUsers: () => req("/auth/leadership-users"),
  createSection: (name: string, excoUserId?: string | null, departmentId?: string | null, isBusinessPartner?: boolean, divisionIds?: string[]) =>
    req("/auth/sections", { method: "POST", body: JSON.stringify({ name, exco_user_id: excoUserId, department_id: departmentId, is_business_partner: isBusinessPartner, division_ids: divisionIds }) }),
  updateSection: (id: string, data: { name: string; exco_user_id?: string | null; department_id?: string | null; active?: boolean; is_business_partner?: boolean; division_ids?: string[] }) =>
    req(`/auth/sections/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteSection: (id: string) => req(`/auth/sections/${id}`, { method: "DELETE" }),
  setSectionOwner: (id: string, data: { role: "HOD" | "MANAGER"; user_id: string | null }) =>
    req(`/auth/sections/${id}/owner`, { method: "PUT", body: JSON.stringify(data) }),
  divisions: () => req("/auth/divisions"),
  createDivision: (name: string, description?: string | null) => req("/auth/divisions", { method: "POST", body: JSON.stringify({ name, description }) }),
  updateDivision: (id: string, data: { name: string; description?: string | null; active?: boolean }) => req(`/auth/divisions/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteDivision: (id: string) => req(`/auth/divisions/${id}`, { method: "DELETE" }),
  teams: (sectionId?: string) => req(`/auth/teams${sectionId ? `?section_id=${encodeURIComponent(sectionId)}` : ""}`),
  createTeam: (name: string, sectionId?: string | null, leaderUserId?: string | null) => req("/auth/teams", { method: "POST", body: JSON.stringify({ name, section_id: sectionId, leader_user_id: leaderUserId }) }),
  updateTeam: (id: string, data: { name: string; section_id?: string | null; leader_user_id?: string | null; active?: boolean }) => req(`/auth/teams/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTeam: (id: string) => req(`/auth/teams/${id}`, { method: "DELETE" }),
  orgStructure: () => req("/auth/org-structure"),
  deleteUnassignedOrg: () => req("/auth/org-structure/unassigned", { method: "DELETE" }),
  employmentTypes: () => req("/auth/employment-types"),
  createEmploymentType: (data: { code: string; name: string; sort_order?: number }) => req("/auth/employment-types", { method: "POST", body: JSON.stringify(data) }),
  updateEmploymentType: (id: string, data: { name?: string; active?: boolean; sort_order?: number }) => req(`/auth/employment-types/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteEmploymentType: (id: string) => req(`/auth/employment-types/${id}`, { method: "DELETE" }),
  delegations: (params?: { team_id?: string; request_type?: string }) => {
    const q: string[] = [];
    if (params?.team_id) q.push(`team_id=${encodeURIComponent(params.team_id)}`);
    if (params?.request_type) q.push(`request_type=${encodeURIComponent(params.request_type)}`);
    return req(`/auth/delegations${q.length ? `?${q.join("&")}` : ""}`);
  },
  delegationEligibility: () => req("/auth/delegations/eligibility"),
  workflows: (requestType?: string, department?: string) => {
    const params: string[] = [];
    if (requestType) params.push(`requestType=${encodeURIComponent(requestType)}`);
    if (department) params.push(`department=${encodeURIComponent(department)}`);
    return req(`/workflows${params.length ? `?${params.join("&")}` : ""}`);
  },
  workflowDetail: (id: string) => req(`/workflows/${id}`),
  createWorkflow: (data: any) => req("/workflows", { method: "POST", body: JSON.stringify(data) }),
  updateWorkflow: (id: string, data: any) => req(`/workflows/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteWorkflow: (id: string) => req(`/workflows/${id}`, { method: "DELETE" }),
  resolveWorkflow: (requestType: string, department?: string, amount?: number, section?: string, advanceSubType?: string, requesterRole?: string, division?: string) => {
    const params = [`requestType=${encodeURIComponent(requestType)}`];
    if (department) params.push(`department=${encodeURIComponent(department)}`);
    if (division) params.push(`division=${encodeURIComponent(division)}`);
    if (section) params.push(`section=${encodeURIComponent(section)}`);
    if (amount != null) params.push(`amount=${encodeURIComponent(String(amount))}`);
    if (advanceSubType) params.push(`advance_sub_type=${encodeURIComponent(advanceSubType)}`);
    if (requesterRole) params.push(`requester_role=${encodeURIComponent(requesterRole)}`);
    return req(`/workflows/resolve?${params.join("&")}`);
  },
  chainApprovers: () => req("/workflows/chain-approvers"),
  workflowActionTypes: () => req("/workflows/action-types"),
  createWorkflowActionType: (data: { code: string; label: string; sort_order?: number }) =>
    req("/workflows/action-types", { method: "POST", body: JSON.stringify(data) }),
  updateWorkflowActionType: (id: number, data: { label?: string; is_active?: boolean; sort_order?: number }) =>
    req(`/workflows/action-types/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteWorkflowActionType: (id: number) =>
    req(`/workflows/action-types/${id}`, { method: "DELETE" }),
  createDelegation: (data: any) => req("/auth/delegations", { method: "POST", body: JSON.stringify(data) }),
  endDelegation: (id: string, reason?: string) => req(`/auth/delegations/${id}/end`, { method: "POST", body: JSON.stringify({ reason }) }),
  delegationAudit: (id: string) => req(`/auth/delegations/${id}/audit`),
  adminFeaturePermissions: () => req("/auth/admin-feature-permissions"),
  updateAdminFeaturePermissions: (features: Record<string, string[]>) =>
    req("/auth/admin-feature-permissions", { method: "PUT", body: JSON.stringify({ features }) }),
  permissionGroups: () => req("/auth/permission-groups"),
  createPermissionGroup: (name: string) => req("/auth/permission-groups", { method: "POST", body: JSON.stringify({ name }) }),
  deletePermissionGroup: (name: string) => req(`/auth/permission-groups/${encodeURIComponent(name)}`, { method: "DELETE" }),
  setGroupVisibility: (name: string, hidden: boolean) =>
    req(`/auth/permission-groups/${encodeURIComponent(name)}/visibility`, { method: "PUT", body: JSON.stringify({ hidden }) }),
  groupMembers: (name: string) => req(`/auth/permission-groups/${encodeURIComponent(name)}/members`),
  addGroupMember: (name: string, userId: string) =>
    req(`/auth/permission-groups/${encodeURIComponent(name)}/members`, { method: "POST", body: JSON.stringify({ user_id: userId }) }),
  removeGroupMember: (name: string, userId: string) =>
    req(`/auth/permission-groups/${encodeURIComponent(name)}/members/${userId}`, { method: "DELETE" }),

  advances: () => req("/advances?mine=true"),
  // Org-wide (not "mine=true") — gated server-side by the report_advances
  // feature permission. Used only by the Reports screens, never by the
  // personal My Advances/My Clearances pages.
  allAdvances: () => req("/advances"),
  reconciliationReport: (from: string, to: string) =>
    req(`/advances/reconciliation-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  clearanceStatusReport: () => req("/advances/clearance-status-report"),
  createAdvance: (data: any) => req("/advances", { method: "POST", body: JSON.stringify(data) }),
  // generic update endpoint; backend should allow editing fields such as type/requested_total/salary_month/etc
  updateAdvance: (id: string, data: any) => req(`/advances/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  // travel-specific lines update (rows)
  updateAdvanceLines: (id: string, data: any) => req(`/advances/${id}/lines`, { method: "PUT", body: JSON.stringify(data) }),
  submitAdvance: (id: string) => req(`/advances/${id}/submit`, { method: "POST", body: JSON.stringify({}) }),
  revokeAdvance: (id: string) => req(`/advances/${id}/revoke`, { method: "POST", body: JSON.stringify({}) }),
  remindAdvance: (id: string) => req(`/advances/${id}/remind`, { method: "POST", body: JSON.stringify({}) }),
  claims: () => req("/claims?mine=true"),
  allClaims: () => req("/claims"),
  createClaim: (data: any) => req("/claims", { method: "POST", body: JSON.stringify(data) }),
  updateClaim: (id: string, data: any) => req(`/claims/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  updateClaimTrips: (id: string, data: any) => req(`/claims/${id}/trips`, { method: "PUT", body: JSON.stringify(data) }),
  uploadClaimReceipt: (id: string, form: FormData) => req(`/claims/${id}/upload-receipt`, { method: "POST", body: form }),
  deleteClaimReceipt: (id: string, receiptId: string) => req(`/claims/${id}/receipts/${receiptId}`, { method: "DELETE" }),
  claimReceiptFileBlob: (id: string, receiptId: string) => fetchBlob(`/claims/${id}/receipts/${receiptId}/file`),
  submitClaim: (id: string) => req(`/claims/${id}/submit`, { method: "POST", body: JSON.stringify({}) }),
  submitPaybackProof: (id: string, form: FormData) => req(`/claims/${id}/payback-proof`, { method: "POST", body: form }),
  verifyPaybackProof: (id: string, proofId: string) => req(`/claims/${id}/payback-proof/${proofId}/verify`, { method: "POST", body: JSON.stringify({}) }),
  rejectPaybackProof: (id: string, proofId: string, reason: string) =>
    req(`/claims/${id}/payback-proof/${proofId}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),
  paybackProofFileBlob: (id: string, proofId: string) => fetchBlob(`/claims/${id}/payback-proof/${proofId}/file`),
  paybackReviewQueue: () => req("/claims/payback-review-queue"),
  sendClearanceToTreasury: (id: string) => req(`/claims/${id}/send-to-treasury`, { method: "POST", body: JSON.stringify({}) }),

  treasuryAccess: () => req("/treasury/access"),
  treasuryQueue: (params: Record<string, string> = {}) => req(`/treasury?${new URLSearchParams(params).toString()}`),
  treasuryCompleteBalanced: (id: string, data: { posting_reference?: string; comment?: string } = {}) =>
    req(`/treasury/${id}/complete-balanced`, { method: "POST", body: JSON.stringify(data) }),
  treasuryProcessRefund: (id: string, data: any) => req(`/treasury/${id}/process-refund`, { method: "POST", body: JSON.stringify(data) }),
  treasuryReconcilePayback: (id: string, data: any) => req(`/treasury/${id}/reconcile-payback`, { method: "POST", body: JSON.stringify(data) }),
  treasuryReturnToHr: (id: string, reason: string) => req(`/treasury/${id}/return-to-hr`, { method: "POST", body: JSON.stringify({ reason }) }),

  treasuryReport: (report: string, params: Record<string, string> = {}) =>
    req(`/treasury-reports/${report}?${new URLSearchParams(params).toString()}`),
  treasuryReportCsv: (report: string, params: Record<string, string> = {}) =>
    fetchBlob(`/treasury-reports/${report}?${new URLSearchParams({ ...params, format: "csv" }).toString()}`),

  inbox: () => req("/inbox"),
  myInboxActions: (limit = 50) => req(`/inbox/my-actions?limit=${limit}`),
  overtimeRequests: () => req("/overtime/requests"),
  overtimeRequestDetail: (id: string) => req(`/overtime/requests/${id}`),
  createOvertimeRequest: (data: any) => req("/overtime/requests", { method: "POST", body: JSON.stringify(data) }),
  updateOvertimeRequest: (id: string, data: any) => req(`/overtime/requests/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  submitOvertimeRequest: (id: string) => req(`/overtime/requests/${id}/submit`, { method: "POST" }),
  withdrawOvertimeRequest: (id: string) => req(`/overtime/requests/${id}/withdraw`, { method: "POST" }),
  overtimeRequestApprovals: () => req("/overtime/request-approvals"),
  approveOvertimeRequest: (id: string, comments?: string) => req(`/overtime/requests/${id}/approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  rejectOvertimeRequest: (id: string, comments: string) => req(`/overtime/requests/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  sendBackOvertimeRequest: (id: string, comments: string) => req(`/overtime/requests/${id}/send-back`, { method: "POST", body: JSON.stringify({ comments }) }),
  generateOvertimeClaim: (requestId: string) => req(`/overtime/requests/${requestId}/generate-claim`, { method: "POST" }),

  overtimeClaims: () => req("/overtime/claims"),
  overtimeClaimDetail: (id: string) => req(`/overtime/claims/${id}`),
  updateOvertimeClaim: (id: string, data: any) => req(`/overtime/claims/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  submitOvertimeClaim: (id: string) => req(`/overtime/claims/${id}/submit`, { method: "POST" }),
  withdrawOvertimeClaim: (id: string) => req(`/overtime/claims/${id}/withdraw`, { method: "POST" }),
  overtimeApprovals: () => req("/overtime/approvals"),
  approveOvertimeClaim: (id: string, comments?: string) => req(`/overtime/claims/${id}/approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  rejectOvertimeClaim: (id: string, comments: string) => req(`/overtime/claims/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  sendBackOvertimeClaim: (id: string, comments: string) => req(`/overtime/claims/${id}/send-back`, { method: "POST", body: JSON.stringify({ comments }) }),

  overtimeFinanceQueue: (status?: string) => req(`/overtime/finance/queue${status ? `?status=${status}` : ""}`),
  processOvertimeClaimFinance: (id: string, data: any) => req(`/overtime/claims/${id}/finance-process`, { method: "POST", body: JSON.stringify(data) }),
  returnOvertimeClaimFinance: (id: string, comments: string) => req(`/overtime/claims/${id}/finance-return`, { method: "POST", body: JSON.stringify({ comments }) }),
  markOvertimeClaimSettled: (id: string) => req(`/overtime/claims/${id}/mark-settled`, { method: "POST" }),

  overtimeEligibleApprovers: (search: string) => req(`/overtime/eligible-approvers?search=${encodeURIComponent(search)}`),
  publicHolidays: () => req("/overtime/public-holidays"),
  createPublicHoliday: (data: { holiday_date: string; name: string }) => req("/overtime/public-holidays", { method: "POST", body: JSON.stringify(data) }),
  deletePublicHoliday: (id: string) => req(`/overtime/public-holidays/${id}`, { method: "DELETE" }),
  overtimeSettings: () => req("/overtime/settings"),
  updateOvertimeSettings: (data: any) => req("/overtime/settings", { method: "PUT", body: JSON.stringify(data) }),
  overtimeReportsSummary: () => req("/overtime/reports/summary"),
  overtimeDashboard: () => req("/overtime/dashboard"),
  aiAnomalies: () => req("/ai/anomalies"),
  aiNlReport: (prompt: string) => req("/ai/nl-report", { method: "POST", body: JSON.stringify({ prompt }) }),
  aiOcrExtract: (text: string) => req("/ai/ocr-extract", { method: "POST", body: JSON.stringify({ text }) }),

  slaReport: (periodDays?: number) => req(`/advances/sla-report${periodDays ? `?period_days=${periodDays}` : ""}`),
  claimsSlaReport: (periodDays?: number) => req(`/claims/sla-report${periodDays ? `?period_days=${periodDays}` : ""}`),
  claimsSlaThresholds: () => req("/claims/sla-thresholds"),
  updateClaimsSlaThresholds: (thresholds: { position_type_code: string; sla_days: number }[]) =>
    req("/claims/sla-thresholds", { method: "PUT", body: JSON.stringify({ thresholds }) }),
  advanceDetail: (id: string) => req(`/advances/${id}`),
  advanceRecoverySettings: () => req("/advances/recovery-settings"),
  updateAdvanceRecoverySettings: (data: { clearance_duration_days: number; recovery_months: number }) =>
    req("/advances/recovery-settings", { method: "PUT", body: JSON.stringify(data) }),
  sessionSettings: () => req("/auth/session-settings"),
  updateSessionSettings: (data: { idle_timeout_minutes: number; warning_seconds: number }) =>
    req("/auth/session-settings", { method: "PUT", body: JSON.stringify(data) }),
  reportTourProgress: (data: { tour_key: string; step_index: number; total_steps: number; completed?: boolean }) =>
    req("/auth/tour-progress", { method: "POST", body: JSON.stringify(data) }),
  tourProgressReport: () => req("/auth/tour-progress/report"),
  confirmAdvanceNotCleared: (id: string) => req(`/advances/${id}/confirm-not-cleared`, { method: "POST" }),
  accommodationRequests: (mine?: boolean) => req(`/accommodation-requests${mine ? "?mine=true" : ""}`),
  createAccommodationRequest: (data: any) => req("/accommodation-requests", { method: "POST", body: JSON.stringify(data) }),
  uploadAccommodationQuotation: (id: string, form: FormData) => req(`/accommodation-requests/${id}/upload-quotation`, { method: "POST", body: form }),
  sendAccommodationToFinance: (id: string) => req(`/accommodation-requests/${id}/send-to-finance`, { method: "POST", body: JSON.stringify({}) }),
  accommodationDetail: (id: string) => req(`/accommodation-requests/${id}`),
  markAccommodationPaid: (id: string) =>
    req(`/accommodation-requests/${id}/mark-paid`, { method: "POST", body: JSON.stringify({}) }),
  rejectAccommodation: (id: string, comments: string) =>
    req(`/accommodation-requests/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  advanceHistory: (id: string) => req(`/advances/${id}/history`),
  claimDetail: (id: string) => req(`/claims/${id}`),

  rollbackAdvance: (id: string, comments?: string) => req(`/advances/${id}/rollback`, { method: "POST", body: JSON.stringify({ comments }) }),
  undoAdvanceCapture: (id: string, comments: string) => req(`/advances/${id}/undo-capture`, { method: "POST", body: JSON.stringify({ comments }) }),
  advancePdf: (id: string) => fetchBlob(`/advances/${id}/pdf`),
  rejectAdvance: (id: string, comments: string) => req(`/advances/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  approveAdvance: (id: string, approved_total: number, comments?: string) =>
    req(`/advances/${id}/approve`, { method: "POST", body: JSON.stringify({ approved_total, comments }) }),
  markAdvancePaid: (id: string) => req(`/advances/${id}/mark-paid`, { method: "POST", body: JSON.stringify({}) }),
  payments: (params: { status?: "pending" | "paid" | "all"; limit?: number; offset?: number } = {}) =>
    req(`/advances/payments?${new URLSearchParams(params as any).toString()}`),
  paymentsAccess: () => req("/advances/payments/access"),

  approveClaim: (id: string, comments?: string) => req(`/claims/${id}/approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  rejectClaim: (id: string, comments: string) => req(`/claims/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  rollbackClaim: (id: string, comments?: string) => req(`/claims/${id}/rollback`, { method: "POST", body: JSON.stringify({ comments }) }),
  financeDecideClaim: (id: string, payload: {
    finance_decision: "ACCEPTED" | "REFUND_FROM_EMPLOYEE" | "REIMBURSE_EMPLOYEE";
    finance_comments: string;
    settlement_amount?: number;
    settled_method?: "PAYROLL" | "ECOCASH" | "BANK" | "CASH" | "OTHER";
    settled_reference?: string;
    assignee_user_id?: string;
    assignee_group_name?: string;
    expected_payment_date?: string;
  }) => req(`/claims/${id}/settle`, { method: "POST", body: JSON.stringify(payload) }),
  markClaimSettled: (id: string, settled_reference?: string) =>
    req(`/claims/${id}/mark-settled`, { method: "POST", body: JSON.stringify({ settled_reference }) }),
  // Hotels (accommodation)
  hotels: (params?: { search?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.limit != null) qs.set("limit", String(params.limit));
    if (params?.offset != null) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return req(`/accommodation/hotels${query ? `?${query}` : ""}`);
  },
  createHotel: (data: any) => req("/accommodation/hotels", { method: "POST", body: JSON.stringify(data) }),
  updateHotel: (id: string, data: any) => req(`/accommodation/hotels/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteHotel: (id: string) => req(`/accommodation/hotels/${id}`, { method: "DELETE" }),
  mealValue: () => req("/accommodation/meal-value"),
  updateMealValue: (meal_value: number) => req("/accommodation/meal-value", { method: "PUT", body: JSON.stringify({ meal_value }) }),

  // PA (personal assistant) assignments - let an assistant submit advances
  // on behalf of a specific boss regardless of employment type/department.
  myPaPrincipals: () => req("/pa-assignments/my-principals"),
  paAssignments: () => req("/pa-assignments"),
  createPaAssignment: (pa_user_id: string, principal_user_id: string) =>
    req("/pa-assignments", { method: "POST", body: JSON.stringify({ pa_user_id, principal_user_id }) }),
  deletePaAssignment: (id: string) => req(`/pa-assignments/${id}`, { method: "DELETE" }),

  requestTypes: () => req("/request-types"),
  requestTypeDetail: (id: string) => req(`/request-types/${id}`),
  createRequestType: (data: any) => req("/request-types", { method: "POST", body: JSON.stringify(data) }),
  updateRequestType: (id: string, data: any) => req(`/request-types/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRequestType: (id: string) => req(`/request-types/${id}`, { method: "DELETE" }),
  updateRequestTypeFields: (id: string, fields: any[]) => req(`/request-types/${id}/fields`, { method: "PUT", body: JSON.stringify(fields) }),
  requestTypePermissions: (id: string) => req(`/request-types/${id}/permissions`),
  moduleFlags: () => req("/request-types/module-flags"),
  updateModuleFlags: (data: {
    overtime_enabled?: boolean; standby_enabled?: boolean;
    salary_advance_enabled?: boolean; loan_advance_enabled?: boolean;
    salary_advance_max_payback_months?: number; loan_advance_max_payback_months?: number;
    vendor_contracts_enabled?: boolean; service_contracts_enabled?: boolean;
  }) => req("/request-types/module-flags", { method: "PUT", body: JSON.stringify(data) }),
  addRequestTypePermission: (id: string, data: any) => req(`/request-types/${id}/permissions`, { method: "POST", body: JSON.stringify(data) }),
  removeRequestTypePermission: (id: string, permId: string) => req(`/request-types/${id}/permissions/${permId}`, { method: "DELETE" }),

  pdfTemplates: (requestType?: string, customRequestTypeId?: string) => {
    const params: string[] = [];
    if (requestType) params.push(`request_type=${encodeURIComponent(requestType)}`);
    if (customRequestTypeId) params.push(`custom_request_type_id=${encodeURIComponent(customRequestTypeId)}`);
    return req(`/pdf-templates${params.length ? `?${params.join("&")}` : ""}`);
  },
  pdfTemplateDetail: (id: string) => req(`/pdf-templates/${id}`),
  createPdfTemplate: (data: any) => req("/pdf-templates", { method: "POST", body: JSON.stringify(data) }),
  updatePdfTemplate: (id: string, data: any) => req(`/pdf-templates/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deletePdfTemplate: (id: string) => req(`/pdf-templates/${id}`, { method: "DELETE" }),
  pdfFieldCatalog: (requestType: string, customRequestTypeId?: string) => {
    const params = [`request_type=${encodeURIComponent(requestType)}`];
    if (customRequestTypeId) params.push(`custom_request_type_id=${encodeURIComponent(customRequestTypeId)}`);
    return req(`/pdf-templates/field-catalog?${params.join("&")}`);
  },
  pdfTemplatePreviewBlob: (id: string, sampleId?: string) => fetchBlob(`/pdf-templates/${id}/preview${sampleId ? `?sample_id=${encodeURIComponent(sampleId)}` : ""}`),
  pdfTemplatePermissions: (id: string) => req(`/pdf-templates/${id}/permissions`),
  addPdfTemplatePermission: (id: string, data: any) => req(`/pdf-templates/${id}/permissions`, { method: "POST", body: JSON.stringify(data) }),
  removePdfTemplatePermission: (id: string, permId: string) => req(`/pdf-templates/${id}/permissions/${permId}`, { method: "DELETE" }),
  pdfLetterhead: () => req("/pdf-templates/letterhead"),
  updatePdfLetterhead: (data: any) => req("/pdf-templates/letterhead", { method: "PUT", body: JSON.stringify(data) }),
  uploadPdfLetterheadLogo: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return req("/pdf-templates/letterhead/logo", { method: "POST", body: form });
  },
  pdfLetterheadPreviewBlob: (draft?: { company_name?: string; address_lines?: string; contact_line?: string; footer_text?: string }) => {
    const params = new URLSearchParams();
    if (draft?.company_name !== undefined) params.set("company_name", draft.company_name);
    if (draft?.address_lines !== undefined) params.set("address_lines", draft.address_lines);
    if (draft?.contact_line !== undefined) params.set("contact_line", draft.contact_line);
    if (draft?.footer_text !== undefined) params.set("footer_text", draft.footer_text);
    const qs = params.toString();
    return fetchBlob(`/pdf-templates/letterhead/preview${qs ? `?${qs}` : ""}`);
  },
  claimPdf: (id: string) => fetchBlob(`/claims/${id}/pdf`),
  accommodationPdf: (id: string) => fetchBlob(`/accommodation/${id}/pdf`),
  overtimeRequestPdf: (id: string) => fetchBlob(`/overtime/requests/${id}/pdf`),
  overtimeClaimPdf: (id: string) => fetchBlob(`/overtime/claims/${id}/pdf`),
  customRequestPdf: (id: string) => fetchBlob(`/custom-requests/${id}/pdf`),

  myManager: () => req("/reporting-lines/my-manager"),
  // Sent as multipart/form-data so attachments can ride along with the rest of the wizard.
  submitCustomRequest: (data: { request_type_id: string; data: Record<string, any>; approval_chain: any[] }, files?: File[]) => {
    const form = new FormData();
    form.append("request_type_id", data.request_type_id);
    form.append("data", JSON.stringify(data.data));
    form.append("approval_chain", JSON.stringify(data.approval_chain));
    (files || []).forEach((f) => form.append("files", f));
    return req("/custom-requests", { method: "POST", body: form });
  },
  myCustomRequests: () => req("/custom-requests/mine"),
  customRequestDetail: (id: string) => req(`/custom-requests/${id}`),
  customRequestConsolidated: (id: string) => req(`/custom-requests/${id}/consolidated`),
  customRequestAttachmentBlob: (id: string, attachmentId: string) => fetchBlob(`/custom-requests/${id}/attachments/${attachmentId}`),
  actionCustomRequest: (id: string, data: { action: "APPROVE" | "REJECT"; comment?: string }) =>
    req(`/custom-requests/${id}/action`, { method: "POST", body: JSON.stringify(data) }),
  cancelCustomRequest: (id: string, comment: string) =>
    req(`/custom-requests/${id}/cancel`, { method: "POST", body: JSON.stringify({ comment }) }),
  closeCustomRequest: (id: string, data: { implementation_date: string; closure_notes?: string }) =>
    req(`/custom-requests/${id}/close`, { method: "POST", body: JSON.stringify(data) }),
  assignedToMeCustomRequests: () => req("/custom-requests/assigned-to-me"),
  addCustomRequestAssignee: (id: string, data: { field_key: string; id?: string; email?: string; name?: string; team_id?: string }) =>
    req(`/custom-requests/${id}/assignees`, { method: "POST", body: JSON.stringify(data) }),
  confirmCustomRequestAssignee: (id: string, field_key: string) =>
    req(`/custom-requests/${id}/assignees/confirm`, { method: "POST", body: JSON.stringify({ field_key }) }),
  updateCustomRequestData: (id: string, data: Record<string, any>) =>
    req(`/custom-requests/${id}/data`, { method: "PATCH", body: JSON.stringify({ data }) }),

  emailActionDetail: (token: string) => req(`/email-actions/${encodeURIComponent(token)}`),
  emailActionConfirm: (token: string, data: { action: "APPROVE" | "REJECT"; comment?: string }) =>
    req(`/email-actions/${encodeURIComponent(token)}/confirm`, { method: "POST", body: JSON.stringify(data) }),

  ceoUsers: () => req("/auth/ceo"),
  managerTypes: () => req("/auth/manager-types"),
  createManagerType: (data: { name: string; role: "MANAGER" | "HOD"; description?: string | null }) => req("/auth/manager-types", { method: "POST", body: JSON.stringify(data) }),
  updateManagerType: (id: string, data: { name: string; role: "MANAGER" | "HOD"; description?: string | null; active?: boolean }) => req(`/auth/manager-types/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteManagerType: (id: string) => req(`/auth/manager-types/${id}`, { method: "DELETE" }),

  reportingLineStats: () => req("/reporting-lines/stats"),
  reportingLines: (department?: string, search?: string, sectionId?: string, teamId?: string) => {
    const params: string[] = [];
    if (teamId) params.push(`team_id=${encodeURIComponent(teamId)}`);
    else if (sectionId) params.push(`section_id=${encodeURIComponent(sectionId)}`);
    else if (department) params.push(`department=${encodeURIComponent(department)}`);
    if (search) params.push(`search=${encodeURIComponent(search)}`);
    return req(`/reporting-lines${params.length ? `?${params.join("&")}` : ""}`);
  },
  reportingLineHierarchy: (department: string) => req(`/reporting-lines/hierarchy/${encodeURIComponent(department)}`),
  reportingLineHistory: (employeeId: string) => req(`/reporting-lines/employee/${employeeId}/history`),
  upsertReportingLine: (data: any) => req("/reporting-lines", { method: "POST", body: JSON.stringify(data) }),
  autoGenerateReportingLines: () => req("/reporting-lines/auto-generate", { method: "POST", body: JSON.stringify({}) }),
  myTeam: () => req("/reporting-lines/my-team"),

  travelTypes: () => req("/travel/types"),
  createTravelType: (data: any) => req("/travel/types", { method: "POST", body: JSON.stringify(data) }),
  updateTravelType: (id: string, data: any) => req(`/travel/types/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTravelType: (id: string) => req(`/travel/types/${id}`, { method: "DELETE" }),
  createTravelLocation: (data: any) => req("/travel/locations", { method: "POST", body: JSON.stringify(data) }),
  updateTravelLocation: (id: string, data: any) => req(`/travel/locations/${id}`, { method: "PUT", body: JSON.stringify(data) }),

  deductionsAccess: () => req("/deductions/access"),
  deductions: () => req("/deductions"),
  setDeductionActioned: (id: string, deducted: boolean) =>
    req(`/deductions/${id}/deducted`, { method: "PATCH", body: JSON.stringify({ deducted }) }),
  refundableAccess: () => req("/refundable/access"),
  refundable: () => req("/refundable"),
  setRefundableActioned: (id: string, refunded: boolean) =>
    req(`/refundable/${id}/refunded`, { method: "PATCH", body: JSON.stringify({ refunded }) }),

  vendorContractsAccess: () => req("/vendor-contracts/access"),
  vendorContractsDashboard: () => req("/vendor-contracts/dashboard"),
  vendorContracts: () => req("/vendor-contracts"),
  vendorContractDetail: (id: string) => req(`/vendor-contracts/${id}`),
  createVendorContract: (data: any) => req("/vendor-contracts", { method: "POST", body: JSON.stringify(data) }),
  updateVendorContract: (id: string, data: any) => req(`/vendor-contracts/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  setVendorContractActive: (id: string, isActive: boolean) =>
    req(`/vendor-contracts/${id}/active`, { method: "PATCH", body: JSON.stringify({ isActive }) }),
  createVendorContractPayment: (id: string, data: any) => req(`/vendor-contracts/${id}/payments`, { method: "POST", body: JSON.stringify(data) }),
  markVendorContractPaymentPaid: (contractId: string, paymentId: string) =>
    req(`/vendor-contracts/${contractId}/payments/${paymentId}/mark-paid`, { method: "POST" }),
  uploadVendorContractDocument: (id: string, form: FormData) => req(`/vendor-contracts/${id}/documents`, { method: "POST", body: form }),
  vendorContractDocumentBlob: (contractId: string, documentId: string) => fetchBlob(`/vendor-contracts/${contractId}/documents/${documentId}`),
  vendorContractsMailReport: () => req("/vendor-contracts/reports/mail"),

  serviceContractsAccess: () => req("/service-contracts/access"),
  serviceContractsDashboard: () => req("/service-contracts/dashboard"),
  serviceContracts: (type: "individual" | "company", params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v))).toString();
    return req(`/service-contracts/${type}${qs ? `?${qs}` : ""}`);
  },
  serviceContractDetail: (type: "individual" | "company", id: string) => req(`/service-contracts/${type}/${id}`),
  createServiceContract: (type: "individual" | "company", data: any) => req(`/service-contracts/${type}`, { method: "POST", body: JSON.stringify(data) }),
  updateServiceContract: (type: "individual" | "company", id: string, data: any) => req(`/service-contracts/${type}/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  setServiceContractActive: (type: "individual" | "company", id: string, isActive: boolean) =>
    req(`/service-contracts/${type}/${id}/active`, { method: "PATCH", body: JSON.stringify({ isActive }) }),
  serviceContractsReports: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v))).toString();
    return req(`/service-contracts/reports${qs ? `?${qs}` : ""}`);
  },
  serviceContractLookups: (kind: "service-categories" | "service-packages" | "durations" | "statuses") => req(`/service-contracts/lookups/${kind}`),
  createServiceContractLookup: (kind: "service-categories" | "service-packages" | "durations" | "statuses", data: any) =>
    req(`/service-contracts/lookups/${kind}`, { method: "POST", body: JSON.stringify(data) }),
  updateServiceContractLookup: (kind: "service-categories" | "service-packages" | "durations" | "statuses", id: string, data: any) =>
    req(`/service-contracts/lookups/${kind}/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  serviceContractApiKeys: () => req("/service-contracts/api-keys"),
  createServiceContractApiKey: (label: string) => req("/service-contracts/api-keys", { method: "POST", body: JSON.stringify({ label }) }),
  setServiceContractApiKeyActive: (id: string, isActive: boolean) =>
    req(`/service-contracts/api-keys/${id}/active`, { method: "PATCH", body: JSON.stringify({ isActive }) }),

  dataCleanupCategories: () => req("/admin/data-cleanup/categories"),
  dataCleanupWipe: (categories: string[]) =>
    req("/admin/data-cleanup", { method: "POST", body: JSON.stringify({ categories, confirm: "WIPE" }) }),
  dataCleanupFullReset: (keepAdminEmail: string) =>
    req("/admin/data-cleanup/full-reset", { method: "POST", body: JSON.stringify({ confirm: "RESET EVERYTHING", keepAdminEmail }) }),

  runApprovalReassignmentSweep: () => req("/admin/approval-maintenance/reassign-pending-approvals", { method: "POST" }),

  itProvisioningAccess: () => req("/it-provisioning/access"),
  itProvisioningItStaff: () => req("/it-provisioning/it-staff"),
  itProvisioningList: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v))).toString();
    return req(`/it-provisioning${qs ? `?${qs}` : ""}`);
  },
  itProvisioningDetail: (id: string) => req(`/it-provisioning/${id}`),
  itProvisioningAssign: (id: string, data: { assigned_to_id?: string | null; device_source?: string }) =>
    req(`/it-provisioning/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  itProvisioningSetDevice: (id: string, data: any) =>
    req(`/it-provisioning/${id}/device`, { method: "PUT", body: JSON.stringify(data) }),
  itProvisioningSetChecklist: (id: string, checklist: Array<{ label: string; checked: boolean }>) =>
    req(`/it-provisioning/${id}/checklist`, { method: "PUT", body: JSON.stringify({ checklist }) }),
  itProvisioningSetSoftware: (id: string, software: Array<{ name: string; status: string; is_standard?: boolean }>) =>
    req(`/it-provisioning/${id}/software`, { method: "PUT", body: JSON.stringify({ software }) }),
  itProvisioningSetReplacementDetails: (id: string, data: any) =>
    req(`/it-provisioning/${id}/replacement-details`, { method: "PUT", body: JSON.stringify(data) }),
  itProvisioningSetUpgradeDetails: (id: string, data: any) =>
    req(`/it-provisioning/${id}/upgrade-details`, { method: "PUT", body: JSON.stringify(data) }),
  itProvisioningMarkProvisioned: (id: string) => req(`/it-provisioning/${id}/mark-provisioned`, { method: "POST", body: JSON.stringify({}) }),
  itProvisioningReadyForCollection: (id: string) => req(`/it-provisioning/${id}/ready-for-collection`, { method: "POST", body: JSON.stringify({}) }),
  itProvisioningHandover: (id: string, data: any) => req(`/it-provisioning/${id}/handover`, { method: "POST", body: JSON.stringify(data) }),
  itProvisioningDevices: () => req("/it-provisioning/devices"),
  itProvisioningReportsSummary: () => req("/it-provisioning/reports/summary"),
  itProvisioningChecklistTemplates: () => req("/it-provisioning/checklist-templates"),
  itProvisioningSaveChecklistTemplates: (computer_type: string, items: string[]) =>
    req("/it-provisioning/checklist-templates", { method: "PUT", body: JSON.stringify({ computer_type, items }) }),
  itProvisioningSoftwareTemplates: () => req("/it-provisioning/software-templates"),
  itProvisioningSaveSoftwareTemplates: (computer_type: string, items: Array<{ name: string; is_standard?: boolean }>) =>
    req("/it-provisioning/software-templates", { method: "PUT", body: JSON.stringify({ computer_type, items }) }),
  itProvisioningDefaultAssignees: () => req("/it-provisioning/default-assignees"),
  itProvisioningSetDefaultAssignees: (assigned_to_ids: string[]) =>
    req("/it-provisioning/default-assignees", { method: "PUT", body: JSON.stringify({ assigned_to_ids }) }),
  itProvisioningClaim: (id: string) => req(`/it-provisioning/${id}/claim`, { method: "POST", body: JSON.stringify({}) }),

  standbyDashboard: () => req("/standby/dashboard"),
  standbyTeams: () => req("/standby/teams"),
  standbyRosters: (teamId?: string) => req(`/standby/rosters${teamId ? `?team_id=${teamId}` : ""}`),
  createStandbyRoster: (data: { team_id: string; roster_month: string }) =>
    req("/standby/rosters", { method: "POST", body: JSON.stringify(data) }),
  standbyRoster: (id: string) => req(`/standby/rosters/${id}`),
  addStandbyAssignment: (rosterId: string, data: any) =>
    req(`/standby/rosters/${rosterId}/assignments`, { method: "POST", body: JSON.stringify(data) }),
  deleteStandbyAssignment: (rosterId: string, assignmentId: string) =>
    req(`/standby/rosters/${rosterId}/assignments/${assignmentId}`, { method: "DELETE" }),
  publishStandbyRoster: (rosterId: string) => req(`/standby/rosters/${rosterId}/publish`, { method: "POST" }),
  cancelStandbyRoster: (rosterId: string) => req(`/standby/rosters/${rosterId}`, { method: "DELETE" }),

  myStandby: (month: string) => req(`/standby/my?month=${month}`),
  generateStandbyClaim: (month: string) => req("/standby/claims/generate", { method: "POST", body: JSON.stringify({ month }) }),
  standbyClaims: () => req("/standby/claims"),
  standbyClaim: (id: string) => req(`/standby/claims/${id}`),
  updateStandbyClaim: (id: string, data: any) => req(`/standby/claims/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  submitStandbyClaim: (id: string) => req(`/standby/claims/${id}/submit`, { method: "POST" }),

  standbyApprovals: () => req("/standby/approvals"),
  approveStandbyClaim: (id: string, comments?: string) =>
    req(`/standby/claims/${id}/approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  rejectStandbyClaim: (id: string, comments: string) =>
    req(`/standby/claims/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  sendBackStandbyClaim: (id: string, comments: string) =>
    req(`/standby/claims/${id}/send-back`, { method: "POST", body: JSON.stringify({ comments }) }),

  standbyFinanceQueue: (status?: string) => req(`/standby/finance/queue${status ? `?status=${status}` : ""}`),
  processStandbyFinance: (id: string, data: any) =>
    req(`/standby/claims/${id}/finance-process`, { method: "POST", body: JSON.stringify(data) }),
  returnStandbyFinance: (id: string, comments: string) =>
    req(`/standby/claims/${id}/finance-return`, { method: "POST", body: JSON.stringify({ comments }) }),
  markStandbyClaimPaid: (id: string) => req(`/standby/claims/${id}/mark-paid`, { method: "POST" }),

  standbyEligibleApprovers: (search: string) => req(`/standby/eligible-approvers?search=${encodeURIComponent(search)}`),

  standbyRosterView: (scope: string, range: string, date: string) =>
    req(`/standby/roster-view?scope=${scope}&range=${range}&date=${date}`),

  updateStandbyTeamSettings: (teamId: string, data: { required_roles: string[] }) =>
    req(`/standby/teams/${teamId}/settings`, { method: "PATCH", body: JSON.stringify(data) }),

  standbyFinanceSections: () => req("/standby/finance-sections"),
  updateStandbyFinanceSection: (id: string, data: { is_standby_finance: boolean }) =>
    req(`/standby/finance-sections/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  standbyClaimAdjustments: (claimId: string) => req(`/standby/claims/${claimId}/adjustments`),
  createStandbyAdjustment: (claimId: string, data: { reason: string; lines: { standby_date: string; start_time?: string; end_time?: string; hours: number }[] }) =>
    req(`/standby/claims/${claimId}/adjustments`, { method: "POST", body: JSON.stringify(data) }),

  standbyOperationalReport: () => req("/standby/reports/operational"),
  standbyFinancialReport: () => req("/standby/reports/financial"),

  standbySettings: () => req("/standby/settings"),
  updateStandbySettings: (data: { compensable_rate_pct: number; default_hourly_rate: number }) =>
    req("/standby/settings", { method: "PUT", body: JSON.stringify(data) }),
  standbyClaimPdf: (id: string) => fetchBlob(`/standby/claims/${id}/pdf`),

  standbyFinanceCodes: (kind?: string, all?: boolean) =>
    req(`/standby/finance-codes?${kind ? `kind=${kind}&` : ""}${all ? "all=true" : ""}`),
  createStandbyFinanceCode: (data: { kind: string; name: string }) =>
    req("/standby/finance-codes", { method: "POST", body: JSON.stringify(data) }),
  updateStandbyFinanceCode: (id: string, data: { name?: string; active?: boolean }) =>
    req(`/standby/finance-codes/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteStandbyFinanceCode: (id: string) => req(`/standby/finance-codes/${id}`, { method: "DELETE" })
};
