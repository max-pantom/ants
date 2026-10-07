import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import * as db from "./db.js";
import { bus, type BusEvent } from "./bus.js";
import { paths, type Config } from "./config.js";
import { guard, sessionInfo, exchangeLaunchToken, login, setup, logout } from "./auth.js";
import { postUserMessage, decide, stopAgent, busyAgents, runTurn } from "./loop.js";
import { listSkills, deleteSkill, copySkills } from "./skills.js";
import { scheduleRoutines, runRoutine, validCron, nextRun } from "./routines.js";
import { watchScreen, hasScreen, closeScreen, VIEWPORT } from "./screen.js";
import { listPlugins, loadedToolsFor, loadPlugins } from "./tools/registry.js";
import { DEFAULT_AGENT_TOOLS, DEFAULT_COORDINATOR_TOOLS } from "./tools/core.js";
import { writeSecret, deleteSecret, secretNames } from "./secrets.js";
import { availability, clientFor, keyOf, providerSettings, resolveModel, PROVIDERS, ProviderError, type ProviderId } from "./providers/index.js";
import { chatgptStatus, chatgptLogout, startChatGPTLogin, finishChatGPTLogin } from "./providers/chatgpt.js";
import { xaiStatus, xaiLogout, startXaiLogin } from "./providers/xai-device.js";
import { log } from "./log.js";
import { assertOutbound, privacyMode, setPrivacyMode, type PrivacyMode } from "./privacy.js";

const THREAD = /^(a|g):[a-z0-9]{1,32}$/;

function agentView(a: db.Agent) {
  return {
    ...a,
    resolved: resolveModel(a),
    busy: busyAgents()[a.id] ?? null,
    screen: hasScreen(a.id),
  };
}

function bad(c: Context, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: message }, status);
}

const mask = (k?: string) => (k ? `••••${k.slice(-4)}` : null);

