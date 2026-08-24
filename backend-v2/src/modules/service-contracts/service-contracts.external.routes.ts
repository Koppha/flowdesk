/**
 * External, system-to-system Service Contracts API - matches
 * docs/service-contracts-api.openapi.yaml exactly. Authenticated by
 * X-API-Key (see lib/apiKeyAuth.ts), not FlowDesk's own JWT session auth -
 * this is for another system to create/keep contracts in sync, not for
 * portal users. Response shapes (including the ValidationErrorBody's
 * `fieldErrors`) are answered directly in-route rather than via the app's
 * generic errorHandler, so external callers see exactly what the spec
 * promises.
 */
import { Router } from "express";
import { z } from "zod";
import { requireApiKey } from "../../lib/apiKeyAuth.js";
import { query } from "../../lib/db.js";
import { nextSequentialNumber } from "../../lib/sequentialNumbers.js";
import {
  computeExpiryDate, resolveKeyAccountManagerId, mapIndividualContract, mapCompanyContract,
  INDIVIDUAL_CONTRACT_SELECT, COMPANY_CONTRACT_SELECT
} from "./service-contracts.schema.js";

export const serviceContractsExternalRouter = Router();
serviceContractsExternalRouter.use(requireApiKey("service_contracts"));

function sendValidationError(res: any, error: z.ZodError) {
  return res.status(400).json({ error: "Invalid payload", fieldErrors: error.flatten().fieldErrors });
}

const IndividualInput = z.object({
  firstName: z.string().trim().min(1),
  surname: z.string().trim().min(1),
  titleCode: z.string().trim().optional().nullable(),
  idNumber: z.string().trim().min(1),
  birthDate: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  msisdn: z.string().trim().min(1),
  alternativeNumber: z.string().trim().optional().nullable(),
  accountNumber: z.string().trim().min(1),
  physicalAddressLine1: z.string().trim().optional().nullable(),
  physicalAddressLine2: z.string().trim().optional().nullable(),
  physicalAddressLine3: z.string().trim().optional().nullable(),
  keyAccountManagerEmail: z.string().email().optional().nullable(),
  serviceCategoryCode: z.string().trim().min(1),
  servicePackageCode: z.string().trim().min(1),
  servicePackageStartDate: z.string(),
  contractDurationMonths: z.number().int().positive(),
  statusCode: z.string().trim().optional().nullable()
});

const CompanyInput = z.object({
  companyName: z.string().trim().min(1),
  companyRegistrationNumber: z.string().trim().min(1),
  contactName: z.string().trim().min(1),
  contactEmail: z.string().email().optional().nullable(),
  contactNumber: z.string().trim().optional().nullable(),
  contractUserName: z.string().trim().optional().nullable(),
  contractUserEmail: z.string().email().optional().nullable(),
  contractUserBirthDate: z.string().optional().nullable(),
  msisdn: z.string().trim().optional().nullable(),
  alternativeNumber: z.string().trim().optional().nullable(),
  accountNumber: z.string().trim().min(1),
  physicalAddressLine1: z.string().trim().optional().nullable(),
  physicalAddressLine2: z.string().trim().optional().nullable(),
  physicalAddressLine3: z.string().trim().optional().nullable(),
  keyAccountManagerEmail: z.string().email().optional().nullable(),
  serviceCategoryCode: z.string().trim().min(1),
  servicePackageCode: z.string().trim().min(1),
  servicePackageStartDate: z.string(),
  contractDurationMonths: z.number().int().positive(),
  statusCode: z.string().trim().optional().nullable()
});

// ── Individual ──────────────────────────────────────────────────────────

