import { query, withTransaction } from "./db.js";
import { logger } from "./logger.js";
import { getDepartmentLeadership, getSectionLeadership, getTeamLeadership, normalizeDepartmentName } from "./departments.js";

// Reporting lines and the Workflow Builder's "Manager" steps work from the
// same rule. Every employee's immediate manager according to Org Structure
// (computeOrgManager) is kept on reporting_line_org, and anyone without a
// reporting line set by hand gets an AUTOMATIC line equal to it - so a
// workflow routes to exactly who Reporting Lines shows. A line set by hand
// (source MANUAL) always wins and is never overwritten; clearing it lets the
// automatic one come back.

export type OrgManager = {
  manager_id: string | null;
  // Which Org Structure unit it came from (UI names): Section = teams,
  // Department = sections, Division = departments.
  basis: "CEO" | "Section" | "Department" | "Division" | null;
  // More than one person holds that role in that unit, so the pick is a guess.
  ambiguous: boolean;
};

// A MANAGER manages their own Section. When someone's Section has no manager,
// a MANAGER who sits in a different Section of the same Department/Division
// is not borrowed - it skips to the next level (HOD, then EXCO) instead
// (user's rule, 2026-11-05: Thabiso Phusumane, alone in Network & Information
// Security, had been given the IT Manager from the next Section). Only a
// MANAGER of the wider unit itself (not placed in a narrower one) counts, or
// a Division manager an admin assigned explicitly on the Division.
async function wideUnitManagers<T extends { id: string }>(level: "Department" | "Division", unit: string, candidates: T[]): Promise<T[]> {
  if (!candidates.length) return candidates;
  if (level === "Division") {
    const explicit = (await query<{ manager_user_id: string | null }>(
      `SELECT manager_user_id FROM departments WHERE lower(trim(name)) = lower($1) LIMIT 1`, [normalizeDepartmentName(unit)]
    ))[0]?.manager_user_id;
    if (explicit && candidates.some((c) => c.id === explicit)) return candidates;
  }
  const kept = new Set((await query<{ id: string }>(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role::text = 'MANAGER' AND team_id IS NULL
        ${level === "Division" ? "AND section_id IS NULL" : ""}`,
    [candidates.map((c) => c.id)]
  )).map((r) => r.id));
  return candidates.filter((c) => kept.has(c.id));
}

// The workflow engine's manager resolution (resolveRequesterManager) uses this
// for someone with no reporting line: EXCO -> CEO; otherwise the closest unit
// first - their Section (team), then Department (section), then Division -
// HOD -> EXCO, MANAGER -> HOD/EXCO, everyone else -> MANAGER/HOD/EXCO, where
// a Department's or Division's MANAGER only counts per wideUnitManagers.
export async function computeOrgManager(userId: string): Promise<OrgManager> {
  const user = (await query<{ role: string; department: string | null; section_id: string | null; team_id: string | null }>(
    `SELECT role::text AS role, department, section_id, team_id FROM users WHERE id = $1`, [userId]
  ))[0];
  const none: OrgManager = { manager_id: null, basis: null, ambiguous: false };
  if (!user || user.role === "CEO") return none;

  if (user.role === "EXCO") {
    const ceos = await query<{ id: string }>(`SELECT id FROM users WHERE role::text = 'CEO' AND is_active = true ORDER BY full_name`);
    return ceos[0] && ceos[0].id !== userId ? { manager_id: ceos[0].id, basis: "CEO", ambiguous: ceos.length > 1 } : none;
  }

  type Leadership = { hod_user_id: string | null; manager_user_id: string | null; exco_user_id: string | null };
  const pick = (l: Leadership): { id: string | null; role: "HOD" | "MANAGER" | "EXCO" | null } => {
    const order: Array<["HOD" | "MANAGER" | "EXCO", string | null]> =
      user.role === "HOD" ? [["EXCO", l.exco_user_id]]
      : user.role === "MANAGER" ? [["HOD", l.hod_user_id], ["EXCO", l.exco_user_id]]
      : [["MANAGER", l.manager_user_id], ["HOD", l.hod_user_id], ["EXCO", l.exco_user_id]];
    // Same as the workflow engine: the first holder in order; if that's the
    // person themselves, this unit gives no answer and the next one up is tried.
    for (const [role, id] of order) if (id) return id === userId ? { id: null, role: null } : { id, role };
    return { id: null, role: null };
  };
  // How many active people hold that role in that unit (a section with no
  // literal MANAGER uses its HODs as managers - see getSectionLeadership).
  const holders = async (column: "team_id" | "section_id", unitId: string, role: string) =>
    Number((await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE ${column} = $1 AND role::text = $2 AND is_active = true AND id <> $3`, [unitId, role, userId]
    ))[0]?.n ?? 0);

  if (user.team_id) {
    const p = pick(await getTeamLeadership(user.team_id));
    if (p.id) return { manager_id: p.id, basis: "Section", ambiguous: (await holders("team_id", user.team_id, p.role!)) > 1 };
  }
  if (user.section_id) {
    const sl = await getSectionLeadership(user.section_id);
    const managers = await wideUnitManagers("Department", user.section_id, sl.managers);
    const l = { ...sl, manager_user_id: managers[0]?.id ?? null, managers };
    const p = pick(l);
    if (p.id) {
      const pool = p.role === "MANAGER" ? l.managers : p.role === "HOD" ? l.hods : l.excos;
      return { manager_id: p.id, basis: "Department", ambiguous: pool.filter((x) => x.id !== userId).length > 1 };
    }
  }
  if (user.department) {
    const dl = await getDepartmentLeadership(user.department);
    const managers = await wideUnitManagers("Division", user.department, dl.managers ?? []);
    const l = { ...dl, manager_user_id: managers[0]?.id ?? null, managers };
    const p = pick(l);
    if (p.id) {
      const pool = p.role === "MANAGER" ? l.managers : p.role === "HOD" ? l.hods : l.excos;
      return { manager_id: p.id, basis: "Division", ambiguous: (pool ?? []).filter((x: { id: string }) => x.id !== userId).length > 1 };
    }
  }
  return none;
}

