// Single source of truth for role display names across admin pages —
// UserPicker, Employees, Managers, EXCO, etc. all read from this instead of
// keeping their own copies that can drift out of sync.

export const ROLE_LABELS: Record<string, string> = {
  EMPLOYEE:      "Employee",
  MANAGER:       "Manager",
  HOD:           "HOD",
  HR_MANAGER:    "HR Manager",
  EXCO:          "EXCO",
  CEO:           "CEO",
  ADMIN:         "Admin",
  FINANCE:       "Finance",
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "—";
  return ROLE_LABELS[role] ?? role;
}
