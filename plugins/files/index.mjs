import fs from "node:fs/promises";
import path from "node:path";

function resolve(p, ctx) {
  const full = path.resolve(ctx.workspace, p || ".");
  for (const f of ctx.forbidden) {
    if (full === f || full.startsWith(f + path.sep)) throw new Error(`${p} is off limits`);
  }
  return full;
}

export const tools = {
  async read({ path: p, offset = 1, limit = 400 }, ctx) {
    const full = resolve(p, ctx);
    const text = await fs.readFile(full, "utf8");
    const lines = text.split("\n");
    const start = Math.max(0, offset - 1);
    const slice = lines.slice(start, start + limit).join("\n");
    const more = start + limit < lines.length ? `\n… ${lines.length - start - limit} more lines (use offset)` : "";
    return slice.slice(0, 40_000) + more;
  },
  async write({ path: p, content, append }, ctx) {
    const full = resolve(p, ctx);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await (append ? fs.appendFile(full, content) : fs.writeFile(full, content));
    return `Wrote ${Buffer.byteLength(content)} bytes to ${full}`;
  },
  async list({ path: p }, ctx) {
    const full = resolve(p, ctx);
    const entries = await fs.readdir(full, { withFileTypes: true });
    if (!entries.length) return `${full} is empty`;
    return `${full}\n` + entries.slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
  },
  async delete({ path: p }, ctx) {
    const full = resolve(p, ctx);
    const st = await fs.stat(full);
    await (st.isDirectory() ? fs.rmdir(full) : fs.unlink(full));
    return `Deleted ${full}`;
  },
};
