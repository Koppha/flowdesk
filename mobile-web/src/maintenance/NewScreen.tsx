import { useEffect, useMemo, useState } from "react";
import { api, currentUser } from "../api";
import { validPhone } from "../screens/PhoneScreen";
import { go } from "../router";
import { mApi } from "./api";
import { PhotoPicker, stillUploading, uploadedIds, type PickedPhoto } from "./Photos";
import { useMeta } from "./shared";

// Log a maintenance request: where, what, how urgent, and photos of it.
export default function MaintenanceNew() {
  const { meta, error: metaError } = useMeta();
  const me = currentUser();
  const [siteId, setSiteId] = useState("");
  const [location, setLocation] = useState("");
  const [contactName, setContactName] = useState(me?.fullName || "");
  const [contactPhone, setContactPhone] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [assetTag, setAssetTag] = useState("");
  const [description, setDescription] = useState("");
  const [accessTimes, setAccessTimes] = useState("");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The phone on my FlowDesk profile: prefills the contact phone, and if
  // there's none, the number I type here (as the contact) is saved to it.
  const [profilePhone, setProfilePhone] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then((p) => {
        setProfilePhone(p.phone || null);
        if (p.phone) setContactPhone((cur) => cur || p.phone || "");
      })
      .catch(() => setProfilePhone(undefined));
  }, []);

  // My own sites first - that's almost always where the problem is.
  const sites = useMemo(() => {
    if (!meta) return [];
    const mine = new Set(meta.my_site_ids);
    return [...meta.sites].sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)) || a.name.localeCompare(b.name));
  }, [meta]);

  if (metaError) return <p className="error">{metaError}</p>;
  if (!meta) return <p className="muted center">Loading…</p>;
  if (!meta.enabled || !meta.has_route) return <p className="muted center">You can't log a maintenance request right now.</p>;

  const category = meta.categories.find((c) => c.id === categoryId);

  async function submit() {
    const missing = !siteId ? "Pick the site." : location.trim().length < 2 ? "Say where on the site it is." : contactName.trim().length < 2 ? "Give a contact name."
      : contactPhone.trim().length < 5 ? "Give a contact phone number." : !categoryId ? "Pick a category." : description.trim().length < 5 ? "Describe the problem."
      : stillUploading(photos) ? "Wait for the photos to finish uploading." : photos.some((p) => p.state === "error") ? "A photo didn't upload - retry it or remove it."
      : category?.photo_required && uploadedIds(photos).length < 1 ? "Add at least 1 photo of the problem." : "";
    if (missing) return setError(missing);
    setBusy(true);
    setError("");
    try {
      const r = await mApi.create({
        site_id: siteId, location: location.trim(), contact_name: contactName.trim(), contact_phone: contactPhone.trim(), category_id: categoryId,
        priority, asset_tag: assetTag.trim(), description: description.trim(), access_times: accessTimes.trim(), photo_ids: uploadedIds(photos)
      });
      // No phone on my profile yet, and I'm the contact: keep the number.
      const isMe = contactName.trim().toLowerCase() === (me?.fullName || "").trim().toLowerCase();
      if (profilePhone === null && isMe && validPhone(contactPhone)) {
        await api.saveMyPhone(contactPhone.trim()).catch(() => {});
      }
      go({ name: "mreq", id: r.id }, true);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>New maintenance request</h1>

      <section className="card stack">
        <h3>Where</h3>
        <label className="field">
          <span>Site</span>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">Choose a site…</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.district ? ` (${s.district})` : ""}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Exact location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Back office, staff toilet" />
        </label>
        <label className="field">
          <span>When can someone get in? (optional)</span>
          <input value={accessTimes} onChange={(e) => setAccessTimes(e.target.value)} placeholder="e.g. Weekdays 8:00-16:30" />
        </label>
      </section>

      <section className="card stack">
        <h3>What's wrong</h3>
        <label className="field">
          <span>Category</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose a category…</option>
            {meta.categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>How urgent?</span>
          <div className="segmented">
            {meta.priorities.map((p) => (
              <button key={p.value} type="button" className={priority === p.value ? `on ${p.value === "EMERGENCY" ? "danger-on" : ""}` : ""} onClick={() => setPriority(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>Describe the problem</span>
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's broken, since when, anything already tried" />
        </label>
        <label className="field">
          <span>Asset tag (optional)</span>
          <input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} />
        </label>
      </section>

      <section className="card stack">
        <h3>Photos{category?.photo_required === false ? " (optional)" : ""}</h3>
        <PhotoPicker photos={photos} onChange={setPhotos} />
      </section>

      <section className="card stack">
        <h3>Contact on site</h3>
        <label className="field">
          <span>Name</span>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="name" />
        </label>
        <label className="field">
          <span>Phone</span>
          <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} autoComplete="tel" placeholder="+266 6222 1234" />
        </label>
      </section>

      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="button" className="primary" onClick={submit} disabled={busy}>
          {busy ? "Sending…" : "Send request"}
        </button>
      </div>
    </div>
  );
}
