import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { sendJson } from "../shared/Coediting";
import { Pager, SearchBox, usePaging } from "../shared/RowList";

// Admin: the "add your phone number" prompt - how many people got it, how many
// added their number, how many haven't, and who.
type Person = {
  id: string; full_name: string | null; email: string; employee_no: string | null; department: string | null; phone: string | null;
  status: "ADDED" | "NOT_ADDED" | "NOT_SEEN" | "HAD_NUMBER"; times_shown: number; later: number;
  first_shown: string | null; last_shown: string | null; saved_at: string | null;
};
const STATUS: Record<Person["status"], { label: string; bg: string; fg: string }> = {
  ADDED: { label: "Added their number", bg: "#dcfce7", fg: "#166534" },
  NOT_ADDED: { label: "Saw it, no number yet", bg: "#fee2e2", fg: "#991b1b" },
  NOT_SEEN: { label: "Not logged in since", bg: "#f1f5f9", fg: "#475569" },
  HAD_NUMBER: { label: "Already had a number", bg: "#dbeafe", fg: "#1e40af" }
};
const d = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export default function PhonePromptReport() {
  const [data, setData] = useState<{ summary: any; people: Person[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Person["status"] | "ALL">("NOT_ADDED");
  const load = async () => {
    const r = await sendJson("GET", "/sms/prompt-report");
    if (r.ok) setData(r.data); else setError(r.data?.error || "Couldn't load the report.");
  };
  useEffect(() => { void load(); }, []);

  const people = (data?.people || []).filter((p) => filter === "ALL" || p.status === filter);
  const paging = usePaging(people, (p) => [p.full_name, p.email, p.employee_no, p.department, p.phone].filter(Boolean).join(" "));

  function exportCsv() {
    const head = ["Name", "Email", "Employee no", "Department", "Phone", "Status", "Times shown", "Clicked Later", "First shown", "Last shown", "Saved via prompt"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [head.map(cell).join(","), ...people.map((p) => [p.full_name, p.email, p.employee_no, p.department, p.phone, STATUS[p.status].label, p.times_shown, p.later, p.first_shown, p.last_shown, p.saved_at].map(cell).join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `phone-number-prompt-${filter.toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!data) return <div style={{ color: error ? "#b91c1c" : "var(--muted)", fontSize: 13 }}>{error || "Loading…"}</div>;
  const s = data.summary;
  const tiles: Array<[Person["status"] | "ALL" | "PROMPTED", string, number, string]> = [
    ["PROMPTED", "Got the prompt", s.prompted, "#0b0b0b"],
    ["ADDED", "Added their number", s.added, "#166534"],
    ["NOT_ADDED", "Saw it, haven't added", s.not_added, "#991b1b"],
    ["NOT_SEEN", "Not logged in since", s.not_seen, "#475569"],
    ["HAD_NUMBER", "Already had a number", s.had_number, "#1e40af"]
  ];
  const pct = s.prompted ? Math.round((s.added / s.prompted) * 100) : 0;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Phone number prompt</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{s.active} active people · {pct}% of those who got the prompt have added their number</div>
        <button type="button" className="ep-btn-outline" style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }} onClick={() => void load()}>Refresh</button>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {tiles.map(([key, label, n, color]) => {
          const on = filter === key || (key === "PROMPTED" && filter === "ALL");
          return (
            <button key={key} type="button" onClick={() => { setFilter(key === "PROMPTED" ? "ALL" : (key as any)); paging.setPage(1); }}
              style={{ flex: "1 1 140px", textAlign: "left", border: on ? "2px solid #2563eb" : "1px solid var(--border)", borderRadius: 10, padding: on ? "7px 11px" : "8px 12px", background: "var(--surface)", cursor: "pointer", font: "inherit", color: "var(--text)" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color }}>{n}</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>{label}</div>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBox value={paging.q} onChange={paging.setQ} placeholder="Search name, email, employee no, department…" />
        <button type="button" className="ep-btn-outline" style={{ fontSize: 12.5 }} onClick={exportCsv} disabled={!people.length}><Download size={13} /> Export CSV</button>
      </div>
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12 }}>
              <th style={{ padding: "8px 10px" }}>Name</th><th style={{ padding: "8px 10px" }}>Department</th><th style={{ padding: "8px 10px" }}>Phone</th>
              <th style={{ padding: "8px 10px" }}>Status</th><th style={{ padding: "8px 10px" }}>Shown</th><th style={{ padding: "8px 10px" }}>Last shown</th>
            </tr>
          </thead>
          <tbody>
            {paging.rows.map((p) => (
              <tr key={p.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 10px" }}><div style={{ fontWeight: 600 }}>{p.full_name || p.email}</div><div style={{ fontSize: 11.5, color: "var(--muted)" }}>{p.email}{p.employee_no ? ` · ${p.employee_no}` : ""}</div></td>
                <td style={{ padding: "8px 10px", color: "var(--muted)" }}>{p.department || "—"}</td>
                <td style={{ padding: "8px 10px" }}>{p.phone || "—"}</td>
                <td style={{ padding: "8px 10px" }}><span style={{ padding: "3px 9px", borderRadius: 99, background: STATUS[p.status].bg, color: STATUS[p.status].fg, fontWeight: 700, fontSize: 11.5, whiteSpace: "nowrap" }}>{STATUS[p.status].label}</span></td>
                <td style={{ padding: "8px 10px" }}>{p.times_shown ? `${p.times_shown}×${p.later ? ` (Later ${p.later}×)` : ""}` : "—"}</td>
                <td style={{ padding: "8px 10px", color: "var(--muted)" }}>{d(p.last_shown)}</td>
              </tr>
            ))}
            {!paging.rows.length && <tr><td colSpan={6} style={{ padding: 12, color: "var(--muted)" }}>Nobody in this group.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager paging={paging} noun="people" />
    </div>
  );
}
