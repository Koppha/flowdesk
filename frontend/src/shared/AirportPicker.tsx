import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapPin, X } from "lucide-react";

// The "Where From" / "Where To" picker on the international ("Plan Your
// Trip") advance-request flow. Same portal + collision-detection dropdown
// approach as ApproverCombobox (shared/ApproverCombobox.tsx) — written
// separately rather than generalizing that one, since the two pick from
// differently-shaped rows (airports vs. directory users) and each is only
// ever used from a single place today.

export type AirportRow = { iata_code: string; name: string; city: string; country: string };

const DROPDOWN_HEIGHT = 240;
const DROPDOWN_MIN_WIDTH = 300;

export function airportLabel(a: AirportRow) {
  return `${a.city} (${a.iata_code})`;
}

export function AirportPicker({
  airports, value, onChange, placeholder
}: { airports: AirportRow[]; value: string; onChange: (iataCode: string) => void; placeholder?: string }) {
  const selected = airports.find((a) => a.iata_code === value) || null;
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [dropdownWidth, setDropdownWidth] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number } | null>(null);
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
    setOpenUpward(spaceBelow < DROPDOWN_HEIGHT + 16);
    if (rect) {
      setDropdownWidth(Math.min(Math.max(rect.width, DROPDOWN_MIN_WIDTH), window.innerWidth - 16));
      setAnchor({ top: rect.bottom + 2, bottom: window.innerHeight - rect.top + 2, left: rect.left });
    } else {
      setDropdownWidth(null);
      setAnchor(null);
    }
    setOpen(true);
    setQuery("");
  }

  const q = query.trim().toLowerCase();
  const matches = (q
    ? airports.filter((a) => a.city.toLowerCase().includes(q) || a.iata_code.toLowerCase().includes(q) || a.country.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    : airports
  ).slice(0, 60);

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <MapPin size={13} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
        <input
          className="ep-form-input"
          style={{ paddingLeft: 26, paddingRight: selected && !open ? 26 : 10 }}
          placeholder={placeholder || "Search city or airport code…"}
          value={open ? query : (selected ? airportLabel(selected) : "")}
          onFocus={handleOpen}
          onChange={(e) => setQuery(e.target.value)}
        />
        {selected && !open && (
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
            width: dropdownWidth ?? "100%", left: anchor.left,
            ...(openUpward ? { bottom: anchor.bottom } : { top: anchor.top }),
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
            maxHeight: DROPDOWN_HEIGHT, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.12)"
          }}
        >
          {matches.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--muted)" }}>No matching airports.</div>
          ) : (
            matches.map((a) => (
              <button
                key={a.iata_code}
                type="button"
                onClick={() => { onChange(a.iata_code); setOpen(false); setQuery(""); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: a.iata_code === value ? "#eff6ff" : "transparent", cursor: "pointer", fontSize: 13 }}
              >
                <div style={{ fontWeight: 600 }}>{a.city} <span style={{ fontWeight: 700, color: "var(--primary, #2563eb)" }}>({a.iata_code})</span></div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{a.name}{a.country ? ` · ${a.country}` : ""}</div>
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
