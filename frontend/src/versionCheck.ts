// Detects when a newer build has been deployed while this tab has been open
// (this app has no service worker, so an already-open tab just keeps running
// whatever JS it loaded at page-load - it never picks up a new deploy on its
// own) and shows a small "reload to update" banner instead of leaving people
// on stale code with no way to notice, which repeatedly looked like backend
// bugs (stale item counts, old button behavior) that were actually already
// fixed and deployed.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function currentBundleSrc(): string | null {
  const script = document.querySelector('script[type="module"][src*="/assets/"]');
  return script ? script.getAttribute("src") : null;
}

function showReloadBanner() {
  if (document.getElementById("version-update-banner")) return;
  const bar = document.createElement("div");
  bar.id = "version-update-banner";
  bar.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#1d4ed8;color:#fff;" +
    "padding:10px 16px;display:flex;align-items:center;justify-content:center;gap:14px;" +
    "font:600 13px system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,0.15);";
  bar.innerHTML =
    `<span>A newer version of FlowDesk is available.</span>` +
    `<button id="version-update-reload" style="background:#fff;color:#1d4ed8;border:none;` +
    `padding:6px 14px;border-radius:6px;font:600 13px system-ui,sans-serif;cursor:pointer;">Reload</button>`;
  document.body.appendChild(bar);
  document.getElementById("version-update-reload")!.addEventListener("click", () => window.location.reload());
}

export function startVersionCheck() {
  const initialSrc = currentBundleSrc();
  if (!initialSrc) return;

  async function check() {
    try {
      const res = await fetch("/", { cache: "no-store" });
      if (!res.ok) return;
      const html = await res.text();
      const match = html.match(/<script[^>]*type="module"[^>]*src="([^"]*\/assets\/[^"]*)"/);
      if (match && match[1] !== initialSrc) showReloadBanner();
    } catch {
      // Offline or a transient network blip - not worth surfacing, just try again next interval.
    }
  }

  setInterval(check, CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
}
