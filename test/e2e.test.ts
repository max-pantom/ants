// End to end: a real Ants process against a scripted model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startMockModel, LEAKY_KEY, type Captured } from "./mock-model.ts";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
const PORT = await freePort();
const MOCK_PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
let logs = "";
let cookie = "";
let dataDir = "";
let mock: { captured: Captured[]; close: () => void };

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${j.error ?? ""}`);
  return j;
}

async function waitFor<T>(f: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages`)).messages as any[];
const lastAssistant = (msgs: any[]) => [...msgs].reverse().find((m) => m.role === "assistant" && !m.meta.toolCalls?.length);

async function say(thread: string, text: string, expect: (m: any) => boolean = () => true) {
  const sent = await api("POST", `/api/threads/${thread}/messages`, { text });
  try {
    return await waitFor(async () => (await messages(thread)).find((m) => m.id > sent.id && m.role === "assistant" && !m.meta.toolCalls?.length && expect(m)));
  } catch (e) {
    const recent = (await messages(thread)).slice(-8).map((m) => `${m.id} ${m.role} ${m.content.slice(0, 100)} ${JSON.stringify(m.meta).slice(0, 160)}`);
    throw new Error(`no reply to "${text}" in ${thread}:\n${recent.join("\n")}\n--- logs ---\n${logs.slice(-1500)}`);
  }
}

const agents = async () => (await api("GET", "/api/state")).agents as any[];
const byName = async (n: string) => (await agents()).find((a) => a.name === n);

