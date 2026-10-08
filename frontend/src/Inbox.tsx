import React, { useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import { api, getUserFromToken, navigateTabToBlob, openBlankTab, openBlobInNewTab } from "./api";
import { showNotice, confirmAction } from "./alerts";
import { LESOTHO_DISTRICTS, TravelType, displayOrgGroupName, formatMoney, isTravelTypeCode, stepDoneStatusLabel, travelTypeLabel } from "./constants";
import { useStaffDirectory } from "./useStaffDirectory";
import { roleLabel } from "./roles";
import { AlertTriangle, AlignLeft, Bell, Briefcase, Building2, Calendar, CheckCircle2, ChevronLeft, ChevronRight, Circle, CircleDot, ClipboardList, Clock3, CreditCard, Download, Eye, FileText, Flag, Hash, Hourglass, Info, type LucideIcon, MapPin, Plane, RefreshCw, Search, ShieldCheck, User, Users } from "lucide-react";
import { BusinessUnitTabs, IconTabRow, FinanceEmptyState, type BusinessUnit } from "./components/FinanceQueueKit";

const PAGE_SIZE_OPTIONS = [10, 25, 50];

type InboxItem =
  | {
      doc_type: "ADVANCE";
      id: string;
      status: string;
      requested_total: number;
      approved_total: number;
      purpose: string | null;
      requester_name: string;
      currency?: string | null;
      division?: string | null;
      advance_type?: string;
      workflow_step_order?: number | null;
      current_step_approver_id?: string | null;
      current_step_position_name?: string | null;
      current_step_requires_accommodation?: boolean;
      current_step_action_type?: string | null;
      current_step_can_reject?: boolean;
      current_step_can_rollback?: boolean;
      current_step_actionable_by_me?: boolean;
      is_delegated?: boolean;
      delegated_from_manager_name?: string | null;
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
      current_step_actionable_by_me?: boolean;
    }
  | {
      doc_type: "CLAIM";
      id: string;
      status: string;
      claim_total: number;
      advance_amount: number;
      balance_amount: number;
      currency?: string | null;
      claimant_name: string;
      workflow_step_order?: number | null;
      current_step_approver_id?: string | null;
      current_step_position_name?: string | null;
      current_step_actionable_by_me?: boolean;
      is_delegated?: boolean;
      delegated_from_manager_name?: string | null;
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
      is_delegated?: boolean;
      delegated_from_manager_name?: string | null;
      created_at: string;
    }
  | {
      doc_type: "OVERTIME_REQUEST";
      id: string;
      status: string;
      request_no: string;
      employee_name: string;
      year: number;
      month: number;
      my_title: string | null;
      submitted_at: string | null;
      current_step_actionable_by_me?: boolean;
      is_delegated?: boolean;
      delegated_from_manager_name?: string | null;
    }
  | {
      doc_type: "OVERTIME_CLAIM";
      id: string;
      status: string;
      claim_no: string;
      employee_name: string;
      year: number;
      month: number;
      converted_hours: number;
      total_amount: number;
      my_title: string | null;
      submitted_at: string | null;
      current_step_actionable_by_me?: boolean;
      is_delegated?: boolean;
      delegated_from_manager_name?: string | null;
    }
  | {
      doc_type: "STANDBY_CLAIM";
      id: string;
      status: string;
      claim_no: string;
      employee_name: string;
      claim_month: string;
      calculated_amount: number;
      my_title: string | null;
      submitted_at: string | null;
      current_step_actionable_by_me?: boolean;
      is_delegated?: boolean;
      delegated_from_manager_name?: string | null;
    };

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthLabel(year: number, month: number) {
  return `${MONTH_NAMES[(month || 1) - 1] || ""} ${year || ""}`.trim();
}

type MyInboxAction = {
  id: string;
  action: string;
  doc_type: string;
  entity_id: string;
  current_status: string | null;
  requester_name: string | null;
  created_at: string;
};

// Previously always prefixed "M" (Lesotho Maloti) regardless of the item's
// actual currency, so every USD/EUR/etc. international advance or clearance
// showed the wrong symbol throughout the inbox and review modal - currency
// is now optional but should be passed everywhere it's available.
function fmt(n: any, currency?: string | null) {
  return formatMoney(n, currency);
}

function RadioIcon(props: { checked: boolean }) {
  return props.checked
    ? <CircleDot size={16} className="review-radio-icon review-radio-icon-checked" aria-hidden />
    : <Circle size={16} className="review-radio-icon" aria-hidden />;
}

// Label-over-value field row mirroring the grouped layout used on the
// generated Travel Advance PDF (renderFieldCell in genericPdfRenderer.ts),
// so the in-app review popup reads like a preview of that document.
function ReviewField(props: { icon: LucideIcon; label: string; value: React.ReactNode }) {
  const Icon = props.icon;
  return (
    <div className="review-field-item">
      <div className="review-field-icon"><Icon size={16} /></div>
      <div>
        <div className="review-field-label">{props.label}</div>
        <div className="review-field-value">{props.value}</div>
      </div>
    </div>
  );
}

function fmtFileSize(bytes: any) {
  const n = Number(bytes || 0);
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Formats a "user" (single object) or "user_multi" (array of assignee
// objects, each either a person or a whole team) field value for display —
// otherwise these render as a bare "[object Object]" via String(value).
function fmtAssigneeValue(value: any): string {
  const label = (a: any) => (a?.teamId ? `Section: ${a.teamName}` : a?.name || a?.email || "—");
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

// Travel line locations come in two formats depending on the travel type's
// location_mode: DISTRICT mode stores "Start → Destination" (e.g. local
// travel), COUNTRY_CITY mode (CMA/international) stores "Country / Province
// / City" or "Country / City" (province omitted outside South Africa) - the
// accommodation destination-extraction below previously only understood the
// "→" format, so CMA/international requests never got a destination to book
// against at all. Falls back to the whole trimmed string if neither
// separator is present.
function parseDestinationFromLocation(location: any): string {
  const trimmed = String(location || "").trim();
  if (!trimmed) return "";
  if (trimmed.includes("→")) return trimmed.split("→")[1]?.trim() || "";
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/").map((p) => p.trim()).filter(Boolean);
    return parts[parts.length - 1] || "";
  }
  return trimmed;
}

function lineAmount(line: any) {
  return Number(line.line_total || 0) || Number(line.meals || 0) || Number(line.lunch || 0) + Number(line.dinner || 0);
}

function lineMealCount(line: any) {
  const count = Number(line.meals_count);
  return Number.isFinite(count) && count > 0 ? count : "—";
}

function displayRoleLabel(value: string | null | undefined) {
  return value ? roleLabel(value) : "Unknown";
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
  if (status.includes("PAID") || status.includes("APPROVED") || status.includes("SETTLED") || status.includes("CLOSED") || status.includes("COMPLETED")) return "status-pill-success";
  if (status.includes("SUBMITTED") || status.includes("REVIEW") || status.includes("PENDING") || status.includes("OFFICER")) return "status-pill-warning";
  if (status.includes("DRAFT")) return "status-pill-neutral";
  return "status-pill-info";
}

function docTypeLabel(value: InboxItem["doc_type"] | string | null | undefined) {
  switch (value) {
    case "ADVANCE":          return "Advance";
    case "ACCOMMODATION":    return "Travel Accommodation";
    case "CLAIM":            return "Clearance";
    case "CUSTOM_REQUEST":   return "Change Request";
    case "OVERTIME_REQUEST": return "Overtime Request";
    case "OVERTIME_CLAIM":   return "Overtime Claim";
    case "STANDBY_CLAIM":    return "Standby Claim";
    default:                 return statusLabel(String(value || "Document"));
  }
}

const TERMINAL_STATUSES = new Set(["DRAFT", "SETTLED", "CLOSED", "PAID", "REJECTED", "CANCELLED"]);

// Trip-completion clearance outcome statuses (see claims.service.ts's
// computeFinancialOutcome) - the claim's own approval chain is already
// fully complete by the time a claim reaches any of these, so the
// "derive a Pending X label from current_step_position_name" branch in
// itemStatusLabel below must never apply to them (that branch is only
// valid while the chain is still actively being approved) - without this
// exclusion, a chain-participant's read-only tracking entry for an
// already-fully-approved claim read as "Pending Approval" again, even
// though every approver had already signed off and it was only waiting on
// Finance Treasury.
const CLEARANCE_OUTCOME_STATUSES = new Set([
  "REFUND_DUE", "PAYBACK_DUE", "PAYBACK_PROOF_SUBMITTED", "PAYBACK_PROOF_REJECTED", "FINANCE_TREASURY_REVIEW", "COMPLETED"
]);
const CLEARANCE_OUTCOME_LABELS: Record<string, string> = {
  COMPLETED: "Fully Cleared",
  FINANCE_TREASURY_REVIEW: "Approved — With Finance Treasury",
  REFUND_DUE: "Approved — Refund Due",
  PAYBACK_DUE: "Approved — Payback Required",
  PAYBACK_PROOF_SUBMITTED: "Payback Proof Under Review",
  PAYBACK_PROOF_REJECTED: "Payback Proof Rejected"
};

function docTypeIcon(value: InboxItem["doc_type"] | string | null | undefined) {
  switch (value) {
    case "ADVANCE":          return Plane;
    case "ACCOMMODATION":    return Briefcase;
    case "CLAIM":            return ShieldCheck;
    case "CUSTOM_REQUEST":   return ClipboardList;
    case "OVERTIME_REQUEST":
    case "OVERTIME_CLAIM":   return Clock3;
    case "STANDBY_CLAIM":    return CircleDot;
    default:                 return CreditCard;
  }
}

function docTypeTone(value: InboxItem["doc_type"] | string | null | undefined) {
  switch (value) {
    case "ADVANCE":          return "doc-tone-blue";
    case "ACCOMMODATION":    return "doc-tone-purple";
    case "CLAIM":            return "doc-tone-green";
    case "CUSTOM_REQUEST":   return "doc-tone-blue";
    case "OVERTIME_REQUEST":
    case "OVERTIME_CLAIM":
    case "STANDBY_CLAIM":    return "doc-tone-purple";
    default:                 return "doc-tone-blue";
  }
}

function itemStageProgress(item: InboxItem) {
  const status = String(item.status || "").toUpperCase();
  if (item.doc_type === "CUSTOM_REQUEST") return (item.current_step_position_name && displayOrgGroupName(item.current_step_position_name)) || statusLabel(status);
  if (item.doc_type === "OVERTIME_REQUEST" || item.doc_type === "OVERTIME_CLAIM" || item.doc_type === "STANDBY_CLAIM") return item.my_title || "Pending";
  // A claim/advance not yet at a terminal/outcome status is still
  // genuinely "Pending"/"In Progress" company-wide, but only from the
  // perspective of whoever's turn it actually is - showing that generic
  // word here regardless of current_step_actionable_by_me contradicted the
  // pill right next to it (itemStatusLabel already says "Approved" once
  // it's past this viewer's own step). Name who it's actually with instead,
  // the same way the CUSTOM_REQUEST branch above already does.
  if (
    (item.doc_type === "CLAIM" || item.doc_type === "ADVANCE") &&
    !item.current_step_actionable_by_me &&
    item.current_step_position_name &&
    !TERMINAL_STATUSES.has(status) &&
    !CLEARANCE_OUTCOME_STATUSES.has(status)
  ) {
    return displayOrgGroupName(item.current_step_position_name);
  }
  if (status === "SUBMITTED") return "Pending";
  if (CLEARANCE_OUTCOME_STATUSES.has(status)) return CLEARANCE_OUTCOME_LABELS[status] || statusLabel(status);
  if (TERMINAL_STATUSES.has(status)) return statusLabel(status);
  return "In Progress";
}

function itemStatusLabel(item: InboxItem) {
  const status = String(item.status || "").toUpperCase();
  if ((item.doc_type === "CLAIM" || item.doc_type === "ADVANCE") && CLEARANCE_OUTCOME_STATUSES.has(status)) {
    return CLEARANCE_OUTCOME_LABELS[status] || statusLabel(status);
  }
  if (
    (item.doc_type === "CLAIM" || item.doc_type === "ADVANCE") &&
    item.current_step_position_name &&
    !TERMINAL_STATUSES.has(status)
  ) {
    // The first ("Manager"/Supervisor) step in the chain is a countersign
    // step; every later step is a regular approval step. Either label was
    // previously shown regardless of whose turn it actually is - someone
    // who already countersigned/approved their own step saw the exact same
    // "Pending Countersign"/"Pending Approval" text as someone whose turn it
    // genuinely still is, with no way to tell "I'm done, it's moved on" from
    // "I still need to act" at a glance (current_step_actionable_by_me
    // already carries that distinction, it just wasn't being read here).
    if ((item as any).current_step_action_type === "COUNTER_SIGN" || item.current_step_position_name === "Manager") {
      return item.current_step_actionable_by_me ? "Pending Countersign" : "Approved";
    }
    // Once the chain has moved past actual approval-type steps and into
    // post-approval processing (Accommodation/Capture/Payment), it's already
    // approved - showing "Pending Approval" here is stale/wrong, it just
    // hasn't been captured, booked, or paid yet.
    if (isCaptureActionType((item as any).current_step_action_type) || (item as any).current_step_action_type === "DEPT_ACCOMODATION") {
      return "Approved";
    }
    if ((item as any).current_step_action_type === "MARK_PAID") return "Approved — Awaiting Payment";
    return item.current_step_actionable_by_me ? "Pending Approval" : "Approved";
  }
  if (item.doc_type === "CUSTOM_REQUEST" && item.status === "IN_PROGRESS") {
    if (item.current_step_actionable_by_me) return "Pending Approval";
    if (item.is_assignee_task) return "Awaiting Your Confirmation";
    return "In Progress";
  }
  if (item.doc_type === "OVERTIME_REQUEST" || item.doc_type === "OVERTIME_CLAIM" || item.doc_type === "STANDBY_CLAIM") return "Pending Approval";
  return statusLabel(item.status);
}

function itemOwner(item: InboxItem) {
  if (item.doc_type === "CLAIM") return item.claimant_name || "Unknown";
  if (item.doc_type === "CUSTOM_REQUEST") return item.requester_name || "Unknown";
  if (item.doc_type === "OVERTIME_REQUEST" || item.doc_type === "OVERTIME_CLAIM" || item.doc_type === "STANDBY_CLAIM") return item.employee_name || "Unknown";
  return item.requester_name || "Unknown";
}

function itemAmountValue(item: InboxItem) {
  if (item.doc_type === "ADVANCE") return Number(item.requested_total || 0);
  if (item.doc_type === "ACCOMMODATION") return Number(item.amount || 0);
  if (item.doc_type === "CUSTOM_REQUEST" || item.doc_type === "OVERTIME_REQUEST") return 0;
  if (item.doc_type === "OVERTIME_CLAIM") return Number(item.total_amount || 0);
  if (item.doc_type === "STANDBY_CLAIM") return Number(item.calculated_amount || 0);
  return Number(item.claim_total || 0);
}

function itemAmount(item: InboxItem) {
  if (item.doc_type === "CUSTOM_REQUEST" || item.doc_type === "OVERTIME_REQUEST") return "—";
  return fmt(itemAmountValue(item), (item as any).currency);
}

function itemContext(item: InboxItem) {
  if (item.doc_type === "ADVANCE") return item.purpose || "Advance request";
  if (item.doc_type === "ACCOMMODATION") return `${item.location || "Location pending"}${item.provider ? ` - ${item.provider}` : ""}`;
  if (item.doc_type === "CUSTOM_REQUEST") return item.request_type_name;
  if (item.doc_type === "OVERTIME_REQUEST") return `${item.request_no} — ${monthLabel(item.year, item.month)}`;
  if (item.doc_type === "OVERTIME_CLAIM") return `${item.claim_no} — ${monthLabel(item.year, item.month)} (${item.converted_hours}h)`;
  if (item.doc_type === "STANDBY_CLAIM") return `${item.claim_no} — ${new Date(item.claim_month).toLocaleDateString(undefined, { year: "numeric", month: "long" })}`;
  return `Advance ${fmt(item.advance_amount, item.currency)} / Balance ${fmt(item.balance_amount, item.currency)}`;
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

// "CAPTURE" was this system's original built-in capture action code;
// "DEPT_CAPTURE" is the custom one actually registered and used by every
// real workflow's Treasury/Finance capture step today (added later via the
// Action Types panel - see workflow_action_types). Recognize both so a step
// using either one still counts as a capture step everywhere below.
function isCaptureActionType(code: string | null | undefined) {
  return code === "CAPTURE" || code === "DEPT_CAPTURE";
}

// Button label for the current workflow step's action, derived from its
// Action Label (action_type code) so a "Capture" step reads "Capture", etc.
// Clearance settlements aren't a Finance choice: an employee refunding the
// company can only hand over cash, and a reimbursement to the employee goes
// out the same way their original advance was paid.
function paymentMethodLabel(code: string | null | undefined) {
  switch (code) {
    case "ECOCASH": return "ECOCASH";
    case "BANK": return "Bank Transfer";
    case "CASH": return "Cash";
    case "OTHER": return "Other";
    default: return "Cash";
  }
}
function deriveSettleMethod(decision: string | null | undefined, advancePaymentMethod: string | null | undefined): "PAYROLL" | "ECOCASH" | "BANK" | "CASH" | "OTHER" {
  if (decision === "REFUND_FROM_EMPLOYEE") return "CASH";
  if (decision === "REIMBURSE_EMPLOYEE") return (advancePaymentMethod as any) || "CASH";
  return "CASH";
}

function actionTypeButtonLabel(code: string | null | undefined) {
  if (isCaptureActionType(code)) return "Capture";
  switch (code) {
    case "COUNTER_SIGN": return "Counter Sign";
    case "BOOK_ACC": return "Book Accommodation";
    case "APPROVE": return "Approve Advance";
    default: return code ? statusLabel(code) : "Approve Advance";
  }
}

// Items at a "Capture" workflow step, or already captured by the current
// user (capture_done) — pulled out into their own dedicated Capture Inbox
// page instead of showing in the general Approval Inbox. Already-captured
// items stay visible (rather than disappearing once the workflow moves on)
// so the capturer can still find and download the form afterwards.
// Accommodation bookings follow the same capture-then-paid flow, so they
// belong in the same Capture Inbox rather than the general Approval Inbox.
export function isCaptureItem(item: any) {
  if (item.doc_type === "ACCOMMODATION") return true;
  return item.doc_type === "ADVANCE" && (isCaptureActionType(item.current_step_action_type) || item.capture_done === true);
}

// Same set as isCaptureItem, but narrowed to items still actually awaiting
// this user's capture action - for the sidebar badge count, which should
// only ever reflect outstanding work, not the whole list (isCaptureItem
// deliberately keeps already-captured items visible in the Capture Inbox
// itself so they can still be found/downloaded, but that would otherwise
// leave the badge stuck showing them as pending forever).
export function isCapturePendingItem(item: any) {
  return isCaptureItem(item) && item.current_step_actionable_by_me === true;
}

// Accommodation-related items Admin needs to see in the general Approval
// Inbox as well as Capture, not exclusively routed to Capture:
//  - An advance still needing an accommodation booking (it usually carries a
//    parallel Capture step too, which is what makes isCaptureItem claim it) -
//    easy to miss sitting only in Capture once payment has already gone out,
//    since accommodation runs parallel to Treasury capture and can still be
//    outstanding long after the advance is PAID.
//  - An accommodation booking HR has already created and sent to finance
//    (SUBMITTED) but not yet paid - previously only ever visible in Capture
//    (isCaptureItem always claims doc_type ACCOMMODATION), so Admin had no
//    way to see requested accommodation from the general inbox at all. Once
//    PAID it's done, so it drops back to Capture-only (nothing left to act
//    on from the Approval Inbox).
export function needsAccommodationBooking(item: any) {
  if (item.doc_type === "ADVANCE") return item.current_step_requires_accommodation === true;
  if (item.doc_type === "ACCOMMODATION") return item.status === "SUBMITTED" && !!item.current_step_actionable_by_me;
  return false;
}

// Items awaiting or already through payment — surfaced in the dedicated
// Payments page instead of the general Approval Inbox. Checked three ways
// because advances reach this state via three different inbox code paths
// (workflow-driven MARK_PAID step, legacy final-step approver, and admin's
// by-status listing), only one of which sets current_step_action_type.
export function isPaymentItem(item: any) {
  return item.doc_type === "ADVANCE" &&
    (item.current_step_action_type === "MARK_PAID" || item.is_final_step_approver === true ||
     ["HR_OFFICER", "APPROVED"].includes(item.status));
}

export default function Inbox(props: {
  onBack?: () => void;
  mode?: "all" | "capture";
  // Overtime and Standby have their own dedicated Approvals/detail screens
  // (with the full line-item view and the Approve/Reject/Send Back "Your
  // Decision" panel) — rather than re-implement that UI a second time inside
  // this generic inbox, these items hand off to that module's own page.
  onNavigateToModule?: (target: "OVERTIME" | "STANDBY", deepLink: { kind: "REQUEST" | "CLAIM"; id: string }) => void;
}) {
  const me = getUserFromToken();
  const role = me?.role || "UNKNOWN";
  const mode = props.mode ?? "all";

  const [items, setItems] = useState<InboxItem[]>([]);
  const [myActions, setMyActions] = useState<MyInboxAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InboxItem | null>(null);

  function openItem(it: InboxItem) {
    if (it.doc_type === "OVERTIME_REQUEST") return props.onNavigateToModule?.("OVERTIME", { kind: "REQUEST", id: it.id });
    if (it.doc_type === "OVERTIME_CLAIM") return props.onNavigateToModule?.("OVERTIME", { kind: "CLAIM", id: it.id });
    if (it.doc_type === "STANDBY_CLAIM") return props.onNavigateToModule?.("STANDBY", { kind: "CLAIM", id: it.id });
    setSelected(it);
  }

  async function refresh() {
    setError(null);
    const [inboxResp, myActionsResp] = await Promise.all([api.inbox(), api.myInboxActions(30)]);
    const all: InboxItem[] = inboxResp.items || [];
    setItems(
      mode === "capture"
        ? all.filter(isCaptureItem)
        : all.filter((it) => (!isCaptureItem(it) || needsAccommodationBooking(it)) && !isPaymentItem(it))
    );
    setMyActions(myActionsResp.items || []);
  }

  useEffect(() => {
    // App.tsx renders <Inbox> for both "all" and "capture" modes at the same
    // JSX position (INBOX vs CAPTURE page branches), so React reuses the same
    // component instance across a mode switch rather than remounting it —
    // re-run the fetch/filter whenever `mode` changes, not just once at mount.
    setItems([]);
    setSelected(null);
    refresh().catch((e) => setError(String(e.message)));
  }, [mode]);

  // Split "my own approval authority" from "acting on behalf of a manager who
  // delegated to me" - the two must never silently merge into one list, per
  // the same principle the audit trail already applies (approvals always
  // record who acted vs. whose authority it was). Only shown once there's
  // actually at least one delegated item, so non-delegates see no change.
  const [delegationScope, setDelegationScope] = useState<"ALL" | "MINE" | "DELEGATED">("ALL");
  const hasAnyDelegatedItems = useMemo(() => items.some((it: any) => it.is_delegated), [items]);
  const delegatingManagers = useMemo(
    () => Array.from(new Set(items.filter((it: any) => it.is_delegated && it.delegated_from_manager_name).map((it: any) => it.delegated_from_manager_name as string))),
    [items]
  );
  useEffect(() => { if (!hasAnyDelegatedItems) setDelegationScope("ALL"); }, [hasAnyDelegatedItems]);

  // Company/division filter (MNO / SEFS / HigherLife) - only meaningful in
  // the Capture Inbox, where Treasury/Finance need to work one company's
  // queue at a time rather than a single list mixing all three.
  const [divisionFilter, setDivisionFilter] = useState<BusinessUnit>("ALL");
  const divisionCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: items.length, MNO: 0, SEFS: 0, HigherLife: 0 };
    for (const it of items) {
      const d = (it as any).division;
      if (d && d in counts) counts[d]++;
    }
    return counts;
  }, [items]);

  // Pending/Captured split, same pattern as Payments' Pending/Paid tabs -
  // capture mode's item list keeps captured items visible (see comment below
  // on pendingItems), so without this split the queue mixes done and not-done
  // work together with no way to separate them.
  const [captureStatusFilter, setCaptureStatusFilter] = useState<"PENDING" | "CAPTURED">("PENDING");
  const captureStatusCounts = useMemo(() => {
    if (mode !== "capture") return { pending: 0, captured: 0 };
    const base = divisionFilter === "ALL" ? items : items.filter((it: any) => it.division === divisionFilter);
    return {
      pending: base.filter((it: any) => it.capture_done !== true).length,
      captured: base.filter((it: any) => it.capture_done === true).length
    };
  }, [items, mode, divisionFilter]);

  // Same Pending/Captured-style split as capture mode's tabs above, but for
  // the regular Approval Inbox: `items` here deliberately keeps every
  // request this user is relevant to, including ones long past their own
  // step (e.g. a manager's chain-wide view after their HOD step was approved
  // weeks ago - see loadViewOnlyCompletedItemsForUser's comment in
  // inbox.routes.ts) - that's correct for "can I still find/track this," but
  // mixed into one list it meant nothing actually still awaiting this user's
  // action was easy to pick out of everything they've ever touched. A true
  // partition (not an "All" tab that still mixes both in) - every item is in
  // exactly one of these two tabs, never both, so Pending only ever holds
  // what genuinely still needs this user's action.
  const [approvalStatusFilter, setApprovalStatusFilter] = useState<"PENDING" | "APPROVED">("PENDING");
  const approvalStatusCounts = useMemo(() => {
    if (mode === "capture") return { pending: 0, approved: 0 };
    const pending = items.filter((it: any) => it.current_step_actionable_by_me === true).length;
    return { pending, approved: items.length - pending };
  }, [items, mode]);

  const scopedItems = useMemo(() => {
    let result = items;
    if (delegationScope === "MINE") result = result.filter((it: any) => !it.is_delegated);
    else if (delegationScope === "DELEGATED") result = result.filter((it: any) => it.is_delegated);
    if (mode === "capture" && divisionFilter !== "ALL") result = result.filter((it: any) => it.division === divisionFilter);
    if (mode === "capture") result = result.filter((it: any) => (captureStatusFilter === "CAPTURED") === (it.capture_done === true));
    // Advances only ever land in `items` here once they've reached their own
    // DEPT_CAPTURE step (loadCaptureHistoryItems gates on that server-side),
    // but claims have no such dedicated capture-stage loader - the ADMIN
    // backstop surfaces every claim with ANY pending step, so a claim still
    // waiting on Manager/EXCO/Countersign approval was showing up in the
    // Capture Inbox right alongside ones genuinely ready to close. A claim
    // only belongs here once it's reached its own passthrough closing step
    // (DEPT_CLOSE, or a workflow whose final step is tagged COUNTER_SIGN -
    // see isDeptCloseStep's own comment further down this file).
    if (mode === "capture") result = result.filter((it: any) => it.doc_type !== "CLAIM" || ["DEPT_CLOSE", "COUNTER_SIGN"].includes(it.current_step_action_type));
    if (mode !== "capture") result = result.filter((it: any) => (approvalStatusFilter === "PENDING") === (it.current_step_actionable_by_me === true));
    return result;
  }, [items, delegationScope, mode, divisionFilter, captureStatusFilter, approvalStatusFilter]);

  const grouped = useMemo(() => {
    const g: Record<string, InboxItem[]> = {};
    for (const it of scopedItems) {
      g[it.doc_type] = g[it.doc_type] || [];
      g[it.doc_type].push(it);
    }
    return g;
  }, [scopedItems]);

  const [activeGroupTab, setActiveGroupTab] = useState<string | null>(null);
  const groupKeys = useMemo(() => Object.keys(grouped), [grouped]);
  // Keep the active tab valid as data loads/changes — default to the first
  // group, and fall back if the previously-active group empties out.
  useEffect(() => {
    if (activeGroupTab && groupKeys.includes(activeGroupTab)) return;
    setActiveGroupTab(groupKeys[0] ?? null);
  }, [groupKeys, activeGroupTab]);

  const [queueSearch, setQueueSearch] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [queuePageSize, setQueuePageSize] = useState(10);
  useEffect(() => { setQueuePage(1); }, [activeGroupTab, queueSearch, delegationScope, divisionFilter, captureStatusFilter, approvalStatusFilter]);

  // Both modes' item lists deliberately keep already-done items visible (so
  // they can still be found/tracked - see approvalStatusCounts above for the
  // regular Approval Inbox's version of this), so "awaiting" counts need to
  // exclude those explicitly rather than just using items.length, in either
  // mode - otherwise already-resolved items keep inflating every count on
  // this page even after they're done.
  const pendingItems = useMemo(
    () => items.filter((it) => it.current_step_actionable_by_me === true),
    [items]
  );

  const metrics = useMemo(
    () => ({
      awaiting: pendingItems.length,
      advances: items.filter((item) => item.doc_type === "ADVANCE").length,
      clearances: items.filter((item) => item.doc_type === "CLAIM").length,
      advanceValue: items
        .filter((item) => item.doc_type === "ADVANCE")
        .reduce((sum, item) => sum + itemAmountValue(item), 0),
      recentActions: myActions.length
    }),
    [items, pendingItems, myActions]
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
          <div className="inbox-eyebrow">{mode === "capture" ? "Capture Workflow" : "Approval Workflow"}</div>
          <h2>{mode === "capture" ? "Capture Inbox" : "Approval Inbox"}</h2>
          <p>
            {mode === "capture"
              ? "Requests waiting for you to capture details before they continue through the workflow."
              : `Review finance requests waiting for ${displayRoleLabel(role)} and keep a clear record of your recent decisions.`}
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
              <h3>{mode === "capture" ? "Capture Queue" : "Approval Queue"}</h3>
              <p>{items.length === 0 ? "No work is waiting right now." : "Grouped by document type and current stage."}</p>
            </div>
            <span className="inbox-count-chip">{pendingItems.length} total</span>
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
            <>
              {mode === "capture" && (
                <BusinessUnitTabs value={divisionFilter} onChange={setDivisionFilter} counts={divisionCounts} icon={Building2} allIcon={Users} />
              )}
              {mode === "capture" && (
                <IconTabRow
                  value={captureStatusFilter}
                  onChange={setCaptureStatusFilter}
                  tabs={[
                    { key: "PENDING", label: "Pending", count: captureStatusCounts.pending, icon: Hourglass },
                    { key: "CAPTURED", label: "Captured", count: captureStatusCounts.captured, icon: CheckCircle2 }
                  ]}
                />
              )}
              {mode !== "capture" && (
                <IconTabRow
                  value={approvalStatusFilter}
                  onChange={setApprovalStatusFilter}
                  tabs={[
                    { key: "PENDING", label: "Pending", count: approvalStatusCounts.pending, icon: Hourglass },
                    { key: "APPROVED", label: "Approved", count: approvalStatusCounts.approved, icon: CheckCircle2 }
                  ]}
                />
              )}
              {hasAnyDelegatedItems && (
                <>
                  <div className="inbox-delegate-banner">
                    You are acting as a delegate for {delegatingManagers.join(", ") || "another manager"}. Delegated items are kept separate from your own approvals below.
                  </div>
                  <div className="ep-tabs" style={{ marginBottom: 8 }}>
                    {([
                      { key: "ALL", label: "All" },
                      { key: "MINE", label: "My Approvals" },
                      { key: "DELEGATED", label: "Delegated To Me" }
                    ] as const).map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        className={`ep-tab ${delegationScope === tab.key ? "active" : ""}`}
                        onClick={() => setDelegationScope(tab.key)}
                      >
                        {tab.label}
                        <span className="inbox-count-chip">
                          {tab.key === "ALL" ? items.length : items.filter((it: any) => (tab.key === "DELEGATED") === !!it.is_delegated).length}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {scopedItems.length === 0 ? (
                <FinanceEmptyState icon={FileText} title="Nothing in this view." hint="Try a different company or status tab above." />
              ) : (
              <div className="ep-tabs">
                {groupKeys.map((docType) => {
                  const Icon = docTypeIcon(docType);
                  return (
                    <button
                      key={docType}
                      type="button"
                      className={`ep-tab ${activeGroupTab === docType ? "active" : ""}`}
                      onClick={() => setActiveGroupTab(docType)}
                    >
                      <Icon size={15} aria-hidden />
                      {docTypeLabel(docType)}
                      <span className="inbox-count-chip">{grouped[docType].length}</span>
                    </button>
                  );
                })}
              </div>
              )}

              {activeGroupTab && grouped[activeGroupTab] && (() => {
                const groupItems = grouped[activeGroupTab];
                const totalAmount = groupItems.reduce((sum, it) => sum + itemAmountValue(it), 0);
                const q = queueSearch.trim().toLowerCase();
                const searched = q
                  ? groupItems.filter((it) =>
                      itemOwner(it).toLowerCase().includes(q) ||
                      itemContext(it).toLowerCase().includes(q) ||
                      itemStatusLabel(it).toLowerCase().includes(q)
                    )
                  : groupItems;
                const totalPages = Math.max(1, Math.ceil(searched.length / queuePageSize));
                const currentPage = Math.min(queuePage, totalPages);
                const pagedItems = searched.slice((currentPage - 1) * queuePageSize, currentPage * queuePageSize);
                return (
                  <article className={`inbox-group-card ${docTypeTone(activeGroupTab)}`}>
                    <div className="inbox-group-header">
                      <div className="inbox-group-title">
                        <h4>{docTypeLabel(activeGroupTab)}</h4>
                      </div>
                      <div className="inbox-group-badges">
                        <span className="inbox-badge inbox-badge-info">Awaiting: {groupItems.length}</span>
                        <span className="inbox-badge inbox-badge-total">Total Amount: {fmt(totalAmount)}</span>
                      </div>
                    </div>

                    <div style={{ padding: "0 20px 14px" }}>
                      <div className="ep-search" style={{ maxWidth: 320 }}>
                        <Search size={14} />
                        <input placeholder="Search by owner, context, status…" value={queueSearch} onChange={(e) => setQueueSearch(e.target.value)} />
                      </div>
                    </div>

                    <div className="inbox-table-wrap">
                      {searched.length === 0 ? (
                        <div className="ep-empty"><p>No items match your search.</p></div>
                      ) : (
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
                          {pagedItems.map((it) => (
                            <tr key={it.id}>
                              <td>
                                <div className="inbox-person-cell">
                                  <span className="inbox-avatar-mini">{initials(itemOwner(it))}</span>
                                  <span>
                                    <strong>{itemOwner(it)}</strong>
                                    <small>{docTypeLabel(it.doc_type)}</small>
                                    {(it as any).is_delegated && (
                                      <small className="inbox-delegated-tag">On behalf of {(it as any).delegated_from_manager_name || "your manager"}</small>
                                    )}
                                  </span>
                                </div>
                              </td>
                              <td>
                                <div className="inbox-stage-cell">
                                  <span className={`status-pill ${statusTone(it.status)}`}>{itemStatusLabel(it)}</span>
                                  {(() => {
                                    const label = itemStatusLabel(it);
                                    const stage = itemStageProgress(it);
                                    // Skip the caption when it's just a shorter echo of the pill
                                    // above it ("Paid" / "Paid", "Pending Approval" / "Pending") -
                                    // it adds no information and reads as an unfinished duplicate.
                                    const redundant = !stage || label.toLowerCase().startsWith(stage.toLowerCase());
                                    return redundant ? null : <small>{stage}</small>;
                                  })()}
                                </div>
                              </td>
                              <td className="inbox-money">{itemAmount(it)}</td>
                              <td className="inbox-context">{itemContext(it)}</td>
                              <td className="inbox-actions-cell">
                                <button
                                  type="button"
                                  className="inbox-review-button"
                                  onClick={() => openItem(it)}
                                  aria-label={`Review ${docTypeLabel(it.doc_type)} for ${itemOwner(it)}`}
                                  title="Review"
                                >
                                  <Eye size={15} aria-hidden="true" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      )}
                    </div>

                    {searched.length > 0 && (
                      <div className="ep-filter-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--border)", flexWrap: "wrap", gap: 10 }}>
                        <span style={{ fontSize: 13, color: "var(--muted)" }}>
                          Showing {(currentPage - 1) * queuePageSize + 1} to {Math.min(currentPage * queuePageSize, searched.length)} of {searched.length} entries
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <select className="ep-form-select" value={queuePageSize} onChange={(e) => { setQueuePageSize(Number(e.target.value)); setQueuePage(1); }}>
                            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
                          </select>
                          <button className="ep-btn-outline" onClick={() => setQueuePage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}><ChevronLeft size={14} /></button>
                          {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 7).map((n) => (
                            <button key={n} className={`button small-button ${currentPage === n ? "button-primary" : "button-subtle"}`} onClick={() => setQueuePage(n)}>{n}</button>
                          ))}
                          <button className="ep-btn-outline" onClick={() => setQueuePage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}><ChevronRight size={14} /></button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })()}
            </>
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

function ReceiptRow(props: { claimId: string; receipt: any }) {
  const { claimId, receipt } = props;
  const [busy, setBusy] = useState(false);

  async function handleView() {
    try {
      await openBlobInNewTab(() => api.claimReceiptFileBlob(claimId, receipt.id));
    } catch (e: any) {
      void showNotice(e?.message || "Failed to open receipt.");
    }
  }

  async function handleDownload() {
    setBusy(true);
    try {
      const blob = await api.claimReceiptFileBlob(claimId, receipt.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = receipt.file_name || "receipt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      void showNotice(e?.message || "Failed to download receipt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-receipt-row">
      <span className="review-info-icon"><FileText size={16} aria-hidden /></span>
      <div className="review-receipt-info">
        <strong>{receipt.file_name || "Receipt"}</strong>
        <small>{fmtFileSize(receipt.size_bytes)}</small>
      </div>
      <div className="review-receipt-actions">
        <button type="button" className="button small-button button-subtle" onClick={handleView} title="View">
          <Eye size={14} aria-hidden />
        </button>
        <button type="button" className="button small-button button-subtle" onClick={handleDownload} disabled={busy} title="Download">
          <Download size={14} aria-hidden />
        </button>
      </div>
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
  const [settleRef, setSettleRef] = useState("");
  const [financeDecision, setFinanceDecision] = useState<"ACCEPTED" | "REFUND_FROM_EMPLOYEE" | "REIMBURSE_EMPLOYEE" | "">("");
  const [settlementAmount, setSettlementAmount] = useState("");
  const [assigneeType, setAssigneeType] = useState<"INDIVIDUAL" | "TEAM">("TEAM");
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
  const travelDayCount = (detail?.lines ?? []).length;

  // Extract destination districts (exclude last return-home leg)
  const destinationDistricts = useMemo(() => {
    if (!isTravelAdvance || !detail?.lines) return [];
    const lines: any[] = detail.lines || [];
    // Use all lines except the last (which is typically the return trip home)
    const outboundLines = lines.length > 1 ? lines.slice(0, -1) : lines;
    const districts = new Set<string>();
    outboundLines.forEach((line: any) => {
      const destination = parseDestinationFromLocation(line.location);
      if (destination) districts.add(destination);
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
      const destination = parseDestinationFromLocation(line.location);
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

  // Requester's preferred hotel per destination district, captured on the
  // request form (travel_meta.hotel) — used to pre-fill HR's provider field,
  // which HR can still change; HR owns amount/dates/notes regardless.
  const destinationHotelChoices = useMemo(() => {
    const choices = new Map<string, string>();
    if (!isTravelAdvance || !detail?.lines) return choices;
    const lines: any[] = detail.lines || [];
    lines.forEach((line: any) => {
      const destination = parseDestinationFromLocation(line.location);
      if (!destination) return;
      let meta = line.travel_meta;
      if (typeof meta === "string") {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      const hotel = meta?.hotel;
      if (destination && hotel) choices.set(destination, hotel);
    });
    return choices;
  }, [isTravelAdvance, detail?.lines]);

  // Mirrors resolveAdvancePdfData's field derivation (backend-v2/src/lib/pdf/pdfFieldCatalog.ts)
  // so the on-screen summary shows the same fields the generated PDF does.
  const pdfFormSummary = useMemo(() => {
    if (item.doc_type !== "ADVANCE" || !detail) return null;
    const lines: any[] = detail.lines || [];
    const dates = lines.map((l) => l.line_date).filter(Boolean).sort();
    // "Apply for Other" never has lines at all (just the overall period the
    // engagement/trip covers, on the request itself) - and the international
    // "Plan Your Trip" flow's one synthesized line only carries the departure
    // date, with the return date on travel_return_date instead. Either way,
    // deriving dateTo purely from lines silently showed "—" (Apply for Other)
    // or the departure date twice (international) instead of the real return
    // date.
    const dateFrom = detail.external_beneficiary_id ? detail.external_start_date : dates[0];
    const dateTo = detail.external_beneficiary_id
      ? detail.external_end_date
      : detail.travel_return_date || dates[dates.length - 1];
    const durationDays = dateFrom && dateTo
      ? Math.max(1, Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86400000) + 1)
      : null;
    const locations = Array.from(new Set(lines.map((l) => l.location).filter(Boolean))) as string[];
    const onBehalfOf = detail.created_by_id && detail.requester_id && detail.created_by_id !== detail.requester_id
      ? detail.created_by_name || ""
      : "";
    // "Apply for Other" - the requester still receives and is accountable
    // for the money, but the trip/expense is actually for this person, not
    // them. Every approver in the chain needs this in front of them, same
    // as an internal on-behalf-of request.
    const applyingFor = detail.external_beneficiary_id
      ? [detail.external_beneficiary_name, detail.external_beneficiary_organisation].filter(Boolean).join(" — ")
      : "";
    return {
      travellerName: detail.requester_name || "—",
      employeeNo: detail.requester_employee_no || "—",
      travellerType: detail.traveller_type || "—",
      division: detail.department || "—",
      onBehalfOf,
      applyingFor,
      typeOfTravel: travelTypeLabel(detail.type, travelTypes),
      destination: locations.join(", ") || "—",
      departureDate: dateFrom ? fmtDate(dateFrom) : "—",
      returnDate: dateTo ? fmtDate(dateTo) : "—",
      travelDuration: durationDays ? `${durationDays} day${durationDays === 1 ? "" : "s"}` : "—",
      purpose: detail.purpose || "—",
      projectNumber: detail.project_number || "—",
      requestedTotal: formatMoney(detail.requested_total, detail.travel_currency),
      approvedTotal: formatMoney(detail.approved_total, detail.travel_currency),
      paymentMethod: detail.payment_method || "—",
      paymentAccount: detail.payment_account || "",
      extraCost: Number(detail.extra_cost_amount || 0) > 0 ? formatMoney(detail.extra_cost_amount, detail.travel_currency) : null,
      extraCostDescription: detail.extra_cost_description || null
    };
  }, [item.doc_type, detail, travelTypes]);

  // Builds the approval-chain progress strip: which stages are done, the
  // currently-pending stage (a "stage" = the current step plus any later
  // steps flagged parallel_with_previous, which become pending together),
  // and everything still waiting.
  const approvalProgressStages = useMemo(() => {
    const fullChain: any[] = Array.isArray(detail?.approval_chain) ? detail.approval_chain : [];
    if (!fullChain.length) return [];
    // "Approval Progress" tracks approval, not post-approval processing —
    // stop the strip after the last actual APPROVE step (a COUNTER_SIGN
    // step doesn't count as the approval itself, only the step that follows
    // it does). Steps like BOOK_ACC/CAPTURE/MARK_PAID happen after approval
    // is already complete, so they're left out of this tracker.
    const lastApproveIdx = fullChain.reduce((last, step, idx) => (step.action_type === "APPROVE" ? idx : last), -1);
    const chain = lastApproveIdx === -1 ? fullChain : fullChain.slice(0, lastApproveIdx + 1);
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
      // Show the assigned approver's real job title instead of the generic
      // workflow step name - a senior title being labeled down to "Manager"/
      // "Head of Department" misrepresents who actually holds approval
      // authority here. Group/team steps and steps with no approver on
      // record still fall back to the workflow label.
      const label = !isTeamGroup && step.approver_title
        ? step.approver_title
        : step.position_name ? displayOrgGroupName(step.position_name) : step.approver_title;
      // A requires_accommodation step is parallel/non-blocking - the
      // workflow's step-order pointer can move past it once Capture/payment
      // complete while it's still genuinely unbooked (see workflowEngine.ts's
      // findPendingAccommodationStep), so "pointer index passed this step"
      // alone isn't a reliable done-signal for it the way it is for every
      // other step - without this guard it showed as done/"Booked" once
      // payment went through even with no accommodation ever created.
      const isDone = Boolean(step.approved) || (stepOrder > idx && !step.requires_accommodation);
      const isActive = !isDone && pendingStage.has(idx);
      return {
        key: `step-${idx}`,
        label,
        state: isDone ? "done" : isActive ? "active" : "waiting",
        status: isDone ? stepDoneStatusLabel(step.action_type) : isActive ? "In Progress" : "Waiting",
        actor: isTeamGroup ? "" : (step.approver_name || "")
      };
    });

    // The configured workflow chain is the entire approval process — once it
    // finishes, the claim goes straight to a terminal state (no forced
    // Finance/Payment stages tacked on; a workflow that actually needs a
    // Finance step includes one as a regular chain step instead).
    if (item.doc_type === "CLAIM") {
      const claimStatus = String(detail?.status || "").toUpperCase();
      // A trip-completion outcome claim (see claims.service.ts's
      // computeFinancialOutcome) has already finished its own approval
      // chain by the time it reaches any of these statuses - the final
      // stage must reflect that (in progress with HR/Treasury, not a plain
      // "Waiting" that reads as nothing having happened yet) rather than
      // falling back to the pre-outcome SETTLED/CLOSED-only terminal check.
      const outcomeInProgress = ["REFUND_DUE", "PAYBACK_DUE", "PAYBACK_PROOF_SUBMITTED", "PAYBACK_PROOF_REJECTED", "FINANCE_TREASURY_REVIEW"].includes(claimStatus);
      const terminalDone = claimStatus === "SETTLED" || claimStatus === "CLOSED" || claimStatus === "COMPLETED";
      const finalLabel = claimStatus === "SETTLED" ? "Settled" : claimStatus === "COMPLETED" ? "Completed" : outcomeInProgress ? "Finance Treasury" : "Closed";
      return [
        initiatorStage,
        ...chainStages,
        {
          key: "step-closed",
          label: finalLabel,
          state: terminalDone ? "done" : outcomeInProgress ? "active" : "waiting",
          status: terminalDone ? "Completed" : outcomeInProgress ? (CLEARANCE_OUTCOME_LABELS[claimStatus] || "In Progress") : "Waiting",
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
  // requires_accommodation means "this request still needs accommodation
  // booked" - it can be true on a Capture (or any other) item that merely
  // co-occurs with a still-open accommodation need (see
  // loadCaptureHistoryItems in inbox.routes.ts, which deliberately keeps
  // this flag set on the Capture item itself so the signal survives once
  // the chain's pending group has moved past the accommodation step). It
  // does NOT mean the current step IS the accommodation step.
  const isAccommodationStep = isWorkflowDriven && Boolean((item as any).current_step_requires_accommodation);
  // The current step is actually the accommodation step itself (e.g. HR
  // preparing accommodation before forwarding to Finance) — at THIS step
  // the assignee attaches the accommodation booking instead of
  // approving/rejecting/capturing. Using the broader isAccommodationStep
  // flag here instead used to suppress the real Capture/Approve button on
  // a Capture item that merely still needed accommodation booked alongside
  // it - a real incident: Capture staff had no way to act on an advance at
  // all once it also needed accommodation.
  const isAccommodationOnlyStep = isWorkflowDriven && (item as any).current_step_action_type === "DEPT_ACCOMODATION";
  const inProgressStatuses = ["SUBMITTED", "COUNTERSIGNED", "HR_OFFICER"];
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
  // The current step's action type / label (drives the action button text and
  // the post-action travel-form generation on "Capture" steps).
  const currentStepActionType: string | null = isWorkflowDriven ? ((item as any).current_step_action_type ?? null) : null;
  const isCaptureStep = isCaptureActionType(currentStepActionType);
  // Custom (non-standard) action types show their own Action Label on the
  // button; standard APPROVE keeps the existing role-aware labels below.
  const customActionLabel = currentStepActionType && !["APPROVE", "COUNTER_SIGN", "MARK_PAID"].includes(currentStepActionType)
    ? actionTypeButtonLabel(currentStepActionType)
    : null;

  const canRollbackAdvance =
    item.doc_type === "ADVANCE" &&
    ((isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationOnlyStep && (item as any).current_step_can_rollback !== false
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_OFFICER") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED"))) ||
      // Finance/Treasury or ADMIN can send a paid-in-error advance all the
      // way back to draft from Capture/Payments too, not just pre-payment -
      // see advances.routes.ts's /:id/rollback post-completion bypass.
      ((role === "ADMIN" || isFinanceDept) && item.status === "PAID"));
  // Cancel voids the advance outright (a terminal marker, not a "start
  // over") - available from Capture/Payments even once PAID, when a
  // correction that still preserves the record (rather than resubmitting)
  // is what's needed.
  const canCancelAdvance =
    item.doc_type === "ADVANCE" &&
    (role === "ADMIN" || isFinanceDept) &&
    !["CANCELLED", "REJECTED", "DRAFT"].includes(item.status);
  const canRejectAdvance =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationOnlyStep && (item as any).current_step_can_reject !== false
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_OFFICER") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED") ||
          (isFinanceDept && ["HR_OFFICER", "APPROVED"].includes(item.status)) ||
          (role === "ADMIN" && inProgressStatuses.includes(item.status))));
  const canApproveAdvance =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && !isAccommodationOnlyStep && !isMarkPaidStep
      : ((role === "MANAGER" && item.status === "SUBMITTED") ||
          (role === "MANAGER" && item.status === "HR_OFFICER") ||
          (role === "HOD" && item.status === "COUNTERSIGNED") ||
          (role === "EXCO" && item.status === "COUNTERSIGNED")));
  // A correction to an already-captured advance shouldn't force it all the
  // way back through Manager/HOD/EXCO/CEO approval again (what Roll Back to
  // Draft would do) - undo-capture only reopens the capture step itself.
  // Once paid, real money has moved, so it's no longer offered here.
  const canUndoCapture = item.doc_type === "ADVANCE" && Boolean((item as any).capture_done) && item.status !== "PAID";
  const canMarkPaid =
    item.doc_type === "ADVANCE" &&
    (isWorkflowDriven
      ? isMyWorkflowStep && isMarkPaidStep
      : ((isFinanceDept || role === "ADMIN" || Boolean((item as any).is_final_step_approver)) &&
          ["HR_OFFICER", "APPROVED"].includes(item.status)));
  const canCreateAccommodation =
    item.doc_type === "ADVANCE" &&
    isTravelAdvance &&
    // Requires isAccommodationOnlyStep (the current step IS DEPT_ACCOMODATION
    // for this viewer), not just isAccommodationStep (the request merely
    // still needs accommodation booked by someone) - a Capture-only viewer
    // (e.g. Treasury) is never personally eligible for the accommodation
    // step itself, even on an item that also carries
    // current_step_requires_accommodation=true for signal/tracking
    // purposes. Without this, Capture staff saw "Book Accommodation" on
    // every request still awaiting HR Ops, a job that isn't theirs.
    (isWorkflowDriven
      ? isMyWorkflowStep && isAccommodationOnlyStep
      : (role === "MANAGER" && ["HR_OFFICER", "APPROVED"].includes(item.status)));
  const canMarkAccommodationPaid = item.doc_type === "ACCOMMODATION" && (role === "ADMIN" || isFinanceDept) && item.status === "SUBMITTED";
  const canRejectAccommodation = item.doc_type === "ACCOMMODATION" && (role === "ADMIN" || isFinanceDept) && item.status === "SUBMITTED";
  const canConfirmNotCleared =
    item.doc_type === "ADVANCE" &&
    (role === "ADMIN" || isFinanceDept) &&
    Boolean((item as any).is_overdue) &&
    !(item as any).not_cleared_confirmed_at;

  // Workflow-driven clearance claims (e.g. "Travel Clearance DT") expose the
  // current step's approver via current_step_approver_id, mirroring advances.
  const isWorkflowDrivenClaim = item.doc_type === "CLAIM" && item.current_step_approver_id !== undefined;
  const isMyClaimWorkflowStep = isWorkflowDrivenClaim && (
    item.current_step_actionable_by_me !== undefined
      ? Boolean(item.current_step_actionable_by_me)
      : item.current_step_approver_id === me?.userId
  );
  // DEPT_CLOSE is HR Operations' own round-robin-assigned final step
  // (see workflowEngine.ts's pickRoundRobinAssignee("clearance_close_hr_ops", ...))
  // - it just passes an already-approved clearance on into Treasury
  // reporting (advanceClaimWorkflowStep's financial_outcome routing), not a
  // real approval decision, so it gets its own single "Close" action instead
  // of the full Approve/Reject/Roll Back trio every other step shows.
  // COUNTER_SIGN steps get the same treatment ONLY when they're the chain's
  // FINAL step - the approval-progress strip already stops counting the
  // chain as "real approval" after the last APPROVE step (see
  // approvalProgressStages above), so a workflow whose final step is a
  // COUNTER_SIGN rather than a DEPT_CLOSE is the same kind of passthrough
  // sign-off. A COUNTER_SIGN step mid-chain (e.g. a Manager step ahead of
  // HOD/EXCO/Close) is a real decision like any other - without this check
  // it was mislabeled "Close" and silently lost Reject/Roll Back.
  const isFinalChainStep = Array.isArray(detail?.approval_chain) && detail.approval_chain.length > 0 &&
    (detail?.workflow_step_order ?? -1) === detail.approval_chain.length - 1;
  const isDeptCloseStep = isWorkflowDrivenClaim && isFinalChainStep && ["DEPT_CLOSE", "COUNTER_SIGN"].includes((item as any).current_step_action_type);
  const canApproveClaim = isWorkflowDrivenClaim && isMyClaimWorkflowStep;
  const canRejectClaim = isWorkflowDrivenClaim && isMyClaimWorkflowStep && !isDeptCloseStep;
  const canRollbackClaim = item.doc_type === "CLAIM" && isWorkflowDrivenClaim && isMyClaimWorkflowStep && !isDeptCloseStep;
  const canSettle = item.doc_type === "CLAIM" && (role === "ADMIN" || isFinanceDept) && item.status === "FINANCE_VERIFIED";
  // Every status a claim can sit at once its own approval_chain has already
  // fully completed - legacy and the new trip-completion outcome statuses
  // alike (see claims.routes.ts's POST_CHAIN_STATUSES). "Request Correction"
  // (send back to draft) is available from any of them, not just the old
  // FINANCE_VERIFIED-only case - a claim settled/completed in error still
  // needs a way back to draft.
  const claimPostChainStatuses = ["FINANCE_VERIFIED", "PAYMENT_PROCESSING", "SETTLED", "CLOSED", ...Array.from(CLEARANCE_OUTCOME_STATUSES)];
  const canRequestCorrection = item.doc_type === "CLAIM" && (role === "ADMIN" || isFinanceDept) && claimPostChainStatuses.includes(item.status);
  const canMarkSettled = item.doc_type === "CLAIM" && (role === "ADMIN" || isFinanceDept) && item.status === "PAYMENT_PROCESSING";
  // Cancel voids the clearance outright (a terminal marker, not a "start
  // over") - available even once settled/completed, when a correction that
  // still preserves the record (rather than resubmitting) is what's needed.
  const canCancelClaim =
    item.doc_type === "CLAIM" &&
    (role === "ADMIN" || isFinanceDept) &&
    !["CANCELLED", "REJECTED", "DRAFT"].includes(item.status);

  const noActionMessage = (() => {
    if (item.doc_type === "ADVANCE" && role === "MANAGER" && !["SUBMITTED", "HR_OFFICER"].includes(item.status)) {
      return "This advance is visible for reference only.";
    }
    if (item.doc_type === "CLAIM" && isWorkflowDrivenClaim && !isMyClaimWorkflowStep) {
      return `This clearance is visible for reference only — it is currently awaiting ${(item.current_step_position_name && displayOrgGroupName(item.current_step_position_name)) || "the next approver"}.`;
    }
    if (item.doc_type === "CLAIM" && !isWorkflowDrivenClaim && role === "MANAGER" && item.status !== "SUBMITTED") {
      return "This claim is visible for reference only because manager approval is only required on submitted claims.";
    }
    return "No action available for your role on this item.";
  })();

  useEffect(() => {
    if (!canCreateAccommodation) return;
    api.hotels({ limit: 10000, offset: 0 })
      .then((result: any) => setAccommodationHotels((Array.isArray(result) ? result : result?.items) || []))
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
          provider: destinationHotelChoices.get(district) || "",
          checkIn: range?.checkIn || "",
          checkOut: range?.checkOut || "",
          amount: "",
          notes: "",
          quotation: null
        };
      });
    });
  }, [canCreateAccommodation, destinationDistricts, destinationDateRanges, destinationHotelChoices]);

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

  // Marks paid, opens the PDF, and confirms success - all while this window
  // stays open - only then closes it (via act's onDone). Closing first (what
  // the generic `act()` helper does on its own) unmounted this component
  // before the PDF/confirmation could ever be seen, so a "successful" mark-paid
  // looked like nothing happened at all.
  async function handleMarkAdvancePaid() {
    // Same reasoning as the capture flow below - open the tab synchronously,
    // before the mark-paid API call, so popup blockers don't silently
    // swallow it once the click is no longer "fresh" after that await.
    const tab = openBlankTab();
    setBusy(true);
    setError(null);
    try {
      await api.markAdvancePaid(item.id);
      try {
        await navigateTabToBlob(tab, () => api.advancePdf(item.id));
      } catch (e: any) {
        setError(e?.message || "Advance marked as paid, but failed to generate the PDF.");
        return;
      }
      await Swal.fire({ icon: "success", title: "Marked as Paid", text: "Status updated and the PDF opened in a new tab.", timer: 1800, showConfirmButton: false });
      await props.onDone();
    } catch (e: any) {
      tab?.close();
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmNotCleared() {
    const confirmed = await confirmAction({
      title: "Confirm this advance was never cleared?",
      text: "This calculates a recovery deduction (total amount ÷ recovery months) for Finance/HR to action outside this system. This cannot be undone.",
      confirmButtonText: "Confirm Not Cleared"
    });
    if (!confirmed) return;
    void act(() => api.confirmAdvanceNotCleared(item.id));
  }

  function handleRollbackAdvance() {
    if (!comments.trim()) {
      setRollbackError("Enter rollback comments before sending this advance back to the owner as draft.");
      return;
    }
    setRollbackError(null);
    void act(() => api.rollbackAdvance(item.id, comments.trim()));
  }

  function handleUndoCapture() {
    if (!comments.trim()) {
      setRollbackError("Enter a reason before undoing this capture.");
      return;
    }
    setRollbackError(null);
    void act(() => api.undoAdvanceCapture(item.id, comments.trim()));
  }

  function handleRollbackClaim() {
    if (!comments.trim()) {
      setRollbackError("Enter rollback comments before sending this clearance back to the owner as draft.");
      return;
    }
    setRollbackError(null);
    void act(() => api.rollbackClaim(item.id, comments.trim()));
  }

  function handleCancelAdvance() {
    if (!comments.trim()) {
      setRollbackError("Enter a reason before cancelling this advance.");
      return;
    }
    setRollbackError(null);
    void act(() => api.cancelAdvance(item.id, comments.trim()));
  }

  function handleCancelClaim() {
    if (!comments.trim()) {
      setRollbackError("Enter a reason before cancelling this clearance.");
      return;
    }
    setRollbackError(null);
    void act(() => api.cancelClaim(item.id, comments.trim()));
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
    // "Capture" is the action label used for the step that finalizes the
    // travel form's data. For that step, download the form and confirm
    // success to the user *before* closing this window - the generic act()
    // helper closes (and unmounts this component) immediately on success,
    // which left Capture with no visible feedback: the PDF tab could still
    // open a moment later, but any error or confirmation had nowhere to show.
    if (isCaptureStep) {
      // Open the tab synchronously, right here in the click handler, before
      // the capture API call - opening it only after that await completes
      // (the old code) meant the browser no longer saw this as a direct
      // response to the click, so popup blockers could silently swallow it
      // and Capture staff would see no PDF at all with no error shown.
      const tab = openBlankTab();
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          await api.approveAdvance(item.id, approvedTotal, comments);
          try {
            await navigateTabToBlob(tab, () => api.advancePdf(item.id));
          } catch (e: any) {
            setError(e?.message || "Captured, but failed to generate the travel form.");
            return;
          }
          await Swal.fire({ icon: "success", title: "Captured", text: "Status updated and the travel form opened in a new tab.", timer: 1800, showConfirmButton: false });
          await props.onDone();
        } catch (e: any) {
          tab?.close();
          setError(String(e.message));
        } finally {
          setBusy(false);
        }
      })();
      return;
    }
    void act(() => api.approveAdvance(item.id, approvedTotal, comments));
  }

  // Doesn't use the generic act() helper because that closes this modal
  // (via onDone) the instant the request succeeds - same reasoning as
  // handleMarkAdvancePaid below - so the success toast never had a chance
  // to render before the component unmounted.
  async function handleCreateAccommodation() {
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

    setBusy(true);
    setError(null);
    try {
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
      await Swal.fire({ icon: "success", title: "Accommodation Booked", text: "Sent to Finance for payment.", timer: 1800, showConfirmButton: false });
      await props.onDone();
    } catch (e: any) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  }

  const referenceCode = `${item.doc_type === "CLAIM" ? "CLR" : item.doc_type === "ACCOMMODATION" ? "ACC" : "ADV"}-${item.id.slice(0, 8).toUpperCase()}`;
  const pageTitle = item.doc_type === "CLAIM" ? "Travel Advance Clearance Review" : item.doc_type === "ACCOMMODATION" ? "Travel Advance Request Review" : "Advance Request Review";

  return (
    <div className="review-page">
      <div className="review-page-header">
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <span className="review-page-icon">
            {React.createElement(docTypeIcon(item.doc_type), { size: 20, "aria-hidden": true })}
          </span>
          <div>
            <div className="review-page-eyebrow">Request Review</div>
            <h2>{pageTitle}</h2>
            <span className="review-page-ref">{referenceCode}</span>
            <span className={`status-pill ${statusTone(item.status)}`}>{itemStatusLabel(item)}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {item.doc_type === "ACCOMMODATION" && (
            <button
              className="button small-button button-subtle"
              onClick={async () => {
                try {
                  await openBlobInNewTab(() => api.accommodationPdf(item.id));
                } catch (e: any) {
                  void showNotice(e?.message || "Failed to generate PDF.");
                }
              }}
            >
              Download PDF
            </button>
          )}
          {item.doc_type === "ADVANCE" && (
            <button
              className="button small-button button-subtle"
              disabled={busy}
              onClick={async () => {
                // Read-only: just opens the current PDF. Capturing (advancing
                // the workflow) only happens via the dedicated "Capture"
                // action button further down the page - this button must
                // never have a side effect on the approval chain.
                try {
                  await openBlobInNewTab(() => api.advancePdf(item.id));
                } catch (e: any) {
                  void showNotice(e?.message || "Failed to generate PDF.");
                }
              }}
            >
              Save as PDF
            </button>
          )}
          <button className="button small-button button-subtle" onClick={props.onClose}>
            Back to Inbox
          </button>
        </div>
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
              <div><small>Division</small><strong>{detail.department || detail.requester_department || "—"}</strong></div>
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
                      <strong>{fmt(detail.advance_amount, detail.currency)}</strong>
                    </div>
                    <div className="recon-stat">
                      <small>Actual Expenditure</small>
                      <strong>{fmt(detail.claim_total, detail.currency)}</strong>
                    </div>
                    <div className="recon-stat">
                      <small>Variance (Over / Under)</small>
                      <strong className={Number(detail.balance_amount) < 0 ? "recon-negative" : ""}>{fmt(detail.balance_amount, detail.currency)}</strong>
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
                      <strong>{fmt(Math.abs(Number(detail.balance_amount || 0)), detail.currency)}</strong>
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
                          <th>{detail.travel_rate_kind === "DAILY" ? "Daily Allowance" : "Meals"}</th>
                          <th>Transport</th>
                          <th>Other</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.trips || []).map((t: any) => (
                          <tr key={t.id}>
                            <td>{fmtDate(t.trip_date)}</td>
                            <td>{t.to_place ? `${t.from_place || "—"} → ${t.to_place}` : (t.from_place || "—")}</td>
                            <td>{fmt(Number(t.breakfast || 0) + Number(t.lunch || 0) + Number(t.dinner || 0), detail.currency)}</td>
                            <td>{fmt(t.petrol_allowance, detail.currency)}</td>
                            <td>{fmt(t.other_expenses, detail.currency)}</td>
                            <td>{fmt(t.line_total, detail.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                      {(detail.trips || []).length > 0 && (
                        <tfoot>
                          <tr>
                            <td colSpan={2}>{Number(detail.extra_cost_amount || 0) > 0 ? "Itemized Total" : "Total"}</td>
                            <td>{fmt((detail.trips || []).reduce((sum: number, t: any) => sum + Number(t.breakfast || 0) + Number(t.lunch || 0) + Number(t.dinner || 0), 0), detail.currency)}</td>
                            <td>{fmt((detail.trips || []).reduce((sum: number, t: any) => sum + Number(t.petrol_allowance || 0), 0), detail.currency)}</td>
                            <td>{fmt((detail.trips || []).reduce((sum: number, t: any) => sum + Number(t.other_expenses || 0), 0), detail.currency)}</td>
                            <td>{fmt((detail.trips || []).reduce((sum: number, t: any) => sum + Number(t.line_total || 0), 0), detail.currency)}</td>
                          </tr>
                          {Number(detail.extra_cost_amount || 0) > 0 && (
                            <>
                              <tr>
                                <td colSpan={5}>Extra Cost{detail.extra_cost_description ? ` — ${detail.extra_cost_description}` : ""}</td>
                                <td>{fmt(detail.extra_cost_amount, detail.currency)}</td>
                              </tr>
                              <tr className="review-table-totals-row">
                                <td colSpan={5}><b>Total</b></td>
                                <td>{fmt(Number(detail.claim_total || 0), detail.currency)}</td>
                              </tr>
                            </>
                          )}
                        </tfoot>
                      )}
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
                      canRejectClaim || canRollbackClaim || canRequestCorrection || canCancelClaim ? "Comments (required for Roll Back / Reject / Request Correction / Cancel)" : "Comments (optional)"}
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
                      {isDeptCloseStep ? "Close" : "Approve Clearance"}
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
                        settled_method: deriveSettleMethod(financeDecision, detail?.advance_payment_method),
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
                    <button className="button small-button button-success" disabled={busy} onClick={() => act(() => api.markClaimSettled(item.id, settleRef.trim() || undefined))}>
                      Mark Settled
                    </button>
                  )}
                  {canCancelClaim && (
                    <button className="button small-button button-danger" disabled={busy} onClick={handleCancelClaim}>
                      Cancel Clearance
                    </button>
                  )}
                  {!(canApproveClaim || canRejectClaim || canRollbackClaim || canRequestCorrection || canSettle || canMarkSettled || canCancelClaim) && (
                    <div className="review-empty-note">{noActionMessage}</div>
                  )}
                </div>
              </div>

              <div className="review-page-sidebar">
                <div className="review-card">
                  <div className="review-card-title">
                    Receipts Submitted{(detail.receipts?.length ?? 0) > 0 ? ` (${detail.receipts.length})` : ""}
                  </div>
                  {(detail.receipts?.length ?? 0) === 0 ? (
                    <div className="review-empty-note" style={{ padding: 14 }}>No receipts attached to this clearance.</div>
                  ) : (
                    <div className="review-receipt-list">
                      {detail.receipts.map((r: any) => (
                        <ReceiptRow key={r.id} claimId={item.id} receipt={r} />
                      ))}
                    </div>
                  )}
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
                                className="review-radio-native"
                                checked={financeDecision === value}
                                onChange={() => {
                                  setFinanceDecision(value);
                                }}
                              />
                              <RadioIcon checked={financeDecision === value} />
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
                            <div className="review-control" style={{ display: "flex", alignItems: "center" }}>
                              {paymentMethodLabel(deriveSettleMethod(financeDecision, detail?.advance_payment_method))}
                              {financeDecision === "REIMBURSE_EMPLOYEE" && " (same as the original advance)"}
                            </div>
                          </label>
                          <label>
                            <span>Payment Reference</span>
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
                            <div className="review-radio-row">
                              <label className="review-radio-option">
                                <input type="radio" name="assignee-type" className="review-radio-native" checked={assigneeType === "TEAM"} onChange={() => setAssigneeType("TEAM")} />
                                <RadioIcon checked={assigneeType === "TEAM"} />
                                Team
                              </label>
                              <label className="review-radio-option">
                                <input type="radio" name="assignee-type" className="review-radio-native" checked={assigneeType === "INDIVIDUAL"} onChange={() => setAssigneeType("INDIVIDUAL")} />
                                <RadioIcon checked={assigneeType === "INDIVIDUAL"} />
                                Individual
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
                        <div className="review-control" style={{ display: "flex", alignItems: "center" }}>
                          {paymentMethodLabel(detail?.settled_method)}
                        </div>
                      </label>
                      <label>
                        <span>Payment Reference</span>
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
              {item.doc_type === "ADVANCE" && pdfFormSummary ? (
                <>
                  <div className="review-card-title review-card-subtitle">Requester</div>
                  <div className="review-field-grid">
                    <ReviewField icon={User} label="Employee Name" value={pdfFormSummary.travellerName} />
                    <ReviewField icon={Hash} label="Employee No." value={pdfFormSummary.employeeNo} />
                    <ReviewField icon={User} label="Employment Type" value={pdfFormSummary.travellerType} />
                    <ReviewField icon={Building2} label="Division" value={pdfFormSummary.division} />
                    {pdfFormSummary.onBehalfOf && <ReviewField icon={User} label="On Behalf Of" value={pdfFormSummary.onBehalfOf} />}
                    {pdfFormSummary.applyingFor && <ReviewField icon={User} label="Applying For" value={pdfFormSummary.applyingFor} />}
                  </div>

                  <div className="review-card-title review-card-subtitle">Trip</div>
                  <div className="review-field-grid">
                    <ReviewField icon={Plane} label="Type of Travel" value={pdfFormSummary.typeOfTravel} />
                    <ReviewField icon={MapPin} label="Destination" value={pdfFormSummary.destination} />
                    <ReviewField icon={Calendar} label="Departure Date" value={pdfFormSummary.departureDate} />
                    <ReviewField icon={Calendar} label="Return Date" value={pdfFormSummary.returnDate} />
                    <ReviewField icon={Clock3} label="Travel Duration" value={pdfFormSummary.travelDuration} />
                    <ReviewField icon={FileText} label="Purpose" value={pdfFormSummary.purpose} />
                    <ReviewField icon={Hash} label="Project Number" value={pdfFormSummary.projectNumber} />
                  </div>

                  <div className="review-card-title review-card-subtitle">Payment</div>
                  <div className="review-field-grid">
                    <ReviewField icon={CreditCard} label="Requested Total" value={pdfFormSummary.requestedTotal} />
                    <ReviewField icon={CreditCard} label="Approved Total" value={pdfFormSummary.approvedTotal} />
                    <ReviewField icon={CreditCard} label="Payment" value={`${pdfFormSummary.paymentMethod} ${pdfFormSummary.paymentAccount}`} />
                    {pdfFormSummary.extraCost && (
                      <ReviewField
                        icon={CreditCard}
                        label="Extra Cost"
                        value={pdfFormSummary.extraCostDescription ? `${pdfFormSummary.extraCost} — ${pdfFormSummary.extraCostDescription}` : pdfFormSummary.extraCost}
                      />
                    )}
                  </div>
                </>
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
                  {detail.external_beneficiary_id ? (
                    <>
                      <div>Applying For: {detail.external_beneficiary_name || "—"}{detail.external_beneficiary_organisation ? ` — ${detail.external_beneficiary_organisation}` : ""}</div>
                      <div>Trip Dates: {detail.external_start_date ? fmtDate(detail.external_start_date) : "—"} to {detail.external_end_date ? fmtDate(detail.external_end_date) : "—"}</div>
                    </>
                  ) : (
                    <>
                      <div>
                        Destination: {detail.travel_destination_iata
                          ? `${detail.travel_origin_iata || "—"} → ${detail.travel_destination_iata}`
                          : (detail.advance_destination || "—")}
                      </div>
                      <div>
                        Trip Dates: {detail.advance_departure_date ? fmtDate(detail.advance_departure_date) : "—"} to {
                          detail.travel_return_date ? fmtDate(detail.travel_return_date) : (detail.advance_departure_date ? fmtDate(detail.advance_departure_date) : "—")
                        }
                      </div>
                    </>
                  )}
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

              {item.doc_type === "ADVANCE" && Boolean((item as any).is_overdue) && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.18)", borderLeft: "4px solid #dc2626", borderRadius: "0 8px 8px 0", marginBottom: 16, fontSize: "0.85rem" }}>
                  <span style={{ fontSize: 18 }}>⚠️</span>
                  <div>
                    <strong style={{ color: "#dc2626" }}>Overdue Clearance</strong>
                    <span style={{ color: "var(--muted)", marginLeft: 8 }}>
                      {(item as any).not_cleared_confirmed_at
                        ? `Confirmed not cleared. Recovery deduction: ${fmt((item as any).recovery_deduction_amount, item.currency)}`
                        : "This advance has passed its clearance duration without being cleared."}
                    </span>
                  </div>
                </div>
              )}

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
                            <span>
                              Hotel / Provider
                              <span
                                className="info-tooltip"
                                title="Pre-filled from the requester's chosen hotel, if they picked one. You control the final booking, amount, dates and payment — change it if needed."
                                style={{ marginLeft: 4 }}
                              >
                                <Info size={12} aria-hidden />
                              </span>
                              {destinationHotelChoices.get(entry.district) && (
                                <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: "0.78rem" }}> — requester's pick, adjust if needed</span>
                              )}
                            </span>
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
                    {canRollbackAdvance || canRejectAdvance || canRejectAccommodation || canUndoCapture || canCancelAdvance ? "Comments (required for Roll Back / Reject / Undo Capture / Cancel)" : "Comments (optional)"}
                  </span>
                  <textarea
                    className="review-control review-textarea"
                    value={comments}
                    onChange={(e) => {
                      setComments(e.target.value);
                      if (rollbackError) setRollbackError(null);
                      if (error === "Enter comments before rejecting this advance.") setError(null);
                    }}
                    placeholder={canRollbackAdvance || canRejectAdvance || canRejectAccommodation || canUndoCapture || canCancelAdvance ? "Enter reason for rollback/reject/undo/cancel" : ""}
                  />
                  {rollbackError && (
                    <div className="review-warning">
                      {rollbackError}
                    </div>
                  )}
                </label>

              </div>

              <div className="review-action-row">
                {(canApproveAdvance || canRejectAdvance || canRollbackAdvance) && (
                  <>
                    {canApproveAdvance && (
                      <button className="button small-button button-primary" disabled={busy} onClick={handleApproveAdvance}>
                        {customActionLabel ?? (role === "EXCO" ? "EXCO Approve" : isCounterSignStep ? "Counter Sign" : "Approve Advance")}
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
                  <button className="button small-button button-primary" disabled={busy} onClick={handleMarkAdvancePaid}>
                    Mark Advance Paid
                  </button>
                )}

                {canConfirmNotCleared && (
                  <button className="button small-button button-danger" disabled={busy} onClick={handleConfirmNotCleared}>
                    Confirm Not Cleared
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
                  <button className="button small-button button-primary" disabled={busy} onClick={() => act(() => api.markAccommodationPaid(item.id))}>
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

                {canUndoCapture && (
                  <button className="button small-button button-subtle" disabled={busy} onClick={handleUndoCapture}>
                    Undo Capture
                  </button>
                )}

                {canCancelAdvance && (
                  <button className="button small-button button-danger" disabled={busy} onClick={handleCancelAdvance}>
                    Cancel Advance
                  </button>
                )}

                {!((canRollbackAdvance || canRejectAdvance || canApproveAdvance || canMarkPaid || canCreateAccommodation || canMarkAccommodationPaid || canRejectAccommodation || canUndoCapture || canCancelAdvance)) && (
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
                {detail.request_type_code === "BRS_APPROVAL" && (
                  <div className="review-field-item" style={{ gridColumn: "1 / -1" }}>
                    <div className="review-field-icon"><FileText size={16} /></div>
                    <div>
                      <div className="review-field-label">Business Requirement Specification</div>
                      <div className="review-field-value">{detail.data?.brs_title || "—"} {detail.data?.brs_reference_no ? `(${detail.data.brs_reference_no})` : ""}</div>
                      <button
                        className="button small-button button-subtle"
                        style={{ marginTop: 6 }}
                        onClick={() => { void openBlobInNewTab(() => api.brsPdfBlob(detail.data.brs_document_id)); }}
                      >
                        View full specification (PDF)
                      </button>
                    </div>
                  </div>
                )}
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
                        <strong>{step.position_name ? displayOrgGroupName(step.position_name) : step.position_name}</strong> — {step.approver_name || "—"}
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
                  You've been named as an assignee on this request — go to Custom Processes &rsaquo; Assigned to Me to fill in implementation details and confirm.
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
