import TreasuryReportPage, { type ReportColumn } from "./TreasuryReportPage";

const columns: ReportColumn[] = [
  { key: "division_name", label: "Division" },
  { key: "department", label: "Department" },
  { key: "trips", label: "Trips" },
  { key: "total_advances", label: "Total Advances", money: true },
  { key: "total_verified_expenses", label: "Total Verified Expenses", money: true },
  { key: "total_refunds", label: "Total Refunds", money: true },
  { key: "total_paybacks", label: "Total Paybacks", money: true },
  { key: "avg_clearance_days", label: "Avg Clearance Days", format: (v) => (v != null ? Number(v).toFixed(1) : "—") },
  { key: "outstanding", label: "Outstanding" },
  { key: "overdue", label: "Overdue (>30d)" },
  { key: "completion_rate", label: "Completion Rate %", format: (v) => (v != null ? `${v}%` : "—") }
];

export default function ReportDeptDivisionClearance({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Department and Division Report"
      subtitle="Clearance activity summarized by division and department."
      endpoint="department-division"
      columns={columns}
      filenamePrefix="department-division-clearance"
      onBack={onBack}
    />
  );
}
