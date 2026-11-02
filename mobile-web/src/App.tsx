import { useEffect, useState } from "react";
import { api, setSessionExpiredHandler } from "./api";
import { applyTheme, getToken, inApp, initialDocId, initialRequestId, initialSection, setBrowserToken, waitForAppHandover, type Section } from "./bridge";
import { href, sectionOf, useRoute, type Route } from "./router";
import ListScreen from "./screens/ListScreen";
import DocScreen from "./screens/DocScreen";
import SignedScreen from "./screens/SignedScreen";
import QuickSignScreen from "./screens/QuickSignScreen";
import SendScreen from "./screens/SendScreen";
import SignatureScreen from "./screens/SignatureScreen";
import MaintenanceList from "./maintenance/ListScreen";
import MaintenanceNew from "./maintenance/NewScreen";
import MaintenanceRequest from "./maintenance/RequestScreen";

type Tab = { route: Route; label: string; match: Route["name"][] };

// Each part of the app (Sign a Document, Maintenance) is its own little app
// here, with its own tabs; the FlowDesk app opens one of them.
const TABS: Record<Section, Tab[]> = {
  sign: [
    { route: { name: "list" }, label: "Documents", match: ["list", "doc", "signed"] },
    { route: { name: "sign" }, label: "Sign a PDF", match: ["sign"] },
    { route: { name: "send" }, label: "Request signature", match: ["send"] },
    { route: { name: "signature" }, label: "My signature", match: ["signature"] }
  ],
  maintenance: [
    { route: { name: "mlist" }, label: "Requests", match: ["mlist", "mreq"] },
    { route: { name: "mnew" }, label: "New request", match: ["mnew"] }
  ]
};

const BACK: Partial<Record<Route["name"], { to: Route; label: string }>> = {
  doc: { to: { name: "list" }, label: "Documents" },
  signed: { to: { name: "list" }, label: "Documents" },
  mreq: { to: { name: "mlist" }, label: "Requests" }
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [noHandover, setNoHandover] = useState(false);
  const [expired, setExpired] = useState(false);
  const route = useRoute();

  useEffect(() => {
    setSessionExpiredHandler(() => (inApp ? setExpired(true) : setSignedIn(false)));
    void (async () => {
      // Inside the app, nothing is decided until its handover is here - the
      // section, the theme and above all the session come from it.
      const arrived = await waitForAppHandover();
      applyTheme();
      if (inApp && !arrived) setNoHandover(true);
      setSignedIn(Boolean(getToken()));
      if (location.hash.length <= 2) {
        // Opened for a specific item (app inbox / push): land on it, with
        // the list one step back. (A reload mid-way keeps its place.)
        if (initialSection() === "maintenance") {
          location.replace(href({ name: "mlist" }));
          const reqId = initialRequestId();
          if (reqId) location.hash = href({ name: "mreq", id: reqId });
        } else {
          const docId = initialDocId();
          if (docId) location.hash = href({ name: "doc", id: docId });
        }
      }
      setReady(true);
    })();
  }, []);

  if (!ready) return <p className="muted center pad-top">Loading…</p>;
  if (expired) return <p className="error center pad-top">Your session has expired. Close this screen and sign in to FlowDesk again.</p>;
  // Never show a second sign-in inside the app - the app owns the session.
  if (noHandover) return <p className="error center pad-top">Couldn't connect to your FlowDesk session. Go back and open this screen again.</p>;
  if (!signedIn) return <BrowserLogin onDone={() => setSignedIn(true)} />;

  const section = sectionOf(route);
  const back = BACK[route.name];

  return (
    <div className="app">
      <main className="content">
        {back && (
          <button type="button" className="back" onClick={() => history.length > 1 ? history.back() : (location.hash = href(back.to))}>
            ‹ {back.label}
          </button>
        )}
        {route.name === "list" && <ListScreen />}
        {route.name === "doc" && <DocScreen key={route.id} id={route.id} />}
        {route.name === "signed" && <SignedScreen key={route.id} id={route.id} />}
        {route.name === "sign" && <QuickSignScreen />}
        {route.name === "send" && <SendScreen />}
        {route.name === "signature" && <SignatureScreen />}
        {route.name === "mlist" && <MaintenanceList />}
        {route.name === "mnew" && <MaintenanceNew />}
        {route.name === "mreq" && <MaintenanceRequest key={route.id} id={route.id} />}
      </main>
      <nav className="tabs" aria-label={section === "maintenance" ? "Maintenance" : "Signing"}>
        {TABS[section].map((t) => (
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
