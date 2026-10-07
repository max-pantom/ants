import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export type Mode = "local" | "server";

export interface Config {
  mode: Mode;
  dev: boolean;
  host: string;
  port: number;
  dataDir: string;
  openBrowser: boolean;
  headful: boolean;
  /** Repo root, so built-in plugins and the built web UI can be found in dev and prod. */
  appRoot: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// server/ in dev (tsx), dist/server/ in prod. Walk up to the folder with package.json.
function findAppRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function parseConfig(argv: string[]): Config {
  const args = argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string) => args.includes(`--${name}`);
  const serverMode = args[0] === "serve" || process.env.ANTS_MODE === "server";
  const dev = has("dev");

  const defaultData = serverMode
    ? "/var/lib/ants"
    : dev
      ? path.join(findAppRoot(here), ".ants-dev")
      : path.join(os.homedir(), ".ants");

  return {
    mode: serverMode ? "server" : "local",
    dev,
    // Bind localhost even on a server. Put a reverse proxy in front for a public name.
    host: flag("host") ?? process.env.ANTS_HOST ?? "127.0.0.1",
    port: Number(flag("port") ?? process.env.ANTS_PORT ?? 4747),
    dataDir: path.resolve(flag("data") ?? process.env.ANTS_DATA ?? defaultData),
    openBrowser: !serverMode && !has("no-open") && !dev,
    headful: has("headful") || process.env.ANTS_HEADFUL === "1",
    appRoot: findAppRoot(here),
  };
}

export const paths = (dataDir: string) => ({
  db: path.join(dataDir, "ants.db"),
  secrets: path.join(dataDir, "secrets"),
  agents: path.join(dataDir, "agents"),
  agent: (id: string) => path.join(dataDir, "agents", id),
  skills: (id: string) => path.join(dataDir, "agents", id, "skills"),
  agentPlugins: (id: string) => path.join(dataDir, "agents", id, "plugins"),
  shots: (id: string) => path.join(dataDir, "agents", id, "shots"),
  hostPlugins: path.join(dataDir, "plugins"),
  // One cookie jar for the whole machine. Screens are pages inside it.
  browser: path.join(dataDir, "browser"),
  // The shared disk agents work on.
  workspace: path.join(dataDir, "workspace"),
});

export function ensureDirs(dataDir: string) {
  const p = paths(dataDir);
  for (const d of [dataDir, p.agents, p.hostPlugins, p.browser, p.workspace]) fs.mkdirSync(d, { recursive: true });
  // Transcripts live in here. Owner only.
  fs.chmodSync(dataDir, 0o700);
  fs.mkdirSync(p.secrets, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.secrets, 0o700);
}
