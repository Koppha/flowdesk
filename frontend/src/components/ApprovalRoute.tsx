import { useEffect, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { api } from "../api";

export type ApprovalRouteStep = { approver_user_id: string; title: string; approver_name?: string };

const FALLBACK_TITLE_OPTIONS = ["Manager", "Other"];

// The Approval Route step "title" (the capacity someone approves in) is
// org-structure-driven — the manager_types master list (Head of Department,
// Senior Manager, Manager, Section Manager, Team Leader, admin-managed via
// the Manager Types screen) rather than a hardcoded per-module list. "Other"
// is always appended as a catch-all for capacities not in that list.
export function useApprovalTitleOptions(): string[] {
  const [options, setOptions] = useState<string[]>(FALLBACK_TITLE_OPTIONS);
  useEffect(() => {
    api.managerTypes()
      .then((rows: any[]) => {
        const names = (rows || []).filter((r) => r.active).map((r) => r.name);
        setOptions(names.length ? [...names, "Other"] : FALLBACK_TITLE_OPTIONS);
      })
      .catch(() => setOptions(FALLBACK_TITLE_OPTIONS));
  }, []);
  return options;
}

// Generic employee-defined Approval Route builder, shared by Standby and
// Overtime (both Request and Claim stages) rather than duplicated per
// module — the approver search and title vocabulary differ, so both are
// passed in rather than hardcoded.
export function ApprovalRouteBuilder({
  steps,
  onChange,
  disabled,
  eligibleApproversFn,
  titleOptions,
  defaultTitle
}: {
  steps: ApprovalRouteStep[];
  onChange: (steps: ApprovalRouteStep[]) => void;
  disabled: boolean;
  eligibleApproversFn: (search: string) => Promise<any[]>;
  titleOptions: string[];
  defaultTitle?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const handle = setTimeout(() => {
      eligibleApproversFn(query).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, eligibleApproversFn]);

  function addStep() {
    onChange([...steps, { approver_user_id: "", title: defaultTitle || titleOptions[0] || "Manager" }]);
  }
  function updateStep(i: number, patch: Partial<ApprovalRouteStep>) {
    onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeStep(i: number) {
    onChange(steps.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Approval Route</div>
      <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Add the people who need to approve this, in order.</p>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, position: "relative" }}>
          <span style={{ width: 20, fontWeight: 700, fontSize: 13 }}>{i + 1}.</span>
          <div style={{ position: "relative", flex: 1 }}>
            <Search size={13} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} aria-hidden />
            <input
              className="review-control"
              style={{ paddingLeft: 26, width: "100%", boxSizing: "border-box" }}
              placeholder="Search employee / approver…"
              value={s.approver_name || ""}
              disabled={disabled}
              onChange={(e) => { updateStep(i, { approver_name: e.target.value, approver_user_id: "" }); setQuery(e.target.value); setActiveIndex(i); }}
              onFocus={() => setActiveIndex(i)}
            />
            {activeIndex === i && results.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, zIndex: 30, maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
                {results.map((u) => (
                  <div
                    key={u.id}
                    onMouseDown={(e) => { e.preventDefault(); updateStep(i, { approver_user_id: u.id, approver_name: u.full_name }); setResults([]); setActiveIndex(null); }}
                    style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid var(--border)" }}
                  >
                    <div style={{ fontWeight: 600 }}>{u.full_name}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{[u.title, u.department].filter(Boolean).join(" • ")}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <select className="review-control" style={{ maxWidth: 140 }} value={s.title} disabled={disabled} onChange={(e) => updateStep(i, { title: e.target.value })}>
            {titleOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {!disabled && (
            <div style={{ display: "flex", gap: 2 }}>
              <button type="button" className="ep-icon-btn" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" className="ep-icon-btn" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
              <button type="button" className="ep-icon-btn danger" onClick={() => removeStep(i)}><Trash2 size={13} aria-hidden /></button>
            </div>
          )}
        </div>
      ))}
      {!disabled && <button type="button" className="ep-btn-outline" onClick={addStep}><Plus size={13} aria-hidden /> Add Approval Step</button>}
    </div>
  );
}
