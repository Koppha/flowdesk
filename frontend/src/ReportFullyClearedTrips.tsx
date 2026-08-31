import TreasuryReportPage, { type ReportColumn } from "./TreasuryReportPage";

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const OUTCOME_LABEL: Record<string, string> = { BALANCED: "Balanced", REFUND_DUE: "Refund Due", PAYBACK_DUE: "Payback Due" };

const columns: ReportColumn[] = [
  { key: "employee_name", label: "Employee" },
  { key: "division_name", label: "Division" },
  { key: "department", label: "Department" },
  { key: "destination", label: "Destination" },
  { key: "financial_outcome", label: "Original Outcome", format: (v) => OUTCOME_LABEL[v] || v },
  { key: "advance_amount", label: "Advance", money: true },
  { key: "verified_expenses", label: "Verified Expenses", money: true },
  { key: "balance_amount", label: "Refund/Payback", money: true },
  { key: "treasury_completion_date", label: "Treasury Completion", format: (v) => fmtDate(v) },
  { key: "processing_days", label: "Processing Days" }
];

export default function ReportFullyClearedTrips({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Fully Cleared Trips Report"
      subtitle="Completed clearances - retains the original financial outcome even after full clearance."
      endpoint="fully-cleared"
      columns={columns}
      filenamePrefix="fully-cleared-trips"
      onBack={onBack}
    />
  );
}
