import { useEffect, useState } from "react";
import { api } from "./api";

// Single source of truth for the admin user/staff list — every admin page
// (Employees, Managers, EXCO, CEO, etc.) reads from this shared cache instead
// of issuing its own independent fetch+filter, so a person always shows up
// consistently regardless of which page is asking (e.g. an HOD is still staff
// and must appear in the general directory, not just the Managers view).

export type StaffMember = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no?: string | null;
  title?: string | null;
  department?: string | null;
  division_id?: string | null;
  division_name?: string | null;
  section_id?: string | null;
  section_name?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  employment_type?: string | null;
  role: string;
  is_active?: boolean;
  profile_completed?: boolean;
  created_at?: string;
  updated_at?: string;
};

const CACHE_TTL_MS = 90_000; // 90 seconds — auto-refresh if cache is stale on mount

let cache: StaffMember[] | null = null;
let cacheAt = 0;
let inflight: Promise<StaffMember[]> | null = null;
const listeners: Array<(staff: StaffMember[]) => void> = [];

function notifyListeners(staff: StaffMember[]) {
  listeners.forEach((fn) => fn(staff));
}

export async function refreshStaffDirectory(): Promise<StaffMember[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await api.adminUsers();
      cache = Array.isArray(rows) ? rows : [];
      cacheAt = Date.now();
    } catch {
      cache = cache ?? [];
    } finally {
      inflight = null;
    }
    notifyListeners(cache!);
    return cache!;
  })();
  return inflight;
}

/**
 * Shared admin staff directory. Returns everyone regardless of role — pages
 * that need a subset (Employees, Managers, EXCO…) should filter `staff`
 * themselves rather than fetching their own copy, so additions/edits made
 * anywhere are reflected everywhere on the next refresh.
 *
 * The cache auto-refreshes on mount if it is older than CACHE_TTL_MS so that
 * self-onboarded users appear promptly without requiring a manual Refresh.
 */
export function useStaffDirectory() {
  const [staff, setStaff] = useState<StaffMember[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    let alive = true;
    const handler = (s: StaffMember[]) => { if (alive) { setStaff(s); setLoading(false); } };
    listeners.push(handler);

    const isStale = !cache || (Date.now() - cacheAt > CACHE_TTL_MS);
    if (isStale) {
      void refreshStaffDirectory();
    } else {
      setLoading(false);
    }

    return () => {
      const idx = listeners.indexOf(handler);
      if (idx !== -1) listeners.splice(idx, 1);
      alive = false;
    };
  }, []);

  async function reload() {
    setLoading(true);
    await refreshStaffDirectory();
  }

  return { staff, loading, reload };
}

export const ACTIVE_STAFF_ROLES = [
  "EMPLOYEE", "HOD", "MANAGER", "HR_MANAGER", "AUTH_OFFICER", "CHIEF_OFFICER", "FINANCE", "EXCO", "CEO",
];

export function isActiveStaff(u: StaffMember): boolean {
  return u.is_active !== false;
}
