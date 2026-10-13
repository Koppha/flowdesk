import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireAuth } from "../../lib/auth.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { query } from "../../lib/db.js";
import { notifyDocumentDistributed } from "../../lib/notifications.js";

// Manual distribution of a fully approved BRS or Change Request. Nothing is
// sent automatically on approval: the requester (or an admin) chooses who
// receives it, and those people get an email plus read-only access to the
// document and its PDF. Every send is kept, so a document can be distributed
// again to more people later.

export type DistributionDocType = "BRS" | "CHANGE_REQUEST";

export async function ensureDistributionsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS document_distributions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_type text NOT NULL,
      doc_id uuid NOT NULL,
      distributed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
      message text,
      targets jsonb NOT NULL DEFAULT '{}',
      recipient_ids uuid[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_doc_distributions_doc ON document_distributions(doc_type, doc_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_doc_distributions_recipients ON document_distributions USING gin(recipient_ids)`);
}

// Read-only access for anyone a document has been distributed to.
export async function hasDistributionAccess(docType: DistributionDocType, docId: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM document_distributions WHERE doc_type = $1 AND doc_id = $2 AND $3::uuid = ANY(recipient_ids) LIMIT 1`,
    [docType, docId, userId]
  );
  return rows.length > 0;
}

type DistributableDoc = { requesterId: string; title: string; label: string; ready: boolean; notReadyReason: string };

async function loadDistributableDoc(docType: DistributionDocType, docId: string): Promise<DistributableDoc> {
  if (docType === "BRS") {
    const doc = (await query<{ requester_id: string; title: string; phase: string; reference_no: string | null }>(
      `SELECT requester_id, title, phase, reference_no FROM brs_documents WHERE id = $1`, [docId]
    ))[0];
    if (!doc) throw notFound("BRS not found");
    return {
      requesterId: doc.requester_id,
      title: doc.reference_no ? `${doc.reference_no} — ${doc.title}` : doc.title,
      label: "BRS",
      ready: doc.phase === "BASELINE",
      notReadyReason: "A BRS can only be distributed once it has been fully approved"
    };
  }
  const sub = (await query<{ requester_id: string; status: string; code: string; data: any }>(
    `SELECT s.requester_id, s.status, rt.code, s.data
       FROM custom_request_submissions s
       JOIN custom_request_types rt ON rt.id = s.request_type_id
      WHERE s.id = $1`,
    [docId]
  ))[0];
  if (!sub || sub.code !== "CHANGE_REQUEST") throw notFound("Change Request not found");
  return {
    requesterId: sub.requester_id,
    title: String(sub.data?.description_of_change || "Change Request").slice(0, 120),
    label: "Change Request",
    ready: ["APPROVED", "CLOSED"].includes(sub.status),
    notReadyReason: "A Change Request can only be distributed once it has been fully approved"
  };
}

function assertCanDistribute(doc: DistributableDoc, actor: { userId: string; role: string }) {
  if (actor.role !== "ADMIN" && doc.requesterId !== actor.userId) {
    throw forbidden("Only the requester or an admin can distribute this");
  }
}

export const distributionsRouter = Router();
distributionsRouter.use(requireAuth);

// GET /distributions/options — groups to pick from, using the UI's names:
// Division = users.department, Department = sections, Section = teams.
distributionsRouter.get("/options", async (_req: AuthedRequest, res, next) => {
  try {
    const [divisions, departments, sections] = await Promise.all([
      query<{ name: string; company: string | null; members: number }>(
        `SELECT d.name, v.name AS company,
                (SELECT count(*)::int FROM users u WHERE u.is_active AND lower(trim(u.department)) = lower(trim(d.name))) AS members
           FROM departments d LEFT JOIN divisions v ON v.id = d.division_id
          WHERE d.active = true
          ORDER BY v.name NULLS LAST, d.name`
      ),
      query<{ id: string; name: string; parent: string | null; members: number }>(
        `SELECT s.id, s.name, d.name AS parent,
                (SELECT count(*)::int FROM users u WHERE u.is_active AND u.section_id = s.id) AS members
           FROM sections s LEFT JOIN departments d ON d.id = s.department_id
          WHERE coalesce(s.active, true)
          ORDER BY s.name`
      ),
      query<{ id: string; name: string; parent: string | null; members: number }>(
        `SELECT t.id, t.name, s.name AS parent,
                (SELECT count(*)::int FROM users u WHERE u.is_active AND u.team_id = t.id) AS members
           FROM teams t LEFT JOIN sections s ON s.id = t.section_id
          WHERE coalesce(t.active, true)
          ORDER BY t.name`
      )
    ]);
    return res.json({ divisions, departments, sections });
  } catch (err) {
    return next(err);
  }
});

