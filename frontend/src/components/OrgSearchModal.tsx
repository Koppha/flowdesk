import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Building2, Layers, Network, Search, Trash2, User, Users, X } from "lucide-react";
import { api } from "../api";

// One search over employees AND whole groups - Divisions, Departments and
// Sections - in the same style as the Workflow Builder's "Add participant"
// search. Used in BRS for co-writers and section collaborators.

export type OrgEntryType = "user" | "division" | "department" | "section";
export type OrgEntry = { type: OrgEntryType; id?: string | null; name?: string | null; label: string; permissions?: string[] };

type Person = { id: string; full_name: string | null; email: string; title?: string | null; department?: string | null; employee_no?: string | null };
type Row = { key: string; type: OrgEntryType; name: string; subtitle: string; company: string | null; division: string | null; entry: OrgEntry };

const STYLE: Record<OrgEntryType, { label: string; bg: string; color: string; Icon: any }> = {
  division: { label: "Division", bg: "#fce7f3", color: "#be185d", Icon: Building2 },
  department: { label: "Department", bg: "#e0e7ff", color: "#4338ca", Icon: Network },
  section: { label: "Section", bg: "#dcfce7", color: "#15803d", Icon: Users },
  user: { label: "Employee", bg: "#fef3c7", color: "#b45309", Icon: User }
};

export function orgEntryKey(e: { type: string; id?: string | null; name?: string | null }) {
  return `${e.type}:${e.type === "division" ? (e.name || "").toLowerCase() : e.id}`;
}

