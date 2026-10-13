// Claim Tracking — the end-to-end lifecycle (Draft -> Submitted -> Approvals
// -> Finance -> Payment/Settlement -> Closed) in one place, shared by
// Standby and Overtime claims since both now use the identical status
// vocabulary (DRAFT/SUBMITTED/REJECTED/FINANCE_PROCESSING/PAYMENT_PENDING/
// CLOSED) and the same route-versioned approval_steps/route_history shape.

export type TimelineStage = {
  key: string;
  label: string;
  state: "done" | "current" | "pending" | "rejected";
  timestamp?: string | null;
  detail?: string;
  comments?: string | null;
};

export function TimelineDot({ state, index }: { state: TimelineStage["state"]; index: number }) {
  const style: Record<TimelineStage["state"], { bg: string; content: string }> = {
    done: { bg: "#22c55e", content: "✓" },
    current: { bg: "#2563eb", content: String(index) },
    pending: { bg: "#e2e8f0", content: String(index) },
    rejected: { bg: "#ef4444", content: "✕" }
  };
  const s = style[state];
  return (
    <div style={{
      width: 22, height: 22, borderRadius: "50%", flexShrink: 0, marginTop: 2,
      background: s.bg, display: "flex", alignItems: "center", justifyContent: "center",
      color: state === "pending" ? "#64748b" : "#fff", fontSize: 11, fontWeight: 700
    }}>
      {s.content}
    </div>
  );
}

