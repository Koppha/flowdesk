/**
 * Service Contracts portal API - the FlowDesk-authenticated surface used by
 * the Contracts > Service Contracts page: dashboard, list/detail/manual
 * create-edit for Individual and Company contracts, admin-managed lookups
 * (categories/packages/durations/statuses), API key issuance for the
 * external integration surface (service-contracts.external.routes.ts), and
 * simple creation/expiry reports. See
 * /home/developer/.claude/plans/calm-coalescing-fog.md for the full
 * rationale (Phase 2 of the Contracts module).
 */
import { Router } from "express";
import { z } from "zod";
import { AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { nextSequentialNumber } from "../../lib/sequentialNumbers.js";
import {
  getBooleanSystemSetting, setBooleanSystemSetting, getStringSystemSetting, setStringSystemSetting, SYSTEM_SETTING_KEYS
} from "../../lib/systemSettings.js";
import { canAccessServiceContracts, canManageServiceContracts, canManageServiceContractNotifications } from "../../lib/serviceContractsPermissions.js";
import { generateApiKey } from "../../lib/apiKeyAuth.js";
import { notifyServiceContractsExpiring } from "../../lib/notifications.js";
import { logger } from "../../lib/logger.js";
import {
  computeExpiryDate, resolveKeyAccountManagerId, mapIndividualContract, mapCompanyContract,
  INDIVIDUAL_CONTRACT_SELECT, COMPANY_CONTRACT_SELECT
} from "./service-contracts.schema.js";

export const serviceContractsRouter = Router();
serviceContractsRouter.use(requireAuth);

async function requireModuleEnabled() {
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsModuleEnabled, true))) {
    throw notFound("Service Contracts is not currently enabled");
  }
}

serviceContractsRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const enabled = await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsModuleEnabled, true);
    if (!enabled) return res.json({ allowed: false });
    const allowed = await canAccessServiceContracts(req.user!.userId, req.user!.role);
    if (!allowed) return res.json({ allowed });
    const canManage = await canManageServiceContracts(req.user!.userId, req.user!.role);
    const canManageNotifications = await canManageServiceContractNotifications(req.user!.userId, req.user!.role);
    return res.json({ allowed, canManage, canManageNotifications, isAdmin: req.user!.role === "ADMIN" });
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.use(async (req: AuthedRequest, res, next) => {
  try {
    await requireModuleEnabled();
    if (!(await canAccessServiceContracts(req.user!.userId, req.user!.role))) {
      throw forbidden("You do not have access to Service Contracts");
    }
    next();
  } catch (err) {
    next(err);
  }
});

async function requireManage(req: AuthedRequest) {
  if (!(await canManageServiceContracts(req.user!.userId, req.user!.role))) {
    throw forbidden("You do not have permission to manage Service Contracts");
  }
}

function requireAdmin(req: AuthedRequest) {
  if (req.user!.role !== "ADMIN") throw forbidden("Only an administrator can manage API keys");
}

// ── Dashboard ───────────────────────────────────────────────────────────

