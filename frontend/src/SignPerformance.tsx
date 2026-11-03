import { useEffect, useState, type CSSProperties } from "react";
import { API, getToken } from "./api";

// Sign a Document > Performance (admins): how much gets signed, how fast
// documents get fully signed, how fast each person acts when a document is
// waiting on them, and what's stuck right now. Data from GET
// /signatures/performance (backend signatures.performance.ts).

type Perf = {
  days: number;
  slaHours: number;
  bucket: "day" | "week";
  summary: {
    signatures: number; quickSigns: number; routedSigns: number; signers: number;
    sent: number; sentWithRoute: number; completed: number; rejected: number; stillOpen: number; deleted: number;
    completionRate: number | null; rejectionRate: number | null;
    turnaroundMedianHours: number | null; turnaroundAvgHours: number | null;
    stepMedianHours: number | null; stepAvgHours: number | null; stepsActed: number; stepsWithinSla: number | null;
    waitingNow: number; overdueNow: number; openWithoutRoute: number;
  };
  channels: { web: number; mobile: number; unknown: number };
  series: { day: string; signatures: number; sent: number; completed: number }[];
  waiting: { id: string; title: string; approverName: string; step: number; steps: number; waitingHours: number; sentBy: string | null; sentAt: string; overdue: boolean }[];
  people: {
    userId: string; fullName: string; department: string | null; signatures: number; quickSigns: number; routedSigns: number; sent: number;
    stepsActed: number; medianResponseHours: number | null; avgResponseHours: number | null; withinSla: number | null; rejected: number;
    waiting: number; oldestWaitingHours: number | null;
  }[];
};

const PERIODS = [7, 30, 90, 365];
const SLAS = [24, 48, 72];

