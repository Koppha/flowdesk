import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, Building2, CalendarCheck, CalendarDays, Camera, CheckCircle2, ClipboardList, Clock, FileText, Hash, History,
  ImageIcon, Info, Lock, MapPin, MessageSquare, Paperclip, Phone, Plus, Send, Settings, ShieldCheck, Target, UserRound, Wrench, X, XCircle,
  Search, ChevronLeft, ChevronRight, Pencil
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, getUserFromToken } from "./api";
import { displayOrgGroupName } from "./constants";
import { DateLine, LIST_FRAME, ListRow, Pager as RowPager, SearchBox, StatusPill, maintenanceIcon, usePaging } from "./shared/RowList";
import { GuidedTour } from "./shared/GuidedTour";
import { TOURS } from "./menu/menuTips";

// Maintenance Requests: staff log a problem with photos, the Admin Office
// (step 1 of the "Maintenance Request" workflow in Workflow Builder) reviews
// and assigns, a worker accepts, updates and completes, the Admin Office
// verifies and the requester confirms or reopens. Works on phone and desktop.

type Meta = {
  enabled: boolean;
  sites: Array<{ id: string; name: string; district: string; kind: string; staff_groups: string[] }>;
  categories: Array<{ id: string; name: string; photo_required: boolean }>;
  targets: Array<{ priority: string; respond_hours: number; fix_working_days: number }>;
  settings: Record<string, string>;
  priorities: Array<{ value: string; label: string }>;
  is_admin_office: boolean;
  is_worker: boolean;
  my_site_ids: string[];
  has_route: boolean;
  workers: Array<{ id: string; name: string; is_contractor: boolean; contractor_phone?: string | null }>;
};
type Summary = {
  id: string; request_no: string; status: string; status_label: string; priority: string; priority_label: string;
  site_name: string; district: string; location: string; category: string; description: string;
  requester_name: string; worker_name: string | null; target_date: string | null; update_requested: boolean;
  created_at: string; next_step: string | null;
};
type Tab = "NEW" | "MINE" | "SITE" | "JOBS" | "OFFICE" | "APPROVALS" | "LISTS";

const STATUS_TONE: Record<string, [string, string]> = {
  SUBMITTED: ["#EEF2F7", "#334155"], PENDING_INFORMATION: ["#FFF4E5", "#8A4B00"], REVIEWED: ["#EEF2F7", "#334155"],
  AWAITING_APPROVAL: ["#F3EDFF", "#5B3AA8"], ASSIGNED: ["#E8F1FB", "#0B4F94"], ACCEPTED: ["#E8F1FB", "#0B4F94"],
  IN_PROGRESS: ["#FFF7D6", "#7A5A00"], WAITING_MATERIALS: ["#FFF7D6", "#7A5A00"], AWAITING_CONTRACTOR: ["#FFF7D6", "#7A5A00"],
  COMPLETED_PENDING_VERIFICATION: ["#E3F6F3", "#0F6B5C"], PENDING_CONFIRMATION: ["#E3F6F3", "#0F6B5C"],
  REOPENED: ["#FDECEC", "#A12C2C"], CLOSED: ["#E6F4EA", "#1E6B34"], CANCELLED: ["#EEEEEE", "#4B5563"]
};
const PRIORITY_TONE: Record<string, [string, string]> = {
  EMERGENCY: ["#B42318", "#FFFFFF"], HIGH: ["#FDE7D9", "#9A3412"], MEDIUM: ["#E8F1FB", "#0B4F94"], LOW: ["#EEF2F7", "#334155"]
};

function Chip({ tone, children, big }: { tone?: [string, string]; children: React.ReactNode; big?: boolean }) {
  const [bg, fg] = tone || ["#EEF2F7", "#334155"];
  return <span style={{ display: "inline-block", padding: big ? "6px 14px" : "2px 10px", borderRadius: 999, background: bg, color: fg, fontWeight: 600, fontSize: big ? 14 : 12, whiteSpace: "nowrap" }}>{children}</span>;
}

// Phone-width layout switch (the detail screen puts its action cards first there).
function useNarrow(px = 860) {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < px);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < px);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [px]);
  return narrow;
}
const UpdateFlag = () => (
  <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, border: "1px solid #F0A26B", color: "#9A3412", fontWeight: 600, fontSize: 11.5 }}>Update requested</span>
);
const fmt = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDate = (d: string | null | undefined) => d ? new Date(String(d).slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

type IconT = LucideIcon;

// Card heading with its icon (detail screen).
function SectionTitle({ icon: Icon, children }: { icon: IconT; children: React.ReactNode }) {
  return (
    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
      <Icon size={22} strokeWidth={2.2} aria-hidden style={{ color: "var(--text)", flex: "0 0 auto" }} />{children}
    </h3>
  );
}

// One labelled value with its icon (Request card).
function InfoField({ icon: Icon, label, children, wide, muted }: { icon: IconT; label: string; children: React.ReactNode; wide?: boolean; muted?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", minWidth: 0, gridColumn: wide ? "1 / -1" : undefined }}>
      <Icon size={20} aria-hidden style={{ color: "var(--muted)", flex: "0 0 auto", marginTop: 2 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{label}</div>
        <div style={{ fontWeight: muted ? 400 : 600, color: muted ? "var(--muted)" : "var(--text)", marginTop: 2, overflowWrap: "anywhere", whiteSpace: wide ? "pre-wrap" : undefined }}>{children}</div>
      </div>
    </div>
  );
}

// "4 days", "5 h", "35 min".
function span(ms: number) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  const days = Math.round(h / 24);
  return `${days} days`;
}

// The response target is met by the first move from the Admin Office or the
// worker: reviewing, assigning, asking for information, accepting, an update,
// or a comment from anyone other than the requester.
const RESPONSE_KINDS = new Set(["INFO_REQUESTED", "REVIEWED", "ASSIGNED", "ACCEPTED", "DECLINED", "STATUS", "UPDATE", "APPROVAL_REQUESTED", "COMPLETED"]);
type TargetLine = { text: string; tone: "ok" | "warn" | "late" | "none" };
const TONE_COLOR: Record<TargetLine["tone"], string> = { ok: "#1E6B34", warn: "#8A4B00", late: "#B42318", none: "var(--muted)" };

function responseStatus(d: any, now = Date.now()): TargetLine | null {
  if (!d.target) return null;
  const due = Date.parse(d.created_at) + Number(d.target.respond_hours) * 3_600_000;
  const first = [...(d.events || [])].reverse().find((e: any) => RESPONSE_KINDS.has(e.kind) || (e.kind === "COMMENT" && e.actor_name && e.actor_name !== d.requester_name));
  if (first) {
    const at = Date.parse(first.created_at);
    return at <= due ? { text: `Met · ${fmt(first.created_at)}`, tone: "ok" } : { text: `Late by ${span(at - due)} · ${fmt(first.created_at)}`, tone: "warn" };
  }
  if (now > due) return { text: `Overdue by ${span(now - due)}`, tone: "late" };
  return { text: `Due ${fmt(new Date(due).toISOString())} · ${span(due - now)} left`, tone: "warn" };
}

function fixStatus(d: any, now = Date.now()): TargetLine {
  if (!d.target_date) return { text: "Set when a worker is assigned", tone: "none" };
  const end = Date.parse(String(d.target_date).slice(0, 10) + "T23:59:59");
  if (["COMPLETED_PENDING_VERIFICATION", "PENDING_CONFIRMATION", "CLOSED", "CANCELLED"].includes(d.status)) return { text: fmtDate(d.target_date), tone: "none" };
  return now > end
    ? { text: `${fmtDate(d.target_date)} · overdue by ${span(now - end)}`, tone: "late" }
    : { text: `${fmtDate(d.target_date)} · ${span(end - now)} left`, tone: "ok" };
}

// ── Photos ───────────────────────────────────────────────────────────────────
type PhotoItem = { key: string; name: string; status: "uploading" | "done" | "failed"; id?: string; blob?: Blob; preview?: string; error?: string };

// PH-05: shrink big JPG/PNG/WebP photos before they upload (long side 1600 px,
// JPEG ~80%) so they get through weak store connections. HEIC can't be read
// by most browsers, so it goes up as it is (still within 10 MB).
async function shrinkPhoto(file: File): Promise<{ blob: Blob; name: string }> {
  const heic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);
  if (heic || !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400_000) return { blob: file, name: file.name };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.8));
    if (!blob || blob.size >= file.size) return { blob: file, name: file.name };
    return { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
  } catch {
    return { blob: file, name: file.name };
  }
}

async function uploadWithRetry(blob: Blob, name: string): Promise<string> {
  let last: any;
  for (const wait of [0, 1500, 4000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return (await api.uploadMaintenancePhoto(blob, name)).id;
    } catch (e: any) {
      last = e;
      if (e?.status && e.status < 500) break;  // a bad file won't get better by retrying
    }
  }
  throw last;
}

