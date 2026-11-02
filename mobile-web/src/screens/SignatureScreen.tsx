import { useState } from "react";
import { api, currentUser } from "../api";
import SignatureChooser, { isComplete, toSaved, useSignatureChoice } from "../components/SignatureChooser";

// My saved signature - the same one the web portal prefills from (typed,
// drawn or uploaded there or here).
export default function SignatureScreen() {
  const { choice, setChoice, saved, setSaved } = useSignatureChoice(currentUser()?.fullName || "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = toSaved(choice);
      await api.saveSignature(next);
      setSaved(next);
      setMessage("Saved. It'll be filled in for you next time you sign, here and on the web.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Remove your saved signature?")) return;
    try {
      await api.clearSignature();
      setSaved(null);
      setMessage("Removed.");
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="stack">
      <h1>My signature</h1>
      <p className="muted">Save it once and it's filled in whenever you sign.</p>
      <section className="card">
        <SignatureChooser choice={choice} onChange={setChoice} saved={saved} />
      </section>
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="button" className="primary" onClick={save} disabled={busy || !isComplete(choice)}>
          {busy ? "Saving…" : "Save signature"}
        </button>
        {saved && <button type="button" className="secondary danger" onClick={remove}>Remove</button>}
      </div>
    </div>
  );
}
