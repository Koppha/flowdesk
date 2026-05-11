const API = (import.meta.env.VITE_API as string) || "http://localhost:4000";

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
  const res = await fetch(`${API}${path}`, { ...options, headers });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(formatApiError(json, res.statusText));
  return json;
}

export const api = {
  login: (email: string, password: string) => req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => req("/auth/me"),
  departments: () => req("/auth/departments"),
  groups: () => req("/auth/groups"),
  requestDirectory: () => req("/auth/request-directory"),
  createDepartment: (name: string) => req("/auth/departments", { method: "POST", body: JSON.stringify({ name }) }),
  completeProfile: (data: any) => req("/auth/complete-profile", { method: "POST", body: JSON.stringify(data) }),
  adminUsers: () => req("/auth/users"),
  updateUserRole: (id: string, data: any) => req(`/auth/users/${id}/role`, { method: "POST", body: JSON.stringify(data) }),
  updateUserDepartment: (id: string, data: any) => req(`/auth/users/${id}/department`, { method: "POST", body: JSON.stringify(data) }),
  updateUserGroup: (id: string, data: any) => req(`/auth/users/${id}/group`, { method: "POST", body: JSON.stringify(data) }),
  updateDepartmentRole: (department: string, data: any) =>
    req(`/auth/departments/${encodeURIComponent(department)}/role`, { method: "POST", body: JSON.stringify(data) }),
  delegations: () => req("/auth/delegations"),
  createDelegation: (data: any) => req("/auth/delegations", { method: "POST", body: JSON.stringify(data) }),
  endDelegation: (id: string) => req(`/auth/delegations/${id}/end`, { method: "POST", body: JSON.stringify({}) }),

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
  overtimeClaims: () => req("/overtime/claims"),
  overtimeClaimDetail: (id: string) => req(`/overtime/claims/${id}`),
  saveOvertimeClaim: (data: any) => req("/overtime/claims", { method: "POST", body: JSON.stringify(data) }),
  updateOvertimeClaim: (id: string, data: any) => req(`/overtime/claims/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  aiAnomalies: () => req("/ai/anomalies"),
  aiNlReport: (prompt: string) => req("/ai/nl-report", { method: "POST", body: JSON.stringify({ prompt }) }),
  aiOcrExtract: (text: string) => req("/ai/ocr-extract", { method: "POST", body: JSON.stringify({ text }) }),

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

  countersignAdvance: (id: string, comments?: string) => req(`/advances/${id}/countersign`, { method: "POST", body: JSON.stringify({ comments }) }),
  rollbackAdvance: (id: string, comments?: string) => req(`/advances/${id}/rollback`, { method: "POST", body: JSON.stringify({ comments }) }),
  rejectAdvance: (id: string, comments: string) => req(`/advances/${id}/reject`, { method: "POST", body: JSON.stringify({ comments }) }),
  approveAdvance: (id: string, approved_total: number, comments?: string) =>
    req(`/advances/${id}/approve`, { method: "POST", body: JSON.stringify({ approved_total, comments }) }),
  markAdvancePaid: (id: string, paid_reference: string) => req(`/advances/${id}/mark-paid`, { method: "POST", body: JSON.stringify({ paid_reference }) }),

  managerApproveClaim: (id: string, comments?: string) => req(`/claims/${id}/manager-approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  authApproveClaim: (id: string, comments?: string) => req(`/claims/${id}/auth-officer-approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  chiefApproveClaim: (id: string, comments?: string) => req(`/claims/${id}/chief-officer-approve`, { method: "POST", body: JSON.stringify({ comments }) }),
  financeVerifyClaim: (id: string, comments?: string) => req(`/claims/${id}/finance-verify`, { method: "POST", body: JSON.stringify({ comments }) }),
  settleClaim: (id: string, settled_method: "ECOCASH" | "BANK" | "CASH" | "OTHER", settled_reference: string) =>
    req(`/claims/${id}/settle`, { method: "POST", body: JSON.stringify({ settled_method, settled_reference }) })
};
