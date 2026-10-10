// The loop is the product. It stays here, in plain sight:
//
//   1. Append the user message.
//   2. Build the prompt from this agent's role, memory, and transcript.
//   3. Call the model with only this agent's tool allowlist.
//   4. If the model calls a tool, run the gate, then the tool, then append the result.
//   5. Repeat until it returns text. Stream that text into the chat.
//
// A gated tool inserts an approval message and the turn stops. Nothing waits in memory:
// when the chat receives yes, the turn runs again and picks up the call where it stopped.
import {
  type Agent,
  type Message,
  type ToolCall,
  getAgent,
  getGroup,
  insertMessage,
  threadMessages,
  listAgents,
  listMemories,
  createApproval,
  approvalForCall,
  pendingApprovals,
  resolveApproval,
  getApproval,
  approvalMessage,
  updateMessageMeta,
  bumpUsage,
  usageToday,
  deleteAgent,
  expiredWorkers,
  findAgentByName,
  addAudit,
} from "./db.js";
import { clientFor, resolveModel, ProviderError, type ChatMsg } from "./providers/index.js";
import { toolsFor, findTool, needsApproval, type ToolCtx } from "./tools/registry.js";
import { listSkills, getSkill } from "./skills.js";
import { redactStreaming } from "./secrets.js";
import { bus } from "./bus.js";
import { log } from "./log.js";
import { assertOutbound } from "./privacy.js";
import { cancelGoal, goalFor, handleAutoCommand, resumeGoal } from "./autonomy.js";

const MAX_STEPS = 30;

export type TurnResult = { status: "done"; text: string } | { status: "paused" } | { status: "error"; message: string } | { status: "stopped" };

let env = { workspace: "", forbidden: [] as string[] };
export function initLoop(o: { workspace: string; forbidden: string[] }) {
  env = o;
  setInterval(sweepWorkers, 15_000).unref();
}

// ---------- threads ----------

export const isGroupThread = (t: string) => t.startsWith("g:");
export const agentThread = (id: string) => `a:${id}`;

/** Where the user sees an agent's questions. A spawned worker asks in its parent's chat. */
function displayThread(agent: Agent, runThread: string) {
  return agent.kind === "worker" && agent.parentThread ? agent.parentThread : runThread;
}

// ---------- one turn at a time per agent ----------

const queues = new Map<string, Promise<unknown>>();
const aborts = new Map<string, AbortController>();
const busy = new Map<string, string>();

export function busyAgents() {
  return Object.fromEntries(busy);
}

export function runTurn(agentId: string, thread: string): Promise<TurnResult> {
  const prev = queues.get(agentId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => guardedTurn(agentId, thread));
  queues.set(agentId, next);
  void next.finally(() => {
    if (queues.get(agentId) === next) queues.delete(agentId);
  });
  return next;
}

export function stopAgent(agentId: string) {
  cancelGoal(agentId);
  aborts.get(agentId)?.abort();
}

async function guardedTurn(agentId: string, thread: string): Promise<TurnResult> {
  const agent = getAgent(agentId);
  if (!agent) return { status: "error", message: "agent is gone" };
  const ac = new AbortController();
  aborts.set(agentId, ac);
  busy.set(agentId, thread);
  bus.send({ type: "busy", agentId, thread });
  let result: TurnResult;
  try {
    result = await turn(agent, thread, ac.signal);
  } catch (e: any) {
    if (e?.name === "AbortError" || ac.signal.aborted) {
      insertMessage({ thread: displayThread(agent, thread), agentId, role: "event", content: `${agent.name} stopped.` });
      result = { status: "stopped" };
    } else {
      log.error(`turn failed for ${agent.name}:`, e);
      const message = e instanceof ProviderError ? e.message : `Something went wrong: ${e?.message ?? e}`;
      insertMessage({ thread: displayThread(agent, thread), agentId, role: "event", content: message, meta: { error: true, link: "/settings" } });
      result = { status: "error", message };
    }
  } finally {
    aborts.delete(agentId);
    busy.delete(agentId);
    bus.send({ type: "busy", agentId, thread: null });
  }
  if (agent.kind === "worker" && result.status !== "paused") finishWorker(agent, result);
  return result;
}

