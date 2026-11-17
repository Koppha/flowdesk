import { useEffect, useState } from "react";
import { API, getToken } from "./api";
import { formatMoney } from "./constants";
import { showNotice } from "./alerts";
import { Banknote, FileText, Upload, X } from "lucide-react";

// My salary advances' repayment, on My Advances: what's left, the months
// still to be deducted, and "Make a repayment" - pay some or all of the
// balance yourself and upload the proof. Finance accepts it; the installment
// stays the same and the deductions end sooner (or stop, if it's all paid).
// See GET/POST /salary-advances (salary-advances.routes.ts).

type PlanMonth = { month: string; amount: number; planned: number; cancelled: boolean };
type Repayment = {
  id: string; amount: number; payment_date: string; reference: string; note: string | null; file_name: string | null;
  status: "SUBMITTED" | "ACCEPTED" | "REJECTED"; reject_reason: string | null; submitted_at: string; reviewed_at: string | null;
};
type MySalaryAdvance = {
  id: string; reference: string; status: string; amount: number; payback_months: number; paid_at: string | null;
  schedule: PlanMonth[]; repaid: number; deducted_to_date: number; outstanding: number | null;
  pending_repayments: number; can_repay_up_to: number; paid_in_full: boolean; this_month: string; repayments: Repayment[];
};

const money = (v: number | null | undefined) => (v == null ? "—" : formatMoney(v, "LSL"));
function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const REPAY_STATUS: Record<string, { label: string; bg: string; color: string }> = {
  SUBMITTED: { label: "Waiting for Finance", bg: "#fef3c7", color: "#92400e" },
  ACCEPTED: { label: "Accepted", bg: "#d1fae5", color: "#065f46" },
  REJECTED: { label: "Not accepted", bg: "#fee2e2", color: "#991b1b" }
};

