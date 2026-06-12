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
  const headers: any = { ...(options.headers || {}) };

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

export const api = {
  login: (email: string, password: string) => req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => req("/auth/me"),
  departments: () => req("/auth/departments"),
  groups: () => req("/auth/groups"),
  requestDirectory: () => req("/auth/request-directory"),
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
  updateUserRole: (id: string, data: any) => req(`/auth/users/${id}/role`, { method: "POST", body: JSON.stringify(data) }),
  updateUserDepartment: (id: string, data: { department: string; division_id?: string | null; section_id?: string | null; team_id?: string | null }) => req(`/auth/users/${id}/department`, { method: "POST", body: JSON.stringify(data) }),
  updateUserGroup: (id: string, data: any) => req(`/auth/users/${id}/group`, { method: "POST", body: JSON.stringify(data) }),
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
  resolveWorkflow: (requestType: string, department?: string, amount?: number, section?: string, advanceSubType?: string) => {
    const params = [`requestType=${encodeURIComponent(requestType)}`];
    if (department) params.push(`department=${encodeURIComponent(department)}`);
    if (section) params.push(`section=${encodeURIComponent(section)}`);
    if (amount != null) params.push(`amount=${encodeURIComponent(String(amount))}`);
    if (advanceSubType) params.push(`advance_sub_type=${encodeURIComponent(advanceSubType)}`);
    return req(`/workflows/resolve?${params.join("&")}`);
  },
  chainApprovers: () => req("/workflows/chain-approvers"),
  workflowExcoMembers: () => req("/workflows/exco-members"),
  createDelegation: (data: any) => req("/auth/delegations", { method: "POST", body: JSON.stringify(data) }),
  endDelegation: (id: string) => req(`/auth/delegations/${id}/end`, { method: "POST", body: JSON.stringify({}) }),
  adminFeaturePermissions: () => req("/auth/admin-feature-permissions"),
  updateAdminFeaturePermissions: (features: Record<string, string[]>) =>
    req("/auth/admin-feature-permissions", { method: "PUT", body: JSON.stringify({ features }) }),

  advances: () => req("/advances?mine=true"),
  createAdvance: (data: any) => req("/advances", { method: "POST", body: JSON.stringify(data) }),
  // generic update endpoint; backend should allow editing fields such as type/requested_total/salary_month/etc
  updateAdvance: (id: string, data: any) => req(`/advances/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  // travel-specific lines update (rows)
  updateAdvanceLines: (id: string, data: any) => req(`/advances/${id}/lines`, { method: "PUT", body: JSON.stringify(data) }),
  submitAdvance: (id: string) => req(`/advances/${id}/submit`, { method: "POST", body: JSON.stringify({}) }),
  revokeAdvance: (id: string) => req(`/advances/${id}/revoke`, { method: "POST", body: JSON.stringify({}) }),
  claims: () => req("/claims?mine=true"),
  createClaim: (data: any) => req("/claims", { method: "POST", body: JSON.stringify(data) }),
  updateClaim: (id: string, data: any) => req(`/claims/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  updateClaimTrips: (id: string, data: any) => req(`/claims/${id}/trips`, { method: "PUT", body: JSON.stringify(data) }),
  uploadClaimReceipt: (id: string, form: FormData) => req(`/claims/${id}/upload-receipt`, { method: "POST", body: form }),
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
  advanceDetail: (id: string) => req(`/advances/${id}`),
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
  rejectAdvance: (id: string, comments: string) => req(`/advances/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  approveAdvance: (id: string, approved_total: number, comments?: string) =>
    req(`/advances/${id}/approve`, { method: "POST", body: JSON.stringify({ approved_total, comments }) }),
  markAdvancePaid: (id: string, paid_reference: string) => req(`/advances/${id}/mark-paid`, { method: "POST", body: JSON.stringify({ paid_reference }) }),

  approveClaim: (id: string, comments?: string) => req(`/claims/${id}/approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  rejectClaim: (id: string, comments: string) => req(`/claims/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  managerApproveClaim: (id: string, comments?: string) => req(`/claims/${id}/manager-approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  authApproveClaim: (id: string, comments?: string) => req(`/claims/${id}/auth-officer-approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  hrManagerApproveClaim: (id: string, comments?: string) => req(`/claims/${id}/hr-manager-approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  chiefApproveClaim: (id: string, comments?: string) => req(`/claims/${id}/chief-officer-approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  financeVerifyClaim: (id: string, comments?: string) => req(`/claims/${id}/finance-verify`, { method: "POST", body: JSON.stringify({ comments }) }),
  settleClaim: (id: string, settled_method: "ECOCASH" | "BANK" | "CASH" | "OTHER", settled_reference: string) =>
    req(`/claims/${id}/settle`, { method: "POST", body: JSON.stringify({ settled_method, settled_reference }) })
  ,
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
  updateTravelLocation: (id: string, data: any) => req(`/travel/locations/${id}`, { method: "PUT", body: JSON.stringify(data) })
};
