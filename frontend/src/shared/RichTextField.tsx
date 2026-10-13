import { useEffect, useRef, useState } from "react";
import {
  Bold, Italic, Underline, Strikethrough, Subscript, Superscript,
  List, ListOrdered, Indent, Outdent,
  Table as TableIcon, Link as LinkIcon, Link2Off, Image as ImageIcon, Minus,
  Undo2, Redo2, Trash2, Eraser,
  AlignLeft, AlignCenter, AlignRight, AlignJustify
} from "lucide-react";

// The one rich-text editor in this frontend — every BRS section (Draft or
// Department Input) uses this same component rather than each screen
// rolling its own contentEditable + toolbar.
export function RichTextField({
  value, onChange, readOnly, placeholder
}: { value: string; onChange?: (html: string) => void; readOnly?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Whether the caret currently sits inside a table cell — gates the second,
  // table-editing toolbar row so it's never shown (or clickable) against
  // plain paragraph text, where "delete row" etc. would have nothing to act on.
  const [inTable, setInTable] = useState(false);

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

  function insertLink() {
    if (readOnly) return;
    const url = window.prompt("Link URL", "https://");
    if (url) exec("createLink", url);
  }

  function insertImage() {
    if (readOnly) return;
    const url = window.prompt("Image URL", "https://");
    if (url) exec("insertImage", url);
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

  const isEmpty = !value || !value.replace(/<[^>]*>/g, "").trim();

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
      <div
        ref={ref}
        className="brs-richtext-editable"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        data-placeholder={isEmpty ? (placeholder || (readOnly ? "—" : "Start typing…")) : undefined}
        onInput={() => onChange?.(ref.current?.innerHTML || "")}
        onBlur={() => onChange?.(ref.current?.innerHTML || "")}
        onMouseUp={refreshTableState}
        onKeyUp={refreshTableState}
      />
    </div>
  );
}
