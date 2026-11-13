import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { sendJson } from "../shared/Coediting";

// Admin: SMS notifications - the gateway, on/off, a test SMS, and how many
// people have a phone number to receive them.
export default function SmsSettingsCard() {
  const [s, setS] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await sendJson("GET", "/sms/settings");
    if (r.ok) { setS(r.data); setForm({ ...r.data, password: "" }); } else setMsg(r.data?.error || "Couldn't load the SMS settings.");
  };
  useEffect(() => { void load(); }, []);

  async function save(patch?: Record<string, unknown>) {
    setBusy(true); setMsg(null);
    const body = patch ?? { enabled: form.enabled, notify: form.notify, url: form.url, sender: form.sender, username: form.username, password: form.password };
    const r = await sendJson("PUT", "/sms/settings", body);
    setBusy(false);
    if (!r.ok) { setMsg(r.data?.error || "Couldn't save."); return; }
    setMsg("Saved.");
    await load();
  }
  async function test() {
    setBusy(true); setMsg(null);
    const r = await sendJson("POST", "/sms/test", { msisdn: testTo });
    setBusy(false);
    setMsg(r.ok && r.data?.ok ? `Test SMS sent to ${testTo}.` : `Test failed: ${r.data?.response || r.data?.error || "unknown error"}`);
    void load();
  }

  if (!s || !form) return <div style={{ padding: 12, color: "var(--muted)" }}>{msg || "Loading…"}</div>;
  const st = s.stats || {};
  const field = { font: "inherit", fontSize: 14, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--text)", width: "100%", boxSizing: "border-box" as const };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {[["Active people", st.active_users], ["With a phone number", st.with_phone], ["Valid mobile numbers", st.valid_phone], ["SMS sent (24h)", st.sent_24h], ["Failed (24h)", st.failed_24h]].map(([l, n]) => (
          <div key={String(l)} style={{ flex: "1 1 130px", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px" }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{n ?? "—"}</div><div style={{ fontSize: 12, color: "var(--muted)" }}>{l}</div>
          </div>
        ))}
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> SMS switched on (gateway in use)
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} /> Send every FlowDesk notification by SMS too (to people with a phone number)
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Gateway address<input style={field} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Sender name (max 11)<input style={field} maxLength={11} value={form.sender} onChange={(e) => setForm({ ...form, sender: e.target.value })} /></label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Gateway user<input style={field} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Gateway password<input style={field} type="password" value={form.password} placeholder={s.has_password ? "Saved - leave blank to keep" : ""} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="ep-btn" disabled={busy} onClick={() => void save()}>Save SMS settings</button>
        <input style={{ ...field, width: 170 }} type="tel" placeholder="Test to e.g. 62227247" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
        <button type="button" className="ep-btn-outline" disabled={busy || !testTo.trim()} onClick={() => void test()}><MessageSquare size={14} /> Send a test SMS</button>
      </div>
      {msg && <div style={{ fontSize: 13, color: /fail|couldn't/i.test(msg) ? "#b91c1c" : "#166534" }}>{msg}</div>}
      {Array.isArray(st.last) && st.last.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Last SMS sent</summary>
          <div style={{ display: "grid", gap: 4, marginTop: 6, fontSize: 12 }}>
            {st.last.map((x: any, i: number) => (
              <div key={i} style={{ color: x.ok ? "var(--text)" : "#b91c1c" }}>
                {new Date(x.created_at).toLocaleString()} · {x.msisdn} · {x.kind} · {x.ok ? "sent" : `failed (${x.response})`} - "{x.msg}"
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
