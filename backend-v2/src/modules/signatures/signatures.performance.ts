import { query } from "../../lib/db.js";
import { ensureSignaturesSchema } from "./signatures.schema.js";

// Sign a Document performance (admin, Sign a Document > Performance):
// volumes, how fast documents get fully signed, how fast each person acts
// on a step that's waiting for them, and what's stuck right now.
//
// Times come from what the module already records: a document's created_at,
// each route step's acted_at (approval_chain), closed_at for documents with
// no route. A step's wait starts when the previous step acted (or when the
// document was sent, for the first step).

const HOUR = 3_600_000;
const TZ = "Africa/Maseru";

type Step = { approver_id: string; approver_name: string; status: "PENDING" | "SIGNED" | "REJECTED"; acted_at: string | null };
type DocRow = {
  id: string; title: string; status: string; created_at: Date; closed_at: Date | null;
  approval_chain: Step[] | null; current_step_order: number; channel: string | null;
  created_by_id: string; creator_name: string | null;
};
type SignRow = { signer_id: string; signed_at: Date; channel: string | null };

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const dayOf = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });

/** When the document stopped moving: fully signed, rejected, or finished by its creator. */
function finishedAt(doc: DocRow): Date | null {
  const chain = doc.approval_chain || [];
  if (doc.status === "COMPLETED" && chain.length === 0) return doc.closed_at;
  if (doc.status === "COMPLETED" || doc.status === "REJECTED") {
    const times = chain.map((s) => (s.acted_at ? Date.parse(s.acted_at) : 0)).filter(Boolean);
    return times.length ? new Date(Math.max(...times)) : doc.closed_at;
  }
  return null;
}

/** When step i started waiting: the previous step's action, or the document being sent. */
function stepStart(doc: DocRow, i: number): Date {
  const prev = i > 0 ? doc.approval_chain![i - 1]?.acted_at : null;
  return prev ? new Date(prev) : doc.created_at;
}

