import { useEffect, useState } from "react";
import { api, downloadBlob } from "./api";
import { showNotice } from "./alerts";
import { BarChart3, Clock3, Download, Filter } from "lucide-react";

// Overtime reports — supersedes the old fixed, unfilterable allowance dump
// inside Overtime.tsx's Reports tab. Same shell shape as TreasuryReportPage
// (filter bar + table backed by the same server-side query as the export),
// but Overtime's own filter set (year/month/status/division/department)
// rather than Treasury's (date range/division/outcome), so it's a sibling
// component rather than a reuse of TreasuryReportPage itself. Hours-only —
// there's no Finance/payment stage left in Overtime claims, so every column
// here is a hours/status figure, never a money amount.
type ReportKey = "allowance" | "paid-history";

const TABS: { key: ReportKey; label: string; icon: any }[] = [
  { key: "allowance", label: "Hours Report", icon: BarChart3 },
  { key: "paid-history", label: "Completed Claims", icon: Clock3 }
];

type Column = { key: string; label: string };

const COLUMNS: Record<ReportKey, Column[]> = {
  allowance: [
    { key: "claim_no", label: "Claim No." },
    { key: "employee_name", label: "Employee" },
    { key: "employee_no", label: "E/N" },
    { key: "job_title", label: "Job Title" },
    { key: "hours_125", label: "125%" },
    { key: "hours_150", label: "150%" },
    { key: "hours_200", label: "200%" },
    { key: "converted_hours", label: "Converted" },
    { key: "equivalent_days", label: "Equivalent Days" },
    { key: "status", label: "Status" }
  ],
  "paid-history": [
    { key: "claim_no", label: "Claim No." },
    { key: "employee_name", label: "Employee" },
    { key: "employee_no", label: "E/N" },
    { key: "division_name", label: "Division" },
    { key: "converted_hours", label: "Converted" },
    { key: "equivalent_days", label: "Equivalent Days" },
    { key: "closed_at", label: "Closed At" }
  ]
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function OvertimeReportsHub({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<ReportKey>("allowance");
  const [data, setData] = useState<any>({ items: [] });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  function load() {
    setLoading(true);
    const params: Record<string, string> = {};
    Object.entries(filters).forEach(([k, v]) => {
      if (v) params[k] = v;
    });
    api
      .overtimeReport(tab, params)
      .then((r: any) => setData(r || { items: [] }))
      .catch((e: any) => void showNotice(e?.message || "Failed to load report"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function exportAs(fmt: "csv" | "pdf") {
    setExporting(fmt);
    try {
      const params: Record<string, string> = {};
      Object.entries(filters).forEach(([k, v]) => {
        if (v) params[k] = v;
      });
      const fetcher = fmt === "csv" ? () => api.overtimeReportCsv(tab, params) : () => api.overtimeReportPdf(tab, params);
      await downloadBlob(fetcher, `overtime-${tab}.${fmt}`);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to export report");
    } finally {
      setExporting(null);
    }
  }

  const items: any[] = Array.isArray(data.items) ? data.items : [];
  const columns = COLUMNS[tab];

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon">
              <BarChart3 size={18} />
            </span>
            <h2>Overtime Reports</h2>
          </div>
          <p className="custom-requests-subtitle">Overtime hours reporting — filtered, exportable, matching what's on screen.</p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">
          Back
        </button>
      </div>

      <div className="ep-tabs" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`ep-tab${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
            <t.icon size={14} aria-hidden /> {t.label}
          </button>
        ))}
      </div>

      <div className="ep-panel">
        <div className="ep-panel-head treasury-filter-bar">
          <Filter size={14} style={{ flexShrink: 0 }} />
          <div className="treasury-filter-field">
            <label>Year</label>
            <input className="ep-form-input" placeholder="Any year" value={filters.year || ""} onChange={(e) => setFilters((f) => ({ ...f, year: e.target.value }))} />
          </div>
          <div className="treasury-filter-field">
            <label>Month</label>
            <select className="ep-select" value={filters.month || ""} onChange={(e) => setFilters((f) => ({ ...f, month: e.target.value }))}>
              <option value="">Any month</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={String(i + 1)}>{m}</option>
              ))}
            </select>
          </div>
          <div className="treasury-filter-field">
            <label>Division</label>
            <input className="ep-form-input" placeholder="Any division" value={filters.division || ""} onChange={(e) => setFilters((f) => ({ ...f, division: e.target.value }))} />
          </div>
          <div className="treasury-filter-field">
            <label>Department</label>
            <input className="ep-form-input" placeholder="Any department" value={filters.department || ""} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))} />
          </div>
          <div className="treasury-filter-actions">
            <button className="ep-btn" onClick={load} disabled={loading}>Apply Filters</button>
            <button className="ep-btn-outline" onClick={() => void exportAs("csv")} disabled={exporting !== null}><Download size={14} /> CSV</button>
            <button className="ep-btn-outline" onClick={() => void exportAs("pdf")} disabled={exporting !== null}><Download size={14} /> PDF</button>
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
                <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {items.map((row, i) => (
                  <tr key={row.id || i}>
                    {columns.map((c) => (
                      <td key={c.key}>{row[c.key] ?? "—"}</td>
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
