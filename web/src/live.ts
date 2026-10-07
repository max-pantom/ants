// One EventSource for the whole app. Components subscribe to what they need.
import type { Message } from "./api";

export type LiveEvent =
  | { type: "message"; thread: string; message: Message }
  | { type: "thread_cleared"; thread: string }
  | { type: "delta"; thread: string; agentId: string; text: string }
  | { type: "busy"; agentId: string; thread: string | null }
  | { type: "agents" }
  | { type: "groups" }
  | { type: "providers" }
  | { type: "reconnected" }
  | { type: "connection"; online: boolean };

type Fn = (e: LiveEvent) => void;
const subs = new Set<Fn>();
let es: EventSource | null = null;
let wasOpen = false;

export function connectLive() {
  if (es) return;
  es = new EventSource("/api/events");
  es.onerror = () => {
    for (const s of subs) s({ type: "connection", online: false });
  };
  es.addEventListener("hello", () => {
    for (const s of subs) s({ type: "connection", online: true });
    // After a drop, anything could have changed. Ask everyone to refetch.
    if (wasOpen) for (const s of subs) s({ type: "reconnected" });
    wasOpen = true;
  });
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as LiveEvent;
      for (const s of subs) s(e);
    } catch {}
  };
}

export function disconnectLive() {
  es?.close();
  es = null;
  wasOpen = false;
}

export function onLive(fn: Fn) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
