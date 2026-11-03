import { useEffect, useState, type CSSProperties } from "react";
import { ArrowLeft } from "lucide-react";
import { API, getToken } from "./api";

// Reports > Process Performance (admins): every FlowDesk process side by
// side - volumes, completion, submitted-to-done time, how fast approvers act
// on a step that's waiting for them (against a target), and what's stuck
// now. Pick a process to see its own figures, queue and approvers. Data from
// GET /reporting/process-performance (backend modules/reporting).

type Summary = {
  submitted: number; done: number; rejected: number; cancelled: number; stillOpen: number;
  completionRate: number | null; rejectionRate: number | null;
  turnaroundMedianHours: number | null; turnaroundAvgHours: number | null;
  stepMedianHours: number | null; stepAvgHours: number | null; stepsActed: number; stepsWithinSla: number | null;
  waitingNow: number; overdueNow: number; oldestWaitingHours: number | null;
};
type Perf = {
  days: number;
  slaHours: number;
  bucket: "day" | "week";
  process: string | null;
  failed: string[];
  processes: (Summary & { key: string; label: string })[];
  summary: Summary;
  series: { day: string; submitted: number; done: number }[];
  waiting: { process: string; id: string; ref: string; title: string; requester: string | null; waitingOn: string; step: string; submittedAt: string; waitingHours: number; overdue: boolean }[];
  approvers: { key: string; who: string; department: string | null; isTeam: boolean; processes: string[]; stepsActed: number; medianHours: number | null; avgHours: number | null; withinSla: number | null; rejected: number; waiting: number; oldestWaitingHours: number | null }[];
};

const PERIODS = [7, 30, 90, 365];
const SLAS = [24, 48, 72];

const statCard: CSSProperties = { flex: "1 1 130px", border: "1px solid var(--border)", borderRadius: 10, padding: 14, background: "var(--surface, #fff)" };
const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 };
const th: CSSProperties = { padding: "8px 10px", fontWeight: 600, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "7px 10px", whiteSpace: "nowrap" };
const tableBox: CSSProperties = { border: "1px solid var(--border)", borderRadius: 10, overflow: "auto", background: "var(--surface, #fff)" };
const headRow: CSSProperties = { textAlign: "left", color: "var(--muted)", position: "sticky", top: 0, background: "var(--surface, #fff)" };
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const RED = "#dc2626";

