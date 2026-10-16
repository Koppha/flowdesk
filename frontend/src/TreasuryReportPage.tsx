import { useEffect, useState } from "react";
import { api } from "./api";
import { showNotice } from "./alerts";
import { formatMoney } from "./constants";
import { BarChart3, Download, Filter } from "lucide-react";
import { ColumnChooser, useColumnVisibility } from "./components/FinanceQueueKit";

export type ReportColumn = {
  key: string;
  label: string;
  money?: boolean;
  format?: (value: any, row: any) => React.ReactNode;
  // Off until the viewer turns it on in Columns.
  hidden?: boolean;
  // Can't be hidden (e.g. the employee's name).
  locked?: boolean;
};

export function fmtReportDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Columns every clearance report offers, in this order: where the traveller
// sits in Org Structure, where they're based, where and when they travelled,
// the VR / submission dates and the amount to be expensed (zero balance ->
// the advance; otherwise the cleared amount). Company is off by default -
// it's also a filter.
export const CLEARANCE_ORG_COLUMNS: ReportColumn[] = [
  { key: "company", label: "Company", hidden: true },
  { key: "division_name", label: "Division" },
  { key: "department", label: "Department" }
];
export const CLEARANCE_TRIP_COLUMNS: ReportColumn[] = [
  { key: "duty_station", label: "Duty Station" },
  { key: "destination", label: "Destination" },
  { key: "departure_date", label: "Departure", format: (v) => fmtReportDate(v) },
  { key: "return_date", label: "Return", format: (v) => fmtReportDate(v) },
  { key: "vr_date", label: "VR Date (advance approved)", format: (v) => fmtReportDate(v) },
  { key: "clearance_submitted_at", label: "Clearance Submitted", format: (v) => fmtReportDate(v) }
];
export const AMOUNT_TO_BE_EXPENSED_COLUMN: ReportColumn = { key: "amount_to_be_expensed", label: "Amount To Be Expensed", money: true };

// Plain text for the CSV: money to 2 decimals; otherwise the column's own
// formatting when it produces text (dates), else the raw value.
function csvCell(c: ReportColumn, row: any): string {
  const v = row[c.key];
  if (c.money) return v == null || v === "" ? "" : Number(v).toFixed(2);
  if (c.format) {
    const f = c.format(v, row);
    if (typeof f === "string" || typeof f === "number") return f === "—" ? "" : String(f);
  }
  if (Array.isArray(v)) return v.join("; ");
  return v == null ? "" : String(v);
}

