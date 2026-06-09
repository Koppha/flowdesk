import { useEffect, useState } from "react";
import { api } from "./api";

export type EmploymentType = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  sort_order: number;
};

const FALLBACK: EmploymentType[] = [
  { id: "PERMANENT", code: "PERMANENT", name: "Permanent", active: true, sort_order: 1 },
  { id: "INTERN",    code: "INTERN",    name: "Intern",    active: true, sort_order: 2 },
  { id: "TEMPORARY", code: "TEMPORARY", name: "Temporary", active: true, sort_order: 3 },
];

// Module-level cache so all components share one fetch per page load
let cache: EmploymentType[] | null = null;
const listeners: Array<(types: EmploymentType[]) => void> = [];

function notifyListeners(types: EmploymentType[]) {
  listeners.forEach(fn => fn(types));
}

export async function refreshEmploymentTypes(): Promise<EmploymentType[]> {
  try {
    const rows: EmploymentType[] = await api.employmentTypes();
    cache = Array.isArray(rows) && rows.length > 0 ? rows : FALLBACK;
  } catch {
    cache = cache ?? FALLBACK;
  }
  notifyListeners(cache);
  return cache;
}

export function useEmploymentTypes() {
  const [types, setTypes] = useState<EmploymentType[]>(cache ?? FALLBACK);

  useEffect(() => {
    let alive = true;
    const handler = (t: EmploymentType[]) => { if (alive) setTypes(t); };
    listeners.push(handler);

    if (!cache) {
      void refreshEmploymentTypes();
    }

    return () => {
      const idx = listeners.indexOf(handler);
      if (idx !== -1) listeners.splice(idx, 1);
      alive = false;
    };
  }, []);

  return types.filter(t => t.active !== false);
}