// ---------- the turn ----------

async function turn(agent: Agent, thread: string, signal: AbortSignal): Promise<TurnResult> {
  for (let step = 0; step < MAX_STEPS; step++) {
    const fresh = getAgent(agent.id);
    if (!fresh) return { status: "error", message: "agent was deleted" };
    agent = fresh;

    // 4 (resumed). Finish tool calls the model already made: gate, run, append.
    if ((await settleToolCalls(agent, thread, signal)) === "paused") return { status: "paused" };

    // Nothing new since this agent last answered: the turn is already done.
    const answered = alreadyAnswered(agent, thread);
    if (answered) return { status: "done", text: answered.content };

    const resolved = resolveModel(agent);
    if (!resolved) {
      insertMessage({
        thread: displayThread(agent, thread),
        agentId: agent.id,
        role: "event",
        content: `${agent.name} has no model yet. Add an API key or sign in under Settings, then pick a model.`,
        meta: { error: true, link: "/settings" },
      });
      return { status: "error", message: "no model" };
    }

    // ChatGPT plan usage is externally metered, so Ants treats it as spend.
    if (resolved.provider === "chatgpt") {
      const gate = spendGate(agent, thread);
      if (gate) return gate;
    }

    // 2. Build the prompt from role, memory, transcript. 3. Call with only the allowlist.
    const tools = toolsFor(agent);
    const client = clientFor(resolved.provider);
    const seen = threadMessages(thread, 1).at(-1)?.id ?? 0;
    const prompt = buildPrompt(agent, thread);
    const sentBytes = Buffer.byteLength(JSON.stringify({ model: resolved.model, messages: prompt, tools: tools.map((t) => t.name) }));
    try {
      const res = await client.complete({
        model: resolved.model,
        messages: prompt,
        tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        signal,
        onText: (text) => bus.send({ type: "delta", thread, agentId: agent.id, text: redactStreaming(text) }),
      });
      addAudit({ agentId: agent.id, agentName: agent.name, kind: "model", action: resolved.model, target: resolved.provider, risk: 1, approval: resolved.provider === "chatgpt" ? "session" : "not-required", bytesSent: sentBytes, status: "ok" });
      bumpUsage(agent.id, resolved.provider);

      insertMessage({
        thread,
        agentId: agent.id,
        role: "assistant",
        content: res.text,
        meta: { seen, ...(res.toolCalls.length ? { toolCalls: res.toolCalls } : {}) },
      });

      // 5. Text with no tool calls ends the turn.
      if (!res.toolCalls.length) return { status: "done", text: res.text };
    } catch (e) {
      addAudit({ agentId: agent.id, agentName: agent.name, kind: "model", action: resolved.model, target: resolved.provider, risk: 1, approval: resolved.provider === "chatgpt" ? "session" : "not-required", bytesSent: sentBytes, status: "error" });
      throw e;
    }
  }
  insertMessage({
    thread: displayThread(agent, thread),
    agentId: agent.id,
    role: "event",
    content: `${agent.name} stopped after ${MAX_STEPS} steps. Say "continue" to let it keep going.`,
  });
  return { status: "error", message: "step limit" };
}

/**
 * The agent's last plain reply, if nothing addressed to it has arrived since the model wrote it.
 * Compared by what the model saw, not by insert order: a message sent while the agent was
 * mid-turn lands before that turn's reply but was never read.
 */
function alreadyAnswered(agent: Agent, thread: string): Message | undefined {
  const msgs = threadMessages(thread, 60);
  const own = [...msgs].reverse().find((m) => m.role === "assistant" && m.agentId === agent.id);
  if (!own || own.meta.toolCalls?.length) return undefined;
  const seen = own.meta.seen ?? own.id;
  const unread = msgs.some((m) => m.id > seen && (m.role === "user" || (m.role === "assistant" && m.agentId !== agent.id)));
  return unread ? undefined : own;
}

