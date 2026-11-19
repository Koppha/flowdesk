import { useCallback, useEffect, useState } from "react";
import { BRS_PHASES, brsApi, brsPdfPath, safeHtml, type BrsComment, type BrsDetail, type BrsSection } from "./brs";
import { currentUser, send } from "../api";
import { appCan, inApp, postToApp } from "../bridge";
import { formatDate, formatDateTime } from "../ui";

// One BRS, read on the phone: where it is, every section, what's waiting on
// me (confirm a section I'm assigned to, mark it done), comments, the PDF.

// The app (capability "brsFiles") downloads the PDF with the session and
// opens the share sheet; in a browser it's a plain download.
const canDownload = () => !inApp || appCan("brsFiles");

async function download(path: string, name: string) {
  if (inApp) {
    postToApp({ type: "sharePdf", path, title: name });
    return;
  }
  const res = await send(path);
  if (!res.ok) throw new Error("Couldn't download it.");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const SECTION_STATUS: Record<string, [string, string]> = {
  PENDING: ["Not started", "muted"],
  IN_PROGRESS: ["In progress", "warn"],
  SUBMITTED: ["Done", "good"]
};

function assigneeLabel(a: BrsSection["assignees"][number]) {
  return a.user_name || a.team_name || a.section_name || a.division_name || "Someone";
}

export default function BrsScreen({ id }: { id: string }) {
  const me = currentUser();
  const [doc, setDoc] = useState<BrsDetail | null>(null);
  const [comments, setComments] = useState<BrsComment[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([brsApi.get(id), brsApi.comments(id).catch(() => [] as BrsComment[])]);
      setDoc(d);
      setComments(c);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !doc) return <p className="error">{error}</p>;
  if (!doc) return <p className="muted center">Loading…</p>;

  // A person assigned by name is plainly me; a whole department/section might
  // be - the server decides, and says so if not.
  const mineToConfirm = (s: BrsSection) => s.assignees.some((a) => !a.confirmed && (a.user_id ? a.user_id === me?.userId : true));
  const amAssignee = (s: BrsSection) => s.assignees.some((a) => (a.user_id ? a.user_id === me?.userId : true));
  const canFinish = (s: BrsSection) =>
    s.status !== "SUBMITTED" && doc.phase !== "BASELINE" && Boolean(s.content_html?.trim()) && (doc.can_write || (s.owner_phase === "DEPT_INPUT" && amAssignee(s)));

  async function run(key: string, fn: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(done);
      await load();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addComment() {
    const body = draft.trim();
    if (!body) return setError("Write a comment first.");
    if (await run("comment", () => brsApi.comment(id, body), "Comment added.")) setDraft("");
  }

  const waitingOnMe = doc.sections.filter((s) => mineToConfirm(s) || (canFinish(s) && amAssignee(s)));
  const done = doc.sections.filter((s) => s.status === "SUBMITTED").length;

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>{doc.title}</h1>
        <div className="row gap">
          <span className="muted small">{doc.reference_no || "BRS"} · {doc.brs_type_name}</span>
          <span className={`pill ${doc.phase === "BASELINE" ? "good" : doc.phase === "APPROVAL" ? "warn" : "info"}`}>{BRS_PHASES[doc.phase] || doc.phase}</span>
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {doc.return_comment && doc.phase !== "BASELINE" && <p className="banner">Sent back: “{doc.return_comment}”</p>}

      <section className="card stack-sm">
        <div className="kv"><span className="muted small">Owner{doc.owners.length > 1 ? "s" : ""}</span><span className="kv-value">{doc.owners.map((o) => o.full_name || o.email).join(", ") || "—"}</span></div>
        <div className="kv"><span className="muted small">Started by</span><span className="kv-value">{doc.creator?.full_name || doc.requester_name || "—"} · {formatDate(doc.created_at)}</span></div>
        <div className="kv"><span className="muted small">Sections</span><span className="kv-value">{done} of {doc.sections.length} done</span></div>
      </section>

      {waitingOnMe.length > 0 && (
        <section className="card stack-sm">
          <h3>Waiting on you</h3>
          {waitingOnMe.map((s) => (
            <div key={s.id} className="stack-sm">
              <strong className="small">{s.title}</strong>
              {s.due_at && <span className="muted small">Due {formatDate(s.due_at)}</span>}
              <div className="row gap-sm">
                {mineToConfirm(s) && (
                  <button type="button" className="secondary" disabled={busy !== null}
                    onClick={() => run(`confirm-${s.id}`, () => brsApi.confirmSection(id, s.id), `You're confirmed on "${s.title}".`)}>
                    {busy === `confirm-${s.id}` ? "Confirming…" : "Confirm I'm on it"}
                  </button>
                )}
                {canFinish(s) && (
                  <button type="button" className="primary" disabled={busy !== null}
                    onClick={() => run(`submit-${s.id}`, () => brsApi.submitSection(id, s.id), `"${s.title}" marked done.`)}>
                    {busy === `submit-${s.id}` ? "Saving…" : "Mark section done"}
                  </button>
                )}
              </div>
              {!s.content_html?.trim() && doc.phase !== "BASELINE" && (
                <span className="muted small">Write this section in BRS Studio on the FlowDesk portal, then mark it done here.</span>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="stack-sm">
        <h3>Document</h3>
        <ul className="list">
          {doc.sections.map((s) => {
            const [label, tone] = SECTION_STATUS[s.status] || [s.status.toLowerCase(), "info"];
            const isOpen = open[s.id];
            return (
              <li key={s.id}>
                <button type="button" className="row-link plain" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
                  <span className="grow">
                    <strong>{s.title}</strong>
                    <span className="muted small">
                      {s.owner_phase === "DEPT_INPUT" ? `Input from ${s.assignees.map(assigneeLabel).join(", ") || "a department"}` : "Written by the owners"}
                    </span>
                  </span>
                  <span className={`pill ${tone}`}>{label}</span>
                </button>
                {isOpen && (
                  s.content_html?.trim()
                    ? <div className="rich pad" dangerouslySetInnerHTML={{ __html: safeHtml(s.content_html) }} />
                    : <p className="muted small pad">Nothing written yet.</p>
                )}
              </li>
            );
          })}
        </ul>
        {doc.phase !== "BASELINE" && <p className="muted small">To write or change sections, open BRS Studio on the FlowDesk portal.</p>}
      </section>

      <section className="card stack-sm">
        <h3>Comments{comments.length ? ` (${comments.length})` : ""}</h3>
        {comments.length === 0 && <p className="muted small">No comments yet.</p>}
        {comments.map((c) => (
          <div key={c.id} className="stack-sm">
            <span className="small"><strong>{c.author_name || "Someone"}</strong>{c.section_title ? ` on "${c.section_title}"` : ""}</span>
            <span className="small pre">{c.body}</span>
            <span className="muted small">{formatDateTime(c.created_at)}</span>
          </div>
        ))}
        <textarea rows={3} value={draft} placeholder="Add a comment…" onChange={(e) => setDraft(e.target.value)} maxLength={5000} />
        <button type="button" className="secondary" disabled={busy !== null} onClick={addComment}>{busy === "comment" ? "Posting…" : "Post comment"}</button>
      </section>

      <section className="card stack-sm">
        <h3>PDF</h3>
        {canDownload() ? (
          <button type="button" className="secondary" onClick={() => download(brsPdfPath(id), `${doc.reference_no || "BRS"}.pdf`).catch((e) => setError(e.message))}>
            Download / share PDF
          </button>
        ) : (
          <p className="muted small">Update the FlowDesk app to download the PDF here.</p>
        )}
      </section>
    </div>
  );
}