before(async () => {
  mock = await startMockModel(MOCK_PORT);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ants-e2e-"));
  proc = spawn(process.execPath, ["--import", "tsx", "server/main.ts", "--data", dataDir, "--port", String(PORT), "--no-open"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env },
  });
  proc.stdout!.on("data", (d) => (logs += d));
  proc.stderr!.on("data", (d) => (logs += d));
  const token = await waitFor(async () => /\?t=([\w-]+)/.exec(logs)?.[1], 15000);
  const res = await fetch(`${base}/api/session/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0];
  await api("PUT", "/api/settings/providers", {
    compat: { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, label: "Mock" },
    default: { provider: "compat", model: "mock-1" },
  });
  await api("PUT", "/api/keys/compat", { key: LEAKY_KEY });
});

after(() => {
  proc?.kill();
  mock?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("refuses without a session and from a foreign Host", async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  // fetch() won't send a custom Host, so use http.request for the rebinding check.
  const status = await new Promise<number>((resolve) =>
    http.get({ host: "127.0.0.1", port: PORT, path: "/api/state", headers: { cookie, host: "evil.example" } }, (r) => resolve(r.statusCode!)),
  );
  assert.equal(status, 403);
});

test("first run has one agent with a greeting", async () => {
  const list = await agents();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Ada");
  const msgs = await messages(`a:${list[0].id}`);
  assert.match(msgs[0].content, /Hi, I'm Ada/);
});

test("two agents chat separately, share files, never see each other's transcript", async () => {
  await api("POST", "/api/agents", { name: "Bea", role: "Researcher." });
  const ada = await byName("Ada");
  const bea = await byName("Bea");

  const r1 = await say(`a:${ada.id}`, "hello there");
  assert.equal(r1.content, "Ada heard: hello there");
  const r2 = await say(`a:${bea.id}`, "hi bea");
  assert.equal(r2.content, "Bea heard: hi bea");

  await say(`a:${ada.id}`, "please write the file", (m) => /Ada got/.test(m.content));
  const r3 = await say(`a:${bea.id}`, "please read the file", (m) => /Bea got/.test(m.content));
  assert.match(r3.content, /written by Ada/);

  const beaPrompts = mock.captured.filter((c) => c.system.startsWith("You are Bea."));
  assert.ok(beaPrompts.length > 0);
  for (const c of beaPrompts) assert.ok(!JSON.stringify(c.messages).includes("hello there"), "Bea saw Ada's chat");
});

test("secrets never reach the transcript or the logs", async () => {
  const ada = await byName("Ada");
  const r = await say(`a:${ada.id}`, "echo the key");
  assert.match(r.content, /\[redacted\]/);
  const raw = JSON.stringify(await messages(`a:${ada.id}`));
  assert.ok(!raw.includes(LEAKY_KEY));
  assert.ok(!logs.includes(LEAKY_KEY));
  const settings = await api("GET", "/api/settings");
  assert.ok(!JSON.stringify(settings).includes(LEAKY_KEY));
});

test("fully-local mode blocks public endpoints and records the decision", async () => {
  const settings = await api("GET", "/api/settings");
  assert.equal(settings.privacy.mode, "fully-local");
  await api("PUT", "/api/settings/providers", { compat: { baseUrl: "https://example.com/v1", label: "Blocked" } });
  const res = await fetch(`${base}/api/providers/compat/models`, { headers: { cookie } });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /Privacy mode fully-local blocks public-network requests/);
  const audit = await api("GET", "/api/audit");
  assert.ok(audit.events.some((e: any) => e.kind === "outbound" && e.status === "blocked" && /example\.com/.test(e.target)));
  await api("PUT", "/api/settings/providers", { compat: { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, label: "Mock" } });
});

test("portable export excludes secrets", async () => {
  const res = await fetch(`${base}/api/export`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /ants-export/);
  const raw = await res.text();
  assert.ok(!raw.includes(LEAKY_KEY));
  assert.match(raw, /Secrets are deliberately excluded/);
});

test("a gated tool waits for yes, and no means no", async () => {
  const ada = await byName("Ada");
  const t = `a:${ada.id}`;
  const file = path.join(dataDir, "workspace", "shared.txt");
  assert.ok(fs.existsSync(file));

  await api("POST", `/api/threads/${t}/messages`, { text: "delete the file" });
  const ap = await waitFor(async () => (await messages(t)).find((m) => m.role === "approval" && m.meta.approval.status === "pending"));
  assert.ok(fs.existsSync(file), "deleted before approval");
  await api("POST", `/api/approvals/${ap.meta.approvalId}`, { decision: "approved" });
  await waitFor(async () => !fs.existsSync(file));

  await say(t, "write the file", (m) => /Ada got: Wrote/.test(m.content));
  await api("POST", `/api/threads/${t}/messages`, { text: "delete the file" });
  await waitFor(async () => (await messages(t)).find((m) => m.role === "approval" && m.meta.approval.status === "pending"));
  await say(t, "no");
  assert.ok(fs.existsSync(file), "deleted after a no");
  assert.match(JSON.stringify(mock.captured[mock.captured.length - 1].messages), /The user declined this action/);
});

test("a message sent mid-turn is answered, not swallowed", async () => {
  const bea = await byName("Bea");
  const t = `a:${bea.id}`;
  await api("POST", `/api/threads/${t}/messages`, { text: "first" });
  await api("POST", `/api/threads/${t}/messages`, { text: "second" });
  await waitFor(async () => (await messages(t)).find((m) => m.role === "assistant" && m.content === "Bea heard: second"));
});

test("memory is per agent", async () => {
  const ada = await byName("Ada");
  const bea = await byName("Bea");
  await say(`a:${ada.id}`, "remember the user likes tea", (m) => /Ada got/.test(m.content));
  const d = await api("GET", `/api/agents/${ada.id}/detail`);
  assert.deepEqual(d.memories.map((m: any) => m.text), ["the user likes tea"]);
  assert.equal((await api("GET", `/api/agents/${bea.id}/detail`)).memories.length, 0);
});

test("coordinator hands off and spawns a worker that leaves no transcript", async () => {
  await api("POST", "/api/agents", { name: "Cora", role: "Routes work.", kind: "coordinator" });
  const cora = await byName("Cora");
  const bea = await byName("Bea");
  assert.ok(!cora.tools.includes("shell_run"));

  await say(`a:${cora.id}`, "hand to Bea: check the news", (m) => /Cora got/.test(m.content));
  await waitFor(async () => (await messages(`a:${bea.id}`)).find((m) => m.role === "assistant" && /Bea heard: \[Cora\]: check the news/.test(m.content)));
  await waitFor(async () => (await messages(`a:${cora.id}`)).find((m) => m.meta.from?.name === "Bea"));

  const before = (await api("GET", "/api/state")).agents.length;
  await say(`a:${cora.id}`, "spawn a worker", (m) => /worker-\w+ heard/.test(m.content));
  const msgs = await messages(`a:${cora.id}`);
  assert.ok(msgs.some((m) => m.meta.from?.name?.startsWith("worker-")), "worker result posted");
  assert.equal((await api("GET", "/api/state")).agents.length, before);
});

test("plugins: example loads, undeclared exports are unreachable", async () => {
  const { plugins } = await api("GET", "/api/plugins");
  const hello = plugins.find((p: any) => p.name === "hello");
  assert.deepEqual(hello.tools, ["hello_greet", "hello_roll"]);

  const ada = await byName("Ada");
  await api("PATCH", `/api/agents/${ada.id}`, { tools: [...ada.tools, "hello_greet", "hello_secret"] });
  const updated = await byName("Ada");
  assert.ok(updated.tools.includes("hello_greet"));
  assert.ok(!updated.tools.includes("hello_secret"));
  const r = await say(`a:${ada.id}`, "greet someone", (m) => /Ada got/.test(m.content));
  assert.match(r.content, /Hello, tester/);
  const r2 = await say(`a:${ada.id}`, "call secret", (m) => /Ada got/.test(m.content));
  assert.match(r2.content, /not on your allowlist/);
});

test("a group thread routes by mention and does not touch one-to-one chats", async () => {
  const ada = await byName("Ada");
  const bea = await byName("Bea");
  const adaBefore = (await messages(`a:${ada.id}`)).length;
  const g = await api("POST", "/api/groups", { name: "Desk", members: [ada.id, bea.id] });
  const r = await say(`g:${g.id}`, "@Bea what's up");
  assert.match(r.content, /^Bea heard: \[User\]: @Bea what's up/);
  const r2 = await say(`g:${g.id}`, "anyone?", (m) => m.agentId === ada.id);
  assert.match(r2.content, /^Ada heard/);
  assert.equal((await messages(`a:${ada.id}`)).length, adaBefore);
});

test("skills save, run by /name, and copy with the template but memory does not", async () => {
  const ada = await byName("Ada");
  await say(`a:${ada.id}`, "save a skill", (m) => /Ada got/.test(m.content));
  await say(`a:${ada.id}`, "/daily-check now");
  const last = mock.captured[mock.captured.length - 1];
  assert.match(JSON.stringify(last.messages), /read shared.txt/);

  const copy = await api("POST", `/api/agents/${ada.id}/copy`, {});
  const d = await api("GET", `/api/agents/${copy.id}/detail`);
  assert.deepEqual(d.skills.map((s: any) => s.slug), ["daily-check"]);
  assert.equal(d.memories.length, 0);
  assert.equal((await messages(`a:${copy.id}`)).length, 0);
});

test("an MCP connector's tools register, read-only runs, the rest asks, secrets stay out of settings", async () => {
  const fake = path.resolve(import.meta.dirname, "fake-mcp.ts");
  await api("POST", "/api/connectors", {
    name: "Fake",
    transport: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", fake],
    env: { FAKE_TOKEN: "tok-MCP-SECRET-98765" },
  });
  const conn = await waitFor(async () => {
    const c = (await api("GET", "/api/connectors")).connectors.find((x: any) => x.id === "fake");
    return c?.status.state === "connected" ? c : c?.status.state === "error" ? Promise.reject(new Error(c.status.error)) : false;
  }, 20000);
  assert.deepEqual(conn.status.tools.map((t: any) => [t.name, t.readOnly]).sort(), [["mcp_fake_echo", true], ["mcp_fake_send", false]]);
  assert.deepEqual(conn.envKeys, ["FAKE_TOKEN"]);
  assert.ok(!JSON.stringify(await api("GET", "/api/connectors")).includes("tok-MCP-SECRET-98765"), "connector secret leaked to the API");

  const ada = await byName("Ada");
  const t = `a:${ada.id}`;
  await api("PATCH", `/api/agents/${ada.id}`, { tools: [...ada.tools, "mcp_fake_echo", "mcp_fake_send"] });

  await say(t, "mcp echo hi", (m) => /Ada got: echo:hi/.test(m.content));

  await api("POST", `/api/threads/${t}/messages`, { text: "mcp send bob" });
  const ap = await waitFor(async () => (await messages(t)).find((m) => m.role === "approval" && m.meta.approval.status === "pending" && /mcp_fake_send/.test(m.meta.approval.tool)));
  await api("POST", `/api/approvals/${ap.meta.approvalId}`, { decision: "approved" });
  const done = await waitFor(async () => (await messages(t)).find((m) => m.role === "assistant" && /sent to bob/.test(m.content)));
  assert.ok(!done.content.includes("tok-MCP-SECRET-98765"), "secret reached the transcript");
  assert.match(done.content, /\[redacted\]/);

  await api("DELETE", "/api/connectors/fake");
  assert.deepEqual((await api("GET", "/api/connectors")).connectors, []);
});

test("/auto keeps an agent working across turns until it finishes, and /auto stop ends a run", async () => {
  const bea = await byName("Bea");
  const t = `a:${bea.id}`;
  await api("POST", `/api/threads/${t}/messages`, { text: "/auto two steps please" });
  const end = await waitFor(async () => (await messages(t)).find((m) => m.role === "event" && /finished the goal: all done/.test(m.content)), 15000);
  assert.ok(end);
  const msgs = await messages(t);
  assert.ok(msgs.some((m) => m.role === "user" && m.meta.autonomous && /^Goal: two steps please/.test(m.content)));
  assert.ok(msgs.some((m) => m.role === "user" && m.meta.autonomous && /^Keep going/.test(m.content)));
  assert.ok(((await agents()).find((a) => a.name === "Bea")).tools.includes("goal_finish"));

  await api("POST", `/api/threads/${t}/messages`, { text: "/auto stop" });
  await waitFor(async () => (await messages(t)).find((m) => m.role === "event" && /isn't running a goal/.test(m.content)));
});

test("agent pictures: a built-in ant, a rejected bad value, and an uploaded image", async () => {
  const bea = await byName("Bea");
  assert.equal(bea.avatar, null);
  const set = await api("PATCH", `/api/agents/${bea.id}`, { avatar: "ant:green:#ffeedd" });
  assert.equal(set.avatar, "ant:green:#ffeedd");
  await assert.rejects(api("PATCH", `/api/agents/${bea.id}`, { avatar: "ant:pink" }), /400/);
  await assert.rejects(api("PATCH", `/api/agents/${bea.id}`, { avatar: "img:123" }), /400/, "img: needs an upload first");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const bad = await fetch(`${base}/api/agents/${bea.id}/avatar`, { method: "PUT", headers: { cookie, "content-type": "text/html" }, body: "<script>" });
  assert.equal(bad.status, 400);
  const up = await fetch(`${base}/api/agents/${bea.id}/avatar`, { method: "PUT", headers: { cookie, "content-type": "image/png" }, body: png });
  assert.equal(up.status, 200);
  assert.match((await up.json() as any).avatar, /^img:\d+$/);
  const got = await fetch(`${base}/api/agents/${bea.id}/avatar`, { headers: { cookie } });
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
  await api("PATCH", `/api/agents/${bea.id}`, { avatar: null });
});

test("agent_create asks first, then adds a permanent agent to the list; spawn workers do not appear there", async () => {
  const ada = await byName("Ada");
  const t = `a:${ada.id}`;
  await api("PATCH", `/api/agents/${ada.id}`, { tools: [...new Set([...ada.tools, "agent_create"])] });
  await api("POST", `/api/threads/${t}/messages`, { text: "create agent Zed" });
  const ap = await waitFor(async () => (await messages(t)).find((m) => m.role === "approval" && m.meta.approval.status === "pending" && m.meta.approval.tool === "agent_create"));
  assert.ok(!(await agents()).some((a) => a.name === "Zed"), "created before approval");
  await api("POST", `/api/approvals/${ap.meta.approvalId}`, { decision: "approved" });
  const zed = await waitFor(async () => (await agents()).find((a) => a.name === "Zed"));
  assert.equal(zed.kind, "agent");
  assert.ok(zed.tools.includes("files_read"));
  assert.ok(!zed.tools.includes("spawn") && !zed.tools.includes("agent_create"));
  assert.equal(((await api("GET", "/api/state")).workers as any[]).length, 0);
});
