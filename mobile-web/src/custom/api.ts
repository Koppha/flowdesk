import { req, send } from "../api";

// Custom Processes (Change Request, Computer Request, BRS and every type an
// admin builds in Request Types) - the same endpoints the web portal uses
// (backend-v2/src/modules/custom-requests, request-types, inbox).

export type FieldType = "text" | "number" | "date" | "select" | "textarea" | "checkbox" | "file" | "table" | "user" | "user_multi" | "section";

export type Field = {
  field_key: string;
  field_label: string;
  field_type: FieldType;
  is_required: boolean;
  placeholder: string | null;
  options: { label: string; value: string }[] | { columns?: { key: string; label: string }[] } | null;
  sort_order: number;
  wizard_step?: number;
  /** Written by that approval step's approver (e.g. Justification by Supervisor), not on the form. */
  filled_at_step?: number | null;
};

export type ChainStep = {
  approver_id: string;
  approver_name: string | null;
  position_name: string;
  decision_type?: "APPROVE" | "NOTE";
  status: string;
  comment: string | null;
  acted_at: string | null;
};

export type Assignee = {
  id: string | null; name: string | null; email: string | null;
  teamName?: string | null; confirmed: boolean; confirmed_at?: string | null; confirmedBy?: string | null;
};

export type Provisioning = {
  status: string; assigned_to_name: string | null; asset_number: string | null;
  ready_for_collection_at: string | null; collection_acknowledged_at: string | null;
} | null;

/** A submission as the lists return it. */
export type Summary = {
  id: string;
  request_type_name: string;
  request_type_code: string;
  requester_name?: string;
  status: string;
  current_step_order: number;
  approval_chain: ChainStep[];
  created_at: string;
  submitted_at?: string | null;
  my_role?: "OWNER" | "CO_WRITER";
};

export type Detail = Summary & {
  requester_id: string;
  requester_email: string;
  data: Record<string, any>;
  fields: Field[];
  attachments: { id: string; original_name: string; size_bytes?: number | null }[];
  can_view_pdf: boolean;
  it_provisioning: Provisioning;
  cancel_comment?: string | null;
};

/** A custom request waiting on me, from the approval inbox. */
export type Task = {
  doc_type: "CUSTOM_REQUEST";
  id: string;
  status: string;
  request_type_name: string;
  request_type_code: string;
  requester_name: string;
  current_step_position_name: string | null;
  current_step_actionable_by_me: boolean;
  is_assignee_task: boolean;
  assignee_field_keys?: string[];
  assignee_labels?: string[];
  delegated_from_manager_name?: string | null;
  created_at: string;
};

export type FixedStep = { title: string; source: "AUTO_MANAGER" | "ROLE_PICKER"; role?: string; roles?: string[]; default_approver_id?: string | null };

export type RequestType = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  category: string | null;
  status: string;
  is_internal: boolean;
  fixed_approval_chain: FixedStep[] | null;
};

export type TypeDetail = RequestType & { fields: Field[] };

export type Person = { id: string; full_name: string | null; email: string; title: string | null; department: string | null; role: string };

export const cApi = {
  /** Custom requests waiting on me (approver or assignee). */
  tasks: async () => {
    const res = await req<{ items: any[] }>("/inbox");
    return (res.items || []).filter((i) => i.doc_type === "CUSTOM_REQUEST") as Task[];
  },
  mine: () => req<Summary[]>("/custom-requests/mine"),
  assigned: () => req<Summary[]>("/custom-requests/assigned-to-me"),
  collaborating: () => req<Summary[]>("/custom-requests/change-requests/collaborating"),
  get: (id: string) => req<Detail>(`/custom-requests/${id}`),

  act: (id: string, body: { action: "APPROVE" | "REJECT" | "ROLLBACK"; comment?: string; field_values?: Record<string, unknown> }) =>
    req<{ status: string }>(`/custom-requests/${id}/action`, { method: "POST", body: JSON.stringify(body) }),
  confirmAssignee: (id: string, field_key: string) =>
    req(`/custom-requests/${id}/assignees/confirm`, { method: "POST", body: JSON.stringify({ field_key }) }),
  assigneeDecision: (id: string, decision: "REJECT" | "ROLLBACK", comment: string) =>
    req(`/custom-requests/${id}/assignees/decision`, { method: "POST", body: JSON.stringify({ decision, comment }) }),
  remind: (id: string) => req(`/custom-requests/${id}/remind`, { method: "POST" }),
  cancel: (id: string, comment: string) => req(`/custom-requests/${id}/cancel`, { method: "POST", body: JSON.stringify({ comment }) }),
  acknowledgeCollection: (id: string) => req(`/custom-requests/${id}/acknowledge-collection`, { method: "POST", body: JSON.stringify({}) }),

  types: () => req<RequestType[]>("/request-types"),
  type: (id: string) => req<TypeDetail>(`/request-types/${id}`),
  myManager: () => req<{ id: string; full_name: string | null; email: string; title: string | null } | null>("/reporting-lines/my-manager"),
  people: () => req<Person[]>("/auth/request-directory?scope=company"),

  submit: async (body: { request_type_id: string; data: Record<string, any>; approval_chain: { approver_id: string | null; position_name: string; decision_type: "APPROVE" | "NOTE" }[] }) => {
    // Multipart, like the portal's wizard (attachments would ride along).
    const form = new FormData();
    form.append("request_type_id", body.request_type_id);
    form.append("data", JSON.stringify(body.data));
    form.append("approval_chain", JSON.stringify(body.approval_chain));
    const res = await send("/custom-requests", { method: "POST", body: form, headers: { Accept: "application/json" } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.message || json?.error?.message || json?.error || "Couldn't send the request.");
    return json as { id: string };
  }
};

export const pdfPathFor = (id: string) => `/custom-requests/${id}/pdf`;
export const attachmentPathFor = (id: string, attachmentId: string) => `/custom-requests/${id}/attachments/${attachmentId}`;
