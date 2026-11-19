import { useEffect, useRef, useState, type CSSProperties } from "react";
import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { api } from "../api";

// Two-step sign-in (backend lib/mfa.ts): the sign-in step after the
// password, the authenticator setup, the user's own settings and the
// admin policy.

export type MfaStep = { challenge: string; mode: "required" | "setup"; phoneApproval: boolean };
type Session = { token: string; user: any };

const muted: CSSProperties = { fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 };
const codeInput: CSSProperties = { letterSpacing: 4, fontSize: 20, textAlign: "center", fontVariantNumeric: "tabular-nums" };
const row: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
const linkBtn: CSSProperties = { background: "none", border: "none", padding: 0, color: "var(--accent, #2563eb)", cursor: "pointer", fontSize: 13, fontWeight: 600 };

function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join("\n");
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Your recovery codes</div>
      <p style={muted}>
        Keep these somewhere safe (not on the same phone). Each one works once, if you lose your phone. They won&apos;t be shown again.
      </p>
      <pre style={{ background: "var(--surface-2, #f4f6fa)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, columns: 2, fontSize: 14, margin: "8px 0" }}>{text}</pre>
      <div style={row}>
        <button type="button" className="ep-btn-outline" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
        <button
          type="button"
          className="ep-btn-outline"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([`FlowDesk recovery codes\n\n${text}\n`], { type: "text/plain" }));
            a.download = "flowdesk-recovery-codes.txt";
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Download
        </button>
      </div>
    </div>
  );
}

/** Scan the QR code, confirm a code, then show the recovery codes. challenge = during sign-in. */
export function MfaSetupPanel({ challenge, onDone }: { challenge?: string; onDone: (result: { recoveryCodes: string[]; session?: Session }) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<{ recoveryCodes: string[]; session?: Session } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.mfaSetupStart(challenge).then(setSetup).catch((e) => setError(e?.message || "Couldn't start the setup"));
  }, [challenge]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.mfaSetupConfirm(code.trim(), challenge);
      setCodes({ recoveryCodes: r.recoveryCodes, session: r.token ? { token: r.token, user: r.user } : undefined });
    } catch (e: any) {
      setError(e?.message || "That code didn't match");
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <RecoveryCodes codes={codes.recoveryCodes} />
        <button type="button" className="button button-primary" onClick={() => onDone(codes)}>
          I&apos;ve saved them - continue
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={muted}>
        <b>1.</b> Install Microsoft Authenticator or Google Authenticator on your phone.
        <br />
        <b>2.</b> In the app, add an account and scan this code:
      </p>
      {setup ? (
        <div style={{ textAlign: "center" }}>
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ borderRadius: 8, border: "1px solid var(--border)" }} />
          <div style={{ ...muted, marginTop: 6 }}>
            Can&apos;t scan? Enter this key: <code style={{ userSelect: "all", wordBreak: "break-all" }}>{setup.secret}</code>
          </div>
        </div>
      ) : (
        !error && <div style={muted}>Preparing…</div>
      )}
      <p style={muted}>
        <b>3.</b> Type the 6-digit code the app shows:
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
        style={{ display: "grid", gap: 10 }}
      >
        <input
          className="login-input"
          style={codeInput}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          aria-label="6-digit code"
        />
        <button className="button button-primary" type="submit" disabled={busy || code.length !== 6 || !setup}>
          {busy ? "Checking…" : "Turn on two-step sign-in"}
        </button>
      </form>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** The sign-in step after a correct password. */
