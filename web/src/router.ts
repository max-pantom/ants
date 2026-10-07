import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "agent"; id: string }
  | { name: "group"; id: string }
  | { name: "settings"; tab: string; id?: string };

export function parse(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "a" && parts[1]) return { name: "agent", id: parts[1] };
  if (parts[0] === "g" && parts[1]) return { name: "group", id: parts[1] };
  if (parts[0] === "settings") return { name: "settings", tab: parts[1] ?? "models", id: parts[2] };
  return { name: "home" };
}

export function navigate(to: string, replace = false) {
  if (location.pathname + location.search === to) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}

/** Plain links that use the router instead of a page load. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
