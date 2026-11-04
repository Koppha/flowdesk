import { useEffect, useState, type CSSProperties } from "react";
import { API, api, getToken } from "./api";
import { BarChart3, Bell, ChevronDown, ChevronUp, GripVertical, Home, Inbox, LayoutGrid, MessageCircle, PanelBottom, Smartphone, User } from "lucide-react";

type ModuleKey = "advances" | "clearances" | "createAdvance" | "createClearance" | "overtime" | "standby" | "customProcesses" | "signADocument" | "maintenance" | "myTeam";
type Modules = Record<ModuleKey, boolean>;
type TabBarKey = "home" | "inbox" | "profile";
type TabBarItem = { key: TabBarKey; enabled: boolean };
type Tab = "modules" | "tabbar" | "branding" | "push" | "support" | "distribution" | "analytics";

type Analytics = {
  totalDownloads: number;
  totalLogins: number;
  uniqueLoginUsers: number;
  // Added with app 1.0.7 (opens/unlocks are tracked) - optional so an older
  // backend's response still renders.
  active?: { today: number; last7Days: number; last30Days: number };
  pushEnabledUsers?: number;
  onlineNow?: { userId: string; fullName: string | null; lastSeen: string }[];
  onlineWindowMinutes?: number;
  requestsToday?: number;
  devices?: { model: string; brand: string | null; os: string | null; users: number }[];
  daily?: { day: string; users: number }[];
  versions?: { version: string; users: number }[];
  users?: {
    userId: string; fullName: string | null; department: string | null; firstSeen: string; lastActive: string;
    logins: number; opens: number; version: string | null; push: boolean;
    requests30d?: number; requestsTotal?: number; online?: boolean; device?: string | null;
  }[];
  recentDownloads: { createdAt: string; fullName: string | null; version: string | null }[];
  recentLogins: { createdAt: string; fullName: string | null }[];
};

const statCard: CSSProperties = { flex: "1 1 120px", border: "1px solid var(--border)", borderRadius: 10, padding: 14 };
const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 };
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function Stat({ value, label, hint }: { value: number | string; label: string; hint?: string }) {
  return (
    <div style={statCard} title={hint}>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

// Active people per day, last 30 days - plain bars, no chart library.
function DailyBars({ daily }: { daily: { day: string; users: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.users));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 90, padding: "0 2px", borderBottom: "1px solid var(--border)" }}>
        {daily.map((d) => (
          <div key={d.day} title={`${shortDate(d.day)}: ${d.users} ${d.users === 1 ? "person" : "people"}`}
            style={{ flex: 1, height: `${Math.max((d.users / max) * 100, d.users ? 6 : 1)}%`, background: d.users ? "var(--accent, #283889)" : "var(--border)", borderRadius: "3px 3px 0 0" }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>
        <span>{daily[0] ? shortDate(daily[0].day) : ""}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

const TAB_BAR_META: Record<TabBarKey, { label: string; icon: typeof Home }> = {
  home: { label: "Home", icon: Home },
  inbox: { label: "Inbox", icon: Inbox },
  profile: { label: "Profile", icon: User }
};
const DEFAULT_TABS: TabBarItem[] = [
  { key: "home", enabled: true },
  { key: "inbox", enabled: true },
  { key: "profile", enabled: true }
];

const MODULES: { key: ModuleKey; label: string; color: string; bg: string }[] = [
  { key: "advances", label: "Advances", color: "#c8102e", bg: "#fdecec" },
  { key: "clearances", label: "Clearances", color: "#0f9d58", bg: "#e8f8ee" },
  { key: "overtime", label: "Overtime", color: "#b45309", bg: "#fef3e2" },
  { key: "standby", label: "Standby", color: "#0369a1", bg: "#e0f2fe" },
  { key: "customProcesses", label: "Custom Processes", color: "#7c3aed", bg: "#ede9fe" },
  { key: "signADocument", label: "Sign a Document", color: "#c8102e", bg: "#fdecec" },
  { key: "maintenance", label: "Maintenance", color: "#b45309", bg: "#fef3e2" },
  // Shown only to managers (MANAGER, HOD, EXCO, CEO, ADMIN); staff never see it.
  { key: "myTeam", label: "My Team (managers only)", color: "#0369a1", bg: "#e0f2fe" }
];

const DEFAULTS: Modules = {
  advances: true,
  clearances: true,
  createAdvance: false,
  createClearance: false,
  overtime: false,
  standby: false,
  customProcesses: false,
  signADocument: false,
  maintenance: false,
  myTeam: false
};

// Not Home tiles (so they stay out of MODULES and the phone preview) - they
// show a "New" button on the app's My Advance Requests / My Clearances lists.
const CREATE_TOGGLES: { key: ModuleKey; label: string; hint: string }[] = [
  { key: "createAdvance", label: "Create advance requests", hint: "New button on My Advance Requests" },
  { key: "createClearance", label: "Create clearances", hint: "New button on My Clearances, with receipt upload" }
];

const TABS: { key: Tab; label: string; icon: typeof LayoutGrid }[] = [
  { key: "modules", label: "Modules", icon: LayoutGrid },
  { key: "tabbar", label: "Tab Bar", icon: PanelBottom },
  { key: "branding", label: "Branding", icon: Smartphone },
  { key: "push", label: "Push Notifications", icon: Bell },
  { key: "distribution", label: "Distribution", icon: Smartphone },
  { key: "support", label: "Help & Support", icon: MessageCircle },
  { key: "analytics", label: "Analytics", icon: BarChart3 }
];

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      style={{
        width: 44,
        height: 24,
        borderRadius: 999,
        border: "none",
        background: checked ? "#0f9d58" : "#d7dbe3",
        position: "relative",
        flex: "none",
        padding: 0,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 22 : 2,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,.25)",
          transition: "left .15s ease"
        }}
      />
    </button>
  );
}

// Calls for screens this file owns, kept here rather than in api.ts.
async function adminReq<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || res.statusText);
  return json as T;
}

