// xAI device-code login (RFC 8628) for SuperGrok / X Premium+.
// This is the flow other open-source hosts use; it is not a partner program.
// Inference still goes to https://api.x.ai/v1. Some tiers get 403 there even after a
// good login, so the key is the path that always works. We never retry a 403 in a loop.
import { readSecret, writeSecret, deleteSecret } from "../secrets.js";
import { getSetting, setSetting } from "../db.js";
import { bus } from "../bus.js";
import { log } from "../log.js";
import { errorText } from "./sse.js";
import { ProviderError } from "./types.js";
import { assertOutbound } from "../privacy.js";

const DISCOVERY = "https://auth.x.ai/.well-known/openid-configuration";
const SCOPE = "openid profile email offline_access api:access";

export interface XaiAuth {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  client_id: string;
}

type LoginState =
  | { state: "idle" }
  | { state: "waiting"; userCode: string; url: string; expiresAt: number }
  | { state: "done" }
  | { state: "error"; error: string };

let login: LoginState = { state: "idle" };
let endpoints: { device: string; token: string } | null = null;

export function xaiClientId(): string | undefined {
  return process.env.ANTS_XAI_CLIENT_ID || getSetting<string | null>("xaiClientId", null) || undefined;
}

async function discover() {
  if (endpoints) return endpoints;
  assertOutbound(DISCOVERY, { action: "xAI OAuth discovery" });
  const res = await fetch(DISCOVERY);
  if (!res.ok) throw new Error(`xAI discovery failed (${res.status})`);
  const j: any = await res.json();
  endpoints = { device: j.device_authorization_endpoint, token: j.token_endpoint };
  return endpoints;
}

export function xaiAuth() {
  return readSecret<XaiAuth>("xai-oauth");
}

export function xaiStatus() {
  const a = xaiAuth();
  return {
    signedIn: !!a,
    clientIdSet: !!xaiClientId(),
    login: login.state === "waiting" ? login : { state: login.state, ...(login.state === "error" ? { error: login.error } : {}) },
    rejected: getSetting<string | null>("xaiOauthRejected", null),
  };
}

export function xaiLogout() {
  deleteSecret("xai-oauth");
  setSetting("xaiOauthRejected", null);
  login = { state: "idle" };
  bus.send({ type: "providers" });
}

export async function startXaiLogin() {
  const clientId = xaiClientId();
  if (!clientId) throw new Error("Set the xAI OAuth client id first (Settings → xAI, or ANTS_XAI_CLIENT_ID).");
  const ep = await discover();
  assertOutbound(ep.device, { action: "xAI device authorization" });
  const res = await fetch(ep.device, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`xAI device login failed (${res.status}): ${(await errorText(res)).message}`);
  const d: any = await res.json();
  const url = d.verification_uri_complete ?? d.verification_uri;
  login = { state: "waiting", userCode: d.user_code, url, expiresAt: Date.now() + (d.expires_in ?? 600) * 1000 };
  bus.send({ type: "providers" });
  void poll(ep.token, clientId, d.device_code, (d.interval ?? 5) * 1000, login.expiresAt);
  return { userCode: d.user_code, url };
}

async function poll(tokenUrl: string, clientId: string, deviceCode: string, interval: number, expiresAt: number) {
  while (Date.now() < expiresAt && login.state === "waiting") {
    await new Promise((r) => setTimeout(r, interval));
    try {
      assertOutbound(tokenUrl, { action: "xAI device token" });
    } catch (e: any) {
      login = { state: "error", error: e.message };
      bus.send({ type: "providers" });
      return;
    }
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: clientId }),
    }).catch(() => null);
    if (!res) continue;
    if (res.ok) {
      const t: any = await res.json();
      writeSecret("xai-oauth", {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: Date.now() + (t.expires_in ?? 21600) * 1000,
        client_id: clientId,
      } satisfies XaiAuth);
      setSetting("xaiOauthRejected", null);
      login = { state: "done" };
      bus.send({ type: "providers" });
      return;
    }
    const e = await errorText(res);
    if (e.code === "authorization_pending" || /authorization_pending/.test(e.message)) continue;
    if (e.code === "slow_down" || /slow_down/.test(e.message)) {
      interval += 5000;
      continue;
    }
    login = { state: "error", error: e.message || e.code || `HTTP ${res.status}` };
    bus.send({ type: "providers" });
    return;
  }
  if (login.state === "waiting") {
    login = { state: "error", error: "The code expired before it was approved." };
    bus.send({ type: "providers" });
  }
}

/** Access token for api.x.ai, refreshed once if needed. Undefined if not signed in. */
export async function xaiOauthToken(): Promise<string | undefined> {
  const a = xaiAuth();
  if (!a) return undefined;
  if (a.expires_at - Date.now() > 60_000) return a.access_token;
  if (!a.refresh_token) return undefined;
  const ep = await discover();
  assertOutbound(ep.token, { action: "xAI token refresh" });
  const res = await fetch(ep.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: a.client_id }),
  });
  if (!res.ok) {
    log.warn("xai oauth refresh failed", res.status);
    throw new ProviderError("xAI subscription login expired and could not be refreshed. Sign in again or use an API key.", 401);
  }
  const t: any = await res.json();
  const next: XaiAuth = {
    ...a,
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? a.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 21600) * 1000,
  };
  writeSecret("xai-oauth", next);
  return next.access_token;
}

export function markXaiRejected(message: string) {
  setSetting("xaiOauthRejected", message);
  bus.send({ type: "providers" });
}
