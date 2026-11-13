import { z } from "zod";
import { query } from "./db.js";

// Working on a BRS or Change Request together: who has it open right now and
// which section each person is editing. Every open page checks in every few
// seconds; anyone not heard from for 25 seconds has left. Saves themselves are
// protected separately (a save over someone else's newer change is refused
// with what they wrote, so nothing is overwritten silently).

export type DocKind = "BRS" | "CR";

export const PresenceSchema = z.object({
  section_key: z.string().max(120).nullish(),
  editing: z.boolean().default(false),
  leaving: z.boolean().default(false)
});

let ready: Promise<void> | null = null;
function ensureTable() {
  ready ??= query(
    `CREATE TABLE IF NOT EXISTS coedit_presence (
       doc_kind text NOT NULL,
       doc_id uuid NOT NULL,
       user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       section_key text,
       editing boolean NOT NULL DEFAULT false,
       seen_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (doc_kind, doc_id, user_id)
     )`
  ).then(() => undefined).catch((err) => { ready = null; throw err; });
  return ready;
}

export type PresentPerson = { user_id: string; name: string | null; section_key: string | null; editing: boolean };

// Check in (or leave) and get everyone else who is here.
export async function checkIn(kind: DocKind, docId: string, userId: string, p: z.infer<typeof PresenceSchema>): Promise<PresentPerson[]> {
  await ensureTable();
  if (p.leaving) {
    await query(`DELETE FROM coedit_presence WHERE doc_kind = $1 AND doc_id = $2 AND user_id = $3`, [kind, docId, userId]);
  } else {
    await query(
      `INSERT INTO coedit_presence (doc_kind, doc_id, user_id, section_key, editing, seen_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (doc_kind, doc_id, user_id) DO UPDATE SET section_key = EXCLUDED.section_key, editing = EXCLUDED.editing, seen_at = now()`,
      [kind, docId, userId, p.section_key ?? null, p.editing && !!p.section_key]
    );
  }
  if (Math.random() < 0.02) void query(`DELETE FROM coedit_presence WHERE seen_at < now() - interval '1 day'`).catch(() => {});
  return query<PresentPerson>(
    `SELECT p.user_id, u.full_name AS name, p.section_key, p.editing
       FROM coedit_presence p JOIN users u ON u.id = p.user_id
      WHERE p.doc_kind = $1 AND p.doc_id = $2 AND p.user_id <> $3 AND p.seen_at > now() - interval '25 seconds'
      ORDER BY u.full_name`,
    [kind, docId, userId]
  );
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
