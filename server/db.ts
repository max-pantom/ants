// SQLite is the only database. Messages are scoped by thread, and a thread is
// either one agent's chat ("a:<agentId>") or a group ("g:<groupId>").
// There is no query here that reads another agent's one-to-one transcript.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { redact } from "./secrets.js";
import { bus } from "./bus.js";

let db: DatabaseSync;

export type AgentKind = "agent" | "coordinator" | "worker";

export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  kind: AgentKind;
  provider: string | null;
  model: string | null;
  tools: string[];
  spendCap: number;
  parentThread: string | null;
  deadline: number | null;
  createdAt: number;
}

export type Role = "user" | "assistant" | "tool" | "approval" | "event";

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface MessageMeta {
  toolCalls?: ToolCall[];
  /** The newest message id the model had in front of it when it wrote this reply. */
  seen?: number;
  toolCallId?: string;
  toolName?: string;
  approvalId?: string;
  approval?: { kind: "tool" | "spend"; tool: string; args: string; status: "pending" | "approved" | "denied"; agentName: string };
  /** Set when another agent wrote this message into the thread. */
  from?: { id: string; name: string };
  skill?: string;
  routine?: boolean;
  image?: string;
  screen?: boolean;
  error?: boolean;
  link?: string;
}

export interface Message {
  id: number;
  thread: string;
  agentId: string | null;
  role: Role;
  content: string;
  meta: MessageMeta;
  createdAt: number;
}

export interface Approval {
  id: string;
  agentId: string;
  /** The thread the agent's turn runs in. */
  runThread: string;
  /** The thread where the user sees and answers the question. Differs for spawned workers. */
  thread: string;
  kind: "tool" | "spend";
  toolCallId: string | null;
  tool: string;
  args: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
}

export interface Routine {
  agentId: string;
  cron: string;
  skill: string | null;
  instruction: string;
  enabled: boolean;
  lastRunAt: number | null;
}

export interface Group {
  id: string;
  name: string;
  members: string[];
  createdAt: number;
}

export interface AuditEvent {
  id: number;
  createdAt: number;
  agentId: string | null;
  agentName: string | null;
  kind: "model" | "tool" | "outbound";
  action: string;
  target: string;
  risk: number;
  approval: string;
  bytesSent: number;
  status: "ok" | "blocked" | "error";
}

export function openDb(file: string) {
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'agent',
      provider TEXT,
      model TEXT,
      tools TEXT NOT NULL DEFAULT '[]',
      spend_cap INTEGER NOT NULL DEFAULT 40,
      parent_thread TEXT,
      deadline INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread TEXT NOT NULL,
      agent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, id);
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      run_thread TEXT NOT NULL,
      thread TEXT NOT NULL,
      kind TEXT NOT NULL,
      tool_call_id TEXT,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS routines (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      cron TEXT NOT NULL,
      skill TEXT,
      instruction TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (group_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS usage (
      agent_id TEXT NOT NULL,
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, day, provider)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      risk INTEGER NOT NULL DEFAULT 0,
      approval TEXT NOT NULL DEFAULT 'not-required',
      bytes_sent INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok'
    );
    CREATE INDEX IF NOT EXISTS audit_created ON audit_events(created_at DESC);
  `);
}

export const newId = () => crypto.randomBytes(6).toString("hex");
const now = () => Date.now();

// ---------- settings (non-secret) ----------

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(key: string, value: unknown) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

// ---------- audit ----------

export function addAudit(e: Omit<AuditEvent, "id" | "createdAt">) {
  db.prepare(
    `INSERT INTO audit_events
      (created_at, agent_id, agent_name, kind, action, target, risk, approval, bytes_sent, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(now(), e.agentId, e.agentName, e.kind, redact(e.action), redact(e.target), e.risk, e.approval, e.bytesSent, e.status);
}

export function listAudit(limit = 200): AuditEvent[] {
  return (db.prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(limit, 1000))) as any[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    agentId: r.agent_id,
    agentName: r.agent_name,
    kind: r.kind,
    action: r.action,
    target: r.target,
    risk: r.risk,
    approval: r.approval,
    bytesSent: r.bytes_sent,
    status: r.status,
  }));
}

