import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, X } from "lucide-react";

// A short guided tour of a page: bubbles that point at its main buttons, one
// after the other (Next / Back / Skip). It starts by itself the first time
// someone opens the page; the "Tour" button replays it any time.
//
// A step points at a CSS selector, at the button/tab/heading whose text starts
// with `text`, or at an input by its placeholder. A step whose target isn't on
// the screen (e.g. a tab this person doesn't have) is skipped.

export type TourTarget = string | { text: string } | { placeholder: string };
export type TourStep = { target?: TourTarget; title: string; body: string };

const DONE_KEY = (id: string) => `fd.tour.${id}.v1`;
const seen = (id: string) => { try { return localStorage.getItem(DONE_KEY(id)) === "1"; } catch { return true; } };
const markSeen = (id: string) => { try { localStorage.setItem(DONE_KEY(id), "1"); } catch { /* storage off */ } };

const visible = (el: Element) => {
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
};

function findTarget(t?: TourTarget): HTMLElement | null {
  if (!t) return null;
  try {
    if (typeof t === "string") return [...document.querySelectorAll<HTMLElement>(t)].find(visible) ?? null;
    if ("placeholder" in t) return [...document.querySelectorAll<HTMLElement>("input[placeholder], textarea[placeholder]")].find((el) => visible(el) && (el.getAttribute("placeholder") || "").startsWith(t.placeholder)) ?? null;
    const want = t.text.toLowerCase();
    const els = [...document.querySelectorAll<HTMLElement>("button, a, label, h1, h2, h3, h4, summary, th, [role=tab]")]
      .filter((el) => visible(el) && !el.closest("[data-tour-ui]") && !el.closest(".sidebar, nav.sidebar-nav, aside") && (el.textContent || "").trim().replace(/\s+/g, " ").toLowerCase().startsWith(want));
    // The tightest match (the button itself, not a container around it).
    return els.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0] ?? null;
  } catch {
    return null;
  }
}

export function GuidedTour({ id, title, steps, autoStart = true }: { id: string; title: string; steps: TourStep[]; autoStart?: boolean }) {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Only the steps whose target is on screen right now (or that need none).
  const [live, setLive] = useState<TourStep[]>([]);

  const start = useCallback(() => {
    const avail = steps.filter((s) => !s.target || findTarget(s.target));
    if (!avail.length) return;
    setLive(avail);
    setI(0);
    setOpen(true);
  }, [steps]);

  useEffect(() => {
    if (!autoStart || seen(id)) return;
    // Give the page a moment to load its data and draw.
    const t = window.setTimeout(() => { if (!seen(id)) start(); }, 1200);
    return () => window.clearTimeout(t);
  }, [id, autoStart, start]);

  const step = open ? live[i] : null;

  const measure = useCallback(() => {
    const el = step ? findTarget(step.target) : null;
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return;
    const el = findTarget(step.target);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight - 40) el.scrollIntoView({ block: "center", behavior: "auto" });
    }
    measure();
    const t = window.setTimeout(measure, 120);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { window.clearTimeout(t); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [step, measure]);

  const close = useCallback(() => { markSeen(id); setOpen(false); }, [id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "Enter") setI((n) => (n + 1 < live.length ? n + 1 : (close(), n)));
      else if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, live.length, close]);

  // Bubble placement: under the target when there's room, else above; centred
  // on screen when the step has no target.
  const W = Math.min(340, window.innerWidth - 24);
  let bubble: CSSProperties = { left: (window.innerWidth - W) / 2, top: Math.max(80, window.innerHeight / 2 - 120) };
  if (rect) {
    const below = rect.bottom + 12 + 190 < window.innerHeight;
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - W / 2), window.innerWidth - W - 12);
    bubble = below ? { left, top: rect.bottom + 12 } : { left, top: Math.max(12, rect.top - 12), transform: "translateY(-100%)" };
  }
  const pad = 6;

  return (
    <>
      <button type="button" data-tour-ui onClick={start} title={`A quick tour of ${title}`}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", cursor: "pointer", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>
        <CircleHelp size={14} /> Tour
      </button>
      {open && step && createPortal(
        <div data-tour-ui role="dialog" aria-modal="true" aria-label={`${title} tour`} style={{ position: "fixed", inset: 0, zIndex: 3000 }}>
          {/* Dim everything except the spotlight; clicks outside do nothing. */}
          {rect ? (
            <div style={{ position: "fixed", left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, borderRadius: 10, boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.55)", outline: "2px solid #60a5fa", pointerEvents: "none", transition: "all .18s ease" }} />
          ) : (
            <div style={{ position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.55)" }} />
          )}
          <div style={{ position: "fixed", width: W, ...bubble, background: "var(--surface, #fff)", color: "var(--text, #111827)", border: "1px solid var(--border, #e5e7eb)", borderRadius: 12, boxShadow: "0 18px 40px rgba(0,0,0,.25)", padding: 16, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#2563eb", textTransform: "uppercase", letterSpacing: ".04em" }}>{title} · {i + 1} of {live.length}</div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{step.title}</div>
              </div>
              <button type="button" onClick={close} aria-label="Close the tour" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--muted)", padding: 2 }}><X size={16} /></button>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text)" }}>{step.body}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <div style={{ display: "flex", gap: 4, flex: 1 }}>
                {live.map((_s, n) => <span key={n} style={{ width: 6, height: 6, borderRadius: 99, background: n === i ? "#2563eb" : "var(--border, #d1d5db)" }} />)}
              </div>
              {i === 0
                ? <button type="button" className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 10px" }} onClick={close}>Skip</button>
                : <button type="button" className="ep-btn-outline" style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => setI(i - 1)}>Back</button>}
              {i + 1 < live.length
                ? <button type="button" className="ep-btn" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setI(i + 1)}>Next</button>
                : <button type="button" className="ep-btn" style={{ fontSize: 12, padding: "5px 12px" }} onClick={close}>Done</button>}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
