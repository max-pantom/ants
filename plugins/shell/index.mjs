import { spawn } from "node:child_process";

// The host's own secrets do not travel into child processes.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^ANTS_/.test(k) || /KEY|TOKEN|SECRET|PASSWORD/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export const tools = {
  run({ command, timeout_s = 60 }, ctx) {
    const timeout = Math.min(Math.max(timeout_s, 1), 600) * 1000;
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-lc", command], { cwd: ctx.workspace, env: cleanEnv() });
      let out = "";
      const add = (d) => {
        if (out.length < 60_000) out += d.toString();
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const kill = () => child.kill("SIGKILL");
      const timer = setTimeout(() => {
        out += `\n[killed after ${timeout / 1000}s]`;
        kill();
      }, timeout);
      ctx.signal.addEventListener("abort", kill, { once: true });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(`exit ${code}\n${out.slice(0, 30_000)}`);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve(`failed to start: ${e.message}`);
      });
    });
  },
};
