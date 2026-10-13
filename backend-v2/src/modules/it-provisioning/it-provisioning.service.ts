import { query } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { getStringSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { notifyItProvisioningOfficers, notifyItProvisioningRequester } from "../../lib/notifications.js";

// The IT Manager's one-time "who provisions Computer Requests" setting: whole
// teams and/or individual people. Stored as {user_ids, team_ids}; the older
// plain array of user ids is still read as user_ids.
export type ProvisioningPool = { user_ids: string[]; team_ids: string[] };

export async function getProvisioningPoolSetting(): Promise<ProvisioningPool> {
  const raw = await getStringSystemSetting(SYSTEM_SETTING_KEYS.defaultItProvisioningAssigneeIds);
  const empty = { user_ids: [], team_ids: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    if (Array.isArray(parsed)) return { user_ids: strings(parsed), team_ids: [] };
    return { user_ids: strings(parsed?.user_ids), team_ids: strings(parsed?.team_ids) };
  } catch {
    return empty;
  }
}

// Everyone currently in the pool: the named people plus every active member
// of the named teams. Read live, so someone joining or leaving a team (or
// being deactivated) is picked up immediately.
export async function getDefaultAssigneeIds(): Promise<string[]> {
  const pool = await getProvisioningPoolSetting();
  if (!pool.user_ids.length && !pool.team_ids.length) return [];
  const rows = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE is_active = true AND (id = ANY($1::uuid[]) OR team_id = ANY($2::uuid[]))
      ORDER BY full_name`,
    [pool.user_ids, pool.team_ids]
  );
  return rows.map((r) => r.id);
}

export async function isInProvisioningPool(userId: string): Promise<boolean> {
  return (await getDefaultAssigneeIds()).includes(userId);
}

// Called once, right when a COMPUTER_REQUEST submission's approval chain
// completes (see performCustomRequestAction in custom-requests.routes.ts).
// Seeds the task's checklist/software from whichever admin-configured
// templates apply to this computer type ('ALL' templates always apply,
// plus any scoped specifically to LAPTOP/DESKTOP) - a snapshot at creation
// time, since templates can change later without retroactively altering
// tasks already in progress. Also applies the IT Manager's default-assignee
// preset: exactly one preset officer auto-assigns directly (same as before);
// more than one leaves the task unassigned but claimable by any of them
// (see POST /:id/claim) - first to claim it gets it, rather than the system
// guessing who should have it.
export async function createProvisioningTaskForSubmission(submissionId: string, computerType: string | null | undefined) {
  const existing = (await query<{ id: string }>(`SELECT id FROM it_provisioning_tasks WHERE submission_id = $1`, [submissionId]))[0];
  if (existing) return existing.id;

  const type = String(computerType || "").toUpperCase();
  const checklistRows = await query<{ label: string }>(
    `SELECT label FROM it_checklist_templates WHERE active = true AND (computer_type = 'ALL' OR computer_type = $1) ORDER BY sort_order`,
    [type]
  );
  const softwareRows = await query<{ name: string; is_standard: boolean }>(
    `SELECT name, is_standard FROM it_software_templates WHERE active = true AND (computer_type = 'ALL' OR computer_type = $1) ORDER BY sort_order`,
    [type]
  );

  const checklist = checklistRows.map((r) => ({ label: r.label, checked: false }));
  const software = softwareRows.map((r) => ({ name: r.name, status: "PENDING", is_standard: r.is_standard }));

  const defaultAssigneeIds = await getDefaultAssigneeIds();
  const singleAssigneeId = defaultAssigneeIds.length === 1 ? defaultAssigneeIds[0] : null;
  const initialStatus = singleAssigneeId ? "IN_PROGRESS" : "AWAITING_PROVISIONING";

  const inserted = (await query<{ id: string }>(
    `INSERT INTO it_provisioning_tasks (submission_id, status, assigned_to_id, checklist, software)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [submissionId, initialStatus, singleAssigneeId, JSON.stringify(checklist), JSON.stringify(software)]
  ))[0];

  // Let IT know it's their turn: the one preset officer, or the whole pool
  // when it's first-to-claim.
  const notifyIds = singleAssigneeId ? [singleAssigneeId] : defaultAssigneeIds;
  if (notifyIds.length) {
    const recipients = await query<{ email: string | null; name: string | null }>(
      `SELECT email, full_name AS name FROM users WHERE id = ANY($1::uuid[])`, [notifyIds]
    );
    const requester = await getTaskRequester(inserted.id);
    void notifyItProvisioningOfficers({
      taskId: inserted.id, recipients, requesterName: requester?.full_name ?? null,
      event: singleAssigneeId ? "NEW_ASSIGNED" : "NEW_CLAIMABLE"
    });
    if (singleAssigneeId && requester) {
      const officer = recipients[0];
      void notifyItProvisioningRequester({
        taskId: inserted.id, requesterEmail: requester.email, requesterName: requester.full_name,
        stage: "ASSIGNED", officerName: officer?.name ?? null
      });
    }
  }
  return inserted.id;
}

