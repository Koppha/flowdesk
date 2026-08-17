import { query } from "./db.js";

export type ManagerDelegation = {
  id: string;
  manager_id: string;
  delegate_id: string;
  department: string | null;
  from_date: string | null;
  to_date: string | null;
  active: boolean;
  reference: string | null;
  reason: string | null;
  comments: string | null;
  created_by: string | null;
  created_source: string;
  ended_by: string | null;
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
};

const DELEGATION_COLUMNS = `id, manager_id, delegate_id, department, from_date, to_date, active,
       reference, reason, comments, created_by, created_source, ended_by, ended_at, end_reason,
       created_at, updated_at`;

// A delegate can hold more than one active delegation at once (e.g. covering
// for two different managers simultaneously) - return all of them, not just
// one, so none are silently dropped.
//
// requestType is optional: a delegation with no rows in delegation_request_types
// applies to every request type (the original, unscoped behavior). A delegation
// with rows there only matches if one of them is in the given requestType(s) -
// pass an array so a caller can offer several acceptable tokens at once (e.g.
// a specific custom request type's own code, plus the broad "CUSTOM_WORKFLOW"
// bucket that covers every custom type).
export async function getActiveManagerDelegations(delegateId: string, requestType?: string | string[]): Promise<ManagerDelegation[]> {
  const requestTypes = requestType == null ? null : Array.isArray(requestType) ? requestType : [requestType];
  return query<ManagerDelegation>(
    `SELECT ${DELEGATION_COLUMNS}
       FROM manager_delegations md
      WHERE delegate_id = $1
        AND active = true
        AND (from_date IS NULL OR from_date <= current_date)
        AND (to_date IS NULL OR to_date >= current_date)
        AND (
          $2::text[] IS NULL
          OR NOT EXISTS (SELECT 1 FROM delegation_request_types drt WHERE drt.delegation_id = md.id)
          OR EXISTS (SELECT 1 FROM delegation_request_types drt WHERE drt.delegation_id = md.id AND drt.request_type_code = ANY($2::text[]))
        )
      ORDER BY created_at DESC`,
    [delegateId, requestTypes]
  );
}

export async function getDelegatedManagerIds(delegateId: string, requestType?: string | string[]): Promise<string[]> {
  const delegations = await getActiveManagerDelegations(delegateId, requestType);
  return delegations.map((d) => d.manager_id);
}

export async function getDelegationsForManager(managerId: string) {
  return query<ManagerDelegation>(
    `SELECT ${DELEGATION_COLUMNS}
       FROM manager_delegations md
      WHERE manager_id = $1
      ORDER BY created_at DESC`,
    [managerId]
  );
}

export async function getDelegationById(id: string) {
  const rows = await query<ManagerDelegation>(
    `SELECT ${DELEGATION_COLUMNS}
       FROM manager_delegations md
      WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// For callers that need to check many items of different request types
// against a delegate's delegations in a loop (e.g. the shared inbox listing) -
// one batch fetch instead of a query per item. `requestTypes: []` means the
// delegation is unscoped (matches everything).
export async function getActiveDelegationsWithTypes(delegateId: string): Promise<Array<{ managerId: string; requestTypes: string[] }>> {
  const delegations = await getActiveManagerDelegations(delegateId);
  if (!delegations.length) return [];
  const rows = await query<{ delegation_id: string; request_type_code: string }>(
    `SELECT delegation_id, request_type_code FROM delegation_request_types WHERE delegation_id = ANY($1::uuid[])`,
    [delegations.map((d) => d.id)]
  );
  const typesByDelegation = new Map<string, string[]>();
  for (const r of rows) {
    typesByDelegation.set(r.delegation_id, [...(typesByDelegation.get(r.delegation_id) || []), r.request_type_code]);
  }
  return delegations.map((d) => ({ managerId: d.manager_id, requestTypes: typesByDelegation.get(d.id) || [] }));
}

export async function getDelegationRequestTypes(delegationId: string): Promise<string[]> {
  const rows = await query<{ request_type_code: string }>(
    `SELECT request_type_code FROM delegation_request_types WHERE delegation_id = $1 ORDER BY request_type_code`,
    [delegationId]
  );
  return rows.map((r) => r.request_type_code);
}

export async function setDelegationRequestTypes(delegationId: string, requestTypes: string[]) {
  await query(`DELETE FROM delegation_request_types WHERE delegation_id = $1`, [delegationId]);
  for (const code of requestTypes) {
    await query(
      `INSERT INTO delegation_request_types (delegation_id, request_type_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [delegationId, code]
    );
  }
}

// Section-scoped delegations (e.g. Standby roster-creation, tagged
// request_type_code='STANDBY_ROSTER') are additionally scoped by team_id,
// which ordinary department-wide approval delegations don't use.
export async function isActiveTeamDelegate(delegateId: string, teamId: string, requestType: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT md.id
       FROM manager_delegations md
       JOIN delegation_request_types drt ON drt.delegation_id = md.id AND drt.request_type_code = $3
      WHERE md.delegate_id = $1
        AND md.team_id = $2
        AND md.active = true
        AND (md.from_date IS NULL OR md.from_date <= current_date)
        AND (md.to_date IS NULL OR md.to_date >= current_date)`,
    [delegateId, teamId, requestType]
  );
  return rows.length > 0;
}

export async function generateDelegationReference(): Promise<string> {
  const year = new Date().getFullYear();
  const rows = await query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(reference, '^DLG-\\d{4}-', ''), '')), '0')::int + 1 AS next_seq
       FROM manager_delegations
      WHERE reference LIKE $1`,
    [`DLG-${year}-%`]
  );
  const seq = Number(rows[0]?.next_seq ?? 1);
  return `DLG-${year}-${String(seq).padStart(6, "0")}`;
}

// Mirrors writeAdvanceAudit (advances.routes.ts) - same shared audit_log
// table, just scoped to entity_type='manager_delegations'.
export async function writeDelegationAudit(args: {
  actorId: string | null;
  delegationId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}) {
  await query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json)
     VALUES ($1,$2,'manager_delegations',$3,$4,$5)`,
    [args.actorId, args.action, args.delegationId, args.before ? JSON.stringify(args.before) : null, args.after ? JSON.stringify(args.after) : null]
  );
}