// Shared table/filter/export shell for all 8 Finance Treasury reports (spec
// section 8). Each report page just supplies its endpoint + column list -
// filtering happens server-side (treasury-reports.routes.ts), and the same
// query result backs both the on-screen table and the CSV export, so they
// always agree with the active filters.
export default function TreasuryReportPage(props: {
  title: string;
  subtitle: string;
  endpoint: string;
  columns: ReportColumn[];
  filenamePrefix: string;
  onBack: () => void;
  extraSummary?: (data: any) => React.ReactNode;
}) {
  const { title, subtitle, endpoint, columns, filenamePrefix, onBack, extraSummary } = props;
  const [data, setData] = useState<any>({ items: [] });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);
  const [companies, setCompanies] = useState<string[]>([]);
  const [divisions, setDivisions] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const visibility = useColumnVisibility(`report-columns:${endpoint}`, columns.filter((c) => c.hidden).map((c) => c.key));
  const shownColumns = columns.filter((c) => c.locked || visibility.show(c.key));

  // Free-text Division/Department filters let a typo (or a name that
  // doesn't match the real org structure string exactly) silently return
  // zero rows with no indication why - real dropdowns, sourced from the
  // same org data every other admin screen uses, make every option always
  // a name that can actually match.
  useEffect(() => {
    // Company = divisions table; Division = departments table; Department = sections.
    api.divisions().then((rows: any[]) => setCompanies(rows.map((d) => d.name))).catch(() => {});
    api.departments().then((rows: any[]) => setDivisions(rows.map((d: any) => (typeof d === "string" ? d : d.name)).filter(Boolean))).catch(() => {});
    api.sections().then((rows: any[]) => setDepartments(Array.from(new Set((Array.isArray(rows) ? rows : []).map((d: any) => d.name).filter(Boolean))).sort() as string[])).catch(() => {});
  }, []);

  function load() {
    setLoading(true);
    const params: Record<string, string> = {};
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    api.treasuryReport(endpoint, params)
      .then((r: any) => setData(r || { items: [] }))
      .catch((e: any) => void showNotice(e?.message || "Failed to load report"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [endpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  // Exports exactly what's on screen: the loaded rows (current filters) and
  // the columns currently shown.
  function exportCsv() {
    setExporting(true);
    try {
      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const lines = [shownColumns.map((c) => esc(c.label)).join(",")];
      for (const row of items) lines.push(shownColumns.map((c) => esc(csvCell(c, row))).join(","));
      const el = document.createElement("a");
      el.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
      el.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
      el.click();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to export report");
    } finally {
      setExporting(false);
    }
  }

  const items: any[] = Array.isArray(data.items) ? data.items : [];

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon"><BarChart3 size={18} /></span>
            <h2>{title}</h2>
          </div>
          <p className="custom-requests-subtitle">{subtitle}</p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      {extraSummary && extraSummary(data)}

      <div className="ep-panel">
        <div className="ep-panel-head treasury-filter-bar">
          <Filter size={14} style={{ flexShrink: 0 }} />
          <div className="treasury-filter-field">
            <label>From</label>
            <input className="ep-form-input" type="date" value={filters.date_from || ""} onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value }))} />
          </div>
          <div className="treasury-filter-field">
            <label>To</label>
            <input className="ep-form-input" type="date" value={filters.date_to || ""} onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value }))} />
          </div>
          <div className="treasury-filter-field">
            <label>Company</label>
            <select className="ep-select" value={filters.company || ""} onChange={(e) => setFilters((f) => ({ ...f, company: e.target.value }))}>
              <option value="">Any company</option>
              {companies.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="treasury-filter-field">
            <label>Division</label>
            <select className="ep-select" value={filters.division || ""} onChange={(e) => setFilters((f) => ({ ...f, division: e.target.value }))}>
              <option value="">Any division</option>
              {divisions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="treasury-filter-field">
            <label>Department</label>
            <select className="ep-select" value={filters.department || ""} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}>
              <option value="">Any department</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="treasury-filter-field">
            <label>Outcome</label>
            <select className="ep-select" value={filters.financial_outcome || ""} onChange={(e) => setFilters((f) => ({ ...f, financial_outcome: e.target.value }))}>
              <option value="">All outcomes</option>
              <option value="BALANCED">Balanced</option>
              <option value="REFUND_DUE">Refund Due</option>
              <option value="PAYBACK_DUE">Payback Due</option>
            </select>
          </div>
          <div className="treasury-filter-actions">
            <button className="ep-btn" onClick={load} disabled={loading}>Apply Filters</button>
            <ColumnChooser columns={columns.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))} show={(k) => columns.find((c) => c.key === k)?.locked || visibility.show(k)} toggle={visibility.toggle} reset={visibility.reset} />
            <button className="ep-btn-outline" onClick={exportCsv} disabled={exporting || !items.length}><Download size={14} /> Export CSV</button>
          </div>
        </div>
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : !items.length ? (
            <div className="ep-empty"><p>No records match.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>{shownColumns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {items.map((row, i) => (
                  <tr key={row.id || i}>
                    {shownColumns.map((c) => (
                      <td key={c.key}>
                        {c.format ? c.format(row[c.key], row) : c.money ? formatMoney(Number(row[c.key] || 0), row.currency) : (row[c.key] ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
