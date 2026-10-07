// A skill is how. It is a file the agent writes after a task worked: steps, decision rules,
// output format, and the approval boundary. The user runs it from chat with /name.
import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";

let dataDir = "";
export const initSkills = (d: string) => (dataDir = d);

export interface Skill {
  slug: string;
  name: string;
  description: string;
  body: string;
  updatedAt: number;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const dir = (agentId: string) => paths(dataDir).skills(agentId);

function parse(slug: string, text: string, mtime: number): Skill {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm: Record<string, string> = {};
  if (m) for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { slug, name: fm.name ?? slug, description: fm.description ?? "", body: (m ? m[2] : text).trim(), updatedAt: mtime };
}

export function listSkills(agentId: string): Skill[] {
  const d = dir(agentId);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const full = path.join(d, f);
      return parse(f.slice(0, -3), fs.readFileSync(full, "utf8"), fs.statSync(full).mtimeMs);
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getSkill(agentId: string, nameOrSlug: string): Skill | undefined {
  const slug = slugify(nameOrSlug);
  return listSkills(agentId).find((s) => s.slug === slug);
}

export function saveSkill(
  agentId: string,
  s: { name: string; description: string; steps: string; decision_rules?: string; output_format?: string; approval_boundary?: string },
): Skill {
  const slug = slugify(s.name);
  if (!slug) throw new Error("A skill needs a name.");
  const oneLine = (x: string) => x.replace(/\s+/g, " ").trim();
  const body = [
    `## Steps\n\n${s.steps.trim()}`,
    s.decision_rules?.trim() && `## Decision rules\n\n${s.decision_rules.trim()}`,
    s.output_format?.trim() && `## Output format\n\n${s.output_format.trim()}`,
    `## Approval boundary\n\n${s.approval_boundary?.trim() || "Ask before anything that sends, spends, deletes, or posts."}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  fs.mkdirSync(dir(agentId), { recursive: true });
  fs.writeFileSync(path.join(dir(agentId), `${slug}.md`), `---\nname: ${oneLine(s.name)}\ndescription: ${oneLine(s.description)}\n---\n\n${body}\n`);
  return getSkill(agentId, slug)!;
}

export function deleteSkill(agentId: string, slug: string) {
  const f = path.join(dir(agentId), `${slugify(slug)}.md`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function copySkills(fromId: string, toId: string) {
  const src = dir(fromId);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dir(toId), { recursive: true });
}
