import { Fragment, useEffect, useState } from "react";
import { api, openBlobInNewTab } from "./api";
import { showNotice, confirmAction } from "./alerts";
import { formatMoney } from "./constants";
import { Wallet, Download, Search } from "lucide-react";

type PaybackRow = {
  id: string;
  claimant_id: string;
  employee_name: string | null;
  employee_no: string | null;
  department: string | null;
  destination: string | null;
  balance_amount: string | number;
  status: "PAYBACK_PROOF_SUBMITTED" | "PAYBACK_PROOF_REJECTED" | "REFUND_DUE";
  currency: string | null;
  submission_count: number;
  proof_id: string | null;
  amount_paid: string | number | null;
  payment_date: string | null;
  reference: string | null;
  proof_comment: string | null;
  submitted_at: string | null;
  proof_status: string | null;
  rejection_reason: string | null;
  // Finance queried the proof from View Clearances (proof_status QUERIED).
  query_reason: string | null;
  queried_at: string | null;
  queried_by_name: string | null;
  // Treasury sent an already-verified payback back to HR Operations.
  treasury_return_reason: string | null;
  treasury_returned_at: string | null;
};

const STATUS_STYLE: Record<string, [string, string]> = {
  PAYBACK_PROOF_SUBMITTED: ["#fef3c7", "#92400e"],
  PAYBACK_PROOF_REJECTED: ["#fee2e2", "#991b1b"],
  REFUND_DUE: ["#dbeafe", "#1e40af"]
};

const STATUS_TEXT: Record<string, string> = {
  PAYBACK_PROOF_SUBMITTED: "Awaiting Review",
  PAYBACK_PROOF_REJECTED: "Rejected — Awaiting Resubmission",
  REFUND_DUE: "Refund — Ready to Send to Treasury"
};

