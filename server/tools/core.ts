// Tools that need the host itself: memory, skills, the screen, and the team tools.
// They register through the same registry as folder plugins and obey the same allowlist.
import { registerCorePlugin, allToolNames } from "./registry.js";
import { addMemory, deleteMemory, listMemories, createAgent, getGroup, findAgentByName, listAgents, type Agent } from "../db.js";
import { listSkills, getSkill, saveSkill } from "../skills.js";
import { screenTools } from "../screen.js";
import { finishGoal, goalFor } from "../autonomy.js";
import { agentSays, agentThread, isGroupThread, runTurn } from "../loop.js";

export const TEAM_TOOLS = ["handoff", "message_agent", "spawn", "agent_create"];

function target(from: Agent, name: string): Agent {
  const a = findAgentByName(name);
  if (!a) throw new Error(`No agent named ${name}.`);
  if (a.id === from.id) throw new Error("That's you.");
  return a;
}

export function registerCoreTools() {
  registerCorePlugin("goal", "Lets an agent end an autonomous run (/auto) with a summary.", [
    {
      name: "goal_finish",
      description: "Call this when the goal you were given with /auto is finished, or you are stuck and cannot go further. Include a short summary of what you did or what is blocking you.",
      parameters: {
        type: "object",
        properties: { status: { type: "string", enum: ["done", "blocked"] }, summary: { type: "string" } },
        required: ["status", "summary"],
      },
      async run({ status, summary }, ctx) {
        if (!goalFor(ctx.agent.id)) return "There is no autonomous goal running; just reply normally.";
        return finishGoal(ctx.agent.id, status === "blocked" ? "blocked" : "done", String(summary).slice(0, 500));
      },
    },
  ]);

  registerCorePlugin("memory", "A short list of notes the agent keeps about the user and its work.", [
    {
      name: "memory_add",
      description: "Save a short durable note to your memory. It is shown to you at the start of every turn.",
      parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      async run({ note }, ctx) {
        const id = addMemory(ctx.agent.id, String(note).slice(0, 500));
        return `Saved as note ${id}.`;
      },
    },
    {
      name: "memory_forget",
      description: "Delete one of your memory notes by id.",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      async run({ id }, ctx) {
        return deleteMemory(ctx.agent.id, Number(id)) ? `Forgot note ${id}.` : `No note ${id}.`;
      },
    },
    {
      name: "memory_list",
      description: "List your memory notes.",
      parameters: { type: "object", properties: {} },
      async run(_a, ctx) {
        const m = listMemories(ctx.agent.id);
        return m.length ? m.map((x) => `${x.id}: ${x.text}`).join("\n") : "No notes yet.";
      },
    },
  ]);

  registerCorePlugin("skills", "Saved procedures the agent can rerun by name.", [
    {
      name: "skill_save",
      description:
        "Save a procedure that worked, so it can be rerun with /name. Write it so a fresh run can follow it without this conversation.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name, e.g. 'weekly-report'" },
          description: { type: "string", description: "One line: what it does" },
          steps: { type: "string", description: "Numbered steps" },
          decision_rules: { type: "string", description: "If X then Y rules" },
          output_format: { type: "string" },
          approval_boundary: { type: "string", description: "What needs the user's yes" },
        },
        required: ["name", "description", "steps"],
      },
      async run(a, ctx) {
        const s = saveSkill(ctx.agent.id, a);
        return `Saved skill /${s.slug}.`;
      },
    },
    {
      name: "skill_read",
      description: "Read one of your saved skills.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run({ name }, ctx) {
        const s = getSkill(ctx.agent.id, name);
        return s ? `# ${s.name}\n${s.description}\n\n${s.body}` : `No skill named ${name}.`;
      },
    },
    {
      name: "skill_list",
      description: "List your saved skills.",
      parameters: { type: "object", properties: {} },
      async run(_a, ctx) {
        const s = listSkills(ctx.agent.id);
        return s.length ? s.map((x) => `/${x.slug}: ${x.description}`).join("\n") : "No skills yet.";
      },
    },
  ]);

  registerCorePlugin("screen", "The agent's own browser screen. Cookies are shared across agents; screens are not.", screenTools());

  registerCorePlugin("team", "Hand work to other agents, leave them notes, and spawn short-lived workers.", [
    {
      name: "handoff",
      description:
        "Give a task to another agent and let them run it now. In a group thread they answer in the group; otherwise in their own chat, and their reply is posted back to you.",
      parameters: {
        type: "object",
        properties: { agent: { type: "string", description: "Agent name" }, task: { type: "string" } },
        required: ["agent", "task"],
      },
      async run({ agent, task }, ctx) {
        const to = target(ctx.agent, agent);
        if (isGroupThread(ctx.thread)) {
          const g = getGroup(ctx.thread.slice(2));
          if (!g?.members.includes(to.id)) throw new Error(`${to.name} is not in this group.`);
          agentSays(ctx.agent, ctx.thread, `@${to.name} ${task}`);
          void runTurn(to.id, ctx.thread);
          return `Handed to ${to.name} in this group.`;
        }
        agentSays(ctx.agent, agentThread(to.id), task);
        const back = ctx.thread;
        void runTurn(to.id, agentThread(to.id)).then((r) => {
          if (r.status === "done") agentSays(to, back, r.text || "(done)");
          else if (r.status === "paused") agentSays(to, back, "I need the user's approval in my chat before I can finish this.");
          else if (r.status === "error") agentSays(to, back, `I couldn't finish: ${r.message}`);
        });
        return `Handed off to ${to.name}. They're working on it in their chat; the reply will be posted here.`;
      },
    },
    {
      name: "message_agent",
      description: "Leave a message in another agent's chat without making them act now. They see it on their next turn.",
      parameters: {
        type: "object",
        properties: { agent: { type: "string" }, text: { type: "string" } },
        required: ["agent", "text"],
      },
      async run({ agent, text }, ctx) {
        const to = target(ctx.agent, agent);
        agentSays(ctx.agent, agentThread(to.id), text);
        return `Delivered to ${to.name}.`;
      },
    },
    {
      name: "agent_create",
      description:
        "Create a PERMANENT agent. It joins the user's agent list with its own chat, memory, skills and screen, and stays until the user deletes it. Use this when the user wants an agent they can keep and talk to. For a one-off task use spawn instead. The user is asked to approve first.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short and unique, letters and numbers" },
          role: { type: "string", description: "One or two sentences: what this agent is for" },
          tools: { type: "array", items: { type: "string" }, description: "Tool names it may use. Omit for the standard set." },
          task: { type: "string", description: "Optional first job. It starts working on it in its own chat." },
        },
        required: ["name", "role"],
      },
      gate: true,
      async run({ name, role, tools, task }, ctx) {
        const clean = String(name ?? "").trim().slice(0, 40);
        if (!clean || !String(role ?? "").trim()) throw new Error("An agent needs a name and a role.");
        if (!/^[\p{L}\p{N} _.-]+$/u.test(clean)) throw new Error("Use letters, numbers, spaces, dots, dashes in the name.");
        if (listAgents(true).some((a) => a.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There is already an agent called ${clean}.`);
        const loaded = new Set(allToolNames());
        const explicit = Array.isArray(tools) && tools.length;
        const wanted: string[] = explicit ? tools.map(String) : DEFAULT_AGENT_TOOLS;
        // A new agent can't be handed the power to spawn or create more agents.
        const bad = explicit ? wanted.filter((t) => !loaded.has(t) || t === "spawn" || t === "agent_create") : [];
        if (bad.length) throw new Error(`Not available: ${bad.join(", ")}. Choose from: ${[...loaded].filter((t) => t !== "spawn" && t !== "agent_create").join(", ")}`);
        const created = createAgent({
          kind: "agent",
          name: clean,
          role: String(role).slice(0, 400),
          description: "",
          provider: ctx.agent.provider,
          model: ctx.agent.model,
          tools: wanted.filter((t) => loaded.has(t)),
          spendCap: ctx.agent.spendCap,
        });
        const t = agentThread(created.id);
        agentSays(ctx.agent, t, `Hi ${created.name}. ${ctx.agent.name} set you up. ${created.role}${task ? `\n\nFirst job: ${String(task)}` : ""}`);
        if (task) void runTurn(created.id, t);
        return `Created ${created.name}. It is now in the agent list with its own chat.${task ? " It is working on the first job there." : ""}`;
      },
    },
    {
      name: "spawn",
      description:
        "Start a TEMPORARY worker for one bounded task, with an explicit tool list and a deadline. Waits for its result. It does not join the user's agent list and its transcript is deleted when it finishes. For a lasting agent the user can keep, use agent_create instead.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Everything the worker needs to know. It sees nothing else." },
          tools: { type: "array", items: { type: "string" }, description: "Tool names the worker may use" },
          minutes: { type: "integer", description: "Deadline in minutes, default 10, max 60" },
          name: { type: "string" },
        },
        required: ["task", "tools"],
      },
      async run({ task, tools, minutes = 10, name }, ctx) {
        const loaded = new Set(allToolNames());
        const wanted: string[] = Array.isArray(tools) ? tools.map(String) : [];
        const bad = wanted.filter((t) => !loaded.has(t) || TEAM_TOOLS.includes(t));
        if (bad.length) throw new Error(`Not available to workers: ${bad.join(", ")}. Choose from: ${[...loaded].filter((t) => !TEAM_TOOLS.includes(t)).join(", ")}`);
        const mins = Math.min(Math.max(Number(minutes) || 10, 1), 60);
        // The allowlist is copied now. Later changes to the host don't reach this worker.
        const worker = createAgent({
          kind: "worker",
          name: name ? String(name).slice(0, 40) : `worker-${Math.random().toString(36).slice(2, 6)}`,
          role: `Temporary worker for ${ctx.agent.name}.`,
          description: "",
          provider: ctx.agent.provider,
          model: ctx.agent.model,
          tools: [...wanted],
          spendCap: ctx.agent.spendCap,
          parentThread: ctx.thread,
          deadline: Date.now() + mins * 60_000,
        });
        agentSays(ctx.agent, ctx.thread, `Spawned ${worker.name} (${mins} min, tools: ${wanted.join(", ") || "none"}) for: ${task}`);
        agentSays(ctx.agent, agentThread(worker.id), task);
        const r = await runTurn(worker.id, agentThread(worker.id));
        if (r.status === "done") return `${worker.name} finished:\n${r.text}`;
        if (r.status === "paused") return `${worker.name} is waiting for the user's approval in this chat. Its result will be posted here.`;
        if (r.status === "error") return `${worker.name} failed: ${r.message}`;
        return `${worker.name} was stopped.`;
      },
    },
  ]);
}

export const DEFAULT_AGENT_TOOLS = [
  "files_read",
  "files_write",
  "files_list",
  "files_delete",
  "shell_run",
  "fetch_get",
  "fetch_post",
  "memory_add",
  "memory_forget",
  "memory_list",
  "skill_save",
  "skill_read",
  "skill_list",
  "screen_open",
  "screen_read",
  "screen_click",
  "screen_type",
  "screen_press",
  "screen_scroll",
  "screen_back",
  "screen_capture",
  "handoff",
  "message_agent",
  "goal_finish",
];

// The coordinator routes. It does not get shell.
export const DEFAULT_COORDINATOR_TOOLS = [
  "handoff",
  "message_agent",
  "spawn",
  "agent_create",
  "memory_add",
  "memory_forget",
  "memory_list",
  "skill_save",
  "skill_read",
  "skill_list",
  "files_read",
  "files_list",
  "fetch_get",
];

