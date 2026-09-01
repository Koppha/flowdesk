import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";

// Shared between CustomRequestsHub.tsx (Change Request, Computer Request,
// Attendance Register, …) and BrsStudio.tsx (BRS Approval Routing) — both
// build a free-form, requester-defined approval chain the same way, so the
// approver picker itself is written once here rather than twice.

export type DirectoryUser = {
  id: string;
  full_name: string | null;
  email: string;
  employee_no: string | null;
  department: string | null;
  title?: string | null;
  role?: string | null;
};

export const COMBOBOX_DROPDOWN_HEIGHT = 220;
export const COMBOBOX_DROPDOWN_MIN_WIDTH = 300;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function userLabel(u: DirectoryUser) {
  const parts = [u.full_name || u.email];
  if (u.title) parts.push(u.title);
  else if (u.department) parts.push(u.department);
  return parts.join(" — ");
}

export function ApproverCombobox({
  users, value, onChange, allowFreeEmail
}: { users: DirectoryUser[]; value: string; onChange: (id: string) => void; allowFreeEmail?: boolean }) {
  const selected = users.find((u) => u.id === value) || null;
  // Lets the field hold a plain email for someone who hasn't logged into
  // FlowDesk yet — they'll get an email naming them on the request instead
  // of being picked from the directory.
  const isFreeEmail = !selected && allowFreeEmail && EMAIL_RE.test(value.trim());
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [openLeftward, setOpenLeftward] = useState(false);
  const [dropdownWidth, setDropdownWidth] = useState<number | null>(null);
  // Anchor coordinates for the portaled dropdown, in viewport (position:fixed)
  // terms — collision detection against the window only works if the dropdown
  // actually escapes any ancestor with overflow:hidden (e.g. a wizard panel
  // card), which an absolutely-positioned child of this combobox can't do.
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function isInside(target: Node) {
      return Boolean(boxRef.current?.contains(target)) || Boolean(dropdownRef.current?.contains(target));
    }
    function onOutside(e: MouseEvent) {
      if (!isInside(e.target as Node)) setOpen(false);
    }
    function onScroll(e: Event) {
      // Ignore scrolling inside the dropdown's own results list — only
      // close when an ancestor (the page/panel) scrolls underneath it.
      if (isInside(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  function handleOpen() {
    const rect = boxRef.current?.getBoundingClientRect();
    const spaceBelow = rect ? window.innerHeight - rect.bottom : Infinity;
    const upward = spaceBelow < COMBOBOX_DROPDOWN_HEIGHT + 16;
    setOpenUpward(upward);

    // The dropdown is widened beyond the (often narrow) input column for
    // readability. Anchor it to whichever side of the input has enough
    // room — falling back to clamping its width to the viewport so it
    // never gets clipped or runs under a neighboring column. Positioned via
    // a portal to document.body (position: fixed, viewport coordinates) so
    // it isn't clipped by a parent card/panel with overflow:hidden.
    if (rect) {
      const desiredWidth = Math.max(rect.width, COMBOBOX_DROPDOWN_MIN_WIDTH);
      const spaceRight = window.innerWidth - rect.left;
      const spaceLeft = rect.right;
      const leftward = desiredWidth > spaceRight - 16 && spaceLeft >= desiredWidth;
      setOpenLeftward(leftward);
      setDropdownWidth(Math.min(desiredWidth, window.innerWidth - 16));
      setAnchor({
        top: rect.bottom + 2,
        bottom: window.innerHeight - rect.top + 2,
        left: rect.left,
        right: window.innerWidth - rect.right
      });
    } else {
      setOpenLeftward(false);
      setDropdownWidth(null);
      setAnchor(null);
    }

    setOpen(true);
    setQuery("");
  }

  const trimmedQuery = query.trim();
  const q = trimmedQuery.toLowerCase();
  const matches = q
    ? users.filter((u) => userLabel(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.employee_no || "").toLowerCase().includes(q))
    : users;
  const isQueryEmail = Boolean(allowFreeEmail) && EMAIL_RE.test(trimmedQuery);
  const hasExactEmailMatch = matches.some((u) => u.email.toLowerCase() === q);
  const showInviteOption = isQueryEmail && !hasExactEmailMatch;

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <Search size={13} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
        <input
          className="ep-form-input"
          style={{ paddingLeft: 26, paddingRight: (selected || isFreeEmail) ? 26 : 10 }}
          placeholder={allowFreeEmail ? "Search approver, or type an email to invite…" : "Search approver by name, email…"}
          value={open ? query : (selected ? userLabel(selected) : (isFreeEmail ? value : ""))}
          onFocus={handleOpen}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(selected || isFreeEmail) && !open && (
          <button
            type="button"
            onClick={() => onChange("")}
            style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex" }}
            title="Clear"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {open && anchor && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed", zIndex: 1000,
            width: dropdownWidth ?? "100%",
            ...(openLeftward ? { right: anchor.right } : { left: anchor.left }),
            ...(openUpward ? { bottom: anchor.bottom } : { top: anchor.top }),
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
            maxHeight: COMBOBOX_DROPDOWN_HEIGHT, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.12)"
          }}
        >
          {showInviteOption && (
            <button
              type="button"
              onClick={() => { onChange(trimmedQuery); setOpen(false); setQuery(""); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", borderBottom: matches.length ? "1px solid var(--border)" : "none", background: "transparent", cursor: "pointer", fontSize: 13 }}
            >
              <div style={{ fontWeight: 600 }}>Invite "{trimmedQuery}"</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Not yet a FlowDesk user — they'll get an email about this request</div>
            </button>
          )}
          {matches.length === 0 && !showInviteOption ? (
            <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--muted)" }}>
              {allowFreeEmail ? "No matches. Type a full email address to invite someone new." : "No matches."}
            </div>
          ) : (
            matches.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => { onChange(u.id); setOpen(false); setQuery(""); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: u.id === value ? "#eff6ff" : "transparent", cursor: "pointer", fontSize: 13 }}
              >
                <div style={{ fontWeight: 600 }}>{u.full_name || u.email}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{u.email}{u.title ? ` · ${u.title}` : u.department ? ` · ${u.department}` : ""}</div>
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