async function upsertIndividual(accountNumber: string, d: z.infer<typeof IndividualInput>, isUpdate: boolean) {
  const keyAccountManagerId = await resolveKeyAccountManagerId(d.keyAccountManagerEmail);
  const expiryDate = computeExpiryDate(d.servicePackageStartDate, d.contractDurationMonths);
  const statusCode = d.statusCode || "OPEN";

  if (isUpdate) {
    await query(
      `UPDATE individual_service_contracts SET
         first_name=$2, surname=$3, title_code=$4, id_number=$5, birth_date=$6, email=$7, msisdn=$8,
         alternative_number=$9, physical_address_line1=$10, physical_address_line2=$11, physical_address_line3=$12,
         key_account_manager_id=$13, service_category_code=$14, service_package_code=$15,
         service_package_start_date=$16, contract_duration_months=$17, status_code=$18, expiry_date=$19,
         updated_at=now()
       WHERE account_number=$1`,
      [
        accountNumber, d.firstName, d.surname, d.titleCode ?? null, d.idNumber, d.birthDate ?? null, d.email ?? null,
        d.msisdn, d.alternativeNumber ?? null, d.physicalAddressLine1 ?? null, d.physicalAddressLine2 ?? null,
        d.physicalAddressLine3 ?? null, keyAccountManagerId, d.serviceCategoryCode, d.servicePackageCode,
        d.servicePackageStartDate, d.contractDurationMonths, statusCode, expiryDate
      ]
    );
  } else {
    const contractNumber = await nextSequentialNumber("IND", 6);
    await query(
      `INSERT INTO individual_service_contracts
       (contract_number, first_name, surname, title_code, id_number, birth_date, email, msisdn, alternative_number,
        account_number, physical_address_line1, physical_address_line2, physical_address_line3,
        key_account_manager_id, service_category_code, service_package_code, service_package_start_date,
        contract_duration_months, status_code, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        contractNumber, d.firstName, d.surname, d.titleCode ?? null, d.idNumber, d.birthDate ?? null, d.email ?? null,
        d.msisdn, d.alternativeNumber ?? null, accountNumber, d.physicalAddressLine1 ?? null,
        d.physicalAddressLine2 ?? null, d.physicalAddressLine3 ?? null, keyAccountManagerId, d.serviceCategoryCode,
        d.servicePackageCode, d.servicePackageStartDate, d.contractDurationMonths, statusCode, expiryDate
      ]
    );
  }
  const rows = await query<any>(`SELECT ${INDIVIDUAL_CONTRACT_SELECT} WHERE c.account_number=$1`, [accountNumber]);
  return mapIndividualContract(rows[0]);
}

serviceContractsExternalRouter.post("/individual", async (req, res, next) => {
  try {
    const parsed = IndividualInput.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const existing = await query<{ id: string }>(`SELECT id FROM individual_service_contracts WHERE account_number=$1`, [parsed.data.accountNumber]);
    if (existing[0]) return res.status(409).json({ error: "A contract with this accountNumber already exists" });
    const contract = await upsertIndividual(parsed.data.accountNumber, parsed.data, false);
    return res.status(201).json(contract);
  } catch (err) {
    return next(err);
  }
});

serviceContractsExternalRouter.get("/individual/:accountNumber", async (req, res, next) => {
  try {
    const rows = await query<any>(`SELECT ${INDIVIDUAL_CONTRACT_SELECT} WHERE c.account_number=$1`, [req.params.accountNumber]);
    if (!rows[0]) return res.status(404).json({ error: "No contract found for this account number" });
    return res.json(mapIndividualContract(rows[0]));
  } catch (err) {
    return next(err);
  }
});

serviceContractsExternalRouter.put("/individual/:accountNumber", async (req, res, next) => {
  try {
    const parsed = IndividualInput.safeParse({ ...req.body, accountNumber: req.params.accountNumber });
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const existing = await query<{ id: string }>(`SELECT id FROM individual_service_contracts WHERE account_number=$1`, [req.params.accountNumber]);
    const contract = await upsertIndividual(req.params.accountNumber, parsed.data, Boolean(existing[0]));
    return res.status(existing[0] ? 200 : 201).json(contract);
  } catch (err) {
    return next(err);
  }
});

// ── Company ─────────────────────────────────────────────────────────────

async function upsertCompany(accountNumber: string, d: z.infer<typeof CompanyInput>, isUpdate: boolean) {
  const keyAccountManagerId = await resolveKeyAccountManagerId(d.keyAccountManagerEmail);
  const expiryDate = computeExpiryDate(d.servicePackageStartDate, d.contractDurationMonths);
  const statusCode = d.statusCode || "OPEN";

  if (isUpdate) {
    await query(
      `UPDATE company_service_contracts SET
         company_name=$2, company_registration_number=$3, contact_name=$4, contact_email=$5, contact_number=$6,
         contract_user_name=$7, contract_user_email=$8, contract_user_birth_date=$9, msisdn=$10,
         alternative_number=$11, physical_address_line1=$12, physical_address_line2=$13, physical_address_line3=$14,
         key_account_manager_id=$15, service_category_code=$16, service_package_code=$17,
         service_package_start_date=$18, contract_duration_months=$19, status_code=$20, expiry_date=$21,
         updated_at=now()
       WHERE account_number=$1`,
      [
        accountNumber, d.companyName, d.companyRegistrationNumber, d.contactName, d.contactEmail ?? null,
        d.contactNumber ?? null, d.contractUserName ?? null, d.contractUserEmail ?? null,
        d.contractUserBirthDate ?? null, d.msisdn ?? null, d.alternativeNumber ?? null,
        d.physicalAddressLine1 ?? null, d.physicalAddressLine2 ?? null, d.physicalAddressLine3 ?? null,
        keyAccountManagerId, d.serviceCategoryCode, d.servicePackageCode, d.servicePackageStartDate,
        d.contractDurationMonths, statusCode, expiryDate
      ]
    );
  } else {
    const contractNumber = await nextSequentialNumber("COM", 6);
    await query(
      `INSERT INTO company_service_contracts
       (contract_number, company_name, company_registration_number, contact_name, contact_email, contact_number,
        contract_user_name, contract_user_email, contract_user_birth_date, msisdn, alternative_number,
        account_number, physical_address_line1, physical_address_line2, physical_address_line3,
        key_account_manager_id, service_category_code, service_package_code, service_package_start_date,
        contract_duration_months, status_code, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        contractNumber, d.companyName, d.companyRegistrationNumber, d.contactName, d.contactEmail ?? null,
        d.contactNumber ?? null, d.contractUserName ?? null, d.contractUserEmail ?? null,
        d.contractUserBirthDate ?? null, d.msisdn ?? null, d.alternativeNumber ?? null, accountNumber,
        d.physicalAddressLine1 ?? null, d.physicalAddressLine2 ?? null, d.physicalAddressLine3 ?? null,
        keyAccountManagerId, d.serviceCategoryCode, d.servicePackageCode, d.servicePackageStartDate,
        d.contractDurationMonths, statusCode, expiryDate
      ]
    );
  }
  const rows = await query<any>(`SELECT ${COMPANY_CONTRACT_SELECT} WHERE c.account_number=$1`, [accountNumber]);
  return mapCompanyContract(rows[0]);
}

