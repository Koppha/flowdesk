import { badRequest } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { AdvanceAction, AdvanceStatus, AdvanceTransitions } from "./advances.types.js";

export function nextStatusOrThrow(current: AdvanceStatus, action: AdvanceAction): AdvanceStatus {
  const next = AdvanceTransitions[current]?.[action];
  if (!next) throw badRequest(`Invalid transition: ${current} -> ${action}`);
  return next;
}

export async function getAdvanceById(id: string) {
  const rows = await query<{
    id: string;
    requester_id: string;
    created_by_id: string;
    status: AdvanceStatus;
    requested_total: string;
    approved_total: string;
    type: string;
    purpose: string | null;
    payment_account: string | null;
    requester_department: string | null;
    override_chain: Array<{ label: string; user_id: string; user_name: string }> | null;
  }>(
    `SELECT ar.id, ar.requester_id, ar.created_by_id, ar.status, ar.requested_total, ar.approved_total, ar.type, ar.purpose, ar.payment_account,
            ar.override_chain,
            u.department AS requester_department
       FROM advance_requests ar
       JOIN users u ON u.id = ar.requester_id
      WHERE ar.id=$1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function createAdvance(args: {
  requesterId: string;
  createdById: string;
  type: string;
  purpose?: string | null;
  project_number?: string | null;
  payment_method: "ECOCASH" | "BANK";
  payment_account?: string | null;
  requested_total: number;
  override_chain?: Array<{ label: string; user_id: string; user_name: string }> | null;
}) {
  const rows = await query<{ id: string }>(
    `INSERT INTO advance_requests
      (requester_id, created_by_id, type, purpose, project_number, payment_method, payment_account, requested_total, override_chain)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      args.requesterId,
      args.createdById,
      args.type,
      args.purpose ?? null,
      args.project_number ?? null,
      args.payment_method,
      args.payment_account ?? null,
      args.requested_total,
      args.override_chain?.length ? JSON.stringify(args.override_chain) : null
    ]
  );

  return rows[0].id;
}

export async function setAdvanceStatus(id: string, status: AdvanceStatus, extras?: { approvedTotal?: number }) {
  if (typeof extras?.approvedTotal === "number") {
    await query(`UPDATE advance_requests SET status=$2, approved_total=$3, updated_at=now() WHERE id=$1`, [id, status, extras.approvedTotal]);
    return;
  }
  await query(`UPDATE advance_requests SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
}
