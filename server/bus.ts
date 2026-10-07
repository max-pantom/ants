import { EventEmitter } from "node:events";

// Everything the UI needs to hear about goes through here and out over SSE.
export type BusEvent =
  | { type: "message"; thread: string; message: unknown }
  | { type: "message_deleted"; thread: string; id: number }
  | { type: "thread_cleared"; thread: string }
  | { type: "delta"; thread: string; agentId: string; text: string }
  | { type: "busy"; agentId: string; thread: string | null }
  | { type: "agents" }
  | { type: "groups" }
  | { type: "providers" }
  | { type: "screen_action"; agentId: string; kind: string; x?: number; y?: number; text?: string };

class Bus extends EventEmitter {
  send(e: BusEvent) {
    this.emit("event", e);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
