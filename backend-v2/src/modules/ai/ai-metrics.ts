// AI Assistant performance: one row per question asked - how long the answer
// took (first words and in full), which model answered and how many it had
// to fall back past, the lookups it made, how it ended, and the person's
// thumbs up / down. Read by Settings > AI Assistant > Performance (admins).
//
// No question or answer text is copied here: the question is linked
// (user_message_id) and disappears with the conversation when the person
// deletes it. The Performance page shows a question's words only when its
// person rated the answer down.
import { query } from "../../lib/db.js";

export type TurnOutcome =
  | "answered" | "refused" | "too_long" | "conversation_full" | "cancelled" | "error"
  | "limit_reached" | "not_set_up";

export type TurnMetric = {
  userId: string;
  conversationId?: string | null;
  userMessageId?: number | null;
  service?: string | null;
  model?: string | null;
  fallbacks?: number;
  firstTextMs?: number | null;
  totalMs?: number | null;
  tools?: string[];
  toolErrors?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  answerChars?: number;
  outcome: TurnOutcome;
  errorKind?: string | null;
};

export async function ensureAiMetricsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS ai_turn_metrics (
      id bigserial PRIMARY KEY,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL,
      user_message_id bigint REFERENCES ai_messages(id) ON DELETE SET NULL,
      service text,
      model text,
      fallbacks int NOT NULL DEFAULT 0,
      first_text_ms int,
      total_ms int,
      tools text[] NOT NULL DEFAULT '{}',
      tool_errors int NOT NULL DEFAULT 0,
      input_tokens int,
      output_tokens int,
      answer_chars int NOT NULL DEFAULT 0,
      outcome text NOT NULL,
      error_kind text,
      rating smallint CHECK (rating IN (-1, 1)),
      rating_comment text,
      rated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ai_turn_metrics_created ON ai_turn_metrics(created_at DESC)`);
}

// Never lets a metrics problem break the answer itself.
export async function recordTurn(m: TurnMetric): Promise<number | null> {
  try {
    const [row] = await query<{ id: number }>(
      `INSERT INTO ai_turn_metrics (user_id, conversation_id, user_message_id, service, model, fallbacks, first_text_ms, total_ms,
                                    tools, tool_errors, input_tokens, output_tokens, answer_chars, outcome, error_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [m.userId, m.conversationId ?? null, m.userMessageId ?? null, m.service ?? null, m.model ?? null, m.fallbacks ?? 0,
        m.firstTextMs ?? null, m.totalMs ?? null, m.tools ?? [], m.toolErrors ?? 0, m.inputTokens ?? null, m.outputTokens ?? null,
        m.answerChars ?? 0, m.outcome, m.errorKind ?? null]
    );
    // bigserial comes back from pg as a string
    return row?.id != null ? Number(row.id) : null;
  } catch {
    return null;
  }
}

