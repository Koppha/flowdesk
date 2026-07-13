import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken, openBlobInNewTab } from "./api";
import { formatMoney } from "./constants";
import { Clock, CheckCircle, Wallet, FileText, Search, ChevronLeft, ChevronRight } from "lucide-react";

const PAGE_SIZE_OPTIONS = [10, 25, 50];

interface PaymentItem {
  id: string;
  status: string;
  payment_status: "PENDING" | "PAID";
  type: string;
  requested_total: number;
  approved_total: number;
  purpose: string | null;
  requester_name: string | null;
  department: string | null;
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
  return `ADV-${year}-${(digits || fallback || "00000").padStart(5, "0")}`;
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

  const [items, setItems] = useState<PaymentItem[]>([]);
  const [tab, setTab] = useState<"pending" | "paid">("pending");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<PaymentItem | null>(null);
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

  const stats = useMemo(() => ({
    pending: items.filter((i) => i.payment_status === "PENDING").length,
    pendingValue: items.filter((i) => i.payment_status === "PENDING").reduce((s, i) => s + Number(i.approved_total || i.requested_total || 0), 0),
    paid: items.filter((i) => i.payment_status === "PAID").length,
    paidValue: items.filter((i) => i.payment_status === "PAID").reduce((s, i) => s + Number(i.approved_total || i.requested_total || 0), 0)
  }), [items]);

  const filtered = useMemo(() => {
    const byTab = items.filter((i) => i.payment_status === tab.toUpperCase());
    if (!search.trim()) return byTab;
    const q = search.toLowerCase();
    return byTab.filter((i) =>
      requestNumber(i).toLowerCase().includes(q) ||
      (i.requester_name || "").toLowerCase().includes(q) ||
      (i.department || "").toLowerCase().includes(q) ||
      (i.paid_reference || "").toLowerCase().includes(q)
    );
  }, [items, tab, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  async function handleMarkPaid(item: PaymentItem) {
    setBusy(true);
    setError(null);
    try {
      await api.markAdvancePaid(item.id);
      await refresh();
      setSelected(null);
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
          <p className="ep-subtitle">Advance requests awaiting payment, and payment history.</p>
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
          <div><div className="stat-value">{stats.pending}</div><div className="stat-label">Pending Payment</div><small>{formatMoney(stats.pendingValue)}</small></div>
        </div>
        <div className="stat-card stat-card-green">
          <span className="stat-icon"><CheckCircle size={28} /></span>
          <div><div className="stat-value">{stats.paid}</div><div className="stat-label">Paid</div><small>{formatMoney(stats.paidValue)}</small></div>
        </div>
      </div>

      <div className="ep-tabs">
        <button type="button" className={`ep-tab ${tab === "pending" ? "active" : ""}`} onClick={() => { setTab("pending"); setPage(1); }}>
          Pending <span className="inbox-count-chip">{stats.pending}</span>
        </button>
        <button type="button" className={`ep-tab ${tab === "paid" ? "active" : ""}`} onClick={() => { setTab("paid"); setPage(1); }}>
          Paid <span className="inbox-count-chip">{stats.paid}</span>
        </button>
      </div>

      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <div className="ep-search" style={{ flex: "1 1 220px" }}>
            <Search size={14} />
            <input placeholder="Search by payee, department, reference…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
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
                  <tr key={item.id} style={{ cursor: "pointer" }} onClick={() => setSelected(item)}>
                    <td>{item.paid_reference || "—"}</td>
                    <td>{requestNumber(item)}</td>
                    <td style={{ fontWeight: 600, fontSize: "0.87rem" }}>{item.requester_name || "—"}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{item.department || "—"}</td>
                    <td style={{ fontWeight: 600 }}>{formatMoney(item.approved_total || item.requested_total)}</td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(item.created_at)}</td>
                    <td><StatusBadge status={item.payment_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {filtered.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
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
          onClick={() => setSelected(null)}
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
              <button className="button small-button button-subtle" onClick={() => setSelected(null)}>Close</button>
            </div>

            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
              <DetailRow label="Payee" value={selected.requester_name || "—"} />
              <DetailRow label="Department" value={selected.department || "—"} />
              <DetailRow label="Amount" value={formatMoney(selected.approved_total || selected.requested_total)} />
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
                  onClick={() => openBlobInNewTab(() => api.advancePdf(selected.id)).catch((e: any) => setError(e?.message || "Failed to open PDF."))}
                >
                  <FileText size={18} />
                  <span style={{ fontSize: 13 }}>{selected.pdf_filename}</span>
                </div>
              </div>
            </div>

            <div style={{ padding: "0 20px 20px", marginTop: "auto" }}>
              {selected.payment_status === "PENDING" && !isAdmin && (
                <button className="button button-primary" disabled={busy} onClick={() => handleMarkPaid(selected)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <Wallet size={16} /> Mark as Paid
                </button>
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