export async function ensureReportingLineSyncSchema() {
  await query(`ALTER TABLE reporting_lines ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'MANUAL'`);
  await query(`
    CREATE TABLE IF NOT EXISTS reporting_line_org (
      employee_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      manager_id uuid REFERENCES users(id) ON DELETE SET NULL,
      basis text,
      ambiguous boolean NOT NULL DEFAULT false,
      computed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export type SyncResult = { created: number; updated: number; removed: number; manualDiffers: number; ambiguous: number; noManager: number };

// Recompute everyone's Org Structure manager and bring AUTOMATIC lines in
// line with it. Serialized across nodes with an advisory lock, and the
// current lines are re-read inside the lock, so two PROD nodes syncing at
// once can't both insert a line.
export async function syncReportingLines(actorId: string | null = null): Promise<SyncResult> {
  const users = await query<{ id: string }>(`SELECT id FROM users WHERE is_active = true AND role::text NOT IN ('ADMIN')`);
  const computed = new Map<string, OrgManager>();
  for (const u of users) computed.set(u.id, await computeOrgManager(u.id));

  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('reporting_line_sync'))`);
    const result: SyncResult = { created: 0, updated: 0, removed: 0, manualDiffers: 0, ambiguous: 0, noManager: 0 };
    const lines = (await client.query<{ id: string; employee_id: string; manager_id: string | null; source: string }>(
      `SELECT id, employee_id, manager_id, source FROM reporting_lines WHERE is_active = true`
    )).rows;
    const lineOf = new Map(lines.map((l) => [l.employee_id, l]));

    for (const [employeeId, org] of computed) {
      await client.query(
        `INSERT INTO reporting_line_org (employee_id, manager_id, basis, ambiguous, computed_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (employee_id) DO UPDATE SET manager_id = EXCLUDED.manager_id, basis = EXCLUDED.basis, ambiguous = EXCLUDED.ambiguous, computed_at = now()`,
        [employeeId, org.manager_id, org.basis, org.ambiguous]
      );
      if (org.ambiguous) result.ambiguous++;
      const line = lineOf.get(employeeId);
      if (line && line.source !== "AUTO") {
        if ((line.manager_id ?? null) !== (org.manager_id ?? null)) result.manualDiffers++;
        continue;
      }
      if (!org.manager_id) {
        result.noManager++;
        if (line) {
          await client.query(`UPDATE reporting_lines SET is_active = false, updated_at = now() WHERE id = $1`, [line.id]);
          result.removed++;
        }
        continue;
      }
      if (line && line.manager_id === org.manager_id) continue;
      if (line) await client.query(`UPDATE reporting_lines SET is_active = false, updated_at = now() WHERE id = $1`, [line.id]);
      await client.query(
        `INSERT INTO reporting_lines (employee_id, manager_id, effective_from, reason, created_by_id, source)
         VALUES ($1, $2, CURRENT_DATE, $3, $4, 'AUTO')`,
        [employeeId, org.manager_id, `From Org Structure (${org.basis})`, actorId]
      );
      if (line) result.updated++; else result.created++;
    }
    return result;
  });
}

// Debounced trigger for after Org Structure, a user's placement/role, or a
// reporting line changes - several edits in a row cause one sync.
let pending: NodeJS.Timeout | null = null;
export function scheduleReportingLineSync(delayMs = 5_000) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    syncReportingLines()
      .then((r) => { if (r.created || r.updated || r.removed) logger.info("reporting_lines_synced", r); })
      .catch((err) => logger.warn("reporting_lines_sync_failed", { error: String(err) }));
  }, delayMs);
}

export function startReportingLineSyncWorker() {
  scheduleReportingLineSync(90_000);
  setInterval(() => scheduleReportingLineSync(0), 30 * 60_000);
}