// The person's own answers only.
export async function rateTurn(userId: string, turnId: number, rating: 1 | -1, comment: string | null) {
  const rows = await query<{ id: number }>(
    `UPDATE ai_turn_metrics SET rating = $3, rating_comment = $4, rated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING id`,
    [turnId, userId, rating, comment]
  );
  return rows.length > 0;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

export async function aiPerformance(days: number) {
  const since = `now() - make_interval(days => $1)`;
  const [summary] = await query<any>(
    `SELECT count(*)::int AS questions,
            count(DISTINCT user_id)::int AS people,
            count(*) FILTER (WHERE outcome = 'answered')::int AS answered,
            count(*) FILTER (WHERE outcome = 'error')::int AS errors,
            count(*) FILTER (WHERE outcome = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE outcome = 'limit_reached')::int AS limit_reached,
            count(*) FILTER (WHERE outcome IN ('refused', 'too_long', 'conversation_full', 'not_set_up'))::int AS other_stops,
            count(*) FILTER (WHERE fallbacks > 0)::int AS with_fallback,
            count(*) FILTER (WHERE tool_errors > 0)::int AS with_lookup_error,
            count(*) FILTER (WHERE rating = 1)::int AS thumbs_up,
            count(*) FILTER (WHERE rating = -1)::int AS thumbs_down,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE outcome = 'answered') AS median_ms,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE outcome = 'answered') AS p90_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY first_text_ms) FILTER (WHERE outcome = 'answered') AS median_first_ms,
            avg(cardinality(tools)) FILTER (WHERE outcome = 'answered') AS lookups_per_answer,
            sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens
       FROM ai_turn_metrics WHERE created_at >= ${since}`,
    [days]
  );
  const daily = await query<any>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            count(t.id)::int AS questions,
            count(t.id) FILTER (WHERE t.outcome = 'error')::int AS errors,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY t.total_ms) FILTER (WHERE t.outcome = 'answered') AS median_ms
       FROM generate_series(date_trunc('day', now() AT TIME ZONE 'Africa/Maseru') - make_interval(days => $1 - 1),
                            date_trunc('day', now() AT TIME ZONE 'Africa/Maseru'), interval '1 day') AS d(day)
       LEFT JOIN ai_turn_metrics t ON date_trunc('day', t.created_at AT TIME ZONE 'Africa/Maseru') = d.day
      GROUP BY d.day ORDER BY d.day`,
    [days]
  );
  const byModel = await query<any>(
    `SELECT coalesce(service, '-') AS service, coalesce(model, '(no model reached)') AS model,
            count(*)::int AS questions,
            count(*) FILTER (WHERE outcome = 'error')::int AS errors,
            count(*) FILTER (WHERE fallbacks > 0)::int AS after_fallback,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE outcome = 'answered') AS median_ms,
            count(*) FILTER (WHERE rating = 1)::int AS thumbs_up,
            count(*) FILTER (WHERE rating = -1)::int AS thumbs_down
       FROM ai_turn_metrics WHERE created_at >= ${since} AND outcome NOT IN ('limit_reached', 'not_set_up')
      GROUP BY 1, 2 ORDER BY questions DESC`,
    [days]
  );
  const lookups = await query<any>(
    `SELECT tool, count(*)::int AS uses FROM ai_turn_metrics, unnest(tools) AS tool
      WHERE created_at >= ${since} GROUP BY tool ORDER BY uses DESC`,
    [days]
  );
  const outcomes = await query<any>(
    `SELECT outcome, coalesce(error_kind, '') AS error_kind, count(*)::int AS n
       FROM ai_turn_metrics WHERE created_at >= ${since} AND outcome <> 'answered'
      GROUP BY 1, 2 ORDER BY n DESC`,
    [days]
  );
  const people = await query<any>(
    `SELECT u.full_name AS name, u.department AS division, count(*)::int AS questions,
            count(*) FILTER (WHERE t.rating = -1)::int AS thumbs_down, max(t.created_at) AS last_asked
       FROM ai_turn_metrics t JOIN users u ON u.id = t.user_id
      WHERE t.created_at >= ${since}
      GROUP BY u.id, u.full_name, u.department ORDER BY questions DESC LIMIT 15`,
    [days]
  );
  // Problems: failed answers (no question text) and answers rated down (with
  // the question, since the person flagged it).
  const problems = await query<any>(
    `SELECT t.id, t.created_at, u.full_name AS name, t.outcome, t.error_kind, t.service, t.model, t.total_ms, t.tools,
            t.rating, t.rating_comment,
            CASE WHEN t.rating = -1 THEN (SELECT left(string_agg(b->>'text', ' '), 300) FROM ai_messages m, jsonb_array_elements(m.content) b
                                           WHERE m.id = t.user_message_id AND b->>'type' = 'text') END AS question
       FROM ai_turn_metrics t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.created_at >= ${since} AND (t.outcome IN ('error', 'too_long', 'refused') OR t.rating = -1)
      ORDER BY t.created_at DESC LIMIT 30`,
    [days]
  );
  const num = (v: unknown) => (v == null ? null : Math.round(Number(v)));
  const s = summary || {};
  const finished = (s.questions || 0) - (s.limit_reached || 0);
  return {
    days,
    summary: {
      questions: s.questions || 0, people: s.people || 0, answered: s.answered || 0, errors: s.errors || 0,
      cancelled: s.cancelled || 0, limit_reached: s.limit_reached || 0, other_stops: s.other_stops || 0,
      answered_pct: pct(s.answered || 0, finished), error_pct: pct(s.errors || 0, finished),
      fallback_pct: pct(s.with_fallback || 0, finished), lookup_error_pct: pct(s.with_lookup_error || 0, finished),
      thumbs_up: s.thumbs_up || 0, thumbs_down: s.thumbs_down || 0,
      satisfaction_pct: pct(s.thumbs_up || 0, (s.thumbs_up || 0) + (s.thumbs_down || 0)),
      median_ms: num(s.median_ms), p90_ms: num(s.p90_ms), median_first_ms: num(s.median_first_ms),
      lookups_per_answer: s.lookups_per_answer == null ? null : Math.round(Number(s.lookups_per_answer) * 10) / 10,
      input_tokens: s.input_tokens == null ? null : Number(s.input_tokens), output_tokens: s.output_tokens == null ? null : Number(s.output_tokens)
    },
    daily: daily.map((d) => ({ day: d.day, questions: d.questions, errors: d.errors, median_ms: num(d.median_ms) })),
    by_model: byModel.map((m) => ({ ...m, median_ms: num(m.median_ms), error_pct: pct(m.errors, m.questions) })),
    lookups,
    outcomes,
    people,
    problems: problems.map((p) => ({ ...p, total_ms: num(p.total_ms) }))
  };
}
