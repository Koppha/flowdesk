import { useEffect, useRef, useState } from "react";
import { mApi, photoUrl, shrink, toDataUrl } from "./api";

export type PickedPhoto = { key: string; preview: string; state: "uploading" | "done" | "error"; id?: string; file: File };

export const uploadedIds = (photos: PickedPhoto[]) => photos.filter((p) => p.state === "done" && p.id).map((p) => p.id!);
export const stillUploading = (photos: PickedPhoto[]) => photos.some((p) => p.state === "uploading");

// Take or choose up to `max` photos. Each one uploads on its own as soon as
// it's picked (the server keeps it unattached until the form is sent), so a
// dropped connection only means retrying that one photo.
export function PhotoPicker({ photos, onChange, max = 5 }: { photos: PickedPhoto[]; onChange: (next: PickedPhoto[]) => void; max?: number }) {
  // Several uploads finish independently, often before React re-renders -
  // keep the newest list here and update it synchronously, so one finishing
  // upload never overwrites another's result (or drops a just-added photo).
  const latest = useRef(photos);
  latest.current = photos;
  const set = (next: PickedPhoto[]) => {
    latest.current = next;
    onChange(next);
  };
  const update = (key: string, patch: Partial<PickedPhoto>) => set(latest.current.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  async function upload(p: PickedPhoto) {
    update(p.key, { state: "uploading" });
    try {
      const { blob, name } = await shrink(p.file);
      const { id } = await mApi.uploadPhoto(blob, name);
      update(p.key, { state: "done", id });
    } catch {
      update(p.key, { state: "error" });
    }
  }

  async function add(files: FileList | null) {
    if (!files?.length) return;
    const room = max - latest.current.length;
    const picked: PickedPhoto[] = [];
    for (const file of Array.from(files).slice(0, room)) {
      picked.push({ key: `${Date.now()}-${Math.random()}`, preview: await toDataUrl(file).catch(() => ""), state: "uploading", file });
    }
    set([...latest.current, ...picked]);
    picked.forEach((p) => void upload(p));
  }

  const full = photos.length >= max;
  return (
    <div className="stack-sm">
      {photos.length > 0 && (
        <div className="photo-grid">
          {photos.map((p) => (
            <div key={p.key} className={`thumb ${p.state}`}>
              {p.preview ? <img src={p.preview} alt="" /> : <span className="small muted">Photo</span>}
              {p.state === "uploading" && <span className="thumb-badge">Uploading…</span>}
              {p.state === "error" && (
                <button type="button" className="thumb-badge error-badge" onClick={() => void upload(p)}>Retry</button>
              )}
              <button type="button" className="thumb-x" aria-label="Remove photo" onClick={() => set(latest.current.filter((x) => x.key !== p.key))}>✕</button>
            </div>
          ))}
        </div>
      )}
      {!full && (
        <div className="row gap">
          <label className="photo-btn">
            <input type="file" accept="image/*" capture="environment" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
            Take photo
          </label>
          <label className="photo-btn">
            <input type="file" accept="image/*" multiple onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
            Choose photos
          </label>
        </div>
      )}
      <span className="muted small">{photos.length}/{max} photos</span>
    </div>
  );
}

/** A server photo, fetched with the session. Tap to view it full screen. */
export function ServerPhoto({ id, deleted }: { id: string; deleted?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (deleted) return;
    let alive = true;
    photoUrl(id).then((u) => alive && setSrc(u)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [id, deleted]);

  if (deleted || failed) return <div className="thumb"><span className="small muted">{deleted ? "Deleted" : "Unavailable"}</span></div>;
  return (
    <>
      <button type="button" className="thumb" onClick={() => src && setOpen(true)}>
        {src ? <img src={src} alt="" /> : <span className="small muted">…</span>}
      </button>
      {open && src && (
        <div className="lightbox" role="dialog" onClick={() => setOpen(false)}>
          <img src={src} alt="" />
          <span className="small">Tap to close</span>
        </div>
      )}
    </>
  );
}
