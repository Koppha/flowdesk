import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken } from "./api";
import { LESOTHO_DISTRICTS, TravelType, isTravelTypeCode, travelTypeLabel } from "./constants";
import { Bell, CheckCircle2, ClipboardList, RefreshCw } from "lucide-react";

type InboxItem =
  | {
      doc_type: "ADVANCE";
      id: string;
      status: string;
      requested_total: number;
      approved_total: number;
      purpose: string | null;
      requester_name: string;
      advance_type?: string;
      workflow_step_order?: number | null;
      current_step_approver_id?: string | null;
      current_step_position_name?: string | null;
      current_step_requires_accommodation?: boolean;
    }
  | {
      doc_type: "ACCOMMODATION";
      id: string;
      status: string;
      amount: number;
      location: string;
      provider: string | null;
      requester_name: string;
      created_by_name: string;
    }
  | {
      doc_type: "CLAIM";
      id: string;
      status: string;
      claim_total: number;
      advance_amount: number;
      balance_amount: number;
      claimant_name: string;
      workflow_step_order?: number | null;
      current_step_approver_id?: string | null;
      current_step_position_name?: string | null;
    }
  | {
      doc_type: "OVERTIME_REQUEST";
      id: string;
      status: string;
      employee_name: string | null;
      section_name: string | null;
      year: number;
      month: number;
    }
  | {
      doc_type: "OVERTIME_CLAIM";
      id: string;
      status: string;
      employee_name: string | null;
      division: string | null;
      year: number;
      month: number;
      total_amount: number;
    };

type MyInboxAction = {
  id: string;
  action: string;
  doc_type: string;
  entity_id: string;
  current_status: string | null;
  requester_name: string | null;
  created_at: string;
};

function fmt(n: any) {
  const x = Number(n || 0);
  return `M${x.toFixed(2)}`;
}

