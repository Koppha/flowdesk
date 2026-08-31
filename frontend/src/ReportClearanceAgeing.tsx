import { useEffect, useState } from "react";
import { api } from "./api";
import { showNotice } from "./alerts";
import { Clock3 } from "lucide-react";

// Ageing uses the date the record entered its current actionable stage
// (payback_verified_at / sent_to_treasury_at / submitted_at, whichever is
// most recent), not the original trip date - computed server-side in
// treasury-reports.routes.ts's /ageing endpoint.
export default function ReportClearanceAgeing({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<{ bands: string[]; grid: { category: string; bands: { band: string; count: number }[] }[] }>({ bands: [], grid: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.treasuryReport("ageing")
      .then((r: any) => setData(r))
      .catch((e: any) => void showNotice(e?.message || "Failed to load ageing report"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon"><Clock3 size={18} /></span>
            <h2>Ageing Report</h2>
          </div>
          <p className="custom-requests-subtitle">How long incomplete clearances have sat in each stage.</p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : !data.grid.length ? (
            <div className="ep-empty"><p>No outstanding clearances.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Category</th>
                  {data.bands.map((b) => <th key={b}>{b}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.grid.map((row) => (
                  <tr key={row.category}>
                    <td>{row.category}</td>
                    {row.bands.map((b) => <td key={b.band}>{b.count}</td>)}
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
