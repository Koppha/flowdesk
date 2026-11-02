import { useEffect, useMemo, useState } from "react";
import { api, currentUser, type Person } from "../api";
import { isPdf } from "../pdf";
import { go } from "../router";
import { PdfPicker } from "../ui";

// Route a PDF to people who sign it in order (the web portal's
// SignRoutingDocument "approval route"). Optionally I sign first.
export default function SendScreen() {
  const me = currentUser();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [route, setRoute] = useState<Person[]>([]);
  const [search, setSearch] = useState("");
  const [signFirst, setSignFirst] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.people().then((p) => setPeople(Array.isArray(p) ? p : [])).catch((e) => setError(e.message));
  }, []);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    const chosen = new Set(route.map((p) => p.id));
    return people
      .filter((p) => !chosen.has(p.id) && p.id !== me?.userId)
      .filter((p) => `${p.full_name || ""} ${p.email} ${p.department || ""}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [search, people, route, me?.userId]);

  function pick(f: File) {
    setError("");
    if (!isPdf(f)) return setError("Choose a PDF file.");
    if (f.size > 25 * 1024 * 1024) return setError("That file is over 25 MB.");
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.pdf$/i, ""));
  }

  function move(i: number, by: number) {
    const next = [...route];
    const [p] = next.splice(i, 1);
    next.splice(i + by, 0, p);
    setRoute(next);
  }

  async function send() {
    if (!file) return setError("Choose a PDF.");
    if (!title.trim()) return setError("Give the document a title.");
    if (!route.length) return setError("Add at least one person to sign it.");
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", title.trim());
      form.append("approvalChain", JSON.stringify(route.map((p) => ({ approverId: p.id }))));
      if (signFirst) form.append("signFirst", "true");
      const doc = await api.createDocument(form);
      // Signing first: straight to the document, where it's now my turn.
      go({ name: "doc", id: doc.id }, true);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>Request signature</h1>
      <PdfPicker file={file} onPick={pick} />

      <label className="field">
        <span>Document title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Board resolution - Q4" />
      </label>

      <section className="card stack">
        <h3>Who signs, in order</h3>
        {route.length === 0 ? (
          <p className="muted small">Search for people below to add them.</p>
        ) : (
          <ol className="route">
            {route.map((p, i) => (
              <li key={p.id}>
                <span className="step-no">{i + 1 + (signFirst ? 1 : 0)}</span>
                <span className="grow">
                  <strong>{p.full_name || p.email}</strong>
                  {p.department && <span className="muted small">{p.department}</span>}
                </span>
                <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === route.length - 1} aria-label="Move down">↓</button>
                <button type="button" className="icon-btn" onClick={() => setRoute(route.filter((x) => x.id !== p.id))} aria-label="Remove">✕</button>
              </li>
            ))}
          </ol>
        )}
        <label className="field">
          <span>Add a person</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email or department" />
        </label>
        {matches.length > 0 && (
          <ul className="list compact">
            {matches.map((p) => (
              <li key={p.id}>
                <button type="button" className="row-link" onClick={() => { setRoute([...route, p]); setSearch(""); }}>
                  <span className="grow">
                    <strong>{p.full_name || p.email}</strong>
                    <span className="muted small">{p.department || p.email}</span>
                  </span>
                  <span className="add">Add</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <label className="consent">
        <input type="checkbox" checked={signFirst} onChange={(e) => setSignFirst(e.target.checked)} />
        <span>I'll sign it first, then it goes to the people above.</span>
      </label>

      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="button" className="primary" onClick={send} disabled={busy}>
          {busy ? "Sending…" : signFirst ? "Continue to sign" : "Send"}
        </button>
      </div>
    </div>
  );
}
