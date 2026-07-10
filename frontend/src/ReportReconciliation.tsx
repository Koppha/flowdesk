import React, { useEffect, useMemo, useState } from "react";
import { formatMoney } from "./constants";
import { Download, Calendar } from "lucide-react";
import { api } from "./api";

interface Row {
  requester_id: string;
  requester_name: string;
  department: string | null;
  opening_balance: number;
  total_requested: number;
  total_paid: number;
  total_settled: number;
  closing_balance: number;
  currency?: string | null;
}

interface Props {
  onBack: () => void;
  meUserId?: string;
}

function monthToRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function ReportReconciliation({ onBack, meUserId }: Props) {
  const [mode, setMode] = useState<"month" | "custom">("month");
  const [month, setMonth] = useState(currentMonth());
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [tab, setTab] = useState<"mine" | "others">("mine");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { from, to } = useMemo(() => {
    if (mode === "month") return monthToRange(month);
    return { from: customFrom, to: customTo };
  }, [mode, month, customFrom, customTo]);

  useEffect(() => {
    if (!from || !to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.reconciliationReport(from, to)
      .then((res: any) => { if (!cancelled) setRows(Array.isArray(res?.rows) ? res.rows : []); })
      .catch((err: any) => { if (!cancelled) setError(err?.message || "Failed to load report"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to]);

  const mine = useMemo(() => rows.filter(r => r.requester_id === meUserId), [rows, meUserId]);
  const others = useMemo(() => rows.filter(r => r.requester_id !== meUserId), [rows, meUserId]);
  const active = tab === "mine" ? mine : others;

  function exportCsv() {
    const headers = ["Requester", "Division", "Opening Balance", "Total Requested", "Total Paid", "Total Settled", "Closing Balance"];
    const csvRows = active.map(r => [
      r.requester_name ?? "", r.department ?? "",
      r.opening_balance, r.total_requested, r.total_paid, r.total_settled, r.closing_balance,
    ]);
    const csv = [headers, ...csvRows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    el.download = `reconciliation-${tab}-${from}-to-${to}.csv`;
    el.click();
  }

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Reports</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Reconciliation</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Reconciliation Report</h1>
          <p className="ep-subtitle">Opening balance, requested, paid, settled and closing balance per requester for the selected period.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={exportCsv} disabled={!active.length}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* Period controls */}
      <div className="ep-panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "14px 20px", alignItems: "center" }}>
          <Calendar size={16} style={{ color: "var(--muted)" }} />
          <select className="ep-form-select" value={mode} onChange={e => setMode(e.target.value as "month" | "custom")}>
            <option value="month">Month</option>
            <option value="custom">Custom range</option>
          </select>
          {mode === "month" ? (
            <input type="month" className="ep-form-select" value={month} onChange={e => setMonth(e.target.value)} />
          ) : (
            <>
              <input type="date" className="ep-form-select" value={customFrom} onChange={e => setCustomFrom(e.target.value)} title="From date" />
              <input type="date" className="ep-form-select" value={customTo} onChange={e => setCustomTo(e.target.value)} title="To date" />
            </>
          )}
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>{active.length} results</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button className={tab === "mine" ? "ep-btn-primary" : "ep-btn-outline"} onClick={() => setTab("mine")}>
          My Requests ({mine.length})
        </button>
        <button className={tab === "others" ? "ep-btn-primary" : "ep-btn-outline"} onClick={() => setTab("others")}>
          All Other Requesters ({others.length})
        </button>
      </div>

      {/* Table */}
      <div className="ep-panel">
        <div className="ep-table-wrap">
          {error ? (
            <div className="ep-empty"><p>{error}</p></div>
          ) : loading ? (
            <div className="ep-empty"><p>Loading…</p></div>
          ) : active.length === 0 ? (
            <div className="ep-empty"><p>No activity for this period.</p></div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  <th>Requester</th>
                  <th>Division</th>
                  <th>Opening Balance</th>
                  <th>Total Requested</th>
                  <th>Total Paid</th>
                  <th>Total Settled</th>
                  <th>Closing Balance</th>
                </tr>
              </thead>
              <tbody>
                {active.map(r => (
                  <tr key={r.requester_id}>
                    <td style={{ fontWeight: 600, fontSize: "0.87rem" }}>{r.requester_name || "—"}</td>
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{r.department || "—"}</td>
                    <td>{formatMoney(r.opening_balance, r.currency ?? "LSL")}</td>
                    <td style={{ fontWeight: 600 }}>{formatMoney(r.total_requested, r.currency ?? "LSL")}</td>
                    <td>{formatMoney(r.total_paid, r.currency ?? "LSL")}</td>
                    <td>{formatMoney(r.total_settled, r.currency ?? "LSL")}</td>
                    <td style={{ fontWeight: 600 }}>{formatMoney(r.closing_balance, r.currency ?? "LSL")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