serviceContractsRouter.get("/dashboard", async (_req: AuthedRequest, res, next) => {
  try {
    // is_active=false means archived (legacy duplicates found during the
    // migration, or anything manually hidden via "Hide from Portal") - never
    // counted in the headline numbers, same as they're excluded from the
    // default list below. See GET /archive for the dedicated archive view.
    const [individual, company] = await Promise.all([
      query<any>(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status_code='OPEN')::int AS active,
               count(*) FILTER (WHERE expiry_date < current_date)::int AS expired,
               count(*) FILTER (WHERE status_code='OPEN' AND expiry_date >= current_date AND expiry_date <= current_date + interval '30 days')::int AS expiring_soon
          FROM individual_service_contracts
         WHERE is_active = true
      `),
      query<any>(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status_code='OPEN')::int AS active,
               count(*) FILTER (WHERE expiry_date < current_date)::int AS expired,
               count(*) FILTER (WHERE status_code='OPEN' AND expiry_date >= current_date AND expiry_date <= current_date + interval '30 days')::int AS expiring_soon
          FROM company_service_contracts
         WHERE is_active = true
      `)
    ]);
    const i = individual[0];
    const c = company[0];
    return res.json({
      stats: [
        { label: "Individual Contracts", value: i.total, icon: "user", tone: "blue" },
        { label: "Company Contracts", value: c.total, icon: "building", tone: "blue" },
        { label: "Expiring in 30 Days", value: i.expiring_soon + c.expiring_soon, icon: "clock", tone: "yellow" },
        { label: "Expired", value: i.expired + c.expired, icon: "alert", tone: "red" }
      ],
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    return next(err);
  }
});

// ── Individual contracts ───────────────────────────────────────────────

const IndividualSchema = z.object({
  firstName: z.string().trim().min(1),
  surname: z.string().trim().min(1),
  titleCode: z.string().trim().optional(),
  idNumber: z.string().trim().min(1),
  birthDate: z.string().optional(),
  email: z.string().trim().optional(),
  msisdn: z.string().trim().min(1),
  alternativeNumber: z.string().trim().optional(),
  accountNumber: z.string().trim().min(1),
  physicalAddressLine1: z.string().trim().optional(),
  physicalAddressLine2: z.string().trim().optional(),
  physicalAddressLine3: z.string().trim().optional(),
  keyAccountManagerEmail: z.string().trim().optional(),
  serviceCategoryCode: z.string().trim().min(1),
  servicePackageCode: z.string().trim().min(1),
  servicePackageStartDate: z.string(),
  contractDurationMonths: z.number().int().positive(),
  statusCode: z.string().trim().optional()
});

serviceContractsRouter.get("/individual", async (req: AuthedRequest, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? `%${req.query.search}%` : null;
    const statusCode = typeof req.query.statusCode === "string" ? req.query.statusCode : null;
    const categoryCode = typeof req.query.categoryCode === "string" ? req.query.categoryCode : null;
    // Archived (is_active=false - legacy migration duplicates, or anything
    // manually hidden) are excluded by default, same as the dashboard -
    // only GET /archive (and this with includeInactive=true) surfaces them.
    const includeInactive = req.query.includeInactive === "true";
    const rows = await query<any>(
      `SELECT ${INDIVIDUAL_CONTRACT_SELECT}
        WHERE ($1::text IS NULL OR c.first_name ILIKE $1 OR c.surname ILIKE $1 OR c.account_number ILIKE $1 OR c.contract_number ILIKE $1)
          AND ($2::text IS NULL OR c.status_code=$2)
          AND ($3::text IS NULL OR c.service_category_code=$3)
          AND ($4::boolean OR c.is_active = true)
        ORDER BY c.created_at DESC`,
      [search, statusCode, categoryCode, includeInactive]
    );
    return res.json({ items: rows.map(mapIndividualContract) });
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.get("/individual/:id", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT ${INDIVIDUAL_CONTRACT_SELECT} WHERE c.id=$1`, [req.params.id]);
    if (!rows[0]) throw notFound();
    return res.json(mapIndividualContract(rows[0]));
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.post("/individual", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = IndividualSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid contract payload", parsed.error.flatten());
    const d = parsed.data;
    const existing = await query<{ id: string }>(`SELECT id FROM individual_service_contracts WHERE account_number=$1`, [d.accountNumber]);
    if (existing[0]) throw badRequest("A contract with this account number already exists");
    const keyAccountManagerId = await resolveKeyAccountManagerId(d.keyAccountManagerEmail);
    const expiryDate = computeExpiryDate(d.servicePackageStartDate, d.contractDurationMonths);
    const contractNumber = await nextSequentialNumber("IND", 6);
    const rows = await query<{ id: string }>(
      `INSERT INTO individual_service_contracts
       (contract_number, first_name, surname, title_code, id_number, birth_date, email, msisdn, alternative_number,
        account_number, physical_address_line1, physical_address_line2, physical_address_line3,
        key_account_manager_id, service_category_code, service_package_code, service_package_start_date,
        contract_duration_months, status_code, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        contractNumber, d.firstName, d.surname, d.titleCode ?? null, d.idNumber, d.birthDate ?? null, d.email ?? null,
        d.msisdn, d.alternativeNumber ?? null, d.accountNumber, d.physicalAddressLine1 ?? null,
        d.physicalAddressLine2 ?? null, d.physicalAddressLine3 ?? null, keyAccountManagerId, d.serviceCategoryCode,
        d.servicePackageCode, d.servicePackageStartDate, d.contractDurationMonths, d.statusCode || "OPEN", expiryDate
      ]
    );
    return res.status(201).json({ id: rows[0].id, contractNumber });
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.put("/individual/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const existing = await query<{ id: string }>(`SELECT id FROM individual_service_contracts WHERE id=$1`, [req.params.id]);
    if (!existing[0]) throw notFound();
    const parsed = IndividualSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid contract payload", parsed.error.flatten());
    const d = parsed.data;
    const clash = await query<{ id: string }>(`SELECT id FROM individual_service_contracts WHERE account_number=$1 AND id<>$2`, [d.accountNumber, req.params.id]);
    if (clash[0]) throw badRequest("Another contract already uses this account number");
    const keyAccountManagerId = await resolveKeyAccountManagerId(d.keyAccountManagerEmail);
    const expiryDate = computeExpiryDate(d.servicePackageStartDate, d.contractDurationMonths);
    await query(
      `UPDATE individual_service_contracts SET
         first_name=$2, surname=$3, title_code=$4, id_number=$5, birth_date=$6, email=$7, msisdn=$8,
         alternative_number=$9, account_number=$10, physical_address_line1=$11, physical_address_line2=$12,
         physical_address_line3=$13, key_account_manager_id=$14, service_category_code=$15, service_package_code=$16,
         service_package_start_date=$17, contract_duration_months=$18, status_code=$19, expiry_date=$20, updated_at=now()
       WHERE id=$1`,
      [
        req.params.id, d.firstName, d.surname, d.titleCode ?? null, d.idNumber, d.birthDate ?? null, d.email ?? null,
        d.msisdn, d.alternativeNumber ?? null, d.accountNumber, d.physicalAddressLine1 ?? null,
        d.physicalAddressLine2 ?? null, d.physicalAddressLine3 ?? null, keyAccountManagerId, d.serviceCategoryCode,
        d.servicePackageCode, d.servicePackageStartDate, d.contractDurationMonths, d.statusCode || "OPEN", expiryDate
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.patch("/individual/:id/active", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const existing = await query<{ id: string }>(`SELECT id FROM individual_service_contracts WHERE id=$1`, [req.params.id]);
    if (!existing[0]) throw notFound();
    await query(`UPDATE individual_service_contracts SET is_active=$2, updated_at=now() WHERE id=$1`, [req.params.id, parsed.data.isActive]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ── Company contracts ───────────────────────────────────────────────────

const CompanySchema = z.object({
  companyName: z.string().trim().min(1),
  companyRegistrationNumber: z.string().trim().min(1),
  contactName: z.string().trim().min(1),
  contactEmail: z.string().trim().optional(),
  contactNumber: z.string().trim().optional(),
  contractUserName: z.string().trim().optional(),
  contractUserEmail: z.string().trim().optional(),
  contractUserBirthDate: z.string().optional(),
  msisdn: z.string().trim().optional(),
  alternativeNumber: z.string().trim().optional(),
  accountNumber: z.string().trim().min(1),
  physicalAddressLine1: z.string().trim().optional(),
  physicalAddressLine2: z.string().trim().optional(),
  physicalAddressLine3: z.string().trim().optional(),
  keyAccountManagerEmail: z.string().trim().optional(),
  serviceCategoryCode: z.string().trim().min(1),
  servicePackageCode: z.string().trim().min(1),
  servicePackageStartDate: z.string(),
  contractDurationMonths: z.number().int().positive(),
  statusCode: z.string().trim().optional()
});

serviceContractsRouter.get("/company", async (req: AuthedRequest, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? `%${req.query.search}%` : null;
    const statusCode = typeof req.query.statusCode === "string" ? req.query.statusCode : null;
    const categoryCode = typeof req.query.categoryCode === "string" ? req.query.categoryCode : null;
    const includeInactive = req.query.includeInactive === "true";
    const rows = await query<any>(
      `SELECT ${COMPANY_CONTRACT_SELECT}
        WHERE ($1::text IS NULL OR c.company_name ILIKE $1 OR c.account_number ILIKE $1 OR c.contract_number ILIKE $1)
          AND ($2::text IS NULL OR c.status_code=$2)
          AND ($3::text IS NULL OR c.service_category_code=$3)
          AND ($4::boolean OR c.is_active = true)
        ORDER BY c.created_at DESC`,
      [search, statusCode, categoryCode, includeInactive]
    );
    return res.json({ items: rows.map(mapCompanyContract) });
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.get("/company/:id", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT ${COMPANY_CONTRACT_SELECT} WHERE c.id=$1`, [req.params.id]);
    if (!rows[0]) throw notFound();
    return res.json(mapCompanyContract(rows[0]));
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.post("/company", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = CompanySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid contract payload", parsed.error.flatten());
    const d = parsed.data;
    const existing = await query<{ id: string }>(`SELECT id FROM company_service_contracts WHERE account_number=$1`, [d.accountNumber]);
    if (existing[0]) throw badRequest("A contract with this account number already exists");
    const keyAccountManagerId = await resolveKeyAccountManagerId(d.keyAccountManagerEmail);
    const expiryDate = computeExpiryDate(d.servicePackageStartDate, d.contractDurationMonths);
    const contractNumber = await nextSequentialNumber("COM", 6);
    const rows = await query<{ id: string }>(
      `INSERT INTO company_service_contracts
       (contract_number, company_name, company_registration_number, contact_name, contact_email, contact_number,
        contract_user_name, contract_user_email, contract_user_birth_date, msisdn, alternative_number,
        account_number, physical_address_line1, physical_address_line2, physical_address_line3,
        key_account_manager_id, service_category_code, service_package_code, service_package_start_date,
        contract_duration_months, status_code, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id`,
      [
        contractNumber, d.companyName, d.companyRegistrationNumber, d.contactName, d.contactEmail ?? null,
        d.contactNumber ?? null, d.contractUserName ?? null, d.contractUserEmail ?? null,
        d.contractUserBirthDate ?? null, d.msisdn ?? null, d.alternativeNumber ?? null, d.accountNumber,
        d.physicalAddressLine1 ?? null, d.physicalAddressLine2 ?? null, d.physicalAddressLine3 ?? null,
        keyAccountManagerId, d.serviceCategoryCode, d.servicePackageCode, d.servicePackageStartDate,
        d.contractDurationMonths, d.statusCode || "OPEN", expiryDate
      ]
    );
    return res.status(201).json({ id: rows[0].id, contractNumber });
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.put("/company/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const existing = await query<{ id: string }>(`SELECT id FROM company_service_contracts WHERE id=$1`, [req.params.id]);
    if (!existing[0]) throw notFound();
    const parsed = CompanySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid contract payload", parsed.error.flatten());
    const d = parsed.data;
    const clash = await query<{ id: string }>(`SELECT id FROM company_service_contracts WHERE account_number=$1 AND id<>$2`, [d.accountNumber, req.params.id]);
    if (clash[0]) throw badRequest("Another contract already uses this account number");
    const keyAccountManagerId = await resolveKeyAccountManagerId(d.keyAccountManagerEmail);
    const expiryDate = computeExpiryDate(d.servicePackageStartDate, d.contractDurationMonths);
    await query(
      `UPDATE company_service_contracts SET
         company_name=$2, company_registration_number=$3, contact_name=$4, contact_email=$5, contact_number=$6,
         contract_user_name=$7, contract_user_email=$8, contract_user_birth_date=$9, msisdn=$10,
         alternative_number=$11, account_number=$12, physical_address_line1=$13, physical_address_line2=$14,
         physical_address_line3=$15, key_account_manager_id=$16, service_category_code=$17, service_package_code=$18,
         service_package_start_date=$19, contract_duration_months=$20, status_code=$21, expiry_date=$22, updated_at=now()
       WHERE id=$1`,
      [
        req.params.id, d.companyName, d.companyRegistrationNumber, d.contactName, d.contactEmail ?? null,
        d.contactNumber ?? null, d.contractUserName ?? null, d.contractUserEmail ?? null,
        d.contractUserBirthDate ?? null, d.msisdn ?? null, d.alternativeNumber ?? null, d.accountNumber,
        d.physicalAddressLine1 ?? null, d.physicalAddressLine2 ?? null, d.physicalAddressLine3 ?? null,
        keyAccountManagerId, d.serviceCategoryCode, d.servicePackageCode, d.servicePackageStartDate,
        d.contractDurationMonths, d.statusCode || "OPEN", expiryDate
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

serviceContractsRouter.patch("/company/:id/active", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const existing = await query<{ id: string }>(`SELECT id FROM company_service_contracts WHERE id=$1`, [req.params.id]);
    if (!existing[0]) throw notFound();
    await query(`UPDATE company_service_contracts SET is_active=$2, updated_at=now() WHERE id=$1`, [req.params.id, parsed.data.isActive]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ── Reports ─────────────────────────────────────────────────────────────

serviceContractsRouter.get("/reports", async (req: AuthedRequest, res, next) => {
  try {
    const type = req.query.type === "expiry" ? "expiry" : "creation";
    const contractType = req.query.contractType === "company" ? "company" : "individual";
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    const statusCode = typeof req.query.statusCode === "string" && req.query.statusCode ? req.query.statusCode : null;
    const dateCol = type === "expiry" ? "expiry_date" : "created_at::date";
    const table = contractType === "company" ? "company_service_contracts" : "individual_service_contracts";
    const nameCol = contractType === "company" ? "company_name" : "first_name || ' ' || surname";
    const rows = await query<any>(
      `SELECT id, contract_number, account_number, ${nameCol} AS name, status_code, expiry_date, created_at
         FROM ${table}
        WHERE ($1::date IS NULL OR ${dateCol} >= $1)
          AND ($2::date IS NULL OR ${dateCol} <= $2)
          AND ($3::text IS NULL OR status_code=$3)
          AND is_active = true
        ORDER BY ${dateCol} DESC`,
      [from, to, statusCode]
    );
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

// ── Lookups (admin-managed reference data) ─────────────────────────────

async function listLookup(table: string, extraCols = "") {
  return query<any>(`SELECT id, code, name, is_active${extraCols} FROM ${table} ORDER BY name`);
}

serviceContractsRouter.get("/lookups/service-categories", async (_req: AuthedRequest, res, next) => {
  try { return res.json({ items: await listLookup("service_categories") }); } catch (err) { return next(err); }
});
serviceContractsRouter.post("/lookups/service-categories", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ code: z.string().trim().min(1), name: z.string().trim().min(1) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const rows = await query<{ id: string }>(`INSERT INTO service_categories (code, name) VALUES ($1,$2) RETURNING id`, [parsed.data.code, parsed.data.name]);
    return res.status(201).json({ id: rows[0].id });
  } catch (err) { return next(err); }
});
serviceContractsRouter.put("/lookups/service-categories/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ name: z.string().trim().min(1), isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`UPDATE service_categories SET name=$2, is_active=$3 WHERE id=$1`, [req.params.id, parsed.data.name, parsed.data.isActive]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

serviceContractsRouter.get("/lookups/service-packages", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT id, code, category_code, name, price, is_active FROM service_packages ORDER BY name`);
    return res.json({ items: rows.map((r) => ({ ...r, price: Number(r.price) })) });
  } catch (err) { return next(err); }
});
serviceContractsRouter.post("/lookups/service-packages", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({
      code: z.string().trim().min(1), categoryCode: z.string().trim().min(1),
      name: z.string().trim().min(1), price: z.number().min(0).default(0)
    }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const rows = await query<{ id: string }>(
      `INSERT INTO service_packages (code, category_code, name, price) VALUES ($1,$2,$3,$4) RETURNING id`,
      [parsed.data.code, parsed.data.categoryCode, parsed.data.name, parsed.data.price]
    );
    return res.status(201).json({ id: rows[0].id });
  } catch (err) { return next(err); }
});
serviceContractsRouter.put("/lookups/service-packages/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ name: z.string().trim().min(1), price: z.number().min(0), isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`UPDATE service_packages SET name=$2, price=$3, is_active=$4 WHERE id=$1`, [req.params.id, parsed.data.name, parsed.data.price, parsed.data.isActive]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

serviceContractsRouter.get("/lookups/durations", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT id, months, label, is_active FROM contract_durations ORDER BY months`);
    return res.json({ items: rows });
  } catch (err) { return next(err); }
});
serviceContractsRouter.post("/lookups/durations", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ months: z.number().int().positive(), label: z.string().trim().min(1) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const rows = await query<{ id: string }>(`INSERT INTO contract_durations (months, label) VALUES ($1,$2) RETURNING id`, [parsed.data.months, parsed.data.label]);
    return res.status(201).json({ id: rows[0].id });
  } catch (err) { return next(err); }
});
serviceContractsRouter.put("/lookups/durations/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ label: z.string().trim().min(1), isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`UPDATE contract_durations SET label=$2, is_active=$3 WHERE id=$1`, [req.params.id, parsed.data.label, parsed.data.isActive]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

serviceContractsRouter.get("/lookups/statuses", async (_req: AuthedRequest, res, next) => {
  try { return res.json({ items: await listLookup("contract_statuses") }); } catch (err) { return next(err); }
});
serviceContractsRouter.post("/lookups/statuses", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ code: z.string().trim().min(1), name: z.string().trim().min(1) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const rows = await query<{ id: string }>(`INSERT INTO contract_statuses (code, name) VALUES ($1,$2) RETURNING id`, [parsed.data.code, parsed.data.name]);
    return res.status(201).json({ id: rows[0].id });
  } catch (err) { return next(err); }
});
serviceContractsRouter.put("/lookups/statuses/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ name: z.string().trim().min(1), isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    await query(`UPDATE contract_statuses SET name=$2, is_active=$3 WHERE id=$1`, [req.params.id, parsed.data.name, parsed.data.isActive]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ── API keys (external integration access) ─────────────────────────────

serviceContractsRouter.get("/api-keys", async (req: AuthedRequest, res, next) => {
  try {
    requireAdmin(req);
    const rows = await query<any>(
      `SELECT id, label, key_prefix, is_active, last_used_at, created_at FROM api_keys WHERE scope='service_contracts' ORDER BY created_at DESC`
    );
    return res.json({ items: rows.map((r) => ({ id: r.id, label: r.label, keyPrefix: r.key_prefix, isActive: r.is_active, lastUsedAt: r.last_used_at, createdAt: r.created_at })) });
  } catch (err) { return next(err); }
});

serviceContractsRouter.post("/api-keys", async (req: AuthedRequest, res, next) => {
  try {
    requireAdmin(req);
    const parsed = z.object({ label: z.string().trim().min(1) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    const rows = await query<{ id: string }>(
      `INSERT INTO api_keys (label, key_hash, key_prefix, scope, created_by_id) VALUES ($1,$2,$3,'service_contracts',$4) RETURNING id`,
      [parsed.data.label, keyHash, keyPrefix, req.user!.userId]
    );
    return res.status(201).json({ id: rows[0].id, rawKey });
  } catch (err) { return next(err); }
});

serviceContractsRouter.patch("/api-keys/:id/active", async (req: AuthedRequest, res, next) => {
  try {
    requireAdmin(req);
    const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const existing = await query<{ id: string }>(`SELECT id FROM api_keys WHERE id=$1 AND scope='service_contracts'`, [req.params.id]);
    if (!existing[0]) throw notFound();
    await query(`UPDATE api_keys SET is_active=$2 WHERE id=$1`, [req.params.id, parsed.data.isActive]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ── Expiry notification settings (its own, narrower permission - see
// canManageServiceContractNotifications's own comment) ─────────────────

const DEFAULT_NOTIFICATION_DAYS = "90,30,7,1,0";

function parseDaysBefore(raw: string): number[] {
  return raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 3650);
}

async function requireManageNotifications(req: AuthedRequest) {
  if (!(await canManageServiceContractNotifications(req.user!.userId, req.user!.role))) {
    throw forbidden("You do not have permission to manage Service Contracts notification settings");
  }
}

serviceContractsRouter.get("/notification-settings", async (req: AuthedRequest, res, next) => {
  try {
    await requireManageNotifications(req);
    const enabled = await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationsEnabled, false);
    const recipients = await getStringSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationRecipients, "");
    const daysBefore = await getStringSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationDaysBefore, DEFAULT_NOTIFICATION_DAYS);
    return res.json({ enabled, recipients: recipients || "", daysBefore: daysBefore || DEFAULT_NOTIFICATION_DAYS });
  } catch (err) { return next(err); }
});

const NotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  recipients: z.string().trim(),
  daysBefore: z.string().trim()
});

serviceContractsRouter.put("/notification-settings", async (req: AuthedRequest, res, next) => {
  try {
    await requireManageNotifications(req);
    const parsed = NotificationSettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const recipientList = parsed.data.recipients.split(/[;,]/).map((e) => e.trim()).filter(Boolean);
    if (parsed.data.enabled && recipientList.length === 0) {
      throw badRequest("At least one recipient email is required to enable notifications");
    }
    if (!recipientList.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) {
      throw badRequest("One or more recipient emails look invalid");
    }
    const daysList = parseDaysBefore(parsed.data.daysBefore);
    if (daysList.length === 0) throw badRequest("Enter at least one valid number of days (0-3650)");

    await setBooleanSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationsEnabled, parsed.data.enabled);
    await setStringSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationRecipients, recipientList.join(", "));
    await setStringSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationDaysBefore, daysList.join(","));
    return res.json({ enabled: parsed.data.enabled, recipients: recipientList.join(", "), daysBefore: daysList.join(",") });
  } catch (err) { return next(err); }
});

// ── Expiry reminder worker ──────────────────────────────────────────────
// In-process interval, same pattern as Vendor Contracts' own reminder
// worker (vendor-contracts.routes.ts) - except settings-driven (global
// recipients + configurable thresholds) rather than per-contract, since
// the migrated legacy data's key_account_manager field is often blank or
// unreliable free text (see the service contract migration's own findings).
async function runServiceContractReminderCycle() {
  try {
    const enabled = await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationsEnabled, false);
    if (!enabled) return;
    const recipientsRaw = await getStringSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationRecipients, "");
    const recipients = (recipientsRaw || "").split(/[;,]/).map((e) => e.trim()).filter(Boolean);
    if (!recipients.length) return;
    const daysBeforeRaw = await getStringSystemSetting(SYSTEM_SETTING_KEYS.serviceContractsNotificationDaysBefore, DEFAULT_NOTIFICATION_DAYS);
    const daysBeforeList = parseDaysBefore(daysBeforeRaw || DEFAULT_NOTIFICATION_DAYS);
    if (!daysBeforeList.length) return;

    const individualRows = await query<any>(
      `SELECT id, contract_number, first_name, surname, expiry_date::text AS expiry_date FROM individual_service_contracts WHERE status_code='OPEN'`
    );
    const companyRows = await query<any>(
      `SELECT id, contract_number, company_name, expiry_date::text AS expiry_date FROM company_service_contracts WHERE status_code='OPEN'`
    );
    const allContracts = [
      ...individualRows.map((r) => ({ type: "individual" as const, id: r.id, contractNumber: r.contract_number, name: `${r.first_name} ${r.surname}`, expiryDate: r.expiry_date })),
      ...companyRows.map((r) => ({ type: "company" as const, id: r.id, contractNumber: r.contract_number, name: r.company_name, expiryDate: r.expiry_date }))
    ];

    const today = new Date().toISOString().slice(0, 10);
    for (const daysBefore of daysBeforeList) {
      const due = allContracts.filter((c) => {
        const expiry = new Date(c.expiryDate + "T00:00:00Z");
        const remindOn = new Date(expiry);
        remindOn.setUTCDate(remindOn.getUTCDate() - daysBefore);
        return remindOn.toISOString().slice(0, 10) === today;
      });
      if (!due.length) continue;

      // Skip ones already logged as sent for this exact (contract, threshold, day).
      const notYetSent: typeof due = [];
      for (const c of due) {
        const existing = await query<{ id: string }>(
          `SELECT id FROM service_contract_reminder_log WHERE contract_type=$1 AND contract_id=$2 AND days_before=$3 AND remind_on=$4`,
          [c.type, c.id, daysBefore, today]
        );
        if (!existing[0]) notYetSent.push(c);
      }
      if (!notYetSent.length) continue;

      await notifyServiceContractsExpiring({ recipients, daysBefore, contracts: notYetSent });
      for (const c of notYetSent) {
        await query(
          `INSERT INTO service_contract_reminder_log (contract_type, contract_id, days_before, remind_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [c.type, c.id, daysBefore, today]
        );
      }
    }
  } catch (err) {
    logger.warn("service_contract_reminder_cycle_failed", { error: String(err) });
  }
}

export function startServiceContractReminderWorker() {
  const intervalMinutes = Number(process.env.SERVICE_CONTRACT_REMINDER_INTERVAL_MINUTES || 60);
  runServiceContractReminderCycle().catch(() => {});
  setInterval(() => { runServiceContractReminderCycle().catch(() => {}); }, intervalMinutes * 60_000);
}
