import React, { useEffect, useState } from "react";
import { api, clearToken, getTheme, getToken, setTheme as saveTheme, setToken, getUserFromToken } from "./api";
import AttendanceModule from "./AttendanceModule";
import Inbox from "./Inbox";
import OvertimeModule from "./OvertimeModule";
import { LESOTHO_DISTRICTS } from "./constants";
import econetLogo from "./assets/econetLogo.webp";

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

export default function App() {
  const [token, setTok] = useState(getToken());
  const [email, setEmail] = useState("employee@example.com");
  const [password, setPassword] = useState("pass123");
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileFirstName, setProfileFirstName] = useState("");
  const [profileLastName, setProfileLastName] = useState("");
  const [profileDepartment, setProfileDepartment] = useState("");
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);
  const [profileEmploymentType, setProfileEmploymentType] = useState<"PERMANENT" | "INTERN" | "TEMPORARY">("PERMANENT");
  const [profileEmployeeNo, setProfileEmployeeNo] = useState("");
  const [requestDirectory, setRequestDirectory] = useState<RequestDirectoryUser[]>([]);
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminUsersLoading, setAdminUsersLoading] = useState(false);
  const [hotels, setHotels] = useState<any[]>([]);
  const [hotelsLoading, setHotelsLoading] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [newHotelDistrict, setNewHotelDistrict] = useState("");
  const [newHotelAddress, setNewHotelAddress] = useState("");
  const [newHotelContact, setNewHotelContact] = useState("");
  const [newHotelDepartment, setNewHotelDepartment] = useState("");
  const [mealValue, setMealValue] = useState(0);
  const [mealValueDraft, setMealValueDraft] = useState("0");
  const [mealValueLoading, setMealValueLoading] = useState(false);
  const [departmentRoleDepartment, setDepartmentRoleDepartment] = useState("");
  const [departmentRoleUserId, setDepartmentRoleUserId] = useState("");
  const [departmentRoleValue, setDepartmentRoleValue] = useState("EMPLOYEE");
  const [groupAssignUserId, setGroupAssignUserId] = useState("");
  const [groupAssignDepartment, setGroupAssignDepartment] = useState("");
  const [newDepartmentName, setNewDepartmentName] = useState("");
  const [newDepartmentSectionId, setNewDepartmentSectionId] = useState("");
  const [departmentRows, setDepartmentRows] = useState<any[]>([]);
  const [sectionOptions, setSectionOptions] = useState<{ id: string; name: string }[]>([]);
  const [newSectionName, setNewSectionName] = useState("");
  const [profileAccordionOpen, setProfileAccordionOpen] = useState(true);
  const [travelSettingsOpen, setTravelSettingsOpen] = useState(true);
  const [sectionManagementOpen, setSectionManagementOpen] = useState(true);
  const [groupAssignmentOpen, setGroupAssignmentOpen] = useState(false);
  const [delegationsOpen, setDelegationsOpen] = useState(false);
  const [adminUsersOpen, setAdminUsersOpen] = useState(false);
  const [delegations, setDelegations] = useState<any[]>([]);
  const [delegationsLoading, setDelegationsLoading] = useState(false);
  const [delegationManagerId, setDelegationManagerId] = useState("");
  const [delegationDelegateId, setDelegationDelegateId] = useState("");
  const [delegationFromDate, setDelegationFromDate] = useState("");
  const [delegationToDate, setDelegationToDate] = useState("");
  const [advances, setAdvances] = useState<any[]>([]);
  const [claims, setClaims] = useState<any[]>([]);
  const [inboxCount, setInboxCount] = useState(0);
  const [page, setPage] = useState<"HOME" | "INBOX" | "ADVANCE" | "CLEARANCE" | "MY_REQUESTS" | "REPORTS" | "SETTINGS" | "ATTENDANCE" | "OVERTIME">("HOME");
  const [theme, setTheme] = useState<"light" | "dark">((getTheme() as "light" | "dark") || "light");
  const [editingAdvanceId, setEditingAdvanceId] = useState<string | null>(null);
  const [editingAdvanceStatus, setEditingAdvanceStatus] = useState<string | null>(null);
  const [editingClaimId, setEditingClaimId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyAdvanceId, setHistoryAdvanceId] = useState<string | null>(null);
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

  function fmtMoney(value: any) {
    return `M${Number(value || 0).toFixed(2)}`;
  }

  function displayRoleLabel(value: string | null | undefined) {
    switch (value) {
      case "ADMIN":
        return "Administrator";
      case "AUTH_OFFICER":
        return "HR";
      case "HR_MANAGER":
        return "HR Manager";
      case "CHIEF_OFFICER":
        return "Chief Officer";
      default:
        return value || "Unknown";
    }
  }

  function displayUserLabel(value: string | null | undefined, roleValue: string | null | undefined) {
    if (roleValue === "AUTH_OFFICER") return "HR";
    if (roleValue === "HR_MANAGER") return "HR Manager";
    if (!value) return "User";
    if (value === "Authorising Officer") return "HR";
    return value;
  }

  function fmtEmploymentType(value: string | null | undefined) {
    switch (value) {
      case "PERMANENT":
        return "Permanent";
      case "INTERN":
        return "Intern";
      case "TEMPORARY":
        return "Temporary";
      default:
        return value || "Unknown";
    }
  }

  function isApproverRole(value: string | null | undefined) {
    return ["MANAGER", "HR_MANAGER", "AUTH_OFFICER", "CHIEF_OFFICER", "FINANCE", "ADMIN"].includes(String(value || "").trim().toUpperCase());
  }

  function formatPersonLabel(user: { full_name: string | null; email?: string; employee_no?: string | null }) {
    const base = user.full_name || user.email || "Unknown user";
    return user.employee_no ? `${base} (${user.employee_no})` : base;
  }

  function isKnownDepartment(value: string) {
    const department = value.trim().toLowerCase();
    return Boolean(department) && departmentOptions.some((option) => option.trim().toLowerCase() === department);
  }

  // advance request form fields
  const [requesterName, setRequesterName] = useState("");
  const [empNumber, setEmpNumber] = useState("");
  const [requestForUserId, setRequestForUserId] = useState("");
  const [supportCreatorUserId, setSupportCreatorUserId] = useState("");
  const [advanceType, setAdvanceType] = useState<"TRAVEL_SUBSISTENCE" | "SALARY" | "LOAN" | null>(null);
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
  const [rows, setRows] = useState<Array<{ date: string; startDistrict: string; destinationDistrict: string; meals: number }>>([]);
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

  function syncTravelRowStartDistricts(nextRows: Array<{ date: string; startDistrict: string; destinationDistrict: string; meals: number }>) {
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
    setRows(syncTravelRowStartDistricts([...rows, { date: newDate, startDistrict, destinationDistrict: "", meals: 0 }]));
  };
  const deleteRow = (index: number) => {
    setRows(syncTravelRowStartDistricts(rows.filter((_, i) => i !== index)));
  };
  const updateRow = (index: number, field: string, value: any) => {
    const copy = [...rows];
    (copy[index] as any)[field] = field === "meals" ? (Number(value) || 0) : value;
    setRows(syncTravelRowStartDistricts(copy));
  };
  const mealValueNumber = Number.isFinite(Number(mealValue)) ? Number(mealValue) : 0;
  const rowTotals = rows.reduce(
    (acc, r) => {
      const meals = Number.isFinite(Number(r.meals)) ? Math.max(0, Number(r.meals)) : 0;
      return {
        meals: acc.meals + meals,
        amount: acc.amount + meals * mealValueNumber
      };
    },
    { meals: 0, amount: 0 }
  );
  const totalRequested = () => {
    if (advanceType === "TRAVEL_SUBSISTENCE") return rowTotals.amount;
    if (advanceType === "SALARY") return Number(salaryAmount) || 0;
    if (advanceType === "LOAN") return Number(loanAmount) || 0;
    return 0;
  };
  const clearableTravelAdvances = advances.filter(
    (a) => a.type === "TRAVEL_SUBSISTENCE" && a.status === "PAID"
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
    return mealValueNumber > 0 ? Number((amount / mealValueNumber).toFixed(2)) : amount;
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
  }, [advanceType, salaryAmount, loanAmount, travelAmount, rows, mealValue]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (advanceType === "TRAVEL_SUBSISTENCE") {
      const total = rowTotals.amount;
      setTravelAmount(total.toFixed(2));
    }
  }, [rows, advanceType, mealValue]);

  const me = getUserFromToken();

  useEffect(() => {
    if (!token) return;
    if (!me) {
      void doLogout();
    }
  }, [token]);

  const role = profile?.role || me?.role || "UNKNOWN";
  const userName = displayUserLabel(profile?.full_name || me?.fullName || me?.username || "User", role);
  const userDepartment = profile?.department || me?.department || "No Department";
  const canManageTravelSettings = ["HR_MANAGER", "AUTH_OFFICER", "ADMIN"].includes(role);
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

  async function refresh() {
    setError(null);
    const meResp = await withStartupTimeout(api.me(), "Profile");
    setProfile(meResp);

    const [departmentsResp, directoryResp, a, c, i, mealResp] = await Promise.all([
      optionalStartupData<string[]>(api.departments(), [], "Departments"),
      optionalStartupData<RequestDirectoryUser[]>(api.requestDirectory(), [], "Request directory"),
      optionalStartupData<any[]>(api.advances(), [], "Advances"),
      optionalStartupData<any[]>(api.claims(), [], "Claims"),
      optionalStartupData<{ items?: any[] }>(api.inbox(), { items: [] }, "Inbox"),
      optionalStartupData<{ meal_value?: number }>(api.mealValue(), { meal_value: 0 }, "Meal value")
    ]);
    setDepartmentOptions(Array.isArray(departmentsResp) ? departmentsResp : []);
    setRequestDirectory(Array.isArray(directoryResp) ? directoryResp : []);
    setAdvances(Array.isArray(a) ? a : []);
    setClaims(Array.isArray(c) ? c : []);
    setInboxCount(i.items?.length || 0);
    const configuredMealValue = Number(mealResp.meal_value || 0);
    setMealValue(configuredMealValue);
    setMealValueDraft(String(configuredMealValue));
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
    setProfileEmploymentType((profile?.employment_type || "PERMANENT") as "PERMANENT" | "INTERN" | "TEMPORARY");
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
    if (token && (page === "SETTINGS" || page === "REPORTS")) {
      if (role === "ADMIN" || role === "MANAGER") {
        void loadAdminUsers();
        void loadDelegations();
      }
      void loadHotels();
      void loadMealValue();
    }
  }, [token, page, role]);

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

  async function createHotel() {
    if (!newHotelName.trim()) return alert("Enter hotel name");
    if (!newHotelDistrict) return alert("Select the district for this hotel");
    try {
      await api.createHotel({ name: newHotelName.trim(), district: newHotelDistrict, address: newHotelAddress.trim() || undefined, contact: newHotelContact.trim() || undefined, department: newHotelDepartment || undefined });
      setNewHotelName("");
      setNewHotelDistrict("");
      setNewHotelAddress("");
      setNewHotelContact("");
      setNewHotelDepartment("");
      void loadHotels();
      alert("Hotel added");
    } catch (e: any) {
      alert("Error creating hotel: " + e.message);
    }
  }

  async function doLogin() {
    setError(null);
    try {
      const r = await api.login(email, password);
      setToken(r.token);
      setTok(r.token);
      setProfile(r.user || null);
      setPage("HOME");
    } catch (e: any) {
      alert("Login failed: " + e.message);
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
    if (!isKnownDepartment(profileDepartment)) {
      alert("Choose your department from the department groups list.");
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
        department: profileDepartment.trim(),
        employment_type: profileEmploymentType,
        employee_no: profileEmployeeNo.trim() || undefined
      });
      setToken(result.token);
      setTok(result.token);
      setProfile(result.user);
      setDepartmentOptions((current) =>
        profileDepartment && !current.includes(profileDepartment)
          ? [...current, profileDepartment].sort((a, b) => a.localeCompare(b))
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
      const [users, sections, departments] = await Promise.all([
        api.adminUsers(),
        api.sections(),
        api.departmentsWithSections()
      ]);
      setAdminUsers(Array.isArray(users) ? users : []);
      setSectionOptions(Array.isArray(sections) ? sections : []);
      setDepartmentRows(Array.isArray(departments) ? departments : []);
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

  async function updateUserDepartment(userId: string, department: string) {
    try {
      const updated: any = await api.updateUserDepartment(userId, { department });
      setAdminUsers((current) => current.map((user) => (user.id === userId ? updated : user)));
      if (profile?.id === userId) {
        setProfile(updated);
      }
    } catch (e: any) {
      alert("Error updating department: " + e.message);
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

      const created: any = await api.createDelegation(payload);
      setDelegations((current) => [created, ...current]);
      setDelegationManagerId("");
      setDelegationDelegateId("");
      setDelegationFromDate("");
      setDelegationToDate("");
      alert("Delegation created.");
    } catch (e: any) {
      alert("Error creating delegation: " + e.message);
    }
  }

  async function endDelegation(id: string) {
    try {
      await api.endDelegation(id);
      setDelegations((current) => current.filter((delegation) => delegation.id !== id));
    } catch (e: any) {
      alert("Error ending delegation: " + e.message);
    }
  }

  useEffect(() => {
    if (!departmentRoleDepartment) {
      setDepartmentRoleUserId("");
      return;
    }
    const departmentUsers = adminUsers.filter((user) => user.department === departmentRoleDepartment);
    if (!departmentUsers.some((user) => user.id === departmentRoleUserId)) {
      setDepartmentRoleUserId(departmentUsers[0]?.id || "");
    }
  }, [adminUsers, departmentRoleDepartment, departmentRoleUserId]);

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

  async function assignUserToGroup() {
    if (!groupAssignUserId) {
      alert("Choose a user to assign.");
      return;
    }
    if (!groupAssignDepartment) {
      alert("Choose a department group first.");
      return;
    }
    try {
      const updated: any = await api.updateUserGroup(groupAssignUserId, {
        department: groupAssignDepartment
      });
      setAdminUsers((current) => current.map((user) => (user.id === groupAssignUserId ? updated : user)));
      if (profile?.id === groupAssignUserId) {
        setProfile(updated);
      }
      setGroupAssignDepartment("");
      setGroupAssignUserId("");
      alert(`Assigned ${updated.full_name || updated.email} to department group ${updated.department}.`);
    } catch (e: any) {
      alert("Error assigning group: " + e.message);
    }
  }

  async function updateDepartmentRole() {
    if (!departmentRoleDepartment) {
      alert("Choose a department first.");
      return;
    }
    if (!departmentRoleUserId) {
      alert("Choose a user first.");
      return;
    }
    try {
      const updated: any = await api.updateUserRole(departmentRoleUserId, { role: departmentRoleValue });
      setAdminUsers((current) => current.map((user) => (user.id === departmentRoleUserId ? updated : user)));
      if (profile?.id === departmentRoleUserId) {
        setProfile(updated);
      }
      alert(`Updated role for ${updated.full_name || updated.email}.`);
    } catch (e: any) {
      alert("Error updating role: " + e.message);
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
      const created: any = await api.createDepartment(name, newDepartmentSectionId || undefined);
      setDepartmentOptions((current) => Array.from(new Set([...(current || []), created.name])).sort((a, b) => a.localeCompare(b)));
      setNewDepartmentName("");
      setNewDepartmentSectionId("");
      await loadAdminUsers();
      alert(`Department group ${created.name} created.`);
    } catch (e: any) {
      alert("Error creating department: " + e.message);
    }
  }

  async function editDepartment(name: string) {
    const newName = prompt("Enter new department name:", name)?.trim();
    if (!newName || newName === name) return;
    try {
      const updated: any = await api.updateDepartment(name, newName);
      setDepartmentOptions((current) =>
        Array.from(new Set([...(current || []).map((d) => (d === name ? updated.name : d)), updated.name])).sort((a, b) => a.localeCompare(b))
      );
      if (groupAssignDepartment === name) setGroupAssignDepartment(updated.name);
      if (departmentRoleDepartment === name) setDepartmentRoleDepartment(updated.name);
      await loadAdminUsers();
      alert(`Department ${name} renamed to ${updated.name}.`);
    } catch (e: any) {
      alert("Error updating department: " + e.message);
    }
  }

  async function deleteDepartment(name: string) {
    if (!confirm(`Delete department group '${name}'? This cannot be undone.`)) return;
    try {
      await api.deleteDepartment(name);
      setDepartmentOptions((current) => (current || []).filter((d) => d !== name));
      if (groupAssignDepartment === name) setGroupAssignDepartment("");
      if (departmentRoleDepartment === name) setDepartmentRoleDepartment("");
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
      const created: any = await api.createSection(name);
      setNewSectionName("");
      await loadAdminUsers();
      alert(`Section ${created.name} created.`);
    } catch (e: any) {
      alert("Error creating section: " + e.message);
    }
  }

  async function editSection(id: string, currentName: string) {
    const newName = prompt("Enter new section name:", currentName)?.trim();
    if (!newName || newName === currentName) return;

    try {
      const updated: any = await api.updateSection(id, newName);
      await loadAdminUsers();
      alert(`Section renamed to ${updated.name}.`);
    } catch (e: any) {
      alert("Error updating section: " + e.message);
    }
  }

  async function deleteSection(id: string, name: string) {
    if (!confirm(`Delete section '${name}'? This cannot be undone.`)) return;
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
      await api.updateDepartment(department, department, sectionId || undefined);
      await loadAdminUsers();
    } catch (e: any) {
      alert("Error updating department section: " + e.message);
    }
  }

  async function showAdvanceHistory(advanceId: string) {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryAdvanceId(advanceId);
    setHistoryEvents([]);
    try {
      const events: any[] = await api.advanceHistory(advanceId);
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
    setPage("ADVANCE");
  }

  function advanceStageLabel(status: string, type?: string) {
    switch (status) {
      case "DRAFT":
        return "Draft (not submitted)";
      case "SUBMITTED":
        return "Waiting Manager Approval";
      case "HR_MANAGER_REVIEW":
        return "Waiting HR Manager Approval";
      case "HR_REVIEW":
        return "Waiting HR Approval";
      case "HR_OFFICER":
        return "Waiting Finance Payment";
      case "APPROVED":
        return "Waiting Finance Payment";
      case "PAID":
        return "Completed";
      case "CANCELLED":
        return "Cancelled";
      case "REJECTED":
        return "Rejected";
      default:
        return status;
    }
  }

  function clearanceStageLabel(status: string) {
    switch (status) {
      case "DRAFT":
        return "Draft clearance";
      case "SUBMITTED":
        return "Waiting Manager Certification";
      case "MANAGER_APPROVED":
        return "Waiting Chief Officer";
      case "CHIEF_OFFICER_APPROVED":
        return "Waiting HR Approval";
      case "HR_OFFICER":
        return "Waiting Finance Verification";
      case "FINANCE_VERIFIED":
        return "Waiting Finance Settlement";
      case "SETTLED":
        return "Cleared";
      case "REJECTED":
        return "Rejected";
      default:
        return status;
    }
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

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <img src={econetLogo} alt="Econet Telecom Lesotho" className="login-logo" />
          <h1>Advance Clearance</h1>
          <p className="subtitle">Finance workflow and approval portal</p>

          <form onSubmit={(e) => {
            e.preventDefault();
            void doLogin();
          }}>
            <div className="form-group">
              <input
                className="login-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
              />
            </div>

            <div className="form-group">
              <input
                className="login-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                type="password"
              />
            </div>

            <button className="button login-button" type="submit">
              Sign In
            </button>
          </form>

          {error && <pre className="error-text">{error}</pre>}

          <p className="demo-text">
            Demo accounts:
            <br />
            employee@example.com
            <br />
            manager@example.com
            <br />
            hr@example.com
            <br />
            chief@example.com
            <br />
            finance@example.com
            <br />
            admin@example.com
            <br />
            Password: <b>pass123</b>
          </p>
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
          <img src={econetLogo} alt="Econet Telecom Lesotho" className="login-logo" />
          <h1>Complete Your Profile</h1>
          <p className="subtitle">Fill in your profile details before using the system.</p>

          <div className="form-group" style={{ display: 'flex', gap: 8 }}>
            <input className="login-input" value={profileFirstName} onChange={(e) => setProfileFirstName(e.target.value)} placeholder="First name" />
            <input className="login-input" value={profileLastName} onChange={(e) => setProfileLastName(e.target.value)} placeholder="Last name" />
          </div>
          <div className="form-group">
            <select
              className="login-input"
              value={profileDepartment}
              onChange={(e) => setProfileDepartment(e.target.value)}
              disabled={departmentOptions.length === 0}
            >
              <option value="">{departmentOptions.length === 0 ? "Loading departments..." : "Choose department"}</option>
              {departmentOptions.map((department) => (
                <option key={department} value={department}>
                  {department}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <select className="login-input" value={profileEmploymentType} onChange={(e) => setProfileEmploymentType(e.target.value as "PERMANENT" | "INTERN" | "TEMPORARY")}>
              <option value="PERMANENT">Permanent Employee</option>
              <option value="INTERN">Intern</option>
              <option value="TEMPORARY">Temporary Employee</option>
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

          <button className="button login-button" onClick={submitProfile} disabled={departmentOptions.length === 0}>Save Profile</button>
          <button className="button small-button" onClick={doLogout} style={{ marginTop: 12 }}>Logout</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="header app-header">
        <img src={econetLogo} alt="Econet Telecom Lesotho" className="header-logo" />
        <div className="user">
          <div className="avatar" />
          <div>
            <div>{userName}</div>
            <div style={{ fontSize: "0.85rem", opacity: 0.7 }}>{userDepartment}</div>
          </div>
        </div>
        <div className="header-actions">
          <button className="button small-button" onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}>
            {theme === "light" ? "Dark Mode" : "Light Mode"}
          </button>
          <button className="button small-button" onClick={doLogout}>Logout</button>
        </div>
      </header>

      <div className="app-body">
        <nav className="sidebar">
          <div className="sidebar-brand">
            <h2>Advance Clearance</h2>
          </div>
          <a href="#" onClick={() => setPage("HOME")}>Dashboard</a>
          <a href="#" onClick={() => setPage("MY_REQUESTS")}>Advance Requests</a>
          <a href="#" onClick={() => setPage("MY_REQUESTS")}>Clearances</a>
          {["INTERN", "TEMPORARY"].includes(String(employmentType || "").toUpperCase()) && <a href="#" onClick={() => setPage("ATTENDANCE")}>Attendance</a>}
          <a href="#" onClick={() => setPage("OVERTIME")}>Overtime</a>
          <a href="#" onClick={() => setPage("INBOX")}>Approval Inbox ({inboxCount})</a>
          <a href="#" onClick={() => setPage("REPORTS")}>Reports</a>
          {(role === "ADMIN" || role === "MANAGER") && <a href="#" onClick={() => setPage("SETTINGS")}>Administrator</a>}
          <a href="#" onClick={() => setPage("SETTINGS")}>Settings</a>
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
          ) : page === "REPORTS" ? (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
                <div>
                  <h2 style={{ margin: 0 }}>Reports</h2>
                  <div style={{ opacity: 0.7, marginTop: 4 }}>Snapshot of advance and clearance activity from the records already loaded in the app.</div>
                </div>
                <button className="button small-button" onClick={() => setPage("HOME")}>Back</button>
              </div>

              <div className="card-container">
                <div className="card">
                  <div className="title">Total Advances</div>
                  <div className="value">{advances.length}</div>
                </div>
                <div className="card">
                  <div className="title">Total Clearances</div>
                  <div className="value">{claims.length}</div>
                </div>
                <div className="card">
                  <div className="title">Approved / Paid Value</div>
                  <div className="value">{fmtMoney(advances.reduce((sum, a) => sum + Number(a.approved_total || 0), 0))}</div>
                </div>
                <div className="card">
                  <div className="title">Clearance Spend</div>
                  <div className="value">{fmtMoney(claims.reduce((sum, c) => sum + Number(c.claim_total || 0), 0))}</div>
                </div>
              </div>

              <div style={{ marginTop: 24, display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
                <div className="card" style={{ padding: 20 }}>
                  <h3 style={{ marginTop: 0 }}>Advances By Type</h3>
                  <div style={{ display: "grid", gap: 10 }}>
                    {Object.entries(advancesByType).length === 0 ? (
                      <div style={{ opacity: 0.7 }}>No advance records yet.</div>
                    ) : (
                      Object.entries(advancesByType).map(([type, count]) => (
                        <div key={type} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                          <span>{type}</span>
                          <b>{count}</b>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="card" style={{ padding: 20, marginBottom: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <h3 style={{ margin: 0 }}>Hotels</h3>
                      <button className="button small-button" onClick={() => void loadHotels()} disabled={hotelsLoading}>{hotelsLoading ? 'Loading...' : 'Refresh'}</button>
                    </div>
                    { canManageTravelSettings && (
                      <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                        <input placeholder="Hotel name" value={newHotelName} onChange={(e) => setNewHotelName(e.target.value)} />
                        <select value={newHotelDistrict} onChange={(e) => setNewHotelDistrict(e.target.value)}>
                          <option value="">Select district</option>
                          {districts.map((district) => (
                            <option key={district} value={district}>{district}</option>
                          ))}
                        </select>
                        <input placeholder="Address (optional)" value={newHotelAddress} onChange={(e) => setNewHotelAddress(e.target.value)} />
                        <input placeholder="Contact (optional)" value={newHotelContact} onChange={(e) => setNewHotelContact(e.target.value)} />
                        <select value={newHotelDepartment} onChange={(e) => setNewHotelDepartment(e.target.value)}>
                          <option value="">Assign department (optional)</option>
                          {departmentOptions.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <div>
                          <button className="button small-button" onClick={() => void createHotel()}>Add Hotel</button>
                        </div>
                      </div>
                    )}

                    <div style={{ overflowX: 'auto' }}>
                      <table className="table">
                        <thead>
                          <tr><th>Name</th><th>District</th><th>Department</th><th>Contact</th><th>Address</th></tr>
                        </thead>
                        <tbody>
                          {hotels.length === 0 ? (
                            <tr><td colSpan={5} style={{ textAlign: 'center' }}>No hotels</td></tr>
                          ) : (
                            hotels.map(h => (
                              <tr key={h.id}>
                                <td>{h.name}</td>
                                <td>{h.district || '—'}</td>
                                <td>{h.department || '—'}</td>
                                <td>{h.contact || '—'}</td>
                                <td>{h.address || '—'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <div className="card" style={{ padding: 20 }}>
                  <h3 style={{ marginTop: 0 }}>Advances By Status</h3>
                  <div style={{ display: "grid", gap: 10 }}>
                    {Object.entries(advancesByStatus).length === 0 ? (
                      <div style={{ opacity: 0.7 }}>No advance records yet.</div>
                    ) : (
                      Object.entries(advancesByStatus).map(([status, count]) => (
                        <div key={status} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                          <span>{advanceStageLabel(status)}</span>
                          <b>{count}</b>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="card" style={{ padding: 20 }}>
                  <h3 style={{ marginTop: 0 }}>Clearances By Status</h3>
                  <div style={{ display: "grid", gap: 10 }}>
                    {Object.entries(claimsByStatus).length === 0 ? (
                      <div style={{ opacity: 0.7 }}>No clearance records yet.</div>
                    ) : (
                      Object.entries(claimsByStatus).map(([status, count]) => (
                        <div key={status} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                          <span>{clearanceStageLabel(status)}</span>
                          <b>{count}</b>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="card" style={{ marginTop: 24, padding: 20 }}>
                <h3 style={{ marginTop: 0 }}>Recent Advance Requests</h3>
                <div style={{ overflowX: "auto" }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Requested</th>
                        <th>Approved</th>
                      </tr>
                    </thead>
                    <tbody>
                      {advances.length === 0 ? (
                        <tr><td colSpan={4} style={{ textAlign: "center" }}>No advance records yet.</td></tr>
                      ) : (
                        advances.slice(0, 10).map((advance) => (
                          <tr key={advance.id}>
                            <td>{advance.type}</td>
                            <td>{advanceStageLabel(advance.status, advance.type)}</td>
                            <td>{fmtMoney(advance.requested_total)}</td>
                            <td>{fmtMoney(advance.approved_total)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ marginTop: 24, display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
                <div className="card" style={{ padding: 20 }}>
                  <h3 style={{ marginTop: 0 }}>Fraud / Anomaly Flags</h3>
                  <div style={{ display: "grid", gap: 10 }}>
                    <div>Duplicate claims: {aiAnomalies?.duplicateClaims?.length || 0}</div>
                    <div>Unusual amounts: {aiAnomalies?.unusualAdvances?.length || 0}</div>
                    <div>Repeated rollbacks: {aiAnomalies?.repeatedRollbacks?.length || 0}</div>
                  </div>
                  {aiAnomalies?.duplicateClaims?.[0] && (
                    <div style={{ marginTop: 10, opacity: 0.8 }}>
                      Top duplicate flag: {aiAnomalies.duplicateClaims[0].claimant_name} ({aiAnomalies.duplicateClaims[0].duplicate_count})
                    </div>
                  )}
                </div>

                <div className="card" style={{ padding: 20 }}>
                  <h3 style={{ marginTop: 0 }}>Natural-Language Reporting</h3>
                  <div className="form-field">
                    <label>Ask a report question</label>
                    <input value={nlPrompt} onChange={(e) => setNlPrompt(e.target.value)} />
                  </div>
                  <button
                    className="button small-button"
                    onClick={async () => {
                      try {
                        const result = await api.aiNlReport(nlPrompt);
                        setNlReport(result);
                      } catch (e: any) {
                        alert("Error generating report: " + e.message);
                      }
                    }}
                  >
                    Run Report
                  </button>
                  {nlReport && (
                    <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                      <div><strong>{nlReport.interpretation}</strong></div>
                      <div style={{ overflowX: "auto" }}>
                        <table className="table">
                          <thead>
                            <tr>
                              {Object.keys(nlReport.rows?.[0] || { result: "" }).map((key) => (
                                <th key={key}>{key}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(nlReport.rows || []).map((row: any, index: number) => (
                              <tr key={index}>
                                {Object.keys(nlReport.rows?.[0] || { result: "" }).map((key) => (
                                  <td key={key}>{String(row[key] ?? "")}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>

                <div className="card" style={{ padding: 20 }}>
                  <h3 style={{ marginTop: 0 }}>OCR Receipt / Proof Extract</h3>
                  <div className="form-field">
                    <label>Paste OCR text from a receipt or payment proof</label>
                    <textarea value={ocrText} onChange={(e) => setOcrText(e.target.value)} rows={5} />
                  </div>
                  <button
                    className="button small-button"
                    onClick={async () => {
                      try {
                        const result = await api.aiOcrExtract(ocrText);
                        setOcrResult(result);
                      } catch (e: any) {
                        alert("Error extracting OCR fields: " + e.message);
                      }
                    }}
                  >
                    Extract Fields
                  </button>
                  {ocrResult && (
                    <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                      <div>Date: {ocrResult.extracted_date || "—"}</div>
                      <div>Amount: {ocrResult.extracted_amount != null ? `M${Number(ocrResult.extracted_amount).toFixed(2)}` : "—"}</div>
                      <div>Reference: {ocrResult.extracted_reference || "—"}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
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
            <div className="advance-form modern-form">
              <h2 className="form-title">{editingAdvanceId ? "Edit Advance Request" : "Advance Request Form"}</h2>

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
              <div className="checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={advanceType === "SALARY"}
                    onChange={() => setAdvanceType(advanceType === "SALARY" ? null : "SALARY")}
                  /> Salary amount M
                  <input
                    type="number"
                    value={salaryAmount}
                    onChange={e => setSalaryAmount(e.target.value)}
                    disabled={advanceType !== "SALARY"}
                    style={{ width: 100, marginLeft: 4 }}
                    placeholder="0"
                  /> for month
                  <input
                    type="month"
                    value={monthField}
                    onChange={e => setMonthField(e.target.value)}
                    disabled={advanceType !== "SALARY"}
                    style={{ width: 120, marginLeft: 4 }}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={advanceType === "TRAVEL_SUBSISTENCE"}
                    onChange={() => setAdvanceType(advanceType === "TRAVEL_SUBSISTENCE" ? null : "TRAVEL_SUBSISTENCE")}
                  /> Travel and subsistence allowance amount of
                  <input
                    type="number"
                    value={travelAmount}
                    readOnly
                    style={{ width: 100, marginLeft: 4 }}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={advanceType === "LOAN"}
                    onChange={() => setAdvanceType(advanceType === "LOAN" ? null : "LOAN")}
                  /> Loan amount of M
                  <input
                    type="number"
                    value={loanAmount}
                    onChange={e => setLoanAmount(e.target.value)}
                    disabled={advanceType !== "LOAN"}
                    style={{ width: 100, marginLeft: 4 }}
                    placeholder="0"
                  />
                </label>
              </div>
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
              {advanceType === "TRAVEL_SUBSISTENCE" && (
                <>
                  <div className="card" style={{ marginBottom: 12, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <span>Meal value</span>
                      <b>{fmtMoney(mealValueNumber)} per meal</b>
                    </div>
                  </div>
                  <table className="breakdown-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Starting District</th>
                        <th>Destination District</th>
                        <th>Meals</th>
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
                          <td>
                            <select
                              value={r.startDistrict || ""}
                              onChange={e => updateRow(idx, "startDistrict", e.target.value)}
                              disabled={idx > 0}
                            >
                              <option value="">Start district</option>
                              {districts.map((district) => (
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
                              {districts.map((district) => (
                                <option key={district} value={district}>{district}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={String(Number.isFinite(Number(r.meals)) ? r.meals : 0)}
                              onChange={e => updateRow(idx, "meals", e.target.value === "" ? 0 : Number(e.target.value))}
                              style={{ width: 80 }}
                            />
                          </td>
                          <td>{fmtMoney((Number.isFinite(Number(r.meals)) ? Math.max(0, Number(r.meals)) : 0) * mealValueNumber)}</td>
                          <td>
                            <button
                              className="button small-button"
                              onClick={() => deleteRow(idx)}
                              type="button"
                              style={{ backgroundColor: '#dc3545', color: 'white' }}
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={6}>
                          <button className="button small-button" onClick={addRow} type="button">
                            Add row
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
                </>
              )}

              <div className="form-field">
                <label>Amount Requested (In Words)</label>
                <input type="text" value={amountInWords} readOnly />
              </div>

              <div className="footer-buttons">
                <button className="button" onClick={() => {
                  setEditingAdvanceId(null);
                  setEditingAdvanceStatus(null);
                  setPage(editingAdvanceId ? "MY_REQUESTS" : "HOME");
                }}>Cancel</button>
                <button className="button" onClick={async () => {
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
                        alert("Please select advance type (Salary, Travel/Subsistence, or Loan).");
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
                      if (advanceType === "TRAVEL_SUBSISTENCE" && rows.length < 1) {
                        alert("At least one entry is required in the travel table.");
                        return;
                      }
                      if (advanceType === "TRAVEL_SUBSISTENCE") {
                        if (mealValueNumber <= 0) {
                          alert("HR must set the meal value before travel and subsistence requests can be submitted.");
                          return;
                        }
                        const hasInvalidRow = rows.some((r) =>
                          !r.date ||
                          !String(r.startDistrict || "").trim() ||
                          !String(r.destinationDistrict || "").trim() ||
                          !(Number.isInteger(Number(r.meals)) && Number(r.meals) >= 0)
                        );
                        if (hasInvalidRow) {
                          alert("Each travel row must have date, starting district, destination district, and a non-negative whole number of meals.");
                          return;
                        }
                        if ((Number(totalRequested()) || 0) <= 0) {
                          alert("Travel total must be greater than 0.");
                          return;
                        }
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
                      if (advanceType === "TRAVEL_SUBSISTENCE") {
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
                        if (advanceType === "TRAVEL_SUBSISTENCE") {
                          const mappedRows = rows.map(r => ({
                            line_date: r.date,
                            location: `${r.startDistrict} → ${r.destinationDistrict}`,
                            meals_count: r.meals,
                            dinner: 0
                          }));
                          await api.updateAdvanceLines(editingAdvanceId, { lines: mappedRows });
                        }
                        await api.submitAdvance(editingAdvanceId);
                        alert("Advance request submitted successfully and moved to next level.");
                        setEditingAdvanceId(null);
                      } else {
                        // create new request, then send any additional details
                        const resp: any = await api.createAdvance(base);
                        const newId = resp.id;
                        if (advanceType === "TRAVEL_SUBSISTENCE") {
                          const mappedRows = rows.map(r => ({
                            line_date: r.date,
                            location: `${r.startDistrict} → ${r.destinationDistrict}`,
                            meals_count: r.meals,
                            dinner: 0
                          }));
                          await api.updateAdvanceLines(newId, { lines: mappedRows });
                        }
                        await api.submitAdvance(newId);
                        alert("Advance request submitted successfully and moved to next level.");
                      }
                      await refresh();
                      setPage("HOME");
                      setEditingAdvanceStatus(null);
                    } catch (e: any) { 
                      alert("Error: " + e.message);
                    }
                  }}>{editingAdvanceId ? "Update & Submit" : "Submit"}</button>
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
                        {fmtMoney(advance.approved_total || advance.requested_total)} - {new Date(advance.created_at).toLocaleDateString()}
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
                  <div>3. Chief Officer approves the clearance.</div>
                  <div>4. HR confirms the trip was duly authorised.</div>
                  <div>5. Finance verifies and settles any amount due or refund reference.</div>
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
                          <td>{a.type}</td>
                          <td>{fmtMoney(a.approved_total || a.requested_total || 0)}</td>
                          <td>{a.status}</td>
                          <td>{advanceStageLabel(a.status, a.type)}</td>
                          <td>{new Date(a.created_at).toLocaleDateString()}</td>
                          <td>
                            {(a.status === "DRAFT" || a.status === "SUBMITTED") && (
                              <button
                                className="button small-button"
                                onClick={async () => {
                                  // fetch full details before navigating to form so we can populate rows etc
                                  try {
                                    const detail: any = await api.advanceDetail(a.id);
                                    setEditingAdvanceId(a.id);
                                    setEditingAdvanceStatus(detail.status || a.status || null);
                                    setAdvanceType(detail.type);
                                    setSalaryAmount(detail.type === "SALARY" ? String(detail.requested_total || 0) : "0");
                                    setLoanAmount(detail.type === "LOAN" ? String(detail.requested_total || 0) : "");
                                    // travel amount will be derived from rows via effect
                                    setTravelAmount(detail.type === "TRAVEL_SUBSISTENCE" ? String(detail.requested_total || 0) : "");
                                    setRows(
                                      detail.lines
                                        ? detail.lines.map((l: any) => {
                                            const rawLocation = String(l.location || "").trim();
                                            const parts = rawLocation.includes("→")
                                              ? rawLocation.split("→").map((part) => part.trim())
                                              : [rawLocation, rawLocation];
                                            return {
                                              date: normalizeDateInputValue(l.line_date),
                                              startDistrict: parts[0] || "",
                                              destinationDistrict: parts[1] || parts[0] || "",
                                              meals: advanceLineMealCount(l)
                                            };
                                          })
                                        : []
                                    );
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
                                    {
                                      const parsedPayment = parsePaymentAccount((detail.payment_method === "BANK" ? "BANK" : "ECOCASH"), detail.payment_account || "");
                                      setEcocashNumber(parsedPayment.ecocash_number);
                                      setBankName(parsedPayment.bank_name);
                                      setBankAccountNumber(parsedPayment.bank_account_number);
                                      setBankBranch(parsedPayment.bank_branch);
                                    }
                                    setPurpose(detail.purpose || "");
                                    // optional: if the API returned an employee number
                                    setRequesterName(detail.requester_name || "");
                                    setEmpNumber(detail.requester_employee_no || detail.emp_number || "");
                                    setRequestForUserId(detail.requester_id || profile?.id || me?.userId || "");
                                    setRequestDate(normalizeDateInputValue(detail.created_at) || new Date().toISOString().slice(0, 10));
                                    setPage("ADVANCE");
                                  } catch (e: any) {
                                    alert("Error loading advance: " + e.message);
                                  }
                                }}
                              >
                                Edit
                              </button>
                            )}
                            {(a.status === "SUBMITTED" || a.status === "PENDING" || a.status === "DRAFT") && (
                              <button
                                className="button small-button"
                                onClick={async () => {
                                  if (window.confirm("Are you sure you want to revoke this advance request?")) {
                                    try {
                                      await api.revokeAdvance(a.id);
                                      alert("Advance request revoked successfully!");
                                      await refresh();
                                    } catch (e: any) {
                                      alert("Error revoking request: " + e.message);
                                    }
                                  }
                                }}
                                style={{ backgroundColor: '#dc3545', color: 'white', marginLeft: 4 }}
                              >
                                Revoke
                              </button>
                            )}
                            <button
                              className="button small-button"
                              onClick={() => showAdvanceHistory(a.id)}
                              style={{ marginLeft: 4 }}
                            >
                              Track
                            </button>
                            {a.status === "PAID" && a.type === "TRAVEL_SUBSISTENCE" && (
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
                          <td>{clearanceStageLabel(c.status)}</td>
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
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
                <h2>Settings</h2>
                <button className="button small-button" onClick={() => setPage("HOME")}>Back</button>
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

              {canManageTravelSettings && (
                <SettingsAccordion
                  title="Travel Rates & Hotels"
                  subtitle="Maintain the meal value and district hotel register."
                  open={travelSettingsOpen}
                  onToggle={() => setTravelSettingsOpen((current) => !current)}
                >
                  <div style={{ display: "grid", gap: 16 }}>
                    <div className="card" style={{ padding: 20 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <div>
                          <h3 style={{ margin: 0 }}>Meal Value</h3>
                          <div style={{ marginTop: 4, opacity: 0.75 }}>Current value: {fmtMoney(mealValueNumber)} per meal</div>
                        </div>
                        <button className="button small-button" onClick={() => void loadMealValue()} disabled={mealValueLoading}>
                          {mealValueLoading ? "Loading..." : "Refresh"}
                        </button>
                      </div>
                      <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={mealValueDraft}
                          onChange={(e) => setMealValueDraft(e.target.value)}
                          style={{ maxWidth: 180 }}
                        />
                        <button className="button small-button" onClick={() => void saveMealValue()} disabled={mealValueLoading}>
                          Save Meal Value
                        </button>
                      </div>
                    </div>

                    <div className="card" style={{ padding: 20 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <h3 style={{ margin: 0 }}>Hotels</h3>
                        <button className="button small-button" onClick={() => void loadHotels()} disabled={hotelsLoading}>
                          {hotelsLoading ? "Loading..." : "Refresh"}
                        </button>
                      </div>

                      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
                        <input placeholder="Hotel name" value={newHotelName} onChange={(e) => setNewHotelName(e.target.value)} />
                        <select value={newHotelDistrict} onChange={(e) => setNewHotelDistrict(e.target.value)}>
                          <option value="">Select district</option>
                          {districts.map((district) => (
                            <option key={district} value={district}>{district}</option>
                          ))}
                        </select>
                        <input placeholder="Address (optional)" value={newHotelAddress} onChange={(e) => setNewHotelAddress(e.target.value)} />
                        <input placeholder="Contact (optional)" value={newHotelContact} onChange={(e) => setNewHotelContact(e.target.value)} />
                        <select value={newHotelDepartment} onChange={(e) => setNewHotelDepartment(e.target.value)}>
                          <option value="">Assign department (optional)</option>
                          {departmentOptions.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <div>
                          <button className="button small-button" onClick={() => void createHotel()}>Add Hotel</button>
                        </div>
                      </div>

                      <div style={{ overflowX: "auto" }}>
                        <table className="table">
                          <thead>
                            <tr><th>Name</th><th>District</th><th>Department</th><th>Contact</th><th>Address</th></tr>
                          </thead>
                          <tbody>
                            {hotels.length === 0 ? (
                              <tr><td colSpan={5} style={{ textAlign: "center" }}>No hotels</td></tr>
                            ) : (
                              hotels.map(h => (
                                <tr key={h.id}>
                                  <td>{h.name}</td>
                                  <td>{h.district || "—"}</td>
                                  <td>{h.department || "—"}</td>
                                  <td>{h.contact || "—"}</td>
                                  <td>{h.address || "—"}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </SettingsAccordion>
              )}

              {role === "ADMIN" || role === "MANAGER" || role === "CHIEF_OFFICER" ? (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <h3 style={{ margin: 0 }}>User Department Groups and Roles</h3>
                    <button className="button small-button" onClick={() => void loadAdminUsers()} disabled={adminUsersLoading}>
                      {adminUsersLoading ? "Loading..." : "Refresh"}
                    </button>
                  </div>

                  {role === "ADMIN" && (
                    <SettingsAccordion
                      title="Section & Department Management"
                      subtitle="Create and manage sections first, then add departments under those sections."
                      open={sectionManagementOpen}
                      onToggle={() => setSectionManagementOpen((current) => !current)}
                    >
                      <div style={{ display: "grid", gap: 20, marginBottom: 24 }}>
                        <div className="card" style={{ padding: 24 }}>
                          <h3 style={{ marginTop: 0 }}>Create Section</h3>
                          <p style={{ color: "#4b5563", marginTop: 4, marginBottom: 20 }}>
                            Create a section first. Departments are then created under that section.
                          </p>
                          <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
                            <label style={{ display: "grid", gap: 6 }}>
                              <span style={{ fontWeight: 600 }}>Section Name <span style={{ color: "#dc2626" }}>*</span></span>
                              <input
                                value={newSectionName}
                                onChange={(e) => setNewSectionName(e.target.value)}
                                placeholder="Enter section name"
                              />
                            </label>
                            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                              <button className="button small-button" onClick={() => void createSection()}>
                                Create Section
                              </button>
                            </div>
                            <div style={{ borderLeft: "4px solid #2563eb", background: "#eff6ff", padding: 12, borderRadius: 8 }}>
                              <strong>Note:</strong> Sections are the top-level division for departments.
                            </div>
                          </div>
                        </div>

                        <div className="card" style={{ padding: 24 }}>
                          <h3 style={{ marginTop: 0 }}>Create Department</h3>
                          <p style={{ color: "#4b5563", marginTop: 4, marginBottom: 20 }}>
                            Create a department group and assign it to an existing section.
                          </p>
                          <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
                            <label style={{ display: "grid", gap: 6 }}>
                              <span style={{ fontWeight: 600 }}>Department Name <span style={{ color: "#dc2626" }}>*</span></span>
                              <input
                                value={newDepartmentName}
                                onChange={(e) => setNewDepartmentName(e.target.value)}
                                placeholder="Enter department name"
                              />
                            </label>
                            <label style={{ display: "grid", gap: 6 }}>
                              <span style={{ fontWeight: 600 }}>Section <span style={{ color: "#dc2626" }}>*</span></span>
                              <select value={newDepartmentSectionId} onChange={(e) => setNewDepartmentSectionId(e.target.value)}>
                                <option value="">Select section</option>
                                {sectionOptions.map((section) => (
                                  <option key={section.id} value={section.id}>
                                    {section.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                              <button className="button small-button" onClick={() => void createDepartment()}>
                                Create Department
                              </button>
                            </div>
                            <div style={{ borderLeft: "4px solid #2563eb", background: "#eff6ff", padding: 12, borderRadius: 8 }}>
                              <strong>Note:</strong> Each department must belong to a section so it can be displayed in the correct division.
                            </div>
                          </div>
                        </div>
                      </div>

                      <div style={{ marginBottom: 16 }}>
                        <h4 style={{ margin: "12px 0 8px" }}>Existing Sections</h4>
                        <div style={{ overflowX: "auto" }}>
                          <table className="table" style={{ width: "100%" }}>
                            <thead>
                              <tr>
                                <th>Name</th>
                                <th style={{ width: 150 }}>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sectionOptions.length === 0 ? (
                                <tr><td colSpan={2} style={{ textAlign: "center" }}>No sections</td></tr>
                              ) : (
                                sectionOptions.map((section) => (
                                  <tr key={section.id}>
                                    <td>{section.name}</td>
                                    <td>
                                      <button className="button small-button" onClick={() => void editSection(section.id, section.name)} style={{ marginRight: 8 }}>
                                        Rename
                                      </button>
                                      <button className="button small-button" onClick={() => void deleteSection(section.id, section.name)}>
                                        Delete
                                      </button>
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div style={{ marginBottom: 16 }}>
                        <h4 style={{ margin: "12px 0 8px" }}>Existing Department Groups</h4>
                        <div style={{ overflowX: "auto" }}>
                          <table className="table" style={{ width: "100%" }}>
                            <thead>
                              <tr>
                                <th>Name</th>
                                <th>Section</th>
                                <th style={{ width: 150 }}>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {departmentRows.length === 0 ? (
                                <tr><td colSpan={3} style={{ textAlign: "center" }}>No department groups</td></tr>
                              ) : (
                                departmentRows.map((department) => (
                                  <tr key={department.name}>
                                    <td>{department.name}</td>
                                    <td>
                                      <select
                                        value={department.section_id || ""}
                                        onChange={(e) => void updateDepartmentSection(department.name, e.target.value)}
                                      >
                                        <option value="">None</option>
                                        {sectionOptions.map((section) => (
                                          <option key={section.id} value={section.id}>
                                            {section.name}
                                          </option>
                                        ))}
                                      </select>
                                    </td>
                                    <td>
                                      <button className="button small-button" onClick={() => void editDepartment(department.name)} style={{ marginRight: 8 }}>
                                        Rename
                                      </button>
                                      <button className="button small-button" onClick={() => void deleteDepartment(department.name)}>
                                        Delete
                                      </button>
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </SettingsAccordion>
                  )}

                  <SettingsAccordion
                    title="User Group & Role Assignment"
                    subtitle="Assign users to departments and roles within your organization."
                    open={groupAssignmentOpen}
                    onToggle={() => setGroupAssignmentOpen((current) => !current)}
                  >
                    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                      <select
                        value={groupAssignUserId}
                        onChange={(e) => setGroupAssignUserId(e.target.value)}
                      >
                        <option value="">Select user to assign department group</option>
                        {adminUsers.map((user) => (
                          <option key={user.id} value={user.id}>
                            {(user.full_name || user.email) + (user.employee_no ? ` (${user.employee_no})` : "")}
                          </option>
                        ))}
                      </select>
                      <select
                        value={groupAssignDepartment}
                        onChange={(e) => setGroupAssignDepartment(e.target.value)}
                        disabled={!groupAssignUserId}
                      >
                        <option value="">Select department group</option>
                        {departmentOptions.map((department) => (
                          <option key={department} value={department}>
                            {department}
                          </option>
                        ))}
                      </select>
                      <button className="button small-button" onClick={() => void assignUserToGroup()}>
                        Assign Department Group
                      </button>
                    </div>

                    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                      <select value={departmentRoleDepartment} onChange={(e) => setDepartmentRoleDepartment(e.target.value)}>
                        <option value="">Select department group</option>
                        {departmentOptions.map((department) => (
                          <option key={department} value={department}>{department}</option>
                        ))}
                      </select>
                      <select
                        value={departmentRoleUserId}
                        onChange={(e) => setDepartmentRoleUserId(e.target.value)}
                        disabled={!departmentRoleDepartment}
                      >
                        <option value="">Select user</option>
                        {adminUsers
                          .filter((user) => user.department === departmentRoleDepartment)
                          .map((user) => (
                            <option key={user.id} value={user.id}>
                              {(user.full_name || user.email) + (user.employee_no ? ` (${user.employee_no})` : "")}
                            </option>
                          ))}
                      </select>
                      <select value={departmentRoleValue} onChange={(e) => setDepartmentRoleValue(e.target.value)}>
                        <option value="EMPLOYEE">Employee</option>
                        <option value="MANAGER">Manager</option>
                        <option value="HR_MANAGER">HR Manager</option>
                        <option value="AUTH_OFFICER">HR</option>
                        <option value="CHIEF_OFFICER">Chief Officer</option>
                        <option value="FINANCE">Finance</option>
                        {role === "ADMIN" && <option value="ADMIN">Admin</option>}
                      </select>
                      <button className="button small-button" onClick={() => void updateDepartmentRole()}>
                        Assign Role To User
                      </button>
                    </div>

                    <div style={{ marginBottom: 16, display: "grid", gap: 10 }}>
                      {departmentOptions.map((department) => {
                        const members = adminUsers.filter((user) => user.department === department);
                        const managers = members.filter((user) => user.role === "MANAGER").map((user) => user.full_name || user.email);
                        const hrManagers = members.filter((user) => user.role === "HR_MANAGER").map((user) => user.full_name || user.email);
                        const hrUsers = members.filter((user) => user.role === "AUTH_OFFICER").map((user) => user.full_name || user.email);
                        const chiefs = members.filter((user) => user.role === "CHIEF_OFFICER").map((user) => user.full_name || user.email);
                        const financeUsers = members.filter((user) => user.role === "FINANCE").map((user) => user.full_name || user.email);
                        return (
                          <div key={department} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
                            <div><b>{department}</b></div>
                            <div style={{ fontSize: 13, opacity: 0.8 }}>Managers: {managers.length ? managers.join(", ") : "None assigned"}</div>
                            <div style={{ fontSize: 13, opacity: 0.8 }}>HR Managers: {hrManagers.length ? hrManagers.join(", ") : "None assigned"}</div>
                            <div style={{ fontSize: 13, opacity: 0.8 }}>HR: {hrUsers.length ? hrUsers.join(", ") : "None assigned"}</div>
                            <div style={{ fontSize: 13, opacity: 0.8 }}>Chief Officers: {chiefs.length ? chiefs.join(", ") : "None assigned"}</div>
                            <div style={{ fontSize: 13, opacity: 0.8 }}>Finance: {financeUsers.length ? financeUsers.join(", ") : "None assigned"}</div>
                            <div style={{ fontSize: 13, opacity: 0.8 }}>Requests go directly to Manager before HR Manager, HR, and Finance.</div>
                          </div>
                        );
                      })}
                    </div>
                  </SettingsAccordion>

                  <SettingsAccordion
                    title="Manager Delegations"
                    subtitle="Create a delegation assignment and track active delegations."
                    open={delegationsOpen}
                    onToggle={() => setDelegationsOpen((current) => !current)}
                  >
                    <div style={{ marginBottom: 20, display: "grid", gap: 12, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <h4 style={{ margin: 0 }}>Manager Delegations</h4>
                          <div style={{ fontSize: 13, opacity: 0.8 }}>Create and manage active delegation assignments.</div>
                        </div>
                        <button className="button small-button" onClick={() => void loadDelegations()} disabled={delegationsLoading}>
                          {delegationsLoading ? "Refreshing..." : "Refresh"}
                        </button>
                      </div>

                      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
                        {role === "ADMIN" ? (
                          <>
                            <div>
                              <label style={{ display: "block", marginBottom: 6 }}>Manager</label>
                              <select
                                value={delegationManagerId}
                                onChange={(e) => setDelegationManagerId(e.target.value)}
                              >
                                <option value="">Select manager</option>
                                {adminUsers
                                  .filter((user) => user.role === "MANAGER")
                                  .map((user) => (
                                    <option key={user.id} value={user.id}>
                                      {user.full_name || user.email}
                                    </option>
                                  ))}
                              </select>
                            </div>
                            <div>
                              <label style={{ display: "block", marginBottom: 6 }}>Delegate</label>
                              <select
                                value={delegationDelegateId}
                                onChange={(e) => setDelegationDelegateId(e.target.value)}
                                disabled={!delegationManagerId}
                              >
                                <option value="">Select delegate</option>
                                {adminUsers
                                  .filter((user) => user.department === adminUsers.find((u) => u.id === delegationManagerId)?.department)
                                  .filter((user) => user.id !== delegationManagerId)
                                  .map((user) => (
                                    <option key={user.id} value={user.id}>
                                      {user.full_name || user.email}
                                    </option>
                                  ))}
                              </select>
                            </div>
                          </>
                        ) : (
                          <>
                            <div>
                              <label style={{ display: "block", marginBottom: 6 }}>Manager</label>
                              <input value={profile?.full_name || ""} readOnly />
                            </div>
                            <div>
                              <label style={{ display: "block", marginBottom: 6 }}>Delegate</label>
                              <select
                                value={delegationDelegateId}
                                onChange={(e) => setDelegationDelegateId(e.target.value)}
                              >
                                <option value="">Select delegate</option>
                                {adminUsers
                                  .filter((user) => user.department === profile?.department)
                                  .filter((user) => user.id !== profile?.id)
                                  .map((user) => (
                                    <option key={user.id} value={user.id}>
                                      {user.full_name || user.email}
                                    </option>
                                  ))}
                              </select>
                            </div>
                          </>
                        )}
                        <div style={{ display: "grid", gap: 10 }}>
                          <div>
                            <label style={{ display: "block", marginBottom: 6 }}>From</label>
                            <input
                              type="date"
                              value={delegationFromDate}
                              onChange={(e) => setDelegationFromDate(e.target.value)}
                            />
                          </div>
                          <div>
                            <label style={{ display: "block", marginBottom: 6 }}>To</label>
                            <input
                              type="date"
                              value={delegationToDate}
                              onChange={(e) => setDelegationToDate(e.target.value)}
                            />
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                        <button className="button small-button" onClick={() => void createDelegation()}>
                          Create Delegation
                        </button>
                        <button className="button small-button" onClick={() => void loadDelegations()} disabled={delegationsLoading}>
                          {delegationsLoading ? "Refreshing..." : "Reload Delegations"}
                        </button>
                      </div>

                      <div style={{ marginTop: 16 }}>
                        <h4 style={{ margin: "0 0 10px" }}>Active Delegations</h4>
                        {delegations.length === 0 ? (
                          <div style={{ color: "#6b7280" }}>No active delegations.</div>
                        ) : (
                          <div style={{ overflowX: "auto" }}>
                            <table className="table">
                              <thead>
                                <tr>
                                  <th>Manager</th>
                                  <th>Delegate</th>
                                  <th>Department</th>
                                  <th>From</th>
                                  <th>To</th>
                                  <th>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {delegations.map((delegation) => {
                                  const manager = adminUsers.find((u) => u.id === delegation.manager_id);
                                  const delegate = adminUsers.find((u) => u.id === delegation.delegate_id);
                                  return (
                                    <tr key={delegation.id}>
                                      <td>{manager?.full_name || manager?.email || "—"}</td>
                                      <td>{delegate?.full_name || delegate?.email || "—"}</td>
                                      <td>{manager?.department || delegate?.department || "—"}</td>
                                      <td>{delegation.from_date || "—"}</td>
                                      <td>{delegation.to_date || "—"}</td>
                                      <td>
                                        <button className="button small-button" onClick={() => void endDelegation(delegation.id)}>
                                          End
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  </SettingsAccordion>

                  <SettingsAccordion
                    title="Admin Users"
                    subtitle="View and manage users, departments, and roles."
                    open={adminUsersOpen}
                    onToggle={() => setAdminUsersOpen((current) => !current)}
                  >
                    <div style={{ overflowX: "auto" }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Email</th>
                            <th>Department</th>
                            <th>Employment Type</th>
                            <th>Employment No.</th>
                            <th>Role</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminUsers.map((user) => (
                            <tr key={user.id}>
                              <td>{user.full_name || "—"}</td>
                              <td>{user.email}</td>
                              <td>
                                {role === "ADMIN" ? (
                                  <select value={user.department || ""} onChange={(e) => void updateUserDepartment(user.id, e.target.value)}>
                                    <option value="" disabled>Unassigned</option>
                                    {departmentOptions.map((department) => (
                                      <option key={department} value={department}>
                                        {department}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  user.department || "—"
                                )}
                              </td>
                              <td>{fmtEmploymentType(user.employment_type)}</td>
                              <td>{user.employee_no || "—"}</td>
                              <td>
                                <select value={user.role} onChange={(e) => void updateAdminUserRole(user.id, e.target.value)}>
                                  <option value="EMPLOYEE">Employee</option>
                                  <option value="MANAGER">Manager</option>
                                  <option value="HR_MANAGER">HR Manager</option>
                                  <option value="AUTH_OFFICER">HR</option>
                                  <option value="CHIEF_OFFICER">Chief Officer</option>
                                  <option value="FINANCE">Finance</option>
                                  <option value="ADMIN">Admin</option>
                                </select>
                              </td>
                            </tr>
                          ))}
                          {adminUsers.length === 0 && (
                            <tr>
                              <td colSpan={6} style={{ textAlign: "center" }}>No users found.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </SettingsAccordion>
                </div>
              ) : (
                <div className="card" style={{ padding: 20 }}>
                  Role management is only available to administrators, managers, and chief officers.
                </div>
              )}
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

              <div className="stat-grid">
                <div className="stat-card stat-card-blue">
                  <div className="title">Pending Advances</div>
                  <div className="value">{pendingAdvCount}</div>
                </div>
                <div className="stat-card stat-card-gold">
                  <div className="title">Pending Clearances</div>
                  <div className="value">{pendingClaimCount}</div>
                </div>
                <div className="stat-card stat-card-rose">
                  <div className="title">Awaiting My Approval</div>
                  <div className="value">{inboxCount}</div>
                </div>
                <div className="stat-card stat-card-green">
                  <div className="title">Monthly Spend</div>
                  <div className="value">{fmtMoney(monthlySpend)}</div>
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
                        <td>{a.type}</td>
                        <td>{a.status}</td>
                        <td>{advanceStageLabel(a.status, a.type)}</td>
                        <td>{fmtMoney(a.requested_total)}</td>
                        <td>{fmtMoney(a.approved_total)}</td>
                        <td>
                          {(a.status === "DRAFT" || a.status === "SUBMITTED") && (
                            <button
                              className="button small-button"
                              onClick={async () => {
                                try {
                                  const detail: any = await api.advanceDetail(a.id);
                                  setEditingAdvanceId(a.id);
                                  setEditingAdvanceStatus(detail.status || a.status || null);
                                  setAdvanceType(detail.type);
                                  setSalaryAmount(detail.type === "SALARY" ? String(detail.requested_total || 0) : "0");
                                  setLoanAmount(detail.type === "LOAN" ? String(detail.requested_total || 0) : "");
                                  setTravelAmount(detail.type === "TRAVEL_SUBSISTENCE" ? String(detail.requested_total || 0) : "");
                                  setRows(
                                    detail.lines
                                      ? detail.lines.map((l: any) => {
                                          const rawLocation = String(l.location || "").trim();
                                          const parts = rawLocation.includes("→")
                                            ? rawLocation.split("→").map((part) => part.trim())
                                            : [rawLocation, rawLocation];
                                          return {
                                            date: normalizeDateInputValue(l.line_date),
                                            startDistrict: parts[0] || "",
                                            destinationDistrict: parts[1] || parts[0] || "",
                                            meals: advanceLineMealCount(l)
                                          };
                                        })
                                      : []
                                  );
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
                                  {
                                    const parsedPayment = parsePaymentAccount((detail.payment_method === "BANK" ? "BANK" : "ECOCASH"), detail.payment_account || "");
                                    setEcocashNumber(parsedPayment.ecocash_number);
                                    setBankName(parsedPayment.bank_name);
                                    setBankAccountNumber(parsedPayment.bank_account_number);
                                    setBankBranch(parsedPayment.bank_branch);
                                  }
                                  setPurpose(detail.purpose || "");
                                  setRequestDate(normalizeDateInputValue(detail.created_at) || new Date().toISOString().slice(0, 10));
                                  setRequesterName(detail.requester_name || "");
                                  setEmpNumber(detail.requester_employee_no || detail.emp_number || "");
                                  setRequestForUserId(detail.requester_id || profile?.id || me?.userId || "");
                                  setPage("ADVANCE");
                                } catch (e: any) {
                                  alert("Error loading advance: " + e.message);
                                }
                              }}
                            >
                              Edit
                            </button>
                          )}
                          {(a.status === "SUBMITTED" || a.status === "PENDING" || a.status === "DRAFT") && (
                            <button
                              className="button small-button"
                              onClick={async () => {
                                if (window.confirm("Are you sure you want to revoke this advance request?")) {
                                  try {
                                    await api.revokeAdvance(a.id);
                                    alert("Advance request revoked successfully!");
                                    await refresh();
                                  } catch (e: any) {
                                    alert("Error revoking request: " + e.message);
                                  }
                                }
                              }}
                              style={{ backgroundColor: '#dc3545', color: 'white', marginLeft: 4 }}
                            >
                              Revoke
                            </button>
                          )}
                          <button
                            className="button small-button"
                            onClick={() => showAdvanceHistory(a.id)}
                            style={{ marginLeft: 4 }}
                          >
                            Track
                          </button>
                          {a.status === "PAID" && a.type === "TRAVEL_SUBSISTENCE" && (
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
                        <td>{clearanceStageLabel(c.status)}</td>
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
          {historyOpen && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000
              }}
            >
              <div
                style={{
                  background: "var(--surface)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  width: "min(900px, 94vw)",
                  maxHeight: "80vh",
                  overflow: "auto",
                  padding: 16,
                  borderRadius: 12,
                  boxSizing: "border-box"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <h3 style={{ margin: 0 }}>Advance Tracking History</h3>
                  <button className="button small-button" onClick={() => setHistoryOpen(false)}>
                    Close
                  </button>
                </div>
                {historyLoading ? (
                  <div>Loading history...</div>
                ) : historyEvents.length === 0 ? (
                  <div>No history found for this request yet.</div>
                ) : historyEvents[0]?.error ? (
                  <div style={{ color: "crimson" }}>Error loading history: {historyEvents[0].error}</div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Actor</th>
                        <th>Action</th>
                        <th>New Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyEvents.map((e: any) => (
                        <tr key={e.id}>
                          <td>{e.created_at ? new Date(e.created_at).toLocaleString() : "-"}</td>
                          <td>{e.actor_name ? `${e.actor_name}${e.actor_role ? ` (${e.actor_role})` : ""}` : "System"}</td>
                          <td>{e.action}</td>
                          <td>{e.after_json?.status || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
