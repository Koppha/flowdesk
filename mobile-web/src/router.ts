import { useEffect, useState } from "react";

// Hash routes, so each screen is a real history entry: the phone's back
// button steps back through the page (the app checks canGoBack first)
// before it leaves the signing screen.
export type Route =
  | { name: "list" }
  | { name: "doc"; id: string }
  | { name: "signed"; id: string }
  | { name: "sign" }
  | { name: "send" }
  | { name: "signature" };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "doc" && parts[1]) return { name: "doc", id: parts[1] };
  if (parts[0] === "signed" && parts[1]) return { name: "signed", id: parts[1] };
  if (parts[0] === "sign") return { name: "sign" };
  if (parts[0] === "send") return { name: "send" };
  if (parts[0] === "signature") return { name: "signature" };
  return { name: "list" };
}

export function href(r: Route) {
  return "#/" + ("id" in r ? `${r.name}/${r.id}` : r.name === "list" ? "" : r.name);
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
