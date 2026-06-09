/**
 * Creates 20 EMPLOYEE users assigned to the "Technical" department.
 * Run once: node scripts/seed-technical-employees.mjs
 */

import bcrypt from "bcrypt";
import pg from "pg";
import { randomUUID } from "crypto";

const { Client } = pg;

const DB_URL = process.env.DATABASE_URL
  || "postgres://postgres:Admin%40ETL111%23%23@10.3.10.59:5432/advance_request";

// 20 employees with realistic Lesotho names
const EMPLOYEES = [
  { firstName: "Teboho",       surname: "Mokoena",    title: "Systems Analyst" },
  { firstName: "Lerato",       surname: "Ntlatlapa",  title: "Network Engineer" },
  { firstName: "Palesa",       surname: "Lekhotsa",   title: "IT Support Technician" },
  { firstName: "Mosihle",      surname: "Mokhesi",    title: "Software Developer" },
  { firstName: "Refiloe",      surname: "Lehohla",    title: "Database Administrator" },
  { firstName: "Thabo",        surname: "Nthako",     title: "Systems Engineer" },
  { firstName: "Nthabiseng",   surname: "Ramahlola",  title: "IT Support Technician" },
  { firstName: "Mpho",         surname: "Mokhele",    title: "Network Technician" },
  { firstName: "Mamello",      surname: "Motlomelo",  title: "Software Developer" },
  { firstName: "Limpho",       surname: "Selebalo",   title: "Systems Analyst" },
  { firstName: "Tsepiso",      surname: "Ntsoaki",    title: "Cybersecurity Analyst" },
  { firstName: "Nthabi",       surname: "Mabusetsa",  title: "Cloud Engineer" },
  { firstName: "Moleboheng",   surname: "Malerato",   title: "IT Project Coordinator" },
  { firstName: "Motlatsi",     surname: "Tšeole",     title: "Infrastructure Engineer" },
  { firstName: "Lineo",        surname: "Mamosa",     title: "Software Developer" },
  { firstName: "Thabang",      surname: "Mokoteli",   title: "Network Administrator" },
  { firstName: "Puseletso",    surname: "Molise",     title: "Systems Technician" },
  { firstName: "Mamokete",     surname: "Ramotseki",  title: "Data Analyst" },
  { firstName: "Ntsoaki",      surname: "Sefako",     title: "IT Support Specialist" },
  { firstName: "Selebalo",     surname: "Phafoli",    title: "Software Developer" },
];

const DEPARTMENT  = "Technical";
const DEFAULT_PASS = "Pass@2025!";
const EMP_PREFIX  = "ETL-T";

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log("Connected to database.");

  const hash = await bcrypt.hash(DEFAULT_PASS, 10);

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < EMPLOYEES.length; i++) {
    const emp = EMPLOYEES[i];
    const fullName   = `${emp.firstName} ${emp.surname}`;
    const emailLocal = `${emp.firstName.toLowerCase()}.${emp.surname.toLowerCase().replace(/[^a-z]/g, "")}`;
    const email      = `${emailLocal}@etl.co.ls`;
    const employeeNo = `${EMP_PREFIX}${String(i + 1).padStart(3, "0")}`;

    // Check if email already exists
    const exists = await client.query(
      "SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1",
      [email]
    );
    if (exists.rows.length > 0) {
      console.log(`  SKIP  ${fullName} <${email}> — already exists`);
      skipped++;
      continue;
    }

    await client.query(
      `INSERT INTO users
         (id, email, full_name, employee_no, title, department,
          password_hash, role, employment_type, profile_completed, is_active,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'EMPLOYEE','PERMANENT',true,true,now(),now())`,
      [randomUUID(), email, fullName, employeeNo, emp.title, DEPARTMENT, hash]
    );

    console.log(`  OK    ${employeeNo}  ${fullName} <${email}> — ${emp.title}`);
    created++;
  }

  await client.end();
  console.log(`\nDone. Created: ${created}  Skipped (already exist): ${skipped}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
