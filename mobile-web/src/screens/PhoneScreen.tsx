import { useEffect, useState } from "react";
import { api } from "../api";
import { inApp, postToApp } from "../bridge";

// "Add your phone number" - opened from Profile > Phone number and from the
// push that asks people to complete their profile. Saves to the FlowDesk
// profile (users.phone), the same field the web portal and Maintenance use.

/** Lesotho/South African style numbers: digits with an optional +, spaces or dashes, 8-15 digits. */
export function validPhone(raw: string) {
  const digits = raw.replace(/[\s()-]/g, "");
  return /^\+?\d{8,15}$/.test(digits);
}

export default function PhoneScreen() {
  const [phone, setPhone] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .me()
      .then((me) => {
        setSaved(me.phone || null);
        setPhone(me.phone || "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    const value = phone.trim();
    if (!validPhone(value)) return setError("Enter a phone number with 8 to 15 digits, e.g. +266 5812 3456.");
    setBusy(true);
    setError("");
    try {
      const r = await api.saveMyPhone(value);
      setSaved(r.phone);
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted center">Loading…</p>;

  if (done) {
    return (
      <div className="stack">
        <h1>Thank you</h1>
        <p className="notice">Your phone number {saved} is saved to your FlowDesk profile.</p>
        {inApp && (
          <div className="sticky-actions">
            <button type="button" className="primary" onClick={() => postToApp({ type: "close" })}>Done</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>{saved ? "Your phone number" : "Add your phone number"}</h1>
      <p className="muted">
        So the team can reach you about your requests - for example the Admin Office about a maintenance job. It's only shown inside FlowDesk.
      </p>
      <label className="field">
        <span>Mobile number</span>
        <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+266 5812 3456" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="button" className="primary" onClick={save} disabled={busy || phone.trim() === (saved || "")}>
          {busy ? "Saving…" : saved ? "Update number" : "Save number"}
        </button>
      </div>
    </div>
  );
}
