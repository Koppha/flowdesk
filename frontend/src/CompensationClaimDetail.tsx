import { useEffect, useState } from "react";
import Swal from "sweetalert2";
import { api } from "./api";
import { confirmAction } from "./alerts";
import { ChevronLeft, ChevronDown, ChevronUp } from "lucide-react";
import { ClaimTrackingTimeline } from "./components/ClaimTrackingTimeline";

// The Treasury-only screen — one shell shared by all three claim types,
// dynamically rendering the type-specific breakdown (per the mockup's own
// "share the rest of the page" design). This is where FlowDesk's one
// terminal Compensation action lives: Treasury ticks the confirmation
// checkbox and clicks Close Claim. Nothing past that is tracked here —
// FlowDesk does not do payroll.

const TYPE_LABEL: Record<string, string> = { OVERTIME: "Overtime Claim", STANDBY: "Standby Claim", CALL_OUT: "Call-Out Claim" };
const STATUS_STYLE: Record<string, [string, string]> = {
  CLOSED: ["#d1fae5", "#065f46"],
  AWAITING_TREASURY: ["#fef3c7", "#92400e"]
};

function StatusBadge({ status }: { status: string }) {
  const [bg, color] = STATUS_STYLE[status] || ["#f1f5f9", "#64748b"];
  return <span style={{ padding: "3px 10px", borderRadius: 99, fontSize: 12, fontWeight: 700, background: bg, color }}>{status === "AWAITING_TREASURY" ? "Awaiting Treasury" : "Closed"}</span>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ep-panel" style={{ marginBottom: 18 }}>
      <div className="ep-panel-head"><div className="ep-panel-title">{title}</div></div>
      <div className="ep-panel-body">{children}</div>
    </section>
  );
}

