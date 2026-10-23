import { useEffect, useState } from "react";
import { api, pdfPath, type SignedRecord } from "../api";
import PdfPlacer from "../components/PdfPlacer";
import { SaveButton, formatDateTime } from "../ui";

// A PDF I signed on my own (upload-and-sign): the stamped copy and its code.
export default function SignedScreen({ id }: { id: string }) {
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [record, setRecord] = useState<SignedRecord | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.signedPdf(id).then(setPdf).catch((e) => setError(e.message));
    api.mySigned().then((r) => setRecord(r.items.find((s) => s.id === id) || null)).catch(() => {});
  }, [id]);

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="stack">
      <header className="doc-head">
        <h1>{record?.title || "Signed document"}</h1>
        {record && <span className="muted small">Signed {formatDateTime(record.signed_at)}</span>}
      </header>
      {record && (
        <div className="code-box">
          <span className="muted small">Verification code</span>
          <strong>{record.verification_code}</strong>
          <span className="muted small">Anyone can check this document against the code on the FlowDesk verify page.</span>
        </div>
      )}
      <section className="card">{pdf ? <PdfPlacer data={pdf} /> : <p className="muted center">Loading…</p>}</section>
      {pdf && <SaveButton path={pdfPath.signed(id)} title={record?.title || "Signed document"} />}
    </div>
  );
}
