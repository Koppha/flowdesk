import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Search, UserX } from "lucide-react";
import { api } from "./api";

// Active users with a Division but no Department (RAID Advances R3): their
// reports and department-based approvals are incomplete. Pick their
// Department here - the ones in their own Division are listed first.

type GapUser = { id: string; full_name: string | null; email: string; employee_no: string | null; title: string | null; role: string; division: string; division_ref_id: string | null };
type Dept = { id: string; name: string; division_ref_id: string | null; division: string | null; members: number };

export default function OrgGaps() {
  const [users, setUsers] = useState<GapUser[]>([]);
  const [departments, setDepartments] = useState<Dept[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [division, setDivision] = useState("ALL");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [done, setDone] = useState<Array<{ name: string; department: string }>>([]);

  useEffect(() => {
    api.orgGaps()
      .then((r: any) => { setUsers(r.users || []); setDepartments(r.departments || []); })
      .catch((e: any) => setError(e.message || "Couldn't load the list."))
      .finally(() => setLoading(false));
  }, []);

  const divisions = useMemo(() => [...new Set(users.map((u) => u.division))].sort(), [users]);
  const shown = users.filter((u) =>
    (division === "ALL" || u.division === division) &&
    (!search || `${u.full_name} ${u.email} ${u.employee_no ?? ""} ${u.title ?? ""}`.toLowerCase().includes(search.toLowerCase())));

  async function save(u: GapUser) {
    const sectionId = choice[u.id];
    if (!sectionId) return;
    setSaving(u.id);
    try {
      const r = await api.setOrgGapDepartment(u.id, sectionId);
      setUsers((list) => list.filter((x) => x.id !== u.id));
      setDone((d) => [{ name: u.full_name || u.email, department: r.department }, ...d].slice(0, 8));
    } catch (e: any) {
      setError(e.message || "Couldn't save.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <h2 style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 6px" }}><UserX size={20} /> Missing Department</h2>
      <p style={{ margin: "0 0 16px", color: "var(--muted)", fontSize: 13.5 }}>
        Active people with a Division but no Department. Their reports and department-based approvals are incomplete until it's set.
        Pick their Department and press <strong>Set</strong> — each change is recorded in the audit log.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <span style={{ padding: "4px 12px", borderRadius: 99, background: users.length ? "#fef3c7" : "#dcfce7", color: users.length ? "#92400e" : "#166534", fontWeight: 700, fontSize: 13 }}>
          {loading ? "Loading…" : users.length ? `${users.length} still missing` : "Nobody missing a Department"}
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", background: "var(--surface)" }}>
          <Search size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, emp no…" style={{ border: "none", outline: "none", background: "transparent", width: 220 }} />
        </label>
        <select value={division} onChange={(e) => setDivision(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)" }}>
          <option value="ALL">All divisions</option>
          {divisions.map((d) => <option key={d} value={d}>{d} ({users.filter((u) => u.division === d).length})</option>)}
        </select>
      </div>

      {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {done.length > 0 && (
        <div style={{ fontSize: 12.5, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
          <CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> Set: {done.map((d) => `${d.name} → ${d.department}`).join(" · ")}
        </div>
      )}

      {!loading && shown.length > 0 && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12 }}>
                {["Person", "Division", "Department", ""].map((h) => <th key={h} style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => {
                const own = departments.filter((d) => u.division_ref_id && d.division_ref_id === u.division_ref_id);
                const other = departments.filter((d) => !own.includes(d));
                return (
                  <tr key={u.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 12px" }}>
                      <div style={{ fontWeight: 600 }}>{u.full_name || u.email}</div>
                      <div style={{ color: "var(--muted)", fontSize: 11.5 }}>{[u.title, u.employee_no, u.email].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td style={{ padding: "8px 12px" }}>{u.division}</td>
                    <td style={{ padding: "8px 12px" }}>
                      <select value={choice[u.id] || ""} onChange={(e) => setChoice((c) => ({ ...c, [u.id]: e.target.value }))} style={{ padding: "6px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface)", minWidth: 240 }}>
                        <option value="">Choose a department…</option>
                        {own.length > 0 && (
                          <optgroup label={`In ${u.division}`}>
                            {own.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.members})</option>)}
                          </optgroup>
                        )}
                        <optgroup label="Other divisions">
                          {other.map((d) => <option key={d.id} value={d.id}>{d.name}{d.division ? ` — ${d.division}` : ""}</option>)}
                        </optgroup>
                      </select>
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <button disabled={!choice[u.id] || saving === u.id} onClick={() => void save(u)}
                        style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: choice[u.id] ? "#1d4ed8" : "#cbd5e1", color: "#fff", fontWeight: 600, cursor: choice[u.id] ? "pointer" : "default" }}>
                        {saving === u.id ? "Saving…" : "Set"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!loading && users.length > 0 && shown.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>Nobody matches that search.</div>}
    </div>
  );
}