/** 0.4 -> "24 min", 5.2 -> "5.2 h", 75 -> "3.1 days". */
function dur(h: number | null | undefined) {
  if (h === null || h === undefined) return "–";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round((h / 24) * 10) / 10} days`;
}
const pctText = (n: number | null) => (n === null ? "–" : `${n}%`);
const lowSla = (n: number | null) => n !== null && n < 80;

function Stat({ value, label, hint, tone }: { value: number | string; label: string; hint?: string; tone?: "bad" | "good" }) {
  return (
    <div style={statCard} title={hint}>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone === "bad" ? RED : tone === "good" ? "#0f9d58" : undefined }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

function SeriesBars({ series, bucket }: { series: Perf["series"]; bucket: Perf["bucket"] }) {
  const max = Math.max(1, ...series.map((d) => Math.max(d.submitted, d.done)));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 100, padding: "0 2px", borderBottom: "1px solid var(--border)" }}>
        {series.map((d) => (
          <div key={d.day} title={`${bucket === "week" ? "Week of " : ""}${shortDate(d.day)}: ${d.submitted} submitted, ${d.done} done`}
            style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 1, height: "100%" }}>
            <div style={{ flex: 1, height: `${Math.max((d.submitted / max) * 100, d.submitted ? 6 : 1)}%`, background: d.submitted ? "var(--accent, #283889)" : "var(--border)", borderRadius: "2px 2px 0 0" }} />
            <div style={{ flex: 1, height: `${Math.max((d.done / max) * 100, d.done ? 6 : 0)}%`, background: "#0f9d58", borderRadius: "2px 2px 0 0" }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>
        <span>{series[0] ? shortDate(series[0].day) : ""}</span>
        <span>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--accent, #283889)", margin: "0 4px 0 0" }} />Submitted
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#0f9d58", margin: "0 4px 0 12px" }} />Done
        </span>
        <span>Today</span>
      </div>
    </div>
  );
}

function Picker<T extends number>({ value, options, onChange, format }: { value: T; options: T[]; onChange: (v: T) => void; format: (v: T) => string }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
      {options.map((o) => (
        <button key={o} type="button" onClick={() => onChange(o)}
          style={{ padding: "5px 11px", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer",
            background: o === value ? "#eff6ff" : "var(--surface-soft)", color: o === value ? "#1d4ed8" : "var(--text)" }}>
          {format(o)}
        </button>
      ))}
    </div>
  );
}

export default function ReportProcessPerformance({ onBack }: { onBack: () => void }) {
  const [days, setDays] = useState(30);
  const [slaHours, setSlaHours] = useState(48);
  const [process, setProcess] = useState<string | null>(null);
  const [data, setData] = useState<Perf | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    const token = getToken();
    const qs = new URLSearchParams({ days: String(days), slaHours: String(slaHours), ...(process ? { process } : {}) });
    fetch(`${API}/reporting/process-performance?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json?.error || r.statusText);
        if (live) setData(json);
      })
      .catch((e) => live && setError(e.message || "Couldn't load process performance"))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [days, slaHours, process]);

  const s = data?.summary;
  const selected = data?.processes.find((p) => p.key === process);

  return (
    <div style={{ padding: 24, maxWidth: 1400 }}>
      <button type="button" onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "none", background: "none", color: "var(--muted)", cursor: "pointer", fontSize: 12.5, padding: 0, marginBottom: 10 }}>
        <ArrowLeft size={14} /> Reports
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontSize: 20, fontWeight: 700, flex: 1 }}>Process Performance</div>
        <Picker value={days} options={PERIODS} onChange={setDays} format={(d) => (d === 365 ? "1 year" : `${d} days`)} />
        <span style={{ fontSize: 12, color: "var(--muted)" }}>Target</span>
        <Picker value={slaHours} options={SLAS} onChange={setSlaHours} format={(h) => `${h} h`} />
      </div>
      <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
        Every process over the last {days === 365 ? "year" : `${days} days`}. "Time to act" is how long an approver (or a team, like Finance) takes once a request is waiting on them; the target is how long that should take.
      </p>

      {error && <p style={{ fontSize: 13, color: RED }}>{error}</p>}
      {data && data.failed.length > 0 && (
        <p style={{ fontSize: 12, color: "#b45309" }}>Couldn't read: {data.failed.join(", ")}. The other processes are shown.</p>
      )}
      {!data || !s ? (
        !error && <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</p>
      ) : (
        <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
          <div style={sectionLabel}>By process — click one to focus on it</div>
          <div style={{ ...tableBox, marginBottom: 20 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={headRow}>
                  {["Process", "Submitted", "Done", "Rejected", "Open", "Completion", "Submitted → done (median)", "Time to act (median)", `Within ${data.slaHours} h`, "Waiting now", `Over ${data.slaHours} h`, "Oldest waiting"].map((h) => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr onClick={() => setProcess(null)} style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: process === null ? "#eff6ff" : undefined, fontWeight: 700 }}>
                  <td style={td}>All processes</td>
                  <td colSpan={11} style={{ ...td, color: "var(--muted)", fontWeight: 400 }}>{process === null ? "Showing everything below" : "Show everything"}</td>
                </tr>
                {data.processes.length === 0 && <tr><td colSpan={12} style={{ padding: 12, color: "var(--muted)" }}>No activity in this period</td></tr>}
                {data.processes.map((p) => (
                  <tr key={p.key} onClick={() => setProcess(p.key === process ? null : p.key)}
                    style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: p.key === process ? "#eff6ff" : undefined }}>
                    <td style={{ ...td, fontWeight: 600 }}>{p.label}</td>
                    <td style={td}>{p.submitted}</td>
                    <td style={td}>{p.done}</td>
                    <td style={td}>{p.rejected}</td>
                    <td style={td}>{p.stillOpen}</td>
                    <td style={td}>{pctText(p.completionRate)}</td>
                    <td style={td}>{dur(p.turnaroundMedianHours)}</td>
                    <td style={td}>{dur(p.stepMedianHours)}</td>
                    <td style={{ ...td, color: lowSla(p.stepsWithinSla) ? RED : undefined }}>{pctText(p.stepsWithinSla)}</td>
                    <td style={{ ...td, fontWeight: p.waitingNow ? 700 : undefined }}>{p.waitingNow || "–"}</td>
                    <td style={{ ...td, color: p.overdueNow ? RED : undefined, fontWeight: p.overdueNow ? 700 : undefined }}>{p.overdueNow || "–"}</td>
                    <td style={{ ...td, color: p.oldestWaitingHours !== null && p.oldestWaitingHours > data.slaHours ? RED : undefined }}>{dur(p.oldestWaitingHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{selected ? selected.label : "All processes"}</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <Stat value={s.submitted} label="Submitted" hint={`${s.cancelled} of them cancelled`} />
            <Stat value={s.done} label="Done" />
            <Stat value={s.rejected} label="Rejected" hint={`Rejection rate ${pctText(s.rejectionRate)} of those that ended`} />
            <Stat value={pctText(s.completionRate)} label="Completion rate" hint="Submitted in this period and now done" />
            <Stat value={dur(s.turnaroundMedianHours)} label="Submitted → done (median)" hint={`Average ${dur(s.turnaroundAvgHours)}`} />
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
            <Stat value={dur(s.stepMedianHours)} label="Time to act on a step (median)" hint={`Average ${dur(s.stepAvgHours)} over ${s.stepsActed} steps`} />
            <Stat value={pctText(s.stepsWithinSla)} label={`Steps done within ${data.slaHours} h`} tone={s.stepsWithinSla === null ? undefined : lowSla(s.stepsWithinSla) ? "bad" : "good"} />
            <Stat value={s.waitingNow} label="Waiting on someone now" />
            <Stat value={s.overdueNow} label={`Waiting over ${data.slaHours} h`} tone={s.overdueNow ? "bad" : "good"} />
            <Stat value={dur(s.oldestWaitingHours)} label="Oldest wait" />
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={sectionLabel}>Submitted and done per {data.bucket}</div>
            <SeriesBars series={data.series} bucket={data.bucket} />
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={sectionLabel}>Waiting now ({data.waiting.length}{data.waiting.length === 100 ? ", longest first" : ""})</div>
            <div style={{ ...tableBox, maxHeight: 360 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={headRow}>
                    {[...(process ? [] : ["Process"]), "Reference", "Request", "Requested by", "Waiting on", "Step", "Waiting for", "Submitted"].map((h) => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.waiting.length === 0 && <tr><td colSpan={8} style={{ padding: 12, color: "var(--muted)" }}>Nothing is waiting</td></tr>}
                  {data.waiting.map((w) => (
                    <tr key={w.process + w.id} style={{ borderTop: "1px solid var(--border)" }}>
                      {!process && <td style={td}>{w.process}</td>}
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 11.5 }}>{w.ref}</td>
                      <td style={{ ...td, whiteSpace: "normal", minWidth: 180 }}>{w.title}</td>
                      <td style={td}>{w.requester || "–"}</td>
                      <td style={td}>{w.waitingOn}</td>
                      <td style={{ ...td, color: "var(--muted)" }}>{w.step}</td>
                      <td style={{ ...td, fontWeight: w.overdue ? 700 : undefined, color: w.overdue ? RED : undefined }}>{dur(w.waitingHours)}</td>
                      <td style={{ ...td, color: "var(--muted)" }}>{shortDate(w.submittedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div style={sectionLabel}>By approver ({data.approvers.length})</div>
            <div style={{ ...tableBox, maxHeight: 460 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={headRow}>
                    {["Approver", "Processes", "Steps acted", "Median time to act", "Average", `Within ${data.slaHours} h`, "Rejected", "Waiting on them", "Oldest waiting"].map((h) => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.approvers.length === 0 && <tr><td colSpan={9} style={{ padding: 12, color: "var(--muted)" }}>No approvals in this period</td></tr>}
                  {data.approvers.map((a) => (
                    <tr key={a.key} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={td}>
                        {a.who}
                        {a.department && <div style={{ fontSize: 11, color: "var(--muted)" }}>{a.department}</div>}
                      </td>
                      <td style={{ ...td, whiteSpace: "normal", color: "var(--muted)", fontSize: 11.5 }}>{a.processes.join(", ")}</td>
                      <td style={td}>{a.stepsActed}</td>
                      <td style={td}>{dur(a.medianHours)}</td>
                      <td style={td}>{dur(a.avgHours)}</td>
                      <td style={{ ...td, color: lowSla(a.withinSla) ? RED : undefined }}>{pctText(a.withinSla)}</td>
                      <td style={td}>{a.rejected || "–"}</td>
                      <td style={{ ...td, fontWeight: a.waiting ? 700 : undefined }}>{a.waiting || "–"}</td>
                      <td style={{ ...td, color: a.oldestWaitingHours !== null && a.oldestWaitingHours > data.slaHours ? RED : undefined }}>{dur(a.oldestWaitingHours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
