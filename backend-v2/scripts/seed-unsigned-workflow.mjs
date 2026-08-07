/**
 * Creates the "Unsigned" claim workflow templates:
 *  - "Unsigned" (STICKY, default flow): HR Officer -> Human Resource (Team) -> Finance (Financial Account)
 *  - "Unsigned - Temporary" (TEMPORARY): Countersign -> Approver
 *
 * Both are created INACTIVE; an admin switches the default flow ON via the
 * Workflow Builder, and can manually fill in / activate the temporary chain
 * (assigning approvers) to take precedence before falling back to the default flow.
 *
 * Run once: node scripts/seed-unsigned-workflow.mjs
 */

import pg from "pg";

const { Client } = pg;

const DB_URL = process.env.DATABASE_URL
  || "postgres://postgres:Admin%40ETL111%23%23@10.3.10.59:5432/advance_request";

async function createWorkflow(client, { name, description, workflowType, steps }) {
  const existing = await client.query(
    `SELECT id FROM workflows WHERE name=$1 AND request_type='CLAIM_REQUEST' LIMIT 1`,
    [name]
  );
  if (existing.rows.length > 0) {
    console.log(`  SKIP  "${name}" — already exists`);
    return;
  }

  const workflow = (
    await client.query(
      `INSERT INTO workflows (name, request_type, description, status, workflow_type)
         VALUES ($1, 'CLAIM_REQUEST', $2, 'INACTIVE', $3)
       RETURNING id`,
      [name, description, workflowType]
    )
  ).rows[0];

  for (const step of steps) {
    await client.query(
      `INSERT INTO workflow_steps
         (workflow_id, step_order, position_type_code, position_name, description,
          is_required, is_final_approval, approval_group_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        workflow.id,
        step.order,
        step.code,
        step.name,
        step.description || null,
        step.required ?? true,
        step.final ?? false,
        step.group || null
      ]
    );
  }

  console.log(`  OK    "${name}" (${workflowType}) — ${steps.length} step(s)`);
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log("Connected to database.");

  await createWorkflow(client, {
    name: "Unsigned",
    description: "Default flow for unsigned claim documents",
    workflowType: "STICKY",
    steps: [
      { order: 1, code: "HR_OFFICER", name: "HR Officer" },
      { order: 2, code: "HR_REVIEW", name: "Human Resource (Team)", group: "Human Resource Team" },
      { order: 3, code: "FINANCE", name: "Finance", group: "Financial Account", final: true }
    ]
  });

  await createWorkflow(client, {
    name: "Unsigned - Temporary",
    description: "Manually-entered temporary flow that takes precedence over the Unsigned default flow",
    workflowType: "TEMPORARY",
    steps: [
      { order: 1, code: "HOD", name: "Countersign" },
      { order: 2, code: "APPROVER", name: "Approver" }
    ]
  });

  await client.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
