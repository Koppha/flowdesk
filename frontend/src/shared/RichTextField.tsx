import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  Bold, Italic, Underline, Strikethrough, Subscript, Superscript,
  List, ListOrdered, Indent, Outdent,
  Table as TableIcon, Link as LinkIcon, Link2Off, Image as ImageIcon, Minus,
  Undo2, Redo2, Trash2, Eraser,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, BarChart3, Workflow, Sparkles
} from "lucide-react";
import { AiCowriterPanel, type ApplyHow, type CowriteRequest } from "./AiCowriter";
import { ChartEditor, DiagramEditor, graphicToImgHtml, readGraphicSpec, type ChartSpec, type DiagramSpec, type GraphicSpec } from "./GraphicsEditors";

// ── Pasting ────────────────────────────────────────────────────────────────
// Word / Excel / web pages paste HTML full of Office markup. Keep what the
// document needs - tables (with merged cells), lists, headings, paragraphs,
// bold/italic/underline, colours and alignment, links and images - and drop
// the rest, so it looks right here and in the BRS PDF.
const KEEP_STYLE = /^(font-weight|font-style|text-decoration|text-align|color|background-color|background|width)$/i;
const DROP_TAGS = "script,style,meta,link,title,xml,o\\:p,colgroup,col,head";
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(DROP_TAGS).forEach((n) => n.remove());
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
  doc.body.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    // Images: only ones that travel with the document (data: or web links);
    // Word's file:///C:/... images can't be seen by anyone else.
    if (tag === "img") {
      const src = el.getAttribute("src") || "";
      if (!/^(data:image\/|https?:\/\/)/i.test(src)) { el.remove(); return; }
    }
    // Office namespaced tags (<o:p>, <v:shape>...) -> keep their text only.
    if (tag.includes(":")) { el.replaceWith(...Array.from(el.childNodes)); return; }
    const keep = new Set(["colspan", "rowspan", "href", "src", "alt", "width"]);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === "style") {
        const kept = attr.value.split(";").map((d) => d.trim()).filter((d) => {
          const [prop, val] = d.split(":").map((x) => (x || "").trim());
          return prop && val && KEEP_STYLE.test(prop) && !/mso-|windowtext/i.test(val);
        });
        if (kept.length) el.setAttribute("style", kept.join("; ")); else el.removeAttribute("style");
      } else if (!keep.has(name) || (name === "width" && tag !== "img")) {
        el.removeAttribute(attr.name);
      }
    }
  });
  // Excel wraps a table in <html><body> with <!--StartFragment--> markers; the
  // body is what we want.
  return doc.body.innerHTML.replace(/\s*<span>\s*<\/span>/g, "").trim();
}

