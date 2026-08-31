import TreasuryReportPage, { type ReportColumn } from "./TreasuryReportPage";

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const columns: ReportColumn[] = [
  { key: "employee_name", label: "Employee" },
  { key: "employee_no", label: "Employee No" },
  { key: "division_name", label: "Division" },
  { key: "department", label: "Department" },
  { key: "payback_amount", label: "Required Payback", money: true },
  { key: "first_submission_date", label: "First Submission", format: (v) => fmtDate(v) },
  { key: "submission_count", label: "# Submissions" },
  { key: "verified_by_name", label: "HR Verified By" },
  { key: "payback_verified_at", label: "HR Verified At", format: (v) => fmtDate(v) },
  { key: "treasury_settlement_status", label: "Treasury Status" },
  { key: "treasury_reconciliation_date", label: "Reconciliation Date", format: (v) => fmtDate(v) },
  { key: "transaction_reference", label: "Transaction Ref" },
  { key: "treasury_posting_reference", label: "Posting Ref" },
  { key: "outstanding_amount", label: "Outstanding", money: true }
];

export default function ReportEmployeePaybacks({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Employee Paybacks Report"
      subtitle="Payback proofs from submission through HR verification to Treasury reconciliation."
      endpoint="employee-paybacks"
      columns={columns}
      filenamePrefix="employee-paybacks"
      onBack={onBack}
    />
  );
}
