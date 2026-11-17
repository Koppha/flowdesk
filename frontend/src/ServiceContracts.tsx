import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken } from "./api";
import { showNotice } from "./alerts";
import {
  FileText, Clock, Users, Building2, AlertTriangle, Plus, ArrowLeft,
  RefreshCw, Key, Copy, Download, Settings as SettingsIcon, User, Edit3,
  Wifi, Layers, Timer, Tags, ShieldCheck, Mail, Phone, MapPin, Hash, CreditCard,
  ChevronLeft, ChevronRight, CalendarClock, Bell, Archive as ArchiveIcon,
  RotateCcw, Repeat, Activity
} from "lucide-react";
import {
  IconTabRow, FinanceFilterBar, FilterField, SearchField, FinanceEmptyState,
  ColumnChooser, useColumnVisibility, type ColumnOption
} from "./components/FinanceQueueKit";
import AssistantChart, { type AssistantChartData } from "./components/AssistantChart";

// ─── Types (mirror the backend's mapIndividualContract/mapCompanyContract) ──
type IndividualContract = {
  id: string; contractNumber: string; firstName: string; surname: string; titleCode: string | null;
  idNumber: string; birthDate: string | null; email: string | null; msisdn: string; alternativeNumber: string | null;
  accountNumber: string; physicalAddressLine1: string | null; physicalAddressLine2: string | null; physicalAddressLine3: string | null;
  keyAccountManagerEmail: string | null; serviceCategoryCode: string; servicePackageCode: string;
  servicePackageStartDate: string; contractDurationMonths: number; statusCode: string; expiryDate: string;
  isActive: boolean; createdAt: string; updatedAt: string;
};
type CompanyContract = {
  id: string; contractNumber: string; companyName: string; companyRegistrationNumber: string; contactName: string;
  contactEmail: string | null; contactNumber: string | null; contractUserName: string | null; contractUserEmail: string | null;
  contractUserBirthDate: string | null; msisdn: string | null; alternativeNumber: string | null; accountNumber: string;
  physicalAddressLine1: string | null; physicalAddressLine2: string | null; physicalAddressLine3: string | null;
  keyAccountManagerEmail: string | null; serviceCategoryCode: string; servicePackageCode: string;
  servicePackageStartDate: string; contractDurationMonths: number; statusCode: string; expiryDate: string;
  isActive: boolean; createdAt: string; updatedAt: string;
};
type ServiceCategory = { id: string; code: string; name: string; is_active: boolean };
type ServicePackage = { id: string; code: string; category_code: string; name: string; price: number; is_active: boolean };
type ContractDuration = { id: string; months: number; label: string; is_active: boolean };
type ContractStatus = { id: string; code: string; name: string; is_active: boolean };
type ApiKey = { id: string; label: string; keyPrefix: string; isActive: boolean; lastUsedAt: string | null; createdAt: string };

type ContractType = "individual" | "company";

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const el = document.createElement("a");
  el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  el.download = filename;
  el.click();
}

const PAGE_SIZE_OPTIONS = [10, 25, 50];

const INDIVIDUAL_COLUMNS: ColumnOption[] = [
  { key: "name", label: "Name", locked: true },
  { key: "title", label: "Title" },
  { key: "idNumber", label: "ID Number" },
  { key: "accountNumber", label: "Account #", locked: true },
  { key: "msisdn", label: "MSISDN" },
  { key: "altNumber", label: "Alternative Number" },
  { key: "email", label: "Email" },
  { key: "category", label: "Category" },
  { key: "package", label: "Package" },
  { key: "startDate", label: "Start Date" },
  { key: "duration", label: "Duration (Months)" },
  { key: "expiry", label: "Expiry" },
  { key: "status", label: "Status", locked: true },
  { key: "address", label: "Address" },
  { key: "kam", label: "Key Account Manager" }
];

const COMPANY_COLUMNS: ColumnOption[] = [
  { key: "company", label: "Company Name", locked: true },
  { key: "contactName", label: "Contact Name" },
  { key: "contractUserName", label: "Contract User" },
  { key: "registrationNumber", label: "Registration Number" },
  { key: "accountNumber", label: "Account #", locked: true },
  { key: "msisdn", label: "MSISDN" },
  { key: "altNumber", label: "Alternative Number" },
  { key: "contactEmail", label: "Contact Email" },
  { key: "category", label: "Category" },
  { key: "package", label: "Package" },
  { key: "startDate", label: "Start Date" },
  { key: "duration", label: "Duration (Months)" },
  { key: "expiry", label: "Expiry" },
  { key: "status", label: "Status", locked: true },
  { key: "address", label: "Address" },
  { key: "kam", label: "Key Account Manager" }
];

const STATUS_TONE: Record<string, [string, string]> = {
  OPEN: ["#d1fae5", "#065f46"],
  SUSPENDED: ["#fef3c7", "#92400e"],
  CLOSED: ["#f1f5f9", "#475569"],
  TERMINATED: ["#fee2e2", "#991b1b"]
};

function StatusBadge({ status, isActive }: { status: string; isActive?: boolean }) {
  const [bg, color] = STATUS_TONE[status] || ["#f1f5f9", "#64748b"];
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{status}</span>
      {isActive === false && <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: "#f1f5f9", color: "#64748b" }}>HIDDEN</span>}
    </span>
  );
}

const EMPTY_INDIVIDUAL_FORM = {
  firstName: "", surname: "", titleCode: "", idNumber: "", birthDate: "", email: "", msisdn: "", alternativeNumber: "",
  accountNumber: "", physicalAddressLine1: "", physicalAddressLine2: "", physicalAddressLine3: "",
  keyAccountManagerEmail: "", serviceCategoryCode: "", servicePackageCode: "", servicePackageStartDate: "",
  contractDurationMonths: "", statusCode: "OPEN"
};
const EMPTY_COMPANY_FORM = {
  companyName: "", companyRegistrationNumber: "", contactName: "", contactEmail: "", contactNumber: "",
  contractUserName: "", contractUserEmail: "", contractUserBirthDate: "", msisdn: "", alternativeNumber: "",
  accountNumber: "", physicalAddressLine1: "", physicalAddressLine2: "", physicalAddressLine3: "",
  keyAccountManagerEmail: "", serviceCategoryCode: "", servicePackageCode: "", servicePackageStartDate: "",
  contractDurationMonths: "", statusCode: "OPEN"
};

type View = "DASHBOARD" | "INDIVIDUAL" | "COMPANY" | "ARCHIVE" | "SETTINGS" | "REPORTS";
type SettingsTab = "CATEGORIES" | "PACKAGES" | "DURATIONS" | "STATUSES" | "API_KEYS" | "NOTIFICATIONS";
type FormMode = "NONE" | "CREATE" | "EDIT";

