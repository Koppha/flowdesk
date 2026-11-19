import React, { useEffect, useState } from "react";
import { Loader2, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { api } from "../api";

// Settings > AI Assistant > Performance (administrators): how the assistant
// is doing - use, speed, which models answer, what fails, and what people
// think of the answers (backend-v2/src/modules/ai/ai-metrics.ts).

type Perf = {
  days: number;
  summary: {
    questions: number; people: number; answered: number; errors: number; cancelled: number; limit_reached: number; other_stops: number;
    answered_pct: number | null; error_pct: number | null; fallback_pct: number | null; lookup_error_pct: number | null;
    thumbs_up: number; thumbs_down: number; satisfaction_pct: number | null;
    median_ms: number | null; p90_ms: number | null; median_first_ms: number | null; lookups_per_answer: number | null;
    input_tokens: number | null; output_tokens: number | null;
  };
  daily: { day: string; questions: number; errors: number; median_ms: number | null }[];
  by_model: { service: string; model: string; questions: number; errors: number; error_pct: number | null; after_fallback: number; median_ms: number | null; thumbs_up: number; thumbs_down: number }[];
  lookups: { tool: string; uses: number }[];
  outcomes: { outcome: string; error_kind: string; n: number }[];
  people: { name: string; division: string | null; questions: number; thumbs_down: number; last_asked: string }[];
  problems: { id: number; created_at: string; name: string | null; outcome: string; error_kind: string | null; service: string | null; model: string | null; total_ms: number | null; tools: string[]; rating: number | null; rating_comment: string | null; question: string | null }[];
};

const LOOKUP_LABEL: Record<string, string> = {
  list_my_advances: "Their advances", get_advance: "One advance", list_my_clearances: "Their clearances", get_clearance: "One clearance",
  list_my_pending_approvals: "Approval Inbox", get_travel_types: "Travel types and rates", run_report: "Finance reports",
  get_user_and_app_stats: "Users and app usage", process_usage: "Process usage", show_chart: "Chart", list_active_processes: "Processes on/off",
  list_my_requests: "Requests in other processes", get_custom_request: "One custom request", list_my_recent_actions: "What they actioned",
  finance_queue: "Finance queues", service_contracts: "Service contracts", create_advance_draft: "Advance draft saved", create_clearance_draft: "Clearance draft started"
};
const OUTCOME_LABEL: Record<string, string> = {
  error: "Failed", cancelled: "Closed before the answer finished", limit_reached: "Daily question limit reached", not_set_up: "Assistant off or not set up",
  refused: "Declined to answer", too_long: "Answer too long", conversation_full: "Conversation too long"
};
const ERROR_LABEL: Record<string, string> = {
  api_key: "key rejected", busy_or_quota: "service busy or out of quota", no_model: "no model set up", timeout: "timed out", other: "other"
};
const outcomeText = (o: string, k?: string | null) =>
  `${OUTCOME_LABEL[o] || o}${k ? ` - ${ERROR_LABEL[k] || (k.startsWith("http_") ? `service error ${k.slice(5)}` : k)}` : ""}`;
const secs = (ms: number | null | undefined) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const pctText = (v: number | null | undefined) => (v == null ? "–" : `${v}%`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const card: React.CSSProperties = { flex: "1 1 150px", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", minWidth: 0 };
const section: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", margin: "0 0 8px" };
const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 600, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", textAlign: "left", color: "var(--muted)" };
const td: React.CSSProperties = { padding: "7px 10px", borderTop: "1px solid var(--border)", verticalAlign: "top" };

function Stat({ value, label, hint, tone }: { value: React.ReactNode; label: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone === "bad" ? "#dc2626" : tone === "good" ? "#059669" : "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
      {hint && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

// Questions per day as bars; the failed part of each day in red.
function DailyBars({ daily }: { daily: Perf["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.questions));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 110, borderBottom: "1px solid var(--border)" }}>
        {daily.map((d) => (
          <div key={d.day} title={`${d.day}: ${d.questions} question${d.questions === 1 ? "" : "s"}${d.errors ? `, ${d.errors} failed` : ""}${d.median_ms != null ? `, median ${secs(d.median_ms)}` : ""}`}
            style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
            {d.errors > 0 && <div style={{ height: `${(d.errors / max) * 100}%`, background: "#dc2626", borderRadius: "3px 3px 0 0" }} />}
            <div style={{ height: `${((d.questions - d.errors) / max) * 100}%`, background: "#4f46e5", borderRadius: d.errors ? 0 : "3px 3px 0 0", minHeight: d.questions ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
        <span>{daily[0]?.day}</span>
        <span><span style={{ color: "#4f46e5" }}>■</span> answered and other &nbsp; <span style={{ color: "#dc2626" }}>■</span> failed</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead><tr>{head.map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export default function AiPerformance() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Perf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    api.aiPerformance(days).then((d: Perf) => { setData(d); setError(null); })
      .catch((e: any) => setError(e?.message || "Couldn't load the figures."))
      .finally(() => setLoading(false));
  };
  useEffect(load, [days]);

  const s = data?.summary;
  return (
    <div className="ep-panel" style={{ marginBottom: 20, padding: 20, display: "grid", gap: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>Performance</div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period"
          style={{ width: "auto", flex: "none", minHeight: 0, font: "inherit", fontSize: 13, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--text)" }}>
          <option value={1}>Today</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
        <button type="button" className="ep-btn-outline" onClick={load} disabled={loading} style={{ flex: "none", width: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>
      {error && <div style={{ color: "#dc2626", fontSize: 13 }}>{error}</div>}
      {!data && !error && <div style={{ color: "var(--muted)", fontSize: 13 }}><Loader2 size={14} className="spin" /> Loading…</div>}

      {data && s && (
        <>
          {s.questions === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>No questions in this period yet. Figures start from when this tracking was switched on.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Stat value={s.questions} label="Questions" hint={`from ${s.people} ${s.people === 1 ? "person" : "people"}`} />
                <Stat value={pctText(s.answered_pct)} label="Answered" hint={`${s.answered} answered`} tone={s.answered_pct != null && s.answered_pct < 90 ? "bad" : "good"} />
                <Stat value={secs(s.median_ms)} label="Typical answer time" hint={`9 in 10 within ${secs(s.p90_ms)}`} />
                <Stat value={secs(s.median_first_ms)} label="Until the first words" hint="typical wait before text appears" />
                <Stat value={pctText(s.satisfaction_pct)} label="Helpful" hint={`${s.thumbs_up} up · ${s.thumbs_down} down`} tone={s.satisfaction_pct != null && s.satisfaction_pct < 70 ? "bad" : undefined} />
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Stat value={pctText(s.error_pct)} label="Failed" hint={`${s.errors} question${s.errors === 1 ? "" : "s"}`} tone={s.errors ? "bad" : undefined} />
                <Stat value={pctText(s.fallback_pct)} label="Needed a backup model" hint="first model busy or failing" />
                <Stat value={pctText(s.lookup_error_pct)} label="A look-up failed" hint={`${s.lookups_per_answer ?? "–"} look-ups per answer`} />
                <Stat value={s.limit_reached} label="Hit the daily limit" hint={`${s.cancelled} closed before the answer finished`} />
              </div>

              <div>
                <div style={section}>Questions per day</div>
                <DailyBars daily={data.daily} />
              </div>

              <div>
                <div style={section}>By model</div>
                <Table head={["Model", "Service", "Questions", "Typical time", "Failed", "As a backup", "Helpful"]}>
                  {data.by_model.map((m) => (
                    <tr key={`${m.service}:${m.model}`}>
                      <td style={td}><code>{m.model}</code></td><td style={td}>{m.service}</td><td style={td}>{m.questions}</td>
                      <td style={td}>{secs(m.median_ms)}</td>
                      <td style={{ ...td, color: m.errors ? "#dc2626" : undefined }}>{m.errors ? `${m.errors} (${pctText(m.error_pct)})` : "0"}</td>
                      <td style={td}>{m.after_fallback}</td>
                      <td style={td}><span style={{ display: "inline-flex", gap: 8 }}><span><ThumbsUp size={12} /> {m.thumbs_up}</span><span><ThumbsDown size={12} /> {m.thumbs_down}</span></span></td>
                    </tr>
                  ))}
                </Table>
              </div>

              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <div style={section}>What it looked up</div>
                  <Table head={["Look-up", "Times"]}>
                    {data.lookups.length === 0 && <tr><td style={td} colSpan={2}>None yet</td></tr>}
                    {data.lookups.map((l) => <tr key={l.tool}><td style={td}>{LOOKUP_LABEL[l.tool] || l.tool}</td><td style={td}>{l.uses}</td></tr>)}
                  </Table>
                </div>
                <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <div style={section}>When it didn't answer</div>
                  <Table head={["What happened", "Times"]}>
                    {data.outcomes.length === 0 && <tr><td style={td} colSpan={2}>Every question was answered</td></tr>}
                    {data.outcomes.map((o) => <tr key={o.outcome + o.error_kind}><td style={td}>{outcomeText(o.outcome, o.error_kind)}</td><td style={td}>{o.n}</td></tr>)}
                  </Table>
                </div>
              </div>

              <div>
                <div style={section}>Who uses it most</div>
                <Table head={["Name", "Division", "Questions", "Rated down", "Last asked"]}>
                  {data.people.map((p) => (
                    <tr key={p.name + p.last_asked}><td style={td}>{p.name}</td><td style={td}>{p.division || "–"}</td><td style={td}>{p.questions}</td><td style={td}>{p.thumbs_down}</td><td style={td}>{when(p.last_asked)}</td></tr>
                  ))}
                </Table>
              </div>

              <div>
                <div style={section}>Answers to look at</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Failed answers, and answers people rated down. A question's words are shown only when its person rated the answer down.</div>
                <Table head={["When", "Who", "What happened", "Model", "Time", "Their note / question"]}>
                  {data.problems.length === 0 && <tr><td style={td} colSpan={6}>Nothing to look at</td></tr>}
                  {data.problems.map((p) => (
                    <tr key={p.id}>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{when(p.created_at)}</td>
                      <td style={td}>{p.name || "–"}</td>
                      <td style={td}>{p.rating === -1 && p.outcome === "answered" ? <span><ThumbsDown size={12} /> Rated not helpful</span> : outcomeText(p.outcome, p.error_kind)}</td>
                      <td style={td}>{p.model ? <code>{p.model}</code> : "–"}</td>
                      <td style={td}>{secs(p.total_ms)}</td>
                      <td style={{ ...td, maxWidth: 380 }}>
                        {p.rating_comment && <div><b>Note:</b> {p.rating_comment}</div>}
                        {p.question && <div style={{ color: "var(--muted)" }}>“{p.question}”</div>}
                        {!p.rating_comment && !p.question && "–"}
                      </td>
                    </tr>
                  ))}
                </Table>
              </div>

              {(s.input_tokens || s.output_tokens) ? (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>Tokens (Claude only - the free services don't report them): {s.input_tokens?.toLocaleString() ?? 0} in, {s.output_tokens?.toLocaleString() ?? 0} out.</div>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
