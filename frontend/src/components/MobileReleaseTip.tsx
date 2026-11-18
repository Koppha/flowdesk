import { useEffect, useState } from "react";
import { Smartphone, X } from "lucide-react";
import { api } from "../api";

// A small tip in the corner when an admin uploads a new mobile app build (Get
// the App). Each browser remembers the version it last saw, so it shows once
// per release: "Get the app" or the close button both count as seen, and so
// does opening Get the App directly.

const SEEN_KEY = "fd.mobileRelease.seenVersion";
const seenVersion = () => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } };
const markSeen = (v: string) => { try { localStorage.setItem(SEEN_KEY, v); } catch { /* private mode: shows again next time */ } };

export default function MobileReleaseTip({ onOpen, onGetTheAppPage }: { onOpen: () => void; onGetTheAppPage: boolean }) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.latestMobileAppBuild()
      .then((r: any) => {
        const v = r?.build?.version ? String(r.build.version) : null;
        if (!cancelled && v && v !== seenVersion()) setVersion(v);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Already looking at the download page: nothing to point at.
  useEffect(() => {
    if (onGetTheAppPage && version) { markSeen(version); setVersion(null); }
  }, [onGetTheAppPage, version]);

  if (!version) return null;

  const dismiss = () => { markSeen(version); setVersion(null); };

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed", top: 72, right: 20, zIndex: 1000, width: 300, maxWidth: "calc(100vw - 32px)",
        background: "var(--card, #fff)", color: "inherit", borderRadius: 12, padding: "14px 16px",
        boxShadow: "0 10px 30px rgba(0,0,0,.18)", border: "1px solid var(--border, #e5e7eb)",
        display: "flex", gap: 12, alignItems: "flex-start"
      }}
    >
      <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#c8102e,#8f0c1f)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        <Smartphone size={18} color="#fff" aria-hidden />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>New mobile app release</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", margin: "2px 0 10px" }}>
          FlowDesk Mobile {version} is out. Install it to approve and track requests on your phone.
        </div>
        <button
          type="button"
          className="ep-btn"
          style={{ fontSize: 12, padding: "6px 14px" }}
          onClick={() => { dismiss(); onOpen(); }}
        >
          Get the app
        </button>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        style={{ background: "none", border: 0, padding: 2, cursor: "pointer", color: "var(--muted)", flex: "none" }}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
