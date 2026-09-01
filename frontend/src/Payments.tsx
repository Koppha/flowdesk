import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken, openBlobInNewTab } from "./api";
import { formatMoney, isFinanceDeptClient } from "./constants";
import { Clock, CheckCircle, Wallet, FileText, Search, ChevronLeft, ChevronRight, XCircle } from "lucide-react";

const PAGE_SIZE_OPTIONS = [10, 25, 50];

interface PaymentItem {
  doc_type: "ADVANCE" | "ACCOMMODATION";
  id: string;
  status: string;
  payment_status: "PENDING" | "PAID";
  type: string;
  currency: string;
  requested_total: number;
  approved_total: number;
  purpose: string | null;
  requester_name: string | null;
  department: string | null;
  division: string | null;
  created_at: string;
  paid_at: string | null;
  paid_reference: string | null;
  approved_by_name: string | null;
  pdf_filename: string;
}

function requestNumber(item: PaymentItem) {
  const created = new Date(item.created_at || Date.now());
  const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear();
  const digits = String(item.id || "").replace(/\D/g, "").slice(-5);
  const fallback = String(item.id || "00000").replace(/-/g, "").slice(0, 5).toUpperCase();
  const prefix = item.doc_type === "ACCOMMODATION" ? "ACC" : "ADV";
  return `${prefix}-${year}-${(digits || fallback || "00000").padStart(5, "0")}`;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function StatusBadge({ status }: { status: "PENDING" | "PAID" }) {
  const [bg, color, label] = status === "PAID" ? ["#d1fae5", "#065f46", "Paid"] : ["#fef3c7", "#92400e", "Pending"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{label}</span>;
}

export default function Payments(props: { onBack?: () => void }) {
  const me = getUserFromToken();
  const isAdmin = me?.role === "ADMIN";
  // Viewing Payments can be granted to any group (e.g. HR Operations, for
  // visibility only); advance payment actions remain Finance-only. Admin is
  // additionally authorized for accommodation payment actions server-side.
  const isFinancePaymentActor = isFinanceDeptClient(me?.department || "");
  const canProcessPayment = (item: PaymentItem) => isFinancePaymentActor || (isAdmin && item.doc_type === "ACCOMMODATION");

  const [items, setItems] = useState<PaymentItem[]>([]);
  const [tab, setTab] = useState<"pending" | "paid">("pending");
  // Company/division filter (MNO / SEFS / HigherLife) - lets Finance work
  // one company's payment queue at a time, same as the Capture Inbox tabs.
  const [divisionFilter, setDivisionFilter] = useState<"ALL" | "MNO" | "SEFS" | "HigherLife">("ALL");
  const [documentFilter, setDocumentFilter] = useState<"ALL" | "ADVANCE" | "ACCOMMODATION">("ALL");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<PaymentItem | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  async function refresh() {
    setError(null);
    try {
      const resp = await api.payments({ status: "all", limit: 200 });
      setItems(resp.items || []);
    } catch (e: any) {
      setError(String(e.message));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Totals are grouped by currency rather than blended into one number —
  // an LSL and a USD advance summed together and labelled with one
  // currency symbol would be meaningless.
  function valueByCurrency(list: PaymentItem[]) {
    const totals = new Map<string, number>();
    for (const i of list) {
      const currency = i.currency || "LSL";
      totals.set(currency, (totals.get(currency) || 0) + Number(i.approved_total || i.requested_total || 0));
    }
    return Array.from(totals.entries());
  }

  const divisionCounts = useMemo(() => {
    const counts: Record<string, number> = { MNO: 0, SEFS: 0, HigherLife: 0 };
    for (const i of items) {
      if (i.division && i.division in counts) counts[i.division]++;
    }
    return counts;
  }, [items]);

  const companyFiltered = useMemo(
    () => (divisionFilter === "ALL" ? items : items.filter((i) => i.division === divisionFilter)),
    [items, divisionFilter]
  );

  const documentCounts = useMemo(() => ({
    ADVANCE: companyFiltered.filter((i) => i.doc_type === "ADVANCE").length,
    ACCOMMODATION: companyFiltered.filter((i) => i.doc_type === "ACCOMMODATION").length
  }), [companyFiltered]);

  const documentFiltered = useMemo(
    () => documentFilter === "ALL" ? companyFiltered : companyFiltered.filter((i) => i.doc_type === documentFilter),
    [companyFiltered, documentFilter]
  );

  const stats = useMemo(() => ({
    pending: documentFiltered.filter((i) => i.payment_status === "PENDING").length,
    pendingValueByCurrency: valueByCurrency(documentFiltered.filter((i) => i.payment_status === "PENDING")),
    paid: documentFiltered.filter((i) => i.payment_status === "PAID").length,
    paidValueByCurrency: valueByCurrency(documentFiltered.filter((i) => i.payment_status === "PAID"))
  }), [documentFiltered]);

  const filtered = useMemo(() => {
    const byTab = documentFiltered.filter((i) => i.payment_status === tab.toUpperCase());
    if (!search.trim()) return byTab;
    const q = search.toLowerCase();
    return byTab.filter((i) =>
      requestNumber(i).toLowerCase().includes(q) ||
      (i.requester_name || "").toLowerCase().includes(q) ||
      (i.purpose || "").toLowerCase().includes(q) ||
      (i.department || "").toLowerCase().includes(q) ||
      (i.paid_reference || "").toLowerCase().includes(q)
    );
  }, [documentFiltered, tab, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  async function handleMarkPaid(item: PaymentItem) {
    setBusy(true);
    setError(null);
    try {
      if (item.doc_type === "ACCOMMODATION") await api.markAccommodationPaid(item.id);
      else await api.markAdvancePaid(item.id);
      await refresh();
      setSelected(null);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  async function handleDecline(item: PaymentItem) {
    if (!declineReason.trim()) {
      setError("Enter a reason for declining this payment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (item.doc_type === "ACCOMMODATION") await api.rejectAccommodation(item.id, declineReason.trim());
      else await api.rejectAdvance(item.id, declineReason.trim());
      await refresh();
      setSelected(null);
      setDeclineReason("");
      setDeclining(false);
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ep-page">
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Payments</h1>
          <p className="ep-subtitle">Advance and accommodation requests awaiting payment, and payment history.</p>
        </div>
        <div className="ep-actions">
          {props.onBack && (
            <button className="ep-btn-outline" onClick={props.onBack}>Back</button>
          )}
          <button className="ep-btn-outline" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      <div className="ep-kpi-row">
        <div className="stat-card stat-card-gold">
          <span className="stat-icon"><Clock size={28} /></span>
          <div>
            <div className="stat-value">{stats.pending}</div><div className="stat-label">Pending Payment</div>
            {stats.pendingValueByCurrency.length === 0
              ? <small>{formatMoney(0)}</small>
              : stats.pendingValueByCurrency.map(([currency, value]) => <small key={currency} style={{ display: "block" }}>{formatMoney(value, currency)}</small>)}
          </div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle size={28} /></span>
          <div>
            <div className="stat-value">{stats.paid}</div><div className="stat-label">Paid</div>
            {stats.paidValueByCurrency.length === 0
              ? <small>{formatMoney(0)}</small>
              : stats.paidValueByCurrency.map(([currency, value]) => <small key={currency} style={{ display: "block" }}>{formatMoney(value, currency)}</small>)}
          </div>
        </div>
      </div>

      <div className="ep-tabs" style={{ marginBottom: 8 }}>
        {([
          { key: "ALL", label: "All Companies" },
          { key: "MNO", label: "MNO" },
          { key: "SEFS", label: "SEFS" },
          { key: "HigherLife", label: "HigherLife" }
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            className={`ep-tab ${divisionFilter === t.key ? "active" : ""}`}
            onClick={() => { setDivisionFilter(t.key); setPage(1); }}
          >
            {t.label}
            <span className="inbox-count-chip">{t.key === "ALL" ? items.length : divisionCounts[t.key]}</span>
          </button>
        ))}
      </div>

      <div className="ep-tabs">
        <button type="button" className={`ep-tab ${tab === "pending" ? "active" : ""}`} onClick={() => { setTab("pending"); setPage(1); }}>
          Pending <span className="inbox-count-chip">{stats.pending}</span>
        </button>
        <button type="button" className={`ep-tab ${tab === "paid" ? "active" : ""}`} onClick={() => { setTab("paid"); setPage(1); }}>
          Paid <span className="inbox-count-chip">{stats.paid}</span>
        </button>
      </div>

      <div className="ep-tabs" style={{ marginTop: 8 }}>
        {([
          { key: "ALL", label: "All Documents" },
          { key: "ADVANCE", label: "Advance" },
          { key: "ACCOMMODATION", label: "Accommodation" }
        ] as const).map((document) => (
          <button
            key={document.key}
            type="button"
            className={`ep-tab ${documentFilter === document.key ? "active" : ""}`}
            onClick={() => { setDocumentFilter(document.key); setPage(1); }}
          >
            {document.label}
            <span className="inbox-count-chip">
              {document.key === "ALL" ? companyFiltered.length : documentCounts[document.key]}
            </span>
          </button>
        ))}
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div className="ep-filter-bar" style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px" }}>
            <Search size={14} />
            <input placeholder="Search by payee, accommodation, department, reference…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-table-wrap">
          {filtered.length === 0 ? (
            <div className="ep-empty"><p>No {tab} payments.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Payment Reference</th>
                  <th>Request No.</th>
                  <th>Payee</th>
                  <th>Department</th>
                  <th>Amount</th>
                  <th>Request Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((item) => (
                  <tr key={item.id} style={{ cursor: "pointer" }} onClick={() => { setSelected(item); setDeclining(false); setDeclineReason(""); }}>
                    <td>{item.doc_type === "ACCOMMODATION" ? "Accommodation" : "Advance"}</td>
                    <td>{item.paid_reference || "—"}</td>
                    <td>{requestNumber(item)}</td>
                    <td style={{ fontWeight: 600, fontSize: "0.87rem" }}>{item.requester_name || "—"}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{item.department || "—"}</td>
                    <td style={{ fontWeight: 600 }}>{formatMoney(item.approved_total || item.requested_total, item.currency)}</td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(item.created_at)}</td>
                    <td><StatusBadge status={item.payment_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {filtered.length > 0 && (
          <div className="ep-filter-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, filtered.length)} of {filtered.length} entries
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <select className="ep-form-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}><ChevronLeft size={14} /></button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 7).map((n) => (
                <button key={n} className={`button small-button ${currentPage === n ? "button-primary" : "button-subtle"}`} onClick={() => setPage(n)}>{n}</button>
              ))}
              <button className="ep-btn-outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>

      {selected && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1200, display: "flex", justifyContent: "flex-end", background: "rgba(15, 23, 42, 0.5)" }}
          onClick={() => { setSelected(null); setDeclining(false); setDeclineReason(""); }}
        >
          <div
            style={{ width: "min(480px, 100vw)", height: "100%", overflow: "auto", background: "var(--surface, #fff)", color: "var(--text)", boxShadow: "-12px 0 40px rgba(15,23,42,0.25)", display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "20px 20px 0" }}>
              <div>
                <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>Payment Details</div>
                <h2 style={{ margin: "4px 0" }}>{selected.paid_reference || "Pending Payment"}</h2>
                <StatusBadge status={selected.payment_status} />
              </div>
              <button className="button small-button button-subtle" onClick={() => { setSelected(null); setDeclining(false); setDeclineReason(""); }}>Close</button>
            </div>

            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
              <DetailRow label="Payee" value={selected.requester_name || "—"} />
              <DetailRow label="Document" value={selected.doc_type === "ACCOMMODATION" ? "Accommodation" : "Advance"} />
              <DetailRow label="Department" value={selected.department || "—"} />
              <DetailRow label="Amount" value={formatMoney(selected.approved_total || selected.requested_total, selected.currency)} />
              <DetailRow label="Request No." value={requestNumber(selected)} />
              <DetailRow label="Requested By" value={selected.requester_name || "—"} />
              <DetailRow label="Request Date" value={fmtDateTime(selected.created_at)} />
              <DetailRow label="Request Status" value={selected.status} />
              <DetailRow label="Approved By" value={selected.approved_by_name || "—"} />
              {selected.payment_status === "PAID" && <DetailRow label="Paid Date" value={fmtDateTime(selected.paid_at)} />}

              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Attachments</div>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--border,#e5e7eb)", borderRadius: 8, cursor: "pointer" }}
                  onClick={() => openBlobInNewTab(() => selected.doc_type === "ACCOMMODATION" ? api.accommodationPdf(selected.id) : api.advancePdf(selected.id)).catch((e: any) => setError(e?.message || "Failed to open PDF."))}
                >
                  <FileText size={18} />
                  <span style={{ fontSize: 13 }}>{selected.pdf_filename}</span>
                </div>
              </div>
            </div>

            {selected.payment_status === "PENDING" && canProcessPayment(selected) && declining && (
              <div style={{ padding: "0 20px 14px" }}>
                <textarea
                  className="ep-form-select"
                  style={{ width: "100%", minHeight: 70, resize: "vertical" }}
                  placeholder="Reason for declining this payment…"
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                />
              </div>
            )}

            <div style={{ padding: "0 20px 20px", marginTop: "auto", display: "flex", gap: 8 }}>
              {selected.payment_status === "PENDING" && canProcessPayment(selected) && (
                declining ? (
                  <>
                    <button className="button button-danger" disabled={busy} onClick={() => handleDecline(selected)} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <XCircle size={16} /> Confirm Decline
                    </button>
                    <button className="button button-subtle" disabled={busy} onClick={() => { setDeclining(false); setDeclineReason(""); }} style={{ flex: 1 }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button className="button button-primary" disabled={busy} onClick={() => handleMarkPaid(selected)} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <Wallet size={16} /> Mark as Paid
                    </button>
                    <button className="button button-danger" disabled={busy} onClick={() => setDeclining(true)} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <XCircle size={16} /> Decline
                    </button>
                  </>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, borderBottom: "1px solid var(--border,#f1f5f9)", paddingBottom: 8 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ fontWeight: 600, textAlign: "right" }}>{value}</span>
    </div>
  );
}