type PhoneCampaign = { enabled: boolean; testMode: boolean; missingPhone: number; reachable: number; reached: number; completed: number; pushesSent: number };

// "Add your phone number" push campaign (backend lib/phoneCampaign.ts).
function PhoneCampaignCard() {
  const [c, setC] = useState<PhoneCampaign | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => adminReq<PhoneCampaign>("/mobile-app/campaigns/phone").then(setC).catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  async function change(patch: Partial<Pick<PhoneCampaign, "enabled" | "testMode">>) {
    setBusy(true);
    setError("");
    try {
      setC(await adminReq<PhoneCampaign>("/mobile-app/campaigns/phone", { method: "PUT", body: JSON.stringify(patch) }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Campaign: add your phone number</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            Pushes people with no phone on their profile; tapping opens the app's phone screen. Repeats until they add one, then stops. Needs app 1.0.8+.
          </div>
        </div>
        {c && <Toggle checked={c.enabled} disabled={busy} onChange={() => change({ enabled: !c.enabled })} />}
      </div>
      {c && (
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {[
              { test: true, label: "Testing - every 5 minutes" },
              { test: false, label: "Live - every 7-14 days (random per person)" }
            ].map((m) => (
              <button key={String(m.test)} type="button" disabled={busy || c.testMode === m.test} onClick={() => change({ testMode: m.test })}
                style={{ padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: c.testMode === m.test ? "default" : "pointer",
                  border: `1px solid ${c.testMode === m.test ? "#c8102e" : "var(--border)"}`, background: c.testMode === m.test ? "#fdecec" : "transparent", color: c.testMode === m.test ? "#c8102e" : "inherit" }}>
                {m.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 14, fontSize: 12.5, flexWrap: "wrap" }}>
            <span><b>{c.missingPhone}</b> without a phone</span>
            <span><b>{c.reachable}</b> reachable now</span>
            <span><b>{c.reached}</b> pushed ({c.pushesSent} pushes)</span>
            <span><b>{c.completed}</b> added their phone</span>
          </div>
        </>
      )}
      {error && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 8 }}>{error}</div>}
    </div>
  );
}

type SupportAgent = { user_id: string; full_name: string | null; email: string; department: string | null };
type SupportConv = { id: string; status: string; last_message_at: string; full_name: string | null; department: string | null; last_body: string | null; last_from_agent: boolean | null };
type SupportMsg = { id: string; body: string; from_agent: boolean; created_at: string; sender_name: string | null };

// Help & Support (backend modules/support at /mobile-app/support): who
// answers, and an inbox to answer from the desk.
function SupportAdmin() {
  const [agents, setAgents] = useState<SupportAgent[]>([]);
  const [email, setEmail] = useState("");
  const [convs, setConvs] = useState<SupportConv[]>([]);
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [open, setOpen] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<SupportMsg[]>([]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");

  const loadAgents = () => adminReq<SupportAgent[]>("/mobile-app/support/agents").then(setAgents).catch((e) => setError(e.message));
  const loadConvs = () => adminReq<SupportConv[]>(`/mobile-app/support/conversations?status=${status}`).then(setConvs).catch((e) => setError(e.message));
  const loadMsgs = (id: string) => adminReq<{ messages: SupportMsg[] }>(`/mobile-app/support/conversations/${id}`).then((r) => setMsgs(r.messages)).catch((e) => setError(e.message));

  useEffect(() => {
    void loadAgents();
  }, []);
  // Refresh the inbox (and the open chat) every 10 seconds.
  useEffect(() => {
    void loadConvs();
    const t = setInterval(() => {
      void loadConvs();
      if (open) void loadMsgs(open);
    }, 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, open]);

  async function addAgent() {
    setError("");
    try {
      await adminReq("/mobile-app/support/agents", { method: "POST", body: JSON.stringify({ email }) });
      setEmail("");
      await loadAgents();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function send() {
    if (!open || !reply.trim()) return;
    try {
      const r = await adminReq<{ messages: SupportMsg[] }>(`/mobile-app/support/conversations/${open}/messages`, { method: "POST", body: JSON.stringify({ body: reply.trim() }) });
      setMsgs(r.messages);
      setReply("");
      void loadConvs();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const box: CSSProperties = { border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" };
  const input: CSSProperties = { flex: 1, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 13, background: "var(--surface-soft)", color: "var(--text)" };
  const primaryBtn: CSSProperties = { padding: "7px 14px", border: "none", borderRadius: 7, background: "#c8102e", color: "#fff", fontWeight: 700, cursor: "pointer" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div style={sectionLabel}>Support team (besides admins)</div>
        <div style={box}>
          {agents.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: "var(--muted)" }}>Only admins for now.</div>}
          {agents.map((a, i) => (
            <div key={a.user_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : undefined, fontSize: 13 }}>
              <span style={{ flex: 1 }}>
                {a.full_name || a.email} <span style={{ color: "var(--muted)", fontSize: 11.5 }}>{a.department || a.email}</span>
              </span>
              <button
                type="button"
                onClick={async () => {
                  await adminReq(`/mobile-app/support/agents/${a.user_id}`, { method: "DELETE" });
                  void loadAgents();
                }}
                style={{ border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", borderRadius: 6, padding: "3px 9px", fontSize: 12, cursor: "pointer" }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Add by FlowDesk email" style={input} />
          <button type="button" onClick={addAgent} disabled={!email.trim()} style={primaryBtn}>Add</button>
        </div>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ ...sectionLabel, marginBottom: 0, flex: 1 }}>Support inbox</div>
          {(["open", "closed"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setStatus(s);
                setOpen(null);
              }}
              style={{ padding: "3px 10px", borderRadius: 999, fontSize: 12, cursor: "pointer", border: `1px solid ${status === s ? "#c8102e" : "var(--border)"}`, background: status === s ? "#fdecec" : "transparent", color: status === s ? "#c8102e" : "inherit" }}
            >
              {s === "open" ? "Open" : "Closed"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ ...box, flex: "1 1 220px", maxHeight: 380, overflow: "auto" }}>
            {convs.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: "var(--muted)" }}>No {status} conversations.</div>}
            {convs.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setOpen(c.id);
                  void loadMsgs(c.id);
                }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none", borderTop: i ? "1px solid var(--border)" : undefined, background: open === c.id ? "var(--panel-2, #f1f2f5)" : "transparent", cursor: "pointer", color: "inherit" }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {c.full_name || "Staff member"}
                  {c.status === "OPEN" && c.last_from_agent === false ? " • waiting" : ""}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.last_from_agent ? "You: " : ""}
                  {c.last_body}
                </div>
              </button>
            ))}
          </div>
          <div style={{ ...box, flex: "2 1 320px", display: "flex", flexDirection: "column", minHeight: 260 }}>
            {!open ? (
              <div style={{ padding: 12, fontSize: 12.5, color: "var(--muted)" }}>Pick a conversation.</div>
            ) : (
              <>
                <div style={{ flex: 1, overflow: "auto", maxHeight: 300, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  {msgs.map((m) => (
                    <div
                      key={m.id}
                      style={{ alignSelf: m.from_agent ? "flex-end" : "flex-start", maxWidth: "80%", background: m.from_agent ? "#c8102e" : "var(--panel-2, #f1f2f5)", color: m.from_agent ? "#fff" : "inherit", borderRadius: 10, padding: "6px 10px", fontSize: 13, whiteSpace: "pre-wrap" }}
                    >
                      {!m.from_agent && <div style={{ fontSize: 10.5, fontWeight: 700, opacity: 0.7 }}>{m.sender_name}</div>}
                      {m.body}
                      <div style={{ fontSize: 10, opacity: 0.7, textAlign: "right" }}>{new Date(m.created_at).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, padding: 8, borderTop: "1px solid var(--border)" }}>
                  <input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void send();
                    }}
                    placeholder="Reply"
                    style={input}
                  />
                  <button type="button" onClick={send} style={primaryBtn}>Send</button>
                  <button
                    type="button"
                    onClick={async () => {
                      await adminReq(`/mobile-app/support/conversations/${open}/close`, { method: "POST" });
                      setOpen(null);
                      void loadConvs();
                    }}
                    style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "transparent", cursor: "pointer", color: "inherit", fontSize: 12 }}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: "#dc2626" }}>{error}</div>}
    </div>
  );
}

function ComingSoon() {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", background: "var(--panel-2, #f1f2f5)", padding: "2px 8px", borderRadius: 999 }}>
      COMING SOON
    </span>
  );
}

// Which module tiles FlowDesk Mobile's Home screen shows - see
// mobile/src/app/(tabs)/index.tsx, which reads GET /admin/mobile-config on
// load and filters its tile grid by this. Only the Modules tab is actually
// wired to a persisted setting; Branding and Push Notifications are laid
// out to match the design mockup but aren't backed by real settings/
// delivery yet (marked "Coming soon" rather than pretending they do
// something) - Distribution is reference information only, same as the
// mockup it's modeled on.
export default function MobileAppConfig({ isAdmin }: { isAdmin?: boolean }) {
  const [tab, setTab] = useState<Tab>("modules");
  const [modules, setModules] = useState<Modules>(DEFAULTS);
  const [savedModules, setSavedModules] = useState<Modules>(DEFAULTS);
  const [tabsConfig, setTabsConfig] = useState<TabBarItem[]>(DEFAULT_TABS);
  const [savedTabsConfig, setSavedTabsConfig] = useState<TabBarItem[]>(DEFAULT_TABS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [androidBuild, setAndroidBuild] = useState<{ version: string; uploadedAt: string } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  useEffect(() => {
    if (isAdmin) {
      api.mobileAppAnalytics().then((r: any) => setAnalytics(r)).catch(() => {});
    }
  }, [isAdmin]);

  useEffect(() => {
    api.mobileAppConfig()
      .then((r: any) => {
        const m = { ...DEFAULTS, ...(r?.modules || {}) };
        setModules(m);
        setSavedModules(m);
        const t = Array.isArray(r?.tabs) && r.tabs.length ? r.tabs : DEFAULT_TABS;
        setTabsConfig(t);
        setSavedTabsConfig(t);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    api.latestMobileAppBuild().then((r: any) => setAndroidBuild(r?.build || null)).catch(() => {});
  }, []);

  function toggle(key: ModuleKey) {
    if (!isAdmin) return;
    setModules((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function toggleTab(key: TabBarKey) {
    if (!isAdmin) return;
    setTabsConfig((prev) => prev.map((t) => (t.key === key ? { ...t, enabled: !t.enabled } : t)));
  }

  function moveTab(index: number, dir: -1 | 1) {
    if (!isAdmin) return;
    setTabsConfig((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const r = await api.updateMobileAppConfig(modules, tabsConfig);
      const m = { ...DEFAULTS, ...(r?.modules || {}) };
      setModules(m);
      setSavedModules(m);
      const t = Array.isArray(r?.tabs) && r.tabs.length ? r.tabs : tabsConfig;
      setTabsConfig(t);
      setSavedTabsConfig(t);
    } catch (e: any) {
      alert("Error saving mobile app configuration: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  const dirty =
    JSON.stringify(modules) !== JSON.stringify(savedModules) ||
    JSON.stringify(tabsConfig) !== JSON.stringify(savedTabsConfig);
  const enabled = MODULES.filter((m) => modules[m.key]);

  return (
    <div className="ep-panel" style={{ marginBottom: 20, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: "linear-gradient(135deg,#c8102e,#8f0c1f)" }} />
          <span style={{ fontSize: 16, fontWeight: 700 }}>Mobile App Configuration</span>
          {dirty && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fef3e2", padding: "3px 9px", borderRadius: 999 }}>
              UNSAVED CHANGES
            </span>
          )}
        </div>
        {isAdmin && (
          <button
            onClick={save}
            disabled={saving || !dirty}
            style={{
              padding: "9px 18px",
              border: "none",
              borderRadius: 9,
              background: "#c8102e",
              color: "#fff",
              cursor: saving || !dirty ? "default" : "pointer",
              fontSize: 13,
              fontWeight: 700,
              opacity: saving || !dirty ? 0.55 : 1
            }}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap" }}>
        <div style={{ width: 200, flex: "none", borderRight: "1px solid var(--border)", padding: "14px 0" }}>
          {TABS.map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  border: "none",
                  background: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 18px",
                  borderLeft: active ? "3px solid #c8102e" : "3px solid transparent",
                  cursor: "pointer",
                  textAlign: "left"
                }}
              >
                <Icon size={15} color={active ? "#c8102e" : "var(--muted)"} />
                <span style={{ fontSize: 13, color: active ? "#c8102e" : "var(--muted)", fontWeight: active ? 700 : 500 }}>{t.label}</span>
              </button>
            );
          })}
        </div>

        <div style={{ flex: "1 1 380px", minWidth: 320, padding: "22px 26px" }}>
          {tab === "modules" && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Home screen modules</div>
              <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
                Only enabled modules appear as tiles on the app&apos;s Home screen — the preview updates live.
              </p>
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {MODULES.map((m, i) => (
                  <div
                    key={m.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      borderTop: i > 0 ? "1px solid var(--border)" : undefined
                    }}
                  >
                    <GripVertical size={14} color="#c3c9d4" />
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: m.bg, flex: "none" }} />
                    <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{m.label}</span>
                    <Toggle checked={modules[m.key]} disabled={!isAdmin} onChange={() => toggle(m.key)} />
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 15, fontWeight: 700, margin: "22px 0 4px" }}>Creating requests</div>
              <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
                Let staff submit new requests from the app. When off, they can still view and approve.
              </p>
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {CREATE_TOGGLES.map((c, i) => (
                  <div
                    key={c.key}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: i > 0 ? "1px solid var(--border)" : undefined }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.label}</div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>{c.hint}</div>
                    </div>
                    <Toggle checked={modules[c.key]} disabled={!isAdmin} onChange={() => toggle(c.key)} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "tabbar" && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Bottom tab bar</div>
              <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
                Which tabs show at the bottom of the app, and in what order. At least one must stay visible.
              </p>
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {tabsConfig.map((t, i) => {
                  const meta = TAB_BAR_META[t.key];
                  const Icon = meta.icon;
                  return (
                    <div
                      key={t.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 16px",
                        borderTop: i > 0 ? "1px solid var(--border)" : undefined
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <button
                          onClick={() => moveTab(i, -1)}
                          disabled={!isAdmin || i === 0}
                          style={{ border: "none", background: "none", padding: 0, cursor: !isAdmin || i === 0 ? "default" : "pointer", opacity: !isAdmin || i === 0 ? 0.3 : 1 }}
                        >
                          <ChevronUp size={14} color="var(--muted)" />
                        </button>
                        <button
                          onClick={() => moveTab(i, 1)}
                          disabled={!isAdmin || i === tabsConfig.length - 1}
                          style={{ border: "none", background: "none", padding: 0, cursor: !isAdmin || i === tabsConfig.length - 1 ? "default" : "pointer", opacity: !isAdmin || i === tabsConfig.length - 1 ? 0.3 : 1 }}
                        >
                          <ChevronDown size={14} color="var(--muted)" />
                        </button>
                      </div>
                      <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--panel-2, #f1f2f5)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                        <Icon size={15} color="var(--ink, #161b2e)" />
                      </div>
                      <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{meta.label}</span>
                      <Toggle checked={t.enabled} disabled={!isAdmin} onChange={() => toggleTab(t.key)} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "branding" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>Branding</span>
                <ComingSoon />
              </div>
              <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
                Applies to the app icon badge, headers, and primary buttons across the app.
              </p>
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 10 }}>Accent color</div>
                <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: "#c8102e", border: "3px solid #161b2e", boxSizing: "border-box" }} />
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: "#0f9d58" }} />
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: "#0369a1" }} />
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: "#7c3aed" }} />
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 10 }}>App icon</div>
                <div style={{ width: 64, height: 64, borderRadius: 14, border: "1.5px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--muted)" }}>
                  Upload
                </div>
              </div>
            </div>
          )}

          {tab === "push" && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Push notifications</div>
              <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
                Phones register for push when people sign in to the app. FlowDesk pushes approvals (advances, clearances, documents to sign) and maintenance updates; people can switch push off in the app's Profile.
              </p>
              {isAdmin && <PhoneCampaignCard />}
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "22px 0 8px" }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Per-event switches</span>
                <ComingSoon />
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {["New item awaiting your approval", "Your request was approved or rejected", "SLA reminder — step overdue"].map((label, i) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: i > 0 ? "1px solid var(--border)" : undefined }}>
                    <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{label}</span>
                    <Toggle checked={i < 2} disabled onChange={() => {}} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "support" && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Help &amp; Support</div>
              <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
                Staff chat with the support team from the app (Profile → Help &amp; support). Admins are always on the team; add anyone else who should answer. They get a push for every new message and can answer here or in the app (Support inbox).
              </p>
              {isAdmin ? <SupportAdmin /> : <p style={{ fontSize: 13, color: "var(--muted)" }}>Only admins can manage support.</p>}
            </div>
          )}

          {tab === "distribution" && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Distribution</div>
              <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>Internal-only for now — no public app store listing.</p>
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>Android — direct APK, served from Get the App</span>
                  {androidBuild ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#0f9d58", background: "#e8f8ee", padding: "3px 9px", borderRadius: 999 }}>
                      LIVE · v{androidBuild.version}
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", background: "var(--panel-2, #f1f2f5)", padding: "3px 9px", borderRadius: 999 }}>NOT SET UP</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
                  <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>iOS — TestFlight (internal)</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", background: "var(--panel-2, #f1f2f5)", padding: "3px 9px", borderRadius: 999 }}>NOT SET UP</span>
                </div>
              </div>
              <div style={{ marginTop: 14, background: "#fef3e2", border: "1px solid #f3dfb5", borderRadius: 10, padding: "12px 16px", fontSize: 12, color: "#92400e" }}>
                Once EAS builds are wired up, saving Modules/Branding here can publish as an over-the-air update — no store review needed for JS/config changes. A native code change still needs a new build.
              </div>
            </div>
          )}

          {tab === "analytics" && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Analytics</div>
              <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)" }}>
                Who uses the mobile app: password sign-ins plus every open or unlock (fingerprint, face or PIN), counted once per person per 15 minutes. Web use is not included.
              </p>
              {!analytics ? (
                <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</p>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                    <Stat value={analytics.onlineNow?.length ?? "–"} label={`Online now (last ${analytics.onlineWindowMinutes ?? 5} min)`} hint={(analytics.onlineNow || []).map((o) => o.fullName || "Unknown").join(", ") || "Nobody right now"} />
                    <Stat value={analytics.requestsToday ?? "–"} label="App requests today" hint="Every call the app made to FlowDesk today" />
                  </div>
                  {analytics.onlineNow && analytics.onlineNow.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0 0 12px" }}>
                      {analytics.onlineNow.map((o) => (
                        <span key={o.userId} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--border)", borderRadius: 999, padding: "3px 10px", fontSize: 12 }}>
                          <span style={{ width: 7, height: 7, borderRadius: 999, background: "#0f9d58" }} />
                          {o.fullName || "Unknown"}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                    <Stat value={analytics.active?.today ?? "–"} label="Active today" hint="People who signed in, opened the app or used it today" />
                    <Stat value={analytics.active?.last7Days ?? "–"} label="Active, last 7 days" />
                    <Stat value={analytics.active?.last30Days ?? "–"} label="Active, last 30 days" />
                  </div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
                    <Stat value={analytics.uniqueLoginUsers} label="People signed in (ever)" hint={`${analytics.totalLogins} password sign-ins in total`} />
                    <Stat value={analytics.pushEnabledUsers ?? "–"} label="Push notifications on" hint="People with at least one phone registered for push" />
                    <Stat value={analytics.totalDownloads} label="Downloads" hint="From Get the App" />
                  </div>

                  {analytics.daily && (
                    <div style={{ marginBottom: 18 }}>
                      <div style={sectionLabel}>Active people per day · last 30 days</div>
                      <DailyBars daily={analytics.daily} />
                    </div>
                  )}

                  {analytics.versions && analytics.versions.length > 0 && (
                    <div style={{ marginBottom: 18 }}>
                      <div style={sectionLabel}>App versions in use</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {analytics.versions.map((v) => (
                          <span key={v.version} style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "4px 10px", fontSize: 12 }}>
                            {v.version.startsWith("Older") ? v.version : `v${v.version}`} · <b>{v.users}</b>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {analytics.devices && analytics.devices.length > 0 && (
                    <div style={{ marginBottom: 18 }}>
                      <div style={sectionLabel}>Devices in use</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {analytics.devices.map((d) => (
                          <span key={(d.brand || "") + d.model} style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "4px 10px", fontSize: 12 }}>
                            {[d.brand, d.model].filter(Boolean).join(" ")}{d.os ? <span style={{ color: "var(--muted)" }}> · {d.os}</span> : null} · <b>{d.users}</b>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {analytics.users && (
                    <div style={{ marginBottom: 18 }}>
                      <div style={sectionLabel}>People using the app ({analytics.users.length})</div>
                      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "auto", maxHeight: 360 }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                          <thead>
                            <tr style={{ textAlign: "left", color: "var(--muted)", position: "sticky", top: 0, background: "var(--surface, #fff)" }}>
                              {["Name", "Last used", "First used", "Requests (30 days)", "Sign-ins", "Opens", "Version", "Device", "Push"].map((h) => (
                                <th key={h} style={{ padding: "8px 10px", fontWeight: 600, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {analytics.users.length === 0 && (
                              <tr><td colSpan={9} style={{ padding: 12, color: "var(--muted)" }}>Nobody yet</td></tr>
                            )}
                            {analytics.users.map((u) => (
                              <tr key={u.userId} style={{ borderTop: "1px solid var(--border)" }}>
                                <td style={{ padding: "7px 10px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    {u.online && <span title="Online now" style={{ width: 7, height: 7, borderRadius: 999, background: "#0f9d58", flex: "none" }} />}
                                    {u.fullName || "Unknown"}
                                  </div>
                                  {u.department && <div style={{ fontSize: 11, color: "var(--muted)" }}>{u.department}</div>}
                                </td>
                                <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{new Date(u.lastActive).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                                <td style={{ padding: "7px 10px", whiteSpace: "nowrap", color: "var(--muted)" }}>{shortDate(u.firstSeen)}</td>
                                <td style={{ padding: "7px 10px" }} title={`${u.requestsTotal ?? 0} in total`}>{u.requests30d ?? 0}</td>
                                <td style={{ padding: "7px 10px" }}>{u.logins}</td>
                                <td style={{ padding: "7px 10px" }}>{u.opens}</td>
                                <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{u.version ? `v${u.version}` : "–"}</td>
                                <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{u.device || "–"}</td>
                                <td style={{ padding: "7px 10px" }}>{u.push ? "On" : "–"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 240px" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 }}>Recent downloads</div>
                      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                        {analytics.recentDownloads.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: "var(--muted)" }}>None yet</div>}
                        {analytics.recentDownloads.map((d, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 12px", borderTop: i > 0 ? "1px solid var(--border)" : undefined, fontSize: 12.5 }}>
                            <span>{d.fullName || "Unknown"}{d.version ? ` · v${d.version}` : ""}</span>
                            <span style={{ color: "var(--muted)" }}>{new Date(d.createdAt).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ flex: "1 1 240px" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 }}>Recent logins</div>
                      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                        {analytics.recentLogins.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: "var(--muted)" }}>None yet</div>}
                        {analytics.recentLogins.map((l, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 12px", borderTop: i > 0 ? "1px solid var(--border)" : undefined, fontSize: 12.5 }}>
                            <span>{l.fullName || "Unknown"}</span>
                            <span style={{ color: "var(--muted)" }}>{new Date(l.createdAt).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div style={{ width: 240, flex: "none", borderLeft: "1px solid var(--border)", padding: 20, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", alignSelf: "flex-start", marginBottom: 12 }}>
            Live preview
          </div>
          <div style={{ width: 190, borderRadius: 22, border: "5px solid #161b2e", background: "#eef1f7", overflow: "hidden" }}>
            <div style={{ padding: "12px 12px 8px" }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: "#161b2e" }}>Good afternoon, Kopano</div>
              <div style={{ fontSize: 8.5, color: "#667085", marginTop: 4 }}>{enabled.length ? "2 awaiting your approval" : "Nothing to show yet"}</div>
            </div>
            <div style={{ padding: "0 10px 12px", minHeight: 120, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, alignContent: "start" }}>
              {enabled.map((m) => (
                <div key={m.key} style={{ background: "#fff", border: "1px solid #e3e7f0", borderRadius: 8, padding: 7 }}>
                  <div style={{ width: 15, height: 15, borderRadius: 4, background: m.bg, marginBottom: 5 }} />
                  <div style={{ fontSize: 7.5, fontWeight: 600, color: "#161b2e" }}>{m.label}</div>
                </div>
              ))}
              {enabled.length === 0 && <div style={{ fontSize: 9.5, color: "#667085", gridColumn: "1 / -1" }}>No modules enabled</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