async function settleToolCalls(agent: Agent, thread: string, signal: AbortSignal): Promise<"ok" | "paused"> {
  const msgs = threadMessages(thread, 60);
  const lastOwn = [...msgs].reverse().find((m) => m.role === "assistant" && m.agentId === agent.id);
  const calls = lastOwn?.meta.toolCalls ?? [];
  if (!calls.length) return "ok";
  const done = new Set(msgs.filter((m) => m.role === "tool" && m.id > lastOwn!.id).map((m) => m.meta.toolCallId));

  for (const call of calls) {
    if (done.has(call.id)) continue;
    signal.throwIfAborted();
    const tool = findTool(agent, call.name);
    if (!tool) {
      toolResult(agent, thread, call, `Tool ${call.name} is not on your allowlist.`);
      continue;
    }
    let args: any;
    try {
      args = call.args ? JSON.parse(call.args) : {};
    } catch {
      toolResult(agent, thread, call, `Arguments were not valid JSON: ${call.args.slice(0, 200)}`);
      continue;
    }

    // The gate. A declared send/spend/delete/post waits for a yes in the chat.
    if (needsApproval(tool, args)) {
      const ap = approvalForCall(call.id);
      if (!ap) {
        askApproval(agent, thread, { kind: "tool", toolCallId: call.id, tool: call.name, args: call.args });
        return "paused";
      }
      if (ap.status === "pending") return "paused";
      if (ap.status === "denied") {
        toolResult(agent, thread, call, "The user declined this action. Do not retry it unless they ask.");
        continue;
      }
    }

    const ctx: ToolCtx = {
      agent,
      thread,
      workspace: env.workspace,
      forbidden: env.forbidden,
      signal,
      log: (...a) => log.info(`[${agent.name}/${tool.plugin}]`, ...a),
      assertOutbound: (url, bytes = 0) => assertOutbound(url, { action: call.name, agentId: agent.id, agentName: agent.name, bytes }),
    };
    const approved = approvalForCall(call.id)?.status ?? (needsApproval(tool, args) ? "missing" : "not-required");
    const target = String(args.url ?? args.path ?? args.command ?? "").slice(0, 500);
    try {
      const out = await tool.run(args, ctx);
      addAudit({ agentId: agent.id, agentName: agent.name, kind: "tool", action: call.name, target, risk: needsApproval(tool, args) ? 3 : 1, approval: approved, bytesSent: Buffer.byteLength(call.args), status: "ok" });
      if (typeof out === "string") toolResult(agent, thread, call, out);
      else toolResult(agent, thread, call, out.text, out.image);
    } catch (e: any) {
      if (signal.aborted) throw e;
      addAudit({ agentId: agent.id, agentName: agent.name, kind: "tool", action: call.name, target, risk: needsApproval(tool, args) ? 3 : 1, approval: approved, bytesSent: Buffer.byteLength(call.args), status: /Privacy mode/.test(e?.message ?? "") ? "blocked" : "error" });
      toolResult(agent, thread, call, `Error: ${e?.message ?? e}`);
    }
  }
  return "ok";
}

function toolResult(agent: Agent, thread: string, call: ToolCall, content: string, image?: string) {
  insertMessage({
    thread,
    agentId: agent.id,
    role: "tool",
    content: content || "(no output)",
    meta: { toolCallId: call.id, toolName: call.name, ...(image ? { image: `/api/agents/${agent.id}/shots/${image}` } : {}) },
  });
}

function askApproval(agent: Agent, runThread: string, a: { kind: "tool" | "spend"; toolCallId: string | null; tool: string; args: string }) {
  const thread = displayThread(agent, runThread);
  const ap = createApproval({ agentId: agent.id, runThread, thread, ...a });
  insertMessage({
    thread,
    agentId: agent.id,
    role: "approval",
    content: a.kind === "spend" ? `${agent.name} wants to use your ChatGPT plan allowance.` : `${agent.name} wants to run ${a.tool}.`,
    meta: { approvalId: ap.id, approval: { kind: a.kind, tool: a.tool, args: ap.args, status: "pending", agentName: agent.name } },
  });
}

// ---------- ChatGPT spend gate ----------

const spendConfirmed = new Set<string>();
const spendKey = (a: Agent) => (a.kind === "worker" && a.parentThread ? `thread:${a.parentThread}` : a.id);

