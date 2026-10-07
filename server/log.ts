import { redact } from "./secrets.js";

// Every log line passes through the redactor. The failure we guard against is
// a key the model echoed, not a misconfigured logger.
function line(level: string, args: unknown[]) {
  const text = args
    .map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const out = `${new Date().toISOString()} ${level} ${redact(text)}\n`;
  (level === "error" ? process.stderr : process.stdout).write(out);
}

export const log = {
  info: (...a: unknown[]) => line("info", a),
  warn: (...a: unknown[]) => line("warn", a),
  error: (...a: unknown[]) => line("error", a),
};
