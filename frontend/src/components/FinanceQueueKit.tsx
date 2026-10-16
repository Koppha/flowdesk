import { useEffect, useRef, useState } from "react";
import { Columns3, Search } from "lucide-react";

// Shared visual kit for the Finance-section queues (Compensation Claims,
// Deductions, Refundable, Payments, Capture Inbox): a Business Unit tab row
// and a status tab row (both the app-wide .ep-tabs/.ep-tab style), a
// labeled filter bar, and a circular-icon empty state.

export const BUSINESS_UNITS = ["ALL", "MNO", "SEFS", "HigherLife"] as const;
export type BusinessUnit = (typeof BUSINESS_UNITS)[number];

export function BusinessUnitTabs({
  value, onChange, counts, icon: Icon, allIcon: AllIcon
}: {
  value: BusinessUnit;
  onChange: (v: BusinessUnit) => void;
  counts: Record<string, number>;
  icon: React.ElementType;
  allIcon: React.ElementType;
}) {
  return (
    <div className="ep-tabs">
      {BUSINESS_UNITS.map((bu) => {
        const active = value === bu;
        const TabIcon = bu === "ALL" ? AllIcon : Icon;
        return (
          <button key={bu} type="button" className={`ep-tab ${active ? "active" : ""}`} onClick={() => onChange(bu)}>
            <TabIcon size={14} />
            {bu === "ALL" ? "All" : bu}
            <span className="ep-tab-count">{counts[bu] ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

export function IconTabRow<T extends string>({
  value, onChange, tabs
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { key: T; label: string; count: number; icon: React.ElementType }[];
}) {
  return (
    <div className="ep-tabs">
      {tabs.map((t) => {
        const active = value === t.key;
        const TabIcon = t.icon;
        return (
          <button key={t.key} type="button" className={`ep-tab ${active ? "active" : ""}`} onClick={() => onChange(t.key)}>
            <TabIcon size={14} />
            {t.label}
            <span className="ep-tab-count">{t.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FinanceFilterBar({ children, onReset, onApply, showReset }: { children: React.ReactNode; onReset?: () => void; onApply?: () => void; showReset?: boolean }) {
  return (
    <div className="ep-panel" style={{ marginBottom: 14 }}>
      <div className="fin-filter-bar">
        {children}
        {(onReset || onApply) && (
          <div className="fin-filter-actions">
            {onReset && <button className="ep-btn-outline" type="button" disabled={!showReset} onClick={onReset}>Reset</button>}
            {onApply && <button className="ep-btn" type="button" onClick={onApply}><Search size={14} /> Apply Filters</button>}
          </div>
        )}
      </div>
    </div>
  );
}

export function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="fin-filter-field">
      {label}
      {children}
    </label>
  );
}

export function SearchField({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="fin-filter-field fin-filter-search">
      {label}
      <span className="fin-filter-field-search-input">
        <Search size={14} />
        <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      </span>
    </label>
  );
}

export function FinanceEmptyState({ icon: Icon, title, hint }: { icon: React.ElementType; title: string; hint?: string }) {
  return (
    <div className="fin-empty">
      <div className="fin-empty-icon"><Icon size={26} /></div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}

export function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="fin-filter-field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

// Light-card KPI tile, distinct from the app-wide gradient `.ep-kpi` cards —
// a small colored icon circle + value + label + optional subtext (e.g. an
// hours figure), matching the Finance-section redesign's visual language.
export function FinanceKpiRow({ children }: { children: React.ReactNode }) {
  return <div className="fin-kpi-row">{children}</div>;
}

export function FinanceKpiTile({
  icon: Icon, value, label, sub, tint, color
}: {
  icon: React.ElementType;
  value: React.ReactNode;
  label: string;
  sub?: React.ReactNode;
  tint: string;
  color: string;
}) {
  return (
    <div className="fin-kpi">
      <span className="fin-kpi-icon" style={{ background: tint, color }}><Icon size={18} /></span>
      <div>
        <div className="fin-kpi-label" style={{ color }}>{label}</div>
        <div className="fin-kpi-value">{value}</div>
        {sub && <div className="fin-kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function FinancePageHeader({
  icon: Icon, title, subtitle, actions
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="ep-header fin-page-header">
      <div className="fin-page-header-text">
        <span className="fin-page-header-icon"><Icon size={22} /></span>
        <div>
          <h1 className="ep-title">{title}</h1>
          <p className="ep-subtitle">{subtitle}</p>
        </div>
      </div>
      {actions && <div className="ep-actions">{actions}</div>}
    </div>
  );
}

// ── Choose columns ───────────────────────────────────────────────────────
// Each viewer picks which columns a finance table shows; remembered in this
// browser (a per-viewer convenience - falls back to the defaults if storage
// is unavailable). `locked` columns (e.g. Name) can't be hidden.
export type ColumnOption = { key: string; label: string; locked?: boolean };

export function useColumnVisibility(storageKey: string, defaultHidden: string[] = []) {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* storage unavailable */ }
    return new Set(defaultHidden);
  });
  function save(next: Set<string>) {
    setHidden(next);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* storage unavailable */ }
  }
  return {
    show: (key: string) => !hidden.has(key),
    toggle: (key: string) => { const next = new Set(hidden); if (next.has(key)) next.delete(key); else next.add(key); save(next); },
    reset: () => save(new Set(defaultHidden))
  };
}

export function ColumnChooser({ columns, show, toggle, reset }: {
  columns: ColumnOption[];
  show: (key: string) => boolean;
  toggle: (key: string) => void;
  reset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const shownCount = columns.filter((c) => show(c.key)).length;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="ep-btn-outline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Columns3 size={14} /> Columns <span style={{ color: "var(--muted)", fontWeight: 500 }}>{shownCount}/{columns.length}</span>
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 30, minWidth: 230, background: "var(--surface, #fff)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 10px 30px rgba(15,23,42,0.15)", padding: 8 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--muted)", padding: "4px 8px 6px", textTransform: "uppercase", letterSpacing: 0.4 }}>Show columns</div>
          <div style={{ maxHeight: 340, overflowY: "auto" }}>
            {columns.map((c) => (
              <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, fontSize: 13, cursor: c.locked ? "default" : "pointer", opacity: c.locked ? 0.6 : 1 }}>
                <input type="checkbox" checked={show(c.key)} disabled={c.locked} onChange={() => toggle(c.key)} />
                {c.label}
              </label>
            ))}
          </div>
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 6 }}>
            <button type="button" onClick={reset} style={{ border: "none", background: "transparent", color: "var(--primary, #2563eb)", cursor: "pointer", fontSize: 12.5, padding: "4px 8px" }}>Reset to default</button>
          </div>
        </div>
      )}
    </div>
  );
}