function spendGate(agent: Agent, thread: string): TurnResult | null {
  const used = usageToday(agent.id, "chatgpt");
  if (used >= agent.spendCap) {
    insertMessage({
      thread: displayThread(agent, thread),
      agentId: agent.id,
      role: "event",
      content: `${agent.name} hit its ChatGPT plan cap (${agent.spendCap} calls today). Raise the cap or switch provider in Settings.`,
      meta: { error: true, link: "/settings" },
    });
    return { status: "error", message: "spend cap" };
  }
  if (spendConfirmed.has(spendKey(agent))) return null;
  if (pendingApprovals({ agentId: agent.id }).some((a) => a.kind === "spend")) return { status: "paused" };
  askApproval(agent, thread, { kind: "spend", toolCallId: null, tool: "chatgpt_plan", args: JSON.stringify({ cap_per_day: agent.spendCap, used_today: used }) });
  return { status: "paused" };
}

// ---------- approvals ----------

export function decide(approvalId: string, decision: "approved" | "denied") {
  const ap = getApproval(approvalId);
  if (!ap || ap.status !== "pending") return false;
  resolveApproval(ap.id, decision);
  const msg = approvalMessage(ap.id);
  if (msg?.meta.approval) updateMessageMeta(msg.id, { approval: { ...msg.meta.approval, status: decision } });
  const agent = getAgent(ap.agentId);
  if (!agent) return true;
  if (ap.kind === "spend") {
    if (decision === "approved") spendConfirmed.add(spendKey(agent));
    else {
      insertMessage({ thread: ap.thread, agentId: agent.id, role: "event", content: `${agent.name} won't use the ChatGPT plan. Pick another provider in Settings.` });
      return true;
    }
  }
  if (goalFor(ap.agentId)) resumeGoal(ap.agentId);
  else void runTurn(ap.agentId, ap.runThread);
  return true;
}

// ---------- the user speaks ----------

