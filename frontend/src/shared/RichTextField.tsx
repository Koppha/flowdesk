import { useEffect, useRef } from "react";
import { Bold, Italic, Underline, List, ListOrdered, Table as TableIcon, Link as LinkIcon } from "lucide-react";

// The one rich-text editor in this frontend — every BRS section (Draft or
// Department Input) uses this same component rather than each screen
// rolling its own contentEditable + toolbar.
export function RichTextField({
  value, onChange, readOnly, placeholder
}: { value: string; onChange?: (html: string) => void; readOnly?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null);

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

  const isEmpty = !value || !value.replace(/<[^>]*>/g, "").trim();

  return (
    <div className="brs-richtext" style={readOnly ? { borderColor: "transparent" } : undefined}>
      {!readOnly && (
        <div className="brs-richtext-toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" onClick={() => exec("bold")} title="Bold"><Bold size={13} /></button>
          <button type="button" onClick={() => exec("italic")} title="Italic"><Italic size={13} /></button>
          <button type="button" onClick={() => exec("underline")} title="Underline"><Underline size={13} /></button>
          <span className="brs-richtext-sep" />
          <select
            className="brs-richtext-style"
            title="Paragraph style"
            defaultValue="p"
            onChange={(e) => { exec("formatBlock", e.target.value); e.target.value = "p"; }}
          >
            <option value="p">Paragraph</option>
            <option value="h3">Heading</option>
            <option value="blockquote">Quote</option>
          </select>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={() => exec("insertUnorderedList")} title="Bulleted list"><List size={13} /></button>
          <button type="button" onClick={() => exec("insertOrderedList")} title="Numbered list"><ListOrdered size={13} /></button>
          <span className="brs-richtext-sep" />
          <button type="button" onClick={insertTable} title="Insert table"><TableIcon size={13} /></button>
          <button type="button" onClick={insertLink} title="Insert link"><LinkIcon size={13} /></button>
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
      />
    </div>
  );
}