export function MfaSignIn({ step, onSignedIn, onCancel }: { step: MfaStep; onSignedIn: (s: Session) => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState<"waiting" | "denied" | "expired" | null>(step.phoneApproval ? "waiting" : null);
  const done = useRef(false);

  // Waiting for Approve in FlowDesk Mobile.
  useEffect(() => {
    if (step.mode !== "required" || !step.phoneApproval) return;
    let live = true;
    const tick = async () => {
      if (!live || done.current) return;
      try {
        const r = await api.mfaApproval(step.challenge);
        if (!live || done.current) return;
        if (r.status === "APPROVED" && r.token) {
          done.current = true;
          onSignedIn({ token: r.token, user: r.user });
          return;
        }
        if (r.status === "DENIED") return setPhone("denied");
        if (r.status === "EXPIRED") return setPhone("expired");
      } catch {
        // A blip - keep waiting.
      }
      if (live) window.setTimeout(tick, 2500);
    };
    const t = window.setTimeout(tick, 2500);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [step, onSignedIn]);

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.mfaVerify(step.challenge, code.trim());
      done.current = true;
      if (r.usedRecoveryCode) window.setTimeout(() => alert("You used a recovery code. Make new ones in Settings > Two-step sign-in if you're running low."), 300);
      onSignedIn({ token: r.token, user: r.user });
    } catch (e: any) {
      setError(e?.message || "That code didn't work");
      setBusy(false);
    }
  }

  if (step.mode === "setup") {
    return (
      <div style={{ display: "grid", gap: 12, textAlign: "left" }}>
        <div style={row}>
          <ShieldCheck size={20} color="var(--accent, #283889)" />
          <b>Set up two-step sign-in</b>
        </div>
        <p style={muted}>Your role needs a second step when signing in to FlowDesk. It takes a minute, once.</p>
        <MfaSetupPanel challenge={step.challenge} onDone={(r) => r.session && onSignedIn(r.session)} />
        <button type="button" style={linkBtn} onClick={onCancel}>Back to sign in</button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12, textAlign: "left" }}>
      {phone && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Smartphone size={20} style={{ flex: "none", marginTop: 2 }} />
          <div style={muted}>
            {phone === "waiting" && <><b>Check your phone.</b> Open the notification in FlowDesk Mobile and tap Approve. Waiting…</>}
            {phone === "denied" && <><b>The sign-in was denied on your phone.</b> If that wasn&apos;t you, change your password.</>}
            {phone === "expired" && <><b>The request expired.</b> Use a code below, or sign in again.</>}
          </div>
        </div>
      )}
      <div style={row}>
        <KeyRound size={18} />
        <b>{recovery ? "Enter a recovery code" : phone ? "Or enter the code from your authenticator app" : "Enter the code from your authenticator app"}</b>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
        style={{ display: "grid", gap: 10 }}
      >
        <input
          className="login-input"
          style={recovery ? { textAlign: "center", fontSize: 16 } : codeInput}
          value={code}
          onChange={(e) => setCode(recovery ? e.target.value.slice(0, 20) : e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          placeholder={recovery ? "xxxxx-xxxxx" : "123456"}
          aria-label={recovery ? "Recovery code" : "6-digit code"}
          autoFocus={!phone}
        />
        <button className="button button-primary login-button" type="submit" disabled={busy || (recovery ? code.trim().length < 10 : code.length !== 6)}>
          {busy ? "Checking…" : "Verify"}
        </button>
      </form>
      {error && <pre className="error-text">{error}</pre>}
      <div style={{ ...row, justifyContent: "space-between" }}>
        <button type="button" style={linkBtn} onClick={() => { setRecovery((r) => !r); setCode(""); setError(null); }}>
          {recovery ? "Use the authenticator app" : "Lost your phone? Use a recovery code"}
        </button>
        <button type="button" style={linkBtn} onClick={onCancel}>Back</button>
      </div>
    </div>
  );
}

type Status = { enabled: boolean; enabledAt: string | null; required: boolean; recoveryCodesLeft: number; phoneApproval: boolean };

