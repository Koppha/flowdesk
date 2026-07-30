import { query } from "./db.js";

const DEFAULT_GROUPS = ["EMPLOYEE", "HOD", "MANAGER", "EXCO", "CEO", "ADMIN"];

let ensured = false;

export async function ensurePermissionGroupTables() {
  if (ensured) return;
  await query(
    `CREATE TABLE IF NOT EXISTS permission_groups (
       name text PRIMARY KEY,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
    []
  );
  await query(
    `CREATE TABLE IF NOT EXISTS user_permission_groups (
       user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       group_name text NOT NULL REFERENCES permission_groups(name) ON DELETE CASCADE,
       PRIMARY KEY (user_id, group_name)
     )`,
    []
  );

  // Seed the default groups (one per legacy role) the first time, and assign
  // every existing user to the group matching their current role, so existing
  // feature-permission configuration keeps working unchanged.
  const existing = await query<{ count: string }>(`SELECT count(*)::text AS count FROM permission_groups`, []);
  if (Number(existing[0]?.count || 0) === 0) {
    for (const name of DEFAULT_GROUPS) {
      await query(`INSERT INTO permission_groups (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
    }
    await query(
      `INSERT INTO user_permission_groups (user_id, group_name)
       SELECT id, role::text FROM users
       ON CONFLICT DO NOTHING`,
      []
    );
  }

  await query(
    `CREATE TABLE IF NOT EXISTS hidden_permission_groups (
       group_name text PRIMARY KEY,
       hidden_at  timestamptz NOT NULL DEFAULT now()
     )`,
    []
  );

  ensured = true;
}

const ROLE_NAMES = ["EMPLOYEE", "HOD", "MANAGER", "EXCO", "CEO", "ADMIN"];

// Groups derived live from org structure (divisions/sections/teams/departments)
// and from each user's current role. Membership is computed on the fly, so it
// always reflects the current org structure and role assignments rather than
// a point-in-time snapshot.
export async function listOrgStructureGroups() {
  const roles = await query<{ name: string; member_count: string }>(
    `SELECT r.name, COALESCE(c.count, 0)::text AS member_count
       FROM (SELECT unnest($1::text[]) AS name) r
       LEFT JOIN (SELECT role::text AS name, count(*) AS count FROM users GROUP BY role) c
         ON c.name = r.name
      ORDER BY r.name`,
    [ROLE_NAMES]
  );
  const divisions = await query<{ name: string; member_count: string }>(
    `SELECT 'Division: ' || d.name AS name, count(u.id)::text AS member_count
       FROM divisions d
       LEFT JOIN users u ON u.division_id = d.id
      WHERE d.active
      GROUP BY d.name
      ORDER BY d.name`,
    []
  );
  // Union the formal departments catalog with departments actually in use on
  // users (free-text department field) - mirrors resolveDepartmentGroup()'s
  // pattern in departments.ts, since many departments only ever exist as
  // values on users and never get a formal `departments` row.
  const departments = await query<{ name: string; member_count: string }>(
    `SELECT 'Department: ' || dep.name AS name, count(u.id)::text AS member_count
       FROM (
         SELECT trim(name) AS name
           FROM departments
          WHERE trim(name) <> ''
            AND active = true
          UNION
         SELECT DISTINCT trim(department) AS name
           FROM users
          WHERE department IS NOT NULL
            AND trim(department) <> ''
            AND lower(trim(department)) NOT IN ('administration', 'administrator')
       ) dep
       LEFT JOIN users u ON trim(u.department) = dep.name
      GROUP BY dep.name
      ORDER BY dep.name`,
    []
  );
  const sections = await query<{ name: string; member_count: string }>(
    `SELECT 'Section: ' || s.name AS name, count(DISTINCT u.id)::text AS member_count
       FROM sections s
       LEFT JOIN teams t ON t.section_id = s.id
       LEFT JOIN users u ON u.section_id = s.id OR u.team_id = t.id
      WHERE s.active
      GROUP BY s.name
      ORDER BY s.name`,
    []
  );
  const teams = await query<{ name: string; member_count: string }>(
    `SELECT 'Team: ' || t.name AS name, count(u.id)::text AS member_count
       FROM teams t
       LEFT JOIN users u ON u.team_id = t.id
      WHERE t.active
      GROUP BY t.name
      ORDER BY t.name`,
    []
  );
  return [...roles, ...divisions, ...departments, ...sections, ...teams];
}

