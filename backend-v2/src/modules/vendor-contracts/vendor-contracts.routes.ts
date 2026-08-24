/**
 * Vendor Contracts — procurement/counterparty agreements: payment schedules,
 * escalation ("increase rule") metadata, renewal/notice-period tracking,
 * documents, and expiry reminders.
 *
 * Ported from a standalone app (/home/developer/2025_UAT/Contract_mgm) into
 * FlowDesk's own module conventions. Deliberately dropped in the port: the
 * source's own auth/session system, its own Users admin page, and its
 * unauthenticated static file mount - this module uses FlowDesk's existing
 * auth, permission groups, and the same authenticated/scoped document
 * download pattern claims.routes.ts already uses for receipts. See
 * /home/developer/.claude/plans/calm-coalescing-fog.md for the full
 * port rationale.
 */
import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import multer from "multer";
import { AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { nextSequentialNumber } from "../../lib/sequentialNumbers.js";
import { sanitizeUploadFilename, fileExtensionFilter } from "../../lib/uploads.js";
import { getBooleanSystemSetting, SYSTEM_SETTING_KEYS } from "../../lib/systemSettings.js";
import { canAccessVendorContracts, canManageVendorContracts } from "../../lib/vendorContractsPermissions.js";
import { notifyVendorContractExpiring } from "../../lib/notifications.js";

export async function ensureVendorContractsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS vendor_contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_number text UNIQUE NOT NULL,
      title text NOT NULL,
      counterparty_name text NOT NULL,
      contract_type text,
      notification_email text,
      start_date date NOT NULL,
      end_date date NOT NULL,
      renewal_date date,
      notice_period_date date,
      contract_value numeric(14,2) NOT NULL DEFAULT 0,
      payment_terms text,
      status text NOT NULL DEFAULT 'ACTIVE',
      description text,
      is_active boolean NOT NULL DEFAULT true,
      created_by_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_vendor_contracts_end_date ON vendor_contracts(end_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_vendor_contracts_status ON vendor_contracts(status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS vendor_contract_increase_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES vendor_contracts(id) ON DELETE CASCADE,
      duration_months int NOT NULL CHECK (duration_months > 0),
      increase_percentage numeric(10,2) NOT NULL CHECK (increase_percentage >= 0),
      sort_order int NOT NULL DEFAULT 0
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_vendor_contract_increase_rules_contract ON vendor_contract_increase_rules(contract_id, sort_order)`);

  await query(`
    CREATE TABLE IF NOT EXISTS vendor_contract_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES vendor_contracts(id) ON DELETE CASCADE,
      payment_label text,
      amount numeric(14,2) NOT NULL,
      due_date date NOT NULL,
      paid_at timestamptz,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_vendor_contract_payments_contract ON vendor_contract_payments(contract_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_vendor_contract_payments_due ON vendor_contract_payments(due_date)`);

  await query(`
    CREATE TABLE IF NOT EXISTS vendor_contract_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES vendor_contracts(id) ON DELETE CASCADE,
      file_name text NOT NULL,
      file_path text NOT NULL,
      file_type text,
      file_size bigint,
      uploaded_by_id uuid REFERENCES users(id),
      uploaded_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_vendor_contract_documents_contract ON vendor_contract_documents(contract_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS vendor_contract_reminder_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES vendor_contracts(id) ON DELETE CASCADE,
      notification_type text NOT NULL,
      remind_on date,
      sent_at timestamptz,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_vendor_contract_reminder_log_dedup ON vendor_contract_reminder_log(contract_id, notification_type, remind_on)`);
}

// ── Business logic (ported from the source app's repository.ts) ───────────

type PaymentStatus = "PAID" | "DUE_SOON" | "OVERDUE";

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Payment status is never stored - it's derived fresh on every read from
// due_date/paid_at, same as the source app, so a payment's status is always
// consistent with "now" rather than going stale.
function getComputedPaymentStatus(dueDate: string, paidAt: string | null): PaymentStatus {
  if (paidAt) return "PAID";
  const due = new Date(dueDate + "T00:00:00Z");
  return due < todayUtc() ? "OVERDUE" : "DUE_SOON";
}

// Days-remaining bucketing for the dashboard's "renewal reminders" widget.
function getExpiryReminderStage(endDate: string): string | null {
  const end = new Date(endDate + "T00:00:00Z");
  const days = Math.ceil((end.getTime() - todayUtc().getTime()) / 86400000);
  if (days < 0) return null;
  if (days <= 1) return "1 day reminder";
  if (days <= 30) return "1 month reminder";
  if (days <= 60) return "2 month reminder";
  if (days <= 90) return "3 month reminder";
  return null;
}

async function getIncreaseRulesByContractIds(contractIds: string[]) {
  if (contractIds.length === 0) return new Map<string, any[]>();
  const rows = await query<any>(
    `SELECT id, contract_id, duration_months, increase_percentage, sort_order
       FROM vendor_contract_increase_rules
      WHERE contract_id = ANY($1::uuid[])
      ORDER BY sort_order, id`,
    [contractIds]
  );
  const byContract = new Map<string, any[]>();
  for (const r of rows) {
    const list = byContract.get(r.contract_id) ?? [];
    list.push({ id: r.id, increaseDurationMonths: r.duration_months, increasePercentage: Number(r.increase_percentage), sortOrder: r.sort_order });
    byContract.set(r.contract_id, list);
  }
  return byContract;
}

// Delete-then-reinsert on every create/update, same as the source (no
// diffing needed at this scale). These rules are metadata only today - no
// calculation anywhere applies a percentage to contract_value.
async function replaceIncreaseRules(contractId: string, rules: Array<{ increaseDurationMonths: number; increasePercentage: number }>) {
  await query(`DELETE FROM vendor_contract_increase_rules WHERE contract_id=$1`, [contractId]);
  let sortOrder = 0;
  for (const rule of rules) {
    await query(
      `INSERT INTO vendor_contract_increase_rules (contract_id, duration_months, increase_percentage, sort_order) VALUES ($1,$2,$3,$4)`,
      [contractId, rule.increaseDurationMonths, rule.increasePercentage, sortOrder]
    );
    sortOrder += 1;
  }
}

const CONTRACT_AGGREGATE_SELECT = `
  c.*,
  (SELECT count(*)::int FROM vendor_contract_documents d WHERE d.contract_id = c.id) AS document_count,
  (SELECT count(*)::int FROM vendor_contract_payments p WHERE p.contract_id = c.id AND p.paid_at IS NULL AND p.due_date >= current_date AND p.due_date <= current_date + interval '90 days') AS due_soon_payment_count,
  (SELECT count(*)::int FROM vendor_contract_payments p WHERE p.contract_id = c.id AND p.paid_at IS NULL AND p.due_date < current_date) AS overdue_payment_count,
  (SELECT count(*)::int FROM vendor_contract_payments p WHERE p.contract_id = c.id AND p.paid_at IS NOT NULL) AS paid_payment_count,
  (SELECT p.payment_label FROM vendor_contract_payments p WHERE p.contract_id = c.id AND p.paid_at IS NULL ORDER BY p.due_date ASC LIMIT 1) AS next_payment_label,
  (SELECT p.due_date FROM vendor_contract_payments p WHERE p.contract_id = c.id AND p.paid_at IS NULL ORDER BY p.due_date ASC LIMIT 1) AS next_payment_due_date,
  (SELECT p.amount FROM vendor_contract_payments p WHERE p.contract_id = c.id AND p.paid_at IS NULL ORDER BY p.due_date ASC LIMIT 1) AS next_payment_amount
`;

function mapContract(row: any, increaseRules: any[]) {
  return {
    id: row.id,
    contractNumber: row.contract_number,
    title: row.title,
    counterpartyName: row.counterparty_name,
    contractType: row.contract_type,
    notificationEmail: row.notification_email,
    startDate: row.start_date,
    endDate: row.end_date,
    renewalDate: row.renewal_date,
    noticePeriodDate: row.notice_period_date,
    contractValue: Number(row.contract_value),
    increaseRules,
    paymentTerms: row.payment_terms,
    status: row.status,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextPaymentLabel: row.next_payment_label,
    nextPaymentDueDate: row.next_payment_due_date,
    nextPaymentAmount: row.next_payment_amount != null ? Number(row.next_payment_amount) : null,
    documentCount: row.document_count,
    dueSoonPaymentCount: row.due_soon_payment_count,
    overduePaymentCount: row.overdue_payment_count,
    paidPaymentCount: row.paid_payment_count
  };
}

function mapPayment(row: any) {
  return {
    id: row.id,
    contractId: row.contract_id,
    paymentLabel: row.payment_label,
    amount: Number(row.amount),
    dueDate: row.due_date,
    status: getComputedPaymentStatus(row.due_date, row.paid_at),
    paidAt: row.paid_at,
    notes: row.notes,
    createdAt: row.created_at
  };
}

function mapDocument(row: any) {
  return {
    id: row.id,
    contractId: row.contract_id,
    fileName: row.file_name,
    filePath: row.file_path,
    fileType: row.file_type,
    fileSize: row.file_size != null ? Number(row.file_size) : null,
    uploadedAt: row.uploaded_at
  };
}

// ── Router ──────────────────────────────────────────────────────────────
export const vendorContractsRouter = Router();
vendorContractsRouter.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeUploadFilename(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileExtensionFilter(["pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg"])
});

async function requireModuleEnabled() {
  if (!(await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.vendorContractsModuleEnabled, true))) {
    throw notFound("Vendor Contracts is not currently enabled");
  }
}

vendorContractsRouter.get("/access", async (req: AuthedRequest, res, next) => {
  try {
    const enabled = await getBooleanSystemSetting(SYSTEM_SETTING_KEYS.vendorContractsModuleEnabled, true);
    if (!enabled) return res.json({ allowed: false });
    const allowed = await canAccessVendorContracts(req.user!.userId, req.user!.role);
    if (!allowed) return res.json({ allowed });
    const canManage = await canManageVendorContracts(req.user!.userId, req.user!.role);
    return res.json({ allowed, canManage });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.use(async (req: AuthedRequest, res, next) => {
  try {
    await requireModuleEnabled();
    if (!(await canAccessVendorContracts(req.user!.userId, req.user!.role))) {
      throw forbidden("You do not have access to Vendor Contracts");
    }
    next();
  } catch (err) {
    next(err);
  }
});

async function requireManage(req: AuthedRequest) {
  if (!(await canManageVendorContracts(req.user!.userId, req.user!.role))) {
    throw forbidden("You do not have permission to manage Vendor Contracts");
  }
}

const IncreaseRuleSchema = z.object({
  increaseDurationMonths: z.number().int().positive(),
  increasePercentage: z.number().min(0)
});

const ContractSchema = z.object({
  title: z.string().trim().min(1),
  counterpartyName: z.string().trim().min(1),
  contractType: z.string().trim().optional(),
  notificationEmail: z.string().trim().optional(),
  startDate: z.string(),
  endDate: z.string(),
  renewalDate: z.string().optional(),
  noticePeriodDate: z.string().optional(),
  contractValue: z.number().min(0).default(0),
  paymentTerms: z.string().trim().optional(),
  status: z.enum(["ACTIVE", "EXPIRED", "TERMINATED", "PENDING_RENEWAL"]).default("ACTIVE"),
  description: z.string().trim().optional(),
  increaseRules: z.array(IncreaseRuleSchema).default([])
});

vendorContractsRouter.get("/", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT ${CONTRACT_AGGREGATE_SELECT} FROM vendor_contracts c ORDER BY c.end_date ASC, c.created_at DESC`);
    const increaseRulesByContract = await getIncreaseRulesByContractIds(rows.map((r) => r.id));
    return res.json({ items: rows.map((r) => mapContract(r, increaseRulesByContract.get(r.id) ?? [])) });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.get("/dashboard", async (_req: AuthedRequest, res, next) => {
  try {
    const [stats, upcomingPayments, expiringContracts, overduePayments, active] = await Promise.all([
      query<any>(`
        SELECT
          (SELECT count(*)::int FROM vendor_contracts WHERE status='ACTIVE') AS active_count,
          (SELECT count(*)::int FROM vendor_contracts WHERE status='ACTIVE' AND end_date <= current_date + interval '90 days') AS expiring_count,
          (SELECT count(*)::int FROM vendor_contract_payments WHERE paid_at IS NULL AND due_date >= current_date AND due_date <= current_date + interval '90 days') AS due_soon_count,
          (SELECT count(*)::int FROM vendor_contract_payments WHERE paid_at IS NULL AND due_date < current_date) AS overdue_count
      `),
      query<any>(`
        SELECT p.id, p.payment_label, p.amount, p.due_date, c.title, c.counterparty_name
          FROM vendor_contract_payments p JOIN vendor_contracts c ON c.id = p.contract_id
         WHERE p.paid_at IS NULL ORDER BY p.due_date ASC LIMIT 5
      `),
      query<any>(`
        SELECT id, title, counterparty_name, end_date FROM vendor_contracts
         WHERE status='ACTIVE' AND end_date <= current_date + interval '90 days'
         ORDER BY end_date ASC LIMIT 5
      `),
      query<any>(`
        SELECT p.id, p.payment_label, p.amount, p.due_date, c.title, c.counterparty_name
          FROM vendor_contract_payments p JOIN vendor_contracts c ON c.id = p.contract_id
         WHERE p.paid_at IS NULL AND p.due_date < current_date ORDER BY p.due_date ASC LIMIT 5
      `),
      query<any>(`SELECT id, title, counterparty_name, end_date FROM vendor_contracts WHERE status='ACTIVE' ORDER BY end_date ASC LIMIT 5`)
    ]);

    const s = stats[0];
    const renewalReminders = active
      .map((c: any) => ({ title: c.title, primaryLabel: "Counterparty", primaryValue: c.counterparty_name, secondaryLabel: "Stage", secondaryValue: getExpiryReminderStage(c.end_date) }))
      .filter((r: any) => r.secondaryValue);

    return res.json({
      stats: [
        { label: "Active Contracts", value: s.active_count, icon: "file", tone: "blue" },
        { label: "Expiring in 90 Days", value: s.expiring_count, icon: "clock", tone: "yellow" },
        { label: "Payments Due Soon", value: s.due_soon_count, icon: "wallet", tone: "yellow" },
        { label: "Overdue Payments", value: s.overdue_count, icon: "alert", tone: "red" }
      ],
      upcomingPayments: upcomingPayments.map((p: any) => ({ contract: p.title, vendor: p.counterparty_name, dueDate: p.due_date, amount: p.amount })),
      expiringContracts: expiringContracts.map((c: any) => ({ contract: c.title, vendor: c.counterparty_name, endDate: c.end_date })),
      overduePayments: overduePayments.map((p: any) => ({ title: p.title, primaryLabel: "Vendor", primaryValue: p.counterparty_name, secondaryLabel: "Amount", secondaryValue: String(p.amount) })),
      renewalReminders,
      statusOverview: [
        { label: "Active", value: s.active_count, color: "blue" },
        { label: "Due Soon", value: s.due_soon_count, color: "yellow" },
        { label: "Overdue", value: s.overdue_count, color: "red" }
      ],
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.get("/reports/mail", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT l.id, l.contract_id, c.contract_number, c.title AS contract_title, c.notification_email,
             l.notification_type, l.remind_on, l.sent_at, l.status, l.created_at
        FROM vendor_contract_reminder_log l
        JOIN vendor_contracts c ON c.id = l.contract_id
       ORDER BY coalesce(l.sent_at, l.created_at) DESC LIMIT 500
    `);
    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(`SELECT ${CONTRACT_AGGREGATE_SELECT} FROM vendor_contracts c WHERE c.id=$1`, [req.params.id]);
    if (!rows[0]) throw notFound();
    const increaseRulesByContract = await getIncreaseRulesByContractIds([req.params.id]);
    const [payments, documents] = await Promise.all([
      query<any>(`SELECT * FROM vendor_contract_payments WHERE contract_id=$1 ORDER BY due_date ASC`, [req.params.id]),
      query<any>(`SELECT * FROM vendor_contract_documents WHERE contract_id=$1 ORDER BY uploaded_at DESC`, [req.params.id])
    ]);
    return res.json({
      contract: mapContract(rows[0], increaseRulesByContract.get(req.params.id) ?? []),
      payments: payments.map(mapPayment),
      documents: documents.map(mapDocument)
    });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = ContractSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid contract payload", parsed.error.flatten());
    const d = parsed.data;
    const contractNumber = await nextSequentialNumber("VC", 6);
    const rows = await query<{ id: string }>(
      `INSERT INTO vendor_contracts
       (contract_number, title, counterparty_name, contract_type, notification_email, start_date, end_date,
        renewal_date, notice_period_date, contract_value, payment_terms, status, description, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        contractNumber, d.title, d.counterpartyName, d.contractType ?? null, d.notificationEmail ?? null,
        d.startDate, d.endDate, d.renewalDate ?? null, d.noticePeriodDate ?? null, d.contractValue,
        d.paymentTerms ?? null, d.status, d.description ?? null, req.user!.userId
      ]
    );
    await replaceIncreaseRules(rows[0].id, d.increaseRules);
    return res.status(201).json({ id: rows[0].id, contractNumber });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const existing = await query<{ id: string }>(`SELECT id FROM vendor_contracts WHERE id=$1`, [req.params.id]);
    if (!existing[0]) throw notFound();
    const parsed = ContractSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid contract payload", parsed.error.flatten());
    const d = parsed.data;
    await query(
      `UPDATE vendor_contracts SET
         title=$2, counterparty_name=$3, contract_type=$4, notification_email=$5, start_date=$6, end_date=$7,
         renewal_date=$8, notice_period_date=$9, contract_value=$10, payment_terms=$11, status=$12,
         description=$13, updated_at=now()
       WHERE id=$1`,
      [
        req.params.id, d.title, d.counterpartyName, d.contractType ?? null, d.notificationEmail ?? null,
        d.startDate, d.endDate, d.renewalDate ?? null, d.noticePeriodDate ?? null, d.contractValue,
        d.paymentTerms ?? null, d.status, d.description ?? null
      ]
    );
    await replaceIncreaseRules(req.params.id, d.increaseRules);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.patch("/:id/active", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const existing = await query<{ id: string }>(`SELECT id FROM vendor_contracts WHERE id=$1`, [req.params.id]);
    if (!existing[0]) throw notFound();
    await query(`UPDATE vendor_contracts SET is_active=$2, updated_at=now() WHERE id=$1`, [req.params.id, parsed.data.isActive]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

const PaymentSchema = z.object({
  paymentLabel: z.string().trim().optional(),
  amount: z.number().positive(),
  dueDate: z.string(),
  notes: z.string().trim().optional()
});

vendorContractsRouter.post("/:id/payments", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const contract = await query<{ id: string }>(`SELECT id FROM vendor_contracts WHERE id=$1`, [req.params.id]);
    if (!contract[0]) throw notFound();
    const parsed = PaymentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payment payload", parsed.error.flatten());
    const d = parsed.data;
    const rows = await query<{ id: string }>(
      `INSERT INTO vendor_contract_payments (contract_id, payment_label, amount, due_date, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.params.id, d.paymentLabel ?? null, d.amount, d.dueDate, d.notes ?? null]
    );
    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.post("/:contractId/payments/:paymentId/mark-paid", async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const rows = await query<{ id: string }>(
      `UPDATE vendor_contract_payments SET paid_at=now()
        WHERE id=$1 AND contract_id=$2 AND paid_at IS NULL
        RETURNING id`,
      [req.params.paymentId, req.params.contractId]
    );
    if (!rows[0]) throw notFound("Payment not found or already paid");
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.post("/:id/documents", upload.single("file"), async (req: AuthedRequest, res, next) => {
  try {
    await requireManage(req);
    const contract = await query<{ id: string }>(`SELECT id FROM vendor_contracts WHERE id=$1`, [req.params.id]);
    if (!contract[0]) throw notFound();
    if (!req.file) throw badRequest("Missing file");
    const rows = await query<any>(
      `INSERT INTO vendor_contract_documents (contract_id, file_name, file_path, file_type, file_size, uploaded_by_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, req.user!.userId]
    );
    return res.status(201).json({ document: mapDocument(rows[0]) });
  } catch (err) {
    return next(err);
  }
});

vendorContractsRouter.get("/:contractId/documents/:documentId", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT * FROM vendor_contract_documents WHERE id=$1 AND contract_id=$2`,
      [req.params.documentId, req.params.contractId]
    );
    const doc = rows[0];
    if (!doc) throw notFound();
    if (!fs.existsSync(doc.file_path)) throw notFound();
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename="${path.basename(doc.file_name)}"`);
    if (doc.file_type) res.setHeader("Content-Type", doc.file_type);
    fs.createReadStream(doc.file_path).pipe(res);
  } catch (err) {
    return next(err);
  }
});

// ── Expiry reminder worker ──────────────────────────────────────────────
// In-process interval, same as the source app - only runs while this node
// process is up, no persistence/catch-up across restarts beyond the
// dedup check against vendor_contract_reminder_log.
function buildReminderCheckpoints(endDate: string): Array<{ type: string; remindOn: string; isDue: boolean }> {
  const end = new Date(endDate + "T00:00:00Z");
  const today = todayUtc();
  const checkpoints: Array<{ type: string; months?: number; days?: number }> = [
    { type: "CONTRACT_EXPIRY_3_MONTH", months: 3 },
    { type: "CONTRACT_EXPIRY_2_MONTH", months: 2 },
    { type: "CONTRACT_EXPIRY_1_MONTH", months: 1 },
    { type: "CONTRACT_EXPIRY_1_DAY", days: 1 }
  ];
  const out = checkpoints.map((c) => {
    const remindOn = new Date(end);
    if (c.months) remindOn.setUTCMonth(remindOn.getUTCMonth() - c.months);
    if (c.days) remindOn.setUTCDate(remindOn.getUTCDate() - c.days);
    const remindOnStr = remindOn.toISOString().slice(0, 10);
    return { type: c.type, remindOn: remindOnStr, isDue: remindOnStr === today.toISOString().slice(0, 10) };
  });
  // Repeats once/day (deduped by remind_on=today) for every cycle once past expiry.
  out.push({ type: "CONTRACT_EXPIRY_SAME_DAY", remindOn: today.toISOString().slice(0, 10), isDue: end <= today });
  return out;
}

async function runVendorContractReminderCycle() {
  const contracts = await query<any>(`SELECT id, contract_number, title, end_date, notification_email FROM vendor_contracts WHERE status='ACTIVE'`);
  for (const c of contracts) {
    if (!c.notification_email) continue;
    for (const checkpoint of buildReminderCheckpoints(c.end_date)) {
      if (!checkpoint.isDue) continue;
      const existing = await query<{ id: string }>(
        `SELECT id FROM vendor_contract_reminder_log WHERE contract_id=$1 AND notification_type=$2 AND remind_on=$3 AND status='SENT'`,
        [c.id, checkpoint.type, checkpoint.remindOn]
      );
      if (existing[0]) continue;
      try {
        await notifyVendorContractExpiring({
          contractId: c.id,
          contractNumber: c.contract_number,
          contractTitle: c.title,
          notificationEmail: c.notification_email,
          endDate: c.end_date,
          checkpointType: checkpoint.type
        });
        await query(
          `INSERT INTO vendor_contract_reminder_log (contract_id, notification_type, remind_on, sent_at, status) VALUES ($1,$2,$3,now(),'SENT')`,
          [c.id, checkpoint.type, checkpoint.remindOn]
        );
      } catch {
        await query(
          `INSERT INTO vendor_contract_reminder_log (contract_id, notification_type, remind_on, status) VALUES ($1,$2,$3,'FAILED')`,
          [c.id, checkpoint.type, checkpoint.remindOn]
        );
      }
    }
  }
}

export function startVendorContractReminderWorker() {
  const intervalMinutes = Number(process.env.VENDOR_CONTRACT_REMINDER_INTERVAL_MINUTES || 60);
  runVendorContractReminderCycle().catch(() => {});
  setInterval(() => { runVendorContractReminderCycle().catch(() => {}); }, intervalMinutes * 60_000);
}
