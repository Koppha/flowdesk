import { query } from "../../lib/db.js";
import { getStringSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";

// The IT Manager's preset pool of default assignees (see GET/PUT
// /it-provisioning/default-assignees), filtered to currently-active users.
// Read live rather than snapshotted per task, so removing someone from the
// pool stops them being offered new claims immediately.
export async function getDefaultAssigneeIds(): Promise<string[]> {
  const raw = await getStringSystemSetting(SYSTEM_SETTING_KEYS.defaultItProvisioningAssigneeIds);
  if (!raw) return [];
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) ids = parsed.filter((v) => typeof v === "string");
  } catch {
    return [];
  }
  if (!ids.length) return [];
  const rows = await query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_active = true`, [ids]);
  const activeSet = new Set(rows.map((r) => r.id));
  return ids.filter((id) => activeSet.has(id));
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
  return inserted.id;
}
