// Responses API client, used by Sign in with ChatGPT. ChatGPT plan usage requires
// store:false and stream:true, so the full input is sent every turn.
import { readSSE, errorText } from "./sse.js";
import { ProviderError, type ChatMsg, type ModelClient, type ModelRequest, type ModelResult } from "./types.js";
import { assertOutbound } from "../privacy.js";

export interface ResponsesOptions {
  baseUrl: string;
  token: () => Promise<string>;
  label: string;
  /** Turns provider error codes into a sentence for the chat. */
  explain?: (status: number, code: string | undefined, message: string) => string | undefined;
}

function toInput(messages: ChatMsg[]) {
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") input.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      if (m.content) input.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.args || "{}" });
    } else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
  }
  return { instructions, input };
}

export class ResponsesClient implements ModelClient {
  constructor(private o: ResponsesOptions) {}

  private fail(status: number, e: { message: string; code?: string }): never {
    const friendly = this.o.explain?.(status, e.code, e.message);
    throw new ProviderError(friendly ?? `${this.o.label} returned ${status}: ${e.message}`, status, e.code);
  }

  async complete(req: ModelRequest): Promise<ModelResult> {
    const { instructions, input } = toInput(req.messages);
    const url = `${this.o.baseUrl}/responses`;
    assertOutbound(url, { action: `${this.o.label} model call` });
    const res = await fetch(url, {
      method: "POST",
      signal: req.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.o.token()}` },
      body: JSON.stringify({
        model: req.model,
        instructions,
        input,
        store: false,
        stream: true,
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })) }
          : {}),
      }),
    });
    if (!res.ok) this.fail(res.status, await errorText(res));

    let text = "";
    const toolCalls: ModelResult["toolCalls"] = [];
    let completed = false;
    for await (const { event, data } of readSSE(res, req.signal)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      const type = ev.type ?? event;
      if (type === "response.output_text.delta") {
        text += ev.delta ?? "";
        req.onText?.(text);
      } else if (type === "response.output_item.done" && ev.item?.type === "function_call") {
        toolCalls.push({ id: ev.item.call_id ?? ev.item.id, name: ev.item.name, args: ev.item.arguments ?? "{}" });
      } else if (type === "response.completed") {
        completed = true;
      } else if (type === "response.failed" || type === "error") {
        const err = ev.response?.error ?? ev.error ?? ev;
        this.fail(400, { message: err.message ?? "response failed", code: err.code });
      } else if (type === "response.incomplete") {
        const why = ev.response?.incomplete_details?.reason;
        if (!text && !toolCalls.length) throw new ProviderError(`${this.o.label}: response incomplete${why ? ` (${why})` : ""}`);
        completed = true;
      }
    }
    if (!completed) throw new ProviderError(`${this.o.label}: stream ended before response.completed`);
    return { text, toolCalls };
  }

  async listModels(): Promise<string[]> {
    const url = `${this.o.baseUrl}/models`;
    assertOutbound(url, { action: `${this.o.label} model list` });
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.o.token()}` } });
    if (!res.ok) this.fail(res.status, await errorText(res));
    const j: any = await res.json();
    return (j.data ?? j.models ?? []).map((m: any) => m.slug ?? m.id).filter(Boolean).sort();
  }
}
