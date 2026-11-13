import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { aiConfigured, loadAiConfig, targetsFor, userModelPick } from "../modules/ai/ai-settings.js";
import { badRequest } from "./errors.js";
import { logger, serializeError } from "./logger.js";

// AI co-writing for documents (BRS sections, Change Request fields). It uses
// the models the admin set up for the AI Assistant - the person's own pick
// first when they may choose - and the same "ai_assistant" permission. The
// AI only proposes text: the writer sees it and decides to use it or not.

export const AI_COWRITER_FEATURE = "ai_assistant";
export const AI_COWRITER_ROLES = ["ADMIN", "MANAGER", "HOD", "EXCO", "FINANCE", "CEO", "EMPLOYEE"];

export const COWRITE_ACTIONS = ["draft", "improve", "expand", "shorten", "grammar", "formal", "bullets", "table", "requirements", "custom"] as const;
export type CowriteAction = (typeof COWRITE_ACTIONS)[number];

export const CowriteSchema = z.object({
  action: z.enum(COWRITE_ACTIONS),
  instruction: z.string().trim().max(2000).default(""),
  current: z.string().max(30_000_000).default(""),
  selection: z.string().max(30_000_000).default("")
});

const ACTION_TEXT: Record<CowriteAction, string> = {
  draft: "Write it from scratch, complete and ready for review, using everything relevant in the context.",
  improve: "Rewrite it to be clearer, better organised and more professional. Keep every fact, number, name and requirement.",
  expand: "Expand it with more useful detail and structure, building on what is there.",
  shorten: "Make it shorter and tighter, keeping every requirement, fact and number.",
  grammar: "Fix only spelling, grammar and punctuation. Change nothing else - not the wording, order or formatting.",
  formal: "Rewrite it in a formal, professional business tone. Keep every fact.",
  bullets: "Restructure it as a clear, well-organised list.",
  table: "Present the information as a table with a header row.",
  requirements: "Write it as numbered, testable requirements (\"The system shall ...\"), each one specific and unambiguous, grouped under short headings where that helps.",
  custom: ""
};

const RULES = [
  "Never invent specific facts that are not in the context - numbers, dates, names, IP addresses, systems, costs or SLAs. Where one is needed, write a placeholder in square brackets, e.g. [confirm the go-live date].",
  "Use British English. Be concise and specific; no filler, no closing remarks, no notes to the writer.",
  "Answer with the text itself only - no preamble like \"Here is...\"."
].join("\n");

// One answer from the configured models, trying the next on failure.
export async function aiComplete(userId: string, system: string, user: string, maxTokens = 4000): Promise<{ text: string; model: string }> {
  const config = await loadAiConfig();
  if (!aiConfigured(config)) throw badRequest("AI isn't set up yet - an admin can turn it on under AI Assistant settings.");
  const targets = targetsFor(config, await userModelPick(userId).catch(() => null));
  let last = "";
  for (const t of targets) {
    try {
      let text = "";
      if (t.provider === "anthropic") {
        if (!t.apiKey) continue;
        const r = await new Anthropic({ apiKey: t.apiKey }).messages.create(
          { model: t.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
          { timeout: 120_000 }
        );
        text = r.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      } else {
        const r = await fetch(`${t.base_url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}) },
          body: JSON.stringify({ model: t.model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
          signal: AbortSignal.timeout(120_000)
        });
        if (!r.ok) throw new Error(`${t.service} returned ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
        const j: any = await r.json();
        const c = j?.choices?.[0]?.message?.content;
        text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text || "").join("") : "";
      }
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (text) return { text, model: t.model };
      last = `${t.model} gave an empty answer`;
    } catch (err: any) {
      last = err?.name === "TimeoutError" ? `${t.model} took too long` : String(err?.message || err);
      logger.warn("ai_cowriter_model_failed", { service: t.service, model: t.model, error: serializeError(err) });
    }
  }
  throw badRequest(`The AI couldn't answer right now${last ? ` (${last.slice(0, 160)})` : ""}. Try again in a moment.`);
}

// ── Text helpers ────────────────────────────────────────────────────────────
export function htmlToText(html: string | null | undefined, max = 4000): string {
  const t = String(html || "")
    .replace(/<img\b[^>]*>/gi, " [picture] ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return t.length > max ? t.slice(0, max) + " …" : t;
}

// Pictures (charts, diagrams, screenshots) can be megabytes of data: the AI
// sees a marker and the picture is put back where the AI leaves the marker.
function stashImages(html: string, store: string[]) {
  return html.replace(/<img\b[^>]*>/gi, (m) => { store.push(m); return `<figure data-keep="${store.length - 1}"></figure>`; });
}
function restoreImages(html: string, store: string[], fallbackAppend: boolean) {
  const used = new Set<number>();
  let out = html.replace(/<figure\b[^>]*data-keep="(\d+)"[^>]*>\s*(<\/figure>)?/gi, (_m, i) => { used.add(Number(i)); return store[Number(i)] ?? ""; });
  // A picture the AI dropped from text it rewrote isn't lost.
  if (fallbackAppend) for (let i = 0; i < store.length; i++) if (!used.has(i)) out += `<p style="text-align: center">${store[i]}</p>`;
  return out;
}

function cleanHtml(s: string) {
  return s
    .replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "")
    .replace(/<\/?(html|head|body)\b[^>]*>/gi, "")
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "")
    .trim();
}

