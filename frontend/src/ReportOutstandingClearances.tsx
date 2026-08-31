import TreasuryReportPage, { type ReportColumn } from "./TreasuryReportPage";

const columns: ReportColumn[] = [
  { key: "employee_name", label: "Employee" },
  { key: "division_name", label: "Division" },
  { key: "department", label: "Department" },
  { key: "responsible_team", label: "Responsible Team" },
  { key: "status", label: "Workflow Status" },
  { key: "balance_amount", label: "Outstanding Amount", money: true },
  { key: "days_outstanding", label: "Days Outstanding" },
  { key: "assigned_officer", label: "Assigned Officer" }
];

export default function ReportOutstandingClearances({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Outstanding Clearances Report"
      subtitle="Every trip not yet completed, grouped by who's currently responsible."
      endpoint="outstanding"
      columns={columns}
      filenamePrefix="outstanding-clearances"
      onBack={onBack}
    />
  );
}
