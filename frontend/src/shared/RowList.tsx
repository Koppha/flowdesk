import { useState, type CSSProperties, type ReactNode } from "react";
import {
  Ban, Briefcase, Building2, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, Code2, Cpu, Droplets, FileEdit, FileText, Hammer,
  HardDrive, Laptop, Lightbulb, Network, PaintRoller, RefreshCw, Scale, Search, Server, Settings2, ShieldAlert, Snowflake, Sparkles, Wrench, X, XCircle, Zap
} from "lucide-react";

// Request lists as rows: an icon tile, the title with a line or two under it,
// a status pill and a chevron - with a search box and pages of 10. Used by
// Maintenance, Change Requests and BRS Studio.

export const LIST_FRAME: CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" };
export const rowStyle = (idx: number, clickable = true): CSSProperties => ({
  padding: "14px 16px", borderTop: idx ? "1px solid var(--border)" : "none", cursor: clickable ? "pointer" : "default", background: "transparent"
});

// ── Tones ──
export type Tone = "green" | "amber" | "blue" | "red" | "gray" | "purple" | "orange";
const TONES: Record<Tone, { bg: string; fg: string; tile: string }> = {
  green: { bg: "#dcfce7", fg: "#166534", tile: "#e8f7ee" },
  amber: { bg: "#fef3c7", fg: "#92400e", tile: "#fff7e6" },
  orange: { bg: "#ffedd5", fg: "#9a3412", tile: "#fff1e6" },
  blue: { bg: "#dbeafe", fg: "#1e40af", tile: "#eaf2ff" },
  red: { bg: "#fee2e2", fg: "#991b1b", tile: "#fdecec" },
  gray: { bg: "#f1f5f9", fg: "#475569", tile: "#f1f5f9" },
  purple: { bg: "#ede9fe", fg: "#5b21b6", tile: "#f3efff" }
};

// A request's status as a coloured pill. Known words pick the colour.
export function toneOfStatus(status: string): Tone {
  const s = status.toUpperCase();
  if (/PENDING_VERIFICATION|TO_VERIFY/.test(s)) return "purple";
  if (/APPROVED|BASELINE|COMPLETED|CLOSED|CONFIRMED|VERIFIED|DONE|PAID/.test(s)) return "green";
  if (/REJECT|DECLIN|OVERDUE/.test(s)) return "red";
  if (/CANCEL|AUTO_CLOSED/.test(s)) return "gray";
  if (/DRAFT/.test(s)) return "gray";
  if (/INFO|UPDATE|WAITING|AWAITING|PENDING/.test(s)) return "orange";
  if (/ASSIGNED|ACCEPTED|IN_PROGRESS|PROGRESS|DEPT_INPUT|REVIEW/.test(s)) return "blue";
  if (/APPROVAL/.test(s)) return "purple";
  if (/SUBMITTED|NEW|OPEN/.test(s)) return "blue";
  return "gray";
}
const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function StatusPill({ status, label, tone }: { status: string; label?: string; tone?: Tone }) {
  const tn = tone ?? toneOfStatus(status);
  const t = TONES[tn];
  const u = status.toUpperCase();
  const Icon = tn === "green" ? CheckCircle2 : tn === "red" ? XCircle : /CANCEL/.test(u) ? Ban : /DRAFT/.test(u) ? FileEdit : Clock;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 11px", borderRadius: 999, background: t.bg, color: t.fg, fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap" }}>
      <Icon size={13} aria-hidden /> {label ?? pretty(status)}
    </span>
  );
}

