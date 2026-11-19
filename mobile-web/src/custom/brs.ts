import DOMPurify from "dompurify";
import { req } from "../api";

// BRS Studio (backend-v2/src/modules/brs) as the app shows it under Custom
// Processes: my BRSs, the ones I give input on or review, the ones shared with
// me, read on the phone, with the small actions that fit one - confirm a
// section assigned to me, mark it done, comment. Writing the sections stays in
// BRS Studio on the portal (rich text, several people at once).

export type BrsSummary = {
  id: string;
  title: string;
  reference_no: string | null;
  phase: string;
  brs_type_name: string;
  requester_name: string | null;
  owner_name?: string | null;
  my_role?: string;
  created_at: string;
  updated_at?: string;
  distributed_at?: string;
  distributed_by_name?: string | null;
};

export type BrsAssignee = {
  id: string;
  user_id: string | null;
  user_name: string | null;
  section_name: string | null;
  team_name: string | null;
  division_name: string | null;
  confirmed: boolean;
};

export type BrsSection = {
  id: string;
  title: string;
  description: string | null;
  owner_phase: "DRAFT" | "DEPT_INPUT" | string;
  is_required: boolean;
  content_html: string | null;
  status: "PENDING" | "IN_PROGRESS" | "SUBMITTED" | string;
  due_at: string | null;
  submitted_at: string | null;
  assignees: BrsAssignee[];
};

export type BrsDetail = BrsSummary & {
  owners: { id: string; full_name: string | null; email: string }[];
  creator: { id: string; full_name: string | null } | null;
  sections: BrsSection[];
  can_write: boolean;
  comment_count: number;
  return_comment: string | null;
  brs_approval_submission_id: string | null;
};

export type BrsComment = { id: string; section_id: string | null; section_title: string | null; body: string; author_name: string | null; created_at: string };

/** Where a BRS is in its life (the portal's BRS Studio stages). */
export const BRS_PHASES: Record<string, string> = {
  INTAKE: "Intake",
  DRAFT: "Draft",
  DEPT_INPUT: "Department input",
  GATE: "Consistency gate",
  APPROVAL: "In approval",
  BASELINE: "Approved"
};

export const brsApi = {
  mine: () => req<BrsSummary[]>("/brs/mine"),
  assigned: () => req<BrsSummary[]>("/brs/assigned-to-me"),
  shared: () => req<BrsSummary[]>("/brs/shared-with-me"),
  get: (id: string) => req<BrsDetail>(`/brs/${id}`),
  comments: (id: string) => req<BrsComment[]>(`/brs/${id}/comments`),
  comment: (id: string, body: string, section_id?: string | null) =>
    req<{ id: string }>(`/brs/${id}/comments`, { method: "POST", body: JSON.stringify({ body, section_id: section_id || null }) }),
  confirmSection: (id: string, sectionId: string) => req(`/brs/${id}/sections/${sectionId}/assignees/confirm`, { method: "POST", body: JSON.stringify({}) }),
  submitSection: (id: string, sectionId: string) => req(`/brs/${id}/sections/${sectionId}/submit`, { method: "POST", body: JSON.stringify({}) })
};

/** Everything a BRS touches me through, newest first, each listed once (mine wins over assigned over shared). */
export async function allMyBrs(): Promise<(BrsSummary & { why: "mine" | "assigned" | "shared" })[]> {
  const [mine, assigned, shared] = await Promise.all([brsApi.mine(), brsApi.assigned().catch(() => []), brsApi.shared().catch(() => [])]);
  const out = new Map<string, BrsSummary & { why: "mine" | "assigned" | "shared" }>();
  for (const d of mine) out.set(d.id, { ...d, why: "mine" });
  for (const d of assigned) if (!out.has(d.id)) out.set(d.id, { ...d, why: "assigned" });
  for (const d of shared) if (!out.has(d.id)) out.set(d.id, { ...d, why: "shared" });
  return [...out.values()].sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
}

/**
 * Section text is HTML written in BRS Studio by many people. This page holds
 * the session token, so it's shown only after DOMPurify strips scripts,
 * event handlers, frames, forms and javascript: links; links open outside
 * the app (the app sends any non-page URL to the phone's browser).
 */
export function safeHtml(html: string | null | undefined) {
  return DOMPurify.sanitize(html || "", {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
    ALLOW_DATA_ATTR: false
  });
}

export const brsPdfPath = (id: string) => `/brs/${id}/pdf`;