export function ClaimTrackingTimeline({
  claim,
  financeStageLabel = "Compensation Processing",
  finalStageLabel = "Paid / Closed",
  finalAmount,
  showFinanceStages = true,
  approvedLabel,
  awaitingTreasuryLabel,
  closedLabel,
  closedDetail
}: {
  claim: any;
  financeStageLabel?: string;
  finalStageLabel?: string;
  finalAmount?: (claim: any) => string | undefined;
  // false for a pre-claim Request (e.g. Overtime's request stage) whose
  // pipeline ends at Approved/Rejected — it never goes to Finance/Payment —
  // and also for Overtime/Standby claims now that neither has a Finance
  // stage: they go straight from the last approval to AWAITING_TREASURY,
  // then CLOSED once Treasury closes it.
  showFinanceStages?: boolean;
  approvedLabel?: string;
  // Shown when the claim has reached AWAITING_TREASURY — "done" once it's
  // actually CLOSED, "current" while still awaiting Treasury.
  awaitingTreasuryLabel?: string;
  // Shown instead of the Finance/Paid stages when showFinanceStages is false
  // and the claim has reached CLOSED — e.g. "Claim Closed" with the
  // converted/compensable hours as the detail line.
  closedLabel?: string;
  closedDetail?: (claim: any) => string | undefined;
}) {
  const stages: TimelineStage[] = [];

  stages.push({ key: "draft", label: "Draft Created", state: "done", timestamp: claim.created_at });

  const isResubmission = (claim.current_route_version || 1) > 1;
  if (claim.submitted_at) {
    stages.push({ key: "submitted", label: isResubmission ? "Resubmitted for Approval" : "Submitted for Approval", state: "done", timestamp: claim.submitted_at });
  } else if (claim.status === "DRAFT") {
    stages.push({
      key: "submit-pending",
      label: isResubmission ? "Returned — Awaiting Correction & Resubmission" : "Awaiting Submission",
      state: "current",
      comments: claim.finance_comments && isResubmission ? claim.finance_comments : undefined
    });
  }

  if (claim.status === "SUBMITTED" || claim.submitted_at) {
    for (const s of claim.approval_steps || []) {
      const isCurrent = claim.status === "SUBMITTED" && s.step_order === claim.current_step_order;
      stages.push({
        key: `step-${s.id}`,
        label: `${s.title} — ${s.approver_name}`,
        state: s.status === "APPROVED" ? "done" : s.status === "REJECTED" ? "rejected" : isCurrent ? "current" : "pending",
        timestamp: s.decided_at,
        comments: s.comments
      });
    }
  }

  if (approvedLabel && claim.status === "APPROVED") {
    stages.push({ key: "approved", label: approvedLabel, state: "done", timestamp: claim.updated_at });
  }

  if (!showFinanceStages) {
    // Pipeline ends at the approval steps above (plus the approved marker
    // just added), e.g. an Overtime Request's tracking — unless the caller
    // also wants an "awaiting Treasury" / "closed" stage once the claim
    // itself has finished its approval route.
    if (awaitingTreasuryLabel && ["AWAITING_TREASURY", "CLOSED"].includes(claim.status)) {
      stages.push({
        key: "awaiting-treasury",
        label: awaitingTreasuryLabel,
        state: claim.status === "CLOSED" ? "done" : "current",
        timestamp: claim.status === "CLOSED" ? undefined : claim.updated_at
      });
    }
    if (closedLabel && claim.status === "CLOSED") {
      stages.push({
        key: "closed",
        label: closedLabel,
        state: "done",
        timestamp: claim.closed_at,
        detail: closedDetail ? closedDetail(claim) : undefined
      });
    }
  } else if (claim.status === "REJECTED") {
    // Terminal — nothing further in the pipeline runs.
  } else if (claim.submitted_at || ["FINANCE_PROCESSING", "PAYMENT_PENDING", "CLOSED"].includes(claim.status)) {
    const financeDone = ["PAYMENT_PENDING", "CLOSED"].includes(claim.status);
    const financeState: TimelineStage["state"] = financeDone ? "done" : claim.status === "FINANCE_PROCESSING" ? "current" : "pending";
    stages.push({
      key: "finance",
      label: financeStageLabel,
      state: financeState,
      timestamp: claim.finance_processed_at,
      detail: claim.finance_reference ? `Ref: ${claim.finance_reference}` : undefined
    });

    const paidState: TimelineStage["state"] = claim.status === "CLOSED" ? "done" : claim.status === "PAYMENT_PENDING" ? "current" : "pending";
    stages.push({
      key: "paid",
      label: finalStageLabel,
      state: paidState,
      timestamp: claim.paid_at,
      detail: finalAmount ? finalAmount(claim) : (claim.calculated_amount != null ? `M ${Number(claim.calculated_amount).toFixed(2)}` : undefined)
    });
  }

  return (
    <div>
      <div>
        {stages.map((s, idx) => (
          <div key={s.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 12 }}>
            <TimelineDot state={s.state} index={idx + 1} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{s.label}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                {s.timestamp ? new Date(s.timestamp).toLocaleString() : s.state === "current" ? "In progress" : s.state === "pending" ? "Not yet reached" : ""}
                {s.detail ? ` · ${s.detail}` : ""}
              </div>
              {s.comments && <div style={{ fontSize: 12, marginTop: 2 }}>{s.comments}</div>}
            </div>
          </div>
        ))}
      </div>

      {Array.isArray(claim.route_history) && claim.route_history.length > 0 && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px dashed var(--border)" }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.4 }}>
            Earlier Approval Route Attempts
          </div>
          {Object.entries(
            (claim.route_history as any[]).reduce((acc: Record<number, any[]>, s) => {
              (acc[s.route_version] = acc[s.route_version] || []).push(s);
              return acc;
            }, {})
          ).map(([version, steps]) => (
            <div key={version} style={{ marginBottom: 10, fontSize: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Attempt {version}</div>
              {(steps as any[]).map((s) => (
                <div key={s.id} style={{ display: "flex", gap: 8, marginBottom: 3, color: "var(--muted)" }}>
                  <span>{s.title} — {s.approver_name}:</span>
                  <span style={{ fontWeight: 600, color: s.status === "APPROVED" ? "#15803d" : s.status === "REJECTED" ? "#b91c1c" : s.status === "SENT_BACK" ? "#b45309" : "#475569" }}>
                    {s.status.replace(/_/g, " ").toLowerCase()}
                  </span>
                  {s.comments && <span>— {s.comments}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
