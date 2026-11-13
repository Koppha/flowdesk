import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { API, getToken } from "../api";

// AI co-writing: the writer picks what the AI should do (or says it in their
// own words), sees the proposal, and chooses whether and where to use it.
// Nothing changes until they do. Used by the BRS editor (HTML) and Change
// Request fields (plain text).

export type CowriteParams = { action: string; instruction: string; current: string; selection: string };
export type CowriteRequest = (p: CowriteParams) => Promise<{ result: string; model: string }>;
export type ApplyHow = "selection" | "replace" | "insert" | "append";

export async function aiPost<T = any>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || (r.status === 403 ? "You don't have access to the AI assistant." : "The AI couldn't answer right now."));
  return j as T;
}

const ACTIONS: Array<{ key: string; label: string; needsContent: boolean; html?: boolean }> = [
  { key: "draft", label: "Draft it for me", needsContent: false },
  { key: "improve", label: "Improve the writing", needsContent: true },
  { key: "expand", label: "Expand with detail", needsContent: true },
  { key: "shorten", label: "Make it shorter", needsContent: true },
  { key: "grammar", label: "Fix spelling & grammar", needsContent: true },
  { key: "formal", label: "More formal", needsContent: true },
  { key: "bullets", label: "Turn into a list", needsContent: true },
  { key: "requirements", label: "Write as requirements", needsContent: false, html: true },
  { key: "table", label: "Turn into a table", needsContent: true, html: true }
];

export function AiCowriterPanel(props: {
  kind: "html" | "text";
  title: string;
  current: string;
  selection: string;
  request: CowriteRequest;
  onApply: (result: string, how: ApplyHow) => void;
  onClose: () => void;
}) {
  const { kind, current, selection } = props;
  const hasSelection = !!selection.replace(/<[^>]*>/g, "").trim();
  const hasContent = !!current.replace(/<[^>]*>/g, "").trim() || /<(img|table)\b/i.test(current);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; model: string } | null>(null);
  const [last, setLast] = useState<string>("draft");

  async function run(action: string) {
    if (action === "custom" && !instruction.trim()) { setError("Say what you'd like the AI to write or change."); return; }
    setBusy(action); setError(null); setLast(action);
    try {
      const r = await props.request({ action, instruction: instruction.trim(), current, selection: hasSelection ? selection : "" });
      setResult({ text: r.result, model: r.model });
    } catch (e: any) {
      setError(e?.message || "The AI couldn't answer right now.");
    } finally { setBusy(null); }
  }

  const apply = (how: ApplyHow) => { if (result) { props.onApply(result.text, how); props.onClose(); } };
  const shown = ACTIONS.filter((a) => (kind === "html" || !a.html) && (hasContent || hasSelection || !a.needsContent));

  return (
    <div className="ep-modal-overlay">
      <div className="ep-modal" style={{ maxWidth: 860, width: "94vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="ep-modal-head">
          <div>
            <h3 className="ep-modal-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><Sparkles size={18} color="#6250d6" /> Write with AI - {props.title}</h3>
            <p className="ep-modal-sub">
              {hasSelection ? "Working on the text you selected." : hasContent ? "Working on what's written so far." : "Nothing written yet - the AI drafts it from the rest of the request."}
              {" "}The AI only suggests: check facts, numbers and names before you use it. Anything it couldn't know is left as [placeholders].
            </p>
          </div>
        </div>
        <div className="ep-modal-body" style={{ maxHeight: "68vh", overflow: "auto" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {shown.map((a) => (
              <button key={a.key} type="button" className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 10px" }} disabled={!!busy} onClick={() => void run(a.key)}>
                {busy === a.key ? "Writing…" : a.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <textarea className="ep-form-textarea" rows={2} style={{ flex: 1 }} value={instruction} onChange={(e) => setInstruction(e.target.value)}
              placeholder={kind === "html" ? "Or say it in your own words, e.g. \"Add the non-functional requirements for USSD response times\"" : "Or say it in your own words, e.g. \"Steps to move the SMSC bind to the load balancer on port 5016\""}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void run("custom"); }} />
            <button type="button" className="ep-btn" disabled={!!busy || !instruction.trim()} onClick={() => void run("custom")} style={{ whiteSpace: "nowrap" }}>
              {busy === "custom" ? "Writing…" : "Ask AI"}
            </button>
          </div>
          {instruction.trim() && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4 }}>Your words are also used with the buttons above.</div>}

          {busy && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, color: "var(--muted)", fontSize: 13 }}>
              <Loader2 size={16} className="spin" style={{ animation: "spin 1s linear infinite" }} /> The AI is writing… this can take up to a minute.
            </div>
          )}
          {error && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 10 }}>{error}</div>}
          {result && !busy && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Suggestion <span style={{ fontWeight: 400, color: "var(--muted)" }}>· {result.model}</span></div>
              {kind === "html" ? (
                <div className="brs-richtext-editable" style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 12, maxHeight: 360, overflow: "auto" }}
                  dangerouslySetInnerHTML={{ __html: result.text }} />
              ) : (
                <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 12, whiteSpace: "pre-wrap", fontSize: 13, maxHeight: 360, overflow: "auto" }}>{result.text}</div>
              )}
            </div>
          )}
        </div>
        <div className="ep-modal-footer" style={{ flexWrap: "wrap" }}>
          <button type="button" className="ep-btn-outline" onClick={props.onClose}>Close</button>
          {result && !busy && (
            <>
              <button type="button" className="ep-btn-outline" onClick={() => void run(last)}>Try again</button>
              {hasSelection && <button type="button" className="ep-btn" onClick={() => apply("selection")}>Replace the selection</button>}
              {hasContent && <button type="button" className={hasSelection ? "ep-btn-outline" : "ep-btn"} onClick={() => apply("replace")}>Replace all</button>}
              {kind === "html" && hasContent && <button type="button" className="ep-btn-outline" onClick={() => apply("insert")}>Insert at the cursor</button>}
              <button type="button" className={hasContent ? "ep-btn-outline" : "ep-btn"} onClick={() => apply("append")}>{hasContent ? "Add at the end" : "Use it"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// A plain-text field's "Write with AI" link + panel (Change Request fields).
export function AiTextAssist(props: { label: string; value: string; onChange: (v: string) => void; request: CowriteRequest }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4, border: "none", background: "transparent", color: "#6250d6", cursor: "pointer", fontSize: 12, padding: 0 }}>
        <Sparkles size={13} /> Write with AI
      </button>
      {open && (
        <AiCowriterPanel kind="text" title={props.label} current={props.value || ""} selection="" request={props.request}
          onClose={() => setOpen(false)}
          onApply={(text, how) => props.onChange(how === "append" && (props.value || "").trim() ? `${props.value.trimEnd()}\n\n${text}` : text)} />
      )}
    </>
  );
}
