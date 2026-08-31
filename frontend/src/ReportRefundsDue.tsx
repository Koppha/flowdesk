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
  { key: "destination", label: "Destination" },
  { key: "refund_amount", label: "Refund Amount", money: true },
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
