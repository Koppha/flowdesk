import { useEffect, useState } from "react";
import { api, type DocSummary, type SignedRecord } from "../api";
import { href } from "../router";
import { StatusPill, formatDate } from "../ui";

// "To sign" home: routed documents waiting on me first, then everything
// else I created or am on the route of, then my one-off signed PDFs.
export default function ListScreen() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [signed, setSigned] = useState<SignedRecord[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.myDocuments(), api.mySigned().catch(() => ({ items: [] as SignedRecord[] }))])
      .then(([d, s]) => {
        setDocs(d.items);
        setSigned(s.items);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!docs) return <p className="muted center">Loading…</p>;

  const waiting = docs.filter((d) => d.is_my_turn);
  const open = docs.filter((d) => !d.is_my_turn && d.status === "OPEN");
  const closed = docs.filter((d) => d.status !== "OPEN");

  return (
    <div className="stack">
      <div className="quick-actions">
        <a className="action-tile" href={href({ name: "sign" })}>
          <strong>Sign a PDF</strong>
          <span className="muted small">Sign a document yourself</span>
        </a>
        <a className="action-tile" href={href({ name: "send" })}>
          <strong>Send for signing</strong>
          <span className="muted small">Route it to others</span>
        </a>
      </div>

      <Section title="Waiting for you" empty="Nothing waiting for your signature." docs={waiting} highlight />
      <Section title="In progress" docs={open} />
      <Section title="Finished" docs={closed} />

      {signed.length > 0 && (
        <section className="stack-sm">
          <h2>Signed by me</h2>
          <ul className="list">
            {signed.map((s) => (
              <li key={s.id}>
                <a href={href({ name: "signed", id: s.id })} className="row-link">
                  <span className="grow">
                    <strong>{s.title}</strong>
                    <span className="muted small">Signed {formatDate(s.signed_at)} · {s.verification_code}</span>
                  </span>
                  <span className="chev">›</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Section({ title, docs, empty, highlight }: { title: string; docs: DocSummary[]; empty?: string; highlight?: boolean }) {
  if (!docs.length && !empty) return null;
  return (
    <section className="stack-sm">
      <h2>
        {title} {docs.length > 0 && <span className="count">{docs.length}</span>}
      </h2>
      {docs.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="list">
          {docs.map((d) => (
            <li key={d.id} className={highlight ? "highlight" : undefined}>
              <a href={href({ name: "doc", id: d.id })} className="row-link">
                <span className="grow">
                  <strong>{d.title}</strong>
                  <span className="muted small">
                    {d.created_by_me ? "Sent by you" : `From ${d.created_by_name || "someone"}`} · {formatDate(d.updated_at)}
                  </span>
                </span>
                <StatusPill status={d.status} myTurn={d.is_my_turn} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
