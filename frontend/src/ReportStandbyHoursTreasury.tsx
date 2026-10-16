import TreasuryReportPage, { type ReportColumn, CLEARANCE_ORG_COLUMNS } from "./TreasuryReportPage";

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Standby claims and Call-Outs, combined — neither has a Finance/money
// stage anymore, so this is hours-only (Compensable Hours for a monthly
// claim, Converted Hours for a Call-Out), tagged by Type.
const columns: ReportColumn[] = [
  { key: "type", label: "Type", format: (v) => (v === "CALL_OUT" ? "Call-Out" : "Standby Claim") },
  { key: "claim_no", label: "Claim No" },
  { key: "employee_name", label: "Employee", locked: true },
  { key: "employee_no", label: "Employee No" },
  ...CLEARANCE_ORG_COLUMNS,
  { key: "hours", label: "Hours" },
  { key: "status", label: "Status" },
  { key: "submitted_at", label: "Submitted", format: (v) => fmtDate(v) },
  { key: "closed_at", label: "Closed", format: (v) => fmtDate(v) }
];

export default function ReportStandbyHoursTreasury({ onBack }: { onBack: () => void }) {
  return (
    <TreasuryReportPage
      title="Standby Hours Report"
      subtitle="Standby claims and Call-Outs, combined — filtered and exportable, hours only."
      endpoint="standby-hours"
      columns={columns}
      filenamePrefix="standby-hours"
      onBack={onBack}
    />
  );
}
