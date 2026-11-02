// Everything the FlowDesk app hands this page, and the messages it sends back.
// The app sets window.__FLOWDESK__ before the page loads (WebView
// injectedJavaScriptBeforeContentLoaded) - see the app's
// src/components/ServerPage.tsx.

export type Section = "sign" | "maintenance";

type Injected = { token?: string; theme?: "light" | "dark"; section?: Section; docId?: string; requestId?: string };

const injected: Injected = (window as any).__FLOWDESK__ || {};
const query = new URLSearchParams(location.search);

/** Running inside the FlowDesk app (vs. a normal browser, for testing). */
export const inApp = Boolean((window as any).ReactNativeWebView);

export type AppMessage =
  | { type: "close" }
  | { type: "signed"; title: string }
  | { type: "sessionExpired" }
  /** The app downloads it with the session and opens the share sheet. */
  | { type: "sharePdf"; path: string; title: string };

export function postToApp(msg: AppMessage) {
  (window as any).ReactNativeWebView?.postMessage(JSON.stringify(msg));
}

// In a plain browser there's no app to hand over a token - the sign-in form
// keeps one for this tab only.
const TOKEN_KEY = "flowdesk.sign.token";

export function getToken(): string | null {
  if (injected.token) return injected.token;
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

/** Which part of the page the app opened (?section= for browser testing). */
export function initialSection(): Section {
  const s = injected.section || query.get("section");
  return s === "maintenance" ? "maintenance" : "sign";
}

/** A document to open straight away (from the app's inbox or a push). */
export function initialDocId(): string | null {
  return injected.docId || query.get("doc");
}

/** A maintenance request to open straight away. */
export function initialRequestId(): string | null {
  return injected.requestId || query.get("req");
}

export function applyTheme() {
  const theme = injected.theme || query.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
}
