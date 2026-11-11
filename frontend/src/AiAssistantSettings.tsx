import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Loader2, Plus, Sparkles, Trash2, X, XCircle } from "lucide-react";
import { api } from "./api";

// Settings > AI Assistant (ADMIN): which AI services the FlowDesk Assistant
// can use (each with its address and one or more named API keys - the one
// ticked is used), one model list across them in order of preference,
// whether people may pick their own model, daily limit and on/off. Saved to
// the server (backend-v2/src/modules/ai/ai-settings.ts) and picked up by
// every server within 15 seconds - no code, .env edit or restart. Keys are
// write-only: added and deleted on the spot, never shown again.

type ServiceId = "gemini" | "groq" | "openrouter" | "anthropic" | "ollama" | "custom";
type ServiceRow = { service: ServiceId; base_url: string; key_id?: string | null };
type ModelRow = { service: ServiceId; model: string };
type KeyInfo = { id: string; name: string; service: ServiceId; base_url: string; source: "settings" | "env"; key_hint: string | null; created_at: string | null };
type Saved = { enabled: boolean; daily_limit: number; services: ServiceRow[]; models: ModelRow[]; user_choice: boolean; source: "settings" | "env"; configured: boolean; keys: KeyInfo[] };
type Form = { enabled: boolean; daily_limit: string; services: ServiceRow[]; models: ModelRow[]; user_choice: boolean };
type TestResult = { service: ServiceId; model: string; ok: boolean; ms: number; message: string };

const SERVICES: Record<ServiceId, { label: string; base: string; help: string }> = {
  gemini: { label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", help: "Key from aistudio.google.com → Get API key. The free tier allows about 20 requests a day per model; turn on billing for the Google project for real use and for the Pro / Gemini 4 models." },
  groq: { label: "Groq", base: "https://api.groq.com/openai/v1", help: "Key from console.groq.com → API Keys. Runs open models; the free tier has daily limits." },
  openrouter: { label: "OpenRouter", base: "https://openrouter.ai/api/v1", help: "Key from openrouter.ai → Keys. One key for models from many providers; models ending in :free cost nothing." },
  anthropic: { label: "Claude (Anthropic)", base: "", help: "Key from console.anthropic.com → API Keys. Set a monthly spend limit there." },
  ollama: { label: "Ollama (own server)", base: "http://127.0.0.1:11434/v1", help: "A model running on one of our own servers - nothing leaves the network. No key needed." },
  custom: { label: "Other (OpenAI-compatible)", base: "", help: "Any service with an OpenAI-compatible chat API: enter its address and key." }
};
const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];

