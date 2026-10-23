import { useEffect, useState } from "react";
import { api, setSessionExpiredHandler } from "./api";
import { getToken, inApp, initialDocId, setBrowserToken } from "./bridge";
import { href, useRoute, type Route } from "./router";
import ListScreen from "./screens/ListScreen";
import DocScreen from "./screens/DocScreen";
import SignedScreen from "./screens/SignedScreen";
import QuickSignScreen from "./screens/QuickSignScreen";
import SendScreen from "./screens/SendScreen";
import SignatureScreen from "./screens/SignatureScreen";

const TABS: { route: Route; label: string; match: Route["name"][] }[] = [
  { route: { name: "list" }, label: "Documents", match: ["list", "doc", "signed"] },
  { route: { name: "sign" }, label: "Sign a PDF", match: ["sign"] },
  { route: { name: "send" }, label: "Send", match: ["send"] },
  { route: { name: "signature" }, label: "My signature", match: ["signature"] }
];

export default function App() {
  const [signedIn, setSignedIn] = useState(() => Boolean(getToken()));
  const [expired, setExpired] = useState(false);
  const route = useRoute();

  useEffect(() => {
    setSessionExpiredHandler(() => (inApp ? setExpired(true) : setSignedIn(false)));
    // Opened for a specific document (app inbox / push): land on it, with the
    // list one step back.
    const docId = initialDocId();
    if (docId && route.name === "list") location.hash = href({ name: "doc", id: docId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (expired) return <p className="error center pad-top">Your session has expired. Close this screen and sign in to FlowDesk again.</p>;
  if (!signedIn) return <BrowserLogin onDone={() => setSignedIn(true)} />;

  const sub = route.name === "doc" || route.name === "signed";

  return (
    <div className="app">
      <main className="content">
        {sub && (
          <button type="button" className="back" onClick={() => history.length > 1 ? history.back() : (location.hash = href({ name: "list" }))}>
            ‹ Documents
          </button>
        )}
        {route.name === "list" && <ListScreen />}
        {route.name === "doc" && <DocScreen key={route.id} id={route.id} />}
        {route.name === "signed" && <SignedScreen key={route.id} id={route.id} />}
        {route.name === "sign" && <QuickSignScreen />}
        {route.name === "send" && <SendScreen />}
        {route.name === "signature" && <SignatureScreen />}
      </main>
      <nav className="tabs" aria-label="Signing">
        {TABS.map((t) => (
          <a key={t.label} href={href(t.route)} className={t.match.includes(route.name) ? "on" : ""} aria-current={t.match.includes(route.name) ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
    </div>
  );
}

// Only outside the app (testing in a phone browser) - inside the app the
// session is handed over and this never shows.
function BrowserLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await api.login(email.trim(), password);
      setBrowserToken(token);
      onDone();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="login stack" onSubmit={submit}>
      <h1>FlowDesk signing</h1>
      <p className="muted">Sign in with your FlowDesk account.</p>
      <label className="field">
        <span>Email</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
