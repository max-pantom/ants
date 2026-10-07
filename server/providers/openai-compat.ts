// One client for OpenAI, xAI, and any OpenAI-compatible base URL.
// Pointing it at http://127.0.0.1:11434/v1 is the local-model path. There is no fourth provider.
import { readSSE, errorText } from "./sse.js";
import { ProviderError, type ChatMsg, type ModelClient, type ModelRequest, type ModelResult } from "./types.js";
import { assertOutbound } from "../privacy.js";

export interface CompatOptions {
  baseUrl: string;
  /** Called per request so a refreshed token is always used. */
  token: () => Promise<string | undefined>;
  label: string;
}

function toWire(messages: ChatMsg[]) {
  return messages.map((m) => {
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: m.content || (m.toolCalls?.length ? null : ""),
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) }
          : {}),
      };
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    return { role: m.role, content: m.content };
  });
}

export class CompatClient implements ModelClient {
  constructor(private o: CompatOptions) {}

  private async headers() {
    const h: Record<string, string> = { "content-type": "application/json" };
    const t = await this.o.token();
    if (t) h.authorization = `Bearer ${t}`;
    return h;
  }

  async complete(req: ModelRequest): Promise<ModelResult> {
    const url = `${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`;
    assertOutbound(url, { action: `${this.o.label} model call` });
    const res = await fetch(url, {
      method: "POST",
      headers: await this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: toWire(req.messages),
        stream: true,
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
      }),
    }).catch((e) => {
      if (e?.name === "AbortError") throw e;
      throw new ProviderError(`${this.o.label}: could not reach ${this.o.baseUrl} (${e?.cause?.code ?? e?.message})`);
    });
    if (!res.ok) {
      const e = await errorText(res);
      throw new ProviderError(`${this.o.label} returned ${res.status}: ${e.message}`, res.status, e.code);
    }

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const { data } of readSSE(res, req.signal)) {
      if (data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(`${this.o.label}: ${chunk.error.message ?? "stream error"}`);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        req.onText?.(text);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(i, cur);
      }
    }
    const toolCalls = [...calls.values()].map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
    return { text, toolCalls };
  }

  async listModels(): Promise<string[]> {
    const url = `${this.o.baseUrl.replace(/\/$/, "")}/models`;
    assertOutbound(url, { action: `${this.o.label} model list` });
    const res = await fetch(url, { headers: await this.headers() });
    if (!res.ok) {
      const e = await errorText(res);
      throw new ProviderError(`${this.o.label} returned ${res.status}: ${e.message}`, res.status, e.code);
    }
    const j: any = await res.json();
    return (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name ?? m.slug).filter(Boolean).sort();
  }
}
