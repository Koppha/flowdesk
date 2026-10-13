import { useEffect, useState } from "react";
import { api } from "./api";
import { Bell } from "lucide-react";

// A reminder-only nudge, not a reassignment: once a pending step (on an
// Advance, Clearance, Change Request/BRS, or a Sign a Document routing
// document) sits longer than this threshold, the current approver gets an
// email - then another every time the same threshold passes again with
// still no action, for as long as it stays unactioned. Nothing is ever
// moved to someone else automatically - see
// backend-v2/src/modules/sla/sla.service.ts for why that's deliberate.
export default function SlaReminderSettings({ isAdmin }: { isAdmin?: boolean }) {
  const [enabled, setEnabled] = useState(true);
  const [thresholdHours, setThresholdHours] = useState("48");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.slaSettings()
      .then((s: { enabled: boolean; thresholdHours: number }) => {
        setEnabled(s.enabled !== false);
        setThresholdHours(String(s.thresholdHours ?? 48));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    const hours = Number(thresholdHours);
    if (!Number.isInteger(hours) || hours < 1) { alert("Threshold must be a whole number of hours, at least 1."); return; }
    setSaving(true);
    try {
      const s = await api.updateSlaSettings({ enabled, thresholdHours: hours });
      setEnabled(s.enabled !== false);
      setThresholdHours(String(s.thresholdHours ?? hours));
    } catch (e: any) {
      alert("Error saving SLA reminder settings: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <div className="ep-panel" style={{ marginBottom: 20 }}>
      <div className="ep-panel-head">
        <div className="ep-panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Bell size={16} /> SLA Reminders
        </div>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>Nudges only — never reassigns</span>
      </div>
      <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: isAdmin ? "pointer" : "default" }}>
          <input type="checkbox" checked={enabled} disabled={!isAdmin} onChange={(e) => setEnabled(e.target.checked)} />
          Email the current approver when a step goes overdue
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          After
          <input
            type="number" min={1} value={thresholdHours} disabled={!isAdmin}
            onChange={(e) => setThresholdHours(e.target.value)}
            style={{ width: 64, padding: "4px 6px", fontSize: 13, border: "1px solid var(--border)", borderRadius: 6 }}
          />
          hours with no action (repeating every {thresholdHours} hours until they act), on Advances, Clearances, Custom Processes (including BRS and Change Requests), and Sign a Document routing documents.
        </label>
        {isAdmin && (
          <button onClick={save} disabled={saving} style={{ padding: "7px 14px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: saving ? 0.7 : 1 }}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}
