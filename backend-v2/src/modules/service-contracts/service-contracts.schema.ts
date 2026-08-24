import { query } from "../../lib/db.js";
import { ensureApiKeysSchema } from "../../lib/apiKeyAuth.js";

export async function ensureServiceContractsSchema() {
  await ensureApiKeysSchema();

  await query(`
    CREATE TABLE IF NOT EXISTS service_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text UNIQUE NOT NULL,
      name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS service_packages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text UNIQUE NOT NULL,
      category_code text NOT NULL REFERENCES service_categories(code),
      name text NOT NULL,
      price numeric(12,2) NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_service_packages_category ON service_packages(category_code)`);

  await query(`
    CREATE TABLE IF NOT EXISTS contract_durations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      months int UNIQUE NOT NULL,
      label text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS contract_statuses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text UNIQUE NOT NULL,
      name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    )
  `);
  // Seed a working default set so the external API has a valid "OPEN" status
  // to fall back on before an admin has configured anything - the spec
  // states statusCode defaults to OPEN when omitted.
  await query(`
    INSERT INTO contract_statuses (code, name) VALUES ('OPEN', 'Open'), ('SUSPENDED', 'Suspended'), ('CLOSED', 'Closed')
    ON CONFLICT (code) DO NOTHING
  `);

  const individualServiceContractFields = `
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_number text UNIQUE NOT NULL,
      first_name text NOT NULL,
      surname text NOT NULL,
      title_code text,
      id_number text NOT NULL,
      birth_date date,
      email text,
      msisdn text NOT NULL,
      alternative_number text,
      account_number text UNIQUE NOT NULL,
      physical_address_line1 text,
      physical_address_line2 text,
      physical_address_line3 text,
      key_account_manager_id uuid REFERENCES users(id),
      service_category_code text NOT NULL REFERENCES service_categories(code),
      service_package_code text NOT NULL REFERENCES service_packages(code),
      service_package_start_date date NOT NULL,
      contract_duration_months int NOT NULL,
      status_code text NOT NULL DEFAULT 'OPEN' REFERENCES contract_statuses(code),
      expiry_date date NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
  `;
  await query(`CREATE TABLE IF NOT EXISTS individual_service_contracts (${individualServiceContractFields})`);
  await query(`CREATE INDEX IF NOT EXISTS idx_individual_service_contracts_expiry ON individual_service_contracts(expiry_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_individual_service_contracts_status ON individual_service_contracts(status_code)`);

  await query(`
    CREATE TABLE IF NOT EXISTS company_service_contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_number text UNIQUE NOT NULL,
      company_name text NOT NULL,
      company_registration_number text NOT NULL,
      contact_name text NOT NULL,
      contact_email text,
      contact_number text,
      contract_user_name text,
      contract_user_email text,
      contract_user_birth_date date,
      msisdn text NOT NULL,
      alternative_number text,
      account_number text UNIQUE NOT NULL,
      physical_address_line1 text,
      physical_address_line2 text,
      physical_address_line3 text,
      key_account_manager_id uuid REFERENCES users(id),
      service_category_code text NOT NULL REFERENCES service_categories(code),
      service_package_code text NOT NULL REFERENCES service_packages(code),
      service_package_start_date date NOT NULL,
      contract_duration_months int NOT NULL,
      status_code text NOT NULL DEFAULT 'OPEN' REFERENCES contract_statuses(code),
      expiry_date date NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_company_service_contracts_expiry ON company_service_contracts(expiry_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_company_service_contracts_status ON company_service_contracts(status_code)`);
}

// ── Shared helpers ──────────────────────────────────────────────────────

export function computeExpiryDate(startDate: string, durationMonths: number): string {
  const start = new Date(startDate + "T00:00:00Z");
  const expiry = new Date(start);
  expiry.setUTCMonth(expiry.getUTCMonth() + durationMonths);
  return expiry.toISOString().slice(0, 10);
}

// Left null if omitted or unmatched, per the OpenAPI spec.
export async function resolveKeyAccountManagerId(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const rows = await query<{ id: string }>(`SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`, [email]);
  return rows[0]?.id ?? null;
}

export function mapIndividualContract(row: any) {
  return {
    id: row.id,
    contractNumber: row.contract_number,
    firstName: row.first_name,
    surname: row.surname,
    titleCode: row.title_code,
    idNumber: row.id_number,
    birthDate: row.birth_date,
    email: row.email,
    msisdn: row.msisdn,
    alternativeNumber: row.alternative_number,
    accountNumber: row.account_number,
    physicalAddressLine1: row.physical_address_line1,
    physicalAddressLine2: row.physical_address_line2,
    physicalAddressLine3: row.physical_address_line3,
    keyAccountManagerEmail: row.key_account_manager_email ?? null,
    serviceCategoryCode: row.service_category_code,
    servicePackageCode: row.service_package_code,
    servicePackageStartDate: row.service_package_start_date,
    contractDurationMonths: row.contract_duration_months,
    statusCode: row.status_code,
    expiryDate: row.expiry_date,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapCompanyContract(row: any) {
  return {
    id: row.id,
    contractNumber: row.contract_number,
    companyName: row.company_name,
    companyRegistrationNumber: row.company_registration_number,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactNumber: row.contact_number,
    contractUserName: row.contract_user_name,
    contractUserEmail: row.contract_user_email,
    contractUserBirthDate: row.contract_user_birth_date,
    msisdn: row.msisdn,
    alternativeNumber: row.alternative_number,
    accountNumber: row.account_number,
    physicalAddressLine1: row.physical_address_line1,
    physicalAddressLine2: row.physical_address_line2,
    physicalAddressLine3: row.physical_address_line3,
    keyAccountManagerEmail: row.key_account_manager_email ?? null,
    serviceCategoryCode: row.service_category_code,
    servicePackageCode: row.service_package_code,
    servicePackageStartDate: row.service_package_start_date,
    contractDurationMonths: row.contract_duration_months,
    statusCode: row.status_code,
    expiryDate: row.expiry_date,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Joins in the key account manager's email for API responses - the FK only
// stores a user id, but the external API's contract shape speaks in emails.
export const INDIVIDUAL_CONTRACT_SELECT = `
  c.*, u.email AS key_account_manager_email
  FROM individual_service_contracts c
  LEFT JOIN users u ON u.id = c.key_account_manager_id
`;

export const COMPANY_CONTRACT_SELECT = `
  c.*, u.email AS key_account_manager_email
  FROM company_service_contracts c
  LEFT JOIN users u ON u.id = c.key_account_manager_id
`;
