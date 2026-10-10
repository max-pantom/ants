// Connectors. An MCP server is an app's own tool surface (GitHub, Linear, a local folder...).
// Each connected server's tools register in the same registry as folder plugins, named
// mcp_<server>_<tool>, so they obey the same per-agent allowlist and the same approval gate.
//
// A tool the server marks read-only runs without asking. Anything else waits for the user's yes.
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSetting, setSetting, addAudit } from "./db.js";
import { readSecret, writeSecret, deleteSecret } from "./secrets.js";
import { registerTool, unregisterPlugin } from "./tools/registry.js";
import { assertOutbound } from "./privacy.js";
import { bus } from "./bus.js";
import { log } from "./log.js";

export interface McpConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  /** Tools the server marks read-only skip the approval card. Everything else always asks. */
  readOnlyWithoutAsking: boolean;
}

/** Values that must never sit in the settings table: env vars for stdio, headers for http. */
interface McpSecret {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpStatus {
  state: "connecting" | "connected" | "error" | "disabled";
  error?: string;
  tools: { name: string; description: string; readOnly: boolean }[];
}

const SETTING = "mcpServers";
const expandHome = (a: string) => (a === "~" || a.startsWith("~/") ? os.homedir() + a.slice(1) : a);
const live = new Map<string, { client: Client; close: () => Promise<void> }>();
const status = new Map<string, McpStatus>();
const CALL_TIMEOUT_MS = 120_000;
const MAX_RESULT = 20_000;

export const listConfigs = () => getSetting<McpConfig[]>(SETTING, []);
const saveConfigs = (c: McpConfig[]) => setSetting(SETTING, c);
const secretName = (id: string) => `mcp-${id}`;
const prefix = (id: string) => `mcp_${id.replace(/-/g, "_")}_`;

export function mcpStatus(id: string): McpStatus {
  return status.get(id) ?? { state: "disabled", tools: [] };
}

export function listConnectors() {
  return listConfigs().map((c) => {
    const s = readSecret<McpSecret>(secretName(c.id));
    return {
      ...c,
      status: mcpStatus(c.id),
      // Names only. Values stay in secrets/.
      envKeys: Object.keys(s?.env ?? {}),
      headerKeys: Object.keys(s?.headers ?? {}),
    };
  });
}

function validate(c: Partial<McpConfig>): McpConfig {
  const name = String(c.name ?? "").trim().slice(0, 40);
  const id = String(c.id ?? name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  if (!name || !id) throw new Error("A connector needs a name.");
  if (c.transport === "stdio") {
    if (!c.command?.trim()) throw new Error("A local connector needs a command, for example npx.");
  } else if (c.transport === "http") {
    if (!/^https?:\/\//.test(c.url ?? "")) throw new Error("A hosted connector needs a URL starting with https://");
  } else throw new Error("Transport must be stdio or http.");
  return {
    id,
    name,
    transport: c.transport,
    command: c.command?.trim(),
    args: (c.args ?? []).map(String),
    url: c.url?.trim(),
    enabled: c.enabled ?? true,
    readOnlyWithoutAsking: c.readOnlyWithoutAsking ?? true,
  };
}

export async function addConnector(input: Partial<McpConfig> & { env?: Record<string, string>; headers?: Record<string, string> }) {
  const cfg = validate(input);
  const all = listConfigs();
  if (all.some((c) => c.id === cfg.id)) throw new Error(`There is already a connector called ${cfg.id}.`);
  const clean = (o?: Record<string, string>) => Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => k.trim() && String(v).length).map(([k, v]) => [k.trim(), String(v)]));
  writeSecret(secretName(cfg.id), { env: clean(input.env), headers: clean(input.headers) } satisfies McpSecret);
  saveConfigs([...all, cfg]);
  void connect(cfg);
  return cfg;
}

export async function removeConnector(id: string) {
  await disconnect(id);
  saveConfigs(listConfigs().filter((c) => c.id !== id));
  deleteSecret(secretName(id));
  status.delete(id);
}

export async function setConnectorEnabled(id: string, enabled: boolean) {
  const all = listConfigs();
  const cfg = all.find((c) => c.id === id);
  if (!cfg) throw new Error("No such connector.");
  cfg.enabled = enabled;
  saveConfigs(all);
  if (enabled) await connect(cfg);
  else {
    await disconnect(id);
    status.set(id, { state: "disabled", tools: [] });
  }
}

export async function reconnectConnector(id: string) {
  const cfg = listConfigs().find((c) => c.id === id);
  if (!cfg) throw new Error("No such connector.");
  await disconnect(id);
  await connect(cfg);
}

export async function initConnectors() {
  for (const c of listConfigs()) {
    if (c.enabled) void connect(c);
    else status.set(c.id, { state: "disabled", tools: [] });
  }
}

export async function shutdownConnectors() {
  await Promise.allSettled([...live.keys()].map(disconnect));
}

async function disconnect(id: string) {
  unregisterPlugin(`mcp:${id}`);
  const l = live.get(id);
  live.delete(id);
  await l?.close().catch(() => {});
}

async function connect(cfg: McpConfig) {
  await disconnect(cfg.id);
  status.set(cfg.id, { state: "connecting", tools: [] });
  bus.send({ type: "providers" });
  const secret = readSecret<McpSecret>(secretName(cfg.id)) ?? {};
  try {
    const transport =
      cfg.transport === "stdio"
        ? // The SDK passes a small safe environment plus only what was declared here.
          new StdioClientTransport({ command: cfg.command!, args: (cfg.args ?? []).map(expandHome), env: secret.env, stderr: "ignore" })
        : (assertOutbound(cfg.url!, { action: `Connect ${cfg.name}` }),
          new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers: secret.headers ?? {} } }));
    const client = new Client({ name: "ants", version: "0.1.0" });
    client.onclose = () => {
      if (live.get(cfg.id)?.client === client) {
        live.delete(cfg.id);
        unregisterPlugin(`mcp:${cfg.id}`);
        status.set(cfg.id, { state: "error", error: "The connection closed.", tools: [] });
        bus.send({ type: "providers" });
      }
    };
    await client.connect(transport, { timeout: 30_000 });
    live.set(cfg.id, { client, close: () => client.close() });

    const listed = await client.listTools(undefined, { timeout: 30_000 });
    const tools: McpStatus["tools"] = [];
    for (const t of listed.tools) {
      const safe = t.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const full = (prefix(cfg.id) + safe).slice(0, 64);
      const readOnly = t.annotations?.readOnlyHint === true;
      registerTool({
        name: full,
        description: `[${cfg.name}] ${t.description ?? t.name}`.slice(0, 1000),
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        gate: !(cfg.readOnlyWithoutAsking && readOnly),
        plugin: `mcp:${cfg.id}`,
        run: (args, ctx) => callTool(cfg, client, t.name, args, ctx),
      });
      tools.push({ name: full, description: t.description ?? "", readOnly });
    }
    status.set(cfg.id, { state: "connected", tools });
    log.info(`connector ${cfg.id}: ${tools.length} tools`);
  } catch (e: any) {
    await disconnect(cfg.id);
    status.set(cfg.id, { state: "error", error: String(e?.message ?? e).slice(0, 300), tools: [] });
    log.warn(`connector ${cfg.id} failed:`, e?.message ?? e);
  }
  bus.send({ type: "providers" });
  bus.send({ type: "agents" });
}

