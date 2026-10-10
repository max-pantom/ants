// Autonomous work. `/auto <goal>` keeps one agent going across turns until it calls goal_finish,
// runs out of its turn budget, hits an error, or the user stops it. It adds no new power:
// every gated tool still waits for a yes, and a pending question pauses the run until answered.
import { getAgent, insertMessage, updateAgent, type Agent } from "./db.js";
import { agentThread, runTurn } from "./loop.js";

interface Goal {
  text: string;
  turnsLeft: number;
  thread: string;
  outcome?: { status: "done" | "blocked"; summary: string };
}

export const DEFAULT_TURNS = 10;
export const MAX_TURNS = 50;
export const GOAL_TOOL = "goal_finish";

const goals = new Map<string, Goal>();

export const goalFor = (agentId: string) => goals.get(agentId);

export function startGoal(agent: Agent, text: string, turns = DEFAULT_TURNS) {
  if (goals.has(agent.id)) throw new Error(`${agent.name} is already working on a goal. Send /auto stop first.`);
  if (!agent.tools.includes(GOAL_TOOL)) updateAgent(agent.id, { tools: [...agent.tools, GOAL_TOOL] });
  const thread = agentThread(agent.id);
  const budget = Math.max(1, Math.min(MAX_TURNS, Math.floor(turns)));
  goals.set(agent.id, { text, turnsLeft: budget, thread });
  insertMessage({
    thread,
    agentId: null,
    role: "user",
    content: `Goal: ${text}\n\nWork on this on your own. Use your tools, and don't ask me questions you can answer yourself. Anything that sends, spends, deletes or posts will wait for my approval. When it is finished, or you are stuck, call goal_finish with a short summary.`,
    meta: { autonomous: true },
  });
  void drive(agent.id);
}

export function cancelGoal(agentId: string, why = "Stopped.") {
  const g = goals.get(agentId);
  if (!g) return false;
  goals.delete(agentId);
  const a = getAgent(agentId);
  if (a) insertMessage({ thread: g.thread, agentId, role: "event", content: `${a.name}'s autonomous run ended. ${why}` });
  return true;
}

/** Called by the goal_finish tool. */
export function finishGoal(agentId: string, status: "done" | "blocked", summary: string) {
  const g = goals.get(agentId);
  if (!g) return "There is no autonomous goal running; just reply normally.";
  g.outcome = { status, summary };
  return "Recorded. Reply with a short final message for the user.";
}

/** Run turns until the goal ends. Re-entered after an approval so a paused run carries on. */
export function resumeGoal(agentId: string) {
  if (goals.has(agentId)) void drive(agentId);
}

let driving = new Set<string>();

async function drive(agentId: string) {
  if (driving.has(agentId)) return;
  driving.add(agentId);
  try {
    for (;;) {
      const g = goals.get(agentId);
      const agent = getAgent(agentId);
      if (!g || !agent) return;

      g.turnsLeft--;
      const r = await runTurn(agentId, g.thread);
      if (!goals.has(agentId)) return; // stopped while it ran

      if (g.outcome) {
        goals.delete(agentId);
        insertMessage({
          thread: g.thread,
          agentId,
          role: "event",
          content: `${agent.name} ${g.outcome.status === "done" ? "finished" : "is blocked on"} the goal: ${g.outcome.summary}`.slice(0, 600),
        });
        return;
      }
      if (r.status === "paused") return; // waits for a yes; decide() resumes
      if (r.status !== "done") {
        cancelGoal(agentId, r.status === "error" ? `It stopped on an error: ${r.message}` : "Stopped.");
        return;
      }
      if (g.turnsLeft <= 0) {
        cancelGoal(agentId, `Turn budget used up. Send /auto <goal> again to keep going.`);
        return;
      }
      insertMessage({
        thread: g.thread,
        agentId: null,
        role: "user",
        content: "Keep going toward the goal. If it is finished or you are stuck, call goal_finish.",
        meta: { autonomous: true },
      });
    }
  } finally {
    driving.delete(agentId);
  }
}

/** `/auto <goal>`, `/auto 20 <goal>` (turn budget), `/auto stop`. Returns true if it handled the message. */
export function handleAutoCommand(agentId: string, thread: string, text: string): string | null {
  const m = /^\/auto(?:\s+(.*))?$/is.exec(text.trim());
  if (!m) return null;
  const agent = getAgent(agentId);
  if (!agent || thread !== agentThread(agentId)) return "Autonomous goals run in an agent's own chat.";
  const rest = (m[1] ?? "").trim();
  if (!rest) return "Usage: /auto <goal>, /auto 20 <goal> to set the turn budget, /auto stop.";
  if (/^stop$/i.test(rest)) return cancelGoal(agentId) ? "" : `${agent.name} isn't running a goal.`;
  const n = /^(\d{1,2})\s+(.+)$/s.exec(rest);
  try {
    startGoal(agent, n ? n[2] : rest, n ? Number(n[1]) : DEFAULT_TURNS);
    return "";
  } catch (e: any) {
    return e.message;
  }
}
