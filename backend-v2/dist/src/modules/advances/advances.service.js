import { badRequest } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { AdvanceTransitions } from "./advances.types.js";
export function nextStatusOrThrow(current, action) {
    const next = AdvanceTransitions[current]?.[action];
    if (!next)
        throw badRequest(`Invalid transition: ${current} -> ${action}`);
    return next;
}
export async function getAdvanceById(id) {
    const rows = await query(`SELECT id, requester_id, created_by_id, status, requested_total, approved_total, type, purpose, payment_account FROM advance_requests WHERE id=$1`, [id]);
    return rows[0] ?? null;
}
export async function createAdvance(args) {
    const rows = await query(`INSERT INTO advance_requests
      (requester_id, created_by_id, type, purpose, project_number, payment_method, payment_account, requested_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`, [
        args.requesterId,
        args.createdById,
        args.type,
        args.purpose ?? null,
        args.project_number ?? null,
        args.payment_method,
        args.payment_account ?? null,
        args.requested_total
    ]);
    return rows[0].id;
}
export async function setAdvanceStatus(id, status, extras) {
    if (typeof extras?.approvedTotal === "number") {
        await query(`UPDATE advance_requests SET status=$2, approved_total=$3, updated_at=now() WHERE id=$1`, [id, status, extras.approvedTotal]);
        return;
    }
    await query(`UPDATE advance_requests SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
}