export async function getTaskRequester(taskId: string) {
  return (await query<{ id: string; email: string | null; full_name: string | null }>(
    `SELECT u.id, u.email, u.full_name
       FROM it_provisioning_tasks t
       JOIN custom_request_submissions s ON s.id = t.submission_id
       JOIN users u ON u.id = s.requester_id
      WHERE t.id = $1`,
    [taskId]
  ))[0] ?? null;
}

// What the requester sees on their own Computer Request.
export async function getProvisioningStatusForSubmission(submissionId: string) {
  return (await query<{
    id: string; status: string; assigned_to_name: string | null; asset_number: string | null;
    provisioned_at: string | null; ready_for_collection_at: string | null; handed_over_at: string | null;
    collection_acknowledged_at: string | null; completed_at: string | null;
  }>(
    `SELECT t.id, t.status, ito.full_name AS assigned_to_name, d.asset_number,
            t.provisioned_at, t.ready_for_collection_at, t.handed_over_at,
            t.collection_acknowledged_at, t.completed_at
       FROM it_provisioning_tasks t
       LEFT JOIN users ito ON ito.id = t.assigned_to_id
       LEFT JOIN it_devices d ON d.id = t.device_id
      WHERE t.submission_id = $1`,
    [submissionId]
  ))[0] ?? null;
}

// The requester confirms they have the device: this is what completes the task.
export async function acknowledgeCollection(submissionId: string, userId: string) {
  const task = (await query<{ id: string; status: string; assigned_to_id: string | null; device_id: string | null }>(
    `SELECT id, status, assigned_to_id, device_id FROM it_provisioning_tasks WHERE submission_id = $1`, [submissionId]
  ))[0];
  if (!task) throw notFound("This request has no IT provisioning record yet");
  if (task.status === "COMPLETED") return;
  if (!["READY_FOR_COLLECTION", "HANDED_OVER"].includes(task.status)) {
    throw badRequest("Your computer isn't ready for collection yet");
  }
  await query(
    `UPDATE it_provisioning_tasks
        SET status = 'COMPLETED', collection_acknowledged_at = now(), collection_acknowledged_by_id = $1,
            handed_over_at = COALESCE(handed_over_at, now()), completed_at = now(), updated_at = now()
      WHERE id = $2`,
    [userId, task.id]
  );
  if (task.device_id) {
    await query(`UPDATE it_devices SET status = 'ASSIGNED', assigned_user_id = $1, updated_at = now() WHERE id = $2`, [userId, task.device_id]);
  }

  const requester = await getTaskRequester(task.id);
  const asset = task.device_id ? (await query<{ asset_number: string }>(`SELECT asset_number FROM it_devices WHERE id = $1`, [task.device_id]))[0]?.asset_number : null;
  void notifyItProvisioningRequester({
    taskId: task.id, requesterEmail: requester?.email ?? null, requesterName: requester?.full_name ?? null,
    stage: "COMPLETED", assetNumber: asset ?? null
  });
  if (task.assigned_to_id) {
    const officer = await query<{ email: string | null; name: string | null }>(`SELECT email, full_name AS name FROM users WHERE id = $1`, [task.assigned_to_id]);
    void notifyItProvisioningOfficers({ taskId: task.id, recipients: officer, requesterName: requester?.full_name ?? null, event: "COLLECTED" });
  }
}

// A replaced device's disposition, applied to the inventory. The old device
// is recorded if IT never captured it before (e.g. issued before FlowDesk).
const DISPOSITION_STATUS: Record<string, string> = { Repair: "IN_REPAIR", Store: "IN_STOCK", Dispose: "DISPOSED", Transfer: "ASSIGNED" };

export async function applyOldDeviceDisposition(args: {
  previousAssetNumber: string | null | undefined;
  disposition: string | null | undefined;
  transferToUserId: string | null | undefined;
  computerType: string | null;
}) {
  const asset = String(args.previousAssetNumber || "").trim();
  const status = args.disposition ? DISPOSITION_STATUS[args.disposition] : undefined;
  if (!asset || !status) return;
  if (args.disposition === "Transfer" && !args.transferToUserId) throw badRequest("Choose who the old device is being transferred to");
  const assignee = args.disposition === "Transfer" ? args.transferToUserId! : null;
  const existing = (await query<{ id: string }>(`SELECT id FROM it_devices WHERE lower(asset_number) = lower($1)`, [asset]))[0];
  if (existing) {
    await query(`UPDATE it_devices SET status = $1, assigned_user_id = $2, updated_at = now() WHERE id = $3`, [status, assignee, existing.id]);
  } else {
    await query(
      `INSERT INTO it_devices (asset_number, computer_type, status, assigned_user_id, notes) VALUES ($1, $2, $3, $4, $5)`,
      [asset, args.computerType, status, assignee, "Recorded from a replacement request"]
    );
  }
}
