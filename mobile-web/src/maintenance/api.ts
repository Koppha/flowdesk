import { req, send } from "../api";

// Mirrors backend-v2/src/modules/maintenance/maintenance.routes.ts. The
// server decides who may do what (`can`) and each person's next step, so the
// screens only show what it allows.

export type Option = { value: string; label: string };
export type Site = { id: string; name: string; district: string; kind: string };
export type Category = { id: string; name: string; photo_required: boolean };
export type Worker = { id: string; name: string; is_contractor: boolean; contractor_company: string | null };

export type Meta = {
  sites: Site[];
  categories: Category[];
  priorities: Option[];
  status_labels: Record<string, string>;
  enabled: boolean;
  is_admin_office: boolean;
  is_worker: boolean;
  my_site_ids: string[];
  has_route: boolean;
  workers: Worker[];
};

export type Summary = {
  id: string;
  request_no: string;
  status: string;
  status_label: string;
  priority: string;
  priority_label: string;
  site_name: string;
  location: string;
  category: string;
  description: string;
  requester_name: string;
  worker_name: string | null;
  target_date: string | null;
  update_requested: boolean;
  created_at: string;
  next_step: string | null;
};

export type Photo = { id: string; stage: string; event_id: string | null; uploaded_by: string; deleted: boolean; delete_reason: string | null; created_at: string };
export type Event = { id: string; kind: string; to_status: string | null; body: string | null; created_at: string; actor_name: string | null; photo_ids: string[] };

export type Action =
  | "review" | "request_info" | "assign" | "request_approval" | "verify" | "send_back" | "cancel" | "accept" | "decline" | "set_status"
  | "complete" | "approve" | "reject_approval" | "provide_info" | "request_update" | "confirm" | "reopen" | "comment";

export type Detail = Summary & {
  district: string;
  contact_name: string;
  contact_phone: string;
  asset_tag: string | null;
  access_times: string | null;
  instructions: string | null;
  worker_phone: string | null;
  worker_is_contractor: boolean;
  work_done: string | null;
  parts_used: string | null;
  time_spent_hours: string | null;
  cost: string | null;
  approval_reason: string | null;
  approval_estimate: string | null;
  approval_status: string | null;
  admin_office_label: string;
  photos: Photo[];
  events: Event[];
  target: { respond_hours: number; fix_working_days: number } | null;
  my: { is_requester: boolean; is_office: boolean; is_worker: boolean; is_site_staff: boolean; is_admin: boolean };
  can: Record<Action, boolean>;
};

export type Scope = "mine" | "site" | "jobs" | "office" | "approvals";
export type StatusFilter = "open" | "closed" | "all";

export type NewRequest = {
  site_id: string;
  location: string;
  contact_name: string;
  contact_phone: string;
  category_id: string;
  priority: string;
  asset_tag: string;
  description: string;
  access_times: string;
  photo_ids: string[];
};

export type ActionInput = {
  action: Action;
  body?: string;
  photo_ids?: string[];
  worker_id?: string;
  target_date?: string;
  priority?: string;
  status?: string;
  estimate?: number;
  work_done?: string;
  parts_used?: string;
  time_spent_hours?: number;
  cost?: number;
};

export const mApi = {
  meta: () => req<Meta>("/maintenance/meta"),
  list: (scope: Scope, status: StatusFilter) => req<Summary[]>(`/maintenance/requests?scope=${scope}&status=${status}`),
  get: (id: string) => req<Detail>(`/maintenance/requests/${id}`),
  create: (body: NewRequest) => req<{ id: string; request_no: string }>("/maintenance/requests", { method: "POST", body: JSON.stringify(body) }),
  act: (id: string, input: ActionInput) => req<{ ok: true }>(`/maintenance/requests/${id}/actions`, { method: "POST", body: JSON.stringify(input) }),
  uploadPhoto: (file: Blob, name: string) => {
    const form = new FormData();
    form.append("file", file, name);
    return req<{ id: string }>("/maintenance/photos", { method: "POST", body: form });
  }
};

// ── Photos ───────────────────────────────────────────────────────────────────

/**
 * Phone cameras produce 3-8 MB photos; on a weak connection that's the
 * difference between a request going through or not. Re-encode to a
 * 1600px JPEG (plenty to see a leak or a broken socket) - or send the
 * original if the phone can't decode it here (e.g. HEIC).
 */
export async function shrink(file: File): Promise<{ blob: Blob; name: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob || blob.size >= file.size) return { blob: file, name: file.name };
    return { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
  } catch {
    return { blob: file, name: file.name };
  }
}

export function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// The backend's CSP allows data: images but not blob:, so fetched photos are
// shown as data URLs - cached, since a request's timeline reuses them.
const photoCache = new Map<string, Promise<string>>();

export function photoUrl(id: string): Promise<string> {
  let p = photoCache.get(id);
  if (!p) {
    p = send(`/maintenance/photos/${id}`).then(async (res) => {
      if (!res.ok) throw new Error(res.status === 410 ? "Photo deleted" : "Couldn't load photo");
      return toDataUrl(await res.blob());
    });
    p.catch(() => photoCache.delete(id));
    photoCache.set(id, p);
  }
  return p;
}