function fmtWhen(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function fmtDate(value: any) {
  const d = new Date(String(value || ""));
  if (Number.isNaN(d.getTime())) return String(value || "—");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

interface AccommodationEntry {
  district: string;
  provider: string;
  checkIn: string;
  checkOut: string;
  amount: string;
  notes: string;
  quotation: File | null;
}

function normalizeDateInputValue(value: any) {
  if (!value) return "";
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  // Use local date components (not toISOString) so that UTC-serialized
  // timestamps for local-midnight dates round-trip to the same calendar day.
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function lineAmount(line: any) {
  return Number(line.line_total || 0) || Number(line.meals || 0) || Number(line.lunch || 0) + Number(line.dinner || 0);
}

function lineMealCount(line: any) {
  const count = Number(line.meals_count);
  return Number.isFinite(count) && count > 0 ? count : "—";
}

function displayRoleLabel(value: string | null | undefined) {
  switch (value) {
    case "HR_MANAGER":
      return "HR Manager";
    default:
      return value || "Unknown";
  }
}

function statusLabel(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusTone(value: string | null | undefined) {
  const status = String(value || "").toUpperCase();
  if (status.includes("REJECT") || status.includes("CANCEL") || status.includes("FAILED")) return "status-pill-danger";
  if (status.includes("PAID") || status.includes("APPROVED") || status.includes("SETTLED") || status.includes("COMPLETED")) return "status-pill-success";
  if (status.includes("SUBMITTED") || status.includes("REVIEW") || status.includes("PENDING") || status.includes("OFFICER")) return "status-pill-warning";
  if (status.includes("DRAFT")) return "status-pill-neutral";
  return "status-pill-info";
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function docTypeLabel(value: InboxItem["doc_type"] | string | null | undefined) {
  switch (value) {
    case "ADVANCE":          return "Advance";
    case "ACCOMMODATION":    return "Travel Accommodation";
    case "CLAIM":            return "Clearance";
    case "OVERTIME_REQUEST": return "Overtime Request";
    case "OVERTIME_CLAIM":   return "Overtime Claim";
    default:                 return statusLabel(String(value || "Document"));
  }
}

function itemOwner(item: InboxItem) {
  if (item.doc_type === "CLAIM") return item.claimant_name || "Unknown";
  if (item.doc_type === "OVERTIME_REQUEST" || item.doc_type === "OVERTIME_CLAIM") return item.employee_name || "Unknown";
  return item.requester_name || "Unknown";
}

function itemAmountValue(item: InboxItem) {
  if (item.doc_type === "ADVANCE") return Number(item.requested_total || 0);
  if (item.doc_type === "ACCOMMODATION") return Number(item.amount || 0);
  if (item.doc_type === "OVERTIME_CLAIM") return Number(item.total_amount || 0);
  if (item.doc_type === "OVERTIME_REQUEST") return 0;
  return Number(item.claim_total || 0);
}

function itemAmount(item: InboxItem) {
  if (item.doc_type === "OVERTIME_REQUEST") return "—";
  return fmt(itemAmountValue(item));
}

function itemContext(item: InboxItem) {
  if (item.doc_type === "ADVANCE") return item.purpose || "Advance request";
  if (item.doc_type === "ACCOMMODATION") return `${item.location || "Location pending"}${item.provider ? ` - ${item.provider}` : ""}`;
  if (item.doc_type === "OVERTIME_REQUEST") return `${MONTHS[(item.month ?? 1) - 1]} ${item.year} · ${item.section_name || ""}`;
  if (item.doc_type === "OVERTIME_CLAIM") return `${MONTHS[(item.month ?? 1) - 1]} ${item.year} · ${item.division || ""}`;
  return `Advance ${fmt(item.advance_amount)} / Balance ${fmt(item.balance_amount)}`;
}

function initials(value: string | null | undefined) {
  const parts = String(value || "User")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (parts[0]?.[0] || "U") + (parts[1]?.[0] || "");
}

function actionLabel(value: string | null | undefined) {
  if (!value) return "Action";
  return statusLabel(value);
}

export default function Inbox(props: { onBack?: () => void }) {
  const me = getUserFromToken();
  const role = me?.role || "UNKNOWN";

  const [items, setItems] = useState<InboxItem[]>([]);
  const [myActions, setMyActions] = useState<MyInboxAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InboxItem | null>(null);

  async function refresh() {
    setError(null);
    const [inboxResp, myActionsResp] = await Promise.all([api.inbox(), api.myInboxActions(30)]);
    setItems(inboxResp.items || []);
    setMyActions(myActionsResp.items || []);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message)));
  }, []);

  const grouped = useMemo(() => {
    const g: Record<string, InboxItem[]> = {};
    for (const it of items) {
      const key = `${it.doc_type}:${it.status}`;
      g[key] = g[key] || [];
      g[key].push(it);
    }
    return g;
  }, [items]);

  const metrics = useMemo(
    () => ({
      awaiting: items.length,
      advances: items.filter((item) => item.doc_type === "ADVANCE").length,
      clearances: items.filter((item) => item.doc_type === "CLAIM").length,
      advanceValue: items
        .filter((item) => item.doc_type === "ADVANCE")
        .reduce((sum, item) => sum + itemAmountValue(item), 0),
      recentActions: myActions.length
    }),
    [items, myActions]
  );

  const latestAction = myActions[0] || null;

  return (
    <div className="inbox-page">
      <section className="inbox-hero">
        <div>
          <div className="inbox-eyebrow">Approval Workflow</div>
          <h2>Approval Inbox</h2>
          <p>
            Review finance requests waiting for {displayRoleLabel(role)} and keep a clear record of your recent decisions.
          </p>
        </div>
        <div className="inbox-hero-actions">
          {props.onBack && (
            <button className="button small-button button-subtle" onClick={props.onBack}>
              Back
            </button>
          )}
          <button className="button small-button button-primary" onClick={() => refresh().catch((e) => setError(String(e.message)))}>
            Refresh
          </button>
        </div>
      </section>

      {error && <pre className="inbox-error">{error}</pre>}

      <section className="inbox-metrics">
        <div className="inbox-metric-card metric-blue">
          <Bell size={26} className="metric-icon" />
          <div><strong>{metrics.awaiting}</strong><span>Awaiting My Approval</span></div>
        </div>
        <div className="inbox-metric-card metric-green">
          <ClipboardList size={26} className="metric-icon" />
          <div><strong>{metrics.advances}</strong><span>Advance Requests</span><small>{fmt(metrics.advanceValue)} value</small></div>
        </div>
        <div className="inbox-metric-card metric-gold">
          <CheckCircle2 size={26} className="metric-icon" />
          <div><strong>{metrics.clearances}</strong><span>Clearances</span></div>
        </div>
        <div className="inbox-metric-card metric-rose">
          <RefreshCw size={26} className="metric-icon" />
          <div><strong>{metrics.recentActions}</strong><span>Recent Actions</span><small>{latestAction ? actionLabel(latestAction.action) : "No history yet"}</small></div>
        </div>
      </section>

      <div className="inbox-layout">
        <section className="inbox-panel inbox-queue-panel">
          <div className="inbox-panel-header">
            <div>
              <h3>Approval Queue</h3>
              <p>{items.length === 0 ? "No work is waiting right now." : "Grouped by document type and current stage."}</p>
            </div>
            <span className="inbox-count-chip">{items.length} total</span>
          </div>

          {items.length === 0 ? (
            <div className="inbox-empty-state">
              <div className="inbox-empty-icon">0</div>
              <h4>No items awaiting your action</h4>
              <p>When requests reach your approval stage, they will appear here with their value, owner, and next action.</p>
              <button className="button small-button button-primary" onClick={() => refresh().catch((e) => setError(String(e.message)))}>
                Refresh Queue
              </button>
            </div>
          ) : (
            <div className="inbox-group-stack">
              {Object.entries(grouped).map(([groupKey, groupItems]) => {
                const [docTypeRaw, statusRaw] = groupKey.split(":");
                return (
                  <article key={groupKey} className="inbox-group-card">
                    <div className="inbox-group-header">
                      <div>
                        <span className="inbox-doc-chip">{docTypeLabel(docTypeRaw)}</span>
                        <h4>{statusLabel(statusRaw)}</h4>
                      </div>
                      <span className="inbox-count-chip">{groupItems.length} item(s)</span>
                    </div>

                    <div className="inbox-table-wrap">
                      <table className="inbox-table">
                        <thead>
                          <tr>
                            <th>Owner</th>
                            <th>Status</th>
                            <th>Amount</th>
                            <th>Context</th>
                            <th className="inbox-actions-header">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupItems.map((it) => (
                            <tr key={it.id}>
                              <td>
                                <div className="inbox-person-cell">
                                  <span className="inbox-avatar-mini">{initials(itemOwner(it))}</span>
                                  <span>
                                    <strong>{itemOwner(it)}</strong>
                                    <small>{docTypeLabel(it.doc_type)}</small>
                                  </span>
                                </div>
                              </td>
                              <td>
                                <span className={`status-pill ${statusTone(it.status)}`}>{statusLabel(it.status)}</span>
                              </td>
                              <td className="inbox-money">{itemAmount(it)}</td>
                              <td className="inbox-context">{itemContext(it)}</td>
                              <td className="inbox-actions-cell">
                                <button
                                  type="button"
                                  className="inbox-review-button"
                                  onClick={() => setSelected(it)}
                                  aria-label={`Review ${docTypeLabel(it.doc_type)} for ${itemOwner(it)}`}
                                  title="Review"
                                >
                                  <RefreshCw size={15} aria-hidden="true" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="inbox-panel inbox-history-panel">
          <div className="inbox-panel-header">
            <div>
              <h3>My Recent Actions</h3>
              <p>Latest decisions and handoffs.</p>
            </div>
            <span className="inbox-count-chip">{myActions.length}</span>
          </div>

          {myActions.length === 0 ? (
            <div className="inbox-history-empty">No action history yet.</div>
          ) : (
            <div className="inbox-action-list">
              {myActions.slice(0, 10).map((a) => (
                <div className="inbox-action-item" key={a.id}>
                  <div className="inbox-action-topline">
                    <strong>{actionLabel(a.action)}</strong>
                    <span className={`status-pill ${statusTone(a.current_status)}`}>{statusLabel(a.current_status)}</span>
                  </div>
                  <div className="inbox-action-meta">
                    {docTypeLabel(a.doc_type)} for {a.requester_name || "Unknown"}
                  </div>
                  <time>{fmtWhen(a.created_at)}</time>
                </div>
              ))}
              {myActions.length > 10 && <div className="inbox-history-note">Showing latest 10 of {myActions.length} records.</div>}
            </div>
          )}
        </aside>
      </div>

      {selected && (
        <ReviewModal
          item={selected}
          role={role}
          onClose={() => setSelected(null)}
          onDone={async () => {
            setSelected(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function ReviewModal(props: { item: InboxItem; role: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { item, role } = props;
  const me = getUserFromToken();
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState("");
  const [paidRef, setPaidRef] = useState("");
  const [settleRef, setSettleRef] = useState("");
  const [settleMethod, setSettleMethod] = useState<"ECOCASH" | "BANK">("ECOCASH");
  const [accommodationEntries, setAccommodationEntries] = useState<AccommodationEntry[]>([]);
  const [accommodationHotels, setAccommodationHotels] = useState<any[]>([]);
  const [travelTypes, setTravelTypes] = useState<TravelType[]>([]);
  const [busy, setBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setError(null);
      try {
        const [d, types] = await Promise.all([
          item.doc_type === "ADVANCE"
            ? api.advanceDetail(item.id)
            : item.doc_type === "ACCOMMODATION"
              ? api.accommodationDetail(item.id)
              : api.claimDetail(item.id),
          api.travelTypes().catch(() => [])
        ]);
        setDetail(d);
        setTravelTypes(Array.isArray(types) ? types : []);
      } catch (e: any) {
        setError(String(e.message));
      }
    })();
  }, [item.id]);

  const isTravelAdvance =
    item.doc_type === "ADVANCE" &&
    (Boolean(detail?.is_travel_type) || isTravelTypeCode(detail?.type, travelTypes));
  // Accommodation is only valid for local travel (Lesotho districts mode)
  const usesDistrictAccommodation = !detail?.travel_location_mode || detail.travel_location_mode === "DISTRICT";
  // Multi-day: more than 1 travel line means the traveller stays overnight
  const travelDayCount = (detail?.lines ?? []).length;
  const isMultiDayTravel = travelDayCount > 1;

  // Extract destination districts (exclude last return-home leg)
  const destinationDistricts = useMemo(() => {
    if (!isTravelAdvance || !detail?.lines) return [];
    const lines: any[] = detail.lines || [];
    // Use all lines except the last (which is typically the return trip home)
    const outboundLines = lines.length > 1 ? lines.slice(0, -1) : lines;
    const districts = new Set<string>();
    outboundLines.forEach((line: any) => {
      const location = String(line.location || "").trim();
      if (location.includes("→")) {
        const destination = location.split("→")[1]?.trim();
        if (destination) districts.add(destination);
      }
    });
    return Array.from(districts);
  }, [isTravelAdvance, detail?.lines]);

  // Auto-fill check-in / check-out per destination district from travel line dates.
  // Check-in is the date the traveller arrives at the district (the line whose
  // destination is that district); check-out is the date of the next leg
  // departing that district (i.e. the following line's date).
  const destinationDateRanges = useMemo(() => {
    const ranges = new Map<string, { checkIn: string; checkOut: string }>();
    if (!isTravelAdvance || !detail?.lines) return ranges;
    const lines: any[] = detail.lines || [];
    const outboundLines = lines.length > 1 ? lines.slice(0, -1) : lines;
    outboundLines.forEach((line: any, idx: number) => {
      const location = String(line.location || "").trim();
      if (!location.includes("→")) return;
      const destination = location.split("→")[1]?.trim();
      if (!destination) return;
      const checkIn = normalizeDateInputValue(line.line_date || line.trip_date || line.date);
      const nextLine = lines[idx + 1];
      const checkOut = nextLine ? normalizeDateInputValue(nextLine.line_date || nextLine.trip_date || nextLine.date) : checkIn;
      const existing = ranges.get(destination);
      if (!existing) {
        ranges.set(destination, { checkIn, checkOut });
      } else {
        existing.checkOut = checkOut;
      }
    });
    return ranges;
  }, [isTravelAdvance, detail?.lines]);

  // For workflow-driven advances, use the current_step_approver_id set by the backend.
  // For legacy advances (no approver_id), fall back to role+status checks.
  const isWorkflowDriven = item.doc_type === "ADVANCE" && item.current_step_approver_id !== undefined;
  const isMyWorkflowStep = isWorkflowDriven && item.current_step_approver_id === me?.userId;
  // The current step is an accommodation-only step (e.g. HR preparing
  // accommodation before forwarding to Finance) — at this step the assignee
  // attaches the accommodation booking instead of approving/rejecting.
  const isAccommodationStep = isWorkflowDriven && Boolean((item as any).current_step_requires_accommodation);
  const inProgressStatuses = ["SUBMITTED", "COUNTERSIGNED", "HR_MANAGER_REVIEW", "HR_REVIEW", "HR_OFFICER"];

  const canRollbackAdvance =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationStep
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "MANAGER" && item.status === "HR_REVIEW") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED")));
  const canRejectAdvance =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationStep
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "MANAGER" && item.status === "HR_REVIEW") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED") ||
          (role === "FINANCE" && ["HR_OFFICER", "APPROVED"].includes(item.status)) ||
          (role === "ADMIN" && inProgressStatuses.includes(item.status))));
  const canApproveAdvance =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationStep
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED")));
  const canMarkPaid =
    item.doc_type === "ADVANCE" &&
    (role === "FINANCE" || role === "ADMIN" || Boolean((item as any).is_final_step_approver)) &&
    ["HR_OFFICER", "APPROVED"].includes(item.status);
  const canCreateAccommodation =
    item.doc_type === "ADVANCE" &&
    isTravelAdvance &&
    usesDistrictAccommodation &&   // local travel only
    isMultiDayTravel &&            // must be more than 1 day
    (isWorkflowDriven
      ? isMyWorkflowStep && isAccommodationStep
      : (role === "MANAGER" && ["HR_REVIEW", "HR_OFFICER", "APPROVED"].includes(item.status)));
  const canMarkAccommodationPaid = item.doc_type === "ACCOMMODATION" && role === "FINANCE" && item.status === "SUBMITTED";
  const canRejectAccommodation = item.doc_type === "ACCOMMODATION" && role === "FINANCE" && item.status === "SUBMITTED";

  // Workflow-driven clearance claims (e.g. "Travel Clearance DT") expose the
  // current step's approver via current_step_approver_id, mirroring advances.
  const isWorkflowDrivenClaim = item.doc_type === "CLAIM" && item.current_step_approver_id !== undefined;
  const isMyClaimWorkflowStep = isWorkflowDrivenClaim && item.current_step_approver_id === me?.userId;
  const canApproveClaim = isWorkflowDrivenClaim && isMyClaimWorkflowStep;
  const canRejectClaim = isWorkflowDrivenClaim && isMyClaimWorkflowStep;

  const canManagerApprove = item.doc_type === "CLAIM" && !isWorkflowDrivenClaim && role === "MANAGER" && item.status === "SUBMITTED";
  const canChiefApprove = item.doc_type === "CLAIM" && !isWorkflowDrivenClaim && role === "EXCO" && item.status === "MANAGER_APPROVED";
  const canAuthApproveClaim = item.doc_type === "CLAIM" && !isWorkflowDrivenClaim && role === "MANAGER" && item.status === "CHIEF_OFFICER_APPROVED";
  const canHrManagerApproveClaim = item.doc_type === "CLAIM" && !isWorkflowDrivenClaim && role === "HR_MANAGER" && item.status === "HR_OFFICER";
  const canFinanceVerify = item.doc_type === "CLAIM" && !isWorkflowDrivenClaim && role === "FINANCE" && item.status === "HR_MANAGER_REVIEW";
  const canSettle = item.doc_type === "CLAIM" && role === "FINANCE" && item.status === "FINANCE_VERIFIED";

  const noActionMessage = (() => {
    if (item.doc_type === "ADVANCE" && role === "MANAGER" && !["SUBMITTED", "HR_MANAGER_REVIEW"].includes(item.status)) {
      return "This advance is visible for reference only.";
    }
    if (item.doc_type === "CLAIM" && isWorkflowDrivenClaim && !isMyClaimWorkflowStep) {
      return `This clearance is visible for reference only — it is currently awaiting ${item.current_step_position_name || "the next approver"}.`;
    }
    if (item.doc_type === "CLAIM" && !isWorkflowDrivenClaim && role === "MANAGER" && item.status !== "SUBMITTED") {
      return "This claim is visible for reference only because manager approval is only required on submitted claims.";
    }
    return "No action available for your role on this item.";
  })();

  useEffect(() => {
    if (!canCreateAccommodation) return;
    api.hotels()
      .then((rows: any[]) => setAccommodationHotels(rows || []))
      .catch((e: any) => setError(String(e.message)));
    // Build one accommodation entry per destination district, auto-filling
    // check-in / check-out from the travel line dates for that district.
    setAccommodationEntries((prev) => {
      if (prev.length) return prev;
      const districts = destinationDistricts.length ? destinationDistricts : [""];
      return districts.map((district) => {
        const range = destinationDateRanges.get(district);
        return {
          district,
          provider: "",
          checkIn: range?.checkIn || "",
          checkOut: range?.checkOut || "",
          amount: "",
          notes: "",
          quotation: null
        };
      });
    });
  }, [canCreateAccommodation, destinationDistricts, destinationDateRanges]);

  function updateAccommodationEntry(index: number, patch: Partial<AccommodationEntry>) {
    setAccommodationEntries((prev) => prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }


  async function act(fn: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await props.onDone();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  function handleRollbackAdvance() {
    if (!comments.trim()) {
      setRollbackError("Enter rollback comments before sending this advance back to the owner as draft.");
      return;
    }
    setRollbackError(null);
    void act(() => api.rollbackAdvance(item.id, comments.trim()));
  }

  function handleRejectAdvance() {
    if (!comments.trim()) {
      setError("Enter comments before rejecting this advance.");
      return;
    }
    void act(() => api.rejectAdvance(item.id, comments.trim()));
  }

  function handleApproveAdvance() {
    const approvedTotal = item.doc_type === "ADVANCE" ? Number(detail?.requested_total || item.requested_total || 0) : 0;
    void act(() => api.approveAdvance(item.id, approvedTotal, comments));
  }

  function handleCreateAccommodation() {
    if (!accommodationEntries.length) {
      setError("Accommodation location is required.");
      return;
    }
    for (const entry of accommodationEntries) {
      if (!entry.district.trim()) {
        setError("Accommodation location is required.");
        return;
      }
      if (!entry.provider.trim()) {
        setError("Enter or select a hotel/provider.");
        return;
      }
      if (Number(entry.amount || 0) <= 0) {
        setError("Accommodation amount must be greater than 0.");
        return;
      }
    }

    void act(async () => {
      // Each destination gets its own draft accommodation request. Only the
      // last one is sent to finance, which advances the advance's workflow
      // step once for the whole batch (and the backend marks any remaining
      // sibling drafts as SUBMITTED at the same time).
      let lastId: string | null = null;
      for (const entry of accommodationEntries) {
        const createResp = await api.createAccommodationRequest({
          advance_request_id: item.id,
          location: entry.district.trim(),
          provider: entry.provider.trim() || undefined,
          check_in: entry.checkIn || undefined,
          check_out: entry.checkOut || undefined,
          amount: Number(entry.amount || 0),
          notes: entry.notes.trim() || undefined
        });
        if (entry.quotation) {
          const form = new FormData();
          form.append("file", entry.quotation);
          await api.uploadAccommodationQuotation(createResp.id, form);
        }
        lastId = createResp.id;
      }
      if (lastId) await api.sendAccommodationToFinance(lastId);
    });
  }

  return (
    <div className="review-modal-backdrop">
      <div className="review-modal-shell">
        <div className="review-modal-header">
          <div>
            <div className="review-modal-eyebrow">Request Review</div>
            <h3>Review {item.doc_type === "ACCOMMODATION" ? "Travel Advance Request" : docTypeLabel(item.doc_type)}</h3>
            <span className={`status-pill ${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
          </div>
          <button className="button small-button button-subtle" onClick={props.onClose}>
            Close
          </button>
        </div>

        {error && <pre className="inbox-error">{error}</pre>}

        {!detail ? (
          <div className="review-loading">Loading request details...</div>
        ) : (
          <div
            className={`review-modal-grid ${item.doc_type === "CLAIM" || isTravelAdvance ? "review-modal-grid-two" : ""}`}
          >
            <div className="review-card">
              <div className="review-card-title">Summary</div>
              {item.doc_type === "ADVANCE" ? (
                <div className="review-detail-list">
                  <div>Type: {travelTypeLabel(detail.type, travelTypes)}</div>
                  <div>Purpose: {detail.purpose || "—"}</div>
                  <div>Requested Total: {fmt(detail.requested_total)}</div>
                  <div>Approved Total: {fmt(detail.approved_total)}</div>
                  <div>Payment: {detail.payment_method} {detail.payment_account || ""}</div>
                </div>
              ) : item.doc_type === "ACCOMMODATION" ? (
                <div className="review-detail-list">
                  <div>Employee: {detail.requester_name || "—"}</div>
                  <div>Created By: {detail.created_by_name || "—"}</div>
                  <div>Location: {detail.location || "—"}</div>
                  <div>Provider: {detail.provider || "—"}</div>
                  <div>Dates: {detail.check_in ? fmtDate(detail.check_in) : "—"} to {detail.check_out ? fmtDate(detail.check_out) : "—"}</div>
                  <div>Amount: {fmt(detail.amount)}</div>
                  <div>
                    Quotations: {detail.quotations?.length ? detail.quotations.map((q: any) => q.file_name || q.path?.split("/").pop() || "Uploaded").join(", ") : "None uploaded"}
                  </div>
                  <div>Advance: {detail.advance_purpose || "—"} ({detail.advance_status || "—"})</div>
                </div>
              ) : (
                <div className="review-detail-list">
                  <div>Project: {detail.project_number || "—"}</div>
                  <div>Month: {detail.month || "—"}</div>
                  <div>Clearance Total: {fmt(detail.claim_total)}</div>
                  <div>Advance Amount: {fmt(detail.advance_amount)}</div>
                  <div>Balance Amount: {fmt(detail.balance_amount)} (positive = employee refunds company; negative = company pays employee)</div>
                </div>
              )}
            </div>

            {(item.doc_type === "CLAIM" || isTravelAdvance) && (
              <div className="review-card">
                <div className="review-card-title">Lines</div>

                {item.doc_type === "ADVANCE" ? (
                  <div className="review-table-wrap">
                    <table className="review-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Location</th>
                          <th>Meals</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.lines || []).map((l: any) => (
                          <tr key={l.id}>
                            <td>{fmtDate(l.line_date)}</td>
                            <td>{l.location || "—"}</td>
                            <td>{lineMealCount(l)}</td>
                            <td>{fmt(lineAmount(l))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="review-table-wrap">
                    <table className="review-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Location</th>
                          <th>Petrol</th>
                          <th>Meals</th>
                          <th>Other</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.trips || []).map((t: any) => (
                          <tr key={t.id}>
                            <td>{fmtDate(t.trip_date)}</td>
                            <td>{t.to_place ? `${t.from_place || "—"} → ${t.to_place}` : (t.from_place || "—")}</td>
                            <td>{fmt(t.petrol_allowance)}</td>
                            <td>{fmt(Number(t.breakfast || 0) + Number(t.lunch || 0) + Number(t.dinner || 0))}</td>
                            <td>{fmt(t.other_expenses)}</td>
                            <td>{fmt(t.line_total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {item.doc_type === "ADVANCE" && isTravelAdvance && (
              <div className="review-card review-card-wide">
                <div className="review-card-title">Accommodation Requests</div>
                {(detail.accommodation_requests || []).length === 0 ? (
                  <div className="review-empty-note">No HR accommodation request has been sent to Finance.</div>
                ) : (
                  <div className="review-table-wrap">
                    <table className="review-table">
                      <thead>
                        <tr>
                          <th>Status</th>
                          <th>Location</th>
                          <th>Provider</th>
                          <th>Amount</th>
                          <th>Created By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.accommodation_requests || []).map((a: any) => (
                          <tr key={a.id}>
                            <td>{statusLabel(a.status)}</td>
                            <td>{a.location || "—"}</td>
                            <td>{a.provider || "—"}</td>
                            <td>{fmt(a.amount)}</td>
                            <td>{a.created_by_name || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div className="review-card review-card-wide">
              <div className="review-card-title">Action</div>

              {canCreateAccommodation && (
                <div style={{ marginBottom: 16 }}>
                  {/* Header banner */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "rgba(37,99,235,0.06)", border: "1px solid rgba(37,99,235,0.18)", borderLeft: "4px solid #2563eb", borderRadius: "0 8px 8px 0", marginBottom: 14, fontSize: "0.85rem" }}>
                    <span style={{ fontSize: 18 }}>🏨</span>
                    <div>
                      <strong style={{ color: "#1d4ed8" }}>Set Accommodation</strong>
                      <span style={{ color: "var(--muted)", marginLeft: 8 }}>
                        {travelDayCount}-day local trip · destination district{destinationDistricts.length > 1 ? "s" : ""}: <strong>{destinationDistricts.join(", ") || "—"}</strong>
                      </span>
                    </div>
                  </div>

                  {accommodationEntries.map((entry, idx) => {
                    const datalistId = `accommodation-hotel-options-${idx}`;
                    const entryHotels = accommodationHotels.filter((hotel) => hotel.district === entry.district);
                    return (
                      <div key={idx} style={{ marginBottom: idx < accommodationEntries.length - 1 ? 16 : 0 }}>
                        {accommodationEntries.length > 1 && (
                          <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 6, color: "#1d4ed8" }}>
                            Destination {idx + 1}: {entry.district || "—"}
                          </div>
                        )}
                        <div className="review-form-grid review-form-grid-3">
                          <label>
                            <span>Destination District <span style={{ color: "#dc2626" }}>*</span></span>
                            {destinationDistricts.length > 0 ? (
                              <input className="review-control" value={entry.district} disabled />
                            ) : (
                              <input
                                className="review-control"
                                value={entry.district}
                                onChange={(e) => updateAccommodationEntry(idx, { district: e.target.value })}
                                placeholder="Enter district"
                              />
                            )}
                          </label>
                          <label>
                            <span>Hotel / Provider</span>
                            <input
                              className="review-control"
                              list={datalistId}
                              value={entry.provider}
                              onChange={(e) => updateAccommodationEntry(idx, { provider: e.target.value })}
                              disabled={!entry.district}
                              placeholder={!entry.district ? "Enter district first" : entryHotels.length === 0 ? "Type hotel/provider name" : "Search or type hotel name"}
                              autoComplete="off"
                            />
                            <datalist id={datalistId}>
                              {entryHotels.map((hotel) => (
                                <option key={hotel.id} value={hotel.name} />
                              ))}
                            </datalist>
                          </label>
                          <label>
                            <span>Amount (M)</span>
                            <input className="review-control" type="number" min="0" step="0.01" placeholder="0.00" value={entry.amount} onChange={(e) => updateAccommodationEntry(idx, { amount: e.target.value })} />
                          </label>
                          <label>
                            <span>Check In <span style={{ color: "var(--muted)", fontSize: "0.78rem" }}>(auto-filled)</span></span>
                            <input className="review-control" type="date" value={entry.checkIn} onChange={(e) => updateAccommodationEntry(idx, { checkIn: e.target.value })} />
                          </label>
                          <label>
                            <span>Check Out <span style={{ color: "var(--muted)", fontSize: "0.78rem" }}>(auto-filled)</span></span>
                            <input className="review-control" type="date" value={entry.checkOut} onChange={(e) => updateAccommodationEntry(idx, { checkOut: e.target.value })} />
                          </label>
                          <label>
                            <span>Notes</span>
                            <input className="review-control" placeholder="Optional notes…" value={entry.notes} onChange={(e) => updateAccommodationEntry(idx, { notes: e.target.value })} />
                          </label>
                          <label className="review-wide-field">
                            <span>Quotation File <span style={{ color: "var(--muted)", fontSize: "0.78rem" }}>(Optional)</span></span>
                            <input
                              className="review-control"
                              type="file"
                              accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
                              onChange={(e) => updateAccommodationEntry(idx, { quotation: e.target.files?.[0] || null })}
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="review-form-grid review-form-grid-2">
                <label>
                  <span>
                    {canRollbackAdvance || canRejectAdvance || canRejectAccommodation || canRejectClaim ? "Comments (required for Roll Back / Reject)" : "Comments (optional)"}
                  </span>
                  <textarea
                    className="review-control review-textarea"
                    value={comments}
                    onChange={(e) => {
                      setComments(e.target.value);
                      if (rollbackError) setRollbackError(null);
                      if (error === "Enter comments before rejecting this advance.") setError(null);
                    }}
                    placeholder={canRollbackAdvance || canRejectAdvance || canRejectAccommodation || canRejectClaim ? "Enter reason for rollback/reject" : ""}
                  />
                  {rollbackError && (
                    <div className="review-warning">
                      {rollbackError}
                    </div>
                  )}
                </label>

                <div className="review-secondary-actions">
                  {item.doc_type === "ADVANCE" && canMarkPaid && (
                    <label>
                      <span>Payment Reference</span>
                      <input
                        className="review-control"
                        value={paidRef}
                        onChange={(e) => setPaidRef(e.target.value)}
                        placeholder="EcoCash txn / voucher"
                      />
                    </label>
                  )}

                  {item.doc_type === "ACCOMMODATION" && canMarkAccommodationPaid && (
                    <label>
                      <span>Payment Reference</span>
                      <input
                        className="review-control"
                        value={paidRef}
                        onChange={(e) => setPaidRef(e.target.value)}
                        placeholder="Budget code"
                      />
                    </label>
                  )}

                  {item.doc_type === "CLAIM" && canSettle && (
                    <div className="review-settlement-fields">
                      <label>
                        <span>Settlement Method</span>
                        <select className="review-control" value={settleMethod} onChange={(e) => setSettleMethod(e.target.value as any)}>
                          <option value="ECOCASH">ECOCASH</option>
                          <option value="BANK">BANK</option>
                        </select>
                      </label>
                      <label>
                        <span>Settlement Reference</span>
                        <input className="review-control" value={settleRef} onChange={(e) => setSettleRef(e.target.value)} />
                      </label>
                    </div>
                  )}
                </div>
              </div>

              <div className="review-action-row">
                {(canApproveAdvance || canRejectAdvance || canRollbackAdvance) && (
                  <>
                    {canApproveAdvance && (
                      <button className="button small-button button-primary" disabled={busy} onClick={handleApproveAdvance}>
                        {role === "HR_MANAGER" ? "Send to HR" : role === "EXCO" ? "EXCO Approve" : "Approve Advance"}
                      </button>
                    )}
                    {canRejectAdvance && (
                      <button
                        className="button small-button button-danger"
                        disabled={busy}
                        onClick={handleRejectAdvance}
                      >
                        Reject Advance
                      </button>
                    )}
                    {canRollbackAdvance && (
                      <button className="button small-button button-subtle" disabled={busy} onClick={handleRollbackAdvance}>
                        Roll Back to Draft
                      </button>
                    )}
                  </>
                )}

                {canMarkPaid && (
                  <button className="button small-button button-primary" disabled={busy || !paidRef.trim()} onClick={() => act(() => api.markAdvancePaid(item.id, paidRef.trim()))}>
                    Mark Advance Paid
                  </button>
                )}

                {canCreateAccommodation && (
                  <button
                    className="button small-button button-primary"
                    disabled={busy}
                    onClick={handleCreateAccommodation}
                  >
                    Send to Finance
                  </button>
                )}

                {canMarkAccommodationPaid && (
                  <button className="button small-button button-primary" disabled={busy || !paidRef.trim()} onClick={() => act(() => api.markAccommodationPaid(item.id, paidRef.trim()))}>
                    Mark Request Paid
                  </button>
                )}

                {canRejectAccommodation && (
                  <button
                    className="button small-button button-danger"
                    disabled={busy || !comments.trim()}
                    onClick={() => act(() => api.rejectAccommodation(item.id, comments.trim()))}
                  >
                    Reject Request
                  </button>
                )}

                {canApproveClaim && (
                  <button className="button small-button button-primary" disabled={busy} onClick={() => act(() => api.approveClaim(item.id, comments))}>
                    Approve Clearance
                  </button>
                )}

                {canRejectClaim && (
                  <button
                    className="button small-button button-danger"
                    disabled={busy || !comments.trim()}
                    onClick={() => act(() => api.rejectClaim(item.id, comments.trim()))}
                  >
                    Reject Clearance
                  </button>
                )}

                {canManagerApprove && (
                  <button className="button small-button button-primary" disabled={busy} onClick={() => act(() => api.managerApproveClaim(item.id, comments))}>
                    Certify Clearance
                  </button>
                )}

                {canChiefApprove && (
                  <button className="button small-button button-primary" disabled={busy} onClick={() => act(() => api.chiefApproveClaim(item.id, comments))}>
                    Chief Officer Approve
                  </button>
                )}

                {canAuthApproveClaim && (
                  <button className="button small-button button-primary" disabled={busy} onClick={() => act(() => api.authApproveClaim(item.id, comments))}>
                    HR Approve
                  </button>
                )}

                {canHrManagerApproveClaim && (
                  <button className="button small-button button-primary" disabled={busy} onClick={() => act(() => api.hrManagerApproveClaim(item.id, comments))}>
                    HR Manager Approve
                  </button>
                )}

                {canFinanceVerify && (
                  <button className="button small-button button-primary" disabled={busy} onClick={() => act(() => api.financeVerifyClaim(item.id, comments))}>
                    Finance Verify
                  </button>
                )}

                {canSettle && (
                  <button className="button small-button button-primary" disabled={busy || !settleRef.trim()} onClick={() => act(() => api.settleClaim(item.id, settleMethod, settleRef.trim()))}>
                    Settle Clearance
                  </button>
                )}

                {!((canRollbackAdvance || canRejectAdvance || canApproveAdvance || canMarkPaid || canCreateAccommodation || canMarkAccommodationPaid || canRejectAccommodation || canApproveClaim || canRejectClaim || canManagerApprove || canAuthApproveClaim || canChiefApprove || canFinanceVerify || canSettle)) && (
                  <div className="review-empty-note">{noActionMessage}</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
