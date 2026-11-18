import { useEffect, useState } from "react";
import { cApi, type Assignee, type ChainStep, type Field, type Person } from "./api";
import { formatDate, formatDateTime } from "../ui";

const STATUS: Record<string, [string, string]> = {
  DRAFT: ["Draft", "muted"],
  IN_PROGRESS: ["Pending approval", "warn"],
  APPROVED: ["Approved", "good"],
  COMPLETED: ["Completed", "good"],
  CLOSED: ["Closed", "good"],
  REJECTED: ["Rejected", "bad"],
  CANCELLED: ["Cancelled", "muted"]
};

export function CStatus({ status, myTurn }: { status: string; myTurn?: boolean }) {
  if (myTurn) return <span className="pill accent">Your turn</span>;
  const [label, tone] = STATUS[status] || [status.replace(/_/g, " ").toLowerCase(), "info"];
  return <span className={`pill ${tone}`}>{label}</span>;
}

/** Short reference shown on lists and headers (same id prefix the portal shows). */
export const refOf = (id: string) => id.slice(0, 8).toUpperCase();

/** Who it's with now, for lists: "With IT Manager". */
export function nextStepText(s: { status: string; approval_chain: ChainStep[]; current_step_order: number }) {
  if (s.status !== "IN_PROGRESS") return "";
  const step = s.approval_chain?.[s.current_step_order];
  return step ? `With ${step.position_name}${step.approver_name ? ` (${step.approver_name})` : ""}` : "";
}

// The company directory loads once per page visit (pickers, labels).
let peoplePromise: Promise<Person[]> | null = null;
export function usePeople() {
  const [people, setPeople] = useState<Person[] | null>(null);
  useEffect(() => {
    if (!peoplePromise) {
      peoplePromise = cApi.people();
      peoplePromise.catch(() => (peoplePromise = null));
    }
    peoplePromise.then(setPeople).catch(() => setPeople([]));
  }, []);
  return people;
}

/** How the portal labels a person: "Name — Title" (ApproverCombobox userLabel). */
export function personLabel(p: Person) {
  const parts = [p.full_name || p.email];
  if (p.title) parts.push(p.title);
  else if (p.department) parts.push(p.department);
  return parts.join(" — ");
}

function assigneeText(a: Assignee) {
  return a.teamName || a.name || a.email || "Someone";
}

/** One stored value, shown read-only. Null = nothing to show. */
export function FieldValue({ field, value }: { field: Field; value: any }): JSX.Element | null {
  if (value === undefined || value === null || value === "") return null;
  switch (field.field_type) {
    case "checkbox":
      return value ? <span>Yes</span> : null;
    case "date":
      return <span>{formatDate(String(value))}</span>;
    case "select": {
      const opts = Array.isArray(field.options) ? field.options : [];
      return <span>{opts.find((o) => o.value === value)?.label || String(value)}</span>;
    }
    case "textarea":
      return <span className="pre">{String(value)}</span>;
    case "user_multi": {
      const list = Array.isArray(value) ? (value as Assignee[]) : [];
      if (!list.length) return null;
      return (
        <span className="stack-sm">
          {list.map((a, i) => (
            <span key={i} className="row gap-sm">
              <span className="grow">{assigneeText(a)}</span>
              <span className={`pill ${a.confirmed ? "good" : "muted"}`}>{a.confirmed ? "Confirmed" : "Not yet"}</span>
            </span>
          ))}
        </span>
      );
    }
    case "table": {
      const rows: { employee?: string; cells?: Record<string, string> }[] = Array.isArray(value?.rows) ? value.rows : [];
      if (!rows.length) return null;
      return <span className="muted">{rows.length} row{rows.length === 1 ? "" : "s"} - open it in the FlowDesk portal to see the table.</span>;
    }
    default:
      return <span>{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>;
  }
}

/** Every filled-in field, in form order, with section headings. */
export function FieldList({ fields, data }: { fields: Field[]; data: Record<string, any> }) {
  const sorted = [...fields].sort((a, b) => (a.wizard_step || 1) - (b.wizard_step || 1) || a.sort_order - b.sort_order);
  const out: JSX.Element[] = [];
  let pendingHeading: Field | null = null;
  for (const f of sorted) {
    if (f.field_type === "section") {
      pendingHeading = f;
      continue;
    }
    // A plain function (no hooks), so it can be called to know if there's anything to show.
    const v = FieldValue({ field: f, value: data?.[f.field_key] });
    if (v === null) continue;
    if (pendingHeading) {
      out.push(<h3 key={`h-${pendingHeading.field_key}`} className="pad-top">{pendingHeading.field_label}</h3>);
      pendingHeading = null;
    }
    out.push(
      <div key={f.field_key} className="kv">
        <span className="muted small">{f.field_label}</span>
        <span className="kv-value">{v}</span>
      </div>
    );
  }
  if (!out.length) return <p className="muted small">Nothing filled in.</p>;
  return <>{out}</>;
}

const STEP_STATUS: Record<string, string> = {
  APPROVED: "Approved", NOTED: "Noted", REJECTED: "Rejected", ROLLED_BACK: "Rolled back", PENDING: "Waiting"
};

/** The approval route, step by step. */
export function Route({ chain, current, status }: { chain: ChainStep[]; current: number; status: string }) {
  return (
    <ol className="timeline">
      {chain.map((s, i) => {
        const isCurrent = status === "IN_PROGRESS" && i === current;
        const label = isCurrent ? "Waiting now" : STEP_STATUS[s.status] || (s.status ? s.status.replace(/_/g, " ").toLowerCase() : "Waiting");
        return (
          <li key={i}>
            <span className="row gap-sm">
              <strong className="small grow">{s.position_name}</strong>
              <span className={`pill ${isCurrent ? "accent" : s.status === "APPROVED" || s.status === "NOTED" ? "good" : s.status === "REJECTED" ? "bad" : "muted"}`}>{label}</span>
            </span>
            <span className="small">{s.approver_name || "—"}</span>
            {s.acted_at && <span className="muted small">{formatDateTime(s.acted_at)}</span>}
            {s.comment && <span className="small pre">“{s.comment}”</span>}
          </li>
        );
      })}
    </ol>
  );
}
