// A scripted OpenAI-compatible model, so the loop can be tested without a key.
// It reads the last message and decides: text, or a tool call.
import http from "node:http";

export const LEAKY_KEY = "sk-test-SECRET-abcdef123456";

export interface Captured {
  system: string;
  messages: any[];
  tools: string[];
}

export function startMockModel(port: number) {
  const captured: Captured[] = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "mock-1" }, { id: "mock-2" }] }));
    }
    let body = "";
    for await (const c of req) body += c;
    const j = JSON.parse(body);
    const msgs = j.messages as any[];
    const system = msgs[0]?.content ?? "";
    captured.push({ system, messages: msgs, tools: (j.tools ?? []).map((t: any) => t.function.name) });
    const last = msgs[msgs.length - 1];
    const me = /You are ([^.]+)\./.exec(system)?.[1] ?? "?";

    const call = (name: string, args: unknown) => ({ tool: { id: `call_${++n}`, name, args: JSON.stringify(args) } });
    let out: { text?: string; tool?: { id: string; name: string; args: string } };
    if (last.role === "tool") out = { text: `${me} got: ${String(last.content).slice(0, 120)}` };
    else {
      const t = String(last.content);
      if (/echo the key/.test(t)) out = { text: `here it is: ${LEAKY_KEY} ok` };
      else if (/write the file/.test(t)) out = call("files_write", { path: "shared.txt", content: `written by ${me}` });
      else if (/read the file/.test(t)) out = call("files_read", { path: "shared.txt" });
      else if (/delete the file/.test(t)) out = call("files_delete", { path: "shared.txt" });
      else if (/remember (.+)/.test(t)) out = call("memory_add", { note: /remember (.+)/.exec(t)![1] });
      else if (/hand to (\w+): (.+)/.test(t)) {
        const m = /hand to (\w+): (.+)/.exec(t)!;
        out = call("handoff", { agent: m[1], task: m[2] });
      } else if (/spawn a worker/.test(t)) out = call("spawn", { task: "list the workspace", tools: ["files_list"], minutes: 2 });
      else if (/save a skill/.test(t)) out = call("skill_save", { name: "daily check", description: "Check the shared file", steps: "1. read shared.txt" });
      else if (/open (\S+) on screen/.test(t)) out = call("screen_open", { url: /open (\S+) on screen/.exec(t)![1] });
      else if (/click (.+) on screen/.test(t)) out = call("screen_click", { text: /click (.+) on screen/.exec(t)![1] });
      else if (/take a screenshot/.test(t)) out = call("screen_capture", {});
      else if (/greet/.test(t)) out = call("hello_greet", { name: "tester" });
      else if (/call secret/.test(t)) out = call("hello_secret", {});
      else out = { text: `${me} heard: ${t.slice(0, 200)}` };
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    if (out.text) {
      // Split the text so a key straddles two deltas.
      const mid = Math.floor(out.text.length / 2);
      send({ choices: [{ delta: { content: out.text.slice(0, mid) } }] });
      send({ choices: [{ delta: { content: out.text.slice(mid) } }] });
    }
    if (out.tool) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: out.tool.id, function: { name: out.tool.name, arguments: "" } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: out.tool.args } }] } }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise<{ captured: Captured[]; close: () => void }>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ captured, close: () => server.close() })),
  );
}
