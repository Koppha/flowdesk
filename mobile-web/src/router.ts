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
  // Account
  | { name: "phone" };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "phone") return { name: "phone" };
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
    default: return `#/${r.name}`;
  }
}

export function sectionOf(r: Route): Section {
  if (r.name === "phone") return "account";
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