function PhotoPicker({ photos, setPhotos, label, hint, max = 5 }: {
  photos: PhotoItem[]; setPhotos: (fn: (p: PhotoItem[]) => PhotoItem[]) => void; label: string; hint?: string; max?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const replaceKey = useRef<string | null>(null);
  const patch = (key: string, p: Partial<PhotoItem>) => setPhotos((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function send(key: string, blob: Blob, name: string) {
    patch(key, { status: "uploading", error: undefined });
    try {
      patch(key, { status: "done", id: await uploadWithRetry(blob, name) });
    } catch (e: any) {
      patch(key, { status: "failed", error: e?.message || "Upload failed" });
    }
  }
  async function add(files: FileList | null) {
    if (!files?.length) return;
    const replacing = replaceKey.current;
    replaceKey.current = null;
    const room = replacing ? 1 : max - photos.length;
    for (const file of Array.from(files).slice(0, Math.max(0, room))) {
      if (!/\.(jpe?g|png|heic|heif|webp)$/i.test(file.name)) { alert(`${file.name}: use a JPG, PNG or HEIC photo`); continue; }
      const { blob, name } = await shrinkPhoto(file);
      if (blob.size > 10 * 1024 * 1024) { alert(`${file.name} is over 10 MB`); continue; }
      const key = replacing || `${Date.now()}-${Math.random()}`;
      const item: PhotoItem = { key, name, status: "uploading", blob, preview: URL.createObjectURL(blob) };
      setPhotos((list) => (replacing ? list.map((x) => (x.key === replacing ? item : x)) : [...list, item]));
      void send(key, blob, name);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ flex: 1 }}>{label}</strong>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>{photos.length} of {max}</span>
      </div>
      {hint && <div style={{ color: "var(--muted)", fontSize: 13 }}>{hint}</div>}
      <input ref={input} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
      {photos.length < max && (
        <button type="button" onClick={() => { replaceKey.current = null; input.current?.click(); }}
          style={{ font: "inherit", fontWeight: 600, minHeight: 52, borderRadius: 12, border: "1.5px dashed #6F9BD1", background: "#EEF5FC", color: "#0B4F94", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Camera size={18} /> Take photo or choose from gallery
        </button>
      )}
      {photos.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 10 }}>
          {photos.map((p, i) => (
            <div key={p.key} style={{ display: "grid", gap: 4 }}>
              <div style={{ position: "relative", height: 92, borderRadius: 10, background: "#D5DBE3", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", color: "#556070" }}>
                {p.preview ? <img src={p.preview} alt={`Photo ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                  : p.id ? <AuthPhoto id={p.id} alt={`Photo ${i + 1}`} fill /> : <ImageIcon size={22} />}
                <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos((l) => l.filter((x) => x.key !== p.key))}
                  style={{ position: "absolute", top: 4, right: 4, width: 28, height: 28, borderRadius: "50%", border: "2px solid #fff", background: "#334155", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                  <X size={14} />
                </button>
              </div>
              <div style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {p.status === "uploading" && <span style={{ color: "var(--muted)" }}>Uploading…</span>}
                {p.status === "done" && <span style={{ color: "#1E6B34" }}>Uploaded</span>}
                {p.status === "failed" && <>
                  <span style={{ color: "#A12C2C" }}>Failed</span>
                  <button type="button" onClick={() => p.blob && void send(p.key, p.blob, p.name)} style={{ font: "inherit", fontSize: 12, fontWeight: 600, border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "#0B4F94", cursor: "pointer", padding: "2px 8px" }}>Retry</button>
                </>}
                <button type="button" onClick={() => { replaceKey.current = p.key; input.current?.click(); }} style={{ font: "inherit", fontSize: 12, border: "none", background: "none", color: "#0B5CAD", cursor: "pointer", padding: 0, textDecoration: "underline" }}>Replace</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const uploadedIds = (photos: PhotoItem[]) => photos.filter((p) => p.status === "done" && p.id).map((p) => p.id!);
const anyUploading = (photos: PhotoItem[]) => photos.some((p) => p.status === "uploading");

// Photos are behind sign-in, so fetch each one and show it from memory.
const photoCache = new Map<string, string>();
function AuthPhoto({ id, alt, fill, onOpen }: { id: string; alt: string; fill?: boolean; onOpen?: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(photoCache.get(id) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (url) return;
    let live = true;
    api.maintenancePhotoBlob(id).then((b) => {
      const u = URL.createObjectURL(b);
      photoCache.set(id, u);
      if (live) setUrl(u);
    }).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [id, url]);
  if (failed) return <span style={{ fontSize: 11, color: "var(--muted)", padding: 6, textAlign: "center" }}>Can't show this photo</span>;
  if (!url) return <ImageIcon size={20} />;
  const img = <img src={url} alt={alt} style={fill ? { width: "100%", height: "100%", objectFit: "cover" } : { maxWidth: "100%", maxHeight: "80vh" }} />;
  return onOpen ? <button type="button" onClick={() => onOpen(url)} style={{ border: "none", padding: 0, background: "none", cursor: "zoom-in", width: "100%", height: "100%" }} aria-label={`Open ${alt} full size`}>{img}</button> : img;
}

function PhotoStrip({ photos, isAdmin, onDeleted }: { photos: any[]; isAdmin: boolean; onDeleted: () => void }) {
  const [open, setOpen] = useState<{ url: string; photo: any } | null>(null);
  if (!photos.length) return null;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(46%, 200px), 1fr))", gap: 12 }}>
        {photos.map((p) => (
          <div key={p.id} style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <div style={{ aspectRatio: "16 / 10", borderRadius: 12, background: "#D5DBE3", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", color: "#556070" }}>
              {p.deleted ? <span style={{ fontSize: 11, padding: 6, textAlign: "center" }}>Deleted: {p.delete_reason}</span>
                : <AuthPhoto id={p.id} alt={`${p.stage === "COMPLETION" ? "After" : "Photo"} by ${p.uploaded_by}`} fill onOpen={(url) => setOpen({ url, photo: p })} />}
            </div>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", minWidth: 0 }}>
              <ImageIcon size={14} aria-hidden style={{ flex: "0 0 auto" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.stage === "COMPLETION" ? "After · " : ""}{p.uploaded_by} · {fmt(p.created_at)}</span>
            </span>
          </div>
        ))}
      </div>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Photo" onClick={() => setOpen(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.85)", zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 16 }}>
          <img src={open.url} alt="Full size" style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 8 }} onClick={(e) => e.stopPropagation()} />
          <div style={{ display: "flex", gap: 10 }} onClick={(e) => e.stopPropagation()}>
            <a href={open.url} download={open.photo.original_name || "photo.jpg"} className="ep-btn-outline" style={{ background: "#fff" }}>Download</a>
            {isAdmin && (
              <button type="button" className="ep-btn-outline" style={{ background: "#fff", color: "#A12C2C" }} onClick={async () => {
                const reason = window.prompt("Why delete this photo? (kept in the history)");
                if (!reason || reason.trim().length < 3) return;
                try { await api.deleteMaintenancePhoto(open.photo.id, reason.trim()); setOpen(null); onDeleted(); } catch (e: any) { alert(e.message); }
              }}>Delete photo</button>
            )}
            <button type="button" className="ep-btn" onClick={() => setOpen(null)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}

// ── New request ──────────────────────────────────────────────────────────────
const fieldStyle: React.CSSProperties = { font: "inherit", fontSize: 16, padding: "11px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", color: "var(--text)", width: "100%", boxSizing: "border-box" };
const labelStyle: React.CSSProperties = { display: "grid", gap: 6, fontWeight: 600, fontSize: 14 };
// A locked button must still read clearly (the app's own disabled look is faint).
const lockedBtn: React.CSSProperties = { background: "#CBD3DD", borderColor: "#CBD3DD", color: "#3F4A5A", cursor: "not-allowed", opacity: 1 };
const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 16, display: "grid", gap: 12 };

function NewRequestForm({ meta, onDone }: { meta: Meta; onDone: (id: string, no: string) => void }) {
  const me = getUserFromToken();
  const draftKey = `fd-maintenance-draft-${me?.userId || "anon"}`;
  const empty = { site_id: meta.my_site_ids.length === 1 ? meta.my_site_ids[0] : "", location: "", contact_name: me?.fullName || "", contact_phone: "", category_id: "", priority: "MEDIUM", asset_tag: "", description: "", access_times: "" };
  const [f, setF] = useState<typeof empty>(() => {
    try { const d = JSON.parse(localStorage.getItem(draftKey) || "null"); return d?.fields ? { ...empty, ...d.fields } : empty; } catch { return empty; }
  });
  const [photos, setPhotos] = useState<PhotoItem[]>(() => {
    try { const d = JSON.parse(localStorage.getItem(draftKey) || "null"); return (d?.photos || []).map((p: any) => ({ key: p.id, id: p.id, name: p.name, status: "done" })); } catch { return []; }
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // PH-05: keep the form (and the photos already uploaded) on this device.
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify({ fields: f, photos: photos.filter((p) => p.status === "done").map((p) => ({ id: p.id, name: p.name })) })); } catch { /* storage off */ }
  }, [f, photos, draftKey]);

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const site = meta.sites.find((s) => s.id === f.site_id);
  const cat = meta.categories.find((c) => c.id === f.category_id);
  const photoRequired = cat ? cat.photo_required : true;
  const ids = uploadedIds(photos);
  const missing = [!f.site_id && "site", f.location.trim().length < 2 && "location", f.contact_name.trim().length < 2 && "contact person",
    f.contact_phone.trim().length < 5 && "contact phone", !f.category_id && "category", f.description.trim().length < 5 && "description"].filter(Boolean) as string[];
  const photoBlock = anyUploading(photos) ? "Waiting for a photo to finish uploading." : photoRequired && ids.length < 1 ? "Add at least 1 photo to submit." : "";
  const canSubmit = !missing.length && !photoBlock && !saving;

  async function submit() {
    setSaving(true);
    setError("");
    try {
      const r = await api.createMaintenanceRequest({ ...f, photo_ids: ids });
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      onDone(r.id, r.request_no);
    } catch (e: any) {
      setError(e.message || "Couldn't submit - your details are kept, try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!meta.has_route) {
    return <div className="ep-empty"><p>No maintenance route is set up for your Division yet. Ask an administrator to add a <strong>Maintenance Request</strong> workflow in Workflow Builder.</p></div>;
  }
  // Desktop: the form on the left, photos and Submit on the right (kept in
  // view while scrolling). Phone: one column in the mockup's order.
  const pair: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12 };
  return (
    <div style={{ maxWidth: 1140, display: "grid", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0 }}>New maintenance request</h2>
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13.5 }}>You get a request number when you submit. * required. The form is kept on this device if the connection drops.</p>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <div style={{ flex: "3 1 460px", minWidth: 0, display: "grid", gap: 14 }}>
          <section style={card} aria-label="Where is the problem?">
            <h3 style={{ margin: 0, fontSize: 16 }}>Where is the problem?</h3>
            <div style={pair}>
              <label style={labelStyle}>Site *
                <select style={fieldStyle} value={f.site_id} onChange={set("site_id")}>
                  <option value="">Select store or office</option>
                  {meta.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label style={labelStyle}>District
                <input style={{ ...fieldStyle, background: "var(--surface-soft)" }} value={site?.district || ""} placeholder="Filled in from the site" readOnly />
              </label>
            </div>
            <label style={labelStyle}>Location within site *
              <input style={fieldStyle} value={f.location} onChange={set("location")} placeholder="Room, counter, floor or area" />
            </label>
            <div style={pair}>
              <label style={labelStyle}>Contact person *
                <input style={fieldStyle} value={f.contact_name} onChange={set("contact_name")} placeholder="On-site person who can give access" />
              </label>
              <label style={labelStyle}>Contact phone *
                <input style={fieldStyle} type="tel" value={f.contact_phone} onChange={set("contact_phone")} placeholder="Phone number" />
              </label>
            </div>
          </section>
          <section style={card} aria-label="What needs fixing?">
            <h3 style={{ margin: 0, fontSize: 16 }}>What needs fixing?</h3>
            <div style={pair}>
              <label style={labelStyle}>Category *
                <select style={fieldStyle} value={f.category_id} onChange={set("category_id")}>
                  <option value="">Choose a category</option>
                  {meta.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label style={labelStyle}>Asset tag (if equipment)
                <input style={fieldStyle} value={f.asset_tag} onChange={set("asset_tag")} placeholder="Tag number on the item" />
              </label>
            </div>
            <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, padding: 0 }}>Priority *</legend>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
                {meta.priorities.map((p) => {
                  const on = f.priority === p.value;
                  return <button key={p.value} type="button" aria-pressed={on} onClick={() => setF((x) => ({ ...x, priority: p.value }))}
                    style={{ font: "inherit", fontWeight: on ? 700 : 500, minHeight: 46, borderRadius: 10, cursor: "pointer", border: on ? "2px solid #0B5CAD" : "1px solid var(--border)", background: on ? "#0B5CAD" : "var(--surface)", color: on ? "#fff" : "var(--text)" }}>{p.label}</button>;
                })}
              </div>
              {f.priority === "EMERGENCY"
                ? <div role="status" style={{ padding: "10px 12px", borderRadius: 10, background: "#FDECEC", border: "1px solid #F1B4AE", color: "#8F1F15", fontSize: 13.5 }}>Emergency: the Admin Office is alerted at once by email and on their phones. If anyone is in danger, phone them as well.</div>
                : <p style={{ margin: 0, fontSize: 13.5 }}><strong>Emergency:</strong> safety risk or the store cannot trade.</p>}
            </fieldset>
            <label style={labelStyle}>Description *
              <textarea style={{ ...fieldStyle, resize: "vertical" }} rows={4} value={f.description} onChange={set("description")} placeholder="What is wrong, since when, and the impact on trading or staff" />
            </label>
            <label style={labelStyle}>Preferred access times
              <input style={fieldStyle} value={f.access_times} onChange={set("access_times")} placeholder="e.g. weekdays before 10:00" />
            </label>
          </section>
        </div>
        <div style={{ flex: "2 1 320px", minWidth: 0, display: "grid", gap: 14, position: "sticky", top: 12 }}>
          <section style={card} aria-label="Photos">
            <PhotoPicker photos={photos} setPhotos={setPhotos} label={photoRequired ? "Photos *" : "Photos"}
              hint={`${photoRequired ? "At least 1 photo is required. " : ""}Up to 5 · JPG, PNG, HEIC · 10 MB each. Big photos are made smaller before they upload.`} />
          </section>
          {error && <div role="alert" style={{ color: "#A12C2C", fontWeight: 600 }}>{error}</div>}
          <div style={{ display: "grid", gap: 8 }}>
            <button type="button" className="ep-btn" disabled={!canSubmit} onClick={() => void submit()} style={{ minHeight: 52, fontSize: 16, ...(canSubmit ? {} : lockedBtn) }}>
              {saving ? "Submitting…" : "Submit request"}
            </button>
            {(missing.length > 0 || photoBlock) && (
              <p role="status" style={{ margin: 0, textAlign: "center", color: "#A12C2C", fontSize: 13.5, fontWeight: 600 }}>
                {missing.length ? `Still needed: ${missing.join(", ")}. ` : ""}{photoBlock}
              </p>
            )}
            <p style={{ margin: 0, textAlign: "center", color: "var(--muted)", fontSize: 12.5 }}>It goes to the Admin Office for review before anyone is assigned.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Lists of requests ────────────────────────────────────────────────────────
function RequestList({ scope, onOpen, showCounters }: { scope: Exclude<Tab, "NEW" | "LISTS">; onOpen: (id: string) => void; showCounters?: boolean }) {
  const [status, setStatus] = useState("open");
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    setRows(null);
    const s = { MINE: "mine", SITE: "site", JOBS: "jobs", OFFICE: "office", APPROVALS: "approvals" }[scope] as any;
    api.maintenanceRequests(s, status).then(setRows).catch((e: any) => setError(e.message));
  }, [scope, status]);
  const shown = (rows || []).filter((r) => !q || `${r.request_no} ${r.site_name} ${r.location} ${r.description} ${r.category}`.toLowerCase().includes(q.toLowerCase()));
  // Needs-you-first: emergencies, then anything with a next step, then by date.
  const ordered = [...shown].sort((a, b) => Number(b.priority === "EMERGENCY") - Number(a.priority === "EMERGENCY") || Number(!!b.next_step) - Number(!!a.next_step) || b.created_at.localeCompare(a.created_at));
  const paging = usePaging(ordered, () => "", 10);
  const today = new Date().toISOString().slice(0, 10);
  const counters = rows ? [
    ["To review", rows.filter((r) => r.status === "SUBMITTED").length, "#121826"],
    ["Update requested", rows.filter((r) => r.update_requested).length, "#9A3412"],
    ["To verify", rows.filter((r) => r.status === "COMPLETED_PENDING_VERIFICATION").length, "#0F6B5C"],
    ["Awaiting approval", rows.filter((r) => r.status === "AWAITING_APPROVAL").length, "#5B3AA8"],
    ["Past target date", rows.filter((r) => r.target_date && String(r.target_date).slice(0, 10) < today).length, "#B42318"]
  ] as const : [];

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {showCounters && status === "open" && rows && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          {counters.map(([label, n, color]) => (
            <div key={label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: n ? color : "var(--muted)" }}>{n}</div>
              <div style={{ color: "var(--muted)", fontSize: 13 }}>{label}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <SearchBox value={q} onChange={(v) => { setQ(v); paging.setPage(1); }} placeholder="Search by request number, site, category or description" />
        <select value={status} onChange={(e) => { setStatus(e.target.value); paging.setPage(1); }} aria-label="Status" style={{ ...fieldStyle, fontSize: 14, width: "auto" }}>
          <option value="open">Open</option><option value="closed">Closed</option><option value="cancelled">Cancelled</option><option value="all">All</option>
        </select>
      </div>
      {error && <div style={{ color: "#A12C2C" }}>{error}</div>}
      {!rows && !error && <div className="ep-loading"><p>Loading…</p></div>}
      {rows && !ordered.length && <div className="ep-empty"><p>Nothing here.</p></div>}
      {ordered.length > 0 && (
        <div style={LIST_FRAME}>
          {paging.rows.map((r, idx) => (
            <ListRow key={r.id} idx={idx} onClick={() => onOpen(r.id)} icon={maintenanceIcon(r.category)} tone={r.priority === "EMERGENCY" ? "red" : "blue"}
              accent={r.priority === "EMERGENCY" && r.next_step ? "#B42318" : undefined}
              title={`${r.category} – ${r.description.slice(0, 90)}${r.description.length > 90 ? "…" : ""}`}
              lines={[<><span>{r.location || r.site_name}</span><DateLine>{fmtDate(r.created_at)}</DateLine></>]}
              right={<>
                {r.next_step && (
                  <span title={`Your next step: ${r.next_step}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "#0B4F94" }}>
                    <span style={{ width: 7, height: 7, borderRadius: 99, background: "#2563eb" }} /> Your turn
                  </span>
                )}
                {r.priority === "EMERGENCY" && <Chip tone={PRIORITY_TONE[r.priority]}>{r.priority_label}</Chip>}
                <StatusPill status={r.status} label={r.status_label} />
              </>} />
          ))}
        </div>
      )}
      {rows && <RowPager paging={paging} noun="requests" />}
    </div>
  );
}

