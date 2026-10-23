import { useCallback, useEffect, useState } from "react";
import { api, pdfPath, type DocDetail } from "../api";
import { postToApp } from "../bridge";
import PdfPlacer from "../components/PdfPlacer";
import SignFlow from "../components/SignFlow";
import { SaveButton, StatusPill, formatDate, formatDateTime } from "../ui";

// One routing document: who's signed, whose turn it is, the PDF itself, and
// - when it's my turn (or the document has no route) - sign / reject.
export default function DocScreen({ id }: { id: string }) {
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"view" | "sign" | "reject">("view");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [d, file] = await Promise.all([api.document(id), api.documentPdf(id)]);
      setDoc(d);
      setPdf(file);
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !doc) return <p className="error">{error}</p>;
  if (!doc || !pdf) return <p className="muted center">Loading…</p>;

  // The server enforces turn order; this only decides which buttons to show.
  const routed = doc.approvalChain.length > 0;
  const canSign = doc.status === "OPEN" && (doc.isMyTurn || !routed);

  async function finish() {
    if (!confirm("Finish signing? After this nobody can add a signature.")) return;
    try {
      await api.finishDocument(doc!.id);
      setNotice("Signing finished - the document is complete.");
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>{doc.title}</h1>
        <div className="row gap">
          <StatusPill status={doc.status} myTurn={doc.isMyTurn} />
          <span className="muted small">Code {doc.verificationCode}</span>
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {routed && (
        <section className="card">
          <h3>Signing order</h3>
          <ol className="steps">
            {doc.approvalChain.map((s, i) => {
              const current = doc.status === "OPEN" && i === doc.currentStepOrder;
              return (
                <li key={i} className={current ? "current" : s.status === "SIGNED" ? "done" : s.status === "REJECTED" ? "rejected" : ""}>
                  <span className="grow">
                    <strong>{s.approverName}</strong>
                    {s.actedAt && <span className="muted small">{s.status === "REJECTED" ? "Rejected" : "Signed"} {formatDateTime(s.actedAt)}</span>}
                    {s.comment && <span className="small">“{s.comment}”</span>}
                  </span>
                  <StatusPill status={current ? "OPEN" : s.status || "PENDING"} />
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {!routed && doc.placements.length > 0 && (
        <section className="card">
          <h3>Signed by</h3>
          <ul className="plain">
            {doc.placements.map((p) => (
              <li key={p.id}>
                <strong>{p.signerName}</strong> <span className="muted small">{formatDateTime(p.signedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mode === "sign" ? (
        <SignFlow
          data={pdf}
          placements={doc.placements}
          submitLabel={routed && doc.currentStepOrder < doc.approvalChain.length - 1 ? "Sign & send on" : "Sign"}
          onSubmit={async (req) => {
            await api.signDocument(doc.id, req);
            postToApp({ type: "signed", title: doc.title });
            setMode("view");
            setNotice("Signed. Your signature has been added to the document.");
            await load();
          }}
        />
      ) : mode === "reject" ? (
        <RejectForm
          onCancel={() => setMode("view")}
          onReject={async (comment) => {
            await api.rejectDocument(doc.id, comment);
            setMode("view");
            setNotice("Rejected. Everyone on the route has been told.");
            await load();
          }}
        />
      ) : (
        <>
          <section className="card">
            <PdfPlacer data={pdf} placements={doc.placements} />
          </section>
          <SaveButton path={pdfPath.document(doc.id)} title={doc.title} />
          <p className="muted small">Created {formatDate(doc.createdAt)}{doc.closedAt ? ` · closed ${formatDate(doc.closedAt)}${doc.closedByName ? ` by ${doc.closedByName}` : ""}` : ""}</p>
          {(canSign || doc.isMyTurn || doc.canFinish) && (
            <div className="sticky-actions">
              {canSign && <button type="button" className="primary" onClick={() => setMode("sign")}>Sign this document</button>}
              {doc.isMyTurn && <button type="button" className="secondary danger" onClick={() => setMode("reject")}>Reject</button>}
              {doc.canFinish && <button type="button" className="secondary" onClick={finish}>Finish signing</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RejectForm({ onReject, onCancel }: { onReject: (comment: string) => Promise<void>; onCancel: () => void }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="card stack">
      <h3>Reject this document</h3>
      <label className="field">
        <span>Reason (sent to everyone on the route)</span>
        <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row gap">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="primary danger"
          disabled={busy || !comment.trim()}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onReject(comment.trim());
            } catch (e: any) {
              setError(e.message);
              setBusy(false);
            }
          }}
        >
          {busy ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </section>
  );
}