export function exportPortable() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    agents: db.prepare("SELECT id, name, role, description, kind, provider, model, tools, spend_cap AS spendCap, created_at AS createdAt FROM agents WHERE kind != 'worker' ORDER BY created_at").all(),
    messages: db.prepare("SELECT thread, agent_id AS agentId, role, content, meta, created_at AS createdAt FROM messages ORDER BY id").all(),
    memories: db.prepare("SELECT agent_id AS agentId, text, created_at AS createdAt FROM memories ORDER BY id").all(),
    routines: db.prepare("SELECT agent_id AS agentId, cron, skill, instruction, enabled, last_run_at AS lastRunAt FROM routines").all(),
    groups: listGroups(),
    audit: listAudit(1000),
  };
}

export function wipePrivateData() {
  db.exec(`
    DELETE FROM messages;
    DELETE FROM memories;
    DELETE FROM approvals;
    DELETE FROM routines;
    DELETE FROM group_members;
    DELETE FROM groups;
    DELETE FROM usage;
    DELETE FROM audit_events;
  `);
  bus.send({ type: "agents" });
  bus.send({ type: "groups" });
}

// ---------- agents ----------

function rowToAgent(r: any): Agent {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    description: r.description,
    kind: r.kind,
    provider: r.provider,
    model: r.model,
    tools: JSON.parse(r.tools),
    spendCap: r.spend_cap,
    parentThread: r.parent_thread,
    deadline: r.deadline,
    createdAt: r.created_at,
  };
}

export function listAgents(includeWorkers = false): Agent[] {
  const rows = db
    .prepare(`SELECT * FROM agents ${includeWorkers ? "" : "WHERE kind != 'worker'"} ORDER BY created_at`)
    .all();
  return rows.map(rowToAgent);
}

export function getAgent(id: string): Agent | undefined {
  const r = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  return r ? rowToAgent(r) : undefined;
}

export function findAgentByName(name: string): Agent | undefined {
  const clean = name.replace(/^@/, "").trim().toLowerCase();
  return listAgents().find((a) => a.name.toLowerCase() === clean || a.id === clean);
}

