import { Fragment, useEffect, useState } from "react";
import { api, openBlobInNewTab } from "./api";
import { showNotice, confirmAction } from "./alerts";
import { formatMoney } from "./constants";
import { FileText, Download, Search } from "lucide-react";

type AccommodationRow = {
  id: string;
  advance_request_id: string;
  requester_id: string;
  created_by_id: string;
  location: string;
  provider: string | null;
  check_in: string | null;
  check_out: string | null;
  amount: string | number;
  status: "DRAFT" | "SUBMITTED" | "PAID" | "REJECTED";
  paid_reference: string | null;
  paid_at: string | null;
  rejection_comments: string | null;
  created_at: string;
  created_by_name: string | null;
  requester_name: string | null;
  requester_department: string | null;
};

const STATUS_STYLE: Record<string, [string, string]> = {
  SUBMITTED: ["#fef3c7", "#92400e"],
  PAID: ["#d1fae5", "#065f46"],
  REJECTED: ["#fee2e2", "#991b1b"]
};

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default function Accommodation({ profile, onBack }: { profile: any; onBack: () => void }) {
  const [rows, setRows] = useState<AccommodationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"ALL" | "SUBMITTED" | "PAID" | "REJECTED">("ALL");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  function load() {
    setLoading(true);
    api.accommodationRequests()
      .then((r: any) => setRows(Array.isArray(r) ? r.filter((row: AccommodationRow) => row.status !== "DRAFT") : []))
      .catch((e: any) => void showNotice(e?.message || "Failed to load accommodation requests"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const isAdmin = profile?.role === "ADMIN";
  const canAct = (row: AccommodationRow) => row.status === "SUBMITTED";

  async function markPaid(id: string) {
    const ok = await confirmAction({ title: "Mark this accommodation booking as paid?", text: "A payment reference will be generated automatically." });
    if (!ok) return;
    setBusyId(id);
    try {
      await api.markAccommodationPaid(id);
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to mark as paid");
    } finally {
      setBusyId(null);
    }
  }

  async function submitReject(id: string) {
    if (!rejectReason.trim()) { void showNotice("A reason is required to reject."); return; }
    setBusyId(id);
    try {
      await api.rejectAccommodation(id, rejectReason.trim());
      setRejectingId(null);
      setRejectReason("");
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to reject");
    } finally {
      setBusyId(null);
    }
  }

  const filtered = rows.filter((r) => {
    if (statusFilter !== "ALL" && r.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${r.requester_name || ""} ${r.location} ${r.provider || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const totalPending = rows.filter((r) => r.status === "SUBMITTED").reduce((s, r) => s + Number(r.amount || 0), 0);

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon"><FileText size={18} /></span>
            <h2>Accommodation</h2>
          </div>
          <p className="custom-requests-subtitle">
            {isAdmin ? "Every accommodation booking across the business." : "Accommodation bookings you've created or that are for you."}
          </p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      <div className="ep-kpi-row" style={{ marginBottom: 16 }}>
        <div className="ep-kpi ep-kpi-amber">
          <div className="ep-kpi-icon"><FileText size={20} /></div>
          <div>
            <div className="ep-kpi-value">{rows.filter((r) => r.status === "SUBMITTED").length}</div>
            <div className="ep-kpi-label">Awaiting payment</div>
            <div className="ep-kpi-subvalue">{formatMoney(totalPending)}</div>
          </div>
        </div>
        <div className="ep-kpi ep-kpi-green">
          <div className="ep-kpi-icon"><FileText size={20} /></div>
          <div>
            <div className="ep-kpi-value">{rows.filter((r) => r.status === "PAID").length}</div>
            <div className="ep-kpi-label">Paid</div>
          </div>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-panel-head" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div className="ep-search" style={{ flex: 1, minWidth: 220 }}>
            <Search size={14} />
            <input placeholder="Search by owner, location, provider…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="ep-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
            <option value="ALL">All statuses</option>
            <option value="SUBMITTED">Awaiting payment</option>
            <option value="PAID">Paid</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </div>
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : !filtered.length ? (
            <div className="ep-empty"><p>No accommodation bookings match.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Traveller</th>
                  <th>Location</th>
                  <th>Provider</th>
                  <th>Dates</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Booked by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td>{r.requester_name || "—"}{r.requester_department ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.requester_department}</div> : null}</td>
                      <td>{r.location}</td>
                      <td>{r.provider || "—"}</td>
                      <td>{fmtDate(r.check_in)} – {fmtDate(r.check_out)}</td>
                      <td>{formatMoney(Number(r.amount || 0))}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{r.created_by_name || "—"}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button className="ep-icon-btn" title="Download PDF" onClick={() => { void openBlobInNewTab(() => api.accommodationPdf(r.id)); }}>
                            <Download size={14} />
                          </button>
                          {canAct(r) && (
                            <>
                              <button className="ep-btn" style={{ padding: "5px 10px", fontSize: 12 }} disabled={busyId === r.id} onClick={() => markPaid(r.id)}>
                                Mark Paid
                              </button>
                              <button className="ep-btn-danger" style={{ padding: "5px 10px", fontSize: 12 }} disabled={busyId === r.id} onClick={() => setRejectingId(rejectingId === r.id ? null : r.id)}>
                                Reject
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {rejectingId === r.id && (
                      <tr>
                        <td colSpan={8} style={{ background: "var(--surface-soft)" }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 4px" }}>
                            <input className="ep-form-input" style={{ flex: 1 }} placeholder="Reason for rejecting…" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                            <button className="ep-btn-danger" style={{ padding: "6px 12px", fontSize: 12 }} disabled={busyId === r.id} onClick={() => submitReject(r.id)}>Confirm Reject</button>
                            <button className="ep-btn-outline" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => { setRejectingId(null); setRejectReason(""); }}>Cancel</button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {r.status === "REJECTED" && r.rejection_comments && (
                      <tr>
                        <td colSpan={8} style={{ fontSize: 12, color: "var(--muted)", paddingTop: 0 }}>Rejected: {r.rejection_comments}</td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
