import { useEffect, useState } from "react";
import { mApi, type Meta } from "./api";

// /maintenance/meta (lists, my roles) loads once per page visit.
let metaPromise: Promise<Meta> | null = null;

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!metaPromise) {
      metaPromise = mApi.meta();
      metaPromise.catch(() => (metaPromise = null));
    }
    metaPromise.then(setMeta).catch((e) => setError(e.message));
  }, []);
  return { meta, error };
}

const STATUS_TONE: Record<string, string> = {
  CLOSED: "good",
  CANCELLED: "muted",
  PENDING_INFORMATION: "warn",
  AWAITING_APPROVAL: "warn",
  REOPENED: "bad",
  COMPLETED_PENDING_VERIFICATION: "accent-soft",
  PENDING_CONFIRMATION: "accent-soft"
};

export function MStatus({ status, label }: { status: string; label: string }) {
  return <span className={`pill ${STATUS_TONE[status] || "info"}`}>{label}</span>;
}

const PRIORITY_TONE: Record<string, string> = { EMERGENCY: "bad", HIGH: "warn", MEDIUM: "muted", LOW: "muted" };

export function MPriority({ priority, label }: { priority: string; label: string }) {
  return <span className={`pill ${PRIORITY_TONE[priority] || "muted"}`}>{label}</span>;
}

export function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="kv">
      <span className="muted small">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
}
