import React, { useCallback, useEffect, useState } from "react";
import { useStaffDirectory } from "./useStaffDirectory";
import { api, clearToken, getTheme, getToken, setTheme as saveTheme, setToken, getUserFromToken, getUiScale, saveUiScale } from "./api";
import AttendanceModule from "./AttendanceModule";
import Inbox from "./Inbox";
import OvertimeModule from "./OvertimeModule";
import OvertimeClaimModule from "./OvertimeClaimModule";
import EmployeesOnboarding from "./EmployeesOnboarding";
import ExcoOnboarding from "./ExcoOnboarding";
import LeadershipAssignments from "./LeadershipAssignments";
import ManagersOnboarding from "./ManagersOnboarding";
import WorkflowBuilder from "./WorkflowBuilder";
import ReportingLines from "./ReportingLines";
import RequestTypes from "./RequestTypes";
import CeoManagement from "./CeoManagement";
import OrgStructure from "./OrgStructure";
import OrgPicker, { type OrgSelection, orgSelectionFromUser } from "./OrgPicker";
import TeamRoster from "./TeamRoster";
import UserManagement from "./UserManagement";
import SlaReports from "./SlaReports";
import ReportAdvances from "./ReportAdvances";
import ReportApprovalPerformance from "./ReportApprovalPerformance";
import ReportWorkflowAnalytics from "./ReportWorkflowAnalytics";
import ReportAuditTrail from "./ReportAuditTrail";
import { useEmploymentTypes } from "./useEmploymentTypes";
import { confirmAction } from "./alerts";
import { CURRENCIES, LESOTHO_DISTRICTS, SOUTH_AFRICA_PROVINCES, TravelType, formatMoney, getCurrencySymbol, isTravelTypeCode, travelTypeLabel } from "./constants";
import econetLogo from "./assets/econetLogo.webp";
import {
  BarChart3,
  Bell,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Clock3,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  Home,
  Hotel,
  Lock,
  LogOut,
  Mail,
  Moon,
  Network,
  Plane,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Trash2,
  User,
  UserRoundCheck,
  Users,
  Wallet,
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

type AppPage = "HOME" | "INBOX" | "ADVANCE" | "CLEARANCE" | "MY_REQUESTS" | "REPORTS" | "SLA_REPORTS" | "REPORT_ADVANCES" | "REPORT_APPROVAL" | "REPORT_WORKFLOW" | "REPORT_AUDIT" | "SETTINGS" | "ATTENDANCE" | "OVERTIME" | "OVERTIME_CLAIM" | "EXCO" | "MANAGERS" | "EMPLOYEES" | "LEADERSHIP" | "WORKFLOW_BUILDER" | "REPORTING_LINES" | "USER_MANAGEMENT" | "ROLES_PERMISSIONS" | "TRAVEL_SETUP" | "REQUEST_TYPES" | "CEO_MANAGEMENT" | "ORG_STRUCTURE" | "TEAM_ROSTER";

export default function App() {
  const empTypes = useEmploymentTypes();
  const [token, setTok] = useState(getToken());
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
  const [hotelsLoading, setHotelsLoading] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [newHotelDistrict, setNewHotelDistrict] = useState("");
  const [newHotelCountry, setNewHotelCountry] = useState("");
  const [newHotelProvince, setNewHotelProvince] = useState("");
  const [newHotelCity, setNewHotelCity] = useState("");
  const [newHotelAddress, setNewHotelAddress] = useState("");
  const [newHotelContact, setNewHotelContact] = useState("");
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
  const [displayAccordionOpen, setDisplayAccordionOpen] = useState(true);
  const [travelSettingsOpen, setTravelSettingsOpen] = useState(true);
  const [sectionManagementOpen, setSectionManagementOpen] = useState(true);
  const [delegationsOpen, setDelegationsOpen] = useState(false);
  const [adminUsersOpen, setAdminUsersOpen] = useState(false);
  const [orgNavOpen, setOrgNavOpen] = useState(false);
  const [featurePermissions, setFeaturePermissions] = useState<Record<string, string[]>>({});
  const [featurePermOpen, setFeaturePermOpen] = useState(false);
  const [featurePermDraft, setFeaturePermDraft] = useState<Record<string, string[]>>({});
  const [permissionGroups, setPermissionGroups] = useState<{ name: string; member_count: string; dynamic?: boolean }[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  const [featurePermSaving, setFeaturePermSaving] = useState(false);
  const [delegations, setDelegations] = useState<any[]>([]);
  const [delegationsLoading, setDelegationsLoading] = useState(false);
  const [orgAssignModal, setOrgAssignModal] = useState<{ userId: string; userName: string } | null>(null);
  const [orgAssignSelection, setOrgAssignSelection] = useState<OrgSelection>({ divisionId: null, divisionName: null, department: null, departmentId: null, sectionId: null, sectionName: null, teamId: null, teamName: null });
  const [orgAssignSaving, setOrgAssignSaving] = useState(false);
  const [userDivisionFilter, setUserDivisionFilter] = useState<string>("");
  const [delegationManagerId, setDelegationManagerId] = useState("");
  const [delegationDelegateId, setDelegationDelegateId] = useState("");
  const [delegationFromDate, setDelegationFromDate] = useState("");
  const [delegationToDate, setDelegationToDate] = useState("");
  const [advances, setAdvances] = useState<any[]>([]);
  const [claims, setClaims] = useState<any[]>([]);
  const [inboxCount, setInboxCount] = useState(0);
  const [page, setRawPage] = useState<AppPage>("HOME");

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
  const [historyAdvanceId, setHistoryAdvanceId] = useState<string | null>(null);
  const [historyAdvanceDetail, setHistoryAdvanceDetail] = useState<any | null>(null);
  const [historyEvents, setHistoryEvents] = useState<any[]>([]);
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
    switch (value) {
      case "CEO":          return "Chief Executive Officer";
      case "ADMIN":        return "Administrator";
      case "EXCO":         return "EXCO Member";
      case "HR_MANAGER":   return "HR Manager";
      case "HOD":          return "Head of Department";
      case "MANAGER":      return "Manager";
      case "FINANCE":      return "Finance";
      case "EMPLOYEE":     return "Employee";
      default:             return value || "Unknown";
    }
  }

  function displayUserLabel(value: string | null | undefined, roleValue: string | null | undefined) {
    if (roleValue === "HR_MANAGER") return "HR Manager";
    if (!value) return "User";
    if (value === "Authorising Officer") return "HR";
    return value;
  }

  function fmtEmploymentType(value: string | null | undefined) {
    return empTypes.find(t => t.code === value)?.name ?? value ?? "Unknown";
  }

  function isApproverRole(value: string | null | undefined) {
    return ["HOD", "MANAGER", "HR_MANAGER", "FINANCE", "ADMIN", "EXCO", "CEO"].includes(String(value || "").trim().toUpperCase());
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
        <td><span className="status-pill status-pill-success">Department</span></td>
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
          <button className="icon-button" onClick={() => void editDepartment(department.name)} title="Edit department" aria-label="Edit department" style={{ marginRight: 8 }}>
            <Edit3 size={16} aria-hidden />
          </button>
          <button className="icon-button danger" onClick={() => void deleteDepartment(department.name)} title="Delete department" aria-label="Delete department">
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
  const [travelAmount, setTravelAmount] = useState("");
  const [loanAmount, setLoanAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"ECOCASH" | "BANK">("ECOCASH");
  const [ecocashNumber, setEcocashNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankBranch, setBankBranch] = useState("");
  const [purpose, setPurpose] = useState("");
  const [requestDate, setRequestDate] = useState(new Date().toISOString().slice(0, 10));
  const districts = LESOTHO_DISTRICTS;
  const [rows, setRows] = useState<TravelRow[]>([]);
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
    const copy = [...rows];
    if (field === "meals") {
      const meals = Number(value) || 0;
      const maxMeals = selectedTravelType?.rate_kind === "DAILY" ? Infinity : 3;
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
  const selectedTravelRate = selectedTravelType ? Number(selectedTravelType.rate_general_staff || 0) : 0;
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
  const isTravelAdvanceSelected = Boolean(selectedTravelType);
  const rowTotals = rows.reduce(
    (acc, r) => {
      const meals = Number.isFinite(Number(r.meals)) ? Math.max(0, Number(r.meals)) : 0;
      return {
        meals: acc.meals + meals,
        amount: acc.amount + meals * selectedTravelRate
      };
    },
    { meals: 0, amount: 0 }
  );
  const totalRequested = () => {
    if (isTravelAdvanceSelected) return rowTotals.amount;
    if (advanceType === "SALARY") return Number(salaryAmount) || 0;
    if (advanceType === "LOAN") return Number(loanAmount) || 0;
    return 0;
  };
  const clearableTravelAdvances = advances.filter(
    (a) => isTravelTypeCode(a.type, travelTypes) && a.status === "PAID"
  );
  const selectedClearanceAdvance = clearableTravelAdvances.find((a) => a.id === clearanceLinkedAdvanceId) || null;
  const clearanceAdvanceAmount = Number(selectedClearanceAdvance?.approved_total || 0);
  const clearanceTotals = clearanceSourceLines.reduce(
    (acc, trip) => {
      const meals = Number(trip.line_total || 0) || Number(trip.meals || 0) || Number(trip.lunch || 0) + Number(trip.dinner || 0);
      const mealCount = Number(trip.meals_count || 0) || (mealValueNumber > 0 ? meals / mealValueNumber : 0);
      const lineTotal =
        meals +
        (Number(trip.other_expenses) || 0) +
        (Number(trip.petrol_allowance) || 0);
      acc.petrol += Number(trip.petrol_allowance) || 0;
      acc.mealCount += mealCount;
      acc.meals += meals;
      acc.other += Number(trip.other_expenses) || 0;
      acc.total += lineTotal;
      return acc;
    },
    { petrol: 0, mealCount: 0, meals: 0, other: 0, total: 0 }
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
    return lineRate > 0 ? Number((amount / lineRate).toFixed(2)) : amount;
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
  }, [advanceType, salaryAmount, loanAmount, travelAmount, rows, mealValue, travelTypes]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${uiScale * 16}px`;
    saveUiScale(uiScale);
  }, [uiScale]);

  useEffect(() => {
    if (isTravelAdvanceSelected) {
      const total = rowTotals.amount;
      setTravelAmount(total.toFixed(2));
    }
  }, [rows, advanceType, selectedTravelRate, isTravelAdvanceSelected]);

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
    || profile?.department || me?.department || "No Department";
  const userInitials = initials(userName);
  const roleName = displayRoleLabel(role);
  const FEATURE_DEFAULTS: Record<string, string[]> = {
    user_management:        ["ADMIN", "MANAGER", "EXCO"],
    roles_permissions:      ["ADMIN", "MANAGER", "EXCO"],
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
  };

  function canAccessFeature(key: string): boolean {
    const allowed = featurePermissions[key] ?? FEATURE_DEFAULTS[key] ?? [];
    if (allowed.includes(role)) return true;
    const myGroups: string[] = profile?.groups ?? [];
    return allowed.some((g) => myGroups.includes(g));
  }

  const canManageTravelSettings = canAccessFeature("travel_setup");
  const profileCompleted = Boolean(profile?.profile_completed ?? me?.profileCompleted);
  const employmentType = profile?.employment_type || me?.employmentType || "PERMANENT";
  const canRequestForSelf = profileCompleted && employmentType === "PERMANENT";
  const canCreateForOthers = profileCompleted && (employmentType === "PERMANENT" || isApproverRole(role));
  const canOpenAdvanceForm = canRequestForSelf || canCreateForOthers;
  const eligibleBeneficiaries = requestDirectory.filter(
    (user) =>
      user.id !== profile?.id &&
      ["INTERN", "TEMPORARY"].includes(String(user.employment_type || "").toUpperCase()) &&
      Boolean(user.profile_completed)
  );
  const eligibleSupportCreators = requestDirectory.filter(
    (user) => user.id !== profile?.id && (String(user.employment_type || "").toUpperCase() === "PERMANENT" || isApproverRole(user.role))
  );
  const selectedRequestUser =
    requestDirectory.find((user) => user.id === requestForUserId) ||
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
    if (page !== "MY_REQUESTS" && page !== "ADVANCE") return;
    const dept = profile?.department || "";
    const section = profile?.section_name || "";

    function loadCustomChainData() {
      setChainPositionTypes([
        { id: "counter_signer", name: "Counter Signed By", code: "COUNTER_SIGNER" },
        { id: "approved_by",    name: "Approved By",       code: "APPROVED_BY"    },
      ]);
    }

    if (!dept) {
      setAdvanceApprovalChain([]);
      setAdvanceWorkflowFound(false);
      loadCustomChainData();
      return;
    }
    setAdvanceWorkflowFound(null);
    // Pass the selected advance sub-type so the backend can prefer a sub-type-specific workflow
    api.resolveWorkflow("ADVANCE_REQUEST", dept, undefined, section, advanceType || undefined)
      .then((result: any) => {
        const chain: any[] = Array.isArray(result?.chain) ? result.chain : [];
        const filtered = chain.filter((s: any) => s.position_type_code !== "EMPLOYEE");
        setAdvanceApprovalChain(
          filtered.map((s: any) => {
            const rawTitle = s.approver_title || s.position_name;
            const isTeamGroup = rawTitle.startsWith("Team: ");
            const title = isTeamGroup ? rawTitle.slice("Team: ".length) : rawTitle;
            return {
              label: title,
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
        setAdvanceApprovalChain([]);
        setAdvanceWorkflowFound(false);
        loadCustomChainData();
      });
  }, [page, profile?.department, profile?.section_name, advanceType]);

  async function refresh() {
    setError(null);
    const meResp = await withStartupTimeout(api.me(), "Profile");
    setProfile(meResp);
    // Pre-seed the profile org selection so the profile completion form
    // shows the user's current org placement if they revisit it
    if (meResp) {
      setProfileOrgSelection(orgSelectionFromUser(meResp));
      if (meResp.department) setProfileDepartment(meResp.department);
    }

    const [departmentsResp, directoryResp, a, c, i, mealResp, travelResp, featPermResp, groupsResp] = await Promise.all([
      optionalStartupData<string[]>(api.departments(), [], "Departments"),
      optionalStartupData<RequestDirectoryUser[]>(api.requestDirectory(), [], "Request directory"),
      optionalStartupData<any[]>(api.advances(), [], "Advances"),
      optionalStartupData<any[]>(api.claims(), [], "Claims"),
      optionalStartupData<{ items?: any[] }>(api.inbox(), { items: [] }, "Inbox"),
      optionalStartupData<{ meal_value?: number }>(api.mealValue(), { meal_value: 0 }, "Meal value"),
      optionalStartupData<TravelType[]>(api.travelTypes(), [], "Travel types"),
      optionalStartupData<{ features?: Record<string, string[]> }>(api.adminFeaturePermissions(), {}, "Feature permissions"),
      optionalStartupData<{ name: string; member_count: string; dynamic?: boolean }[]>(api.permissionGroups(), [], "Permission groups")
    ]);
    setDepartmentOptions(Array.isArray(departmentsResp) ? departmentsResp : []);
    setRequestDirectory(Array.isArray(directoryResp) ? directoryResp : []);
    setAdvances(Array.isArray(a) ? a : []);
    setClaims(Array.isArray(c) ? c : []);
    setInboxCount(i.items?.length || 0);
    const configuredMealValue = Number(mealResp.meal_value || 0);
    setMealValue(configuredMealValue);
    setMealValueDraft(String(configuredMealValue));
    setTravelTypes(Array.isArray(travelResp) ? travelResp : []);
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
        setClearanceSourceLines(detail.lines || []);
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
    if (token && ["SETTINGS", "REPORTS", "USER_MANAGEMENT", "ROLES_PERMISSIONS"].includes(page)) {
      if (role === "ADMIN" || role === "MANAGER") {
        void loadAdminUsers();
        void loadDelegations();
      }
    }
    if (token && ["SETTINGS", "REPORTS", "TRAVEL_SETUP"].includes(page)) {
      void loadHotels();
      void loadMealValue();
      void loadTravelTypes();
    }
  }, [token, page, role]);

  const ORG_PAGES = ["EXCO", "CEO_MANAGEMENT", "MANAGERS", "EMPLOYEES", "LEADERSHIP", "WORKFLOW_BUILDER", "REPORTING_LINES", "ORG_STRUCTURE", "TEAM_ROSTER"] as const;

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

  async function loadHotels() {
    setHotelsLoading(true);
    try {
      const rows: any[] = await api.hotels();
      setHotels(rows || []);
    } catch (e: any) {
      alert("Error loading hotels: " + e.message);
    } finally {
      setHotelsLoading(false);
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
        requires_accommodation: newTravelTypeRequiresAccommodation
      });
      setNewTravelTypeName("");
      setNewTravelTypeGeneralRate("0");
      setNewTravelTypeExcoRate("0");
      setNewTravelTypeCeoRate("0");
      setNewTravelTypeCurrency("LSL");
      setNewTravelTypeRequiresAccommodation(false);
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
        requires_accommodation: type.requires_accommodation ?? false
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
      setToken(r.token);
      setTok(r.token);
      setProfile(r.user || null);
      setPage("HOME");
    } catch (e: any) {
      console.error("Login error:", e);
      const errorMsg = e?.message || "Login failed. Please try again.";
      setError(errorMsg);
    } finally {
      setLoginLoading(false);
    }
  }

  async function doLogout() {
    clearToken();
    setTok(null);
    setProfile(null);
    setRequestDirectory([]);
    setAdvances([]);
    setClaims([]);
    setInboxCount(0);
    setAdminUsers([]);
    setPage("HOME");
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
      setDepartmentOptions((current) =>
        effectiveDepartment && !current.includes(effectiveDepartment)
          ? [...current, effectiveDepartment].sort((a, b) => a.localeCompare(b))
          : current
      );
      setRequesterName(result.user?.full_name || "");
      setEmpNumber(result.user?.employee_no || "");
      alert(
        profileEmploymentType === "PERMANENT"
          ? "Profile saved. You can now request advances."
          : "Profile saved. Interns and temporary employees cannot create their own advances, but permanent staff can create on their behalf."
      );
    } catch (e: any) {
      alert("Error saving profile: " + e.message);
    }
  }

  async function loadAdminUsers() {
    setAdminUsersLoading(true);
    try {
      const [users, sections, departments, leaders] = await Promise.all([
        api.adminUsers(),
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

  useEffect(() => {
    if (delegationsOpen && delegations.length === 0 && !delegationsLoading) {
      void loadDelegations();
    }
  }, [delegationsOpen]);

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
        to_date: delegationToDate || undefined
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
      await api.endDelegation(id);
      setDelegations((current) => current.filter((delegation) => delegation.id !== id));
    } catch (e: any) {
      alert("Error ending delegation: " + e.message);
    }
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
      alert(`Department group ${created.name} created.`);
    } catch (e: any) {
      alert("Error creating department: " + e.message);
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
      title: "Delete department group?",
      text: `Delete '${name}'? This cannot be undone.`,
      confirmButtonText: "Delete"
    });
    if (!confirmed) return;
    try {
      await api.deleteDepartment(name);
      setDepartmentOptions((current) => (current || []).filter((d) => d !== name));
      await loadAdminUsers();
      alert(`Department group ${name} deleted.`);
    } catch (e: any) {
      alert("Error deleting department: " + e.message);
    }
  }

  async function createSection() {
    const name = newSectionName.trim();
    if (!name) {
      alert("Enter a section name.");
      return;
    }

    try {
      const created: any = await api.createSection(name, newSectionExcoId || null);
      setNewSectionName("");
      setNewSectionExcoId("");
      await loadAdminUsers();
      alert(`Section ${created.name} created.`);
    } catch (e: any) {
      alert("Error creating section: " + e.message);
    }
  }

  async function editSection(id: string, currentName: string) {
    // open edit modal for section
    const section = sectionOptions.find((s) => s.id === id);
    setEditingSectionObj({ id, name: section?.name || currentName, exco_user_id: section?.exco_user_id || null });
  }

  async function deleteSection(id: string, name: string) {
    const confirmed = await confirmAction({
      title: "Delete section?",
      text: `Delete '${name}'? This cannot be undone.`,
      confirmButtonText: "Delete"
    });
    if (!confirmed) return;
    try {
      await api.deleteSection(id);
      await loadAdminUsers();
      alert(`Section ${name} deleted.`);
    } catch (e: any) {
      alert("Error deleting section: " + e.message);
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
    if (!payload.name) return alert('Enter a department name.');
    try {
      const updated: any = await api.updateDepartment(editingDepartmentObj.originalName, payload);
      setEditingDepartmentObj(null);
      await loadAdminUsers();
      alert(`Department updated: ${updated.name || payload.name}`);
    } catch (e: any) {
      alert('Error updating department: ' + e.message);
    }
  }

  function cancelEditDepartment() {
    setEditingDepartmentObj(null);
  }

  async function submitEditSection() {
    if (!editingSectionObj) return;
    const payload: any = { name: editingSectionObj.name.trim(), exco_user_id: editingSectionObj.exco_user_id || null };
    if (!payload.name) return alert('Enter a section name.');
    try {
      const updated: any = await api.updateSection(editingSectionObj.id, payload);
      setEditingSectionObj(null);
      await loadAdminUsers();
      alert(`Section updated: ${updated.name || payload.name}`);
    } catch (e: any) {
      alert('Error updating section: ' + e.message);
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
    if (clearableTravelAdvances.length === 0) {
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
    setTravelAmount("");
    setPaymentMethod("ECOCASH");
    setEcocashNumber("");
    setBankName("");
    setBankAccountNumber("");
    setBankBranch("");
    setPurpose("");
    setRequestDate(new Date().toISOString().slice(0, 10));
    setRows([]);
    setMonthField("");
    setCustomApprovalChain([]);
    setCustomChainLabel("");
    setCustomChainUserId("");
    setChainPositionSearches({});
    setChainPositionTypes([]);
    setPage("ADVANCE");
  }

  function advanceStageLabel(status: string, _type?: string) {
    switch (status) {
      case "DRAFT":             return "Draft (not submitted)";
      case "SUBMITTED":         return "Pending Approval";
      case "COUNTERSIGNED":     return "Pending HOD / EXCO Approval";
      case "HR_MANAGER_REVIEW": return "Pending HR Manager Approval";
      case "HR_REVIEW":         return "Pending HR Review";
      case "HR_OFFICER":        return "Pending Finance Payment";
      case "APPROVED":          return "Approved — Awaiting Payment";
      case "PAID":              return "Completed";
      case "CANCELLED":         return "Cancelled";
      case "REJECTED":          return "Rejected";
      default:                  return humanizeToken(status);
    }
  }

  function clearanceStageLabel(claim: any) {
    const status = typeof claim === "string" ? claim : claim?.status;
    switch (status) {
      case "DRAFT":
        return "Draft clearance";
      case "SETTLED":
        return "Cleared";
      case "REJECTED":
        return "Rejected";
    }

    if (claim && typeof claim === "object" && Array.isArray(claim.approval_chain) && claim.approval_chain.length > 0) {
      const chain = claim.approval_chain;
      const stepIdx = typeof claim.workflow_step_order === "number" ? claim.workflow_step_order : 0;
      const step = chain[stepIdx];
      if (step) {
        return `Waiting on ${step.position_name || step.approver_title || "Approver"}`;
      }
    }

    switch (status) {
      case "SUBMITTED":
        return "Waiting Manager Certification";
      case "MANAGER_APPROVED":
      case "CHIEF_OFFICER_APPROVED":
        return "Pending Approval";
      case "HR_OFFICER":
        return "Waiting HR Manager Approval";
      case "HR_MANAGER_REVIEW":
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

  function statusToneClass(value: any) {
    const status = String(value || "").toUpperCase();
    if (["REJECTED", "CANCELLED"].includes(status) || status.includes("REJECT")) return "tracking-tone-danger";
    if (["PAID", "APPROVED", "HR_OFFICER"].includes(status)) return "tracking-tone-success";
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
      const blob = await api.advancePdf(advanceId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err: any) {
      alert(err?.message || "Failed to generate PDF.");
    }
  }

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
        const isDone   = terminalDone || stepApproved || currentStepIdx > idx;
        const isActive = !terminalFailed && !isDone && pendingStage.has(idx);
        // "Team: X" steps are approvable by any member of that group, not the
        // specific individual returned as approver_name/approver_title (the
        // department HOD) — show the group name instead, with no fixed actor.
        const isTeamGroup = typeof step.position_name === "string" && step.position_name.startsWith("Team: ");
        const label = isTeamGroup ? step.position_name.slice("Team: ".length) : (step.approver_title || step.position_name);
        const actorName = isTeamGroup ? "" : (approveEvent?.actor_name || step.approver_name || "");
        stages.push({
          key: `step-${idx}`,
          label,
          state: terminalFailed && isActive ? "danger" : isActive ? "active" : isDone ? "done" : "waiting",
          date: approveEvent?.created_at || "",
          actor: actorName,
          status: isActive ? "In Progress" : isDone ? "Approved" : "Waiting"
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
    const managerEvent  = eventForTransition(events, ["SUBMITTED"], ["COUNTERSIGNED", "HR_MANAGER_REVIEW"]);
    const hodEvent      = eventForTransition(events, ["COUNTERSIGNED"], ["HR_MANAGER_REVIEW"]);
    const hrManagerEvent = eventForTransition(events, ["HR_MANAGER_REVIEW"], ["HR_REVIEW"]);
    const hrEvent       = eventForTransition(events, ["HR_REVIEW"], ["HR_OFFICER", "APPROVED"]);
    const financeEvent  = eventForTransition(events, ["HR_OFFICER", "APPROVED"], ["APPROVED", "PAID"]);

    const managerDest = String(managerEvent?.after_json?.status || "").toUpperCase();
    const throughCountersigned = managerDest === "COUNTERSIGNED" || currentStatus === "COUNTERSIGNED";
    const skippedMiddle = Boolean(managerEvent) && !throughCountersigned;

    const order: Record<string, number> = {
      DRAFT: 0, SUBMITTED: 1, COUNTERSIGNED: 2,
      HR_MANAGER_REVIEW: 3, HR_REVIEW: 4, HR_OFFICER: 5, APPROVED: 6, PAID: 7
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
      stage("hr-manager", "HR Manager Review", ["HR_MANAGER_REVIEW"], 3, hrManagerEvent),
      stage("hr", "HR Review", ["HR_REVIEW"], 4, hrEvent),
      stage("finance", "Finance Approval", ["HR_OFFICER", "APPROVED"], 6, financeEvent),
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
    setTravelAmount(isTravelTypeCode(detail.type, travelTypes) ? String(detail.requested_total || 0) : "");
    setRows(detail.lines ? detail.lines.map((line: any) => travelRowFromLine(line)) : []);
    setMonthField(detail.salary_month || "");
    setSalaryPaybackDuration(
      detail.type === "SALARY"
        ? (detail.salary_payback_duration || detail.payback_duration || "")
        : ""
    );
    setLoanPaybackDuration(
      detail.type === "LOAN"
        ? (detail.loan_payback_duration || detail.payback_duration || "")
        : ""
    );
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
    return status === "HR_MANAGER_REVIEW" || status === "HR_REVIEW" || status === "HR_OFFICER" || status === "APPROVED" || status === "PAID";
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
    setClearanceTrips([emptyClearanceTripRow()]);
    setClearanceReceipts(detail.receipts || []);
  }

  function buildClearancePayload() {
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
    if (clearanceSourceLines.length < 1) {
      alert("No advance trip lines were found to clear.");
      return null;
    }
    if (clearanceTotals.total <= 0) {
      alert("Total expenditure must be greater than 0.");
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
      linked_advance_id: clearanceLinkedAdvanceId
    };
  }

  async function persistClearance(submitAfterSave: boolean, options?: { silent?: boolean; refreshAfterSave?: boolean }) {
    const payload = buildClearancePayload();
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

      if (submitAfterSave) {
        await api.submitClaim(claimId!);
        if (!silent) alert("Clearance submitted successfully.");
        resetClearanceForm();
        if (refreshAfterSave) await refresh();
        setPage("MY_REQUESTS");
        return claimId;
      }

      if (refreshAfterSave) await refresh();
      if (!silent) alert("Clearance draft saved.");
      return claimId;
    } catch (e: any) {
      alert("Error saving clearance: " + e.message);
      return null;
    }
  }

  async function uploadClearanceReceipt(file: File) {
    try {
      const hadDraft = Boolean(editingClaimId);
      const claimId = editingClaimId || await persistClearance(false, { silent: true, refreshAfterSave: false });
      if (!claimId) return;
      const form = new FormData();
      form.append("file", file);
      const result: any = await api.uploadClaimReceipt(claimId, form);
      setClearanceReceipts((current) => [...current, result.receipt]);
      await refresh();
      alert(hadDraft ? "Receipt uploaded." : "Draft saved and receipt uploaded.");
    } catch (e: any) {
      alert("Error uploading receipt: " + e.message);
    }
  }

  // helper summaries
  const pendingAdvCount = advances.filter((a) => ["SUBMITTED", "HR_MANAGER_REVIEW", "HR_REVIEW", "HR_OFFICER", "APPROVED"].includes(a.status)).length;
  const pendingClaimCount = claims.filter((c) => !["SETTLED", "REJECTED"].includes(c.status)).length;
  const monthlySpend = claims.reduce((sum, c) => sum + Number(c.claim_total || 0), 0) + advances.reduce((sum, a) => sum + Number(a.approved_total || 0), 0);
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
  const requestSummaryAmount = fmtMoney(totalRequested());
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
                  <strong>{advanceStageLabel(currentStatus, advance.type)}</strong>
                  <em className={`tracking-status-pill ${statusToneClass(currentStatus)}`}>
                    {["PAID", "REJECTED", "CANCELLED"].includes(currentStatus) ? humanizeToken(currentStatus) : "In Progress"}
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
                    <div key={stage.key} className={`tracking-progress-step is-${stage.state}`}>
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
                      <div><dt>Request Type</dt><dd>{requestType}</dd></div>
                      <div><dt>Business Unit</dt><dd>{businessUnit}</dd></div>
                      <div><dt>Department</dt><dd>{department}</dd></div>
                      <div><dt>Amount Requested</dt><dd>{fmtMoney(amount)}</dd></div>
                      <div><dt>Purpose</dt><dd>{advance.purpose || "—"}</dd></div>
                    </dl>
                  </section>

                  <section className="tracking-card">
                    <h3><User size={17} aria-hidden /> Current Owner</h3>
                    <div className="tracking-owner">
                      <strong>{activeStage?.label || "Requester"}</strong>
                      <span>{advanceStageLabel(currentStatus, advance.type)}</span>
                      <button type="button"><Mail size={15} aria-hidden /> Send Reminder</button>
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
              <div className="login-options">
                <label>
                  <input type="checkbox" />
                  <span>Remember me</span>
                </label>
                <a href="#forgot">Forgot password?</a>
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
          {profileEmploymentType !== "PERMANENT" && (
            <p className="subtitle" style={{ marginTop: 8 }}>
              Interns and temporary employees cannot request advances.
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
            <h3>Edit Department</h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <label>Name</label>
              <input value={editingDepartmentObj.name} onChange={(e) => setEditingDepartmentObj({ ...editingDepartmentObj, name: e.target.value })} />

              <label>Section</label>
              <select value={editingDepartmentObj.section_id || ''} onChange={(e) => setEditingDepartmentObj({ ...editingDepartmentObj, section_id: e.target.value || null })}>
                <option value="">(No section)</option>
                {sectionOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>

              <label>HOD</label>
              {leadershipSelect(leadershipUsers.hods.length ? leadershipUsers.hods : leadershipUsers.managers, editingDepartmentObj.hod_user_id || '', 'No HOD', (v: string) => setEditingDepartmentObj({ ...editingDepartmentObj, hod_user_id: v || null }))}

              <label>Manager</label>
              {leadershipSelect(leadershipUsers.managers, editingDepartmentObj.manager_user_id || '', 'No manager', (v: string) => setEditingDepartmentObj({ ...editingDepartmentObj, manager_user_id: v || null }))}

              <label>EXCO Member</label>
              {leadershipSelect(leadershipUsers.exco, editingDepartmentObj.exco_user_id || '', 'No EXCO member', (v: string) => setEditingDepartmentObj({ ...editingDepartmentObj, exco_user_id: v || null }))}

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
            <h3>Edit Section</h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <label>Name</label>
              <input value={editingSectionObj.name} onChange={(e) => setEditingSectionObj({ ...editingSectionObj, name: e.target.value })} />

              <label>EXCO Member</label>
              {leadershipSelect(leadershipUsers.exco, editingSectionObj.exco_user_id || '', 'No EXCO member', (v: string) => setEditingSectionObj({ ...editingSectionObj, exco_user_id: v || null }))}

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
          <div className="sidebar-section-label">Advance Clearance</div>
          <a href="#" className={navItemClass(page === "HOME")} onClick={(e) => { e.preventDefault(); setPage("HOME"); }}><span className="sidebar-nav-icon"><Home size={18} aria-hidden /></span>Dashboard</a>
          <a href="#" className={navItemClass(page === "ADVANCE" || page === "MY_REQUESTS")} onClick={(e) => { e.preventDefault(); setPage("MY_REQUESTS"); }}><span className="sidebar-nav-icon"><ClipboardList size={18} aria-hidden /></span>Advance Requests</a>
          <a href="#" className={navItemClass(page === "CLEARANCE")} onClick={(e) => { e.preventDefault(); setPage("MY_REQUESTS"); }}><span className="sidebar-nav-icon"><CheckCircle2 size={18} aria-hidden /></span>Clearances</a>
          {["INTERN", "TEMPORARY"].includes(String(employmentType || "").toUpperCase()) && <a href="#" className={navItemClass(page === "ATTENDANCE")} onClick={(e) => { e.preventDefault(); setPage("ATTENDANCE"); }}><span className="sidebar-nav-icon"><FileText size={18} aria-hidden /></span>Attendance</a>}
          <a href="#" className={navItemClass(page === "OVERTIME")} onClick={(e) => { e.preventDefault(); setPage("OVERTIME"); }}><span className="sidebar-nav-icon"><Clock3 size={18} aria-hidden /></span>Overtime Request</a>
          <a href="#" className={navItemClass(page === "OVERTIME_CLAIM")} onClick={(e) => { e.preventDefault(); setPage("OVERTIME_CLAIM"); }}><span className="sidebar-nav-icon"><Clock3 size={18} aria-hidden /></span>Overtime Claim</a>
          <a href="#" className={navItemClass(page === "INBOX")} onClick={(e) => { e.preventDefault(); setPage("INBOX"); }}><span className="sidebar-nav-icon"><Mail size={18} aria-hidden /></span>Approval Inbox <b>{inboxCount}</b></a>
          <div className={`sidebar-group ${["REPORTS","SLA_REPORTS","REPORT_ADVANCES","REPORT_APPROVAL","REPORT_WORKFLOW","REPORT_AUDIT"].includes(page) ? "open" : ""}`}>
            <a href="#" className={navItemClass(["REPORTS","SLA_REPORTS","REPORT_ADVANCES","REPORT_APPROVAL","REPORT_WORKFLOW","REPORT_AUDIT"].includes(page))} onClick={(e) => { e.preventDefault(); setPage("REPORTS"); }}><span className="sidebar-nav-icon"><BarChart3 size={18} aria-hidden /></span>Reports <strong><ChevronDown size={14} aria-hidden /></strong></a>
            <div className="sidebar-subnav">
              <a href="#" className={navItemClass(page === "REPORT_ADVANCES")} onClick={(e) => { e.preventDefault(); setPage("REPORT_ADVANCES"); }}><FileText size={14} aria-hidden />Advance Requests</a>
              <a href="#" className={navItemClass(page === "REPORT_APPROVAL")} onClick={(e) => { e.preventDefault(); setPage("REPORT_APPROVAL"); }}><Users size={14} aria-hidden />Approval Performance</a>
              <a href="#" className={navItemClass(page === "SLA_REPORTS")} onClick={(e) => { e.preventDefault(); setPage("SLA_REPORTS"); }}><BarChart3 size={14} aria-hidden />SLA Reports</a>
              <a href="#" className={navItemClass(page === "REPORT_WORKFLOW")} onClick={(e) => { e.preventDefault(); setPage("REPORT_WORKFLOW"); }}><GitBranch size={14} aria-hidden />Workflow Analytics</a>
              <a href="#" className={navItemClass(page === "REPORT_AUDIT")} onClick={(e) => { e.preventDefault(); setPage("REPORT_AUDIT"); }}><ShieldCheck size={14} aria-hidden />Audit Trail</a>
            </div>
          </div>
          <div className="sidebar-section-label">Administration</div>
          {(canAccessFeature("user_management") || canAccessFeature("roles_permissions")) && (
            <div className={`sidebar-group ${["USER_MANAGEMENT", "ROLES_PERMISSIONS"].includes(page) ? "open" : ""}`}>
              <a href="#" className={navItemClass(["USER_MANAGEMENT", "ROLES_PERMISSIONS"].includes(page))} onClick={(e) => { e.preventDefault(); setPage("USER_MANAGEMENT"); }}><span className="sidebar-nav-icon"><Users size={18} aria-hidden /></span>User Management <strong><ChevronDown size={14} aria-hidden /></strong></a>
              <div className="sidebar-subnav">
                {canAccessFeature("user_management") && <a href="#" className={navItemClass(page === "USER_MANAGEMENT")} onClick={(e) => { e.preventDefault(); setPage("USER_MANAGEMENT"); }}><Users size={14} aria-hidden />Users</a>}
                {canAccessFeature("roles_permissions") && <a href="#" className={navItemClass(page === "ROLES_PERMISSIONS")} onClick={(e) => { e.preventDefault(); setPage("ROLES_PERMISSIONS"); }}><ShieldCheck size={14} aria-hidden />Roles & Permissions</a>}
              </div>
            </div>
          )}
          {canManageTravelSettings && (
            <a href="#" className={navItemClass(page === "TRAVEL_SETUP")} onClick={(e) => { e.preventDefault(); setPage("TRAVEL_SETUP"); }}><span className="sidebar-nav-icon"><BriefcaseBusiness size={18} aria-hidden /></span>Travel Setup</a>
          )}
          {canAccessFeature("request_types") && (
            <a href="#" className={navItemClass(page === "REQUEST_TYPES")} onClick={(e) => { e.preventDefault(); setPage("REQUEST_TYPES"); }}><span className="sidebar-nav-icon"><ClipboardList size={18} aria-hidden /></span>Request Types</a>
          )}
          {(canAccessFeature("org_structure") || canAccessFeature("team_roster") || canAccessFeature("ceo_management") || canAccessFeature("employees") || canAccessFeature("exco_members") || canAccessFeature("managers") || canAccessFeature("leadership_assignments") || canAccessFeature("workflow_builder") || canAccessFeature("reporting_lines")) && (
            <div className={`sidebar-group ${orgNavOpen ? "open" : ""}`}>
              <a href="#" className={navItemClass(ORG_PAGES.includes(page as any))} onClick={(e) => { e.preventDefault(); setOrgNavOpen((v) => !v); }}><span className="sidebar-nav-icon"><Network size={18} aria-hidden /></span>Organizational Structure <strong>{orgNavOpen ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}</strong></a>
              <div className="sidebar-subnav">
                {canAccessFeature("org_structure") && <a href="#" className={navItemClass(page === "ORG_STRUCTURE")} onClick={(e) => { e.preventDefault(); setPage("ORG_STRUCTURE"); }}><Network size={14} aria-hidden />Org Structure</a>}
                {canAccessFeature("team_roster") && <a href="#" className={navItemClass(page === "TEAM_ROSTER")} onClick={(e) => { e.preventDefault(); setPage("TEAM_ROSTER"); }}><Users size={14} aria-hidden />Team Roster</a>}
                {canAccessFeature("ceo_management") && <a href="#" className={navItemClass(page === "CEO_MANAGEMENT")} onClick={(e) => { e.preventDefault(); setPage("CEO_MANAGEMENT"); }}><ShieldCheck size={14} aria-hidden />CEO</a>}
                {canAccessFeature("employees") && <a href="#" className={navItemClass(page === "EMPLOYEES")} onClick={(e) => { e.preventDefault(); setPage("EMPLOYEES"); }}><Users size={14} aria-hidden />Employees</a>}
                {canAccessFeature("exco_members") && <a href="#" className={navItemClass(page === "EXCO")} onClick={(e) => { e.preventDefault(); setPage("EXCO"); }}><ShieldCheck size={14} aria-hidden />EXCO Members</a>}
                {canAccessFeature("managers") && <a href="#" className={navItemClass(page === "MANAGERS")} onClick={(e) => { e.preventDefault(); setPage("MANAGERS"); }}><UserRoundCheck size={14} aria-hidden />Managers</a>}
                {canAccessFeature("leadership_assignments") && <a href="#" className={navItemClass(page === "LEADERSHIP")} onClick={(e) => { e.preventDefault(); setPage("LEADERSHIP"); }}><Users size={14} aria-hidden />Leadership Assignments</a>}
                {canAccessFeature("workflow_builder") && <a href="#" className={navItemClass(page === "WORKFLOW_BUILDER")} onClick={(e) => { e.preventDefault(); setPage("WORKFLOW_BUILDER"); }}><ShieldCheck size={14} aria-hidden />Approval Workflow Builder</a>}
                {canAccessFeature("reporting_lines") && <a href="#" className={navItemClass(page === "REPORTING_LINES")} onClick={(e) => { e.preventDefault(); setPage("REPORTING_LINES"); }}><GitBranch size={14} aria-hidden />Reporting Lines</a>}
              </div>
            </div>
          )}
          <a href="#" className={navItemClass(page === "SETTINGS")} onClick={(e) => { e.preventDefault(); setPage("SETTINGS"); }}><span className="sidebar-nav-icon"><SettingsIcon size={18} aria-hidden /></span>Settings</a>
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
            <Inbox onBack={() => setPage("HOME")} />
          ) : page === "ATTENDANCE" ? (
            <AttendanceModule profile={profile} requestDirectory={requestDirectory} onBack={() => setPage("HOME")} />
          ) : page === "OVERTIME" ? (
            <OvertimeModule profile={profile} requestDirectory={requestDirectory} onBack={() => setPage("HOME")} />
          ) : page === "OVERTIME_CLAIM" ? (
            <OvertimeClaimModule profile={profile} requestDirectory={requestDirectory} onBack={() => setPage("HOME")} />
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
          ) : page === "ORG_STRUCTURE" ? (
            <OrgStructure />
          ) : page === "TEAM_ROSTER" ? (
            <TeamRoster />
          ) : page === "REQUEST_TYPES" ? (
            <RequestTypes onNavigate={(p) => setPage(p as any)} />
          ) : page === "USER_MANAGEMENT" ? (
            <div className="ep-page">
              <div className="ep-breadcrumb"><span>Administration</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span>User Management</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span className="ep-breadcrumb-active">Users</span></div>
              <UserManagement />
            </div>
          ) : page === "ROLES_PERMISSIONS" ? (
            <div className="ep-page">
              <div className="ep-breadcrumb"><span>Administration</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span>User Management</span><ChevronDown size={13} style={{transform:"rotate(-90deg)"}} /><span className="ep-breadcrumb-active">Roles & Permissions</span></div>
              <div className="ep-header">
                <div className="ep-header-text">
                  <h1 className="ep-title">Roles & Permissions</h1>
                  <p className="ep-subtitle">Manage manager delegations and feature access permissions.</p>
                </div>
                <div className="ep-actions">
                  <button className="ep-btn-outline" onClick={() => void loadAdminUsers()} disabled={adminUsersLoading}>{adminUsersLoading ? "Loading…" : "Refresh"}</button>
                </div>
              </div>

              <SettingsAccordion
                title="Manager Delegations"
                subtitle="Create a delegation assignment and track active delegations."
                open={delegationsOpen}
                onToggle={() => setDelegationsOpen((current) => !current)}
              >
                {/* Create Delegation form */}
                <div className="ep-panel" style={{ marginBottom: 16 }}>
                  <div className="ep-panel-head">
                    <div>
                      <div className="ep-panel-title">Create Delegation</div>
                      <div className="ep-panel-sub">Temporarily assign a manager's approval authority to a delegate.</div>
                    </div>
                    <button className="ep-btn-outline" onClick={() => void loadDelegations()} disabled={delegationsLoading}>
                      {delegationsLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>
                  <div className="ep-panel-body">
                    <div className="ep-form-row" style={{ marginBottom: 0 }}>
                      {role === "ADMIN" ? (
                        <>
                          <div className="ep-form-group">
                            <label>Manager <span className="ep-required">*</span></label>
                            <select className="ep-form-select" value={delegationManagerId} onChange={(e) => setDelegationManagerId(e.target.value)}>
                              <option value="">Select manager</option>
                              {adminUsers.filter((user) => user.role === "MANAGER").map((user) => (
                                <option key={user.id} value={user.id}>{user.full_name || user.email}</option>
                              ))}
                            </select>
                          </div>
                          <div className="ep-form-group">
                            <label>Delegate <span className="ep-required">*</span></label>
                            <select className="ep-form-select" value={delegationDelegateId} onChange={(e) => setDelegationDelegateId(e.target.value)} disabled={!delegationManagerId}>
                              <option value="">Select delegate</option>
                              {adminUsers
                                .filter((user) => user.department === adminUsers.find((u) => u.id === delegationManagerId)?.department)
                                .filter((user) => user.id !== delegationManagerId)
                                .map((user) => (
                                  <option key={user.id} value={user.id}>{user.full_name || user.email}</option>
                                ))}
                            </select>
                          </div>
                        </>
                      ) : (
                        <div className="ep-form-group" style={{ gridColumn: "1 / -1" }}>
                          <label>Delegate <span className="ep-required">*</span></label>
                          <select className="ep-form-select" value={delegationDelegateId} onChange={(e) => setDelegationDelegateId(e.target.value)}>
                            <option value="">Select delegate</option>
                            {adminUsers
                              .filter((user) => user.department === adminUsers.find((u) => u.id === (profile?.id || me?.userId))?.department)
                              .filter((user) => user.id !== (profile?.id || me?.userId))
                              .map((user) => (
                                <option key={user.id} value={user.id}>{user.full_name || user.email}</option>
                              ))}
                          </select>
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
                    </div>
                    <button className="ep-btn" style={{ marginTop: 8 }} onClick={() => void createDelegation()}>Create Delegation</button>
                  </div>
                </div>

                {/* Delegations table */}
                {delegationsLoading ? (
                  <div style={{ padding: "16px 0", color: "var(--muted)", fontSize: 13 }}>Loading…</div>
                ) : delegations.length === 0 ? (
                  <div style={{ padding: "16px 0", color: "var(--muted)", fontSize: 13 }}>No delegations found.</div>
                ) : (
                  <div className="ep-table-wrap">
                    <table className="ep-table">
                      <thead>
                        <tr><th>Manager</th><th>Delegate</th><th>Department</th><th>From</th><th>To</th><th>Status</th><th></th></tr>
                      </thead>
                      <tbody>
                        {delegations.map((delegation) => (
                          <tr key={delegation.id}>
                            <td style={{ fontWeight: 600 }}>{delegation.manager_name || "—"}</td>
                            <td>{delegation.delegate_name || "—"}</td>
                            <td style={{ color: "var(--muted)", fontSize: "0.85rem" }}>{delegation.department || "—"}</td>
                            <td style={{ fontSize: "0.85rem" }}>{delegation.from_date || "—"}</td>
                            <td style={{ fontSize: "0.85rem" }}>{delegation.to_date || "—"}</td>
                            <td>
                              <span className={`status-pill ${delegation.active ? "status-pill-success" : "status-pill-danger"}`}>
                                {delegation.active ? "Active" : "Ended"}
                              </span>
                            </td>
                            <td>
                              {delegation.active && (
                                <button className="ep-btn-danger" style={{ padding: "5px 10px", fontSize: "0.8rem" }} onClick={() => void endDelegation(delegation.id)}>
                                  End
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SettingsAccordion>

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
                    const GROUPS_LIST = permissionGroups.map((g) => ({ key: g.name, label: g.name, dynamic: !!g.dynamic }));
                    const FEATURES_LIST = [
                      { key: "user_management",        label: "Users",                    group: "User Management" },
                      { key: "roles_permissions",      label: "Roles & Permissions",      group: "User Management" },
                      { key: "travel_setup",           label: "Travel Setup",             group: "Travel" },
                      { key: "org_structure",          label: "Org Structure",            group: "Org Structure" },
                      { key: "team_roster",            label: "Team Roster",              group: "Org Structure" },
                      { key: "ceo_management",         label: "CEO",                      group: "Org Structure" },
                      { key: "employees",              label: "Employees",                group: "Org Structure" },
                      { key: "exco_members",           label: "EXCO Members",             group: "Org Structure" },
                      { key: "managers",               label: "Managers",                 group: "Org Structure" },
                      { key: "leadership_assignments", label: "Leadership Assignments",   group: "Org Structure" },
                      { key: "workflow_builder",       label: "Approval Workflow Builder",group: "Org Structure" },
                      { key: "request_types",          label: "Request Types",            group: "Org Structure" },
                      { key: "reporting_lines",        label: "Reporting Lines",          group: "Org Structure" },
                      { key: "advance_pdf",            label: "Download Advance PDF",     group: "Advances" },
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
                      advance_pdf:            ["ADMIN","MANAGER","HOD","EXCO","FINANCE","CEO","EMPLOYEE"],
                    };
                    function toggleRole(featureKey: string, roleKey: string) {
                      if (roleKey === "ADMIN") return;
                      const current = draft[featureKey] ?? DEFAULTS[featureKey] ?? [];
                      const next = current.includes(roleKey)
                        ? current.filter((r) => r !== roleKey)
                        : [...current, roleKey];
                      setFeaturePermDraft({ ...draft, [featureKey]: next });
                    }
                    async function handleAddGroup() {
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
                    const groups = Array.from(new Set(FEATURES_LIST.map((f) => f.group)));
                    return (
                      <div>
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: "left", padding: "6px 10px", background: "var(--bg-secondary,#f8fafc)", borderBottom: "2px solid var(--border,#e5e7eb)", minWidth: 180 }}>Feature</th>
                                {GROUPS_LIST.map((r) => (
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
                              {groups.map((group) => {
                                const groupFeatures = FEATURES_LIST.filter((f) => f.group === group);
                                return (
                                  <React.Fragment key={group}>
                                    <tr>
                                      <td colSpan={GROUPS_LIST.length + 1} style={{ padding: "8px 10px 4px", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted,#6b7280)", background: "var(--bg-secondary,#f8fafc)", borderTop: "1px solid var(--border,#e5e7eb)" }}>{group}</td>
                                    </tr>
                                    {groupFeatures.map((feat, idx) => {
                                      const allowed = draft[feat.key] ?? DEFAULTS[feat.key] ?? [];
                                      return (
                                        <tr key={feat.key} style={{ background: idx % 2 === 0 ? "transparent" : "var(--bg-secondary,#f8fafc)" }}>
                                          <td style={{ padding: "7px 10px", borderBottom: "1px solid var(--border,#e5e7eb)" }}>{feat.label}</td>
                                          {GROUPS_LIST.map((r) => {
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
                            </tbody>
                          </table>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
                          <input
                            type="text"
                            placeholder="New group name"
                            value={newGroupName}
                            onChange={(e) => setNewGroupName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") void handleAddGroup(); }}
                            style={{ padding: "6px 10px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, fontSize: 13 }}
                          />
                          <button className="ep-btn-outline" type="button" onClick={() => void handleAddGroup()} disabled={groupSaving || !newGroupName.trim()}>
                            {groupSaving ? "Saving…" : "+ Add Group"}
                          </button>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14, gap: 8 }}>
                          <button className="ep-btn-outline" onClick={() => setFeaturePermDraft({ ...featurePermissions })}>Reset</button>
                          <button className="ep-btn" onClick={() => void saveFeaturePermissions()} disabled={featurePermSaving}>{featurePermSaving ? "Saving…" : "Save Changes"}</button>
                        </div>
                      </div>
                    );
                  })()}
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
                  <button className="ep-btn" onClick={() => setShowAddHotelModal(true)}><Plus size={15} />Add Hotel</button>
                </div>
                <div className="ep-table-wrap">
                  {hotelsLoading ? (
                    <div className="ep-loading"><RefreshCw size={18} className="rl-spin" /><p>Loading…</p></div>
                  ) : hotels.length === 0 ? (
                    <div className="ep-empty"><p>No hotels yet. Click <strong>Add Hotel</strong> to add one.</p></div>
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
                      <label className="ep-checkbox-label">
                        <input type="checkbox" checked={newTravelTypeRequiresAccommodation} onChange={(e) => setNewTravelTypeRequiresAccommodation(e.target.checked)} />
                        <span>Requires accommodation booking</span>
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
                      <label className="ep-checkbox-label">
                        <input type="checkbox" checked={editingTravelType.requires_accommodation ?? false} onChange={(e) => setEditingTravelType({ ...editingTravelType, requires_accommodation: e.target.checked })} />
                        <span>Requires accommodation booking</span>
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

              {/* KPI stat cards */}
              <div className="ep-kpi-row">
                <div className="stat-card stat-card-blue">
                  <span className="stat-icon"><FileText size={28} /></span>
                  <div>
                    <div className="stat-value">{advances.length}</div>
                    <div className="stat-label">Total Advances</div>
                  </div>
                </div>
                <div className="stat-card stat-card-green">
                  <span className="stat-icon"><ClipboardList size={28} /></span>
                  <div>
                    <div className="stat-value">{claims.length}</div>
                    <div className="stat-label">Total Clearances</div>
                  </div>
                </div>
                <div className="stat-card stat-card-gold">
                  <span className="stat-icon"><Wallet size={28} /></span>
                  <div>
                    <div className="stat-value" style={{ fontSize: "1.35rem" }}>{fmtMoney(advances.reduce((s, a) => s + Number(a.approved_total || 0), 0))}</div>
                    <div className="stat-label">Approved / Paid Value</div>
                  </div>
                </div>
                <div className="stat-card stat-card-rose">
                  <span className="stat-icon"><Wallet size={28} /></span>
                  <div>
                    <div className="stat-value" style={{ fontSize: "1.35rem" }}>{fmtMoney(claims.reduce((s, c) => s + Number(c.claim_total || 0), 0))}</div>
                    <div className="stat-label">Clearance Spend</div>
                  </div>
                </div>
              </div>

              {/* Report module cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 24 }}>
                {([
                  { icon: <FileText size={26} />, color: "#3b82f6", bg: "#eff6ff", title: "Advance Requests", desc: "Full admin view of all advance requests with filters and export.", action: () => setPage("REPORT_ADVANCES"), live: true },
                  { icon: <Users size={26} />, color: "#059669", bg: "#d1fae5", title: "Approval Performance", desc: "Approval rates, processing times, and department breakdowns.", action: () => setPage("REPORT_APPROVAL"), live: true },
                  { icon: <BarChart3 size={26} />, color: "#8b5cf6", bg: "#ede9fe", title: "SLA Reports", desc: "Track processing times, breach rates, and SLA compliance by department.", action: () => setPage("SLA_REPORTS"), live: true },
                  { icon: <GitBranch size={26} />, color: "#f59e0b", bg: "#fef3c7", title: "Workflow Analytics", desc: "Workflow coverage, step complexity, and usage by request type.", action: () => setPage("REPORT_WORKFLOW"), live: true },
                  { icon: <ShieldCheck size={26} />, color: "#dc2626", bg: "#fee2e2", title: "Audit Trail", desc: "Chronological log of all advance and clearance activity.", action: () => setPage("REPORT_AUDIT"), live: true },
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
                              {advanceStageLabel(status)}
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
                                  {advanceStageLabel(adv.status, adv.type)}
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
            <SlaReports onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_ADVANCES" ? (
            <ReportAdvances advances={advances} travelTypes={travelTypes} onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_APPROVAL" ? (
            <ReportApprovalPerformance advances={advances} onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_WORKFLOW" ? (
            <ReportWorkflowAnalytics advances={advances} onBack={() => setPage("REPORTS")} />
          ) : page === "REPORT_AUDIT" ? (
            <ReportAuditTrail advances={advances} claims={claims} travelTypes={travelTypes} onBack={() => setPage("REPORTS")} />
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
                  <select value={requestForUserId} onChange={(e) => setRequestForUserId(e.target.value)}>
                    {canRequestForSelf && (
                      <option value={profile?.id || me?.userId || ""}>Myself</option>
                    )}
                    {eligibleBeneficiaries.map((user) => (
                      <option key={user.id} value={user.id}>
                        {formatPersonLabel(user)} - {fmtEmploymentType(user.employment_type)}
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: 13, opacity: 0.78 }}>
                    Permanent employees and approvers can create requests on behalf of interns and temporary employees in their department.
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
                <div className="form-field">
                  <label>Receive Via</label>
                  <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as "ECOCASH" | "BANK")}>
                    <option value="ECOCASH">ECOCASH</option>
                    <option value="BANK">BANK</option>
                  </select>
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

              <div className="form-field">
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
              <div className="form-field">
                <label>Advance Type</label>
                <select
                  value={advanceType || ""}
                  onChange={(e) => {
                    setAdvanceType(e.target.value || null);
                    setRows([]);
                  }}
                >
                  <option value="">Select advance type</option>
                  <optgroup label="Travel">
                    {travelTypeOptions.map((type) => (
                      <option key={type.code} value={type.code}>{type.name}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Other advances">
                    <option value="SALARY">Salary</option>
                    <option value="LOAN">Loan</option>
                  </optgroup>
                </select>
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

              {isTravelAdvanceSelected && (
                <div className="form-field">
                  <label>{selectedTravelType?.name || "Travel"} Amount</label>
                  <input type="number" value={travelAmount} readOnly />
                </div>
              )}
              {advanceType === "SALARY" && (
                <div className="form-field">
                  <label>Payback Duration</label>
                  <select value={salaryPaybackDuration} onChange={(e) => setSalaryPaybackDuration(e.target.value)}>
                    <option value="">Select duration</option>
                    <option value="1_MONTH">1 Month</option>
                    <option value="2_MONTHS">2 Months</option>
                    <option value="3_MONTHS">3 Months</option>
                    <option value="6_MONTHS">6 Months</option>
                  </select>
                </div>
              )}
              {advanceType === "LOAN" && (
                <div className="form-field">
                  <label>Payback Duration</label>
                  <select value={loanPaybackDuration} onChange={(e) => setLoanPaybackDuration(e.target.value)}>
                    <option value="">Select duration</option>
                    <option value="1_MONTH">1 Month</option>
                    <option value="2_MONTHS">2 Months</option>
                    <option value="3_MONTHS">3 Months</option>
                    <option value="6_MONTHS">6 Months</option>
                  </select>
                </div>
              )}

              {/* breakdown table for travel */}
              {isTravelAdvanceSelected && selectedTravelType && (
                <>
                  <div className="card" style={{ marginBottom: 12, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <span>{selectedTravelType.name}</span>
                      <b>{fmtMoney(selectedTravelRate, selectedTravelType?.currency)} per {selectedTravelUnitLabel}</b>
                    </div>
                    {(selectedTravelType.rate_exco > 0 || selectedTravelType.rate_ceo > 0) && (
                      <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, opacity: 0.78 }}>
                        <span>General Staff: {fmtMoney(selectedTravelType.rate_general_staff, selectedTravelType.currency)}</span>
                        <span>EXCO: {fmtMoney(selectedTravelType.rate_exco, selectedTravelType.currency)}</span>
                        <span>CEO: {fmtMoney(selectedTravelType.rate_ceo, selectedTravelType.currency)}</span>
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 13, opacity: 0.78 }}>
                      {selectedTravelType.location_mode === "DISTRICT" ? "Use Lesotho districts for local travel." : "Use country, city, and South African province where applicable."}
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
                            <input
                              type="number"
                              min="0"
                              max={selectedTravelType?.rate_kind === "DAILY" ? undefined : 3}
                              step="1"
                              value={String(Number.isFinite(Number(r.meals)) ? r.meals : 0)}
                              onChange={e => updateRow(idx, "meals", e.target.value === "" ? 0 : Number(e.target.value))}
                              style={{ width: 80 }}
                            />
                          </td>
                          <td>{fmtMoney((Number.isFinite(Number(r.meals)) ? Math.max(0, Number(r.meals)) : 0) * selectedTravelRate, selectedTravelType?.currency)}</td>
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
                            <td>{fmtMoney(rowTotals.amount)}</td>
                            <td></td>
                          </tr>
                          <tr>
                            <td>Total</td>
                            <td></td>
                            <td></td>
                            <td>{rowTotals.meals}</td>
                            <td colSpan={2}>{fmtMoney(totalRequested())}</td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>

                  {/* ── Accommodation notice for multi-day local travel ── */}
                  {selectedTravelType?.location_mode === "DISTRICT" && rows.length > 1 && (() => {
                    const destinations = [...new Set(
                      rows.slice(0, -1)   // exclude last return-home row
                        .map((r) => r.destinationDistrict)
                        .filter(Boolean)
                    )];
                    if (!destinations.length) return null;
                    return (
                      <div className="accommodation-notice">
                        <Hotel size={18} className="accommodation-notice-icon" />
                        <div>
                          <strong>Accommodation may be required</strong> — this is a {rows.length}-day local trip.
                          <div style={{ fontSize: "0.82rem", color: "var(--muted)", margin: "3px 0 6px" }}>
                            The requester may need accommodation in the following destination district{destinations.length > 1 ? "s" : ""}. HR will process accommodation during review.
                          </div>
                          <div className="accommodation-notice-districts">
                            {destinations.map((d) => (
                              <span key={d} className="accommodation-notice-district">
                                <Hotel size={11} /> {d}
                              </span>
                            ))}
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

              {advanceWorkflowFound === false && advanceType && (
                <div className="form-section" style={{ marginTop: 24, border: "1px solid #e2c96e", borderRadius: 8, padding: "16px 18px", background: "#fffdf0" }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Custom Approval Chain</div>
                  <div style={{ fontSize: 13, color: "#7a6a00", marginBottom: 18 }}>
                    No workflow is configured for your department/section. Define the approvers for this request.
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    {chainPositionTypes.map((pt) => {
                      const selected = customApprovalChain.find(s => s.label === pt.name);

                      // Counter Signed By: teammates + people in same section/dept + managers/HODs
                      // Approved By: managers, HODs, and other leadership positions only
                      const myId = profile?.id || me?.userId || "";
                      const myTeamId    = profile?.team_id    || null;
                      const mySectionId = profile?.section_id || null;
                      const myDept      = (profile?.department || "").toLowerCase();

                      const isPermanent = (u: { employment_type?: string | null }) =>
                        String(u.employment_type || "").toUpperCase() === "PERMANENT";

                      const pool = pt.code === "COUNTER_SIGNER"
                        ? staffDirectory.filter(u =>
                            u.is_active !== false &&
                            isPermanent(u) &&
                            u.role !== "ADMIN" &&
                            u.id !== myId &&
                            myTeamId !== null &&
                            u.team_id === myTeamId
                          )
                        : pt.code === "APPROVED_BY"
                          ? staffDirectory.filter(u =>
                              u.is_active !== false &&
                              isPermanent(u) &&
                              u.id !== myId &&
                              ["MANAGER", "HOD", "EXCO"].includes(u.role)
                            )
                          : staffDirectory.filter(u =>
                              u.is_active !== false && isPermanent(u) && u.role !== "EMPLOYEE" && u.role !== "ADMIN" && u.id !== myId
                            );
                      const ptSubtitle = pt.code === "COUNTER_SIGNER"
                        ? "Supervisor or Manager to confirm your request details"
                        : pt.code === "APPROVED_BY"
                          ? "GM or Executive of your Department to approve the request"
                          : null;

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
                              const userName = u.full_name || u.email;
                              setCustomApprovalChain(prev => {
                                const without = prev.filter(s => s.label !== pt.name);
                                const insertAt = chainPositionTypes.findIndex(p => p.id === pt.id);
                                const before = without.filter(s => chainPositionTypes.findIndex(p => p.name === s.label) < insertAt);
                                const after  = without.filter(s => chainPositionTypes.findIndex(p => p.name === s.label) >= insertAt);
                                return [...before, { label: pt.name, user_id: uid, user_name: userName }, ...after];
                              });
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
                  setPage(editingAdvanceId ? "MY_REQUESTS" : "HOME");
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
                        setPage("MY_REQUESTS");
                        await refresh();
                      } catch (e: any) { alert("Error: " + e.message); }
                    }}>Revoke</button>
                )}
                <button className="button" disabled={submittingAdvance} onClick={async () => {
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
                        alert("Only permanent employees can create their own advance requests.");
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
                      if (isTravelAdvanceSelected && rows.length < 1) {
                        alert("At least one entry is required in the travel table.");
                        return;
                      }
                      if (isTravelAdvanceSelected && selectedTravelType) {
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
                        base.salary_payback_duration = salaryPaybackDuration;
                        base.payback_duration = salaryPaybackDuration;
                      }
                      if (isTravelAdvanceSelected) {
                        base.requested_total = Number(totalRequested()) || 0;
                      }
                      if (advanceType === "LOAN") {
                        base.requested_total = Number(loanAmount) || 0;
                        base.loan_payback_duration = loanPaybackDuration;
                        base.payback_duration = loanPaybackDuration;
                      }
                      if (editingAdvanceId) {
                        // update existing request
                        await api.updateAdvance(editingAdvanceId, base);
                        if (isTravelAdvanceSelected && selectedTravelType) {
                          const mappedRows = rows.map(r => ({
                            line_date: r.date,
                            location: selectedTravelType.location_mode === "DISTRICT"
                              ? `${r.startDistrict} → ${r.destinationDistrict}`
                              : [r.country, r.province, r.city].filter(Boolean).join(" / "),
                            travel_meta: selectedTravelType.location_mode === "DISTRICT"
                              ? { location_mode: selectedTravelType.location_mode, startDistrict: r.startDistrict, destinationDistrict: r.destinationDistrict }
                              : { location_mode: selectedTravelType.location_mode, country: r.country, province: r.province, city: r.city },
                            meals_count: r.meals,
                            dinner: 0
                          }));
                          await api.updateAdvanceLines(editingAdvanceId, { lines: mappedRows });
                        }
                        const submitResult: any = await api.submitAdvance(editingAdvanceId);
                        alert(submitResult?.warning || "Advance request submitted successfully and moved to next level.");
                        setEditingAdvanceId(null);
                      } else {
                        // create new request, then send any additional details
                        const resp: any = await api.createAdvance(base);
                        const newId = resp.id;
                        if (isTravelAdvanceSelected && selectedTravelType) {
                          const mappedRows = rows.map(r => ({
                            line_date: r.date,
                            location: selectedTravelType.location_mode === "DISTRICT"
                              ? `${r.startDistrict} → ${r.destinationDistrict}`
                              : [r.country, r.province, r.city].filter(Boolean).join(" / "),
                            travel_meta: selectedTravelType.location_mode === "DISTRICT"
                              ? { location_mode: selectedTravelType.location_mode, startDistrict: r.startDistrict, destinationDistrict: r.destinationDistrict }
                              : { location_mode: selectedTravelType.location_mode, country: r.country, province: r.province, city: r.city },
                            meals_count: r.meals,
                            dinner: 0
                          }));
                          await api.updateAdvanceLines(newId, { lines: mappedRows });
                        }
                        const submitResult: any = await api.submitAdvance(newId);
                        alert(submitResult?.warning || "Advance request submitted successfully and moved to next level.");
                      }
                      await refresh();
                      setPage("HOME");
                      setEditingAdvanceStatus(null);
                    } catch (e: any) {
                      alert("Error: " + e.message);
                    } finally {
                      setSubmittingAdvance(false);
                    }
                  }}>{submittingAdvance ? "Submitting…" : (editingAdvanceId ? "Update & Submit" : "Submit")}</button>
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
                      <dd>{requestForUserId === (profile?.id || me?.userId || "") ? "Myself" : requesterName || "Myself"}</dd>
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
                  <div className="summary-note">
                    Permanent employees and approvers can create requests on behalf of interns and temporary employees in their department.
                  </div>
                </aside>
              </div>
            </div>
            )
          ) : page === "CLEARANCE" ? (
            <div className="advance-form modern-form">
              <h2 className="form-title">{editingClaimId ? "Edit Clearance" : "Travel Advance Clearance Form"}</h2>

              <div className="form-grid-2">
                <div className="form-field">
                  <label>Paid Advance</label>
                  <select value={clearanceLinkedAdvanceId} onChange={(e) => setClearanceLinkedAdvanceId(e.target.value)}>
                    <option value="">Select paid travel advance</option>
                    {clearableTravelAdvances.map((advance) => (
                      <option key={advance.id} value={advance.id}>
                        {travelTypeLabel(advance.type, travelTypes)} - {fmtMoney(advance.approved_total || advance.requested_total)} - {new Date(advance.created_at).toLocaleDateString()}
                      </option>
                    ))}
                  </select>
                  {clearableTravelAdvances.length === 0 && (
                    <div style={{ marginTop: 6, fontSize: 13, color: "crimson" }}>
                      No paid travel advances are available to clear yet.
                    </div>
                  )}
                </div>
                <div className="form-field">
                  <label>Month</label>
                  <input type="month" value={clearanceMonth} onChange={(e) => setClearanceMonth(e.target.value)} />
                </div>
              </div>

              <div className="form-grid-3">
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

              <div className="form-grid-3">
                <div className="form-field">
                  <label>Vehicle Type</label>
                  <input type="text" value={clearanceVehicleType} onChange={(e) => setClearanceVehicleType(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Engine CC</label>
                  <input type="text" value={clearanceEngineCc} onChange={(e) => setClearanceEngineCc(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Vehicle Rate</label>
                  <input type="number" value={clearanceVehicleRate} onChange={(e) => setClearanceVehicleRate(e.target.value)} />
                </div>
              </div>

              <div className="card" style={{ marginTop: 16, padding: 16 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Advance Received</div>
                    <div>{fmtMoney(clearanceAdvanceAmount)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Actual Expenditure</div>
                    <div>{fmtMoney(clearanceTotals.total)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Difference</div>
                    <div>{fmtMoney(Math.abs(clearanceBalance))}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Outcome</div>
                    <div>
                      {clearanceBalance > 0
                        ? "Employee refunds company"
                        : clearanceBalance < 0
                          ? "Company pays employee"
                          : "Fully cleared"}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 20, overflowX: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Location</th>
                      <th>Meals</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clearanceSourceLines.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: "center" }}>Select a paid travel advance to load its trip lines.</td>
                      </tr>
                    ) : (
                      clearanceSourceLines.map((line, index) => (
                        <tr key={line.id || index}>
                          <td>{normalizeDateInputValue(line.line_date)}</td>
                          <td>{line.location || "—"}</td>
                          <td>{advanceLineMealCount(line)}</td>
                          <td>{fmtMoney(advanceLineAmount(line))}</td>
                        </tr>
                      ))
                    )}
                    <tr>
                      <td><b>Totals</b></td>
                      <td>—</td>
                      <td>{Number(clearanceTotals.mealCount.toFixed(2))}</td>
                      <td>{fmtMoney(clearanceTotals.total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="card" style={{ marginTop: 16, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <b>Receipts</b>
                    <div style={{ marginTop: 4, fontSize: 13, opacity: 0.75 }}>
                      Upload receipts immediately. If the draft does not exist yet, it will be saved first automatically.
                    </div>
                  </div>
                  <label className="button" style={{ cursor: "pointer", opacity: 1 }}>
                    Upload Receipt
                    <input
                      type="file"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadClearanceReceipt(file);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
                <div style={{ marginTop: 12 }}>
                  {clearanceReceipts.length === 0 ? (
                    <div style={{ opacity: 0.7 }}>No receipts uploaded yet.</div>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>File</th>
                          <th>Uploaded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clearanceReceipts.map((receipt) => (
                          <tr key={receipt.id}>
                            <td>{String(receipt.file_path || "").split("/").pop() || receipt.file_path}</td>
                            <td>{receipt.uploaded_at ? new Date(receipt.uploaded_at).toLocaleString() : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              <div className="card" style={{ marginTop: 16, padding: 16 }}>
                <div><b>Clearance Process</b></div>
                <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                  <div>1. Employee captures actual trip expenditure and links the paid advance.</div>
                  <div>2. Manager certifies the trip was duly ordered.</div>
                  <div>3. The configured approval workflow routes the clearance through each approver in turn.</div>
                  <div>4. Finance verifies and settles any amount due or refund reference.</div>
                </div>
              </div>

              <div className="footer-buttons">
                <button className="button" onClick={() => {
                  resetClearanceForm();
                  setPage("MY_REQUESTS");
                }}>
                  Cancel
                </button>
                <button className="button" type="button" onClick={() => persistClearance(false)}>
                  Save Draft
                </button>
                <button className="button" type="button" onClick={() => persistClearance(true)} disabled={clearableTravelAdvances.length === 0}>
                  Submit Clearance
                </button>
              </div>
            </div>
          ) : page === "MY_REQUESTS" ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <h2>My Requests</h2>
                <button className="button small-button" onClick={startNewAdvanceRequest}>New Request</button>
              </div>
              
              <h3>Advance Requests ({advances.length})</h3>
              <div style={{ overflowX: "auto", marginBottom: 24 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Current Stage</th>
                      <th>Date</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {advances.length === 0 ? (
                      <tr><td colSpan={6} style={{ textAlign: 'center' }}>No advance requests yet</td></tr>
                    ) : (
                      advances.map(a => (
                        <tr key={a.id}>
                          <td>{travelTypeLabel(a.type, travelTypes)}</td>
                          <td>{fmtMoney(a.approved_total || a.requested_total || 0)}</td>
                          <td>{a.status}</td>
                          <td>{advanceStageLabel(a.status, a.type)}</td>
                          <td>{new Date(a.created_at).toLocaleDateString()}</td>
                          <td>
                            {(a.status === "DRAFT" || a.status === "SUBMITTED") && (
                              <button
                                className="ep-icon-btn"
                                title="Edit"
                                onClick={async () => {
                                  try {
                                    const detail: any = await api.advanceDetail(a.id);
                                    populateAdvanceForm(detail, a);
                                    setPage("ADVANCE");
                                  } catch (e: any) {
                                    alert("Error loading advance: " + e.message);
                                  }
                                }}
                              >
                                <Edit3 size={15} aria-hidden />
                              </button>
                            )}
                            <button
                              className="ep-icon-btn"
                              title="Track"
                              onClick={() => showAdvanceHistory(a.id)}
                            >
                              <RefreshCw size={14} aria-hidden />
                            </button>
                            {a.status === "PAID" && isTravelTypeCode(a.type, travelTypes) && (
                              <button
                                className="button small-button"
                                onClick={() => startClearanceForAdvance(a.id)}
                                style={{ marginLeft: 4 }}
                              >
                                Clear
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <h3>Clearances ({claims.length})</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Stage</th>
                      <th>Date</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claims.length === 0 ? (
                      <tr><td colSpan={6} style={{ textAlign: 'center' }}>No clearances yet</td></tr>
                    ) : (
                      claims.map(c => (
                        <tr key={c.id}>
                          <td>{c.month || "—"}</td>
                          <td>{fmtMoney(c.claim_total || 0)}</td>
                          <td>{c.status}</td>
                          <td>{clearanceStageLabel(c)}</td>
                          <td>{new Date(c.created_at).toLocaleDateString()}</td>
                          <td>
                            {c.status === "DRAFT" ? (
                              <button className="button small-button" onClick={() => editClearance(c.id)}>
                                Edit
                              </button>
                            ) : (
                              <span style={{ opacity: 0.7 }}>Submitted</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
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
                  <div>Department: {profile?.department || "—"}</div>
                  <div>Employment Type: {fmtEmploymentType(employmentType)}</div>
                  <div>Employment Number: {profile?.employee_no || "—"}</div>
                  <div>Role: {displayRoleLabel(role)}</div>
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
                  <h2 className="dashboard-title">Advance Management Dashboard</h2>
                  <p className="dashboard-subtitle">
                    Track upcoming approvals, active requests, and clearance work without leaving the register.
                  </p>
                </div>
                <div className="dashboard-search-card">
                  <div className="dashboard-search-title">Quick Search</div>
                  <input
                    className="dashboard-search-input"
                    type="text"
                    value=""
                    readOnly
                    placeholder="Search by employee, type, or status"
                  />
                  <div className="dashboard-sync-chip">
                    <span>Last sync</span>
                    <strong>{new Date().toLocaleString()}</strong>
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
                  <div><div className="stat-value">{fmtMoney(monthlySpend)}</div><div className="stat-label">Monthly Spend</div></div>
                </div>
              </div>

              <div className="card-container">
                <div className="card dashboard-card" style={{ cursor: "pointer" }} onClick={() => setPage("MY_REQUESTS")}>
                  <div className="title">My Total Requests</div>
                  <div className="value">{advances.length + claims.length}</div>
                </div>
                <div className="card dashboard-card">
                  <div className="title">Profile Snapshot</div>
                  <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                    <div><strong>Name:</strong> {profile?.full_name || me?.fullName || "—"}</div>
                    <div><strong>Employee No:</strong> {profile?.employee_no || me?.employeeNo || "—"}</div>
                    <div><strong>Department:</strong> {profile?.department || me?.department || "—"}</div>
                  </div>
                </div>
              </div>

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

              <div className="dashboard-actions">
                <button className="button" disabled={!canOpenAdvanceForm} onClick={startNewAdvanceRequest}>
                  New Advance Request
                </button>
                <button className="button" disabled={!canRequestForSelf} onClick={startNewClearance}>
                  New Clearance
                </button>
              </div>

              {/* My advances table */}
              <h3 style={{ marginTop: 24 }}>My Advances</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Current Stage</th>
                      <th>Requested</th>
                      <th>Approved</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {advances.map((a) => (
                      <tr key={a.id}>
                        <td>{travelTypeLabel(a.type, travelTypes)}</td>
                        <td>{a.status}</td>
                        <td>{advanceStageLabel(a.status, a.type)}</td>
                        <td>{fmtMoney(a.requested_total)}</td>
                        <td>{fmtMoney(a.approved_total)}</td>
                        <td style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          {(a.status === "DRAFT" || a.status === "SUBMITTED") && (
                            <button
                              className="ep-icon-btn"
                              title="Edit"
                              onClick={async () => {
                                try {
                                  const detail: any = await api.advanceDetail(a.id);
                                  populateAdvanceForm(detail, a);
                                  setPage("ADVANCE");
                                } catch (e: any) {
                                  alert("Error loading advance: " + e.message);
                                }
                              }}
                            >
                              <Edit3 size={15} aria-hidden />
                            </button>
                          )}
                          <button
                            className="ep-icon-btn"
                            title="Track"
                            onClick={() => showAdvanceHistory(a.id)}
                          >
                            <RefreshCw size={14} aria-hidden />
                          </button>
                          {a.status === "PAID" && isTravelTypeCode(a.type, travelTypes) && (
                            <button
                              className="button small-button"
                              onClick={() => startClearanceForAdvance(a.id)}
                              style={{ marginLeft: 4 }}
                            >
                              Clear
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* My claims table */}
              <h3 style={{ marginTop: 24 }}>My Clearances</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Status</th>
                      <th>Stage</th>
                      <th>Total</th>
                      <th>Advance</th>
                      <th>Balance</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claims.map((c) => (
                      <tr key={c.id}>
                        <td>{c.month}</td>
                        <td>{c.status}</td>
                        <td>{clearanceStageLabel(c)}</td>
                        <td>{fmtMoney(c.claim_total)}</td>
                        <td>{fmtMoney(c.advance_amount)}</td>
                        <td>{fmtMoney(c.balance_amount)}</td>
                        <td>
                          {c.status === "DRAFT" ? (
                            <button className="button small-button" onClick={() => editClearance(c.id)}>
                              Edit
                            </button>
                          ) : (
                            <span style={{ opacity: 0.7 }}>Submitted</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {historyOpen && renderAdvanceTrackingModal()}
          </div>
        </div>
      </div>
    </div>
  );
}