const statCard: CSSProperties = { flex: "1 1 130px", border: "1px solid var(--border)", borderRadius: 10, padding: 14 };
const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 };
const th: CSSProperties = { padding: "8px 10px", fontWeight: 600, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "7px 10px", whiteSpace: "nowrap" };
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** 0.4 -> "24 min", 5.2 -> "5.2 h", 75 -> "3.1 days". */
function dur(h: number | null | undefined) {
  if (h === null || h === undefined) return "–";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round((h / 24) * 10) / 10} days`;
}
const pctText = (n: number | null) => (n === null ? "–" : `${n}%`);

function Stat({ value, label, hint, tone }: { value: number | string; label: string; hint?: string; tone?: "bad" | "good" }) {
  return (
    <div style={statCard} title={hint}>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone === "bad" ? "#dc2626" : tone === "good" ? "#0f9d58" : undefined }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

// Signatures per day (or week) - plain bars, no chart library, same as Mobile App > Analytics.
function SeriesBars({ series, bucket }: { series: Perf["series"]; bucket: Perf["bucket"] }) {
  const max = Math.max(1, ...series.map((d) => d.signatures));
  const label = (d: Perf["series"][number]) =>
    `${bucket === "week" ? "Week of " : ""}${shortDate(d.day)}: ${d.signatures} signature${d.signatures === 1 ? "" : "s"}, ${d.sent} sent, ${d.completed} fully signed`;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 90, padding: "0 2px", borderBottom: "1px solid var(--border)" }}>
        {series.map((d) => (
          <div key={d.day} title={label(d)}
            style={{ flex: 1, height: `${Math.max((d.signatures / max) * 100, d.signatures ? 6 : 1)}%`, background: d.signatures ? "var(--accent, #283889)" : "var(--border)", borderRadius: "3px 3px 0 0" }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>
        <span>{series[0] ? shortDate(series[0].day) : ""}</span>
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

export default function SignPerformance() {
  const [days, setDays] = useState(30);
  const [slaHours, setSlaHours] = useState(48);
  const [data, setData] = useState<Perf | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setError("");
    const token = getToken();
    fetch(`${API}/signatures/performance?days=${days}&slaHours=${slaHours}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json?.error || r.statusText);
        if (live) setData(json);
      })
      .catch((e) => live && setError(e.message || "Couldn't load performance"));
    return () => { live = false; };
  }, [days, slaHours]);

  const s = data?.summary;
  const ch = data?.channels;
  const channelTotal = ch ? ch.web + ch.mobile + ch.unknown : 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Performance</div>
        <Picker value={days} options={PERIODS} onChange={setDays} format={(d) => (d === 365 ? "1 year" : `${d} days`)} />
        <span style={{ fontSize: 12, color: "var(--muted)" }}>Target</span>
        <Picker value={slaHours} options={SLAS} onChange={setSlaHours} format={(h) => `${h} h`} />
      </div>
      <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
        Everything signed in the portal and the mobile app over the last {days === 365 ? "year" : `${days} days`}. "Target" is how long a person should take to sign or reject a document once it's waiting on them.
      </p>

      {error && <p style={{ fontSize: 13, color: "#dc2626" }}>{error}</p>}
      {!data || !s ? (
        !error && <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</p>
      ) : (
        <>
          <div style={sectionLabel}>Volume</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <Stat value={s.signatures} label="Signatures" hint={`${s.quickSigns} quick signs, ${s.routedSigns} on documents sent for signing`} />
            <Stat value={s.signers} label="People who signed" />
            <Stat value={s.sent} label="Documents sent" hint={`${s.sentWithRoute} with a signing route${s.deleted ? `, ${s.deleted} more deleted` : ""}`} />
            <Stat value={s.completed} label="Fully signed" hint="Of the documents sent in this period" />
            <Stat value={s.rejected} label="Rejected" />
          </div>

          <div style={sectionLabel}>Speed</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <Stat value={pctText(s.completionRate)} label="Completion rate" hint="Documents sent in this period that are now fully signed" />
            <Stat value={dur(s.turnaroundMedianHours)} label="Sent → fully signed (median)" hint={`Average ${dur(s.turnaroundAvgHours)}`} />
            <Stat value={dur(s.stepMedianHours)} label="Time to act on a step (median)" hint={`Average ${dur(s.stepAvgHours)} over ${s.stepsActed} steps signed or rejected`} />
            <Stat value={pctText(s.stepsWithinSla)} label={`Steps done within ${data.slaHours} h`} tone={s.stepsWithinSla !== null && s.stepsWithinSla < 80 ? "bad" : s.stepsWithinSla !== null ? "good" : undefined} />
            <Stat value={pctText(s.rejectionRate)} label="Rejection rate" hint="Of documents sent with a signing route" />
          </div>

          <div style={sectionLabel}>Right now</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
            <Stat value={s.waitingNow} label="Waiting on someone" hint="Documents whose route is waiting for the next signer" />
            <Stat value={s.overdueNow} label={`Waiting over ${data.slaHours} h`} tone={s.overdueNow ? "bad" : "good"} />
            <Stat value={s.openWithoutRoute} label="Open, no route" hint="Documents anyone with the link can sign, not yet finished by whoever sent them" />
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={sectionLabel}>Signatures per {data.bucket}</div>
            <SeriesBars series={data.series} bucket={data.bucket} />
          </div>

          {ch && channelTotal > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={sectionLabel}>Where people sign</div>
              <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: "var(--border)", marginBottom: 8 }}>
                <div style={{ width: `${(ch.web / channelTotal) * 100}%`, background: "var(--accent, #283889)" }} />
                <div style={{ width: `${(ch.mobile / channelTotal) * 100}%`, background: "#0f9d58" }} />
              </div>
              <div style={{ display: "flex", gap: 14, fontSize: 12, flexWrap: "wrap" }}>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--accent, #283889)", marginRight: 6 }} />Web portal · <b>{ch.web}</b></span>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#0f9d58", marginRight: 6 }} />Mobile app · <b>{ch.mobile}</b></span>
                {ch.unknown > 0 && <span style={{ color: "var(--muted)" }}>Not recorded (signed before tracking started) · <b>{ch.unknown}</b></span>}
              </div>
            </div>
          )}

          <div style={{ marginBottom: 18 }}>
            <div style={sectionLabel}>Waiting now ({data.waiting.length})</div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "auto", maxHeight: 320 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--muted)", position: "sticky", top: 0, background: "var(--surface, #fff)" }}>
                    {["Document", "Waiting on", "Step", "Waiting for", "Sent by", "Sent"].map((h) => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.waiting.length === 0 && <tr><td colSpan={6} style={{ padding: 12, color: "var(--muted)" }}>Nothing is waiting</td></tr>}
                  {data.waiting.map((w) => (
                    <tr key={w.id} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ ...td, whiteSpace: "normal", minWidth: 180 }}>{w.title}</td>
                      <td style={td}>{w.approverName}</td>
                      <td style={td}>{w.step} of {w.steps}</td>
                      <td style={{ ...td, fontWeight: w.overdue ? 700 : undefined, color: w.overdue ? "#dc2626" : undefined }}>{dur(w.waitingHours)}</td>
                      <td style={td}>{w.sentBy || "–"}</td>
                      <td style={{ ...td, color: "var(--muted)" }}>{shortDate(w.sentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div style={sectionLabel}>By person ({data.people.length})</div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "auto", maxHeight: 420 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--muted)", position: "sticky", top: 0, background: "var(--surface, #fff)" }}>
                    {["Name", "Signatures", "Sent", "Steps acted", "Median time to act", "Average", `Within ${data.slaHours} h`, "Rejected", "Waiting on them", "Oldest waiting"].map((h) => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.people.length === 0 && <tr><td colSpan={10} style={{ padding: 12, color: "var(--muted)" }}>No signing activity in this period</td></tr>}
                  {data.people.map((p) => (
                    <tr key={p.userId} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={td}>
                        {p.fullName}
                        {p.department && <div style={{ fontSize: 11, color: "var(--muted)" }}>{p.department}</div>}
                      </td>
                      <td style={td} title={`${p.quickSigns} quick signs, ${p.routedSigns} on sent documents`}>{p.signatures}</td>
                      <td style={td}>{p.sent}</td>
                      <td style={td}>{p.stepsActed}</td>
                      <td style={td}>{dur(p.medianResponseHours)}</td>
                      <td style={td}>{dur(p.avgResponseHours)}</td>
                      <td style={{ ...td, color: p.withinSla !== null && p.withinSla < 80 ? "#dc2626" : undefined }}>{pctText(p.withinSla)}</td>
                      <td style={td}>{p.rejected}</td>
                      <td style={{ ...td, fontWeight: p.waiting ? 700 : undefined }}>{p.waiting || "–"}</td>
                      <td style={{ ...td, color: p.oldestWaitingHours !== null && p.oldestWaitingHours > data.slaHours ? "#dc2626" : undefined }}>{dur(p.oldestWaitingHours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
