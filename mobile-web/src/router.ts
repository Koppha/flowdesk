import { useEffect, useState } from "react";
import type { Section } from "./bridge";

// Hash routes, so each screen is a real history entry: the phone's back
// button steps back through the page (the app checks canGoBack first)
// before it leaves the screen.
export type Route =
  // Sign a Document
  | { name: "list" }
  | { name: "doc"; id: string }
  | { name: "signed"; id: string }
  | { name: "sign" }
  | { name: "send" }
  | { name: "signature" }
  // Maintenance
  | { name: "mlist" }
  | { name: "mnew" }
  | { name: "mreq"; id: string }
  // Custom Processes (Change Request, Computer Request, every Request Types process)
  | { name: "clist" }
  | { name: "cnew"; typeId?: string }
  | { name: "creq"; id: string }
  | { name: "cbrs"; id: string }
  // Account
  | { name: "phone" }
  | { name: "support" }
  | { name: "supportInbox" }
  | { name: "supportChat"; id: string };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "phone") return { name: "phone" };
  if (parts[0] === "support") {
    if (parts[1] === "inbox") return { name: "supportInbox" };
    if (parts[1] === "c" && parts[2]) return { name: "supportChat", id: parts[2] };
    return { name: "support" };
  }
  if (parts[0] === "c") {
    if (parts[1] === "new") return parts[2] ? { name: "cnew", typeId: parts[2] } : { name: "cnew" };
    if (parts[1] === "req" && parts[2]) return { name: "creq", id: parts[2] };
    if (parts[1] === "brs" && parts[2]) return { name: "cbrs", id: parts[2] };
    return { name: "clist" };
  }
  if (parts[0] === "m") {
    if (parts[1] === "new") return { name: "mnew" };
    if (parts[1] === "req" && parts[2]) return { name: "mreq", id: parts[2] };
    return { name: "mlist" };
  }
  if (parts[0] === "doc" && parts[1]) return { name: "doc", id: parts[1] };
  if (parts[0] === "signed" && parts[1]) return { name: "signed", id: parts[1] };
  if (parts[0] === "sign") return { name: "sign" };
  if (parts[0] === "send") return { name: "send" };
  if (parts[0] === "signature") return { name: "signature" };
  return { name: "list" };
}

export function href(r: Route) {
  switch (r.name) {
    case "list": return "#/";
    case "doc": case "signed": return `#/${r.name}/${r.id}`;
    case "mlist": return "#/m";
    case "mnew": return "#/m/new";
    case "mreq": return `#/m/req/${r.id}`;
    case "clist": return "#/c";
    case "cnew": return r.typeId ? `#/c/new/${r.typeId}` : "#/c/new";
    case "creq": return `#/c/req/${r.id}`;
    case "cbrs": return `#/c/brs/${r.id}`;
    case "supportInbox": return "#/support/inbox";
    case "supportChat": return `#/support/c/${r.id}`;
    default: return `#/${r.name}`;
  }
}

export function sectionOf(r: Route): Section {
  if (r.name === "phone" || r.name === "support" || r.name === "supportInbox" || r.name === "supportChat") return "account";
  if (r.name === "clist" || r.name === "cnew" || r.name === "creq" || r.name === "cbrs") return "custom";
  return r.name === "mlist" || r.name === "mnew" || r.name === "mreq" ? "maintenance" : "sign";
}

export function go(r: Route, replace = false) {
  if (replace) location.replace(href(r));
  else location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