async function callTool(cfg: McpConfig, client: Client, name: string, args: unknown, ctx: { signal: AbortSignal; agent: { id: string; name: string } }) {
  const target = cfg.transport === "http" ? cfg.url! : `${cfg.command} ${(cfg.args ?? []).join(" ")}`.trim();
  const bytes = Buffer.byteLength(JSON.stringify(args ?? {}));
  if (cfg.transport === "http") assertOutbound(cfg.url!, { action: `${cfg.name}: ${name}`, agentId: ctx.agent.id, agentName: ctx.agent.name, bytes });
  let result: any;
  try {
    result = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { signal: ctx.signal, timeout: CALL_TIMEOUT_MS });
  } catch (e) {
    addAudit({ agentId: ctx.agent.id, agentName: ctx.agent.name, kind: "tool", action: `${cfg.id}.${name}`, target, risk: 2, approval: "gate", bytesSent: bytes, status: "error" });
    throw e;
  }
  addAudit({ agentId: ctx.agent.id, agentName: ctx.agent.name, kind: "tool", action: `${cfg.id}.${name}`, target, risk: 2, approval: "gate", bytesSent: bytes, status: result.isError ? "error" : "ok" });
  const parts: string[] = [];
  for (const c of result.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource" && "text" in c.resource) parts.push(String(c.resource.text));
    else parts.push(`[${c.type} content not shown]`);
  }
  let text = parts.join("\n") || (result.structuredContent ? JSON.stringify(result.structuredContent) : "(no output)");
  if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n…(truncated, ${text.length - MAX_RESULT} more characters)`;
  if (result.isError) throw new Error(text);
  return text;
}

/** Starting points for the Add form. Nothing here is installed or contacted until the user adds it. */
export const CONNECTOR_TEMPLATES = [
  { id: "filesystem", name: "Files", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"], env: [], note: "Edit the last argument to the folder to share." },
  { id: "github", name: "GitHub", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: ["Authorization"], note: "Header value: Bearer <a fine-grained personal access token limited to the repos you want>." },
  { id: "linear", name: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", headers: ["Authorization"], note: "Header value: Bearer <your Linear API key>." },
  { id: "custom-stdio", name: "Custom (local command)", transport: "stdio", command: "", args: [], env: [], note: "Any MCP server you run as a command." },
  { id: "custom-http", name: "Custom (hosted URL)", transport: "http", url: "", headers: [], note: "Any MCP server reachable over HTTP." },
] as const;
