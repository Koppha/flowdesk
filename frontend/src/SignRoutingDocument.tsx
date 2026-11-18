import React, { useCallback, useEffect, useRef, useState } from "react";
import SignatureUpload from "./components/SignatureUpload";
import { renderPdfPage, type RenderTaskRef } from "./shared/pdfRender";
import * as pdfjsLib from "pdfjs-dist";
// @ts-ignore - Vite's ?url suffix resolves to the built worker's asset URL
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, getUserFromToken, downloadBlob } from "./api";
import { confirmAction } from "./alerts";
import Swal from "sweetalert2";
import { ApproverCombobox, type DirectoryUser } from "./shared/ApproverCombobox";
import { Field, fieldStyle, labelStyle, SignatureCanvas } from "./SignDocument";
import { Upload, FilePlus2, FolderOpen, ChevronLeft, ChevronRight, MousePointerClick, Share2, CheckCircle2, Users, Plus, Trash2, ArrowUp, ArrowDown, XCircle, Clock3, Ban, Download, ZoomIn, ZoomOut, Maximize2, Minimize2, PenLine, Type, SquareCheck, Undo2 } from "lucide-react";

// Measures typed text the way it's stamped (Helvetica) so the on-page box
// is exactly as wide as the text will be.
const measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
function textWidthPx(line: string, fontPx: number) {
  if (!measureCtx) return line.length * fontPx * 0.55;
  measureCtx.font = `${fontPx}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(line).width;
}

const TEXT_COLORS = ["#111827", "#dc2626", "#1d4ed8", "#059669", "#ea580c"];

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// The "click-to-place" counterpart to Quick Sign - one PDF, multiple people
// each add their own mark at a spot they choose (built for paper-style
// multi-GM routing sheets). A document is shared purely by its link
// (?signDoc=<id>); there's no inbox or notification here.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Placement = {
  id: string;
  signerName: string;
  authorityName: string | null;
  delegationNotation: "AI" | "PP" | null;
  pageNumber: number;
  signedAt: string;
};

type ChainStep = {
  approverId: string;
  approverName: string;
  status: "PENDING" | "SIGNED" | "REJECTED";
  comment: string | null;
  actedAt: string | null;
};

type DocDetail = {
  id: string;
  title: string;
  verificationCode: string;
  status: "OPEN" | "COMPLETED" | "REJECTED";
  currentStepOrder: number;
  approvalChain: ChainStep[];
  isMyTurn: boolean;
  placements: Placement[];
  closedAt?: string | null;
  closedByName?: string | null;
  canFinish?: boolean;
  canDelete?: boolean;
  canUndo?: boolean;
};

type ChainStepDraft = { approverId: string };

export default function SignRoutingDocument() {
  const me = getUserFromToken();
  // Company-wide directory, available to any authenticated user (not the
  // admin-only staff list) - matches how BRS/Custom Requests build their
  // own requester-defined approval chains, since signing a document is
  // just as ordinary a thing for a regular employee to do as an admin.
  const [companyDirectory, setCompanyDirectory] = useState<DirectoryUser[]>([]);
  useEffect(() => {
    api.requestDirectory("company").then((rows: any[]) => setCompanyDirectory(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);
  // "On behalf of" (below) excludes yourself - you can't sign under your
  // own delegated authority. The approval-route builder needs the opposite:
  // the creator may well want to include themselves as one of the signers
  // in their own routing chain, so it gets the full directory.
  const directory: DirectoryUser[] = companyDirectory.filter((s) => s.id !== me?.userId);
  const chainDirectory: DirectoryUser[] = companyDirectory;

  const [docId, setDocId] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState("");

  const [newTitle, setNewTitle] = useState("");
  // PDFs waiting to be sent, one signature request each: the form works on
  // the first, and after sending it moves on to the next.
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const newFile = newFiles[0] ?? null;
  // "Sent ..." note shown on the form after a request goes out.
  const [sentNote, setSentNote] = useState<{ id: string; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [openInput, setOpenInput] = useState("");
  const [opening, setOpening] = useState(false);

  // Optional approval route built at creation time - empty means the
  // original free-for-all behavior (anyone with the link signs, any order).
  const [chainDraft, setChainDraft] = useState<ChainStepDraft[]>([]);
  // Sign it yourself first, then it goes to the route.
  const [signFirst, setSignFirst] = useState(false);

  const [showReject, setShowReject] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const [myDocs, setMyDocs] = useState<any[]>([]);
  const [loadingMyDocs, setLoadingMyDocs] = useState(true);

  const [policy, setPolicy] = useState<{ default: "AI" | "PP"; overridable: boolean; requireImage?: boolean } | null>(null);

  // PDF rendering
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<any>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  // Canvas pixels per PDF point - sizes the signature preview's text the
  // same as the stamp (signatureStamp.ts works in points).
  const [pageScale, setPageScale] = useState(1);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(!!document.fullscreenElement);
      // The container's available width changes once it fills the whole
      // screen - re-render at that new size instead of leaving the page
      // stuck at its pre-fullscreen pixel dimensions.
      if (pdfDocRef.current) void renderPage(pdfDocRef.current, pageNum, zoom);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum, zoom]);

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await containerRef.current?.requestFullscreen();
    }
  }

  // Click mode: place a signature, or drop plain text (e.g. filling in a
  // cell by hand, a note) - same click-to-place mechanics, different form
  // and a different, non-signing endpoint underneath.
  const [placeMode, setPlaceMode] = useState<"sign" | "text" | "tick">("sign");
  // Tick tool: a tick or cross in a box, sized as a fraction of page width.
  const [tickKind, setTickKind] = useState<"CHECK" | "CROSS">("CHECK");
  const [tickSizePct, setTickSizePct] = useState(0.022);
  const [tickColor, setTickColor] = useState(TEXT_COLORS[0]);
  const [placingTick, setPlacingTick] = useState(false);
  // A signature placed but not yet sent stays put while you use the Tick or
  // Add text tools (or another page), and comes back when you return to Sign.
  const [parkedSign, setParkedSign] = useState<{ xPct: number; yPct: number; page: number } | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [textDraftSize, setTextDraftSize] = useState(14);
  const [textDraftColor, setTextDraftColor] = useState(TEXT_COLORS[0]);
  const [placingText, setPlacingText] = useState(false);

  // Placement in progress
  const [pendingClick, setPendingClick] = useState<{ xPct: number; yPct: number } | null>(null);
  // Narrower default than before (0.16) - a table cell in a typical
  // multi-column sign-off sheet is often ~100-150pt wide on an A4 page
  // (595pt), so the old default spilled into the neighboring column at the
  // slightest off-center click. Centered on click either way; the visible
  // anchor dot (see the canvas overlay below) shows exactly that point.
  const [markWidthPct, setMarkWidthPct] = useState(0.1);
  const [consentChecked, setConsentChecked] = useState(false);
  const [signMode, setSignMode] = useState<"type" | "draw" | "upload">("draw");
  // Drawn/uploaded signatures only, with a short allowance for a saved typed
  // one (see the same logic in SignDocument.tsx and claimTypedSigning).
  const [typedLeft, setTypedLeft] = useState<number | null>(null);
  const requireImage = policy?.requireImage === true;
  const typedAllowed = !requireImage || (typedLeft ?? 0) > 0;
  // A picture of the signature someone uploaded (see SignatureUpload).
  const [uploadedDataUrl, setUploadedDataUrl] = useState<string | null>(null);
  const [typedName, setTypedName] = useState(me?.fullName || "");
  const [drawnDataUrl, setDrawnDataUrl] = useState<string | null>(null);
  const sigImage = signMode === "draw" ? drawnDataUrl : signMode === "upload" ? uploadedDataUrl : null;
  const [canvasSeed, setCanvasSeed] = useState<string | null>(null);
  const [rememberSignature, setRememberSignature] = useState(true);
  const [onBehalfOf, setOnBehalfOf] = useState(false);
  const [authorityUserId, setAuthorityUserId] = useState("");
  const [requestedNotation, setRequestedNotation] = useState<"AI" | "PP">("PP");
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState("");

  const loadMyDocs = useCallback(async () => {
    setLoadingMyDocs(true);
    try {
      const resp = await api.mySignableDocuments();
      setMyDocs(Array.isArray(resp?.items) ? resp.items : []);
    } catch {
      // non-critical
    } finally {
      setLoadingMyDocs(false);
    }
  }, []);

  useEffect(() => {
    void loadMyDocs();
    api.signatureNotationPolicy().then((p) => setPolicy(p)).catch(() => {});
    api.mySavedSignature().then((saved) => {
      if (!saved) return;
      const left: number | null = saved.typedSigningsLeft ?? null;
      setTypedLeft(left);
      setSignMode(saved.signatureType === "type" && left !== 0 ? "type" : "draw");
      if (saved.signatureType === "type") setTypedName(saved.typedName || me?.fullName || "");
      if (saved.signatureType === "draw" && saved.imageDataUrl) {
        setDrawnDataUrl(saved.imageDataUrl);
        setCanvasSeed(saved.imageDataUrl);
      }
    }).catch(() => {});
    // Pre-fill from a shared link or an Inbox handoff, but don't open it
    // automatically - the person should choose to, not have it happen to
    // them the moment the page loads.
    const fromLink = new URLSearchParams(window.location.search).get("signDoc");
    if (fromLink) {
      setOpenInput(fromLink);
      const url = new URL(window.location.href);
      url.searchParams.delete("signDoc");
      window.history.replaceState(window.history.state, "", url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadMyDocs]);

  async function loadPdfIntoCanvas(blob: Blob, page: number) {
    setPdfBusy(true);
    try {
      const buf = await blob.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      pdfDocRef.current = pdf;
      setNumPages(pdf.numPages);
      await renderPage(pdf, Math.min(page, pdf.numPages));
    } finally {
      setPdfBusy(false);
    }
  }

  // The canvas's CSS box can otherwise be stretched or squeezed away from
  // its own internal pixel width/height by the surrounding flex/grid layout
  // (a scrollbar appearing once a tall page overflows, a window resize, a
  // layout race right after the document opens) - when that happens,
  // getBoundingClientRect() reports a box that no longer matches what the
  // canvas was actually rendered at, so xPct/yPct silently stop landing
  // where they visually appear to. Widening the viewer made this far more
  // likely to actually trigger (bigger canvases cross the
  // "now needs a scrollbar" threshold much more often). renderPage below
  // pins canvas.style.width/height to its own pixel size directly via the
  // ref, so the browser can never silently rescale it out from under the
  // click math, and the ResizeObserver further down re-renders at the
  // correct size if the container's true width ever drifts from that.
  const renderTaskRef: RenderTaskRef = useRef(null);
  async function renderPage(pdf: any, page: number, zoomOverride?: number) {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !pdf) return;
    const pdfPage = await pdf.getPage(page);
    const unscaled = pdfPage.getViewport({ scale: 1 });
    // Fills the available container width by default (reading a dense,
    // multi-page document needs real size, not a small fixed preview) -
    // the zoom control on top lets someone go further still.
    const targetWidth = Math.min(container.clientWidth || 1000, 1500) * (zoomOverride ?? zoom);
    const scale = targetWidth / unscaled.width;
    const viewport = pdfPage.getViewport({ scale });
    setCanvasSize({ width: viewport.width, height: viewport.height });
    setPageScale(scale);
    // One drawing at a time - overlapping renders flip the page.
    if (!(await renderPdfPage(pdfPage, canvas, viewport, renderTaskRef))) return;
    setPageNum(page);
  }

  async function goToPage(page: number) {
    if (!pdfDocRef.current || page < 1 || page > numPages) return;
    if (placeMode === "sign" && pendingClick) setParkedSign({ ...pendingClick, page: pageNum });
    setPendingClick(null);
    await renderPage(pdfDocRef.current, page);
    if (placeMode === "sign" && parkedSign && parkedSign.page === page) { setPendingClick({ xPct: parkedSign.xPct, yPct: parkedSign.yPct }); setParkedSign(null); }
  }

  async function switchTool(next: "sign" | "text" | "tick") {
    if (next === placeMode) return;
    if (placeMode === "sign" && pendingClick) setParkedSign({ ...pendingClick, page: pageNum });
    setPendingClick(null);
    setPlaceMode(next);
    if (next === "sign" && parkedSign) {
      if (parkedSign.page !== pageNum && pdfDocRef.current) await renderPage(pdfDocRef.current, parkedSign.page);
      setPendingClick({ xPct: parkedSign.xPct, yPct: parkedSign.yPct });
      setParkedSign(null);
    }
  }

  async function changeZoom(next: number) {
    const clamped = Math.min(2.5, Math.max(0.5, Math.round(next * 20) / 20));
    setZoom(clamped);
    if (pdfDocRef.current) {
      setPendingClick(null);
      await renderPage(pdfDocRef.current, pageNum, clamped);
    }
  }

  // Self-corrects for exactly the failure mode described above: if the
  // container's real width ever drifts from what the canvas was sized for
  // (a scrollbar appearing, a window resize, any layout settling after the
  // fact), re-render at the new true size instead of leaving a mismatch
  // for click math to silently inherit.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let lastWidth = container.clientWidth;
    const observer = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el || !pdfDocRef.current) return;
      const width = el.clientWidth;
      if (Math.abs(width - lastWidth) < 2) return;
      lastWidth = width;
      setPendingClick(null);
      void renderPage(pdfDocRef.current, pageNum, zoom);
    });
    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, pageNum, zoom]);

  async function openDocument(idOrLink: string) {
    const match = UUID_RE.exec(idOrLink);
    const id = match ? match[0] : idOrLink.trim();
    if (!id) return;
    setDocError("");
    setOpening(true);
    setDocLoading(true);
    try {
      const [detail, blob] = await Promise.all([api.signableDocument(id), api.signableDocumentFileBlob(id)]);
      setDocId(id);
      setDoc(detail);
      setPendingClick(null);
      setZoom(1);
      setPlaceMode("sign");
      await loadPdfIntoCanvas(blob, 1);
    } catch (e: any) {
      setDocError(e.message || "Couldn't open that document.");
      setDocId(null);
      setDoc(null);
    } finally {
      setOpening(false);
      setDocLoading(false);
    }
  }

  async function refreshCurrentDocument() {
    if (!docId) return;
    setDocLoading(true);
    try {
      const [detail, blob] = await Promise.all([api.signableDocument(docId), api.signableDocumentFileBlob(docId)]);
      setDoc(detail);
      await loadPdfIntoCanvas(blob, pageNum);
    } finally {
      setDocLoading(false);
    }
  }

  function addChainStep() {
    setChainDraft((c) => [...c, { approverId: "" }]);
  }
  function updateChainStep(idx: number, approverId: string) {
    setChainDraft((c) => c.map((s, i) => (i === idx ? { approverId } : s)));
  }
  function removeChainStep(idx: number) {
    setChainDraft((c) => c.filter((_, i) => i !== idx));
  }
  function moveChainStep(idx: number, dir: -1 | 1) {
    setChainDraft((c) => {
      const next = [...c];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return c;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }

  function titleFromFile(f: File) {
    return f.name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim();
  }

  // Add chosen PDFs to the queue (several at once is fine). The first one's
  // file name becomes the title if none is typed yet.
  function addFiles(list: FileList | null) {
    const picked = Array.from(list || []).filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!picked.length) return;
    setSentNote(null);
    const next = [...newFiles, ...picked.filter((f) => !newFiles.some((p) => p.name === f.name && p.size === f.size))];
    if (!newFiles.length && !newTitle.trim() && next[0]) setNewTitle(titleFromFile(next[0]));
    setNewFiles(next);
  }

  function removeQueuedFile(idx: number) {
    const next = newFiles.filter((_, i) => i !== idx);
    if (idx === 0) setNewTitle(next[0] ? titleFromFile(next[0]) : "");
    setNewFiles(next);
  }

  async function handleCreate() {
    setDocError("");
    if (!newFile) { setDocError("Choose a PDF to start."); return; }
    if (!newTitle.trim()) { setDocError("Give this document a title."); return; }
    const chain = chainDraft.filter((s) => s.approverId);
    if (chainDraft.some((s) => !s.approverId)) { setDocError("Every approval step needs an approver selected (or remove the empty row)."); return; }
    if (signFirst && chain.length === 0) { setDocError("Add at least one approver to send it to after you sign."); return; }
    setCreating(true);
    try {
      const form = new FormData();
      form.append("file", newFile);
      form.append("title", newTitle.trim());
      if (chain.length > 0) form.append("approvalChain", JSON.stringify(chain));
      if (chain.length > 0 && signFirst) form.append("signFirst", "true");
      const resp = await api.createSignableDocument(form);
      const sentTitle = newTitle.trim();
      const firstApprover = chain.length ? chainDirectory.find((u) => u.id === chain[0].approverId)?.full_name : null;
      setSentNote({
        id: resp.id,
        text: signFirst
          ? `Started “${sentTitle}” - sign it now, then Sign & send passes it on.`
          : chain.length
            ? `Sent “${sentTitle}” - it's waiting on ${firstApprover || "the first approver"}.`
            : `Started “${sentTitle}” - anyone with its link can sign it. Open it to copy the link.`
      });
      // Move on to the next PDF. Its route starts as the same people - most
      // batches go to the same approvers - and can be changed before sending.
      const rest = newFiles.slice(1);
      setNewFiles(rest);
      setNewTitle(rest[0] ? titleFromFile(rest[0]) : "");
      if (!rest.length) { setChainDraft([]); setSignFirst(false); }
      await loadMyDocs();
      // Only "I'll sign it first" needs the sender inside the document right away.
      if (signFirst) await openDocument(resp.id);
    } catch (e: any) {
      setDocError(e.message || "Failed to start document.");
    } finally {
      setCreating(false);
    }
  }

  const [finishing, setFinishing] = useState(false);
  async function handleFinish() {
    if (!docId) return;
    const signedCount = doc?.placements.length ?? 0;
    const ok = await confirmAction({
      title: "Finish signing?",
      text: `${signedCount} signature${signedCount === 1 ? "" : "s"} so far. After this nobody can sign or add to the document — it's completed for good.`,
      confirmButtonText: "Finish signing"
    });
    if (!ok) return;
    setFinishing(true);
    try {
      await api.finishSignableDocument(docId);
      setPendingClick(null);
      await refreshCurrentDocument();
      await loadMyDocs();
    } catch (e: any) {
      setPlaceError(e.message || "Couldn't finish signing.");
    } finally {
      setFinishing(false);
    }
  }

  async function handleReject() {
    if (!docId) return;
    if (!rejectComment.trim()) { setPlaceError("Say why you're rejecting this document."); return; }
    setRejecting(true);
    try {
      await api.rejectSignableDocument(docId, rejectComment.trim());
      setShowReject(false);
      setRejectComment("");
      await refreshCurrentDocument();
      await loadMyDocs();
    } catch (e: any) {
      setPlaceError(e.message || "Failed to reject document.");
    } finally {
      setRejecting(false);
    }
  }

  function pctFromClientPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      xPct: Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1),
      yPct: Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1)
    };
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!canAct) return;
    const pt = pctFromClientPoint(e.clientX, e.clientY);
    if (!pt) return;
    if (placeMode === "tick" && canvasSize.width) {
      // Centred on the click - you click inside the box you want ticked.
      const w = tickSizePct, h = (tickSizePct * canvasSize.width) / canvasSize.height;
      setPendingClick({ xPct: Math.min(Math.max(pt.xPct - w / 2, 0), 1 - w), yPct: Math.min(Math.max(pt.yPct - h / 2, 0), 1 - h) });
    } else if (placeMode === "sign" && canvasSize.width) {
      const boxH = (markWidthPct * canvasSize.width / 2.6) / canvasSize.height;
      setPendingClick({ xPct: Math.min(pt.xPct, 1 - markWidthPct), yPct: Math.min(pt.yPct, 1 - boxH) });
    } else {
      setPendingClick(pt);
    }
    setPlaceError("");
  }

  // Click gets you close; dragging the marker afterwards gets it exact -
  // repeated reports that a single click never quite lands where expected
  // (screen/PDF coordinate conversion has enough moving parts - zoom,
  // scroll, box size vs. anchor point - that pixel-perfect click precision
  // alone isn't a reliable bar to hold this to) mean direct, visual
  // adjustment beats trying to make the click itself flawless.
  const draggingRef = useRef(false);
  function startDrag(e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!pendingClick) return;
    const start = pctFromClientPoint(e.clientX, e.clientY);
    if (!start) return;
    // Keep the point you grabbed under the pointer, instead of jumping the
    // box's corner to it.
    const offset = { x: start.xPct - pendingClick.xPct, y: start.yPct - pendingClick.yPct };
    const signing = placeMode === "sign" && canvasSize.width > 0;
    const ticking = placeMode === "tick" && canvasSize.width > 0;
    const maxX = signing ? 1 - markWidthPct : ticking ? 1 - tickSizePct : 1;
    const maxY = signing ? 1 - (markWidthPct * canvasSize.width / 2.6) / canvasSize.height : ticking ? 1 - (tickSizePct * canvasSize.width) / canvasSize.height : 1;
    draggingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const pt = pctFromClientPoint(ev.clientX, ev.clientY);
      if (pt) setPendingClick({ xPct: Math.min(Math.max(pt.xPct - offset.x, 0), maxX), yPct: Math.min(Math.max(pt.yPct - offset.y, 0), maxY) });
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // "Place on page" without clicking: drop it in the middle of what's on screen.
  function placeInView() {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !canvasSize.width) return;
    const rect = canvas.getBoundingClientRect();
    const view = container.getBoundingClientRect();
    const midY = (Math.max(rect.top, view.top) + Math.min(rect.bottom, view.bottom)) / 2;
    const boxH = (markWidthPct * canvasSize.width / 2.6) / canvasSize.height;
    setPendingClick({
      xPct: Math.min(Math.max(0.5 - markWidthPct / 2, 0), 1 - markWidthPct),
      yPct: Math.min(Math.max((midY - rect.top) / rect.height - boxH / 2, 0), 1 - boxH)
    });
    setPlaceError("");
  }

  async function handlePlace() {
    setPlaceError("");
    if (!docId || !pendingClick) return;
    if (!consentChecked) { setPlaceError("You must confirm consent to sign electronically."); return; }
    if (signMode === "type" && !typedName.trim()) { setPlaceError("Type your name to sign."); return; }
    if (signMode === "draw" && !drawnDataUrl) { setPlaceError("Draw your signature."); return; }
    if (signMode === "upload" && !uploadedDataUrl) { setPlaceError("Upload a picture of your signature."); return; }
    if (onBehalfOf && !authorityUserId) { setPlaceError("Choose whose authority you're signing under."); return; }

    const consentStatement = `I, ${me?.fullName || "the signer"}, confirm this is my legal signature and I consent to sign this document electronically on ${new Date().toLocaleDateString("en-GB")}.`;

    setPlacing(true);
    try {
      const placed = await api.signPlacement(docId, {
        consentStatement,
        pageNumber: pageNum,
        xPct: pendingClick.xPct,
        yPct: pendingClick.yPct,
        widthPct: markWidthPct,
        typedSignatureText: signMode === "type" ? typedName.trim() : undefined,
        signatureImageDataUrl: signMode !== "type" && sigImage ? sigImage : undefined,
        authorityUserId: onBehalfOf ? authorityUserId : undefined,
        requestedNotation: onBehalfOf && policy?.overridable ? requestedNotation : undefined
      });
      if (placed?.typedSigningsLeft !== undefined) {
        setTypedLeft(placed.typedSigningsLeft);
        if (placed.typedSigningsLeft === 0) {
          setSignMode("draw");
          void Swal.fire({ icon: "info", title: "That was your last typed signature", text: "Next time, draw or upload your signature to sign." });
        }
      }
      if (rememberSignature && !(signMode === "type" && requireImage)) {
        await api.saveMySavedSignature({
          signatureType: signMode === "type" ? "type" : "draw",
          typedName: signMode === "type" ? typedName.trim() : null,
          imageDataUrl: signMode === "type" ? null : sigImage
        }).catch(() => {});
      }
      setPendingClick(null);
      setConsentChecked(false);
      setOnBehalfOf(false);
      setAuthorityUserId("");
      await refreshCurrentDocument();
    } catch (e: any) {
      setPlaceError(e.message || "Failed to place signature.");
    } finally {
      setPlacing(false);
    }
  }

  async function handlePlaceTick() {
    setPlaceError("");
    if (!docId || !pendingClick) return;
    setPlacingTick(true);
    try {
      await api.annotateTickSignableDocument(docId, {
        pageNumber: pageNum, xPct: pendingClick.xPct, yPct: pendingClick.yPct,
        sizePct: tickSizePct, kind: tickKind, color: tickColor
      });
      setPendingClick(null);
      await refreshCurrentDocument();
    } catch (e: any) {
      setPlaceError(e.message || "Failed to add the tick.");
    } finally {
      setPlacingTick(false);
    }
  }

  const [undoing, setUndoing] = useState(false);
  async function handleUndo() {
    if (!docId) return;
    setUndoing(true);
    setPlaceError("");
    try {
      await api.undoSignableDocument(docId);
      await refreshCurrentDocument();
    } catch (e: any) {
      setPlaceError(e.message || "Couldn't undo.");
    } finally {
      setUndoing(false);
    }
  }

  async function handleDelete(id: string, title: string) {
    const { value: reason, isConfirmed } = await Swal.fire({
      title: `Delete "${title}"?`,
      text: "It's removed for everyone on the route and can't be signed any more. It's kept in the audit log with your reason.",
      input: "textarea",
      inputPlaceholder: "Why are you deleting it?",
      inputValidator: (v: string) => (!v || !v.trim() ? "Please give a reason." : undefined),
      showCancelButton: true,
      confirmButtonText: "Delete",
      confirmButtonColor: "#dc2626",
      reverseButtons: true,
      focusCancel: true
    });
    if (!isConfirmed || !reason) return;
    try {
      await api.deleteSignableDocument(id, String(reason).trim());
      if (docId === id) { setDocId(null); setDoc(null); pdfDocRef.current = null; }
      await loadMyDocs();
    } catch (e: any) {
      void Swal.fire({ icon: "error", title: "Couldn't delete", text: e.message || "Please try again." });
    }
  }

  async function handlePlaceText() {
    setPlaceError("");
    if (!docId || !pendingClick) return;
    if (!textDraft.trim()) { setPlaceError("Type some text first."); return; }
    setPlacingText(true);
    try {
      await api.annotateSignableDocument(docId, {
        pageNumber: pageNum, xPct: pendingClick.xPct, yPct: pendingClick.yPct,
        text: textDraft.replace(/\s+$/, ""), fontSize: textDraftSize, color: textDraftColor
      });
      setPendingClick(null);
      setTextDraft("");
      await refreshCurrentDocument();
    } catch (e: any) {
      setPlaceError(e.message || "Failed to add text.");
    } finally {
      setPlacingText(false);
    }
  }

  function shareLink(id: string) {
    return `${window.location.origin}${window.location.pathname}?signDoc=${id}`;
  }

  // Available at any stage - not signed yet, partway through the route, or
  // finished - it always downloads whatever the current copy looks like.
  async function handleDownload(id: string, title: string) {
    await downloadBlob(() => api.signableDocumentFileBlob(id), `${title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "document"}.pdf`);
  }

  // Sized in exact pixels computed in JS - not CSS width:% + aspect-ratio,
  // which leaves the actual box dimensions up to the browser's own
  // percentage/aspect-ratio rounding and interaction with border-box
  // sizing. Mirroring stampSignatureMarkAtPosition's own arithmetic
  // (signatureStamp.ts) directly here - boxWidth = widthPct * pageWidth,
  // boxHeight = boxWidth / 2.6, both converted to canvas pixels via the
  // same scale already used to render the page - removes any gap between
  // what this preview shows and what actually gets stamped.
  const sigAt = placeMode === "sign" ? pendingClick : (parkedSign && parkedSign.page === pageNum ? parkedSign : null);
  const sigParked = placeMode !== "sign";
  const markBoxStyle: React.CSSProperties | null = sigAt && canvasSize.width
    ? (() => {
        const boxWidthPx = markWidthPct * canvasSize.width;
        const boxHeightPx = boxWidthPx / 2.6;
        return {
          position: "absolute",
          left: `${sigAt.xPct * canvasSize.width}px`,
          top: `${sigAt.yPct * canvasSize.height}px`,
          width: `${boxWidthPx}px`,
          height: `${boxHeightPx}px`,
          border: "1.5px dashed #3b82f6",
          background: "rgba(255,255,255,0.55)",
          boxShadow: "0 0 0 3px rgba(59,130,246,0.18)",
          cursor: sigParked ? "default" : "grab",
          opacity: sigParked ? 0.6 : 1,
          pointerEvents: sigParked ? "none" : "auto",
          touchAction: "none",
          borderRadius: 2,
          overflow: "hidden",
          zIndex: 2
        };
      })()
    : null;

  // A fixed-size dot exactly on the click point - draggable via a larger
  // invisible hit-area (28px) around the visible 8px dot, present in both
  // sign and text-add mode.
  const anchorDotHandleStyle: React.CSSProperties | null = pendingClick && canvasSize.width
    ? {
        position: "absolute",
        // Pixel-based, same basis as markBoxStyle above (both driven off
        // canvasSize directly) - not percentages, so the two can never
        // drift apart by a rounding pixel between them.
        left: `${pendingClick.xPct * canvasSize.width}px`,
        top: `${pendingClick.yPct * canvasSize.height}px`,
        width: 28, height: 28, marginLeft: -14, marginTop: -14,
        cursor: "grab",
        touchAction: "none",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 2
      }
    : null;

  const activeNotation = onBehalfOf ? (policy?.overridable ? requestedNotation : policy?.default) : null;
  const hasChain = Boolean(doc?.approvalChain?.length);
  // A document with no route is open until its creator finishes it.
  const canAct = Boolean(doc) && doc!.status === "OPEN" && (!hasChain || doc!.isMyTurn);
  const currentApproverName = hasChain && doc!.status === "OPEN" ? doc!.approvalChain[doc!.currentStepOrder]?.approverName : null;

  return (
    <div>
      {!docId ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
              <FilePlus2 size={16} /> Request a signature
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="Title">
                <input style={fieldStyle} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. GM Sign-off Sheet — April 2026" />
              </Field>
              <Field label={newFiles.length > 1 ? `PDF file (1 of ${newFiles.length})` : "PDF file"}>
                <label style={{
                  ...fieldStyle, display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                  border: newFile ? "1px solid #34d399" : "1px dashed var(--border)",
                  background: newFile ? "#ecfdf5" : "var(--surface-soft)"
                }} title="Choose one or more PDFs - each becomes its own signature request">
                  {newFile ? <CheckCircle2 size={14} color="#059669" /> : <Upload size={14} />}
                  <span style={{ flex: 1, color: newFile ? "#065f46" : "inherit", fontWeight: newFile ? 600 : 400 }}>
                    {newFile ? `${newFile.name} (${(newFile.size / 1024).toFixed(0)} KB) — attached` : "Choose one or more PDFs…"}
                  </span>
                  <input type="file" accept="application/pdf" multiple style={{ display: "none" }}
                    onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
                </label>
                {newFile && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, fontSize: 11.5, color: "var(--muted)" }}>
                    <span>{newFiles.length > 1 ? "Click above to add more PDFs." : "Click above to add more PDFs - each is sent as its own request."}</span>
                    <button type="button" onClick={() => removeQueuedFile(0)} style={{ border: "none", background: "none", color: "#dc2626", cursor: "pointer", fontSize: 11.5, padding: 0 }}>Remove this PDF</button>
                  </div>
                )}
                {newFiles.length > 1 && (
                  <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--muted)" }}>
                    Next, each as its own request:
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                      {newFiles.slice(1).map((f, i) => (
                        <span key={`${f.name}-${f.size}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 6px 3px 9px", borderRadius: 99, background: "var(--surface-soft)", border: "1px solid var(--border)", color: "var(--text)" }}>
                          {f.name}
                          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => removeQueuedFile(i + 1)}
                            style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)", padding: 0, fontSize: 13, lineHeight: 1 }}>×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </Field>

              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, background: signFirst ? "#eff6ff" : "var(--surface-soft)", cursor: "pointer", fontSize: 12 }}>
                <input type="checkbox" checked={signFirst} onChange={(e) => setSignFirst(e.target.checked)} style={{ marginTop: 2 }} />
                <span>
                  <strong>I'll sign it first</strong>
                  <span style={{ display: "block", color: "var(--muted)", fontSize: 11, marginTop: 2 }}>
                    {signFirst
                      ? (chainDraft.some((s) => s.approverId)
                          ? `You sign before anyone else; Sign & send then passes it to ${chainDirectory.find((u) => u.id === chainDraft.find((s) => s.approverId)?.approverId)?.full_name || "the first approver"}.`
                          : "Now add the people it should go to after you sign, below.")
                      : "Tick to sign it yourself before it goes to the approvers."}
                  </span>
                </span>
              </label>

              <div>
                <label style={labelStyle}>Approval route{signFirst ? "" : " (optional)"}</label>
                <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
                  Leave empty to let anyone with the link sign, in any order. Add approvers to require them to sign in this order — each one can also reject.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {chainDraft.map((step, idx) => (
                    <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: "var(--muted)", width: 16, textAlign: "center" }}>{idx + 1}</span>
                      <div style={{ flex: 1 }}>
                        <ApproverCombobox users={chainDirectory} value={step.approverId} onChange={(id) => updateChainStep(idx, id)} />
                      </div>
                      <button type="button" onClick={() => moveChainStep(idx, -1)} disabled={idx === 0} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 4 }}><ArrowUp size={12} /></button>
                      <button type="button" onClick={() => moveChainStep(idx, 1)} disabled={idx === chainDraft.length - 1} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 4 }}><ArrowDown size={12} /></button>
                      <button type="button" onClick={() => removeChainStep(idx)} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 4, color: "#dc2626" }}><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={addChainStep} style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                  <Plus size={12} /> Add approval step
                </button>
              </div>

              <button onClick={handleCreate} disabled={creating} style={{ padding: "9px 16px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, opacity: creating ? 0.7 : 1 }}>
                {creating ? "Sending…" : signFirst ? "Start & sign" : chainDraft.some((s) => s.approverId) ? "Send for signing" : "Start"}
                {!creating && newFiles.length > 1 ? ` · then the next PDF (${newFiles.length - 1} left)` : ""}
              </button>
              {sentNote && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 7, background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", fontSize: 12 }}>
                  <CheckCircle2 size={14} />
                  <span style={{ flex: 1 }}>{sentNote.text}{newFile ? ` Next: ${newFile.name}.` : ""}</span>
                  <button type="button" onClick={() => void openDocument(sentNote.id)} style={{ border: "1px solid #a7f3d0", background: "#fff", color: "#065f46", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 11.5 }}>Open it</button>
                </div>
              )}
            </div>
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
              <FolderOpen size={16} /> Open a shared document
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="Paste the link or document ID someone shared with you">
                <input style={fieldStyle} value={openInput} onChange={(e) => setOpenInput(e.target.value)} placeholder="https://…/?signDoc=… or the document ID" />
              </Field>
              <button onClick={() => void openDocument(openInput)} disabled={opening || !openInput.trim()} style={{ padding: "9px 16px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 13, fontWeight: 600, opacity: opening ? 0.7 : 1 }}>
                {opening ? "Opening…" : "Open document"}
              </button>
            </div>
          </div>

          {docError && <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#dc2626" }}>{docError}</div>}

          <div style={{ gridColumn: "1 / -1", marginTop: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", marginBottom: 10 }}>Your signature requests</div>
            {loadingMyDocs ? (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading…</div>
            ) : myDocs.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>None yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {myDocs.map((d) => (
                  <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
                        {d.title}{d.created_by_me ? "" : " (shared with you)"}
                        {d.is_my_turn && <span style={{ fontSize: 10, fontWeight: 700, color: "#1d4ed8", background: "#eff6ff", padding: "2px 7px", borderRadius: 10 }}>AWAITING YOU</span>}
                        {d.status === "REJECTED" && <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", background: "#fef2f2", padding: "2px 7px", borderRadius: 10 }}>REJECTED</span>}
                        {d.status === "COMPLETED" && <span style={{ fontSize: 10, fontWeight: 700, color: "#059669", background: "#ecfdf5", padding: "2px 7px", borderRadius: 10 }}>COMPLETED</span>}
                        {d.my_signed_at && <span style={{ fontSize: 10, fontWeight: 700, color: "#6d28d9", background: "#f5f3ff", padding: "2px 7px", borderRadius: 10 }}>SIGNED BY YOU</span>}
                      </div>
                      {d.status === "REJECTED" && (() => {
                        const step = (Array.isArray(d.approval_chain) ? d.approval_chain : []).find((x: any) => x.status === "REJECTED");
                        return step ? <div style={{ fontSize: 11.5, color: "#b91c1c", marginTop: 2 }}>Rejected by {step.approver_name}{step.comment ? `: "${step.comment}"` : ""}</div> : null;
                      })()}
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>
                        {new Date(d.updated_at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                        {d.my_signed_at ? ` · you signed ${new Date(d.my_signed_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                      </div>
                    </div>
                    <button onClick={() => void handleDownload(d.id, d.title)} title="Download current copy" style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                      <Download size={12} />
                    </button>
                    {d.created_by_me && (
                      <button onClick={() => void handleDelete(d.id, d.title)} title="Delete this document" style={{ display: "flex", alignItems: "center", padding: "6px 10px", border: "1px solid #fecaca", borderRadius: 6, background: "#fef2f2", color: "#dc2626", cursor: "pointer", fontSize: 12 }}>
                        <Trash2 size={12} />
                      </button>
                    )}
                    <button onClick={() => void openDocument(d.id)} style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                      Open
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
                {doc?.title}
                {doc?.status === "REJECTED" && <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", background: "#fef2f2", padding: "2px 7px", borderRadius: 10 }}>REJECTED</span>}
                {doc?.status === "COMPLETED" && <span style={{ fontSize: 10, fontWeight: 700, color: "#059669", background: "#ecfdf5", padding: "2px 7px", borderRadius: 10 }}>COMPLETED</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Verify code: <code>{doc?.verificationCode}</code></div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => void handleDownload(doc?.id || docId, doc?.title || "document")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                <Download size={13} /> Download
              </button>
              <button onClick={() => { navigator.clipboard?.writeText(shareLink(docId)).catch(() => {}); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                <Share2 size={13} /> Copy shareable link
              </button>
              {doc?.canFinish && (
                <button onClick={() => void handleFinish()} disabled={finishing} title="Stop anyone else signing; the document is completed"
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "none", borderRadius: 7, background: "#059669", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: finishing ? 0.7 : 1 }}>
                  <CheckCircle2 size={13} /> {finishing ? "Finishing…" : "Finish signing"}
                </button>
              )}
              {doc?.canUndo && (
                <button onClick={() => void handleUndo()} disabled={undoing} title="Take back your last text or tick"
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12, opacity: undoing ? 0.6 : 1 }}>
                  <Undo2 size={13} /> {undoing ? "Undoing…" : "Undo"}
                </button>
              )}
              {doc?.canDelete && (
                <button onClick={() => void handleDelete(doc.id, doc.title)} title="Delete this document"
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid #fecaca", borderRadius: 7, background: "#fef2f2", color: "#dc2626", cursor: "pointer", fontSize: 12 }}>
                  <Trash2 size={13} /> Delete
                </button>
              )}
              <button onClick={() => { setDocId(null); setDoc(null); pdfDocRef.current = null; }} style={{ padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                Back
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(260px, 320px)", gap: 16, alignItems: "start" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)", marginBottom: 8, flexWrap: "wrap" }}>
                <MousePointerClick size={13} />
                {canAct ? (placeMode === "sign" ? (pendingClick ? "Drag your signature to the right spot, then press Sign & send" : "Click on the page to place your signature") : placeMode === "tick" ? (pendingClick ? "Drag the tick into the box if needed, then press Add tick" : "Click the box you want to tick") : "Click on the page to add text") : doc?.status === "REJECTED" ? "This document was rejected" : doc?.status === "COMPLETED" ? (hasChain ? "Every approver has signed" : "Signing finished") : `Awaiting ${currentApproverName || "the next approver"}'s signature`}
                {canAct && (
                  <span style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => void switchTool("sign")} title="Sign" style={{ border: placeMode === "sign" ? "1px solid #3b82f6" : "1px solid var(--border)", borderRadius: 5, background: placeMode === "sign" ? "#eff6ff" : "var(--surface-soft)", color: placeMode === "sign" ? "#1d4ed8" : "var(--text)", cursor: "pointer", padding: "3px 6px", display: "flex", alignItems: "center" }}><PenLine size={13} /></button>
                    <button onClick={() => void switchTool("tick")} title="Tick a box" style={{ border: placeMode === "tick" ? "1px solid #3b82f6" : "1px solid var(--border)", borderRadius: 5, background: placeMode === "tick" ? "#eff6ff" : "var(--surface-soft)", color: placeMode === "tick" ? "#1d4ed8" : "var(--text)", cursor: "pointer", padding: "3px 6px", display: "flex", alignItems: "center" }}><SquareCheck size={13} /></button>
                    <button onClick={() => void switchTool("text")} title="Add text" style={{ border: placeMode === "text" ? "1px solid #3b82f6" : "1px solid var(--border)", borderRadius: 5, background: placeMode === "text" ? "#eff6ff" : "var(--surface-soft)", color: placeMode === "text" ? "#1d4ed8" : "var(--text)", cursor: "pointer", padding: "3px 6px", display: "flex", alignItems: "center" }}><Type size={13} /></button>
                  </span>
                )}
                <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => void changeZoom(zoom - 0.15)} disabled={zoom <= 0.5} title="Zoom out" style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ZoomOut size={13} /></button>
                    {Math.round(zoom * 100)}%
                    <button onClick={() => void changeZoom(zoom + 0.15)} disabled={zoom >= 2.5} title="Zoom in" style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ZoomIn size={13} /></button>
                    <button onClick={() => void toggleFullscreen()} title={isFullscreen ? "Exit full screen" : "Full screen"} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}>
                      {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    </button>
                  </span>
                  {numPages > 1 && (
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button onClick={() => void goToPage(pageNum - 1)} disabled={pageNum <= 1} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ChevronLeft size={13} /></button>
                      Page {pageNum} / {numPages}
                      <button onClick={() => void goToPage(pageNum + 1)} disabled={pageNum >= numPages} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-soft)", cursor: "pointer", padding: 3 }}><ChevronRight size={13} /></button>
                    </span>
                  )}
                </span>
              </div>
              {doc?.status === "REJECTED" && (() => {
                const step = doc.approvalChain.find((x) => x.status === "REJECTED");
                if (!step) return null;
                return (
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", marginBottom: 10, border: "1px solid #fecaca", borderRadius: 8, background: "#fef2f2", color: "#7f1d1d" }}>
                    <Ban size={16} color="#dc2626" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 13 }}>
                      <strong>Rejected by {step.approverName}</strong>{step.actedAt ? ` on ${new Date(step.actedAt).toLocaleDateString("en-GB")}` : ""}
                      {step.comment && <div style={{ marginTop: 3, whiteSpace: "pre-wrap" }}>Reason: {step.comment}</div>}
                    </div>
                  </div>
                );
              })()}
              <div ref={containerRef} style={{ position: "relative", border: "1px solid var(--border)", borderRadius: 8, overflow: "auto", maxHeight: isFullscreen ? "100vh" : "80vh", background: "#525659", display: "flex", justifyContent: "center", opacity: pdfBusy || docLoading ? 0.6 : 1 }}>
                <div style={{ position: "relative" }}>
                  <canvas ref={canvasRef} onClick={handleCanvasClick} style={{ cursor: canAct ? "crosshair" : "default", display: "block" }} />
                  {markBoxStyle && (() => {
                    // Same layout as the stamp (signatureStamp.ts): name strip 24%,
                    // signature 56%, date strip 20%, sizes in PDF points x page scale.
                    const boxW = markWidthPct * canvasSize.width;
                    const boxH = boxW / 2.6;
                    const nameH = boxH * 0.24, dateH = boxH * 0.2, markH = boxH - nameH - dateH;
                    const nameSize = Math.min(nameH * 0.8, 9 * pageScale);
                    const sigSize = Math.min(markH * 0.7, 20 * pageScale);
                    const dateSize = Math.min(dateH * 0.85, 7.5 * pageScale);
                    const name = `${me?.fullName || "Your name"}${onBehalfOf && activeNotation ? ` (${activeNotation === "AI" ? "a.i." : "p.p."})` : ""}`;
                    return (
                      <div style={markBoxStyle} onPointerDown={sigParked ? undefined : startDrag} title={sigParked ? "Your signature - go back to Sign to move it or send it" : "Drag to move your signature"}>
                        <div style={{ height: nameH, fontFamily: "Helvetica, Arial, sans-serif", fontWeight: 700, fontSize: nameSize, lineHeight: `${nameH}px`, color: "#1c296b", whiteSpace: "nowrap", pointerEvents: "none" }}>{name}</div>
                        <div style={{ height: markH, display: "flex", alignItems: "center", justifyContent: signMode !== "type" ? "center" : "flex-start", pointerEvents: "none" }}>
                          {signMode !== "type"
                            ? (sigImage ? <img src={sigImage} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} draggable={false} /> : <span style={{ fontSize: Math.max(sigSize * 0.5, 9), color: "#64748b" }}>{signMode === "upload" ? "Upload your signature →" : "Draw your signature →"}</span>)
                            : <span style={{ fontFamily: "Helvetica, Arial, sans-serif", fontWeight: 700, fontSize: sigSize, color: typedName.trim() ? "#1c296b" : "#94a3b8", whiteSpace: "nowrap" }}>{typedName.trim() || "Your signature"}</span>}
                        </div>
                        <div style={{ height: dateH, fontFamily: "Helvetica, Arial, sans-serif", fontSize: dateSize, lineHeight: `${dateH}px`, color: "#737373", pointerEvents: "none" }}>{new Date().toLocaleDateString("en-GB")}</div>
                      </div>
                    );
                  })()}
                  {pendingClick && placeMode === "tick" && canvasSize.width > 0 && (() => {
                    const px = tickSizePct * canvasSize.width;
                    // Same geometry as stampTickMarks (textAnnotate.ts).
                    const lines = tickKind === "CHECK" ? "M14 54 L40 80 L88 18" : "M20 20 L80 80 M80 20 L20 80";
                    return (
                      <div onPointerDown={startDrag} title="Drag to move the tick"
                        style={{ position: "absolute", left: pendingClick.xPct * canvasSize.width, top: pendingClick.yPct * canvasSize.height, width: px, height: px, cursor: "grab", touchAction: "none", outline: "1.5px dashed #3b82f6", outlineOffset: 2, zIndex: 2 }}>
                        <svg viewBox="0 0 100 100" width={px} height={px} style={{ display: "block", pointerEvents: "none" }}>
                          <path d={lines} fill="none" stroke={tickColor} strokeWidth={13} strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                    );
                  })()}
                  {pendingClick && placeMode === "text" && canvasSize.width > 0 && (() => {
                    // Typed straight onto the page, at the size and font it's
                    // stamped in (textAnnotate.ts), so you can see the page edge.
                    const fontPx = textDraftSize * pageScale;
                    const lineH = fontPx * 1.25;
                    const lines = (textDraft || "").split("\n");
                    const w = Math.max(...lines.map((l) => textWidthPx(l, fontPx)), textDraft ? 0 : textWidthPx("Type here…", fontPx)) + 4;
                    const h = Math.max(lines.length, 1) * lineH;
                    const left = pendingClick.xPct * canvasSize.width;
                    const top = pendingClick.yPct * canvasSize.height;
                    const pastEdge = left + w - 4 > canvasSize.width || top + h > canvasSize.height;
                    const accent = pastEdge ? "#dc2626" : "#3b82f6";
                    return (
                      <div style={{ position: "absolute", left, top, zIndex: 3 }}>
                        <div onPointerDown={startDrag} title="Drag to move the text"
                          style={{ position: "absolute", left: -2, bottom: "100%", marginBottom: 3, height: 17, padding: "0 7px", background: accent, color: "#fff", fontSize: 10.5, fontWeight: 600, borderRadius: "4px 4px 0 0", cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", touchAction: "none", userSelect: "none" }}>
                          ⠿ Drag{pastEdge ? " · runs past the page edge" : ""}
                        </div>
                        <textarea
                          autoFocus
                          value={textDraft}
                          onChange={(e) => setTextDraft(e.target.value)}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void handlePlaceText(); } if (e.key === "Escape") { setPendingClick(null); setTextDraft(""); } }}
                          placeholder="Type here…"
                          wrap="off"
                          spellCheck
                          style={{ display: "block", width: w, height: h, padding: 0, margin: 0, border: "none", outline: `1.5px dashed ${accent}`, outlineOffset: 2, background: "rgba(255,255,255,0.45)", color: textDraftColor, fontFamily: "Helvetica, Arial, sans-serif", fontSize: fontPx, lineHeight: `${lineH}px`, resize: "none", overflow: "hidden", whiteSpace: "pre", boxSizing: "content-box" }}
                        />
                      </div>
                    );
                  })()}
                </div>
              </div>
              {hasChain ? (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 12, color: "var(--text)", marginBottom: 6 }}>
                    <Users size={13} /> Approval route
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {doc!.approvalChain.map((s, i) => (
                      <div key={s.approverId + i} style={{ fontSize: 12, color: i === doc!.currentStepOrder && doc!.status === "OPEN" ? "var(--text)" : "var(--muted)", display: "flex", gap: 8, fontWeight: i === doc!.currentStepOrder && doc!.status === "OPEN" ? 600 : 400 }}>
                        {s.status === "SIGNED" ? <CheckCircle2 size={13} color="#059669" /> : s.status === "REJECTED" ? <Ban size={13} color="#dc2626" /> : <Clock3 size={13} color={i === doc!.currentStepOrder && doc!.status === "OPEN" ? "#1d4ed8" : "#9ca3af"} />}
                        <span>
                          {i + 1}. {s.approverName}
                          {s.status === "SIGNED" && s.actedAt ? ` — signed ${new Date(s.actedAt).toLocaleDateString("en-GB")}` : ""}
                          {s.status === "REJECTED" ? ` — rejected${s.comment ? `: "${s.comment}"` : ""}` : ""}
                          {s.status === "PENDING" && i === doc!.currentStepOrder && doc!.status === "OPEN" ? " — awaiting signature" : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : doc && doc.placements.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 12, color: "var(--text)", marginBottom: 6 }}>
                    <Users size={13} /> Signed so far
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {doc.placements.map((p) => (
                      <div key={p.id} style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 8 }}>
                        <CheckCircle2 size={13} color="#059669" />
                        <span>{p.signerName}{p.authorityName ? ` (${p.delegationNotation === "AI" ? "a.i." : "p.p."} for ${p.authorityName})` : ""} — {new Date(p.signedAt).toLocaleDateString("en-GB")}, page {p.pageNumber}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16, position: "sticky", top: 16 }}>
              {canAct && placeMode !== "sign" && parkedSign && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", marginBottom: 12, borderRadius: 7, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 12, color: "#92400e" }}>
                  <PenLine size={13} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>Your signature is placed{parkedSign.page !== pageNum ? ` on page ${parkedSign.page}` : ""} but not sent yet.</span>
                  <button type="button" onClick={() => void switchTool("sign")} style={{ border: "1px solid #f59e0b", background: "#fff", color: "#92400e", borderRadius: 6, padding: "3px 8px", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>Back to signing</button>
                </div>
              )}
              {!canAct ? (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {doc?.status === "REJECTED" ? "This document's approval route was rejected — no further action is possible." :
                   doc?.status === "COMPLETED" && !hasChain ? `Signing was finished${doc.closedByName ? ` by ${doc.closedByName}` : ""}${doc.closedAt ? ` on ${new Date(doc.closedAt).toLocaleDateString("en-GB")}` : ""} — nobody can sign it any more. You can still download a copy.` :
                   doc?.status === "COMPLETED" ? "Every approver has signed. You can still download a copy at any time." :
                   `Waiting on ${currentApproverName || "the next approver"} to sign before this reaches you. They've been emailed.`}
                </div>
              ) : placeMode === "tick" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}><SquareCheck size={14} /> Tick a box</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>{pendingClick ? "Drag it into the box if it's not quite there, then press Add tick. Repeat for each box." : "Click the box on the page you want to tick."}</div>
                  <div>
                    <label style={labelStyle}>Mark</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      {(["CHECK", "CROSS"] as const).map((k) => (
                        <button key={k} type="button" onClick={() => setTickKind(k)} style={{ padding: "5px 12px", borderRadius: 6, fontSize: 13, cursor: "pointer", border: tickKind === k ? "1px solid #3b82f6" : "1px solid var(--border)", background: tickKind === k ? "#eff6ff" : "var(--surface-soft)", color: tickKind === k ? "#1d4ed8" : "var(--text)", fontWeight: 700 }}>
                          {k === "CHECK" ? "✓ Tick" : "✗ Cross"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Field label="Size">
                    <input type="range" min={0.012} max={0.06} step={0.002} value={tickSizePct} onChange={(e) => setTickSizePct(Number(e.target.value))} />
                  </Field>
                  <div>
                    <label style={labelStyle}>Color</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      {TEXT_COLORS.map((c) => (
                        <button key={c} onClick={() => setTickColor(c)} style={{ width: 22, height: 22, borderRadius: "50%", background: c, border: tickColor === c ? "2px solid var(--text)" : "1px solid var(--border)", cursor: "pointer" }} />
                      ))}
                    </div>
                  </div>
                  {placeError && <div style={{ fontSize: 11, color: "#dc2626" }}>{placeError}</div>}
                  {pendingClick && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => void handlePlaceTick()} disabled={placingTick} style={{ flex: 1, padding: "8px 12px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: placingTick ? 0.7 : 1 }}>
                        {placingTick ? "Adding…" : tickKind === "CHECK" ? "Add tick" : "Add cross"}
                      </button>
                      <button onClick={() => { setPendingClick(null); setPlaceError(""); }} disabled={placingTick} style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ) : placeMode === "text" && !pendingClick ? (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>Click a spot on the page to add text there.</div>
              ) : placeMode === "text" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}><Type size={14} /> Add text</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>Type in the box on the page. Drag it by its tab; it turns red if it runs past the page edge. Ctrl+Enter adds it, Esc cancels.</div>
                  <Field label="Size">
                    <input type="range" min={8} max={36} step={1} value={textDraftSize} onChange={(e) => setTextDraftSize(Number(e.target.value))} />
                  </Field>
                  <div>
                    <label style={labelStyle}>Color</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      {TEXT_COLORS.map((c) => (
                        <button key={c} onClick={() => setTextDraftColor(c)} style={{ width: 22, height: 22, borderRadius: "50%", background: c, border: textDraftColor === c ? "2px solid var(--text)" : "1px solid var(--border)", cursor: "pointer" }} />
                      ))}
                    </div>
                  </div>
                  {placeError && <div style={{ fontSize: 11, color: "#dc2626" }}>{placeError}</div>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={handlePlaceText} disabled={placingText || !textDraft.trim()} style={{ flex: 1, padding: "8px 12px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: placingText || !textDraft.trim() ? 0.7 : 1 }}>
                      {placingText ? "Adding…" : "Add text"}
                    </button>
                    <button onClick={() => { setPendingClick(null); setTextDraft(""); setPlaceError(""); }} disabled={placingText} style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 20, height: 20, borderRadius: "50%", background: pendingClick ? "#dcfce7" : "#dbeafe", color: pendingClick ? "#166534" : "#1d4ed8", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{pendingClick ? "✓" : "1"}</span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{pendingClick ? "Signature placed — drag it on the page to adjust" : "Set up your signature, then place it on the page"}</span>
                  </div>
                  <Field label="Mark size">
                    <input type="range" min={0.08} max={0.35} step={0.01} value={markWidthPct} onChange={(e) => setMarkWidthPct(Number(e.target.value))} />
                  </Field>

                  <div>
                    <label style={labelStyle}>Your signature</label>
                    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                      {(typedAllowed ? ["type", "draw", "upload"] as const : ["draw", "upload"] as const).map((m) => (
                        <button key={m} type="button" onClick={() => setSignMode(m)} style={{ padding: "5px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", border: signMode === m ? "1px solid #3b82f6" : "1px solid var(--border)", background: signMode === m ? "#eff6ff" : "var(--surface-soft)", color: signMode === m ? "#1d4ed8" : "var(--text)", fontWeight: 600 }}>
                          {m === "type" ? "Type" : m === "draw" ? "Draw" : "Upload"}
                        </button>
                      ))}
                    </div>
                    {signMode === "type" ? (
                      <>
                        <input style={{ ...fieldStyle, fontFamily: "'Brush Script MT', cursive", fontSize: 20 }} value={typedName} readOnly={requireImage} onChange={(e) => setTypedName(e.target.value)} placeholder="Your full name" />
                        {requireImage && typedLeft !== null && typedLeft > 0 && (
                          <div style={{ fontSize: 11, color: "#b45309", marginTop: 4 }}>Your saved typed signature can be used {typedLeft} more time{typedLeft === 1 ? "" : "s"}. Please draw or upload instead.</div>
                        )}
                      </>
                    ) : signMode === "draw" ? (
                      <SignatureCanvas key={canvasSeed ? "seeded" : "blank"} onChange={setDrawnDataUrl} initialDataUrl={canvasSeed} />
                    ) : (
                      <SignatureUpload value={uploadedDataUrl} onChange={setUploadedDataUrl} />
                    )}
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)", marginTop: 6, cursor: "pointer" }}>
                      <input type="checkbox" checked={rememberSignature} onChange={(e) => setRememberSignature(e.target.checked)} />
                      Remember for next time
                    </label>
                  </div>

                  <div>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, cursor: "pointer" }}>
                      <input type="checkbox" checked={onBehalfOf} onChange={(e) => setOnBehalfOf(e.target.checked)} style={{ marginTop: 2 }} />
                      Signing on behalf of someone else's authority
                    </label>
                    {onBehalfOf && (
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                        <ApproverCombobox users={directory} value={authorityUserId} onChange={setAuthorityUserId} />
                        {policy?.overridable && (
                          <select style={fieldStyle} value={requestedNotation} onChange={(e) => setRequestedNotation(e.target.value as "AI" | "PP")}>
                            <option value="AI">a.i. (ad interim)</option>
                            <option value="PP">p.p. (per procurationem)</option>
                          </select>
                        )}
                        {activeNotation && (
                          <div style={{ fontSize: 10, color: "var(--muted)" }}>
                            Reads as: {activeNotation === "AI" ? "a.i." : "p.p."} for {directory.find((u) => u.id === authorityUserId)?.full_name || "…"}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <label style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, cursor: "pointer" }}>
                    <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} style={{ marginTop: 2 }} />
                    I confirm this is my legal signature and I consent to sign electronically.
                  </label>

                  {placeError && <div style={{ fontSize: 11, color: "#dc2626" }}>{placeError}</div>}

                  {!pendingClick ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <button onClick={placeInView} style={{ padding: "8px 12px", border: "none", borderRadius: 7, background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                        Place on page
                      </button>
                      <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center" }}>…or click the spot on the page where it should go.</div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>Nothing is sent until you press {hasChain ? "Sign & send" : "Sign"}. You can still drag or resize it.</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={handlePlace} disabled={placing} style={{ flex: 1, padding: "8px 12px", border: "none", borderRadius: 7, background: "#059669", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: placing ? 0.7 : 1 }}>
                          {placing ? "Sending…" : hasChain ? "Sign & send" : "Sign"}
                        </button>
                        <button onClick={() => setPendingClick(null)} disabled={placing} style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                          Remove
                        </button>
                      </div>
                    </div>
                  )}

                  {!pendingClick && (
                    <div style={{ borderTop: hasChain ? "1px solid var(--border)" : undefined, paddingTop: hasChain ? 10 : 0 }}>
                      {hasChain && (
                    showReject ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                        <Field label="Reason for rejecting">
                          <textarea style={{ ...fieldStyle, minHeight: 60, resize: "vertical" }} value={rejectComment} onChange={(e) => setRejectComment(e.target.value)} placeholder="Explain why you're rejecting this document…" />
                        </Field>
                        {placeError && <div style={{ fontSize: 11, color: "#dc2626" }}>{placeError}</div>}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={handleReject} disabled={rejecting} style={{ flex: 1, padding: "8px 12px", border: "none", borderRadius: 7, background: "#dc2626", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: rejecting ? 0.7 : 1 }}>
                            {rejecting ? "Rejecting…" : "Confirm rejection"}
                          </button>
                          <button onClick={() => { setShowReject(false); setRejectComment(""); setPlaceError(""); }} disabled={rejecting} style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface-soft)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setShowReject(true)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 12px", border: "1px solid #fecaca", borderRadius: 7, background: "#fef2f2", color: "#dc2626", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                        <XCircle size={13} /> Reject this document
                      </button>
                    )
                  )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
