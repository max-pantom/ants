// A routine is when. It points at a skill or a standing instruction, runs on a cron,
// and posts into that agent's chat. A run does real work, so gated tools still stop.
import { Cron } from "croner";
import { getAgent, getRoutine, insertMessage, listRoutines, markRoutineRun } from "./db.js";
import { agentThread, runTurn } from "./loop.js";
import { getSkill } from "./skills.js";
import { log } from "./log.js";

const jobs = new Map<string, Cron>();

export function validCron(expr: string): string | null {
  try {
    new Cron(expr, { paused: true }).stop();
    return null;
  } catch (e: any) {
    return e.message;
  }
}

export function nextRun(expr: string): number | null {
  try {
    const c = new Cron(expr, { paused: true });
    const n = c.nextRun();
    c.stop();
    return n ? n.getTime() : null;
  } catch {
    return null;
  }
}

export function scheduleRoutines() {
  for (const j of jobs.values()) j.stop();
  jobs.clear();
  for (const r of listRoutines()) {
    if (!r.enabled) continue;
    try {
      jobs.set(r.agentId, new Cron(r.cron, { protect: true }, () => void runRoutine(r.agentId)));
    } catch (e: any) {
      log.warn(`routine for ${r.agentId} has a bad cron: ${e.message}`);
    }
  }
}

export function runRoutine(agentId: string) {
  const r = getRoutine(agentId);
  const agent = getAgent(agentId);
  if (!r || !agent) return;
  const thread = agentThread(agentId);
  const skill = r.skill ? getSkill(agentId, r.skill) : undefined;
  if (r.skill && !skill) {
    insertMessage({ thread, agentId, role: "event", content: `Routine skipped: skill /${r.skill} no longer exists.`, meta: { error: true } });
    return;
  }
  const content = skill ? `/${skill.slug}${r.instruction ? ` ${r.instruction}` : ""}` : r.instruction;
  insertMessage({ thread, agentId: null, role: "user", content, meta: { routine: true, ...(skill ? { skill: skill.slug } : {}) } });
  markRoutineRun(agentId);
  return runTurn(agentId, thread);
}
