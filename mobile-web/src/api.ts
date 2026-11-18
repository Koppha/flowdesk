import { getToken, inApp, postToApp, setBrowserToken } from "./bridge";

// The page lives at <api>/mobile-app/web/ (or the older /mobile-app/sign/),
// so the API is everything before that - whatever proxy prefix the page was
// loaded through.
export const API_BASE =
  (import.meta.env.VITE_API as string | undefined) ||
  location.origin + location.pathname.replace(/\/mobile-app\/(web|sign)(\/.*)?$/, "");

let onSessionExpired: () => void = () => {};
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

function errorMessage(json: any, fallback: string): string {
  if (typeof json?.message === "string") return json.message;
  if (typeof json?.error === "string") return json.error;
  if (typeof json?.error?.message === "string") return json.error.message;
  return fallback || "Something went wrong.";
}

export async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  headers.set("X-Flowdesk-Client", "mobile");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(API_BASE + path, { ...init, headers });
  if (res.status === 401 && token) {
    if (inApp) postToApp({ type: "sessionExpired" });
    else setBrowserToken(null);
    onSessionExpired();
  }
  return res;
}

export async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, { ...init, headers: { Accept: "application/json", ...(init.headers as any) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(json, res.statusText));
  return json as T;
}

async function pdf(path: string): Promise<ArrayBuffer> {
  const res = await send(path);
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(errorMessage(json, "Couldn't load the document."));
  }
  return res.arrayBuffer();
}

// --- Types (mirror backend-v2/src/modules/signatures/signatures.routes.ts) ---

export type ChainStep = { approverId: string; approverName: string; status: string | null; comment: string | null; actedAt: string | null };

export type DocSummary = {
  id: string;
  title: string;
  verification_code: string;
  created_at: string;
  updated_at: string;
  created_by_name: string | null;
  status: "OPEN" | "COMPLETED" | "REJECTED" | "DELETED" | string;
  current_step_order: number;
  approval_chain: { approver_id: string; approver_name: string; status?: string | null }[];
  created_by_me: boolean;
  is_my_turn: boolean;
  /** When I signed it, if I have. */
  my_signed_at?: string | null;
};

export type Placement = { id: string; signerName: string; authorityName: string | null; pageNumber: number; xPct: number; yPct: number; signedAt: string };

export type DocDetail = {
  id: string;
  title: string;
  verificationCode: string;
  createdById: string;
  createdAt: string;
  status: string;
  currentStepOrder: number;
  approvalChain: ChainStep[];
  isMyTurn: boolean;
  closedAt: string | null;
  closedByName: string | null;
  canFinish: boolean;
  canDelete: boolean;
  placements: Placement[];
};

export type SignedRecord = { id: string; title: string; verification_code: string; signed_at: string };

export type SavedSignature = {
  signatureType: "type" | "draw"; typedName: string | null; imageDataUrl: string | null;
  /** Typed signings still allowed while drawn/uploaded signatures are required (null = not limited). */
  typedSigningsLeft?: number | null;
};

export type Person = { id: string; full_name: string | null; email: string; department: string | null };

/** What gets stamped: a typed name or a drawn image, plus where it goes. */
export type SignatureInput = { typedSignatureText?: string; signatureImageDataUrl?: string };
export type Position = { pageNumber: number; xPct: number; yPct: number };

export const api = {
  login: (email: string, password: string) =>
    req<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  myDocuments: () => req<{ items: DocSummary[] }>("/signatures/documents/mine"),
  document: (id: string) => req<DocDetail>(`/signatures/documents/${id}`),
  documentPdf: (id: string) => pdf(pdfPath.document(id)),
  createDocument: (form: FormData) =>
    req<{ id: string; verificationCode: string; title: string }>("/signatures/documents", { method: "POST", body: form }),
  signDocument: (id: string, body: SignatureInput & Position & { consentStatement: string; widthPct: number }) =>
    req<{ id: string }>(`/signatures/documents/${id}/sign`, { method: "POST", body: JSON.stringify(body) }),
  rejectDocument: (id: string, comment: string) =>
    req(`/signatures/documents/${id}/reject`, { method: "POST", body: JSON.stringify({ comment }) }),
  finishDocument: (id: string) => req(`/signatures/documents/${id}/finish`, { method: "POST", body: JSON.stringify({}) }),

  mySigned: () => req<{ items: SignedRecord[] }>("/signatures/mine"),
  signUpload: (form: FormData) => req<{ id: string; verificationCode: string }>("/signatures/upload-and-sign", { method: "POST", body: form }),
  signedPdf: (id: string) => pdf(pdfPath.signed(id)),

  savedSignature: () => req<SavedSignature | null>("/signatures/my-saved-signature"),
  /** requireImage: signatures must be drawn or uploaded (admin setting). */
  signaturePolicy: () => req<{ requireImage?: boolean }>("/signatures/settings"),
  saveSignature: (s: SavedSignature) => req("/signatures/my-saved-signature", { method: "PUT", body: JSON.stringify(s) }),
  clearSignature: () => req("/signatures/my-saved-signature", { method: "DELETE" }),

  people: () => req<Person[]>("/auth/request-directory?scope=company"),

  me: () => req<{ id: string; full_name: string | null; phone: string | null }>("/auth/me"),
  /** The FlowDesk profile phone (users.phone) - shared with the web portal. */
  saveMyPhone: (phone: string) =>
    req<{ ok: true; phone: string | null }>("/auth/me/profile", { method: "PATCH", body: JSON.stringify({ phone }) })
};

/** API path of a signed PDF: a routing document's current copy, or a one-off signature. */
export const pdfPath = {
  document: (id: string) => `/signatures/documents/${id}/file`,
  signed: (id: string) => `/signatures/${id}/file`
};

/** Hands the PDF to the phone: the app's share sheet, or a plain download in a browser. */
export async function savePdf(path: string, title: string) {
  if (inApp) {
    postToApp({ type: "sharePdf", path, title });
    return;
  }
  const blob = new Blob([await pdf(path)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "signed"}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- The signed-in user, read from the token (same claims the web app uses) ---

export type Me = { userId: string; fullName: string };

export function currentUser(): Me | null {
  const token = getToken();
  if (!token) return null;
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(part)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
    const p = JSON.parse(json);
    return { userId: p.userId, fullName: p.fullName || "" };
  } catch {
    return null;
  }
}

/** Same wording the web portal records (SignDocument.tsx / SignRoutingDocument.tsx). */
export function consentStatement(me: Me | null) {
  return `I, ${me?.fullName || "the signer"}, confirm this is my legal signature and I consent to sign this document electronically on ${new Date().toLocaleDateString("en-GB")}.`;
}