const YES = /^(y|yes|yep|yeah|ok|okay|approve|approved|go|go ahead|do it|sure|yes please)[.!]*$/i;
const NO = /^(n|no|nope|deny|denied|don't|do not|cancel|stop)[.!]*$/i;

export function postUserMessage(thread: string, text: string): Message {
  const trimmed = text.trim();
  const pending = pendingApprovals({ thread });

  if (pending.length && (YES.test(trimmed) || NO.test(trimmed))) {
    const msg = insertMessage({ thread, agentId: null, role: "user", content: trimmed });
    for (const ap of pending) decide(ap.id, YES.test(trimmed) ? "approved" : "denied");
    return msg;
  }
  // Anything else while a question is open counts as "no", then the new message is handled.
  for (const ap of pending) {
    resolveApproval(ap.id, "denied");
    const m = approvalMessage(ap.id);
    if (m?.meta.approval) updateMessageMeta(m.id, { approval: { ...m.meta.approval, status: "denied" } });
  }

  if (/^\/auto(\s|$)/i.test(trimmed) && !isGroupThread(thread)) {
    const msg = insertMessage({ thread, agentId: null, role: "user", content: text });
    const reply = handleAutoCommand(thread.slice(2), thread, trimmed);
    if (reply) insertMessage({ thread, agentId: thread.slice(2), role: "event", content: reply });
    return msg;
  }

  const responders = respondersFor(thread, trimmed);
  const skillSlug = trimmed.match(/^\/([a-z0-9-]+)/i)?.[1];
  const skill = skillSlug && responders[0] ? getSkill(responders[0], skillSlug) : undefined;

  const msg = insertMessage({ thread, agentId: null, role: "user", content: text, meta: skill ? { skill: skill.slug } : {} });
  // In a group, responders go one after another so each sees the previous reply.
  void responders.reduce<Promise<unknown>>((p, id) => p.then(() => runTurn(id, thread)), Promise.resolve());
  return msg;
}

function respondersFor(thread: string, text: string): string[] {
  if (!isGroupThread(thread)) {
    const a = getAgent(thread.slice(2));
    return a ? [a.id] : [];
  }
  const g = getGroup(thread.slice(2));
  if (!g) return [];
  const members = g.members.map((id) => getAgent(id)).filter(Boolean) as Agent[];
  const mentioned = members.filter((a) => new RegExp(`@${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  if (mentioned.length) return mentioned.map((a) => a.id);
  // No mention: the first member leads, and can hand off from there.
  return members.length ? [members[0].id] : [];
}

/** Another agent writes into a thread. `run` hands over the turn; without it, the message just waits. */
export function agentSays(from: Agent, thread: string, text: string) {
  return insertMessage({ thread, agentId: null, role: "user", content: text, meta: { from: { id: from.id, name: from.name } } });
}

// ---------- the prompt ----------

function systemPrompt(agent: Agent, thread: string): string {
  const others = listAgents().filter((a) => a.id !== agent.id);
  const memories = listMemories(agent.id);
  const skills = listSkills(agent.id);
  const lines: string[] = [];

  lines.push(`You are ${agent.name}. ${agent.role}`.trim());
  if (agent.description) lines.push(agent.description);

  if (agent.kind === "coordinator") {
    lines.push(
      "",
      "You are the coordinator. You do not do the specialist work yourself. You decide who should take a job:",
      "- handoff gives a task to another agent and runs them now. Their reply is posted back here.",
      "- message_agent leaves a note in another agent's chat without making them act.",
      "- spawn starts a short-lived worker with an explicit tool list and a deadline, for a bounded task. Its result is posted here.",
      "Say in one line who you routed the work to and why.",
    );
  }
  if (agent.kind === "worker") {
    const deadline = agent.deadline ? new Date(agent.deadline).toLocaleTimeString() : "soon";
    lines.push("", `You are a temporary worker spawned for one task. Do it, then reply with the result only. Finish before ${deadline}. Your transcript is deleted when you finish.`);
  }

  lines.push(
    "",
    "You run on Ants: several named agents on one machine the user owns.",
    `Shared with the other agents: the filesystem (shared workspace: ${env.workspace}), the browser's cookies and saved logins, installed tools.`,
    "Not shared: your chat, your memory, and your screen. You cannot read another agent's chat.",
  );
  if (others.length) {
    lines.push("Other agents:");
    for (const a of others) lines.push(`- ${a.name}${a.kind === "coordinator" ? " (coordinator)" : ""}: ${a.role}`);
  }

  if (isGroupThread(thread)) {
    const g = getGroup(thread.slice(2));
    const names = (g?.members ?? []).map((id) => getAgent(id)?.name).filter(Boolean);
    lines.push(
      "",
      `This is the group thread "${g?.name}" with the user and ${names.join(", ")}. Messages from others start with [Name]. The user's messages start with [User].`,
      "Only answer what is meant for you. Use handoff to pass a task to another member here.",
    );
  } else if (agent.kind !== "worker") {
    lines.push("", "This is your one-to-one chat with the user. Messages starting with [Name] were written by another agent.");
  }

  lines.push(
    "",
    "How to work:",
    "- Talk like a capable colleague in chat. Short, plain, direct. Markdown only when it helps.",
    "- Adding help: spawn makes a TEMPORARY worker for one task. It never appears in the agent list and is deleted when done. agent_create makes a PERMANENT agent that joins the user's agent list with its own chat and memory. If the user wants an agent they can keep, talk to, or see in the list, use agent_create. Do not use skill_save as a substitute for creating an agent.",
    "- Tools that send, spend, delete, or post pause for the user's approval on their own. Just call them; do not ask for permission in text first.",
    "- Your screen is a real browser. Use screen_read to see it. The user can watch it live.",
    "- Keep short durable notes with memory_add: preferences, facts, where things are. Not task logs.",
    "- When a multi-step task has worked and is likely to come up again, offer to save it as a skill with skill_save.",
    `- Now: ${new Date().toString()}`,
  );

  if (memories.length) {
    lines.push("", "Your memory (notes you wrote earlier, id: note):");
    for (const m of memories.slice(-60)) lines.push(`${m.id}: ${m.text}`);
  }
  if (skills.length) {
    lines.push("", "Your saved skills (the user runs them with /name):");
    for (const s of skills) lines.push(`- /${s.slug}: ${s.description}`);
  }
  return lines.join("\n");
}

/**
 * Messages in the order this agent experienced them. Something written while the agent was
 * mid-turn has a lower id than that turn's reply, but the reply never saw it, so it goes after.
 */
function asExperienced(agent: Agent, msgs: Message[]): Message[] {
  const own = msgs.filter((m) => m.role === "assistant" && m.agentId === agent.id && m.meta.seen !== undefined);
  const key = (m: Message) => {
    if (m.role === "tool" || (m.role === "assistant" && m.agentId === agent.id)) return m.id;
    const missedBy = own.find((a) => a.id > m.id && a.meta.seen! < m.id);
    return missedBy ? missedBy.id + 0.5 : m.id;
  };
  return msgs.map((m) => ({ m, k: key(m) })).sort((a, b) => a.k - b.k).map((x) => x.m);
}

export function buildPrompt(agent: Agent, thread: string): ChatMsg[] {
  const msgs = asExperienced(agent, threadMessages(thread, 100));
  const group = isGroupThread(thread);
  const out: ChatMsg[] = [{ role: "system", content: systemPrompt(agent, thread) }];
  const results = new Map<string, Message>();
  for (const m of msgs) if (m.role === "tool" && m.agentId === agent.id && m.meta.toolCallId) results.set(m.meta.toolCallId, m);

  // Older tool output is trimmed so long sessions stay inside the context window.
  const ownAssistant = msgs.filter((m) => m.role === "assistant" && m.agentId === agent.id && m.meta.toolCalls?.length);
  const recentCut = ownAssistant.length > 4 ? ownAssistant[ownAssistant.length - 4].id : 0;

  for (const m of msgs) {
    if (m.role === "user") {
      let content = m.content;
      if (m.meta.skill) {
        const s = getSkill(agent.id, m.meta.skill);
        if (s) {
          const extra = content.replace(/^\/[a-z0-9-]+\s*/i, "");
          content = `Run your saved skill "${s.name}". Follow it.\n\n<skill>\n${s.body}\n</skill>${extra ? `\n\nInput: ${extra}` : ""}`;
        }
      }
      if (m.meta.routine) content = `[Routine run] ${content}`;
      if (m.meta.from) content = `[${m.meta.from.name}]: ${content}`;
      else if (group) content = `[User]: ${content}`;
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      if (m.agentId === agent.id) {
        const calls = m.meta.toolCalls ?? [];
        out.push({ role: "assistant", content: m.content, ...(calls.length ? { toolCalls: calls } : {}) });
        for (const c of calls) {
          const r = results.get(c.id);
          let content = r?.content ?? "(not run)";
          if (m.id < recentCut && content.length > 1500) content = `${content.slice(0, 1500)}\n… (trimmed)`;
          out.push({ role: "tool", toolCallId: c.id, name: c.name, content });
        }
      } else if (m.content) {
        const name = getAgent(m.agentId ?? "")?.name ?? "Another agent";
        out.push({ role: "user", content: `[${name}]: ${m.content}` });
      }
    }
    // Tool results are placed above, right after their call. Events and approval cards are for the user.
  }
  return out;
}

// ---------- workers ----------

function finishWorker(worker: Agent, result: TurnResult) {
  // Someone may have kept it as a permanent agent while it ran. Then it stays.
  if (getAgent(worker.id)?.kind !== "worker") return;
  const parent = worker.parentThread;
  if (parent) {
    if (result.status === "done") {
      insertMessage({
        thread: parent,
        agentId: null,
        role: "user",
        content: result.text || "(finished with no text)",
        meta: { from: { id: worker.id, name: worker.name } },
      });
    } else if (result.status !== "stopped") {
      insertMessage({ thread: parent, agentId: worker.id, role: "event", content: `${worker.name} failed: ${(result as any).message ?? "error"}` });
    }
  }
  // The worker's transcript goes with it.
  deleteAgent(worker.id);
}

function sweepWorkers() {
  for (const w of expiredWorkers()) {
    stopAgent(w.id);
    if (w.parentThread) insertMessage({ thread: w.parentThread, agentId: null, role: "event", content: `${w.name} ran out of time and was removed.` });
    deleteAgent(w.id);
  }
}

export { findAgentByName };
