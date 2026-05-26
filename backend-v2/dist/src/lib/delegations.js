import { query } from "./db.js";
export async function getActiveManagerDelegation(delegateId) {
    const rows = await query(`SELECT id, manager_id, delegate_id, department, from_date, to_date, active, created_at, updated_at
       FROM manager_delegations
      WHERE delegate_id = $1
        AND active = true
        AND (from_date IS NULL OR from_date <= current_date)
        AND (to_date IS NULL OR to_date >= current_date)
      LIMIT 1`, [delegateId]);
    return rows[0] ?? null;
}
export async function getDelegationsForManager(managerId) {
    return query(`SELECT id, manager_id, delegate_id, department, from_date, to_date, active, created_at, updated_at
       FROM manager_delegations
      WHERE manager_id = $1
      ORDER BY created_at DESC`, [managerId]);
}
export async function getDelegationById(id) {
    const rows = await query(`SELECT id, manager_id, delegate_id, department, from_date, to_date, active, created_at, updated_at
       FROM manager_delegations
      WHERE id = $1`, [id]);
    return rows[0] ?? null;
}