export function IconTile({ children, tone = "blue" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span aria-hidden style={{ width: 44, height: 44, borderRadius: 12, background: TONES[tone].tile, color: TONES[tone].fg === "#475569" ? "#334155" : "#1d4ed8", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
      {children}
    </span>
  );
}

export function DateLine({ children }: { children: ReactNode }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><CalendarDays size={12} aria-hidden /> {children}</span>;
}

export const Chevron = ({ open }: { open?: boolean }) => (
  <ChevronRight size={18} aria-hidden style={{ color: "var(--muted)", flex: "none", transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s" }} />
);

// A whole row: tile | title + lines | right side (pill, actions) | chevron.
export function ListRow(props: { idx: number; icon: ReactNode; tone?: Tone; title: ReactNode; lines?: ReactNode[]; right?: ReactNode; onClick?: () => void; open?: boolean; accent?: string; children?: ReactNode }) {
  return (
    <div style={{ ...rowStyle(props.idx, !!props.onClick), boxShadow: props.accent ? `inset 4px 0 0 ${props.accent}` : undefined }}>
      <div role={props.onClick ? "button" : undefined} tabIndex={props.onClick ? 0 : undefined}
        onClick={props.onClick} onKeyDown={(e) => { if (props.onClick && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); props.onClick(); } }}
        style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
        <IconTile tone={props.tone}>{props.icon}</IconTile>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{props.title}</div>
          {(props.lines || []).filter(Boolean).map((l, i) => (
            <div key={i} style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3, display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "center" }}>{l}</div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>{props.right}</div>
        {props.onClick && <Chevron open={props.open} />}
      </div>
      {props.children}
    </div>
  );
}

// ── Icons ──
export function maintenanceIcon(category: string) {
  const c = (category || "").toLowerCase();
  if (/electric|power|light|units|generator/.test(c)) return <Zap size={20} />;
  if (/plumb|water|leak|toilet|drain/.test(c)) return <Droplets size={20} />;
  if (/air|aircon|hvac|cool|fridge|equip/.test(c)) return <Snowflake size={20} />;
  if (/build|roof|gutter|wall|door|window|struct/.test(c)) return <Building2 size={20} />;
  if (/paint/.test(c)) return <PaintRoller size={20} />;
  if (/clean|hygien/.test(c)) return <Sparkles size={20} />;
  if (/it\b|computer|network|laptop/.test(c)) return <Laptop size={20} />;
  if (/secur|safety|fire/.test(c)) return <ShieldAlert size={20} />;
  if (/furnit|carpent/.test(c)) return <Hammer size={20} />;
  return <Wrench size={20} />;
}

// A Change Request's icon from the type of change it ticks.
export function changeRequestIcon(data: Record<string, any> | null | undefined, typeCode?: string) {
  const d = data || {};
  if (typeCode && typeCode !== "CHANGE_REQUEST") return typeCode === "COMPUTER_REQUEST" ? <Laptop size={20} /> : <FileText size={20} />;
  if (d.change_type_network) return <Network size={20} />;
  if (d.change_type_applications) return <Code2 size={20} />;
  if (d.change_type_hardware) return <Cpu size={20} />;
  if (d.change_type_system_software) return <HardDrive size={20} />;
  if (d.change_type_configuration) return <Settings2 size={20} />;
  if (d.change_type_environment) return <Server size={20} />;
  if (d.change_type_business_rule) return <Scale size={20} />;
  if (d.change_type_business_request) return <Briefcase size={20} />;
  return <RefreshCw size={20} />;
}
export const brsIcon = () => <Lightbulb size={20} />;

// ── Search + pages ──
export function usePaging<T>(items: T[], text: (x: T) => string, pageSize = 10) {
  const [q, setQRaw] = useState("");
  const [page, setPage] = useState(1);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = words.length ? items.filter((x) => { const h = text(x).toLowerCase(); return words.every((w) => h.includes(w)); }) : items;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  const rows = filtered.slice((current - 1) * pageSize, current * pageSize);
  return { q, setQ: (v: string) => { setQRaw(v); setPage(1); }, page: current, setPage, pages, rows, total: filtered.length, all: items.length, pageSize };
}
export type Paging = ReturnType<typeof usePaging<any>>;

export function SearchBox({ value, onChange, placeholder, style }: { value: string; onChange: (v: string) => void; placeholder: string; style?: CSSProperties }) {
  return (
    <div style={{ position: "relative", flex: "1 1 260px", ...style }}>
      <Search size={15} aria-hidden style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        style={{ font: "inherit", fontSize: 14, width: "100%", boxSizing: "border-box", padding: "9px 32px 9px 34px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", color: "var(--text)" }} />
      {value && (
        <button type="button" aria-label="Clear the search" onClick={() => onChange("")}
          style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", cursor: "pointer", color: "var(--muted)", padding: 2 }}><X size={14} /></button>
      )}
    </div>
  );
}

export function Pager({ paging, noun, onPage }: { paging: Pick<Paging, "page" | "pages" | "total" | "all" | "pageSize" | "setPage">; noun: string; onPage?: (n: number) => void }) {
  if (!paging.all) return null;
  const go = (n: number) => { paging.setPage(n); onPage?.(n); };
  const nums: Array<number | "…"> = [];
  for (let i = 1; i <= paging.pages; i++) {
    if (i === 1 || i === paging.pages || Math.abs(i - paging.page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  const from = paging.total ? (paging.page - 1) * paging.pageSize + 1 : 0;
  const to = Math.min(paging.page * paging.pageSize, paging.total);
  const btn = (on: boolean): CSSProperties => ({ minWidth: 32, height: 32, padding: "0 8px", borderRadius: 8, border: "1px solid var(--border)", background: on ? "var(--primary, #2563eb)" : "var(--surface)", color: on ? "#fff" : "var(--text)", cursor: "pointer", fontSize: 13 });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, color: "var(--muted)", padding: "10px 2px 0" }}>
      <span style={{ flex: 1 }}>{paging.total ? `Showing ${from}–${to} of ${paging.total} ${noun}` : `No ${noun} match the search`}{paging.total !== paging.all ? ` (${paging.all} in all)` : ""}</span>
      {paging.pages > 1 && (
        <div style={{ display: "flex", gap: 4 }} role="navigation" aria-label={`${noun} pages`}>
          <button type="button" style={btn(false)} disabled={paging.page === 1} onClick={() => go(paging.page - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
          {nums.map((n, i) => n === "…" ? <span key={`e${i}`} style={{ alignSelf: "center" }}>…</span>
            : <button key={n} type="button" style={btn(n === paging.page)} aria-current={n === paging.page ? "page" : undefined} onClick={() => go(n)}>{n}</button>)}
          <button type="button" style={btn(false)} disabled={paging.page === paging.pages} onClick={() => go(paging.page + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
        </div>
      )}
    </div>
  );
}