export async function listPermissionGroups() {
  await ensurePermissionGroupTables();
  const [custom, org, hidden] = await Promise.all([
    query<{ name: string; member_count: string }>(
      `SELECT pg.name, count(upg.user_id)::text AS member_count
         FROM permission_groups pg
         LEFT JOIN user_permission_groups upg ON upg.group_name = pg.name
        GROUP BY pg.name
        ORDER BY pg.name`,
      []
    ),
    listOrgStructureGroups(),
    query<{ group_name: string }>(`SELECT group_name FROM hidden_permission_groups`, [])
  ]);
  const orgNames = new Set(org.map((g) => g.name));
  const hiddenNames = new Set(hidden.map((h) => h.group_name));
  const merged = [
    ...org.map((g) => ({ ...g, dynamic: true, hidden: g.name !== "ADMIN" && hiddenNames.has(g.name) })),
    ...custom.filter((g) => !orgNames.has(g.name)).map((g) => ({ ...g, dynamic: false, hidden: hiddenNames.has(g.name) }))
  ];
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

export async function setGroupVisibility(name: string, hidden: boolean) {
  await ensurePermissionGroupTables();
  if (name === "ADMIN") return;
  if (hidden) {
    await query(`INSERT INTO hidden_permission_groups (group_name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
  } else {
    await query(`DELETE FROM hidden_permission_groups WHERE group_name=$1`, [name]);
  }
}

export async function createPermissionGroup(name: string) {
  await ensurePermissionGroupTables();
  await query(`INSERT INTO permission_groups (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
}

export async function deletePermissionGroup(name: string) {
  await ensurePermissionGroupTables();
  await query(`DELETE FROM permission_groups WHERE name=$1`, [name]);
  await query(`DELETE FROM hidden_permission_groups WHERE group_name=$1`, [name]);
  // Strip the deleted group from any feature-permission allow-lists
  await query(
    `UPDATE admin_feature_permissions SET allowed_roles = array_remove(allowed_roles, $1), updated_at = now()
      WHERE $1 = ANY(allowed_roles)`,
    [name]
  );
}

export async function getUserGroups(userId: string): Promise<string[]> {
  await ensurePermissionGroupTables();
  const custom = await query<{ group_name: string }>(
    `SELECT group_name FROM user_permission_groups WHERE user_id=$1 ORDER BY group_name`,
    [userId]
  );
  const rows = await query<{ role: string; division_name: string | null; department: string | null; section_name: string | null; team_name: string | null }>(
    `SELECT u.role::text AS role, dv.name AS division_name, u.department,
            s.name AS section_name, t.name AS team_name
       FROM users u
       LEFT JOIN divisions dv ON dv.id = u.division_id
       LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN sections s ON s.id = COALESCE(u.section_id, t.section_id)
      WHERE u.id=$1`,
    [userId]
  );
  const dynamic: string[] = [];
  const u = rows[0];
  if (u) {
    if (u.role) dynamic.push(u.role);
    if (u.division_name) dynamic.push(`Division: ${u.division_name}`);
    if (u.department) dynamic.push(`Department: ${u.department}`);
    if (u.section_name) dynamic.push(`Section: ${u.section_name}`);
    if (u.team_name) dynamic.push(`Team: ${u.team_name}`);
  }
  return Array.from(new Set([...custom.map((r) => r.group_name), ...dynamic]));
}

// Org-structure groups (roles, Division/Department/Section/Team) are derived
// automatically from live org data and can't be assigned manually - only
// admin-created custom groups can have members added/removed directly.
export async function isOrgStructureGroupName(name: string): Promise<boolean> {
  const org = await listOrgStructureGroups();
  return org.some((g) => g.name === name);
}

export async function setUserGroups(userId: string, groups: string[]) {
  await ensurePermissionGroupTables();
  const org = await listOrgStructureGroups();
  const orgNames = new Set(org.map((g) => g.name));
  // Org-structure groups are derived automatically and can't be assigned manually.
  const unique = Array.from(new Set(groups.filter((g) => typeof g === "string" && g.trim() && !orgNames.has(g))));
  await query(`DELETE FROM user_permission_groups WHERE user_id=$1`, [userId]);
  for (const name of unique) {
    await query(`INSERT INTO permission_groups (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
    await query(`INSERT INTO user_permission_groups (user_id, group_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, name]);
  }
}

// Individual membership management for one custom group at a time - used by
// the Roles & Permissions "Manage Columns" member picker, so an admin can
// grant a feature to specific people without editing a user's whole group set.
export async function listGroupMembers(groupName: string) {
  await ensurePermissionGroupTables();
  return query<{ id: string; full_name: string | null; email: string }>(
    `SELECT u.id, u.full_name, u.email
       FROM user_permission_groups upg
       JOIN users u ON u.id = upg.user_id
      WHERE upg.group_name = $1
      ORDER BY u.full_name NULLS LAST, u.email`,
    [groupName]
  );
}

export async function addGroupMember(groupName: string, userId: string) {
  await ensurePermissionGroupTables();
  await query(`INSERT INTO user_permission_groups (user_id, group_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, groupName]);
}

export async function removeGroupMember(groupName: string, userId: string) {
  await ensurePermissionGroupTables();
  await query(`DELETE FROM user_permission_groups WHERE user_id=$1 AND group_name=$2`, [userId, groupName]);
}
