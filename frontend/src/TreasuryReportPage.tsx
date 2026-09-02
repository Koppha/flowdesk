import { useEffect, useState } from "react";
import { api, downloadBlob } from "./api";
import { showNotice } from "./alerts";
import { formatMoney } from "./constants";
import { BarChart3, Download, Filter } from "lucide-react";

export type ReportColumn = {
  key: string;
  label: string;
  money?: boolean;
  format?: (value: any, row: any) => React.ReactNode;
};

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

  async function exportCsv() {
    setExporting(true);
    try {
      const params: Record<string, string> = {};
      Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
      await downloadBlob(() => api.treasuryReportCsv(endpoint, params), `${filenamePrefix}.csv`);
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
            <label>Division</label>
            <input className="ep-form-input" placeholder="Any division" value={filters.division || ""} onChange={(e) => setFilters((f) => ({ ...f, division: e.target.value }))} />
          </div>
          <div className="treasury-filter-field">
            <label>Department</label>
            <input className="ep-form-input" placeholder="Any department" value={filters.department || ""} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))} />
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
            <button className="ep-btn-outline" onClick={exportCsv} disabled={exporting}><Download size={14} /> Export CSV</button>
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
