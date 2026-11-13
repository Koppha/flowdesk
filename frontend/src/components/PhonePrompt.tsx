import { useEffect, useState } from "react";
import { MessageSquare, Smartphone } from "lucide-react";
import { api, getToken } from "../api";

// Asks everyone with no phone number on their profile to add one, so FlowDesk
// notifications can reach them by SMS (e.g. while Outlook is down). It shows
// at every login; "Later" only hides it until the next login. It stops once a
// number is saved.

const SNOOZE_KEY = "fd.phonePrompt.snoozedFor";
const loginStamp = () => (getToken() || "").slice(-24);
const snoozed = () => { try { const t = loginStamp(); return !!t && localStorage.getItem(SNOOZE_KEY) === t; } catch { return false; } };

// 8 digits starting 5 or 6, optionally with 266 / +266 in front.
export function lesothoMobile(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("266")) d = d.slice(3);
  return /^[56]\d{7}$/.test(d) ? d : null;
}

export default function PhonePrompt({ profile, onSaved }: { profile: { id?: string; phone?: string | null } | null; onSaved: (phone: string) => void }) {
  const [hidden, setHidden] = useState(snoozed());
  // A new login (a new session token) asks again.
  useEffect(() => { setHidden(snoozed()); }, [profile?.id, loginStamp()]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  if (!profile?.id || hidden || (profile.phone && profile.phone.trim() && !done)) return null;

  async function save() {
    const n = lesothoMobile(value);
    if (!n) { setError("Enter your 8-digit mobile number, e.g. 6222 7247."); return; }
    setSaving(true); setError(null);
    try {
      await api.updateMyProfileContact({ phone: n });
      setDone(true);
      onSaved(n);
      window.setTimeout(() => setHidden(true), 2200);
    } catch (e: any) {
      setError(e?.message || "Couldn't save your number. Try again.");
    } finally { setSaving(false); }
  }

  function later() {
    try { localStorage.setItem(SNOOZE_KEY, loginStamp()); } catch { /* storage off */ }
    setHidden(true);
  }

  return (
    <div className="ep-modal-overlay" style={{ zIndex: 2800 }}>
      <div className="ep-modal" role="dialog" aria-modal="true" aria-labelledby="phone-prompt-title" style={{ maxWidth: 460, width: "92vw" }}>
        <div className="ep-modal-head">
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ width: 44, height: 44, borderRadius: 12, background: "#eaf2ff", color: "#1d4ed8", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
              {done ? <MessageSquare size={22} /> : <Smartphone size={22} />}
            </span>
            <div>
              <h3 id="phone-prompt-title" className="ep-modal-title">{done ? "You're all set" : "Add your phone number"}</h3>
              <p className="ep-modal-sub" style={{ marginTop: 4 }}>
                {done
                  ? "FlowDesk notifications will now also reach you by SMS."
                  : "Outlook email is having an outage. Add your mobile number so FlowDesk can send you your approvals and updates by SMS."}
              </p>
            </div>
          </div>
        </div>
        {!done && (
          <>
            <div className="ep-modal-body">
              <label style={{ display: "grid", gap: 6, fontWeight: 600, fontSize: 14 }}>
                Mobile number
                <div style={{ display: "flex", alignItems: "stretch", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--surface)" }}>
                  <span style={{ padding: "10px 12px", background: "var(--surface-soft, #f3f4f6)", color: "var(--muted)", fontWeight: 600, borderRight: "1px solid var(--border)" }}>+266</span>
                  <input type="tel" inputMode="numeric" autoFocus value={value} onChange={(e) => { setValue(e.target.value); setError(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void save(); }} placeholder="6222 7247"
                    style={{ flex: 1, border: "none", outline: "none", padding: "10px 12px", font: "inherit", fontSize: 16, background: "transparent", color: "var(--text)" }} />
                </div>
              </label>
              {error && <div role="alert" style={{ color: "#b91c1c", fontSize: 13, marginTop: 8 }}>{error}</div>}
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>Only used for FlowDesk notifications and your team's contact list. You can change it under Settings.</div>
            </div>
            <div className="ep-modal-footer">
              <button type="button" className="ep-btn-outline" onClick={later}>Later</button>
              <button type="button" className="ep-btn" disabled={saving || !value.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save my number"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