export function createApp(cfg: Config) {
  const app = new Hono();
  const p = paths(cfg.dataDir);
  // In dev the UI runs on Vite's port; OAuth still lands on this server.
  const uiOrigin = cfg.dev ? "http://127.0.0.1:5173" : `http://127.0.0.1:${cfg.port}`;

  app.onError((err, c) => {
    if (err instanceof ProviderError) return c.json({ error: err.message }, 400);
    log.error(`${c.req.method} ${c.req.path}`, err);
    return c.json({ error: err.message }, 500);
  });

  app.use("*", guard());

  // ---------- session ----------

  app.get("/api/session", (c) => c.json(sessionInfo(c)));
  app.post("/api/session/token", async (c) => {
    const { token } = await c.req.json();
    return exchangeLaunchToken(c, String(token ?? "")) ? c.json({ ok: true }) : bad(c, "That launch link is stale. Use the one `ants` printed most recently.", 403);
  });
  app.post("/api/login", async (c) => {
    const { password } = await c.req.json();
    const err = login(c, String(password ?? ""));
    return err ? bad(c, err, 403) : c.json({ ok: true });
  });
  app.post("/api/setup", async (c) => {
    const { code, password } = await c.req.json();
    try {
      const err = setup(c, String(code ?? ""), String(password ?? ""));
      return err ? bad(c, err, 403) : c.json({ ok: true });
    } catch (e: any) {
      return bad(c, e.message);
    }
  });
  app.post("/api/logout", (c) => {
    logout(c);
    return c.json({ ok: true });
  });

  // ---------- state ----------

  app.get("/api/state", (c) =>
    c.json({
      mode: cfg.mode,
      agents: db.listAgents().map(agentView),
      groups: db.listGroups(),
      lastIds: db.lastMessageIds(),
      pending: db.pendingApprovals({}).map((a) => a.thread),
    }),
  );

  // ---------- agents ----------

  const uniqueName = (name: string, except?: string) =>
    !db.listAgents(true).some((a) => a.name.toLowerCase() === name.toLowerCase() && a.id !== except);

  app.post("/api/agents", async (c) => {
    const b = await c.req.json();
    const name = String(b.name ?? "").trim().slice(0, 40);
    const role = String(b.role ?? "").trim().slice(0, 400);
    if (!name || !role) return bad(c, "An agent needs a name and a role.");
    if (!/^[\p{L}\p{N} _.-]+$/u.test(name)) return bad(c, "Use letters, numbers, spaces, dots, dashes in the name.");
    if (!uniqueName(name)) return bad(c, `There is already an agent called ${name}.`, 409);
    const kind = b.kind === "coordinator" ? "coordinator" : "agent";
    const a = db.createAgent({
      name,
      role,
      description: String(b.description ?? "").slice(0, 2000),
      kind,
      tools: kind === "coordinator" ? DEFAULT_COORDINATOR_TOOLS : DEFAULT_AGENT_TOOLS,
    });
    return c.json(agentView(a));
  });

  app.patch("/api/agents/:id", async (c) => {
    const a = db.getAgent(c.req.param("id"));
    if (!a || a.kind === "worker") return bad(c, "No such agent.", 404);
    const b = await c.req.json();
    const patch: Partial<db.Agent> = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 40);
      if (!name) return bad(c, "Name can't be empty.");
      if (!uniqueName(name, a.id)) return bad(c, `There is already an agent called ${name}.`, 409);
      patch.name = name;
    }
    if (b.role !== undefined) patch.role = String(b.role).slice(0, 400);
    if (b.description !== undefined) patch.description = String(b.description).slice(0, 2000);
    if (b.provider !== undefined) patch.provider = b.provider || null;
    if (b.model !== undefined) patch.model = b.model || null;
    if (Array.isArray(b.tools)) {
      const loaded = new Set(loadedToolsFor(a.id).map((t) => t.name));
      patch.tools = b.tools.map(String).filter((t: string) => loaded.has(t));
    }
    if (b.spendCap !== undefined) patch.spendCap = Math.max(0, Math.min(10000, Number(b.spendCap) || 0));
    return c.json(agentView(db.updateAgent(a.id, patch)));
  });

  app.delete("/api/agents/:id", async (c) => {
    const a = db.getAgent(c.req.param("id"));
    if (!a) return bad(c, "No such agent.", 404);
    stopAgent(a.id);
    await closeScreen(a.id);
    db.deleteAgent(a.id);
    fs.rmSync(p.agent(a.id), { recursive: true, force: true });
    scheduleRoutines();
    return c.json({ ok: true });
  });

  // Copy as template: role, skills, routine, plugins, allowlist. Never transcript or memory.
  app.post("/api/agents/:id/copy", async (c) => {
    const a = db.getAgent(c.req.param("id"));
    if (!a || a.kind === "worker") return bad(c, "No such agent.", 404);
    const b = await c.req.json().catch(() => ({}));
    let name = String(b.name ?? "").trim();
    if (!name) for (let i = 2; !name || !uniqueName(name); i++) name = `${a.name} ${i}`;
    if (!uniqueName(name)) return bad(c, `There is already an agent called ${name}.`, 409);
    const copy = db.createAgent({ name, role: a.role, description: a.description, kind: a.kind, provider: a.provider, model: a.model, tools: a.tools, spendCap: a.spendCap });
    copySkills(a.id, copy.id);
    if (fs.existsSync(p.agentPlugins(a.id))) fs.cpSync(p.agentPlugins(a.id), p.agentPlugins(copy.id), { recursive: true });
    const r = db.getRoutine(a.id);
    // The copy's routine starts paused so two agents don't fire the same job by surprise.
    if (r) db.setRoutine({ agentId: copy.id, cron: r.cron, skill: r.skill, instruction: r.instruction, enabled: false });
    await loadPlugins({ builtinDir: path.join(cfg.appRoot, "plugins"), hostDir: p.hostPlugins, agentsDir: p.agents });
    return c.json(agentView(copy));
  });

  app.get("/api/agents/:id/detail", (c) => {
    const a = db.getAgent(c.req.param("id"));
    if (!a) return bad(c, "No such agent.", 404);
    const routine = db.getRoutine(a.id);
    return c.json({
      agent: agentView(a),
      memories: db.listMemories(a.id),
      skills: listSkills(a.id).map(({ slug, name, description, body, updatedAt }) => ({ slug, name, description, body, updatedAt })),
      routine: routine ? { ...routine, nextRun: routine.enabled ? nextRun(routine.cron) : null } : null,
      tools: loadedToolsFor(a.id).map((t) => ({ name: t.name, description: t.description, plugin: t.plugin, gate: t.gate ?? false })),
    });
  });

  app.delete("/api/agents/:id/memories/:mid", (c) => {
    db.deleteMemory(c.req.param("id"), Number(c.req.param("mid")));
    return c.json({ ok: true });
  });

  app.delete("/api/agents/:id/skills/:slug", (c) => {
    deleteSkill(c.req.param("id"), c.req.param("slug"));
    return c.json({ ok: true });
  });

  app.put("/api/agents/:id/routine", async (c) => {
    const a = db.getAgent(c.req.param("id"));
    if (!a || a.kind === "worker") return bad(c, "No such agent.", 404);
    const b = await c.req.json();
    const cron = String(b.cron ?? "").trim();
    const err = validCron(cron);
    if (err) return bad(c, `That schedule doesn't parse: ${err}`);
    const skill = b.skill ? String(b.skill) : null;
    const instruction = String(b.instruction ?? "").trim();
    if (!skill && !instruction) return bad(c, "A routine needs a skill or an instruction.");
    db.setRoutine({ agentId: a.id, cron, skill, instruction, enabled: b.enabled !== false });
    scheduleRoutines();
    return c.json({ ok: true, nextRun: nextRun(cron) });
  });

  app.delete("/api/agents/:id/routine", (c) => {
    db.deleteRoutine(c.req.param("id"));
    scheduleRoutines();
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/routine/run", (c) => {
    if (!db.getRoutine(c.req.param("id"))) return bad(c, "No routine.", 404);
    void runRoutine(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/stop", (c) => {
    stopAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/agents/:id/shots/:file", (c) => {
    const file = c.req.param("file");
    if (!/^\d+\.jpg$/.test(file) || !/^[a-z0-9]+$/.test(c.req.param("id"))) return bad(c, "bad file");
    const full = path.join(p.shots(c.req.param("id")), file);
    if (!fs.existsSync(full)) return bad(c, "gone", 404);
    return c.body(fs.readFileSync(full), 200, { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" });
  });

  // ---------- the screen ----------

  app.get("/api/agents/:id/screen", (c) => {
    const id = c.req.param("id");
    if (!db.getAgent(id)) return bad(c, "No such agent.", 404);
    return streamSSE(c, async (stream) => {
      let stop: (() => void) | null = null;
      let alive = true;
      const onAction = (e: BusEvent) => {
        if (e.type === "screen_action" && e.agentId === id) void stream.writeSSE({ event: "action", data: JSON.stringify(e) });
      };
      bus.on("event", onAction);
      stream.onAbort(() => {
        alive = false;
      });
      await stream.writeSSE({ event: "viewport", data: JSON.stringify(VIEWPORT) });
      let on: boolean | null = null;
      while (alive) {
        const now = hasScreen(id);
        if (now !== on) {
          on = now;
          await stream.writeSSE({ event: "state", data: now ? "on" : "off" });
          stop?.();
          stop = now ? watchScreen(id, (f) => void stream.writeSSE({ event: "frame", data: f })) : null;
        }
        await stream.sleep(1000);
      }
      bus.off("event", onAction);
      stop?.();
    });
  });

  app.post("/api/agents/:id/screen/close", async (c) => {
    await closeScreen(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---------- threads ----------

  app.get("/api/threads/:thread/messages", (c) => {
    const thread = c.req.param("thread");
    if (!THREAD.test(thread)) return bad(c, "bad thread");
    const before = c.req.query("before");
    return c.json({ messages: db.threadMessages(thread, 150, before ? Number(before) : undefined) });
  });

  app.post("/api/threads/:thread/messages", async (c) => {
    const thread = c.req.param("thread");
    if (!THREAD.test(thread)) return bad(c, "bad thread");
    if (thread.startsWith("a:")) {
      const a = db.getAgent(thread.slice(2));
      if (!a || a.kind === "worker") return bad(c, "No such agent.", 404);
    } else if (!db.getGroup(thread.slice(2))) return bad(c, "No such group.", 404);
    const { text } = await c.req.json();
    if (!String(text ?? "").trim()) return bad(c, "Empty message.");
    return c.json(postUserMessage(thread, String(text).slice(0, 50_000)));
  });

  app.post("/api/threads/:thread/clear", (c) => {
    const thread = c.req.param("thread");
    if (!THREAD.test(thread)) return bad(c, "bad thread");
    db.clearThread(thread);
    return c.json({ ok: true });
  });

  app.post("/api/threads/:thread/retry", (c) => {
    const thread = c.req.param("thread");
    if (!thread.startsWith("a:") || !db.getAgent(thread.slice(2))) return bad(c, "bad thread");
    void runTurn(thread.slice(2), thread);
    return c.json({ ok: true });
  });

  app.post("/api/approvals/:id", async (c) => {
    const { decision } = await c.req.json();
    if (decision !== "approved" && decision !== "denied") return bad(c, "decision must be approved or denied");
    return decide(c.req.param("id"), decision) ? c.json({ ok: true }) : bad(c, "That question was already answered.", 409);
  });

  // ---------- groups ----------

  const validMembers = (ids: unknown) => {
    if (!Array.isArray(ids)) return null;
    const uniq = [...new Set(ids.map(String))].filter((id) => {
      const a = db.getAgent(id);
      return a && a.kind !== "worker";
    });
    return uniq.length >= 2 && uniq.length <= 6 ? uniq : null;
  };

  app.post("/api/groups", async (c) => {
    const b = await c.req.json();
    const members = validMembers(b.members);
    if (!members) return bad(c, "A group holds two to six agents.");
    const name = String(b.name ?? "").trim().slice(0, 60) || "Group";
    return c.json(db.createGroup(name, members));
  });

  app.patch("/api/groups/:id", async (c) => {
    const g = db.getGroup(c.req.param("id"));
    if (!g) return bad(c, "No such group.", 404);
    const b = await c.req.json();
    const members = b.members ? validMembers(b.members) : g.members;
    if (!members) return bad(c, "A group holds two to six agents.");
    db.updateGroup(g.id, String(b.name ?? g.name).slice(0, 60), members);
    return c.json(db.getGroup(g.id));
  });

  app.delete("/api/groups/:id", (c) => {
    db.deleteGroup(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---------- settings & providers ----------

  app.get("/api/settings", (c) =>
    c.json({
      mode: cfg.mode,
      dataDir: cfg.dataDir,
      workspace: p.workspace,
      providers: providerSettings(),
      catalog: PROVIDERS,
      keys: { openai: mask(keyOf("openai")), xai: mask(keyOf("xai")), compat: mask(keyOf("compat")) },
      available: availability(),
      chatgpt: chatgptStatus(),
      xai: xaiStatus(),
      xaiClientId: db.getSetting<string | null>("xaiClientId", null),
      privacy: {
        mode: privacyMode(),
        encryptionAtRest: false,
        telemetry: false,
        cloudAccountRequired: false,
      },
    }),
  );

  app.put("/api/settings/privacy", async (c) => {
    const { mode } = await c.req.json();
    if (!["fully-local", "self-hosted", "hybrid"].includes(mode)) return bad(c, "Unknown privacy mode.");
    setPrivacyMode(mode as PrivacyMode);
    return c.json({ ok: true, mode });
  });

  app.get("/api/audit", (c) => c.json({ events: db.listAudit(Number(c.req.query("limit") ?? 200)) }));

  app.get("/api/export", (c) => {
    const data = {
      ...db.exportPortable(),
      skills: Object.fromEntries(db.listAgents().map((a) => [a.id, listSkills(a.id)])),
      note: "Secrets are deliberately excluded.",
    };
    c.header("content-disposition", `attachment; filename="ants-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json(data);
  });

  app.get("/api/security", (c) => {
    const file = path.join(cfg.appRoot, "SECURITY.md");
    return fs.existsSync(file) ? c.body(fs.readFileSync(file, "utf8"), 200, { "content-type": "text/markdown; charset=utf-8" }) : bad(c, "Security model not found.", 404);
  });

  app.post("/api/wipe", async (c) => {
    const { confirmation } = await c.req.json();
    if (confirmation !== "WIPE ANTS") return bad(c, "Type WIPE ANTS exactly.");
    for (const a of db.listAgents()) await closeScreen(a.id);
    db.wipePrivateData();
    for (const name of secretNames()) if (!["auth", "chatgpt-host"].includes(name)) deleteSecret(name);
    fs.rmSync(p.workspace, { recursive: true, force: true });
    fs.rmSync(p.browser, { recursive: true, force: true });
    fs.mkdirSync(p.workspace, { recursive: true });
    fs.mkdirSync(p.browser, { recursive: true });
    for (const a of db.listAgents()) fs.rmSync(p.shots(a.id), { recursive: true, force: true });
    return c.json({ ok: true });
  });

  app.put("/api/settings/providers", async (c) => {
    const b = await c.req.json();
    const cur = providerSettings();
    const url = (u: unknown, fallback: string) => {
      const s = String(u ?? "").trim();
      if (!s) return fallback;
      if (!/^https?:\/\//.test(s)) throw new ProviderError("Base URLs start with http:// or https://");
      return s.replace(/\/$/, "");
    };
    const next = {
      openai: { baseUrl: url(b.openai?.baseUrl, cur.openai.baseUrl) },
      xai: { baseUrl: url(b.xai?.baseUrl, cur.xai.baseUrl) },
      compat: { baseUrl: url(b.compat?.baseUrl, cur.compat.baseUrl), label: String(b.compat?.label ?? cur.compat.label).slice(0, 40) },
      default: {
        provider: (b.default?.provider ?? cur.default.provider) || null,
        model: (b.default?.model ?? cur.default.model) || null,
      },
    };
    db.setSetting("providers", next);
    if (b.xaiClientId !== undefined) db.setSetting("xaiClientId", String(b.xaiClientId).trim() || null);
    bus.send({ type: "agents" });
    return c.json({ ok: true });
  });

  app.put("/api/keys/:provider", async (c) => {
    const prov = c.req.param("provider");
    if (!["openai", "xai", "compat"].includes(prov)) return bad(c, "unknown provider");
    const { key } = await c.req.json();
    const k = String(key ?? "").trim();
    if (k) writeSecret(`${prov}-key`, { key: k });
    else deleteSecret(`${prov}-key`);
    bus.send({ type: "providers" });
    return c.json({ ok: true, masked: mask(k || undefined) });
  });

  app.get("/api/providers/:id/models", async (c) => {
    const id = c.req.param("id") as ProviderId;
    if (!PROVIDERS.some((x) => x.id === id)) return bad(c, "unknown provider");
    try {
      return c.json({ models: await clientFor(id).listModels() });
    } catch (e: any) {
      return bad(c, e.message);
    }
  });

  app.post("/api/auth/chatgpt/start", (c) => {
    assertOutbound("https://auth.openai.com", { action: "ChatGPT OAuth" });
    if (cfg.mode === "server")
      return bad(
        c,
        "Sign in with ChatGPT on the machine that has your browser, then copy secrets/chatgpt-auth.json to this server's data folder over SSH. See the README.",
      );
    return c.json({ url: startChatGPTLogin(`http://127.0.0.1:${cfg.port}/auth/callback`) });
  });

  app.get("/auth/callback", async (c) => {
    const params = new URL(c.req.url).searchParams;
    try {
      await finishChatGPTLogin(params);
      bus.send({ type: "providers" });
      return c.redirect(`${uiOrigin}/settings?chatgpt=ok`);
    } catch (e: any) {
      log.warn("chatgpt sign-in failed:", e.message);
      return c.redirect(`${uiOrigin}/settings?chatgpt_error=${encodeURIComponent(e.message)}`);
    }
  });

  app.post("/api/auth/chatgpt/logout", (c) => {
    chatgptLogout();
    bus.send({ type: "providers" });
    return c.json({ ok: true });
  });

  app.post("/api/auth/xai/start", async (c) => {
    try {
      assertOutbound("https://auth.x.ai", { action: "xAI OAuth" });
      return c.json(await startXaiLogin());
    } catch (e: any) {
      return bad(c, e.message);
    }
  });

  app.post("/api/auth/xai/logout", (c) => {
    xaiLogout();
    return c.json({ ok: true });
  });

  // ---------- plugins ----------

  app.get("/api/plugins", (c) => c.json({ plugins: listPlugins() }));
  app.post("/api/plugins/reload", async (c) => {
    await loadPlugins({ builtinDir: path.join(cfg.appRoot, "plugins"), hostDir: p.hostPlugins, agentsDir: p.agents });
    bus.send({ type: "agents" });
    return c.json({ plugins: listPlugins() });
  });

  // ---------- live events ----------

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: BusEvent[] = [];
      let wake: (() => void) | null = null;
      const on = (e: BusEvent) => {
        // Worker chats are private to the run; the UI hears about them through the parent thread.
        if ((e.type === "message" || e.type === "delta") && e.thread.startsWith("a:")) {
          const a = db.getAgent(e.thread.slice(2));
          if (a?.kind === "worker") return;
        }
        if (e.type === "screen_action") return;
        queue.push(e);
        wake?.();
      };
      bus.on("event", on);
      let alive = true;
      stream.onAbort(() => {
        alive = false;
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (alive) {
        while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
        await new Promise<void>((r) => {
          if (queue.length || !alive) return r();
          wake = r;
          setTimeout(r, 20_000);
        });
        wake = null;
        if (!queue.length && alive) await stream.writeSSE({ event: "ping", data: "" });
      }
      bus.off("event", on);
    }),
  );

  // ---------- the UI ----------

  const webDir = path.join(cfg.appRoot, "dist", "web");
  if (fs.existsSync(webDir)) {
    app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), webDir) }));
    app.get("/favicon.svg", serveStatic({ path: path.relative(process.cwd(), path.join(webDir, "favicon.svg")) }));
    const index = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
    app.get("*", (c) => (c.req.path.startsWith("/api/") ? bad(c, "not found", 404) : c.html(index)));
  } else {
    app.get("/", (c) => c.text(cfg.dev ? "Dev mode: open the Vite URL (http://127.0.0.1:5173)." : "UI not built. Run `npm run build`."));
  }

  return app;
}