function StatusBadge({ row }: { row: PaybackRow }) {
  const status = row.status;
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  // A Finance query shares PAYBACK_PROOF_REJECTED with an HR rejection;
  // a Treasury return shares PAYBACK_PROOF_SUBMITTED with a fresh proof.
  const text = status === "PAYBACK_PROOF_REJECTED" && row.proof_status === "QUERIED"
    ? "Queried by Finance — Awaiting Resubmission"
    : status === "PAYBACK_PROOF_SUBMITTED" && row.proof_status === "VERIFIED"
      ? "Returned by Treasury — Review Again"
      : STATUS_TEXT[status] || status;
  return <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{text}</span>;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default function PaybackReview({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<PaybackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  function load() {
    setLoading(true);
    api.paybackReviewQueue()
      .then((r: any) => setRows(Array.isArray(r.items) ? r.items : []))
      .catch((e: any) => void showNotice(e?.message || "Failed to load payback proofs"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function verify(row: PaybackRow) {
    if (!row.proof_id) return;
    const ok = await confirmAction({ title: "Verify this repayment proof?", text: `${row.employee_name} — ${formatMoney(Number(row.amount_paid || 0), row.currency)}. This marks the clearance fully cleared.` });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await api.verifyPaybackProof(row.id, row.proof_id);
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to verify");
    } finally {
      setBusyId(null);
    }
  }

  async function submitReject(row: PaybackRow) {
    if (!row.proof_id) return;
    if (!rejectReason.trim()) { void showNotice("A reason is required to reject."); return; }
    const ok = await confirmAction({ title: "Reject this repayment proof?", text: "The employee will be asked to resubmit corrected proof." });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await api.rejectPaybackProof(row.id, row.proof_id, rejectReason.trim());
      setRejectingId(null);
      setRejectReason("");
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to reject");
    } finally {
      setBusyId(null);
    }
  }

  async function sendToTreasury(row: PaybackRow) {
    const ok = await confirmAction({ title: "Send this refund to Finance Treasury?", text: `${row.employee_name} — ${formatMoney(Math.abs(Number(row.balance_amount || 0)), row.currency)}.` });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await api.sendClearanceToTreasury(row.id);
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to send to Treasury");
    } finally {
      setBusyId(null);
    }
  }

  const filtered = rows.filter((r) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    const hay = `${r.employee_name || ""} ${r.employee_no || ""} ${r.department || ""} ${r.destination || ""}`.toLowerCase();
    return hay.includes(q);
  });

  const awaitingCount = rows.filter((r) => r.status === "PAYBACK_PROOF_SUBMITTED").length;
  const rejectedCount = rows.filter((r) => r.status === "PAYBACK_PROOF_REJECTED").length;
  const refundDueCount = rows.filter((r) => r.status === "REFUND_DUE").length;

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon"><Wallet size={18} /></span>
            <h2>HR Operations Review</h2>
          </div>
          <p className="custom-requests-subtitle">Repayment proofs awaiting verification, and refunds ready to send to Finance Treasury.</p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      <div className="ep-kpi-row" style={{ marginBottom: 16 }}>
        <div className="ep-kpi ep-kpi-amber">
          <div className="ep-kpi-icon"><Wallet size={20} /></div>
          <div>
            <div className="ep-kpi-value">{awaitingCount}</div>
            <div className="ep-kpi-label">Awaiting Verification</div>
          </div>
        </div>
        <div className="ep-kpi ep-kpi-red">
          <div className="ep-kpi-icon"><Wallet size={20} /></div>
          <div>
            <div className="ep-kpi-value">{rejectedCount}</div>
            <div className="ep-kpi-label">Rejected — Awaiting Resubmission</div>
          </div>
        </div>
        <div className="ep-kpi ep-kpi-blue">
          <div className="ep-kpi-icon"><Wallet size={20} /></div>
          <div>
            <div className="ep-kpi-value">{refundDueCount}</div>
            <div className="ep-kpi-label">Refunds Ready to Send to Treasury</div>
          </div>
        </div>
      </div>

      <div className="ep-panel">
        <div className="ep-panel-head" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div className="ep-search" style={{ flex: 1, minWidth: 220 }}>
            <Search size={14} />
            <input placeholder="Search by employee, number, department, destination…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : !filtered.length ? (
            <div className="ep-empty"><p>No payback proofs awaiting your review.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Trip</th>
                  <th>Required Payback</th>
                  <th>Submitted Amount</th>
                  <th>Submitted</th>
                  <th># Submissions</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td>{r.employee_name || "—"}{r.department ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.department}</div> : null}</td>
                      <td>{r.destination || "—"}</td>
                      <td>{formatMoney(Number(r.balance_amount || 0), r.currency)}</td>
                      <td>{r.amount_paid != null ? formatMoney(Number(r.amount_paid), r.currency) : "—"}</td>
                      <td>{fmtDate(r.submitted_at)}</td>
                      <td>{r.submission_count}</td>
                      <td><StatusBadge row={r} /></td>
                      <td>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          {r.proof_id && (
                            <button className="ep-icon-btn" title="View proof" onClick={() => { void openBlobInNewTab(() => api.paybackProofFileBlob(r.id, r.proof_id!)); }}>
                              <Download size={14} />
                            </button>
                          )}
                          {r.status === "PAYBACK_PROOF_SUBMITTED" && (
                            <>
                              <button className="ep-btn" style={{ padding: "5px 10px", fontSize: 12 }} disabled={busyId === r.id} onClick={() => verify(r)}>
                                Verify Payback
                              </button>
                              <button className="ep-btn-danger" style={{ padding: "5px 10px", fontSize: 12 }} disabled={busyId === r.id} onClick={() => setRejectingId(rejectingId === r.id ? null : r.id)}>
                                Reject Proof
                              </button>
                            </>
                          )}
                          {r.status === "REFUND_DUE" && (
                            <button className="ep-btn" style={{ padding: "5px 10px", fontSize: 12 }} disabled={busyId === r.id} onClick={() => sendToTreasury(r)}>
                              Send to Treasury
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {rejectingId === r.id && (
                      <tr>
                        <td colSpan={8} style={{ background: "var(--surface-soft)" }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 4px" }}>
                            <input className="ep-form-input" style={{ flex: 1 }} placeholder="Reason for rejecting (required)…" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                            <button className="ep-btn-danger" style={{ padding: "6px 12px", fontSize: 12 }} disabled={busyId === r.id || !rejectReason.trim()} onClick={() => submitReject(r)}>Confirm Reject</button>
                            <button className="ep-btn-outline" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => { setRejectingId(null); setRejectReason(""); }}>Cancel</button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {r.status === "PAYBACK_PROOF_REJECTED" && r.proof_status === "QUERIED" && r.query_reason ? (
                      <tr>
                        <td colSpan={8} style={{ fontSize: 12, color: "var(--muted)", paddingTop: 0 }}>
                          Queried by Finance{r.queried_by_name ? ` (${r.queried_by_name}, ${fmtDate(r.queried_at)})` : ""}: {r.query_reason}
                        </td>
                      </tr>
                    ) : r.status === "PAYBACK_PROOF_REJECTED" && r.rejection_reason ? (
                      <tr>
                        <td colSpan={8} style={{ fontSize: 12, color: "var(--muted)", paddingTop: 0 }}>Rejected: {r.rejection_reason}</td>
                      </tr>
                    ) : null}
                    {r.status === "PAYBACK_PROOF_SUBMITTED" && r.proof_status === "VERIFIED" && r.treasury_return_reason && (
                      <tr>
                        <td colSpan={8} style={{ fontSize: 12, color: "var(--muted)", paddingTop: 0 }}>
                          Returned by Treasury{r.treasury_returned_at ? ` (${fmtDate(r.treasury_returned_at)})` : ""}: {r.treasury_return_reason}
                        </td>
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
