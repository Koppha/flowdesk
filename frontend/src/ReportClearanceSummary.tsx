import TreasuryReportPage, { type ReportColumn } from "./TreasuryReportPage";
import { formatMoney } from "./constants";

const columns: ReportColumn[] = [
  { key: "month", label: "Month" },
  { key: "division_name", label: "Division" },
  { key: "department", label: "Department" },
  { key: "employee_name", label: "Employee" },
  { key: "financial_outcome", label: "Outcome" },
  { key: "advance_amount", label: "Advance", money: true },
  { key: "verified_expenses", label: "Verified Expenses", money: true },
  { key: "status", label: "Status" }
];

function Summary({ totals }: { totals: any }) {
  if (!totals) return null;
  const tiles: [string, string][] = [
    ["Total Trips", String(totals.total_trips || 0)],
    ["Total Advances", formatMoney(totals.total_advances || 0)],
    ["Total Verified Expenses", formatMoney(totals.total_verified_expenses || 0)],
    ["Balanced", `${totals.balanced_count || 0}`],
    ["Refunds", `${totals.refund_count || 0} — ${formatMoney(totals.refund_value || 0)}`],
    ["Paybacks", `${totals.payback_count || 0} — ${formatMoney(totals.payback_value || 0)}`],
    ["Outstanding Refunds", formatMoney(totals.total_outstanding_refunds || 0)],
    ["Unreconciled Paybacks", formatMoney(totals.total_unreconciled_paybacks || 0)],
    ["Completed", String(totals.completed_count || 0)],
    ["In Progress", String(totals.in_progress_count || 0)]
  ];
  return (
    <div className="ep-kpi-row" style={{ marginBottom: 16, flexWrap: "wrap" }}>
      {tiles.map(([label, value]) => (
        <div className="ep-kpi ep-kpi-blue" key={label}>
          <div><div className="ep-kpi-value" style={{ fontSize: 18 }}>{value}</div><div className="ep-kpi-label">{label}</div></div>
        </div>
      ))}
    </div>
  );
}

export default function ReportClearanceSummary({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Clearance Summary Report"
      subtitle="Overview of every submitted trip clearance and its financial outcome."
      endpoint="clearance-summary"
      columns={columns}
      filenamePrefix="clearance-summary"
      onBack={onBack}
      extraSummary={(data) => <Summary totals={data.totals} />}
    />
  );
}