export function OrgEntryChip({ entry, onRemove }: { entry: OrgEntry; onRemove?: () => void }) {
  const st = STYLE[entry.type];
  const Icon = st.Icon;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 8px", borderRadius: 99, fontSize: 12, fontWeight: 600, background: st.bg, color: st.color }}>
      <Icon size={12} /> {entry.label}
      {entry.type !== "user" && <span style={{ fontWeight: 400, opacity: 0.8 }}>· {st.label}</span>}
      {onRemove && (
        <button type="button" aria-label={`Remove ${entry.label}`} onClick={onRemove}
          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 2, display: "inline-flex", color: "inherit" }}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

export default function OrgSearchModal(props: {
  title: string;
  subtitle: string;
  people: Person[];
  kinds?: OrgEntryType[];
  excludeKeys?: string[];
  onAdd: (entries: OrgEntry[]) => void;
  onClose: () => void;
}) {
  const { title, subtitle, people, kinds = ["division", "department", "section", "user"], excludeKeys = [], onAdd, onClose } = props;
  const [options, setOptions] = useState<{ divisions: any[]; departments: any[]; sections: any[] }>({ divisions: [], departments: [], sections: [] });
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [company, setCompany] = useState("");
  const [division, setDivision] = useState("");
  const [multi, setMulti] = useState(false);
  const [picked, setPicked] = useState<Row[]>([]);

  useEffect(() => {
    api.distributionOptions().then((o: any) => setOptions({ divisions: o?.divisions || [], departments: o?.departments || [], sections: o?.sections || [] })).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const companyOf = useMemo(() => new Map(options.divisions.map((d: any) => [String(d.name).toLowerCase(), d.company as string | null])), [options.divisions]);
  const companies = useMemo(() => [...new Set(options.divisions.map((d: any) => d.company).filter(Boolean))].sort() as string[], [options.divisions]);
  const divisionNames = useMemo(
    () => options.divisions.filter((d: any) => !company || d.company === company).map((d: any) => d.name as string).sort(),
    [options.divisions, company]
  );

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (kinds.includes("division")) for (const d of options.divisions) {
      if (!d.members) continue;
      out.push({ key: `division:${String(d.name).toLowerCase()}`, type: "division", name: d.name, subtitle: `${d.company ? d.company + " · " : ""}${d.members} people`, company: d.company, division: d.name,
        entry: { type: "division", name: d.name, label: d.name } });
    }
    if (kinds.includes("department")) for (const d of options.departments) {
      if (!d.members) continue;
      out.push({ key: `department:${d.id}`, type: "department", name: d.name, subtitle: `${d.parent ? d.parent + " · " : ""}${d.members} people`, company: d.parent ? companyOf.get(String(d.parent).toLowerCase()) ?? null : null, division: d.parent,
        entry: { type: "department", id: d.id, label: d.name } });
    }
    if (kinds.includes("section")) for (const t of options.sections) {
      if (!t.members) continue;
      out.push({ key: `section:${t.id}`, type: "section", name: t.name, subtitle: `${t.parent ? t.parent + " · " : ""}${t.members} people`, company: null, division: null,
        entry: { type: "section", id: t.id, label: t.name } });
    }
    if (kinds.includes("user")) for (const p of people) {
      out.push({ key: `user:${p.id}`, type: "user", name: p.full_name || p.email, subtitle: [p.title, p.department, p.employee_no].filter(Boolean).join(" · "),
        company: p.department ? companyOf.get(String(p.department).toLowerCase()) ?? null : null, division: p.department ?? null,
        entry: { type: "user", id: p.id, label: p.full_name || p.email } });
    }
    const q = query.trim().toLowerCase();
    return out
      .filter((r) => !excludeKeys.includes(r.key))
      .filter((r) => !company || r.company === company || r.type === "section")
      .filter((r) => !division || (r.division || "").toLowerCase() === division.toLowerCase() || r.key === `division:${division.toLowerCase()}`)
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q))
      .slice(0, q || company || division ? 200 : 60);
  }, [options, people, kinds, excludeKeys, query, company, division, companyOf]);

  const isPicked = (r: Row) => picked.some((p) => p.key === r.key);
  function act(r: Row) {
    if (!multi) { onAdd([r.entry]); onClose(); return; }
    setPicked((prev) => (isPicked(r) ? prev.filter((p) => p.key !== r.key) : [...prev, r]));
  }

  return createPortal(
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div style={{ background: "var(--surface)", borderRadius: 14, padding: 24, width: 620, maxWidth: "100%", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,0.25)" }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "#dbeafe", color: "#1d4ed8", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Layers size={18} /></div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{subtitle}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 4 }} aria-label="Close"><X size={18} /></button>
        </div>

        <div style={{ position: "relative", marginBottom: 12 }}>
          <Search size={15} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
          <input autoFocus placeholder="Search division, department, section or employee" value={query} onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%", padding: "10px 10px 10px 36px", border: "1px solid #93c5fd", borderRadius: 8, background: "var(--surface)", color: "var(--text)", fontSize: 14, boxSizing: "border-box" }} />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Results</span>
          <button type="button" onClick={() => setFiltersOpen((v) => !v)}
            style={{ fontSize: 13, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", cursor: "pointer" }}>Filters</button>
        </div>
        {filtersOpen && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <select className="ep-form-select" value={company} onChange={(e) => { setCompany(e.target.value); setDivision(""); }} style={{ flex: 1, minWidth: 140 }}>
              <option value="">All companies…</option>
              {companies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="ep-form-select" value={division} onChange={(e) => setDivision(e.target.value)} style={{ flex: 2, minWidth: 180 }}>
              <option value="">All divisions…</option>
              {divisionNames.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10, minHeight: 180, maxHeight: 320 }}>
          {rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>{query ? "No matches found." : "Loading…"}</div>
          ) : rows.map((r) => {
            const st = STYLE[r.type];
            const Icon = st.Icon;
            const sel = isPicked(r);
            return (
              <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ width: 38, height: 38, borderRadius: 9, background: st.bg, color: st.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={17} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: st.bg, color: st.color, flexShrink: 0 }}>{st.label}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subtitle}</div>
                </div>
                <button type="button" onClick={() => act(r)} aria-label={`Add ${r.name}`}
                  style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0, border: `1px solid ${sel ? "#1d4ed8" : "#93c5fd"}`, background: sel ? "#1d4ed8" : "var(--surface)", color: sel ? "#fff" : "#1d4ed8", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 600 }}>
                  {multi && sel ? "✓" : "+"}
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: 14, gap: 8 }}>
          <button type="button" onClick={() => { setMulti((v) => !v); setPicked([]); }}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "7px 12px", border: `1px solid ${multi ? "#1d4ed8" : "var(--border)"}`, borderRadius: 7, background: multi ? "#eff6ff" : "var(--surface-soft)", color: multi ? "#1d4ed8" : "var(--text)", cursor: "pointer" }}>
            <Users size={14} /> Multiple selection
          </button>
          <button type="button" onClick={() => { setQuery(""); setCompany(""); setDivision(""); setPicked([]); }} title="Clear search & filters"
            style={{ width: 34, height: 34, borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface-soft)", color: "#dc2626", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Trash2 size={15} />
          </button>
        </div>
        {multi && picked.length > 0 && (
          <button type="button" onClick={() => { onAdd(picked.map((p) => p.entry)); onClose(); }}
            style={{ marginTop: 12, padding: "9px 14px", background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            Add Selected ({picked.length})
          </button>
        )}
        <div style={{ marginTop: 14, padding: "10px 14px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, fontSize: 12, color: "#1e40af" }}>
          Search by division, department or section name, or an employee's name, title or employee number. Adding a group includes everyone currently in it.
        </div>
      </div>
    </div>,
    document.body
  );
}
