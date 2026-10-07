// One owner. Locally: the browser that `ants` opened gets a session through a one-time
// launch token in the URL. On a server: one password, set on first boot, and a session cookie.
import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { readSecret, writeSecret, randomToken } from "./secrets.js";
import type { Mode } from "./config.js";

const COOKIE = "ants_session";
const SESSION_DAYS = 30;

interface AuthFile {
  sessionKey: string;
  passwordHash?: string;
  salt?: string;
}

let mode: Mode = "local";
let launchToken = "";
let setupCode: string | null = null;

function authFile(): AuthFile {
  let a = readSecret<AuthFile>("auth");
  if (!a?.sessionKey) {
    a = { ...a, sessionKey: randomToken() };
    writeSecret("auth", a);
  }
  return a;
}

export function initAuth(m: Mode) {
  mode = m;
  launchToken = randomToken(24);
  authFile();
  if (m === "server" && !hasPassword()) {
    const env = process.env.ANTS_PASSWORD;
    if (env) setPassword(env);
    else setupCode = crypto.randomInt(100000, 999999).toString();
  }
  return { launchToken, setupCode };
}

export const hasPassword = () => !!readSecret<AuthFile>("auth")?.passwordHash;

export function setPassword(pw: string) {
  if (pw.length < 8) throw new Error("Use at least 8 characters.");
  const salt = randomToken(16);
  const passwordHash = crypto.scryptSync(pw, salt, 64).toString("base64url");
  // A new password also rotates the session key, which signs everyone out.
  writeSecret("auth", { sessionKey: randomToken(), passwordHash, salt });
  setupCode = null;
}

function checkPassword(pw: string) {
  const a = authFile();
  if (!a.passwordHash || !a.salt) return false;
  const got = crypto.scryptSync(pw, a.salt, 64);
  const want = Buffer.from(a.passwordHash, "base64url");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function sign(exp: number) {
  return crypto.createHmac("sha256", authFile().sessionKey).update(String(exp)).digest("base64url");
}

function issue(c: Context) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const secure = c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:");
  setCookie(c, COOKIE, `${exp}.${sign(exp)}`, { httpOnly: true, sameSite: "Lax", path: "/", secure, maxAge: SESSION_DAYS * 86400 });
}

export function isAuthed(c: Context) {
  const v = getCookie(c, COOKIE);
  if (!v) return false;
  const [exp, sig] = v.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = sign(Number(exp));
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

export function sessionInfo(c: Context) {
  return {
    mode,
    authed: isAuthed(c),
    needsSetup: mode === "server" && !hasPassword(),
  };
}

export function exchangeLaunchToken(c: Context, t: string) {
  if (mode !== "local") return false;
  const ok = t.length === launchToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(launchToken));
  if (ok) issue(c);
  return ok;
}

const failures = new Map<string, { n: number; until: number }>();
const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";

function tooMany(c: Context) {
  const f = failures.get(clientIp(c));
  return !!f && f.n >= 10 && f.until > Date.now();
}

function failed(c: Context) {
  const ip = clientIp(c);
  const f = failures.get(ip);
  failures.set(ip, { n: f && f.until > Date.now() ? f.n + 1 : 1, until: Date.now() + 15 * 60_000 });
}

export function login(c: Context, pw: string): string | null {
  if (tooMany(c)) return "Too many tries. Wait a few minutes.";
  if (mode === "local") return "Local mode has no password. Open the link `ants` printed.";
  if (!checkPassword(pw)) {
    failed(c);
    return "Wrong password.";
  }
  failures.delete(clientIp(c));
  issue(c);
  return null;
}

export function setup(c: Context, code: string, pw: string): string | null {
  if (mode !== "server" || hasPassword()) return "Already set up.";
  if (tooMany(c)) return "Too many tries. Wait a few minutes.";
  if (!setupCode || code.trim() !== setupCode) {
    failed(c);
    return "That setup code is wrong. It is printed in the server log.";
  }
  setPassword(pw);
  issue(c);
  return null;
}

export function logout(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Blocks DNS rebinding and cross-site writes, then requires a session for the API. */
export function guard(): MiddlewareHandler {
  const allowed = (process.env.ANTS_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const open = new Set(["/api/session", "/api/session/token", "/api/login", "/api/setup", "/api/logout"]);
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    const hostname = host.replace(/:\d+$/, "");
    if (mode === "local" && !LOCAL_HOSTS.has(hostname) && !allowed.includes(hostname)) {
      return c.text("Ants only answers on localhost.", 403);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin && new URL(origin).host !== host) return c.text("Cross-site request refused.", 403);
    }
    const p = c.req.path;
    if (p.startsWith("/api/") && !open.has(p) && !isAuthed(c)) return c.json({ error: "Sign in first." }, 401);
    return next();
  };
}
