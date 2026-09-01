import { useEffect, useState } from "react";
import { api, getUserFromToken } from "./api";
import { AlertTriangle, CheckCircle2, Trash2, ArrowLeft, RefreshCw, Wrench } from "lucide-react";

type Category = { key: string; label: string; count: number };

type ReassignmentResult = {
  module: "advance" | "claim";
  requestId: string;
  requestType: string;
  positionType: string;
  oldApproverName: string | null;
  newApproverName: string | null;
};
type ReassignmentWarning = { module: "advance" | "claim"; requestId: string; reason: string };

export default function DataCleanup({ onBack }: { onBack: () => void }) {
  const me = getUserFromToken();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepResult, setSweepResult] = useState<{ reassignments: ReassignmentResult[]; warnings: ReassignmentWarning[] } | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);

  async function runSweep() {
    setSweepBusy(true);
    setSweepError(null);
    setSweepResult(null);
    try {
      const resp = await api.runApprovalReassignmentSweep();
      setSweepResult(resp);
    } catch (e: any) {
      setSweepError(e?.message || "Failed to run the reassignment sweep.");
    } finally {
      setSweepBusy(false);
    }
  }

  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetResult, setResetResult] = useState<{ usersDeleted: number } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  async function load() {
    const resp = await api.dataCleanupCategories();
    setCategories(resp.categories || []);
  }

  useEffect(() => { void load(); }, []);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (!categories) return;
    setSelected((prev) => (prev.size === categories.length ? new Set() : new Set(categories.map((c) => c.key))));
  }

  async function wipe() {
    if (confirmText !== "WIPE" || selected.size === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const resp = await api.dataCleanupWipe(Array.from(selected));
      setResult(resp.deleted);
      setConfirmText("");
      setSelected(new Set());
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to wipe selected data.");
    } finally {
      setBusy(false);
    }
  }

  async function fullReset() {
    if (resetConfirmText !== "RESET EVERYTHING" || !resetEmail.trim()) return;
    setResetBusy(true);
    setResetError(null);
    setResetResult(null);
    try {
      const resp = await api.dataCleanupFullReset(resetEmail.trim());
      setResetResult({ usersDeleted: resp.usersDeleted });
      setResetConfirmText("");
      await load();
    } catch (e: any) {
      setResetError(e?.message || "Failed to reset.");
    } finally {
      setResetBusy(false);
    }
  }

  const totalSelectedRows = categories
    ? categories.filter((c) => selected.has(c.key)).reduce((sum, c) => sum + c.count, 0)
    : 0;

  return (
    <div className="ep-page">
      <div className="ep-breadcrumb">
        <span style={{ cursor: "pointer", color: "var(--muted)" }} onClick={onBack}>Settings</span>
        <span className="ep-breadcrumb-sep">›</span>
        <span className="ep-breadcrumb-active">Data Cleanup</span>
      </div>
      <div className="ep-header">
        <div className="ep-header-text">
          <h1 className="ep-title">Data Cleanup</h1>
          <p className="ep-subtitle">Permanently delete request/claim data before go-live. This cannot be undone — take a database backup first.</p>
        </div>
        <div className="ep-actions">
          <button className="ep-btn-outline" onClick={onBack}><ArrowLeft size={14} /> Back</button>
          <button className="ep-btn-outline" onClick={() => void load()}><RefreshCw size={14} /> Refresh counts</button>
        </div>
      </div>

      <div className="ep-panel" style={{ marginBottom: 18, borderLeft: "3px solid #2563eb" }}>
        <div className="ep-panel-head">
          <div className="ep-panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Wrench size={16} /> Approval Chain Maintenance
          </div>
        </div>
        <div className="ep-panel-body">
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Not destructive — this re-checks every pending advance and clearance claim's current and future
            unapproved dynamic steps (Manager/HOD/EXCO, not fixed picks or group steps) against the live workflow
            and who each position resolves to now. It notifies a replacement only when the current step changes. The same sweep
            runs automatically once a day; run it here on demand after fixing a workflow, a reporting line, or a
            department's leadership.
          </p>
          <button className="ep-btn" onClick={() => void runSweep()} disabled={sweepBusy}>
            <RefreshCw size={14} className={sweepBusy ? "rl-spin" : undefined} /> {sweepBusy ? "Running…" : "Run Sweep Now"}
          </button>

          {sweepError && <pre className="inbox-error" style={{ marginTop: 12 }}>{sweepError}</pre>}

          {sweepResult && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 10 }}>
                <CheckCircle2 size={16} color="#16a34a" />
                <strong>Done.</strong> {sweepResult.reassignments.length} reassigned, {sweepResult.warnings.length} need manual review.
              </div>
              {sweepResult.reassignments.length > 0 && (
                <div style={{ marginBottom: 12, overflowX: "auto" }}>
                  <table className="table" style={{ fontSize: 12.5 }}>
                    <thead>
                      <tr><th>Module</th><th>Position</th><th>Old Approver</th><th>New Approver</th></tr>
                    </thead>
                    <tbody>
                      {sweepResult.reassignments.map((r, i) => (
                        <tr key={i}>
                          <td>{r.module}</td>
                          <td>{r.positionType}</td>
                          <td>{r.oldApproverName || "—"}</td>
                          <td>{r.newApproverName || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {sweepResult.warnings.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {sweepResult.warnings.map((w, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: "#b45309" }}>
                      <AlertTriangle size={14} style={{ flex: "0 0 auto", marginTop: 2 }} />
                      <span>{w.module} {w.requestId.slice(0, 8)}: {w.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="ep-panel" style={{ marginBottom: 18, borderLeft: "3px solid #dc2626" }}>
        <div className="ep-panel-body" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <AlertTriangle size={18} color="#dc2626" style={{ flex: "0 0 auto", marginTop: 2 }} />
          <div style={{ fontSize: 13 }}>
            Deletions here are immediate and irreversible — they run in a single transaction directly against
            this environment's database. Take a backup first (<code>pg_dump</code>) if this is production data
            you might need again.
          </div>
        </div>
      </div>

      <div className="ep-panel" style={{ marginBottom: 18 }}>
        <div className="ep-panel-head">
          <div className="ep-panel-title">Choose what to wipe</div>
          <button className="ep-btn-outline" onClick={toggleAll} disabled={!categories}>
            {categories && selected.size === categories.length ? "Deselect all" : "Select all"}
          </button>
        </div>
        <div className="ep-panel-body">
          {!categories ? (
            <div className="ep-loading"><RefreshCw size={18} className="rl-spin" /><p>Loading…</p></div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
              {categories.map((c) => (
                <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggle(c.key)} />
                  <span style={{ flex: 1, fontSize: 13 }}>{c.label}</span>
                  <span className="inbox-count-chip">{c.count}</span>
                </label>
              ))}
            </div>
          )}

          {selected.size > 0 && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
              <p style={{ fontSize: 13, marginBottom: 10 }}>
                This will permanently delete <strong>{totalSelectedRows}</strong> row{totalSelectedRows === 1 ? "" : "s"} across{" "}
                <strong>{selected.size}</strong> {selected.size === 1 ? "category" : "categories"}. Type <strong>WIPE</strong> to confirm.
              </p>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  className="ep-form-input"
                  style={{ maxWidth: 220 }}
                  placeholder="Type WIPE to confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
                <button
                  className="ep-btn"
                  style={{ background: "#dc2626" }}
                  disabled={confirmText !== "WIPE" || busy}
                  onClick={() => void wipe()}
                >
                  <Trash2 size={14} /> {busy ? "Wiping…" : "Wipe Selected Data"}
                </button>
              </div>
            </div>
          )}

          {error && <pre className="inbox-error" style={{ marginTop: 12 }}>{error}</pre>}

          {result && (
            <div style={{ marginTop: 16, padding: 12, background: "var(--surface-soft)", borderRadius: 8, fontSize: 13 }}>
              <strong>Done.</strong> Deleted:{" "}
              {Object.entries(result).map(([k, v], i) => (
                <span key={k}>{i > 0 ? ", " : ""}{v} {k}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ep-panel" style={{ borderLeft: "3px solid #7f1d1d" }}>
        <div className="ep-panel-head">
          <div className="ep-panel-title" style={{ color: "#7f1d1d" }}>Danger Zone — Full Reset</div>
          <button className="ep-btn-outline" onClick={() => setResetOpen((v) => !v)}>{resetOpen ? "Collapse" : "Expand"}</button>
        </div>
        {resetOpen && (
          <div className="ep-panel-body">
            <p style={{ fontSize: 13, marginBottom: 12 }}>
              Wipes <strong>everything</strong> above, plus every user account except one you specify, plus the entire
              org structure (divisions/departments/sections/teams). Whoever you keep will need to re-import the real
              org chart and every employee before this system can be used again. Use this only if this environment
              has never held real data.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, fontWeight: 600 }}>Admin account to keep (email)</div>
                <input className="ep-form-input" value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} placeholder={me?.username || "admin@example.com"} />
              </label>
              <label style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4, fontWeight: 600 }}>Type RESET EVERYTHING to confirm</div>
                <input className="ep-form-input" value={resetConfirmText} onChange={(e) => setResetConfirmText(e.target.value)} placeholder="RESET EVERYTHING" />
              </label>
            </div>
            <button
              className="ep-btn"
              style={{ background: "#7f1d1d" }}
              disabled={resetConfirmText !== "RESET EVERYTHING" || !resetEmail.trim() || resetBusy}
              onClick={() => void fullReset()}
            >
              <Trash2 size={14} /> {resetBusy ? "Resetting…" : "Reset Everything"}
            </button>
            {resetError && <pre className="inbox-error" style={{ marginTop: 12 }}>{resetError}</pre>}
            {resetResult && (
              <div style={{ marginTop: 16, padding: 12, background: "var(--surface-soft)", borderRadius: 8, fontSize: 13 }}>
                <strong>Done.</strong> Deleted {resetResult.usersDeleted} user{resetResult.usersDeleted === 1 ? "" : "s"} and all org structure. Log out and back in as the kept admin.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
