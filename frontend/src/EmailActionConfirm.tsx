import { useEffect, useState } from "react";
import { api } from "./api";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";

type Detail = {
  docType: "ADVANCE" | "CLAIM" | "CUSTOM_REQUEST";
  approverName: string | null;
  alreadyActioned: boolean;
  liveStatus: string;
  summary: { docLabel: string; requester: string | null; amount: number | null; status: string } | null;
};

const DOC_TYPE_LABELS: Record<string, string> = {
  ADVANCE: "Advance Request",
  CLAIM: "Clearance Claim",
  CUSTOM_REQUEST: "Request"
};

function formatMoney(amount: number | null) {
  if (amount === null || amount === undefined) return null;
  return `M${amount.toFixed(2)}`;
}

export default function EmailActionConfirm({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [action, setAction] = useState<"APPROVE" | "REJECT" | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ status: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setDetail(await api.emailActionDetail(token));
      } catch (e: any) {
        setError(e?.message || "This link is invalid or has expired.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  async function submit() {
    if (!action) return;
    if (action === "REJECT" && !comment.trim()) {
      setError("Please add a comment explaining why you're rejecting this.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.emailActionConfirm(token, { action, comment: comment.trim() || undefined });
      setResult(res);
    } catch (e: any) {
      setError(e?.message || "Failed to submit your decision.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 480, background: "#fff", borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,0.12)", padding: 28 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700 }}>Approve / Reject by Email</h2>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "#64748b" }}>No login required — this link is unique to you.</p>

        {loading ? (
          <div style={{ padding: "30px 0", textAlign: "center", color: "#64748b" }}>Loading…</div>
        ) : result ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <CheckCircle2 size={40} color="#16a34a" style={{ marginBottom: 10 }} />
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {result.status === "REJECTED" ? "Rejected" : "Submitted"}
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
              Your decision has been recorded. You may close this page.
            </div>
          </div>
        ) : error && !detail ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <ShieldAlert size={40} color="#dc2626" style={{ marginBottom: 10 }} />
            <div style={{ fontWeight: 700, fontSize: 16 }}>Link not available</div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>{error}</div>
          </div>
        ) : detail?.alreadyActioned ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <XCircle size={40} color="#d97706" style={{ marginBottom: 10 }} />
            <div style={{ fontWeight: 700, fontSize: 16 }}>Already actioned</div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
              This step has already moved on (current status: {detail.liveStatus.replace(/_/g, " ")}). Please check the app for the latest status.
            </div>
          </div>
        ) : (
          <>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 14, marginBottom: 18, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{DOC_TYPE_LABELS[detail?.docType || ""] || "Request"}</div>
              <div>{detail?.summary?.docLabel}</div>
              <div style={{ color: "#64748b", marginTop: 4 }}>Requested by: {detail?.summary?.requester || "—"}</div>
              {detail?.summary?.amount !== null && detail?.summary?.amount !== undefined && (
                <div style={{ color: "#64748b" }}>Amount: {formatMoney(detail.summary.amount)}</div>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <button
                type="button"
                onClick={() => setAction("APPROVE")}
                style={{
                  flex: 1, padding: "10px 0", borderRadius: 8, border: action === "APPROVE" ? "2px solid #16a34a" : "1px solid #e2e8f0",
                  background: action === "APPROVE" ? "#f0fdf4" : "#fff", color: "#16a34a", fontWeight: 700, cursor: "pointer"
                }}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => setAction("REJECT")}
                style={{
                  flex: 1, padding: "10px 0", borderRadius: 8, border: action === "REJECT" ? "2px solid #dc2626" : "1px solid #e2e8f0",
                  background: action === "REJECT" ? "#fef2f2" : "#fff", color: "#dc2626", fontWeight: 700, cursor: "pointer"
                }}
              >
                Reject
              </button>
            </div>

            {action && (
              <textarea
                placeholder={action === "REJECT" ? "Reason for rejection (required)" : "Comment (optional)"}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                style={{ width: "100%", boxSizing: "border-box", padding: 10, borderRadius: 8, border: "1px solid #e2e8f0", marginBottom: 14, fontSize: 13 }}
              />
            )}

            {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>}

            <button
              type="button"
              onClick={submit}
              disabled={!action || submitting}
              style={{
                width: "100%", padding: "11px 0", borderRadius: 8, border: "none",
                background: !action ? "#cbd5e1" : "#1d4ed8", color: "#fff", fontWeight: 700, cursor: !action ? "not-allowed" : "pointer"
              }}
            >
              {submitting ? "Submitting…" : "Confirm Decision"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
