import React, { useEffect, useMemo, useState } from "react";
import { api, getUserFromToken } from "./api";
import { LESOTHO_DISTRICTS, TravelType, formatMoney, isTravelTypeCode, travelTypeLabel } from "./constants";
import { useStaffDirectory } from "./useStaffDirectory";
import { AlertTriangle, AlignLeft, Bell, Briefcase, Building2, Calendar, CheckCircle2, ChevronDown, ChevronUp, ClipboardList, Clock3, CreditCard, FileText, Flag, Hash, Plane, RefreshCw, ShieldCheck, User, Users } from "lucide-react";

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
      current_step_action_type?: string | null;
      current_step_can_reject?: boolean;
      current_step_can_rollback?: boolean;
      current_step_actionable_by_me?: boolean;
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
      current_step_actionable_by_me?: boolean;
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
    }
  | {
      doc_type: "CUSTOM_REQUEST";
      id: string;
      status: string;
      request_type_name: string;
      request_type_code: string;
      requester_name: string | null;
      current_step_position_name: string | null;
      current_step_actionable_by_me?: boolean;
      // True if the viewer is an unconfirmed assignee (e.g. Change Assignee)
      // on this request — distinct from being the current-step approver.
      is_assignee_task?: boolean;
      created_at: string;
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

// Formats a "user" (single object) or "user_multi" (array of assignee
// objects, each either a person or a whole team) field value for display —
// otherwise these render as a bare "[object Object]" via String(value).
function fmtAssigneeValue(value: any): string {
  const label = (a: any) => (a?.teamId ? `Team: ${a.teamName}` : a?.name || a?.email || "—");
  if (Array.isArray(value)) return value.map(label).join(", ") || "—";
  if (value && typeof value === "object") return label(value);
  return String(value ?? "—");
}

// Picks a representative icon for a custom-request field in the review
// modal's Request Details grid — keyed on field_type first, falling back
// to a few common field_key name patterns for better-than-generic results.
function fieldIcon(f: { field_key: string; field_type: string }) {
  if (f.field_type === "user" || f.field_type === "user_multi") return Users;
  if (f.field_type === "section") return Building2;
  if (f.field_type === "date") return Calendar;
  if (f.field_type === "checkbox") return CheckCircle2;
  if (f.field_type === "textarea") return AlignLeft;
  if (f.field_type === "number") return Hash;
  const key = f.field_key.toLowerCase();
  if (key.includes("priority")) return Flag;
  if (key.includes("risk") || key.includes("impact") || key.includes("urgent")) return AlertTriangle;
  if (key.includes("department")) return Briefcase;
  return FileText;
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
    case "CUSTOM_REQUEST":   return "Change Request";
    default:                 return statusLabel(String(value || "Document"));
  }
}

const TERMINAL_STATUSES = new Set(["DRAFT", "SETTLED", "PAID", "REJECTED", "CANCELLED"]);

function docTypeIcon(value: InboxItem["doc_type"] | string | null | undefined) {
  switch (value) {
    case "ADVANCE":          return Plane;
    case "ACCOMMODATION":    return Briefcase;
    case "CLAIM":            return ShieldCheck;
    case "OVERTIME_REQUEST":
    case "OVERTIME_CLAIM":   return Clock3;
    case "CUSTOM_REQUEST":   return ClipboardList;
    default:                 return CreditCard;
  }
}

function docTypeTone(value: InboxItem["doc_type"] | string | null | undefined) {
  switch (value) {
    case "ADVANCE":          return "doc-tone-blue";
    case "ACCOMMODATION":    return "doc-tone-purple";
    case "CLAIM":            return "doc-tone-green";
    case "OVERTIME_REQUEST":
    case "OVERTIME_CLAIM":   return "doc-tone-amber";
    case "CUSTOM_REQUEST":   return "doc-tone-blue";
    default:                 return "doc-tone-blue";
  }
}

function itemStageProgress(item: InboxItem) {
  const status = String(item.status || "").toUpperCase();
  if (item.doc_type === "CUSTOM_REQUEST") return item.current_step_position_name || statusLabel(status);
  if (status === "SUBMITTED") return "Pending";
  if (TERMINAL_STATUSES.has(status)) return statusLabel(status);
  return "In Progress";
}

function itemStatusLabel(item: InboxItem) {
  if (
    (item.doc_type === "CLAIM" || item.doc_type === "ADVANCE") &&
    item.current_step_position_name &&
    !TERMINAL_STATUSES.has(String(item.status || "").toUpperCase())
  ) {
    // The first ("Manager"/Supervisor) step in the chain is a countersign
    // step; every later step is a regular approval step.
    if ((item as any).current_step_action_type === "COUNTER_SIGN" || item.current_step_position_name === "Manager") {
      return "Pending Countersign";
    }
    return "Pending Approval";
  }
  if (item.doc_type === "CUSTOM_REQUEST" && item.status === "IN_PROGRESS") {
    if (item.current_step_actionable_by_me) return "Pending Approval";
    if (item.is_assignee_task) return "Awaiting Your Confirmation";
    return "In Progress";
  }
  return statusLabel(item.status);
}

function itemOwner(item: InboxItem) {
  if (item.doc_type === "CLAIM") return item.claimant_name || "Unknown";
  if (item.doc_type === "OVERTIME_REQUEST" || item.doc_type === "OVERTIME_CLAIM") return item.employee_name || "Unknown";
  if (item.doc_type === "CUSTOM_REQUEST") return item.requester_name || "Unknown";
  return item.requester_name || "Unknown";
}

