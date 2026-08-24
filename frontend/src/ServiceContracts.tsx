import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken } from "./api";
import {
  FileText, Clock, Users, Building2, AlertTriangle, Search, Plus, ArrowLeft,
  RefreshCw, Key, Copy, Download, Settings as SettingsIcon
} from "lucide-react";

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

function StatusBadge({ status, isActive }: { status: string; isActive?: boolean }) {
  const map: Record<string, [string, string]> = { OPEN: ["#d1fae5", "#065f46"], SUSPENDED: ["#fef3c7", "#92400e"], CLOSED: ["#f1f5f9", "#475569"] };
  const [bg, color] = map[status] || ["#f1f5f9", "#64748b"];
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

type View = "DASHBOARD" | "INDIVIDUAL" | "COMPANY" | "LOOKUPS" | "API_KEYS" | "REPORTS";
type FormMode = "NONE" | "CREATE" | "EDIT";

export default function ServiceContracts() {
  const me = getUserFromToken();
  const [canManage, setCanManage] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [view, setView] = useState<View>("DASHBOARD");

  const [individual, setIndividual] = useState<IndividualContract[]>([]);
  const [company, setCompany] = useState<CompanyContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<any>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

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

  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [packages, setPackages] = useState<ServicePackage[]>([]);
  const [durations, setDurations] = useState<ContractDuration[]>([]);
  const [statuses, setStatuses] = useState<ContractStatus[]>([]);

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const [reportType, setReportType] = useState<"creation" | "expiry">("creation");
  const [reportContractType, setReportContractType] = useState<ContractType>("individual");
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

  useEffect(() => {
    (async () => {
      try {
        const access = await api.serviceContractsAccess();
        setCanManage(Boolean(access.canManage));
        setIsAdmin(Boolean(access.isAdmin));
      } catch {}
    })();
    refreshLists();
    refreshDashboard();
    refreshLookups();
  }, []);

  useEffect(() => {
    if (view === "API_KEYS" && isAdmin) refreshApiKeys();
  }, [view, isAdmin]);

  async function openDetail(type: ContractType, id: string) {
    setDetailType(type);
    setDetailLoading(true);
    setDetail(null);
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

  async function loadReport() {
    try {
      const resp = await api.serviceContractsReports({ type: reportType, contractType: reportContractType, from: reportFrom, to: reportTo });
      setReportRows(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    }
  }
  useEffect(() => { if (view === "REPORTS") loadReport(); }, [view, reportType, reportContractType, reportFrom, reportTo]);

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

  if (loading) return <div className="ep-page"><p>Loading service contracts…</p></div>;

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
            <p className="ep-subtitle">{detail?.contractNumber} &middot; {detail?.accountNumber}</p>
          </div>
          {canManage && detail && (
            <div className="ep-actions" style={{ gap: 8 }}>
              <button className="button small-button button-subtle" onClick={() => (ind ? startEditIndividual(ind) : com && startEditCompany(com))}>Edit</button>
              <button className="button small-button button-subtle" onClick={() => toggleActive(detailType, detail)} disabled={busy}>
                {detail.isActive ? "Hide from Portal" : "Restore Visibility"}
              </button>
            </div>
          )}
        </div>

        {error && <pre className="inbox-error">{error}</pre>}

        {detailLoading || !detail ? <p>Loading…</p> : (
          <div className="ep-panel" style={{ marginTop: 14, padding: 18 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <StatusBadge status={detail.statusCode} isActive={detail.isActive} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, fontSize: 13.5 }}>
              {ind && <>
                <Field label="Title">{ind.titleCode || "—"}</Field>
                <Field label="ID Number">{ind.idNumber}</Field>
                <Field label="Birth Date">{fmtDate(ind.birthDate)}</Field>
                <Field label="Email">{ind.email || "—"}</Field>
              </>}
              {com && <>
                <Field label="Registration Number">{com.companyRegistrationNumber}</Field>
                <Field label="Contact Name">{com.contactName}</Field>
                <Field label="Contact Email">{com.contactEmail || "—"}</Field>
                <Field label="Contact Number">{com.contactNumber || "—"}</Field>
                <Field label="Contract User">{com.contractUserName || "—"}</Field>
              </>}
              <Field label="MSISDN">{detail.msisdn || "—"}</Field>
              <Field label="Alternative Number">{detail.alternativeNumber || "—"}</Field>
              <Field label="Key Account Manager">{detail.keyAccountManagerEmail || "—"}</Field>
              <Field label="Service Category">{detail.serviceCategoryCode}</Field>
              <Field label="Service Package">{detail.servicePackageCode}</Field>
              <Field label="Package Start Date">{fmtDate(detail.servicePackageStartDate)}</Field>
              <Field label="Duration">{detail.contractDurationMonths} months</Field>
              <Field label="Expiry Date">{fmtDate(detail.expiryDate)}</Field>
              <Field label="Physical Address">{[detail.physicalAddressLine1, detail.physicalAddressLine2, detail.physicalAddressLine3].filter(Boolean).join(", ") || "—"}</Field>
            </div>
          </div>
        )}
      </div>
    );
  }

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
          <div className="ep-panel" style={{ padding: 20 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
              <label>First Name *<input value={f.firstName} onChange={(e) => set({ firstName: e.target.value })} /></label>
              <label>Surname *<input value={f.surname} onChange={(e) => set({ surname: e.target.value })} /></label>
              <label>Title<input value={f.titleCode} onChange={(e) => set({ titleCode: e.target.value })} placeholder="MR / MRS / MS" /></label>
              <label>ID Number *<input value={f.idNumber} onChange={(e) => set({ idNumber: e.target.value })} /></label>
              <label>Birth Date<input type="date" value={f.birthDate} onChange={(e) => set({ birthDate: e.target.value })} /></label>
              <label>Email<input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
              <label>MSISDN *<input value={f.msisdn} onChange={(e) => set({ msisdn: e.target.value })} /></label>
              <label>Alternative Number<input value={f.alternativeNumber} onChange={(e) => set({ alternativeNumber: e.target.value })} /></label>
              <label>Account Number *<input value={f.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} /></label>
              <label>Key Account Manager Email<input type="email" value={f.keyAccountManagerEmail} onChange={(e) => set({ keyAccountManagerEmail: e.target.value })} /></label>
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
              <label>Address Line 1<input value={f.physicalAddressLine1} onChange={(e) => set({ physicalAddressLine1: e.target.value })} /></label>
              <label>Address Line 2<input value={f.physicalAddressLine2} onChange={(e) => set({ physicalAddressLine2: e.target.value })} /></label>
              <label>Address Line 3<input value={f.physicalAddressLine3} onChange={(e) => set({ physicalAddressLine3: e.target.value })} /></label>
            </div>
            <div style={{ marginTop: 24, display: "flex", gap: 10 }}>
              <button className="button button-primary" disabled={saving} onClick={saveContract}>{saving ? "Saving…" : "Save Contract"}</button>
              <button className="button button-subtle" onClick={() => setFormMode("NONE")}>Cancel</button>
            </div>
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
        <div className="ep-panel" style={{ padding: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
            <label>Company Name *<input value={f.companyName} onChange={(e) => set({ companyName: e.target.value })} /></label>
            <label>Registration Number *<input value={f.companyRegistrationNumber} onChange={(e) => set({ companyRegistrationNumber: e.target.value })} /></label>
            <label>Contact Name *<input value={f.contactName} onChange={(e) => set({ contactName: e.target.value })} /></label>
            <label>Contact Email<input type="email" value={f.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} /></label>
            <label>Contact Number<input value={f.contactNumber} onChange={(e) => set({ contactNumber: e.target.value })} /></label>
            <label>Contract User Name<input value={f.contractUserName} onChange={(e) => set({ contractUserName: e.target.value })} /></label>
            <label>Contract User Email<input type="email" value={f.contractUserEmail} onChange={(e) => set({ contractUserEmail: e.target.value })} /></label>
            <label>Contract User Birth Date<input type="date" value={f.contractUserBirthDate} onChange={(e) => set({ contractUserBirthDate: e.target.value })} /></label>
            <label>MSISDN<input value={f.msisdn} onChange={(e) => set({ msisdn: e.target.value })} /></label>
            <label>Alternative Number<input value={f.alternativeNumber} onChange={(e) => set({ alternativeNumber: e.target.value })} /></label>
            <label>Account Number *<input value={f.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} /></label>
            <label>Key Account Manager Email<input type="email" value={f.keyAccountManagerEmail} onChange={(e) => set({ keyAccountManagerEmail: e.target.value })} /></label>
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
            <label>Address Line 1<input value={f.physicalAddressLine1} onChange={(e) => set({ physicalAddressLine1: e.target.value })} /></label>
            <label>Address Line 2<input value={f.physicalAddressLine2} onChange={(e) => set({ physicalAddressLine2: e.target.value })} /></label>
            <label>Address Line 3<input value={f.physicalAddressLine3} onChange={(e) => set({ physicalAddressLine3: e.target.value })} /></label>
          </div>
          <div style={{ marginTop: 24, display: "flex", gap: 10 }}>
            <button className="button button-primary" disabled={saving} onClick={saveContract}>{saving ? "Saving…" : "Save Contract"}</button>
            <button className="button button-subtle" onClick={() => setFormMode("NONE")}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Dashboard / Individual / Company / Lookups / API Keys / Reports ────
  const tabs: View[] = canManage ? ["DASHBOARD", "INDIVIDUAL", "COMPANY", "LOOKUPS", "API_KEYS", "REPORTS"] : ["DASHBOARD", "INDIVIDUAL", "COMPANY"];
  const tabLabel: Record<View, string> = { DASHBOARD: "Dashboard", INDIVIDUAL: "Individual", COMPANY: "Company", LOOKUPS: "Lookups", API_KEYS: "API Keys", REPORTS: "Reports" };

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
        {tabs.map((v) => <button key={v} className={`ep-tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>{tabLabel[v]}</button>)}
      </div>

      {view === "DASHBOARD" && dashboard && (
        <div className="ep-kpi-row">
          {dashboard.stats.map((s: any) => (
            <div key={s.label} className={`ep-kpi ep-kpi-${s.tone === "red" ? "purple" : s.tone === "yellow" ? "gold" : "blue"}`}>
              <div className="ep-kpi-icon">{s.tone === "red" ? <AlertTriangle size={26} /> : s.tone === "yellow" ? <Clock size={26} /> : s.icon === "building" ? <Building2 size={26} /> : <Users size={26} />}</div>
              <div><div className="ep-kpi-value">{s.value}</div><div className="ep-kpi-label">{s.label}</div></div>
            </div>
          ))}
        </div>
      )}

      {(view === "INDIVIDUAL" || view === "COMPANY") && (
        <div className="ep-panel" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
            <div className="ep-search" style={{ flex: "1 1 220px" }}>
              <Search size={14} />
              <input placeholder="Search name, account number, contract number…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select className="ep-form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ minWidth: 160 }}>
              <option value="">All Statuses</option>
              {statuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </div>
          <div className="ep-table-wrap">
            {view === "INDIVIDUAL" ? (
              <table className="ep-table">
                <thead><tr><th>Name</th><th>Account #</th><th>Package</th><th>Expiry</th><th>Status</th></tr></thead>
                <tbody>
                  {filteredIndividual.length === 0 ? (
                    <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No individual contracts match your filters.</td></tr>
                  ) : filteredIndividual.map((c) => (
                    <tr key={c.id} onClick={() => openDetail("individual", c.id)} style={{ cursor: "pointer", opacity: c.isActive ? 1 : 0.55 }}>
                      <td style={{ fontWeight: 600 }}>{c.firstName} {c.surname}<div style={{ fontSize: 11, color: "var(--muted)" }}>{c.contractNumber}</div></td>
                      <td>{c.accountNumber}</td>
                      <td>{c.servicePackageCode}</td>
                      <td>{fmtDate(c.expiryDate)}</td>
                      <td><StatusBadge status={c.statusCode} isActive={c.isActive} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="ep-table">
                <thead><tr><th>Company</th><th>Account #</th><th>Package</th><th>Expiry</th><th>Status</th></tr></thead>
                <tbody>
                  {filteredCompany.length === 0 ? (
                    <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No company contracts match your filters.</td></tr>
                  ) : filteredCompany.map((c) => (
                    <tr key={c.id} onClick={() => openDetail("company", c.id)} style={{ cursor: "pointer", opacity: c.isActive ? 1 : 0.55 }}>
                      <td style={{ fontWeight: 600 }}>{c.companyName}<div style={{ fontSize: 11, color: "var(--muted)" }}>{c.contractNumber}</div></td>
                      <td>{c.accountNumber}</td>
                      <td>{c.servicePackageCode}</td>
                      <td>{fmtDate(c.expiryDate)}</td>
                      <td><StatusBadge status={c.statusCode} isActive={c.isActive} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {view === "LOOKUPS" && canManage && (
        <LookupsPanel
          categories={categories} packages={packages} durations={durations} statuses={statuses}
          onChanged={refreshLookups}
        />
      )}

      {view === "API_KEYS" && canManage && (
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
              <table className="ep-table">
                <thead><tr><th>Label</th><th>Key</th><th>Status</th><th>Last Used</th><th>Created</th><th /></tr></thead>
                <tbody>
                  {apiKeys.length === 0 ? (
                    <tr><td colSpan={6} style={{ color: "var(--muted)" }}>No API keys issued yet.</td></tr>
                  ) : apiKeys.map((k) => (
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
            </div>
          </div>
        ) : (
          <div className="ep-panel" style={{ marginTop: 14, padding: 20, color: "var(--muted)" }}>Only an administrator can manage API keys.</div>
        )
      )}

      {view === "REPORTS" && canManage && (
        <div className="ep-panel" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 10, padding: "14px 20px", flexWrap: "wrap", alignItems: "center" }}>
            <select className="ep-form-select" value={reportType} onChange={(e) => setReportType(e.target.value as any)}>
              <option value="creation">By Creation Date</option>
              <option value="expiry">By Expiry Date</option>
            </select>
            <select className="ep-form-select" value={reportContractType} onChange={(e) => setReportContractType(e.target.value as any)}>
              <option value="individual">Individual</option>
              <option value="company">Company</option>
            </select>
            <input type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} />
            <input type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} />
            <button className="ep-btn-outline" onClick={() => downloadCsv(
              `service-contracts-${reportType}.csv`,
              ["Contract Number", "Account Number", "Name", "Status", "Expiry Date", "Created At"],
              reportRows.map((r) => [r.contract_number, r.account_number, r.name, r.status_code, r.expiry_date, r.created_at])
            )}><Download size={14} /> Export</button>
          </div>
          <div className="ep-table-wrap">
            <table className="ep-table">
              <thead><tr><th>Contract Number</th><th>Account #</th><th>Name</th><th>Status</th><th>Expiry</th><th>Created</th></tr></thead>
              <tbody>
                {reportRows.length === 0 ? (
                  <tr><td colSpan={6} style={{ color: "var(--muted)" }}>No contracts in this range.</td></tr>
                ) : reportRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.contract_number}</td><td>{r.account_number}</td><td>{r.name}</td>
                    <td><StatusBadge status={r.status_code} /></td><td>{fmtDate(r.expiry_date)}</td><td>{fmtDate(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>{children}</div>;
}

// ─── Lookups admin panel ────────────────────────────────────────────────
function LookupsPanel({ categories, packages, durations, statuses, onChanged }: {
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
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  }
  async function addPackage() {
    if (!newPkgCode.trim() || !newPkgCat || !newPkgName.trim()) return;
    setBusy(true);
    try { await api.createServiceContractLookup("service-packages", { code: newPkgCode.trim(), categoryCode: newPkgCat, name: newPkgName.trim(), price: Number(newPkgPrice) || 0 }); setNewPkgCode(""); setNewPkgName(""); setNewPkgPrice(""); onChanged(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  }
  async function addDuration() {
    if (!newDurMonths || !newDurLabel.trim()) return;
    setBusy(true);
    try { await api.createServiceContractLookup("durations", { months: Number(newDurMonths), label: newDurLabel.trim() }); setNewDurMonths(""); setNewDurLabel(""); onChanged(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  }
  async function addStatus() {
    if (!newStatCode.trim() || !newStatName.trim()) return;
    setBusy(true);
    try { await api.createServiceContractLookup("statuses", { code: newStatCode.trim(), name: newStatName.trim() }); setNewStatCode(""); setNewStatName(""); onChanged(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  }

  async function toggle(kind: "service-categories" | "service-packages" | "durations" | "statuses", id: string, payload: any) {
    setBusy(true);
    try { await api.updateServiceContractLookup(kind, id, payload); onChanged(); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
      <div className="ep-panel">
        <div className="ep-panel-header" style={{ padding: "14px 20px" }}><h3 style={{ margin: 0 }}><SettingsIcon size={16} style={{ verticalAlign: -3 }} /> Service Categories</h3></div>
        <div className="ep-table-wrap"><table className="ep-table">
          <thead><tr><th>Code</th><th>Name</th><th>Active</th></tr></thead>
          <tbody>{categories.map((c) => (
            <tr key={c.id}>
              <td>{c.code}</td><td>{c.name}</td>
              <td><input type="checkbox" checked={c.is_active} disabled={busy} onChange={(e) => toggle("service-categories", c.id, { name: c.name, isActive: e.target.checked })} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div style={{ display: "flex", gap: 8, padding: "10px 20px 16px" }}>
          <input placeholder="Code" value={newCatCode} onChange={(e) => setNewCatCode(e.target.value)} style={{ maxWidth: 100 }} />
          <input placeholder="Name" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} style={{ flex: 1 }} />
          <button className="ep-btn-outline" disabled={busy} onClick={addCategory}><Plus size={14} /> Add</button>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-panel-header" style={{ padding: "14px 20px" }}><h3 style={{ margin: 0 }}><SettingsIcon size={16} style={{ verticalAlign: -3 }} /> Service Packages</h3></div>
        <div className="ep-table-wrap"><table className="ep-table">
          <thead><tr><th>Code</th><th>Category</th><th>Name</th><th>Price</th><th>Active</th></tr></thead>
          <tbody>{packages.map((p) => (
            <tr key={p.id}>
              <td>{p.code}</td><td>{p.category_code}</td><td>{p.name}</td><td>{Number(p.price).toFixed(2)}</td>
              <td><input type="checkbox" checked={p.is_active} disabled={busy} onChange={(e) => toggle("service-packages", p.id, { name: p.name, price: Number(p.price), isActive: e.target.checked })} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div style={{ display: "flex", gap: 8, padding: "10px 20px 16px", flexWrap: "wrap" }}>
          <input placeholder="Code" value={newPkgCode} onChange={(e) => setNewPkgCode(e.target.value)} style={{ maxWidth: 140 }} />
          <select className="ep-form-select" value={newPkgCat} onChange={(e) => setNewPkgCat(e.target.value)} style={{ maxWidth: 140 }}>
            <option value="">Category…</option>
            {categories.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select>
          <input placeholder="Name" value={newPkgName} onChange={(e) => setNewPkgName(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <input placeholder="Price" type="number" value={newPkgPrice} onChange={(e) => setNewPkgPrice(e.target.value)} style={{ maxWidth: 100 }} />
          <button className="ep-btn-outline" disabled={busy} onClick={addPackage}><Plus size={14} /> Add</button>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-panel-header" style={{ padding: "14px 20px" }}><h3 style={{ margin: 0 }}><SettingsIcon size={16} style={{ verticalAlign: -3 }} /> Contract Durations</h3></div>
        <div className="ep-table-wrap"><table className="ep-table">
          <thead><tr><th>Months</th><th>Label</th><th>Active</th></tr></thead>
          <tbody>{durations.map((d) => (
            <tr key={d.id}>
              <td>{d.months}</td><td>{d.label}</td>
              <td><input type="checkbox" checked={d.is_active} disabled={busy} onChange={(e) => toggle("durations", d.id, { label: d.label, isActive: e.target.checked })} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div style={{ display: "flex", gap: 8, padding: "10px 20px 16px" }}>
          <input placeholder="Months" type="number" value={newDurMonths} onChange={(e) => setNewDurMonths(e.target.value)} style={{ maxWidth: 100 }} />
          <input placeholder="Label" value={newDurLabel} onChange={(e) => setNewDurLabel(e.target.value)} style={{ flex: 1 }} />
          <button className="ep-btn-outline" disabled={busy} onClick={addDuration}><Plus size={14} /> Add</button>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-panel-header" style={{ padding: "14px 20px" }}><h3 style={{ margin: 0 }}><SettingsIcon size={16} style={{ verticalAlign: -3 }} /> Contract Statuses</h3></div>
        <div className="ep-table-wrap"><table className="ep-table">
          <thead><tr><th>Code</th><th>Name</th><th>Active</th></tr></thead>
          <tbody>{statuses.map((s) => (
            <tr key={s.id}>
              <td>{s.code}</td><td>{s.name}</td>
              <td><input type="checkbox" checked={s.is_active} disabled={busy} onChange={(e) => toggle("statuses", s.id, { name: s.name, isActive: e.target.checked })} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div style={{ display: "flex", gap: 8, padding: "10px 20px 16px" }}>
          <input placeholder="Code" value={newStatCode} onChange={(e) => setNewStatCode(e.target.value)} style={{ maxWidth: 100 }} />
          <input placeholder="Name" value={newStatName} onChange={(e) => setNewStatName(e.target.value)} style={{ flex: 1 }} />
          <button className="ep-btn-outline" disabled={busy} onClick={addStatus}><Plus size={14} /> Add</button>
        </div>
      </div>
    </div>
  );
}
