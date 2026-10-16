import TreasuryReportPage, { type ReportColumn, CLEARANCE_ORG_COLUMNS, CLEARANCE_TRIP_COLUMNS } from "./TreasuryReportPage";

const columns: ReportColumn[] = [
  { key: "employee_name", label: "Employee", locked: true },
  { key: "employee_no", label: "Employee No" },
  ...CLEARANCE_ORG_COLUMNS,
  ...CLEARANCE_TRIP_COLUMNS.map((c) => ({ ...c, hidden: true })),
  { key: "financial_outcome", label: "Outcome" },
  { key: "required_settlement_amount", label: "Required", money: true },
  { key: "actual_settlement_amount", label: "Actual", money: true },
  { key: "difference", label: "Difference", money: true },
  { key: "payment_reference", label: "Payment Ref" },
  { key: "posting_reference", label: "Posting Ref" },
  { key: "hr_verifier", label: "HR Verifier" },
  { key: "treasury_processor", label: "Treasury Processor" },
  { key: "final_status", label: "Final Status" },
  { key: "exceptions", label: "Exceptions", format: (v: string[]) => (v?.length ? v.join("; ") : "—") }
];

export default function ReportAuditReconciliation({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Audit and Reconciliation Report"
      subtitle="Flags settlement discrepancies, missing references, and unreconciled or overdue items."
      endpoint="audit-reconciliation"
      columns={columns}
      filenamePrefix="audit-reconciliation"
      onBack={onBack}
    />
  );
}