async function call(method: string, path: string, body?: FormData) {
  const token = getToken();
  const r = await fetch(`${API}/salary-advances${path}`, { method, cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.error || `Request failed (${r.status})`);
  return json;
}

async function openProof(id: string) {
  try {
    const token = getToken();
    const r = await fetch(`${API}/salary-advances/repayments/${id}/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) throw new Error("Could not open the proof");
    window.open(URL.createObjectURL(await r.blob()), "_blank", "noopener");
  } catch (e: any) {
    void showNotice(e?.message || "Could not open the proof");
  }
}

function RepayForm({ advance, onDone, onCancel }: { advance: MySalaryAdvance; onDone: () => void; onCancel: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = advance.can_repay_up_to;

  async function submit() {
    setError(null);
    const value = Number(amount);
    if (!value || value <= 0) return setError("Enter the amount you paid.");
    if (value > max + 0.004) return setError(`That's more than you owe - at most ${money(max)}.`);
    if (!reference.trim()) return setError("Enter the payment reference.");
    if (!file) return setError("Upload your proof of payment.");
    const form = new FormData();
    form.append("amount", String(value));
    form.append("payment_date", date);
    form.append("reference", reference.trim());
    if (note.trim()) form.append("note", note.trim());
    form.append("file", file);
    setBusy(true);
    try {
      await call("POST", `/${advance.id}/repayments`, form);
      void showNotice("Repayment sent to Finance. You'll be told once it's accepted.");
      onDone();
    } catch (e: any) {
      setError(e?.message || "Could not send the repayment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 14, marginTop: 10, background: "var(--surface, #fff)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>Make a repayment</strong>
        <button type="button" className="ep-icon-btn" onClick={onCancel} aria-label="Close"><X size={14} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label style={{ fontSize: 12.5 }}>Amount paid (M)
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input className="ep-form-input" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Up to ${max.toFixed(2)}`} />
            <button type="button" className="ep-btn-outline" style={{ whiteSpace: "nowrap" }} onClick={() => setAmount(max.toFixed(2))}>Pay full balance</button>
          </div>
        </label>
        <label style={{ fontSize: 12.5 }}>Date paid
          <input className="ep-form-input" style={{ marginTop: 4 }} type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label style={{ fontSize: 12.5 }}>Payment reference
          <input className="ep-form-input" style={{ marginTop: 4 }} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bank or EcoCash reference" />
        </label>
        <label style={{ fontSize: 12.5 }}>Proof of payment (PDF or photo)
          <input className="ep-form-input" style={{ marginTop: 4 }} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <label style={{ display: "block", fontSize: 12.5, marginTop: 10 }}>Note (optional)
        <input className="ep-form-input" style={{ marginTop: 4 }} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <p style={{ fontSize: 12, color: "var(--muted)", margin: "10px 0 0" }}>
        Your monthly deduction stays the same - a partial repayment makes the deductions end sooner. Paying the full balance stops them.
      </p>
      {error && <div style={{ color: "#991b1b", fontSize: 12.5, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button type="button" className="ep-btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="button button-primary small-button" onClick={() => void submit()} disabled={busy}>
          <Upload size={14} aria-hidden /> {busy ? "Sending…" : "Send to Finance"}
        </button>
      </div>
    </div>
  );
}

export default function SalaryAdvanceRepayments() {
  const [items, setItems] = useState<MySalaryAdvance[]>([]);
  const [repaying, setRepaying] = useState<string | null>(null);

  function load() {
    call("GET", "/mine").then((b) => setItems(b.items || [])).catch(() => setItems([]));
  }
  useEffect(load, []);

  // Paid salary advances still being repaid, or with repayments to show.
  const shown = items.filter((a) => a.status === "PAID" && (!a.paid_in_full || a.repayments.some((r) => r.status === "SUBMITTED")));
  if (!shown.length) return null;

  return (
    <div className="ep-panel" style={{ padding: "16px 20px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Banknote size={18} aria-hidden />
        <strong style={{ fontSize: 15 }}>Salary advance repayment</strong>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 12px" }}>
        Deducted from your salary each month. You can also repay some or all of it yourself - upload the proof and Finance confirms it.
      </p>
      {shown.map((a) => {
        const live = a.schedule.filter((s) => !s.cancelled && s.month >= a.this_month);
        return (
          <div key={a.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div style={{ fontSize: 13 }}>
                <strong>{a.reference}</strong> · {money(a.amount)} · installment {money(a.schedule[0]?.planned)} a month
                <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 2 }}>
                  Still owed <strong style={{ color: "#92400e" }}>{money(a.outstanding)}</strong>
                  {a.repaid > 0 && <> · repaid yourself {money(a.repaid)}</>}
                  {a.pending_repayments > 0 && <> · {money(a.pending_repayments)} waiting for Finance</>}
                  {live.length > 0 && <> · deductions until {monthLabel(live[live.length - 1].month)}</>}
                </div>
              </div>
              {a.can_repay_up_to > 0 && repaying !== a.id && (
                <button type="button" className="button button-primary small-button" onClick={() => setRepaying(a.id)}>Make a repayment</button>
              )}
            </div>
            {live.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {live.map((s) => (
                  <span key={s.month} style={{ fontSize: 11.5, border: "1px solid var(--border)", borderRadius: 99, padding: "2px 9px" }}>
                    {monthLabel(s.month)}: {money(s.amount)}
                  </span>
                ))}
              </div>
            )}
            {repaying === a.id && <RepayForm advance={a} onCancel={() => setRepaying(null)} onDone={() => { setRepaying(null); load(); }} />}
            {a.repayments.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {a.repayments.map((r) => {
                  const st = REPAY_STATUS[r.status];
                  return (
                    <div key={r.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 0" }}>
                      <span style={{ padding: "1px 8px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: st.bg, color: st.color }}>{st.label}</span>
                      <span>{money(r.amount)} paid {fmtDate(r.payment_date)} · ref {r.reference}</span>
                      <button type="button" onClick={() => void openProof(r.id)} style={{ border: 0, background: "none", color: "var(--primary, #2563eb)", cursor: "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 3 }}>
                        <FileText size={12} /> Proof
                      </button>
                      {r.status === "REJECTED" && r.reject_reason && <span style={{ color: "#991b1b" }}>— {r.reject_reason}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
