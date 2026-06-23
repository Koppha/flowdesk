export const WORKFLOW_ROUTE_LABELS = {
    EMPLOYEE: "Employee",
    HOD: "HOD",
    MANAGER: "Manager",
    FINANCE: "Finance",
    HR_MANAGER_REVIEW: "HR Manager",
    HR_REVIEW: "HR Review",
    CEO: "CEO",
    PROCUREMENT: "Procurement",
    LEGAL_REVIEW: "Legal Review",
    TEAM_APPROVAL: "Team Approval"
};
export function normalizeWorkflowRouteCode(code, fallback = null) {
    const value = String(code || fallback || "").trim();
    return value ? value.toUpperCase().replace(/\s+/g, "_") : "CUSTOM";
}
export function workflowRouteLabel(code, fallback = null) {
    const normalized = normalizeWorkflowRouteCode(code, fallback);
    return WORKFLOW_ROUTE_LABELS[normalized] || fallback || normalized.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}
