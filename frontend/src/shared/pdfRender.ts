// Draws one PDF page onto a canvas, first stopping any drawing still in
// progress on that canvas. Two pdf.js renders running on the same canvas at
// once (e.g. opening a document while a resize redraw starts) each apply
// pdf.js's own "flip to screen coordinates" transform, so the page comes out
// upside down and mirrored - seen on PROD on 22 Oct 2026.
export type RenderTaskRef = { current: { cancel: () => void; promise: Promise<unknown> } | null };

export async function renderPdfPage(pdfPage: any, canvas: HTMLCanvasElement, viewport: any, taskRef: RenderTaskRef) {
  const previous = taskRef.current;
  if (previous) {
    previous.cancel();
    try { await previous.promise; } catch { /* cancelled */ }
  }
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const task = pdfPage.render({ canvasContext: ctx, viewport });
  taskRef.current = task;
  try {
    await task.promise;
    return true;
  } catch (e: any) {
    // A newer render took over - not an error.
    if (e?.name === "RenderingCancelledException") return false;
    throw e;
  } finally {
    if (taskRef.current === task) taskRef.current = null;
  }
}
