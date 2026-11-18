import { useEffect, useMemo, useState } from "react";
import { cApi, type Field, type FixedStep, type Person, type RequestType, type TypeDetail } from "./api";
import { personLabel, usePeople } from "./shared";
import { go, href } from "../router";
import { currentUser } from "../api";

// A Change Request is born as a shared draft its owners and co-writers work
// on together in the portal; tables (Attendance Register) and file uploads
// need the portal's bigger screen too.
const PORTAL_ONLY_CODES = new Set(["CHANGE_REQUEST"]);
const PHONE_FIELD_TYPES = new Set(["text", "number", "date", "select", "textarea", "checkbox", "user", "user_multi", "section"]);

function portalOnlyReason(t: RequestType, fields?: Field[]): string | null {
  if (PORTAL_ONLY_CODES.has(t.code)) return "A Change Request starts as a draft that its owners and co-writers work on together - start it in the FlowDesk portal. You can approve it and follow it here.";
  const blocker = fields?.find((f) => f.filled_at_step == null && !PHONE_FIELD_TYPES.has(f.field_type) && f.is_required);
  if (blocker) return `"${blocker.field_label}" can only be filled in on the FlowDesk portal, so start this one there.`;
  return null;
}

/** Search-as-you-type person picker (the directory is too long for a plain select). */
function PersonPicker({ people, value, onChange, filter, placeholder }: {
  people: Person[]; value: string | null; onChange: (id: string | null) => void; filter?: (p: Person) => boolean; placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const pool = useMemo(() => (filter ? people.filter(filter) : people), [people, filter]);
  const picked = value ? people.find((p) => p.id === value) : null;
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return pool.filter((p) => `${p.full_name || ""} ${p.email} ${p.title || ""} ${p.department || ""}`.toLowerCase().includes(s)).slice(0, 8);
  }, [q, pool]);

  if (picked) {
    return (
      <div className="row gap-sm">
        <span className="grow">{personLabel(picked)}</span>
        <button type="button" className="link-btn" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder || "Type a name…"} />
      {matches.length > 0 && (
        <ul className="list">
          {matches.map((p) => (
            <li key={p.id}>
              <button type="button" className="row-link plain" onClick={() => { onChange(p.id); setQ(""); }}>
                <span className="grow small">{personLabel(p)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim() && !matches.length && <span className="muted small">No one matches.</span>}
      {!q.trim() && filter && <span className="muted small">{pool.length} people can be picked here.</span>}
    </div>
  );
}

function TypePicker() {
  const [types, setTypes] = useState<RequestType[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    cApi.types()
      .then((all) => setTypes(all.filter((t) => t.status === "ACTIVE" && !t.is_internal)))
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!types) return <p className="muted center">Loading…</p>;
  if (!types.length) return <p className="muted center">There are no processes you can start.</p>;
  return (
    <div className="stack">
      <h1>New request</h1>
      <ul className="list">
        {types.map((t) => (
          <li key={t.id}>
            <a className="row-link" href={href({ name: "cnew", typeId: t.id })}>
              <span className="grow">
                <strong>{t.name}</strong>
                {t.description && <span className="muted small">{t.description}</span>}
                {PORTAL_ONLY_CODES.has(t.code) && <span className="muted small">Start it in the portal</span>}
              </span>
              <span className="chev" aria-hidden="true">›</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ChainPick = { approver_id: string | null; position_name: string };

export default function CustomNew({ typeId }: { typeId?: string }) {
  if (!typeId) return <TypePicker />;
  return <TypeForm key={typeId} typeId={typeId} />;
}

function TypeForm({ typeId }: { typeId: string }) {
  const me = currentUser();
  const people = usePeople();
  const [type, setType] = useState<TypeDetail | null>(null);
  const [fixed, setFixed] = useState<FixedStep[] | null>(null);
  const [manager, setManager] = useState<{ id: string; full_name: string | null; email: string } | null | undefined>(undefined);
  const [values, setValues] = useState<Record<string, any>>({});
  const [chain, setChain] = useState<ChainPick[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The type list carries the fixed approval route; the detail carries the fields.
    Promise.all([cApi.type(typeId), cApi.types(), cApi.myManager().catch(() => null)])
      .then(([detail, all, mgr]) => {
        const summary = all.find((t) => t.id === typeId);
        const fixedChain = (detail.fixed_approval_chain || summary?.fixed_approval_chain || null) as FixedStep[] | null;
        setType({ ...detail, fixed_approval_chain: fixedChain });
        setFixed(fixedChain?.length ? fixedChain : null);
        setManager(mgr);
        setChain(fixedChain?.length
          ? fixedChain.map((s) => ({ approver_id: s.source === "AUTO_MANAGER" ? mgr?.id ?? null : s.default_approver_id ?? null, position_name: s.title }))
          : [{ approver_id: mgr?.id ?? null, position_name: mgr ? "Manager" : "" }]);
      })
      .catch((e) => setError(e.message));
  }, [typeId]);

  const formFields = useMemo(
    () => (type?.fields || []).filter((f) => f.filled_at_step == null).sort((a, b) => (a.wizard_step || 1) - (b.wizard_step || 1) || a.sort_order - b.sort_order),
    [type]
  );

  if (error && !type) return <p className="error">{error}</p>;
  if (!type || !people || manager === undefined) return <p className="muted center">Loading…</p>;

  const blocked = portalOnlyReason(type, type.fields);
  if (blocked) {
    return (
      <div className="stack">
        <h1>{type.name}</h1>
        <p className="banner">{blocked}</p>
      </div>
    );
  }

  const set = (key: string, v: any) => setValues((cur) => ({ ...cur, [key]: v }));
  const setStep = (i: number, patch: Partial<ChainPick>) => setChain((c) => c.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const rolesOf = (s: FixedStep) => (s.roles?.length ? s.roles : s.role ? [s.role] : []).map((r) => r.toUpperCase());

  async function submit() {
    for (const f of formFields) {
      if (!f.is_required || f.field_type === "section") continue;
      const v = values[f.field_key];
      const empty = f.field_type === "user_multi" ? !Array.isArray(v) || !v.length : f.field_type === "checkbox" ? false : v === undefined || v === null || String(v).trim() === "";
      if (empty) return setError(`"${f.field_label}" is required.`);
    }
    const route = fixed
      ? chain.map((s, i) => ({ approver_id: s.approver_id, position_name: fixed[i].title, decision_type: "APPROVE" as const }))
      : chain.filter((s) => s.approver_id && s.position_name.trim()).map((s) => ({ approver_id: s.approver_id, position_name: s.position_name.trim(), decision_type: "APPROVE" as const }));
    if (fixed) {
      const missing = fixed.findIndex((s, i) => !chain[i]?.approver_id && !(s.source === "AUTO_MANAGER" && manager));
      if (missing >= 0) return setError(`Pick who approves as "${fixed[missing].title}".`);
    } else if (!route.length) {
      return setError("Add at least one approver, with their title.");
    }
    if (route.some((s) => s.approver_id === me?.userId)) return setError("You can't approve your own request - pick someone else.");

    // "user" fields keep a readable snapshot (as the portal does); "user_multi" sends ids for the server to resolve.
    const data: Record<string, any> = {};
    for (const f of formFields) {
      const v = values[f.field_key];
      if (v === undefined || f.field_type === "section") continue;
      if (f.field_type === "user") {
        const p = people!.find((x) => x.id === v);
        data[f.field_key] = p ? personLabel(p) : v;
      } else if (f.field_type === "user_multi") {
        data[f.field_key] = (v as string[]).map((id) => ({ id }));
      } else if (f.field_type === "number") {
        data[f.field_key] = v === "" ? null : Number(v);
      } else {
        data[f.field_key] = typeof v === "string" ? v.trim() : v;
      }
    }

    setBusy(true);
    setError("");
    try {
      const res = await cApi.submit({ request_type_id: type!.id, data, approval_chain: route });
      if (res?.id) go({ name: "creq", id: res.id }, true);
      else go({ name: "clist" }, true);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>{type.name}</h1>
      {type.description && <p className="muted small">{type.description}</p>}

      <section className="card stack">
        {formFields.map((f) => {
          if (f.field_type === "section") return <h3 key={f.field_key}>{f.field_label}</h3>;
          if (!PHONE_FIELD_TYPES.has(f.field_type)) return null; // optional portal-only field
          const label = `${f.field_label}${f.is_required ? " *" : ""}`;
          const v = values[f.field_key];
          switch (f.field_type) {
            case "textarea":
              return <label key={f.field_key} className="field"><span>{label}</span><textarea rows={4} value={v ?? ""} placeholder={f.placeholder || ""} onChange={(e) => set(f.field_key, e.target.value)} /></label>;
            case "number":
              return <label key={f.field_key} className="field"><span>{label}</span><input type="number" inputMode="decimal" value={v ?? ""} placeholder={f.placeholder || ""} onChange={(e) => set(f.field_key, e.target.value)} /></label>;
            case "date":
              return <label key={f.field_key} className="field"><span>{label}</span><input type="date" value={v ?? ""} onChange={(e) => set(f.field_key, e.target.value)} /></label>;
            case "select": {
              const opts = Array.isArray(f.options) ? f.options : [];
              return (
                <label key={f.field_key} className="field">
                  <span>{label}</span>
                  <select value={v ?? ""} onChange={(e) => set(f.field_key, e.target.value)}>
                    <option value="">Choose…</option>
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
              );
            }
            case "checkbox":
              return (
                <label key={f.field_key} className="consent">
                  <input type="checkbox" checked={Boolean(v)} onChange={(e) => set(f.field_key, e.target.checked)} />
                  <span>{f.field_label}</span>
                </label>
              );
            case "user":
              return (
                <div key={f.field_key} className="field">
                  <span>{label}</span>
                  <PersonPicker people={people!} value={v ?? null} onChange={(id) => set(f.field_key, id ?? undefined)} />
                </div>
              );
            case "user_multi": {
              const ids: string[] = Array.isArray(v) ? v : [];
              return (
                <div key={f.field_key} className="field">
                  <span>{label}</span>
                  {ids.map((id) => {
                    const p = people!.find((x) => x.id === id);
                    return (
                      <div key={id} className="row gap-sm">
                        <span className="grow small">{p ? personLabel(p) : id}</span>
                        <button type="button" className="link-btn" onClick={() => set(f.field_key, ids.filter((x) => x !== id))}>Remove</button>
                      </div>
                    );
                  })}
                  <PersonPicker people={people!} value={null} filter={(p) => !ids.includes(p.id)} placeholder="Add someone…"
                    onChange={(id) => id && set(f.field_key, [...ids, id])} />
                </div>
              );
            }
            default:
              return <label key={f.field_key} className="field"><span>{label}</span><input value={v ?? ""} placeholder={f.placeholder || ""} onChange={(e) => set(f.field_key, e.target.value)} /></label>;
          }
        })}
      </section>

      <section className="card stack">
        <h3>Who approves it</h3>
        {fixed ? (
          fixed.map((s, i) => (
            <div key={i} className="field">
              <span>{i + 1}. {s.title}</span>
              {s.source === "AUTO_MANAGER" && manager ? (
                <span className="small">{manager.full_name || manager.email} <span className="muted">(your manager)</span></span>
              ) : (
                <>
                  {s.source === "AUTO_MANAGER" && <span className="muted small">No manager is set up for you - pick who approves for them.</span>}
                  <PersonPicker people={people} value={chain[i]?.approver_id ?? null} onChange={(id) => setStep(i, { approver_id: id })}
                    filter={rolesOf(s).length ? (p) => rolesOf(s).includes(String(p.role).toUpperCase()) && p.id !== me?.userId : (p) => p.id !== me?.userId} />
                </>
              )}
            </div>
          ))
        ) : (
          <>
            {chain.map((s, i) => (
              <div key={i} className="stack-sm">
                <div className="row gap-sm">
                  <strong className="grow small">Step {i + 1}</strong>
                  {chain.length > 1 && <button type="button" className="link-btn" onClick={() => setChain((c) => c.filter((_, j) => j !== i))}>Remove</button>}
                </div>
                <input value={s.position_name} placeholder="Their title, e.g. Manager" onChange={(e) => setStep(i, { position_name: e.target.value })} />
                <PersonPicker people={people} value={s.approver_id} onChange={(id) => setStep(i, { approver_id: id })} filter={(p) => p.id !== me?.userId} />
              </div>
            ))}
            <button type="button" className="secondary" onClick={() => setChain((c) => [...c, { approver_id: null, position_name: "" }])}>Add another approver</button>
          </>
        )}
      </section>

      {error && <p className="error">{error}</p>}
      <div className="sticky-actions">
        <button type="button" className="primary" onClick={submit} disabled={busy}>{busy ? "Sending…" : "Send for approval"}</button>
      </div>
    </div>
  );
}