function itemAmountValue(item: InboxItem) {
  if (item.doc_type === "ADVANCE") return Number(item.requested_total || 0);
  if (item.doc_type === "ACCOMMODATION") return Number(item.amount || 0);
  if (item.doc_type === "OVERTIME_CLAIM") return Number(item.total_amount || 0);
  if (item.doc_type === "OVERTIME_REQUEST" || item.doc_type === "CUSTOM_REQUEST") return 0;
  return Number(item.claim_total || 0);
}

function itemAmount(item: InboxItem) {
  if (item.doc_type === "OVERTIME_REQUEST" || item.doc_type === "CUSTOM_REQUEST") return "—";
  return fmt(itemAmountValue(item));
}

function itemContext(item: InboxItem) {
  if (item.doc_type === "ADVANCE") return item.purpose || "Advance request";
  if (item.doc_type === "ACCOMMODATION") return `${item.location || "Location pending"}${item.provider ? ` - ${item.provider}` : ""}`;
  if (item.doc_type === "OVERTIME_REQUEST") return `${MONTHS[(item.month ?? 1) - 1]} ${item.year} · ${item.section_name || ""}`;
  if (item.doc_type === "OVERTIME_CLAIM") return `${MONTHS[(item.month ?? 1) - 1]} ${item.year} · ${item.division || ""}`;
  if (item.doc_type === "CUSTOM_REQUEST") return item.request_type_name;
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
      g[it.doc_type] = g[it.doc_type] || [];
      g[it.doc_type].push(it);
    }
    return g;
  }, [items]);

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

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

  if (selected) {
    return selected.doc_type === "CUSTOM_REQUEST" ? (
      <CustomRequestReviewModal
        item={selected}
        onClose={() => setSelected(null)}
        onDone={async () => {
          setSelected(null);
          await refresh();
        }}
      />
    ) : (
      <ReviewModal
        item={selected}
        role={role}
        onClose={() => setSelected(null)}
        onDone={async () => {
          setSelected(null);
          await refresh();
        }}
      />
    );
  }

  return (
    <div className="inbox-page">
      <section className="inbox-metrics">
        <div className="inbox-metric-card metric-blue">
          <span className="inbox-metric-icon"><Bell size={22} aria-hidden /></span>
          <div className="inbox-metric-body"><strong>{metrics.awaiting}</strong><span>Awaiting My Approval</span></div>
        </div>
        <div className="inbox-metric-card metric-green">
          <span className="inbox-metric-icon"><ClipboardList size={22} aria-hidden /></span>
          <div className="inbox-metric-body"><strong>{metrics.advances}</strong><span>Advance Requests</span><small>{fmt(metrics.advanceValue)} value</small></div>
        </div>
        <div className="inbox-metric-card metric-gold">
          <span className="inbox-metric-icon"><CheckCircle2 size={22} aria-hidden /></span>
          <div className="inbox-metric-body"><strong>{metrics.clearances}</strong><span>Clearances</span></div>
        </div>
        <div className="inbox-metric-card metric-rose">
          <span className="inbox-metric-icon"><RefreshCw size={22} aria-hidden /></span>
          <div className="inbox-metric-body"><strong>{metrics.recentActions}</strong><span>Recent Actions</span><small>{latestAction ? actionLabel(latestAction.action) : "No history yet"}</small></div>
        </div>
      </section>

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
              {Object.entries(grouped).map(([docType, groupItems]) => {
                const Icon = docTypeIcon(docType);
                const collapsed = Boolean(collapsedGroups[docType]);
                const totalAmount = groupItems.reduce((sum, it) => sum + itemAmountValue(it), 0);
                return (
                  <article key={docType} className={`inbox-group-card ${docTypeTone(docType)}`}>
                    <button type="button" className="inbox-group-header inbox-group-toggle" onClick={() => toggleGroup(docType)} aria-expanded={!collapsed}>
                      <div className="inbox-group-title">
                        <span className="inbox-group-icon"><Icon size={18} aria-hidden /></span>
                        <h4>{docTypeLabel(docType)}</h4>
                        <span className="inbox-count-chip">{groupItems.length}</span>
                      </div>
                      <div className="inbox-group-badges">
                        <span className="inbox-badge inbox-badge-info">Awaiting: {groupItems.length}</span>
                        <span className="inbox-badge inbox-badge-total">Total Amount: {fmt(totalAmount)}</span>
                        {collapsed ? <ChevronDown size={18} aria-hidden /> : <ChevronUp size={18} aria-hidden />}
                      </div>
                    </button>

                    {!collapsed && (
                      <div className="inbox-table-wrap">
                        <table className="inbox-table">
                          <thead>
                            <tr>
                              <th>Owner</th>
                              <th>Status / Stage</th>
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
                                  <div className="inbox-stage-cell">
                                    <span className={`status-pill ${statusTone(it.status)}`}>{itemStatusLabel(it)}</span>
                                    <small>{itemStageProgress(it)}</small>
                                  </div>
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
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

      <section className="inbox-panel inbox-history-panel">
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
      </section>
    </div>
  );
}

function ReviewModal(props: { item: InboxItem; role: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { item, role } = props;
  const me = getUserFromToken();
  const isFinanceDept = String(me?.department || "").trim().toLowerCase() === "finance";
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState("");
  const [paidRef, setPaidRef] = useState("");
  const [settleRef, setSettleRef] = useState("");
  const [settleMethod, setSettleMethod] = useState<"ECOCASH" | "BANK">("ECOCASH");
  const [financeDecision, setFinanceDecision] = useState<"ACCEPTED" | "REFUND_FROM_EMPLOYEE" | "REIMBURSE_EMPLOYEE" | "">("");
  const [settlementAmount, setSettlementAmount] = useState("");
  const [assigneeType, setAssigneeType] = useState<"INDIVIDUAL" | "TEAM">("INDIVIDUAL");
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [assigneeGroupName, setAssigneeGroupName] = useState("");
  const [expectedPaymentDate, setExpectedPaymentDate] = useState("");
  const { staff: financeStaff } = useStaffDirectory();
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

  // Builds the approval-chain progress strip: which stages are done, the
  // currently-pending stage (a "stage" = the current step plus any later
  // steps flagged parallel_with_previous, which become pending together),
  // and everything still waiting.
  const approvalProgressStages = useMemo(() => {
    const chain: any[] = Array.isArray(detail?.approval_chain) ? detail.approval_chain : [];
    if (!chain.length) return [];
    const stepOrder = detail?.workflow_step_order ?? 0;
    let pendingStart = stepOrder;
    while (pendingStart > 0 && chain[pendingStart]?.parallel_with_previous) pendingStart--;
    const pendingStage = new Set<number>();
    if (pendingStart < chain.length) {
      pendingStage.add(pendingStart);
      for (let i = pendingStart + 1; i < chain.length && chain[i]?.parallel_with_previous; i++) pendingStage.add(i);
    }
    const initiatorStage = {
      key: "step-initiator",
      label: "Employee",
      state: "done" as const,
      status: "Submitted",
      actor: detail?.requester_name || ""
    };
    const chainStages = chain.map((step: any, idx: number) => {
      const isTeamGroup = typeof step.position_name === "string" && step.position_name.startsWith("Team: ");
      const label = isTeamGroup ? step.position_name.slice("Team: ".length) : (step.approver_title || step.position_name);
      const isDone = Boolean(step.approved) || stepOrder > idx;
      const isActive = !isDone && pendingStage.has(idx);
      return {
        key: `step-${idx}`,
        label,
        state: isDone ? "done" : isActive ? "active" : "waiting",
        status: isDone ? "Approved" : isActive ? "In Progress" : "Waiting",
        actor: isTeamGroup ? "" : (step.approver_name || "")
      };
    });

    // Once the dynamic chain finishes, a CLAIM moves through fixed
    // Finance/Payment/Closed stages that aren't part of approval_chain.
    if (item.doc_type === "CLAIM") {
      const claimStatus = detail?.status;
      const financeDone = ["PAYMENT_PROCESSING", "SETTLED", "CLOSED"].includes(claimStatus);
      const financeActive = claimStatus === "FINANCE_VERIFIED";
      const paymentDone = claimStatus === "CLOSED";
      const paymentActive = claimStatus === "PAYMENT_PROCESSING";
      return [
        initiatorStage,
        ...chainStages,
        {
          key: "step-finance",
          label: "Finance Verification",
          state: financeDone ? "done" : financeActive ? "active" : "waiting",
          status: financeDone ? "Verified" : financeActive ? "In Progress" : "Waiting",
          actor: ""
        },
        {
          key: "step-payment",
          label: "Payment Processing",
          state: paymentDone ? "done" : paymentActive ? "active" : "waiting",
          status: paymentDone ? "Paid" : paymentActive ? "In Progress" : "Waiting",
          actor: ""
        },
        {
          key: "step-closed",
          label: "Closed",
          state: claimStatus === "CLOSED" ? "done" : "waiting",
          status: claimStatus === "CLOSED" ? "Closed" : "Pending",
          actor: ""
        }
      ];
    }

    return [initiatorStage, ...chainStages];
  }, [detail?.approval_chain, detail?.workflow_step_order, detail?.requester_name, detail?.status, item.doc_type]);

  // For workflow-driven advances, use the current_step_approver_id set by the backend.
  // For legacy advances (no approver_id), fall back to role+status checks.
  const isWorkflowDriven = item.doc_type === "ADVANCE" && item.current_step_approver_id !== undefined;
  const isMyWorkflowStep = isWorkflowDriven && (
    item.current_step_actionable_by_me !== undefined
      ? Boolean(item.current_step_actionable_by_me)
      : item.current_step_approver_id === me?.userId
  );
  // The current step is an accommodation-only step (e.g. HR preparing
  // accommodation before forwarding to Finance) — at this step the assignee
  // attaches the accommodation booking instead of approving/rejecting.
  const isAccommodationStep = isWorkflowDriven && Boolean((item as any).current_step_requires_accommodation);
  const inProgressStatuses = ["SUBMITTED", "COUNTERSIGNED", "HR_MANAGER_REVIEW", "HR_REVIEW", "HR_OFFICER"];
  // Workflow steps can be configured (in the Workflow Designer) to label
  // their approval action "Counter Sign" instead of "Approve".
  const isCounterSignStep =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? (item as any).current_step_action_type === "COUNTER_SIGN"
      : (role === "MANAGER" && item.status === "SUBMITTED"));
  // A workflow step can be configured with action type "MARK_PAID" — at that
  // step the assignee records payment instead of approving/rejecting.
  const isMarkPaidStep = isWorkflowDriven && (item as any).current_step_action_type === "MARK_PAID";

  const canRollbackAdvance =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationStep && (item as any).current_step_can_rollback !== false
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "MANAGER" && item.status === "HR_REVIEW") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED")));
  const canRejectAdvance =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationStep && (item as any).current_step_can_reject !== false
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "MANAGER" && item.status === "HR_REVIEW") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED") ||
          (isFinanceDept && ["HR_OFFICER", "APPROVED"].includes(item.status)) ||
          (role === "ADMIN" && inProgressStatuses.includes(item.status))));
  const canApproveAdvance =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationStep && !isMarkPaidStep
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "HR_MANAGER" && item.status === "HR_MANAGER_REVIEW") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED")));
  const canMarkPaid =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && isMarkPaidStep
      : ((isFinanceDept || role === "ADMIN" || Boolean((item as any).is_final_step_approver)) &&
          ["HR_OFFICER", "APPROVED"].includes(item.status)));
  const canCreateAccommodation =
    item.doc_type === "ADVANCE" &&
    isTravelAdvance &&
    usesDistrictAccommodation &&   // local travel only
    isMultiDayTravel &&            // must be more than 1 day
    (isWorkflowDriven
      ? isMyWorkflowStep && isAccommodationStep
      : (role === "MANAGER" && ["HR_REVIEW", "HR_OFFICER", "APPROVED"].includes(item.status)));
  const canMarkAccommodationPaid = item.doc_type === "ACCOMMODATION" && isFinanceDept && item.status === "SUBMITTED";
  const canRejectAccommodation = item.doc_type === "ACCOMMODATION" && isFinanceDept && item.status === "SUBMITTED";

  // Workflow-driven clearance claims (e.g. "Travel Clearance DT") expose the
  // current step's approver via current_step_approver_id, mirroring advances.
  const isWorkflowDrivenClaim = item.doc_type === "CLAIM" && item.current_step_approver_id !== undefined;
  const isMyClaimWorkflowStep = isWorkflowDrivenClaim && (
    item.current_step_actionable_by_me !== undefined
      ? Boolean(item.current_step_actionable_by_me)
      : item.current_step_approver_id === me?.userId
  );
  const canApproveClaim = isWorkflowDrivenClaim && isMyClaimWorkflowStep;
  const canRejectClaim = isWorkflowDrivenClaim && isMyClaimWorkflowStep;
  const canRollbackClaim = item.doc_type === "CLAIM" && isWorkflowDrivenClaim && isMyClaimWorkflowStep;
  const canSettle = item.doc_type === "CLAIM" && (role === "ADMIN" || isFinanceDept) && item.status === "FINANCE_VERIFIED";
  const canRequestCorrection = item.doc_type === "CLAIM" && (role === "ADMIN" || isFinanceDept) && item.status === "FINANCE_VERIFIED";
  const canMarkSettled = item.doc_type === "CLAIM" && (role === "ADMIN" || isFinanceDept) && item.status === "PAYMENT_PROCESSING";

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
      return true;
    } catch (e: any) {
      setError(String(e.message));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleMarkAdvancePaid() {
    const ok = await act(() => api.markAdvancePaid(item.id, paidRef.trim()));
    if (!ok) return;
    try {
      const blob = await api.advancePdf(item.id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e: any) {
      setError(e?.message || "Advance marked as paid, but failed to generate the PDF.");
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

  function handleRollbackClaim() {
    if (!comments.trim()) {
      setRollbackError("Enter rollback comments before sending this clearance back to the owner as draft.");
      return;
    }
    setRollbackError(null);
    void act(() => api.rollbackClaim(item.id, comments.trim()));
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

  const referenceCode = `${item.doc_type === "CLAIM" ? "CLR" : item.doc_type === "ACCOMMODATION" ? "ACC" : "ADV"}-${item.id.slice(0, 8).toUpperCase()}`;
  const pageTitle = item.doc_type === "CLAIM" ? "Travel Advance Clearance Review" : item.doc_type === "ACCOMMODATION" ? "Travel Advance Request Review" : "Advance Request Review";

  return (
    <div className="review-page">
      <div className="review-page-header">
        <div>
          <div className="review-page-eyebrow">Request Review</div>
          <h2>{pageTitle}</h2>
          <span className="review-page-ref">{referenceCode}</span>
          <span className={`status-pill ${statusTone(item.status)}`}>{itemStatusLabel(item)}</span>
        </div>
        <button className="button small-button button-subtle" onClick={props.onClose}>
          Back to Inbox
        </button>
      </div>

      {error && <pre className="inbox-error">{error}</pre>}

      {!detail ? (
        <div className="review-loading">Loading request details...</div>
      ) : (
        <>
          <div className="review-info-row">
            <div className="review-info-card">
              <span className="review-info-icon"><User size={16} aria-hidden /></span>
              <div><small>Employee</small><strong>{itemOwner(item)}</strong></div>
            </div>
            <div className="review-info-card">
              <span className="review-info-icon"><Building2 size={16} aria-hidden /></span>
              <div><small>Department</small><strong>{detail.department || detail.requester_department || "—"}</strong></div>
            </div>
            <div className="review-info-card">
              <span className="review-info-icon"><Hash size={16} aria-hidden /></span>
              <div><small>Reference</small><strong>{referenceCode}</strong></div>
            </div>
            <div className="review-info-card">
              <span className="review-info-icon"><Calendar size={16} aria-hidden /></span>
              <div><small>Submitted On</small><strong>{detail.submitted_at || detail.created_at ? fmtWhen(detail.submitted_at || detail.created_at) : "—"}</strong></div>
            </div>
          </div>

          {item.doc_type === "CLAIM" ? (
            <div className="review-page-grid">
              <div className="review-page-main">
                <div className="review-card">
                  <div className="review-card-title">Reconciliation Summary</div>
                  <div className="recon-summary">
                    <div className="recon-stat">
                      <small>Advance Paid</small>
                      <strong>{fmt(detail.advance_amount)}</strong>
                    </div>
                    <div className="recon-stat">
                      <small>Actual Expenditure</small>
                      <strong>{fmt(detail.claim_total)}</strong>
                    </div>
                    <div className="recon-stat">
                      <small>Variance (Over / Under)</small>
                      <strong className={Number(detail.balance_amount) < 0 ? "recon-negative" : ""}>{fmt(detail.balance_amount)}</strong>
                    </div>
                  </div>
                  <div className="recon-settlement-banner">
                    <span className="review-info-icon"><User size={16} aria-hidden /></span>
                    <div>
                      <small>Settlement Type</small>
                      <strong>
                        {Number(detail.balance_amount) > 0
                          ? "Employee Owes Company"
                          : Number(detail.balance_amount) < 0
                            ? "Company Owes Employee"
                            : "Settled in Full"}
                      </strong>
                    </div>
                    <div className="recon-settlement-amount">
                      <small>Settlement Amount</small>
                      <strong>{fmt(Math.abs(Number(detail.balance_amount || 0)))}</strong>
                    </div>
                  </div>
                </div>

                <div className="review-card">
                  <div className="review-card-title">Expense Breakdown</div>
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
                </div>

                {approvalProgressStages.length > 0 && (
                  <div className="review-card">
                    <div className="review-card-title">Approval Workflow</div>
                    <div className="tracking-progress-strip">
                      {approvalProgressStages.map((stage: any, index: number) => (
                        <div key={stage.key} className={`tracking-progress-step is-${stage.state}`}>
                          {index < approvalProgressStages.length - 1 && <span className="tracking-progress-line" aria-hidden />}
                          <span className="tracking-step-icon">
                            {stage.state === "done" ? <CheckCircle2 size={22} aria-hidden /> : stage.state === "active" ? <User size={21} aria-hidden /> : <Clock3 size={20} aria-hidden />}
                          </span>
                          <strong>{stage.label}</strong>
                          <em>{stage.status}</em>
                          {stage.actor && <small>{stage.actor}</small>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="review-card">
                  <div className="review-card-title">
                    {canSettle ? "Finance Comments (required)" :
                      canRejectClaim || canRollbackClaim || canRequestCorrection ? "Comments (required for Roll Back / Reject / Request Correction)" : "Comments (optional)"}
                  </div>
                  <div style={{ padding: 14 }}>
                    <textarea
                      className="review-control review-textarea"
                      value={comments}
                      onChange={(e) => {
                        setComments(e.target.value);
                        if (rollbackError) setRollbackError(null);
                      }}
                      placeholder="Notes on the reconciliation / settlement decision"
                    />
                    {rollbackError && <div className="review-warning">{rollbackError}</div>}
                  </div>
                </div>

                <div className="review-action-row review-action-row-page">
                  {canApproveClaim && (
                    <button className="button small-button button-primary" disabled={busy} onClick={() => act(() => api.approveClaim(item.id, comments))}>
                      Approve Clearance
                    </button>
                  )}
                  {canRejectClaim && (
                    <button className="button small-button button-danger" disabled={busy || !comments.trim()} onClick={() => act(() => api.rejectClaim(item.id, comments.trim()))}>
                      Reject Clearance
                    </button>
                  )}
                  {canRollbackClaim && (
                    <button className="button small-button button-subtle" disabled={busy} onClick={handleRollbackClaim}>
                      Roll Back to Draft
                    </button>
                  )}
                  {canRequestCorrection && (
                    <button className="button small-button button-subtle" disabled={busy} onClick={handleRollbackClaim}>
                      Request Correction
                    </button>
                  )}
                  {canSettle && financeDecision === "ACCEPTED" && (
                    <button
                      className="button small-button button-success"
                      disabled={busy || !comments.trim()}
                      onClick={() => act(() => api.financeDecideClaim(item.id, { finance_decision: "ACCEPTED", finance_comments: comments.trim() }))}
                    >
                      Approve Clearance
                    </button>
                  )}
                  {canSettle && (financeDecision === "REFUND_FROM_EMPLOYEE" || financeDecision === "REIMBURSE_EMPLOYEE") && (
                    <button
                      className="button small-button button-primary"
                      disabled={busy || !comments.trim() || !settleRef.trim()}
                      onClick={() => act(() => api.financeDecideClaim(item.id, {
                        finance_decision: financeDecision,
                        finance_comments: comments.trim(),
                        settlement_amount: settlementAmount ? Number(settlementAmount) : undefined,
                        settled_method: settleMethod,
                        settled_reference: settleRef.trim(),
                        assignee_user_id: assigneeType === "INDIVIDUAL" ? (assigneeUserId || undefined) : undefined,
                        assignee_group_name: assigneeType === "TEAM" ? (assigneeGroupName.trim() || undefined) : undefined,
                        expected_payment_date: expectedPaymentDate || undefined
                      }))}
                    >
                      Approve &amp; Send To Payment
                    </button>
                  )}
                  {canMarkSettled && (
                    <button className="button small-button button-success" disabled={busy} onClick={() => act(() => api.markClaimSettled(item.id, settleRef.trim() ? settleMethod : undefined, settleRef.trim() || undefined))}>
                      Mark Settled
                    </button>
                  )}
                  {!(canApproveClaim || canRejectClaim || canRollbackClaim || canRequestCorrection || canSettle || canMarkSettled) && (
                    <div className="review-empty-note">{noActionMessage}</div>
                  )}
                </div>
              </div>

              <div className="review-page-sidebar">
                <div className="review-card">
                  <div className="review-card-title">Receipts Submitted</div>
                  <div className="review-empty-note" style={{ padding: 14 }}>No receipts attached to this clearance.</div>
                </div>

                {canSettle && (
                  <div className="review-card">
                    <div className="review-card-title">Finance Decision</div>
                    <div className="review-settlement-fields" style={{ padding: 14 }}>
                      <label>
                        <span>Settlement Decision</span>
                        <div className="review-radio-group">
                          {([
                            ["ACCEPTED", "Clearance Accepted"],
                            ["REFUND_FROM_EMPLOYEE", "Employee Must Refund Company"],
                            ["REIMBURSE_EMPLOYEE", "Company Must Reimburse Employee"]
                          ] as const).map(([value, label]) => (
                            <label key={value} className="review-radio-option">
                              <input
                                type="radio"
                                name="finance-decision"
                                checked={financeDecision === value}
                                onChange={() => setFinanceDecision(value)}
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </label>

                      {(financeDecision === "REFUND_FROM_EMPLOYEE" || financeDecision === "REIMBURSE_EMPLOYEE") && (
                        <>
                          <div className="review-card-title review-card-subtitle">Settlement Details</div>
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
                          <label>
                            <span>Amount {financeDecision === "REIMBURSE_EMPLOYEE" ? "To Reimburse" : "To Recover"}</span>
                            <input
                              type="number"
                              className="review-control"
                              value={settlementAmount}
                              onChange={(e) => setSettlementAmount(e.target.value)}
                              placeholder={Math.abs(Number(item.balance_amount || 0)).toFixed(2)}
                            />
                          </label>
                          <label>
                            <span>Assign To</span>
                            <div className="review-radio-group">
                              <label className="review-radio-option">
                                <input type="radio" name="assignee-type" checked={assigneeType === "INDIVIDUAL"} onChange={() => setAssigneeType("INDIVIDUAL")} />
                                Individual
                              </label>
                              <label className="review-radio-option">
                                <input type="radio" name="assignee-type" checked={assigneeType === "TEAM"} onChange={() => setAssigneeType("TEAM")} />
                                Team
                              </label>
                            </div>
                          </label>
                          {assigneeType === "INDIVIDUAL" ? (
                            <label>
                              <span>Individual</span>
                              <select className="review-control" value={assigneeUserId} onChange={(e) => setAssigneeUserId(e.target.value)}>
                                <option value="">Select a person…</option>
                                {financeStaff.filter((u) => u.is_active !== false).map((u) => (
                                  <option key={u.id} value={u.id}>{u.full_name || u.email}{u.title ? ` — ${u.title}` : ""}</option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <label>
                              <span>Team</span>
                              <input className="review-control" value={assigneeGroupName} onChange={(e) => setAssigneeGroupName(e.target.value)} placeholder="e.g. Payroll Officers" />
                            </label>
                          )}
                          <label>
                            <span>Expected Payment Date</span>
                            <input type="date" className="review-control" value={expectedPaymentDate} onChange={(e) => setExpectedPaymentDate(e.target.value)} />
                          </label>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {canMarkSettled && (
                  <div className="review-card">
                    <div className="review-card-title">Settlement Details</div>
                    <div className="review-settlement-fields" style={{ padding: 14 }}>
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
                  </div>
                )}
              </div>
            </div>
          ) : (
          <div
            className={`review-modal-grid ${isTravelAdvance ? "review-modal-grid-two" : ""}`}
          >
            <div className="review-card">
              <div className="review-card-title">Summary</div>
              {item.doc_type === "ADVANCE" ? (
                <div className="review-detail-list">
                  <div>Type: {travelTypeLabel(detail.type, travelTypes)}</div>
                  <div>Purpose: {detail.purpose || "—"}</div>
                  <div>Requested Total: {formatMoney(detail.requested_total, detail.travel_currency)}</div>
                  <div>Approved Total: {formatMoney(detail.approved_total, detail.travel_currency)}</div>
                  <div>Payment: {detail.payment_method} {detail.payment_account || ""}</div>
                </div>
              ) : (
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
              )}
            </div>

            {isTravelAdvance && (
              <div className="review-card">
                <div className="review-card-title">Lines</div>

                <div className="review-table-wrap">
                  <table className="review-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Location</th>
                        <th>{detail.travel_rate_kind === "DAILY" ? "Days" : "Meals"}</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detail.lines || []).map((l: any) => (
                        <tr key={l.id}>
                          <td>{fmtDate(l.line_date)}</td>
                          <td>{l.location || "—"}</td>
                          <td>{lineMealCount(l)}</td>
                          <td>{formatMoney(lineAmount(l), detail.travel_currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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

            {item.doc_type === "ADVANCE" && approvalProgressStages.length > 0 && (
              <div className="review-card review-card-wide">
                <div className="review-card-title">Approval Progress</div>
                <div className="tracking-progress-strip">
                  {approvalProgressStages.map((stage: any, index: number) => (
                    <div key={stage.key} className={`tracking-progress-step is-${stage.state}`}>
                      {index < approvalProgressStages.length - 1 && <span className="tracking-progress-line" aria-hidden />}
                      <span className="tracking-step-icon">
                        {stage.state === "done" ? <CheckCircle2 size={22} aria-hidden /> : stage.state === "active" ? <User size={21} aria-hidden /> : <Clock3 size={20} aria-hidden />}
                      </span>
                      <strong>{stage.label}</strong>
                      <em>{stage.status}</em>
                      {stage.actor && <small>{stage.actor}</small>}
                    </div>
                  ))}
                </div>
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
                    {canRollbackAdvance || canRejectAdvance || canRejectAccommodation ? "Comments (required for Roll Back / Reject)" : "Comments (optional)"}
                  </span>
                  <textarea
                    className="review-control review-textarea"
                    value={comments}
                    onChange={(e) => {
                      setComments(e.target.value);
                      if (rollbackError) setRollbackError(null);
                      if (error === "Enter comments before rejecting this advance.") setError(null);
                    }}
                    placeholder={canRollbackAdvance || canRejectAdvance || canRejectAccommodation ? "Enter reason for rollback/reject" : ""}
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
                </div>
              </div>

              <div className="review-action-row">
                {(canApproveAdvance || canRejectAdvance || canRollbackAdvance) && (
                  <>
                    {canApproveAdvance && (
                      <button className="button small-button button-primary" disabled={busy} onClick={handleApproveAdvance}>
                        {role === "HR_MANAGER" ? "Send to HR" : role === "EXCO" ? "EXCO Approve" : isCounterSignStep ? "Counter Sign" : "Approve Advance"}
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
                  <button className="button small-button button-primary" disabled={busy || !paidRef.trim()} onClick={handleMarkAdvancePaid}>
                    Mark Advance Paid
                  </button>
                )}

                {canCreateAccommodation && (
                  <button
                    className="button small-button button-primary"
                    disabled={busy}
                    onClick={handleCreateAccommodation}
                    style={busy ? { opacity: 0.75, cursor: "not-allowed" } : undefined}
                  >
                    {busy ? "Booking…" : "Book Accommodation"}
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

                {!((canRollbackAdvance || canRejectAdvance || canApproveAdvance || canMarkPaid || canCreateAccommodation || canMarkAccommodationPaid || canRejectAccommodation)) && (
                  <div className="review-empty-note">{noActionMessage}</div>
                )}
              </div>
            </div>
          </div>
          )}
        </>
      )}
    </div>
  );
}

function CustomRequestReviewModal(props: { item: InboxItem; onClose: () => void; onDone: () => Promise<void> }) {
  const { item } = props;
  const [detail, setDetail] = useState<any>(null);
  const [consolidated, setConsolidated] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      setError(null);
      try {
        setDetail(await api.customRequestDetail(item.id));
      } catch (e: any) {
        setError(String(e.message));
      }
      try {
        setConsolidated(await api.customRequestConsolidated(item.id));
      } catch {
        setConsolidated([]);
      }
    })();
  }, [item.id]);

  async function act(action: "APPROVE" | "REJECT") {
    setBusy(true);
    setError(null);
    try {
      await api.actionCustomRequest(item.id, { action, comment: comment.trim() || undefined });
      await props.onDone();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  const canAct = item.doc_type === "CUSTOM_REQUEST" && item.current_step_actionable_by_me && item.status === "IN_PROGRESS";
  const isAssigneeTask = item.doc_type === "CUSTOM_REQUEST" && !!item.is_assignee_task;

  return (
    <div className="review-modal-backdrop">
      <div className="review-modal-shell">
        <div className="review-modal-header">
          <div>
            <div className="review-modal-eyebrow">Request Review</div>
            <h3>Review {detail?.request_type_name || "Change Request"}</h3>
            <span className={`status-pill ${statusTone(item.status)}`}>{itemStatusLabel(item)}</span>
          </div>
          <button className="button small-button button-subtle" onClick={props.onClose}>
            Close
          </button>
        </div>

        {error && <pre className="inbox-error">{error}</pre>}

        {!detail ? (
          <div className="review-loading">Loading request details...</div>
        ) : (
          <div className="review-modal-grid review-modal-grid-two">
            <div className="review-card review-card-wide">
              <div className="review-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <FileText size={16} /> Request Details
              </div>
              <div className="review-field-grid">
                <div className="review-field-item">
                  <div className="review-field-icon"><User size={16} /></div>
                  <div>
                    <div className="review-field-label">Requested By</div>
                    <div className="review-field-value">{detail.requester_name || "—"}</div>
                  </div>
                </div>
                {(detail.fields || []).map((f: any) => {
                  const value = detail.data?.[f.field_key];
                  if (value === undefined || value === null || value === "") return null;
                  if (f.field_type === "table") {
                    const cfg = f.options || {};
                    const columns: { key: string; label: string }[] =
                      cfg.columnMode === "FIXED"
                        ? (cfg.columns || [])
                        : Array.from({ length: (value.rows || []).length ? Math.max(...((value.rows || []).flatMap((r: any) => Object.keys(r.cells || {}).map(Number)).concat([0]))) : 0 }, (_, i) => ({ key: String(i + 1), label: String(i + 1) }));
                    const summaryColumns: { key: string; label: string }[] = cfg.summaryColumns || [];
                    const dayCellStyle = { textAlign: "center" as const, padding: "5px 4px", minWidth: 26, fontSize: "0.8rem" };
                    const dayHeadStyle = { ...dayCellStyle, padding: "8px 4px" };
                    const summaryCellStyle = { textAlign: "center" as const, padding: "5px 8px", minWidth: 48, fontSize: "0.8rem" };
                    return (
                      <div key={f.field_key} style={{ gridColumn: "1 / -1" }}>
                        <div style={{ marginBottom: 6 }}>{f.field_label}</div>
                        <div className="review-table-wrap" style={{ overflowX: "auto", maxWidth: "100%" }}>
                          <table className="review-table" style={{ width: "auto" }}>
                            <thead>
                              <tr>
                                <th style={{ position: "sticky", left: 0, background: "var(--surface-soft)" }}>Employee</th>
                                {columns.map((c) => <th key={c.key} style={dayHeadStyle}>{c.label}</th>)}
                                {summaryColumns.map((c) => <th key={c.key} style={{ ...summaryCellStyle, padding: "8px 8px" }}>{c.label}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {(value.rows || []).map((row: any, ri: number) => (
                                <tr key={ri}>
                                  <td style={{ position: "sticky", left: 0, background: "var(--surface)", whiteSpace: "nowrap" }}>{row.employee || "—"}</td>
                                  {columns.map((c) => <td key={c.key} style={dayCellStyle}>{row.cells?.[c.key] || "—"}</td>)}
                                  {summaryColumns.map((c) => <td key={c.key} style={summaryCellStyle}>{value.summary?.perRow?.[ri]?.[c.key] ?? 0}</td>)}
                                </tr>
                              ))}
                              {!!(value.rows || []).length && (
                                <tr>
                                  <td style={{ fontWeight: 700, position: "sticky", left: 0, background: "var(--surface)" }}>Total</td>
                                  {columns.map((c) => <td key={c.key} />)}
                                  {summaryColumns.map((c) => <td key={c.key} style={{ ...summaryCellStyle, fontWeight: 700 }}>{value.summary?.totals?.[c.key] ?? 0}</td>)}
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  }
                  const display = f.field_type === "checkbox"
                    ? (value ? "Yes" : "No")
                    : (f.field_type === "user" || f.field_type === "user_multi")
                      ? fmtAssigneeValue(value)
                      : String(value);
                  const Icon = fieldIcon(f);
                  return (
                    <div className="review-field-item" key={f.field_key}>
                      <div className="review-field-icon"><Icon size={16} /></div>
                      <div>
                        <div className="review-field-label">{f.field_label}</div>
                        <div className={`review-field-value ${f.field_type === "textarea" ? "review-field-value-multiline" : ""}`}>{display}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {(() => {
              const tableField = (detail.fields || []).find((f: any) => f.field_type === "table");
              if (!tableField || consolidated.length < 2) return null;
              const cfg = tableField.options || {};
              const allRows = consolidated.flatMap((sub: any) => {
                const tv = sub.data?.[tableField.field_key];
                return (tv?.rows || []).map((row: any, ri: number) => ({
                  employee: row.employee || sub.requester_name,
                  status: sub.status,
                  cells: row.cells || {},
                  summary: tv?.summary?.perRow?.[ri] || {}
                }));
              });
              const maxDay = Math.max(0, ...allRows.flatMap((r: any) => Object.keys(r.cells).map(Number)));
              const columns: { key: string; label: string }[] =
                cfg.columnMode === "FIXED" ? (cfg.columns || []) : Array.from({ length: maxDay }, (_, i) => ({ key: String(i + 1), label: String(i + 1) }));
              const summaryColumns: { key: string; label: string }[] = cfg.summaryColumns || [];
              const dayCellStyle = { textAlign: "center" as const, padding: "5px 4px", minWidth: 26, fontSize: "0.8rem" };
              const dayHeadStyle = { ...dayCellStyle, padding: "8px 4px" };
              const summaryCellStyle = { textAlign: "center" as const, padding: "5px 8px", minWidth: 48, fontSize: "0.8rem" };
              return (
                <div className="review-card review-card-wide">
                  <div className="review-card-title">Team Register — Consolidated</div>
                  <div className="review-table-wrap" style={{ overflowX: "auto", maxWidth: "100%" }}>
                    <table className="review-table" style={{ width: "auto" }}>
                      <thead>
                        <tr>
                          <th style={{ position: "sticky", left: 0, background: "var(--surface-soft)" }}>Employee</th>
                          <th>Status</th>
                          {columns.map((c) => <th key={c.key} style={dayHeadStyle}>{c.label}</th>)}
                          {summaryColumns.map((c) => <th key={c.key} style={{ ...summaryCellStyle, padding: "8px 8px" }}>{c.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {allRows.map((row: any, ri: number) => (
                          <tr key={ri}>
                            <td style={{ position: "sticky", left: 0, background: "var(--surface)", whiteSpace: "nowrap" }}>{row.employee || "—"}</td>
                            <td><span className={`status-pill ${statusTone(row.status)}`}>{statusLabel(row.status)}</span></td>
                            {columns.map((c) => <td key={c.key} style={dayCellStyle}>{row.cells[c.key] || "—"}</td>)}
                            {summaryColumns.map((c) => <td key={c.key} style={summaryCellStyle}>{row.summary[c.key] ?? 0}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            <div className="review-card review-card-wide">
              <div className="review-card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Users size={16} /> Approval Chain
              </div>
              <div>
                {(detail.approval_chain || []).map((step: any, idx: number) => {
                  const isCurrent = idx === detail.current_step_order && detail.status === "IN_PROGRESS";
                  return (
                    <div className="review-chain-step" key={idx}>
                      <div className="review-chain-step-number">{idx + 1}</div>
                      <div className="review-chain-step-info">
                        <strong>{step.position_name}</strong> — {step.approver_name || "—"}
                        {step.decision_type === "NOTE" && <span style={{ color: "var(--muted)", fontSize: 12 }}> (noting)</span>}
                        {step.comment && <div style={{ fontSize: 12, color: "var(--muted)" }}>"{step.comment}"</div>}
                      </div>
                      <span className={`status-pill ${statusTone(isCurrent ? "PENDING" : step.status)}`}>
                        {isCurrent ? "Pending" : statusLabel(step.status)}
                      </span>
                      {isCurrent && <span className="review-chain-current-flag">Current Step</span>}
                    </div>
                  );
                })}
              </div>

              {canAct && (
                <div style={{ padding: "0 14px 16px" }}>
                  <textarea
                    className="ep-form-textarea"
                    rows={2}
                    placeholder="Add a comment (optional)"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    style={{ width: "100%", marginBottom: 10, marginTop: 14 }}
                  />
                  <div style={{ display: "flex", gap: 10 }}>
                    <button className="button small-button button-primary" disabled={busy} onClick={() => act("APPROVE")}>
                      {detail.approval_chain?.[detail.current_step_order]?.decision_type === "NOTE" ? "Acknowledge (Note)" : "Approve"}
                    </button>
                    <button className="button small-button button-danger" disabled={busy} onClick={() => act("REJECT")}>
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {!canAct && isAssigneeTask && (
                <div className="review-empty-note" style={{ padding: "0 14px 16px" }}>
                  You've been named as an assignee on this request — go to Custom Requests &rsaquo; Assigned to Me to fill in implementation details and confirm.
                </div>
              )}
              {!canAct && !isAssigneeTask && <div className="review-empty-note" style={{ padding: "0 14px 16px" }}>This request is not awaiting your action.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
