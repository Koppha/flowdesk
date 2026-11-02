// Everything the FlowDesk app hands this page, and the messages it sends back.
// The app sets window.__FLOWDESK__ before the page loads (WebView
// injectedJavaScriptBeforeContentLoaded) - see the app's
// src/components/ServerPage.tsx.

export type Section = "sign" | "maintenance" | "account";

type Injected = {
  token?: string;
  theme?: "light" | "dark";
  section?: Section;
  docId?: string;
  requestId?: string;
  /** A named screen to open first (app /web?go=phone). */
  start?: string;
  /** What this app build can do for the page, e.g. "headerAction" (1.0.8+). */
  capabilities?: string[];
};

// Read fresh every time, never cached at load: on Android the app's
// injected script can land a moment AFTER this page's own script starts
// (often when the page comes from cache), and a value read once at startup
// stayed empty - the page then showed its own sign-in form inside the app.
const injectedNow = (): Injected => (window as any).__FLOWDESK__ || {};
const query = new URLSearchParams(location.search);

/** Running inside the FlowDesk app (vs. a normal browser, for testing). */
export const inApp = Boolean((window as any).ReactNativeWebView);

export type AppMessage =
  | { type: "close" }
  | { type: "signed"; title: string }
  | { type: "sessionExpired" }
  /** The app downloads it with the session and opens the share sheet. */
  | { type: "sharePdf"; path: string; title: string }
  /** A button in the app's own header (label null = none); tapping it opens `hash` here. */
  | { type: "headerAction"; label: string | null; hash?: string }
  /** The app's native camera / gallery; the photos come back via window.__flowdeskPhotos. */
  | { type: "pickPhotos"; id: string; source: "camera" | "library"; max: number };

// ── Native photos (app 1.0.8+, capability "nativePhotos") ───────────────────
// Android's in-WebView file chooser doesn't reliably hand pictures back, so
// the page asks the app to take/choose them and gets data URLs back.
type NativePhoto = { dataUrl: string; name: string };
const photoWaiters = new Map<string, (photos: NativePhoto[]) => void>();
(window as any).__flowdeskPhotos = (reply: { id: string; photos?: NativePhoto[] }) => {
  photoWaiters.get(reply?.id)?.(reply.photos || []);
  photoWaiters.delete(reply?.id);
};

function dataUrlToFile({ dataUrl, name }: NativePhoto): File {
  const [head, b64] = dataUrl.split(",");
  const type = /data:([^;]+)/.exec(head)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type });
}

/** Take or choose photos with the app's native picker. Resolves [] if cancelled. */
export function pickNativePhotos(source: "camera" | "library", max: number): Promise<File[]> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    photoWaiters.set(id, (photos) => resolve(photos.map(dataUrlToFile)));
    postToApp({ type: "pickPhotos", id, source, max });
  });
}

/** Whether this app build supports a given page feature (older builds support none). */
export function appCan(capability: string) {
  return inApp && (injectedNow().capabilities || []).includes(capability);
}

export function postToApp(msg: AppMessage) {
  (window as any).ReactNativeWebView?.postMessage(JSON.stringify(msg));
}

// In a plain browser there's no app to hand over a token - the sign-in form
// keeps one for this tab only.
const TOKEN_KEY = "flowdesk.sign.token";

export function getToken(): string | null {
  const fromApp = injectedNow().token;
  if (fromApp) return fromApp;
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setBrowserToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked - the user just signs in again next time.
  }
}

/**
 * Inside the app, wait for its handover (token, section, theme) - it can
 * arrive just after this page starts. Resolves at once in a browser or when
 * it's already here; gives up after timeoutMs.
 */
export function waitForAppHandover(timeoutMs = 4000): Promise<boolean> {
  if (!inApp || injectedNow().token) return Promise.resolve(Boolean(injectedNow().token) || !inApp);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const arrived = Boolean(injectedNow().token);
      if (arrived || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(arrived);
      }
    }, 50);
  });
}

/** Which part of the page the app opened (?section= for browser testing). */
export function initialSection(): Section {
  const s = injectedNow().section || query.get("section");
  return s === "maintenance" || s === "account" ? s : "sign";
}

/** A document to open straight away (from the app's inbox or a push). */
export function initialDocId(): string | null {
  return injectedNow().docId || query.get("doc");
}

/** A maintenance request to open straight away. */
export function initialRequestId(): string | null {
  return injectedNow().requestId || query.get("req");
}

export function applyTheme() {
  const theme = injectedNow().theme || query.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
}

/** The named screen the app asked for (/web?go=...), or ?start= in a browser. */
export function initialStart(): string | null {
  return injectedNow().start || query.get("start");
}
