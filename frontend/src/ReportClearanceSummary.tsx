import TreasuryReportPage, { type ReportColumn, AMOUNT_TO_BE_EXPENSED_COLUMN, CLEARANCE_ORG_COLUMNS, CLEARANCE_TRIP_COLUMNS } from "./TreasuryReportPage";
import { formatMoney } from "./constants";

const columns: ReportColumn[] = [
  { key: "month", label: "Month" },
  { key: "employee_name", label: "Employee", locked: true },
  { key: "employee_no", label: "Employee No" },
  ...CLEARANCE_ORG_COLUMNS,
  ...CLEARANCE_TRIP_COLUMNS,
  { key: "financial_outcome", label: "Outcome" },
  // A claim (trip with no advance) says so instead of showing 0.00 on screen (the CSV keeps 0.00).
  { key: "advance_amount", label: "Advance", money: true, format: (v, row) => (row?.claim_kind === "CLAIM" ? "No advance (claim)" : formatMoney(Number(v || 0), row?.currency)) },
  { key: "verified_expenses", label: "Verified Expenses", money: true },
  AMOUNT_TO_BE_EXPENSED_COLUMN,
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
