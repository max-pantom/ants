import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

export function markdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] }).replace(/<a /g, '<a target="_blank" rel="noreferrer" ');
}

/** A stable warm hue per name, so an agent is recognisable at a glance. */
export function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (h * 7) % 360;
}

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function clock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export const lastSeen = {
  get(thread: string): number {
    try {
      return Number(localStorage.getItem(`seen:${thread}`) ?? 0);
    } catch {
      return 0;
    }
  },
  set(thread: string, id: number) {
    try {
      localStorage.setItem(`seen:${thread}`, String(id));
    } catch {}
  },
};

/** One line that says what a tool call was about. */
export function argSummary(args: string): string {
  try {
    const a = JSON.parse(args || "{}");
    const first = a.url ?? a.path ?? a.command ?? a.agent ?? a.name ?? a.note ?? a.task ?? a.value ?? a.key ?? a.text ?? a.ref;
    if (first === undefined) return "";
    return String(first).replace(/\s+/g, " ").slice(0, 80);
  } catch {
    return "";
  }
}

export function prettyArgs(args: string) {
  try {
    return JSON.stringify(JSON.parse(args || "{}"), null, 2);
  } catch {
    return args;
  }
}