/** Settings > Two-step sign-in (the signed-in user's own). */
export function MfaSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<"idle" | "setup" | "codes" | "disable">("idle");
  const [code, setCode] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.mfaStatus().then(setStatus).catch((e) => setError(e?.message || "Couldn't load"));
  useEffect(() => {
    void load();
  }, []);

  async function act() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "codes") setNewCodes((await api.mfaRecoveryCodes(code.trim())).recoveryCodes);
      else if (mode === "disable") {
        await api.mfaDisable(code.trim());
        setMode("idle");
        await load();
      }
      setCode("");
    } catch (e: any) {
      setError(e?.message || "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <div style={muted}>{error || "Loading…"}</div>;

  if (newCodes) {
    return (
      <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
        <RecoveryCodes codes={newCodes} />
        <button type="button" className="ep-btn-outline" onClick={() => { setNewCodes(null); setMode("idle"); void load(); }}>Done</button>
      </div>
    );
  }

  if (mode === "setup") {
    return (
      <div style={{ maxWidth: 420 }}>
        <MfaSetupPanel onDone={() => { setMode("idle"); void load(); }} />
        <button type="button" style={{ ...linkBtn, marginTop: 8 }} onClick={() => setMode("idle")}>Cancel</button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 520 }}>
      <div style={row}>
        <ShieldCheck size={18} color={status.enabled ? "#0f9d58" : "var(--muted)"} />
        <b>{status.enabled ? "On" : "Off"}</b>
        {status.enabled && status.enabledAt && <span style={muted}>since {new Date(status.enabledAt).toLocaleDateString()}</span>}
        {status.required && <span style={{ ...muted, fontWeight: 600 }}>· Required for your role</span>}
      </div>
      <p style={muted}>
        When you sign in, FlowDesk also asks for a code from an authenticator app on your phone
        {status.phoneApproval ? " - or you tap Approve in FlowDesk Mobile" : ""}. Someone with your password alone can&apos;t get in.
      </p>
      {status.enabled && <div style={muted}>Recovery codes left: <b>{status.recoveryCodesLeft}</b></div>}
      {!status.enabled && (
        <div>
          <button type="button" className="button button-primary" onClick={() => setMode("setup")}>Set up two-step sign-in</button>
        </div>
      )}
      {status.enabled && mode === "idle" && (
        <div style={row}>
          <button type="button" className="ep-btn-outline" onClick={() => setMode("codes")}>New recovery codes</button>
          {!status.required && <button type="button" className="ep-btn-outline" onClick={() => setMode("disable")}>Turn off</button>}
        </div>
      )}
      {(mode === "codes" || mode === "disable") && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act();
          }}
          style={{ ...row, alignItems: "stretch" }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            placeholder="Code from your app"
            aria-label="6-digit code"
            style={{ maxWidth: 170 }}
            autoFocus
          />
          <button type="submit" className="button button-primary" disabled={busy || code.length !== 6}>
            {mode === "codes" ? "Make new codes" : "Turn off"}
          </button>
          <button type="button" style={linkBtn} onClick={() => { setMode("idle"); setCode(""); setError(null); }}>Cancel</button>
        </form>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

type Policy = { requiredRoles: string[]; financeSections: boolean; everyone: boolean };
type Enrolled = { user_id: string; full_name: string | null; email: string; role: string; enabled_at: string; recovery_left: number };
const POLICY_ROLES = ["ADMIN", "FINANCE", "CEO", "EXCO", "MANAGER", "HOD", "HR_OFFICER"];

/** Settings > Two-step sign-in policy (admins). */
export function MfaAdmin() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [enrolled, setEnrolled] = useState<Enrolled[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = () =>
    api.mfaPolicy().then((r) => { setPolicy(r.policy); setEnrolled(r.enrolled); }).catch((e) => setError(e?.message || "Couldn't load"));
  useEffect(() => {
    void load();
  }, []);

  async function save(next: Policy) {
    setPolicy(next);
    setSaved(null);
    try {
      await api.setMfaPolicy(next);
      setSaved("Saved");
    } catch (e: any) {
      setError(e?.message || "Couldn't save");
    }
  }

  if (!policy) return <div style={muted}>{error || "Loading…"}</div>;
  const toggleRole = (r: string) =>
    void save({ ...policy, requiredRoles: policy.requiredRoles.includes(r) ? policy.requiredRoles.filter((x) => x !== r) : [...policy.requiredRoles, r] });
  const shown = enrolled.filter((u) => `${u.full_name || ""} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Who must use it</div>
        <p style={muted}>They set it up at their next sign-in. Anyone else can turn it on in their own Settings.</p>
        <label style={{ ...row, margin: "6px 0" }}>
          <input type="checkbox" checked={policy.everyone} onChange={(e) => void save({ ...policy, everyone: e.target.checked })} />
          Everyone
        </label>
        {!policy.everyone && (
          <>
            <div style={{ ...row, margin: "6px 0" }}>
              {POLICY_ROLES.map((r) => (
                <label key={r} style={{ ...row, gap: 4, border: "1px solid var(--border)", borderRadius: 999, padding: "3px 10px", fontSize: 12.5 }}>
                  <input type="checkbox" checked={policy.requiredRoles.includes(r)} onChange={() => toggleRole(r)} />
                  {r.replace(/_/g, " ")}
                </label>
              ))}
            </div>
            <label style={{ ...row, margin: "6px 0", fontSize: 13 }}>
              <input type="checkbox" checked={policy.financeSections} onChange={(e) => void save({ ...policy, financeSections: e.target.checked })} />
              Staff in Finance Departments (those with Finance authority), whatever their role
            </label>
          </>
        )}
        {saved && <span style={{ ...muted, color: "#0f9d58" }}>{saved}</span>}
      </div>
      <div>
        <div style={{ ...row, justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontWeight: 600 }}>Turned on ({enrolled.length})</div>
          {enrolled.length > 8 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" style={{ maxWidth: 200 }} />}
        </div>
        <p style={muted}>Lost phone and no recovery codes? Reset it here; they set it up again at their next sign-in.</p>
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {shown.length === 0 && <div style={{ padding: 12, ...muted }}>Nobody yet</div>}
          {shown.map((u, i) => (
            <div key={u.user_id} style={{ ...row, justifyContent: "space-between", padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : undefined, fontSize: 13 }}>
              <span>
                {u.full_name || u.email} <span style={muted}>· {u.role} · since {new Date(u.enabled_at).toLocaleDateString()} · {u.recovery_left} recovery codes</span>
              </span>
              <button
                type="button"
                className="ep-btn-outline"
                style={{ padding: "3px 10px", fontSize: 12 }}
                onClick={async () => {
                  if (!window.confirm(`Reset two-step sign-in for ${u.full_name || u.email}? They'll set it up again at their next sign-in.`)) return;
                  try {
                    await api.mfaAdminReset(u.user_id);
                    await load();
                  } catch (e: any) {
                    setError(e?.message || "Couldn't reset");
                  }
                }}
              >
                Reset
              </button>
            </div>
          ))}
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
