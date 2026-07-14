import { useEffect, useState, type RefObject } from "react";

export type TourStep = {
  target: RefObject<HTMLElement>;
  title: string;
  body: string;
};

type Props = {
  steps: TourStep[];
  storageKey: string;
  active: boolean;
};

// One-time spotlight walkthrough for first-time users. "Seen" state lives in
// localStorage (per-browser, not per-user) since it's a dismissible hint, not
// data worth round-tripping to the server.
export default function GuidedTour({ steps, storageKey, active }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === "1"; } catch { return true; }
  });

  useEffect(() => {
    if (active) setStepIndex(0);
  }, [active]);

  useEffect(() => {
    if (!active || dismissed) return;
    const step = steps[stepIndex];
    const el = step?.target.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const update = () => setRect(el.getBoundingClientRect());
    update();
    const t = setTimeout(update, 300);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
    // `steps` is deliberately excluded: callers often pass an inline array
    // literal, which would otherwise re-trigger scrollIntoView on every
    // unrelated re-render. The target ref identity is what actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, active, dismissed, steps[stepIndex]?.target]);

  if (!active || dismissed) return null;
  const step = steps[stepIndex];
  if (!step || !rect) return null;

  const finish = () => {
    try { localStorage.setItem(storageKey, "1"); } catch { /* ignore */ }
    setDismissed(true);
  };

  const pad = 6;
  const calloutWidth = 300;
  const calloutLeft = Math.max(12, Math.min(rect.left, window.innerWidth - calloutWidth - 12));
  const calloutAbove = rect.bottom + 160 > window.innerHeight;

  return (
    <div className="tour-overlay">
      <div
        className="tour-highlight"
        style={{
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2
        }}
      />
      <div
        className="tour-callout"
        style={{
          left: calloutLeft,
          width: calloutWidth,
          top: calloutAbove ? undefined : rect.bottom + 12,
          bottom: calloutAbove ? window.innerHeight - rect.top + 12 : undefined
        }}
      >
        <div className="tour-callout-step">{stepIndex + 1} of {steps.length}</div>
        <div className="tour-callout-title">{step.title}</div>
        <div className="tour-callout-body">{step.body}</div>
        <div className="tour-callout-actions">
          <button className="tour-skip" onClick={finish}>Skip tour</button>
          <div style={{ display: "flex", gap: 8 }}>
            {stepIndex > 0 && (
              <button className="tour-prev" onClick={() => setStepIndex((i) => i - 1)}>Back</button>
            )}
            {stepIndex < steps.length - 1 ? (
              <button className="tour-next" onClick={() => setStepIndex((i) => i + 1)}>Next</button>
            ) : (
              <button className="tour-next" onClick={finish}>Got it</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