// ── Request detail ───────────────────────────────────────────────────────────
const KIND_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted", INFO_REQUESTED: "Asked for information", INFO_PROVIDED: "Answered", REVIEWED: "Reviewed", ASSIGNED: "Assigned",
  ACCEPTED: "Accepted", DECLINED: "Declined", STATUS: "Work status", UPDATE: "Update", COMMENT: "Comment", UPDATE_REQUESTED: "Update requested",
  APPROVAL_REQUESTED: "Approval requested", APPROVED_STEP: "Approved (step)", APPROVED: "Approved", APPROVAL_REJECTED: "Approval rejected",
  COMPLETED: "Completed", VERIFIED: "Verified", SENT_BACK: "Sent back", CONFIRMED: "Confirmed fixed", REOPENED: "Reopened",
  AUTO_CLOSED: "Closed automatically", CANCELLED: "Cancelled", PHOTO_DELETED: "Photo deleted"
};

export function MaintenanceDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }) {
  const [d, setD] = useState<any>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<string | null>(null);
  const [v, setV] = useState<Record<string, any>>({});
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  // The History comment box keeps its own text and photos, apart from the side forms.
  const [commentText, setCommentText] = useState("");
  const [commentPhotos, setCommentPhotos] = useState<PhotoItem[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  // Hooks run before the early "Loading…" return below.
  const useNarrowFlag = useNarrow();

  const load = () => api.maintenanceRequest(id).then(setD).catch((e: any) => setError(e.message));
  useEffect(() => { void load(); api.maintenanceMeta().then(setMeta).catch(() => undefined); }, [id]);

  function openForm(name: string, init: Record<string, any> = {}) { setForm(name); setV(init); setPhotos([]); setError(""); }
  async function run(action: string, extra: Record<string, any> = {}): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await api.maintenanceAction(id, { action, ...extra });
      setForm(null);
      setPhotos([]);
      await load();
      onChanged?.();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function postComment() {
    const ok = await run("comment", { body: commentText.trim(), photo_ids: uploadedIds(commentPhotos) });
    if (ok) { setCommentText(""); setCommentPhotos([]); setAttachOpen(false); }
  }

  if (!d) return <div style={{ padding: 20 }}>{error ? <span style={{ color: "#A12C2C" }}>{error}</span> : "Loading…"}</div>;
  const can = d.can || {};
  const reqPhotos = d.photos.filter((p: any) => p.stage === "REQUEST");
  const donePhotos = d.photos.filter((p: any) => p.stage === "COMPLETION");
  const btn = (label: string, onClick: () => void, tone: "primary" | "outline" | "danger" = "outline") => (
    <button type="button" disabled={busy} onClick={onClick} className={tone === "primary" ? "ep-btn" : "ep-btn-outline"}
      style={{ minHeight: 44, ...(tone === "danger" ? { color: "#A12C2C", borderColor: "#E5B4B0" } : {}) }}>{label}</button>
  );
  const textBox = (key: string, label: string, placeholder = "") => (
    <label style={labelStyle}>{label}
      <textarea style={{ ...fieldStyle, fontSize: 15, resize: "vertical" }} rows={3} value={v[key] || ""} placeholder={placeholder} onChange={(e) => setV((x) => ({ ...x, [key]: e.target.value }))} />
    </label>
  );
  const submitRow = (label: string, onClick: () => void, disabled = false) => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="ep-btn" disabled={busy || disabled || anyUploading(photos)} onClick={onClick} style={{ minHeight: 44, ...(busy || disabled || anyUploading(photos) ? lockedBtn : {}) }}>{busy ? "Saving…" : label}</button>
      <button type="button" className="ep-btn-outline" onClick={() => setForm(null)} style={{ minHeight: 44 }}>Back</button>
    </div>
  );
  const num = (key: string) => (v[key] === "" || v[key] === undefined ? undefined : Number(v[key]));
  const target = d.target;
  // Full-width action button with an icon (side cards).
  const wideBtn = (label: string, Icon: IconT, onClick: () => void, tone: "primary" | "outline" | "danger" = "outline") => (
    <button type="button" disabled={busy} onClick={onClick} className={tone === "primary" ? "ep-btn" : "ep-btn-outline"}
      style={{ minHeight: 48, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 15, fontWeight: 600, borderRadius: 10,
        ...(tone === "danger" ? { color: "#B42318", borderColor: "#E5B4B0", background: "#FFF5F5" } : {}) }}>
      <Icon size={18} aria-hidden />{label}
    </button>
  );
  const respond = OPEN_LIKE.includes(d.status) ? responseStatus(d) : null;
  const narrow = useNarrowFlag;
  const fix = fixStatus(d);
  const missedResponse = respond?.tone === "late";

  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 1100 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <button type="button" onClick={onClose} style={{ minHeight: 42, display: "inline-flex", alignItems: "center", gap: 8, borderRadius: 999, padding: "0 18px", background: "#eaf2ff", color: "#1d4ed8", border: "1px solid #c7dbfb", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
          <ArrowLeft size={17} aria-hidden /> Back
        </button>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-0.01em" }}>{d.request_no}</h2>
        <Chip big tone={STATUS_TONE[d.status]}><span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Clock size={15} aria-hidden />{d.status_label}</span></Chip>
        <Chip big tone={PRIORITY_TONE[d.priority]}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>{["EMERGENCY", "HIGH"].includes(d.priority) && <AlertTriangle size={15} aria-hidden />}{d.priority_label}</span>
        </Chip>
        {d.update_requested_at && <UpdateFlag />}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", fontSize: 15 }}>
        <MapPin size={17} aria-hidden style={{ color: "var(--muted)", flex: "0 0 auto" }} />
        <span>{d.site_name}{d.district ? `, ${d.district}` : ""} · {d.location} · {d.category}</span>
      </div>
      {(d.next_step || missedResponse) && (
        <div role="status" style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 16px", borderRadius: 12, background: missedResponse ? "#FDECEC" : "#E8F1FB", border: `1px solid ${missedResponse ? "#F3C1BD" : "#C9DDF3"}` }}>
          <span style={{ flex: "0 0 auto", width: 26, height: 26, borderRadius: 999, background: missedResponse ? "#B42318" : "#0B5CAD", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            {missedResponse ? <AlertTriangle size={15} aria-hidden /> : <Info size={16} aria-hidden />}
          </span>
          <div style={{ display: "grid", gap: 2 }}>
            {d.next_step && <div style={{ fontWeight: 600, color: "#121826" }}>Your next step: <span style={{ color: "#0B5CAD", fontWeight: 700 }}>{d.next_step}</span></div>}
            {missedResponse && <div style={{ color: "#B42318", fontWeight: 600, fontSize: 14 }}>The {target.respond_hours} h response target for {String(d.priority_label).toLowerCase()} requests was missed - {respond!.text.toLowerCase()}.</div>}
          </div>
        </div>
      )}
      {d.update_requested_at && (d.my.is_worker || d.my.is_office) && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: "#FFF4E5", border: "1px solid #F5C58A", color: "#6B3A00" }}>
          An update was asked for on {fmt(d.update_requested_at)}. Your next update or reply answers it.
        </div>
      )}
      {error && <div role="alert" style={{ color: "#A12C2C", fontWeight: 600 }}>{error}</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <div style={{ flex: "999 1 520px", minWidth: 0, display: "grid", gap: 14 }}>
          <section style={{ ...card, gap: 16, padding: 20 }} aria-label="Request">
            <SectionTitle icon={FileText}>Request</SectionTitle>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: "16px 24px" }}>
              <InfoField icon={CalendarDays} label="Submitted by">{d.requester_name} · {fmt(d.created_at)}</InfoField>
              <InfoField icon={Phone} label="Contact on site">{d.contact_name} · {d.contact_phone ? <a href={`tel:${d.contact_phone}`} style={{ color: "inherit" }}>{d.contact_phone}</a> : "—"}</InfoField>
              <InfoField icon={Hash} label="Asset tag" muted={!d.asset_tag}>{d.asset_tag || "Not given"}</InfoField>
              <InfoField icon={Lock} label="Preferred access" muted={!d.access_times}>{d.access_times || "Any time"}</InfoField>
              <InfoField icon={UserRound} label="Worker" muted={!d.worker_name}>{d.worker_name ? `${d.worker_name}${d.worker_is_contractor ? " (contractor)" : ""}` : "Not assigned yet"}</InfoField>
              <InfoField icon={CalendarCheck} label="Target date" muted={!d.target_date}>{d.target_date ? fmtDate(d.target_date) : "Set when a worker is assigned"}</InfoField>
              <InfoField icon={Building2} label="Admin Office">{String(d.admin_office_label).split(", ").map(displayOrgGroupName).join(", ")}</InfoField>
              <InfoField icon={FileText} label="Description" wide>{d.description}</InfoField>
              {d.instructions && <InfoField icon={ClipboardList} label="Instructions to worker" wide>{d.instructions}</InfoField>}
            </div>
            <PhotoStrip photos={reqPhotos} isAdmin={d.my.is_admin} onDeleted={() => void load()} />
          </section>

          {d.work_done && (
            <section style={card} aria-label="Work done">
              <SectionTitle icon={Wrench}>Work done</SectionTitle>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{d.work_done}</p>
              <div style={{ color: "var(--muted)", fontSize: 13 }}>
                {[d.parts_used && `Parts: ${d.parts_used}`, d.time_spent_hours != null && `Time: ${d.time_spent_hours} h`, d.cost != null && `Cost: M ${Number(d.cost).toFixed(2)}`, d.completed_at && `Completed ${fmt(d.completed_at)}`, d.verified_at && `Verified ${fmt(d.verified_at)}`].filter(Boolean).join(" · ")}
              </div>
              <PhotoStrip photos={donePhotos} isAdmin={d.my.is_admin} onDeleted={() => void load()} />
            </section>
          )}

          <section style={{ ...card, padding: 20 }} aria-label="History">
            <SectionTitle icon={History}>History</SectionTitle>
            {can.comment && (
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 12, padding: "0 6px 0 14px", background: "var(--surface)" }}>
                    <MessageSquare size={18} aria-hidden style={{ color: "var(--muted)", flex: "0 0 auto" }} />
                    <input value={commentText} onChange={(e) => setCommentText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && (commentText.trim() || uploadedIds(commentPhotos).length) && !busy && !anyUploading(commentPhotos)) { e.preventDefault(); void postComment(); } }}
                      placeholder={d.my.is_worker ? "Post an update - findings, next step, parts needed" : "Add a comment or photo"} aria-label={d.my.is_worker ? "Progress update" : "Comment"}
                      style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", font: "inherit", fontSize: 15, color: "var(--text)", padding: "13px 0" }} />
                    <button type="button" onClick={() => setAttachOpen((o) => !o)} aria-pressed={attachOpen} aria-label="Attach photos" title="Attach photos"
                      style={{ border: "none", background: attachOpen ? "#E8F1FB" : "transparent", color: attachOpen ? "#0B5CAD" : "var(--muted)", borderRadius: 8, width: 38, height: 38, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                      <Paperclip size={19} aria-hidden />
                    </button>
                  </div>
                  <button type="button" className="ep-btn" aria-label="Post" title="Post"
                    disabled={busy || anyUploading(commentPhotos) || (!commentText.trim() && !uploadedIds(commentPhotos).length)} onClick={() => void postComment()}
                    style={{ width: 50, height: 50, borderRadius: 12, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto",
                      ...(busy || anyUploading(commentPhotos) || (!commentText.trim() && !uploadedIds(commentPhotos).length) ? lockedBtn : {}) }}>
                    <Send size={19} aria-hidden />
                  </button>
                </div>
                {attachOpen && <PhotoPicker photos={commentPhotos} setPhotos={setCommentPhotos} label="Photos (optional)" />}
              </div>
            )}
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid" }}>
              {d.events.map((e: any) => {
                const isComment = e.kind === "COMMENT" || e.kind === "UPDATE";
                const isBad = ["DECLINED", "APPROVAL_REJECTED", "SENT_BACK", "REOPENED", "CANCELLED", "PHOTO_DELETED"].includes(e.kind);
                return (
                  <li key={e.id} style={{ padding: "14px 0", borderTop: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span aria-hidden style={{ flex: "0 0 auto", width: 30, height: 30, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center",
                      background: isBad ? "#FDECEC" : isComment ? "#E8F1FB" : "#121826", color: isBad ? "#B42318" : isComment ? "#0B5CAD" : "#fff" }}>
                      {isBad ? <XCircle size={16} /> : isComment ? <MessageSquare size={15} /> : <CheckCircle2 size={16} />}
                    </span>
                    <div style={{ display: "grid", gap: 6, minWidth: 0, flex: 1 }}>
                      <div><strong>{KIND_LABEL[e.kind] || e.kind}</strong>{e.to_status && e.kind !== "SUBMITTED" ? ` → ${(meta as any)?.status_labels?.[e.to_status] || e.to_status.replace(/_/g, " ").toLowerCase()}` : ""}
                        <span style={{ color: "var(--muted)", fontSize: 13 }}> · {e.actor_name || "FlowDesk"} · {fmt(e.created_at)}</span></div>
                      {e.body && <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{e.body}</div>}
                      {e.photo_ids.length > 0 && <PhotoStrip photos={d.photos.filter((p: any) => e.photo_ids.includes(p.id) && p.stage !== "REQUEST")} isAdmin={d.my.is_admin} onDeleted={() => void load()} />}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <aside style={{ flex: "1 1 320px", minWidth: 0, display: "grid", gap: 14, order: narrow ? -1 : 0 }}>
          {/* Requester */}
          {(can.confirm || can.reopen) && (
            <section style={{ ...card, border: "2px solid #0B5CAD" }} aria-label="Is it fixed?">
              <SectionTitle icon={ShieldCheck}>Is it fixed?</SectionTitle>
              {form !== "reopen" ? <>
                {btn("Yes, confirm resolved", () => void run("confirm"), "primary")}
                {btn("No, reopen it", () => openForm("reopen"), "danger")}
                <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>If you don't answer, it closes by itself after a few working days.</p>
              </> : <>
                {textBox("body", "What is still wrong? *")}
                <PhotoPicker photos={photos} setPhotos={setPhotos} label="Photos (optional)" />
                {submitRow("Reopen", () => void run("reopen", { body: v.body || "", photo_ids: uploadedIds(photos) }), (v.body || "").trim().length < 3)}
              </>}
            </section>
          )}
          {can.provide_info && (
            <section style={{ ...card, border: "2px solid #0B5CAD" }} aria-label="Answer the Admin Office">
              <SectionTitle icon={Info}>The Admin Office asked</SectionTitle>
              <p style={{ margin: 0 }}>{d.events.find((e: any) => e.kind === "INFO_REQUESTED")?.body}</p>
              {textBox("body", "Your answer")}
              <PhotoPicker photos={photos} setPhotos={setPhotos} label="Photos (optional)" />
              <button type="button" className="ep-btn" disabled={busy || anyUploading(photos)} style={{ minHeight: 44 }} onClick={() => void run("provide_info", { body: v.body || "", photo_ids: uploadedIds(photos) })}>Send answer</button>
            </section>
          )}
          {can.request_update && <section style={card}>{btn("Ask for an update", () => void run("request_update"))}<span style={{ color: "var(--muted)", fontSize: 13 }}>The worker and the Admin Office are told.</span></section>}

          {/* Approver */}
          {can.approve && (
            <section style={{ ...card, border: "2px solid #5B3AA8" }} aria-label="Approval">
              <SectionTitle icon={ShieldCheck}>Approve the spend?</SectionTitle>
              <p style={{ margin: 0 }}>{d.approval_reason}</p>
              {d.approval_estimate != null && <div><strong>Estimate:</strong> M {Number(d.approval_estimate).toFixed(2)}</div>}
              {textBox("body", "Comment (required to reject)")}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {btn("Approve", () => void run("approve", { body: v.body || "" }), "primary")}
                {btn("Reject", () => (v.body || "").trim().length >= 3 ? void run("reject_approval", { body: v.body }) : setError("Give a reason for rejecting"), "danger")}
              </div>
            </section>
          )}

          {/* Worker (or the Admin Office for a contractor) */}
          {(can.accept || can.decline) && (
            <section style={{ ...card, border: "2px solid #0B5CAD" }} aria-label="New job">
              <SectionTitle icon={Wrench}>{d.status === "REOPENED" ? "Reopened - take it back?" : "New job for you"}</SectionTitle>
              {target && <div style={{ fontSize: 13.5 }}><Clock size={14} style={{ verticalAlign: -2 }} /> Respond within {target.respond_hours} h · fix by {fmtDate(d.target_date)}</div>}
              {form !== "decline" ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {btn("Accept", () => void run("accept"), "primary")}
                {btn("Decline", () => openForm("decline"))}
              </div> : <>
                {textBox("body", "Why can't you take it? *")}
                {submitRow("Decline", () => void run("decline", { body: v.body || "" }), (v.body || "").trim().length < 3)}
              </>}
            </section>
          )}
          {can.set_status && (
            <section style={card} aria-label="Work status">
              <SectionTitle icon={Clock}>Where is the work?</SectionTitle>
              {[["IN_PROGRESS", "In Progress"], ["WAITING_MATERIALS", "Waiting for Materials"], ["AWAITING_CONTRACTOR", "Awaiting Contractor"]].map(([s, label]) => (
                <button key={s} type="button" aria-pressed={d.status === s} disabled={busy || d.status === s} onClick={() => void run("set_status", { status: s })}
                  style={{ font: "inherit", minHeight: 44, borderRadius: 10, textAlign: "left", padding: "0 14px", cursor: d.status === s ? "default" : "pointer",
                    border: d.status === s ? "2px solid #0B5CAD" : "1px solid var(--border)", background: d.status === s ? "#E8F1FB" : "var(--surface)", color: d.status === s ? "#0B4F94" : "var(--text)", fontWeight: d.status === s ? 700 : 500 }}>{label}</button>
              ))}
            </section>
          )}
          {can.complete && (
            <section style={card} aria-label="Completion">
              <SectionTitle icon={CheckCircle2}>Completion</SectionTitle>
              {form !== "complete" ? btn("Mark completed…", () => openForm("complete"), "primary") : <>
                {textBox("work_done", "Work done *", "What was fixed or replaced")}
                <label style={labelStyle}>Parts used<input style={fieldStyle} value={v.parts_used || ""} onChange={(e) => setV((x) => ({ ...x, parts_used: e.target.value }))} placeholder="Item and quantity" /></label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={labelStyle}>Time spent (h)<input style={fieldStyle} inputMode="decimal" value={v.time_spent_hours || ""} onChange={(e) => setV((x) => ({ ...x, time_spent_hours: e.target.value }))} /></label>
                  <label style={labelStyle}>Cost (M)<input style={fieldStyle} inputMode="decimal" value={v.cost || ""} onChange={(e) => setV((x) => ({ ...x, cost: e.target.value }))} /></label>
                </div>
                <PhotoPicker photos={photos} setPhotos={setPhotos} label="Completion photos * (at least 1)" />
                {submitRow("Mark completed", () => void run("complete", { work_done: v.work_done || "", parts_used: v.parts_used || "", time_spent_hours: num("time_spent_hours"), cost: num("cost"), photo_ids: uploadedIds(photos) }),
                  (v.work_done || "").trim().length < 3 || uploadedIds(photos).length < 1)}
                {uploadedIds(photos).length < 1 && <p role="status" style={{ margin: 0, color: "#A12C2C", fontSize: 13, fontWeight: 600 }}>Add at least 1 completion photo first.</p>}
              </>}
            </section>
          )}

          {/* Admin Office */}
          {(can.review || can.assign) && meta && (
            <section style={{ ...card, padding: 20 }} aria-label="Assignment">
              <SectionTitle icon={CheckCircle2}>Assignment</SectionTitle>
              {form !== "assign" && form !== "info" ? <div style={{ display: "grid", gap: 10 }}>
                {wideBtn(d.worker_id ? "Change assignment" : "Assign a worker", UserRound, () => openForm("assign", { worker_id: d.worker_id || "", target_date: d.target_date ? String(d.target_date).slice(0, 10) : "", priority: d.priority, body: d.instructions || "" }), "primary")}
                {can.review && wideBtn("Mark reviewed", CheckCircle2, () => void run("review"))}
                {can.request_info && wideBtn("Ask the requester for information", Info, () => openForm("info"))}
              </div> : form === "info" ? <>
                {textBox("body", "Your question *")}
                {submitRow("Send question", () => void run("request_info", { body: v.body || "" }), (v.body || "").trim().length < 3)}
              </> : <>
                <label style={labelStyle}>Worker *
                  <select style={fieldStyle} value={v.worker_id || ""} onChange={(e) => setV((x) => ({ ...x, worker_id: e.target.value }))}>
                    <option value="">Choose a worker</option>
                    {meta.workers.map((w) => <option key={w.id} value={w.id}>{w.name}{w.is_contractor ? " (contractor)" : ""}</option>)}
                  </select>
                </label>
                {!meta.workers.length && <p style={{ margin: 0, color: "#A12C2C", fontSize: 13 }}>No workers yet - add them under Lists.</p>}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={labelStyle}>Target date<input type="date" style={fieldStyle} value={v.target_date || ""} onChange={(e) => setV((x) => ({ ...x, target_date: e.target.value }))} /></label>
                  <label style={labelStyle}>Priority
                    <select style={fieldStyle} value={v.priority} onChange={(e) => setV((x) => ({ ...x, priority: e.target.value }))}>
                      {meta.priorities.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </label>
                </div>
                <p style={{ margin: 0, color: "var(--muted)", fontSize: 12.5 }}>Leave the target date empty to use the priority's fix target.</p>
                {textBox("body", "Instructions to worker", "Access notes, safety, scope")}
                {submitRow("Save assignment", () => void run("assign", { worker_id: v.worker_id, target_date: v.target_date || undefined, priority: v.priority, body: v.body || "" }), !v.worker_id)}
              </>}
            </section>
          )}
          {can.request_info && !((can.review || can.assign) && meta) && (
            <section style={card}>
              {form !== "info" ? wideBtn("Ask the requester for information", Info, () => openForm("info")) : <>
                {textBox("body", "Your question *")}
                {submitRow("Send question", () => void run("request_info", { body: v.body || "" }), (v.body || "").trim().length < 3)}
              </>}
            </section>
          )}
          {can.verify && (
            <section style={{ ...card, border: "2px solid #0F6B5C" }} aria-label="Verification">
              <SectionTitle icon={ShieldCheck}>Verify the work</SectionTitle>
              {form !== "send_back" ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {btn("Verified - ask the requester to confirm", () => void run("verify"), "primary")}
                {btn("Send back to the worker", () => openForm("send_back"))}
              </div> : <>
                {textBox("body", "What still needs doing? *")}
                {submitRow("Send back", () => void run("send_back", { body: v.body || "" }), (v.body || "").trim().length < 3)}
              </>}
            </section>
          )}
          {can.request_approval && (
            <section style={card} aria-label="Approval">
              <SectionTitle icon={ShieldCheck}>Approval</SectionTitle>
              {d.approval_status && <div style={{ fontSize: 13.5 }}>Last approval: <strong>{d.approval_status.toLowerCase()}</strong>{d.approval_reason ? ` - ${d.approval_reason}` : ""}</div>}
              {form !== "approval" ? <>
                {btn("Request approval…", () => openForm("approval"))}
                <p style={{ margin: 0, color: "var(--muted)", fontSize: 12.5 }}>For a replacement, a contractor or spend{meta?.settings?.spend_limit ? ` from M ${Number(meta.settings.spend_limit).toFixed(2)}` : ""}. Work pauses until it's approved.</p>
              </> : <>
                {textBox("body", "What needs approving? *", "Replacement, contractor, parts")}
                <label style={labelStyle}>Estimated cost (M)<input style={fieldStyle} inputMode="decimal" value={v.estimate || ""} onChange={(e) => setV((x) => ({ ...x, estimate: e.target.value }))} /></label>
                {submitRow("Send for approval", () => void run("request_approval", { body: v.body || "", estimate: num("estimate") }), (v.body || "").trim().length < 3)}
              </>}
            </section>
          )}
          {Array.isArray(d.approval_chain) && d.approval_chain.length > 0 && (
            <section style={card} aria-label="Approval steps">
              <SectionTitle icon={ShieldCheck}>Approval steps</SectionTitle>
              {d.approval_chain.map((s: any, i: number) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13.5 }}>
                  <span>{i + 1}. {s.position_name} — {s.acted_by_name || s.approver_name || "—"}</span>
                  <span style={{ fontWeight: 600 }}>{s.status ? s.status.toLowerCase() : d.status === "AWAITING_APPROVAL" && d.approval_step === i ? "waiting" : "—"}</span>
                </div>
              ))}
            </section>
          )}
          {target && OPEN_LIKE.includes(d.status) && (
            <section style={{ ...card, padding: 20 }} aria-label="Targets">
              <SectionTitle icon={Target}>Targets</SectionTitle>
              {[
                { icon: Clock, label: "Respond within", value: `${target.respond_hours} h`, status: respond },
                { icon: Wrench, label: "Fix by", value: null as string | null, status: fix }
              ].map(({ icon: Icon, label, value, status }) => (
                <div key={label} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <Icon size={20} aria-hidden style={{ color: "var(--muted)", flex: "0 0 auto", marginTop: 1 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 15 }}>
                      <span>{label}</span>
                      {value && <strong>{value}</strong>}
                    </div>
                    {status && <div style={{ fontSize: 13.5, fontWeight: status.tone === "late" ? 700 : 500, color: TONE_COLOR[status.tone], marginTop: 2 }}>{status.text}</div>}
                  </div>
                </div>
              ))}
            </section>
          )}
          {can.cancel && form !== "cancel" && wideBtn("Cancel request…", XCircle, () => openForm("cancel"), "danger")}
          {can.cancel && form === "cancel" && (
            <section style={card}>
              {<>
                {textBox("body", "Reason for cancelling *")}
                {submitRow("Cancel request", () => void run("cancel", { body: v.body || "" }), (v.body || "").trim().length < 3)}
              </>}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
const OPEN_LIKE = ["SUBMITTED", "REVIEWED", "ASSIGNED", "ACCEPTED", "IN_PROGRESS", "WAITING_MATERIALS", "AWAITING_CONTRACTOR", "REOPENED", "AWAITING_APPROVAL"];

// For the Approval Inbox.
export function MaintenanceDetailModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  return (
    <div className="review-modal-backdrop">
      <div className="review-modal-shell" style={{ maxWidth: 1180 }}>
        <MaintenanceDetail id={id} onClose={onClose} onChanged={onDone} />
      </div>
    </div>
  );
}

// ── Lists (Admin Office) ─────────────────────────────────────────────────────
// A searchable, paged list: the search box (with an optional status filter)
// and the pager under it.
type ActiveFilter = "ALL" | "ACTIVE" | "INACTIVE";
function usePagedList<T>(items: T[], text: (x: T) => string, isActive: (x: T) => boolean, pageSize = 10) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<ActiveFilter>("ALL");
  const [page, setPage] = useState(1);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = items.filter((x) => {
    if (status === "ACTIVE" && !isActive(x)) return false;
    if (status === "INACTIVE" && isActive(x)) return false;
    const hay = text(x).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  const rows = filtered.slice((current - 1) * pageSize, current * pageSize);
  return {
    q, setQ: (v: string) => { setQ(v); setPage(1); }, status, setStatus: (v: ActiveFilter) => { setStatus(v); setPage(1); },
    page: current, setPage, pages, rows, total: filtered.length, all: items.length, from: filtered.length ? (current - 1) * pageSize + 1 : 0, to: (current - 1) * pageSize + rows.length
  };
}

function ListSearch({ list, placeholder }: { list: ReturnType<typeof usePagedList<any>>; placeholder: string }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{ position: "relative", flex: "1 1 240px" }}>
        <Search size={15} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
        <input style={{ ...fieldStyle, fontSize: 14, padding: "9px 32px 9px 32px" }} value={list.q} onChange={(e) => list.setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
        {list.q && (
          <button type="button" aria-label="Clear the search" onClick={() => list.setQ("")}
            style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", cursor: "pointer", color: "var(--muted)", padding: 2 }}><X size={14} /></button>
        )}
      </div>
      <select style={{ ...fieldStyle, fontSize: 14, padding: "9px 10px", width: "auto" }} value={list.status} onChange={(e) => list.setStatus(e.target.value as ActiveFilter)} aria-label="Show">
        <option value="ALL">All</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option>
      </select>
    </div>
  );
}

function Pager({ list, noun }: { list: ReturnType<typeof usePagedList<any>>; noun: string }) {
  if (!list.all) return null;
  const nums: Array<number | "…"> = [];
  for (let i = 1; i <= list.pages; i++) {
    if (i === 1 || i === list.pages || Math.abs(i - list.page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  const btn = (on: boolean): React.CSSProperties => ({ minWidth: 32, height: 32, padding: "0 8px", borderRadius: 8, border: "1px solid var(--border)", background: on ? "var(--primary, #2563eb)" : "var(--surface)", color: on ? "#fff" : "var(--text)", cursor: "pointer", fontSize: 13 });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, color: "var(--muted)" }}>
      <span style={{ flex: 1 }}>
        {list.total ? `Showing ${list.from}–${list.to} of ${list.total} ${noun}` : `No ${noun} match`}{list.total !== list.all ? ` (${list.all} in all)` : ""}
      </span>
      {list.pages > 1 && (
        <div style={{ display: "flex", gap: 4 }} role="navigation" aria-label={`${noun} pages`}>
          <button type="button" style={btn(false)} disabled={list.page === 1} onClick={() => list.setPage(list.page - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
          {nums.map((n, i) => n === "…"
            ? <span key={`e${i}`} style={{ alignSelf: "center", padding: "0 2px" }}>…</span>
            : <button key={n} type="button" style={btn(n === list.page)} aria-current={n === list.page ? "page" : undefined} onClick={() => list.setPage(n)}>{n}</button>)}
          <button type="button" style={btn(false)} disabled={list.page === list.pages} onClick={() => list.setPage(list.page + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
        </div>
      )}
    </div>
  );
}

function MaintenanceLists() {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [site, setSite] = useState<any>(null);
  const [worker, setWorker] = useState<any>(null);
  const [newCat, setNewCat] = useState("");
  const [targets, setTargets] = useState<any[]>([]);
  const [settings, setSettings] = useState<{ spend_limit: string; auto_close_working_days: string }>({ spend_limit: "", auto_close_working_days: "3" });
  const load = () => api.maintenanceAdminLists().then((r: any) => {
    setD(r);
    setTargets(r.targets);
    setSettings({ spend_limit: r.settings.spend_limit ?? "", auto_close_working_days: r.settings.auto_close_working_days ?? "3" });
  }).catch((e: any) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const siteList = usePagedList<any>(d?.sites || [], (x) => [x.name, x.district, x.kind === "OFFICE" ? "office" : "store", ...(x.staff_groups || []).map(displayOrgGroupName)].join(" "), (x) => !!x.active);
  const workerList = usePagedList<any>(d?.workers || [], (x) => [x.name, x.is_contractor ? "contractor" : "staff", x.contractor_company, x.contractor_phone, x.contractor_email].filter(Boolean).join(" "), (x) => !!x.active);
  const catList = usePagedList<any>(d?.categories || [], (x) => x.name, (x) => !!x.active);
  const siteFormRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (site) siteFormRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [site?.id, !!site]);
  const save = async (fn: () => Promise<any>, msg: string) => {
    setError(""); setNote("");
    try { await fn(); setNote(msg); await load(); } catch (e: any) { setError(e.message); }
  };
  if (!d) return <div className="ep-loading"><p>{error || "Loading…"}</p></div>;
  const order = ["EMERGENCY", "HIGH", "MEDIUM", "LOW"];

  return (
    <div style={{ display: "grid", gap: 16, width: "100%" }}>
      <p style={{ margin: 0, color: "var(--muted)" }}>Who is in the Admin Office is set in <strong>Workflow Builder</strong>: the step whose Action Label is <strong>Assigner</strong> in the <strong>Maintenance Request</strong> workflow (or its first step, if none is). Later steps there approve spend.</p>
      {note && <div style={{ color: "#1E6B34", fontWeight: 600 }}><CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> {note}</div>}
      {error && <div role="alert" style={{ color: "#A12C2C", fontWeight: 600 }}>{error}</div>}

      <section style={card} aria-label="Sites">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>Sites</h3>
          <button type="button" className="ep-btn" onClick={() => setSite({ id: null, name: "", district: "", kind: "STORE", staff_groups: [], active: true })}><Plus size={14} /> Add site</button>
        </div>
        <ListSearch list={siteList} placeholder="Search sites by name, district or staff group" />
        {site && (
          <div ref={siteFormRef} style={{ display: "grid", gap: 10, padding: 12, border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
              <label style={labelStyle}>Name *<input style={fieldStyle} value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} /></label>
              <label style={labelStyle}>District<input style={fieldStyle} value={site.district} onChange={(e) => setSite({ ...site, district: e.target.value })} /></label>
              <label style={labelStyle}>Type<select style={fieldStyle} value={site.kind} onChange={(e) => setSite({ ...site, kind: e.target.value })}><option value="STORE">Store</option><option value="OFFICE">Office</option></select></label>
            </div>
            <label style={labelStyle}>Staff based here (they see this site's requests)
              <select style={fieldStyle} value="" onChange={(e) => e.target.value && !site.staff_groups.includes(e.target.value) && setSite({ ...site, staff_groups: [...site.staff_groups, e.target.value] })}>
                <option value="">Add a Division, Department or Section…</option>
                {d.org_groups.map((g: string) => <option key={g} value={g}>{displayOrgGroupName(g)}</option>)}
              </select>
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {site.staff_groups.map((g: string) => (
                <span key={g} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999, background: "var(--surface-soft)", border: "1px solid var(--border)", fontSize: 13 }}>
                  {displayOrgGroupName(g)}
                  <button type="button" aria-label={`Remove ${g}`} onClick={() => setSite({ ...site, staff_groups: site.staff_groups.filter((x: string) => x !== g) })} style={{ border: "none", background: "none", cursor: "pointer", padding: 0, color: "var(--muted)" }}><X size={13} /></button>
                </span>
              ))}
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={site.active} onChange={(e) => setSite({ ...site, active: e.target.checked })} /> Active</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="ep-btn" onClick={() => void save(() => api.saveMaintenanceSite(site.id, { name: site.name, district: site.district, kind: site.kind, staff_groups: site.staff_groups, active: site.active }).then(() => setSite(null)), "Site saved")}>Save site</button>
              <button type="button" className="ep-btn-outline" onClick={() => setSite(null)}>Cancel</button>
            </div>
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 520, borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead><tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12.5 }}><th style={{ padding: 6 }}>Site</th><th style={{ padding: 6 }}>District</th><th style={{ padding: 6 }}>Staff based here</th><th style={{ padding: 6 }}></th></tr></thead>
            <tbody>
              {siteList.rows.map((s: any) => (
                <tr key={s.id} style={{ borderTop: "1px solid var(--border)", opacity: s.active ? 1 : 0.55 }}>
                  <td style={{ padding: 6 }}>{s.name}{s.kind === "OFFICE" ? " (office)" : ""}{s.active ? "" : " · inactive"}</td>
                  <td style={{ padding: 6 }}>{s.district || "—"}</td>
                  <td style={{ padding: 6, color: "var(--muted)" }}>{s.staff_groups.length ? s.staff_groups.map(displayOrgGroupName).join(", ") : "—"}</td>
                  <td style={{ padding: 6, textAlign: "right", width: 48 }}>
                    <button type="button" className="ep-btn-outline" onClick={() => setSite({ ...s })} title={`Edit ${s.name}`} aria-label={`Edit ${s.name}`}
                      style={{ width: 34, height: 34, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Pencil size={15} /></button>
                  </td>
                </tr>
              ))}
              {!d.sites.length && <tr><td colSpan={4} style={{ padding: 6, color: "var(--muted)" }}>No sites yet. Staff can't log a request until there's at least one.</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager list={siteList} noun="sites" />
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))", gap: 16, alignItems: "start" }}>
      <section style={card} aria-label="Workers">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>Workers</h3>
          <button type="button" className="ep-btn" onClick={() => setWorker({ type: "internal", user_id: "", contractor_name: "", contractor_company: "", contractor_phone: "", contractor_email: "" })}><Plus size={14} /> Add worker</button>
        </div>
        {worker && (
          <div style={{ display: "grid", gap: 10, padding: 12, border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "flex", gap: 16 }}>
              <label><input type="radio" checked={worker.type === "internal"} onChange={() => setWorker({ ...worker, type: "internal" })} /> ETL staff (FlowDesk login)</label>
              <label><input type="radio" checked={worker.type === "contractor"} onChange={() => setWorker({ ...worker, type: "contractor" })} /> Contractor (no login)</label>
            </div>
            {worker.type === "internal" ? (
              <label style={labelStyle}>Person
                <select style={fieldStyle} value={worker.user_id} onChange={(e) => setWorker({ ...worker, user_id: e.target.value })}>
                  <option value="">Choose a person</option>
                  {d.users.map((u: any) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
                </select>
              </label>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                <label style={labelStyle}>Name *<input style={fieldStyle} value={worker.contractor_name} onChange={(e) => setWorker({ ...worker, contractor_name: e.target.value })} /></label>
                <label style={labelStyle}>Company<input style={fieldStyle} value={worker.contractor_company} onChange={(e) => setWorker({ ...worker, contractor_company: e.target.value })} /></label>
                <label style={labelStyle}>Phone<input style={fieldStyle} value={worker.contractor_phone} onChange={(e) => setWorker({ ...worker, contractor_phone: e.target.value })} /></label>
                <label style={labelStyle}>Email<input style={fieldStyle} type="email" value={worker.contractor_email} onChange={(e) => setWorker({ ...worker, contractor_email: e.target.value })} /></label>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="ep-btn" onClick={() => void save(() => api.saveMaintenanceWorker(null, worker.type === "internal" ? { user_id: worker.user_id } : { contractor_name: worker.contractor_name, contractor_company: worker.contractor_company, contractor_phone: worker.contractor_phone, contractor_email: worker.contractor_email }).then(() => setWorker(null)), "Worker added")}>Add</button>
              <button type="button" className="ep-btn-outline" onClick={() => setWorker(null)}>Cancel</button>
            </div>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 12.5 }}>For a contractor, the Admin Office accepts, updates and completes the job on their behalf.</p>
          </div>
        )}
        <ListSearch list={workerList} placeholder="Search workers by name, company or phone" />
        <div style={{ display: "grid", gap: 6 }}>
          {workerList.rows.map((w: any) => (
            <div key={w.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border)", opacity: w.active ? 1 : 0.55 }}>
              <span style={{ flex: 1 }}>{w.name}{w.is_contractor ? ` · contractor${w.contractor_company ? `, ${w.contractor_company}` : ""}${w.contractor_phone ? `, ${w.contractor_phone}` : ""}` : ""}</span>
              <button type="button" className="ep-btn-outline" onClick={() => void save(() => api.saveMaintenanceWorker(w.id, { active: !w.active }), w.active ? "Worker made inactive" : "Worker active again")}>{w.active ? "Make inactive" : "Make active"}</button>
            </div>
          ))}
          {!d.workers.length && <span style={{ color: "var(--muted)" }}>No workers yet.</span>}
        </div>
        <Pager list={workerList} noun="workers" />
      </section>

      <section style={card} aria-label="Categories">
        <h3 style={{ margin: 0, fontSize: 16 }}>Categories</h3>
        <ListSearch list={catList} placeholder="Search categories" />
        {catList.rows.map((c: any) => (
          <div key={c.id} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border)", opacity: c.active ? 1 : 0.55 }}>
            <span style={{ flex: "1 1 160px" }}>{c.name}</span>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13.5 }}>
              <input type="checkbox" checked={!c.photo_required} onChange={(e) => void save(() => api.saveMaintenanceCategory(c.id, { photo_required: !e.target.checked }), "Category saved")} /> Photo not required
            </label>
            <button type="button" className="ep-btn-outline" onClick={() => void save(() => api.saveMaintenanceCategory(c.id, { active: !c.active }), "Category saved")}>{c.active ? "Hide" : "Show"}</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...fieldStyle, fontSize: 14 }} value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="New category" aria-label="New category" />
          <button type="button" className="ep-btn" disabled={newCat.trim().length < 2} onClick={() => void save(() => api.saveMaintenanceCategory(null, { name: newCat.trim(), sort_order: d.categories.length }).then(() => setNewCat("")), "Category added")}>Add</button>
        </div>
        <Pager list={catList} noun="categories" />
      </section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))", gap: 16, alignItems: "start" }}>

      <section style={card} aria-label="Priority targets">
        <h3 style={{ margin: 0, fontSize: 16 }}>Priority targets</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13.5, minWidth: 420 }}>
            <thead><tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12.5 }}><th style={{ padding: 6 }}>Priority</th><th style={{ padding: 6 }}>Respond within (hours)</th><th style={{ padding: 6 }}>Fix within (working days)</th></tr></thead>
            <tbody>
              {order.map((p) => {
                const t = targets.find((x) => x.priority === p) || { priority: p, respond_hours: 24, fix_working_days: 7 };
                const upd = (k: string, val: string) => setTargets((list) => [...list.filter((x) => x.priority !== p), { ...t, [k]: val }]);
                return (
                  <tr key={p} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: 6 }}><Chip tone={PRIORITY_TONE[p]}>{p[0] + p.slice(1).toLowerCase()}</Chip></td>
                    <td style={{ padding: 6 }}><input style={{ ...fieldStyle, fontSize: 14, width: 110 }} inputMode="decimal" value={t.respond_hours} onChange={(e) => upd("respond_hours", e.target.value)} aria-label={`${p} respond hours`} /></td>
                    <td style={{ padding: 6 }}><input style={{ ...fieldStyle, fontSize: 14, width: 110 }} inputMode="numeric" value={t.fix_working_days} onChange={(e) => upd("fix_working_days", e.target.value)} aria-label={`${p} fix days`} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="button" className="ep-btn" style={{ justifySelf: "start" }} onClick={() => void save(() => api.saveMaintenanceTargets(targets.map((t) => ({ priority: t.priority, respond_hours: Number(t.respond_hours), fix_working_days: Number(t.fix_working_days) }))), "Targets saved")}>Save targets</button>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 12.5 }}>Working days skip weekends and FlowDesk's public holidays. A new assignment's target date comes from these unless the Admin Office picks one.</p>
      </section>

      <section style={card} aria-label="Settings">
        <h3 style={{ margin: 0, fontSize: 16 }}>Settings</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <label style={labelStyle}>Spend that needs approval, from (M)
            <input style={fieldStyle} inputMode="decimal" value={settings.spend_limit} placeholder="Not set" onChange={(e) => setSettings({ ...settings, spend_limit: e.target.value })} />
          </label>
          <label style={labelStyle}>Close unconfirmed requests after (working days)
            <input style={fieldStyle} inputMode="numeric" value={settings.auto_close_working_days} onChange={(e) => setSettings({ ...settings, auto_close_working_days: e.target.value })} />
          </label>
        </div>
        <button type="button" className="ep-btn" style={{ justifySelf: "start" }} onClick={() => void save(() => api.saveMaintenanceSettings({ spend_limit: settings.spend_limit.trim() === "" ? null : Number(settings.spend_limit), auto_close_working_days: Number(settings.auto_close_working_days) || 3 }), "Settings saved")}>Save settings</button>
      </section>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Maintenance({ openId, onOpenProcess }: { openId?: string | null; onOpenProcess?: () => void }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("NEW");
  const [detail, setDetail] = useState<string | null>(openId ?? null);
  const [done, setDone] = useState<{ id: string; no: string } | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api.maintenanceMeta().then((m: Meta) => {
      setMeta(m);
      setTab(m.is_admin_office ? "OFFICE" : m.is_worker ? "JOBS" : "NEW");
    }).catch((e: any) => setError(e.message));
  }, []);
  useEffect(() => { if (openId) setDetail(openId); }, [openId]);

  const tabs = useMemo(() => {
    if (!meta) return [] as Array<[Tab, string, React.ReactNode]>;
    const t: Array<[Tab, string, React.ReactNode]> = [["NEW", "New request", <Plus size={14} key="i" />], ["MINE", "My requests", <ClipboardList size={14} key="i" />]];
    if (meta.my_site_ids.length) t.push(["SITE", "My site", <MapPin size={14} key="i" />]);
    if (meta.is_worker) t.push(["JOBS", "My jobs", <Wrench size={14} key="i" />]);
    if (meta.is_admin_office) t.push(["OFFICE", "Admin Office", <ClipboardList size={14} key="i" />], ["LISTS", "Lists", <Settings size={14} key="i" />]);
    return t;
  }, [meta]);

  if (error) return <div style={{ padding: 24, color: "#A12C2C" }}>{error}</div>;
  if (!meta) return <div className="ep-loading" style={{ padding: 24 }}><p>Loading…</p></div>;

  return (
    <div style={{ padding: "20px 16px 40px", width: "100%", boxSizing: "border-box", display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 24, display: "flex", alignItems: "center", gap: 10, flex: 1 }}><Wrench size={22} /> Maintenance</h1>
        <GuidedTour id="maintenance" {...TOURS.maintenance} />
      </div>
      {!meta.enabled && (
        <div role="status" style={{ padding: "12px 14px", borderRadius: 10, background: "#FFF4E5", border: "1px solid #F5C58A", color: "#6B3A00" }}>
          <strong>Maintenance is switched off.</strong> Staff can't see it and nobody can log a request. Set up the sites and workers under Lists first, then switch it on
          {onOpenProcess ? <> under <a href="#" onClick={(e) => { e.preventDefault(); onOpenProcess(); }}>Process</a></> : " under Process"}.
        </div>
      )}
      {!detail && (
        <nav aria-label="Maintenance" style={{ display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}>
          {tabs.map(([key, label, icon]) => (
            <a key={key} href="#" className={`ep-tab ${tab === key ? "active" : ""}`} aria-current={tab === key ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); setTab(key); setDone(null); }}>{icon} {label}</a>
          ))}
        </nav>
      )}
      {detail ? (
        <MaintenanceDetail id={detail} onClose={() => { setDetail(null); setRefresh((n) => n + 1); }} />
      ) : tab === "NEW" ? (
        done ? (
          <div style={{ ...card, maxWidth: 560 }}>
            <h2 style={{ margin: 0 }}><CheckCircle2 size={22} style={{ verticalAlign: -4, color: "#1E6B34" }} /> Request {done.no} submitted</h2>
            <p style={{ margin: 0 }}>The Admin Office reviews it before anyone is assigned. You'll get an email and a FlowDesk notification at every step.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="ep-btn" onClick={() => setDetail(done.id)}>View it</button>
              <button type="button" className="ep-btn-outline" onClick={() => setDone(null)}>Log another</button>
            </div>
          </div>
        ) : meta.enabled ? <NewRequestForm meta={meta} onDone={(id, no) => setDone({ id, no })} />
          : <div className="ep-empty"><p>New requests open once Maintenance is switched on under Process.</p></div>
      ) : tab === "LISTS" ? (
        <MaintenanceLists />
      ) : (
        <RequestList key={`${tab}-${refresh}`} scope={tab} onOpen={setDetail} showCounters={tab === "OFFICE"} />
      )}
    </div>
  );
}
