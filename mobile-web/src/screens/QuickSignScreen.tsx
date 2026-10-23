import { useState } from "react";
import { api } from "../api";
import { postToApp } from "../bridge";
import { isPdf } from "../pdf";
import { go } from "../router";
import SignFlow from "../components/SignFlow";
import { PdfPicker } from "../ui";

// Sign a PDF myself: pick it, sign it, get the verification-coded copy.
export default function QuickSignScreen() {
  const [file, setFile] = useState<File | null>(null);
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  async function pick(f: File) {
    setError("");
    if (!isPdf(f)) return setError("Choose a PDF file.");
    if (f.size > 25 * 1024 * 1024) return setError("That file is over 25 MB.");
    setFile(f);
    setData(await f.arrayBuffer());
    if (!title) setTitle(f.name.replace(/\.pdf$/i, ""));
  }

  return (
    <div className="stack">
      <h1>Sign a PDF</h1>
      <PdfPicker file={file} onPick={pick} />
      {error && <p className="error">{error}</p>}
      {data && file && (
        <>
          <label className="field">
            <span>Document title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <SignFlow
            key={file.name + file.size}
            data={data}
            onSubmit={async (req) => {
              if (!title.trim()) throw new Error("Give the document a title.");
              const form = new FormData();
              form.append("file", file);
              form.append("title", title.trim());
              form.append("consentStatement", req.consentStatement);
              form.append("pageNumber", String(req.pageNumber));
              form.append("xPct", String(req.xPct));
              form.append("yPct", String(req.yPct));
              form.append("widthPct", String(req.widthPct));
              if (req.typedSignatureText) form.append("typedSignatureText", req.typedSignatureText);
              if (req.signatureImageDataUrl) form.append("signatureImageDataUrl", req.signatureImageDataUrl);
              const result = await api.signUpload(form);
              postToApp({ type: "signed", title: title.trim() });
              go({ name: "signed", id: result.id }, true);
            }}
          />
        </>
      )}
    </div>
  );
}
