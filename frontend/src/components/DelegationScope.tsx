import { useEffect, useMemo, useState } from "react";

// Splits "my own approval authority" from "acting on behalf of a manager
// who delegated to me" — the two must never silently merge into one list,
// mirroring the same principle already applied in the generic Inbox
// (frontend/src/Inbox.tsx) for Advance/Clearance. Shared here so Standby
// and Overtime's own dedicated Approvals screens get the same treatment
// instead of re-implementing it per module.

export type DelegationScopeValue = "ALL" | "MINE" | "DELEGATED";

export function useDelegationScope<T extends { is_delegated?: boolean; delegated_from_manager_name?: string | null }>(items: T[]) {
  const [scope, setScope] = useState<DelegationScopeValue>("ALL");
  const hasAnyDelegated = useMemo(() => items.some((it) => it.is_delegated), [items]);
  const delegatingManagers = useMemo(
    () => Array.from(new Set(items.filter((it) => it.is_delegated && it.delegated_from_manager_name).map((it) => it.delegated_from_manager_name as string))),
    [items]
  );
  // Reset to "All" if the delegated set disappears (e.g. filters change),
  // so scope never gets stuck on an empty "Delegated To Me" view.
  useEffect(() => { if (!hasAnyDelegated) setScope("ALL"); }, [hasAnyDelegated]);
  const scopedItems = useMemo(() => {
    if (scope === "MINE") return items.filter((it) => !it.is_delegated);
    if (scope === "DELEGATED") return items.filter((it) => it.is_delegated);
    return items;
  }, [items, scope]);
  return { scope, setScope, scopedItems, hasAnyDelegated, delegatingManagers };
}

export function DelegationScopeBar<T extends { is_delegated?: boolean }>({
  items, scope, setScope, hasAnyDelegated, delegatingManagers, myLabel = "My Approvals"
}: {
  items: T[];
  scope: DelegationScopeValue;
  setScope: (s: DelegationScopeValue) => void;
  hasAnyDelegated: boolean;
  delegatingManagers: string[];
  myLabel?: string;
}) {
  if (!hasAnyDelegated) return null;
  return (
    <>
      <div className="inbox-delegate-banner">
        You are acting as a delegate for {delegatingManagers.join(", ") || "another manager"}. Delegated items are kept separate from your own approvals below.
      </div>
      <div className="ep-tabs" style={{ marginBottom: 8 }}>
        {([
          { key: "ALL", label: "All" },
          { key: "MINE", label: myLabel },
          { key: "DELEGATED", label: "Delegated To Me" }
        ] as const).map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`ep-tab ${scope === tab.key ? "active" : ""}`}
            onClick={() => setScope(tab.key)}
          >
            {tab.label}
            <span className="inbox-count-chip">
              {tab.key === "ALL" ? items.length : items.filter((it) => (tab.key === "DELEGATED") === !!it.is_delegated).length}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

// Small per-row "On behalf of X" tag for a delegated item — drop under the
// owner/employee name cell.
export function DelegatedTag({ item }: { item: { is_delegated?: boolean; delegated_from_manager_name?: string | null } }) {
  if (!item.is_delegated) return null;
  return <small className="inbox-delegated-tag">On behalf of {item.delegated_from_manager_name || "your manager"}</small>;
}
