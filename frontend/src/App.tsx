import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStaffDirectory, refreshStaffDirectory } from "./useStaffDirectory";
import { api, clearToken, getTheme, getToken, setTheme as saveTheme, setToken, getUserFromToken, getUiScale, saveUiScale, openBlobInNewTab } from "./api";
import Inbox, { isCaptureItem, isCapturePendingItem, isPaymentItem, needsAccommodationBooking } from "./Inbox";
import Payments from "./Payments";
import Deductions from "./Deductions";
import Refundable from "./Refundable";
import Accommodation from "./Accommodation";
import PaybackReview from "./PaybackReview";
import TreasuryProcessing from "./TreasuryProcessing";
import ReportClearanceSummary from "./ReportClearanceSummary";
import ReportRefundsDue from "./ReportRefundsDue";
import ReportEmployeePaybacks from "./ReportEmployeePaybacks";
import ReportFullyClearedTrips from "./ReportFullyClearedTrips";
import ReportOutstandingClearances from "./ReportOutstandingClearances";
import ReportClearanceAgeing from "./ReportClearanceAgeing";
import ReportAuditReconciliation from "./ReportAuditReconciliation";
import ReportDeptDivisionClearance from "./ReportDeptDivisionClearance";
import VendorContracts from "./VendorContracts";
import ServiceContracts from "./ServiceContracts";
import ITProvisioning from "./ITProvisioning";
import Overtime from "./Overtime";
import EmployeesOnboarding from "./EmployeesOnboarding";
import ExcoOnboarding from "./ExcoOnboarding";
import LeadershipAssignments from "./LeadershipAssignments";
import ManagersOnboarding from "./ManagersOnboarding";
import WorkflowBuilder from "./WorkflowBuilder";
import Standby from "./Standby";
import ReportingLines from "./ReportingLines";
import PdfDesigner from "./PdfDesigner";
import DataCleanup from "./DataCleanup";
import RequestTypes from "./RequestTypes";
import CustomRequestsHub from "./CustomRequestsHub";
import BrsStudio from "./BrsStudio";
import BrsAdmin from "./BrsAdmin";
import EmailActionConfirm from "./EmailActionConfirm";
import GuidedTour, { type TourStep } from "./GuidedTour";
import CeoManagement from "./CeoManagement";
import OrgStructure from "./OrgStructure";
import OrgPicker, { type OrgSelection, orgSelectionFromUser } from "./OrgPicker";
import TeamRoster from "./TeamRoster";
import UserManagement from "./UserManagement";
import SlaReports from "./SlaReports";
import ReportAdvances from "./ReportAdvances";
import MyAdvances from "./MyAdvances";
import MyClearances from "./MyClearances";
import ReportApprovalPerformance from "./ReportApprovalPerformance";
import ReportWorkflowAnalytics from "./ReportWorkflowAnalytics";
import OvertimeReportsHub from "./OvertimeReportsHub";
import ReportAuditTrail from "./ReportAuditTrail";
import ReportReconciliation from "./ReportReconciliation";
import ReportTourEngagement from "./ReportTourEngagement";
import ReportClearanceStatus from "./ReportClearanceStatus";
import MyTeam from "./MyTeam";
import { useEmploymentTypes } from "./useEmploymentTypes";
import Swal from "sweetalert2";
import { confirmAction, showNotice } from "./alerts";
import { CURRENCIES, LESOTHO_DISTRICTS, SOUTH_AFRICA_PROVINCES, TravelType, currentApprovalStepLabel, displayOrgGroupName, formatMoney, getCurrencySymbol, isAdvancePastApproval, isTravelTypeCode, stepDoneStatusLabel, travelTypeLabel } from "./constants";
import econetLogo from "./assets/econetLogo.webp";
import { HolidayCalendarButton } from "./HolidayCalendar";
import { roleLabel } from "./roles";
import {
  ArrowRightLeft,
  BarChart3,
  Bell,
  BriefcaseBusiness,
  Building2,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Clock3,
  DollarSign,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  Home,
  Hotel,
  Info,
  Lock,
  LogOut,
  Mail,
  MinusCircle,
  Monitor,
  Moon,
  PlusCircle,
  Network,
  Phone,
  Plane,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Star,
  Sun,
  Trash2,
  Upload,
  User,
  UserRoundCheck,
  Users,
  Landmark,
  Wallet,
  Wifi,
  X,
  Zap
} from "lucide-react";

type ClearanceTripRow = {
  trip_date: string;
  from_place: string;
  to_place: string;
  depart_time: string;
  arrive_time: string;
  km_travelled: number;
  petrol_allowance: number;
  breakfast: number;
  lunch: number;
  dinner: number;
  other_expenses: number;
  purpose: string;
  // UI-only: whether this row is in inline-edit mode (stripped before the
  // payload is sent — persistClearance maps explicit fields only).
  __editing?: boolean;
};

type TravelRow = {
  date: string;
  startDistrict: string;
  destinationDistrict: string;
  country: string;
  province: string;
  city: string;
  meals: number;
};

type HotelImportRow = {
  name: string;
  district: string;
  country: string;
  province: string;
  city: string;
  address: string;
  contact: string;
};

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && inQ && line[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') { inQ = !inQ; }
    else if (c === "," && !inQ) { result.push(cell); cell = ""; }
    else { cell += c; }
  }
  result.push(cell);
  return result;
}

function csvCell(v: string) { return `"${(v || "").replace(/"/g, '""')}"`; }

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

type RequestDirectoryUser = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  department: string | null;
  employment_type: string | null;
  role: string;
  profile_completed: boolean | null;
};

function emptyClearanceTripRow(date?: string): ClearanceTripRow {
  return {
    trip_date: date || new Date().toISOString().slice(0, 10),
    from_place: "",
    to_place: "",
    depart_time: "",
    arrive_time: "",
    km_travelled: 0,
    petrol_allowance: 0,
    breakfast: 0,
    lunch: 0,
    dinner: 0,
    other_expenses: 0,
    purpose: ""
  };
}

function dashboardDocTypeLabel(value: string | null | undefined) {
  switch (value) {
    case "ADVANCE": return "Advances";
    case "ACCOMMODATION": return "Travel Accommodation";
    case "CLAIM": return "Clearances";
    case "OVERTIME_REQUEST": return "Overtime Requests";
    case "OVERTIME_CLAIM": return "Overtime Claims";
    default: return value || "Requests";
  }
}

function dashboardDocTypeIcon(value: string | null | undefined) {
  switch (value) {
    case "ADVANCE": return Plane;
    case "ACCOMMODATION": return Hotel;
    case "CLAIM": return ShieldCheck;
    case "OVERTIME_REQUEST":
    case "OVERTIME_CLAIM": return Clock3;
    default: return FileText;
  }
}

function dashboardDocTypeAmount(item: any): number {
  return Number(item.requested_total ?? item.amount ?? item.total_amount ?? item.claim_total ?? 0);
}

function dashboardStatusLabel(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function dashboardStatusTone(value: string | null | undefined) {
  const status = String(value || "").toUpperCase();
  if (status.includes("REJECT") || status.includes("CANCEL")) return "status-pill-danger";
  if (status.includes("PAID") || status.includes("APPROVED") || status.includes("SETTLED") || status.includes("CLOSED")) return "status-pill-success";
  if (status.includes("DRAFT")) return "status-pill-neutral";
  return "status-pill-warning";
}

function dashboardInitials(value: string | null | undefined) {
  const parts = String(value || "User").trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] || "U") + (parts[1]?.[0] || "");
}

function isInCurrentMonth(value: unknown, now: Date): boolean {
  if (!value) return false;
  const date = new Date(String(value));
  return !Number.isNaN(date.getTime())
    && date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth();
}

const STARTUP_REQUEST_TIMEOUT_MS = 10000;

function withStartupTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`${label} timed out`)), STARTUP_REQUEST_TIMEOUT_MS);
  });

  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function SettingsAccordion(props: { title: string; subtitle?: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 20, marginBottom: 20 }}>
      <button
        type="button"
        onClick={props.onToggle}
        style={{
          all: "unset",
          width: "100%",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: 0
        }}
      >
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{props.title}</div>
          {props.subtitle ? <div style={{ color: "#6b7280", marginTop: 4 }}>{props.subtitle}</div> : null}
        </div>
        <div style={{ fontSize: 22, width: 28, textAlign: "center" }}>{props.open ? "−" : "+"}</div>
      </button>
      {props.open ? <div style={{ marginTop: 16 }}>{props.children}</div> : null}
    </div>
  );
}

// Type-to-filter user picker: shows the current selection as a chip (with a
// clear button) and, while empty, a search box whose matches appear in a
// dropdown below — same interaction as the step-assignment picker in
// WorkflowBuilder, just generalized to any list of candidate users.
function UserSearchSelect(props: {
  value: string;
  onChange: (userId: string) => void;
  users: Array<{ id: string; full_name: string | null; email: string; department?: string | null }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [query, setQueryText] = useState("");
  const [open, setOpen] = useState(false);
  const selected = props.users.find((u) => u.id === props.value);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? props.users.filter((u) => (u.full_name || u.email).toLowerCase().includes(q) || (u.department || "").toLowerCase().includes(q))
    : props.users;

  if (selected) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13 }}>
        <User size={13} style={{ color: "var(--muted, #6b7280)", flexShrink: 0 }} aria-hidden />
        <span style={{ flex: 1, fontWeight: 500 }}>{selected.full_name || selected.email}</span>
        {selected.department ? <span style={{ color: "var(--muted, #6b7280)", fontSize: 11 }}>{selected.department}</span> : null}
        {!props.disabled && (
          <button type="button" onClick={() => { props.onChange(""); setQueryText(""); }} className="ep-icon-btn" style={{ width: 22, height: 22 }} aria-label="Clear selection">
            <X size={13} aria-hidden />
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted, #9ca3af)", pointerEvents: "none" }} aria-hidden />
      <input
        type="text"
        value={query}
        onChange={(e) => setQueryText(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        placeholder={props.placeholder || `Search or browse ${props.users.length} users…`}
        className="ep-form-input"
        style={{ width: "100%", paddingLeft: 30, boxSizing: "border-box" }}
        disabled={props.disabled}
      />
      {open && filtered.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, zIndex: 50, maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
          {filtered.map((u) => (
            <div
              key={u.id}
              onMouseDown={(e) => { e.preventDefault(); props.onChange(u.id); setQueryText(""); setOpen(false); }}
              style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#eff6ff"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
            >
              <span>{u.full_name || u.email}</span>
              {u.department ? <span style={{ color: "var(--muted, #6b7280)", fontSize: 11 }}>{u.department}</span> : null}
            </div>
          ))}
        </div>
      )}
      {open && q && filtered.length === 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, zIndex: 50, padding: "8px 12px", fontSize: 13, color: "var(--muted, #6b7280)" }}>
          No matches
        </div>
      )}
    </div>
  );
}

// Request types a delegation can be scoped to. Kept to the types whose
// approval routing actually consults getDelegatedManagerIds() today - see
// backend-v2/src/lib/delegations.ts - so a checked box always does something.
const DELEGATION_REQUEST_TYPE_OPTIONS = [
  { value: "ADVANCE_REQUEST", label: "Advance Requests (Salary / Loan / Travel)" },
  { value: "CLEARANCE_REQUEST", label: "Travel Clearances" },
  { value: "CUSTOM_WORKFLOW", label: "Custom Processes (All Types)" },
  { value: "STANDBY_CLAIM", label: "Standby Claim Approvals" }
];

// Derives a delegation's real lifecycle state from its own from/to dates and
// `active` flag - there's no separate status column or scheduler driving
// this, so "Upcoming"/"Expiring Soon"/"Expired" are computed fresh on every
// render rather than stored.
function delegationDerivedStatus(d: { active: boolean; from_date: string | null; to_date: string | null }): "ENDED" | "EXPIRED" | "UPCOMING" | "EXPIRING" | "ACTIVE" {
  if (!d.active) return "ENDED";
  const todayMs = new Date(new Date().toDateString()).getTime();
  const from = d.from_date ? new Date(d.from_date).getTime() : null;
  const to = d.to_date ? new Date(d.to_date).getTime() : null;
  if (to !== null && to < todayMs) return "EXPIRED";
  if (from !== null && from > todayMs) return "UPCOMING";
  if (to !== null && (to - todayMs) / 86400000 <= 7) return "EXPIRING";
  return "ACTIVE";
}

// manager_delegations.from_date/to_date are SQL `date` columns - the pg
// driver hands these back as JS Date objects, which JSON.stringify renders
// as a full ISO timestamp ("2026-07-08T22:00:00.000Z"). Trim to just the
// calendar date for display.
function formatDateOnly(value: string | null | undefined): string {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

const DELEGATION_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active", UPCOMING: "Upcoming", EXPIRING: "Expiring Soon", EXPIRED: "Expired", ENDED: "Ended"
};
const DELEGATION_STATUS_CLASS: Record<string, string> = {
  ACTIVE: "status-pill-success", UPCOMING: "status-pill-info", EXPIRING: "status-pill-warning",
  EXPIRED: "status-pill-danger", ENDED: "status-pill-danger"
};

async function optionalStartupData<T>(promise: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await withStartupTimeout(promise, label);
  } catch (error) {
    console.warn(`${label} failed during startup`, error);
    return fallback;
  }
}

function isAuthOrTimeoutError(error: unknown) {
  const message = String((error as any)?.message || "").toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("invalid token") ||
    message.includes("unauthorized") ||
    message.includes("not authorized") ||
    message.includes("not authenticated") ||
    (error as any)?.status === 401
  );
}

type AppPage = "HOME" | "INBOX" | "CAPTURE" | "PAYMENTS" | "DEDUCTIONS" | "REFUNDABLE" | "ACCOMMODATION" | "PAYBACK_REVIEW" | "TREASURY_PROCESSING" | "REPORT_CLEARANCE_SUMMARY" | "REPORT_REFUNDS_DUE" | "REPORT_EMPLOYEE_PAYBACKS" | "REPORT_FULLY_CLEARED" | "REPORT_OUTSTANDING" | "REPORT_AGEING" | "REPORT_TREASURY_AUDIT" | "REPORT_DEPT_DIVISION" | "REPORT_OVERTIME" | "IT_PROVISIONING" | "ADVANCE" | "CLEARANCE" | "MY_ADVANCES" | "MY_CLEARANCES" | "MY_TEAM" | "REPORTS" | "SLA_REPORTS" | "REPORT_ADVANCES" | "REPORT_APPROVAL" | "REPORT_WORKFLOW" | "REPORT_AUDIT" | "REPORT_RECONCILIATION" | "REPORT_TOUR_ENGAGEMENT" | "REPORT_CLEARANCE_STATUS" | "SETTINGS" | "OVERTIME" | "STANDBY" | "CHANGE_REQUEST" | "EXCO" | "MANAGERS" | "EMPLOYEES" | "LEADERSHIP" | "WORKFLOW_BUILDER" | "REPORTING_LINES" | "USER_MANAGEMENT" | "ROLES_PERMISSIONS" | "MANAGER_DELEGATIONS" | "TRAVEL_SETUP" | "REQUEST_TYPES" | "CEO_MANAGEMENT" | "ORG_STRUCTURE" | "TEAM_ROSTER" | "PDF_DESIGNER" | "DATA_CLEANUP" | "VENDOR_CONTRACTS" | "SERVICE_CONTRACTS" | "BRS" | "BRS_ADMIN";

// Native <input type="month"> has no calendar UI in Firefox (just a plain text
// box expecting "YYYY-MM"), so the clearance form uses explicit Month/Year
// dropdowns instead, composing the same "YYYY-MM" string the backend expects.
const CLEARANCE_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function clearanceMonthYearRange(): number[] {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let y = current - 2; y <= current + 1; y++) years.push(y);
  return years;
}

function travelTypeCurrency(code: string | null | undefined, travelTypes: TravelType[]) {
  return travelTypes.find((type) => type.code === code)?.currency ?? "LSL";
}

type PaybackProofFormState = { amount_paid: string; payment_date: string; reference: string; comment: string; file: File | null };

function PaybackProofForm(props: {
  form: PaybackProofFormState;
  setForm: React.Dispatch<React.SetStateAction<PaybackProofFormState>>;
  onSubmit: () => void;
  submitting: boolean;
  submitLabel: string;
}) {
  const { form, setForm, onSubmit, submitting, submitLabel } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input className="ep-form-input" type="number" step="0.01" placeholder="Amount paid" value={form.amount_paid} onChange={(e) => setForm((f) => ({ ...f, amount_paid: e.target.value }))} />
      <input className="ep-form-input" type="date" placeholder="Payment date" value={form.payment_date} onChange={(e) => setForm((f) => ({ ...f, payment_date: e.target.value }))} />
      <input className="ep-form-input" placeholder="Transaction / receipt reference (optional)" value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} />
      <textarea className="ep-form-input" placeholder="Comment (optional)" value={form.comment} onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))} />
      <label className="clearance-upload-button" style={{ alignSelf: "flex-start" }}>
        <Upload size={15} aria-hidden /> {form.file ? form.file.name : "Attach Proof (receipt / deposit slip / bank confirmation)"}
        <input type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: "none" }} onChange={(e) => setForm((f) => ({ ...f, file: e.currentTarget.files?.[0] || null }))} />
      </label>
      <button className="button small-button" type="button" disabled={submitting} onClick={onSubmit} style={{ alignSelf: "flex-start" }}>
        {submitting ? "Submitting…" : submitLabel}
      </button>
    </div>
  );
}

export default function App() {
  const empTypes = useEmploymentTypes();
  const [token, setTok] = useState(getToken());
  const justLoggedIn = useRef(false);
  const knownInboxCount = useRef(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [profile, setProfile] = useState<any>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileFirstName, setProfileFirstName] = useState("");
  const [profileLastName, setProfileLastName] = useState("");
  const [profileDepartment, setProfileDepartment] = useState("");
  const [profileOrgSelection, setProfileOrgSelection] = useState<OrgSelection>({ divisionId: null, divisionName: null, department: null, departmentId: null, sectionId: null, sectionName: null, teamId: null, teamName: null });
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);
  const [profileEmploymentType, setProfileEmploymentType] = useState("PERMANENT");
  const [profileEmployeeNo, setProfileEmployeeNo] = useState("");
  const [requestDirectory, setRequestDirectory] = useState<RequestDirectoryUser[]>([]);
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminUsersLoading, setAdminUsersLoading] = useState(false);
  const [hotels, setHotels] = useState<any[]>([]);
  const [myPaPrincipals, setMyPaPrincipals] = useState<any[]>([]);
  const [hotelsTotal, setHotelsTotal] = useState(0);
  const [hotelSearch, setHotelSearch] = useState("");
  const [hotelPage, setHotelPage] = useState(0);
  const hotelSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const HOTELS_PAGE_SIZE = 25;
  const [standbyToday, setStandbyToday] = useState<any[]>([]);
  const [hotelsLoading, setHotelsLoading] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [newHotelDistrict, setNewHotelDistrict] = useState("");
  const [newHotelCountry, setNewHotelCountry] = useState("");
  const [newHotelProvince, setNewHotelProvince] = useState("");
  const [newHotelCity, setNewHotelCity] = useState("");
  const [newHotelAddress, setNewHotelAddress] = useState("");
  const [newHotelContact, setNewHotelContact] = useState("");
  const [showImportHotelsModal, setShowImportHotelsModal] = useState(false);
  const [importHotelRows, setImportHotelRows] = useState<HotelImportRow[] | null>(null);
  const [importHotelProcessing, setImportHotelProcessing] = useState(false);
  const [importHotelResult, setImportHotelResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);
  const hotelFileInputRef = useRef<HTMLInputElement>(null);
  const [hasActiveCustomRequestTypes, setHasActiveCustomRequestTypes] = useState(false);
  const [hasActiveBrsTypes, setHasActiveBrsTypes] = useState(false);
  const [overtimeModuleEnabled, setOvertimeModuleEnabled] = useState(true);
  const [standbyModuleEnabled, setStandbyModuleEnabled] = useState(true);
  const [salaryAdvanceEnabled, setSalaryAdvanceEnabled] = useState(true);
  const [loanAdvanceEnabled, setLoanAdvanceEnabled] = useState(true);
  const [salaryAdvanceMaxMonths, setSalaryAdvanceMaxMonths] = useState(6);
  const [loanAdvanceMaxMonths, setLoanAdvanceMaxMonths] = useState(6);
  const [hasDeductionsAccess, setHasDeductionsAccess] = useState(false);
  const [deductionsCount, setDeductionsCount] = useState(0);
  const [hasRefundableAccess, setHasRefundableAccess] = useState(false);
  const [refundableCount, setRefundableCount] = useState(0);
  const [hasTreasuryAccess, setHasTreasuryAccess] = useState(false);
  const [treasuryCount, setTreasuryCount] = useState(0);
  const [hasOvertimeFinanceAccess, setHasOvertimeFinanceAccess] = useState(false);
  const [hasItProvisioningAccess, setHasItProvisioningAccess] = useState(false);
  const [itProvisioningCount, setItProvisioningCount] = useState(0);
  const [hasPaymentsAccess, setHasPaymentsAccess] = useState(false);
  const [hasVendorContractsAccess, setHasVendorContractsAccess] = useState(false);
  const [hasServiceContractsAccess, setHasServiceContractsAccess] = useState(false);
  const [favoritePages, setFavoritePages] = useState<string[]>([]);
  const [financeMenuOpen, setFinanceMenuOpen] = useState(false);
  const [contractsMenuOpen, setContractsMenuOpen] = useState(false);
  const [shortcutPickerOpen, setShortcutPickerOpen] = useState(false);
  const favoritePagesInitialized = useRef(false);
  const shortcutPickerRef = useRef<HTMLDivElement>(null);
  const [travelTypes, setTravelTypes] = useState<TravelType[]>([]);
  const [travelTypesLoading, setTravelTypesLoading] = useState(false);
  const [newTravelTypeName, setNewTravelTypeName] = useState("");
  const [newTravelTypeLocationMode, setNewTravelTypeLocationMode] = useState<"DISTRICT" | "COUNTRY_CITY">("COUNTRY_CITY");
  const [newTravelTypeRateKind, setNewTravelTypeRateKind] = useState<"MEAL" | "DAILY">("DAILY");
  const [newTravelTypeGeneralRate, setNewTravelTypeGeneralRate] = useState("0");
  const [newTravelTypeExcoRate, setNewTravelTypeExcoRate] = useState("0");
  const [newTravelTypeCeoRate, setNewTravelTypeCeoRate] = useState("0");
  const [newTravelTypeCurrency, setNewTravelTypeCurrency] = useState("LSL");
  const [newTravelTypeRequiresAccommodation, setNewTravelTypeRequiresAccommodation] = useState(false);
  const [newTravelTypeAllowedPaymentMethods, setNewTravelTypeAllowedPaymentMethods] = useState<("ECOCASH" | "BANK")[]>(["ECOCASH", "BANK"]);
  const [newTravelTypeAllowExternalBeneficiary, setNewTravelTypeAllowExternalBeneficiary] = useState(false);
  const [editingTravelType, setEditingTravelType] = useState<TravelType | null>(null);
  const [showAddTravelTypeModal, setShowAddTravelTypeModal] = useState(false);
  const [showAddHotelModal, setShowAddHotelModal] = useState(false);
  const [editingHotel, setEditingHotel] = useState<any | null>(null);
  const [savingHotel, setSavingHotel] = useState(false);
  const [newTravelLocationTypeId, setNewTravelLocationTypeId] = useState("");
  const [newTravelLocationDistrict, setNewTravelLocationDistrict] = useState("");
  const [newTravelLocationCountry, setNewTravelLocationCountry] = useState("");
  const [newTravelLocationProvince, setNewTravelLocationProvince] = useState("");
  const [newTravelLocationCity, setNewTravelLocationCity] = useState("");
  const [mealValue, setMealValue] = useState(0);
  const [mealValueDraft, setMealValueDraft] = useState("0");
  const [mealValueLoading, setMealValueLoading] = useState(false);
  const [newDepartmentName, setNewDepartmentName] = useState("");
  const [newDepartmentSectionId, setNewDepartmentSectionId] = useState("");
  const [newDepartmentHodId, setNewDepartmentHodId] = useState("");
  const [newDepartmentManagerId, setNewDepartmentManagerId] = useState("");
  const [newDepartmentExcoId, setNewDepartmentExcoId] = useState("");
  const [newDepartmentActive, setNewDepartmentActive] = useState(true);
  const [departmentRows, setDepartmentRows] = useState<any[]>([]);
  const [sectionOptions, setSectionOptions] = useState<any[]>([]);
  const [newSectionName, setNewSectionName] = useState("");
  const [newSectionExcoId, setNewSectionExcoId] = useState("");
  const [leadershipUsers, setLeadershipUsers] = useState<{ hods: any[]; managers: any[]; exco: any[] }>({ hods: [], managers: [], exco: [] });
  const [profileAccordionOpen, setProfileAccordionOpen] = useState(true);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [savingPhone, setSavingPhone] = useState(false);
  const [displayAccordionOpen, setDisplayAccordionOpen] = useState(true);
  const [travelSettingsOpen, setTravelSettingsOpen] = useState(true);
  const [sectionManagementOpen, setSectionManagementOpen] = useState(true);
  const [adminUsersOpen, setAdminUsersOpen] = useState(false);
  const [recoverySettingsOpen, setRecoverySettingsOpen] = useState(false);
  const [recoveryDurationDraft, setRecoveryDurationDraft] = useState("7");
  const [recoveryMonthsDraft, setRecoveryMonthsDraft] = useState("3");
  const [recoverySettingsLoading, setRecoverySettingsLoading] = useState(false);
  const [recoverySettingsSaving, setRecoverySettingsSaving] = useState(false);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [idleTimeoutDraft, setIdleTimeoutDraft] = useState("30");
  const [warningSecondsDraft, setWarningSecondsDraft] = useState("60");
  const [sessionSettingsLoading, setSessionSettingsLoading] = useState(false);
  const [sessionSettingsSaving, setSessionSettingsSaving] = useState(false);
  // The values actually enforced by the idle-logout timer, as opposed to the
  // admin settings form's own draft state above - fetched once per session
  // and updated immediately if the admin saves new values.
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(30);
  const [warningSeconds, setWarningSeconds] = useState(60);
  const [showIdleWarning, setShowIdleWarning] = useState(false);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState(0);
  const lastActivityRef = useRef(Date.now());
  const [orgNavOpen, setOrgNavOpen] = useState(false);
  const [featurePermissions, setFeaturePermissions] = useState<Record<string, string[]>>({});
  const [featurePermOpen, setFeaturePermOpen] = useState(false);
  const [featurePermDraft, setFeaturePermDraft] = useState<Record<string, string[]>>({});
  const [permissionGroups, setPermissionGroups] = useState<{ name: string; member_count: string; dynamic?: boolean; hidden?: boolean }[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  // "+Add Group" defaults to picking an existing Division/Department/Section/
  // Team by name (these already exist as live, auto-membership columns - see
  // listOrgStructureGroups on the backend - so "adding" one really means
  // revealing its already-hidden column) rather than free-typing a name that
  // could typo-mismatch the real org unit and silently grant nobody access.
  // "Custom" is the escape hatch for a genuinely new hand-picked cohort.
  const [addGroupType, setAddGroupType] = useState<"Division" | "Department" | "Section" | "Team" | "Custom">("Division");
  const [selectedOrgGroupName, setSelectedOrgGroupName] = useState("");
  // addGroupType's raw values ("Division"/"Department"/"Section"/"Team") match the
  // legacy table names and must stay as-is for filtering permissionGroups by their
  // stored raw prefix (see orgGroupPool below) — this map only controls what's shown.
  const ADD_GROUP_TYPE_LABELS: Record<typeof addGroupType, string> = {
    Division: "Company",
    Department: "Division",
    Section: "Department",
    Team: "Section",
    Custom: "Custom group",
  };
  const [manageColumnsOpen, setManageColumnsOpen] = useState(false);
  const [groupSaving, setGroupSaving] = useState(false);
  const [expandedGroupName, setExpandedGroupName] = useState<string | null>(null);
  const [groupMembers, setGroupMembers] = useState<{ id: string; full_name: string | null; email: string }[]>([]);
  const [groupMembersLoading, setGroupMembersLoading] = useState(false);
  const [memberDirectory, setMemberDirectory] = useState<RequestDirectoryUser[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberSaving, setMemberSaving] = useState(false);
  const [featurePermSaving, setFeaturePermSaving] = useState(false);
  const [featureAccessSearch, setFeatureAccessSearch] = useState("");
  const [featureAccessModuleFilter, setFeatureAccessModuleFilter] = useState("ALL");
  const [featureAccessSelectedKey, setFeatureAccessSelectedKey] = useState<string | null>(null);
  // Groups (roles + every Division/Department/Section/Team) render as
  // columns, and that list only grows over time - paginate it the same way
  // the rest of the app paginates long row lists, just on the column axis.
  const [featureAccessGroupsPage, setFeatureAccessGroupsPage] = useState(1);
  const [featureAccessGroupsPageSize, setFeatureAccessGroupsPageSize] = useState(8);
  const [delegations, setDelegations] = useState<any[]>([]);
  const [delegationsLoading, setDelegationsLoading] = useState(false);
  // Whether the current (non-ADMIN) user is assigned to any active workflow
  // step with "Allow Delegation" on — gates self-service delegation visibility.
  const [delegationEligible, setDelegationEligible] = useState(false);
  const [orgAssignModal, setOrgAssignModal] = useState<{ userId: string; userName: string } | null>(null);
  const [orgAssignSelection, setOrgAssignSelection] = useState<OrgSelection>({ divisionId: null, divisionName: null, department: null, departmentId: null, sectionId: null, sectionName: null, teamId: null, teamName: null });
  const [orgAssignSaving, setOrgAssignSaving] = useState(false);
  const [userDivisionFilter, setUserDivisionFilter] = useState<string>("");
  const [delegationManagerId, setDelegationManagerId] = useState("");
  const [delegationDelegateId, setDelegationDelegateId] = useState("");
  const [delegationFromDate, setDelegationFromDate] = useState("");
  const [delegationToDate, setDelegationToDate] = useState("");
  const [delegationReason, setDelegationReason] = useState("");
  const [delegationComments, setDelegationComments] = useState("");
  // Empty = applies to all request types (the original, unscoped behavior).
  const [delegationRequestTypes, setDelegationRequestTypes] = useState<string[]>([]);
  const [showCreateDelegationModal, setShowCreateDelegationModal] = useState(false);
  const [delegationDetailId, setDelegationDetailId] = useState<string>("");
  const [delegationSearch, setDelegationSearch] = useState("");
  const [delegationStatusFilter, setDelegationStatusFilter] = useState("");
  const [delegationDeptFilter, setDelegationDeptFilter] = useState("");
  const [delegationAudit, setDelegationAudit] = useState<any[]>([]);
  const [delegationAuditLoading, setDelegationAuditLoading] = useState(false);
  const [paAssignmentsList, setPaAssignmentsList] = useState<any[]>([]);
  const [paAssignmentsLoading, setPaAssignmentsLoading] = useState(false);
  const [newPaUserId, setNewPaUserId] = useState("");
  const [newPaPrincipalUserId, setNewPaPrincipalUserId] = useState("");
  const [customRequestTypeOptions, setCustomRequestTypeOptions] = useState<Array<{ code: string; name: string }>>([]);
  const [advances, setAdvances] = useState<any[]>([]);
  const [claims, setClaims] = useState<any[]>([]);
  // Org-wide (not "mine=true") datasets for the Advance Requests / Approval
  // Performance reports only - kept separate from `advances`/`claims` above,
  // which are always the signed-in user's own requests and back My
  // Advances/My Clearances. Silently empty for anyone without the
  // report_advances feature permission (the fetch 403s, same as payments).
  const [reportAdvances, setReportAdvances] = useState<any[]>([]);
  const [reportClaims, setReportClaims] = useState<any[]>([]);
  const [dashboardSearch, setDashboardSearch] = useState("");
  const [dashboardSearchLive, setDashboardSearchLive] = useState<{ advances: any[]; claims: any[] }>({ advances: [], claims: [] });
  const [dashboardSearchLoading, setDashboardSearchLoading] = useState(false);
  const [dashboardSearchSyncedAt, setDashboardSearchSyncedAt] = useState<Date | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const [inboxItems, setInboxItems] = useState<any[]>([]);
  const [captureCount, setCaptureCount] = useState(0);
  const [paymentsCount, setPaymentsCount] = useState(0);
  const [page, setRawPage] = useState<AppPage>("HOME");
  // Set when the Inbox hands off an Overtime/Standby item to that module's
  // own detail screen (see Inbox.tsx's onNavigateToModule) — consumed once by
  // Overtime/Standby on mount, then cleared so re-visiting the page later
  // doesn't keep re-opening the same item.
  const [moduleDeepLink, setModuleDeepLink] = useState<{ kind: "REQUEST" | "CLAIM"; id: string } | null>(null);

  // The app is a single-page client that switches "pages" via state only, with
  // no URL changes. Without pushing history entries, the browser back button
  // has nothing of ours to go back to and navigates the user out of the app
  // entirely. Push a history entry on every navigation, and on back/forward
  // restore the previous in-app page instead of leaving the SPA.
  const setPage = useCallback((next: AppPage) => {
    setRawPage((current) => {
      if (current !== next) {
        window.history.pushState({ appPage: next }, "");
      }
      return next;
    });
  }, []);

  useEffect(() => {
    window.history.replaceState({ appPage: "HOME" }, "");
    const onPopState = (event: PopStateEvent) => {
      const next = (event.state && event.state.appPage) as AppPage | undefined;
      setRawPage(next || "HOME");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const [theme, setTheme] = useState<"light" | "dark">((getTheme() as "light" | "dark") || "light");
  const [uiScale, setUiScale] = useState<number>(getUiScale);
  const [submittingAdvance, setSubmittingAdvance] = useState(false);
  const [editingAdvanceId, setEditingAdvanceId] = useState<string | null>(null);
  const [editingAdvanceStatus, setEditingAdvanceStatus] = useState<string | null>(null);
  const [editingClaimId, setEditingClaimId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [editingDepartmentObj, setEditingDepartmentObj] = useState<null | {
    originalName: string;
    name: string;
    section_id?: string | null;
    manager_user_id?: string | null;
    hod_user_id?: string | null;
    exco_user_id?: string | null;
    active?: boolean;
  }>(null);
  const [editingSectionObj, setEditingSectionObj] = useState<null | { id: string; name: string; exco_user_id?: string | null }>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [remindingAdvanceId, setRemindingAdvanceId] = useState<string | null>(null);
  const [historyAdvanceId, setHistoryAdvanceId] = useState<string | null>(null);
  const [historyAdvanceDetail, setHistoryAdvanceDetail] = useState<any | null>(null);
  const [historyEvents, setHistoryEvents] = useState<any[]>([]);
  const [clearanceTrackOpen, setClearanceTrackOpen] = useState(false);
  const [clearanceTrackLoading, setClearanceTrackLoading] = useState(false);
  const [clearanceTrackId, setClearanceTrackId] = useState<string | null>(null);
  const [clearanceTrackDetail, setClearanceTrackDetail] = useState<any | null>(null);
  const [paybackProofForm, setPaybackProofForm] = useState<{ amount_paid: string; payment_date: string; reference: string; comment: string; file: File | null }>({ amount_paid: "", payment_date: "", reference: "", comment: "", file: null });
  const [paybackProofSubmitting, setPaybackProofSubmitting] = useState(false);
  const [aiAnomalies, setAiAnomalies] = useState<any | null>(null);
  const [nlPrompt, setNlPrompt] = useState("show rejected salary advances this month by department");
  const [nlReport, setNlReport] = useState<any | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [ocrResult, setOcrResult] = useState<any | null>(null);

  function normalizeDateInputValue(value: any) {
    if (!value) return "";
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const t = s.indexOf("T");
    if (t > 0) return s.slice(0, t);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return "";
  }

  function fmtMoney(value: any, currency?: string | null) {
    return formatMoney(value, currency ?? "LSL");
  }

  function displayRoleLabel(value: string | null | undefined) {
    return value ? roleLabel(value) : "Unknown";
  }

  function displayUserLabel(value: string | null | undefined, roleValue: string | null | undefined) {
    if (!value) return "User";
    return value;
  }

  function fmtEmploymentType(value: string | null | undefined) {
    return empTypes.find(t => t.code === value)?.name ?? value ?? "Unknown";
  }

  function isApproverRole(value: string | null | undefined) {
    return ["HOD", "MANAGER", "FINANCE", "ADMIN", "EXCO", "CEO"].includes(String(value || "").trim().toUpperCase());
  }

  function formatPersonLabel(user: { full_name: string | null; email?: string; employee_no?: string | null }) {
    const base = user.full_name || user.email || "Unknown user";
    return user.employee_no ? `${base} (${user.employee_no})` : base;
  }

  function leadershipStatus(department: any) {
    if (!department.hod_user_id) return "No HOD assigned to this department.";
    if (!department.manager_user_id) return "No manager assigned to this department.";
    if (!department.exco_user_id) return "No EXCO member assigned to this department.";
    return "Ready";
  }

  function leadershipSelect(options: any[], value: string | null | undefined, emptyLabel: string, onChange: (value: string) => void) {
    return (
      <select value={value || ""} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 190 }}>
        <option value="">{emptyLabel}</option>
        {options.map((user) => (
          <option key={user.id} value={user.id}>
            {formatPersonLabel(user)}
          </option>
        ))}
      </select>
    );
  }

  function statusPill(active: boolean) {
    return (
      <span className={`status-pill ${active ? "status-pill-success" : "status-pill-warning"}`}>
        {active ? "Active" : "Inactive"}
      </span>
    );
  }

  function renderDepartmentOrgRow(department: any, nested = false) {
    return (
      <tr key={department.id || department.name}>
        <td>
          <div style={{ paddingLeft: nested ? 22 : 0, display: "grid", gap: 4 }}>
            <strong>{department.name}</strong>
            <small style={{ color: leadershipStatus(department) === "Ready" ? "#16a34a" : "#b45309" }}>
              {leadershipStatus(department)}
            </small>
          </div>
        </td>
        <td><span className="status-pill status-pill-success">Division</span></td>
        <td>
          {leadershipSelect(leadershipUsers.hods.length ? leadershipUsers.hods : leadershipUsers.managers, department.hod_user_id, "No HOD", (value) =>
            void updateDepartmentLeadership(department, { hod_user_id: value || null })
          )}
        </td>
        <td>
          {leadershipSelect(leadershipUsers.managers, department.manager_user_id, "No manager", (value) =>
            void updateDepartmentLeadership(department, { manager_user_id: value || null })
          )}
        </td>
        <td>
          {leadershipSelect(leadershipUsers.exco, department.exco_user_id, "No EXCO member", (value) =>
            void updateDepartmentLeadership(department, { exco_user_id: value || null })
          )}
        </td>
        <td>
          <button className="icon-button" onClick={() => void editDepartment(department.name)} title="Edit division" aria-label="Edit division" style={{ marginRight: 8 }}>
            <Edit3 size={16} aria-hidden />
          </button>
          <button className="icon-button danger" onClick={() => void deleteDepartment(department.name)} title="Delete division" aria-label="Delete division">
            <Trash2 size={16} aria-hidden />
          </button>
        </td>
      </tr>
    );
  }

  function updateDepartmentRow(name: string, changes: Record<string, unknown>) {
    setDepartmentRows((current) => current.map((department) => (
      department.name === name ? { ...department, ...changes } : department
    )));
  }

  function initials(value: string | null | undefined) {
    return String(value || "User")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "U";
  }

  function isKnownDepartment(value: string) {
    const department = value.trim().toLowerCase();
    return Boolean(department) && departmentOptions.some((option) => option.trim().toLowerCase() === department);
  }

  // advance request approval chain (resolved from workflow)
  const [advanceApprovalChain, setAdvanceApprovalChain] = useState<Array<{ label: string; name: string | null }>>([]);
  const [advanceWorkflowFound, setAdvanceWorkflowFound] = useState<boolean | null>(null);
  // custom chain built by user when no workflow exists for their dept/section
  const [customApprovalChain, setCustomApprovalChain] = useState<Array<{ label: string; user_id: string; user_name: string }>>([]);
  const [customChainLabel, setCustomChainLabel] = useState("");
  const [customChainUserId, setCustomChainUserId] = useState("");
  const [chainPositionSearches, setChainPositionSearches] = useState<Record<string, string>>({});
  const [chainPositionTypes, setChainPositionTypes] = useState<Array<{ id: string; name: string; code: string }>>([]);
  // "invite by email" affordance on the custom approval chain picker, for
  // naming someone who's never logged into FlowDesk yet — keyed by position
  // label (there are only ever two: Counter Signed By / Approved By).
  const [inviteEmailByLabel, setInviteEmailByLabel] = useState<Record<string, string>>({});
  const [inviteRoleByLabel, setInviteRoleByLabel] = useState<Record<string, "MANAGER" | "HOD" | "EXCO">>({});
  const [invitingLabel, setInvitingLabel] = useState<string | null>(null);
  const [inviteErrorByLabel, setInviteErrorByLabel] = useState<Record<string, string>>({});
  const { staff: staffDirectory } = useStaffDirectory();

  // advance request form fields
  const [requesterName, setRequesterName] = useState("");
  const [empNumber, setEmpNumber] = useState("");
  const [requestForUserId, setRequestForUserId] = useState("");
  const [supportCreatorUserId, setSupportCreatorUserId] = useState("");
  const [advanceType, setAdvanceType] = useState<string | null>(null);
  const [monthField, setMonthField] = useState("");
  const [salaryPaybackDuration, setSalaryPaybackDuration] = useState("");
  const [salaryAmount, setSalaryAmount] = useState("0");
  const [loanPaybackDuration, setLoanPaybackDuration] = useState("");
  const [loanAmount, setLoanAmount] = useState("");
  // "Apply for Other" - an advance for an external, non-Econet beneficiary.
  // The requester still receives the funds themselves (same Receive Via
  // fields as any advance) - this is just who the money is actually for.
  const [isApplyForOther, setIsApplyForOther] = useState(false);
  // Apply for Other skips the day-by-day travel table entirely - just the
  // external person's particulars, purpose, and a manually-entered amount.
  const [otherAmount, setOtherAmount] = useState("");
  const [otherStartDate, setOtherStartDate] = useState("");
  const [otherFinishDate, setOtherFinishDate] = useState("");
  const [externalPayees, setExternalPayees] = useState<any[]>([]);
  const [externalBeneficiaryId, setExternalBeneficiaryId] = useState("");
  const [showNewExternalPayeeForm, setShowNewExternalPayeeForm] = useState(false);
  const [newPayeeName, setNewPayeeName] = useState("");
  const [newPayeeCategory, setNewPayeeCategory] = useState("");
  const [newPayeeOrg, setNewPayeeOrg] = useState("");
  const [newPayeeContact, setNewPayeeContact] = useState("");
  const [savingNewPayee, setSavingNewPayee] = useState(false);
  const [extraCostAmount, setExtraCostAmount] = useState("");
  const [extraCostDescription, setExtraCostDescription] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"ECOCASH" | "BANK">("ECOCASH");
  const [ecocashNumber, setEcocashNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankBranch, setBankBranch] = useState("");
  const [purpose, setPurpose] = useState("");
  const advanceTypeFieldRef = useRef<HTMLDivElement>(null);
  const paymentMethodFieldRef = useRef<HTMLDivElement>(null);
  const purposeFieldRef = useRef<HTMLDivElement>(null);
  const advanceSubmitButtonRef = useRef<HTMLButtonElement>(null);
  const [requestDate, setRequestDate] = useState(new Date().toISOString().slice(0, 10));
  const districts = LESOTHO_DISTRICTS;
  const [rows, setRows] = useState<TravelRow[]>([]);
  // Requester's preferred hotel per destination district, keyed by district name.
  // Only the hotel choice is captured here — HR sets amount/dates/notes during review.
  const [accommodationHotelChoices, setAccommodationHotelChoices] = useState<Record<string, string>>({});
  const [amountInWords, setAmountInWords] = useState("");
  const [clearanceMonth, setClearanceMonth] = useState("");
  const [clearanceDutyStation, setClearanceDutyStation] = useState("");
  const [clearanceProjectNumber, setClearanceProjectNumber] = useState("");
  const [clearanceVehicleReg, setClearanceVehicleReg] = useState("");
  const [clearanceVehicleType, setClearanceVehicleType] = useState("");
  const [clearanceEngineCc, setClearanceEngineCc] = useState("");
  const [clearanceVehicleRate, setClearanceVehicleRate] = useState("");
  const [clearanceLinkedAdvanceId, setClearanceLinkedAdvanceId] = useState("");
  const [clearanceTrips, setClearanceTrips] = useState<ClearanceTripRow[]>([emptyClearanceTripRow()]);
  const [clearanceReceipts, setClearanceReceipts] = useState<any[]>([]);
  const [clearanceSourceLines, setClearanceSourceLines] = useState<any[]>([]);
  const [clearanceReasonForOverspend, setClearanceReasonForOverspend] = useState("");
  const [clearanceExtraCostAmount, setClearanceExtraCostAmount] = useState("");
  const [clearanceExtraCostDescription, setClearanceExtraCostDescription] = useState("");

  function emptyTravelRow(date?: string, startDistrict = ""): TravelRow {
    return {
      date: date || new Date().toISOString().slice(0, 10),
      startDistrict,
      destinationDistrict: "",
      country: "",
      province: "",
      city: "",
      meals: 0
    };
  }

  function syncTravelRowStartDistricts(nextRows: TravelRow[]) {
    return nextRows.map((row, index, allRows) => (
      index === 0 ? row : { ...row, startDistrict: allRows[index - 1].destinationDistrict || "" }
    ));
  }

  const addRow = () => {
    let newDate = new Date().toISOString().split('T')[0];
    let startDistrict = "";
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const lastDate = new Date(lastRow.date);
      lastDate.setDate(lastDate.getDate() + 1);
      newDate = lastDate.toISOString().split('T')[0];
      startDistrict = lastRow.destinationDistrict || "";
    }
    setRows(syncTravelRowStartDistricts([...rows, emptyTravelRow(newDate, startDistrict)]));
  };
  const deleteRow = (index: number) => {
    setRows(syncTravelRowStartDistricts(rows.filter((_, i) => i !== index)));
  };
  const updateRow = (index: number, field: string, value: any) => {
    // Each row is one day of the trip, in order - row 0 is the departure day,
    // the last row is the return day (see pdfFieldCatalog.ts's departure/
    // return date fields, which are just this list's earliest/latest date).
    // Reject an edit that would put this day's date out of order relative
    // to its neighbors, rather than silently accepting a return date earlier
    // than the departure date.
    if (field === "date") {
      const prevRowDate = index > 0 ? rows[index - 1].date : null;
      const nextRowDate = index < rows.length - 1 ? rows[index + 1].date : null;
      if (prevRowDate && value < prevRowDate) {
        alert("This date can't be earlier than the previous day's date.");
        return;
      }
      if (nextRowDate && value > nextRowDate) {
        alert("This date can't be later than the next day's date.");
        return;
      }
    }
    const copy = [...rows];
    if (field === "meals") {
      const meals = Number(value) || 0;
      // Day 1 (breakfast/lunch/dinner) allows up to 3 meals; subsequent days
      // exclude breakfast (assumed eaten before departure that day), so 2.
      // DAILY-rate rows hold a day count instead, capped at 180 (matches the
      // server-side LinesSchema max).
      const maxMeals = selectedTravelType?.rate_kind === "DAILY" ? 180 : (index === 0 ? 3 : 2);
      (copy[index] as any).meals = Math.min(Math.max(meals, 0), maxMeals);
    } else {
      (copy[index] as any)[field] = value;
    }
    if (field === "country" && String(value).toLowerCase() !== "south africa") {
      copy[index].province = "";
    }
    setRows(syncTravelRowStartDistricts(copy));
  };
  const mealValueNumber = Number.isFinite(Number(mealValue)) ? Number(mealValue) : 0;
  const selectedTravelType = travelTypes.find((type) => type.code === advanceType && type.active !== false) || null;
  // The advance is billed at the traveller's own rate (whoever it's
  // actually for, not necessarily the person filling in the form on their
  // behalf) — EXCO/CEO have their own configured rates precisely so this
  // doesn't silently fall back to the general-staff rate for them.
  const travellerRole =
    requestDirectory.find((user) => user.id === requestForUserId)?.role ||
    myPaPrincipals.find((user) => user.id === requestForUserId)?.role ||
    (!requestForUserId || requestForUserId === profile?.id ? profile?.role : undefined) ||
    "UNKNOWN";
  const selectedTravelRate = selectedTravelType
    ? Number(
        (travellerRole === "CEO" ? selectedTravelType.rate_ceo : travellerRole === "EXCO" ? selectedTravelType.rate_exco : selectedTravelType.rate_general_staff) || 0
      )
    : 0;
  const selectedTravelUnitLabel = selectedTravelType?.rate_kind === "DAILY" ? "day" : "meal";
  const selectedTravelLocations = selectedTravelType?.locations || [];
  const selectedTravelDistricts = selectedTravelLocations
    .map((location) => String(location.district || "").trim())
    .filter(Boolean);
  const districtOptions = selectedTravelDistricts.length ? Array.from(new Set(selectedTravelDistricts)) : [...districts];
  const selectedTravelCountries = Array.from(
    new Set(selectedTravelLocations.map((location) => String(location.country || "").trim()).filter(Boolean))
  );
  const isSelectedCountrySouthAfrica = rows.some((row) => row.country.trim().toLowerCase() === "south africa");
  const travelTypeOptions = travelTypes.filter((type) => type.active !== false);
  // Admin opts specific travel types in (Travel Setup's "Allow Apply for
  // Other" checkbox) - Salary/Loan are never offered for an external
  // beneficiary at all.
  const applyForOtherTypeOptions = travelTypeOptions.filter((type) => type.allow_external_beneficiary);
  const isTravelAdvanceSelected = Boolean(selectedTravelType);
  // Apply for Other never uses the day-by-day travel table/per-diem
  // calculation, even if a real travel type happens to be selected - just
  // the external beneficiary, purpose, and a manually-entered amount.
  const showTravelBreakdown = isTravelAdvanceSelected && !isApplyForOther;
  const allowedPaymentMethods: ("ECOCASH" | "BANK")[] = selectedTravelType?.allowed_payment_methods?.length
    ? selectedTravelType.allowed_payment_methods
    : ["ECOCASH", "BANK"];
  const rowTotals = rows.reduce(
    (acc, r) => {
      let meals = Number.isFinite(Number(r.meals)) ? Math.max(0, Number(r.meals)) : 0;
      // For daily-rate requests, a row with no meals should count as 1 day
      if (selectedTravelType?.rate_kind === "DAILY" && meals === 0) meals = 1;
      return {
        meals: acc.meals + meals,
        amount: acc.amount + meals * selectedTravelRate
      };
    },
    { meals: 0, amount: 0 }
  );
  const extraCost = showTravelBreakdown ? (Number(extraCostAmount) || 0) : 0;
  const totalRequested = () => {
    if (isApplyForOther) return Number(otherAmount) || 0;
    if (showTravelBreakdown) return rowTotals.amount + extraCost;
    if (advanceType === "SALARY") return Number(salaryAmount) || 0;
    if (advanceType === "LOAN") return Number(loanAmount) || 0;
    return 0;
  };
  const clearableTravelAdvances = advances.filter(
    (a) => isTravelTypeCode(a.type, travelTypes) && a.status === "PAID"
  );
  // Advances that already have an active (non-rejected) clearance claim can't
  // start a second one — excludes the claim currently being edited so its own
  // linked advance still shows up (and stays selected) while resuming a draft.
  const claimedAdvanceIds = new Set(
    claims
      .filter((c: any) => c.status !== "REJECTED" && c.linked_advance_id && c.id !== editingClaimId)
      .map((c: any) => c.linked_advance_id)
  );
  const newClearanceAdvanceOptions = clearableTravelAdvances.filter((a) => !claimedAdvanceIds.has(a.id));
  const selectedClearanceAdvance = clearableTravelAdvances.find((a) => a.id === clearanceLinkedAdvanceId) || null;
  const clearanceAdvanceAmount = Number(selectedClearanceAdvance?.approved_total || 0);
  // Actual expenditure is captured per trip line by the employee (Meals /
  // Transport / Other) so it can exceed the advance — the variance against the
  // advance drives the overspend / underspend settlement below.
  const clearanceExtraCost = Number(clearanceExtraCostAmount) || 0;
  const clearanceTotals = clearanceTrips.reduce(
    (acc, trip) => {
      const meals = Number(trip.lunch) || 0;
      const transport = Number(trip.petrol_allowance) || 0;
      const other = Number(trip.other_expenses) || 0;
      acc.meals += meals;
      acc.transport += transport;
      acc.other += other;
      acc.total += meals + transport + other;
      return acc;
    },
    { meals: 0, transport: 0, other: 0, total: clearanceExtraCost }
  );
  const clearanceBalance = Number((clearanceAdvanceAmount - clearanceTotals.total).toFixed(2));

  function advanceLineAmount(line: any) {
    return Number(line.line_total || 0) || Number(line.meals || 0) || Number(line.lunch || 0) + Number(line.dinner || 0);
  }

  function advanceLineMealCount(line: any) {
    const storedCount = Number(line.meals_count);
    if (Number.isFinite(storedCount) && storedCount > 0) return storedCount;
    const amount = advanceLineAmount(line);
    if (amount <= 0) return 0;
    const lineRate = Number(line.meal_value || 0) || selectedTravelRate || mealValueNumber;
    const computed = lineRate > 0 ? Number((amount / lineRate).toFixed(2)) : amount;
    // For daily-rate requests, if no meals computed, treat the row as 1 day
    if (selectedTravelType?.rate_kind === "DAILY" && (computed === 0 || computed === 0.0)) return 1;
    return computed;
  }

  function numberToWords(num: number): string {
    if (num === 0) return "Zero Only";
    const [integer, decimal] = num.toString().split('.');
    let word = "";
    let intNum = Number(integer);
    const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
    const teens = ["Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
    const thousands = ["", "Thousand", "Million", "Billion"];
    let i = 0;
    while (intNum > 0) {
      if (intNum % 1000 !== 0) {
        word = helper(intNum % 1000) + thousands[i] + " " + word;
      }
      intNum = Math.floor(intNum / 1000);
      i++;
    }
    word = word.trim();
    if (decimal && Number(decimal) > 0) {
      word += " and " + helper(Number(decimal)) + "Cents";
    }
    return word + " Only";
    function helper(n: number): string {
      let str = "";
      if (n >= 100) {
        str += ones[Math.floor(n / 100)] + " Hundred ";
        n %= 100;
      }
      if (n >= 20) {
        str += tens[Math.floor(n / 10)] + " ";
        n %= 10;
      } else if (n >= 10) {
        str += teens[n - 10] + " ";
        return str;
      }
      if (n > 0) {
        str += ones[n] + " ";
      }
      return str;
    }
  }


  useEffect(() => {
    setAmountInWords(numberToWords(totalRequested()));
  }, [advanceType, salaryAmount, loanAmount, extraCostAmount, rows, mealValue, travelTypes]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${uiScale * 16}px`;
    saveUiScale(uiScale);
  }, [uiScale]);

  useEffect(() => {
    if (!allowedPaymentMethods.includes(paymentMethod)) {
      setPaymentMethod(allowedPaymentMethods[0]);
    }
  }, [allowedPaymentMethods, paymentMethod]);

  const me = getUserFromToken();

  useEffect(() => {
    if (!token) return;
    if (!me) {
      void doLogout();
    }
  }, [token]);

  const role = profile?.role || me?.role || "UNKNOWN";
  const userName = displayUserLabel(profile?.full_name || me?.fullName || me?.username || "User", role);
  const userDepartment = [profile?.division_name, profile?.department, profile?.section_name, profile?.team_name].filter(Boolean).join(" › ")
    || profile?.department || me?.department || "No Division";
  const userInitials = initials(userName);
  const roleName = displayRoleLabel(role);
  const FEATURE_DEFAULTS: Record<string, string[]> = {
    user_management:        ["ADMIN", "MANAGER", "EXCO"],
    roles_permissions:      ["ADMIN", "MANAGER", "EXCO", "CEO"],
    travel_setup:           ["ADMIN", "MANAGER"],
    org_structure:          ["ADMIN"],
    team_roster:            ["ADMIN"],
    ceo_management:         ["ADMIN"],
    employees:              ["ADMIN"],
    exco_members:           ["ADMIN", "MANAGER"],
    managers:               ["ADMIN", "MANAGER", "EXCO"],
    leadership_assignments: ["ADMIN", "MANAGER", "EXCO"],
    workflow_builder:       ["ADMIN", "MANAGER", "EXCO"],
    request_types:          ["ADMIN"],
    reporting_lines:        ["ADMIN", "MANAGER", "EXCO"],
    advance_pdf:            ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"],
    report_reconciliation:  ["ADMIN", "FINANCE"],
    report_advances:        ["ADMIN", "FINANCE"],
    pdf_designer:           ["ADMIN"],
    claims_sla_report:      ["ADMIN", "FINANCE"],
    advance_recovery_settings: ["ADMIN", "FINANCE"],
    manager_delegations:    ["ADMIN"],
    deductions:             ["ADMIN"],
    refundable:             ["ADMIN"],
    it_provisioning:        ["ADMIN"],
    payments:               ["ADMIN", "Department: Finance"],
    capture:                ["ADMIN", "Section: Treasury & Financial Accounting"],
    accommodation:          ["ADMIN", "Section: Human Resources Operations", "Section: Treasury & Financial Accounting"],
    hr_operations_review:   ["ADMIN", "Section: Human Resources Operations"],
    clearance_status_report: [
      "ADMIN", "Department: Finance", "Section: Treasury & Financial Accounting",
      "Department: Human Resource", "Department: Human Resources", "Section: Human Resources Operations"
    ],
    overtime_request:       ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"],
    overtime_claim:         ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"],
  };

  function canAccessFeature(key: string): boolean {
    // ADMIN always has access, regardless of what an allowed_roles list says -
    // mirrors the backend's own hasFeatureAccess, which checks role==='ADMIN'
    // before ever consulting the table. Without this hard-coded bypass here
    // too, an admin who edits a feature's allowed groups (or a row inserted
    // directly rather than through the Roles & Permissions save button) could
    // accidentally lock themselves out of it.
    if (role === "ADMIN") return true;
    const allowed = featurePermissions[key] ?? FEATURE_DEFAULTS[key] ?? [];
    if (allowed.includes(role)) return true;
    const myGroups: string[] = profile?.groups ?? [];
    return allowed.some((g) => myGroups.includes(g));
  }

  const canManageTravelSettings = canAccessFeature("travel_setup");
  const profileCompleted = Boolean(profile?.profile_completed ?? me?.profileCompleted);
  const employmentType = profile?.employment_type || me?.employmentType || "PERMANENT";

  // Dashboard "shortcuts" — every process a user could plausibly pin, gated
  // by the same visibility rules as the sidebar so the picker never offers
  // something they can't actually open.
  const shortcutCatalog: { key: AppPage; label: string; icon: typeof ClipboardList; available: boolean }[] = [
    { key: "MY_ADVANCES", label: "Advance Requests", icon: ClipboardList, available: true },
    { key: "MY_CLEARANCES", label: "Clearances", icon: CheckCircle2, available: true },
    { key: "OVERTIME", label: "Overtime", icon: Clock3, available: overtimeModuleEnabled },
    { key: "CHANGE_REQUEST", label: "Custom Processes", icon: GitBranch, available: hasActiveCustomRequestTypes },
    { key: "INBOX", label: "Approval Inbox", icon: Mail, available: true },
    { key: "REPORTS", label: "Reports", icon: BarChart3, available: true },
    { key: "TRAVEL_SETUP", label: "Travel Setup", icon: BriefcaseBusiness, available: canManageTravelSettings },
    { key: "REQUEST_TYPES", label: "Process", icon: ClipboardList, available: canAccessFeature("request_types") },
    { key: "USER_MANAGEMENT", label: "User Management", icon: Users, available: canAccessFeature("user_management") },
    { key: "ORG_STRUCTURE", label: "Org Structure", icon: Network, available: canAccessFeature("org_structure") },
    { key: "SETTINGS", label: "Settings", icon: SettingsIcon, available: true }
  ];
  const availableShortcuts = shortcutCatalog.filter((s) => s.available);
  const favoriteShortcuts = favoritePages
    .map((key) => availableShortcuts.find((s) => s.key === key))
    .filter((s): s is (typeof shortcutCatalog)[number] => Boolean(s));

  async function toggleFavoritePage(key: AppPage, pinned: boolean) {
    const next = pinned ? [...favoritePages, key] : favoritePages.filter((k) => k !== key);
    setFavoritePages(next);
    setShortcutPickerOpen(false);
    try {
      await api.updateFavoritePages(next);
    } catch {
      // Non-critical — local state already reflects the user's intent;
      // it'll just re-sync from the server next time /auth/me is fetched.
    }
  }

  useEffect(() => {
    if (!shortcutPickerOpen) return;
    function onOutside(e: MouseEvent) {
      if (shortcutPickerRef.current && !shortcutPickerRef.current.contains(e.target as Node)) setShortcutPickerOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [shortcutPickerOpen]);

  // Idle-session logout: fetch the admin-configured timeout once per login.
  useEffect(() => {
    if (!token) return;
    void loadActiveSessionSettings();
  }, [token]);

  // Track activity and enforce the timeout - re-created whenever the
  // enforced values change (e.g. an admin just saved new settings) so a
  // stale closure never keeps running the old timeout/warning window.
  useEffect(() => {
    if (!token) return;
    function markActivity() {
      lastActivityRef.current = Date.now();
      setShowIdleWarning(false);
    }
    const events: Array<"mousedown" | "mousemove" | "keydown" | "scroll" | "touchstart"> = ["mousedown", "mousemove", "keydown", "scroll", "touchstart"];
    events.forEach((evt) => window.addEventListener(evt, markActivity, { passive: true }));

    const timeoutMs = idleTimeoutMinutes * 60000;
    const warningMs = Math.min(warningSeconds * 1000, timeoutMs - 1000);
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= timeoutMs) {
        setShowIdleWarning(false);
        void doLogout();
        return;
      }
      if (elapsed >= timeoutMs - warningMs) {
        setShowIdleWarning(true);
        setIdleSecondsLeft(Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000)));
      }
    }, 1000);

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, markActivity));
      clearInterval(interval);
    };
  }, [token, idleTimeoutMinutes, warningSeconds]);
  const canRequestForSelf = profileCompleted && ["PERMANENT", "INTERN", "TEMPORARY"].includes(employmentType);
  // Temps and interns can never request on someone else's behalf, regardless
  // of role - except for a boss they're explicitly assigned as PA for
  // (myPaPrincipals), which is its own authorization independent of role/
  // employment type (see resolveAdvanceRequester on the backend).
  const canCreateForOthers = (profileCompleted && employmentType === "PERMANENT") || myPaPrincipals.length > 0;
  const canOpenAdvanceForm = canRequestForSelf || canCreateForOthers;
  // "Apply for Other" (an advance for an external, non-Econet beneficiary) -
  // only permanent employees, same authorization axis as creating an
  // advance on behalf of another (internal) employee.
  const canApplyForExternal = profileCompleted && employmentType === "PERMANENT";
  const eligibleBeneficiaries = useMemo(() => {
    const fromDirectory = requestDirectory.filter(
      (user) =>
        user.id !== profile?.id &&
        ["INTERN", "TEMPORARY"].includes(String(user.employment_type || "").toUpperCase()) &&
        Boolean(user.profile_completed)
    );
    const seen = new Set(fromDirectory.map((u) => u.id));
    const fromPaAssignments = myPaPrincipals.filter((u) => u.id !== profile?.id && !seen.has(u.id));
    return [...fromDirectory, ...fromPaAssignments];
  }, [requestDirectory, myPaPrincipals, profile?.id]);
  const eligibleSupportCreators = requestDirectory.filter(
    (user) =>
      user.id !== profile?.id &&
      (String(user.department || "").trim() === String(profile?.department || "").trim()) &&
      (String(user.employment_type || "").toUpperCase() === "PERMANENT" || isApproverRole(user.role))
  );
  const selectedRequestUser =
    requestDirectory.find((user) => user.id === requestForUserId) ||
    myPaPrincipals.find((user) => user.id === requestForUserId) ||
    (requestForUserId === (profile?.id || me?.userId)
      ? {
          id: profile?.id || me?.userId || "",
          full_name: profile?.full_name || me?.fullName || "",
          email,
          employee_no: profile?.employee_no || me?.employeeNo || "",
          department: profile?.department || me?.department || "",
          employment_type: employmentType,
          role,
          profile_completed: profileCompleted
        }
      : null);

  // when we open the advance form ensure request date is initialized
  useEffect(() => {
    if (page === "ADVANCE" && !requestDate) {
      setRequestDate(new Date().toISOString().slice(0, 10));
    }
  }, [page, requestDate]);

  // resolve approval chain from the workflow that matches the user's section + advance type
  useEffect(() => {
    if (page !== "MY_ADVANCES" && page !== "ADVANCE") return;
    // A PA submitting for an assigned boss must resolve the approval route
    // (and the rate tier, via travellerRole above) from the BOSS's own org
    // placement, not the PA's - otherwise this always showed the PA's own
    // chain/rate regardless of who "Request For" actually pointed at. Self
    // and the existing intern/temp on-behalf flow are unaffected (myPaPrincipals
    // won't contain requestForUserId for those, so this falls through to the
    // same profile-based behavior as before).
    const paPrincipal = myPaPrincipals.find((u) => u.id === requestForUserId);
    const dept = paPrincipal ? (paPrincipal.department || "") : (profile?.department || "");
    const section = paPrincipal ? (paPrincipal.section_name || "") : (profile?.section_name || "");
    const division = paPrincipal ? (paPrincipal.division_name || "") : (profile?.division_name || "");
    const chainRole = paPrincipal ? (paPrincipal.role || role) : role;

    function loadCustomChainData() {
      setChainPositionTypes([
        { id: "counter_signer", name: "Counter Signed By", code: "COUNTER_SIGNER" },
        { id: "approved_by",    name: "Approved By",       code: "APPROVED_BY"    },
      ]);
    }

    // Guards against an older request (e.g. for a previously-selected advance
    // type) resolving after a newer one and clobbering its result - without
    // this, advanceApprovalChain and advanceWorkflowFound could each end up
    // reflecting a *different* request, showing a resolved chain and the
    // "no workflow" custom-picker fallback at the same time.
    let cancelled = false;

    if (!dept) {
      setAdvanceApprovalChain([]);
      setAdvanceWorkflowFound(false);
      loadCustomChainData();
      return () => { cancelled = true; };
    }
    setAdvanceWorkflowFound(null);
    // Pass the selected advance sub-type (and requester role) so the backend can
    // prefer a sub-type-specific and/or role-restricted workflow.
    api.resolveWorkflow("ADVANCE_REQUEST", dept, undefined, section, advanceType || undefined, chainRole, division || undefined)
      .then((result: any) => {
        if (cancelled) return;
        const chain: any[] = Array.isArray(result?.chain) ? result.chain : [];
        const filtered = chain.filter((s: any) => s.position_type_code !== "EMPLOYEE");
        setAdvanceApprovalChain(
          filtered.map((s: any) => {
            const rawTitle = s.position_name || s.approver_title;
            const isTeamGroup = rawTitle.startsWith("Team: ");
            return {
              label: displayOrgGroupName(rawTitle),
              // "Team: X" steps are approvable by any member of that group, not
              // the specific individual returned as approver_name (the HOD).
              name: isTeamGroup ? null : s.approver_name || null
            };
          })
        );
        const found = filtered.length > 0;
        setAdvanceWorkflowFound(found);
        if (!found) loadCustomChainData();
      })
      .catch(() => {
        if (cancelled) return;
        setAdvanceApprovalChain([]);
        setAdvanceWorkflowFound(false);
        loadCustomChainData();
      });

    return () => { cancelled = true; };
  }, [page, profile?.department, profile?.division_name, profile?.section_name, advanceType, role, requestForUserId, myPaPrincipals]);

  async function refresh() {
    setError(null);
    const meResp = await withStartupTimeout(api.me(), "Profile");
    setProfile(meResp);
    setPhoneDraft(meResp?.phone || "");
    // Only seed from the server once per session — afterwards, local state
    // (updated optimistically as the user pins/unpins shortcuts) is authoritative.
    if (meResp && !favoritePagesInitialized.current) {
      setFavoritePages(Array.isArray(meResp.favorite_pages) ? meResp.favorite_pages : []);
      favoritePagesInitialized.current = true;
    }
    // Pre-seed the profile org selection so the profile completion form
    // shows the user's current org placement if they revisit it
    if (meResp) {
      setProfileOrgSelection(orgSelectionFromUser(meResp));
      if (meResp.department) setProfileDepartment(meResp.department);
    }

    const [departmentsResp, directoryResp, a, c, allAdvancesResp, allClaimsResp, i, mealResp, travelResp, hotelsResp, standbyResp, featPermResp, groupsResp, rtResp, paymentsResp, paymentsAccessResp, deductionsAccessResp, refundableAccessResp, treasuryAccessResp, itProvisioningAccessResp, moduleFlagsResp, vendorContractsAccessResp, serviceContractsAccessResp, overtimeDashboardResp] = await Promise.all([
      optionalStartupData<string[]>(api.departments(), [], "Departments"),
      optionalStartupData<RequestDirectoryUser[]>(api.requestDirectory(), [], "Request directory"),
      optionalStartupData<any[]>(api.advances(), [], "Advances"),
      optionalStartupData<any[]>(api.claims(), [], "Claims"),
      // Fails silently (403) for anyone without the report_advances feature
      // permission, same as payments below - only feeds the Reports screens.
      optionalStartupData<any[]>(api.allAdvances(), [], "All advances"),
      optionalStartupData<any[]>(api.allClaims(), [], "All claims"),
      optionalStartupData<{ items?: any[] }>(api.inbox(), { items: [] }, "Inbox"),
      optionalStartupData<{ meal_value?: number }>(api.mealValue(), { meal_value: 0 }, "Meal value"),
      optionalStartupData<TravelType[]>(api.travelTypes(), [], "Travel types"),
      optionalStartupData<any>(api.hotels({ limit: 10000, offset: 0 }), [], "Hotels"),
      optionalStartupData<{ on_standby_today?: any[] }>(api.standbyDashboard(), { on_standby_today: [] }, "Standby"),
      optionalStartupData<{ features?: Record<string, string[]> }>(api.adminFeaturePermissions(), {}, "Feature permissions"),
      optionalStartupData<{ name: string; member_count: string; dynamic?: boolean }[]>(api.permissionGroups(), [], "Permission groups"),
      optionalStartupData<any[]>(api.requestTypes(), [], "Request types"),
      // Fails silently (403) for anyone outside Finance/Admin via optionalStartupData's
      // catch-and-fallback, same as every other startup call above — no role check needed here.
      optionalStartupData<{ total?: number }>(api.payments({ status: "pending" }), { total: 0 }, "Payments"),
      optionalStartupData<{ allowed?: boolean }>(api.paymentsAccess(), { allowed: false }, "Payments access"),
      optionalStartupData<{ allowed?: boolean; pendingCount?: number }>(api.deductionsAccess(), { allowed: false }, "Deductions access"),
      optionalStartupData<{ allowed?: boolean; pendingCount?: number }>(api.refundableAccess(), { allowed: false }, "Refundable access"),
      optionalStartupData<{ allowed?: boolean; pendingCount?: number }>(api.treasuryAccess(), { allowed: false }, "Treasury access"),
      optionalStartupData<{ allowed?: boolean; awaitingProvisioning?: number; inProgress?: number }>(api.itProvisioningAccess(), { allowed: false }, "IT Provisioning access"),
      optionalStartupData<{
        overtime_enabled?: boolean; standby_enabled?: boolean;
        salary_advance_enabled?: boolean; loan_advance_enabled?: boolean;
        salary_advance_max_payback_months?: number; loan_advance_max_payback_months?: number;
      }>(api.moduleFlags(), { overtime_enabled: true, standby_enabled: true }, "Module flags"),
      optionalStartupData<{ allowed?: boolean; canManage?: boolean }>(api.vendorContractsAccess(), { allowed: false }, "Vendor Contracts access"),
      optionalStartupData<{ allowed?: boolean; canManage?: boolean }>(api.serviceContractsAccess(), { allowed: false }, "Service Contracts access"),
      optionalStartupData<{ is_finance?: boolean }>(api.overtimeDashboard(), { is_finance: false }, "Overtime dashboard"),
    ]);
    setDepartmentOptions(Array.isArray(departmentsResp) ? departmentsResp : []);
    setRequestDirectory(Array.isArray(directoryResp) ? directoryResp : []);
    setAdvances(Array.isArray(a) ? a : []);
    setClaims(Array.isArray(c) ? c : []);
    setReportAdvances(Array.isArray(allAdvancesResp) ? allAdvancesResp : []);
    setReportClaims(Array.isArray(allClaimsResp) ? allClaimsResp : []);
    const rawInboxItems: any[] = Array.isArray(i.items) ? i.items : [];
    const nonSplitInboxItems = rawInboxItems.filter((it) => (!isCaptureItem(it) || needsAccommodationBooking(it)) && !isPaymentItem(it));
    // The Inbox list itself shows every item you're relevant to (including
    // ones already past your own step, kept for visibility/tracking), but
    // the badge count must only reflect items actually waiting on YOUR
    // action right now - otherwise it stays inflated with things already
    // approved by you or not yet reached your step.
    const inboxItemCount = nonSplitInboxItems.filter((it) => it.current_step_actionable_by_me === true).length;
    setInboxCount(inboxItemCount);
    setInboxItems(nonSplitInboxItems);
    setCaptureCount(rawInboxItems.filter(isCapturePendingItem).length);
    setPaymentsCount(paymentsResp.total || 0);
    setHasPaymentsAccess(Boolean(paymentsAccessResp?.allowed));
    knownInboxCount.current = inboxItemCount;
    // getToken() (live, not the closure-captured `token` state) guards
    // against a session expiring or logging out during the long fetch
    // above - without this, the reminder could still fire and land on top
    // of the freshly-rendered login page instead of being suppressed.
    if (justLoggedIn.current && inboxItemCount > 0 && getToken()) {
      justLoggedIn.current = false;
      void Swal.fire({
        icon: "info",
        title: "Approval Inbox",
        text: `You have ${inboxItemCount} item${inboxItemCount === 1 ? "" : "s"} awaiting your approval.`,
        confirmButtonText: "Go to Inbox",
        showCancelButton: true,
        cancelButtonText: "Dismiss",
        reverseButtons: true
      }).then((result) => {
        if (result.isConfirmed) setPage("INBOX");
      });
    } else {
      justLoggedIn.current = false;
    }
    const configuredMealValue = Number(mealResp.meal_value || 0);
    setMealValue(configuredMealValue);
    setMealValueDraft(String(configuredMealValue));
    setTravelTypes(Array.isArray(travelResp) ? travelResp : []);
    const initialHotels = Array.isArray(hotelsResp) ? hotelsResp : hotelsResp?.items || [];
    setHotels(initialHotels);
    setHotelsTotal(Array.isArray(hotelsResp) ? initialHotels.length : Number(hotelsResp?.total || initialHotels.length));
    setStandbyToday(Array.isArray(standbyResp?.on_standby_today) ? standbyResp.on_standby_today : []);
    setHasActiveCustomRequestTypes(Array.isArray(rtResp) && rtResp.some((rt: any) => rt.status === "ACTIVE"));
    // Fetched separately from the big Promise.all above (not woven into its
    // fragile positional destructuring) — BRS is optional, so any failure
    // here should just leave the nav item hidden, never break startup.
    api.brsModuleFlag().then((f: any) => setHasActiveBrsTypes(Boolean(f?.brs_enabled))).catch(() => setHasActiveBrsTypes(false));
    setOvertimeModuleEnabled(moduleFlagsResp?.overtime_enabled !== false);
    setStandbyModuleEnabled(moduleFlagsResp?.standby_enabled !== false);
    setSalaryAdvanceEnabled(moduleFlagsResp?.salary_advance_enabled !== false);
    setLoanAdvanceEnabled(moduleFlagsResp?.loan_advance_enabled !== false);
    setSalaryAdvanceMaxMonths(Number(moduleFlagsResp?.salary_advance_max_payback_months) || 6);
    setLoanAdvanceMaxMonths(Number(moduleFlagsResp?.loan_advance_max_payback_months) || 6);
    setHasDeductionsAccess(Boolean(deductionsAccessResp?.allowed));
    setDeductionsCount(deductionsAccessResp?.pendingCount || 0);
    setHasRefundableAccess(Boolean(refundableAccessResp?.allowed));
    setRefundableCount(refundableAccessResp?.pendingCount || 0);
    setHasTreasuryAccess(Boolean(treasuryAccessResp?.allowed));
    setTreasuryCount(treasuryAccessResp?.pendingCount || 0);
    setHasOvertimeFinanceAccess(Boolean(overtimeDashboardResp?.is_finance));
    setHasItProvisioningAccess(Boolean(itProvisioningAccessResp?.allowed));
    setItProvisioningCount((itProvisioningAccessResp?.awaitingProvisioning || 0) + (itProvisioningAccessResp?.inProgress || 0));
    setHasVendorContractsAccess(Boolean(vendorContractsAccessResp?.allowed));
    setHasServiceContractsAccess(Boolean(serviceContractsAccessResp?.allowed));
    if (featPermResp && typeof featPermResp === "object" && "features" in featPermResp && featPermResp.features) {
      setFeaturePermissions(featPermResp.features as Record<string, string[]>);
    }
    setPermissionGroups(Array.isArray(groupsResp) ? groupsResp : []);
    if (token) {
      try {
        const anomalyRows = await api.aiAnomalies();
        setAiAnomalies(anomalyRows);
      } catch {
        setAiAnomalies(null);
      }
    }
  }

  useEffect(() => {
    if (!token) return;
    setProfileLoading(true);
    refresh()
      .catch((e) => {
        if (isAuthOrTimeoutError(e)) {
          void doLogout();
        } else {
          alert("Error loading data: " + String((e as any)?.message || e));
        }
      })
      .finally(() => setProfileLoading(false));
  }, [token]);

  // Poll inbox every 30 s while logged in; alert when new items arrive
  useEffect(() => {
    if (!token) return;
    const id = setInterval(async () => {
      try {
        const resp: { items?: any[] } = await api.inbox();
        const rawItems: any[] = Array.isArray(resp.items) ? resp.items : [];
        const nonSplitItems = rawItems.filter((it) => (!isCaptureItem(it) || needsAccommodationBooking(it)) && !isPaymentItem(it));
        // Same fix as the initial load: only count items actually actionable
        // by you right now, not everything you're peripherally relevant to.
        const fresh = nonSplitItems.filter((it) => it.current_step_actionable_by_me === true).length;
        setCaptureCount(rawItems.filter(isCapturePendingItem).length);
        const prev = knownInboxCount.current;
        if (fresh > prev) {
          const added = fresh - prev;
          knownInboxCount.current = fresh;
          setInboxCount(fresh);
          setInboxItems(nonSplitItems);
          void Swal.fire({
            icon: "info",
            title: "New Approval Request",
            text: `${added} new item${added === 1 ? "" : "s"} ${added === 1 ? "has" : "have"} arrived in your Approval Inbox.`,
            confirmButtonText: "Go to Inbox",
            showCancelButton: true,
            cancelButtonText: "Dismiss",
            reverseButtons: true
          }).then((result) => {
            if (result.isConfirmed) setPage("INBOX");
          });
        } else {
          knownInboxCount.current = fresh;
          setInboxCount(fresh);
          setInboxItems(nonSplitItems);
        }
      } catch (e) {
        if (isAuthOrTimeoutError(e)) {
          clearInterval(id);
          void doLogout();
        }
        // non-auth errors (network blip, server restart) are ignored —
        // the next tick will retry without alarming the user
      }
      // Separate try/catch: 403s here (anyone outside Finance/Admin) are
      // expected and must not trigger the inbox poll's auth-error logout above.
      try {
        const paymentsResp: { total?: number } = await api.payments({ status: "pending" });
        setPaymentsCount(paymentsResp.total || 0);
      } catch {
        // ignored — non-Finance/Admin users simply won't see a Payments badge
      }
      try {
        const paymentsAccessResp: { allowed?: boolean } = await api.paymentsAccess();
        setHasPaymentsAccess(Boolean(paymentsAccessResp?.allowed));
      } catch {
        // ignored — users without Payments access simply won't see the nav item
      }
      // Separate try/catch: 403s here (anyone without Deductions access) are
      // expected and must not trigger the inbox poll's auth-error logout above.
      try {
        const deductionsResp: { allowed?: boolean; pendingCount?: number } = await api.deductionsAccess();
        setHasDeductionsAccess(Boolean(deductionsResp?.allowed));
        setDeductionsCount(deductionsResp?.pendingCount || 0);
      } catch {
        // ignored — users without Deductions access simply won't see the nav item
      }
      try {
        const refundableResp: { allowed?: boolean; pendingCount?: number } = await api.refundableAccess();
        setHasRefundableAccess(Boolean(refundableResp?.allowed));
        setRefundableCount(refundableResp?.pendingCount || 0);
      } catch {
        // ignored — users without Refundable access simply won't see the nav item
      }
      try {
        const itProvResp: { allowed?: boolean; awaitingProvisioning?: number; inProgress?: number } = await api.itProvisioningAccess();
        setHasItProvisioningAccess(Boolean(itProvResp?.allowed));
        setItProvisioningCount((itProvResp?.awaitingProvisioning || 0) + (itProvResp?.inProgress || 0));
      } catch {
        // ignored — users without IT Provisioning access simply won't see the nav item
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => {
    const full = profile?.full_name || "";
    const parts = full.split(" ").filter(Boolean);
    setProfileFirstName(parts.shift() || "");
    setProfileLastName(parts.join(" ") || "");
    setProfileName(full);
    setProfileDepartment(profile?.department || "");
    setProfileEmploymentType(profile?.employment_type || "PERMANENT");
    setProfileEmployeeNo(profile?.employee_no || "");
    if (profile?.full_name) setRequesterName(profile.full_name);
    if (profile?.employee_no) setEmpNumber(profile.employee_no);
    if (profile?.id) setRequestForUserId(profile.id);
  }, [profile]);

  useEffect(() => {
    if (!selectedRequestUser) return;
    setRequesterName(selectedRequestUser.full_name || "");
    setEmpNumber(selectedRequestUser.employee_no || "");
  }, [selectedRequestUser]);

  useEffect(() => {
    if (page !== "CLEARANCE" || !clearanceLinkedAdvanceId) {
      setClearanceSourceLines([]);
      return;
    }

    let cancelled = false;
    api.advanceDetail(clearanceLinkedAdvanceId)
      .then((detail: any) => {
        if (cancelled) return;
        const lines = detail.lines || [];
        setClearanceSourceLines(lines);
        // Seed editable actual-expenditure rows from the advance's planned
        // lines (meals pre-filled, transport/other start at 0). When editing
        // an existing claim, populateClearanceForm overrides this with saved
        // actuals instead.
        if (!editingClaimId) {
          // A DAILY-rate line (CMA/international per diem) can cover several
          // days on one line_date - expand it into one clearance row per day
          // so the settlement form keeps the same per-day breakdown as
          // before, instead of collapsing a multi-day trip into one row.
          const isDailyRateAdvance = detail.travel_rate_kind === "DAILY";
          setClearanceTrips(
            lines.length
              ? lines.flatMap((line: any) => {
                  const dayCount = isDailyRateAdvance ? Math.max(1, Number(line.meals_count) || 1) : 1;
                  const perDayAmount = advanceLineAmount(line) / dayCount;
                  return Array.from({ length: dayCount }, (_, day) => {
                    const rowDate = day === 0
                      ? normalizeDateInputValue(line.line_date)
                      : normalizeDateInputValue(new Date(new Date(line.line_date).getTime() + day * 86400000).toISOString().slice(0, 10));
                    return {
                      ...emptyClearanceTripRow(rowDate),
                      from_place: line.location || "",
                      lunch: perDayAmount
                    };
                  });
                })
              : [emptyClearanceTripRow()]
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        setClearanceSourceLines([]);
      });

    return () => {
      cancelled = true;
    };
  }, [page, clearanceLinkedAdvanceId]);

  useEffect(() => {
    if (!token) { setMyPaPrincipals([]); return; }
    api.myPaPrincipals()
      .then((rows: any) => setMyPaPrincipals(Array.isArray(rows) ? rows : []))
      .catch(() => setMyPaPrincipals([]));
  }, [token]);

  useEffect(() => {
    if (token && ["SETTINGS", "REPORTS", "USER_MANAGEMENT", "ROLES_PERMISSIONS", "MANAGER_DELEGATIONS"].includes(page)) {
      if (role === "ADMIN" || role === "MANAGER") {
        void loadAdminUsers();
        void loadDelegations();
      }
      if (page === "MANAGER_DELEGATIONS" && role === "ADMIN") {
        void loadPaAssignments();
      }
    }
    if (token && ["SETTINGS", "REPORTS", "TRAVEL_SETUP"].includes(page)) {
      void loadHotels();
      void loadMealValue();
      void loadTravelTypes();
    }
  }, [token, page, role]);

  const ORG_PAGES = ["EXCO", "CEO_MANAGEMENT", "MANAGERS", "EMPLOYEES", "LEADERSHIP", "WORKFLOW_BUILDER", "REPORTING_LINES", "ORG_STRUCTURE", "TEAM_ROSTER", "PDF_DESIGNER"] as const;

  useEffect(() => {
    if (ORG_PAGES.includes(page as any)) setOrgNavOpen(true);
  }, [page]);

  async function loadMealValue() {
    setMealValueLoading(true);
    try {
      const resp: { meal_value?: number } = await api.mealValue();
      const value = Number(resp.meal_value || 0);
      setMealValue(value);
      setMealValueDraft(String(value));
    } catch (e: any) {
      alert("Error loading meal value: " + e.message);
    } finally {
      setMealValueLoading(false);
    }
  }

  async function saveMealValue() {
    const value = Number(mealValueDraft);
    if (!Number.isFinite(value) || value < 0) {
      alert("Meal value must be zero or greater.");
      return;
    }
    setMealValueLoading(true);
    try {
      const resp: { meal_value?: number } = await api.updateMealValue(value);
      const saved = Number(resp.meal_value ?? value);
      setMealValue(saved);
      setMealValueDraft(String(saved));
      alert("Meal value saved.");
    } catch (e: any) {
      alert("Error saving meal value: " + e.message);
    } finally {
      setMealValueLoading(false);
    }
  }

  async function loadHotels(opts?: { search?: string; page?: number }) {
    setHotelsLoading(true);
    const search = opts?.search ?? hotelSearch;
    const page = opts?.page ?? hotelPage;
    try {
      const result: any = await api.hotels({ search, limit: HOTELS_PAGE_SIZE, offset: page * HOTELS_PAGE_SIZE });
      setHotels(Array.isArray(result) ? result : result?.items || []);
      setHotelsTotal(Array.isArray(result) ? result.length : Number(result?.total || 0));
    } catch (e: any) {
      alert("Error loading hotels: " + e.message);
    } finally {
      setHotelsLoading(false);
    }
  }

  async function exportHotelsCSV() {
    const header = ["Name", "District", "Country", "Province", "City", "Address", "Contact"];
    const rows: string[][] = [header];
    try {
      // Export the full list regardless of the current search/page in view.
      const result: any = await api.hotels({ limit: 10000, offset: 0 });
      const all: any[] = Array.isArray(result) ? result : result?.items || [];
      for (const h of all) {
        rows.push([h.name || "", h.district || "", h.country || "", h.province || "", h.city || "", h.address || "", h.contact || ""]);
      }
      downloadCsv(`hotels-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } catch (e: any) {
      alert("Error exporting hotels: " + e.message);
    }
  }

  // Debounced so typing doesn't fire a request per keystroke - resets to
  // page 0 since the previous page offset may not exist under the new filter.
  function handleHotelSearchChange(value: string) {
    setHotelSearch(value);
    setHotelPage(0);
    if (hotelSearchDebounceRef.current) clearTimeout(hotelSearchDebounceRef.current);
    hotelSearchDebounceRef.current = setTimeout(() => {
      void loadHotels({ search: value, page: 0 });
    }, 300);
  }

  function handleHotelPageChange(page: number) {
    setHotelPage(page);
    void loadHotels({ page });
  }

  function handleImportHotelsFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const parsed: HotelImportRow[] = [];
      for (const line of lines.slice(1)) {
        const cells = parseCsvLine(line);
        const name = cells[0]?.trim() ?? "";
        if (!name) continue;
        parsed.push({
          name,
          district: cells[1]?.trim() ?? "",
          country: cells[2]?.trim() ?? "",
          province: cells[3]?.trim() ?? "",
          city: cells[4]?.trim() ?? "",
          address: cells[5]?.trim() ?? "",
          contact: cells[6]?.trim() ?? ""
        });
      }
      setImportHotelRows(parsed);
      setImportHotelResult(null);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function runImportHotels() {
    if (!importHotelRows?.length) return;
    setImportHotelProcessing(true);
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    try {
      const existingResp: any = await api.hotels({ limit: 10000, offset: 0 });
      let existing: any[] = Array.isArray(existingResp) ? existingResp : existingResp?.items || [];
      for (const row of importHotelRows) {
        const dupe = existing.some(
          (h) => h.name.trim().toLowerCase() === row.name.toLowerCase() && (h.district || "").trim().toLowerCase() === row.district.toLowerCase()
        );
        if (dupe) { skipped++; continue; }
        if (!row.district && !(row.country && row.city)) {
          errors.push(`"${row.name}": needs either a District, or both Country and City`);
          continue;
        }
        try {
          await api.createHotel({
            name: row.name,
            district: row.district || undefined,
            country: row.country || undefined,
            province: row.province || undefined,
            city: row.city || undefined,
            address: row.address || undefined,
            contact: row.contact || undefined
          });
          created++;
          existing = [...existing, row];
        } catch (e: any) {
          errors.push(`"${row.name}": ${e.message}`);
        }
      }
      await loadHotels();
      setImportHotelResult({ created, skipped, errors });
    } catch (e: any) {
      errors.push(`Unexpected: ${e.message}`);
      setImportHotelResult({ created, skipped, errors });
    } finally {
      setImportHotelProcessing(false);
    }
  }

  async function loadTravelTypes() {
    setTravelTypesLoading(true);
    try {
      const rows: TravelType[] = await api.travelTypes();
      setTravelTypes(Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      alert("Error loading travel types: " + e.message);
    } finally {
      setTravelTypesLoading(false);
    }
  }

  async function createTravelType() {
    if (!newTravelTypeName.trim()) return alert("Enter a travel type name");
    if (newTravelTypeAllowedPaymentMethods.length === 0) return alert("Select at least one payment method");
    try {
      await api.createTravelType({
        name: newTravelTypeName.trim(),
        location_mode: newTravelTypeLocationMode,
        rate_kind: newTravelTypeRateKind,
        rate_general_staff: Number(newTravelTypeGeneralRate) || 0,
        rate_exco: Number(newTravelTypeExcoRate) || 0,
        rate_ceo: Number(newTravelTypeCeoRate) || 0,
        currency: newTravelTypeCurrency,
        active: true,
        requires_accommodation: newTravelTypeRequiresAccommodation,
        allowed_payment_methods: newTravelTypeAllowedPaymentMethods,
        allow_external_beneficiary: newTravelTypeAllowExternalBeneficiary
      });
      setNewTravelTypeName("");
      setNewTravelTypeGeneralRate("0");
      setNewTravelTypeExcoRate("0");
      setNewTravelTypeCeoRate("0");
      setNewTravelTypeCurrency("LSL");
      setNewTravelTypeRequiresAccommodation(false);
      setNewTravelTypeAllowedPaymentMethods(["ECOCASH", "BANK"]);
      setNewTravelTypeAllowExternalBeneficiary(false);
      await loadTravelTypes();
      alert("Travel type saved.");
    } catch (e: any) {
      alert("Error saving travel type: " + e.message);
    }
  }

  async function saveEditedTravelType() {
    if (!editingTravelType) return;
    await updateTravelTypeRate(editingTravelType);
    setEditingTravelType(null);
  }

  async function updateTravelTypeRate(type: TravelType) {
    if (!(type.allowed_payment_methods?.length)) return alert("Select at least one payment method");
    try {
      await api.updateTravelType(type.id, {
        name: type.name,
        location_mode: type.location_mode,
        rate_kind: type.rate_kind,
        rate_general_staff: Number(type.rate_general_staff) || 0,
        rate_exco: Number(type.rate_exco) || 0,
        rate_ceo: Number(type.rate_ceo) || 0,
        currency: type.currency ?? "LSL",
        active: type.active !== false,
        requires_accommodation: type.requires_accommodation ?? false,
        allowed_payment_methods: type.allowed_payment_methods,
        allow_external_beneficiary: type.allow_external_beneficiary ?? false
      });
      await loadTravelTypes();
      alert("Travel type updated.");
    } catch (e: any) {
      alert("Error updating travel type: " + e.message);
    }
  }

  async function deleteTravelType(typeId: string) {
    const confirmed = await confirmAction({
      title: "Delete travel type?",
      text: "This will remove the travel type and its configured locations.",
      confirmButtonText: "Delete"
    });
    if (!confirmed) return;
    try {
      await api.deleteTravelType(typeId);
      await loadTravelTypes();
      alert("Travel type deleted.");
    } catch (e: any) {
      alert("Error deleting travel type: " + e.message);
    }
  }

  async function createTravelLocation() {
    const selectedType = travelTypes.find((type) => type.id === newTravelLocationTypeId);
    if (!selectedType) return alert("Select the travel type for this location.");
    const country = newTravelLocationCountry.trim();
    const city = newTravelLocationCity.trim();
    const province = newTravelLocationProvince.trim();
    const district = newTravelLocationDistrict.trim();
    if (selectedType.location_mode === "DISTRICT" && !district) return alert("Enter the district.");
    if (selectedType.location_mode === "COUNTRY_CITY") {
      if (!country) return alert("Enter the country.");
      if (country.toLowerCase() === "south africa" && !province) return alert("Choose the South African province.");
      if (!city) return alert("Enter the city.");
    }
    try {
      await api.createTravelLocation({
        travel_type_id: selectedType.id,
        district: selectedType.location_mode === "DISTRICT" ? district : undefined,
        country: selectedType.location_mode === "COUNTRY_CITY" ? country : undefined,
        province: selectedType.location_mode === "COUNTRY_CITY" ? province : undefined,
        city: selectedType.location_mode === "COUNTRY_CITY" ? city : undefined
      });
      setNewTravelLocationDistrict("");
      setNewTravelLocationCountry("");
      setNewTravelLocationProvince("");
      setNewTravelLocationCity("");
      await loadTravelTypes();
      alert("Travel location added.");
    } catch (e: any) {
      alert("Error adding travel location: " + e.message);
    }
  }

  async function createHotel() {
    if (!newHotelName.trim()) return alert("Enter hotel name");
    if (!newHotelDistrict && (!newHotelCountry.trim() || !newHotelCity.trim())) return alert("Select a district or enter country and city for this hotel");
    if (newHotelCountry.trim().toLowerCase() === "south africa" && !newHotelProvince.trim()) return alert("Choose the South African province for this hotel");
    try {
      await api.createHotel({
        name: newHotelName.trim(),
        district: newHotelDistrict || undefined,
        country: newHotelCountry.trim() || undefined,
        province: newHotelProvince.trim() || undefined,
        city: newHotelCity.trim() || undefined,
        address: newHotelAddress.trim() || undefined,
        contact: newHotelContact.trim() || undefined
      });
      setNewHotelName("");
      setNewHotelDistrict("");
      setNewHotelCountry("");
      setNewHotelProvince("");
      setNewHotelCity("");
      setNewHotelAddress("");
      setNewHotelContact("");
      void loadHotels();
      setShowAddHotelModal(false);
    } catch (e: any) {
      alert("Error creating hotel: " + e.message);
    }
  }

  async function saveHotel() {
    if (!editingHotel) return;
    setSavingHotel(true);
    try {
      await api.updateHotel(editingHotel.id, {
        name: editingHotel.name,
        district: editingHotel.district || undefined,
        country: editingHotel.country || undefined,
        province: editingHotel.province || undefined,
        city: editingHotel.city || undefined,
        address: editingHotel.address || undefined,
        contact: editingHotel.contact || undefined,
      });
      setEditingHotel(null);
      void loadHotels();
    } catch (e: any) {
      alert("Error updating hotel: " + e.message);
    } finally { setSavingHotel(false); }
  }

  async function deleteHotel(hotel: any) {
    if (!hotel?.id) return;
    const confirmed = await confirmAction({
      title: "Delete hotel?",
      text: `Delete ${hotel.name || "this hotel"}?`,
      confirmButtonText: "Delete"
    });
    if (!confirmed) return;
    try {
      await api.deleteHotel(hotel.id);
      void loadHotels();
    } catch (e: any) {
      alert("Error deleting hotel: " + e.message);
    }
  }

  async function doLogin() {
    if (loginLoading) return;
    setError(null);
    setLoginLoading(true);
    try {
      console.log("Attempting login with:", email);
      const r = await api.login(email, password);
      console.log("Login successful, received token:", r.token ? "✓" : "✗");
      justLoggedIn.current = true;
      setToken(r.token);
      setTok(r.token);
      setProfile(r.user || null);
      setPage("HOME");
      // The shared staff directory's first fetch fires on app mount, before
      // any token exists, so it 401s on every fresh session - force a real
      // fetch now that we're actually authenticated (see useStaffDirectory.ts).
      void refreshStaffDirectory();
    } catch (e: any) {
      console.error("Login error:", e);
      const errorMsg = e?.message || "Login failed. Please try again.";
      setError(errorMsg);
    } finally {
      setLoginLoading(false);
    }
  }

  async function doLogout() {
    // A pending "Approval Inbox" reminder (or any other open dialog) is a
    // plain DOM overlay outside React's tree - it doesn't get torn down
    // just because the login page re-renders underneath it. Without this,
    // logging out (or an auth/timeout error auto-logging someone out) while
    // that reminder was still up left it floating over the login screen.
    Swal.close();
    clearToken();
    setTok(null);
    setProfile(null);
    setRequestDirectory([]);
    setAdvances([]);
    setClaims([]);
    setReportAdvances([]);
    setReportClaims([]);
    setInboxCount(0);
    setInboxItems([]);
    setAdminUsers([]);
    setPage("HOME");
  }

  function stayLoggedIn() {
    lastActivityRef.current = Date.now();
    setShowIdleWarning(false);
  }

  async function submitProfile() {
    if (!profileFirstName.trim() || !profileLastName.trim()) {
      alert("Enter your first name and last name.");
      return;
    }
    // Accept either OrgPicker selection or legacy dropdown
    const effectiveDepartment = profileOrgSelection.department || profileDepartment;
    if (!effectiveDepartment) {
      alert("Choose your department.");
      return;
    }
    if (profileEmploymentType === "PERMANENT" && !profileEmployeeNo.trim()) {
      alert("Enter your employment number.");
      return;
    }

    try {
      const full = `${profileFirstName.trim()} ${profileLastName.trim()}`;
      const result: any = await api.completeProfile({
        full_name: full,
        department: effectiveDepartment.trim(),
        division_id: profileOrgSelection.divisionId ?? null,
        section_id: profileOrgSelection.sectionId ?? null,
        team_id: profileOrgSelection.teamId ?? null,
        employment_type: profileEmploymentType,
        employee_no: profileEmployeeNo.trim() || undefined
      });
      setToken(result.token);
      setTok(result.token);
      setProfile(result.user);
      void refreshStaffDirectory();
      setDepartmentOptions((current) =>
        effectiveDepartment && !current.includes(effectiveDepartment)
          ? [...current, effectiveDepartment].sort((a, b) => a.localeCompare(b))
          : current
      );
      setRequesterName(result.user?.full_name || "");
      setEmpNumber(result.user?.employee_no || "");
      alert(
        ["PERMANENT", "INTERN", "TEMPORARY"].includes(profileEmploymentType)
          ? "Profile saved. You can now request advances."
          : "Profile saved."
      );
    } catch (e: any) {
      alert("Error saving profile: " + e.message);
    }
  }

  async function loadAdminUsers() {
    setAdminUsersLoading(true);
    try {
      // Manager Delegations is the only one of this effect's pages a
      // non-ADMIN ever actually reaches (the others are ADMIN-gated in the
      // sidebar) - and a manager only needs the company directory to pick
      // their own delegate, not the full /auth/users user-management list,
      // which requireUserManagementAccess can restrict to ADMIN-only (see
      // admin_feature_permissions) - hitting it as a manager 403'd the
      // whole Promise.all and broke the page for every non-admin.
      const [users, sections, departments, leaders] = await Promise.all([
        role === "ADMIN" ? api.adminUsers() : api.requestDirectory("company"),
        api.sections(),
        api.departmentsWithSections(),
        api.leadershipUsers()
      ]);
      setAdminUsers(Array.isArray(users) ? users : []);
      setSectionOptions(Array.isArray(sections) ? sections : []);
      setDepartmentRows(Array.isArray(departments) ? departments : []);
      setLeadershipUsers({
        hods: Array.isArray(leaders?.hods) ? leaders.hods : Array.isArray(leaders?.managers) ? leaders.managers : [],
        managers: Array.isArray(leaders?.managers) ? leaders.managers : [],
        exco: Array.isArray(leaders?.exco) ? leaders.exco : []
      });
    } catch (e: any) {
      alert("Error loading admin settings: " + e.message);
    } finally {
      setAdminUsersLoading(false);
    }
  }

  async function loadDelegations() {
    setDelegationsLoading(true);
    try {
      const rows: any[] = await api.delegations();
      setDelegations(Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      alert("Error loading delegations: " + e.message);
    } finally {
      setDelegationsLoading(false);
    }
  }

  async function loadCustomRequestTypeOptions() {
    try {
      const rows: any[] = await api.requestTypes();
      setCustomRequestTypeOptions(
        (Array.isArray(rows) ? rows : [])
          // is_active only tracks soft-delete; a type also needs status='ACTIVE'
          // (not DRAFT) before anyone can actually submit against it - drafts
          // have no business showing up as a delegation-scopable type.
          .filter((rt) => rt.is_active !== false && rt.status === "ACTIVE")
          .map((rt) => ({ code: rt.code as string, name: rt.name as string }))
      );
    } catch {
      setCustomRequestTypeOptions([]);
    }
  }

  useEffect(() => {
    if (page !== "MANAGER_DELEGATIONS") return;
    if (delegations.length === 0 && !delegationsLoading) void loadDelegations();
    if (customRequestTypeOptions.length === 0) void loadCustomRequestTypeOptions();
  }, [page]);

  // ADMIN manages delegations on others' behalf regardless of this check;
  // for self-service users, the sidebar link (and page) only appear once
  // they're assigned to a step with "Allow Delegation" on — so this must be
  // fetched independent of which page is open, not gated on visiting it.
  useEffect(() => {
    if (!role || role === "ADMIN") return;
    api.delegationEligibility()
      .then((r: any) => setDelegationEligible(!!r?.eligible))
      .catch(() => setDelegationEligible(false));
  }, [role]);

  async function updateUserDepartment(userId: string, department: string, divisionId?: string | null, sectionId?: string | null, teamId?: string | null) {
    try {
      const updated: any = await api.updateUserDepartment(userId, { department, division_id: divisionId ?? null, section_id: sectionId ?? null, team_id: teamId ?? null });
      setAdminUsers((current) => current.map((user) => (user.id === userId ? updated : user)));
      if (profile?.id === userId) setProfile(updated);
    } catch (e: any) {
      alert("Error updating department: " + e.message);
    }
  }

  async function saveOrgAssignment() {
    if (!orgAssignModal) return;
    if (!orgAssignSelection.department) { alert("Select a department."); return; }
    setOrgAssignSaving(true);
    try {
      await updateUserDepartment(orgAssignModal.userId, orgAssignSelection.department, orgAssignSelection.divisionId, orgAssignSelection.sectionId, orgAssignSelection.teamId);
      setOrgAssignModal(null);
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setOrgAssignSaving(false);
    }
  }

  async function createDelegation() {
    const delegateId = delegationDelegateId;
    if (!delegateId) {
      alert("Choose a delegate user.");
      return;
    }
    try {
      const payload: any = {
        delegate_id: delegateId,
        from_date: delegationFromDate || undefined,
        to_date: delegationToDate || undefined,
        reason: delegationReason.trim() || undefined,
        comments: delegationComments.trim() || undefined,
        request_types: delegationRequestTypes.length ? delegationRequestTypes : undefined
      };
      if (role === "ADMIN") {
        if (!delegationManagerId) {
          alert("Choose a manager to delegate.");
          return;
        }
        payload.manager_id = delegationManagerId;
      }

      await api.createDelegation(payload);
      setDelegationManagerId("");
      setDelegationDelegateId("");
      setDelegationFromDate("");
      setDelegationToDate("");
      setDelegationReason("");
      setDelegationComments("");
      setDelegationRequestTypes([]);
      setShowCreateDelegationModal(false);
      await loadDelegations();
    } catch (e: any) {
      alert("Error creating delegation: " + e.message);
    }
  }

  async function endDelegation(id: string) {
    const confirmed = await confirmAction({
      title: "End delegation?",
      text: "The delegate will immediately lose manager approval authority.",
      confirmButtonText: "End Delegation"
    });
    if (!confirmed) return;
    try {
      const updated = await api.endDelegation(id);
      setDelegations((current) => current.map((delegation) => (delegation.id === id ? { ...delegation, ...updated } : delegation)));
    } catch (e: any) {
      alert("Error ending delegation: " + e.message);
    }
  }

  async function loadDelegationAudit(id: string) {
    setDelegationAuditLoading(true);
    try {
      setDelegationAudit(await api.delegationAudit(id));
    } catch {
      setDelegationAudit([]);
    } finally {
      setDelegationAuditLoading(false);
    }
  }

  async function loadPaAssignments() {
    setPaAssignmentsLoading(true);
    try {
      const rows = await api.paAssignments();
      setPaAssignmentsList(Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      alert("Error loading PA assignments: " + e.message);
    } finally {
      setPaAssignmentsLoading(false);
    }
  }

  async function createPaAssignment() {
    if (!newPaUserId || !newPaPrincipalUserId) {
      alert("Select both the assistant and the boss they'll submit for.");
      return;
    }
    if (newPaUserId === newPaPrincipalUserId) {
      alert("A person can't be their own PA.");
      return;
    }
    try {
      await api.createPaAssignment(newPaUserId, newPaPrincipalUserId);
      setNewPaUserId("");
      setNewPaPrincipalUserId("");
      await loadPaAssignments();
    } catch (e: any) {
      alert("Error creating PA assignment: " + e.message);
    }
  }

  async function endPaAssignment(id: string) {
    const confirmed = await confirmAction({
      title: "Remove PA assignment?",
      text: "The assistant will no longer be able to submit advance requests for this person.",
      confirmButtonText: "Remove"
    });
    if (!confirmed) return;
    try {
      await api.deletePaAssignment(id);
      setPaAssignmentsList((current) => current.filter((a) => a.id !== id));
    } catch (e: any) {
      alert("Error removing PA assignment: " + e.message);
    }
  }

  function resolveDelegationTypeLabel(code: string): string {
    // Standby roster-creation delegations are created from the Standby
    // module (which supplies the required team_id), not the generic admin
    // "Create Delegation" modal — so this code is deliberately not in
    // DELEGATION_REQUEST_TYPE_OPTIONS (that list doubles as the modal's
    // picker), it's just given a readable label here.
    if (code === "STANDBY_ROSTER") return "Standby Roster Creation";
    return DELEGATION_REQUEST_TYPE_OPTIONS.find((o) => o.value === code)?.label
      || customRequestTypeOptions.find((o) => o.code === code)?.name
      || code;
  }

  async function updateAdminUserRole(userId: string, roleValue: string) {
    try {
      const updated: any = await api.updateUserRole(userId, { role: roleValue });
      setAdminUsers((current) => current.map((user) => (user.id === userId ? updated : user)));
      if (profile?.id === userId) {
        setProfile(updated);
      }
    } catch (e: any) {
      alert("Error updating role: " + e.message);
    }
  }

  async function saveFeaturePermissions() {
    setFeaturePermSaving(true);
    try {
      await api.updateAdminFeaturePermissions(featurePermDraft);
      setFeaturePermissions(featurePermDraft);
      alert("Feature permissions saved.");
    } catch (e: any) {
      alert("Error saving permissions: " + e.message);
    } finally {
      setFeaturePermSaving(false);
    }
  }

  async function loadRecoverySettings() {
    setRecoverySettingsLoading(true);
    try {
      const data: any = await api.advanceRecoverySettings();
      if (data) {
        setRecoveryDurationDraft(String(data.clearance_duration_days ?? 7));
        setRecoveryMonthsDraft(String(data.recovery_months ?? 3));
      }
    } catch (e: any) {
      alert("Error loading recovery settings: " + e.message);
    } finally {
      setRecoverySettingsLoading(false);
    }
  }

  async function saveRecoverySettings() {
    const days = Number(recoveryDurationDraft);
    const months = Number(recoveryMonthsDraft);
    if (!Number.isFinite(days) || days < 1) { alert("Clearance duration must be at least 1 day."); return; }
    if (!Number.isFinite(months) || months < 1) { alert("Recovery months must be at least 1."); return; }
    setRecoverySettingsSaving(true);
    try {
      await api.updateAdvanceRecoverySettings({ clearance_duration_days: days, recovery_months: months });
      alert("Advance recovery settings saved.");
    } catch (e: any) {
      alert("Error saving recovery settings: " + e.message);
    } finally {
      setRecoverySettingsSaving(false);
    }
  }

  // Fetches the values actually enforced by the idle-logout timer - separate
  // from loadSessionSettingsDraft below, which only feeds the admin edit form.
  async function loadActiveSessionSettings() {
    try {
      const data: any = await api.sessionSettings();
      if (data) {
        setIdleTimeoutMinutes(Number(data.idle_timeout_minutes) || 30);
        setWarningSeconds(Number(data.warning_seconds) || 60);
      }
    } catch {
      // Idle-logout is a convenience, not a security boundary - if this
      // fails, just keep the built-in 30-minute default rather than blocking anything.
    }
  }

  async function loadSessionSettingsDraft() {
    setSessionSettingsLoading(true);
    try {
      const data: any = await api.sessionSettings();
      if (data) {
        setIdleTimeoutDraft(String(data.idle_timeout_minutes ?? 30));
        setWarningSecondsDraft(String(data.warning_seconds ?? 60));
      }
    } catch (e: any) {
      alert("Error loading session settings: " + e.message);
    } finally {
      setSessionSettingsLoading(false);
    }
  }

  async function saveSessionSettings() {
    const minutes = Number(idleTimeoutDraft);
    const seconds = Number(warningSecondsDraft);
    if (!Number.isFinite(minutes) || minutes < 1) { alert("Idle timeout must be at least 1 minute."); return; }
    if (!Number.isFinite(seconds) || seconds < 10) { alert("Warning period must be at least 10 seconds."); return; }
    if (seconds >= minutes * 60) { alert("Warning period must be shorter than the idle timeout."); return; }
    setSessionSettingsSaving(true);
    try {
      await api.updateSessionSettings({ idle_timeout_minutes: minutes, warning_seconds: seconds });
      setIdleTimeoutMinutes(minutes);
      setWarningSeconds(seconds);
      lastActivityRef.current = Date.now();
      setShowIdleWarning(false);
      alert("Session timeout settings saved.");
    } catch (e: any) {
      alert("Error saving session settings: " + e.message);
    } finally {
      setSessionSettingsSaving(false);
    }
  }

  async function createDepartment() {
    const name = newDepartmentName.trim();
    if (!name) {
      alert("Enter a department group name.");
      return;
    }
    if (sectionOptions.length > 0 && !newDepartmentSectionId) {
      alert("Choose a section for this department.");
      return;
    }
    try {
      const created: any = await api.createDepartment(
        name,
        newDepartmentSectionId || null,
        newDepartmentManagerId || null,
        newDepartmentExcoId || null,
        newDepartmentActive,
        newDepartmentHodId || null
      );
      setDepartmentOptions((current) => Array.from(new Set([...(current || []), created.name])).sort((a, b) => a.localeCompare(b)));
      setNewDepartmentName("");
      setNewDepartmentSectionId("");
      setNewDepartmentHodId("");
      setNewDepartmentManagerId("");
      setNewDepartmentExcoId("");
      setNewDepartmentActive(true);
      await loadAdminUsers();
      alert(`Division group ${created.name} created.`);
    } catch (e: any) {
      alert("Error creating division: " + e.message);
    }
  }

  async function editDepartment(name: string) {
    // open edit modal populated with department attributes
    const dept = departmentRows.find((d) => d.name === name);
    setEditingDepartmentObj({
      originalName: name,
      name: dept?.name || name,
      section_id: dept?.section_id || null,
      hod_user_id: dept?.hod_user_id || null,
      manager_user_id: dept?.manager_user_id || null,
      exco_user_id: dept?.exco_user_id || null,
      active: typeof dept?.active === 'boolean' ? dept.active : true
    });
  }

  async function deleteDepartment(name: string) {
    const confirmed = await confirmAction({
      title: "Delete division group?",
      text: `Delete '${name}'? This cannot be undone.`,
      confirmButtonText: "Delete"
    });
    if (!confirmed) return;
    try {
      await api.deleteDepartment(name);
      setDepartmentOptions((current) => (current || []).filter((d) => d !== name));
      await loadAdminUsers();
      alert(`Division group ${name} deleted.`);
    } catch (e: any) {
      alert("Error deleting division: " + e.message);
    }
  }

  async function createSection() {
    const name = newSectionName.trim();
    if (!name) {
      alert("Enter a department name.");
      return;
    }

    try {
      const created: any = await api.createSection(name, newSectionExcoId || null);
      setNewSectionName("");
      setNewSectionExcoId("");
      await loadAdminUsers();
      alert(`Department ${created.name} created.`);
    } catch (e: any) {
      alert("Error creating department: " + e.message);
    }
  }

  async function editSection(id: string, currentName: string) {
    // open edit modal for section
    const section = sectionOptions.find((s) => s.id === id);
    setEditingSectionObj({ id, name: section?.name || currentName, exco_user_id: section?.exco_user_id || null });
  }

  async function deleteSection(id: string, name: string) {
    const confirmed = await confirmAction({
      title: "Delete department?",
      text: `Delete '${name}'? This cannot be undone.`,
      confirmButtonText: "Delete"
    });
    if (!confirmed) return;
    try {
      await api.deleteSection(id);
      await loadAdminUsers();
      alert(`Department ${name} deleted.`);
    } catch (e: any) {
      alert("Error deleting department: " + e.message);
    }
  }

  async function updateDepartmentSection(department: string, sectionId: string) {
    try {
      await api.updateDepartment(department, { name: department, section_id: sectionId || null });
      await loadAdminUsers();
    } catch (e: any) {
      alert("Error updating department section: " + e.message);
    }
  }

  async function updateDepartmentLeadership(department: any, changes: { hod_user_id?: string | null; manager_user_id?: string | null; exco_user_id?: string | null; active?: boolean }) {
    try {
      updateDepartmentRow(department.name, changes);
      await api.updateDepartment(department.name, { name: department.name, ...changes });
      await loadAdminUsers();
    } catch (e: any) {
      await loadAdminUsers();
      alert("Error updating department leadership: " + e.message);
    }
  }

  async function updateSectionLeadership(section: any, excoUserId: string | null) {
    try {
      setSectionOptions((current) => current.map((item) => (
        item.id === section.id ? { ...item, exco_user_id: excoUserId } : item
      )));
      await api.updateSection(section.id, { name: section.name, exco_user_id: excoUserId });
      await loadAdminUsers();
    } catch (e: any) {
      await loadAdminUsers();
      alert("Error updating section owner: " + e.message);
    }
  }

  async function submitEditDepartment() {
    if (!editingDepartmentObj) return;
    const payload: any = {
      name: editingDepartmentObj.name.trim(),
      section_id: editingDepartmentObj.section_id || null,
      hod_user_id: editingDepartmentObj.hod_user_id || null,
      manager_user_id: editingDepartmentObj.manager_user_id || null,
      exco_user_id: editingDepartmentObj.exco_user_id || null,
      active: !!editingDepartmentObj.active
    };
    if (!payload.name) return alert('Enter a division name.');
    try {
      const updated: any = await api.updateDepartment(editingDepartmentObj.originalName, payload);
      setEditingDepartmentObj(null);
      await loadAdminUsers();
      alert(`Division updated: ${updated.name || payload.name}`);
    } catch (e: any) {
      alert('Error updating division: ' + e.message);
    }
  }

  function cancelEditDepartment() {
    setEditingDepartmentObj(null);
  }

  async function submitEditSection() {
    if (!editingSectionObj) return;
    const payload: any = { name: editingSectionObj.name.trim(), exco_user_id: editingSectionObj.exco_user_id || null };
    if (!payload.name) return alert('Enter a department name.');
    try {
      const updated: any = await api.updateSection(editingSectionObj.id, payload);
      setEditingSectionObj(null);
      await loadAdminUsers();
      alert(`Department updated: ${updated.name || payload.name}`);
    } catch (e: any) {
      alert('Error updating department: ' + e.message);
    }
  }

  function cancelEditSection() {
    setEditingSectionObj(null);
  }

  async function showAdvanceHistory(advanceId: string) {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryAdvanceId(advanceId);
    setHistoryAdvanceDetail(advances.find((advance: any) => advance.id === advanceId) || null);
    setHistoryEvents([]);
    try {
      const [detail, events] = await Promise.all([
        api.advanceDetail(advanceId).catch(() => advances.find((advance: any) => advance.id === advanceId) || null),
        api.advanceHistory(advanceId)
      ]);
      setHistoryAdvanceDetail(detail);
      setHistoryEvents(events);
    } catch (e: any) {
      setHistoryEvents([{ error: e.message }]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function showClearanceTracking(claimId: string) {
    setClearanceTrackOpen(true);
    setClearanceTrackLoading(true);
    setClearanceTrackId(claimId);
    setClearanceTrackDetail(claims.find((claim: any) => claim.id === claimId) || null);
    try {
      const detail = await api.claimDetail(claimId);
      setClearanceTrackDetail(detail);
    } catch (e: any) {
      // fall back to the list-row data already set above
    } finally {
      setClearanceTrackLoading(false);
    }
  }

  async function submitPaybackProofForTracking() {
    const claimId = clearanceTrackId;
    if (!claimId) return;
    if (!paybackProofForm.file) { alert("A proof attachment is required."); return; }
    if (!paybackProofForm.amount_paid || !paybackProofForm.payment_date) { alert("Amount paid and payment date are required."); return; }
    setPaybackProofSubmitting(true);
    try {
      const form = new FormData();
      form.append("file", paybackProofForm.file);
      form.append("amount_paid", paybackProofForm.amount_paid);
      form.append("payment_date", paybackProofForm.payment_date);
      if (paybackProofForm.reference) form.append("reference", paybackProofForm.reference);
      if (paybackProofForm.comment) form.append("comment", paybackProofForm.comment);
      await api.submitPaybackProof(claimId, form);
      setPaybackProofForm({ amount_paid: "", payment_date: "", reference: "", comment: "", file: null });
      const detail = await api.claimDetail(claimId);
      setClearanceTrackDetail(detail);
      alert("Payback proof submitted. HR Operations will review it.");
    } catch (e: any) {
      alert("Error submitting payback proof: " + e.message);
    } finally {
      setPaybackProofSubmitting(false);
    }
  }

  async function editClearance(claimId: string) {
    try {
      const detail: any = await api.claimDetail(claimId);
      populateClearanceForm(detail);
      setPage("CLEARANCE");
    } catch (e: any) {
      alert("Error loading clearance: " + e.message);
    }
  }

  function startClearanceForAdvance(advanceId: string) {
    resetClearanceForm();
    setClearanceLinkedAdvanceId(advanceId);
    setPage("CLEARANCE");
  }

  function startNewClearance() {
    if (newClearanceAdvanceOptions.length === 0) {
      alert("No paid travel advance is available to clear yet.");
      return;
    }
    resetClearanceForm();
    setPage("CLEARANCE");
  }

  function startNewAdvanceRequest() {
    setEditingAdvanceId(null);
    setEditingAdvanceStatus(null);
    setRequestForUserId(profile?.id || me?.userId || "");
    setRequesterName(profile?.full_name || me?.fullName || me?.username || "");
    setEmpNumber(profile?.employee_no || me?.employeeNo || "");
    setAdvanceType(null);
    setSalaryAmount("0");
    setSalaryPaybackDuration("");
    setLoanPaybackDuration("");
    setLoanAmount("");
    setIsApplyForOther(false);
    setOtherAmount("");
    setOtherStartDate("");
    setOtherFinishDate("");
    setExternalBeneficiaryId("");
    setShowNewExternalPayeeForm(false);
    setNewPayeeName("");
    setNewPayeeCategory("");
    setNewPayeeOrg("");
    setNewPayeeContact("");
    setExtraCostAmount("");
    setExtraCostDescription("");
    setPaymentMethod("ECOCASH");
    setEcocashNumber("");
    setBankName("");
    setBankAccountNumber("");
    setBankBranch("");
    setPurpose("");
    setRequestDate(new Date().toISOString().slice(0, 10));
    setRows([]);
    setAccommodationHotelChoices({});
    setMonthField("");
    setCustomApprovalChain([]);
    setCustomChainLabel("");
    setCustomChainUserId("");
    setChainPositionSearches({});
    setChainPositionTypes([]);
    setPage("ADVANCE");
  }

  function advanceStageLabel(advance: any) {
    const status = advance?.status;
    if (status === "DRAFT") return "Draft (not submitted)";
    if (status === "PAID") return "Completed";
    if (status === "CANCELLED") return "Cancelled";
    if (status === "REJECTED") return "Rejected";
    // status often still reads a stale pre-approval bucket (e.g. "SUBMITTED")
    // once a workflow-driven advance has moved past approval into
    // Accommodation/Capture/Payment - see isAdvancePastApproval.
    if (isAdvancePastApproval(advance)) return "Approved — Awaiting Payment";
    switch (status) {
      case "SUBMITTED":         return "Pending Approval";
      case "COUNTERSIGNED":     return "Pending HOD / EXCO Approval";
      case "HR_OFFICER":        return "Pending Finance Payment";
      case "APPROVED":          return "Approved — Awaiting Payment";
      default:                  return humanizeToken(status);
    }
  }

  function clearanceStageLabel(claim: any) {
    const status = typeof claim === "string" ? claim : claim?.status;
    switch (status) {
      case "DRAFT":
        return "Draft clearance";
      case "SETTLED":
      case "CLOSED":
        return "Cleared";
      case "REJECTED":
        return "Rejected";
    }

    if (claim && typeof claim === "object" && Array.isArray(claim.approval_chain) && claim.approval_chain.length > 0) {
      const chain = claim.approval_chain;
      const stepIdx = typeof claim.workflow_step_order === "number" ? claim.workflow_step_order : 0;
      const step = chain[stepIdx];
      if (step) {
        return `Waiting on ${(step.position_name && displayOrgGroupName(step.position_name)) || step.approver_title || "Approver"}`;
      }
    }

    switch (status) {
      case "SUBMITTED":
        return "Waiting Manager Certification";
      case "MANAGER_APPROVED":
      case "EXCO_APPROVED":
        return "Pending Approval";
      case "HR_OFFICER":
        return "Waiting Finance Verification";
      case "FINANCE_VERIFIED":
        return "Waiting Finance Settlement";
      default:
        return status;
    }
  }

  function humanizeToken(value: any) {
    const abbrevs = new Set(["HR", "HOD", "EXCO", "CEO", "CFO", "COO", "SLA", "ID"]);
    const text = String(value || "—").replace(/_/g, " ");
    return text.replace(/\b\w+\b/g, (word) => {
      const up = word.toUpperCase();
      return abbrevs.has(up) ? up : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
  }

  // Clearance status is a compact summary of the configured workflow's progress.
  function humanizeClaimStatus(value: any) {
    if (value === "EXCO_APPROVED") return "Pending Approval";
    return humanizeToken(value);
  }

  // Employee-facing labels for the trip-completion clearance outcome
  // statuses - deliberately distinct from raw enum values, per spec.
  const CLEARANCE_OUTCOME_LABELS: Record<string, string> = {
    FULLY_CLEARED: "Fully Cleared",
    COMPLETED: "Fully Cleared",
    REFUND_DUE: "Refund Due to You",
    PAYBACK_DUE: "Payback Required",
    PAYBACK_PROOF_SUBMITTED: "Payback Proof Under Review",
    PAYBACK_PROOF_REJECTED: "Payback Proof Rejected",
    FINANCE_TREASURY_REVIEW: "Fully Cleared — With Finance Treasury"
  };
  function clearanceOutcomeStatusLabel(value: any) {
    const status = String(value || "").toUpperCase();
    return CLEARANCE_OUTCOME_LABELS[status] || humanizeClaimStatus(status);
  }

  function formatTrackingDate(value: any, includeTime = true) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {})
    });
  }

  function requestNumber(advance: any) {
    const created = new Date(advance?.created_at || Date.now());
    const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear();
    const digits = String(advance?.id || "").replace(/\D/g, "").slice(-5);
    const fallback = String(advance?.id || "00000").replace(/-/g, "").slice(0, 5).toUpperCase();
    return `ADV-${year}-${(digits || fallback || "00000").padStart(5, "0")}`;
  }

  function claimNumber(claim: any) {
    const created = new Date(claim?.created_at || Date.now());
    const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear();
    const digits = String(claim?.id || "").replace(/\D/g, "").slice(-5);
    const fallback = String(claim?.id || "00000").replace(/-/g, "").slice(0, 5).toUpperCase();
    return `CL-${year}-${(digits || fallback || "00000").padStart(5, "0")}`;
  }

  function statusToneClass(value: any) {
    const status = String(value || "").toUpperCase();
    if (["REJECTED", "CANCELLED"].includes(status) || status.includes("REJECT")) return "tracking-tone-danger";
    if (["PAID", "APPROVED", "HR_OFFICER", "COMPLETED", "FINANCE_TREASURY_REVIEW"].includes(status)) return "tracking-tone-success";
    if (["DRAFT"].includes(status)) return "tracking-tone-neutral";
    return "tracking-tone-progress";
  }

  function eventStatus(event: any) {
    return event?.after_json?.status || event?.before_json?.status || "";
  }

  function eventActor(event: any) {
    if (!event?.actor_name) return "System";
    return `${event.actor_name}${event.actor_role ? ` (${humanizeToken(event.actor_role)})` : ""}`;
  }

  function eventForTransition(events: any[], beforeStatuses: string[], afterStatuses: string[]) {
    return events.find((event: any) => {
      const before = String(event?.before_json?.status || "").toUpperCase();
      const after = String(event?.after_json?.status || "").toUpperCase();
      return String(event?.action || "") === "ADVANCE_APPROVE" && beforeStatuses.includes(before) && afterStatuses.includes(after);
    });
  }

  async function downloadAdvancePdf(advanceId: string) {
    try {
      await openBlobInNewTab(() => api.advancePdf(advanceId));
    } catch (err: any) {
      alert(err?.message || "Failed to generate PDF.");
    }
  }

  async function openPdfBlob(fetcher: () => Promise<Blob>) {
    try {
      await openBlobInNewTab(fetcher);
    } catch (err: any) {
      void showNotice(err?.message || "Failed to generate PDF.");
    }
  }
  const downloadClaimPdf = (id: string) => openPdfBlob(() => api.claimPdf(id));
  const downloadAccommodationPdf = (id: string) => openPdfBlob(() => api.accommodationPdf(id));
  const downloadCustomRequestPdf = (id: string) => openPdfBlob(() => api.customRequestPdf(id));

  function buildTrackingStages(advance: any, events: any[]) {
    const currentStatus = String(advance?.status || "DRAFT").toUpperCase();
    const terminalFailed = ["REJECTED", "CANCELLED"].includes(currentStatus);
    const terminalDone   = ["APPROVED", "PAID"].includes(currentStatus);

    const createEvent = events.find((e: any) => e.action === "ADVANCE_CREATE");
    const submitEvent = events.find((e: any) => e.action === "ADVANCE_SUBMIT");
    const paidEvent   = events.find((e: any) => e.action === "ADVANCE_MARK_PAID" || e?.after_json?.status === "PAID");

    // ── Workflow-driven tracking ───────────────────────────────────────────────
    if (Array.isArray(advance?.approval_chain) && advance.approval_chain.length > 0) {
      const chain: any[] = advance.approval_chain;
      const currentStepIdx: number =
        typeof advance.workflow_step_order === "number" ? advance.workflow_step_order : 0;

      const stages: any[] = [
        {
          key: "draft",
          label: "Draft",
          state: "done",
          date: createEvent?.created_at || advance?.created_at || "",
          actor: createEvent?.actor_name || "",
          status: "Created"
        },
        {
          key: "submitted",
          label: "Submitted",
          state: currentStatus === "DRAFT" ? "waiting" : "done",
          date: submitEvent?.created_at || advance?.submitted_at || "",
          actor: submitEvent?.actor_name || "",
          status: currentStatus === "DRAFT" ? "Waiting" : "Submitted"
        }
      ];

      // The pending "stage" is the current step plus any subsequent steps
      // flagged parallel_with_previous — they become actionable together.
      let pendingStageStart = currentStepIdx;
      while (pendingStageStart > 0 && chain[pendingStageStart]?.parallel_with_previous) pendingStageStart--;
      const pendingStage = new Set<number>();
      if (pendingStageStart < chain.length) {
        pendingStage.add(pendingStageStart);
        for (let i = pendingStageStart + 1; i < chain.length && chain[i]?.parallel_with_previous; i++) pendingStage.add(i);
      }

      chain.forEach((step: any, idx: number) => {
        // Match the approve audit event that advanced past this step (workflow_step === idx + 1)
        const approveEvent = events.find(
          (e: any) => e.action === "ADVANCE_APPROVE" && Number(e?.after_json?.workflow_step ?? -1) === idx + 1
        ) ?? null;
        const stepApproved = Boolean(step.approved);
        // A requires_accommodation step is parallel/non-blocking (see
        // workflowEngine.ts's findPendingAccommodationStep) - the workflow's
        // step-order pointer can move past it once Capture/payment complete
        // while it's still genuinely unbooked, so "pointer index passed
        // this step" is not a reliable done-signal for it the way it is for
        // every other step. Without this guard, an unbooked accommodation
        // step showed as done/"Booked" once payment went through.
        const isDone   = terminalDone || stepApproved || (currentStepIdx > idx && !step.requires_accommodation);
        const isActive = !terminalFailed && !isDone && pendingStage.has(idx);
        const isSkipped = step.skipIfUnassigned && !step.approver_name && !stepApproved;
        // "Team: X" steps are approvable by any member of that group, not the
        // specific individual returned as approver_name/approver_title (the
        // department HOD) — show the group name instead, with no fixed actor.
        const isTeamGroup = typeof step.position_name === "string" && step.position_name.startsWith("Team: ");
        // Show the assigned approver's real job title instead of the generic
        // workflow step name (e.g. "Manager"/"Head of Department") - a senior
        // title like GM being labeled down to "Manager" misrepresents who
        // actually holds approval authority here. Group/team steps and steps
        // with no approver on record still fall back to the workflow label.
        const label = !isTeamGroup && step.approver_title
          ? step.approver_title
          : step.position_name ? displayOrgGroupName(step.position_name) : step.approver_title;
        const actorName = isTeamGroup ? "" : (approveEvent?.actor_name || step.approver_name || "");
        stages.push({
          key: `step-${idx}`,
          label,
          state: isSkipped ? "done" : terminalFailed && isActive ? "danger" : isActive ? "active" : isDone ? "done" : "waiting",
          date: approveEvent?.created_at || "",
          actor: actorName,
          status: isSkipped ? "Skipped (no approver assigned)" : isActive ? "In Progress" : isDone ? stepDoneStatusLabel(step.action_type) : "Waiting",
          tooltip: isSkipped ? "This step was automatically skipped because no approver was assigned and the step is configured to skip if unassigned." : undefined
        });
      });

      const paidState = currentStatus === "PAID" ? "done" : currentStatus === "APPROVED" ? "active" : "waiting";
      stages.push({
        key: "paid",
        label: "Paid",
        state: paidState,
        date: paidEvent?.created_at || advance?.paid_at || "",
        actor: paidEvent?.actor_name || "",
        status: currentStatus === "PAID" ? "Completed" : "Waiting"
      });

      if (terminalFailed) {
        const failedEvent = events.find((e: any) => ["ADVANCE_REJECT", "ADVANCE_CANCEL"].includes(String(e.action || "")));
        stages.push({
          key: "closed",
          label: humanizeToken(currentStatus),
          state: "danger",
          date: failedEvent?.created_at || advance?.updated_at,
          actor: failedEvent?.actor_name || "",
          status: humanizeToken(currentStatus)
        });
      }
      return stages;
    }

    // ── Legacy (no workflow chain) — keep existing stage logic ─────────────────
    const managerEvent  = eventForTransition(events, ["SUBMITTED"], ["COUNTERSIGNED", "HR_OFFICER"]);
    const hodEvent      = eventForTransition(events, ["COUNTERSIGNED"], ["HR_OFFICER"]);
    const financeEvent  = eventForTransition(events, ["HR_OFFICER", "APPROVED"], ["APPROVED", "PAID"]);

    const managerDest = String(managerEvent?.after_json?.status || "").toUpperCase();
    const throughCountersigned = managerDest === "COUNTERSIGNED" || currentStatus === "COUNTERSIGNED";
    const skippedMiddle = Boolean(managerEvent) && !throughCountersigned;

    const order: Record<string, number> = {
      DRAFT: 0, SUBMITTED: 1, COUNTERSIGNED: 2,
      HR_OFFICER: 3, APPROVED: 4, PAID: 5
    };
    const currentOrder = order[currentStatus] ?? (terminalFailed ? -1 : 0);

    const stage = (key: string, label: string, pendingStatuses: string[], doneOrder: number, event: any, fallbackDate?: any) => {
      const active = pendingStatuses.includes(currentStatus);
      const done = Boolean(event) || currentOrder >= doneOrder;
      return {
        key, label,
        state: terminalFailed && active ? "danger" : active ? "active" : done ? "done" : "waiting",
        date: event?.created_at || fallbackDate || "",
        actor: event?.actor_name || "",
        status: active ? "In Progress" : done ? "Approved" : "Waiting"
      };
    };

    const stages: any[] = [
      stage("draft", "Draft", ["DRAFT"], 0, createEvent, advance?.created_at),
      {
        ...stage("submitted", "Submitted", [], 1, submitEvent, advance?.submitted_at),
        state: currentStatus === "DRAFT" ? "waiting" : "done",
        status: currentStatus === "DRAFT" ? "Waiting" : "Submitted"
      },
      stage("manager", "Manager Approval", ["SUBMITTED"], 1, managerEvent)
    ];

    if (throughCountersigned) {
      stages.push(stage("hod", "HOD / EXCO Approval", ["COUNTERSIGNED"], 2, hodEvent));
    } else if (!skippedMiddle) {
      stages.push(stage("hod", "HOD / EXCO Approval", ["COUNTERSIGNED"], 2, null));
    }

    stages.push(
      stage("finance", "Finance Approval", ["HR_OFFICER", "APPROVED"], 3, financeEvent),
      {
        ...stage("paid", "Paid", ["PAID"], 7, paidEvent, advance?.paid_at),
        status: currentStatus === "PAID" ? "Completed" : "Waiting"
      }
    );

    if (terminalFailed) {
      const failedEvent = events.find((e: any) => ["ADVANCE_REJECT", "ADVANCE_CANCEL"].includes(String(e.action || "")));
      stages.push({
        key: "closed",
        label: humanizeToken(currentStatus),
        state: "danger",
        date: failedEvent?.created_at || advance?.updated_at,
        actor: failedEvent?.actor_name || "",
        status: humanizeToken(currentStatus)
      });
    }

    return stages;
  }

  function buildClearanceTrackingStages(claim: any) {
    const currentStatus = String(claim?.status || "DRAFT").toUpperCase();
    const terminalFailed = currentStatus === "REJECTED";
    const terminalDone = currentStatus === "SETTLED" || currentStatus === "CLOSED" || currentStatus === "COMPLETED";
    // A trip-completion outcome claim (see claims.service.ts's
    // computeFinancialOutcome) has already finished its own approval chain
    // by the time it reaches any of these - show the final stage as
    // in-progress with HR/Treasury rather than a plain "Waiting" that reads
    // as nothing having happened yet.
    const outcomeInProgress = ["REFUND_DUE", "PAYBACK_DUE", "PAYBACK_PROOF_SUBMITTED", "PAYBACK_PROOF_REJECTED", "FINANCE_TREASURY_REVIEW"].includes(currentStatus);
    const chain: any[] = Array.isArray(claim?.approval_chain) ? claim.approval_chain : [];

    const stages: any[] = [
      {
        key: "draft",
        label: "Draft",
        state: "done",
        actor: "",
        status: "Created"
      },
      {
        key: "submitted",
        label: "Submitted",
        state: currentStatus === "DRAFT" ? "waiting" : "done",
        actor: claim?.requester_name || claim?.claimant_name || "",
        status: currentStatus === "DRAFT" ? "Waiting" : "Submitted"
      }
    ];

    if (chain.length > 0) {
      const currentStepIdx = typeof claim.workflow_step_order === "number" ? claim.workflow_step_order : 0;
      let pendingStageStart = currentStepIdx;
      while (pendingStageStart > 0 && chain[pendingStageStart]?.parallel_with_previous) pendingStageStart--;
      const pendingStage = new Set<number>();
      if (pendingStageStart < chain.length) {
        pendingStage.add(pendingStageStart);
        for (let i = pendingStageStart + 1; i < chain.length && chain[i]?.parallel_with_previous; i++) pendingStage.add(i);
      }
      chain.forEach((step: any, idx: number) => {
        const stepApproved = Boolean(step.approved);
        // See buildTrackingStages's identical guard - a requires_accommodation
        // step can be parallel/non-blocking, so the pointer moving past it is
        // not a reliable done-signal on its own.
        const isDone = terminalDone || stepApproved || (currentStepIdx > idx && !step.requires_accommodation);
        const isActive = !terminalFailed && !isDone && pendingStage.has(idx);
        const isTeamGroup = typeof step.position_name === "string" && step.position_name.startsWith("Team: ");
        // Show the assigned approver's real job title instead of the generic
        // workflow step name - see buildTrackingStages for why.
        const label = !isTeamGroup && step.approver_title
          ? step.approver_title
          : step.position_name ? displayOrgGroupName(step.position_name) : step.approver_title;
        const actorName = isTeamGroup ? "" : (step.approver_name || "");
        stages.push({
          key: `step-${idx}`,
          label,
          state: terminalFailed && isActive ? "danger" : isActive ? "active" : isDone ? "done" : "waiting",
          actor: actorName,
          status: isActive ? "In Progress" : isDone ? stepDoneStatusLabel(step.action_type) : "Waiting"
        });
      });
    }

    stages.push({
      key: "settled",
      label: currentStatus === "SETTLED" ? "Settled" : currentStatus === "COMPLETED" ? "Completed" : outcomeInProgress ? "Finance Treasury" : "Closed",
      state: terminalDone ? "done" : outcomeInProgress ? "active" : "waiting",
      actor: "",
      status: terminalDone ? "Completed" : outcomeInProgress ? clearanceOutcomeStatusLabel(currentStatus) : "Waiting"
    });

    if (terminalFailed) {
      stages.push({
        key: "closed",
        label: "Rejected",
        state: "danger",
        actor: "",
        status: "Rejected"
      });
    }

    return stages;
  }

  function parsePaymentAccount(method: "ECOCASH" | "BANK", raw: string) {
    if (method === "BANK") {
      const m = /^BANK:(.*);ACCOUNT:(.*);BRANCH:(.*)$/.exec(String(raw || ""));
      if (m) {
        return { bank_name: m[1], bank_account_number: m[2], bank_branch: m[3], ecocash_number: "" };
      }
      return { bank_name: "", bank_account_number: raw || "", bank_branch: "", ecocash_number: "" };
    }
    return { bank_name: "", bank_account_number: "", bank_branch: "", ecocash_number: raw || "" };
  }

  function travelMetaFromLine(line: any) {
    if (!line?.travel_meta) return {};
    if (typeof line.travel_meta === "string") {
      try {
        return JSON.parse(line.travel_meta);
      } catch {
        return {};
      }
    }
    return line.travel_meta || {};
  }

  function travelRowFromLine(line: any): TravelRow {
    const meta = travelMetaFromLine(line);
    const rawLocation = String(line.location || "").trim();
    const parts = rawLocation.includes("→")
      ? rawLocation.split("→").map((part) => part.trim())
      : rawLocation.includes("->")
        ? rawLocation.split("->").map((part) => part.trim())
        : [rawLocation, rawLocation];
    return {
      date: normalizeDateInputValue(line.line_date),
      startDistrict: meta.startDistrict || meta.start_district || parts[0] || "",
      destinationDistrict: meta.destinationDistrict || meta.destination_district || parts[1] || parts[0] || "",
      country: meta.country || "",
      province: meta.province || "",
      city: meta.city || "",
      meals: advanceLineMealCount(line)
    };
  }

  function populateAdvanceForm(detail: any, fallback: any = {}) {
    setEditingAdvanceId(detail.id || fallback.id || null);
    setEditingAdvanceStatus(detail.status || fallback.status || null);
    setAdvanceType(detail.type || null);
    setSalaryAmount(detail.type === "SALARY" ? String(detail.requested_total || 0) : "0");
    setLoanAmount(detail.type === "LOAN" ? String(detail.requested_total || 0) : "");
    setIsApplyForOther(Boolean(detail.external_beneficiary_id));
    setOtherAmount(detail.external_beneficiary_id ? String(detail.requested_total || 0) : "");
    setOtherStartDate(detail.external_start_date || "");
    setOtherFinishDate(detail.external_end_date || "");
    setExternalBeneficiaryId(detail.external_beneficiary_id ? String(detail.external_beneficiary_id) : "");
    if (detail.external_beneficiary_id) {
      api.externalPayees().then(setExternalPayees).catch(() => setExternalPayees([]));
    }
    setExtraCostAmount(Number(detail.extra_cost_amount || 0) > 0 ? String(detail.extra_cost_amount) : "");
    setExtraCostDescription(detail.extra_cost_description || "");
    setRows(detail.lines ? detail.lines.map((line: any) => travelRowFromLine(line)) : []);
    setAccommodationHotelChoices(
      (detail.lines || []).reduce((acc: Record<string, string>, line: any) => {
        const meta = travelMetaFromLine(line);
        const destination = meta.destinationDistrict || meta.destination_district || "";
        if (destination && meta.hotel) acc[destination] = meta.hotel;
        return acc;
      }, {})
    );
    setMonthField(detail.salary_month || "");
    setSalaryPaybackDuration(detail.type === "SALARY" && detail.payback_months ? String(detail.payback_months) : "");
    setLoanPaybackDuration(detail.type === "LOAN" && detail.payback_months ? String(detail.payback_months) : "");
    setPaymentMethod((detail.payment_method === "BANK" ? "BANK" : "ECOCASH"));
    const parsedPayment = parsePaymentAccount((detail.payment_method === "BANK" ? "BANK" : "ECOCASH"), detail.payment_account || "");
    setEcocashNumber(parsedPayment.ecocash_number);
    setBankName(parsedPayment.bank_name);
    setBankAccountNumber(parsedPayment.bank_account_number);
    setBankBranch(parsedPayment.bank_branch);
    setPurpose(detail.purpose || "");
    setRequesterName(detail.requester_name || "");
    setEmpNumber(detail.requester_employee_no || detail.emp_number || "");
    setRequestForUserId(detail.requester_id || profile?.id || me?.userId || "");
    setRequestDate(normalizeDateInputValue(detail.created_at) || new Date().toISOString().slice(0, 10));
  }

  function isAtLeastManagerReviewed(status: string | null) {
    return status === "HR_OFFICER" || status === "APPROVED" || status === "PAID";
  }

  function isAtLeastApproved(status: string | null) {
    return status === "HR_OFFICER" || status === "APPROVED" || status === "PAID";
  }

  function resetClearanceForm() {
    setEditingClaimId(null);
    setClearanceMonth("");
    setClearanceDutyStation("");
    setClearanceProjectNumber("");
    setClearanceVehicleReg("");
    setClearanceVehicleType("");
    setClearanceEngineCc("");
    setClearanceVehicleRate("");
    setClearanceLinkedAdvanceId("");
    setClearanceTrips([emptyClearanceTripRow()]);
    setClearanceReceipts([]);
    setClearanceSourceLines([]);
    setClearanceReasonForOverspend("");
    setClearanceExtraCostAmount("");
    setClearanceExtraCostDescription("");
  }

  function populateClearanceForm(detail: any) {
    setEditingClaimId(detail.id);
    setClearanceMonth(detail.month || "");
    setClearanceDutyStation(detail.duty_station || "");
    setClearanceProjectNumber(detail.project_number || "");
    setClearanceVehicleReg(detail.vehicle_reg || "");
    setClearanceVehicleType(detail.vehicle_type || "");
    setClearanceEngineCc(detail.engine_cc || "");
    setClearanceVehicleRate(detail.vehicle_rate != null ? String(detail.vehicle_rate) : "");
    setClearanceLinkedAdvanceId(detail.linked_advance_id || "");
    setClearanceTrips(
      Array.isArray(detail.trips) && detail.trips.length
        ? detail.trips.map((t: any) => ({
            ...emptyClearanceTripRow(normalizeDateInputValue(t.trip_date)),
            from_place: t.from_place || "",
            lunch: Number(t.lunch || 0),
            petrol_allowance: Number(t.petrol_allowance || 0),
            other_expenses: Number(t.other_expenses || 0),
            purpose: t.purpose || ""
          }))
        : [emptyClearanceTripRow()]
    );
    setClearanceReceipts(detail.receipts || []);
    setClearanceReasonForOverspend(detail.reason_for_overspend || "");
    setClearanceExtraCostAmount(Number(detail.extra_cost_amount || 0) > 0 ? String(detail.extra_cost_amount) : "");
    setClearanceExtraCostDescription(detail.extra_cost_description || "");
  }

  function updateClearanceTrip(index: number, patch: Partial<ClearanceTripRow>) {
    setClearanceTrips((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addClearanceTrip() {
    setClearanceTrips((prev) => [...prev, { ...emptyClearanceTripRow(), __editing: true }]);
  }

  function toggleClearanceTripEdit(index: number) {
    setClearanceTrips((prev) => prev.map((row, i) => (i === index ? { ...row, __editing: !row.__editing } : row)));
  }

  function removeClearanceTrip(index: number) {
    setClearanceTrips((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function buildClearancePayload(options?: { requireSettlementDetails?: boolean }) {
    const requireSettlementDetails = Boolean(options?.requireSettlementDetails);
    const monthValue = clearanceMonth.trim();
    const dutyStationValue = clearanceDutyStation.trim();
    const projectNumberValue = clearanceProjectNumber.trim();
    const vehicleRegValue = clearanceVehicleReg.trim();
    const vehicleTypeValue = clearanceVehicleType.trim();
    const engineCcValue = clearanceEngineCc.trim();

    if (!clearanceLinkedAdvanceId) {
      alert("Select the paid travel advance being cleared.");
      return null;
    }
    if (!selectedClearanceAdvance) {
      alert("The selected advance is not available for clearance.");
      return null;
    }
    if (!monthValue) {
      alert("Month is required.");
      return null;
    }
    if (clearanceTrips.length < 1) {
      alert("Add at least one trip line with the actual expenditure.");
      return null;
    }
    if (clearanceTotals.total <= 0) {
      alert("Total actual expenditure must be greater than 0.");
      return null;
    }
    // Negative balance means actual expenditure exceeded the advance (the
    // company owes the employee) — an explanation is required before submit.
    if (requireSettlementDetails && clearanceBalance < 0 && !clearanceReasonForOverspend.trim()) {
      alert("Please provide a reason for the overspend before submitting.");
      return null;
    }

    return {
      month: monthValue,
      duty_station: dutyStationValue || undefined,
      project_number: projectNumberValue || undefined,
      vehicle_reg: vehicleRegValue || undefined,
      vehicle_type: vehicleTypeValue || undefined,
      engine_cc: engineCcValue || undefined,
      vehicle_rate: clearanceVehicleRate ? Number(clearanceVehicleRate) || 0 : undefined,
      linked_advance_id: clearanceLinkedAdvanceId,
      reason_for_overspend: clearanceBalance < 0 ? (clearanceReasonForOverspend.trim() || undefined) : undefined
    };
  }

  async function persistClearance(submitAfterSave: boolean, options?: { silent?: boolean; refreshAfterSave?: boolean }) {
    if (submitAfterSave && clearanceExtraCost > 0 && !clearanceExtraCostDescription.trim()) {
      alert("Please provide a justification for the extra cost before submitting.");
      return null;
    }
    const payload = buildClearancePayload({ requireSettlementDetails: submitAfterSave });
    if (!payload) return null;
    const silent = Boolean(options?.silent);
    const refreshAfterSave = options?.refreshAfterSave ?? true;

    try {
      let claimId = editingClaimId;
      if (claimId) {
        await api.updateClaim(claimId, payload);
      } else {
        const created: any = await api.createClaim(payload);
        claimId = created.id;
        setEditingClaimId(claimId);
      }

      // Persist the employee's actual per-trip expenditure (overrides the
      // advance-synced lines so claim_total/balance reflect what was really
      // spent). Must run after create/update and before submit.
      await api.updateClaimTrips(claimId!, {
        trips: clearanceTrips.map((row) => ({
          trip_date: row.trip_date,
          from_place: row.from_place || undefined,
          to_place: row.to_place || undefined,
          depart_time: row.depart_time || undefined,
          arrive_time: row.arrive_time || undefined,
          km_travelled: Number(row.km_travelled) || 0,
          petrol_allowance: Number(row.petrol_allowance) || 0,
          breakfast: Number(row.breakfast) || 0,
          lunch: Number(row.lunch) || 0,
          dinner: Number(row.dinner) || 0,
          other_expenses: Number(row.other_expenses) || 0,
          purpose: row.purpose || undefined
        })),
        extra_cost_amount: clearanceExtraCost,
        extra_cost_description: clearanceExtraCostDescription.trim() || undefined
      });

      if (submitAfterSave) {
        await api.submitClaim(claimId!);
        if (!silent) void Swal.fire({ icon: "success", title: "Clearance Submitted", text: "Your clearance has been submitted for approval.", timer: 1800, showConfirmButton: false });
        resetClearanceForm();
        if (refreshAfterSave) await refresh();
        setPage("MY_CLEARANCES");
        return claimId;
      }

      if (refreshAfterSave) await refresh();
      if (!silent) void Swal.fire({ icon: "success", title: "Draft Saved", timer: 1200, showConfirmButton: false });
      return claimId;
    } catch (e: any) {
      alert("Error saving clearance: " + e.message);
      return null;
    }
  }

  async function uploadClearanceReceipts(files: File[], category?: string) {
    if (files.length === 0) return;

    try {
      const hadDraft = Boolean(editingClaimId);
      const claimId = editingClaimId || await persistClearance(false, { silent: true, refreshAfterSave: false });
      if (!claimId) return;

      const uploadedReceipts: any[] = [];
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        if (category) form.append("category", category);
        const result: any = await api.uploadClaimReceipt(claimId, form);
        if (result?.receipt) uploadedReceipts.push(result.receipt);
      }

      if (uploadedReceipts.length > 0) {
        setClearanceReceipts((current) => [...current, ...uploadedReceipts]);
      }
      await refresh();
      const noun = category ? "document" : "receipt";
      const plural = files.length === 1 ? noun : `${noun}s`;
      alert(hadDraft ? `${plural[0].toUpperCase()}${plural.slice(1)} uploaded.` : `Draft saved and ${plural} uploaded.`);
    } catch (e: any) {
      alert("Error uploading file: " + e.message);
    }
  }

  // Lets the claimant pull a wrongly-chosen file back off the draft before submitting.
  async function removeClearanceReceipt(receiptId: string) {
    if (!editingClaimId) return;
    const ok = await confirmAction({ title: "Remove this file?", text: "This cannot be undone.", confirmButtonText: "Remove" });
    if (!ok) return;
    try {
      await api.deleteClaimReceipt(editingClaimId, receiptId);
      setClearanceReceipts((current) => current.filter((r) => r.id !== receiptId));
    } catch (e: any) {
      alert("Error removing file: " + e.message);
    }
  }

  // dashboard quick search across advances and clearances
  // Live, debounced query against the real system (GET /search) rather than
  // a client-side filter over the dashboard's own "mine=true" advances/claims
  // cache — that cache never contained other employees' requests at all, so
  // Quick Search could never actually find anyone but yourself. The backend
  // applies the same report_advances-gated "search everyone vs. just your
  // own" scoping GET /advances and GET /claims already use.
  useEffect(() => {
    const term = dashboardSearch.trim();
    if (!term) {
      setDashboardSearchLive({ advances: [], claims: [] });
      setDashboardSearchLoading(false);
      return;
    }
    setDashboardSearchLoading(true);
    const handle = setTimeout(() => {
      api.dashboardSearch(term)
        .then((res: any) => {
          setDashboardSearchLive({ advances: Array.isArray(res?.advances) ? res.advances : [], claims: Array.isArray(res?.claims) ? res.claims : [] });
          setDashboardSearchSyncedAt(new Date());
        })
        .catch(() => setDashboardSearchLive({ advances: [], claims: [] }))
        .finally(() => setDashboardSearchLoading(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [dashboardSearch]);

  const dashboardSearchResults = useMemo(() => {
    if (!dashboardSearch.trim()) return [];
    const advanceResults = dashboardSearchLive.advances.map((a) => ({
      kind: "advance" as const,
      id: a.id,
      mine: a.requester_id === profile?.id,
      title: `${a.requester_name || "—"} · ${travelTypeLabel(a.type, travelTypes)}`,
      subtitle: currentApprovalStepLabel(a) ? `Pending ${currentApprovalStepLabel(a)} Approval` : advanceStageLabel(a),
    }));
    const claimResults = dashboardSearchLive.claims.map((c) => ({
      kind: "clearance" as const,
      id: c.id,
      mine: c.claimant_id === profile?.id,
      title: `${c.requester_name || "—"} · ${travelTypeLabel(c.type, travelTypes)}`,
      subtitle: String(c.status || "").replace(/_/g, " "),
    }));
    return [...advanceResults, ...claimResults].slice(0, 8);
  }, [dashboardSearch, dashboardSearchLive, travelTypes, profile?.id]);

  // recent activity feed for the dashboard, built from my own advances & clearances
  const dashboardRecentActivity = useMemo(() => {
    const name = profile?.full_name || me?.fullName || "—";
    type Entry = { id: string; title: string; subtitle: string; status: string; date: string };
    const entries: Entry[] = [];
    for (const a of advances) {
      const type = travelTypeLabel(a.type, travelTypes);
      const title = `Advance for ${a.requester_name || name}`;
      if (a.paid_at) entries.push({ id: `${a.id}-paid`, title, subtitle: `${type} · Paid`, status: "PAID", date: a.paid_at });
      else if (a.approved_at) entries.push({ id: `${a.id}-appr`, title, subtitle: `${type} · Approved`, status: "APPROVED", date: a.approved_at });
      else if (a.status === "REJECTED" && (a.updated_at || a.approved_at)) entries.push({ id: `${a.id}-rej`, title, subtitle: `${type} · Rejected`, status: "REJECTED", date: a.updated_at || a.approved_at });
      else if (a.submitted_at || a.created_at) entries.push({ id: `${a.id}-sub`, title, subtitle: `${type} · ${currentApprovalStepLabel(a) ? `Pending ${currentApprovalStepLabel(a)} Approval` : advanceStageLabel(a)}`, status: isAdvancePastApproval(a) ? "APPROVED" : a.status, date: a.submitted_at || a.created_at });
    }
    for (const c of claims) {
      const title = `Clearance for ${c.requester_name || name}`;
      if (c.paid_at) entries.push({ id: `${c.id}-paid`, title, subtitle: "Clearance · Paid", status: "PAID", date: c.paid_at });
      else if (c.approved_at) entries.push({ id: `${c.id}-appr`, title, subtitle: "Clearance · Approved", status: "APPROVED", date: c.approved_at });
      else if (c.status === "REJECTED" && (c.updated_at || c.approved_at)) entries.push({ id: `${c.id}-rej`, title, subtitle: "Clearance · Rejected", status: "REJECTED", date: c.updated_at || c.approved_at });
      else if (c.created_at) entries.push({ id: `${c.id}-sub`, title, subtitle: `Clearance · ${String(c.status || "").replace(/_/g, " ")}`, status: c.status, date: c.created_at });
    }
    return entries.sort((x, y) => new Date(y.date).getTime() - new Date(x.date).getTime()).slice(0, 5);
  }, [advances, claims, travelTypes, profile, me]);

  // approval queue summary for the dashboard, grouped by document type
  const dashboardQueueGroups = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (const item of inboxItems) {
      (groups[item.doc_type] ||= []).push(item);
    }
    return Object.entries(groups).map(([docType, items]) => {
      const total = items.reduce((sum, it) => sum + dashboardDocTypeAmount(it), 0);
      const byStage: Record<string, { count: number; amount: number }> = {};
      for (const it of items) {
        const stage = it.current_step_position_name;
        if (!stage) continue;
        byStage[stage] ||= { count: 0, amount: 0 };
        byStage[stage].count += 1;
        byStage[stage].amount += dashboardDocTypeAmount(it);
      }
      return { docType, count: items.length, total, byStage };
    });
  }, [inboxItems]);

  // helper summaries
  const pendingAdvCount = advances.filter((a) => ["SUBMITTED", "COUNTERSIGNED", "HR_OFFICER", "APPROVED"].includes(a.status)).length;
  const pendingClaimCount = claims.filter((c) => !["SETTLED", "CLOSED", "REJECTED"].includes(c.status)).length;
  // Only money actually paid to the employee during the current month is
  // spend. Approved, rejected, cancelled and still-pending requests must not
  // inflate this figure. A clearance contributes only an actual reimbursement
  // to the employee (never its full expense total or an employee payback).
  // Group by currency rather than blending unlike currencies into one number.
  const monthlySpendByCurrency = (() => {
    const totals = new Map<string, number>();
    const now = new Date();
    for (const a of advances) {
      if (a.status !== "PAID" || !isInCurrentMonth(a.paid_at, now)) continue;
      const currency = travelTypeCurrency(a.type, travelTypes);
      totals.set(currency, (totals.get(currency) || 0) + Number(a.approved_total || 0));
    }
    for (const c of claims) {
      const isPaidRefund = c.status === "COMPLETED" && c.financial_outcome === "REFUND_DUE";
      const isPaidLegacyReimbursement = c.status === "CLOSED" && c.finance_decision === "REIMBURSE_EMPLOYEE";
      if ((!isPaidRefund && !isPaidLegacyReimbursement) || !isInCurrentMonth(c.settled_at, now)) continue;
      const currency = c.currency || "LSL";
      totals.set(currency, (totals.get(currency) || 0) + Number(c.settlement_amount || 0));
    }
    return Array.from(totals.entries());
  })();
  const advancesByType = advances.reduce<Record<string, number>>((acc, advance) => {
    acc[advance.type] = (acc[advance.type] || 0) + 1;
    return acc;
  }, {});
  const advancesByStatus = advances.reduce<Record<string, number>>((acc, advance) => {
    acc[advance.status] = (acc[advance.status] || 0) + 1;
    return acc;
  }, {});
  const claimsByStatus = claims.reduce<Record<string, number>>((acc, claim) => {
    acc[claim.status] = (acc[claim.status] || 0) + 1;
    return acc;
  }, {});
  const navItemClass = (active: boolean) => `sidebar-link${active ? " active" : ""}`;
  const nowLabel = new Date().toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const requestSummaryType = advanceType ? (isTravelAdvanceSelected ? selectedTravelType?.name || travelTypeLabel(advanceType, travelTypes) : travelTypeLabel(advanceType, travelTypes)) : "—";
  const requestSummaryPayment = paymentMethod || "—";
  const requestSummaryAmount = fmtMoney(totalRequested(), selectedTravelType?.currency);
  const requestSummaryDate = requestDate ? new Date(requestDate).toLocaleDateString("en-GB") : "—";

  function renderAdvanceTrackingModal() {
    const advance = historyAdvanceDetail || advances.find((item: any) => item.id === historyAdvanceId) || {};
    const error = historyEvents[0]?.error;
    const events = error ? [] : historyEvents;
    const currentStatus = String(advance.status || eventStatus(events[events.length - 1]) || "DRAFT").toUpperCase();
    const stages = buildTrackingStages({ ...advance, status: currentStatus }, events);
    const activeStage = stages.find((stage: any) => stage.state === "active" || stage.state === "danger")
      || stages.find((stage: any) => stage.state === "waiting")
      || stages[stages.length - 1];
    const createdAt = advance.created_at || events[0]?.created_at;
    const submittedAt = advance.submitted_at || events.find((event: any) => event.action === "ADVANCE_SUBMIT")?.created_at;
    const targetMs = 2 * 24 * 60 * 60 * 1000;
    const createdTime = createdAt ? new Date(createdAt).getTime() : Date.now();
    const expectedCompletion = Number.isFinite(createdTime) ? new Date(createdTime + targetMs) : null;
    const approvalRows = stages.filter((stage: any) => !["draft", "submitted"].includes(stage.key));
    const commentEvents = events.filter((event: any) => event?.after_json?.comments);
    const requester = advance.requester_name || profile?.full_name || me?.fullName || me?.username || "Unknown";
    const department = advance.department || profile?.department || me?.department || "—";
    const businessUnit = advance.division_name || profile?.division_name || "—";
    const requestType = travelTypeLabel(advance.type, travelTypes);
    const amount = Number(advance.approved_total || advance.requested_total || 0);

    return (
      <div className="tracking-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="tracking-modal-title">
        <div className="tracking-modal-shell">
          <div className="tracking-modal-header">
            <div className="tracking-title-group">
              <span className="tracking-title-icon"><GitBranch size={28} aria-hidden /></span>
              <div>
                <h2 id="tracking-modal-title">Advance Tracking</h2>
                <p>Track the progress and status of your advance request</p>
              </div>
            </div>
            {canAccessFeature("advance_pdf") && (
              <button className="button small-button button-subtle" type="button" onClick={() => downloadAdvancePdf(advance.id)} style={{ marginRight: 8 }}>
                <Download size={16} aria-hidden /> Download PDF
              </button>
            )}
            <button className="tracking-close-icon" type="button" onClick={() => setHistoryOpen(false)} aria-label="Close tracking">
              <X size={22} aria-hidden />
            </button>
          </div>

          {historyLoading ? (
            <div className="tracking-loading"><RefreshCw className="rl-spin" size={22} /> Loading tracking details...</div>
          ) : error ? (
            <div className="tracking-error">Error loading history: {error}</div>
          ) : (
            <>
              <section className="tracking-summary-band">
                <div className="tracking-summary-lead">
                  <span className="tracking-doc-icon"><FileText size={25} aria-hidden /></span>
                  <div>
                    <span>Request No.</span>
                    <strong>{requestNumber(advance)}</strong>
                    <em className={`tracking-status-pill ${statusToneClass(currentStatus)}`}>{humanizeToken(currentStatus)}</em>
                  </div>
                </div>
                <div>
                  <span>Current Stage</span>
                  <strong>
                    {Array.isArray(advance.approval_chain) && advance.approval_chain.length > 0
                      && !["DRAFT", "PAID", "APPROVED", "REJECTED", "CANCELLED"].includes(currentStatus) && activeStage?.label
                      ? (isAdvancePastApproval(advance) ? `With ${activeStage.label}` : `Pending ${activeStage.label} Approval`)
                      : advanceStageLabel(advance)}
                  </strong>
                  <em className={`tracking-status-pill ${statusToneClass(currentStatus)}`}>
                    {["PAID", "APPROVED", "REJECTED", "CANCELLED"].includes(currentStatus) ? humanizeToken(currentStatus) : "In Progress"}
                  </em>
                </div>
                <div>
                  <span>Submitted On</span>
                  <strong>{formatTrackingDate(submittedAt || createdAt)}</strong>
                </div>
                <div>
                  <span>Requested By</span>
                  <strong>{requester}</strong>
                  <small>{displayRoleLabel(profile?.role || me?.role || "EMPLOYEE")}</small>
                </div>
              </section>

              <section className="tracking-card tracking-progress-card">
                <h3>Request Progress</h3>
                <div className="tracking-progress-strip">
                  {stages.map((stage: any, index: number) => (
                    <div key={stage.key} className={`tracking-progress-step is-${stage.state}`} title={stage.tooltip}>
                      {index < stages.length - 1 && <span className="tracking-progress-line" aria-hidden />}
                      <span className="tracking-step-icon">
                        {stage.state === "done" ? <CheckCircle2 size={22} aria-hidden /> : stage.state === "danger" ? <X size={21} aria-hidden /> : stage.state === "active" ? <User size={21} aria-hidden /> : <Clock3 size={20} aria-hidden />}
                      </span>
                      <strong>{stage.label}</strong>
                      <em>{stage.status}</em>
                      {stage.actor && <small>{stage.actor}</small>}
                      {stage.date && <small>{formatTrackingDate(stage.date)}</small>}
                    </div>
                  ))}
                </div>
              </section>

              <div className="tracking-content-grid">
                <div className="tracking-main-stack">
                  <section className="tracking-card">
                    <h3>Approval Journey</h3>
                    <div className="tracking-table-wrap">
                      <table className="tracking-table">
                        <thead>
                          <tr>
                            <th>Step</th>
                            <th>Approver</th>
                            <th>Status</th>
                            <th>Action Date</th>
                            <th>Comments</th>
                          </tr>
                        </thead>
                        <tbody>
                          {approvalRows.map((stage: any, index: number) => (
                            <tr key={stage.key}>
                              <td>{index + 1}</td>
                              <td>{stage.actor || (stage.state === "done" ? "System" : "Pending")}</td>
                              <td><span className={`tracking-mini-status is-${stage.state}`}>{stage.status}</span></td>
                              <td>{stage.date ? formatTrackingDate(stage.date) : "—"}</td>
                              <td>{commentEvents.find((event: any) => event.created_at === stage.date)?.after_json?.comments || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="tracking-card">
                    <h3>Comments</h3>
                    {commentEvents.length === 0 ? (
                      <div className="tracking-empty">No comments captured for this request.</div>
                    ) : commentEvents.map((event: any) => (
                      <div className="tracking-comment" key={`comment-${event.id}`}>
                        <span>{initials(event.actor_name || "System")}</span>
                        <div>
                          <strong>{eventActor(event)}</strong>
                          <time>{formatTrackingDate(event.created_at)}</time>
                          <p>{event.after_json.comments}</p>
                        </div>
                      </div>
                    ))}
                  </section>

                  <details className="tracking-audit-log">
                    <summary>Technical Audit Log</summary>
                    <div className="tracking-table-wrap">
                      <table className="tracking-table">
                        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>New Status</th></tr></thead>
                        <tbody>
                          {events.map((event: any) => (
                            <tr key={`audit-${event.id}`}>
                              <td>{formatTrackingDate(event.created_at)}</td>
                              <td>{eventActor(event)}</td>
                              <td>{event.action}</td>
                              <td>{eventStatus(event) || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </div>

                <aside className="tracking-side-stack">
                  <section className="tracking-card">
                    <h3>Request Summary</h3>
                    <dl className="tracking-detail-list">
                      <div><dt>Request No.</dt><dd>{requestNumber(advance)}</dd></div>
                      <div><dt>Process</dt><dd>{requestType}</dd></div>
                      <div><dt>Business Unit</dt><dd>{businessUnit}</dd></div>
                      <div><dt>Division</dt><dd>{department}</dd></div>
                      <div><dt>Amount Requested</dt><dd>{fmtMoney(amount)}</dd></div>
                      <div><dt>Purpose</dt><dd>{advance.purpose || "—"}</dd></div>
                    </dl>
                  </section>

                  <section className="tracking-card">
                    <h3><User size={17} aria-hidden /> Current Owner</h3>
                    <div className="tracking-owner">
                      <strong>{activeStage?.label || "Requester"}</strong>
                      <span>{advanceStageLabel(advance)}</span>
                      {["SUBMITTED","COUNTERSIGNED","HR_OFFICER","APPROVED"].includes(currentStatus) && (
                        <button
                          type="button"
                          disabled={remindingAdvanceId === advance.id}
                          style={remindingAdvanceId === advance.id ? { opacity: 0.7, cursor: "not-allowed" } : undefined}
                          onClick={async () => {
                            setRemindingAdvanceId(advance.id);
                            try {
                              const result: any = await api.remindAdvance(advance.id);
                              alert(`Reminder sent to ${result.approverName || "the approver"}. You will also receive a confirmation email.`);
                            } catch (err: any) {
                              alert(err?.message || "Failed to send reminder.");
                            } finally {
                              setRemindingAdvanceId(null);
                            }
                          }}
                        >
                          <Mail size={15} aria-hidden /> {remindingAdvanceId === advance.id ? "Sending…" : "Send Reminder"}
                        </button>
                      )}
                    </div>
                  </section>

                  <section className="tracking-card">
                    <h3><Clock3 size={17} aria-hidden /> Expected Completion</h3>
                    <div className="tracking-owner">
                      <strong>{expectedCompletion ? formatTrackingDate(expectedCompletion) : "—"}</strong>
                      <span>Based on SLA</span>
                    </div>
                  </section>
                </aside>
              </div>
            </>
          )}

          <div className="tracking-modal-footer">
            <button className="button small-button" type="button" onClick={() => setHistoryOpen(false)}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  function renderClearanceTrackingModal() {
    const claim = clearanceTrackDetail || claims.find((item: any) => item.id === clearanceTrackId) || {};
    const currentStatus = String(claim.status || "DRAFT").toUpperCase();
    const stages = buildClearanceTrackingStages(claim);
    const activeStage = stages.find((stage: any) => stage.state === "active" || stage.state === "danger")
      || stages.find((stage: any) => stage.state === "waiting")
      || stages[stages.length - 1];
    const requester = claim.requester_name || claim.claimant_name || profile?.full_name || me?.fullName || me?.username || "Unknown";

    return (
      <div className="tracking-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="clearance-tracking-modal-title">
        <div className="tracking-modal-shell">
          <div className="tracking-modal-header">
            <div className="tracking-title-group">
              <span className="tracking-title-icon"><GitBranch size={28} aria-hidden /></span>
              <div>
                <h2 id="clearance-tracking-modal-title">Clearance Tracking</h2>
                <p>Track the progress and status of your clearance</p>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              {claim.can_view_pdf && (
                <button className="button small-button button-subtle" type="button" onClick={() => downloadClaimPdf(claim.id)}>
                  Download PDF
                </button>
              )}
              <button className="tracking-close-icon" type="button" onClick={() => setClearanceTrackOpen(false)} aria-label="Close tracking">
                <X size={22} aria-hidden />
              </button>
            </div>
          </div>

          {clearanceTrackLoading ? (
            <div className="tracking-loading"><RefreshCw className="rl-spin" size={22} /> Loading tracking details...</div>
          ) : (
            <>
              <section className="tracking-summary-band">
                <div className="tracking-summary-lead">
                  <span className="tracking-doc-icon"><FileText size={25} aria-hidden /></span>
                  <div>
                    <span>Reference</span>
                    <strong>{claimNumber(claim)}</strong>
                    <em className={`tracking-status-pill ${statusToneClass(currentStatus)}`}>{clearanceOutcomeStatusLabel(currentStatus)}</em>
                  </div>
                </div>
                <div>
                  <span>Current Stage</span>
                  <strong>{clearanceStageLabel(claim)}</strong>
                  <em className={`tracking-status-pill ${statusToneClass(currentStatus)}`}>
                    {["SETTLED", "CLOSED", "REJECTED"].includes(currentStatus) ? humanizeToken(currentStatus) : "In Progress"}
                  </em>
                </div>
                <div>
                  <span>Submitted On</span>
                  <strong>{formatTrackingDate(claim.created_at)}</strong>
                </div>
                <div>
                  <span>Requested By</span>
                  <strong>{requester}</strong>
                  <small>{displayRoleLabel(profile?.role || me?.role || "EMPLOYEE")}</small>
                </div>
              </section>

              <section className="tracking-card tracking-progress-card">
                <h3>Clearance Progress</h3>
                <div className="tracking-progress-strip">
                  {stages.map((stage: any, index: number) => (
                    <div key={stage.key} className={`tracking-progress-step is-${stage.state}`}>
                      {index < stages.length - 1 && <span className="tracking-progress-line" aria-hidden />}
                      <span className="tracking-step-icon">
                        {stage.state === "done" ? <CheckCircle2 size={22} aria-hidden /> : stage.state === "danger" ? <X size={21} aria-hidden /> : stage.state === "active" ? <User size={21} aria-hidden /> : <Clock3 size={20} aria-hidden />}
                      </span>
                      <strong>{stage.label}</strong>
                      <em>{stage.status}</em>
                      {stage.actor && <small>{stage.actor}</small>}
                    </div>
                  ))}
                </div>
              </section>

              <div className="tracking-content-grid">
                <div className="tracking-main-stack">
                  <section className="tracking-card">
                    <h3>Clearance Summary</h3>
                    <dl className="tracking-detail-list">
                      <div><dt>Reference</dt><dd>{claimNumber(claim)}</dd></div>
                      <div><dt>Month</dt><dd>{claim.month || "—"}</dd></div>
                      <div><dt>Approved Advance</dt><dd>{fmtMoney(claim.advance_amount, claim.currency)}</dd></div>
                      <div><dt>Verified Expenses</dt><dd>{fmtMoney(claim.claim_total, claim.currency)}</dd></div>
                      {claim.financial_outcome === "REFUND_DUE" && (
                        <div><dt>Refund Due</dt><dd>{fmtMoney(Math.abs(Number(claim.balance_amount || 0)), claim.currency)}</dd></div>
                      )}
                      {claim.financial_outcome === "PAYBACK_DUE" && (
                        <div><dt>Payback Due</dt><dd>{fmtMoney(Math.abs(Number(claim.balance_amount || 0)), claim.currency)}</dd></div>
                      )}
                      <div>
                        <dt>Outstanding Amount</dt>
                        <dd>{claim.employee_clearance_status === "FULLY_CLEARED" || currentStatus === "COMPLETED" || currentStatus === "FINANCE_TREASURY_REVIEW" ? fmtMoney(0, claim.currency) : fmtMoney(Math.abs(Number(claim.balance_amount || 0)), claim.currency)}</dd>
                      </div>
                      {claim.financial_outcome && <div><dt>Clearance Outcome</dt><dd>{clearanceOutcomeStatusLabel(claim.financial_outcome === "BALANCED" ? "FULLY_CLEARED" : claim.financial_outcome)}</dd></div>}
                      <div><dt>Current Status</dt><dd>{clearanceOutcomeStatusLabel(currentStatus)}</dd></div>
                    </dl>
                  </section>

                  {currentStatus === "PAYBACK_DUE" && (
                    <section className="tracking-card">
                      <h3>Submit Payback Proof</h3>
                      <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>
                        You must return {fmtMoney(Math.abs(Number(claim.balance_amount || 0)), claim.currency)} to the company. Upload proof of payment (receipt, deposit slip, or bank transfer confirmation) below.
                      </p>
                      <PaybackProofForm form={paybackProofForm} setForm={setPaybackProofForm} onSubmit={submitPaybackProofForTracking} submitting={paybackProofSubmitting} submitLabel="Submit Payback Proof" />
                    </section>
                  )}

                  {currentStatus === "PAYBACK_PROOF_REJECTED" && (
                    <section className="tracking-card">
                      <h3>Payback Proof Rejected</h3>
                      <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>
                        HR Operations did not accept your previous proof
                        {claim.payback_proofs?.[0]?.rejection_reason ? <>: <strong>{claim.payback_proofs[0].rejection_reason}</strong></> : "."}
                        {" "}Please review and resubmit — required payback amount: {fmtMoney(Math.abs(Number(claim.balance_amount || 0)), claim.currency)}.
                      </p>
                      <PaybackProofForm form={paybackProofForm} setForm={setPaybackProofForm} onSubmit={submitPaybackProofForTracking} submitting={paybackProofSubmitting} submitLabel="Resubmit Payback Proof" />
                    </section>
                  )}

                  {currentStatus === "PAYBACK_PROOF_SUBMITTED" && (
                    <section className="tracking-card">
                      <h3>Payback Proof Submitted</h3>
                      <p style={{ fontSize: 13, color: "var(--muted)" }}>
                        Submitted {formatTrackingDate(claim.payback_proofs?.[0]?.submitted_at)}. Awaiting HR Operations verification.
                      </p>
                    </section>
                  )}

                  {(currentStatus === "COMPLETED" || currentStatus === "FINANCE_TREASURY_REVIEW") && (
                    <section className="tracking-card">
                      <h3>Trip Completed and Fully Cleared</h3>
                      <p style={{ fontSize: 13, color: "var(--muted)" }}>All trip expenses have been accounted for, and no outstanding payment remains.</p>
                    </section>
                  )}

                  {claim.payback_proofs?.length > 0 && (
                    <section className="tracking-card">
                      <h3>Payback Proof History</h3>
                      <dl className="tracking-detail-list">
                        {claim.payback_proofs.map((p: any) => (
                          <div key={p.id}><dt>v{p.version} — {formatTrackingDate(p.submitted_at)}</dt><dd>{p.status} {p.rejection_reason ? `— ${p.rejection_reason}` : ""}</dd></div>
                        ))}
                      </dl>
                    </section>
                  )}
                </div>

                <aside className="tracking-side-stack">
                  <section className="tracking-card">
                    <h3><User size={17} aria-hidden /> Current Owner</h3>
                    <div className="tracking-owner">
                      <strong>{activeStage?.label || "Requester"}</strong>
                      <span>{clearanceStageLabel(claim)}</span>
                    </div>
                  </section>
                </aside>
              </div>
            </>
          )}

          <div className="tracking-modal-footer">
            <button className="button small-button" type="button" onClick={() => setClearanceTrackOpen(false)}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const emailActionToken = new URLSearchParams(window.location.search).get("email_action");
  if (emailActionToken) {
    return <EmailActionConfirm token={emailActionToken} />;
  }

  if (!token) {
    return (
      <div className="login-page">
        <section className="login-showcase">
          <span className="econet-logo-frame login-showcase-logo">
            <img src={econetLogo} alt="Econet Telecom Lesotho" />
          </span>

          <div className="flowdesk-brand">
            <span className="flowdesk-mark" aria-hidden>F</span>
            <span className="flowdesk-wordmark">FLOW<span>DESK</span></span>
          </div>
          <div className="flowdesk-brand-underline" aria-hidden />

          <p className="login-tagline">
            Streamlined advance requests, approvals, travel clearance and settlement — all in one secure platform.
          </p>

          <div className="login-illustration" aria-hidden>
            <div className="login-illustration-monitor">
              <div className="login-illustration-monitor-dots">
                <span /><span /><span />
              </div>
              <div className="login-illustration-monitor-body">
                <div className="login-illustration-donut" />
                <div className="login-illustration-bars">
                  <span style={{ height: "35%" }} />
                  <span style={{ height: "55%" }} />
                  <span style={{ height: "75%" }} />
                  <span style={{ height: "95%" }} />
                </div>
                <div className="login-illustration-row"><span className="dot done" /><i /></div>
                <div className="login-illustration-row"><span className="dot done" /><i /></div>
              </div>
              <div className="login-illustration-stand" />
            </div>

            <div className="login-badge login-badge-request">
              <FileText size={16} aria-hidden />
              <span>Request</span>
            </div>
            <div className="login-badge login-badge-approve">
              <CheckCircle2 size={16} aria-hidden />
              <span>Approve</span>
            </div>
            <div className="login-badge login-badge-travel">
              <Plane size={16} aria-hidden />
              <span>Travel</span>
            </div>
            <div className="login-badge login-badge-settle">
              <Wallet size={16} aria-hidden />
              <span>Settle</span>
            </div>

            <div className="login-illustration-plant">
              <span className="login-illustration-plant-pot" />
              <span className="login-illustration-plant-leaf l1" />
              <span className="login-illustration-plant-leaf l2" />
              <span className="login-illustration-plant-leaf l3" />
            </div>
            <div className="login-illustration-mug">
              <span className="login-illustration-mug-mark">F</span>
              <span className="login-illustration-mug-handle" />
            </div>
          </div>

          <div className="login-feature-row">
            <div>
              <ShieldCheck size={20} aria-hidden />
              <div>
                <strong>Secure</strong>
                <small>Enterprise grade security</small>
              </div>
            </div>
            <div>
              <Zap size={20} aria-hidden />
              <div>
                <strong>Efficient</strong>
                <small>Automated workflow and real-time tracking</small>
              </div>
            </div>
            <div>
              <BarChart3 size={20} aria-hidden />
              <div>
                <strong>Transparent</strong>
                <small>Full visibility and audit trail</small>
              </div>
            </div>
          </div>

          <div className="login-showcase-footer">© {new Date().getFullYear()} FlowDesk. All rights reserved.</div>
        </section>

        <div className="login-panel">
          <div className="login-card">
            <span className="econet-logo-frame login-logo">
              <img src={econetLogo} alt="Econet Telecom Lesotho" />
            </span>
            <h2>Welcome Back</h2>
            <p className="subtitle">Sign in to continue to FlowDesk</p>

            <form onSubmit={(e) => {
              e.preventDefault();
              void doLogin();
            }}>
              <div className="login-form-group">
                <label>Username</label>
                <div className="login-icon-field">
                  <User size={18} className="login-field-icon" aria-hidden />
                  <input
                    className="login-input login-input-icon"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your username"
                    type="text"
                    autoComplete="username"
                    required
                  />
                </div>
              </div>

              <div className="login-form-group">
                <label>Password</label>
                <div className="login-icon-field">
                  <Lock size={18} className="login-field-icon" aria-hidden />
                  <input
                    className="login-input login-input-icon login-input-icon-trailing"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className="login-password-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
                  </button>
                </div>
              </div>
              <button className="button button-primary login-button" type="submit" disabled={loginLoading} aria-busy={loginLoading}>
                {loginLoading ? (
                  <span className="login-button-content" aria-live="polite">
                    <RefreshCw size={18} className="login-button-spinner" />
                    Signing in...
                  </span>
                ) : (
                  <span className="login-button-content">
                    <Lock size={16} aria-hidden />
                    Sign In
                  </span>
                )}
              </button>
            </form>

            {error && <pre className="error-text">{error}</pre>}

            <div className="login-security-note login-security-banner">
              <ShieldCheck size={18} aria-hidden />
              <span>This is a secure system. Unauthorised access is prohibited.</span>
            </div>
          </div>

        </div>
      </div>
    );
  }

  if (profileLoading && !profile) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h2>Loading profile...</h2>
        </div>
      </div>
    );
  }

  if (!profileCompleted) {
    return (
      <div className="login-page">
        <div className="login-card" style={{ maxWidth: 520 }}>
          <span className="econet-logo-frame login-logo">
            <img src={econetLogo} alt="Econet Telecom Lesotho" />
          </span>
          <h1>Complete Your Profile</h1>
          <p className="subtitle">Fill in your profile details before using the system.</p>

          <div className="form-group" style={{ display: 'flex', gap: 8 }}>
            <input className="login-input" value={profileFirstName} onChange={(e) => setProfileFirstName(e.target.value)} placeholder="First name" />
            <input className="login-input" value={profileLastName} onChange={(e) => setProfileLastName(e.target.value)} placeholder="Last name" />
          </div>
          <div className="form-group">
            <OrgPicker
              value={profileOrgSelection}
              onChange={(sel) => { setProfileOrgSelection(sel); if (sel.department) setProfileDepartment(sel.department); }}
              inputClassName="login-input"
            />
          </div>
          <div className="form-group">
            <select className="login-input" value={profileEmploymentType} onChange={(e) => setProfileEmploymentType(e.target.value)}>
              {empTypes.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <input
              className="login-input"
              value={profileEmployeeNo}
              onChange={(e) => setProfileEmployeeNo(e.target.value)}
              placeholder={profileEmploymentType === "PERMANENT" ? "Employment number" : "Employment number (optional)"}
            />
          </div>
          {!["PERMANENT", "INTERN", "TEMPORARY"].includes(profileEmploymentType) && (
            <p className="subtitle" style={{ marginTop: 8 }}>
              This employment type cannot request advances.
            </p>
          )}

          <button className="button login-button" onClick={submitProfile}>Save Profile</button>
          <button className="button small-button" onClick={doLogout} style={{ marginTop: 12 }}>Logout</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell page-${page.toLowerCase().replace(/_/g, "-")}`}>
      {showIdleWarning && (
        <div className="ep-modal-overlay" style={{ zIndex: 2000 }}>
          <div className="ep-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="ep-modal-head">
              <div>
                <h2 className="ep-modal-title">Still there?</h2>
                <p className="ep-modal-sub">You've been inactive for a while. For security, you'll be logged out automatically.</p>
              </div>
            </div>
            <div className="ep-modal-body">
              <p style={{ fontSize: 28, fontWeight: 700, textAlign: "center", margin: "8px 0" }}>
                {Math.floor(idleSecondsLeft / 60)}:{String(idleSecondsLeft % 60).padStart(2, "0")}
              </p>
              <p style={{ textAlign: "center", color: "var(--muted, #6b7280)", fontSize: 13 }}>until you're signed out</p>
            </div>
            <div className="ep-modal-footer" style={{ justifyContent: "center" }}>
              <button className="ep-btn-outline" onClick={() => void doLogout()}>Log Out Now</button>
              <button className="ep-btn" onClick={stayLoggedIn}>Stay Logged In</button>
            </div>
          </div>
        </div>
      )}
      <header className="header app-header">
        <div className="user header-user">
          <div className="avatar">{userInitials}</div>
          <div>
            <div className="header-user-name">{userName}</div>
            <div className="header-user-meta">{userDepartment}</div>
          </div>
        </div>
        <div className="header-search" aria-hidden="true">
          <span>Search employees, requests, modules...</span>
          <kbd>Ctrl + K</kbd>
        </div>
        <div className="header-actions">
          <button
            className="icon-button has-icon"
            type="button"
            aria-label="Toggle theme"
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Sun size={19} aria-hidden /> : <Moon size={19} aria-hidden />}
          </button>
          <button className="notification-button has-icon" type="button" aria-label="Notifications">
            <Bell size={18} aria-hidden />
            <span>{Math.max(inboxCount, 0)}</span>
          </button>
          <button className="button small-button button-subtle" onClick={doLogout}>
            <LogOut size={16} aria-hidden />
            Logout
          </button>
        </div>
      </header>

      {editingDepartmentObj && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}>
          <div className="card" style={{ width: 720, maxWidth: '95%', padding: 20 }}>
            <h3>Edit Division</h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <label>Name</label>
              <input value={editingDepartmentObj.name} onChange={(e) => setEditingDepartmentObj({ ...editingDepartmentObj, name: e.target.value })} />

              <label>Department</label>
              <select value={editingDepartmentObj.section_id || ''} onChange={(e) => setEditingDepartmentObj({ ...editingDepartmentObj, section_id: e.target.value || null })}>
                <option value="">(No department)</option>
                {sectionOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>

              <label>HOD</label>
              {leadershipSelect(leadershipUsers.hods.length ? leadershipUsers.hods : leadershipUsers.managers, editingDepartmentObj.hod_user_id || '', 'Vacant — not yet assigned', (v: string) => setEditingDepartmentObj({ ...editingDepartmentObj, hod_user_id: v || null }))}

              <label>Manager</label>
              {leadershipSelect(leadershipUsers.managers, editingDepartmentObj.manager_user_id || '', 'Vacant — not yet assigned', (v: string) => setEditingDepartmentObj({ ...editingDepartmentObj, manager_user_id: v || null }))}

              <label>EXCO Member</label>
              {leadershipSelect(leadershipUsers.exco, editingDepartmentObj.exco_user_id || '', 'Vacant — not yet assigned', (v: string) => setEditingDepartmentObj({ ...editingDepartmentObj, exco_user_id: v || null }))}

              <label>
                <input type="checkbox" checked={!!editingDepartmentObj.active} onChange={(e) => setEditingDepartmentObj({ ...editingDepartmentObj, active: e.target.checked })} /> Active
              </label>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="button small-button" onClick={cancelEditDepartment}>Cancel</button>
                <button className="button button-primary" onClick={() => void submitEditDepartment()}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingSectionObj && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}>
          <div className="card" style={{ width: 560, maxWidth: '95%', padding: 20 }}>
            <h3>Edit Department</h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <label>Name</label>
              <input value={editingSectionObj.name} onChange={(e) => setEditingSectionObj({ ...editingSectionObj, name: e.target.value })} />

              <label>EXCO Member</label>
              {leadershipSelect(leadershipUsers.exco, editingSectionObj.exco_user_id || '', 'Vacant — not yet assigned', (v: string) => setEditingSectionObj({ ...editingSectionObj, exco_user_id: v || null }))}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="button small-button" onClick={cancelEditSection}>Cancel</button>
                <button className="button button-primary" onClick={() => void submitEditSection()}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="app-body">
        <nav className="sidebar">
          <img src={econetLogo} alt="Econet Telecom Lesotho" className="sidebar-logo" />
          <div className="sidebar-brand">
            <h2>FlowDesk</h2>
          </div>
          <a href="#" className={navItemClass(page === "HOME")} onClick={(e) => { e.preventDefault(); setPage("HOME"); }}><span className="sidebar-nav-icon"><Home size={18} aria-hidden /></span>Dashboard</a>
          <div className={`sidebar-group ${["ADVANCE", "MY_ADVANCES", "CLEARANCE", "MY_CLEARANCES"].includes(page) ? "open" : ""}`}>
            <a href="#" className={navItemClass(page === "ADVANCE" || page === "MY_ADVANCES")} onClick={(e) => { e.preventDefault(); setPage("MY_ADVANCES"); }}><span className="sidebar-nav-icon"><ClipboardList size={18} aria-hidden /></span>Advance Requests <strong><ChevronDown size={14} aria-hidden /></strong></a>
            <div className="sidebar-subnav">
              <a href="#" className={navItemClass(page === "CLEARANCE" || page === "MY_CLEARANCES")} onClick={(e) => { e.preventDefault(); setPage("MY_CLEARANCES"); }}><CheckCircle2 size={14} aria-hidden />Clearances</a>
            </div>
          </div>
          {(canAccessFeature("overtime_request") || canAccessFeature("overtime_claim")) && overtimeModuleEnabled && (
            <a href="#" className={navItemClass(page === "OVERTIME")} onClick={(e) => { e.preventDefault(); setPage("OVERTIME"); }}><span className="sidebar-nav-icon"><Clock3 size={18} aria-hidden /></span>Overtime</a>
          )}
          {standbyModuleEnabled && (
            <a href="#" className={navItemClass(page === "STANDBY")} onClick={(e) => { e.preventDefault(); setPage("STANDBY"); }}><span className="sidebar-nav-icon"><Clock3 size={18} aria-hidden /></span>Standby</a>
          )}
          {hasActiveCustomRequestTypes && <a href="#" className={navItemClass(page === "CHANGE_REQUEST")} onClick={(e) => { e.preventDefault(); setPage("CHANGE_REQUEST"); }}><span className="sidebar-nav-icon"><GitBranch size={18} aria-hidden /></span>Custom Processes</a>}
          {hasActiveBrsTypes && <a href="#" className={navItemClass(page === "BRS")} onClick={(e) => { e.preventDefault(); setPage("BRS"); }}><span className="sidebar-nav-icon"><FileText size={18} aria-hidden /></span>BRS Studio</a>}
          <a href="#" className={navItemClass(page === "INBOX")} onClick={(e) => { e.preventDefault(); setPage("INBOX"); }}><span className="sidebar-nav-icon"><Mail size={18} aria-hidden /></span>Approval Inbox <b>{inboxCount}</b></a>
          {(canAccessFeature("capture") || hasPaymentsAccess || hasDeductionsAccess || hasRefundableAccess) && (
            <div className={`sidebar-group ${(financeMenuOpen || ["CAPTURE","PAYMENTS","DEDUCTIONS","REFUNDABLE"].includes(page)) ? "open" : ""}`}>
              <a href="#" className={navItemClass(["CAPTURE","PAYMENTS","DEDUCTIONS","REFUNDABLE"].includes(page))} onClick={(e) => { e.preventDefault(); setFinanceMenuOpen((v) => !v); }}>
                <span className="sidebar-nav-icon"><Wallet size={18} aria-hidden /></span>Finance
                {(() => {
                  // Only sum counts for sub-items this user can actually see below —
                  // otherwise the header total includes e.g. refundableCount even when
                  // hasRefundableAccess is false and no Refundable row is rendered,
                  // showing a number with nothing underneath it to account for it.
                  const financeTotal = (canAccessFeature("capture") ? captureCount : 0)
                    + (hasPaymentsAccess ? paymentsCount : 0)
                    + (hasDeductionsAccess ? deductionsCount : 0)
                    + (hasRefundableAccess ? refundableCount : 0);
                  return financeTotal > 0 && <b>{financeTotal}</b>;
                })()}
                <strong><ChevronDown size={14} aria-hidden /></strong>
              </a>
              <div className="sidebar-subnav">
                {canAccessFeature("capture") && (
                  <a href="#" className={navItemClass(page === "CAPTURE")} onClick={(e) => { e.preventDefault(); setPage("CAPTURE"); }}><Camera size={14} aria-hidden />Capture Inbox <span className="inbox-count-chip">{captureCount}</span></a>
                )}
                {hasPaymentsAccess && (
                  <a href="#" className={navItemClass(page === "PAYMENTS")} onClick={(e) => { e.preventDefault(); setPage("PAYMENTS"); }}><Wallet size={14} aria-hidden />Payments <span className="inbox-count-chip">{paymentsCount}</span></a>
                )}
                {hasDeductionsAccess && (
                  <a href="#" className={navItemClass(page === "DEDUCTIONS")} onClick={(e) => { e.preventDefault(); setPage("DEDUCTIONS"); }}><MinusCircle size={14} aria-hidden />Deductions <span className="inbox-count-chip">{deductionsCount}</span></a>
                )}
                {hasRefundableAccess && (
                  <a href="#" className={navItemClass(page === "REFUNDABLE")} onClick={(e) => { e.preventDefault(); setPage("REFUNDABLE"); }}><PlusCircle size={14} aria-hidden />Refundable <span className="inbox-count-chip">{refundableCount}</span></a>
                )}
                <a href="#" className={navItemClass(["REPORTS","SLA_REPORTS","REPORT_ADVANCES","REPORT_APPROVAL","REPORT_WORKFLOW","REPORT_AUDIT","REPORT_RECONCILIATION","REPORT_TOUR_ENGAGEMENT","REPORT_CLEARANCE_STATUS","REPORT_CLEARANCE_SUMMARY","REPORT_REFUNDS_DUE","REPORT_EMPLOYEE_PAYBACKS","REPORT_FULLY_CLEARED","REPORT_OUTSTANDING","REPORT_AGEING","REPORT_TREASURY_AUDIT","REPORT_DEPT_DIVISION","REPORT_OVERTIME"].includes(page))} onClick={(e) => { e.preventDefault(); setPage("REPORTS"); }}><BarChart3 size={14} aria-hidden />Reports</a>
              </div>
            </div>
          )}
          {hasItProvisioningAccess && (
            <a href="#" className={navItemClass(page === "IT_PROVISIONING")} onClick={(e) => { e.preventDefault(); setPage("IT_PROVISIONING"); }}><span className="sidebar-nav-icon"><Monitor size={18} aria-hidden /></span>IT Provisioning <b>{itProvisioningCount}</b></a>
          )}
          {(hasVendorContractsAccess || hasServiceContractsAccess) && (
            <div className={`sidebar-group ${(contractsMenuOpen || ["VENDOR_CONTRACTS", "SERVICE_CONTRACTS"].includes(page)) ? "open" : ""}`}>
              <a href="#" className={navItemClass(page === "VENDOR_CONTRACTS" || page === "SERVICE_CONTRACTS")} onClick={(e) => { e.preventDefault(); setContractsMenuOpen((v) => !v); }}>
                <span className="sidebar-nav-icon"><FileText size={18} aria-hidden /></span>Contracts
                <strong><ChevronDown size={14} aria-hidden /></strong>
              </a>
              <div className="sidebar-subnav">
                {hasVendorContractsAccess && (
                  <a href="#" className={navItemClass(page === "VENDOR_CONTRACTS")} onClick={(e) => { e.preventDefault(); setPage("VENDOR_CONTRACTS"); }}><FileText size={14} aria-hidden />Vendor Contracts</a>
                )}
                {hasServiceContractsAccess && (
                  <a href="#" className={navItemClass(page === "SERVICE_CONTRACTS")} onClick={(e) => { e.preventDefault(); setPage("SERVICE_CONTRACTS"); }}><Wifi size={14} aria-hidden />Service Contracts</a>
                )}
              </div>
            </div>
          )}
          <div className={`sidebar-group ${["REPORTS","SLA_REPORTS","REPORT_ADVANCES","REPORT_APPROVAL","REPORT_WORKFLOW","REPORT_AUDIT","REPORT_RECONCILIATION","REPORT_TOUR_ENGAGEMENT","REPORT_CLEARANCE_STATUS","REPORT_CLEARANCE_SUMMARY","REPORT_REFUNDS_DUE","REPORT_EMPLOYEE_PAYBACKS","REPORT_FULLY_CLEARED","REPORT_OUTSTANDING","REPORT_AGEING","REPORT_TREASURY_AUDIT","REPORT_DEPT_DIVISION","REPORT_OVERTIME"].includes(page) ? "open" : ""}`}>
            <a href="#" className={navItemClass(["REPORTS","SLA_REPORTS","REPORT_ADVANCES","REPORT_APPROVAL","REPORT_WORKFLOW","REPORT_AUDIT","REPORT_RECONCILIATION","REPORT_TOUR_ENGAGEMENT","REPORT_CLEARANCE_STATUS","REPORT_CLEARANCE_SUMMARY","REPORT_REFUNDS_DUE","REPORT_EMPLOYEE_PAYBACKS","REPORT_FULLY_CLEARED","REPORT_OUTSTANDING","REPORT_AGEING","REPORT_TREASURY_AUDIT","REPORT_DEPT_DIVISION","REPORT_OVERTIME"].includes(page))} onClick={(e) => { e.preventDefault(); setPage("REPORTS"); }}><span className="sidebar-nav-icon"><BarChart3 size={18} aria-hidden /></span>Reports <strong><ChevronDown size={14} aria-hidden /></strong></a>
            <div className="sidebar-subnav">
              {canAccessFeature("report_advances") && (
                <a href="#" className={navItemClass(page === "REPORT_ADVANCES")} onClick={(e) => { e.preventDefault(); setPage("REPORT_ADVANCES"); }}><FileText size={14} aria-hidden />Advance Requests</a>
              )}
              {canAccessFeature("report_advances") && (
                <a href="#" className={navItemClass(page === "REPORT_APPROVAL")} onClick={(e) => { e.preventDefault(); setPage("REPORT_APPROVAL"); }}><Users size={14} aria-hidden />Approval Performance</a>
              )}
              <a href="#" className={navItemClass(page === "SLA_REPORTS")} onClick={(e) => { e.preventDefault(); setPage("SLA_REPORTS"); }}><BarChart3 size={14} aria-hidden />SLA Reports</a>
              <a href="#" className={navItemClass(page === "REPORT_WORKFLOW")} onClick={(e) => { e.preventDefault(); setPage("REPORT_WORKFLOW"); }}><GitBranch size={14} aria-hidden />Workflow Analytics</a>
              <a href="#" className={navItemClass(page === "REPORT_AUDIT")} onClick={(e) => { e.preventDefault(); setPage("REPORT_AUDIT"); }}><ShieldCheck size={14} aria-hidden />Audit Trail</a>
              {canAccessFeature("report_reconciliation") && (
                <a href="#" className={navItemClass(page === "REPORT_RECONCILIATION")} onClick={(e) => { e.preventDefault(); setPage("REPORT_RECONCILIATION"); }}><BarChart3 size={14} aria-hidden />Reconciliation</a>
              )}
              {canAccessFeature("clearance_status_report") && (
                <a href="#" className={navItemClass(page === "REPORT_CLEARANCE_STATUS")} onClick={(e) => { e.preventDefault(); setPage("REPORT_CLEARANCE_STATUS"); }}><CheckCircle2 size={14} aria-hidden />Clearance Status</a>
              )}
              {role === "ADMIN" && (
                <a href="#" className={navItemClass(page === "REPORT_TOUR_ENGAGEMENT")} onClick={(e) => { e.preventDefault(); setPage("REPORT_TOUR_ENGAGEMENT"); }}><PlayCircle size={14} aria-hidden />Tooltip Engagement</a>
              )}
            </div>
          </div>
          <div className="sidebar-section-label">Administration</div>
          {(canAccessFeature("user_management") || canAccessFeature("roles_permissions") || canAccessFeature("manager_delegations") || delegationEligible) && (
            <div className={`sidebar-group ${["USER_MANAGEMENT", "ROLES_PERMISSIONS", "MANAGER_DELEGATIONS"].includes(page) ? "open" : ""}`}>
              <a href="#" className={navItemClass(["USER_MANAGEMENT", "ROLES_PERMISSIONS", "MANAGER_DELEGATIONS"].includes(page))} onClick={(e) => { e.preventDefault(); setPage("USER_MANAGEMENT"); }}><span className="sidebar-nav-icon"><Users size={18} aria-hidden /></span>User Management <strong><ChevronDown size={14} aria-hidden /></strong></a>
              <div className="sidebar-subnav">
                {canAccessFeature("user_management") && <a href="#" className={navItemClass(page === "USER_MANAGEMENT")} onClick={(e) => { e.preventDefault(); setPage("USER_MANAGEMENT"); }}><Users size={14} aria-hidden />Users</a>}
                {canAccessFeature("roles_permissions") && <a href="#" className={navItemClass(page === "ROLES_PERMISSIONS")} onClick={(e) => { e.preventDefault(); setPage("ROLES_PERMISSIONS"); }}><ShieldCheck size={14} aria-hidden />Roles & Permissions</a>}
                {(canAccessFeature("manager_delegations") || delegationEligible) && <a href="#" className={navItemClass(page === "MANAGER_DELEGATIONS")} onClick={(e) => { e.preventDefault(); setPage("MANAGER_DELEGATIONS"); }}><Users size={14} aria-hidden />Manager Delegations</a>}
              </div>
            </div>
          )}
          {["MANAGER", "HOD", "EXCO", "CEO", "ADMIN"].includes(role) && (
            <a href="#" className={navItemClass(page === "MY_TEAM")} onClick={(e) => { e.preventDefault(); setPage("MY_TEAM"); }}><span className="sidebar-nav-icon"><Users size={18} aria-hidden /></span>My Team</a>
          )}
          {canManageTravelSettings && (
            <a href="#" className={navItemClass(page === "TRAVEL_SETUP")} onClick={(e) => { e.preventDefault(); setPage("TRAVEL_SETUP"); }}><span className="sidebar-nav-icon"><BriefcaseBusiness size={18} aria-hidden /></span>Travel Setup</a>
          )}
          {canAccessFeature("request_types") && (
            <a href="#" className={navItemClass(page === "REQUEST_TYPES")} onClick={(e) => { e.preventDefault(); setPage("REQUEST_TYPES"); }}><span className="sidebar-nav-icon"><ClipboardList size={18} aria-hidden /></span>Process</a>
          )}
          {role === "ADMIN" && (
            <a href="#" className={navItemClass(page === "BRS_ADMIN")} onClick={(e) => { e.preventDefault(); setPage("BRS_ADMIN"); }}><span className="sidebar-nav-icon"><FileText size={18} aria-hidden /></span>BRS Templates</a>
          )}
          {(canAccessFeature("org_structure") || canAccessFeature("team_roster") || canAccessFeature("ceo_management") || canAccessFeature("employees") || canAccessFeature("exco_members") || canAccessFeature("managers") || canAccessFeature("leadership_assignments") || canAccessFeature("workflow_builder") || canAccessFeature("reporting_lines") || canAccessFeature("pdf_designer")) && (
            <div className={`sidebar-group ${orgNavOpen ? "open" : ""}`}>
              <a href="#" className={navItemClass(ORG_PAGES.includes(page as any))} onClick={(e) => { e.preventDefault(); setOrgNavOpen((v) => !v); }}><span className="sidebar-nav-icon"><Network size={18} aria-hidden /></span>Organizational Structure <strong>{orgNavOpen ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}</strong></a>
              <div className="sidebar-subnav">
                {canAccessFeature("org_structure") && <a href="#" className={navItemClass(page === "ORG_STRUCTURE")} onClick={(e) => { e.preventDefault(); setPage("ORG_STRUCTURE"); }}><Network size={14} aria-hidden />Org Structure</a>}
                {canAccessFeature("team_roster") && <a href="#" className={navItemClass(page === "TEAM_ROSTER")} onClick={(e) => { e.preventDefault(); setPage("TEAM_ROSTER"); }}><Users size={14} aria-hidden />Section Roster</a>}
                {canAccessFeature("ceo_management") && <a href="#" className={navItemClass(page === "CEO_MANAGEMENT")} onClick={(e) => { e.preventDefault(); setPage("CEO_MANAGEMENT"); }}><ShieldCheck size={14} aria-hidden />CEO</a>}
                {canAccessFeature("employees") && <a href="#" className={navItemClass(page === "EMPLOYEES")} onClick={(e) => { e.preventDefault(); setPage("EMPLOYEES"); }}><Users size={14} aria-hidden />Employees</a>}
                {canAccessFeature("exco_members") && <a href="#" className={navItemClass(page === "EXCO")} onClick={(e) => { e.preventDefault(); setPage("EXCO"); }}><ShieldCheck size={14} aria-hidden />EXCO Members</a>}
                {canAccessFeature("managers") && <a href="#" className={navItemClass(page === "MANAGERS")} onClick={(e) => { e.preventDefault(); setPage("MANAGERS"); }}><UserRoundCheck size={14} aria-hidden />Managers</a>}
                {canAccessFeature("leadership_assignments") && <a href="#" className={navItemClass(page === "LEADERSHIP")} onClick={(e) => { e.preventDefault(); setPage("LEADERSHIP"); }}><Users size={14} aria-hidden />Leadership Assignments</a>}
                {canAccessFeature("workflow_builder") && <a href="#" className={navItemClass(page === "WORKFLOW_BUILDER")} onClick={(e) => { e.preventDefault(); setPage("WORKFLOW_BUILDER"); }}><ShieldCheck size={14} aria-hidden />Approval Workflow Builder</a>}
                {canAccessFeature("reporting_lines") && <a href="#" className={navItemClass(page === "REPORTING_LINES")} onClick={(e) => { e.preventDefault(); setPage("REPORTING_LINES"); }}><GitBranch size={14} aria-hidden />Reporting Lines</a>}
                {canAccessFeature("pdf_designer") && <a href="#" className={navItemClass(page === "PDF_DESIGNER")} onClick={(e) => { e.preventDefault(); setPage("PDF_DESIGNER"); }}><FileText size={14} aria-hidden />PDF Designer</a>}
              </div>
            </div>
          )}
          <a href="#" className={navItemClass(page === "SETTINGS")} onClick={(e) => { e.preventDefault(); setPage("SETTINGS"); }}><span className="sidebar-nav-icon"><SettingsIcon size={18} aria-hidden /></span>Settings</a>
          {role === "ADMIN" && (
            <a href="#" className={navItemClass(page === "DATA_CLEANUP")} onClick={(e) => { e.preventDefault(); setPage("DATA_CLEANUP"); }}><span className="sidebar-nav-icon"><Trash2 size={18} aria-hidden /></span>Data Cleanup</a>
          )}
          <div className="sidebar-spacer" />
          <div className="sidebar-user-card">
            <span className="avatar">{userInitials}</span>
            <div>
              <strong>{userName}</strong>
              <small>{roleName}</small>
              <em>Online</em>
            </div>
          </div>
        </nav>

        <div className="main">
          <div className="content">
          {error && <pre style={{ color: "crimson" }}>{error}</pre>}

          {page === "INBOX" ? (
            <Inbox
              onBack={() => setPage("HOME")}
              onNavigateToModule={(target, deepLink) => { setModuleDeepLink(deepLink); setPage(target); }}
            />
          ) : page === "CAPTURE" ? (
            <Inbox
              mode="capture"
              onBack={() => setPage("HOME")}
              onNavigateToModule={(target, deepLink) => { setModuleDeepLink(deepLink); setPage(target); }}
            />
          ) : page === "PAYMENTS" ? (
            <Payments onBack={() => setPage("HOME")} />
          ) : page === "DEDUCTIONS" ? (
            <Deductions />
          ) : page === "REFUNDABLE" ? (
            <Refundable />
          ) : page === "ACCOMMODATION" && canAccessFeature("accommodation") ? (
            <Accommodation profile={profile} onBack={() => setPage("HOME")} />
          ) : page === "PAYBACK_REVIEW" && canAccessFeature("hr_operations_review") ? (
            <PaybackReview onBack={() => setPage("HOME")} />
          ) : page === "TREASURY_PROCESSING" ? (
            <TreasuryProcessing onBack={() => setPage("HOME")} />
          ) : page === "REPORT_CLEARANCE_SUMMARY" ? (
            <ReportClearanceSummary onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_REFUNDS_DUE" ? (
            <ReportRefundsDue onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_EMPLOYEE_PAYBACKS" ? (
            <ReportEmployeePaybacks onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_FULLY_CLEARED" ? (
            <ReportFullyClearedTrips onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_OUTSTANDING" ? (
            <ReportOutstandingClearances onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_AGEING" ? (
            <ReportClearanceAgeing onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_TREASURY_AUDIT" ? (
            <ReportAuditReconciliation onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_DEPT_DIVISION" ? (
            <ReportDeptDivisionClearance onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_OVERTIME" ? (
            <OvertimeReportsHub onBack={() => setPage("REPORTS")} />
          ) : page === "IT_PROVISIONING" ? (
            <ITProvisioning />
          ) : page === "OVERTIME" ? (
            <Overtime
              profile={profile}
              role={role}
              onBack={() => setPage("HOME")}
              deepLink={moduleDeepLink}
              onDeepLinkConsumed={() => setModuleDeepLink(null)}
            />
          ) : page === "STANDBY" ? (
            <Standby
              profile={profile}
              role={role}
              onBack={() => setPage("HOME")}
              deepLink={moduleDeepLink}
              onDeepLinkConsumed={() => setModuleDeepLink(null)}
            />
          ) : page === "CHANGE_REQUEST" ? (
            <CustomRequestsHub profile={profile} requestDirectory={requestDirectory} onBack={() => setPage("HOME")} />
          ) : page === "BRS" ? (
            <BrsStudio profile={profile} onBack={() => setPage("HOME")} />
          ) : page === "BRS_ADMIN" ? (
            <BrsAdmin onBack={() => setPage("HOME")} />
          ) : page === "CEO_MANAGEMENT" ? (
            <CeoManagement />
          ) : page === "EMPLOYEES" ? (
            <EmployeesOnboarding />
          ) : page === "EXCO" ? (
            <ExcoOnboarding />
          ) : page === "MANAGERS" ? (
            <ManagersOnboarding />
          ) : page === "LEADERSHIP" ? (
            <LeadershipAssignments />
          ) : page === "WORKFLOW_BUILDER" ? (
            <WorkflowBuilder />
          ) : page === "REPORTING_LINES" ? (
            <ReportingLines />
          ) : page === "PDF_DESIGNER" ? (
            <PdfDesigner />
          ) : page === "DATA_CLEANUP" ? (
            <DataCleanup onBack={() => setPage("SETTINGS")} />
          ) : page === "VENDOR_CONTRACTS" ? (
            <VendorContracts />
          ) : page === "SERVICE_CONTRACTS" ? (
            <ServiceContracts />
          ) : page === "ORG_STRUCTURE" ? (
            <OrgStructure />
          ) : page === "TEAM_ROSTER" ? (
            <TeamRoster />
          ) : page === "REQUEST_TYPES" ? (
            <RequestTypes onNavigate={(p) => setPage(p as any)} isAdmin={role === "ADMIN"} />
          ) : page === "USER_MANAGEMENT" ? (
            <div className="ep-page">
              <div className="ep-breadcrumb"><span>Administration</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span>User Management</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span className="ep-breadcrumb-active">Users</span></div>
              <UserManagement />
            </div>
          ) : page === "MANAGER_DELEGATIONS" ? (() => {
            const statuses = delegations.map(delegationDerivedStatus);
            const counts = {
              ACTIVE: statuses.filter((s) => s === "ACTIVE").length,
              UPCOMING: statuses.filter((s) => s === "UPCOMING").length,
              EXPIRING: statuses.filter((s) => s === "EXPIRING").length,
              TOTAL: delegations.length
            };
            const departmentOptions = Array.from(new Set(delegations.map((d) => d.department).filter(Boolean))).sort();
            const searchLower = delegationSearch.trim().toLowerCase();
            const filteredDelegations = delegations.filter((d) => {
              if (delegationStatusFilter && delegationDerivedStatus(d) !== delegationStatusFilter) return false;
              if (delegationDeptFilter && d.department !== delegationDeptFilter) return false;
              if (searchLower && !`${d.manager_name || ""} ${d.delegate_name || ""} ${d.reference || ""}`.toLowerCase().includes(searchLower)) return false;
              return true;
            });
            const detailDelegation = delegations.find((d) => d.id === delegationDetailId) || null;

            return (
            <div className="ep-page">
              <div className="ep-breadcrumb"><span>Administration</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span>User Management</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span className="ep-breadcrumb-active">Manager Delegations</span></div>
              <div className="ep-header">
                <div className="ep-header-text">
                  <h1 className="ep-title">Manager Delegations</h1>
                  <p className="ep-subtitle">Manage temporary delegations of approval authority. Delegates can act on behalf of managers within the delegated period.</p>
                </div>
                <div className="ep-actions">
                  <button className="ep-btn-outline" onClick={() => void loadDelegations()} disabled={delegationsLoading}>
                    {delegationsLoading ? "Loading…" : "Refresh"}
                  </button>
                  <button className="ep-btn" onClick={() => setShowCreateDelegationModal(true)}>
                    <Plus size={14} aria-hidden /> New Delegation
                  </button>
                </div>
              </div>

              <div className="ep-cards-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 }}>
                {[
                  { label: "Active Delegations", sub: "Currently active", value: counts.ACTIVE, onClick: () => setDelegationStatusFilter("ACTIVE") },
                  { label: "Upcoming", sub: "Starting later", value: counts.UPCOMING, onClick: () => setDelegationStatusFilter("UPCOMING") },
                  { label: "Expiring Soon", sub: "Ending within 7 days", value: counts.EXPIRING, onClick: () => setDelegationStatusFilter("EXPIRING") },
                  { label: "Total Delegations", sub: "All time", value: counts.TOTAL, onClick: () => setDelegationStatusFilter("") }
                ].map((card) => (
                  <button key={card.label} className="card" onClick={card.onClick}
                    style={{ textAlign: "left", cursor: "pointer", border: "1px solid var(--border)", padding: 16 }}>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>{card.value}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{card.label}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>{card.sub}</div>
                  </button>
                ))}
              </div>

              <div className="ep-panel" style={{ marginBottom: 16 }}>
                <div className="ep-panel-body" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    type="text"
                    className="ep-form-input"
                    placeholder="Search manager, delegate, or reference…"
                    value={delegationSearch}
                    onChange={(e) => setDelegationSearch(e.target.value)}
                    style={{ flex: "1 1 240px" }}
                  />
                  <select className="ep-form-select" value={delegationStatusFilter} onChange={(e) => setDelegationStatusFilter(e.target.value)} style={{ width: 160 }}>
                    <option value="">All Statuses</option>
                    {Object.entries(DELEGATION_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <select className="ep-form-select" value={delegationDeptFilter} onChange={(e) => setDelegationDeptFilter(e.target.value)} style={{ width: 180 }}>
                    <option value="">All Departments</option>
                    {departmentOptions.map((dept) => <option key={dept} value={dept}>{dept}</option>)}
                  </select>
                  {(delegationSearch || delegationStatusFilter || delegationDeptFilter) && (
                    <button className="ep-btn-outline" onClick={() => { setDelegationSearch(""); setDelegationStatusFilter(""); setDelegationDeptFilter(""); }}>Reset</button>
                  )}
                </div>
              </div>

              {/* Delegations table */}
              {delegationsLoading ? (
                <div style={{ padding: "16px 0", color: "var(--muted)", fontSize: 13 }}>Loading…</div>
              ) : filteredDelegations.length === 0 ? (
                <div style={{ padding: "16px 0", color: "var(--muted)", fontSize: 13 }}>No delegations found.</div>
              ) : (
                <div className="ep-table-wrap">
                  <table className="ep-table">
                    <thead>
                      <tr><th>Reference</th><th>Manager</th><th>Delegate</th><th>Department</th><th>Process</th><th>Period</th><th>Status</th><th></th></tr>
                    </thead>
                    <tbody>
                      {filteredDelegations.map((delegation) => {
                        const status = delegationDerivedStatus(delegation);
                        return (
                        <tr key={delegation.id} style={{ cursor: "pointer" }} onClick={() => { setDelegationDetailId(delegation.id); void loadDelegationAudit(delegation.id); }}>
                          <td style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{delegation.reference || "—"}</td>
                          <td style={{ fontWeight: 600 }}>
                            {delegation.manager_name || "—"}
                            {delegation.reason ? <div style={{ fontWeight: 400, fontSize: "0.75rem", color: "var(--muted)" }}>{delegation.reason}</div> : null}
                          </td>
                          <td>{delegation.delegate_name || "—"}</td>
                          <td style={{ color: "var(--muted)", fontSize: "0.85rem" }}>{delegation.department || "—"}</td>
                          <td style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                            {delegation.request_types?.length
                              ? delegation.request_types.map((t: string) => resolveDelegationTypeLabel(t)).join(", ")
                              : "All types"}
                          </td>
                          <td style={{ fontSize: "0.85rem" }}>{formatDateOnly(delegation.from_date)} → {formatDateOnly(delegation.to_date)}</td>
                          <td>
                            <span className={`status-pill ${DELEGATION_STATUS_CLASS[status]}`}>{DELEGATION_STATUS_LABEL[status]}</span>
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {delegation.active && (
                              <button className="ep-btn-danger" style={{ padding: "5px 10px", fontSize: "0.8rem" }} onClick={() => void endDelegation(delegation.id)}>
                                End
                              </button>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {role === "ADMIN" && (
                <div className="ep-panel" style={{ marginTop: 24 }}>
                  <div className="ep-panel-head">
                    <div>
                      <div className="ep-panel-title">PA Assignments</div>
                      <div className="ep-panel-sub">Let an assistant submit advance requests on behalf of a specific person, regardless of employment type or department.</div>
                    </div>
                    <button className="ep-btn-outline" onClick={() => void loadPaAssignments()} disabled={paAssignmentsLoading}>
                      {paAssignmentsLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>
                  <div className="ep-panel-body">
                    <div className="ep-form-row" style={{ alignItems: "flex-end", marginBottom: 16 }}>
                      <div className="ep-form-group">
                        <label>Assistant (PA)</label>
                        <UserSearchSelect
                          value={newPaUserId}
                          onChange={setNewPaUserId}
                          users={adminUsers.filter((u) => u.is_active !== false)}
                          placeholder="Search or browse users…"
                        />
                      </div>
                      <div className="ep-form-group">
                        <label>Submits for (boss)</label>
                        <UserSearchSelect
                          value={newPaPrincipalUserId}
                          onChange={setNewPaPrincipalUserId}
                          users={adminUsers.filter((u) => u.is_active !== false && u.id !== newPaUserId)}
                          placeholder="Search or browse users…"
                        />
                      </div>
                      <button className="ep-btn" onClick={() => void createPaAssignment()}>
                        <Plus size={14} aria-hidden /> Add
                      </button>
                    </div>
                    {paAssignmentsList.length === 0 ? (
                      <div style={{ padding: "8px 0", color: "var(--muted)", fontSize: 13 }}>No PA assignments yet.</div>
                    ) : (
                      <div className="ep-table-wrap">
                        <table className="ep-table">
                          <thead>
                            <tr><th>Assistant</th><th>Submits for</th><th>Since</th><th></th></tr>
                          </thead>
                          <tbody>
                            {paAssignmentsList.map((a) => (
                              <tr key={a.id}>
                                <td style={{ fontWeight: 600 }}>{a.pa_user_name || a.pa_user_email || "—"}</td>
                                <td>{a.principal_user_name || a.principal_user_email || "—"}</td>
                                <td style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{formatDateOnly(a.created_at)}</td>
                                <td>
                                  <button className="ep-btn-danger" style={{ padding: "5px 10px", fontSize: "0.8rem" }} onClick={() => void endPaAssignment(a.id)}>
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {showCreateDelegationModal && (
                <div className="ep-modal-overlay" onClick={() => setShowCreateDelegationModal(false)}>
                  <div className="ep-modal ep-modal-lg" onClick={(e) => e.stopPropagation()}>
                    <div className="ep-modal-head">
                      <div>
                        <h2 className="ep-modal-title">Create Delegation</h2>
                        <p className="ep-modal-sub">Temporarily assign a manager's approval authority to a delegate.</p>
                      </div>
                      <button className="ep-icon-btn" onClick={() => setShowCreateDelegationModal(false)} aria-label="Close"><X size={16} aria-hidden /></button>
                    </div>
                    <div className="ep-modal-body">
                      <div className="ep-form-row" style={{ marginBottom: 0 }}>
                        {/* Everyone (including ADMIN) can only delegate their own approval
                            authority — never set up a delegation on someone else's behalf. */}
                        {role === "ADMIN" ? (
                          <>
                            <div className="ep-form-group">
                              <label>Manager <span className="ep-required">*</span></label>
                              <UserSearchSelect
                                value={delegationManagerId}
                                onChange={(id) => { setDelegationManagerId(id); setDelegationDelegateId(""); }}
                                users={adminUsers.filter((user) => user.is_active !== false && ["MANAGER", "HOD", "EXCO", "CEO"].includes(user.role))}
                                placeholder="Search or browse managers…"
                              />
                            </div>
                            <div className="ep-form-group">
                              <label>Delegate <span className="ep-required">*</span></label>
                              <UserSearchSelect
                                value={delegationDelegateId}
                                onChange={setDelegationDelegateId}
                                disabled={!delegationManagerId}
                                placeholder={delegationManagerId ? "Search or browse users…" : "Select a manager first"}
                                users={adminUsers.filter((user) => {
                                  if (user.is_active === false || user.id === delegationManagerId) return false;
                                  const manager = adminUsers.find((u) => u.id === delegationManagerId);
                                  if (!manager) return true;
                                  // CEO is org-wide, no scoping at all. Someone with no department
                                  // of their own but a division (e.g. a GM overseeing a whole
                                  // division rather than one department) is scoped to that
                                  // division instead of one department/section.
                                  if (manager.role === "CEO") return true;
                                  if (!manager.department) {
                                    return Boolean(manager.division_id) && manager.division_id === user.division_id;
                                  }
                                  const sameDept = manager.department === user.department;
                                  const sameSection = Boolean(manager.section_id) && manager.section_id === user.section_id;
                                  return sameDept || sameSection;
                                })}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}>
                            <label>Delegate <span className="ep-required">*</span></label>
                            <UserSearchSelect
                              value={delegationDelegateId}
                              onChange={setDelegationDelegateId}
                              placeholder="Search or browse users…"
                              users={adminUsers.filter((user) => {
                                const selfId = profile?.id || me?.userId;
                                if (user.is_active === false || user.id === selfId) return false;
                                const selfInfo = adminUsers.find((u) => u.id === selfId);
                                // CEO is org-wide, no scoping at all. Someone with no department
                                // of their own but a division (e.g. a GM overseeing a whole
                                // division rather than one department) is scoped to that
                                // division instead of one department/section.
                                if (role === "CEO") return true;
                                if (!selfInfo?.department) {
                                  return Boolean(selfInfo?.division_id) && selfInfo?.division_id === user.division_id;
                                }
                                const sameDept = selfInfo?.department === user.department;
                                const sameSection = Boolean(selfInfo?.section_id) && selfInfo?.section_id === user.section_id;
                                return sameDept || sameSection;
                              })}
                            />
                          </div>
                        )}
                        <div className="ep-form-group">
                          <label>From Date <span className="ep-optional">(Optional)</span></label>
                          <input type="date" className="ep-form-input" value={delegationFromDate} onChange={(e) => setDelegationFromDate(e.target.value)} />
                        </div>
                        <div className="ep-form-group">
                          <label>To Date <span className="ep-optional">(Optional)</span></label>
                          <input type="date" className="ep-form-input" value={delegationToDate} onChange={(e) => setDelegationToDate(e.target.value)} />
                        </div>
                        <div className="ep-form-group">
                          <label>Reason <span className="ep-optional">(Optional)</span></label>
                          <input type="text" className="ep-form-input" placeholder="e.g. Annual leave" value={delegationReason} onChange={(e) => setDelegationReason(e.target.value)} />
                        </div>
                        <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}>
                          <label>Comments <span className="ep-optional">(Optional)</span></label>
                          <input type="text" className="ep-form-input" placeholder="Add a note for the audit trail" value={delegationComments} onChange={(e) => setDelegationComments(e.target.value)} />
                        </div>
                        <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}>
                          <label>Process <span className="ep-optional">(Optional)</span></label>
                          <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--muted, #6b7280)" }}>
                            Leave unchecked to delegate every approval type. Check specific types to limit this delegation to only those.
                          </p>
                          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                            {DELEGATION_REQUEST_TYPE_OPTIONS.map((opt) => (
                              <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                                <input
                                  type="checkbox"
                                  checked={delegationRequestTypes.includes(opt.value)}
                                  onChange={() => setDelegationRequestTypes((current) => {
                                    if (current.includes(opt.value)) return current.filter((v) => v !== opt.value);
                                    // Checking the broad "all custom types" bucket makes picking
                                    // individual ones redundant - clear those out.
                                    const next = opt.value === "CUSTOM_WORKFLOW"
                                      ? current.filter((v) => !customRequestTypeOptions.some((c) => c.code === v))
                                      : current;
                                    return [...next, opt.value];
                                  })}
                                />
                                {opt.label}
                              </label>
                            ))}
                          </div>
                          {customRequestTypeOptions.length > 0 && (
                            <div style={{ marginTop: 10, paddingLeft: 16, borderLeft: "2px solid var(--border)" }}>
                              <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--muted, #6b7280)" }}>
                                Or limit to specific custom processes instead of all of them:
                              </p>
                              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                                {customRequestTypeOptions.map((opt) => (
                                  <label key={opt.code} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, opacity: delegationRequestTypes.includes("CUSTOM_WORKFLOW") ? 0.5 : 1 }}>
                                    <input
                                      type="checkbox"
                                      disabled={delegationRequestTypes.includes("CUSTOM_WORKFLOW")}
                                      checked={delegationRequestTypes.includes(opt.code)}
                                      onChange={() => setDelegationRequestTypes((current) =>
                                        current.includes(opt.code) ? current.filter((v) => v !== opt.code) : [...current, opt.code]
                                      )}
                                    />
                                    {opt.name}
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="ep-modal-footer">
                      <button className="ep-btn-outline" onClick={() => setShowCreateDelegationModal(false)}>Cancel</button>
                      <button className="ep-btn" onClick={() => void createDelegation()}>Create Delegation</button>
                    </div>
                  </div>
                </div>
              )}

              {detailDelegation && (() => {
                const status = delegationDerivedStatus(detailDelegation);
                return (
                <div className="ep-modal-overlay" onClick={() => setDelegationDetailId("")}>
                  <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="ep-modal-head">
                      <div>
                        <h2 className="ep-modal-title">Delegation Details</h2>
                        <p className="ep-modal-sub">{detailDelegation.reference}</p>
                      </div>
                      <button className="ep-icon-btn" onClick={() => setDelegationDetailId("")} aria-label="Close"><X size={16} aria-hidden /></button>
                    </div>
                    <div className="ep-modal-body">
                      <span className={`status-pill ${DELEGATION_STATUS_CLASS[status]}`} style={{ marginBottom: 12, display: "inline-block" }}>
                        {DELEGATION_STATUS_LABEL[status]}
                      </span>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13 }}>
                        <div><strong>Manager</strong><div>{detailDelegation.manager_name || "—"}</div></div>
                        <div><strong>Delegate</strong><div>{detailDelegation.delegate_name || "—"}</div></div>
                        <div><strong>Department</strong><div>{detailDelegation.department || "—"}</div></div>
                        <div><strong>Period</strong><div>{formatDateOnly(detailDelegation.from_date)} → {formatDateOnly(detailDelegation.to_date)}</div></div>
                        <div style={{ gridColumn: "1 / -1" }}><strong>Process</strong><div>
                          {detailDelegation.request_types?.length
                            ? detailDelegation.request_types.map((t: string) => resolveDelegationTypeLabel(t)).join(", ")
                            : "All types"}
                        </div></div>
                        {detailDelegation.reason && <div style={{ gridColumn: "1 / -1" }}><strong>Reason</strong><div>{detailDelegation.reason}</div></div>}
                        {detailDelegation.comments && <div style={{ gridColumn: "1 / -1" }}><strong>Comments</strong><div>{detailDelegation.comments}</div></div>}
                        <div><strong>Created By</strong><div>{detailDelegation.created_by_name || "—"}</div></div>
                        {!detailDelegation.active && (
                          <>
                            <div><strong>Ended By</strong><div>{detailDelegation.ended_by_name || "—"}</div></div>
                            {detailDelegation.end_reason && <div style={{ gridColumn: "1 / -1" }}><strong>End Reason</strong><div>{detailDelegation.end_reason}</div></div>}
                          </>
                        )}
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <strong style={{ fontSize: 13 }}>Audit Trail</strong>
                        {delegationAuditLoading ? (
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>Loading…</div>
                        ) : delegationAudit.length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>No audit entries.</div>
                        ) : (
                          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                            {delegationAudit.map((entry) => (
                              <div key={entry.id} style={{ fontSize: 12, borderLeft: "2px solid var(--border)", paddingLeft: 8 }}>
                                <strong>{entry.action}</strong> by {entry.actor_name || "—"} · {new Date(entry.created_at).toLocaleString()}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="ep-modal-footer">
                      {detailDelegation.active && (
                        <button className="ep-btn-danger" onClick={() => void endDelegation(detailDelegation.id)}>End Delegation</button>
                      )}
                      <button className="ep-btn-outline" onClick={() => setDelegationDetailId("")}>Close</button>
                    </div>
                  </div>
                </div>
                );
              })()}
            </div>
            );
          })()
          : page === "ROLES_PERMISSIONS" ? (
            <div className="ep-page">
              <div className="ep-breadcrumb"><span>Administration</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span>User Management</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span className="ep-breadcrumb-active">Roles & Permissions</span></div>
              <div className="ep-header">
                <div className="ep-header-text">
                  <h1 className="ep-title">Roles & Permissions</h1>
                  <p className="ep-subtitle">Manage feature access permissions and advance recovery settings.</p>
                </div>
                <div className="ep-actions">
                  <button className="ep-btn-outline" onClick={() => void loadAdminUsers()} disabled={adminUsersLoading}>{adminUsersLoading ? "Loading…" : "Refresh"}</button>
                </div>
              </div>

              {role === "ADMIN" && (
                <SettingsAccordion
                  title="Administration Feature Access"
                  subtitle="Control which roles can see each administration function in the sidebar."
                  open={featurePermOpen}
                  onToggle={() => {
                    if (!featurePermOpen) {
                      setFeaturePermDraft({ ...featurePermissions });
                    }
                    setFeaturePermOpen((v) => !v);
                  }}
                >
                  {(() => {
                    const GROUPS_LIST = permissionGroups.filter((g) => !g.hidden).map((g) => ({ key: g.name, label: displayOrgGroupName(g.name), dynamic: !!g.dynamic }));
                    const FEATURES_LIST = [
                      { key: "user_management",        label: "Users",                    group: "User Management" },
                      { key: "roles_permissions",      label: "Roles & Permissions",      group: "User Management" },
                      { key: "travel_setup",           label: "Travel Setup",             group: "Travel" },
                      { key: "org_structure",          label: "Org Structure",            group: "Org Structure" },
                      { key: "team_roster",            label: "Section Roster",           group: "Org Structure" },
                      { key: "ceo_management",         label: "CEO",                      group: "Org Structure" },
                      { key: "employees",              label: "Employees",                group: "Org Structure" },
                      { key: "exco_members",           label: "EXCO Members",             group: "Org Structure" },
                      { key: "managers",               label: "Managers",                 group: "Org Structure" },
                      { key: "leadership_assignments", label: "Leadership Assignments",   group: "Org Structure" },
                      { key: "workflow_builder",       label: "Approval Workflow Builder",group: "Org Structure" },
                      { key: "request_types",          label: "Process",            group: "Org Structure" },
                      { key: "reporting_lines",        label: "Reporting Lines",          group: "Org Structure" },
                      { key: "pdf_designer",           label: "PDF Designer",             group: "Org Structure" },
                      { key: "advance_pdf",            label: "Download Advance PDF",     group: "Advances" },
                      { key: "report_advances",        label: "Advance Requests / Approval Performance Reports", group: "Reports" },
                      { key: "report_reconciliation",  label: "Reconciliation Report",    group: "Reports" },
                      { key: "claims_sla_report",      label: "Clearance SLA Report",     group: "Reports" },
                      { key: "clearance_status_report", label: "Clearance Status Report",  group: "Reports" },
                      { key: "advance_recovery_settings", label: "Advance Recovery Settings", group: "Advances" },
                      { key: "manager_delegations",    label: "Manager Delegations",      group: "User Management" },
                      { key: "deductions",             label: "Deductions",               group: "Finance Operations" },
                      { key: "refundable",             label: "Refundable",               group: "Finance Operations" },
                      { key: "it_provisioning",        label: "IT Provisioning",          group: "IT" },
                      { key: "payments",               label: "Payments",                 group: "Finance Operations" },
                      { key: "capture",                label: "Capture Inbox",            group: "Finance Operations" },
                      { key: "accommodation",          label: "Accommodation",            group: "HR Operations" },
                      { key: "hr_operations_review",   label: "HR Operations Review",     group: "HR Operations" },
                      { key: "overtime_request",       label: "Overtime Request",         group: "Overtime" },
                      { key: "overtime_claim",         label: "Overtime Claim",            group: "Overtime" },
                      { key: "vendor_contracts",         label: "Vendor Contracts (View)",   group: "Contracts" },
                      { key: "vendor_contracts_manage",  label: "Vendor Contracts (Manage)", group: "Contracts" },
                      { key: "service_contracts",        label: "Service Contracts (View)",   group: "Contracts" },
                      { key: "service_contracts_manage", label: "Service Contracts (Manage)", group: "Contracts" },
                    ];
                    const draft = featurePermDraft;
                    const DEFAULTS: Record<string, string[]> = {
                      user_management:        ["ADMIN","MANAGER","EXCO"],
                      roles_permissions:      ["ADMIN","MANAGER","EXCO"],
                      travel_setup:           ["ADMIN","MANAGER"],
                      org_structure:          ["ADMIN"],
                      team_roster:            ["ADMIN"],

                      ceo_management:         ["ADMIN"],
                      employees:              ["ADMIN"],
                      exco_members:           ["ADMIN","MANAGER"],
                      managers:               ["ADMIN","MANAGER","EXCO"],
                      leadership_assignments: ["ADMIN","MANAGER","EXCO"],
                      workflow_builder:       ["ADMIN","MANAGER","EXCO"],
                      request_types:          ["ADMIN"],
                      reporting_lines:        ["ADMIN","MANAGER","EXCO"],
                      pdf_designer:           ["ADMIN"],
                      advance_pdf:            ["ADMIN","MANAGER","HOD","EXCO","FINANCE","CEO","EMPLOYEE"],
                      report_advances:        ["ADMIN","FINANCE"],
                      report_reconciliation:  ["ADMIN","FINANCE"],
                      claims_sla_report:      ["ADMIN","FINANCE"],
                      clearance_status_report: ["ADMIN","Department: Finance","Section: Treasury & Financial Accounting","Department: Human Resource","Department: Human Resources","Section: Human Resources Operations"],
                      advance_recovery_settings: ["ADMIN","FINANCE"],
                      manager_delegations:    ["ADMIN"],
                      deductions:             ["ADMIN"],
                      refundable:             ["ADMIN"],
    it_provisioning:        ["ADMIN"],
                      payments:               ["ADMIN","Department: Finance"],
                      capture:                ["ADMIN","Section: Treasury & Financial Accounting"],
                      accommodation:          ["ADMIN","Section: Human Resources Operations","Section: Treasury & Financial Accounting"],
                      hr_operations_review:   ["ADMIN","Section: Human Resources Operations"],
                      overtime_request:       ["ADMIN","MANAGER","HOD","EXCO","FINANCE","CEO","EMPLOYEE"],
                      overtime_claim:         ["ADMIN","MANAGER","HOD","EXCO","FINANCE","CEO","EMPLOYEE"],
                      vendor_contracts:         ["ADMIN"],
                      vendor_contracts_manage:  ["ADMIN"],
                      service_contracts:        ["ADMIN"],
                      service_contracts_manage: ["ADMIN"],
                    };
                    function toggleRole(featureKey: string, roleKey: string) {
                      if (roleKey === "ADMIN") return;
                      const current = draft[featureKey] ?? DEFAULTS[featureKey] ?? [];
                      const next = current.includes(roleKey)
                        ? current.filter((r) => r !== roleKey)
                        : [...current, roleKey];
                      setFeaturePermDraft({ ...draft, [featureKey]: next });
                    }
                    // Every real Division/Department/Section/Team already exists as a
                    // live column (membership computed automatically from org data) -
                    // "adding" one here just reveals it if it's currently hidden.
                    const orgGroupPool = addGroupType === "Custom"
                      ? []
                      : permissionGroups.filter((g) => g.dynamic && g.name.startsWith(`${addGroupType}: `));

                    async function handleAddGroup() {
                      if (addGroupType === "Custom") {
                        const name = newGroupName.trim();
                        if (!name) return;
                        setGroupSaving(true);
                        try {
                          const updated = await api.createPermissionGroup(name);
                          setPermissionGroups(Array.isArray(updated) ? updated : []);
                          setNewGroupName("");
                        } catch (err: any) {
                          alert(err?.message || "Failed to add group.");
                        } finally {
                          setGroupSaving(false);
                        }
                        return;
                      }
                      if (!selectedOrgGroupName) return;
                      setGroupSaving(true);
                      try {
                        const updated = await api.setGroupVisibility(selectedOrgGroupName, false);
                        setPermissionGroups(Array.isArray(updated) ? updated : []);
                        setSelectedOrgGroupName("");
                      } catch (err: any) {
                        alert(err?.message || "Failed to add group.");
                      } finally {
                        setGroupSaving(false);
                      }
                    }
                    async function handleRemoveGroup(name: string) {
                      if (name === "ADMIN") return;
                      if (!window.confirm(`Remove the "${name}" group? Users in this group will lose any access granted by it.`)) return;
                      setGroupSaving(true);
                      try {
                        const updated = await api.deletePermissionGroup(name);
                        setPermissionGroups(Array.isArray(updated) ? updated : []);
                      } catch (err: any) {
                        alert(err?.message || "Failed to remove group.");
                      } finally {
                        setGroupSaving(false);
                      }
                    }
                    async function handleToggleGroupVisibility(name: string, hidden: boolean) {
                      if (name === "ADMIN") return;
                      setGroupSaving(true);
                      try {
                        const updated = await api.setGroupVisibility(name, hidden);
                        setPermissionGroups(Array.isArray(updated) ? updated : []);
                      } catch (err: any) {
                        alert(err?.message || "Failed to update column visibility.");
                      } finally {
                        setGroupSaving(false);
                      }
                    }
                    async function handleToggleMembers(name: string) {
                      if (expandedGroupName === name) {
                        setExpandedGroupName(null);
                        return;
                      }
                      setExpandedGroupName(name);
                      setMemberSearch("");
                      setGroupMembersLoading(true);
                      try {
                        const [members] = await Promise.all([
                          api.groupMembers(name),
                          memberDirectory.length ? Promise.resolve(memberDirectory) : api.requestDirectory("company").then((rows: RequestDirectoryUser[]) => {
                            setMemberDirectory(Array.isArray(rows) ? rows : []);
                            return rows;
                          })
                        ]);
                        setGroupMembers(Array.isArray(members) ? members : []);
                      } catch (err: any) {
                        alert(err?.message || "Failed to load group members.");
                        setExpandedGroupName(null);
                      } finally {
                        setGroupMembersLoading(false);
                      }
                    }
                    async function handleAddMember(name: string, userId: string) {
                      setMemberSaving(true);
                      try {
                        const updated = await api.addGroupMember(name, userId);
                        setGroupMembers(Array.isArray(updated) ? updated : []);
                        setMemberSearch("");
                        const groupsResp = await api.permissionGroups();
                        setPermissionGroups(Array.isArray(groupsResp) ? groupsResp : []);
                      } catch (err: any) {
                        alert(err?.message || "Failed to add member.");
                      } finally {
                        setMemberSaving(false);
                      }
                    }
                    async function handleRemoveMember(name: string, userId: string) {
                      setMemberSaving(true);
                      try {
                        const updated = await api.removeGroupMember(name, userId);
                        setGroupMembers(Array.isArray(updated) ? updated : []);
                        const groupsResp = await api.permissionGroups();
                        setPermissionGroups(Array.isArray(groupsResp) ? groupsResp : []);
                      } catch (err: any) {
                        alert(err?.message || "Failed to remove member.");
                      } finally {
                        setMemberSaving(false);
                      }
                    }
                    const groups = Array.from(new Set(FEATURES_LIST.map((f) => f.group)));
                    const totalRoles = GROUPS_LIST.length;
                    const totalFeatures = FEATURES_LIST.length;
                    const totalCells = totalRoles * totalFeatures;
                    const grantedCells = FEATURES_LIST.reduce((sum, feat) => {
                      const allowed = draft[feat.key] ?? DEFAULTS[feat.key] ?? [];
                      return sum + GROUPS_LIST.filter((r) => allowed.includes(r.key)).length;
                    }, 0);
                    const restrictedCells = totalCells - grantedCells;
                    const coveragePct = totalCells > 0 ? Math.round((grantedCells / totalCells) * 100) : 0;
                    const groupsTotalPages = Math.max(1, Math.ceil(GROUPS_LIST.length / featureAccessGroupsPageSize));
                    const groupsCurrentPage = Math.min(featureAccessGroupsPage, groupsTotalPages);
                    const pagedGroupsList = GROUPS_LIST.slice(
                      (groupsCurrentPage - 1) * featureAccessGroupsPageSize,
                      groupsCurrentPage * featureAccessGroupsPageSize
                    );
                    const searchQuery = featureAccessSearch.trim().toLowerCase();
                    const filteredFeatures = FEATURES_LIST.filter((f) =>
                      (featureAccessModuleFilter === "ALL" || f.group === featureAccessModuleFilter) &&
                      (!searchQuery || f.label.toLowerCase().includes(searchQuery) || f.key.toLowerCase().includes(searchQuery))
                    );
                    const visibleGroups = groups.filter((group) => filteredFeatures.some((f) => f.group === group));
                    const selectedFeature = FEATURES_LIST.find((f) => f.key === featureAccessSelectedKey) || null;
                    async function handleRestoreDefaults() {
                      if (!window.confirm("Restore all features to their default role access? This discards any unsaved changes and any previously saved customizations once you click Save Changes.")) return;
                      setFeaturePermDraft({ ...DEFAULTS });
                    }
                    return (
                      <div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
                          {[
                            { label: "Total Roles", value: totalRoles },
                            { label: "Total Features", value: totalFeatures },
                            { label: "Granted", value: grantedCells },
                            { label: "Restricted", value: restrictedCells },
                            { label: "Access Coverage", value: `${coveragePct}%` }
                          ].map((tile) => (
                            <div key={tile.label} style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-secondary,#f8fafc)" }}>
                              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted,#6b7280)", fontWeight: 600 }}>{tile.label}</div>
                              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{tile.value}</div>
                            </div>
                          ))}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                          <input
                            type="text"
                            placeholder="Search features…"
                            value={featureAccessSearch}
                            onChange={(e) => setFeatureAccessSearch(e.target.value)}
                            style={{ padding: "6px 10px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, fontSize: 13, minWidth: 200 }}
                          />
                          <select
                            value={featureAccessModuleFilter}
                            onChange={(e) => setFeatureAccessModuleFilter(e.target.value)}
                            style={{ padding: "6px 10px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, fontSize: 13 }}
                          >
                            <option value="ALL">All Modules</option>
                            {groups.map((group) => (
                              <option key={group} value={group}>{group}</option>
                            ))}
                          </select>
                        </div>

                        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                          <div style={{ overflowX: "auto", flex: 1, minWidth: 0 }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                              <thead>
                                <tr>
                                  <th style={{ textAlign: "left", padding: "6px 10px", background: "var(--bg-secondary,#f8fafc)", borderBottom: "2px solid var(--border,#e5e7eb)", minWidth: 180 }}>Feature</th>
                                  {pagedGroupsList.map((r) => (
                                    <th key={r.key} style={{ padding: "6px 8px", background: "var(--bg-secondary,#f8fafc)", borderBottom: "2px solid var(--border,#e5e7eb)", textAlign: "center", minWidth: 70, fontSize: 12, fontWeight: 600 }}>
                                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                                        <span>{r.label}</span>
                                        {r.key !== "ADMIN" && !r.dynamic && (
                                          <button
                                            type="button"
                                            onClick={() => void handleRemoveGroup(r.key)}
                                            disabled={groupSaving}
                                            title={`Remove ${r.label} group`}
                                            style={{ border: "none", background: "none", cursor: groupSaving ? "not-allowed" : "pointer", color: "var(--text-muted,#6b7280)", fontSize: 12, lineHeight: 1, padding: 0 }}
                                          >
                                            ×
                                          </button>
                                        )}
                                      </div>
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {visibleGroups.map((group) => {
                                  const groupFeatures = filteredFeatures.filter((f) => f.group === group);
                                  return (
                                    <React.Fragment key={group}>
                                      <tr>
                                        <td colSpan={pagedGroupsList.length + 1} style={{ padding: "8px 10px 4px", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted,#6b7280)", background: "var(--bg-secondary,#f8fafc)", borderTop: "1px solid var(--border,#e5e7eb)" }}>{group}</td>
                                      </tr>
                                      {groupFeatures.map((feat, idx) => {
                                        const allowed = draft[feat.key] ?? DEFAULTS[feat.key] ?? [];
                                        const isSelected = feat.key === featureAccessSelectedKey;
                                        return (
                                          <tr key={feat.key} style={{ background: isSelected ? "rgba(37,99,235,0.08)" : idx % 2 === 0 ? "transparent" : "var(--bg-secondary,#f8fafc)" }}>
                                            <td
                                              style={{ padding: "7px 10px", borderBottom: "1px solid var(--border,#e5e7eb)", cursor: "pointer" }}
                                              onClick={() => setFeatureAccessSelectedKey(isSelected ? null : feat.key)}
                                            >
                                              {feat.label}
                                            </td>
                                            {pagedGroupsList.map((r) => {
                                              const checked = allowed.includes(r.key);
                                              const isAdmin = r.key === "ADMIN";
                                              return (
                                                <td key={r.key} style={{ textAlign: "center", borderBottom: "1px solid var(--border,#e5e7eb)", padding: "7px 8px" }}>
                                                  <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    disabled={isAdmin}
                                                    title={isAdmin ? "Admin always has access" : undefined}
                                                    onChange={() => toggleRole(feat.key, r.key)}
                                                    style={{ cursor: isAdmin ? "not-allowed" : "pointer", accentColor: "var(--primary,#2563eb)" }}
                                                  />
                                                </td>
                                              );
                                            })}
                                          </tr>
                                        );
                                      })}
                                    </React.Fragment>
                                  );
                                })}
                                {visibleGroups.length === 0 && (
                                  <tr>
                                    <td colSpan={pagedGroupsList.length + 1} style={{ padding: "16px 10px", textAlign: "center", color: "var(--text-muted,#6b7280)" }}>
                                      No features match your search/filter.
                                    </td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                            {GROUPS_LIST.length > 0 && (
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px", flexWrap: "wrap", gap: 10 }}>
                                <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>
                                  Showing groups {(groupsCurrentPage - 1) * featureAccessGroupsPageSize + 1}
                                  –{Math.min(groupsCurrentPage * featureAccessGroupsPageSize, GROUPS_LIST.length)} of {GROUPS_LIST.length}
                                </span>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <select
                                    value={featureAccessGroupsPageSize}
                                    onChange={(e) => { setFeatureAccessGroupsPageSize(Number(e.target.value)); setFeatureAccessGroupsPage(1); }}
                                    style={{ padding: "4px 8px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, fontSize: 12 }}
                                  >
                                    {[8, 16, 24].map((n) => <option key={n} value={n}>{n} per page</option>)}
                                  </select>
                                  <button
                                    className="ep-btn-outline"
                                    type="button"
                                    onClick={() => setFeatureAccessGroupsPage((p) => Math.max(1, p - 1))}
                                    disabled={groupsCurrentPage === 1}
                                    style={{ padding: "4px 8px" }}
                                  >
                                    <ChevronLeft size={14} aria-hidden />
                                  </button>
                                  {Array.from({ length: groupsTotalPages }, (_, i) => i + 1).slice(0, 7).map((n) => (
                                    <button
                                      key={n}
                                      type="button"
                                      className={`button small-button ${groupsCurrentPage === n ? "button-primary" : "button-subtle"}`}
                                      onClick={() => setFeatureAccessGroupsPage(n)}
                                    >
                                      {n}
                                    </button>
                                  ))}
                                  <button
                                    className="ep-btn-outline"
                                    type="button"
                                    onClick={() => setFeatureAccessGroupsPage((p) => Math.min(groupsTotalPages, p + 1))}
                                    disabled={groupsCurrentPage === groupsTotalPages}
                                    style={{ padding: "4px 8px" }}
                                  >
                                    <ChevronRight size={14} aria-hidden />
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>

                          {selectedFeature && (
                            <div style={{ width: 260, flexShrink: 0, border: "1px solid var(--border,#e5e7eb)", borderRadius: 8, padding: 14, background: "var(--bg-secondary,#f8fafc)" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                                <div style={{ fontWeight: 700, fontSize: 14 }}>{selectedFeature.label}</div>
                                <button type="button" onClick={() => setFeatureAccessSelectedKey(null)} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text-muted,#6b7280)", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                              </div>
                              <div style={{ fontSize: 12, color: "var(--text-muted,#6b7280)", marginBottom: 2 }}>Module</div>
                              <div style={{ fontSize: 13, marginBottom: 10 }}>{selectedFeature.group}</div>
                              <div style={{ fontSize: 12, color: "var(--text-muted,#6b7280)", marginBottom: 2 }}>Key</div>
                              <div style={{ fontSize: 13, fontFamily: "monospace", marginBottom: 10 }}>{selectedFeature.key}</div>
                              <div style={{ fontSize: 12, color: "var(--text-muted,#6b7280)", marginBottom: 4 }}>Has Access</div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                {GROUPS_LIST.map((r) => {
                                  const allowed = draft[selectedFeature.key] ?? DEFAULTS[selectedFeature.key] ?? [];
                                  const checked = allowed.includes(r.key);
                                  const isAdmin = r.key === "ADMIN";
                                  return (
                                    <label key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: isAdmin ? "not-allowed" : "pointer" }}>
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={isAdmin}
                                        onChange={() => toggleRole(selectedFeature.key, r.key)}
                                        style={{ accentColor: "var(--primary,#2563eb)" }}
                                      />
                                      <span>{r.label}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                          <select
                            value={addGroupType}
                            onChange={(e) => { setAddGroupType(e.target.value as typeof addGroupType); setSelectedOrgGroupName(""); setNewGroupName(""); }}
                            style={{ padding: "6px 10px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, fontSize: 13 }}
                          >
                            <option value="Division">{ADD_GROUP_TYPE_LABELS.Division}</option>
                            <option value="Department">{ADD_GROUP_TYPE_LABELS.Department}</option>
                            <option value="Section">{ADD_GROUP_TYPE_LABELS.Section}</option>
                            <option value="Team">{ADD_GROUP_TYPE_LABELS.Team}</option>
                            <option value="Custom">{ADD_GROUP_TYPE_LABELS.Custom}</option>
                          </select>
                          {addGroupType === "Custom" ? (
                            <input
                              type="text"
                              placeholder="New group name"
                              value={newGroupName}
                              onChange={(e) => setNewGroupName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") void handleAddGroup(); }}
                              style={{ padding: "6px 10px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, fontSize: 13 }}
                            />
                          ) : orgGroupPool.filter((g) => g.hidden).length === 0 ? (
                            <span style={{ fontSize: 12, color: "var(--text-muted,#6b7280)" }}>
                              Every {ADD_GROUP_TYPE_LABELS[addGroupType].toLowerCase()} already has a column — use Manage Columns to re-hide one.
                            </span>
                          ) : (
                            <select
                              value={selectedOrgGroupName}
                              onChange={(e) => setSelectedOrgGroupName(e.target.value)}
                              style={{ padding: "6px 10px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, fontSize: 13, minWidth: 220 }}
                            >
                              <option value="">Select a {ADD_GROUP_TYPE_LABELS[addGroupType].toLowerCase()}…</option>
                              {orgGroupPool.filter((g) => g.hidden).map((g) => (
                                <option key={g.name} value={g.name}>{displayOrgGroupName(g.name)} ({g.member_count})</option>
                              ))}
                            </select>
                          )}
                          <button
                            className="ep-btn-outline"
                            type="button"
                            onClick={() => void handleAddGroup()}
                            disabled={groupSaving || (addGroupType === "Custom" ? !newGroupName.trim() : !selectedOrgGroupName)}
                          >
                            {groupSaving ? "Saving…" : "+ Add Group"}
                          </button>
                          <button className="ep-btn-outline" type="button" onClick={() => setManageColumnsOpen((v) => !v)}>
                            {manageColumnsOpen ? "Hide Manage Columns" : `Manage Columns (${permissionGroups.filter((g) => g.hidden).length} hidden)`}
                          </button>
                        </div>
                        {manageColumnsOpen && (
                          <div style={{ marginTop: 10, border: "1px solid var(--border,#e5e7eb)", borderRadius: 8, padding: "10px 14px", maxHeight: 260, overflowY: "auto" }}>
                            <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text-muted,#6b7280)" }}>
                              Choose which roles/departments/divisions appear as columns in the table above. Hiding a column doesn't remove the group or anyone's access — it just declutters the view.
                            </p>
                            {[...permissionGroups].sort((a, b) => a.name.localeCompare(b.name)).map((g) => {
                              const memberFilter = memberSearch.trim().toLowerCase();
                              const memberResults = !memberFilter ? [] : memberDirectory.filter((u) =>
                                !groupMembers.some((m) => m.id === u.id) &&
                                ((u.full_name || "").toLowerCase().includes(memberFilter) || u.email.toLowerCase().includes(memberFilter))
                              ).slice(0, 8);
                              return (
                              <div key={g.name} style={{ padding: "5px 0", borderBottom: "1px solid var(--border,#f1f5f9)" }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: g.name === "ADMIN" ? "not-allowed" : "pointer" }}>
                                    <input
                                      type="checkbox"
                                      checked={!g.hidden}
                                      disabled={g.name === "ADMIN" || groupSaving}
                                      onChange={(e) => void handleToggleGroupVisibility(g.name, !e.target.checked)}
                                      style={{ accentColor: "var(--primary,#2563eb)" }}
                                    />
                                    <span>{g.name}</span>
                                    <span style={{ color: "var(--text-muted,#6b7280)" }}>({g.member_count})</span>
                                  </label>
                                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    {!g.dynamic && (
                                      <button type="button" onClick={() => void handleToggleMembers(g.name)}
                                        style={{ border: "none", background: "none", cursor: "pointer", color: "var(--primary,#2563eb)", fontSize: 12 }}>
                                        {expandedGroupName === g.name ? "Hide Members" : "Members"}
                                      </button>
                                    )}
                                    {!g.dynamic && g.name !== "ADMIN" && (
                                      <button type="button" onClick={() => void handleRemoveGroup(g.name)} disabled={groupSaving}
                                        style={{ border: "none", background: "none", cursor: groupSaving ? "not-allowed" : "pointer", color: "var(--text-muted,#6b7280)", fontSize: 12 }}>
                                        Delete
                                      </button>
                                    )}
                                  </div>
                                </div>
                                {!g.dynamic && expandedGroupName === g.name && (
                                  <div style={{ marginTop: 8, marginLeft: 24, padding: "8px 10px", background: "var(--bg-secondary,#f8fafc)", borderRadius: 6 }}>
                                    {groupMembersLoading ? (
                                      <p style={{ fontSize: 12, color: "var(--text-muted,#6b7280)", margin: 0 }}>Loading members…</p>
                                    ) : (
                                      <>
                                        {groupMembers.length === 0 && (
                                          <p style={{ fontSize: 12, color: "var(--text-muted,#6b7280)", margin: "0 0 6px" }}>No individual members yet.</p>
                                        )}
                                        {groupMembers.map((m) => (
                                          <div key={m.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0" }}>
                                            <span style={{ fontSize: 13 }}>{m.full_name || m.email} <span style={{ color: "var(--text-muted,#6b7280)", fontSize: 11 }}>({m.email})</span></span>
                                            <button type="button" onClick={() => void handleRemoveMember(g.name, m.id)} disabled={memberSaving}
                                              style={{ border: "none", background: "none", cursor: memberSaving ? "not-allowed" : "pointer", color: "var(--text-muted,#6b7280)", fontSize: 12 }}>
                                              Remove
                                            </button>
                                          </div>
                                        ))}
                                        <div style={{ position: "relative", marginTop: 6 }}>
                                          <input
                                            type="text"
                                            placeholder="Search a person by name or email…"
                                            value={memberSearch}
                                            onChange={(e) => setMemberSearch(e.target.value)}
                                            style={{ width: "100%", padding: "5px 8px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, fontSize: 12 }}
                                          />
                                          {memberResults.length > 0 && (
                                            <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, marginTop: 4, background: "var(--bg,#fff)" }}>
                                              {memberResults.map((u) => (
                                                <div key={u.id}
                                                  onClick={() => !memberSaving && void handleAddMember(g.name, u.id)}
                                                  style={{ padding: "5px 8px", fontSize: 12, cursor: memberSaving ? "not-allowed" : "pointer" }}
                                                >
                                                  {u.full_name || u.email} <span style={{ color: "var(--text-muted,#6b7280)" }}>({u.email})</span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                              );
                            })}
                          </div>
                        )}
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14, gap: 8 }}>
                          <button className="ep-btn-outline" onClick={() => void handleRestoreDefaults()}>Restore Defaults</button>
                          <button className="ep-btn-outline" onClick={() => setFeaturePermDraft({ ...featurePermissions })}>Reset</button>
                          <button className="ep-btn" onClick={() => void saveFeaturePermissions()} disabled={featurePermSaving}>{featurePermSaving ? "Saving…" : "Save Changes"}</button>
                        </div>
                      </div>
                    );
                  })()}
                </SettingsAccordion>
              )}

              {canAccessFeature("advance_recovery_settings") && (
                <SettingsAccordion
                  title="Advance Recovery Settings"
                  subtitle="How long an employee has to clear a paid travel advance before it's flagged Overdue, and the recovery period used to calculate a not-cleared deduction."
                  open={recoverySettingsOpen}
                  onToggle={() => { const next = !recoverySettingsOpen; setRecoverySettingsOpen(next); if (next) void loadRecoverySettings(); }}
                >
                  {recoverySettingsLoading ? (
                    <div style={{ color: "var(--muted)" }}>Loading…</div>
                  ) : (
                    <div>
                      <div className="form-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 520 }}>
                        <div className="form-field">
                          <label>Clearance Duration (days)</label>
                          <input type="number" min={1} value={recoveryDurationDraft} onChange={(e) => setRecoveryDurationDraft(e.target.value)} />
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Days after payment before an uncleared advance shows as Overdue.</div>
                        </div>
                        <div className="form-field">
                          <label>Recovery Period (months)</label>
                          <input type="number" min={1} value={recoveryMonthsDraft} onChange={(e) => setRecoveryMonthsDraft(e.target.value)} />
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Total amount not cleared ÷ this number = monthly deduction shown to Finance.</div>
                        </div>
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <button className="button" onClick={() => void saveRecoverySettings()} disabled={recoverySettingsSaving}>
                          {recoverySettingsSaving ? "Saving…" : "Save Settings"}
                        </button>
                      </div>
                    </div>
                  )}
                </SettingsAccordion>
              )}

              {role === "ADMIN" && (
                <SettingsAccordion
                  title="Session Timeout"
                  subtitle="How long a user can be inactive before they're warned, then automatically logged out."
                  open={sessionSettingsOpen}
                  onToggle={() => { const next = !sessionSettingsOpen; setSessionSettingsOpen(next); if (next) void loadSessionSettingsDraft(); }}
                >
                  {sessionSettingsLoading ? (
                    <div style={{ color: "var(--muted)" }}>Loading…</div>
                  ) : (
                    <div>
                      <div className="form-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 520 }}>
                        <div className="form-field">
                          <label>Idle Timeout (minutes)</label>
                          <input type="number" min={1} value={idleTimeoutDraft} onChange={(e) => setIdleTimeoutDraft(e.target.value)} />
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Minutes of no activity before a user is logged out.</div>
                        </div>
                        <div className="form-field">
                          <label>Warning Period (seconds)</label>
                          <input type="number" min={10} value={warningSecondsDraft} onChange={(e) => setWarningSecondsDraft(e.target.value)} />
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>How long the "Still there?" prompt shows before logging out.</div>
                        </div>
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <button className="button" onClick={() => void saveSessionSettings()} disabled={sessionSettingsSaving}>
                          {sessionSettingsSaving ? "Saving…" : "Save Settings"}
                        </button>
                      </div>
                    </div>
                  )}
                </SettingsAccordion>
              )}
            </div>
          ) : page === "TRAVEL_SETUP" ? (
            <div className="ep-page">
              <div className="ep-breadcrumb"><span>Administration</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span className="ep-breadcrumb-active">Travel Setup</span></div>
              <div className="ep-header">
                <div className="ep-header-text">
                  <h1 className="ep-title">Travel Setup</h1>
                  <p className="ep-subtitle">Maintain travel types, allowance rates, and approved hotel accommodations.</p>
                </div>
                <div className="ep-actions">
                  <button className="ep-btn-outline" onClick={() => void Promise.all([loadTravelTypes(), loadHotels()])} disabled={travelTypesLoading || hotelsLoading}>Refresh</button>
                </div>
              </div>

              {/* ── Travel Types panel ── */}
              <div className="ep-panel">
                <div className="ep-panel-head">
                  <div>
                    <div className="ep-panel-title">Travel Types & Rates</div>
                    <div className="ep-panel-sub">Configure travel allowance types and rates per employee category.</div>
                  </div>
                  <button className="ep-btn" onClick={() => setShowAddTravelTypeModal(true)}><Plus size={15} />Add Travel Type</button>
                </div>
                <div className="ep-table-wrap">
                  {travelTypesLoading ? (
                    <div className="ep-loading"><RefreshCw size={18} className="rl-spin" /><p>Loading…</p></div>
                  ) : travelTypes.length === 0 ? (
                    <div className="ep-empty"><p>No travel types yet. Click <strong>Add Travel Type</strong> to create one.</p></div>
                  ) : (
                    <table className="ep-table">
                      <thead>
                        <tr><th>Name</th><th>Location Mode</th><th>Rate Type</th><th>Currency</th><th>General Staff</th><th>EXCO</th><th>CEO</th><th>Actions</th></tr>
                      </thead>
                      <tbody>
                        {travelTypes.map((type) => (
                          <tr key={type.id}>
                            <td style={{ fontWeight: 600 }}>{type.name}</td>
                            <td><span className="status-pill status-pill-info">{type.location_mode === "DISTRICT" ? "Districts" : "Countries / Cities"}</span></td>
                            <td>{type.rate_kind === "DAILY" ? "Daily" : "Meal"}</td>
                            <td>
                              <span title={CURRENCIES.find(c => c.code === (type.currency ?? "LSL"))?.name ?? type.currency}>
                                <strong>{getCurrencySymbol(type.currency)}</strong>
                                {" "}{type.currency ?? "LSL"}
                              </span>
                            </td>
                            <td>{fmtMoney(type.rate_general_staff, type.currency)}</td>
                            <td>{fmtMoney(type.rate_exco, type.currency)}</td>
                            <td>{fmtMoney(type.rate_ceo, type.currency)}</td>
                            <td>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button className="ep-icon-btn" onClick={() => setEditingTravelType(type)} title="Edit"><Edit3 size={13} aria-hidden /></button>
                                <button className="ep-icon-btn" style={{ color: "#dc2626" }} onClick={() => void deleteTravelType(type.id)} title="Delete"><Trash2 size={13} aria-hidden /></button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* ── Hotels panel ── */}
              <div className="ep-panel">
                <div className="ep-panel-head">
                  <div>
                    <div className="ep-panel-title">Hotels & Accommodation</div>
                    <div className="ep-panel-sub">Manage approved hotels available for accommodation requests.</div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="ep-btn-outline" onClick={() => void exportHotelsCSV()} disabled={hotelsTotal === 0}><Download size={15} />Export CSV</button>
                    <button className="ep-btn-outline" onClick={() => setShowImportHotelsModal(true)}><Upload size={15} />Import CSV</button>
                    <button className="ep-btn" onClick={() => setShowAddHotelModal(true)}><Plus size={15} />Add Hotel</button>
                  </div>
                </div>
                <div style={{ padding: "0 16px 12px" }}>
                  <input
                    className="ep-form-input"
                    style={{ maxWidth: 320 }}
                    placeholder="Search hotels by name, district, city, country…"
                    value={hotelSearch}
                    onChange={(e) => handleHotelSearchChange(e.target.value)}
                  />
                </div>
                <div className="ep-table-wrap">
                  {hotelsLoading ? (
                    <div className="ep-loading"><RefreshCw size={18} className="rl-spin" /><p>Loading…</p></div>
                  ) : hotels.length === 0 ? (
                    <div className="ep-empty">
                      <p>{hotelSearch ? "No hotels match your search." : (
                        <>No hotels yet. Click <strong>Add Hotel</strong> to add one.</>
                      )}</p>
                    </div>
                  ) : (
                    <table className="ep-table">
                      <thead>
                        <tr><th>Hotel Name</th><th>District / City</th><th>Country</th><th>Contact</th><th>Actions</th></tr>
                      </thead>
                      <tbody>
                        {hotels.map((hotel) => (
                          <tr key={hotel.id}>
                            <td style={{ fontWeight: 600 }}>{hotel.name}</td>
                            <td>{hotel.district || hotel.city || "—"}</td>
                            <td>{hotel.country || "Lesotho"}</td>
                            <td>{hotel.contact || "—"}</td>
                            <td>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button className="ep-icon-btn" onClick={() => setEditingHotel({ ...hotel })} title="Edit"><Edit3 size={13} /></button>
                                <button className="ep-icon-btn danger" onClick={() => void deleteHotel(hotel)} title="Delete"><Trash2 size={13} /></button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {hotelsTotal > HOTELS_PAGE_SIZE && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px" }}>
                    <span style={{ fontSize: "0.85rem", color: "var(--muted, #888)" }}>
                      {hotelPage * HOTELS_PAGE_SIZE + 1}–{Math.min((hotelPage + 1) * HOTELS_PAGE_SIZE, hotelsTotal)} of {hotelsTotal}
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="ep-btn-outline" style={{ padding: "5px 12px" }} disabled={hotelPage === 0} onClick={() => handleHotelPageChange(hotelPage - 1)}>Previous</button>
                      <button
                        className="ep-btn-outline"
                        style={{ padding: "5px 12px" }}
                        disabled={(hotelPage + 1) * HOTELS_PAGE_SIZE >= hotelsTotal}
                        onClick={() => handleHotelPageChange(hotelPage + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Add Travel Type Modal ── */}
              {showAddTravelTypeModal && (
                <div className="ep-modal-overlay" onClick={() => setShowAddTravelTypeModal(false)}>
                  <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="ep-modal-head">
                      <div><h2 className="ep-modal-title">Add Travel Type</h2><p className="ep-modal-sub">Define a new travel allowance type with rates per employee category.</p></div>
                      <button className="ep-icon-btn" onClick={() => setShowAddTravelTypeModal(false)}><X size={18} /></button>
                    </div>
                    <div className="ep-modal-body">
                      <div className="ep-form-group">
                        <label>Travel Type Name <span className="ep-required">*</span></label>
                        <input className="ep-form-input" placeholder="e.g. Business Travel Allowance" value={newTravelTypeName} onChange={(e) => setNewTravelTypeName(e.target.value)} />
                      </div>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>Location Mode <span className="ep-required">*</span></label>
                          <select className="ep-form-select" value={newTravelTypeLocationMode} onChange={(e) => setNewTravelTypeLocationMode(e.target.value as "DISTRICT" | "COUNTRY_CITY")}>
                            <option value="COUNTRY_CITY">Countries / Cities</option>
                            <option value="DISTRICT">Districts</option>
                          </select>
                        </div>
                        <div className="ep-form-group">
                          <label>Rate Type <span className="ep-required">*</span></label>
                          <select className="ep-form-select" value={newTravelTypeRateKind} onChange={(e) => setNewTravelTypeRateKind(e.target.value as "MEAL" | "DAILY")}>
                            <option value="DAILY">Daily Rate</option>
                            <option value="MEAL">Meal Rate</option>
                          </select>
                        </div>
                      </div>
                      <div className="ep-form-group">
                        <label>Currency <span className="ep-required">*</span></label>
                        <select className="ep-form-select" value={newTravelTypeCurrency} onChange={(e) => setNewTravelTypeCurrency(e.target.value)}>
                          {CURRENCIES.map(c => (
                            <option key={c.code} value={c.code}>{c.symbol} — {c.code} ({c.name})</option>
                          ))}
                        </select>
                      </div>
                      <div className="ep-form-row-3">
                        <div className="ep-form-group">
                          <label>General Staff Rate ({getCurrencySymbol(newTravelTypeCurrency)})</label>
                          <input type="number" min="0" step="0.01" className="ep-form-input" placeholder="0.00" value={newTravelTypeGeneralRate} onChange={(e) => setNewTravelTypeGeneralRate(e.target.value)} />
                        </div>
                        <div className="ep-form-group">
                          <label>EXCO Rate ({getCurrencySymbol(newTravelTypeCurrency)})</label>
                          <input type="number" min="0" step="0.01" className="ep-form-input" placeholder="0.00" value={newTravelTypeExcoRate} onChange={(e) => setNewTravelTypeExcoRate(e.target.value)} />
                        </div>
                        <div className="ep-form-group">
                          <label>CEO Rate ({getCurrencySymbol(newTravelTypeCurrency)})</label>
                          <input type="number" min="0" step="0.01" className="ep-form-input" placeholder="0.00" value={newTravelTypeCeoRate} onChange={(e) => setNewTravelTypeCeoRate(e.target.value)} />
                        </div>
                      </div>
                      <div className="ep-form-group">
                        <label>Payment Methods <span className="ep-required">*</span></label>
                        <div style={{ display: "flex", gap: 18 }}>
                          <label className="ep-checkbox-label">
                            <input
                              type="checkbox"
                              checked={newTravelTypeAllowedPaymentMethods.includes("ECOCASH")}
                              onChange={(e) => setNewTravelTypeAllowedPaymentMethods((prev) =>
                                e.target.checked ? [...prev, "ECOCASH"] : prev.filter((m) => m !== "ECOCASH")
                              )}
                            />
                            <span>EcoCash</span>
                          </label>
                          <label className="ep-checkbox-label">
                            <input
                              type="checkbox"
                              checked={newTravelTypeAllowedPaymentMethods.includes("BANK")}
                              onChange={(e) => setNewTravelTypeAllowedPaymentMethods((prev) =>
                                e.target.checked ? [...prev, "BANK"] : prev.filter((m) => m !== "BANK")
                              )}
                            />
                            <span>Bank Transfer</span>
                          </label>
                        </div>
                      </div>
                      <label className="ep-checkbox-label">
                        <input type="checkbox" checked={newTravelTypeRequiresAccommodation} onChange={(e) => setNewTravelTypeRequiresAccommodation(e.target.checked)} />
                        <span>Requires accommodation booking</span>
                      </label>
                      <label className="ep-checkbox-label">
                        <input type="checkbox" checked={newTravelTypeAllowExternalBeneficiary} onChange={(e) => setNewTravelTypeAllowExternalBeneficiary(e.target.checked)} />
                        <span>Allow "Apply for Other" (external beneficiary)</span>
                      </label>
                    </div>
                    <div className="ep-modal-footer">
                      <button className="ep-btn-outline" onClick={() => setShowAddTravelTypeModal(false)}>Cancel</button>
                      <button className="ep-btn" onClick={() => { void createTravelType(); setShowAddTravelTypeModal(false); }}>Add Travel Type</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Edit Travel Type Modal ── */}
              {editingTravelType && (
                <div className="ep-modal-overlay" onClick={() => setEditingTravelType(null)}>
                  <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="ep-modal-head">
                      <div><h2 className="ep-modal-title">Edit Travel Type</h2><p className="ep-modal-sub">Update the rates and settings for <strong>{editingTravelType.name}</strong>.</p></div>
                      <button className="ep-icon-btn" onClick={() => setEditingTravelType(null)}><X size={18} /></button>
                    </div>
                    <div className="ep-modal-body">
                      <div className="ep-form-group">
                        <label>Travel Type Name <span className="ep-required">*</span></label>
                        <input className="ep-form-input" value={editingTravelType.name} onChange={(e) => setEditingTravelType({ ...editingTravelType, name: e.target.value })} />
                      </div>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>Rate Type <span className="ep-required">*</span></label>
                          <select className="ep-form-select" value={editingTravelType.rate_kind} onChange={(e) => setEditingTravelType({ ...editingTravelType, rate_kind: e.target.value as "MEAL" | "DAILY" })}>
                            <option value="DAILY">Daily Rate</option>
                            <option value="MEAL">Meal Rate</option>
                          </select>
                        </div>
                        <div className="ep-form-group">
                          <label>Currency <span className="ep-required">*</span></label>
                          <select className="ep-form-select" value={editingTravelType.currency ?? "LSL"} onChange={(e) => setEditingTravelType({ ...editingTravelType, currency: e.target.value })}>
                            {CURRENCIES.map(c => (
                              <option key={c.code} value={c.code}>{c.symbol} — {c.code} ({c.name})</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="ep-form-row-3">
                        <div className="ep-form-group">
                          <label>General Staff Rate ({getCurrencySymbol(editingTravelType.currency)})</label>
                          <input type="number" min="0" step="0.01" className="ep-form-input" value={editingTravelType.rate_general_staff} onChange={(e) => setEditingTravelType({ ...editingTravelType, rate_general_staff: Number(e.target.value) })} />
                        </div>
                        <div className="ep-form-group">
                          <label>EXCO Rate ({getCurrencySymbol(editingTravelType.currency)})</label>
                          <input type="number" min="0" step="0.01" className="ep-form-input" value={editingTravelType.rate_exco} onChange={(e) => setEditingTravelType({ ...editingTravelType, rate_exco: Number(e.target.value) })} />
                        </div>
                        <div className="ep-form-group">
                          <label>CEO Rate ({getCurrencySymbol(editingTravelType.currency)})</label>
                          <input type="number" min="0" step="0.01" className="ep-form-input" value={editingTravelType.rate_ceo} onChange={(e) => setEditingTravelType({ ...editingTravelType, rate_ceo: Number(e.target.value) })} />
                        </div>
                      </div>
                      <div className="ep-form-group">
                        <label>Payment Methods <span className="ep-required">*</span></label>
                        <div style={{ display: "flex", gap: 18 }}>
                          <label className="ep-checkbox-label">
                            <input
                              type="checkbox"
                              checked={(editingTravelType.allowed_payment_methods ?? ["ECOCASH", "BANK"]).includes("ECOCASH")}
                              onChange={(e) => {
                                const current = editingTravelType.allowed_payment_methods ?? ["ECOCASH", "BANK"];
                                setEditingTravelType({
                                  ...editingTravelType,
                                  allowed_payment_methods: e.target.checked ? [...current, "ECOCASH"] : current.filter((m) => m !== "ECOCASH")
                                });
                              }}
                            />
                            <span>EcoCash</span>
                          </label>
                          <label className="ep-checkbox-label">
                            <input
                              type="checkbox"
                              checked={(editingTravelType.allowed_payment_methods ?? ["ECOCASH", "BANK"]).includes("BANK")}
                              onChange={(e) => {
                                const current = editingTravelType.allowed_payment_methods ?? ["ECOCASH", "BANK"];
                                setEditingTravelType({
                                  ...editingTravelType,
                                  allowed_payment_methods: e.target.checked ? [...current, "BANK"] : current.filter((m) => m !== "BANK")
                                });
                              }}
                            />
                            <span>Bank Transfer</span>
                          </label>
                        </div>
                      </div>
                      <label className="ep-checkbox-label">
                        <input type="checkbox" checked={editingTravelType.requires_accommodation ?? false} onChange={(e) => setEditingTravelType({ ...editingTravelType, requires_accommodation: e.target.checked })} />
                        <span>Requires accommodation booking</span>
                      </label>
                      <label className="ep-checkbox-label">
                        <input type="checkbox" checked={editingTravelType.allow_external_beneficiary ?? false} onChange={(e) => setEditingTravelType({ ...editingTravelType, allow_external_beneficiary: e.target.checked })} />
                        <span>Allow "Apply for Other" (external beneficiary)</span>
                      </label>
                    </div>
                    <div className="ep-modal-footer">
                      <button className="ep-btn-outline" onClick={() => setEditingTravelType(null)}>Cancel</button>
                      <button className="ep-btn" onClick={() => void saveEditedTravelType()}>Save Changes</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Add Hotel Modal ── */}
              {showAddHotelModal && (
                <div className="ep-modal-overlay" onClick={() => setShowAddHotelModal(false)}>
                  <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="ep-modal-head">
                      <div><h2 className="ep-modal-title">Add Hotel</h2><p className="ep-modal-sub">Add an approved hotel for accommodation requests.</p></div>
                      <button className="ep-icon-btn" onClick={() => setShowAddHotelModal(false)}><X size={18} /></button>
                    </div>
                    <div className="ep-modal-body">
                      <div className="ep-form-group">
                        <label>Hotel Name <span className="ep-required">*</span></label>
                        <input className="ep-form-input" placeholder="e.g. Lesotho Sun Hotel" value={newHotelName} onChange={(e) => setNewHotelName(e.target.value)} />
                      </div>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>District <span className="ep-optional">(optional if city provided)</span></label>
                          <select className="ep-form-select" value={newHotelDistrict} onChange={(e) => setNewHotelDistrict(e.target.value)}>
                            <option value="">— Select district —</option>
                            {districts.map((d) => <option key={d} value={d}>{d}</option>)}
                          </select>
                        </div>
                        <div className="ep-form-group">
                          <label>Country <span className="ep-optional">(optional if district provided)</span></label>
                          <input className="ep-form-input" placeholder="e.g. Lesotho" value={newHotelCountry} onChange={(e) => setNewHotelCountry(e.target.value)} />
                        </div>
                      </div>
                      {newHotelCountry.trim().toLowerCase() === "south africa" && (
                        <div className="ep-form-group">
                          <label>Province <span className="ep-required">*</span></label>
                          <select className="ep-form-select" value={newHotelProvince} onChange={(e) => setNewHotelProvince(e.target.value)}>
                            <option value="">— Select province —</option>
                            {SOUTH_AFRICA_PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                      )}
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>City <span className="ep-optional">(Optional)</span></label>
                          <input className="ep-form-input" placeholder="e.g. Maseru" value={newHotelCity} onChange={(e) => setNewHotelCity(e.target.value)} />
                        </div>
                        <div className="ep-form-group">
                          <label>Contact <span className="ep-optional">(Optional)</span></label>
                          <input className="ep-form-input" placeholder="+266 2231 xxxx" value={newHotelContact} onChange={(e) => setNewHotelContact(e.target.value)} />
                        </div>
                      </div>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>Address <span className="ep-optional">(Optional)</span></label>
                          <input className="ep-form-input" placeholder="Street address" value={newHotelAddress} onChange={(e) => setNewHotelAddress(e.target.value)} />
                        </div>
                      </div>
                    </div>
                    <div className="ep-modal-footer">
                      <button className="ep-btn-outline" onClick={() => setShowAddHotelModal(false)}>Cancel</button>
                      <button className="ep-btn" onClick={() => void createHotel()}>Add Hotel</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Edit Hotel Modal ── */}
              {editingHotel && (
                <div className="ep-modal-overlay" onClick={() => setEditingHotel(null)}>
                  <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="ep-modal-head">
                      <div><h2 className="ep-modal-title">Edit Hotel</h2><p className="ep-modal-sub">Update details for <strong>{editingHotel.name}</strong>.</p></div>
                      <button className="ep-icon-btn" onClick={() => setEditingHotel(null)}><X size={18} /></button>
                    </div>
                    <div className="ep-modal-body">
                      <div className="ep-form-group">
                        <label>Hotel Name <span className="ep-required">*</span></label>
                        <input className="ep-form-input" value={editingHotel.name || ""} onChange={(e) => setEditingHotel({ ...editingHotel, name: e.target.value })} />
                      </div>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>District</label>
                          <select className="ep-form-select" value={editingHotel.district || ""} onChange={(e) => setEditingHotel({ ...editingHotel, district: e.target.value })}>
                            <option value="">— Select district —</option>
                            {districts.map((d) => <option key={d} value={d}>{d}</option>)}
                          </select>
                        </div>
                        <div className="ep-form-group">
                          <label>Country</label>
                          <input className="ep-form-input" value={editingHotel.country || ""} onChange={(e) => setEditingHotel({ ...editingHotel, country: e.target.value })} />
                        </div>
                      </div>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>City</label>
                          <input className="ep-form-input" value={editingHotel.city || ""} onChange={(e) => setEditingHotel({ ...editingHotel, city: e.target.value })} />
                        </div>
                        <div className="ep-form-group">
                          <label>Contact</label>
                          <input className="ep-form-input" value={editingHotel.contact || ""} onChange={(e) => setEditingHotel({ ...editingHotel, contact: e.target.value })} />
                        </div>
                      </div>
                      <div className="ep-form-row">
                        <div className="ep-form-group">
                          <label>Address</label>
                          <input className="ep-form-input" value={editingHotel.address || ""} onChange={(e) => setEditingHotel({ ...editingHotel, address: e.target.value })} />
                        </div>
                      </div>
                    </div>
                    <div className="ep-modal-footer">
                      <button className="ep-btn-outline" onClick={() => setEditingHotel(null)}>Cancel</button>
                      <button className="ep-btn" onClick={() => void saveHotel()} disabled={savingHotel}>{savingHotel ? "Saving…" : "Save Changes"}</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Import Hotels Modal ── */}
              {showImportHotelsModal && (
                <div className="ep-modal-overlay" onClick={() => { if (!importHotelProcessing) { setShowImportHotelsModal(false); setImportHotelRows(null); setImportHotelResult(null); } }}>
                  <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="ep-modal-head">
                      <div><h2 className="ep-modal-title">Import Hotels</h2><p className="ep-modal-sub">Bulk-add hotels from a CSV file. Existing hotels with the same name and district are skipped.</p></div>
                      <button className="ep-icon-btn" onClick={() => { setShowImportHotelsModal(false); setImportHotelRows(null); setImportHotelResult(null); }}><X size={18} /></button>
                    </div>
                    <div className="ep-modal-body">
                      <input ref={hotelFileInputRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleImportHotelsFile} />

                      {!importHotelRows && !importHotelResult && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                          <div style={{ padding: "10px 12px", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                            <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                              <FileText size={13} /> Expected CSV format
                            </div>
                            <code style={{ fontSize: 11, display: "block", whiteSpace: "pre" }}>
                              {"Name,District,Country,Province,City,Address,Contact\n"}
                              {"Lancer's Inn,Maseru,,,,,22312114 / 59439591\n"}
                              {"Bruvita,Thaba-Tseka,,,Katse,,63681450"}
                            </code>
                          </div>
                          <button className="ep-btn" style={{ alignSelf: "flex-start" }} onClick={() => hotelFileInputRef.current?.click()}>
                            <Upload size={13} /> Choose CSV File
                          </button>
                        </div>
                      )}

                      {importHotelRows && !importHotelResult && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                          {importHotelRows.length === 0 ? (
                            <div style={{ fontSize: 13, color: "#dc2626" }}>No valid rows found in the file. Check the format.</div>
                          ) : (
                            <div style={{ fontSize: 13, color: "var(--muted)" }}>
                              {importHotelRows.length} hotel{importHotelRows.length !== 1 ? "s" : ""} ready to import. Existing hotels with the same name + district will be skipped.
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button className="ep-btn-outline" onClick={() => { setImportHotelRows(null); hotelFileInputRef.current?.click(); }} disabled={importHotelProcessing}>
                              Choose Different File
                            </button>
                          </div>
                        </div>
                      )}

                      {importHotelResult && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                          <div style={{ padding: "10px 14px", background: importHotelResult.errors.length ? "#fef2f2" : "#f0fdf4", border: `1px solid ${importHotelResult.errors.length ? "#fca5a5" : "#86efac"}`, borderRadius: 7, fontSize: 13 }}>
                            <div style={{ fontWeight: 600, marginBottom: 4, color: importHotelResult.errors.length ? "#dc2626" : "#16a34a" }}>
                              {importHotelResult.errors.length ? "Import completed with errors" : "Import successful"}
                            </div>
                            <div style={{ color: "var(--text)" }}>{importHotelResult.created} created · {importHotelResult.skipped} skipped (already exist)</div>
                          </div>
                          {importHotelResult.errors.length > 0 && (
                            <div style={{ maxHeight: 160, overflowY: "auto", fontSize: 12, color: "#dc2626" }}>
                              {importHotelResult.errors.map((err, i) => <div key={i}>{err}</div>)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="ep-modal-footer">
                      <button className="ep-btn-outline" onClick={() => { setShowImportHotelsModal(false); setImportHotelRows(null); setImportHotelResult(null); }} disabled={importHotelProcessing}>
                        {importHotelResult ? "Close" : "Cancel"}
                      </button>
                      {importHotelRows && !importHotelResult && (
                        <button className="ep-btn" onClick={() => void runImportHotels()} disabled={importHotelProcessing || importHotelRows.length === 0}>
                          {importHotelProcessing ? "Importing…" : "Confirm Import"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : page === "REPORTS" ? (
            <div className="ep-page">
              {/* Header */}
              <div className="ep-header">
                <div className="ep-header-text">
                  <h1 className="ep-title">Reports</h1>
                  <p className="ep-subtitle">Overview of advance and clearance activity across the organisation.</p>
                </div>
              </div>

              {/* KPI stat cards - organisation-wide for anyone with the
                  report_advances permission; otherwise falls back to just
                  the viewer's own requests (never blank, never someone
                  else's data without the permission to see it). */}
              {(() => {
                const canSeeOrgWide = canAccessFeature("report_advances");
                const hubAdvances = canSeeOrgWide ? reportAdvances : advances;
                const hubClaims = canSeeOrgWide ? reportClaims : claims;
                return (
              <div className="ep-kpi-row">
                <div className="stat-card stat-card-blue">
                  <span className="stat-icon"><FileText size={28} /></span>
                  <div>
                    <div className="stat-value">{hubAdvances.length}</div>
                    <div className="stat-label">Total Advances</div>
                  </div>
                </div>
                <div className="stat-card stat-card-green">
                  <span className="stat-icon"><ClipboardList size={28} /></span>
                  <div>
                    <div className="stat-value">{hubClaims.length}</div>
                    <div className="stat-label">Total Clearances</div>
                  </div>
                </div>
                <div className="stat-card stat-card-gold">
                  <span className="stat-icon"><Wallet size={28} /></span>
                  <div>
                    {(() => {
                      const totals = new Map<string, number>();
                      for (const a of hubAdvances) {
                        const currency = travelTypeCurrency(a.type, travelTypes);
                        totals.set(currency, (totals.get(currency) || 0) + Number(a.approved_total || 0));
                      }
                      const entries = Array.from(totals.entries());
                      return entries.length === 0
                        ? <div className="stat-value" style={{ fontSize: "1.35rem" }}>{fmtMoney(0)}</div>
                        : entries.map(([currency, value]) => <div key={currency} className="stat-value" style={{ fontSize: "1.35rem" }}>{fmtMoney(value, currency)}</div>);
                    })()}
                    <div className="stat-label">Approved / Paid Value</div>
                  </div>
                </div>
                <div className="stat-card stat-card-rose">
                  <span className="stat-icon"><Wallet size={28} /></span>
                  <div>
                    {(() => {
                      const totals = new Map<string, number>();
                      for (const c of hubClaims) {
                        const currency = c.currency || "LSL";
                        totals.set(currency, (totals.get(currency) || 0) + Number(c.claim_total || 0));
                      }
                      const entries = Array.from(totals.entries());
                      return entries.length === 0
                        ? <div className="stat-value" style={{ fontSize: "1.35rem" }}>{fmtMoney(0)}</div>
                        : entries.map(([currency, value]) => <div key={currency} className="stat-value" style={{ fontSize: "1.35rem" }}>{fmtMoney(value, currency)}</div>);
                    })()}
                    <div className="stat-label">Clearance Spend</div>
                  </div>
                </div>
              </div>
                );
              })()}

              {/* Report module cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 24 }}>
                {([
                  ...(canAccessFeature("report_advances") ? [
                    { icon: <FileText size={26} />, color: "#3b82f6", bg: "#eff6ff", title: "Advance Requests", desc: "Full admin view of all advance requests with filters and export.", action: () => setPage("REPORT_ADVANCES"), live: true },
                    { icon: <Users size={26} />, color: "#059669", bg: "#d1fae5", title: "Approval Performance", desc: "Approval rates, processing times, and department breakdowns.", action: () => setPage("REPORT_APPROVAL"), live: true },
                  ] : []),
                  { icon: <BarChart3 size={26} />, color: "#8b5cf6", bg: "#ede9fe", title: "SLA Reports", desc: "Track processing times, breach rates, and SLA compliance by department.", action: () => setPage("SLA_REPORTS"), live: true },
                  { icon: <GitBranch size={26} />, color: "#f59e0b", bg: "#fef3c7", title: "Workflow Analytics", desc: "Workflow coverage, step complexity, and usage by process.", action: () => setPage("REPORT_WORKFLOW"), live: true },
                  { icon: <ShieldCheck size={26} />, color: "#dc2626", bg: "#fee2e2", title: "Audit Trail", desc: "Chronological log of all advance and clearance activity.", action: () => setPage("REPORT_AUDIT"), live: true },
                  ...(canAccessFeature("report_reconciliation") ? [
                    { icon: <BarChart3 size={26} />, color: "#0d9488", bg: "#ccfbf1", title: "Reconciliation", desc: "Opening/closing balances, requested, paid, and settled per requester for a period.", action: () => setPage("REPORT_RECONCILIATION"), live: true },
                  ] : []),
                  ...(canAccessFeature("clearance_status_report") ? [
                    { icon: <CheckCircle2 size={26} />, color: "#059669", bg: "#d1fae5", title: "Clearance Status", desc: "Every paid travel advance, tracked as Complete, Not Complete, or Not Cleared.", action: () => setPage("REPORT_CLEARANCE_STATUS"), live: true },
                  ] : []),
                  ...(role === "ADMIN" ? [
                    { icon: <PlayCircle size={26} />, color: "#4f46e5", bg: "#e0e7ff", title: "Tooltip Engagement", desc: "How far users get through each in-app guided tour before completing or skipping it.", action: () => setPage("REPORT_TOUR_ENGAGEMENT"), live: true },
                  ] : []),
                  ...(hasTreasuryAccess ? [
                    { icon: <Landmark size={26} />, color: "#0891b2", bg: "#cffafe", title: "Trip Clearance Summary", desc: "Trips, advances, verified expenses and outcomes across the business.", action: () => setPage("REPORT_CLEARANCE_SUMMARY"), live: true },
                    { icon: <Landmark size={26} />, color: "#2563eb", bg: "#dbeafe", title: "Refunds Due", desc: "Refunds owed to employees, from awaiting payment through to processed.", action: () => setPage("REPORT_REFUNDS_DUE"), live: true },
                    { icon: <Landmark size={26} />, color: "#7c3aed", bg: "#ede9fe", title: "Employee Paybacks", desc: "Payback proofs, HR verification, and Treasury reconciliation.", action: () => setPage("REPORT_EMPLOYEE_PAYBACKS"), live: true },
                    { icon: <Landmark size={26} />, color: "#059669", bg: "#d1fae5", title: "Fully Cleared Trips", desc: "Completed clearances, retaining their original financial outcome.", action: () => setPage("REPORT_FULLY_CLEARED"), live: true },
                    { icon: <Landmark size={26} />, color: "#d97706", bg: "#fef3c7", title: "Outstanding Clearances", desc: "Every trip not yet completed, grouped by responsible team.", action: () => setPage("REPORT_OUTSTANDING"), live: true },
                    { icon: <Clock3 size={26} />, color: "#db2777", bg: "#fce7f3", title: "Clearance Ageing", desc: "How long incomplete clearances have sat in each stage.", action: () => setPage("REPORT_AGEING"), live: true },
                    { icon: <ShieldCheck size={26} />, color: "#dc2626", bg: "#fee2e2", title: "Treasury Audit & Reconciliation", desc: "Flags settlement discrepancies, missing references, and overdue items.", action: () => setPage("REPORT_TREASURY_AUDIT"), live: true },
                    { icon: <BarChart3 size={26} />, color: "#0d9488", bg: "#ccfbf1", title: "Department & Division", desc: "Clearance activity summarized by division and department.", action: () => setPage("REPORT_DEPT_DIVISION"), live: true },
                  ] : []),
                  ...(role === "ADMIN" || hasOvertimeFinanceAccess ? [
                    { icon: <Clock3 size={26} />, color: "#b45309", bg: "#fef3c7", title: "Overtime Reports", desc: "Payment queue, allowance report, and paid history — filtered and exportable.", action: () => setPage("REPORT_OVERTIME"), live: true },
                  ] : []),
                ]).map(({ icon, color, bg, title, desc, action }) => (
                  <div key={title}
                    onClick={() => action?.()}
                    style={{
                      background: "white", borderRadius: 12, border: `1px solid #e8edf2`,
                      boxShadow: "0 1px 4px rgba(0,0,0,0.06)", padding: 20,
                      cursor: "pointer",
                      transition: "box-shadow 0.15s, transform 0.15s",
                      display: "flex", flexDirection: "column", gap: 12,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)"; (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 4px rgba(0,0,0,0.06)"; (e.currentTarget as HTMLDivElement).style.transform = ""; }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                      <span style={{ width: 46, height: 46, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", color }}>{icon}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 99, background: "#d1fae5", color: "#065f46" }}>Live</span>
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 4 }}>{title}</div>
                      <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>{desc}</div>
                    </div>
                    <div style={{ fontSize: 13, color, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
                      View Report <ChevronRight />
                    </div>
                  </div>
                ))}
              </div>

              {/* Breakdown panels */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 20 }}>
                {/* Advances by type */}
                <div className="ep-panel">
                  <div className="ep-panel-head"><div className="ep-panel-title">Advances by Type</div></div>
                  <div style={{ padding: "4px 0" }}>
                    {Object.entries(advancesByType).length === 0 ? (
                      <div className="ep-empty" style={{ padding: "20px 0" }}><p>No advance records yet.</p></div>
                    ) : (() => {
                      const total = Object.values(advancesByType).reduce((s, n) => s + n, 0);
                      return Object.entries(advancesByType).sort(([,a],[,b]) => b - a).map(([type, count]) => (
                        <div key={type} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 20px" }}>
                          <span style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{travelTypeLabel(type, travelTypes)}</span>
                          <div style={{ width: 80, height: 6, background: "var(--surface-soft)", borderRadius: 99, overflow: "hidden", flexShrink: 0 }}>
                            <div style={{ height: "100%", width: `${(count/total)*100}%`, background: "#3b82f6", borderRadius: 99 }} />
                          </div>
                          <span style={{ fontWeight: 700, color: "var(--text)", minWidth: 24, textAlign: "right", fontSize: 13 }}>{count}</span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>

                {/* Advances by status */}
                <div className="ep-panel">
                  <div className="ep-panel-head"><div className="ep-panel-title">Advances by Status</div></div>
                  <div style={{ padding: "4px 0" }}>
                    {Object.entries(advancesByStatus).length === 0 ? (
                      <div className="ep-empty" style={{ padding: "20px 0" }}><p>No advance records yet.</p></div>
                    ) : (() => {
                      const total = Object.values(advancesByStatus).reduce((s, n) => s + n, 0);
                      const statusColors: Record<string, [string,string]> = {
                        DRAFT: ["#f1f5f9","#64748b"], SUBMITTED: ["#dbeafe","#1d4ed8"],
                        PENDING_APPROVAL: ["#fef3c7","#92400e"], APPROVED: ["#d1fae5","#065f46"],
                        REJECTED: ["#fee2e2","#dc2626"], PAID: ["#ede9fe","#6d28d9"],
                        PENDING_PAYMENT: ["#fef3c7","#92400e"],
                      };
                      return Object.entries(advancesByStatus).sort(([,a],[,b]) => b - a).map(([status, count]) => {
                        const [bg, color] = statusColors[status] || ["#f1f5f9","#64748b"];
                        return (
                          <div key={status} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 20px" }}>
                            <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>
                              {advanceStageLabel({ status })}
                            </span>
                            <div style={{ flex: 1, height: 6, background: "var(--surface-soft)", borderRadius: 99, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${(count/total)*100}%`, background: color, borderRadius: 99 }} />
                            </div>
                            <span style={{ fontWeight: 700, color: "var(--text)", minWidth: 24, textAlign: "right", fontSize: 13 }}>{count}</span>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>

                {/* Clearances by status */}
                <div className="ep-panel">
                  <div className="ep-panel-head"><div className="ep-panel-title">Clearances by Status</div></div>
                  <div style={{ padding: "4px 0" }}>
                    {Object.entries(claimsByStatus).length === 0 ? (
                      <div className="ep-empty" style={{ padding: "20px 0" }}><p>No clearance records yet.</p></div>
                    ) : (() => {
                      const total = Object.values(claimsByStatus).reduce((s, n) => s + n, 0);
                      const statusColors: Record<string, [string,string]> = {
                        SUBMITTED: ["#dbeafe","#1d4ed8"], APPROVED: ["#d1fae5","#065f46"],
                        REJECTED: ["#fee2e2","#dc2626"], PAID: ["#ede9fe","#6d28d9"],
                        PENDING_APPROVAL: ["#fef3c7","#92400e"],
                      };
                      return Object.entries(claimsByStatus).sort(([,a],[,b]) => b - a).map(([status, count]) => {
                        const [bg, color] = statusColors[status] || ["#f1f5f9","#64748b"];
                        return (
                          <div key={status} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 20px" }}>
                            <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>
                              {clearanceStageLabel(status)}
                            </span>
                            <div style={{ flex: 1, height: 6, background: "var(--surface-soft)", borderRadius: 99, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${(count/total)*100}%`, background: color, borderRadius: 99 }} />
                            </div>
                            <span style={{ fontWeight: 700, color: "var(--text)", minWidth: 24, textAlign: "right", fontSize: 13 }}>{count}</span>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              </div>

              {/* Recent requests table */}
              <div className="ep-panel" style={{ marginBottom: 20 }}>
                <div className="ep-panel-head">
                  <div className="ep-panel-title">Recent Advance Requests</div>
                </div>
                <div className="ep-table-wrap">
                  {advances.length === 0 ? (
                    <div className="ep-empty"><p>No advance records yet.</p></div>
                  ) : (
                    <table className="ep-table">
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th>Type</th>
                          <th>Status</th>
                          <th>Requested</th>
                          <th>Approved</th>
                        </tr>
                      </thead>
                      <tbody>
                        {advances.slice(0, 10).map((adv) => {
                          const statusColors: Record<string, [string,string]> = {
                            DRAFT: ["#f1f5f9","#64748b"], SUBMITTED: ["#dbeafe","#1d4ed8"],
                            PENDING_APPROVAL: ["#fef3c7","#92400e"], APPROVED: ["#d1fae5","#065f46"],
                            REJECTED: ["#fee2e2","#dc2626"], PAID: ["#ede9fe","#6d28d9"],
                            PENDING_PAYMENT: ["#fef3c7","#92400e"],
                          };
                          const [sbg, sclr] = statusColors[adv.status] || ["#f1f5f9","#64748b"];
                          return (
                            <tr key={adv.id}>
                              <td style={{ fontWeight: 600 }}>{(adv as any).requester_name || (adv as any).full_name || "—"}</td>
                              <td>{travelTypeLabel(adv.type, travelTypes)}</td>
                              <td>
                                <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: sbg, color: sclr }}>
                                  {currentApprovalStepLabel(adv) ? `Pending ${currentApprovalStepLabel(adv)} Approval` : advanceStageLabel(adv)}
                                </span>
                              </td>
                              <td style={{ fontWeight: 600 }}>{fmtMoney(adv.requested_total)}</td>
                              <td style={{ color: "var(--muted)" }}>{fmtMoney(adv.approved_total)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* AI tools */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 1fr", gap: 14 }}>

                {/* Fraud flags */}
                <div className="ep-panel">
                  <div className="ep-panel-head"><div className="ep-panel-title">Anomaly Flags</div></div>
                  <div style={{ padding: "8px 20px 16px" }}>
                    {[
                      { label: "Duplicate claims", count: aiAnomalies?.duplicateClaims?.length || 0, color: "#dc2626", bg: "#fee2e2" },
                      { label: "Unusual amounts",  count: aiAnomalies?.unusualAdvances?.length   || 0, color: "#f59e0b", bg: "#fef3c7" },
                      { label: "Repeated rollbacks",count: aiAnomalies?.repeatedRollbacks?.length || 0, color: "#8b5cf6", bg: "#ede9fe" },
                    ].map(({ label, count, color, bg }) => (
                      <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--surface-soft)" }}>
                        <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>
                        <span style={{ fontWeight: 700, fontSize: 15, padding: "2px 10px", borderRadius: 99, background: count > 0 ? bg : "var(--surface-soft)", color: count > 0 ? color : "var(--muted)" }}>{count}</span>
                      </div>
                    ))}
                    {aiAnomalies?.duplicateClaims?.[0] && (
                      <div style={{ marginTop: 12, padding: "10px 12px", background: "#fef2f2", borderRadius: 8, fontSize: 12, color: "#dc2626" }}>
                        Top flag: {aiAnomalies.duplicateClaims[0].claimant_name} ({aiAnomalies.duplicateClaims[0].duplicate_count} duplicates)
                      </div>
                    )}
                  </div>
                </div>

                {/* NL Reporting */}
                <div className="ep-panel">
                  <div className="ep-panel-head"><div className="ep-panel-title">Natural-Language Query</div></div>
                  <div style={{ padding: "8px 20px 16px" }}>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Ask a question in plain English and get instant results from the records.</div>
                    <div className="ep-form-group">
                      <input
                        className="ep-form-input"
                        placeholder="e.g. show rejected salary advances this month by department"
                        value={nlPrompt}
                        onChange={(e) => setNlPrompt(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === "Enter") {
                            try { const r = await api.aiNlReport(nlPrompt); setNlReport(r); } catch (err: any) { alert(err.message); }
                          }
                        }}
                      />
                    </div>
                    <button className="ep-btn-primary" style={{ marginTop: 8 }}
                      onClick={async () => {
                        try { const r = await api.aiNlReport(nlPrompt); setNlReport(r); } catch (err: any) { alert(err.message); }
                      }}>
                      Run Report
                    </button>
                    {nlReport && (
                      <div style={{ marginTop: 14 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>{nlReport.interpretation}</div>
                        <div style={{ overflowX: "auto" }}>
                          <table className="ep-table">
                            <thead>
                              <tr>{Object.keys(nlReport.rows?.[0] || { result: "" }).map((k) => <th key={k}>{k}</th>)}</tr>
                            </thead>
                            <tbody>
                              {(nlReport.rows || []).map((row: any, i: number) => (
                                <tr key={i}>{Object.keys(nlReport.rows?.[0] || { result: "" }).map((k) => <td key={k}>{String(row[k] ?? "")}</td>)}</tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* OCR */}
                <div className="ep-panel">
                  <div className="ep-panel-head"><div className="ep-panel-title">OCR Proof Extract</div></div>
                  <div style={{ padding: "8px 20px 16px" }}>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Paste text from a receipt or payment proof to extract key fields.</div>
                    <textarea
                      className="ep-form-input"
                      placeholder="Paste OCR text here…"
                      value={ocrText}
                      onChange={(e) => setOcrText(e.target.value)}
                      rows={4}
                      style={{ resize: "vertical" }}
                    />
                    <button className="ep-btn-primary" style={{ marginTop: 8 }}
                      onClick={async () => {
                        try { const r = await api.aiOcrExtract(ocrText); setOcrResult(r); } catch (err: any) { alert(err.message); }
                      }}>
                      Extract Fields
                    </button>
                    {ocrResult && (
                      <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                        {[
                          { label: "Date",      val: ocrResult.extracted_date || "—" },
                          { label: "Amount",    val: ocrResult.extracted_amount != null ? `M${Number(ocrResult.extracted_amount).toFixed(2)}` : "—" },
                          { label: "Reference", val: ocrResult.extracted_reference || "—" },
                        ].map(({ label, val }) => (
                          <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", background: "var(--surface-soft)", borderRadius: 8, fontSize: 13 }}>
                            <span style={{ color: "var(--muted)" }}>{label}</span>
                            <span style={{ fontWeight: 700, color: "var(--text)" }}>{val}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : page === "SLA_REPORTS" ? (
            <SlaReports onBack={() => setPage("REPORTS")} canViewClaimsSla={canAccessFeature("claims_sla_report")} />
          ) : page === "REPORT_ADVANCES" ? (
            <ReportAdvances advances={reportAdvances} travelTypes={travelTypes} onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_APPROVAL" ? (
            <ReportApprovalPerformance advances={reportAdvances} travelTypes={travelTypes} onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_WORKFLOW" ? (
            <ReportWorkflowAnalytics advances={advances} onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_AUDIT" ? (
            <ReportAuditTrail advances={advances} claims={claims} travelTypes={travelTypes} onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_RECONCILIATION" ? (
            <ReportReconciliation onBack={() => setPage("REPORTS")} meUserId={profile?.id || me?.userId} />
          ) : page === "REPORT_TOUR_ENGAGEMENT" ? (
            <ReportTourEngagement onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_CLEARANCE_STATUS" ? (
            <ReportClearanceStatus onBack={() => setPage("REPORTS")} />
          ) : page === "ADVANCE" ? (
            !canOpenAdvanceForm ? (
              <div className="card" style={{ padding: 24 }}>
                <h2>Advance Requests Disabled</h2>
                <p>{fmtEmploymentType(employmentType)} users cannot create their own advance requests.</p>
                {eligibleSupportCreators.length > 0 && (
                  <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
                    <div><strong>Choose a department member to create for you:</strong></div>
                    <select value={supportCreatorUserId} onChange={(e) => setSupportCreatorUserId(e.target.value)}>
                      <option value="">Select support creator</option>
                      {eligibleSupportCreators.map((user) => (
                        <option key={user.id} value={user.id}>
                          {formatPersonLabel(user)} - {displayRoleLabel(user.role)}
                        </option>
                      ))}
                    </select>
                    {supportCreatorUserId && (
                      <div style={{ opacity: 0.8 }}>
                        Ask {formatPersonLabel(eligibleSupportCreators.find((user) => user.id === supportCreatorUserId) || { full_name: "", email: "", employee_no: "" })} to create the advance on your behalf.
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
            <div className="request-page">
              <GuidedTour
                active={!editingAdvanceId}
                storageKey="fd_advance_form_tour_seen_v1"
                steps={[
                  {
                    target: paymentMethodFieldRef as any,
                    title: "How you'll receive the money",
                    body: "Pick EcoCash or Bank Transfer. Some advance types only allow one of the two — you'll be told if so."
                  },
                  {
                    target: purposeFieldRef as any,
                    title: "Explain the purpose",
                    body: "A short, clear reason for the request. Approvers see this first, so be specific (at least 5 characters)."
                  },
                  {
                    target: advanceTypeFieldRef as any,
                    title: "Choose the advance type",
                    body: "Pick what this advance is for — a travel type, salary, or loan. This determines which fields and rates apply below."
                  },
                  {
                    target: advanceSubmitButtonRef as any,
                    title: "Submit for approval",
                    body: "Once everything looks right, submit here. You can track its approval progress from My Advances afterwards."
                  }
                ] as TourStep[]}
              />
              <div className="request-header">
                <div>
                  <h2>{editingAdvanceId ? "Edit Advance Request" : "Create Advance Request"}</h2>
                  <p>Submit a finance advance request for approval.</p>
                </div>
                <div className="request-illustration" aria-hidden="true">
                  <span />
                </div>
              </div>
              <div className="request-stepper">
                <span className="active">Request Information</span>
                <span>Review Request</span>
                <span>Submit</span>
              </div>
              <div className="request-shell">
                <div className="advance-form modern-form request-main-card">
              <h2 className="form-title">Request Details</h2>

              {canCreateForOthers && !editingAdvanceId && (
                <div className="form-field">
                  <label>Request For</label>
                  <select
                    value={isApplyForOther ? "__EXTERNAL__" : requestForUserId}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "__EXTERNAL__") {
                        // Still a self-request underneath (requestForUserId
                        // stays "me") - the requester receives the funds and
                        // stays accountable, they just aren't the traveller.
                        setIsApplyForOther(true);
                        // A previously-picked type might not be enabled for
                        // Apply for Other - force a fresh, valid pick.
                        setAdvanceType(null);
                        setRequestForUserId(profile?.id || me?.userId || "");
                        if (externalPayees.length === 0) {
                          api.externalPayees().then(setExternalPayees).catch(() => setExternalPayees([]));
                        }
                      } else {
                        setIsApplyForOther(false);
                        setExternalBeneficiaryId("");
                        setRequestForUserId(val);
                      }
                    }}
                  >
                    {canRequestForSelf && (
                      <option value={profile?.id || me?.userId || ""}>Myself</option>
                    )}
                    {eligibleBeneficiaries.map((user) => (
                      <option key={user.id} value={user.id}>
                        {formatPersonLabel(user)} - {fmtEmploymentType(user.employment_type)}
                      </option>
                    ))}
                    {canApplyForExternal && <option value="__EXTERNAL__">Apply for Other</option>}
                  </select>
                </div>
              )}

              {isApplyForOther && (
                <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                  <div className="form-field">
                    <label>External Beneficiary</label>
                    <select value={externalBeneficiaryId} onChange={(e) => setExternalBeneficiaryId(e.target.value)}>
                      <option value="">Select who this is for…</option>
                      {externalPayees.map((p: any) => (
                        <option key={p.id} value={p.id}>{p.full_name}{p.organisation ? ` — ${p.organisation}` : ""}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="link-button"
                      style={{ marginTop: 6 }}
                      onClick={() => setShowNewExternalPayeeForm((v) => !v)}
                    >
                      {showNewExternalPayeeForm ? "Cancel" : "+ New External Payee"}
                    </button>
                  </div>
                  <div className="form-field">
                    <label>Amount</label>
                    <input type="number" value={otherAmount} onChange={(e) => setOtherAmount(e.target.value)} placeholder="0" />
                  </div>
                  <div className="form-grid-2">
                    <div className="form-field">
                      <label>Start Date</label>
                      <input type="date" value={otherStartDate} onChange={(e) => setOtherStartDate(e.target.value)} />
                    </div>
                    <div className="form-field">
                      <label>Finish Date</label>
                      <input type="date" value={otherFinishDate} onChange={(e) => setOtherFinishDate(e.target.value)} />
                    </div>
                  </div>
                  {showNewExternalPayeeForm && (
                    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                      <div className="form-grid-2">
                        <div className="form-field">
                          <label>Full Name</label>
                          <input value={newPayeeName} onChange={(e) => setNewPayeeName(e.target.value)} placeholder="e.g. Karabo Ntsane" />
                        </div>
                        <div className="form-field">
                          <label>Category</label>
                          <input value={newPayeeCategory} onChange={(e) => setNewPayeeCategory(e.target.value)} placeholder="e.g. Contractor" />
                        </div>
                        <div className="form-field">
                          <label>Organisation</label>
                          <input value={newPayeeOrg} onChange={(e) => setNewPayeeOrg(e.target.value)} placeholder="optional" />
                        </div>
                        <div className="form-field">
                          <label>Phone / Email</label>
                          <input value={newPayeeContact} onChange={(e) => setNewPayeeContact(e.target.value)} placeholder="optional" />
                        </div>
                      </div>
                      <button
                        type="button"
                        className="button button-subtle small-button"
                        disabled={savingNewPayee || !newPayeeName.trim()}
                        onClick={async () => {
                          setSavingNewPayee(true);
                          try {
                            const created: any = await api.createExternalPayee({
                              full_name: newPayeeName.trim(),
                              category: newPayeeCategory.trim() || undefined,
                              organisation: newPayeeOrg.trim() || undefined,
                              phone: newPayeeContact.trim() || undefined
                            });
                            const refreshed: any[] = await api.externalPayees();
                            setExternalPayees(refreshed);
                            setExternalBeneficiaryId(created.id);
                            setShowNewExternalPayeeForm(false);
                            setNewPayeeName(""); setNewPayeeCategory(""); setNewPayeeOrg(""); setNewPayeeContact("");
                          } catch (e: any) {
                            alert("Error: " + e.message);
                          } finally {
                            setSavingNewPayee(false);
                          }
                        }}
                      >
                        Save Payee
                      </button>
                    </div>
                  )}
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    You receive the funds and remain accountable — approval follows your own workflow chain, same as any advance.
                  </div>
                </div>
              )}

              <div className="form-grid-2">
                <div className="form-field">
                  <label>Name and Surname</label>
                  <input type="text" value={requesterName} onChange={(e) => setRequesterName(e.target.value)} placeholder="Employee full name" />
                </div>
                <div className="form-field">
                  <label>Employment Number</label>
                  <input type="text" value={empNumber} onChange={(e) => setEmpNumber(e.target.value)} placeholder="Employee number" />
                </div>
              </div>

              <div className="form-grid-2">
                <div className="form-field">
                  <label>Date</label>
                  <input type="date" value={requestDate} onChange={(e) => setRequestDate(e.target.value)} />
                </div>
                <div className="form-field" ref={paymentMethodFieldRef}>
                  <label>Receive Via</label>
                  <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as "ECOCASH" | "BANK")}>
                    {allowedPaymentMethods.includes("ECOCASH") && <option value="ECOCASH">ECOCASH</option>}
                    {allowedPaymentMethods.includes("BANK") && <option value="BANK">BANK</option>}
                  </select>
                  {allowedPaymentMethods.length === 1 && (
                    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                      {selectedTravelType?.name || "This advance type"} can only be paid via {allowedPaymentMethods[0] === "ECOCASH" ? "EcoCash" : "Bank Transfer"}.
                    </div>
                  )}
                </div>
              </div>

              {paymentMethod === "ECOCASH" ? (
                <div className="form-field">
                  <label>EcoCash Number</label>
                  <input type="text" value={ecocashNumber} onChange={(e) => setEcocashNumber(e.target.value)} placeholder="EcoCash number" />
                </div>
              ) : (
                <div className="form-grid-3">
                  <div className="form-field">
                    <label>Bank</label>
                    <input type="text" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Bank name" />
                  </div>
                  <div className="form-field">
                    <label>Account Number</label>
                    <input type="text" value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} placeholder="Bank account number" />
                  </div>
                  <div className="form-field">
                    <label>Branch</label>
                    <input type="text" value={bankBranch} onChange={(e) => setBankBranch(e.target.value)} placeholder="Branch" />
                  </div>
                </div>
              )}

              <div className="form-field" ref={purposeFieldRef}>
                <label>Purpose</label>
                <textarea
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="Briefly explain purpose of this request"
                  rows={3}
                />
              </div>

              {isAtLeastManagerReviewed(editingAdvanceStatus) && (
                <div className="field-row">
                  <label>Reviewed by:</label><span>________________</span>
                  <label>Date:</label><span>__________</span>
                </div>
              )}
              {isAtLeastApproved(editingAdvanceStatus) && (
                <div className="field-row">
                  <label>Approved by:</label><span>________________</span>
                  <label>Date:</label><span>__________</span>
                </div>
              )}
              <div className="form-field" ref={advanceTypeFieldRef}>
                <label>Advance Type</label>
                <select
                  value={advanceType || ""}
                  onChange={(e) => {
                    setAdvanceType(e.target.value || null);
                    setRows([]);
                    setAccommodationHotelChoices({});
                    setExtraCostAmount("");
                    setExtraCostDescription("");
                  }}
                >
                  <option value="">Select advance type</option>
                  {isApplyForOther ? (
                    <optgroup label="Travel">
                      {applyForOtherTypeOptions.map((type) => (
                        <option key={type.code} value={type.code}>{type.name}</option>
                      ))}
                    </optgroup>
                  ) : (
                    <>
                      <optgroup label="Travel">
                        {travelTypeOptions.map((type) => (
                          <option key={type.code} value={type.code}>{type.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Other advances">
                        {salaryAdvanceEnabled && <option value="SALARY">Salary</option>}
                        {loanAdvanceEnabled && <option value="LOAN">Loan</option>}
                      </optgroup>
                    </>
                  )}
                </select>
                {isApplyForOther && applyForOtherTypeOptions.length === 0 && (
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                    No advance types are enabled for "Apply for Other" yet — ask an admin to enable one in Travel Setup.
                  </div>
                )}
              </div>

              {advanceType === "SALARY" && (
                <div className="form-grid-2">
                  <div className="form-field">
                    <label>Salary Amount</label>
                    <input type="number" value={salaryAmount} onChange={e => setSalaryAmount(e.target.value)} placeholder="0" />
                  </div>
                  <div className="form-field">
                    <label>Salary Month</label>
                    <input type="month" value={monthField} onChange={e => setMonthField(e.target.value)} />
                  </div>
                </div>
              )}

              {advanceType === "LOAN" && (
                <div className="form-field">
                  <label>Loan Amount</label>
                  <input type="number" value={loanAmount} onChange={e => setLoanAmount(e.target.value)} placeholder="0" />
                </div>
              )}

              {advanceType === "SALARY" && (
                <div className="form-field">
                  <label>Payback Duration</label>
                  <select value={salaryPaybackDuration} onChange={(e) => setSalaryPaybackDuration(e.target.value)}>
                    <option value="">Select duration</option>
                    {Array.from({ length: salaryAdvanceMaxMonths }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={String(n)}>{n} Month{n === 1 ? "" : "s"}</option>
                    ))}
                  </select>
                </div>
              )}
              {advanceType === "LOAN" && (
                <div className="form-field">
                  <label>Payback Duration</label>
                  <select value={loanPaybackDuration} onChange={(e) => setLoanPaybackDuration(e.target.value)}>
                    <option value="">Select duration</option>
                    {Array.from({ length: loanAdvanceMaxMonths }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={String(n)}>{n} Month{n === 1 ? "" : "s"}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* breakdown table for travel */}
              {showTravelBreakdown && selectedTravelType && (
                <>
                  <div className="card" style={{ marginBottom: 12, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <span>{selectedTravelType.name}</span>
                      <b>{fmtMoney(selectedTravelRate, selectedTravelType?.currency)} per {selectedTravelUnitLabel}</b>
                    </div>
                  </div>
                  <table className="travel-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        {selectedTravelType.location_mode === "DISTRICT" ? (
                          <>
                            <th>Starting District</th>
                            <th>Destination District</th>
                          </>
                        ) : (
                          <>
                            <th>Country</th>
                            <th>Province / City</th>
                          </>
                        )}
                        <th>{selectedTravelType.rate_kind === "DAILY" ? "Days" : "Meals"}</th>
                        <th>Line Total</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, idx) => (
                        <tr key={idx}>
                          <td>
                            <input
                              type="date"
                              value={r.date}
                              onChange={e => updateRow(idx, "date", e.target.value)}
                            />
                          </td>
                          {selectedTravelType.location_mode === "DISTRICT" ? (
                            <>
                              <td>
                                <select
                                  value={r.startDistrict || ""}
                                  onChange={e => updateRow(idx, "startDistrict", e.target.value)}
                                  disabled={idx > 0}
                                >
                                  <option value="">Start district</option>
                                  {districtOptions.map((district) => (
                                    <option key={district} value={district}>{district}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <select
                                  value={r.destinationDistrict || ""}
                                  onChange={e => updateRow(idx, "destinationDistrict", e.target.value)}
                                >
                                  <option value="">Destination district</option>
                                  {districtOptions.map((district) => (
                                    <option key={district} value={district}>{district}</option>
                                  ))}
                                </select>
                              </td>
                            </>
                          ) : (
                            <>
                              <td>
                                <input
                                  list={`travel-country-options-${idx}`}
                                  value={r.country || ""}
                                  onChange={e => updateRow(idx, "country", e.target.value)}
                                  placeholder="Country"
                                />
                                <datalist id={`travel-country-options-${idx}`}>
                                  {selectedTravelCountries.map((country) => (
                                    <option key={country} value={country} />
                                  ))}
                                </datalist>
                              </td>
                              <td>
                                <div style={{ display: "grid", gap: 6 }}>
                                  {r.country.trim().toLowerCase() === "south africa" && (
                                    <select value={r.province || ""} onChange={e => updateRow(idx, "province", e.target.value)}>
                                      <option value="">Province</option>
                                      {SOUTH_AFRICA_PROVINCES.map((province) => (
                                        <option key={province} value={province}>{province}</option>
                                      ))}
                                    </select>
                                  )}
                                  <input
                                    list={`travel-city-options-${idx}`}
                                    value={r.city || ""}
                                    onChange={e => updateRow(idx, "city", e.target.value)}
                                    placeholder="City"
                                  />
                                  <datalist id={`travel-city-options-${idx}`}>
                                    {selectedTravelLocations
                                      .filter((location) => !r.country || String(location.country || "") === r.country)
                                      .filter((location) => !r.province || String(location.province || "") === r.province)
                                      .map((location) => String(location.city || "").trim())
                                      .filter(Boolean)
                                      .map((city) => (
                                        <option key={city} value={city} />
                                      ))}
                                  </datalist>
                                </div>
                              </td>
                            </>
                          )}
                          <td>
                            {selectedTravelType?.rate_kind === "DAILY" ? (
                              // A daily-rate trip (CMA/international per diem) pays a flat
                              // amount per day - one row can now cover a multi-day leg of
                              // the trip instead of forcing one row per calendar day.
                              <input
                                type="number"
                                min="1"
                                max="180"
                                step="1"
                                value={String(Number.isFinite(Number(r.meals)) && Number(r.meals) > 0 ? r.meals : 1)}
                                onChange={e => updateRow(idx, "meals", e.target.value === "" ? 1 : Number(e.target.value))}
                                style={{ width: 80 }}
                              />
                            ) : (
                              <input
                                type="number"
                                min="0"
                                max={idx === 0 ? 3 : 2}
                                step="1"
                                value={String(Number.isFinite(Number(r.meals)) ? r.meals : 0)}
                                onChange={e => updateRow(idx, "meals", e.target.value === "" ? 0 : Number(e.target.value))}
                                style={{ width: 80 }}
                              />
                            )}
                          </td>
                          <td>{fmtMoney((Number.isFinite(Number(r.meals)) ? Math.max(selectedTravelType?.rate_kind === "DAILY" ? 1 : 0, Number(r.meals)) : (selectedTravelType?.rate_kind === "DAILY" ? 1 : 0)) * selectedTravelRate, selectedTravelType?.currency)}</td>
                          <td>
                            <button
                              className="travel-delete-btn"
                              onClick={() => deleteRow(idx)}
                              type="button"
                              title="Delete row"
                              aria-label="Delete row"
                            >
                              <Trash2 size={15} aria-hidden />
                            </button>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: "10px 0" }}>
                          <button className="ep-btn" onClick={addRow} type="button" style={{ padding: "7px 20px", fontSize: "0.85rem" }}>
                            <Plus size={14} /> Add row
                          </button>
                        </td>
                      </tr>
                      {rows.length > 0 && (
                        <>
                          <tr>
                            <td>Sub-total</td>
                            <td></td>
                            <td></td>
                            <td>{rowTotals.meals}</td>
                            <td>{fmtMoney(rowTotals.amount, selectedTravelType?.currency)}</td>
                            <td></td>
                          </tr>
                          <tr>
                            <td>Extra Cost</td>
                            <td colSpan={3}>
                              <input
                                type="text"
                                value={extraCostDescription}
                                onChange={(e) => setExtraCostDescription(e.target.value)}
                                placeholder={`Justification${extraCost > 0 ? " (required)" : " — what is this extra cost for?"}`}
                                style={{ width: "100%", boxSizing: "border-box" }}
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                min="0"
                                value={extraCostAmount}
                                onChange={(e) => setExtraCostAmount(e.target.value)}
                                placeholder="0"
                                style={{ width: 100 }}
                              />
                            </td>
                            <td></td>
                          </tr>
                          <tr>
                            <td>Total</td>
                            <td></td>
                            <td></td>
                            <td>{rowTotals.meals}</td>
                            <td colSpan={2}>{fmtMoney(totalRequested(), selectedTravelType?.currency)}</td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>

                  {/* ── Accommodation notice for local travel ── */}
                  {selectedTravelType?.location_mode === "DISTRICT" && rows.length > 0 && (() => {
                    // On a multi-day trip, the last row is assumed to be the
                    // return-home leg (no accommodation needed that day) — but
                    // with only one row, it's the trip itself, so keep it.
                    const destinations = [...new Set(
                      (rows.length > 1 ? rows.slice(0, -1) : rows)
                        .map((r) => r.destinationDistrict)
                        .filter(Boolean)
                    )];
                    if (!destinations.length) return null;
                    return (
                      <div className="accommodation-notice">
                        <Hotel size={18} className="accommodation-notice-icon" />
                        <div>
                          <strong>Accommodation may be required</strong>
                          <span
                            className="info-tooltip"
                            title="Choosing a hotel here is optional. HR confirms the booking, amount, dates and payment during review."
                            style={{ marginLeft: 4, marginRight: 4 }}
                          >
                            <Info size={13} aria-hidden />
                          </span>
                           — this is a {rows.length}-day local trip.
                          <div style={{ fontSize: "0.82rem", color: "var(--muted)", margin: "3px 0 6px" }}>
                            If you have a preferred hotel in the destination district{destinations.length > 1 ? "s" : ""} below, choose it here — HR will handle the amount, dates and payment during review.
                          </div>
                          <div className="accommodation-notice-districts" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {destinations.map((d) => {
                              const districtHotels = hotels.filter((h) => h.district === d);
                              const hotelListId = `request-hotel-options-${d}`;
                              const chosenHotel = districtHotels.find((h) => h.name === accommodationHotelChoices[d]);
                              return (
                                <div key={d} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                    <span className="accommodation-notice-district">
                                      <Hotel size={11} /> {d}
                                    </span>
                                    <input
                                      className="review-control"
                                      style={{ maxWidth: 260 }}
                                      list={hotelListId}
                                      value={accommodationHotelChoices[d] || ""}
                                      onChange={(e) => setAccommodationHotelChoices((prev) => ({ ...prev, [d]: e.target.value }))}
                                      placeholder={districtHotels.length === 0 ? "No hotels listed for this district" : "Search or type hotel name (optional)"}
                                      autoComplete="off"
                                    />
                                    <datalist id={hotelListId}>
                                      {districtHotels.map((h) => (
                                        <option key={h.id} value={h.name} />
                                      ))}
                                    </datalist>
                                  </div>
                                  {chosenHotel?.contact && (
                                    <span style={{ fontSize: "0.8rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: 4, marginLeft: 2 }}>
                                      <Phone size={11} aria-hidden /> {chosenHotel.contact}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}

              <div className="form-field">
                <label>Amount Requested (In Words)</label>
                <input type="text" value={amountInWords} readOnly />
              </div>

              {(() => {
                const isTravelAdvanceUiType = !!advanceType && advanceType !== "SALARY" && advanceType !== "LOAN";
                const canPickOwnCountersigner = isTravelAdvanceUiType && ["CEO", "EXCO", "MANAGER"].includes(role);
                const showNoWorkflowFallback = advanceWorkflowFound === false && advanceType && !canPickOwnCountersigner;
                return canPickOwnCountersigner || showNoWorkflowFallback;
              })() && (
                <div className="form-section" style={{ marginTop: 24, border: "1px solid #e2c96e", borderRadius: 8, padding: "16px 18px", background: "#fffdf0" }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    {["CEO", "EXCO", "MANAGER"].includes(role) && advanceType !== "SALARY" && advanceType !== "LOAN" ? "Choose Your Countersigner / Approver" : "Custom Approval Chain"}
                  </div>
                  <div style={{ fontSize: 13, color: "#7a6a00", marginBottom: 18 }}>
                    {["CEO", "EXCO", "MANAGER"].includes(role) && advanceType !== "SALARY" && advanceType !== "LOAN"
                      ? "For travel advances, select the countersigner/approver for this request."
                      : "No workflow is configured for your department/section. Define the approvers for this request."}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    {chainPositionTypes.map((pt) => {
                      const selected = customApprovalChain.find(s => s.label === pt.name);

                      const myId = profile?.id || me?.userId || "";
                      const mySectionId = profile?.section_id || null;
                      const myDept      = (profile?.department || "").toLowerCase();

                      const isPermanent = (u: { employment_type?: string | null }) =>
                        String(u.employment_type || "").toUpperCase() === "PERMANENT";

                      const isTravelAdvanceUiType = !!advanceType && advanceType !== "SALARY" && advanceType !== "LOAN";
                      const canPickOwnCountersigner = isTravelAdvanceUiType && ["CEO", "EXCO", "MANAGER"].includes(role);

                      // Travel advance, requester is CEO/EXCO/MANAGER: pick own
                      // countersigner/approver from a role-appropriate pool
                      // (CEO/EXCO -> Exco members only; Manager -> own
                      // section/department staff or Exco members).
                      // Otherwise (no workflow configured fallback): the
                      // original generic pools.
                      const pool = canPickOwnCountersigner
                        ? (role === "MANAGER"
                            ? staffDirectory.filter(u =>
                                u.is_active !== false &&
                                isPermanent(u) &&
                                u.id !== myId &&
                                (
                                  u.role === "EXCO" ||
                                  (mySectionId !== null && u.section_id === mySectionId) ||
                                  (!!myDept && (u.department || "").toLowerCase() === myDept)
                                )
                              )
                            : staffDirectory.filter(u =>
                                u.is_active !== false &&
                                isPermanent(u) &&
                                u.id !== myId &&
                                u.role === "EXCO"
                              )
                          )
                        // No workflow is configured for this request at all, so
                        // there's no department/section-derived chain to fall
                        // back on either - the requester's own Manager/HOD/EXCO
                        // (same department or section) are the only people who
                        // plausibly have standing to counter-sign or approve it.
                        : staffDirectory.filter(u =>
                            u.is_active !== false &&
                            isPermanent(u) &&
                            u.id !== myId &&
                            ["MANAGER", "HOD", "EXCO"].includes(u.role) &&
                            (
                              (mySectionId !== null && u.section_id === mySectionId) ||
                              (!!myDept && (u.department || "").toLowerCase() === myDept)
                            )
                          );
                      const ptSubtitle = pt.code === "COUNTER_SIGNER"
                        ? "Supervisor or Manager to confirm your request details"
                        : pt.code === "APPROVED_BY"
                          ? "GM or Executive of your Division to approve the request"
                          : null;

                      const applySelection = (uid: string, userName: string) => {
                        setCustomApprovalChain(prev => {
                          const without = prev.filter(s => s.label !== pt.name);
                          const insertAt = chainPositionTypes.findIndex(p => p.id === pt.id);
                          const before = without.filter(s => chainPositionTypes.findIndex(p => p.name === s.label) < insertAt);
                          const after  = without.filter(s => chainPositionTypes.findIndex(p => p.name === s.label) >= insertAt);
                          return [...before, { label: pt.name, user_id: uid, user_name: userName }, ...after];
                        });
                      };

                      // Inviting a not-yet-registered approver by email only
                      // makes sense in the "no workflow configured" fallback —
                      // when a real workflow exists, the pool is already drawn
                      // from known people. `!canPickOwnCountersigner` stands in
                      // for that case since this section only renders when one
                      // of the two is true.
                      const showInviteByEmail = !canPickOwnCountersigner;
                      const inviteEmail = inviteEmailByLabel[pt.name] || "";
                      const inviteRole = inviteRoleByLabel[pt.name] || "MANAGER";

                      async function inviteByEmail() {
                        const email = inviteEmail.trim();
                        if (!email) return;
                        setInvitingLabel(pt.name);
                        setInviteErrorByLabel(prev => ({ ...prev, [pt.name]: "" }));
                        try {
                          const resp = await api.resolveOrInviteApprover(email, inviteRole);
                          applySelection(resp.id, resp.full_name || email);
                          setInviteEmailByLabel(prev => ({ ...prev, [pt.name]: "" }));
                        } catch (e: any) {
                          setInviteErrorByLabel(prev => ({ ...prev, [pt.name]: e?.message || "Could not invite this person" }));
                        } finally {
                          setInvitingLabel(null);
                        }
                      }

                      return (
                        <div key={pt.id}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: ptSubtitle ? 1 : 6 }}>
                            <User size={15} style={{ color: "var(--muted, #6b7280)", flexShrink: 0 }} aria-hidden />
                            <span style={{ fontWeight: 600, fontSize: 14 }}>
                              {pt.name} <span style={{ color: "#c0392b" }}>*</span>
                            </span>
                          </div>
                          {ptSubtitle && <div style={{ fontSize: 12, color: "#78716c", marginBottom: 6, paddingLeft: 21 }}>{ptSubtitle}</div>}
                          <select
                            value={selected?.user_id ?? ""}
                            onChange={(e) => {
                              const uid = e.target.value;
                              if (!uid) {
                                setCustomApprovalChain(prev => prev.filter(s => s.label !== pt.name));
                                return;
                              }
                              const u = pool.find(p => p.id === uid);
                              if (!u) return;
                              applySelection(uid, u.full_name || u.email);
                            }}
                            style={{ width: "100%", padding: "9px 12px", borderRadius: 7, border: `1px solid ${selected ? "#b6d4a8" : "#d1d5db"}`, fontSize: 14, background: selected ? "#f0fdf4" : "#f9fafb", color: "var(--text)", cursor: "pointer" }}
                          >
                            <option value="">— Select a person —</option>
                            {pool.map(u => (
                              <option key={u.id} value={u.id}>
                                {u.full_name || u.email}{u.title ? ` — ${u.title}` : ""}
                              </option>
                            ))}
                          </select>
                          {showInviteByEmail && (
                            <div style={{ marginTop: 8 }}>
                              <div style={{ fontSize: 12, color: "#78716c", marginBottom: 4 }}>
                                Not in the list? Invite them by email — they'll receive an email to approve, even if they've never logged into FlowDesk.
                              </div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <input
                                  type="email"
                                  placeholder="their.email@etl.co.ls"
                                  value={inviteEmail}
                                  onChange={(e) => setInviteEmailByLabel(prev => ({ ...prev, [pt.name]: e.target.value }))}
                                  style={{ flex: 1, padding: "7px 10px", borderRadius: 7, border: "1px solid #d1d5db", fontSize: 13 }}
                                />
                                <select
                                  value={inviteRole}
                                  onChange={(e) => setInviteRoleByLabel(prev => ({ ...prev, [pt.name]: e.target.value as "MANAGER" | "HOD" | "EXCO" }))}
                                  style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid #d1d5db", fontSize: 13 }}
                                >
                                  <option value="MANAGER">Manager</option>
                                  <option value="HOD">HOD</option>
                                  <option value="EXCO">EXCO</option>
                                </select>
                                <button
                                  type="button"
                                  className="button small-button"
                                  disabled={!inviteEmail.trim() || invitingLabel === pt.name}
                                  onClick={inviteByEmail}
                                >
                                  {invitingLabel === pt.name ? "Inviting…" : "Invite"}
                                </button>
                              </div>
                              {inviteErrorByLabel[pt.name] && (
                                <div style={{ fontSize: 12, color: "#c0392b", marginTop: 4 }}>{inviteErrorByLabel[pt.name]}</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="footer-buttons">
                <button className="button" onClick={() => {
                  setEditingAdvanceId(null);
                  setEditingAdvanceStatus(null);
                  setPage(editingAdvanceId ? "MY_ADVANCES" : "HOME");
                }}>Cancel</button>
                {editingAdvanceId && ["DRAFT","SUBMITTED"].includes(editingAdvanceStatus || "") && (
                  <button className="button" style={{ color: "#dc3545", borderColor: "#dc3545" }}
                    onClick={async () => {
                      const confirmed = await confirmAction({ title: "Revoke advance request?", text: "This will cancel the request.", confirmButtonText: "Revoke" });
                      if (!confirmed) return;
                      try {
                        await api.revokeAdvance(editingAdvanceId);
                        setEditingAdvanceId(null);
                        setEditingAdvanceStatus(null);
                        setPage("MY_ADVANCES");
                        await refresh();
                      } catch (e: any) { alert("Error: " + e.message); }
                    }}>Revoke</button>
                )}
                <button className="button" ref={advanceSubmitButtonRef} disabled={submittingAdvance} onClick={async () => {
                    setSubmittingAdvance(true);
                    try {
                      const trimmedEmpNumber = empNumber.trim();
                      const trimmedRequesterName = requesterName.trim();
                      const trimmedPurpose = purpose.trim();
                      const trimmedEcocash = ecocashNumber.trim();
                      const normalizedEcocash = trimmedEcocash.replace(/[\s-]/g, "");
                      const trimmedBankName = bankName.trim();
                      const trimmedBankAccountNumber = bankAccountNumber.trim();
                      const trimmedBankBranch = bankBranch.trim();
                      const selfUserId = profile?.id || me?.userId || "";
                      const isOnBehalfRequest = Boolean(requestForUserId && selfUserId && requestForUserId !== selfUserId);
                      const namePattern = /^[A-Za-z][A-Za-z .'-]{1,99}$/;
                      const empPattern = /^[A-Za-z0-9/_-]{3,30}$/;
                      const ecocashPattern = /^\+?\d{7,15}$/;
                      const bankNamePattern = /^[A-Za-z0-9 .,&'-]{2,60}$/;
                      const bankAccountPattern = /^[A-Za-z0-9-]{4,34}$/;
                      const branchPattern = /^[A-Za-z0-9 .,'/-]{2,60}$/;

                      if (!trimmedEmpNumber) {
                        alert("Employee Number is required.");
                        return;
                      }
                      if (!empPattern.test(trimmedEmpNumber)) {
                        alert("Employee Number format is invalid.");
                        return;
                      }
                      if (!trimmedRequesterName) {
                        alert("Name is required.");
                        return;
                      }
                      if (!namePattern.test(trimmedRequesterName)) {
                        alert("Name format is invalid.");
                        return;
                      }
                      if (isOnBehalfRequest && !canCreateForOthers) {
                        alert("You are not allowed to create advances on behalf of other employees.");
                        return;
                      }
                      if (!isOnBehalfRequest && !canRequestForSelf) {
                        alert("Your employment type is not allowed to create advance requests for yourself.");
                        return;
                      }
                      if (!advanceType) {
                        alert("Please select an advance type.");
                        return;
                      }
                      if (advanceType === "SALARY" && (Number(salaryAmount) || 0) <= 0) {
                        alert("Salary amount must be greater than 0.");
                        return;
                      }
                      if (advanceType === "SALARY" && !monthField) {
                        alert("Salary month is required.");
                        return;
                      }
                      if (advanceType === "SALARY" && !salaryPaybackDuration) {
                        alert("Please choose a payback duration.");
                        return;
                      }
                      if (advanceType === "LOAN" && (Number(loanAmount) || 0) <= 0) {
                        alert("Loan amount must be greater than 0.");
                        return;
                      }
                      if (advanceType === "LOAN" && !loanPaybackDuration) {
                        alert("Please choose a payback duration.");
                        return;
                      }
                      if (isApplyForOther && !canApplyForExternal) {
                        alert("Only permanent employees can apply for an advance on behalf of someone outside Econet.");
                        return;
                      }
                      if (isApplyForOther && !externalBeneficiaryId) {
                        alert("Select who this advance is for.");
                        return;
                      }
                      if (isApplyForOther && (Number(otherAmount) || 0) <= 0) {
                        alert("Amount must be greater than 0.");
                        return;
                      }
                      if (isApplyForOther && (!otherStartDate || !otherFinishDate)) {
                        alert("Start date and finish date are required.");
                        return;
                      }
                      if (isApplyForOther && otherFinishDate < otherStartDate) {
                        alert("Finish date cannot be before the start date.");
                        return;
                      }
                      if (showTravelBreakdown && extraCost > 0 && !extraCostDescription.trim()) {
                        alert("Please justify the extra cost.");
                        return;
                      }
                      if (!trimmedPurpose) {
                        alert("Purpose is required.");
                        return;
                      }
                      if (trimmedPurpose.length < 5) {
                        alert("Purpose must be at least 5 characters.");
                        return;
                      }
                      if (paymentMethod === "ECOCASH" && !trimmedEcocash) {
                        alert("EcoCash number is required.");
                        return;
                      }
                      if (paymentMethod === "ECOCASH" && !ecocashPattern.test(normalizedEcocash)) {
                        alert("EcoCash number format is invalid.");
                        return;
                      }
                      if (paymentMethod === "BANK") {
                        if (!trimmedBankName) {
                          alert("Bank is required.");
                          return;
                        }
                        if (!bankNamePattern.test(trimmedBankName)) {
                          alert("Bank name format is invalid.");
                          return;
                        }
                        if (!trimmedBankAccountNumber) {
                          alert("Bank account number is required.");
                          return;
                        }
                        if (!bankAccountPattern.test(trimmedBankAccountNumber)) {
                          alert("Bank account number format is invalid.");
                          return;
                        }
                        if (!trimmedBankBranch) {
                          alert("Bank branch is required.");
                          return;
                        }
                        if (!branchPattern.test(trimmedBankBranch)) {
                          alert("Bank branch format is invalid.");
                          return;
                        }
                      }
                      if (showTravelBreakdown && rows.length < 1) {
                        alert("At least one entry is required in the travel table.");
                        return;
                      }
                      if (showTravelBreakdown && selectedTravelType) {
                        if (selectedTravelRate <= 0) {
                          alert("HR must set the rate before this travel type can be submitted.");
                          return;
                        }
                        const hasInvalidRow = rows.some((r) =>
                          !r.date || !(Number.isInteger(Number(r.meals)) && Number(r.meals) >= 0) ||
                          (
                            selectedTravelType.location_mode === "DISTRICT"
                              ? (!String(r.startDistrict || "").trim() || !String(r.destinationDistrict || "").trim())
                              : (
                                  !String(r.country || "").trim() ||
                                  !String(r.city || "").trim() ||
                                  (String(r.country || "").trim().toLowerCase() === "south africa" && !String(r.province || "").trim())
                                )
                          )
                        );
                        if (hasInvalidRow) {
                          alert("Each travel row must have date, location, and a non-negative whole number of units.");
                          return;
                        }
                        if ((Number(totalRequested()) || 0) <= 0) {
                          alert("Travel total must be greater than 0.");
                          return;
                        }
                      }

                      if (advanceWorkflowFound === false && customApprovalChain.length === 0) {
                        alert("Please add at least one approver to the custom approval chain.");
                        return;
                      }

                      // build the minimal payload for the generic endpoint
                      const base: any = {
                        type: advanceType,
                        payment_method: paymentMethod,
                        purpose: trimmedPurpose
                      };
                      if (isOnBehalfRequest) {
                        base.beneficiary_user_id = requestForUserId;
                      }
                      if (advanceWorkflowFound === false && customApprovalChain.length > 0) {
                        base.override_chain = customApprovalChain;
                      }
                      if (paymentMethod === "ECOCASH") {
                        base.ecocash_number = normalizedEcocash;
                        base.payment_account = normalizedEcocash;
                      } else {
                        base.bank_name = trimmedBankName;
                        base.bank_account_number = trimmedBankAccountNumber;
                        base.bank_branch = trimmedBankBranch;
                        base.payment_account = `${trimmedBankName} | ${trimmedBankAccountNumber} | ${trimmedBankBranch}`;
                      }
                      if (advanceType === "SALARY") {
                        base.requested_total = Number(salaryAmount) || 0;
                        base.salary_month = monthField;
                        base.payback_months = Number(salaryPaybackDuration) || undefined;
                      }
                      if (showTravelBreakdown) {
                        base.requested_total = Number(totalRequested()) || 0;
                        base.extra_cost_amount = extraCost;
                        base.extra_cost_description = extraCostDescription.trim() || undefined;
                      }
                      if (advanceType === "LOAN") {
                        base.requested_total = Number(loanAmount) || 0;
                        base.payback_months = Number(loanPaybackDuration) || undefined;
                      }
                      if (isApplyForOther) {
                        // Always the manually-entered amount, overriding
                        // whatever the selected Advance Type's own branch
                        // above set - Apply for Other never uses the
                        // per-diem/rows calculation, salary amount, or loan
                        // amount, no matter which type is picked alongside it.
                        base.requested_total = Number(otherAmount) || 0;
                        base.external_beneficiary_id = externalBeneficiaryId;
                        base.external_start_date = otherStartDate;
                        base.external_end_date = otherFinishDate;
                      }
                      if (editingAdvanceId) {
                        // update existing request
                        await api.updateAdvance(editingAdvanceId, base);
                        if (showTravelBreakdown && selectedTravelType) {
                          const mappedRows = rows.map(r => ({
                            line_date: r.date,
                            location: selectedTravelType.location_mode === "DISTRICT"
                              ? `${r.startDistrict} → ${r.destinationDistrict}`
                              : [r.country, r.province, r.city].filter(Boolean).join(" / "),
                            travel_meta: selectedTravelType.location_mode === "DISTRICT"
                              ? { location_mode: selectedTravelType.location_mode, startDistrict: r.startDistrict, destinationDistrict: r.destinationDistrict, hotel: accommodationHotelChoices[r.destinationDistrict] || undefined }
                              : { location_mode: selectedTravelType.location_mode, country: r.country, province: r.province, city: r.city },
                            meals_count: (selectedTravelType?.rate_kind === "DAILY" && (!r.meals || Number(r.meals) === 0) ? 1 : r.meals),
                            dinner: 0
                          }));
                          await api.updateAdvanceLines(editingAdvanceId, { lines: mappedRows });
                        }
                        // A draft still needs the actual submit transition;
                        // anything already in the approval pipeline (but not
                        // yet approved) just gets its fields saved in place -
                        // its current status/step/approver are untouched.
                        if (editingAdvanceStatus === "DRAFT") {
                          const submitResult: any = await api.submitAdvance(editingAdvanceId);
                          alert(submitResult?.warning || "Advance request submitted successfully.");
                        } else {
                          alert("Changes saved.");
                        }
                        setEditingAdvanceId(null);
                      } else {
                        // create new request, then send any additional details
                        const resp: any = await api.createAdvance(base);
                        const newId = resp.id;
                        if (showTravelBreakdown && selectedTravelType) {
                          const mappedRows = rows.map(r => ({
                            line_date: r.date,
                            location: selectedTravelType.location_mode === "DISTRICT"
                              ? `${r.startDistrict} → ${r.destinationDistrict}`
                              : [r.country, r.province, r.city].filter(Boolean).join(" / "),
                            travel_meta: selectedTravelType.location_mode === "DISTRICT"
                              ? { location_mode: selectedTravelType.location_mode, startDistrict: r.startDistrict, destinationDistrict: r.destinationDistrict, hotel: accommodationHotelChoices[r.destinationDistrict] || undefined }
                              : { location_mode: selectedTravelType.location_mode, country: r.country, province: r.province, city: r.city },
                            meals_count: (selectedTravelType?.rate_kind === "DAILY" && (!r.meals || Number(r.meals) === 0) ? 1 : r.meals),
                            dinner: 0
                          }));
                          await api.updateAdvanceLines(newId, { lines: mappedRows });
                        }
                        const submitResult: any = await api.submitAdvance(newId);
                        alert(submitResult?.warning || "Advance request submitted successfully.");
                      }
                      await refresh();
                      setPage("HOME");
                      setEditingAdvanceStatus(null);
                    } catch (e: any) {
                      alert("Error: " + e.message);
                    } finally {
                      setSubmittingAdvance(false);
                    }
                  }}>{submittingAdvance
                    ? (editingAdvanceId && editingAdvanceStatus !== "DRAFT" ? "Saving…" : "Submitting…")
                    : (editingAdvanceId ? (editingAdvanceStatus === "DRAFT" ? "Update & Submit" : "Save Changes") : "Submit")}</button>
              </div>
                </div>
                <aside className="request-summary-card">
                  <div className="summary-title">Request Summary</div>
                  <dl>
                    <div>
                      <dt>Advance Type</dt>
                      <dd>{requestSummaryType}</dd>
                    </div>
                    <div>
                      <dt>Amount Requested</dt>
                      <dd className="summary-amount">{requestSummaryAmount}</dd>
                    </div>
                    <div>
                      <dt>Payment Method</dt>
                      <dd>{requestSummaryPayment}</dd>
                    </div>
                    <div>
                      <dt>Request For</dt>
                      <dd>
                        {isApplyForOther
                          ? `Apply for Other${externalBeneficiaryId ? ` — ${externalPayees.find((p: any) => p.id === externalBeneficiaryId)?.full_name || ""}` : ""}`
                          : requestForUserId === (profile?.id || me?.userId || "") ? "Myself" : requesterName || "Myself"}
                      </dd>
                    </div>
                    <div>
                      <dt>Date</dt>
                      <dd>{requestSummaryDate}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd><span className="status-pill status-pill-warning">Draft</span></dd>
                    </div>
                    <div>
                      <dt>Approval Route</dt>
                      <dd>
                        {advanceApprovalChain.length ? (
                          <span className="approval-route-chain">
                            {advanceApprovalChain.map((step, i) => (
                              <span key={i} className="approval-route-chain">
                                {i > 0 && <span className="approval-route-arrow">→</span>}
                                <span
                                  className={`approval-route-step${step.name ? " has-tooltip" : ""}`}
                                  title={step.name || undefined}
                                >
                                  {step.label}
                                </span>
                              </span>
                            ))}
                          </span>
                        ) : customApprovalChain.length ? (
                          <span className="approval-route-chain">
                            {customApprovalChain.map((step, i) => (
                              <span key={i} className="approval-route-chain">
                                {i > 0 && <span className="approval-route-arrow">→</span>}
                                <span
                                  className="approval-route-step has-tooltip"
                                  title={step.user_name}
                                >
                                  {step.label}
                                </span>
                              </span>
                            ))}
                          </span>
                        ) : !advanceType ? (
                          <span style={{ color: "#aaa", fontSize: 12 }}>Select advance type to view approval route</span>
                        ) : advanceWorkflowFound === null ? (
                          <span style={{ color: "#aaa", fontSize: 12 }}>Loading…</span>
                        ) : (
                          <span style={{ color: "#b45309", fontSize: 12 }}>No workflow — define below</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                </aside>
              </div>
            </div>
            )
          ) : page === "CLEARANCE" ? (
            <div className="advance-form modern-form clearance-form-v2">
              {/* Header */}
              <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 22 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: "#dbeafe", color: "#1d4ed8", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <BriefcaseBusiness size={22} aria-hidden />
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>{editingClaimId ? "Edit Clearance" : "Travel Advance Clearance Form"}</h2>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>Submit your travel expenses and supporting receipts for reconciliation.</div>
                </div>
              </div>

              {/* Travel Details */}
              <div className="card" style={{ padding: 18, marginBottom: 18 }}>
                <div style={{ fontWeight: 600, color: "#2563eb", marginBottom: 14 }}>Travel Details</div>
                <div className="form-grid-3">
                  <div className="form-field">
                    <label>Paid Advance <span style={{ color: "#dc2626" }}>*</span></label>
                    <select value={clearanceLinkedAdvanceId} onChange={(e) => setClearanceLinkedAdvanceId(e.target.value)}>
                      <option value="">Select paid travel advance</option>
                      {newClearanceAdvanceOptions.map((advance) => (
                        <option key={advance.id} value={advance.id}>
                          {travelTypeLabel(advance.type, travelTypes)} - {fmtMoney(advance.approved_total || advance.requested_total, travelTypeCurrency(advance.type, travelTypes))} - {new Date(advance.created_at).toLocaleDateString()}
                        </option>
                      ))}
                    </select>
                    {newClearanceAdvanceOptions.length === 0 && (
                      <div style={{ marginTop: 6, fontSize: 13, color: "crimson" }}>
                        No paid travel advances are available to clear yet.
                      </div>
                    )}
                  </div>
                  <div className="form-field">
                    <label>Month <span style={{ color: "#dc2626" }}>*</span></label>
                    <select
                      value={clearanceMonth ? clearanceMonth.split("-")[1] || "" : ""}
                      onChange={(e) => {
                        const mm = e.target.value;
                        const yyyy = clearanceMonth ? clearanceMonth.split("-")[0] : String(new Date().getFullYear());
                        setClearanceMonth(mm ? `${yyyy}-${mm}` : "");
                      }}
                    >
                      <option value="">Month</option>
                      {CLEARANCE_MONTH_NAMES.map((name, idx) => (
                        <option key={name} value={String(idx + 1).padStart(2, "0")}>{name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label>Year <span style={{ color: "#dc2626" }}>*</span></label>
                    <select
                      value={clearanceMonth ? clearanceMonth.split("-")[0] || "" : ""}
                      onChange={(e) => {
                        const yyyy = e.target.value;
                        const mm = clearanceMonth ? clearanceMonth.split("-")[1] : String(new Date().getMonth() + 1).padStart(2, "0");
                        setClearanceMonth(yyyy ? `${yyyy}-${mm}` : "");
                      }}
                    >
                      <option value="">Year</option>
                      {clearanceMonthYearRange().map((y) => (
                        <option key={y} value={String(y)}>{y}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="form-grid-3" style={{ marginTop: 4 }}>
                  <div className="form-field">
                    <label>Duty Station</label>
                    <input type="text" value={clearanceDutyStation} onChange={(e) => setClearanceDutyStation(e.target.value)} />
                  </div>
                  <div className="form-field">
                    <label>Project Number</label>
                    <input type="text" value={clearanceProjectNumber} onChange={(e) => setClearanceProjectNumber(e.target.value)} />
                  </div>
                  <div className="form-field">
                    <label>Vehicle Registration</label>
                    <input type="text" value={clearanceVehicleReg} onChange={(e) => setClearanceVehicleReg(e.target.value)} />
                  </div>
                </div>

                <div className="form-grid-3" style={{ marginTop: 4 }}>
                  <div className="form-field">
                    <label>Vehicle Type</label>
                    <input type="text" value={clearanceVehicleType} onChange={(e) => setClearanceVehicleType(e.target.value)} />
                  </div>
                  <div className="form-field">
                    <label>Engine CC</label>
                    <input type="text" value={clearanceEngineCc} onChange={(e) => setClearanceEngineCc(e.target.value)} />
                  </div>
                  <div className="form-field">
                    <label>Vehicle Rate (per KM)</label>
                    <input type="number" value={clearanceVehicleRate} onChange={(e) => setClearanceVehicleRate(e.target.value)} />
                  </div>
                </div>
              </div>

              {/* Advance Reconciliation Summary */}
              <div className="card" style={{ padding: 18, marginBottom: 18 }}>
                <div style={{ fontWeight: 600, color: "#2563eb", marginBottom: 14 }}>Advance Reconciliation Summary</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
                  {[
                    { label: "Advance Received", value: fmtMoney(clearanceAdvanceAmount), sub: "", color: "var(--text)", icon: ArrowRightLeft, iconBg: "#dbeafe", iconColor: "#2563eb" },
                    { label: "Actual Expenditure", value: fmtMoney(clearanceTotals.total), sub: "", color: "var(--text)", icon: Wallet, iconBg: "#ffedd5", iconColor: "#ea580c" },
                    { label: "Variance (Over / Under)", value: `${clearanceBalance < 0 ? "-" : ""}${fmtMoney(Math.abs(clearanceBalance))}`, sub: "", color: clearanceBalance < 0 ? "#1d4ed8" : clearanceBalance > 0 ? "#b45309" : "#15803d", icon: User, iconBg: "#ede9fe", iconColor: "#7c3aed" },
                    {
                      label: "Settlement Status",
                      value: clearanceBalance < 0 ? "Company Owes Employee" : clearanceBalance > 0 ? "Employee Owes Company" : "Fully Cleared",
                      sub: clearanceBalance < 0 ? "Additional reimbursement required" : clearanceBalance > 0 ? "Refund to company required" : "No further action needed",
                      color: clearanceBalance < 0 ? "#1d4ed8" : clearanceBalance > 0 ? "#b45309" : "#15803d",
                      icon: DollarSign, iconBg: "#dbeafe", iconColor: "#2563eb", small: true
                    }
                  ].map((c) => {
                    const Icon = c.icon;
                    return (
                      <div key={c.label} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", position: "relative" }}>
                        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 6, paddingRight: 34 }}>{c.label}</div>
                        <div style={{ fontWeight: 700, fontSize: c.small ? 15 : 20, color: c.color, lineHeight: 1.2 }}>{c.value}</div>
                        {c.sub && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>{c.sub}</div>}
                        <div style={{ position: "absolute", top: 14, right: 14, width: 30, height: 30, borderRadius: "50%", background: c.iconBg, color: c.iconColor, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Icon size={15} aria-hidden />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Two-column body: left = Trip Lines + Receipts + Process, right = Settlement Details */}
              <div className={`clearance-body-grid${clearanceBalance !== 0 ? " has-settlement" : ""}`}>
                <div className="clearance-left-stack">
                  {/* Trip Lines */}
                  <div className="card" style={{ padding: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <span style={{ fontWeight: 600, color: "#2563eb" }}>Trip Lines</span>
                      <button className="button button-subtle small-button" type="button" onClick={addClearanceTrip}><Plus size={14} aria-hidden /> Add Trip</button>
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table className="table clearance-trip-table">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Location</th>
                            <th>Purpose</th>
                            <th style={{ textAlign: "right" }}>Meals (M)</th>
                            <th style={{ textAlign: "right" }}>Transport (M)</th>
                            <th style={{ textAlign: "right" }}>Other (M)</th>
                            <th style={{ textAlign: "right" }}>Total (M)</th>
                            <th style={{ textAlign: "center" }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {clearanceTrips.map((trip, index) => {
                            const rowTotal = (Number(trip.lunch) || 0) + (Number(trip.petrol_allowance) || 0) + (Number(trip.other_expenses) || 0);
                            return trip.__editing ? (
                              <tr key={index}>
                                <td><input type="date" value={trip.trip_date} onChange={(e) => updateClearanceTrip(index, { trip_date: e.target.value })} style={{ minWidth: 125 }} /></td>
                                <td><input type="text" value={trip.from_place} placeholder="Location" onChange={(e) => updateClearanceTrip(index, { from_place: e.target.value })} style={{ minWidth: 90 }} /></td>
                                <td><input type="text" value={trip.purpose} placeholder="Purpose" onChange={(e) => updateClearanceTrip(index, { purpose: e.target.value })} style={{ minWidth: 100 }} /></td>
                                <td><input type="number" min={0} step="0.01" value={trip.lunch} onChange={(e) => updateClearanceTrip(index, { lunch: Number(e.target.value) })} style={{ width: 80, textAlign: "right" }} /></td>
                                <td><input type="number" min={0} step="0.01" value={trip.petrol_allowance} onChange={(e) => updateClearanceTrip(index, { petrol_allowance: Number(e.target.value) })} style={{ width: 80, textAlign: "right" }} /></td>
                                <td><input type="number" min={0} step="0.01" value={trip.other_expenses} onChange={(e) => updateClearanceTrip(index, { other_expenses: Number(e.target.value) })} style={{ width: 80, textAlign: "right" }} /></td>
                                <td style={{ textAlign: "right", fontWeight: 600 }}>{rowTotal.toFixed(2)}</td>
                                <td style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                                  <button type="button" className="icon-button" title="Done editing" onClick={() => toggleClearanceTripEdit(index)} style={{ color: "#16a34a" }}><CheckCircle2 size={15} aria-hidden /></button>
                                  <button type="button" className="icon-button" title="Remove trip" disabled={clearanceTrips.length <= 1} onClick={() => removeClearanceTrip(index)} style={{ color: "#dc2626" }}><Trash2 size={15} aria-hidden /></button>
                                </td>
                              </tr>
                            ) : (
                              <tr key={index}>
                                <td>{trip.trip_date ? new Date(trip.trip_date).toLocaleDateString("en-GB") : "—"}</td>
                                <td>{trip.from_place || "—"}</td>
                                <td>{trip.purpose || "—"}</td>
                                <td style={{ textAlign: "right" }}>{(Number(trip.lunch) || 0).toFixed(2)}</td>
                                <td style={{ textAlign: "right" }}>{(Number(trip.petrol_allowance) || 0).toFixed(2)}</td>
                                <td style={{ textAlign: "right" }}>{(Number(trip.other_expenses) || 0).toFixed(2)}</td>
                                <td style={{ textAlign: "right", fontWeight: 600 }}>{rowTotal.toFixed(2)}</td>
                                <td style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                                  <button type="button" className="icon-button" title="Edit trip" onClick={() => toggleClearanceTripEdit(index)} style={{ color: "#2563eb" }}><Edit3 size={15} aria-hidden /></button>
                                  <button type="button" className="icon-button" title="Remove trip" disabled={clearanceTrips.length <= 1} onClick={() => removeClearanceTrip(index)} style={{ color: "#dc2626" }}><Trash2 size={15} aria-hidden /></button>
                                </td>
                              </tr>
                            );
                          })}
                          <tr>
                            <td colSpan={3}>Itemized Total</td>
                            <td style={{ textAlign: "right", fontWeight: 600 }}>{clearanceTotals.meals.toFixed(2)}</td>
                            <td style={{ textAlign: "right", fontWeight: 600 }}>{clearanceTotals.transport.toFixed(2)}</td>
                            <td style={{ textAlign: "right", fontWeight: 600 }}>{clearanceTotals.other.toFixed(2)}</td>
                            <td style={{ textAlign: "right", fontWeight: 600 }}>{(clearanceTotals.total - clearanceExtraCost).toFixed(2)}</td>
                            <td></td>
                          </tr>
                          {clearanceExtraCost > 0 && (
                            <tr>
                              <td colSpan={6} style={{ textAlign: "right" }}>Extra Cost{clearanceExtraCostDescription.trim() ? ` — ${clearanceExtraCostDescription.trim()}` : ""}</td>
                              <td style={{ textAlign: "right", fontWeight: 600 }}>{clearanceExtraCost.toFixed(2)}</td>
                              <td></td>
                            </tr>
                          )}
                          <tr>
                            <td colSpan={6}><b>Total</b></td>
                            <td style={{ textAlign: "right", fontWeight: 700 }}>{clearanceTotals.total.toFixed(2)}</td>
                            <td></td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Extra Cost — a lump-sum spend that doesn't fit any single
                      day's Meals/Transport/Other line (e.g. a one-off repair
                      or emergency booking). Added on top of the itemized
                      total above so it actually reduces what's owed, instead
                      of just being an unlinked receipt upload no one's
                      settlement figure ever reflects. */}
                  <div className="card clearance-section-card">
                    <div className="clearance-card-header">
                      <div>
                        <div style={{ fontWeight: 600, color: "#2563eb" }}>Extra Cost</div>
                        <div style={{ marginTop: 4, fontSize: 13, color: "var(--muted)" }}>
                          A one-off cost that isn't tied to a single day above — attach proof under Receipts too.
                        </div>
                      </div>
                    </div>
                    <div className="form-row" style={{ marginTop: 12 }}>
                      <div className="form-field">
                        <label>Amount</label>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={clearanceExtraCostAmount}
                          onChange={(e) => setClearanceExtraCostAmount(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      <div className="form-field" style={{ flex: 2 }}>
                        <label>Justification{clearanceExtraCost > 0 ? " *" : ""}</label>
                        <input
                          type="text"
                          value={clearanceExtraCostDescription}
                          onChange={(e) => setClearanceExtraCostDescription(e.target.value)}
                          placeholder="What is this extra cost for?"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Receipts */}
                  <div className="card clearance-section-card">
                    <div className="clearance-card-header">
                      <div>
                        <div style={{ fontWeight: 600, color: "#2563eb" }}>Receipts</div>
                        <div style={{ marginTop: 4, fontSize: 13, color: "var(--muted)" }}>
                          Upload receipts immediately. If the draft does not exist yet, it will be saved first automatically.
                        </div>
                      </div>
                      <label className="clearance-upload-button">
                        <Upload size={15} aria-hidden /> Upload Receipt
                        <input
                          type="file"
                          multiple
                          accept=".pdf,.jpg,.jpeg,.png"
                          style={{ display: "none" }}
                          onChange={(e) => {
                            const files = Array.from(e.currentTarget.files || []);
                            if (files.length > 0) void uploadClearanceReceipts(files);
                            e.currentTarget.value = "";
                          }}
                        />
                      </label>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      {clearanceReceipts.length === 0 ? (
                        <div style={{ color: "var(--muted)", fontSize: 13 }}>No receipts uploaded yet.</div>
                      ) : (
                        clearanceReceipts.map((receipt) => (
                          <div key={receipt.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8 }}>
                            <FileText size={18} style={{ color: "#dc2626", flexShrink: 0 }} aria-hidden />
                            <div style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {String(receipt.file_path || "").split("/").pop() || receipt.file_path}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--muted)" }}>{receipt.uploaded_at ? new Date(receipt.uploaded_at).toLocaleDateString() : ""}</div>
                            <button type="button" className="ep-icon-btn danger" title="Remove" onClick={() => void removeClearanceReceipt(receipt.id)}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Clearance Process stepper */}
                  <div className="card" style={{ padding: 18 }}>
                    <div style={{ fontWeight: 600, color: "#2563eb", marginBottom: 16 }}>Clearance Process</div>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 4, overflowX: "auto" }}>
                      {[
                        { icon: User, title: "Employee", desc: "Capture expenses and submit for approval", bg: "#dbeafe", color: "#2563eb" },
                        { icon: UserRoundCheck, title: "Manager", desc: "Review and approve trip and expenses", bg: "#ffedd5", color: "#ea580c" },
                        { icon: Wallet, title: "Finance", desc: "Verify, reconcile and confirm settlement", bg: "#dcfce7", color: "#16a34a" },
                        { icon: DollarSign, title: "Payment", desc: "Process refund or reimbursement", bg: "#ede9fe", color: "#7c3aed" },
                        { icon: CheckCircle2, title: "Closed", desc: "Advance clearance completed", bg: "#dcfce7", color: "#16a34a" }
                      ].map((step, i, arr) => {
                        const Icon = step.icon;
                        return (
                          <React.Fragment key={step.title}>
                            <div style={{ flex: 1, minWidth: 90, textAlign: "center" }}>
                              <div style={{ width: 40, height: 40, borderRadius: "50%", background: step.bg, color: step.color, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px" }}>
                                <Icon size={18} aria-hidden />
                              </div>
                              <div style={{ fontWeight: 600, fontSize: 13 }}>{step.title}</div>
                              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{step.desc}</div>
                            </div>
                            {i < arr.length - 1 && <div style={{ color: "var(--muted)", paddingTop: 10, flexShrink: 0 }}><ChevronRight size={16} aria-hidden /></div>}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Right column: Settlement Details */}
                {clearanceBalance !== 0 && (
                <div className="card clearance-settlement-card">
                  <div className="clearance-settlement-title">Settlement Details</div>

                  {clearanceBalance < 0 && (
                    <div className="form-field" style={{ marginTop: 16 }}>
                      <label>Reason for Overspend <span style={{ color: "#dc2626" }}>*</span></label>
                      <textarea
                        value={clearanceReasonForOverspend}
                        onChange={(e) => setClearanceReasonForOverspend(e.target.value)}
                        rows={3}
                        placeholder="Explain why actual expenditure exceeded the advance received..."
                        style={{ width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                  )}

                  <div className="clearance-info-note">
                    <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
                    <div>
                      <strong>Important</strong>
                      <div style={{ marginTop: 2 }}>
                        {clearanceBalance < 0
                          ? "Negative variance means the company owes you. You'll be refunded via the same method you chose when requesting the advance - please ensure all receipts are attached."
                          : clearanceBalance > 0
                            ? "Positive variance means you owe the company. If you've already returned the balance, attach proof under Receipts above - otherwise this amount will be deducted from your salary."
                            : "This clearance is fully balanced. Attach any supporting documents needed for reconciliation."}
                      </div>
                    </div>
                  </div>
                </div>
                )}
              </div>

              <div className="footer-buttons" style={{ marginTop: 18 }}>
                <button className="button button-subtle clearance-action-button" onClick={() => {
                  resetClearanceForm();
                  setPage("MY_CLEARANCES");
                }}>
                  Cancel
                </button>
                <button className="button button-subtle clearance-action-button" type="button" onClick={() => persistClearance(false)}>
                  Save Draft
                </button>
                <button className="button clearance-action-button clearance-submit-button" type="button" onClick={() => persistClearance(true)} disabled={clearableTravelAdvances.length === 0}>
                  Submit Clearance
                </button>
              </div>
            </div>
          ) : page === "MY_ADVANCES" ? (
            <MyAdvances
              advances={advances}
              travelTypes={travelTypes}
              claims={claims}
              onContinueClearance={editClearance}
              onNew={startNewAdvanceRequest}
              onEdit={async (a) => {
                try {
                  const detail: any = await api.advanceDetail(a.id);
                  populateAdvanceForm(detail, a);
                  setPage("ADVANCE");
                } catch (e: any) {
                  alert("Error loading advance: " + e.message);
                }
              }}
              onTrack={showAdvanceHistory}
              onClear={startClearanceForAdvance}
            />
          ) : page === "MY_CLEARANCES" ? (
            <MyClearances claims={claims} onNew={startNewClearance} onEdit={editClearance} onTrack={showClearanceTracking} />
          ) : page === "MY_TEAM" ? (
            <MyTeam onDelegate={() => setPage("MANAGER_DELEGATIONS")} />
          ) : page === "SETTINGS" ? (
            <div className="ep-page">
              <div className="ep-breadcrumb"><span className="ep-breadcrumb-active">Settings</span></div>
              <div className="ep-header">
                <div className="ep-header-text">
                  <h1 className="ep-title">Settings</h1>
                  <p className="ep-subtitle">Manage your profile and account preferences.</p>
                </div>
              </div>

<SettingsAccordion
                  title="My Profile"
                  subtitle="View and confirm your user profile details."
                  open={profileAccordionOpen}
                  onToggle={() => setProfileAccordionOpen((current) => !current)}
                >
                  <div>Name and Surname: {profile?.full_name || "—"}</div>
                  <div>Division: {profile?.department || "—"}</div>
                  <div>Employment Type: {fmtEmploymentType(employmentType)}</div>
                  <div>Employment Number: {profile?.employee_no || "—"}</div>
                  <div>Role: {displayRoleLabel(role)}</div>
                  <div>Email: {profile?.email || "—"}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <span>Phone:</span>
                    <input
                      type="tel"
                      value={phoneDraft}
                      onChange={(e) => setPhoneDraft(e.target.value)}
                      placeholder="e.g. 6222 0000"
                      style={{ maxWidth: 180 }}
                    />
                    <button
                      className="ep-btn-outline"
                      style={{ padding: "4px 10px", fontSize: 12 }}
                      disabled={savingPhone || phoneDraft.trim() === (profile?.phone || "")}
                      onClick={async () => {
                        setSavingPhone(true);
                        try {
                          await api.updateMyProfileContact({ phone: phoneDraft.trim() });
                          setProfile((p: any) => ({ ...p, phone: phoneDraft.trim() }));
                        } catch (e: any) {
                          alert("Could not save phone number: " + e.message);
                        } finally {
                          setSavingPhone(false);
                        }
                      }}
                    >
                      {savingPhone ? "Saving…" : "Save"}
                    </button>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>Used to show your contact on standby rosters.</span>
                  </div>
                </SettingsAccordion>

              <SettingsAccordion
                title="Display Size"
                subtitle="Adjust the text and UI size to your preference. Changes apply immediately and are saved for your device."
                open={displayAccordionOpen}
                onToggle={() => setDisplayAccordionOpen(c => !c)}
              >
                {(() => {
                  const STEPS = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2];
                  const LABELS: Record<number, string> = {
                    0.8: "XS", 0.85: "S", 0.9: "S+", 0.95: "M−",
                    1.0: "M", 1.05: "M+", 1.1: "L", 1.15: "L+", 1.2: "XL"
                  };
                  const idx = STEPS.indexOf(uiScale);
                  const canDec = idx > 0;
                  const canInc = idx < STEPS.length - 1;
                  const pct = Math.round(uiScale * 100);

                  return (
                    <div>
                      {/* Controls row */}
                      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                        <button
                          onClick={() => canDec && setUiScale(STEPS[idx - 1])}
                          disabled={!canDec}
                          style={{
                            width: 40, height: 40, borderRadius: "50%", border: "2px solid var(--border)",
                            background: canDec ? "var(--surface)" : "var(--surface-soft)",
                            cursor: canDec ? "pointer" : "not-allowed",
                            color: canDec ? "var(--text)" : "var(--muted)",
                            fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                          title="Decrease size"
                        >−</button>

                        {/* Step dots */}
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {STEPS.map((s) => (
                            <button
                              key={s}
                              onClick={() => setUiScale(s)}
                              title={`${Math.round(s * 100)}% — ${LABELS[s]}`}
                              style={{
                                width: s === uiScale ? 28 : 18,
                                height: s === uiScale ? 28 : 18,
                                borderRadius: "50%",
                                border: s === uiScale ? "2px solid #3b82f6" : "2px solid var(--border)",
                                background: s === uiScale ? "#3b82f6" : "var(--surface-soft)",
                                cursor: "pointer",
                                transition: "all 0.15s",
                                padding: 0,
                              }}
                            />
                          ))}
                        </div>

                        <button
                          onClick={() => canInc && setUiScale(STEPS[idx + 1])}
                          disabled={!canInc}
                          style={{
                            width: 40, height: 40, borderRadius: "50%", border: "2px solid var(--border)",
                            background: canInc ? "var(--surface)" : "var(--surface-soft)",
                            cursor: canInc ? "pointer" : "not-allowed",
                            color: canInc ? "var(--text)" : "var(--muted)",
                            fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                          title="Increase size"
                        >+</button>

                        {/* Label + reset */}
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontWeight: 700, fontSize: 15, color: "#3b82f6", minWidth: 44 }}>{pct}%</span>
                          <span style={{ fontSize: 13, color: "var(--muted)" }}>{LABELS[uiScale]}</span>
                          {uiScale !== 1.0 && (
                            <button
                              onClick={() => setUiScale(1.0)}
                              style={{ fontSize: 12, color: "#3b82f6", background: "none", border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: 4, textDecoration: "underline" }}
                            >Reset</button>
                          )}
                        </div>
                      </div>

                      {/* Live preview */}
                      <div style={{ marginTop: 18, padding: "14px 18px", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 8 }}>
                        <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Preview</div>
                        <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--text)", marginBottom: 4 }}>Advance Request — Approval Workflow</div>
                        <div style={{ fontSize: "0.88rem", color: "var(--muted)" }}>Submit your request and track each approval stage in real time.</div>
                      </div>
                    </div>
                  );
                })()}
              </SettingsAccordion>

            </div>
          ) : (
            <>
              <div className="dashboard-hero">
                <div className="dashboard-hero-copy">
                  <div className="dashboard-eyebrow">Operations Portal</div>
                  <h2 className="dashboard-title">FlowDesk Dashboard</h2>
                  <p className="dashboard-subtitle">
                    Track upcoming approvals, active requests, and clearance work without leaving the register.
                  </p>
                  <div style={{ marginTop: 12 }}>
                    <HolidayCalendarButton />
                  </div>
                </div>
                <div className="dashboard-search-card" style={{ position: "relative" }}>
                  <div className="dashboard-search-title">Quick Search</div>
                  <input
                    className="dashboard-search-input"
                    type="text"
                    value={dashboardSearch}
                    onChange={(e) => setDashboardSearch(e.target.value)}
                    placeholder="Search by employee, type, or status"
                  />
                  {dashboardSearch.trim() && (
                    <div className="dashboard-search-results">
                      {dashboardSearchLoading ? (
                        <div className="dashboard-search-result-empty">Searching…</div>
                      ) : dashboardSearchResults.length === 0 ? (
                        <div className="dashboard-search-result-empty">No matches found.</div>
                      ) : (
                        dashboardSearchResults.map((r) => (
                          <div
                            key={`${r.kind}-${r.id}`}
                            className="dashboard-search-result"
                            onClick={() => {
                              setDashboardSearch("");
                              // Own request → straight to the personal list it lives on.
                              // Someone else's (only findable at all if this viewer has
                              // report_advances access) → the org-wide report, since
                              // there's no single-record deep link for another
                              // employee's advance/clearance yet.
                              if (r.kind === "advance") setPage(r.mine ? "MY_ADVANCES" : "REPORT_ADVANCES");
                              else setPage(r.mine ? "MY_CLEARANCES" : "REPORT_CLEARANCE_STATUS");
                            }}
                          >
                            <span className="dashboard-search-result-title">{r.title}</span>
                            <span className="dashboard-search-result-subtitle">{r.subtitle}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                  <div className="dashboard-sync-chip">
                    <span>Last sync</span>
                    <strong>{dashboardSearchSyncedAt ? dashboardSearchSyncedAt.toLocaleString() : "—"}</strong>
                  </div>
                </div>
              </div>

              <div className="ep-kpi-row">
                <div className="stat-card stat-card-blue">
                  <span className="stat-icon"><ClipboardList size={28} /></span>
                  <div><div className="stat-value">{pendingAdvCount}</div><div className="stat-label">Pending Advances</div></div>
                </div>
                <div className="stat-card stat-card-gold">
                  <span className="stat-icon"><FileText size={28} /></span>
                  <div><div className="stat-value">{pendingClaimCount}</div><div className="stat-label">Pending Clearances</div></div>
                </div>
                <div className="stat-card stat-card-rose">
                  <span className="stat-icon"><Mail size={28} /></span>
                  <div><div className="stat-value">{inboxCount}</div><div className="stat-label">Awaiting My Approval</div></div>
                </div>
                <div className="stat-card stat-card-green">
                  <span className="stat-icon"><BarChart3 size={28} /></span>
                  <div>
                    {monthlySpendByCurrency.length === 0
                      ? <div className="stat-value">{fmtMoney(0)}</div>
                      : monthlySpendByCurrency.map(([currency, value]) => <div key={currency} className="stat-value">{fmtMoney(value, currency)}</div>)}
                    <div className="stat-label">Monthly Spend</div>
                  </div>
                </div>
              </div>

              <div className="card" style={{ marginTop: 20, marginBottom: 4, padding: "14px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: favoriteShortcuts.length ? 12 : 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, display: "flex", alignItems: "center", gap: 6 }}>
                    <Star size={16} aria-hidden /> Shortcuts
                  </div>
                  <div style={{ position: "relative" }} ref={shortcutPickerRef}>
                    <button
                      type="button"
                      className="ep-btn-outline"
                      style={{ fontSize: 12, padding: "4px 10px", display: "flex", alignItems: "center", gap: 4 }}
                      onClick={() => setShortcutPickerOpen((v) => !v)}
                    >
                      <Plus size={13} aria-hidden /> Add Shortcut
                    </button>
                    {shortcutPickerOpen && (
                      <div
                        style={{
                          position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 30,
                          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
                          boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 220, maxHeight: 260, overflowY: "auto"
                        }}
                      >
                        {availableShortcuts.filter((s) => !favoritePages.includes(s.key)).length === 0 ? (
                          <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--muted)" }}>All available shortcuts are already pinned.</div>
                        ) : (
                          availableShortcuts.filter((s) => !favoritePages.includes(s.key)).map((s) => {
                            const Icon = s.icon;
                            return (
                              <button
                                key={s.key}
                                type="button"
                                onClick={() => toggleFavoritePage(s.key, true)}
                                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}
                              >
                                <Icon size={14} aria-hidden /> {s.label}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {favoriteShortcuts.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>Pin your most-used processes here for one-click access.</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {favoriteShortcuts.map((s) => {
                      const Icon = s.icon;
                      return (
                        <div
                          key={s.key}
                          onClick={() => setPage(s.key)}
                          style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", cursor: "pointer", background: "var(--surface-soft)" }}
                        >
                          <Icon size={16} aria-hidden />
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</span>
                          <button
                            type="button"
                            title="Remove shortcut"
                            onClick={(e) => { e.stopPropagation(); toggleFavoritePage(s.key, false); }}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", marginLeft: 4 }}
                          >
                            <X size={13} aria-hidden />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="card-container">
                <div className="card dashboard-card dashboard-total-card">
                  <div className="dashboard-card-head" style={{ cursor: "pointer" }} onClick={() => setPage("MY_ADVANCES")}>
                    <div className="title">My Total Requests</div>
                    <FileText size={32} className="dashboard-total-icon" aria-hidden />
                  </div>
                  <div className="value" style={{ cursor: "pointer" }} onClick={() => setPage("MY_ADVANCES")}>{advances.length + claims.length}</div>
                  <div className="dashboard-card-sub">Total requests across all categories</div>
                  <div className="dashboard-actions">
                    <button className="button button-primary" disabled={!canOpenAdvanceForm} onClick={startNewAdvanceRequest}>
                      <Plus size={14} aria-hidden /> New Advance Request
                    </button>
                    <button className="button" disabled={!canRequestForSelf} onClick={startNewClearance}>
                      <Plus size={14} aria-hidden /> New Clearance
                    </button>
                  </div>
                </div>
                <div className="card dashboard-card dashboard-profile-card">
                  <div className="dashboard-card-head">
                    <div className="title">Profile Snapshot</div>
                    <button className="ep-icon-btn" title="Edit profile" onClick={() => setPage("SETTINGS")}>
                      <Edit3 size={14} aria-hidden />
                    </button>
                  </div>
                  <div className="dashboard-profile-body">
                    <div className="dashboard-profile-fields">
                      <div><strong>Name:</strong> {profile?.full_name || me?.fullName || "—"}</div>
                      <div><strong>Employee No:</strong> {profile?.employee_no || me?.employeeNo || "—"}</div>
                      <div><strong>Division:</strong> {profile?.department || me?.department || "—"}</div>
                    </div>
                    <div className="dashboard-avatar">{dashboardInitials(profile?.full_name || me?.fullName)}</div>
                  </div>
                </div>
              </div>

              {hasActiveCustomRequestTypes && (
                <div className="card" style={{ marginTop: 20, padding: "16px 20px", display: "flex", alignItems: "center", gap: 16 }}>
                  <span style={{ width: 44, height: 44, borderRadius: 10, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <GitBranch size={22} color="#2563eb" aria-hidden />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>Custom Processes</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Submit a change request, attendance register, or other configured process</div>
                  </div>
                  <button className="button button-primary" onClick={() => setPage("CHANGE_REQUEST")}>Open</button>
                </div>
              )}

              <div className="dashboard-panel-row">
                <div className="card dashboard-panel">
                  <div className="dashboard-panel-head">
                    <h3>Recent Activity</h3>
                    <span className="dashboard-panel-link" onClick={() => setPage("REPORT_AUDIT")}>View all</span>
                  </div>
                  {dashboardRecentActivity.length === 0 ? (
                    <div className="dashboard-panel-empty">No recent activity yet.</div>
                  ) : (
                    <div className="dashboard-activity-list">
                      {dashboardRecentActivity.map((entry) => {
                        const Icon = entry.status === "PAID" || entry.status === "APPROVED" ? CheckCircle2 : entry.status === "REJECTED" ? X : Clock3;
                        return (
                          <div className="dashboard-activity-item" key={entry.id}>
                            <span className={`dashboard-activity-icon ${dashboardStatusTone(entry.status)}`}>
                              <Icon size={16} aria-hidden />
                            </span>
                            <div className="dashboard-activity-body">
                              <div className="dashboard-activity-title">
                                <strong>{entry.title}</strong>
                                <span className={`status-pill ${dashboardStatusTone(entry.status)}`}>{dashboardStatusLabel(entry.status)}</span>
                              </div>
                              <div className="dashboard-activity-sub">{entry.subtitle}</div>
                            </div>
                            <time>{new Date(entry.date).toLocaleString()}</time>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="dashboard-panel-footer" onClick={() => setPage("REPORT_AUDIT")}>View all activity →</div>
                </div>

                <div className="card dashboard-panel">
                  <div className="dashboard-panel-head">
                    <h3>Approval Queue</h3>
                    <span className="inbox-count-chip">{inboxCount} total</span>
                  </div>
                  {dashboardQueueGroups.length === 0 ? (
                    <div className="dashboard-panel-empty">No items awaiting your approval.</div>
                  ) : (
                    <div className="dashboard-queue-list">
                      {dashboardQueueGroups.map((g) => {
                        const Icon = dashboardDocTypeIcon(g.docType);
                        return (
                          <div className="dashboard-queue-group" key={g.docType}>
                            <div className="dashboard-queue-row">
                              <div className="dashboard-queue-label">
                                <span className="inbox-group-icon"><Icon size={16} aria-hidden /></span>
                                <strong>{dashboardDocTypeLabel(g.docType)}</strong>
                                <span className="inbox-count-chip">{g.count}</span>
                              </div>
                              <div className="dashboard-queue-meta">
                                <span className="inbox-badge inbox-badge-info">Awaiting: {g.count}</span>
                                <span className="inbox-badge inbox-badge-total">Total Amount: {fmtMoney(g.total)}</span>
                              </div>
                            </div>
                            {Object.keys(g.byStage).length > 0 && (
                              <div className="dashboard-queue-stages">
                                {Object.entries(g.byStage).map(([stage, s]) => (
                                  <div className="dashboard-queue-stage" key={stage}>
                                    <span>Pending {displayOrgGroupName(stage)} <b>{s.count}</b></span>
                                    <span>{fmtMoney(s.amount)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="dashboard-panel-footer" onClick={() => setPage("INBOX")}>View all queues →</div>
                </div>
              </div>

              {standbyModuleEnabled && (
                <div className="card dashboard-panel" style={{ marginTop: 16 }}>
                  <div className="dashboard-panel-head">
                    <h3>Who's on Standby Today</h3>
                    <span className="dashboard-panel-link" onClick={() => setPage("STANDBY")}>Open Standby →</span>
                  </div>
                  {standbyToday.length === 0 ? (
                    <div className="dashboard-panel-empty">Nobody on standby today.</div>
                  ) : (
                    <div className="ep-table-wrap">
                      <table className="ep-table">
                        <thead><tr><th>Employee</th><th>Position</th><th>Email</th><th>Phone</th><th>From</th><th>To</th></tr></thead>
                        <tbody>
                          {standbyToday.map((p: any, idx: number) => (
                            <tr key={idx}>
                              <td>{p.full_name}</td>
                              <td>{p.title || "—"}</td>
                              <td>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : "—"}</td>
                              <td>{p.phone ? <a href={`tel:${p.phone}`}>{p.phone}</a> : "—"}</td>
                              <td>{p.start_time}</td>
                              <td>{p.end_time}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {!canOpenAdvanceForm && (
                <div className="card" style={{ marginTop: 20, padding: 16 }}>
                  <div>{fmtEmploymentType(employmentType)} users cannot create their own advances or clearances.</div>
                  {eligibleSupportCreators.length > 0 && (
                    <div style={{ marginTop: 12, display: "grid", gap: 10, maxWidth: 420 }}>
                      <div><strong>Choose a department member to help you:</strong></div>
                      <select value={supportCreatorUserId} onChange={(e) => setSupportCreatorUserId(e.target.value)}>
                        <option value="">Select support creator</option>
                        {eligibleSupportCreators.map((user) => (
                          <option key={user.id} value={user.id}>
                            {formatPersonLabel(user)} - {displayRoleLabel(user.role)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

            </>
          )}
          {historyOpen && renderAdvanceTrackingModal()}
          {clearanceTrackOpen && renderClearanceTrackingModal()}
          </div>
        </div>
      </div>
    </div>
  );
}
