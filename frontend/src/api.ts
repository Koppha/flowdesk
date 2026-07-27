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
export async function openBlobInNewTab(fetcher: () => Promise<Blob>) {
  const tab = window.open("", "_blank");
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

export const api = {
  login: (email: string, password: string) => req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => req("/auth/me"),
  updateFavoritePages: (favorite_pages: string[]) => req("/auth/me/favorites", { method: "PATCH", body: JSON.stringify({ favorite_pages }) }),
  verifyPassword: (password: string) => req("/auth/verify-password", { method: "POST", body: JSON.stringify({ password }) }),
  departments: () => req("/auth/departments"),
  groups: () => req("/auth/groups"),
  requestDirectory: () => req("/auth/request-directory"),
  companyDirectory: () => req("/auth/request-directory?scope=company"),
  createDepartment: (name: string, sectionId?: string | null, managerUserId?: string | null, excoUserId?: string | null, active = true, hodUserId?: string | null) =>
    req("/auth/departments", { method: "POST", body: JSON.stringify({ name, section_id: sectionId, hod_user_id: hodUserId, manager_user_id: managerUserId, exco_user_id: excoUserId, active }) }),
  updateDepartment: (department: string, data: { name: string; section_id?: string | null; division_id?: string | null; hod_user_id?: string | null; manager_user_id?: string | null; exco_user_id?: string | null; active?: boolean; is_business_partner?: boolean; division_ids?: string[] }) =>
    req(`/auth/departments/${encodeURIComponent(department)}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteDepartment: (department: string) => req(`/auth/departments/${encodeURIComponent(department)}`, { method: "DELETE" }),
  completeProfile: (data: { full_name: string; department: string; division_id?: string | null; section_id?: string | null; team_id?: string | null; employment_type: string; employee_no?: string }) => req("/auth/complete-profile", { method: "POST", body: JSON.stringify(data) }),
  adminUsers: (divisionId?: string | null) => req(`/auth/users${divisionId ? `?division_id=${encodeURIComponent(divisionId)}` : ""}`),
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
  delegations: () => req("/auth/delegations"),
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
  resolveWorkflow: (requestType: string, department?: string, amount?: number, section?: string, advanceSubType?: string, requesterRole?: string) => {
    const params = [`requestType=${encodeURIComponent(requestType)}`];
    if (department) params.push(`department=${encodeURIComponent(department)}`);
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
  endDelegation: (id: string) => req(`/auth/delegations/${id}/end`, { method: "POST", body: JSON.stringify({}) }),
  adminFeaturePermissions: () => req("/auth/admin-feature-permissions"),
  updateAdminFeaturePermissions: (features: Record<string, string[]>) =>
    req("/auth/admin-feature-permissions", { method: "PUT", body: JSON.stringify({ features }) }),
  permissionGroups: () => req("/auth/permission-groups"),
  createPermissionGroup: (name: string) => req("/auth/permission-groups", { method: "POST", body: JSON.stringify({ name }) }),
  deletePermissionGroup: (name: string) => req(`/auth/permission-groups/${encodeURIComponent(name)}`, { method: "DELETE" }),
  setGroupVisibility: (name: string, hidden: boolean) =>
    req(`/auth/permission-groups/${encodeURIComponent(name)}/visibility`, { method: "PUT", body: JSON.stringify({ hidden }) }),

  advances: () => req("/advances?mine=true"),
  reconciliationReport: (from: string, to: string) =>
    req(`/advances/reconciliation-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  createAdvance: (data: any) => req("/advances", { method: "POST", body: JSON.stringify(data) }),
  // generic update endpoint; backend should allow editing fields such as type/requested_total/salary_month/etc
  updateAdvance: (id: string, data: any) => req(`/advances/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  // travel-specific lines update (rows)
  updateAdvanceLines: (id: string, data: any) => req(`/advances/${id}/lines`, { method: "PUT", body: JSON.stringify(data) }),
  submitAdvance: (id: string) => req(`/advances/${id}/submit`, { method: "POST", body: JSON.stringify({}) }),
  revokeAdvance: (id: string) => req(`/advances/${id}/revoke`, { method: "POST", body: JSON.stringify({}) }),
  remindAdvance: (id: string) => req(`/advances/${id}/remind`, { method: "POST", body: JSON.stringify({}) }),
  claims: () => req("/claims?mine=true"),
  createClaim: (data: any) => req("/claims", { method: "POST", body: JSON.stringify(data) }),
  updateClaim: (id: string, data: any) => req(`/claims/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  updateClaimTrips: (id: string, data: any) => req(`/claims/${id}/trips`, { method: "PUT", body: JSON.stringify(data) }),
  uploadClaimReceipt: (id: string, form: FormData) => req(`/claims/${id}/upload-receipt`, { method: "POST", body: form }),
  deleteClaimReceipt: (id: string, receiptId: string) => req(`/claims/${id}/receipts/${receiptId}`, { method: "DELETE" }),
  claimReceiptFileBlob: (id: string, receiptId: string) => fetchBlob(`/claims/${id}/receipts/${receiptId}/file`),
  submitClaim: (id: string) => req(`/claims/${id}/submit`, { method: "POST", body: JSON.stringify({}) }),

  inbox: () => req("/inbox"),
  myInboxActions: (limit = 50) => req(`/inbox/my-actions?limit=${limit}`),
  attendance: () => req("/attendance?mine=true"),
  attendanceDetail: (id: string) => req(`/attendance/${id}`),
  saveAttendance: (data: any) => req("/attendance", { method: "POST", body: JSON.stringify(data) }),
  updateAttendance: (id: string, data: any) => req(`/attendance/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  overtimeRequests: () => req("/overtime/requests"),
  overtimeRequestDetail: (id: string) => req(`/overtime/requests/${id}`),
  saveOvertimeRequest: (data: any) => req("/overtime/requests", { method: "POST", body: JSON.stringify(data) }),
  updateOvertimeRequest: (id: string, data: any) => req(`/overtime/requests/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  overtimeRequestApproveSupervisor: (id: string) => req(`/overtime/requests/${id}/approve-supervisor`, { method: "POST" }),
  overtimeRequestApproveHod: (id: string) => req(`/overtime/requests/${id}/approve-hod`, { method: "POST" }),
  overtimeRequestApproveCto: (id: string) => req(`/overtime/requests/${id}/approve-cto`, { method: "POST" }),
  overtimeRequestReject: (id: string, reason?: string) => req(`/overtime/requests/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),
  overtimeClaims: () => req("/overtime/claims"),
  overtimeClaimDetail: (id: string) => req(`/overtime/claims/${id}`),
  saveOvertimeClaim: (data: any) => req("/overtime/claims", { method: "POST", body: JSON.stringify(data) }),
  updateOvertimeClaim: (id: string, data: any) => req(`/overtime/claims/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  overtimeClaimAuthorise: (id: string) => req(`/overtime/claims/${id}/authorise`, { method: "POST" }),
  overtimeClaimHrNote: (id: string, data: any) => req(`/overtime/claims/${id}/hr-note`, { method: "POST", body: JSON.stringify(data) }),
  overtimeClaimFinanceVerify: (id: string, data: any) => req(`/overtime/claims/${id}/finance-verify`, { method: "POST", body: JSON.stringify(data) }),
  overtimeClaimRecordEarnings: (id: string, data: any) => req(`/overtime/claims/${id}/record-earnings`, { method: "POST", body: JSON.stringify(data) }),
  overtimeClaimTransferSummary: (id: string, data: any) => req(`/overtime/claims/${id}/transfer-summary`, { method: "POST", body: JSON.stringify(data) }),
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
  confirmAdvanceNotCleared: (id: string) => req(`/advances/${id}/confirm-not-cleared`, { method: "POST" }),
  createAccommodationRequest: (data: any) => req("/accommodation-requests", { method: "POST", body: JSON.stringify(data) }),
  uploadAccommodationQuotation: (id: string, form: FormData) => req(`/accommodation-requests/${id}/upload-quotation`, { method: "POST", body: form }),
  sendAccommodationToFinance: (id: string) => req(`/accommodation-requests/${id}/send-to-finance`, { method: "POST", body: JSON.stringify({}) }),
  accommodationDetail: (id: string) => req(`/accommodation-requests/${id}`),
  markAccommodationPaid: (id: string, paid_reference: string) =>
    req(`/accommodation-requests/${id}/mark-paid`, { method: "POST", body: JSON.stringify({ paid_reference }) }),
  rejectAccommodation: (id: string, comments: string) =>
    req(`/accommodation-requests/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  advanceHistory: (id: string) => req(`/advances/${id}/history`),
  claimDetail: (id: string) => req(`/claims/${id}`),

  rollbackAdvance: (id: string, comments?: string) => req(`/advances/${id}/rollback`, { method: "POST", body: JSON.stringify({ comments }) }),
  advancePdf: (id: string) => fetchBlob(`/advances/${id}/pdf`),
  rejectAdvance: (id: string, comments: string) => req(`/advances/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  approveAdvance: (id: string, approved_total: number, comments?: string) =>
    req(`/advances/${id}/approve`, { method: "POST", body: JSON.stringify({ approved_total, comments }) }),
  markAdvancePaid: (id: string) => req(`/advances/${id}/mark-paid`, { method: "POST", body: JSON.stringify({}) }),
  payments: (params: { status?: "pending" | "paid" | "all"; limit?: number; offset?: number } = {}) =>
    req(`/advances/payments?${new URLSearchParams(params as any).toString()}`),

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
  markClaimSettled: (id: string, settled_method?: "PAYROLL" | "ECOCASH" | "BANK" | "CASH" | "OTHER", settled_reference?: string) =>
    req(`/claims/${id}/mark-settled`, { method: "POST", body: JSON.stringify({ settled_method, settled_reference }) }),
  // Hotels (accommodation)
  hotels: () => req("/accommodation/hotels"),
  createHotel: (data: any) => req("/accommodation/hotels", { method: "POST", body: JSON.stringify(data) }),
  updateHotel: (id: string, data: any) => req(`/accommodation/hotels/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteHotel: (id: string) => req(`/accommodation/hotels/${id}`, { method: "DELETE" }),
  mealValue: () => req("/accommodation/meal-value"),
  updateMealValue: (meal_value: number) => req("/accommodation/meal-value", { method: "PUT", body: JSON.stringify({ meal_value }) }),

  requestTypes: () => req("/request-types"),
  requestTypeDetail: (id: string) => req(`/request-types/${id}`),
  createRequestType: (data: any) => req("/request-types", { method: "POST", body: JSON.stringify(data) }),
  updateRequestType: (id: string, data: any) => req(`/request-types/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRequestType: (id: string) => req(`/request-types/${id}`, { method: "DELETE" }),
  updateRequestTypeFields: (id: string, fields: any[]) => req(`/request-types/${id}/fields`, { method: "PUT", body: JSON.stringify(fields) }),
  requestTypePermissions: (id: string) => req(`/request-types/${id}/permissions`),
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

  travelTypes: () => req("/travel/types"),
  createTravelType: (data: any) => req("/travel/types", { method: "POST", body: JSON.stringify(data) }),
  updateTravelType: (id: string, data: any) => req(`/travel/types/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTravelType: (id: string) => req(`/travel/types/${id}`, { method: "DELETE" }),
  createTravelLocation: (data: any) => req("/travel/locations", { method: "POST", body: JSON.stringify(data) }),
  updateTravelLocation: (id: string, data: any) => req(`/travel/locations/${id}`, { method: "PUT", body: JSON.stringify(data) }),

  deductionsAccess: () => req("/deductions/access"),
  deductions: () => req("/deductions"),
  setDeductionVrDate: (id: string, vr_date: string | null) =>
    req(`/deductions/${id}/vr-date`, { method: "PATCH", body: JSON.stringify({ vr_date }) }),
  setDeductionActioned: (id: string, deducted: boolean) =>
    req(`/deductions/${id}/deducted`, { method: "PATCH", body: JSON.stringify({ deducted }) }),
  deductionAccessGroups: () => req("/deductions/access-groups"),
  setDeductionAccessGroups: (groups: string[]) => req("/deductions/access-groups", { method: "PUT", body: JSON.stringify({ groups }) })
};