// GET /distributions/mine — everything distributed to the current user.
distributionsRouter.get("/mine", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT DISTINCT ON (dd.doc_type, dd.doc_id)
              dd.doc_type, dd.doc_id, dd.created_at AS distributed_at, dd.message, ub.full_name AS distributed_by_name,
              CASE WHEN dd.doc_type = 'BRS' THEN coalesce(b.reference_no || ' — ', '') || b.title
                   ELSE coalesce(s.data->>'description_of_change', 'Change Request') END AS title
         FROM document_distributions dd
         LEFT JOIN users ub ON ub.id = dd.distributed_by_id
         LEFT JOIN brs_documents b ON dd.doc_type = 'BRS' AND b.id = dd.doc_id
         LEFT JOIN custom_request_submissions s ON dd.doc_type = 'CHANGE_REQUEST' AND s.id = dd.doc_id
        WHERE $1::uuid = ANY(dd.recipient_ids)
        ORDER BY dd.doc_type, dd.doc_id, dd.created_at DESC`,
      [req.user!.userId]
    );
    rows.sort((a: any, b: any) => String(b.distributed_at).localeCompare(String(a.distributed_at)));
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

const DocTypeParam = z.enum(["BRS", "CHANGE_REQUEST"]);

// GET /distributions/:docType/:docId — the document's distribution history
// (requester or admin).
distributionsRouter.get("/:docType/:docId", async (req: AuthedRequest, res, next) => {
  try {
    const docType = DocTypeParam.parse(req.params.docType);
    const doc = await loadDistributableDoc(docType, req.params.docId);
    assertCanDistribute(doc, req.user!);
    const rows = await query(
      `SELECT dd.id, dd.message, dd.targets, cardinality(dd.recipient_ids) AS recipient_count, dd.created_at,
              ub.full_name AS distributed_by_name
         FROM document_distributions dd
         LEFT JOIN users ub ON ub.id = dd.distributed_by_id
        WHERE dd.doc_type = $1 AND dd.doc_id = $2
        ORDER BY dd.created_at DESC`,
      [docType, req.params.docId]
    );
    return res.json({ ready: doc.ready, items: rows });
  } catch (err) {
    return next(err);
  }
});

const DistributeSchema = z.object({
  user_ids: z.array(z.string().uuid()).default([]),
  divisions: z.array(z.string().trim().min(1)).default([]),
  department_ids: z.array(z.string().uuid()).default([]),
  section_ids: z.array(z.string().uuid()).default([]),
  message: z.string().trim().max(2000).nullish()
});

// POST /distributions/:docType/:docId — send it.
distributionsRouter.post("/:docType/:docId", async (req: AuthedRequest, res, next) => {
  try {
    const docType = DocTypeParam.parse(req.params.docType);
    const parsed = DistributeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid payload", parsed.error.flatten());
    const { user_ids, divisions, department_ids, section_ids, message } = parsed.data;
    if (!user_ids.length && !divisions.length && !department_ids.length && !section_ids.length) {
      throw badRequest("Choose at least one person or group to distribute to");
    }

    const doc = await loadDistributableDoc(docType, req.params.docId);
    assertCanDistribute(doc, req.user!);
    if (!doc.ready) throw badRequest(doc.notReadyReason);

    const recipients = await query<{ id: string; email: string; full_name: string | null }>(
      `SELECT id, email, full_name FROM users
        WHERE is_active = true AND id <> $5::uuid
          AND (id = ANY($1::uuid[])
               OR lower(trim(department)) = ANY($2::text[])
               OR section_id = ANY($3::uuid[])
               OR team_id = ANY($4::uuid[]))`,
      [user_ids, divisions.map((d) => d.toLowerCase()), department_ids, section_ids, req.user!.userId]
    );
    if (!recipients.length) throw badRequest("Nobody active matches the people and groups you chose");

    // Names snapshot, so history reads the same even if groups are renamed.
    const [departmentNames, sectionNames, userNames] = await Promise.all([
      query<{ name: string }>(`SELECT name FROM sections WHERE id = ANY($1::uuid[]) ORDER BY name`, [department_ids]),
      query<{ name: string }>(`SELECT name FROM teams WHERE id = ANY($1::uuid[]) ORDER BY name`, [section_ids]),
      query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = ANY($1::uuid[]) ORDER BY full_name`, [user_ids])
    ]);
    const targets = {
      people: userNames.map((u) => u.full_name),
      divisions,
      departments: departmentNames.map((d) => d.name),
      sections: sectionNames.map((s) => s.name)
    };

    await query(
      `INSERT INTO document_distributions (doc_type, doc_id, distributed_by_id, message, targets, recipient_ids)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[])`,
      [docType, req.params.docId, req.user!.userId, message || null, JSON.stringify(targets), recipients.map((r) => r.id)]
    );

    void notifyDocumentDistributed({
      docId: req.params.docId,
      docLabel: doc.label,
      title: doc.title,
      distributedBy: req.user!.fullName ?? null,
      message: message || null,
      where: docType === "BRS" ? "BRS Studio > Shared with me" : "Custom Requests > Shared with me",
      recipientEmails: recipients.map((r) => r.email)
    });

    return res.status(201).json({ ok: true, recipient_count: recipients.length });
  } catch (err) {
    return next(err);
  }
});
