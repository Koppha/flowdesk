import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "./api";

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
// data worth blocking the UI on - but progress is also best-effort reported
// to the server (storageKey doubles as the tour_key) so an admin can see how
// far users actually get, without that report needing to be authoritative
// enough to gate anything.
export default function GuidedTour({ steps, storageKey, active }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === "1"; } catch { return true; }
  });
  const reportedStepRef = useRef(-1);

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

  // Best-effort progress ping, once per step actually reached - failures are
  // silently ignored, since a stats gap is fine but blocking the tour isn't.
  useEffect(() => {
    if (!active || dismissed || !steps.length) return;
    if (reportedStepRef.current === stepIndex) return;
    reportedStepRef.current = stepIndex;
    void api.reportTourProgress({ tour_key: storageKey, step_index: stepIndex, total_steps: steps.length }).catch(() => {});
  }, [active, dismissed, stepIndex, steps.length, storageKey]);

  if (!active || dismissed) return null;
  const step = steps[stepIndex];
  if (!step || !rect) return null;

  const finish = (completed: boolean) => {
    try { localStorage.setItem(storageKey, "1"); } catch { /* ignore */ }
    void api.reportTourProgress({ tour_key: storageKey, step_index: stepIndex, total_steps: steps.length, completed }).catch(() => {});
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
          <button className="tour-skip" onClick={() => finish(false)}>Skip tour</button>
          <div style={{ display: "flex", gap: 8 }}>
            {stepIndex > 0 && (
              <button className="tour-prev" onClick={() => setStepIndex((i) => i - 1)}>Back</button>
            )}
            {stepIndex < steps.length - 1 ? (
              <button className="tour-next" onClick={() => setStepIndex((i) => i + 1)}>Next</button>
            ) : (
              <button className="tour-next" onClick={() => finish(true)}>Got it</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