// A pasted or chosen image, shrunk to at most 1400 px wide so a screenshot
// doesn't make the section (and the PDF) huge. PNG stays PNG when small
// (charts, diagrams); bigger ones become JPEG.
export function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.onload = () => {
      const src = String(reader.result || "");
      const img = new Image();
      img.onerror = () => resolve(src);
      img.onload = () => {
        const max = 1400;
        if (img.width <= max && src.length < 400_000) return resolve(src);
        const scale = Math.min(1, max / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(src);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const png = canvas.toDataURL("image/png");
        resolve(png.length < 600_000 ? png : canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

// The one rich-text editor in this frontend — every BRS section (Draft or
// Department Input) uses this same component rather than each screen
// rolling its own contentEditable + toolbar.
export function RichTextField({
  value, onChange, readOnly, placeholder, ai, aiTitle
}: {
  value: string; onChange?: (html: string) => void; readOnly?: boolean; placeholder?: string;
  // AI co-writing (BRS sections): asks the server for a proposal.
  ai?: CowriteRequest; aiTitle?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Whether the caret currently sits inside a table cell — gates the second,
  // table-editing toolbar row so it's never shown (or clickable) against
  // plain paragraph text, where "delete row" etc. would have nothing to act on.
  const [inTable, setInTable] = useState(false);
  // Charts and diagrams: the open editor (with the image being edited, if
  // any), the picked graphic in the text, and where the caret was when the
  // editor opened - the graphic goes there.
  const [graphicEditor, setGraphicEditor] = useState<{ kind: "chart" | "diagram"; spec: GraphicSpec | null; img: HTMLImageElement | null } | null>(null);
  const [pickedGraphic, setPickedGraphic] = useState<HTMLImageElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  // AI co-writing: what was selected when the panel opened.
  const [aiOpen, setAiOpen] = useState<{ current: string; selection: string; range: Range | null } | null>(null);

  function openAi() {
    if (readOnly || !ai) return;
    saveCaret();
    const r = savedRange.current;
    let selection = "";
    if (r && !r.collapsed) {
      const holder = document.createElement("div");
      holder.appendChild(r.cloneContents());
      selection = holder.innerHTML;
    }
    setAiOpen({ current: ref.current?.innerHTML || "", selection, range: r ? r.cloneRange() : null });
  }

  function applyAi(html: string, how: ApplyHow) {
    const el = ref.current;
    if (!el) return;
    const range = aiOpen?.range;
    if (how === "replace") {
      el.innerHTML = html;
    } else if (how === "append") {
      el.insertAdjacentHTML("beforeend", html);
    } else {
      el.focus();
      const sel = window.getSelection();
      if (range && sel && el.contains(range.startContainer)) {
        if (how === "insert") range.collapse(false);
        sel.removeAllRanges(); sel.addRange(range);
        if (!document.execCommand("insertHTML", false, html)) { range.deleteContents(); const frag = range.createContextualFragment(html); range.insertNode(frag); }
      } else {
        el.insertAdjacentHTML("beforeend", html);
      }
    }
    onChange?.(el.innerHTML);
  }

  // Only push `value` into the DOM when it actually differs from what's
  // already there — e.g. switching to a different section, or another
  // user's edit coming back from a reload. Never on every local keystroke,
  // since re-setting innerHTML mid-type would throw the caret to the start.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value || "")) {
      ref.current.innerHTML = value || "";
    }
  }, [value]);

  function exec(cmd: string, arg?: string) {
    if (readOnly) return;
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    onChange?.(ref.current?.innerHTML || "");
  }

  function insertTable() {
    if (readOnly) return;
    ref.current?.focus();
    const html = '<table><tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>';
    if (!document.execCommand("insertHTML", false, html)) {
      ref.current?.insertAdjacentHTML("beforeend", html);
    }
    onChange?.(ref.current?.innerHTML || "");
  }

  function saveCaret() {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount && ref.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  }

  function openGraphic(kind: "chart" | "diagram") {
    if (readOnly) return;
    saveCaret();
    setGraphicEditor({ kind, spec: null, img: null });
  }

  function editGraphic(img: HTMLImageElement) {
    const spec = readGraphicSpec(img);
    if (!spec || readOnly) return;
    setGraphicEditor({ kind: spec.kind, spec, img });
  }

  async function saveGraphic(spec: GraphicSpec) {
    const target = graphicEditor?.img;
    setGraphicEditor(null);
    let html: string;
    try { html = await graphicToImgHtml(spec); } catch { return; }
    if (target && ref.current?.contains(target)) {
      // Keep the size the writer gave it.
      const kept = target.getAttribute("width");
      const holder = document.createElement("span");
      holder.innerHTML = html;
      const img = holder.firstElementChild as HTMLImageElement;
      if (kept) img.setAttribute("width", kept);
      target.replaceWith(img);
      setPickedGraphic(img);
      onChange?.(ref.current?.innerHTML || "");
      return;
    }
    ref.current?.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current); }
    insertHtml(`<p style="text-align: center">${html}</p><p><br></p>`);
  }

  // A picked graphic: make it smaller/larger (the PDF follows), or remove it.
  function resizeGraphic(factor: number) {
    if (!pickedGraphic) return;
    const cur = Number(pickedGraphic.getAttribute("width")) || pickedGraphic.naturalWidth / 2 || 600;
    pickedGraphic.setAttribute("width", String(Math.round(Math.max(160, Math.min(720, cur * factor)))));
    onChange?.(ref.current?.innerHTML || "");
  }
  function removeGraphic() {
    if (!pickedGraphic) return;
    pickedGraphic.remove();
    setPickedGraphic(null);
    onChange?.(ref.current?.innerHTML || "");
  }

  function insertHtml(html: string) {
    ref.current?.focus();
    if (!document.execCommand("insertHTML", false, html)) ref.current?.insertAdjacentHTML("beforeend", html);
    onChange?.(ref.current?.innerHTML || "");
  }

  // Paste: keep tables, lists, formatting and images (see cleanPastedHtml);
  // screenshots and charts copied as pictures become images. Plain text
  // pastes as it always did.
  async function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    if (readOnly) return;
    const cd = e.clipboardData;
    const html = cd.getData("text/html");
    const images = Array.from(cd.files || []).filter((f) => f.type.startsWith("image/"));
    if (html && /<(table|img|ul|ol|li|h[1-6]|p|b|strong|i|em|u|div|span|br)\b/i.test(html)) {
      e.preventDefault();
      let clean = cleanPastedHtml(html);
      // Excel/Word also put the selection on the clipboard as a picture: only
      // use it when the HTML itself had no table or image to show.
      if (images.length && !/<(table|img)\b/i.test(clean) && !clean.replace(/<[^>]*>/g, "").trim()) {
        clean = (await Promise.all(images.map(imageFileToDataUrl))).map((src) => `<img src="${src}">`).join("");
      }
      if (clean) insertHtml(clean);
      return;
    }
    if (images.length) {
      e.preventDefault();
      try {
        const srcs = await Promise.all(images.map(imageFileToDataUrl));
        insertHtml(srcs.map((src) => `<img src="${src}">`).join("") + "<p><br></p>");
      } catch { /* leave the paste out */ }
    }
  }

  function insertLink() {
    if (readOnly) return;
    const url = window.prompt("Link URL", "https://");
    if (url) exec("createLink", url);
  }

  // Insert image: pick one from this computer (it's kept inside the document,
  // so everyone - and the PDF - sees it).
  function insertImage() {
    if (readOnly) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try { insertHtml(`<img src="${await imageFileToDataUrl(file)}"><p><br></p>`); } catch { /* unreadable image */ }
    };
    input.click();
  }

  // Finds the table cell the caret or click currently sits in, if any —
  // re-read from the live selection on every call rather than cached,
  // since a toolbar button click can shift focus/selection between renders.
  function currentCell(): HTMLTableCellElement | null {
    const sel = window.getSelection();
    const anchor = sel?.anchorNode;
    if (!anchor || !ref.current?.contains(anchor)) return null;
    const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element);
    return (el?.closest("td,th") as HTMLTableCellElement | null) ?? null;
  }

  function refreshTableState() {
    setInTable(Boolean(currentCell()));
  }

  // Runs `action` against the table containing the caret, then syncs both
  // the field's value and the contextual toolbar's visibility - shared by
  // every row/column/table edit below so none of them forget either step.
  function withTable(action: (cell: HTMLTableCellElement, table: HTMLTableElement) => void) {
    if (readOnly) return;
    ref.current?.focus();
    const cell = currentCell();
    const table = cell?.closest("table") as HTMLTableElement | null;
    if (!cell || !table) return;
    action(cell, table);
    onChange?.(ref.current?.innerHTML || "");
    refreshTableState();
  }

  function addRow() {
    withTable((cell) => {
      const row = cell.closest("tr")!;
      const newRow = row.cloneNode(true) as HTMLTableRowElement;
      Array.from(newRow.children).forEach((td) => { td.innerHTML = "&nbsp;"; });
      row.after(newRow);
    });
  }

  function addColumn() {
    withTable((cell, table) => {
      const cellIndex = Array.from(cell.parentElement!.children).indexOf(cell);
      table.querySelectorAll("tr").forEach((tr) => {
        const sibling = tr.children[cellIndex] as HTMLElement | undefined;
        if (!sibling) return;
        const newCell = document.createElement(sibling.tagName.toLowerCase() === "th" ? "th" : "td");
        newCell.innerHTML = "&nbsp;";
        sibling.after(newCell);
      });
    });
  }

  function deleteRow() {
    withTable((cell, table) => {
      if (table.querySelectorAll("tr").length <= 1) table.remove();
      else cell.closest("tr")!.remove();
    });
  }

  function deleteColumn() {
    withTable((cell, table) => {
      const firstRow = table.querySelector("tr");
      const cellIndex = Array.from(cell.parentElement!.children).indexOf(cell);
      if (!firstRow || firstRow.children.length <= 1) { table.remove(); return; }
      table.querySelectorAll("tr").forEach((tr) => { tr.children[cellIndex]?.remove(); });
    });
  }

  function deleteTable() {
    withTable((_cell, table) => { table.remove(); });
  }

  const isEmpty = !value || (!value.replace(/<[^>]*>/g, "").trim() && !/<(img|table|hr)\b/i.test(value));
  const pickedSpec = pickedGraphic ? readGraphicSpec(pickedGraphic) : null;

  return (
    <div className="brs-richtext" style={readOnly ? { borderColor: "transparent" } : undefined}>
      {!readOnly && (
        <div className="brs-richtext-toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" onClick={() => exec("undo")} title="Undo"><Undo2 size={13} /></button>
          <button type="button" onClick={() => exec("redo")} title="Redo"><Redo2 size={13} /></button>
          <span className="brs-richtext-sep" />
          <select
            className="brs-richtext-style"
            title="Paragraph style"
            defaultValue="p"
            onChange={(e) => { exec("formatBlock", e.target.value); e.target.value = "p"; }}
          >
            <option value="p">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="h4">Heading 4</option>
            <option value="blockquote">Quote</option>
            <option value="pre">Code block</option>
          </select>
          <select
            className="brs-richtext-style"
            title="Font"
            defaultValue=""
            onChange={(e) => { exec("fontName", e.target.value); e.target.value = ""; }}
          >
            <option value="" disabled>Font</option>
            <option value="Arial">Arial</option>
            <option value="Georgia">Georgia</option>
            <option value="'Times New Roman'">Times New Roman</option>
            <option value="'Courier New'">Courier New</option>
            <option value="Verdana">Verdana</option>
          </select>
          <select
            className="brs-richtext-style"
            title="Font size"
            defaultValue=""
            onChange={(e) => { exec("fontSize", e.target.value); e.target.value = ""; }}
          >
            <option value="" disabled>Size</option>
            <option value="2">Small</option>
            <option value="3">Normal</option>
            <option value="4">Medium</option>
            <option value="5">Large</option>
            <option value="7">Huge</option>
          </select>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={() => exec("bold")} title="Bold"><Bold size={13} /></button>
          <button type="button" onClick={() => exec("italic")} title="Italic"><Italic size={13} /></button>
          <button type="button" onClick={() => exec("underline")} title="Underline"><Underline size={13} /></button>
          <button type="button" onClick={() => exec("strikeThrough")} title="Strikethrough"><Strikethrough size={13} /></button>
          <label className="brs-richtext-color" title="Text color">
            <span style={{ borderBottomColor: "#dc2626" }}>A</span>
            <input type="color" defaultValue="#111827" onChange={(e) => exec("foreColor", e.target.value)} />
          </label>
          <label className="brs-richtext-color" title="Highlight color">
            <span style={{ borderBottomColor: "#fde047" }}>H</span>
            <input type="color" defaultValue="#fef08a" onChange={(e) => exec("hiliteColor", e.target.value)} />
          </label>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={() => exec("subscript")} title="Subscript">X<sub>2</sub></button>
          <button type="button" onClick={() => exec("superscript")} title="Superscript">X<sup>2</sup></button>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={() => exec("justifyLeft")} title="Align left"><AlignLeft size={13} /></button>
          <button type="button" onClick={() => exec("justifyCenter")} title="Center"><AlignCenter size={13} /></button>
          <button type="button" onClick={() => exec("justifyRight")} title="Align right"><AlignRight size={13} /></button>
          <button type="button" onClick={() => exec("justifyFull")} title="Justify"><AlignJustify size={13} /></button>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={() => exec("insertUnorderedList")} title="Bulleted list"><List size={13} /></button>
          <button type="button" onClick={() => exec("insertOrderedList")} title="Numbered list"><ListOrdered size={13} /></button>
          <button type="button" onClick={() => exec("outdent")} title="Decrease indent"><Outdent size={13} /></button>
          <button type="button" onClick={() => exec("indent")} title="Increase indent"><Indent size={13} /></button>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={insertTable} title="Insert table"><TableIcon size={13} /></button>
          <button type="button" onClick={insertImage} title="Insert image"><ImageIcon size={13} /></button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => openGraphic("chart")} title="Insert a chart or graph (bar, line, area, pie...)"><BarChart3 size={13} /> Chart</button>
          {ai && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={openAi} title="Write with AI: draft this section, or improve, expand or shorten the selected text"
              style={{ color: "#6250d6", fontWeight: 600 }}><Sparkles size={13} /> AI</button>
          )}
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => openGraphic("diagram")} title="Insert a diagram: flowchart, UML (class, use case, activity, sequence), shapes and connectors"><Workflow size={13} /> Diagram</button>
          <button type="button" onClick={insertLink} title="Insert link"><LinkIcon size={13} /></button>
          <button type="button" onClick={() => exec("unlink")} title="Remove link"><Link2Off size={13} /></button>
          <button type="button" onClick={() => exec("insertHorizontalRule")} title="Horizontal rule"><Minus size={13} /></button>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={() => exec("removeFormat")} title="Clear formatting"><Eraser size={13} /></button>
        </div>
      )}
      {!readOnly && inTable && (
        <div className="brs-richtext-toolbar brs-richtext-table-toolbar" role="toolbar" aria-label="Table editing">
          <span className="brs-richtext-table-label">Table:</span>
          <button type="button" onClick={addRow} title="Add a row below the current one">+ Row</button>
          <button type="button" onClick={addColumn} title="Add a column right of the current one">+ Column</button>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={deleteRow} title="Delete the current row">Delete Row</button>
          <button type="button" onClick={deleteColumn} title="Delete the current column">Delete Column</button>
          <span className="brs-richtext-sep" />
          <button type="button" className="brs-richtext-table-delete" onClick={deleteTable} title="Delete the whole table">
            <Trash2 size={13} /> Delete Table
          </button>
        </div>
      )}
      {!readOnly && pickedGraphic && pickedSpec && (
        <div className="brs-richtext-toolbar brs-richtext-table-toolbar" role="toolbar" aria-label="Chart or diagram">
          <span className="brs-richtext-table-label">{pickedSpec.kind === "chart" ? "Chart:" : "Diagram:"}</span>
          <button type="button" onClick={() => editGraphic(pickedGraphic)}>Edit</button>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={() => resizeGraphic(0.8)} title="Make it smaller">Smaller</button>
          <button type="button" onClick={() => resizeGraphic(1.25)} title="Make it larger (up to the page width)">Larger</button>
          <span className="brs-richtext-sep" />
          <button type="button" className="brs-richtext-table-delete" onClick={removeGraphic}><Trash2 size={13} /> Remove</button>
        </div>
      )}
      {aiOpen && ai && (
        <AiCowriterPanel kind="html" title={aiTitle || "this section"} current={aiOpen.current} selection={aiOpen.selection} request={ai}
          onClose={() => setAiOpen(null)} onApply={applyAi} />
      )}
      {graphicEditor?.kind === "chart" && (
        <ChartEditor initial={graphicEditor.spec as ChartSpec | null} onCancel={() => setGraphicEditor(null)} onSave={(sp) => void saveGraphic(sp)} />
      )}
      {graphicEditor?.kind === "diagram" && (
        <DiagramEditor initial={graphicEditor.spec as DiagramSpec | null} onCancel={() => setGraphicEditor(null)} onSave={(sp) => void saveGraphic(sp)} />
      )}
      <div
        ref={ref}
        className="brs-richtext-editable"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        data-placeholder={isEmpty ? (placeholder || (readOnly ? "—" : "Start typing…")) : undefined}
        onInput={() => onChange?.(ref.current?.innerHTML || "")}
        onBlur={() => onChange?.(ref.current?.innerHTML || "")}
        onPaste={(e) => void handlePaste(e)}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          setPickedGraphic(t.tagName === "IMG" && t.hasAttribute("data-fd-graphic") ? (t as HTMLImageElement) : null);
        }}
        onDoubleClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.tagName === "IMG" && t.hasAttribute("data-fd-graphic")) { e.preventDefault(); editGraphic(t as HTMLImageElement); }
        }}
        onMouseUp={refreshTableState}
        onKeyUp={refreshTableState}
      />
    </div>
  );
}
