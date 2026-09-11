import { Search } from "lucide-react";

// Shared visual kit for the Finance-section queues (Compensation Claims,
// Deductions, Refundable, Payments, Capture Inbox) — a card-style Business
// Unit selector, boxed icon tabs, a labeled filter bar, and a circular-icon
// empty state, all built on new `fin-*` classes (styles.css) kept separate
// from the app-wide `.ep-tab`/`.ep-tabs` underline tabs those pages used
// before, so this redesign doesn't ripple into unrelated tab bars.

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
    <div className="fin-bu-tabs">
      {BUSINESS_UNITS.map((bu) => {
        const active = value === bu;
        const TabIcon = bu === "ALL" ? AllIcon : Icon;
        return (
          <button key={bu} type="button" className={`fin-bu-tab ${active ? "active" : ""}`} onClick={() => onChange(bu)}>
            <span className="fin-bu-tab-icon"><TabIcon size={17} /></span>
            <span className="fin-bu-tab-label">{bu === "ALL" ? "All" : bu}</span>
            <span className="fin-bu-tab-count">{counts[bu] ?? 0}</span>
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
    <div className="fin-icon-tabs">
      {tabs.map((t) => {
        const active = value === t.key;
        const TabIcon = t.icon;
        return (
          <button key={t.key} type="button" className={`fin-icon-tab ${active ? "active" : ""}`} onClick={() => onChange(t.key)}>
            <TabIcon size={14} />
            {t.label}
            <span className="fin-icon-tab-count">{t.count}</span>
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