export async function getSigningPerformance(days: number, slaHours: number) {
  await ensureSignaturesSchema();
  const now = Date.now();
  const since = new Date(now - days * 24 * HOUR);

  const [docs, quick, placed] = await Promise.all([
    query<DocRow>(
      `SELECT d.id, d.title, d.status, d.created_at, d.closed_at, d.approval_chain, d.current_step_order,
              d.channel, d.created_by_id, u.full_name AS creator_name
         FROM signable_documents d
         JOIN users u ON u.id = d.created_by_id
        WHERE d.created_at >= $1 OR d.status = 'OPEN'`,
      [since]
    ),
    query<SignRow>(`SELECT signer_id, signed_at, channel FROM document_signatures WHERE signed_at >= $1`, [since]),
    query<SignRow>(`SELECT signer_id, signed_at, channel FROM document_signature_placements WHERE signed_at >= $1`, [since])
  ]);

  const inPeriod = docs.filter((d) => d.created_at >= since && d.status !== "DELETED");
  const deleted = docs.filter((d) => d.created_at >= since && d.status === "DELETED").length;
  const routed = inPeriod.filter((d) => (d.approval_chain || []).length > 0);

  // Sent -> fully signed (or rejected), for documents sent in the period.
  const completed = inPeriod.filter((d) => d.status === "COMPLETED");
  const rejected = inPeriod.filter((d) => d.status === "REJECTED");
  const turnaround = completed
    .map((d) => finishedAt(d))
    .map((t, i) => (t ? (t.getTime() - completed[i].created_at.getTime()) / HOUR : null))
    .filter((h): h is number => h !== null && h >= 0);

  // Every step acted on in the period, and every step waiting right now.
  type Person = {
    userId: string; signatures: number; quickSigns: number; routedSigns: number; sent: number;
    response: number[]; withinSla: number; rejected: number; waiting: number; oldestWaiting: number | null;
  };
  const people = new Map<string, Person>();
  const person = (id: string) => {
    let p = people.get(id);
    if (!p) people.set(id, (p = { userId: id, signatures: 0, quickSigns: 0, routedSigns: 0, sent: 0, response: [], withinSla: 0, rejected: 0, waiting: 0, oldestWaiting: null }));
    return p;
  };

  const response: number[] = [];
  const waitingNow: { id: string; title: string; approverId: string; approverName: string; step: number; steps: number; waitingHours: number; sentBy: string | null; sentAt: Date }[] = [];
  for (const d of docs) {
    const chain = d.approval_chain || [];
    chain.forEach((s, i) => {
      if (s.acted_at && Date.parse(s.acted_at) >= since.getTime() && s.status !== "PENDING") {
        const h = (Date.parse(s.acted_at) - stepStart(d, i).getTime()) / HOUR;
        if (h >= 0) {
          response.push(h);
          const p = person(s.approver_id);
          p.response.push(h);
          if (h <= slaHours) p.withinSla++;
          if (s.status === "REJECTED") p.rejected++;
        }
      }
    });
    if (d.status === "OPEN" && d.current_step_order < chain.length) {
      const s = chain[d.current_step_order];
      const h = (now - stepStart(d, d.current_step_order).getTime()) / HOUR;
      const p = person(s.approver_id);
      p.waiting++;
      p.oldestWaiting = Math.max(p.oldestWaiting ?? 0, h);
      waitingNow.push({
        id: d.id, title: d.title, approverId: s.approver_id, approverName: s.approver_name,
        step: d.current_step_order + 1, steps: chain.length, waitingHours: h, sentBy: d.creator_name, sentAt: d.created_at
      });
    }
  }
  for (const d of inPeriod) person(d.created_by_id).sent++;
  for (const s of quick) { const p = person(s.signer_id); p.signatures++; p.quickSigns++; }
  for (const s of placed) { const p = person(s.signer_id); p.signatures++; p.routedSigns++; }

  const names = people.size
    ? await query<{ id: string; full_name: string | null; department: string | null }>(
        `SELECT id, full_name, department FROM users WHERE id = ANY($1::uuid[])`, [[...people.keys()]]
      )
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n]));

  // Web vs the mobile app. Signatures from before this was recorded have no channel.
  const channels = { web: 0, mobile: 0, unknown: 0 };
  for (const s of [...quick, ...placed]) {
    if (s.channel === "MOBILE") channels.mobile++;
    else if (s.channel === "WEB") channels.web++;
    else channels.unknown++;
  }

  // Signatures, documents sent and documents completed over time - by day up
  // to 90 days, by week beyond that.
  const byWeek = days > 90;
  const bucketOf = (t: Date) => {
    if (!byWeek) return dayOf(t);
    const d = new Date(dayOf(t) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
    return d.toISOString().slice(0, 10);
  };
  const series = new Map<string, { day: string; signatures: number; sent: number; completed: number }>();
  for (let t = since.getTime(); t <= now; t += 24 * HOUR) {
    const k = bucketOf(new Date(t));
    if (!series.has(k)) series.set(k, { day: k, signatures: 0, sent: 0, completed: 0 });
  }
  const bump = (t: Date | null, key: "signatures" | "sent" | "completed") => {
    if (!t || t < since) return;
    const row = series.get(bucketOf(t));
    if (row) row[key]++;
  };
  for (const s of [...quick, ...placed]) bump(s.signed_at, "signatures");
  for (const d of inPeriod) bump(d.created_at, "sent");
  for (const d of docs) if (d.status === "COMPLETED") bump(finishedAt(d), "completed");

  const overdue = waitingNow.filter((w) => w.waitingHours > slaHours);
  return {
    days,
    slaHours,
    bucket: byWeek ? "week" : "day",
    summary: {
      signatures: quick.length + placed.length,
      quickSigns: quick.length,
      routedSigns: placed.length,
      signers: new Set([...quick, ...placed].map((s) => s.signer_id)).size,
      sent: inPeriod.length,
      sentWithRoute: routed.length,
      completed: completed.length,
      rejected: rejected.length,
      stillOpen: inPeriod.filter((d) => d.status === "OPEN").length,
      deleted,
      completionRate: pct(completed.length, inPeriod.length),
      rejectionRate: pct(rejected.length, routed.length),
      turnaroundMedianHours: round1(median(turnaround)),
      turnaroundAvgHours: round1(avg(turnaround)),
      stepMedianHours: round1(median(response)),
      stepAvgHours: round1(avg(response)),
      stepsActed: response.length,
      stepsWithinSla: pct(response.filter((h) => h <= slaHours).length, response.length),
      waitingNow: waitingNow.length,
      overdueNow: overdue.length,
      openWithoutRoute: docs.filter((d) => d.status === "OPEN" && !(d.approval_chain || []).length).length
    },
    channels,
    series: [...series.values()],
    waiting: waitingNow
      .sort((a, b) => b.waitingHours - a.waitingHours)
      .slice(0, 50)
      .map((w) => ({ ...w, waitingHours: round1(w.waitingHours), overdue: w.waitingHours > slaHours })),
    people: [...people.values()]
      .map((p) => ({
        userId: p.userId,
        fullName: nameOf.get(p.userId)?.full_name ?? "Unknown",
        department: nameOf.get(p.userId)?.department ?? null,
        signatures: p.signatures,
        quickSigns: p.quickSigns,
        routedSigns: p.routedSigns,
        sent: p.sent,
        stepsActed: p.response.length,
        medianResponseHours: round1(median(p.response)),
        avgResponseHours: round1(avg(p.response)),
        withinSla: pct(p.withinSla, p.response.length),
        rejected: p.rejected,
        waiting: p.waiting,
        oldestWaitingHours: round1(p.oldestWaiting)
      }))
      .sort((a, b) => b.waiting - a.waiting || b.signatures - a.signatures || b.sent - a.sent)
  };
}
