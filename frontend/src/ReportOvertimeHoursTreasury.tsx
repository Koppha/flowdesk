import TreasuryReportPage, { type ReportColumn, CLEARANCE_ORG_COLUMNS } from "./TreasuryReportPage";

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Overtime has no Finance/money stage anymore — a claim closes straight off
// its last approval with Converted Hours as the final figure — so this
// Treasury report is hours-only, no amount column.
const columns: ReportColumn[] = [
  { key: "claim_no", label: "Claim No" },
  { key: "employee_name", label: "Employee", locked: true },
  { key: "employee_no", label: "Employee No" },
  ...CLEARANCE_ORG_COLUMNS,
  { key: "converted_hours", label: "Converted Hours" },
  { key: "equivalent_days", label: "Equivalent Days" },
  { key: "status", label: "Status" },
  { key: "submitted_at", label: "Submitted", format: (v) => fmtDate(v) },
  { key: "closed_at", label: "Closed", format: (v) => fmtDate(v) }
];

export default function ReportOvertimeHoursTreasury({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Overtime Hours Report"
      subtitle="Every non-draft Overtime claim, filtered and exportable — converted hours only, no Finance stage."
      endpoint="overtime-hours"
      columns={columns}
      filenamePrefix="overtime-hours"
      onBack={onBack}
    />
  );
}