export function createAgent(a: Partial<Agent> & { name: string; role: string }): Agent {
  const id = a.id ?? newId();
  db.prepare(
    `INSERT INTO agents (id, name, role, description, kind, provider, model, tools, spend_cap, parent_thread, deadline, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    a.name,
    a.role,
    a.description ?? "",
    a.kind ?? "agent",
    a.provider ?? null,
    a.model ?? null,
    JSON.stringify(a.tools ?? []),
    a.spendCap ?? 40,
    a.parentThread ?? null,
    a.deadline ?? null,
    now(),
  );
  if (a.kind !== "worker") bus.send({ type: "agents" });
  return getAgent(id)!;
}

export function updateAgent(id: string, patch: Partial<Agent>) {
  const cur = getAgent(id);
  if (!cur) throw new Error("no such agent");
  const next = { ...cur, ...patch };
  db.prepare(
    `UPDATE agents SET name = ?, role = ?, description = ?, provider = ?, model = ?, tools = ?, spend_cap = ? WHERE id = ?`,
  ).run(next.name, next.role, next.description, next.provider, next.model, JSON.stringify(next.tools), next.spendCap, id);
  bus.send({ type: "agents" });
  return getAgent(id)!;
}

export function deleteAgent(id: string) {
  const a = getAgent(id);
  db.prepare("DELETE FROM messages WHERE thread = ?").run(`a:${id}`);
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  if (a?.kind !== "worker") bus.send({ type: "agents" });
}

export function expiredWorkers(): Agent[] {
  return db
    .prepare("SELECT * FROM agents WHERE kind = 'worker' AND deadline IS NOT NULL AND deadline < ?")
    .all(now())
    .map(rowToAgent);
}

// ---------- messages ----------

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    thread: r.thread,
    agentId: r.agent_id,
    role: r.role,
    content: r.content,
    meta: JSON.parse(r.meta),
    createdAt: r.created_at,
  };
}

/** Every insert is redacted. This is the one door into the transcript. */
export function insertMessage(m: { thread: string; agentId: string | null; role: Role; content: string; meta?: MessageMeta }): Message {
  const content = redact(m.content);
  const meta = redact(JSON.stringify(m.meta ?? {}));
  const r = db
    .prepare("INSERT INTO messages (thread, agent_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(m.thread, m.agentId, m.role, content, meta, now());
  const msg = getMessage(Number(r.lastInsertRowid))!;
  bus.send({ type: "message", thread: m.thread, message: msg });
  return msg;
}

export function updateMessageMeta(id: number, patch: Partial<MessageMeta>) {
  const m = getMessage(id);
  if (!m) return;
  db.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(redact(JSON.stringify({ ...m.meta, ...patch })), id);
  bus.send({ type: "message", thread: m.thread, message: getMessage(id) });
}

export function approvalMessage(approvalId: string): Message | undefined {
  const r = db.prepare("SELECT * FROM messages WHERE role = 'approval' AND json_extract(meta, '$.approvalId') = ?").get(approvalId);
  return r ? rowToMessage(r) : undefined;
}

export function getMessage(id: number): Message | undefined {
  const r = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  return r ? rowToMessage(r) : undefined;
}

export function threadMessages(thread: string, limit = 200, beforeId?: number): Message[] {
  const rows = beforeId
    ? db.prepare("SELECT * FROM messages WHERE thread = ? AND id < ? ORDER BY id DESC LIMIT ?").all(thread, beforeId, limit)
    : db.prepare("SELECT * FROM messages WHERE thread = ? ORDER BY id DESC LIMIT ?").all(thread, limit);
  return rows.map(rowToMessage).reverse();
}

export function clearThread(thread: string) {
  db.prepare("DELETE FROM messages WHERE thread = ?").run(thread);
  db.prepare("DELETE FROM approvals WHERE thread = ? OR run_thread = ?").run(thread, thread);
  bus.send({ type: "thread_cleared", thread });
}

export function lastMessageIds(): Record<string, number> {
  const rows = db.prepare("SELECT thread, MAX(id) AS id FROM messages GROUP BY thread").all() as any[];
  return Object.fromEntries(rows.map((r) => [r.thread, r.id]));
}

// ---------- memories ----------

export function listMemories(agentId: string) {
  return db.prepare("SELECT id, text, created_at AS createdAt FROM memories WHERE agent_id = ? ORDER BY id").all(agentId) as {
    id: number;
    text: string;
    createdAt: number;
  }[];
}

export function addMemory(agentId: string, text: string) {
  const r = db.prepare("INSERT INTO memories (agent_id, text, created_at) VALUES (?, ?, ?)").run(agentId, redact(text), now());
  return Number(r.lastInsertRowid);
}

export function deleteMemory(agentId: string, id: number) {
  return db.prepare("DELETE FROM memories WHERE agent_id = ? AND id = ?").run(agentId, id).changes > 0;
}

// ---------- approvals ----------

function rowToApproval(r: any): Approval {
  return {
    id: r.id,
    agentId: r.agent_id,
    runThread: r.run_thread,
    thread: r.thread,
    kind: r.kind,
    toolCallId: r.tool_call_id,
    tool: r.tool,
    args: r.args,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function createApproval(a: Omit<Approval, "id" | "status" | "createdAt">): Approval {
  const id = newId();
  db.prepare(
    `INSERT INTO approvals (id, agent_id, run_thread, thread, kind, tool_call_id, tool, args, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, a.agentId, a.runThread, a.thread, a.kind, a.toolCallId, a.tool, redact(a.args), now());
  return getApproval(id)!;
}

export function getApproval(id: string): Approval | undefined {
  const r = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
  return r ? rowToApproval(r) : undefined;
}

export function approvalForCall(toolCallId: string): Approval | undefined {
  const r = db.prepare("SELECT * FROM approvals WHERE tool_call_id = ? ORDER BY created_at DESC LIMIT 1").get(toolCallId);
  return r ? rowToApproval(r) : undefined;
}

export function pendingApprovals(where: { thread?: string; agentId?: string; runThread?: string }): Approval[] {
  const clauses = ["status = 'pending'"];
  const vals: string[] = [];
  if (where.thread) (clauses.push("thread = ?"), vals.push(where.thread));
  if (where.agentId) (clauses.push("agent_id = ?"), vals.push(where.agentId));
  if (where.runThread) (clauses.push("run_thread = ?"), vals.push(where.runThread));
  return db.prepare(`SELECT * FROM approvals WHERE ${clauses.join(" AND ")} ORDER BY created_at`).all(...vals).map(rowToApproval);
}

export function resolveApproval(id: string, status: "approved" | "denied") {
  db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(status, now(), id);
}

// ---------- routines ----------

function rowToRoutine(r: any): Routine {
  return { agentId: r.agent_id, cron: r.cron, skill: r.skill, instruction: r.instruction, enabled: !!r.enabled, lastRunAt: r.last_run_at };
}

export function getRoutine(agentId: string): Routine | undefined {
  const r = db.prepare("SELECT * FROM routines WHERE agent_id = ?").get(agentId);
  return r ? rowToRoutine(r) : undefined;
}

export function listRoutines(): Routine[] {
  return db.prepare("SELECT * FROM routines").all().map(rowToRoutine);
}

export function setRoutine(r: Omit<Routine, "lastRunAt">) {
  db.prepare(
    `INSERT INTO routines (agent_id, cron, skill, instruction, enabled) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET cron = excluded.cron, skill = excluded.skill, instruction = excluded.instruction, enabled = excluded.enabled`,
  ).run(r.agentId, r.cron, r.skill, r.instruction, r.enabled ? 1 : 0);
}

export function deleteRoutine(agentId: string) {
  db.prepare("DELETE FROM routines WHERE agent_id = ?").run(agentId);
}

export function markRoutineRun(agentId: string) {
  db.prepare("UPDATE routines SET last_run_at = ? WHERE agent_id = ?").run(now(), agentId);
}

// ---------- groups ----------

export function listGroups(): Group[] {
  const groups = db.prepare("SELECT * FROM groups ORDER BY created_at").all() as any[];
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.created_at,
    members: (db.prepare("SELECT agent_id FROM group_members WHERE group_id = ? ORDER BY position").all(g.id) as any[]).map(
      (m) => m.agent_id,
    ),
  }));
}

