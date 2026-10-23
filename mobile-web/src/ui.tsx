import { useState } from "react";
import { savePdf } from "./api";
import { inApp } from "./bridge";

export function formatDate(iso: string | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const LABELS: Record<string, [string, string]> = {
  OPEN: ["In progress", "warn"],
  COMPLETED: ["Completed", "good"],
  REJECTED: ["Rejected", "bad"],
  DELETED: ["Deleted", "muted"],
  SIGNED: ["Signed", "good"],
  PENDING: ["Pending", "muted"]
};

export function StatusPill({ status, myTurn }: { status: string | null | undefined; myTurn?: boolean }) {
  if (myTurn) return <span className="pill accent">Your turn</span>;
  const [label, tone] = LABELS[String(status || "PENDING").toUpperCase()] || [String(status), "muted"];
  return <span className={`pill ${tone}`}>{label}</span>;
}

export function SaveButton({ path, title }: { path: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await savePdf(path, title);
          } catch (e: any) {
            setError(e?.message || "Couldn't download the document.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {inApp ? "Download / share PDF" : busy ? "Downloading…" : "Download PDF"}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/** File picker for a single PDF, styled as a big tap target. */
export function PdfPicker({ file, onPick }: { file: File | null; onPick: (f: File) => void }) {
  return (
    <label className="file-pick">
      <input type="file" accept="application/pdf,.pdf" onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])} />
      <strong>{file ? file.name : "Choose a PDF"}</strong>
      <span className="muted small">{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · tap to change` : "From your phone or cloud storage, up to 25 MB"}</span>
    </label>
  );
}
