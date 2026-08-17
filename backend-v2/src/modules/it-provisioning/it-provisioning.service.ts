import { query } from "../../lib/db.js";

// Called once, right when a COMPUTER_REQUEST submission's approval chain
// completes (see performCustomRequestAction in custom-requests.routes.ts).
// Seeds the task's checklist/software from whichever admin-configured
// templates apply to this computer type ('ALL' templates always apply,
// plus any scoped specifically to LAPTOP/DESKTOP) - a snapshot at creation
// time, since templates can change later without retroactively altering
// tasks already in progress.
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

  const inserted = (await query<{ id: string }>(
    `INSERT INTO it_provisioning_tasks (submission_id, status, checklist, software)
     VALUES ($1, 'AWAITING_PROVISIONING', $2, $3)
     RETURNING id`,
    [submissionId, JSON.stringify(checklist), JSON.stringify(software)]
  ))[0];
  return inserted.id;
}
