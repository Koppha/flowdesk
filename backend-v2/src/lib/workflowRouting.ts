export const WORKFLOW_ROUTE_LABELS: Record<string, string> = {
  EMPLOYEE: "Employee",
  HOD: "HOD",
  MANAGER: "Manager",
  EXCO_OWNER: "EXCO Member",
  FINANCE: "Finance",
  HR_MANAGER_REVIEW: "HR Manager",
  HR_REVIEW: "HR Review",
  CEO: "CEO",
  PROCUREMENT: "Procurement",
  LEGAL_REVIEW: "Legal Review",
  TEAM_APPROVAL: "Team Approval"
};

export function normalizeWorkflowRouteCode(code: string | null | undefined, fallback: string | null | undefined = null) {
  const value = String(code || fallback || "").trim();
  return value ? value.toUpperCase().replace(/\s+/g, "_") : "CUSTOM";
}

export function workflowRouteLabel(code: string | null | undefined, fallback: string | null | undefined = null) {
  const normalized = normalizeWorkflowRouteCode(code, fallback);
  return WORKFLOW_ROUTE_LABELS[normalized] || fallback || normalized.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}
