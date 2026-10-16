import TreasuryReportPage, { type ReportColumn, AMOUNT_TO_BE_EXPENSED_COLUMN, CLEARANCE_ORG_COLUMNS, CLEARANCE_TRIP_COLUMNS } from "./TreasuryReportPage";

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const columns: ReportColumn[] = [
  { key: "employee_name", label: "Employee", locked: true },
  { key: "employee_no", label: "Employee No" },
  ...CLEARANCE_ORG_COLUMNS,
  ...CLEARANCE_TRIP_COLUMNS,
  { key: "refund_amount", label: "Refund Amount", money: true },
  AMOUNT_TO_BE_EXPENSED_COLUMN,
  { key: "status", label: "Status" },
  { key: "treasury_settlement_status", label: "Treasury Status" },
  { key: "days_outstanding", label: "Days Outstanding" },
  { key: "treasury_officer_name", label: "Assigned Officer" },
  { key: "payment_date", label: "Payment Date", format: (v) => fmtDate(v) },
  { key: "payment_reference", label: "Payment Reference" },
  { key: "completion_date", label: "Completion Date", format: (v) => fmtDate(v) }
];

export default function ReportRefundsDue({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Refunds Due Report"
      subtitle="Refunds owed to employees, from awaiting-payment through to processed."
      endpoint="refunds-due"
      columns={columns}
      filenamePrefix="refunds-due"
      onBack={onBack}
    />
  );
}