function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "5px 0", borderBottom: "1px solid var(--border-soft, #f1f5f9)" }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function RateBreakdownTable({ rows }: { rows: { rate: string; hours: number; converted_hours: number }[] }) {
  const totalHours = rows.reduce((s, r) => s + r.hours, 0);
  const totalConverted = rows.reduce((s, r) => s + r.converted_hours, 0);
  return (
    <div className="ep-table-wrap">
      <table className="ep-table">
        <thead><tr><th>Rate</th><th>Number of Hours</th><th>Converted to Number of Hours</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rate}><td>{r.rate}</td><td>{r.hours.toFixed(1)}</td><td>{r.converted_hours.toFixed(2)}</td></tr>
          ))}
          <tr style={{ fontWeight: 700 }}><td>Total</td><td>{totalHours.toFixed(1)}</td><td>{totalConverted.toFixed(2)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function OvertimeClaimDetails({ claim }: { claim: any }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <Card title="Claim Summary">
        <KeyValue label="Total Overtime" value={`${Number(claim.total_overtime || 0).toFixed(1)} hours`} />
        <KeyValue label="Converted to Number of Hours" value={Number(claim.converted_hours || 0).toFixed(2)} />
        <KeyValue label="Equivalent Days" value={Number(claim.equivalent_days || 0).toFixed(3)} />
        {claim.compensation_preference && <KeyValue label="Compensation" value={claim.compensation_preference} />}
      </Card>
      <Card title="Overtime Details (Grouped by Rate)">
        <RateBreakdownTable rows={claim.rate_breakdown} />
        <button type="button" className="button button-subtle" style={{ marginTop: 10 }} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />} View Detailed Overtime Entries
        </button>
        {expanded && (
          <div className="ep-table-wrap" style={{ marginTop: 10 }}>
            <table className="ep-table">
              <thead><tr><th>Date</th><th>Day</th><th>From</th><th>To</th><th>Ordered By</th><th>125%</th><th>150%</th><th>200%</th><th>Converted Hours</th></tr></thead>
              <tbody>
                {(claim.lines || []).map((l: any, i: number) => (
                  <tr key={i}>
                    <td>{l.date}</td><td>{l.day || "—"}</td><td>{l.from_time}</td><td>{l.to_time}</td><td>{l.ordered_by || "—"}</td>
                    <td>{Number(l.hours_125 || 0) || "—"}</td><td>{Number(l.hours_150 || 0) || "—"}</td><td>{Number(l.hours_200 || 0) || "—"}</td>
                    <td>{l.converted_hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function StandbyClaimDetails({ claim }: { claim: any }) {
  return (
    <>
      <Card title="Claim Summary">
        <KeyValue label="Standby Hours" value={Number(claim.total_standby_hours || 0).toFixed(1)} />
        <KeyValue label="Compensable Hours" value={Number(claim.compensable_hours || 0).toFixed(2)} />
        <KeyValue label="Equivalent Days" value={Number(claim.equivalent_days || 0).toFixed(3)} />
        {claim.compensation_preference && <KeyValue label="Compensation" value={claim.compensation_preference} />}
      </Card>
      <Card title="Standby Details">
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Standby Date</th><th>Day</th><th>From</th><th>To</th><th>Standby Hours</th><th>Compensable Hours</th></tr></thead>
            <tbody>
              {(claim.lines || []).map((l: any, i: number) => (
                <tr key={i}>
                  <td>{l.standby_date}</td><td>{l.day}</td><td>{l.start_time}</td><td>{l.end_time}</td>
                  <td>{l.standby_hours.toFixed(1)}</td><td>{l.compensable_hours.toFixed(2)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={4}>Total</td>
                <td>{Number(claim.total_standby_hours || 0).toFixed(1)}</td>
                <td>{Number(claim.compensable_hours || 0).toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {claim.roster_label && <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>Source roster: {claim.roster_label}</p>}
      </Card>
    </>
  );
}

function CallOutClaimDetails({ claim }: { claim: any }) {
  return (
    <>
      <Card title="Claim Summary">
        <KeyValue label="Total Call-Out Hours" value={Number(claim.hours || 0).toFixed(1)} />
        <KeyValue label="Converted Hours" value={Number(claim.converted_hours || 0).toFixed(2)} />
        <KeyValue label="Reason" value={claim.reason || "—"} />
      </Card>
      <Card title="Call-Out Details">
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead><tr><th>Date</th><th>From</th><th>To</th><th>Hours</th><th>Applicable Rate</th><th>Converted Hours</th></tr></thead>
            <tbody>
              <tr>
                <td>{claim.call_date}</td><td>{claim.start_time}</td><td>{claim.end_time}</td>
                <td>{Number(claim.hours || 0).toFixed(1)}</td><td>{claim.rate_pct}%</td><td>{Number(claim.converted_hours || 0).toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

export default function CompensationClaimDetail({ claimType, claimId, onBack }: { claimType: string; claimId: string; onBack: () => void }) {
  const [claim, setClaim] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [comment, setComment] = useState("");
  const [closing, setClosing] = useState(false);

  async function load() {
    try {
      setClaim(await api.compensationClaimDetail(claimType, claimId));
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [claimType, claimId]);

  async function closeClaim() {
    if (!claim) return;
    const ok = await confirmAction({
      title: "Close Compensation Claim?",
      text: `You are confirming that the approved compensation hours have been taken for processing outside FlowDesk.\n\nClaim: ${claim.claim_no}\nEmployee: ${claim.employee_name}\nType: ${TYPE_LABEL[claimType]}\nPeriod: ${claim.period_label}\n\nThis action will close the FlowDesk claim.`,
      confirmButtonText: "Confirm & Close"
    });
    if (!ok) return;
    setClosing(true);
    try {
      await api.closeCompensationClaim(claimType, claimId, comment.trim() || undefined);
      await Swal.fire({ icon: "success", title: "Claim closed", timer: 1400, showConfirmButton: false });
      await load();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Could not close claim", text: e.message });
    } finally {
      setClosing(false);
    }
  }

  if (loading) return <div className="ep-page"><p>Loading claim…</p></div>;
  if (error || !claim) return <div className="ep-page"><pre className="inbox-error">{error || "Claim not found"}</pre></div>;

  return (
    <div className="ep-page">
      <button className="button button-subtle" type="button" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={14} aria-hidden /> Back to Compensation Claims</button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 className="ep-title" style={{ marginBottom: 2 }}>{TYPE_LABEL[claimType]}</h1>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>{claim.claim_no}</div>
        </div>
        <StatusBadge status={claim.status} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="Employee Information">
          <KeyValue label="Employee" value={claim.employee_name || "—"} />
          <KeyValue label="Employee No." value={claim.employee_no || "—"} />
          <KeyValue label="Position" value={claim.position || "—"} />
          <KeyValue label="Department" value={claim.department || "—"} />
          <KeyValue label="Division" value={claim.division_name || "—"} />
          <KeyValue label="Section" value={claim.section_name || "—"} />
          <KeyValue label="Period" value={claim.period_label || "—"} />
        </Card>
        {claimType === "OVERTIME" && <OvertimeClaimDetails claim={claim} />}
        {claimType === "STANDBY" && <StandbyClaimDetails claim={claim} />}
        {claimType === "CALL_OUT" && <CallOutClaimDetails claim={claim} />}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="Approval History">
          <ClaimTrackingTimeline
            claim={claim}
            showFinanceStages={false}
            awaitingTreasuryLabel="Awaiting Treasury"
            closedLabel="Claim Closed"
            closedDetail={() => undefined}
          />
        </Card>

        <Card title="Treasury Confirmation">
          {claim.status === "CLOSED" ? (
            <>
              <KeyValue label="Closed By" value={claim.processed_by_name || "—"} />
              <KeyValue label="Closed At" value={claim.closed_at ? new Date(claim.closed_at).toLocaleString() : "—"} />
              {claim.treasury_comment && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>Treasury Comments</div>
                  <div style={{ fontSize: 13 }}>{claim.treasury_comment}</div>
                </div>
              )}
            </>
          ) : (
            <>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, marginBottom: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
                <span>I confirm that I have taken the approved compensation hours for processing.</span>
              </label>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>Treasury Comments (optional)</label>
              <textarea
                className="review-control" style={{ width: "100%", boxSizing: "border-box", marginBottom: 14 }} rows={3}
                value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add comments here…"
              />
              <button className="ep-btn" type="button" disabled={!confirmed || closing} onClick={() => void closeClaim()} style={{ width: "100%", justifyContent: "center" }}>
                {closing ? "Closing…" : "Close Claim"}
              </button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
