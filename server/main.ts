// One process. Locally it binds 127.0.0.1 and opens the browser; that is the app.
// `ants serve` binds the same way on a server and asks for a password.
import path from "node:path";
import { spawn } from "node:child_process";

// node:sqlite still prints an experimental warning on some Node 22/24 builds. Keep the log clean.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: any, ...rest: any[]) => {
  if (String(w?.message ?? w).includes("SQLite")) return;
  return emitWarning(w, ...rest);
}) as typeof process.emitWarning;

const { serve } = await import("@hono/node-server");
const { parseConfig, ensureDirs, paths } = await import("./config.js");
const { initSecrets } = await import("./secrets.js");
const db = await import("./db.js");
const { initAuth } = await import("./auth.js");
const { initPrivacy } = await import("./privacy.js");
const { initScreens, shutdownScreens } = await import("./screen.js");
const { initSkills } = await import("./skills.js");
const { initLoop } = await import("./loop.js");
const { registerCoreTools, DEFAULT_AGENT_TOOLS } = await import("./tools/core.js");
const { loadPlugins } = await import("./tools/registry.js");
const { scheduleRoutines } = await import("./routines.js");
const { hostId } = await import("./providers/chatgpt.js");
const { createApp } = await import("./app.js");
const { log } = await import("./log.js");

const cfg = parseConfig(process.argv);
const p = paths(cfg.dataDir);

if (process.argv[2] === "password") {
  // `ants password <new>` resets the server password from a shell on the box.
  ensureDirs(cfg.dataDir);
  initSecrets(p.secrets);
  const { setPassword } = await import("./auth.js");
  setPassword(process.argv[3] ?? "");
  console.log("Password updated. Existing sessions are signed out.");
  process.exit(0);
}

ensureDirs(cfg.dataDir);
initSecrets(p.secrets);
db.openDb(p.db);
initPrivacy(cfg.mode);
hostId();

// First run: one agent already exists, so the empty state is a message, not a form.
if (db.listAgents().length === 0) {
  const ada = db.createAgent({
    name: "Ada",
    role: "A capable generalist. Researches on the web, drafts, and gets things done in files and the browser.",
    tools: DEFAULT_AGENT_TOOLS,
  });
  db.insertMessage({
    thread: `a:${ada.id}`,
    agentId: ada.id,
    role: "assistant",
    content:
      "Hi, I'm Ada. I have my own screen on this machine and a shared folder with any agents you add later. Tell me what you need. If I don't have a model yet, I'll point you to Settings.",
  });
}

const { launchToken, setupCode } = initAuth(cfg.mode);
initScreens({ dataDir: cfg.dataDir, headful: cfg.headful });
initSkills(cfg.dataDir);
initLoop({ workspace: p.workspace, forbidden: [p.secrets, p.db] });
registerCoreTools();
await loadPlugins({ builtinDir: path.join(cfg.appRoot, "plugins"), hostDir: p.hostPlugins, agentsDir: p.agents });
scheduleRoutines();

const app = createApp(cfg);
const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, () => {
  const base = `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}`;
  log.info(`ants ${cfg.mode} mode, data in ${cfg.dataDir}`);
  if (cfg.mode === "local") {
    const ui = cfg.dev ? "http://127.0.0.1:5173" : base;
    const url = `${ui}/?t=${launchToken}`;
    // The launch token is printed on purpose; it is how this browser gets a session.
    process.stdout.write(`\n  Ants is running: ${url}\n\n`);
    if (cfg.openBrowser) openBrowser(url);
  } else {
    process.stdout.write(`\n  Ants is listening on ${base}\n`);
    if (setupCode) process.stdout.write(`  First boot. Open the site and enter setup code ${setupCode} to set the password.\n`);
    process.stdout.write("\n");
  }
});

server.on("error", (e: any) => {
  if (e.code === "EADDRINUSE") log.error(`Port ${cfg.port} is busy. Is Ants already running? Use --port to pick another.`);
  else log.error(e);
  process.exit(1);
});

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  log.info("shutting down");
  await shutdownScreens();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
