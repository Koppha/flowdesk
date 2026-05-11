import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken } from "./api";

type InboxItem =
  | {
      doc_type: "ADVANCE";
      id: string;
      status: string;
      requested_total: number;
      approved_total: number;
      purpose: string | null;
      requester_name: string;
    }
  | {
      doc_type: "ACCOMMODATION";
      id: string;
      status: string;
      amount: number;
      location: string;
      provider: string | null;
      requester_name: string;
      created_by_name: string;
    }
  | {
      doc_type: "CLAIM";
      id: string;
      status: string;
      claim_total: number;
      advance_amount: number;
      balance_amount: number;
      claimant_name: string;
    };

type MyInboxAction = {
  id: string;
  action: string;
  doc_type: string;
  entity_id: string;
  current_status: string | null;
  requester_name: string | null;
  created_at: string;
};

function fmt(n: any) {
  const x = Number(n || 0);
  return `M${x.toFixed(2)}`;
}

function fmtWhen(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function fmtDate(value: any) {
  const d = new Date(String(value || ""));
  if (Number.isNaN(d.getTime())) return String(value || "—");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function displayRoleLabel(value: string | null | undefined) {
  switch (value) {
    case "AUTH_OFFICER":
      return "HR";
    case "HR_MANAGER":
      return "HR Manager";
    case "CHIEF_OFFICER":
      return "Chief Officer";
    case "COUNTERSIGN":
      return "Countersign";
    default:
      return value || "Unknown";
  }
}

export default function Inbox(props: { onBack?: () => void }) {
  const me = getUserFromToken();
  const role = me?.role || "UNKNOWN";

  const [items, setItems] = useState<InboxItem[]>([]);
  const [myActions, setMyActions] = useState<MyInboxAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InboxItem | null>(null);

  async function refresh() {
    setError(null);
    const [inboxResp, myActionsResp] = await Promise.all([api.inbox(), api.myInboxActions(30)]);
    setItems(inboxResp.items || []);
    setMyActions(myActionsResp.items || []);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message)));
  }, []);

  const grouped = useMemo(() => {
    const g: Record<string, InboxItem[]> = {};
    for (const it of items) {
      const key = `${it.doc_type}:${it.status}`;
      g[key] = g[key] || [];
      g[key].push(it);
    }
    return g;
  }, [items]);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>Approval Inbox</h3>
          <div style={{ opacity: 0.7 }}>Role: {displayRoleLabel(role)}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {props.onBack && (
            <button className="button small-button" onClick={props.onBack} style={{ padding: "8px 12px" }}>
              Back
            </button>
          )}
          <button className="button small-button" onClick={() => refresh().catch((e) => setError(String(e.message)))} style={{ padding: "8px 12px" }}>
            Refresh
          </button>
        </div>
      </div>

      {error && <pre style={{ color: "crimson" }}>{error}</pre>}

      <div style={{ marginTop: 16 }} className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <b>My Recent Actions</b>
          <span style={{ opacity: 0.7 }}>{myActions.length} record(s)</span>
        </div>
        {myActions.length === 0 ? (
          <div style={{ marginTop: 8, opacity: 0.75 }}>No action history yet.</div>
        ) : (
          <div style={{ marginTop: 8, overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Document</th>
                  <th>Owner</th>
                  <th>Current Status</th>
                </tr>
              </thead>
              <tbody>
                {myActions.map((a) => (
                  <tr key={a.id}>
                    <td>{fmtWhen(a.created_at)}</td>
                    <td>{a.action}</td>
                    <td>{a.doc_type}</td>
                    <td>{a.requester_name || "—"}</td>
                    <td>{a.current_status || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div style={{ marginTop: 16, opacity: 0.75 }}>No items awaiting your action.</div>
      ) : (
        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          {Object.entries(grouped).map(([groupKey, groupItems]) => (
            <div key={groupKey} style={{ padding: 12 }} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <b>{groupKey}</b>
                <span style={{ opacity: 0.7 }}>{groupItems.length} item(s)</span>
              </div>

              <div style={{ marginTop: 8, overflowX: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th>Amount</th>
                      <th>Balance</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupItems.map((it) => (
                      <tr key={it.id}>
                        <td>
                          {it.doc_type === "ADVANCE"
                            ? it.requester_name
                            : it.doc_type === "ACCOMMODATION"
                              ? it.requester_name
                              : it.claimant_name}
                        </td>
                        <td>
                          {it.doc_type === "ADVANCE"
                            ? fmt(it.requested_total)
                            : it.doc_type === "ACCOMMODATION"
                              ? fmt(it.amount)
                              : fmt(it.claim_total)}
                        </td>
                        <td>
                          {it.doc_type === "CLAIM" ? (
                            <>
                              Advance {fmt(it.advance_amount)} • Balance {fmt(it.balance_amount)}
                            </>
                          ) : it.doc_type === "ACCOMMODATION" ? (
                            <>
                              {it.location}{it.provider ? ` • ${it.provider}` : ""}
                            </>
                          ) : (
                            <span style={{ opacity: 0.6 }}>—</span>
                          )}
                        </td>
                        <td>
                          <button className="button small-button" onClick={() => setSelected(it)}>
                            Review
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <ReviewModal
          item={selected}
          role={role}
          onClose={() => setSelected(null)}
          onDone={async () => {
            setSelected(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function ReviewModal(props: { item: InboxItem; role: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { item, role } = props;
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState("");
  const [paidRef, setPaidRef] = useState("");
  const [settleRef, setSettleRef] = useState("");
  const [settleMethod, setSettleMethod] = useState<"ECOCASH" | "BANK">("ECOCASH");
  const [accommodationLocation, setAccommodationLocation] = useState("");
  const [accommodationProvider, setAccommodationProvider] = useState("");
  const [accommodationCheckIn, setAccommodationCheckIn] = useState("");
  const [accommodationCheckOut, setAccommodationCheckOut] = useState("");
  const [accommodationAmount, setAccommodationAmount] = useState("");
  const [accommodationNotes, setAccommodationNotes] = useState("");
  const [accommodationQuotation, setAccommodationQuotation] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setError(null);
      try {
        const d =
          item.doc_type === "ADVANCE"
            ? await api.advanceDetail(item.id)
            : item.doc_type === "ACCOMMODATION"
              ? await api.accommodationDetail(item.id)
              : await api.claimDetail(item.id);
        setDetail(d);
      } catch (e: any) {
        setError(String(e.message));
      }
    })();
  }, [item.id]);

  const isSalaryAdvance = item.doc_type === "ADVANCE" && detail?.type === "SALARY";
  const isLoanAdvance = item.doc_type === "ADVANCE" && detail?.type === "LOAN";
  const isTravelAdvance = item.doc_type === "ADVANCE" && detail?.type === "TRAVEL_SUBSISTENCE";

  const canCountersign = item.doc_type === "ADVANCE" && role === "COUNTERSIGN" && item.status === "SUBMITTED" && isTravelAdvance;
  const canRollbackAdvance =
    item.doc_type === "ADVANCE" &&
    ((role === "COUNTERSIGN" && item.status === "SUBMITTED" && isTravelAdvance) ||
      (role === "MANAGER" && item.status === "COUNTERSIGNED" && isTravelAdvance) ||
      (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW" && isTravelAdvance) ||
      (role === "AUTH_OFFICER" && item.status === "SUBMITTED" && (isLoanAdvance || isSalaryAdvance)));
  const canRejectAdvance =
    item.doc_type === "ADVANCE" &&
    ((role === "MANAGER" && item.status === "COUNTERSIGNED" && isTravelAdvance) ||
      (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW" && isTravelAdvance) ||
      (role === "AUTH_OFFICER" && item.status === "SUBMITTED" && (isLoanAdvance || isSalaryAdvance)) ||
      (role === "FINANCE" && item.status === "AUTH_OFFICER_APPROVED" && isSalaryAdvance) ||
      (role === "ADMIN" && ["SUBMITTED", "COUNTERSIGNED", "HR_MANAGER_REVIEW", "AUTH_OFFICER_APPROVED"].includes(item.status)));
  const canApproveAdvance =
    item.doc_type === "ADVANCE" &&
    ((role === "MANAGER" && item.status === "COUNTERSIGNED" && isTravelAdvance) ||
      (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW" && isTravelAdvance) ||
      (role === "AUTH_OFFICER" && item.status === "SUBMITTED" && (isLoanAdvance || isSalaryAdvance)) ||
      (role === "FINANCE" && item.status === "AUTH_OFFICER_APPROVED" && isSalaryAdvance));
  const canMarkPaid = item.doc_type === "ADVANCE" && role === "FINANCE" && item.status === "APPROVED";
  const canCreateAccommodation =
    item.doc_type === "ADVANCE" &&
    role === "AUTH_OFFICER" &&
    item.status === "APPROVED" &&
    isTravelAdvance;
  const canMarkAccommodationPaid = item.doc_type === "ACCOMMODATION" && role === "FINANCE" && item.status === "SUBMITTED";
  const canRejectAccommodation = item.doc_type === "ACCOMMODATION" && role === "FINANCE" && item.status === "SUBMITTED";

  const canManagerApprove = item.doc_type === "CLAIM" && role === "MANAGER" && item.status === "SUBMITTED";
  const canAuthApproveClaim = item.doc_type === "CLAIM" && role === "AUTH_OFFICER" && item.status === "MANAGER_APPROVED";
  const canChiefApprove = item.doc_type === "CLAIM" && role === "CHIEF_OFFICER" && item.status === "AUTH_OFFICER_APPROVED";
  const canFinanceVerify = item.doc_type === "CLAIM" && role === "FINANCE" && item.status === "CHIEF_OFFICER_APPROVED";
  const canSettle = item.doc_type === "CLAIM" && role === "FINANCE" && item.status === "FINANCE_VERIFIED";

  async function act(fn: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await props.onDone();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  function handleRollbackAdvance() {
    if (!comments.trim()) {
      setRollbackError("Enter rollback comments before sending this advance back to the owner as draft.");
      return;
    }
    setRollbackError(null);
    void act(() => api.rollbackAdvance(item.id, comments.trim()));
  }

  function handleRejectAdvance() {
    if (!comments.trim()) {
      setError("Enter comments before rejecting this advance.");
      return;
    }
    void act(() => api.rejectAdvance(item.id, comments.trim()));
  }

  function handleApproveAdvance() {
    const approvedTotal = item.doc_type === "ADVANCE" ? Number(detail?.requested_total || item.requested_total || 0) : 0;
    void act(() => api.approveAdvance(item.id, approvedTotal, comments));
  }

  function handleCreateAccommodation() {
    const amount = Number(accommodationAmount || 0);
    if (!accommodationLocation.trim()) {
      setError("Accommodation location is required.");
      return;
    }
    if (amount <= 0) {
      setError("Accommodation amount must be greater than 0.");
      return;
    }
    if (!accommodationQuotation) {
      setError("Upload a quotation file before sending the accommodation request to finance.");
      return;
    }

    void act(async () => {
      const createResp = await api.createAccommodationRequest({
        advance_request_id: item.id,
        location: accommodationLocation.trim(),
        provider: accommodationProvider.trim() || undefined,
        check_in: accommodationCheckIn || undefined,
        check_out: accommodationCheckOut || undefined,
        amount,
        notes: accommodationNotes.trim() || undefined
      });
      const form = new FormData();
      form.append("file", accommodationQuotation);
      await api.uploadAccommodationQuotation(createResp.id, form);
      await api.sendAccommodationToFinance(createResp.id);
    });
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", justifyContent: "center", alignItems: "center", padding: 16 }}>
      <div
        style={{
          background: "var(--surface)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          width: 960,
          maxWidth: "100%",
          borderRadius: 14,
          padding: 16,
          boxSizing: "border-box"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>
              Review {item.doc_type === "ACCOMMODATION" ? "Travel Advance Request" : item.doc_type}
            </h3>
            <div style={{ opacity: 0.7 }}>
              Status: <b>{item.status}</b>
            </div>
          </div>
          <button className="button small-button" onClick={props.onClose} style={{ height: 36, padding: "0 12px" }}>
            Close
          </button>
        </div>

        {error && <pre style={{ color: "crimson", marginTop: 12 }}>{error}</pre>}

        {!detail ? (
          <div style={{ marginTop: 12, opacity: 0.7 }}>Loading…</div>
        ) : (
          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns:
                item.doc_type === "CLAIM" || detail.type === "TRAVEL_SUBSISTENCE" ? "1fr 1fr" : "1fr",
              gap: 12
            }}
          >
            <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, background: "var(--surface-soft)" }}>
              <b>Summary</b>
              {item.doc_type === "ADVANCE" ? (
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  <div>Purpose: {detail.purpose || "—"}</div>
                  <div>Requested Total: {fmt(detail.requested_total)}</div>
                  <div>Approved Total: {fmt(detail.approved_total)}</div>
                  <div>Payment: {detail.payment_method} {detail.payment_account || ""}</div>
                </div>
              ) : item.doc_type === "ACCOMMODATION" ? (
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  <div>Employee: {detail.requester_name || "—"}</div>
                  <div>Created By: {detail.created_by_name || "—"}</div>
                  <div>Location: {detail.location || "—"}</div>
                  <div>Provider: {detail.provider || "—"}</div>
                  <div>Dates: {detail.check_in ? fmtDate(detail.check_in) : "—"} to {detail.check_out ? fmtDate(detail.check_out) : "—"}</div>
                  <div>Amount: {fmt(detail.amount)}</div>
                  <div>
                    Quotations: {detail.quotations?.length ? detail.quotations.map((q: any) => q.file_name || q.path?.split("/").pop() || "Uploaded").join(", ") : "None uploaded"}
                  </div>
                  <div>Advance: {detail.advance_purpose || "—"} ({detail.advance_status || "—"})</div>
                </div>
              ) : (
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  <div>Project: {detail.project_number || "—"}</div>
                  <div>Month: {detail.month || "—"}</div>
                  <div>Clearance Total: {fmt(detail.claim_total)}</div>
                  <div>Advance Amount: {fmt(detail.advance_amount)}</div>
                  <div>Balance Amount: {fmt(detail.balance_amount)} (positive = employee refunds company; negative = company pays employee)</div>
                </div>
              )}
            </div>

            {(item.doc_type === "CLAIM" || detail.type === "TRAVEL_SUBSISTENCE") && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, background: "var(--surface-soft)" }}>
                <b>Lines</b>

                {item.doc_type === "ADVANCE" ? (
                  <div style={{ marginTop: 8, maxHeight: 260, overflow: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", color: "var(--text)" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                          <th style={{ padding: 6 }}>Date</th>
                          <th style={{ padding: 6 }}>Meals</th>
                          <th style={{ padding: 6 }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.lines || []).map((l: any) => (
                          <tr key={l.id} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: 6 }}>{fmtDate(l.line_date)}</td>
                            <td style={{ padding: 6 }}>{fmt(Number(l.meals) || Number(l.lunch || 0) + Number(l.dinner || 0))}</td>
                            <td style={{ padding: 6 }}>{fmt(Number(l.meals) || Number(l.lunch || 0) + Number(l.dinner || 0))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ marginTop: 8, maxHeight: 260, overflow: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", color: "var(--text)" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                          <th style={{ padding: 6 }}>Date</th>
                          <th style={{ padding: 6 }}>Route</th>
                          <th style={{ padding: 6 }}>Petrol</th>
                          <th style={{ padding: 6 }}>Meals</th>
                          <th style={{ padding: 6 }}>Other</th>
                          <th style={{ padding: 6 }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.trips || []).map((t: any) => (
                          <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: 6 }}>{fmtDate(t.trip_date)}</td>
                            <td style={{ padding: 6 }}>{(t.from_place || "—") + " → " + (t.to_place || "—")}</td>
                            <td style={{ padding: 6 }}>{fmt(t.petrol_allowance)}</td>
                            <td style={{ padding: 6 }}>{fmt((t.breakfast || 0) + (t.lunch || 0) + (t.dinner || 0))}</td>
                            <td style={{ padding: 6 }}>{fmt(t.other_expenses)}</td>
                            <td style={{ padding: 6 }}>{fmt(t.line_total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {item.doc_type === "ADVANCE" && detail.type === "TRAVEL_SUBSISTENCE" && (
              <div style={{ gridColumn: "1 / -1", border: "1px solid var(--border)", borderRadius: 12, padding: 12, background: "var(--surface-soft)" }}>
                <b>Accommodation Requests</b>
                {(detail.accommodation_requests || []).length === 0 ? (
                  <div style={{ marginTop: 8, opacity: 0.75 }}>No HR accommodation request has been sent to Finance.</div>
                ) : (
                  <div style={{ marginTop: 8, overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", color: "var(--text)" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                          <th style={{ padding: 6 }}>Status</th>
                          <th style={{ padding: 6 }}>Location</th>
                          <th style={{ padding: 6 }}>Provider</th>
                          <th style={{ padding: 6 }}>Amount</th>
                          <th style={{ padding: 6 }}>Created By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.accommodation_requests || []).map((a: any) => (
                          <tr key={a.id} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: 6 }}>{a.status}</td>
                            <td style={{ padding: 6 }}>{a.location || "—"}</td>
                            <td style={{ padding: 6 }}>{a.provider || "—"}</td>
                            <td style={{ padding: 6 }}>{fmt(a.amount)}</td>
                            <td style={{ padding: 6 }}>{a.created_by_name || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div style={{ gridColumn: "1 / -1", border: "1px solid var(--border)", borderRadius: 12, padding: 12, background: "var(--surface-soft)" }}>
              <b>Action</b>

              {canCreateAccommodation && (
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Location</div>
                    <input value={accommodationLocation} onChange={(e) => setAccommodationLocation(e.target.value)} style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Provider</div>
                    <input value={accommodationProvider} onChange={(e) => setAccommodationProvider(e.target.value)} style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Amount</div>
                    <input type="number" value={accommodationAmount} onChange={(e) => setAccommodationAmount(e.target.value)} style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Check In</div>
                    <input type="date" value={accommodationCheckIn} onChange={(e) => setAccommodationCheckIn(e.target.value)} style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Check Out</div>
                    <input type="date" value={accommodationCheckOut} onChange={(e) => setAccommodationCheckOut(e.target.value)} style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Notes</div>
                    <input value={accommodationNotes} onChange={(e) => setAccommodationNotes(e.target.value)} style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }} />
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Quotation File</div>
                    <input
                      type="file"
                      accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
                      onChange={(e) => {
                        setAccommodationQuotation(e.target.files?.[0] || null);
                      }}
                      style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                    />
                  </div>
                </div>
              )}

              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    {canRollbackAdvance || canRejectAdvance || canRejectAccommodation ? "Comments (required for Roll Back / Reject)" : "Comments (optional)"}
                  </div>
                  <textarea
                    value={comments}
                    onChange={(e) => {
                      setComments(e.target.value);
                      if (rollbackError) setRollbackError(null);
                      if (error === "Enter comments before rejecting this advance.") setError(null);
                    }}
                    style={{ width: "100%", minHeight: 70, padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                    placeholder={canRollbackAdvance || canRejectAdvance || canRejectAccommodation ? "Enter reason for rollback/reject" : ""}
                  />
                  {rollbackError && (
                    <div style={{ marginTop: 4, fontSize: 12, color: "#b45309" }}>
                      {rollbackError}
                    </div>
                  )}
                </div>

                <div style={{ minWidth: 0 }}>
                  {item.doc_type === "ADVANCE" && canMarkPaid && (
                    <>
                      <div style={{ fontSize: 13, opacity: 0.8 }}>Payment Reference</div>
                      <input
                        value={paidRef}
                        onChange={(e) => setPaidRef(e.target.value)}
                        style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                        placeholder="EcoCash txn / voucher"
                      />
                    </>
                  )}

                  {item.doc_type === "ACCOMMODATION" && canMarkAccommodationPaid && (
                    <>
                      <div style={{ fontSize: 13, opacity: 0.8 }}>Payment Reference</div>
                      <input
                        value={paidRef}
                        onChange={(e) => setPaidRef(e.target.value)}
                        style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
                        placeholder="Budget code"
                      />
                    </>
                  )}

                  {item.doc_type === "CLAIM" && canSettle && (
                    <div style={{ display: "grid", gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 13, opacity: 0.8 }}>Settlement Method</div>
                        <select value={settleMethod} onChange={(e) => setSettleMethod(e.target.value as any)} style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}>
                          <option value="ECOCASH">ECOCASH</option>
                          <option value="BANK">BANK</option>
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 13, opacity: 0.8 }}>Settlement Reference</div>
                        <input value={settleRef} onChange={(e) => setSettleRef(e.target.value)} style={{ width: "100%", padding: 8, boxSizing: "border-box", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }} />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {canCountersign && (
                  <button className="button small-button" disabled={busy} onClick={() => act(() => api.countersignAdvance(item.id, comments))} style={{ padding: "8px 12px" }}>
                    Countersign Advance
                  </button>
                )}

                {(canApproveAdvance || canRejectAdvance || canRollbackAdvance) && (
                  <>
                    {canApproveAdvance && (
                      <button className="button small-button" disabled={busy} onClick={handleApproveAdvance} style={{ padding: "8px 12px" }}>
                        {role === "HR_MANAGER" ? "Approve for HR Accommodation" : "Approve Advance"}
                      </button>
                    )}
                    {canRejectAdvance && (
                      <button
                        className="button small-button"
                        disabled={busy}
                        onClick={handleRejectAdvance}
                        style={{ padding: "8px 12px", backgroundColor: "#dc2626", color: "white" }}
                      >
                        Reject Advance
                      </button>
                    )}
                    {canRollbackAdvance && (
                      <button className="button small-button" disabled={busy} onClick={handleRollbackAdvance} style={{ padding: "8px 12px" }}>
                        Roll Back to Draft
                      </button>
                    )}
                  </>
                )}

                {canMarkPaid && (
                  <button className="button small-button" disabled={busy || !paidRef.trim()} onClick={() => act(() => api.markAdvancePaid(item.id, paidRef.trim()))} style={{ padding: "8px 12px" }}>
                    Mark Advance Paid
                  </button>
                )}

                {canCreateAccommodation && (
                  <button
                    className="button small-button"
                    disabled={busy || !accommodationQuotation}
                    onClick={handleCreateAccommodation}
                    style={{ padding: "8px 12px" }}
                  >
                    Upload quotation and send to Finance
                  </button>
                )}

                {canMarkAccommodationPaid && (
                  <button className="button small-button" disabled={busy || !paidRef.trim()} onClick={() => act(() => api.markAccommodationPaid(item.id, paidRef.trim()))} style={{ padding: "8px 12px" }}>
                    Mark Request Paid
                  </button>
                )}

                {canRejectAccommodation && (
                  <button
                    className="button small-button"
                    disabled={busy || !comments.trim()}
                    onClick={() => act(() => api.rejectAccommodation(item.id, comments.trim()))}
                    style={{ padding: "8px 12px", backgroundColor: "#dc2626", color: "white" }}
                  >
                    Reject Request
                  </button>
                )}

                {canManagerApprove && (
                  <button className="button small-button" disabled={busy} onClick={() => act(() => api.managerApproveClaim(item.id, comments))} style={{ padding: "8px 12px" }}>
                    Certify Clearance
                  </button>
                )}

                {canAuthApproveClaim && (
                  <button className="button small-button" disabled={busy} onClick={() => act(() => api.authApproveClaim(item.id, comments))} style={{ padding: "8px 12px" }}>
                    HR Approve
                  </button>
                )}

                {canChiefApprove && (
                  <button className="button small-button" disabled={busy} onClick={() => act(() => api.chiefApproveClaim(item.id, comments))} style={{ padding: "8px 12px" }}>
                    Chief Officer Approve
                  </button>
                )}

                {canFinanceVerify && (
                  <button className="button small-button" disabled={busy} onClick={() => act(() => api.financeVerifyClaim(item.id, comments))} style={{ padding: "8px 12px" }}>
                    Finance Verify
                  </button>
                )}

                {canSettle && (
                  <button className="button small-button" disabled={busy || !settleRef.trim()} onClick={() => act(() => api.settleClaim(item.id, settleMethod, settleRef.trim()))} style={{ padding: "8px 12px" }}>
                    Settle Clearance
                  </button>
                )}

                {!((canCountersign || canRollbackAdvance || canRejectAdvance || canApproveAdvance || canMarkPaid || canCreateAccommodation || canMarkAccommodationPaid || canRejectAccommodation || canManagerApprove || canAuthApproveClaim || canChiefApprove || canFinanceVerify || canSettle)) && (
                  <div style={{ opacity: 0.75 }}>No action available for your role on this item.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
