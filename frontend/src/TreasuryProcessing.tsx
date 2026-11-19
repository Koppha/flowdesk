import { Fragment, useEffect, useState } from "react";
import { api } from "./api";
import { showNotice, confirmAction } from "./alerts";
import { formatMoney } from "./constants";
import { Landmark, Search } from "lucide-react";

type TreasuryRow = {
  id: string;
  claimant_id: string;
  employee_name: string | null;
  employee_no: string | null;
  division_name: string | null;
  department: string | null;
  destination: string | null;
  submitted_at: string | null;
  advance_amount: string | number;
  verified_expenses: string | number;
  financial_outcome: "BALANCED" | "REFUND_DUE" | "PAYBACK_DUE";
  refund_amount: string | number;
  payback_amount: string | number;
  workflow_status: string;
  treasury_settlement_status: string | null;
  treasury_officer_name: string | null;
  treasury_completed_at: string | null;
  payback_verified_at: string | null;
  currency: string | null;
};

const OUTCOME_LABEL: Record<string, string> = { BALANCED: "Balanced", REFUND_DUE: "Refund Due", PAYBACK_DUE: "Payback Due" };
const STATUS_LABEL: Record<string, string> = {
  FINANCE_TREASURY_REVIEW: "Awaiting Treasury",
  COMPLETED: "Completed"
};

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default function TreasuryProcessing({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<TreasuryRow[]>([]);
  const [summary, setSummary] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [outcomeState, setOutcomeState] = useState<"OUTSTANDING" | "COMPLETED" | "ALL">("OUTSTANDING");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});

  function load() {
    setLoading(true);
    const params: Record<string, string> = {};
    if (outcomeState !== "ALL") params.outcome_state = outcomeState;
    api.treasuryQueue(params)
      .then((r: any) => { setRows(Array.isArray(r.items) ? r.items : []); setSummary(r.summary || {}); })
      .catch((e: any) => void showNotice(e?.message || "Failed to load Treasury queue"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [outcomeState]);

  function updateForm(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function completeBalanced(row: TreasuryRow) {
    const ok = await confirmAction({ title: "Complete this balanced clearance?", text: `${row.employee_name} — no refund or payback required.` });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await api.treasuryCompleteBalanced(row.id, { posting_reference: form.posting_reference, comment: form.comment });
      setOpenId(null); setForm({});
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to complete");
    } finally {
      setBusyId(null);
    }
  }

  async function processRefund(row: TreasuryRow) {
    if (!form.payment_date || !form.payment_method || !form.reference) { void showNotice("Payment date, method and reference are required."); return; }
    const ok = await confirmAction({ title: "Process this refund?", text: `${formatMoney(Number(row.refund_amount), row.currency)} to ${row.employee_name}.` });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await api.treasuryProcessRefund(row.id, {
        amount: Number(row.refund_amount),
        payment_date: form.payment_date,
        payment_method: form.payment_method,
        reference: form.reference,
        voucher_reference: form.voucher_reference,
        comment: form.comment
      });
      setOpenId(null); setForm({});
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to process refund");
    } finally {
      setBusyId(null);
    }
  }

  async function reconcilePayback(row: TreasuryRow) {
    if (!form.receipt_date || !form.transaction_reference || !form.reconciliation_date || !form.amount_received) {
      void showNotice("Amount received, receipt date, transaction reference and reconciliation date are required.");
      return;
    }
    const ok = await confirmAction({ title: "Confirm and reconcile this payback?", text: `${row.employee_name} — ${formatMoney(Number(form.amount_received), row.currency)}.` });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await api.treasuryReconcilePayback(row.id, {
        amount_received: Number(form.amount_received),
        receipt_date: form.receipt_date,
        transaction_reference: form.transaction_reference,
        bank_reference: form.bank_reference,
        posting_reference: form.posting_reference,
        reconciliation_date: form.reconciliation_date,
        comment: form.comment
      });
      setOpenId(null); setForm({});
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to reconcile");
    } finally {
      setBusyId(null);
    }
  }

  async function returnToHr(row: TreasuryRow) {
    if (!form.return_reason?.trim()) { void showNotice("A reason is required."); return; }
    const ok = await confirmAction({ title: "Return this clearance to HR Operations?", text: "HR Operations will need to re-verify the payment." });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await api.treasuryReturnToHr(row.id, form.return_reason.trim());
      setOpenId(null); setForm({});
      load();
    } catch (e: any) {
      void showNotice(e?.message || "Failed to return to HR Operations");
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

  return (
    <div className="custom-requests-page">
      <div className="custom-requests-header">
        <div>
          <div className="custom-requests-title-row">
            <span className="custom-requests-title-icon"><Landmark size={18} /></span>
            <h2>Trip Clearance Processing</h2>
          </div>
          <p className="custom-requests-subtitle">Finance Treasury final processing for every clearance outcome.</p>
        </div>
        <button onClick={onBack} className="ep-btn-outline custom-requests-back">Back</button>
      </div>

      <div className="ep-kpi-row" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        <div className="ep-kpi ep-kpi-amber"><div className="ep-kpi-icon"><Landmark size={20} /></div><div><div className="ep-kpi-value">{summary.awaiting_review || 0}</div><div className="ep-kpi-label">Awaiting Treasury Review</div></div></div>
        <div className="ep-kpi ep-kpi-blue"><div className="ep-kpi-icon"><Landmark size={20} /></div><div><div className="ep-kpi-value">{summary.refunds_awaiting_payment || 0}</div><div className="ep-kpi-label">Refunds Awaiting Payment</div></div></div>
        <div className="ep-kpi ep-kpi-blue"><div className="ep-kpi-icon"><Landmark size={20} /></div><div><div className="ep-kpi-value">{summary.paybacks_awaiting_reconciliation || 0}</div><div className="ep-kpi-label">Paybacks Awaiting Reconciliation</div></div></div>
        <div className="ep-kpi ep-kpi-green"><div className="ep-kpi-icon"><Landmark size={20} /></div><div><div className="ep-kpi-value">{summary.balanced_awaiting_completion || 0}</div><div className="ep-kpi-label">Balanced Awaiting Completion</div></div></div>
        <div className="ep-kpi ep-kpi-red"><div className="ep-kpi-icon"><Landmark size={20} /></div><div><div className="ep-kpi-value">{summary.returned_to_hr || 0}</div><div className="ep-kpi-label">Returned to HR Operations</div></div></div>
        <div className="ep-kpi ep-kpi-green"><div className="ep-kpi-icon"><Landmark size={20} /></div><div><div className="ep-kpi-value">{summary.completed_today || 0}</div><div className="ep-kpi-label">Completed Today</div></div></div>
        <div className="ep-kpi ep-kpi-blue"><div className="ep-kpi-icon"><Landmark size={20} /></div><div><div className="ep-kpi-value">{formatMoney(Number(summary.total_outstanding_refund || 0))}</div><div className="ep-kpi-label">Total Outstanding Refund</div></div></div>
      </div>

      <div className="ep-panel">
        <div className="ep-panel-head" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div className="ep-search" style={{ flex: 1, minWidth: 220 }}>
            <Search size={14} />
            <input placeholder="Search by employee, number, department, destination…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="ep-select" value={outcomeState} onChange={(e) => setOutcomeState(e.target.value as any)}>
            <option value="OUTSTANDING">Outstanding</option>
            <option value="COMPLETED">Completed</option>
            <option value="ALL">All</option>
          </select>
        </div>
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-loading"><p>Loading…</p></div>
          ) : !filtered.length ? (
            <div className="ep-empty"><p>No clearances match.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Division / Dept</th>
                  <th>Destination</th>
                  <th>Advance</th>
                  <th>Expenses</th>
                  <th>Outcome</th>
                  <th>Amount</th>
                  <th>Officer</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const amount = r.financial_outcome === "REFUND_DUE" ? r.refund_amount : r.financial_outcome === "PAYBACK_DUE" ? r.payback_amount : 0;
                  const actionable = r.workflow_status === "FINANCE_TREASURY_REVIEW";
                  return (
                    <Fragment key={r.id}>
                      <tr>
                        <td>{r.employee_name || "—"}{r.employee_no ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.employee_no}</div> : null}</td>
                        <td>{r.division_name || "—"} / {r.department || "—"}</td>
                        <td>{r.destination || "—"}</td>
                        <td>{(r as any).claim_kind === "CLAIM" ? <span title="A claim: trip with no advance" style={{ color: "var(--muted)", fontWeight: 500 }}>No advance (claim)</span> : formatMoney(Number(r.advance_amount || 0), r.currency)}</td>
                        <td>{formatMoney(Number(r.verified_expenses || 0), r.currency)}</td>
                        <td>{OUTCOME_LABEL[r.financial_outcome] || r.financial_outcome}</td>
                        <td>{amount ? formatMoney(Number(amount), r.currency) : "—"}</td>
                        <td>{r.treasury_officer_name || "—"}</td>
                        <td>{STATUS_LABEL[r.workflow_status] || r.workflow_status}</td>
                        <td>
                          {actionable && (
                            <button className="ep-btn" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => { setOpenId(openId === r.id ? null : r.id); setForm({}); }}>
                              {openId === r.id ? "Close" : "Process"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {openId === r.id && (
                        <tr>
                          <td colSpan={10} style={{ background: "var(--surface-soft)", padding: 12 }}>
                            {r.financial_outcome === "BALANCED" && (
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <input className="ep-form-input" placeholder="Posting/journal reference (optional)" value={form.posting_reference || ""} onChange={(e) => updateForm("posting_reference", e.target.value)} />
                                <input className="ep-form-input" style={{ flex: 1, minWidth: 160 }} placeholder="Comment (optional)" value={form.comment || ""} onChange={(e) => updateForm("comment", e.target.value)} />
                                <button className="ep-btn" disabled={busyId === r.id} onClick={() => completeBalanced(r)}>Complete Treasury Processing</button>
                              </div>
                            )}
                            {r.financial_outcome === "REFUND_DUE" && (
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <span style={{ fontSize: 12, fontWeight: 700 }}>Refund: {formatMoney(Number(r.refund_amount), r.currency)}</span>
                                <input className="ep-form-input" type="date" placeholder="Payment date" value={form.payment_date || ""} onChange={(e) => updateForm("payment_date", e.target.value)} />
                                <select className="ep-select" value={form.payment_method || ""} onChange={(e) => updateForm("payment_method", e.target.value)}>
                                  <option value="">Payment method…</option>
                                  <option value="ECOCASH">ECOCASH</option>
                                  <option value="BANK">Bank Transfer</option>
                                  <option value="CASH">Cash</option>
                                  <option value="OTHER">Other</option>
                                </select>
                                <input className="ep-form-input" placeholder="Payment reference" value={form.reference || ""} onChange={(e) => updateForm("reference", e.target.value)} />
                                <input className="ep-form-input" placeholder="Voucher/journal ref (optional)" value={form.voucher_reference || ""} onChange={(e) => updateForm("voucher_reference", e.target.value)} />
                                <input className="ep-form-input" style={{ flex: 1, minWidth: 160 }} placeholder="Comment (optional)" value={form.comment || ""} onChange={(e) => updateForm("comment", e.target.value)} />
                                <button className="ep-btn" disabled={busyId === r.id} onClick={() => processRefund(r)}>Process Refund</button>
                              </div>
                            )}
                            {r.financial_outcome === "PAYBACK_DUE" && (
                              <div>
                                {!r.payback_verified_at ? (
                                  <div style={{ fontSize: 12, color: "var(--muted)" }}>HR Operations has not yet verified this repayment - Treasury cannot reconcile it yet.</div>
                                ) : (
                                  <>
                                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                                      <span style={{ fontSize: 12, fontWeight: 700 }}>Required: {formatMoney(Number(r.payback_amount), r.currency)}</span>
                                      <input className="ep-form-input" placeholder="Amount received" value={form.amount_received || ""} onChange={(e) => updateForm("amount_received", e.target.value)} />
                                      <input className="ep-form-input" type="date" placeholder="Receipt date" value={form.receipt_date || ""} onChange={(e) => updateForm("receipt_date", e.target.value)} />
                                      <input className="ep-form-input" placeholder="Transaction reference" value={form.transaction_reference || ""} onChange={(e) => updateForm("transaction_reference", e.target.value)} />
                                      <input className="ep-form-input" placeholder="Bank/cashbook ref (optional)" value={form.bank_reference || ""} onChange={(e) => updateForm("bank_reference", e.target.value)} />
                                      <input className="ep-form-input" placeholder="Posting ref (optional)" value={form.posting_reference || ""} onChange={(e) => updateForm("posting_reference", e.target.value)} />
                                      <input className="ep-form-input" type="date" placeholder="Reconciliation date" value={form.reconciliation_date || ""} onChange={(e) => updateForm("reconciliation_date", e.target.value)} />
                                      <input className="ep-form-input" style={{ flex: 1, minWidth: 160 }} placeholder="Comment (optional)" value={form.comment || ""} onChange={(e) => updateForm("comment", e.target.value)} />
                                      <button className="ep-btn" disabled={busyId === r.id} onClick={() => reconcilePayback(r)}>Confirm and Reconcile Payback</button>
                                    </div>
                                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                      <input className="ep-form-input" style={{ flex: 1, minWidth: 200 }} placeholder="Reason for returning to HR Operations…" value={form.return_reason || ""} onChange={(e) => updateForm("return_reason", e.target.value)} />
                                      <button className="ep-btn-danger" disabled={busyId === r.id} onClick={() => returnToHr(r)}>Return to HR Operations</button>
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
