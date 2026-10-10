// Plugins are folders. A manifest names the plugin and lists its tools as JSON Schema.
// The loader imports the folder and registers only the tools the manifest declares,
// so a plugin cannot reach a tool it did not declare. An agent's allowlist is a subset
// of what is loaded.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent } from "../db.js";
import { log } from "../log.js";

export interface ToolCtx {
  agent: Agent;
  /** The thread this turn runs in. */
  thread: string;
  workspace: string;
  /** Paths no tool may touch (the secrets folder). */
  forbidden: string[];
  signal: AbortSignal;
  log: (...a: unknown[]) => void;
  assertOutbound: (url: string, bytes?: number) => void;
}

export type ToolOutput = string | { text: string; image?: string };

/** `true` always asks. `{ when: "arg" }` asks only when that boolean argument is true. */
export type Gate = boolean | { when: string };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  gate?: Gate;
  plugin: string;
  run(args: any, ctx: ToolCtx): Promise<ToolOutput>;
}

export interface PluginInfo {
  name: string;
  description: string;
  dir: string | null;
  scope: "builtin" | "host" | `agent:${string}`;
  tools: string[];
  error?: string;
}

const hostTools = new Map<string, ToolDef>();
const agentTools = new Map<string, Map<string, ToolDef>>();
const plugins: PluginInfo[] = [];

export function registerTool(t: ToolDef) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw new Error(`bad tool name ${t.name}`);
  hostTools.set(t.name, t);
}

/** Remove every host tool a plugin registered. Used when a connector disconnects. */
export function unregisterPlugin(plugin: string) {
  for (const [k, t] of hostTools) if (t.plugin === plugin) hostTools.delete(k);
}

export function registerCorePlugin(name: string, description: string, tools: Omit<ToolDef, "plugin">[]) {
  for (const t of tools) registerTool({ ...t, plugin: name });
  plugins.push({ name, description, dir: null, scope: "builtin", tools: tools.map((t) => t.name) });
}

interface Manifest {
  name: string;
  description?: string;
  main?: string;
  tools: { name: string; description: string; parameters?: Record<string, unknown>; gate?: Gate }[];
}

async function loadPlugin(dir: string, scope: PluginInfo["scope"]) {
  const manifestPath = path.join(dir, "plugin.json");
  if (!fs.existsSync(manifestPath)) return;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest.name || !/^[a-z0-9-]+$/.test(manifest.name)) throw new Error("manifest needs a lowercase name");
    if (!Array.isArray(manifest.tools)) throw new Error("manifest needs a tools array");
  } catch (e: any) {
    plugins.push({ name: path.basename(dir), description: "", dir, scope, tools: [], error: e.message });
    return;
  }
  const info: PluginInfo = { name: manifest.name, description: manifest.description ?? "", dir, scope, tools: [] };
  plugins.push(info);
  try {
    const entry = path.join(dir, manifest.main ?? "index.mjs");
    const mod = await import(`${pathToFileURL(entry).href}?v=${fs.statSync(entry).mtimeMs}`);
    const impl = mod.tools ?? mod.default?.tools ?? mod.default ?? {};
    const target = scope.startsWith("agent:") ? agentMap(scope.slice(6)) : hostTools;
    for (const t of manifest.tools) {
      const fn = impl[t.name];
      if (typeof fn !== "function") {
        info.error = `${t.name} is declared but not exported`;
        continue;
      }
      const full = `${manifest.name.replace(/-/g, "_")}_${t.name}`;
      target.set(full, {
        name: full,
        description: t.description,
        parameters: t.parameters ?? { type: "object", properties: {} },
        gate: t.gate,
        plugin: manifest.name,
        run: (args, ctx) => fn(args, ctx),
      });
      info.tools.push(full);
    }
  } catch (e: any) {
    info.error = e.message;
    log.warn(`plugin ${manifest.name} failed to load:`, e.message);
  }
}

function agentMap(id: string) {
  let m = agentTools.get(id);
  if (!m) agentTools.set(id, (m = new Map()));
  return m;
}

async function loadDir(root: string, scope: PluginInfo["scope"]) {
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (fs.statSync(dir).isDirectory()) await loadPlugin(dir, scope);
  }
}

export async function loadPlugins(o: { builtinDir: string; hostDir: string; agentsDir: string }) {
  // Drop folder plugins, keep core ones, so a reload picks up edits.
  for (let i = plugins.length - 1; i >= 0; i--) if (plugins[i].dir) plugins.splice(i, 1);
  for (const [k, t] of hostTools) if (!t.plugin.startsWith("mcp:") && !plugins.some((p) => !p.dir && p.name === t.plugin)) hostTools.delete(k);
  agentTools.clear();

  await loadDir(o.builtinDir, "builtin");
  await loadDir(o.hostDir, "host");
  if (fs.existsSync(o.agentsDir)) {
    for (const id of fs.readdirSync(o.agentsDir)) await loadDir(path.join(o.agentsDir, id, "plugins"), `agent:${id}`);
  }
}

export function listPlugins() {
  return plugins;
}

/** Every tool this agent could be given: host tools plus its own installed plugins. */
export function loadedToolsFor(agentId: string): ToolDef[] {
  return [...hostTools.values(), ...(agentTools.get(agentId)?.values() ?? [])];
}

export function allToolNames(): string[] {
  return [...hostTools.keys()];
}

/** The tools an agent can actually call: loaded ∩ allowlist. */
export function toolsFor(agent: Agent): ToolDef[] {
  const allow = new Set(agent.tools);
  return loadedToolsFor(agent.id).filter((t) => allow.has(t.name));
}

export function findTool(agent: Agent, name: string): ToolDef | undefined {
  return toolsFor(agent).find((t) => t.name === name);
}

export function needsApproval(t: ToolDef, args: any): boolean {
  if (!t.gate) return false;
  if (t.gate === true) return true;
  return !!args?.[t.gate.when];
}