function cleanText(s: string) {
  return s.replace(/^```\w*\s*/, "").replace(/```\s*$/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").trim();
}

function task(action: CowriteAction, instruction: string) {
  if (action === "custom" && !instruction) throw badRequest("Say what you'd like the AI to write or change.");
  return [ACTION_TEXT[action], instruction ? `The writer's instruction: ${instruction}` : ""].filter(Boolean).join("\n");
}

// ── BRS section ─────────────────────────────────────────────────────────────
export async function cowriteBrsSection(args: {
  userId: string;
  doc: { title: string; brs_type_name?: string | null; intake_data?: Record<string, any> | null };
  section: { id: string; title: string };
  others: Array<{ id: string; title: string; content_html: string | null }>;
  input: z.infer<typeof CowriteSchema>;
}) {
  const { doc, section, input } = args;
  const store: string[] = [];
  const target = input.selection.trim() ? input.selection : input.current;
  const working = stashImages(target, store);
  const intake = doc.intake_data || {};
  let budget = 14_000;
  const otherText = args.others
    .filter((s) => s.id !== section.id)
    .map((s) => {
      const t = htmlToText(s.content_html, Math.min(1500, Math.max(0, budget)));
      budget -= t.length;
      return t ? `### ${s.title}\n${t}` : `### ${s.title}\n(empty)`;
    }).join("\n\n");

  const system = [
    "You co-write Business Requirements Specifications (BRS) at Econet Telecom Lesotho, a mobile network operator.",
    "You write one section of the document at a time, as HTML for the section body.",
    "Output only body HTML: <p>, <h3>, <h4>, <ul>/<ol>/<li>, <table> (header row in <th>), <strong>, <em>. No <html>/<body>, no markdown, no code fences, and don't repeat the section title - it is already shown.",
    "Keep every <figure data-keep=\"N\"></figure> tag exactly as it is, in the place it belongs - each one is a picture.",
    RULES
  ].join("\n");
  const user = [
    `Document: ${doc.title}${doc.brs_type_name ? ` (${doc.brs_type_name})` : ""}`,
    intake.programme_type ? `Programme type: ${intake.programme_type}` : "",
    intake.department ? `Requesting department: ${intake.department}` : "",
    intake.product_owner ? `Product owner: ${intake.product_owner}` : "",
    intake.target_quarter ? `Target quarter: ${intake.target_quarter}` : "",
    intake.business_justification ? `Business justification:\n${htmlToText(intake.business_justification, 3000)}` : "",
    otherText ? `\nOther sections of the document (for context and consistency):\n${otherText}` : "",
    `\nThe section being written: "${section.title}"`,
    input.selection.trim()
      ? `\nThe writer selected this part of the section - rewrite only this part:\n${working}`
      : working.replace(/<[^>]+>/g, "").trim() || store.length ? `\nIts current content:\n${working}` : "\nIt is empty so far.",
    `\nTask: ${task(input.action, input.instruction)}`
  ].filter(Boolean).join("\n");

  const { text, model } = await aiComplete(args.userId, system, user);
  const html = restoreImages(cleanHtml(text), store, input.action !== "custom" || !input.selection.trim());
  return { html, model };
}

// ── Change Request field ────────────────────────────────────────────────────
export async function cowriteChangeRequestField(args: {
  userId: string;
  fields: Array<{ field_key: string; field_label: string; field_type: string }>;
  values: Record<string, unknown>;
  target: { key: string; label: string };
  input: z.infer<typeof CowriteSchema>;
}) {
  const { fields, values, target, input } = args;
  const shown = (v: unknown) => typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  const ticked = fields.filter((f) => f.field_type === "checkbox" && values[f.field_key] === true).map((f) => f.field_label);
  const context = fields
    .filter((f) => f.field_key !== target.key && !["checkbox", "user", "user_multi", "file", "table"].includes(f.field_type))
    .map((f) => [f.field_label, shown(values[f.field_key]).slice(0, 2000)] as const)
    .filter(([, v]) => v)
    .map(([l, v]) => `${l}: ${v}`)
    .join("\n");
  const current = (input.selection.trim() || input.current).slice(0, 8000);

  const system = [
    "You help IT and network engineers at Econet Telecom Lesotho, a mobile network operator, write Change Requests for the Change Advisory Board.",
    "You write one field of the Change Request form at a time, as plain text.",
    "Plain text only: no markdown (no **, no #). Use numbered steps (1. 2. 3.) or \"- \" bullets where a list helps - implementation and back-out plans are numbered steps, each one concrete and checkable, including verification and who does it where known.",
    RULES
  ].join("\n");
  const user = [
    "The Change Request so far:",
    context || "(nothing filled in yet)",
    ticked.length ? `Ticked: ${ticked.join(", ")}` : "",
    `\nThe field being written: "${target.label}"`,
    current.trim() ? `${input.selection.trim() ? "The part to rewrite" : "Its current text"}:\n${current}` : "It is empty so far.",
    `\nTask: ${task(input.action, input.instruction)}`
  ].filter(Boolean).join("\n");

  const { text, model } = await aiComplete(args.userId, system, user, 2500);
  return { text: cleanText(text), model };
}
