import { Router } from "express";
import { z } from "zod";
import { type AuthedRequest, requireRole } from "../../lib/auth.js";
import { query } from "../../lib/db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { logger, serializeError } from "../../lib/logger.js";
import { notifySupportMessage } from "../../lib/notifications.js";
import { sendPushToUser } from "../../lib/push.js";

// Help & Support: a chat between a staff member and the support team - the
// admins plus anyone an admin adds as a support agent. Mounted by
// mobile-app.routes.ts at /mobile-app/support (after requireAuth). The app
// shows it as a server page (#/support), so it needs no app release.
//
// One conversation per person at a time: writing when the last one is closed
// opens a new one. Agents see everyone's; people see only their own.

export const supportRouter = Router();

let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  schemaReady ??= (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS support_agents (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await query(`
      CREATE TABLE IF NOT EXISTS support_conversations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'OPEN',
        created_at timestamptz NOT NULL DEFAULT now(),
        last_message_at timestamptz NOT NULL DEFAULT now(),
        closed_at timestamptz,
        closed_by uuid REFERENCES users(id) ON DELETE SET NULL
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_support_conversations_user ON support_conversations (user_id, created_at DESC)`);
    await query(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
        sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
        from_agent boolean NOT NULL DEFAULT false,
        body text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages (conversation_id, created_at)`);
    // When the staff member last looked at their chat - an agent's reply after
    // that shows in their Approval Inbox as unread.
    await query(`ALTER TABLE support_conversations ADD COLUMN IF NOT EXISTS user_read_at timestamptz`);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

supportRouter.use(async (_req, _res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    next(err);
  }
});

async function isAgent(userId: string, role: string) {
  if (role === "ADMIN") return true;
  return (await query(`SELECT 1 FROM support_agents WHERE user_id = $1`, [userId])).length > 0;
}

async function agentIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM users WHERE is_active AND role = 'ADMIN'
     UNION SELECT a.user_id FROM support_agents a JOIN users u ON u.id = a.user_id WHERE u.is_active`
  );
  return rows.map((r) => r.id);
}

async function messagesOf(conversationId: string) {
  return query(
    `SELECT m.id, m.body, m.from_agent, m.created_at, u.full_name AS sender_name, m.sender_id
       FROM support_messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1 ORDER BY m.created_at`,
    [conversationId]
  );
}

function push(userIds: string[], title: string, body: string) {
  for (const id of userIds) {
    void sendPushToUser(id, { title, body: body.slice(0, 140), data: { url: "/web?go=support" } }).catch((e: unknown) =>
      logger.warn("support_push_failed", { error: serializeError(e) })
    );
  }
}

async function emailsOf(userIds: string[]) {
  if (!userIds.length) return [];
  const rows = await query<{ email: string }>(`SELECT email FROM users WHERE id = ANY($1::uuid[]) AND is_active AND email IS NOT NULL`, [userIds]);
  return rows.map((r) => r.email);
}

// Emails go out alongside the push, for people working on the web.
function email(userIds: string[], subject: string, heading: string, lines: string[]) {
  void emailsOf(userIds)
    .then((emails) => notifySupportMessage({ emails, subject, heading, lines }))
    .catch((e: unknown) => logger.warn("support_email_failed", { error: serializeError(e) }));
}

const BodySchema = z.object({ body: z.string().trim().min(1, "Write a message").max(4000) });

// GET /mobile-app/support/me - my latest conversation (open or the last closed
// one) with its messages, and whether I'm an agent.
supportRouter.get("/me", async (req: AuthedRequest, res, next) => {
  try {
    const me = req.user!;
    const [conv] = await query<any>(`SELECT * FROM support_conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [me.userId]);
    // Looking at it reads support's replies (takes it out of my Approval Inbox).
    if (conv) await query(`UPDATE support_conversations SET user_read_at = now() WHERE id = $1`, [conv.id]);
    return res.json({
      isAgent: await isAgent(me.userId, me.role),
      conversation: conv ? { id: conv.id, status: conv.status, createdAt: conv.created_at } : null,
      messages: conv ? await messagesOf(conv.id) : []
    });
  } catch (err) {
    return next(err);
  }
});

// POST /mobile-app/support/me/messages - write to support (opens a new
// conversation if I have none open).
supportRouter.post("/me/messages", async (req: AuthedRequest, res, next) => {
  try {
    const p = BodySchema.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message || "Write a message");
    const me = req.user!;
    let [conv] = await query<any>(`SELECT * FROM support_conversations WHERE user_id = $1 AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1`, [me.userId]);
    if (!conv) [conv] = await query<any>(`INSERT INTO support_conversations (user_id) VALUES ($1) RETURNING *`, [me.userId]);
    // Email the team only when this starts the wait for an answer - not for
    // every follow-up line while they haven't replied yet.
    const [last] = await query<{ from_agent: boolean }>(`SELECT from_agent FROM support_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [conv.id]);
    await query(`INSERT INTO support_messages (conversation_id, sender_id, from_agent, body) VALUES ($1, $2, false, $3)`, [conv.id, me.userId, p.data.body]);
    await query(`UPDATE support_conversations SET last_message_at = now(), user_read_at = now() WHERE id = $1`, [conv.id]);
    const agents = (await agentIds()).filter((id) => id !== me.userId);
    push(agents, `Support: ${me.fullName || "a staff member"}`, p.data.body);
    if (!last || last.from_agent) {
      email(agents, `Help & Support: ${me.fullName || "a staff member"} needs help`, "New support message", [
        `From: ${me.fullName || me.username}`,
        ``,
        p.data.body.slice(0, 1000)
      ]);
    }
    return res.status(201).json({ conversationId: conv.id, messages: await messagesOf(conv.id) });
  } catch (err) {
    return next(err);
  }
});

// ── Approval Inbox ───────────────────────────────────────────────────────────
// Chats that need this person: for the support team, every open conversation
// whose last word is the staff member's (waiting on an answer); for anyone,
// support's reply to their own chat that they haven't read yet.
export async function supportInboxItems(user: { userId: string; role: string }) {
  await ensureSchema();
  const LAST = `(SELECT %s FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1)`;
  const items: any[] = [];
  if (await isAgent(user.userId, user.role)) {
    const waiting = await query<any>(
      `SELECT c.id, c.created_at, c.last_message_at, u.full_name, ${LAST.replace("%s", "body")} AS last_body
         FROM support_conversations c JOIN users u ON u.id = c.user_id
        WHERE c.status = 'OPEN' AND c.user_id <> $1 AND ${LAST.replace("%s", "from_agent")} = false
        ORDER BY c.last_message_at`,
      [user.userId]
    );
    for (const c of waiting) {
      items.push({
        doc_type: "SUPPORT_CHAT", id: c.id, status: "AWAITING_REPLY", status_label: "Awaiting reply", task_label: "Reply to this chat",
        requester_name: c.full_name || "Staff member", preview: c.last_body, as_agent: true,
        current_step_actionable_by_me: true, created_at: c.last_message_at
      });
    }
  }
  const replied = await query<any>(
    `SELECT c.id, c.last_message_at, ${LAST.replace("%s", "body")} AS last_body
       FROM support_conversations c
      WHERE c.user_id = $1 AND c.status = 'OPEN' AND ${LAST.replace("%s", "from_agent")} = true
        AND (c.user_read_at IS NULL OR c.user_read_at < ${LAST.replace("%s", "created_at")})`,
    [user.userId]
  );
  for (const c of replied) {
    items.push({
      doc_type: "SUPPORT_CHAT", id: c.id, status: "REPLIED", status_label: "Support replied", task_label: "Read support's reply",
      requester_name: "FlowDesk support", preview: c.last_body, as_agent: false,
      current_step_actionable_by_me: true, created_at: c.last_message_at
    });
  }
  return items;
}

// ── Agents ───────────────────────────────────────────────────────────────────
async function assertAgent(req: AuthedRequest) {
  if (!(await isAgent(req.user!.userId, req.user!.role))) throw forbidden("Only the support team can see this");
}

supportRouter.get("/conversations", async (req: AuthedRequest, res, next) => {
  try {
    await assertAgent(req);
    const status = req.query.status === "closed" ? "CLOSED" : "OPEN";
    const rows = await query(
      `SELECT c.id, c.status, c.created_at, c.last_message_at, u.full_name, u.department, u.phone,
              (SELECT body FROM support_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_body,
              (SELECT from_agent FROM support_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_from_agent
         FROM support_conversations c JOIN users u ON u.id = c.user_id
        WHERE c.status = $1 ORDER BY c.last_message_at DESC LIMIT 200`,
      [status]
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

supportRouter.get("/conversations/:id", async (req: AuthedRequest, res, next) => {
  try {
    await assertAgent(req);
    const [c] = await query<any>(
      `SELECT c.*, u.full_name, u.email, u.department, u.phone FROM support_conversations c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (!c) throw notFound();
    return res.json({
      conversation: { id: c.id, status: c.status, createdAt: c.created_at, user: { fullName: c.full_name, email: c.email, department: c.department, phone: c.phone } },
      messages: await messagesOf(c.id)
    });
  } catch (err) {
    return next(err);
  }
});

supportRouter.post("/conversations/:id/messages", async (req: AuthedRequest, res, next) => {
  try {
    await assertAgent(req);
    const p = BodySchema.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message || "Write a message");
    const [c] = await query<any>(`SELECT * FROM support_conversations WHERE id = $1`, [req.params.id]);
    if (!c) throw notFound();
    // Replying reopens a closed conversation.
    await query(`UPDATE support_conversations SET status = 'OPEN', closed_at = NULL, last_message_at = now() WHERE id = $1`, [c.id]);
    await query(`INSERT INTO support_messages (conversation_id, sender_id, from_agent, body) VALUES ($1, $2, true, $3)`, [c.id, req.user!.userId, p.data.body]);
    push([c.user_id], "FlowDesk support replied", p.data.body);
    email([c.user_id], "FlowDesk support replied", "Support replied", [`${req.user!.fullName || "The support team"} wrote:`, ``, p.data.body.slice(0, 1000)]);
    return res.status(201).json({ messages: await messagesOf(c.id) });
  } catch (err) {
    return next(err);
  }
});

supportRouter.post("/conversations/:id/close", async (req: AuthedRequest, res, next) => {
  try {
    await assertAgent(req);
    const [c] = await query<any>(
      `UPDATE support_conversations SET status = 'CLOSED', closed_at = now(), closed_by = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, req.user!.userId]
    );
    if (!c) throw notFound();
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ── Who may answer (admin only) ──────────────────────────────────────────────
supportRouter.get("/agents", requireRole(["ADMIN"]), async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await query(
      `SELECT a.user_id, u.full_name, u.email, u.department, a.created_at FROM support_agents a JOIN users u ON u.id = a.user_id ORDER BY u.full_name`
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

supportRouter.post("/agents", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    const p = z.object({ email: z.string().trim().min(3) }).safeParse(req.body);
    if (!p.success) throw badRequest("Give the person's FlowDesk email");
    const [u] = await query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) AND is_active`, [p.data.email]);
    if (!u) throw badRequest("No active FlowDesk user has that email");
    await query(`INSERT INTO support_agents (user_id, granted_by) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [u.id, req.user!.userId]);
    return res.status(201).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

supportRouter.delete("/agents/:userId", requireRole(["ADMIN"]), async (req: AuthedRequest, res, next) => {
  try {
    await query(`DELETE FROM support_agents WHERE user_id = $1`, [req.params.userId]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