export default function ServiceContracts() {
  const me = getUserFromToken();
  const [canManage, setCanManage] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [canManageNotifications, setCanManageNotifications] = useState(false);
  const [view, setView] = useState<View>("DASHBOARD");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("CATEGORIES");

  const [individual, setIndividual] = useState<IndividualContract[]>([]);
  const [company, setCompany] = useState<CompanyContract[]>([]);
  const [archivedIndividual, setArchivedIndividual] = useState<IndividualContract[]>([]);
  const [archivedCompany, setArchivedCompany] = useState<CompanyContract[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<any>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [listPage, setListPage] = useState(1);
  const [listPageSize, setListPageSize] = useState(10);

  const [detailType, setDetailType] = useState<ContractType | null>(null);
  const [detail, setDetail] = useState<IndividualContract | CompanyContract | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [formMode, setFormMode] = useState<FormMode>("NONE");
  const [formType, setFormType] = useState<ContractType>("individual");
  const [individualForm, setIndividualForm] = useState(EMPTY_INDIVIDUAL_FORM);
  const [companyForm, setCompanyForm] = useState(EMPTY_COMPANY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [renewOpen, setRenewOpen] = useState(false);
  const [renewStartDate, setRenewStartDate] = useState("");
  const [renewDurationMonths, setRenewDurationMonths] = useState("");
  const [renewSaving, setRenewSaving] = useState(false);
  const [renewError, setRenewError] = useState<string | null>(null);

  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [packages, setPackages] = useState<ServicePackage[]>([]);
  const [durations, setDurations] = useState<ContractDuration[]>([]);
  const [statuses, setStatuses] = useState<ContractStatus[]>([]);

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const [notifEnabled, setNotifEnabled] = useState(false);
  const [notifRecipients, setNotifRecipients] = useState("");
  const [notifDaysBefore, setNotifDaysBefore] = useState("");
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifLoaded, setNotifLoaded] = useState(false);

  const [reportType, setReportType] = useState<"creation" | "expiry">("creation");
  const [reportContractType, setReportContractType] = useState<ContractType>("individual");
  const [reportStatus, setReportStatus] = useState("");
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [reportRows, setReportRows] = useState<any[]>([]);

  async function refreshLists() {
    setError(null);
    try {
      const [i, c] = await Promise.all([api.serviceContracts("individual"), api.serviceContracts("company")]);
      setIndividual(i.items || []);
      setCompany(c.items || []);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  }

  async function refreshArchive() {
    setArchiveLoading(true);
    try {
      const [i, c] = await Promise.all([
        api.serviceContracts("individual", { includeInactive: "true" }),
        api.serviceContracts("company", { includeInactive: "true" })
      ]);
      setArchivedIndividual((i.items || []).filter((x: IndividualContract) => !x.isActive));
      setArchivedCompany((c.items || []).filter((x: CompanyContract) => !x.isActive));
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setArchiveLoading(false);
    }
  }

  async function refreshDashboard() {
    try { setDashboard(await api.serviceContractsDashboard()); } catch (e: any) { setError(String(e.message)); }
  }

  async function refreshLookups() {
    try {
      const [cat, pkg, dur, st] = await Promise.all([
        api.serviceContractLookups("service-categories"),
        api.serviceContractLookups("service-packages"),
        api.serviceContractLookups("durations"),
        api.serviceContractLookups("statuses")
      ]);
      setCategories(cat.items || []);
      setPackages(pkg.items || []);
      setDurations(dur.items || []);
      setStatuses(st.items || []);
    } catch (e: any) {
      setError(String(e.message));
    }
  }

  async function refreshApiKeys() {
    try { setApiKeys((await api.serviceContractApiKeys()).items || []); } catch (e: any) { setError(String(e.message)); }
  }

  async function refreshNotificationSettings() {
    try {
      const resp = await api.serviceContractNotificationSettings();
      setNotifEnabled(Boolean(resp.enabled));
      setNotifRecipients(resp.recipients || "");
      setNotifDaysBefore(resp.daysBefore || "");
      setNotifLoaded(true);
    } catch (e: any) { setError(String(e.message)); }
  }

  async function saveNotificationSettings() {
    setNotifSaving(true);
    try {
      const resp = await api.updateServiceContractNotificationSettings({ enabled: notifEnabled, recipients: notifRecipients, daysBefore: notifDaysBefore });
      setNotifEnabled(Boolean(resp.enabled));
      setNotifRecipients(resp.recipients || "");
      setNotifDaysBefore(resp.daysBefore || "");
      showNotice("Notification settings saved.");
    } catch (e: any) {
      showNotice(e.message);
    } finally {
      setNotifSaving(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const access = await api.serviceContractsAccess();
        setCanManage(Boolean(access.canManage));
        setIsAdmin(Boolean(access.isAdmin));
        setCanManageNotifications(Boolean(access.canManageNotifications));
      } catch {}
    })();
    refreshLists();
    refreshDashboard();
    refreshLookups();
  }, []);

  useEffect(() => {
    if (view === "SETTINGS" && settingsTab === "API_KEYS" && isAdmin) refreshApiKeys();
    if (view === "SETTINGS" && settingsTab === "NOTIFICATIONS" && canManageNotifications && !notifLoaded) refreshNotificationSettings();
    if (view === "ARCHIVE" && !archiveLoaded) { setArchiveLoaded(true); refreshArchive(); }
  }, [view, settingsTab, isAdmin, canManageNotifications, notifLoaded, archiveLoaded]);

  async function openDetail(type: ContractType, id: string) {
    setDetailType(type);
    setDetailLoading(true);
    setDetail(null);
    setRenewOpen(false);
    try {
      setDetail(await api.serviceContractDetail(type, id));
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetailType(null);
    setDetail(null);
    setRenewOpen(false);
  }

  function startCreate(type: ContractType) {
    setFormType(type);
    if (type === "individual") setIndividualForm(EMPTY_INDIVIDUAL_FORM);
    else setCompanyForm(EMPTY_COMPANY_FORM);
    setSaveError(null);
    setFormMode("CREATE");
  }

  function startEditIndividual(c: IndividualContract) {
    setFormType("individual");
    setIndividualForm({
      firstName: c.firstName, surname: c.surname, titleCode: c.titleCode || "", idNumber: c.idNumber,
      birthDate: c.birthDate?.slice(0, 10) || "", email: c.email || "", msisdn: c.msisdn, alternativeNumber: c.alternativeNumber || "",
      accountNumber: c.accountNumber, physicalAddressLine1: c.physicalAddressLine1 || "", physicalAddressLine2: c.physicalAddressLine2 || "",
      physicalAddressLine3: c.physicalAddressLine3 || "", keyAccountManagerEmail: c.keyAccountManagerEmail || "",
      serviceCategoryCode: c.serviceCategoryCode, servicePackageCode: c.servicePackageCode,
      servicePackageStartDate: c.servicePackageStartDate?.slice(0, 10) || "", contractDurationMonths: String(c.contractDurationMonths),
      statusCode: c.statusCode
    });
    setSaveError(null);
    setFormMode("EDIT");
  }

  function startEditCompany(c: CompanyContract) {
    setFormType("company");
    setCompanyForm({
      companyName: c.companyName, companyRegistrationNumber: c.companyRegistrationNumber, contactName: c.contactName,
      contactEmail: c.contactEmail || "", contactNumber: c.contactNumber || "", contractUserName: c.contractUserName || "",
      contractUserEmail: c.contractUserEmail || "", contractUserBirthDate: c.contractUserBirthDate?.slice(0, 10) || "",
      msisdn: c.msisdn || "", alternativeNumber: c.alternativeNumber || "", accountNumber: c.accountNumber,
      physicalAddressLine1: c.physicalAddressLine1 || "", physicalAddressLine2: c.physicalAddressLine2 || "",
      physicalAddressLine3: c.physicalAddressLine3 || "", keyAccountManagerEmail: c.keyAccountManagerEmail || "",
      serviceCategoryCode: c.serviceCategoryCode, servicePackageCode: c.servicePackageCode,
      servicePackageStartDate: c.servicePackageStartDate?.slice(0, 10) || "", contractDurationMonths: String(c.contractDurationMonths),
      statusCode: c.statusCode
    });
    setSaveError(null);
    setFormMode("EDIT");
  }

  async function saveContract() {
    setSaveError(null);
    setSaving(true);
    try {
      if (formType === "individual") {
        const f = individualForm;
        if (!f.firstName.trim() || !f.surname.trim() || !f.idNumber.trim() || !f.msisdn.trim() || !f.accountNumber.trim() ||
            !f.serviceCategoryCode || !f.servicePackageCode || !f.servicePackageStartDate || !f.contractDurationMonths) {
          setSaveError("First name, surname, ID number, MSISDN, account number, category, package, start date and duration are required.");
          setSaving(false);
          return;
        }
        const payload = {
          firstName: f.firstName.trim(), surname: f.surname.trim(), titleCode: f.titleCode || undefined,
          idNumber: f.idNumber.trim(), birthDate: f.birthDate || undefined, email: f.email.trim() || undefined,
          msisdn: f.msisdn.trim(), alternativeNumber: f.alternativeNumber.trim() || undefined, accountNumber: f.accountNumber.trim(),
          physicalAddressLine1: f.physicalAddressLine1.trim() || undefined, physicalAddressLine2: f.physicalAddressLine2.trim() || undefined,
          physicalAddressLine3: f.physicalAddressLine3.trim() || undefined, keyAccountManagerEmail: f.keyAccountManagerEmail.trim() || undefined,
          serviceCategoryCode: f.serviceCategoryCode, servicePackageCode: f.servicePackageCode,
          servicePackageStartDate: f.servicePackageStartDate, contractDurationMonths: Number(f.contractDurationMonths),
          statusCode: f.statusCode
        };
        if (formMode === "CREATE") {
          const created = await api.createServiceContract("individual", payload);
          setFormMode("NONE");
          await refreshLists(); await refreshDashboard();
          openDetail("individual", created.id);
        } else if (formMode === "EDIT" && detail) {
          await api.updateServiceContract("individual", detail.id, payload);
          setFormMode("NONE");
          await refreshLists(); await refreshDashboard();
          openDetail("individual", detail.id);
        }
      } else {
        const f = companyForm;
        if (!f.companyName.trim() || !f.companyRegistrationNumber.trim() || !f.contactName.trim() || !f.accountNumber.trim() ||
            !f.serviceCategoryCode || !f.servicePackageCode || !f.servicePackageStartDate || !f.contractDurationMonths) {
          setSaveError("Company name, registration number, contact name, account number, category, package, start date and duration are required.");
          setSaving(false);
          return;
        }
        const payload = {
          companyName: f.companyName.trim(), companyRegistrationNumber: f.companyRegistrationNumber.trim(), contactName: f.contactName.trim(),
          contactEmail: f.contactEmail.trim() || undefined, contactNumber: f.contactNumber.trim() || undefined,
          contractUserName: f.contractUserName.trim() || undefined, contractUserEmail: f.contractUserEmail.trim() || undefined,
          contractUserBirthDate: f.contractUserBirthDate || undefined, msisdn: f.msisdn.trim() || undefined,
          alternativeNumber: f.alternativeNumber.trim() || undefined, accountNumber: f.accountNumber.trim(),
          physicalAddressLine1: f.physicalAddressLine1.trim() || undefined, physicalAddressLine2: f.physicalAddressLine2.trim() || undefined,
          physicalAddressLine3: f.physicalAddressLine3.trim() || undefined, keyAccountManagerEmail: f.keyAccountManagerEmail.trim() || undefined,
          serviceCategoryCode: f.serviceCategoryCode, servicePackageCode: f.servicePackageCode,
          servicePackageStartDate: f.servicePackageStartDate, contractDurationMonths: Number(f.contractDurationMonths),
          statusCode: f.statusCode
        };
        if (formMode === "CREATE") {
          const created = await api.createServiceContract("company", payload);
          setFormMode("NONE");
          await refreshLists(); await refreshDashboard();
          openDetail("company", created.id);
        } else if (formMode === "EDIT" && detail) {
          await api.updateServiceContract("company", detail.id, payload);
          setFormMode("NONE");
          await refreshLists(); await refreshDashboard();
          openDetail("company", detail.id);
        }
      }
    } catch (e: any) {
      setSaveError(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(type: ContractType, c: { id: string; isActive: boolean }) {
    setBusy(true);
    try {
      await api.setServiceContractActive(type, c.id, !c.isActive);
      await refreshLists();
      if (detailType === type && detail?.id === c.id) openDetail(type, c.id);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  function startRenew() {
    if (!detail) return;
    // Starts the day after the current expiry - a renewal picks up right
    // where the old term ends, not "today" (which could be weeks before
    // expiry if someone renews early).
    const next = new Date(detail.expiryDate + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    setRenewStartDate(next.toISOString().slice(0, 10));
    setRenewDurationMonths(String(detail.contractDurationMonths));
    setRenewError(null);
    setRenewOpen(true);
  }

  async function submitRenew() {
    if (!detail || !detailType) return;
    if (!renewStartDate || !renewDurationMonths) {
      setRenewError("Pick a start date and duration.");
      return;
    }
    setRenewSaving(true);
    setRenewError(null);
    try {
      const base = detailType === "individual" ? (detail as IndividualContract) : (detail as CompanyContract);
      const payload: Record<string, any> = {
        ...base,
        keyAccountManagerEmail: base.keyAccountManagerEmail || undefined,
        servicePackageStartDate: renewStartDate,
        contractDurationMonths: Number(renewDurationMonths),
        statusCode: "OPEN"
      };
      await api.updateServiceContract(detailType, detail.id, payload);
      setRenewOpen(false);
      await Promise.all([refreshLists(), refreshDashboard()]);
      await openDetail(detailType, detail.id);
      showNotice("Contract renewed.");
    } catch (e: any) {
      setRenewError(String(e.message));
    } finally {
      setRenewSaving(false);
    }
  }

  async function toggleActiveArchive(type: ContractType, c: { id: string; isActive: boolean }) {
    setBusy(true);
    try {
      await api.setServiceContractActive(type, c.id, !c.isActive);
      await Promise.all([refreshArchive(), refreshLists(), refreshDashboard()]);
      showNotice("Restored - it will now show up in the regular Individual/Company list.");
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  async function loadReport() {
    try {
      const resp = await api.serviceContractsReports({ type: reportType, contractType: reportContractType, statusCode: reportStatus, from: reportFrom, to: reportTo });
      setReportRows(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    }
  }
  useEffect(() => { if (view === "REPORTS") loadReport(); }, [view, reportType, reportContractType, reportStatus, reportFrom, reportTo]);

  const filteredIndividual = useMemo(() => {
    const q = search.trim().toLowerCase();
    return individual.filter((c) => {
      if (statusFilter && c.statusCode !== statusFilter) return false;
      if (!q) return true;
      return `${c.firstName} ${c.surname}`.toLowerCase().includes(q) || c.accountNumber.toLowerCase().includes(q) || c.contractNumber.toLowerCase().includes(q);
    });
  }, [individual, search, statusFilter]);

  const filteredCompany = useMemo(() => {
    const q = search.trim().toLowerCase();
    return company.filter((c) => {
      if (statusFilter && c.statusCode !== statusFilter) return false;
      if (!q) return true;
      return c.companyName.toLowerCase().includes(q) || c.accountNumber.toLowerCase().includes(q) || c.contractNumber.toLowerCase().includes(q);
    });
  }, [company, search, statusFilter]);

  const packagesForCategory = (categoryCode: string) => packages.filter((p) => p.category_code === categoryCode && p.is_active);
  const categoryName = (code: string) => categories.find((c) => c.code === code)?.name || code;
  const packageName = (code: string) => packages.find((p) => p.code === code)?.name || code;

  const individualColumns = useColumnVisibility("service-contracts:individual-columns", ["title", "idNumber", "altNumber", "email", "startDate", "address", "kam"]);
  const companyColumns = useColumnVisibility("service-contracts:company-columns", ["registrationNumber", "contactEmail", "altNumber", "startDate", "address", "kam"]);

  // Reset the list search/filter whenever the search field is cleared via the Reset button.
  const hasListFilters = Boolean(search.trim() || statusFilter);

  // Both lists share one page/pageSize - reset to page 1 whenever the active
  // list, search, or status filter changes, so a filter never leaves the
  // view stranded on a now-empty page further in.
  useEffect(() => { setListPage(1); }, [view, search, statusFilter]);

  const activeListLength = view === "INDIVIDUAL" ? filteredIndividual.length : filteredCompany.length;
  const listTotalPages = Math.max(1, Math.ceil(activeListLength / listPageSize));
  const listCurrentPage = Math.min(listPage, listTotalPages);
  const pagedIndividual = filteredIndividual.slice((listCurrentPage - 1) * listPageSize, listCurrentPage * listPageSize);
  const pagedCompany = filteredCompany.slice((listCurrentPage - 1) * listPageSize, listCurrentPage * listPageSize);

  // ── Dashboard extras: expiring-soon and per-category breakdown, computed
  // client-side from the already-loaded full lists so the whitespace below
  // the headline KPIs carries something actionable instead of sitting empty. ──
  const dashboardExpiringSoon = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = new Date(today); horizon.setDate(horizon.getDate() + 30);
    const all = [
      ...individual.map((c) => ({ id: c.id, type: "individual" as const, name: `${c.firstName} ${c.surname}`, expiryDate: c.expiryDate, statusCode: c.statusCode })),
      ...company.map((c) => ({ id: c.id, type: "company" as const, name: c.companyName, expiryDate: c.expiryDate, statusCode: c.statusCode }))
    ];
    return all
      .filter((c) => c.statusCode === "OPEN" && c.expiryDate)
      .map((c) => ({ ...c, expiry: new Date(c.expiryDate) }))
      .filter((c) => c.expiry >= today && c.expiry <= horizon)
      .sort((a, b) => a.expiry.getTime() - b.expiry.getTime())
      .slice(0, 8);
  }, [individual, company]);

  const dashboardByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of individual) counts.set(c.serviceCategoryCode, (counts.get(c.serviceCategoryCode) || 0) + 1);
    for (const c of company) counts.set(c.serviceCategoryCode, (counts.get(c.serviceCategoryCode) || 0) + 1);
    const rows = Array.from(counts.entries())
      .map(([code, count]) => ({ code, name: categories.find((c) => c.code === code)?.name || code, count }))
      .sort((a, b) => b.count - a.count);
    const max = rows[0]?.count || 1;
    return { rows, max };
  }, [individual, company, categories]);

  // Last 12 months: how many individual vs company contracts started in
  // each month (by service_package_start_date, which is what the legacy
  // data actually carries - created_at is just the migration timestamp for
  // everything migrated in one batch, so it wouldn't show a real trend).
  const dashboardTrend: AssistantChartData = useMemo(() => {
    const months: string[] = [];
    const base = new Date(); base.setUTCDate(1); base.setUTCHours(0, 0, 0, 0);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(base); d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const count = (rows: Array<{ servicePackageStartDate: string }>) => {
      const byMonth = new Map<string, number>();
      for (const r of rows) { const m = (r.servicePackageStartDate || "").slice(0, 7); if (m) byMonth.set(m, (byMonth.get(m) || 0) + 1); }
      return months.map((m) => byMonth.get(m) || 0);
    };
    const labels = months.map((m) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short" }));
    return {
      title: "Contracts Trend",
      type: "line",
      labels,
      series: [
        { name: "Individual", values: count(individual) },
        { name: "Company", values: count(company) }
      ]
    };
  }, [individual, company]);

  // Next 6 months: how many OPEN contracts expire in each one.
  const dashboardExpiryTrend: AssistantChartData = useMemo(() => {
    const months: string[] = [];
    const base = new Date(); base.setUTCDate(1); base.setUTCHours(0, 0, 0, 0);
    for (let i = 0; i < 6; i++) {
      const d = new Date(base); d.setUTCMonth(d.getUTCMonth() + i);
      months.push(d.toISOString().slice(0, 7));
    }
    const all = [...individual, ...company].filter((c) => c.statusCode === "OPEN" && c.expiryDate);
    const byMonth = new Map<string, number>();
    for (const c of all) { const m = c.expiryDate.slice(0, 7); byMonth.set(m, (byMonth.get(m) || 0) + 1); }
    const labels = months.map((m) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short" }));
    return {
      title: "Expiring Contracts",
      type: "line",
      labels,
      series: [{ name: "Expiring", values: months.map((m) => byMonth.get(m) || 0) }]
    };
  }, [individual, company]);

  const dashboardTopServices: AssistantChartData = useMemo(() => ({
    title: "Top Services",
    type: "bar",
    labels: dashboardByCategory.rows.map((r) => r.name),
    series: [{ name: "Contracts", values: dashboardByCategory.rows.map((r) => r.count) }]
  }), [dashboardByCategory]);

  const dashboardCategoryPie: AssistantChartData = useMemo(() => ({
    title: "Contracts by Service Category",
    type: "pie",
    labels: dashboardByCategory.rows.map((r) => r.name),
    series: [{ name: "Contracts", values: dashboardByCategory.rows.map((r) => r.count) }]
  }), [dashboardByCategory]);

  // Recent activity, derived honestly from what the data actually carries -
  // there's no dedicated audit/event log for Service Contracts (unlike
  // clearances/advances elsewhere in FlowDesk), so this is the most recent
  // contracts by creation or last update, not a real event stream.
  const dashboardRecentActivity = useMemo(() => {
    const all = [
      ...individual.map((c) => ({ id: c.id, type: "individual" as const, name: `${c.firstName} ${c.surname}`, createdAt: c.createdAt, updatedAt: c.updatedAt })),
      ...company.map((c) => ({ id: c.id, type: "company" as const, name: c.companyName, createdAt: c.createdAt, updatedAt: c.updatedAt }))
    ];
    return all
      .map((c) => {
        const created = new Date(c.createdAt).getTime();
        const updated = new Date(c.updatedAt).getTime();
        const edited = updated > created + 60_000; // more than a minute apart = a real later edit, not just the insert itself
        return { ...c, when: edited ? c.updatedAt : c.createdAt, label: edited ? "Contract updated" : "New contract added" };
      })
      .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())
      .slice(0, 6);
  }, [individual, company]);

  if (loading) return (
    <div className="ep-page">
      <div className="fin-empty" style={{ marginTop: 60 }}>
        <div className="fin-empty-icon"><RefreshCw size={26} className="rl-spin" /></div>
        <h3>Loading Service Contracts…</h3>
      </div>
    </div>
  );

  // ── Create/Edit form ────────────────────────────────────────────────────
  if (formMode !== "NONE") {
    const catOptions = categories.filter((c) => c.is_active);
    if (formType === "individual") {
      const f = individualForm;
      const set = (patch: Partial<typeof f>) => setIndividualForm((s) => ({ ...s, ...patch }));
      return (
        <div className="ep-page">
          <div className="ep-header">
            <div className="ep-header-text">
              <button className="ep-btn-outline" onClick={() => setFormMode("NONE")} style={{ marginBottom: 10 }}><ArrowLeft size={14} /> Cancel</button>
              <h1 className="ep-title">{formMode === "CREATE" ? "New Individual Service Contract" : "Edit Individual Service Contract"}</h1>
            </div>
          </div>
          {saveError && <pre className="inbox-error">{saveError}</pre>}

          <div className="review-card">
            <div className="review-card-title">Personal Details</div>
            <div className="form-grid-3">
              <label>First Name *<input value={f.firstName} onChange={(e) => set({ firstName: e.target.value })} /></label>
              <label>Surname *<input value={f.surname} onChange={(e) => set({ surname: e.target.value })} /></label>
              <label>Title<input value={f.titleCode} onChange={(e) => set({ titleCode: e.target.value })} placeholder="MR / MRS / MS" /></label>
              <label>ID Number *<input value={f.idNumber} onChange={(e) => set({ idNumber: e.target.value })} /></label>
              <label>Birth Date<input type="date" value={f.birthDate} onChange={(e) => set({ birthDate: e.target.value })} /></label>
              <label>Email<input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
            </div>
          </div>

          <div className="review-card" style={{ marginTop: 14 }}>
            <div className="review-card-title">Contact &amp; Address</div>
            <div className="form-grid-3">
              <label>MSISDN *<input value={f.msisdn} onChange={(e) => set({ msisdn: e.target.value })} /></label>
              <label>Alternative Number<input value={f.alternativeNumber} onChange={(e) => set({ alternativeNumber: e.target.value })} /></label>
              <label>Key Account Manager Email<input type="email" value={f.keyAccountManagerEmail} onChange={(e) => set({ keyAccountManagerEmail: e.target.value })} /></label>
              <label>Address Line 1<input value={f.physicalAddressLine1} onChange={(e) => set({ physicalAddressLine1: e.target.value })} /></label>
              <label>Address Line 2<input value={f.physicalAddressLine2} onChange={(e) => set({ physicalAddressLine2: e.target.value })} /></label>
              <label>Address Line 3<input value={f.physicalAddressLine3} onChange={(e) => set({ physicalAddressLine3: e.target.value })} /></label>
            </div>
          </div>

          <div className="review-card" style={{ marginTop: 14 }}>
            <div className="review-card-title">Service &amp; Billing</div>
            <div className="form-grid-3">
              <label>Account Number *<input value={f.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} /></label>
              <label>Service Category *
                <select className="ep-form-select" value={f.serviceCategoryCode} onChange={(e) => set({ serviceCategoryCode: e.target.value, servicePackageCode: "" })}>
                  <option value="">Select…</option>
                  {catOptions.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
              </label>
              <label>Service Package *
                <select className="ep-form-select" value={f.servicePackageCode} onChange={(e) => set({ servicePackageCode: e.target.value })} disabled={!f.serviceCategoryCode}>
                  <option value="">Select…</option>
                  {packagesForCategory(f.serviceCategoryCode).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                </select>
              </label>
              <label>Package Start Date *<input type="date" value={f.servicePackageStartDate} onChange={(e) => set({ servicePackageStartDate: e.target.value })} /></label>
              <label>Duration (months) *
                <select className="ep-form-select" value={f.contractDurationMonths} onChange={(e) => set({ contractDurationMonths: e.target.value })}>
                  <option value="">Select…</option>
                  {durations.filter((d) => d.is_active).map((d) => <option key={d.months} value={d.months}>{d.label}</option>)}
                </select>
              </label>
              <label>Status
                <select className="ep-form-select" value={f.statusCode} onChange={(e) => set({ statusCode: e.target.value })}>
                  {statuses.filter((s) => s.is_active).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
            <button className="button button-primary" disabled={saving} onClick={saveContract}>{saving ? "Saving…" : "Save Contract"}</button>
            <button className="button button-subtle" onClick={() => setFormMode("NONE")}>Cancel</button>
          </div>
        </div>
      );
    }
    const f = companyForm;
    const set = (patch: Partial<typeof f>) => setCompanyForm((s) => ({ ...s, ...patch }));
    return (
      <div className="ep-page">
        <div className="ep-header">
          <div className="ep-header-text">
            <button className="ep-btn-outline" onClick={() => setFormMode("NONE")} style={{ marginBottom: 10 }}><ArrowLeft size={14} /> Cancel</button>
            <h1 className="ep-title">{formMode === "CREATE" ? "New Company Service Contract" : "Edit Company Service Contract"}</h1>
          </div>
        </div>
        {saveError && <pre className="inbox-error">{saveError}</pre>}

        <div className="review-card">
          <div className="review-card-title">Company Details</div>
          <div className="form-grid-3">
            <label>Company Name *<input value={f.companyName} onChange={(e) => set({ companyName: e.target.value })} /></label>
            <label>Registration Number *<input value={f.companyRegistrationNumber} onChange={(e) => set({ companyRegistrationNumber: e.target.value })} /></label>
            <label>Contact Name *<input value={f.contactName} onChange={(e) => set({ contactName: e.target.value })} /></label>
            <label>Contact Email<input type="email" value={f.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} /></label>
            <label>Contact Number<input value={f.contactNumber} onChange={(e) => set({ contactNumber: e.target.value })} /></label>
            <label>Contract User Name<input value={f.contractUserName} onChange={(e) => set({ contractUserName: e.target.value })} /></label>
            <label>Contract User Email<input type="email" value={f.contractUserEmail} onChange={(e) => set({ contractUserEmail: e.target.value })} /></label>
            <label>Contract User Birth Date<input type="date" value={f.contractUserBirthDate} onChange={(e) => set({ contractUserBirthDate: e.target.value })} /></label>
          </div>
        </div>

        <div className="review-card" style={{ marginTop: 14 }}>
          <div className="review-card-title">Contact &amp; Address</div>
          <div className="form-grid-3">
            <label>MSISDN<input value={f.msisdn} onChange={(e) => set({ msisdn: e.target.value })} /></label>
            <label>Alternative Number<input value={f.alternativeNumber} onChange={(e) => set({ alternativeNumber: e.target.value })} /></label>
            <label>Key Account Manager Email<input type="email" value={f.keyAccountManagerEmail} onChange={(e) => set({ keyAccountManagerEmail: e.target.value })} /></label>
            <label>Address Line 1<input value={f.physicalAddressLine1} onChange={(e) => set({ physicalAddressLine1: e.target.value })} /></label>
            <label>Address Line 2<input value={f.physicalAddressLine2} onChange={(e) => set({ physicalAddressLine2: e.target.value })} /></label>
            <label>Address Line 3<input value={f.physicalAddressLine3} onChange={(e) => set({ physicalAddressLine3: e.target.value })} /></label>
          </div>
        </div>

        <div className="review-card" style={{ marginTop: 14 }}>
          <div className="review-card-title">Service &amp; Billing</div>
          <div className="form-grid-3">
            <label>Account Number *<input value={f.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} /></label>
            <label>Service Category *
              <select className="ep-form-select" value={f.serviceCategoryCode} onChange={(e) => set({ serviceCategoryCode: e.target.value, servicePackageCode: "" })}>
                <option value="">Select…</option>
                {catOptions.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <label>Service Package *
              <select className="ep-form-select" value={f.servicePackageCode} onChange={(e) => set({ servicePackageCode: e.target.value })} disabled={!f.serviceCategoryCode}>
                <option value="">Select…</option>
                {packagesForCategory(f.serviceCategoryCode).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
              </select>
            </label>
            <label>Package Start Date *<input type="date" value={f.servicePackageStartDate} onChange={(e) => set({ servicePackageStartDate: e.target.value })} /></label>
            <label>Duration (months) *
              <select className="ep-form-select" value={f.contractDurationMonths} onChange={(e) => set({ contractDurationMonths: e.target.value })}>
                <option value="">Select…</option>
                {durations.filter((d) => d.is_active).map((d) => <option key={d.months} value={d.months}>{d.label}</option>)}
              </select>
            </label>
            <label>Status
              <select className="ep-form-select" value={f.statusCode} onChange={(e) => set({ statusCode: e.target.value })}>
                {statuses.filter((s) => s.is_active).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
          <button className="button button-primary" disabled={saving} onClick={saveContract}>{saving ? "Saving…" : "Save Contract"}</button>
          <button className="button button-subtle" onClick={() => setFormMode("NONE")}>Cancel</button>
        </div>
      </div>
    );
  }

  // ── Detail overlay ──────────────────────────────────────────────────────
  if (detailType) {
    const isIndividual = detailType === "individual";
    const ind = isIndividual ? (detail as IndividualContract | null) : null;
    const com = !isIndividual ? (detail as CompanyContract | null) : null;
    return (
      <div className="ep-page">
        <div className="ep-header">
          <div className="ep-header-text">
            <button className="ep-btn-outline" onClick={closeDetail} style={{ marginBottom: 10 }}><ArrowLeft size={14} /> Back to Contracts</button>
            <h1 className="ep-title">{ind ? `${ind.firstName} ${ind.surname}` : com?.companyName || "Contract"}</h1>
            <p className="ep-subtitle">{detail?.contractNumber} &middot; Account {detail?.accountNumber}</p>
          </div>
          {canManage && detail && (
            <div className="ep-actions" style={{ gap: 8 }}>
              <button className="button small-button button-primary" onClick={startRenew}><Repeat size={14} /> Renew</button>
              <button className="button small-button button-subtle" onClick={() => (ind ? startEditIndividual(ind) : com && startEditCompany(com))}><Edit3 size={14} /> Edit</button>
              <button className="button small-button button-subtle" onClick={() => toggleActive(detailType, detail)} disabled={busy}>
                {detail.isActive ? "Hide from Portal" : "Restore Visibility"}
              </button>
            </div>
          )}
        </div>

        {error && <pre className="inbox-error">{error}</pre>}

        {renewOpen && detail && (
          <div className="review-card" style={{ marginBottom: 14, borderColor: "#2563eb" }}>
            <div className="review-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Repeat size={15} /> Renew Contract
            </div>
            <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 12px" }}>
              Currently expires {fmtDate(detail.expiryDate)}. Pick a new start date and duration - the expiry date is recalculated automatically, everything else stays the same.
            </p>
            {renewError && <pre className="inbox-error">{renewError}</pre>}
            <div className="form-grid-3">
              <label>New Start Date
                <input type="date" value={renewStartDate} onChange={(e) => setRenewStartDate(e.target.value)} />
              </label>
              <label>Duration
                <select className="ep-form-select" value={renewDurationMonths} onChange={(e) => setRenewDurationMonths(e.target.value)}>
                  {durations.filter((d) => d.is_active).map((d) => <option key={d.months} value={d.months}>{d.label}</option>)}
                </select>
              </label>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                <button className="button button-primary" disabled={renewSaving} onClick={submitRenew}>{renewSaving ? "Renewing…" : "Confirm Renewal"}</button>
                <button className="button button-subtle" onClick={() => setRenewOpen(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {detailLoading || !detail ? (
          <div className="fin-empty" style={{ marginTop: 20 }}><div className="fin-empty-icon"><RefreshCw size={22} className="rl-spin" /></div><h3>Loading…</h3></div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, margin: "4px 0 16px" }}>
              <StatusBadge status={detail.statusCode} isActive={detail.isActive} />
            </div>

            <div className="review-card">
              <div className="review-card-title">{ind ? "Personal Details" : "Company Details"}</div>
              <div className="review-field-grid">
                {ind && <>
                  <ReviewField icon={User} label="Title" value={ind.titleCode || "—"} />
                  <ReviewField icon={Hash} label="ID Number" value={ind.idNumber} />
                  <ReviewField icon={Clock} label="Birth Date" value={fmtDate(ind.birthDate)} />
                  <ReviewField icon={Mail} label="Email" value={ind.email || "—"} />
                </>}
                {com && <>
                  <ReviewField icon={Hash} label="Registration Number" value={com.companyRegistrationNumber} />
                  <ReviewField icon={User} label="Contact Name" value={com.contactName} />
                  <ReviewField icon={Mail} label="Contact Email" value={com.contactEmail || "—"} />
                  <ReviewField icon={Phone} label="Contact Number" value={com.contactNumber || "—"} />
                  <ReviewField icon={User} label="Contract User" value={com.contractUserName || "—"} />
                </>}
                <ReviewField icon={Phone} label="MSISDN" value={detail.msisdn || "—"} />
                <ReviewField icon={Phone} label="Alternative Number" value={detail.alternativeNumber || "—"} />
                <ReviewField icon={ShieldCheck} label="Key Account Manager" value={detail.keyAccountManagerEmail || "—"} />
                <ReviewField icon={MapPin} label="Physical Address" value={[detail.physicalAddressLine1, detail.physicalAddressLine2, detail.physicalAddressLine3].filter(Boolean).join(", ") || "—"} />
              </div>
            </div>

            <div className="review-card" style={{ marginTop: 14 }}>
              <div className="review-card-title">Service &amp; Billing</div>
              <div className="review-field-grid">
                <ReviewField icon={Wifi} label="Service Category" value={detail.serviceCategoryCode} />
                <ReviewField icon={Layers} label="Service Package" value={detail.servicePackageCode} />
                <ReviewField icon={CreditCard} label="Account Number" value={detail.accountNumber} />
                <ReviewField icon={Clock} label="Package Start Date" value={fmtDate(detail.servicePackageStartDate)} />
                <ReviewField icon={Timer} label="Duration" value={`${detail.contractDurationMonths} months`} />
                <ReviewField icon={AlertTriangle} label="Expiry Date" value={fmtDate(detail.expiryDate)} />
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Dashboard / Individual / Company / Settings / Reports ───────────────
  const tabs: { key: View; label: string; icon: React.ElementType }[] = [
    { key: "DASHBOARD", label: "Dashboard", icon: FileText },
    { key: "INDIVIDUAL", label: "Individual", icon: User },
    { key: "COMPANY", label: "Company", icon: Building2 },
    ...(canManage ? [{ key: "ARCHIVE" as View, label: "Archive", icon: ArchiveIcon }] : []),
    ...(canManage ? [{ key: "REPORTS" as View, label: "Reports", icon: Download }] : []),
    ...(canManage ? [{ key: "SETTINGS" as View, label: "Settings", icon: SettingsIcon }] : [])
  ];

  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Service Contracts</h1>
          <p className="ep-subtitle">Individual and company telecom service contracts — created here or synced in from another system via API.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={() => { refreshLists(); refreshDashboard(); }}><RefreshCw size={14} /> Refresh</button>
          {canManage && view === "INDIVIDUAL" && <button className="button button-primary" onClick={() => startCreate("individual")}><Plus size={14} /> New Individual Contract</button>}
          {canManage && view === "COMPANY" && <button className="button button-primary" onClick={() => startCreate("company")}><Plus size={14} /> New Company Contract</button>}
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div className="ep-tabs">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} className={`ep-tab ${view === t.key ? "active" : ""}`} onClick={() => setView(t.key)}>
              <Icon size={14} />{t.label}
            </button>
          );
        })}
      </div>

      {view === "DASHBOARD" && dashboard && (
        <>
          <div className="ep-kpi-row">
            {dashboard.stats.map((s: any) => (
              <div key={s.label} className={`ep-kpi ep-kpi-${s.tone === "red" ? "purple" : s.tone === "yellow" ? "gold" : "blue"}`}>
                <div className="ep-kpi-icon">{s.tone === "red" ? <AlertTriangle size={26} /> : s.tone === "yellow" ? <Clock size={26} /> : s.icon === "building" ? <Building2 size={26} /> : <Users size={26} />}</div>
                <div><div className="ep-kpi-value">{s.value}</div><div className="ep-kpi-label">{s.label}</div></div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)", gap: 14, marginTop: 14 }}>
            <div className="ep-panel" style={{ padding: 16 }}>
              <AssistantChart chart={dashboardTrend} />
            </div>

            <div className="ep-panel">
              <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
                <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Wifi size={16} /> Contracts by Service Category</h3>
              </div>
              {dashboardByCategory.rows.length === 0 ? (
                <p style={{ padding: "0 20px 18px", color: "var(--muted)", fontSize: 13 }}>No contracts yet.</p>
              ) : (
                <>
                  <div style={{ padding: "0 8px" }}><AssistantChart chart={dashboardCategoryPie} /></div>
                  <div style={{ padding: "0 20px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {dashboardByCategory.rows.map((r) => (
                      <div key={r.code} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>{r.name}</span>
                        <span style={{ color: "var(--muted)" }}>{r.count} · {((r.count / (dashboardByCategory.rows.reduce((s, x) => s + x.count, 0) || 1)) * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 14, marginTop: 14 }}>
            <div className="ep-panel" style={{ padding: 16 }}>
              <AssistantChart chart={dashboardTopServices} />
            </div>

            <div className="ep-panel" style={{ padding: 16 }}>
              <AssistantChart chart={dashboardExpiryTrend} />
            </div>

            <div className="ep-panel">
              <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
                <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Activity size={16} /> Recent Activity</h3>
              </div>
              <div style={{ padding: "4px 20px 16px", display: "flex", flexDirection: "column", gap: 2 }}>
                {dashboardRecentActivity.length === 0 ? (
                  <p style={{ color: "var(--muted)", fontSize: 13 }}>Nothing yet.</p>
                ) : dashboardRecentActivity.map((a) => (
                  <div key={`${a.type}-${a.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)", cursor: "pointer" }} onClick={() => openDetail(a.type, a.id)}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{a.label}</div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>{a.name}</div>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtDate(a.when)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="ep-panel" style={{ marginTop: 14 }}>
            <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
              <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><CalendarClock size={16} /> Expiring in the Next 30 Days</h3>
            </div>
            <div className="ep-table-wrap">
              {dashboardExpiringSoon.length === 0 ? (
                <FinanceEmptyState icon={CalendarClock} title="Nothing expiring soon." hint="Open contracts due to lapse in the next 30 days will show up here." />
              ) : (
                <table className="ep-table">
                  <thead><tr><th>Name</th><th>Type</th><th>Expiry</th></tr></thead>
                  <tbody>
                    {dashboardExpiringSoon.map((c) => (
                      <tr key={`${c.type}-${c.id}`} style={{ cursor: "pointer" }} onClick={() => openDetail(c.type, c.id)}>
                        <td style={{ fontWeight: 600 }}>{c.name}</td>
                        <td style={{ color: "var(--muted)" }}>{c.type === "individual" ? "Individual" : "Company"}</td>
                        <td>{fmtDate(c.expiryDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {(view === "INDIVIDUAL" || view === "COMPANY") && (
        <>
          <FinanceFilterBar onReset={() => { setSearch(""); setStatusFilter(""); }} showReset={hasListFilters}>
            <SearchField label="Search" placeholder="Name, account number, contract number…" value={search} onChange={setSearch} />
            <FilterField label="Status">
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All Statuses</option>
                {statuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            </FilterField>
          </FinanceFilterBar>

          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
            {view === "INDIVIDUAL" ? (
              <ColumnChooser columns={INDIVIDUAL_COLUMNS} show={individualColumns.show} toggle={individualColumns.toggle} reset={individualColumns.reset} />
            ) : (
              <ColumnChooser columns={COMPANY_COLUMNS} show={companyColumns.show} toggle={companyColumns.toggle} reset={companyColumns.reset} />
            )}
          </div>

          <div className="ep-panel">
            <div className="ep-table-wrap">
              {view === "INDIVIDUAL" ? (
                filteredIndividual.length === 0 ? (
                  <FinanceEmptyState icon={User} title="No individual contracts match your filters." hint="Try a different search term or status." />
                ) : (
                  <table className="ep-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        {individualColumns.show("title") && <th>Title</th>}
                        {individualColumns.show("idNumber") && <th>ID Number</th>}
                        <th>Account #</th>
                        {individualColumns.show("msisdn") && <th>MSISDN</th>}
                        {individualColumns.show("altNumber") && <th>Alt. Number</th>}
                        {individualColumns.show("email") && <th>Email</th>}
                        {individualColumns.show("category") && <th>Category</th>}
                        {individualColumns.show("package") && <th>Package</th>}
                        {individualColumns.show("startDate") && <th>Start Date</th>}
                        {individualColumns.show("duration") && <th>Duration (Months)</th>}
                        <th>Expiry</th>
                        <th>Status</th>
                        {individualColumns.show("address") && <th>Address</th>}
                        {individualColumns.show("kam") && <th>Key Account Manager</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {pagedIndividual.map((c) => (
                        <tr key={c.id} onClick={() => openDetail("individual", c.id)} style={{ cursor: "pointer", opacity: c.isActive ? 1 : 0.55 }}>
                          <td style={{ fontWeight: 600 }}>{c.firstName} {c.surname}<div style={{ fontSize: 11, color: "var(--muted)" }}>{c.contractNumber}</div></td>
                          {individualColumns.show("title") && <td>{c.titleCode || "—"}</td>}
                          {individualColumns.show("idNumber") && <td>{c.idNumber}</td>}
                          <td>{c.accountNumber}</td>
                          {individualColumns.show("msisdn") && <td>{c.msisdn || "—"}</td>}
                          {individualColumns.show("altNumber") && <td>{c.alternativeNumber || "—"}</td>}
                          {individualColumns.show("email") && <td>{c.email || "—"}</td>}
                          {individualColumns.show("category") && <td>{categoryName(c.serviceCategoryCode)}</td>}
                          {individualColumns.show("package") && <td>{packageName(c.servicePackageCode)}</td>}
                          {individualColumns.show("startDate") && <td>{fmtDate(c.servicePackageStartDate)}</td>}
                          {individualColumns.show("duration") && <td>{c.contractDurationMonths}</td>}
                          <td>{fmtDate(c.expiryDate)}</td>
                          <td><StatusBadge status={c.statusCode} isActive={c.isActive} /></td>
                          {individualColumns.show("address") && <td>{[c.physicalAddressLine1, c.physicalAddressLine2, c.physicalAddressLine3].filter(Boolean).join(", ") || "—"}</td>}
                          {individualColumns.show("kam") && <td>{c.keyAccountManagerEmail || "—"}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : (
                filteredCompany.length === 0 ? (
                  <FinanceEmptyState icon={Building2} title="No company contracts match your filters." hint="Try a different search term or status." />
                ) : (
                  <table className="ep-table">
                    <thead>
                      <tr>
                        <th>Company Name</th>
                        {companyColumns.show("contactName") && <th>Contact Name</th>}
                        {companyColumns.show("contractUserName") && <th>Contract User</th>}
                        {companyColumns.show("registrationNumber") && <th>Registration Number</th>}
                        <th>Account #</th>
                        {companyColumns.show("msisdn") && <th>MSISDN</th>}
                        {companyColumns.show("altNumber") && <th>Alt. Number</th>}
                        {companyColumns.show("contactEmail") && <th>Contact Email</th>}
                        {companyColumns.show("category") && <th>Category</th>}
                        {companyColumns.show("package") && <th>Package</th>}
                        {companyColumns.show("startDate") && <th>Start Date</th>}
                        {companyColumns.show("duration") && <th>Duration (Months)</th>}
                        <th>Expiry</th>
                        <th>Status</th>
                        {companyColumns.show("address") && <th>Address</th>}
                        {companyColumns.show("kam") && <th>Key Account Manager</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {pagedCompany.map((c) => (
                        <tr key={c.id} onClick={() => openDetail("company", c.id)} style={{ cursor: "pointer", opacity: c.isActive ? 1 : 0.55 }}>
                          <td style={{ fontWeight: 600 }}>{c.companyName}<div style={{ fontSize: 11, color: "var(--muted)" }}>{c.contractNumber}</div></td>
                          {companyColumns.show("contactName") && <td>{c.contactName || "—"}</td>}
                          {companyColumns.show("contractUserName") && <td>{c.contractUserName || "—"}</td>}
                          {companyColumns.show("registrationNumber") && <td>{c.companyRegistrationNumber || "—"}</td>}
                          <td>{c.accountNumber}</td>
                          {companyColumns.show("msisdn") && <td>{c.msisdn || "—"}</td>}
                          {companyColumns.show("altNumber") && <td>{c.alternativeNumber || "—"}</td>}
                          {companyColumns.show("contactEmail") && <td>{c.contactEmail || "—"}</td>}
                          {companyColumns.show("category") && <td>{categoryName(c.serviceCategoryCode)}</td>}
                          {companyColumns.show("package") && <td>{packageName(c.servicePackageCode)}</td>}
                          {companyColumns.show("startDate") && <td>{fmtDate(c.servicePackageStartDate)}</td>}
                          {companyColumns.show("duration") && <td>{c.contractDurationMonths}</td>}
                          <td>{fmtDate(c.expiryDate)}</td>
                          <td><StatusBadge status={c.statusCode} isActive={c.isActive} /></td>
                          {companyColumns.show("address") && <td>{[c.physicalAddressLine1, c.physicalAddressLine2, c.physicalAddressLine3].filter(Boolean).join(", ") || "—"}</td>}
                          {companyColumns.show("kam") && <td>{c.keyAccountManagerEmail || "—"}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}
            </div>
            {activeListLength > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>
                  Showing {(listCurrentPage - 1) * listPageSize + 1} to {Math.min(listCurrentPage * listPageSize, activeListLength)} of {activeListLength} entries
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <select className="ep-form-select" value={listPageSize} onChange={(e) => { setListPageSize(Number(e.target.value)); setListPage(1); }}>
                    {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
                  </select>
                  <button className="ep-btn-outline" onClick={() => setListPage((p) => Math.max(1, p - 1))} disabled={listCurrentPage === 1}><ChevronLeft size={14} /></button>
                  {Array.from({ length: listTotalPages }, (_, i) => i + 1).slice(0, 7).map((n) => (
                    <button key={n} className={`button small-button ${listCurrentPage === n ? "button-primary" : "button-subtle"}`} onClick={() => setListPage(n)}>{n}</button>
                  ))}
                  <button className="ep-btn-outline" onClick={() => setListPage((p) => Math.min(listTotalPages, p + 1))} disabled={listCurrentPage === listTotalPages}><ChevronRight size={14} /></button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {view === "ARCHIVE" && canManage && (
        <div className="ep-panel">
          <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
            <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><ArchiveIcon size={16} /> Archived Contracts</h3>
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--muted)" }}>
              Legacy duplicates found during the migration from the old Contract Management system, plus anything manually hidden from the portal.
              Not counted in the dashboard or shown in Individual/Company. Restore one if it turns out to be the record you actually need.
            </p>
          </div>
          {archiveLoading ? (
            <div style={{ padding: 20, color: "var(--muted)" }}>Loading…</div>
          ) : archivedIndividual.length === 0 && archivedCompany.length === 0 ? (
            <FinanceEmptyState icon={ArchiveIcon} title="Nothing archived." hint="Hidden contracts and migration duplicates will show up here." />
          ) : (
            <div className="ep-table-wrap">
              <table className="ep-table">
                <thead><tr><th>Type</th><th>Name</th><th>Contract #</th><th>Account #</th><th>Expiry</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {archivedIndividual.map((c) => (
                    <tr key={`i-${c.id}`} style={{ opacity: 0.75 }}>
                      <td><User size={14} style={{ verticalAlign: -2 }} /> Individual</td>
                      <td>{c.firstName} {c.surname}</td>
                      <td><code style={{ fontSize: 12 }}>{c.contractNumber}</code></td>
                      <td>{c.accountNumber}</td>
                      <td>{fmtDate(c.expiryDate)}</td>
                      <td><StatusBadge status={c.statusCode} /></td>
                      <td>
                        <button className="button small-button button-subtle" disabled={busy} onClick={() => toggleActiveArchive("individual", c)}>
                          <RotateCcw size={13} /> Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                  {archivedCompany.map((c) => (
                    <tr key={`c-${c.id}`} style={{ opacity: 0.75 }}>
                      <td><Building2 size={14} style={{ verticalAlign: -2 }} /> Company</td>
                      <td>{c.companyName}</td>
                      <td><code style={{ fontSize: 12 }}>{c.contractNumber}</code></td>
                      <td>{c.accountNumber}</td>
                      <td>{fmtDate(c.expiryDate)}</td>
                      <td><StatusBadge status={c.statusCode} /></td>
                      <td>
                        <button className="button small-button button-subtle" disabled={busy} onClick={() => toggleActiveArchive("company", c)}>
                          <RotateCcw size={13} /> Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {view === "SETTINGS" && canManage && (
        <>
          <IconTabRow<SettingsTab>
            value={settingsTab}
            onChange={setSettingsTab}
            tabs={[
              { key: "CATEGORIES", label: "Categories", count: categories.length, icon: Wifi },
              { key: "PACKAGES", label: "Packages", count: packages.length, icon: Layers },
              { key: "DURATIONS", label: "Durations", count: durations.length, icon: Timer },
              { key: "STATUSES", label: "Statuses", count: statuses.length, icon: Tags },
              ...(isAdmin ? [{ key: "API_KEYS" as SettingsTab, label: "API Keys", count: apiKeys.length, icon: Key }] : []),
              ...(canManageNotifications ? [{ key: "NOTIFICATIONS" as SettingsTab, label: "Notifications", count: notifEnabled ? 1 : 0, icon: Bell }] : [])
            ]}
          />

          {settingsTab !== "API_KEYS" && settingsTab !== "NOTIFICATIONS" && (
            <LookupsPanel
              tab={settingsTab}
              categories={categories} packages={packages} durations={durations} statuses={statuses}
              onChanged={refreshLookups}
            />
          )}

          {settingsTab === "API_KEYS" && (
            isAdmin ? (
              <div className="ep-panel" style={{ marginTop: 14 }}>
                <div className="ep-panel-header" style={{ padding: "14px 20px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                  <h3 style={{ margin: 0 }}>External API Keys</h3>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input placeholder="Label (e.g. Billing System)" value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} style={{ minWidth: 220 }} />
                    <button className="button small-button button-primary" onClick={async () => {
                      if (!newKeyLabel.trim()) return;
                      try {
                        const resp = await api.createServiceContractApiKey(newKeyLabel.trim());
                        setRevealedKey(resp.rawKey);
                        setNewKeyLabel("");
                        refreshApiKeys();
                      } catch (e: any) { setError(String(e.message)); }
                    }}><Key size={14} /> Generate Key</button>
                  </div>
                </div>
                {revealedKey && (
                  <div style={{ margin: "0 20px 16px", padding: 14, borderRadius: 8, background: "#fef3c7", border: "1px solid #fbbf24" }}>
                    <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Copy this key now — it won't be shown again.</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <code style={{ fontSize: 13, wordBreak: "break-all" }}>{revealedKey}</code>
                      <button className="ep-icon-btn" title="Copy" onClick={() => { navigator.clipboard.writeText(revealedKey); }}><Copy size={14} /></button>
                    </div>
                    <button className="button small-button button-subtle" style={{ marginTop: 10 }} onClick={() => setRevealedKey(null)}>Done</button>
                  </div>
                )}
                <div className="ep-table-wrap">
                  {apiKeys.length === 0 ? (
                    <FinanceEmptyState icon={Key} title="No API keys issued yet." hint="Generate one above for an external system to sync contracts in." />
                  ) : (
                    <table className="ep-table">
                      <thead><tr><th>Label</th><th>Key</th><th>Status</th><th>Last Used</th><th>Created</th><th /></tr></thead>
                      <tbody>
                        {apiKeys.map((k) => (
                          <tr key={k.id}>
                            <td>{k.label}</td>
                            <td><code style={{ fontSize: 12 }}>{k.keyPrefix}…</code></td>
                            <td>{k.isActive ? <span style={{ color: "#065f46", fontWeight: 700 }}>Active</span> : <span style={{ color: "#991b1b", fontWeight: 700 }}>Revoked</span>}</td>
                            <td>{k.lastUsedAt ? fmtDate(k.lastUsedAt) : "Never"}</td>
                            <td>{fmtDate(k.createdAt)}</td>
                            <td>
                              <button className="button small-button button-subtle" onClick={async () => {
                                try { await api.setServiceContractApiKeyActive(k.id, !k.isActive); refreshApiKeys(); }
                                catch (e: any) { setError(String(e.message)); }
                              }}>{k.isActive ? "Revoke" : "Reactivate"}</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            ) : (
              <div className="ep-panel" style={{ marginTop: 14, padding: 20, color: "var(--muted)" }}>Only an administrator can manage API keys.</div>
            )
          )}

          {settingsTab === "NOTIFICATIONS" && canManageNotifications && (
            <div className="ep-panel" style={{ marginTop: 14 }}>
              <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
                <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Bell size={16} /> Expiry Notification Digest</h3>
                <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--muted)" }}>
                  One email, sent to the list below, whenever open contracts hit one of the day thresholds before their expiry date.
                </p>
              </div>
              {!notifLoaded ? (
                <div style={{ padding: 20, color: "var(--muted)" }}>Loading…</div>
              ) : (
                <div style={{ padding: "6px 20px 20px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, marginBottom: 16 }}>
                    <input type="checkbox" checked={notifEnabled} onChange={(e) => setNotifEnabled(e.target.checked)} />
                    Enable expiry notifications
                  </label>
                  <div className="form-grid-2">
                    <label>Recipients (comma-separated emails)
                      <textarea
                        rows={3}
                        value={notifRecipients}
                        onChange={(e) => setNotifRecipients(e.target.value)}
                        placeholder="e.g. enterprise@etl.co.ls, billing@etl.co.ls"
                      />
                    </label>
                    <label>Days before expiry to remind (comma-separated)
                      <input
                        value={notifDaysBefore}
                        onChange={(e) => setNotifDaysBefore(e.target.value)}
                        placeholder="e.g. 90,30,7,1,0"
                      />
                      <span style={{ fontSize: 11.5, color: "var(--muted)" }}>0 means "expires today".</span>
                    </label>
                  </div>
                  <button className="button button-primary" disabled={notifSaving} onClick={saveNotificationSettings} style={{ marginTop: 6 }}>
                    {notifSaving ? "Saving…" : "Save Notification Settings"}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {view === "REPORTS" && canManage && (
        <>
          <FinanceFilterBar>
            <FilterField label="Report">
              <select value={reportType} onChange={(e) => setReportType(e.target.value as any)}>
                <option value="creation">By Creation Date</option>
                <option value="expiry">By Expiry Date</option>
              </select>
            </FilterField>
            <FilterField label="Contract Type">
              <select value={reportContractType} onChange={(e) => setReportContractType(e.target.value as any)}>
                <option value="individual">Individual</option>
                <option value="company">Company</option>
              </select>
            </FilterField>
            <FilterField label="Status">
              <select value={reportStatus} onChange={(e) => setReportStatus(e.target.value)}>
                <option value="">All Statuses</option>
                {statuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            </FilterField>
            <FilterField label="From"><input type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} /></FilterField>
            <FilterField label="To"><input type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} /></FilterField>
          </FinanceFilterBar>
          <div className="ep-panel">
            <div className="ep-panel-header" style={{ padding: "14px 20px", display: "flex", justifyContent: "flex-end" }}>
              <button className="ep-btn-outline" onClick={() => downloadCsv(
                `service-contracts-${reportType}.csv`,
                ["Contract Number", "Account Number", "Name", "Status", "Expiry Date", "Created At"],
                reportRows.map((r) => [r.contract_number, r.account_number, r.name, r.status_code, r.expiry_date, r.created_at])
              )}><Download size={14} /> Export CSV</button>
            </div>
            <div className="ep-table-wrap">
              {reportRows.length === 0 ? (
                <FinanceEmptyState icon={Download} title="No contracts in this range." hint="Widen the date range or pick a different contract type." />
              ) : (
                <table className="ep-table">
                  <thead><tr><th>Contract Number</th><th>Account #</th><th>Name</th><th>Status</th><th>Expiry</th><th>Created</th></tr></thead>
                  <tbody>
                    {reportRows.map((r) => (
                      <tr key={r.id}>
                        <td>{r.contract_number}</td><td>{r.account_number}</td><td>{r.name}</td>
                        <td><StatusBadge status={r.status_code} /></td><td>{fmtDate(r.expiry_date)}</td><td>{fmtDate(r.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ReviewField({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: React.ReactNode }) {
  return (
    <div className="review-field-item">
      <div className="review-field-icon"><Icon size={16} /></div>
      <div>
        <div className="review-field-label">{label}</div>
        <div className="review-field-value">{value}</div>
      </div>
    </div>
  );
}

// ─── Lookups admin panel (one catalog at a time, under Settings) ────────
function LookupsPanel({ tab, categories, packages, durations, statuses, onChanged }: {
  tab: SettingsTab;
  categories: ServiceCategory[]; packages: ServicePackage[]; durations: ContractDuration[]; statuses: ContractStatus[];
  onChanged: () => void;
}) {
  const [newCatCode, setNewCatCode] = useState(""); const [newCatName, setNewCatName] = useState("");
  const [newPkgCode, setNewPkgCode] = useState(""); const [newPkgCat, setNewPkgCat] = useState(""); const [newPkgName, setNewPkgName] = useState(""); const [newPkgPrice, setNewPkgPrice] = useState("");
  const [newDurMonths, setNewDurMonths] = useState(""); const [newDurLabel, setNewDurLabel] = useState("");
  const [newStatCode, setNewStatCode] = useState(""); const [newStatName, setNewStatName] = useState("");
  const [busy, setBusy] = useState(false);

  async function addCategory() {
    if (!newCatCode.trim() || !newCatName.trim()) return;
    setBusy(true);
    try { await api.createServiceContractLookup("service-categories", { code: newCatCode.trim(), name: newCatName.trim() }); setNewCatCode(""); setNewCatName(""); onChanged(); }
    catch (e: any) { showNotice(e.message); } finally { setBusy(false); }
  }
  async function addPackage() {
    if (!newPkgCode.trim() || !newPkgCat || !newPkgName.trim()) return;
    setBusy(true);
    try { await api.createServiceContractLookup("service-packages", { code: newPkgCode.trim(), categoryCode: newPkgCat, name: newPkgName.trim(), price: Number(newPkgPrice) || 0 }); setNewPkgCode(""); setNewPkgName(""); setNewPkgPrice(""); onChanged(); }
    catch (e: any) { showNotice(e.message); } finally { setBusy(false); }
  }
  async function addDuration() {
    if (!newDurMonths || !newDurLabel.trim()) return;
    setBusy(true);
    try { await api.createServiceContractLookup("durations", { months: Number(newDurMonths), label: newDurLabel.trim() }); setNewDurMonths(""); setNewDurLabel(""); onChanged(); }
    catch (e: any) { showNotice(e.message); } finally { setBusy(false); }
  }
  async function addStatus() {
    if (!newStatCode.trim() || !newStatName.trim()) return;
    setBusy(true);
    try { await api.createServiceContractLookup("statuses", { code: newStatCode.trim(), name: newStatName.trim() }); setNewStatCode(""); setNewStatName(""); onChanged(); }
    catch (e: any) { showNotice(e.message); } finally { setBusy(false); }
  }

  async function toggle(kind: "service-categories" | "service-packages" | "durations" | "statuses", id: string, payload: any) {
    setBusy(true);
    try { await api.updateServiceContractLookup(kind, id, payload); onChanged(); }
    catch (e: any) { showNotice(e.message); } finally { setBusy(false); }
  }

  if (tab === "CATEGORIES") return (
    <div className="ep-panel" style={{ marginTop: 14 }}>
      <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
        <h3 style={{ margin: 0 }}>Service Categories</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--muted)" }}>The service lines contracts can be sold under — Fibre, LTE, ADSL, and so on.</p>
      </div>
      <div className="ep-table-wrap">
        {categories.length === 0 ? <FinanceEmptyState icon={Wifi} title="No service categories yet." /> : (
          <table className="ep-table">
            <thead><tr><th>Code</th><th>Name</th><th>Active</th></tr></thead>
            <tbody>{categories.map((c) => (
              <tr key={c.id}>
                <td><code style={{ fontSize: 12 }}>{c.code}</code></td><td>{c.name}</td>
                <td><input type="checkbox" checked={c.is_active} disabled={busy} onChange={(e) => toggle("service-categories", c.id, { name: c.name, isActive: e.target.checked })} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="form-grid-3" style={{ padding: "10px 20px 18px" }}>
        <label>Code<input placeholder="e.g. FIBRE" value={newCatCode} onChange={(e) => setNewCatCode(e.target.value)} /></label>
        <label>Name<input placeholder="e.g. Fibre" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} /></label>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button className="button button-primary" disabled={busy} onClick={addCategory}><Plus size={14} /> Add Category</button>
        </div>
      </div>
    </div>
  );

  if (tab === "PACKAGES") return (
    <div className="ep-panel" style={{ marginTop: 14 }}>
      <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
        <h3 style={{ margin: 0 }}>Service Packages</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--muted)" }}>Specific plans within a category, each with its own monthly price.</p>
      </div>
      <div className="ep-table-wrap">
        {packages.length === 0 ? <FinanceEmptyState icon={Layers} title="No service packages yet." /> : (
          <table className="ep-table">
            <thead><tr><th>Code</th><th>Category</th><th>Name</th><th>Price</th><th>Active</th></tr></thead>
            <tbody>{packages.map((p) => (
              <tr key={p.id}>
                <td><code style={{ fontSize: 12 }}>{p.code}</code></td><td>{p.category_code}</td><td>{p.name}</td><td>{Number(p.price).toFixed(2)}</td>
                <td><input type="checkbox" checked={p.is_active} disabled={busy} onChange={(e) => toggle("service-packages", p.id, { name: p.name, price: Number(p.price), isActive: e.target.checked })} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="form-grid-3" style={{ padding: "10px 20px 0" }}>
        <label>Code<input placeholder="e.g. SP162" value={newPkgCode} onChange={(e) => setNewPkgCode(e.target.value)} /></label>
        <label>Category
          <select className="ep-form-select" value={newPkgCat} onChange={(e) => setNewPkgCat(e.target.value)}>
            <option value="">Select…</option>
            {categories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <label>Name<input placeholder="e.g. Unlimited 20GB" value={newPkgName} onChange={(e) => setNewPkgName(e.target.value)} /></label>
      </div>
      <div className="form-grid-3" style={{ padding: "0 20px 18px" }}>
        <label>Price<input placeholder="0.00" type="number" value={newPkgPrice} onChange={(e) => setNewPkgPrice(e.target.value)} /></label>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button className="button button-primary" disabled={busy} onClick={addPackage}><Plus size={14} /> Add Package</button>
        </div>
      </div>
    </div>
  );

  if (tab === "DURATIONS") return (
    <div className="ep-panel" style={{ marginTop: 14 }}>
      <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
        <h3 style={{ margin: 0 }}>Contract Durations</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--muted)" }}>How long a contract runs before it expires.</p>
      </div>
      <div className="ep-table-wrap">
        {durations.length === 0 ? <FinanceEmptyState icon={Timer} title="No contract durations yet." /> : (
          <table className="ep-table">
            <thead><tr><th>Months</th><th>Label</th><th>Active</th></tr></thead>
            <tbody>{durations.map((d) => (
              <tr key={d.id}>
                <td>{d.months}</td><td>{d.label}</td>
                <td><input type="checkbox" checked={d.is_active} disabled={busy} onChange={(e) => toggle("durations", d.id, { label: d.label, isActive: e.target.checked })} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="form-grid-3" style={{ padding: "10px 20px 18px" }}>
        <label>Months<input placeholder="e.g. 36" type="number" value={newDurMonths} onChange={(e) => setNewDurMonths(e.target.value)} /></label>
        <label>Label<input placeholder="e.g. 36 Months" value={newDurLabel} onChange={(e) => setNewDurLabel(e.target.value)} /></label>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button className="button button-primary" disabled={busy} onClick={addDuration}><Plus size={14} /> Add Duration</button>
        </div>
      </div>
    </div>
  );

  // STATUSES
  return (
    <div className="ep-panel" style={{ marginTop: 14 }}>
      <div className="ep-panel-header" style={{ padding: "14px 20px" }}>
        <h3 style={{ margin: 0 }}>Contract Statuses</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--muted)" }}>The lifecycle states a contract can be in.</p>
      </div>
      <div className="ep-table-wrap">
        {statuses.length === 0 ? <FinanceEmptyState icon={Tags} title="No contract statuses yet." /> : (
          <table className="ep-table">
            <thead><tr><th>Code</th><th>Name</th><th>Active</th></tr></thead>
            <tbody>{statuses.map((s) => (
              <tr key={s.id}>
                <td><StatusBadge status={s.code} /></td><td>{s.name}</td>
                <td><input type="checkbox" checked={s.is_active} disabled={busy} onChange={(e) => toggle("statuses", s.id, { name: s.name, isActive: e.target.checked })} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="form-grid-3" style={{ padding: "10px 20px 18px" }}>
        <label>Code<input placeholder="e.g. ARCHIVED" value={newStatCode} onChange={(e) => setNewStatCode(e.target.value)} /></label>
        <label>Name<input placeholder="e.g. Archived" value={newStatName} onChange={(e) => setNewStatName(e.target.value)} /></label>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button className="button button-primary" disabled={busy} onClick={addStatus}><Plus size={14} /> Add Status</button>
        </div>
      </div>
    </div>
  );
}
