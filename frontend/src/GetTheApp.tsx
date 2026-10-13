import { useEffect, useRef, useState } from "react";
import { API, api } from "./api";
import { Download, Smartphone, UploadCloud } from "lucide-react";

type Build = { version: string; originalFilename: string; sizeBytes: number; uploadedAt: string } | null;

function fmtSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// No public Play Store listing - being logged into FlowDesk at all is the
// access control (see backend-v2/src/lib/mobileAppBuilds.ts). Anyone signed
// in can download the current build; only ADMIN can upload a new one.
export default function GetTheApp({ isAdmin }: { isAdmin?: boolean }) {
  const [build, setBuild] = useState<Build>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function loadLatest() {
    setLoading(true);
    api.latestMobileAppBuild()
      .then((r: any) => setBuild(r?.build || null))
      .catch(() => setBuild(null))
      .finally(() => setLoading(false));
  }

  useEffect(loadLatest, []);

  async function handleDownload() {
    // A short-lived token in the URL, not a fetched Blob: this file can be
    // 200MB+, and buffering the whole thing into page memory before
    // anything happens is exactly what left the button stuck on
    // "Preparing…" with no progress. A plain <a> download lets the browser
    // stream it natively instead, with its own progress UI.
    setDownloading(true);
    try {
      const { token } = await api.mobileAppDownloadToken();
      const a = document.createElement("a");
      a.href = `${API}/mobile-app/download?platform=ANDROID&token=${encodeURIComponent(token)}`;
      a.download = build?.originalFilename || "flowdesk.apk";
      a.click();
    } catch (e: any) {
      alert("Couldn't start the download: " + e.message);
    } finally {
      setDownloading(false);
    }
  }

  async function handleUpload() {
    if (!file) { setUploadError("Choose an .apk file first"); return; }
    if (!version.trim()) { setUploadError("Enter a version"); return; }
    setUploadError(null);
    setUploading(true);
    try {
      await api.uploadMobileAppApk(file, version.trim());
      setFile(null);
      setVersion("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      loadLatest();
    } catch (e: any) {
      setUploadError(e.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Inside FlowDesk: Get the App</h1>
      <p style={{ margin: "0 0 20px", fontSize: 13.5, color: "var(--muted)" }}>
        No public store listing, no separate account to create. Staff only ever reach this page because they&apos;re already
        logged into FlowDesk — that login is the allow-list.
      </p>

      <div className="ep-panel" style={{ marginBottom: 20 }}>
        <div className="ep-panel-head">
          <div className="ep-panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Smartphone size={16} /> Android
          </div>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Direct install, no store needed</span>
        </div>
        <div style={{ padding: "16px 18px" }}>
          {loading ? (
            <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</p>
          ) : !build ? (
            <p style={{ fontSize: 13, color: "var(--muted)" }}>No build has been uploaded yet.</p>
          ) : (
            <>
              <p style={{ margin: "0 0 14px", fontSize: 13.5 }}>
                FlowDesk serves the signed app file straight from this page. Because you had to log in to see this
                button, the link itself is the allow-list — nobody outside FlowDesk can reach it.
              </p>
              <button
                onClick={handleDownload}
                disabled={downloading}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", border: "none", borderRadius: 8, background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 13.5, fontWeight: 700, opacity: downloading ? 0.7 : 1 }}
              >
                <Download size={16} /> {downloading ? "Preparing…" : "Download for Android"}
              </button>
              <p style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
                Version {build.version} · {fmtSize(build.sizeBytes)} · Updated {fmtDate(build.uploadedAt)}
              </p>
              <p style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
                First time only: Android will ask permission to let FlowDesk install apps. Expected for an internal
                app — approve it once.
              </p>
            </>
          )}
        </div>
      </div>

      {isAdmin && (
        <div className="ep-panel">
          <div className="ep-panel-head">
            <div className="ep-panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <UploadCloud size={16} /> Upload a new build
            </div>
          </div>
          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10, maxWidth: 360 }}>
            <input
              type="text"
              placeholder="Version (e.g. 1.4.1)"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              style={{ padding: "8px 10px", fontSize: 13, border: "1px solid var(--border)", borderRadius: 6 }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".apk"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              style={{ fontSize: 13 }}
            />
            {uploadError && <span style={{ fontSize: 12, color: "#dc2626" }}>{uploadError}</span>}
            <button
              onClick={handleUpload}
              disabled={uploading}
              style={{ alignSelf: "flex-start", padding: "8px 16px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 12.5, fontWeight: 600, opacity: uploading ? 0.7 : 1 }}
            >
              {uploading ? "Uploading…" : "Upload"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