serviceContractsExternalRouter.post("/company", async (req, res, next) => {
  try {
    const parsed = CompanyInput.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const existing = await query<{ id: string }>(`SELECT id FROM company_service_contracts WHERE account_number=$1`, [parsed.data.accountNumber]);
    if (existing[0]) return res.status(409).json({ error: "A contract with this accountNumber already exists" });
    const contract = await upsertCompany(parsed.data.accountNumber, parsed.data, false);
    return res.status(201).json(contract);
  } catch (err) {
    return next(err);
  }
});

serviceContractsExternalRouter.get("/company/:accountNumber", async (req, res, next) => {
  try {
    const rows = await query<any>(`SELECT ${COMPANY_CONTRACT_SELECT} WHERE c.account_number=$1`, [req.params.accountNumber]);
    if (!rows[0]) return res.status(404).json({ error: "No contract found for this account number" });
    return res.json(mapCompanyContract(rows[0]));
  } catch (err) {
    return next(err);
  }
});

serviceContractsExternalRouter.put("/company/:accountNumber", async (req, res, next) => {
  try {
    const parsed = CompanyInput.safeParse({ ...req.body, accountNumber: req.params.accountNumber });
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const existing = await query<{ id: string }>(`SELECT id FROM company_service_contracts WHERE account_number=$1`, [req.params.accountNumber]);
    const contract = await upsertCompany(req.params.accountNumber, parsed.data, Boolean(existing[0]));
    return res.status(existing[0] ? 200 : 201).json(contract);
  } catch (err) {
    return next(err);
  }
});

// ── Lookups ─────────────────────────────────────────────────────────────

serviceContractsExternalRouter.get("/lookups/service-categories", async (_req, res, next) => {
  try {
    const rows = await query<any>(`SELECT code, name, is_active FROM service_categories WHERE is_active=true ORDER BY name`);
    return res.json(rows.map((r) => ({ code: r.code, name: r.name, isActive: r.is_active })));
  } catch (err) {
    return next(err);
  }
});

serviceContractsExternalRouter.get("/lookups/service-packages", async (req, res, next) => {
  try {
    const categoryCode = typeof req.query.categoryCode === "string" ? req.query.categoryCode : null;
    const rows = await query<any>(
      `SELECT code, category_code, name, price, is_active FROM service_packages
        WHERE is_active=true AND ($1::text IS NULL OR category_code=$1) ORDER BY name`,
      [categoryCode]
    );
    return res.json(rows.map((r) => ({ code: r.code, categoryCode: r.category_code, name: r.name, price: Number(r.price), isActive: r.is_active })));
  } catch (err) {
    return next(err);
  }
});

serviceContractsExternalRouter.get("/lookups/durations", async (_req, res, next) => {
  try {
    const rows = await query<any>(`SELECT months, label, is_active FROM contract_durations WHERE is_active=true ORDER BY months`);
    return res.json(rows.map((r) => ({ months: r.months, label: r.label, isActive: r.is_active })));
  } catch (err) {
    return next(err);
  }
});

serviceContractsExternalRouter.get("/lookups/statuses", async (_req, res, next) => {
  try {
    const rows = await query<any>(`SELECT code, name, is_active FROM contract_statuses WHERE is_active=true ORDER BY name`);
    return res.json(rows.map((r) => ({ code: r.code, name: r.name, isActive: r.is_active })));
  } catch (err) {
    return next(err);
  }
});
