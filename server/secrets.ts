// Secrets are files, not rows. Every value in here is also fed to the redactor,
// which runs before any log line and before any message insert.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let dir = "";
// Cached with the file's mtime, so a credential file copied in over SSH is picked up live.
const cache = new Map<string, { v: unknown; mtime: number }>();
let known: string[] = [];
let refreshingKnown = false;

export function initSecrets(secretsDir: string) {
  dir = secretsDir;
  cache.clear();
  refreshKnown();
}

function file(name: string) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad secret name ${name}`);
  return path.join(dir, `${name}.json`);
}

export function readSecret<T = unknown>(name: string): T | undefined {
  let mtime: number;
  try {
    mtime = fs.statSync(file(name)).mtimeMs;
  } catch {
    cache.delete(name);
    return undefined;
  }
  const hit = cache.get(name);
  if (hit && hit.mtime === mtime) return hit.v as T;
  try {
    const v = JSON.parse(fs.readFileSync(file(name), "utf8")) as T;
    cache.set(name, { v, mtime });
    if (!refreshingKnown) refreshKnown();
    return v;
  } catch {
    return undefined;
  }
}

/** Atomic write, owner-only. */
export function writeSecret(name: string, value: unknown) {
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  cache.set(name, { v: value, mtime: fs.statSync(target).mtimeMs });
  refreshKnown();
}

export function deleteSecret(name: string) {
  try {
    fs.unlinkSync(file(name));
  } catch {}
  cache.delete(name);
  refreshKnown();
}

export function secretNames(): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// Field names that are identifiers, not secrets. Redacting them would only hide useful context.
const notSecret = new Set(["ext_agent_host_id", "client_id", "email", "sub", "scope", "expires_at", "baseUrl", "createdAt", "status"]);

function collect(v: unknown, key: string, out: Set<string>) {
  if (typeof v === "string") {
    if (!notSecret.has(key) && v.length >= 8) out.add(v);
  } else if (Array.isArray(v)) v.forEach((x) => collect(x, key, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collect(x, k, out);
}

function refreshKnown() {
  const out = new Set<string>();
  refreshingKnown = true;
  try {
    for (const name of secretNames()) collect(readSecret(name), name, out);
  } finally {
    refreshingKnown = false;
  }
  // Keys handed in through the environment count too.
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD/i.test(k)) out.add(v);
  }
  known = [...out].sort((a, b) => b.length - a.length);
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const s of known) if (out.includes(s)) out = out.split(s).join("[redacted]");
  return out;
}

/**
 * For streaming: redact, and also hold back a tail that could be the start of a secret,
 * so a key split across two deltas never reaches the browser half-way.
 */
export function redactStreaming(text: string): string {
  const out = redact(text);
  for (const s of known) {
    for (let n = Math.min(s.length - 1, out.length); n >= 4; n--) {
      if (out.endsWith(s.slice(0, n))) return out.slice(0, out.length - n);
    }
  }
  return out;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}