export function getGroup(id: string) {
  return listGroups().find((g) => g.id === id);
}

export function createGroup(name: string, members: string[]): Group {
  const id = newId();
  db.prepare("INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now());
  members.forEach((m, i) => db.prepare("INSERT INTO group_members (group_id, agent_id, position) VALUES (?, ?, ?)").run(id, m, i));
  bus.send({ type: "groups" });
  return getGroup(id)!;
}

export function updateGroup(id: string, name: string, members: string[]) {
  db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(name, id);
  db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
  members.forEach((m, i) => db.prepare("INSERT INTO group_members (group_id, agent_id, position) VALUES (?, ?, ?)").run(id, m, i));
  bus.send({ type: "groups" });
}

export function deleteGroup(id: string) {
  db.prepare("DELETE FROM messages WHERE thread = ?").run(`g:${id}`);
  db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  bus.send({ type: "groups" });
}

// ---------- usage ----------

const today = () => new Date().toISOString().slice(0, 10);

export function bumpUsage(agentId: string, provider: string) {
  db.prepare(
    `INSERT INTO usage (agent_id, day, provider, calls) VALUES (?, ?, ?, 1)
     ON CONFLICT(agent_id, day, provider) DO UPDATE SET calls = calls + 1`,
  ).run(agentId, today(), provider);
}

export function usageToday(agentId: string, provider: string): number {
  const r = db.prepare("SELECT calls FROM usage WHERE agent_id = ? AND day = ? AND provider = ?").get(agentId, today(), provider) as
    | { calls: number }
    | undefined;
  return r?.calls ?? 0;
}