const field: React.CSSProperties = { display: "grid", gap: 6, maxWidth: 720 };
const label: React.CSSProperties = { fontSize: 13, fontWeight: 600 };
const hint: React.CSSProperties = { fontSize: 12, color: "var(--muted)", lineHeight: 1.5 };
const small: React.CSSProperties = { padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--text)", cursor: "pointer", fontSize: 12.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 };
const iconBtn: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", cursor: "pointer", padding: 4, display: "inline-flex" };
const card: React.CSSProperties = { display: "grid", gap: 10, padding: 14, border: "1px solid var(--border)", borderRadius: 10 };
const chip = (color: string, bg: string): React.CSSProperties => ({ fontSize: 11, fontWeight: 700, color, background: bg, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" });
const serviceTag: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" };

export default function AiAssistantSettings() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  // The "Add a key" form under each service: a name and the key itself.
  const [newKeys, setNewKeys] = useState<Partial<Record<ServiceId, { name: string; key: string }>>>({});
  const [available, setAvailable] = useState<Partial<Record<ServiceId, string[]>>>({});
  const [newModel, setNewModel] = useState<{ service: ServiceId | ""; model: string }>({ service: "", model: "" });
  const [addingService, setAddingService] = useState<ServiceId | "">("");
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  // "✓ Saved" next to the button - without it a successful save just greys
  // the button out, which reads as "not responding".
  const [justSaved, setJustSaved] = useState(false);

  const services = (rows: ServiceRow[]) => rows.map((s) => ({ service: s.service, base_url: s.base_url, key_id: s.key_id ?? null }));
  // Keys come back from their own calls; keep the form's unsaved edits.
  function loadKeys(s: Saved) {
    setSaved((prev) => (prev ? { ...prev, keys: s.keys } : s));
  }
  function load(s: Saved) {
    setSaved(s);
    setForm({ enabled: s.enabled, daily_limit: String(s.daily_limit), services: services(s.services), models: s.models, user_choice: s.user_choice !== false });
  }
  useEffect(() => { api.aiSettings().then(load).catch((e: any) => setError(e.message)); }, []);

  const dirty = useMemo(() => {
    if (!saved || !form) return false;
    return form.enabled !== saved.enabled || form.daily_limit !== String(saved.daily_limit) || form.user_choice !== (saved.user_choice !== false) ||
      JSON.stringify(form.services) !== JSON.stringify(services(saved.services)) || JSON.stringify(form.models) !== JSON.stringify(saved.models);
  }, [saved, form]);

  if (error && !form) return <div className="ep-panel" style={{ padding: 20, color: "#b91c1c" }}>Couldn't load the AI settings: {error}</div>;
  if (!form || !saved) return null;

  const set = (patch: Partial<Form>) => { setForm({ ...form, ...patch }); setJustSaved(false); };
  // Keys saved for this service at this address, and the one it uses: the
  // ticked one, else the first (the server does the same).
  const keysOf = (s: ServiceRow) => saved.keys.filter((k) => k.service === s.service && k.base_url === s.base_url);
  const activeKey = (s: ServiceRow) => { const list = keysOf(s); return list.find((k) => k.id === s.key_id) || list.find((k) => k.source === "settings") || list[0] || null; };
  const target = (s: ServiceRow) => ({ service: s.service, base_url: s.base_url, key_id: activeKey(s)?.id ?? null });
  const notAdded = SERVICE_IDS.filter((id) => !form.services.some((s) => s.service === id));

  function addService(id: ServiceId) {
    const models = id === "anthropic" && !form!.models.some((m) => m.service === "anthropic") ? [...form!.models, { service: id, model: "claude-opus-5-5" }] : form!.models;
    set({ services: [...form!.services, { service: id, base_url: SERVICES[id].base }], models });
    setAddingService("");
  }
  function removeService(id: ServiceId) {
    const count = form!.models.filter((m) => m.service === id).length;
    if (count && !confirm(`Remove ${SERVICES[id].label}? Its ${count} model${count === 1 ? "" : "s"} will be taken off the list. Its saved key is kept for later.`)) return;
    set({ services: form!.services.filter((s) => s.service !== id), models: form!.models.filter((m) => m.service !== id) });
  }
  function setBase(id: ServiceId, base_url: string) {
    set({ services: form!.services.map((s) => (s.service === id ? { ...s, base_url } : s)) });
  }
  function pickKey(id: ServiceId, key_id: string) {
    set({ services: form!.services.map((s) => (s.service === id ? { ...s, key_id } : s)) });
  }
  // Saved at once (encrypted on the server) and ticked for its service; the
  // pick itself is part of "Save changes".
  async function addKey(s: ServiceRow) {
    const k = newKeys[s.service];
    if (!k?.name.trim() || !k.key.trim()) return;
    setBusy(`key:${s.service}`); setError(null);
    try {
      const r = await api.aiKeyAdd({ service: s.service, base_url: s.base_url, name: k.name.trim(), key: k.key.trim() });
      loadKeys(r.settings);
      setNewKeys({ ...newKeys, [s.service]: undefined });
      pickKey(s.service, r.id);
    } catch (e: any) { setError(`${SERVICES[s.service].label}: ${e.message}`); }
    finally { setBusy(""); }
  }
  async function deleteKey(s: ServiceRow, k: KeyInfo) {
    const inUse = activeKey(s)?.id === k.id;
    if (!confirm(`Delete the key "${k.name}" (${k.key_hint || "…"})?${inUse ? " It's the one this service uses now - it will switch to another saved key, if there is one." : ""} This can't be undone.`)) return;
    setBusy(`key:${s.service}`); setError(null);
    try {
      loadKeys(await api.aiKeyRemove(k.id));
      if (s.key_id === k.id) set({ services: form!.services.map((x) => (x.service === s.service ? { ...x, key_id: null } : x)) });
    } catch (e: any) { setError(e.message); }
    finally { setBusy(""); }
  }
  function addModel(service: ServiceId, model: string) {
    const name = model.trim();
    if (!name || form!.models.some((m) => m.service === service && m.model === name) || form!.models.length >= 12) return;
    set({ models: [...form!.models, { service, model: name }] });
  }
  function move(i: number, dir: -1 | 1) {
    const next = [...form!.models];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set({ models: next });
  }

  async function loadModels(s: ServiceRow) {
    setBusy(`models:${s.service}`); setError(null);
    try { setAvailable({ ...available, [s.service]: (await api.aiSettingsModels(target(s))).models || [] }); }
    catch (e: any) { setError(`${SERVICES[s.service].label}: ${e.message}`); }
    finally { setBusy(""); }
  }
  async function test() {
    setBusy("test"); setError(null); setResults(null);
    try { setResults((await api.aiSettingsTest({ services: form!.services.map(target), models: form!.models })).results || []); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(""); }
  }
  async function save() {
    setBusy("save"); setError(null); setJustSaved(false);
    try {
      load(await api.updateAiSettings({ enabled: form!.enabled, daily_limit: Number(form!.daily_limit), services: form!.services, models: form!.models, user_choice: form!.user_choice }));
      setJustSaved(true);
    } catch (e: any) { setError(`Not saved: ${e.message}`); }
    finally { setBusy(""); }
  }

  // Mid-tone colours so the chips read on both the light and dark theme.
  const statusChip = !saved.enabled ? ["Switched off", "#64748b", "rgba(100,116,139,0.16)"] : saved.configured ? ["Online", "#10b981", "rgba(16,185,129,0.14)"] : ["Not set up", "#d97706", "rgba(245,158,11,0.16)"];

  return (
    <div className="ep-panel" style={{ marginBottom: 20 }}>
      <div style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--surface, #fff)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "14px 20px", borderBottom: "1px solid var(--border)", borderRadius: "inherit" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", color: "#fff", background: "linear-gradient(135deg,#6366f1,#d946ef)" }}><Sparkles size={16} /></div>
          <span style={{ fontSize: 16, fontWeight: 700 }}>AI Assistant</span>
          <span style={chip(statusChip[1], statusChip[2])}>{statusChip[0]}</span>
          {dirty && <span style={chip("#b45309", "#fef3e2")}>UNSAVED CHANGES</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {error ? <span style={{ fontSize: 12.5, color: "#dc2626", maxWidth: 460 }}>{error}</span>
            : justSaved && !dirty ? <span style={{ fontSize: 12.5, color: "#10b981" }}>Live on every server within 15 seconds</span> : null}
          <button onClick={() => void save()} disabled={!dirty || busy !== ""} title={!dirty && !justSaved ? "Nothing has changed since the last save" : undefined}
            style={{ padding: "9px 18px", border: "none", borderRadius: 9, background: justSaved && !dirty ? "#059669" : "#4f46e5", color: "#fff", fontSize: 13, fontWeight: 700, cursor: !dirty || busy ? "default" : "pointer", opacity: (!dirty && !justSaved) || busy ? 0.55 : 1 }}>
            {busy === "save" ? "Saving…" : justSaved && !dirty ? "✓ Saved" : "Save changes"}
          </button>
        </div>
      </div>

      <div style={{ padding: 20, display: "grid", gap: 26 }}>
        {saved.source === "env" && (
          <div style={{ ...hint, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "rgba(99,102,241,0.06)" }}>
            These settings currently come from the server's <code>.env</code> file. Saving here moves them into FlowDesk, so they can be changed from this page from then on.
          </div>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} style={{ width: 16, height: 16, minHeight: 0 }} />
          Assistant is on for everyone with access
        </label>

        <div style={field}>
          <span style={label}>AI services</span>
          <span style={hint}>Connect as many as you like. Each can keep several named keys (say a free and a paid one) - tick the one to use and save to switch. Removing a service keeps its keys, so adding it back later needs no re-entry.</span>
          {form.services.map((s) => {
            const k = activeKey(s);
            const keyChip = s.service === "ollama" ? null : k ? chip("#10b981", "rgba(16,185,129,0.14)") : chip("#d97706", "rgba(245,158,11,0.16)");
            const keyText = k ? `Using ${k.name} (${k.key_hint})` : "No key yet";
            const keys = keysOf(s);
            const nk = newKeys[s.service] || { name: "", key: "" };
            return (
              <div key={s.service} style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 14 }}>{SERVICES[s.service].label}</strong>
                  {keyChip && <span style={keyChip}>{keyText}</span>}
                  <span style={{ flex: 1 }} />
                  <button type="button" style={small} onClick={() => void loadModels(s)} disabled={busy !== ""}>
                    {busy === `models:${s.service}` ? <Loader2 size={14} className="spin" /> : null} Load models
                  </button>
                  <button type="button" style={{ ...small, color: "#dc2626" }} onClick={() => removeService(s.service)}><Trash2 size={13} /> Remove</button>
                </div>
                <span style={hint}>{SERVICES[s.service].help}</span>
                {s.service !== "anthropic" && (
                  <input value={s.base_url} onChange={(e) => setBase(s.service, e.target.value.trim())} placeholder="Service address, https://…/v1" aria-label={`${SERVICES[s.service].label} address`} />
                )}
                {s.service !== "ollama" && (
                  <div style={{ display: "grid", gap: 6 }}>
                    {keys.length > 0 && (
                      <div role="radiogroup" aria-label={`${SERVICES[s.service].label} key to use`} style={{ display: "grid", gap: 4 }}>
                        {keys.map((key) => (
                          <label key={key.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" }}>
                            <input type="radio" name={`key-${s.service}`} checked={k?.id === key.id} onChange={() => pickKey(s.service, key.id)} style={{ width: 15, height: 15, minHeight: 0 }} />
                            <strong style={{ fontWeight: 600 }}>{key.name}</strong>
                            <code style={{ fontSize: 12, color: "var(--muted)" }}>{key.key_hint}</code>
                            {key.created_at && <span style={{ fontSize: 11.5, color: "var(--muted)" }}>added {new Date(key.created_at).toLocaleDateString()}</span>}
                            <span style={{ flex: 1 }} />
                            {key.source === "settings" ? (
                              <button type="button" style={{ ...iconBtn, color: "#dc2626" }} disabled={busy !== ""} onClick={(e) => { e.preventDefault(); void deleteKey(s, key); }} aria-label={`Delete key ${key.name}`} title="Delete this key"><Trash2 size={13} /></button>
                            ) : <span style={{ fontSize: 11.5, color: "var(--muted)" }}>set on the server</span>}
                          </label>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <input value={nk.name} onChange={(e) => setNewKeys({ ...newKeys, [s.service]: { ...nk, name: e.target.value } })} placeholder="Name, e.g. Free or Company paid" aria-label={`Name for a new ${SERVICES[s.service].label} key`} style={{ flex: "1 1 160px", maxWidth: 220 }} />
                      <input type="password" autoComplete="new-password" value={nk.key} onChange={(e) => setNewKeys({ ...newKeys, [s.service]: { ...nk, key: e.target.value } })} placeholder={keys.length ? "Paste another API key" : "Paste the API key"} aria-label={`New ${SERVICES[s.service].label} API key`} style={{ flex: "2 1 220px" }} />
                      <button type="button" style={small} disabled={busy !== "" || !nk.name.trim() || !nk.key.trim()} onClick={() => void addKey(s)}>
                        {busy === `key:${s.service}` ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Add key
                      </button>
                    </div>
                  </div>
                )}
                {available[s.service] && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto", padding: 8, border: "1px dashed var(--border)", borderRadius: 8 }}>
                    {available[s.service]!.length === 0 ? <span style={hint}>No chat models found for this key.</span> : available[s.service]!.map((m) => {
                      const added = form.models.some((x) => x.service === s.service && x.model === m);
                      return (
                        <button key={m} type="button" onClick={() => addModel(s.service, m)} disabled={added}
                          style={{ ...small, padding: "4px 9px", fontWeight: 500, opacity: added ? 0.45 : 1 }}>{added ? "✓ " : "+ "}{m}</button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {notAdded.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select value={addingService} onChange={(e) => setAddingService(e.target.value as ServiceId | "")} style={{ maxWidth: 280 }} aria-label="Service to add">
                <option value="">Add a service…</option>
                {notAdded.map((id) => <option key={id} value={id}>{SERVICES[id].label}</option>)}
              </select>
              <button type="button" style={small} disabled={!addingService} onClick={() => addingService && addService(addingService)}><Plus size={14} /> Add service</button>
            </div>
          )}
        </div>

        <div style={field}>
          <span style={label}>Models, in order of preference</span>
          <span style={hint}>The first model answers. If it's busy, out of quota or its service is down, the next one takes over automatically - on any service.</span>
          <div style={{ display: "grid", gap: 6 }}>
            {form.models.length === 0 && <span style={{ ...hint, fontStyle: "italic" }}>No models yet - use Load models on a service above, or add one below.</span>}
            {form.models.map((m, i) => (
              <div key={`${m.service}:${m.model}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
                <span style={{ fontSize: 12, color: "var(--muted)", width: 18 }}>{i + 1}.</span>
                <span style={serviceTag}>{SERVICES[m.service].label}</span>
                <code style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>{m.model}</code>
                {i === 0 && <span style={{ fontSize: 11, fontWeight: 700, color: "#6366f1" }}>PREFERRED</span>}
                <button type="button" style={iconBtn} onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp size={13} /></button>
                <button type="button" style={iconBtn} onClick={() => move(i, 1)} disabled={i === form.models.length - 1} aria-label="Move down"><ArrowDown size={13} /></button>
                <button type="button" style={iconBtn} onClick={() => set({ models: form.models.filter((_, j) => j !== i) })} aria-label="Remove"><X size={13} /></button>
              </div>
            ))}
          </div>
          {form.services.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select value={newModel.service || form.services[0].service} onChange={(e) => setNewModel({ ...newModel, service: e.target.value as ServiceId })} style={{ maxWidth: 220 }} aria-label="Service for the new model">
                {form.services.map((s) => <option key={s.service} value={s.service}>{SERVICES[s.service].label}</option>)}
              </select>
              <input value={newModel.model} onChange={(e) => setNewModel({ ...newModel, model: e.target.value })} placeholder="Model name" style={{ flex: "1 1 220px", maxWidth: 340 }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addModel((newModel.service || form.services[0].service) as ServiceId, newModel.model); setNewModel({ ...newModel, model: "" }); } }} />
              <button type="button" style={small} disabled={!newModel.model.trim()}
                onClick={() => { addModel((newModel.service || form.services[0].service) as ServiceId, newModel.model); setNewModel({ ...newModel, model: "" }); }}><Plus size={14} /> Add</button>
            </div>
          )}
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer", maxWidth: 720 }}>
          <input type="checkbox" checked={form.user_choice} onChange={(e) => set({ user_choice: e.target.checked })} style={{ width: 16, height: 16, minHeight: 0, marginTop: 2 }} />
          <span>
            People can pick their own model from this list
            <span style={{ ...hint, display: "block", fontWeight: 400 }}>They choose in the assistant (web and app). Theirs answers first; if it fails, the list above takes over in order. Off: everyone uses the list's order.</span>
          </span>
        </label>

        <div style={field}>
          <span style={label}>Questions per person per day</span>
          <input type="number" min={1} max={1000} value={form.daily_limit} onChange={(e) => set({ daily_limit: e.target.value })} style={{ maxWidth: 120 }} />
        </div>

        <div style={field}>
          <div>
            <button type="button" style={small} onClick={() => void test()} disabled={busy !== "" || !form.models.length}>
              {busy === "test" ? <Loader2 size={14} className="spin" /> : null} Test connection
            </button>
          </div>
          <span style={hint}>Sends one tiny question to each model above (it counts towards that service's quota) and shows which ones work right now.</span>
          {results && (
            <div style={{ display: "grid", gap: 4 }}>
              {results.map((r) => (
                <div key={`${r.service}:${r.model}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, flexWrap: "wrap" }}>
                  {r.ok ? <CheckCircle2 size={15} color="#059669" /> : <XCircle size={15} color="#dc2626" />}
                  <span style={serviceTag}>{SERVICES[r.service].label}</span>
                  <code>{r.model}</code>
                  <span style={{ color: r.ok ? "var(--muted)" : "#dc2626" }}>{r.ok ? `Working (${(r.ms / 1000).toFixed(1)}s)` : r.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ ...hint, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          Saved changes reach every server within 15 seconds - no restart, nobody is logged out.
          Free tiers may use what's sent to improve the provider's products, so use a paid plan (or Ollama on our own server) before relying on it with real company data.
        </div>
      </div>
    </div>
  );
}
