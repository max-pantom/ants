export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface Meta {
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  approvalId?: string;
  approval?: { kind: "tool" | "spend"; tool: string; args: string; status: "pending" | "approved" | "denied"; agentName: string };
  from?: { id: string; name: string };
  skill?: string;
  routine?: boolean;
  autonomous?: boolean;
  image?: string;
  screen?: boolean;
  error?: boolean;
  link?: string;
}

export interface Message {
  id: number;
  thread: string;
  agentId: string | null;
  role: "user" | "assistant" | "tool" | "approval" | "event";
  content: string;
  meta: Meta;
  createdAt: number;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  kind: "agent" | "coordinator" | "worker";
  provider: string | null;
  model: string | null;
  avatar: string | null;
  parentThread?: string | null;
  deadline?: number | null;
  tools: string[];
  spendCap: number;
  resolved: { provider: string; model: string } | null;
  busy: string | null;
  screen: boolean;
}

export interface Group {
  id: string;
  name: string;
  members: string[];
}

export interface AppState {
  mode: "local" | "server";
  agents: Agent[];
  workers: Agent[];
  groups: Group[];
  lastIds: Record<string, number>;
  pending: string[];
}

export interface Skill {
  slug: string;
  name: string;
  description: string;
  body: string;
}

export interface AgentDetail {
  agent: Agent;
  memories: { id: number; text: string; createdAt: number }[];
  skills: Skill[];
  routine: { cron: string; skill: string | null; instruction: string; enabled: boolean; lastRunAt: number | null; nextRun: number | null } | null;
  tools: { name: string; description: string; plugin: string; gate: boolean | { when: string } }[];
}

export interface Settings {
  mode: "local" | "server";
  dataDir: string;
  workspace: string;
  providers: {
    openai: { baseUrl: string };
    xai: { baseUrl: string };
    compat: { baseUrl: string; label: string };
    default: { provider: string | null; model: string | null };
  };
  catalog: { id: string; label: string }[];
  keys: Record<string, string | null>;
  presets: { id: string; label: string; baseUrl: string; keyUrl: string }[];
  available: Record<string, boolean>;
  chatgpt: { signedIn: boolean; email?: string; planUsage?: boolean; clientId?: string; hostId: string; importedFromOtherHost?: boolean };
  xai: {
    signedIn: boolean;
    clientIdSet: boolean;
    login: { state: "idle" | "waiting" | "done" | "error"; userCode?: string; url?: string; error?: string };
    rejected: string | null;
  };
  xaiClientId: string | null;
  defaultSpendCap: number;
  privacy: {
    mode: "fully-local" | "self-hosted" | "hybrid";
    encryptionAtRest: boolean;
    telemetry: boolean;
    cloudAccountRequired: boolean;
  };
}

export interface AuditEvent {
  id: number;
  createdAt: number;
  agentName: string | null;
  kind: "model" | "tool" | "outbound";
  action: string;
  target: string;
  risk: number;
  approval: string;
  bytesSent: number;
  status: "ok" | "blocked" | "error";
}

export interface PluginInfo {
  name: string;
  description: string;
  dir: string | null;
  scope: string;
  tools: string[];
  error?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Can't reach the Ants server. Is it still running? Start it with `node bin/ants.js`.", 0);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(j.error ?? res.statusText, res.status);
  return j as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>("POST", p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>("PUT", p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const del = <T = any>(p: string) => api<T>("DELETE", p);

export interface Connector {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  readOnlyWithoutAsking: boolean;
  status: { state: "connecting" | "connected" | "error" | "disabled"; error?: string; tools: { name: string; description: string; readOnly: boolean }[] };
  envKeys: string[];
  headerKeys: string[];
}

export interface ConnectorTemplate {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: readonly string[];
  url?: string;
  env?: readonly string[];
  headers?: readonly string[];
  note: string;
}
