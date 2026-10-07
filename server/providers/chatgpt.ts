// Sign in with ChatGPT, open-source flow (developers.openai.com/siwc/token-sharing-open-source).
// No client secret, no API key. The first sign-in uses client_id=dynamic_agent_client and
// OpenAI issues a client_id bound to this user, which we keep and reuse.
//
// Terms that shape this file: requests come from this host for this user only. The token is
// never proxied to other tools. A laptop and a VPS may share the client_id, never the host id.
import crypto from "node:crypto";
import { readSecret, writeSecret, deleteSecret } from "../secrets.js";
import { log } from "../log.js";
import { errorText } from "./sse.js";
import { ProviderError } from "./types.js";
import { assertOutbound } from "../privacy.js";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
export const CHATGPT_API = "https://api.openai.com/v1";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";

interface HostFile {
  ext_agent_host_id: string;
}

export interface ChatGPTAuth {
  client_id: string;
  ext_agent_host_id: string;
  email?: string;
  sub?: string;
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_at: number;
}

/** Stable for the life of this install. Generated on first launch. Never copied to another machine. */
export function hostId(): string {
  let h = readSecret<HostFile>("chatgpt-host");
  if (!h?.ext_agent_host_id) {
    h = { ext_agent_host_id: `urn:uuid:${crypto.randomUUID()}` };
    writeSecret("chatgpt-host", h);
  }
  return h.ext_agent_host_id;
}

export function chatgptAuth(): ChatGPTAuth | undefined {
  return readSecret<ChatGPTAuth>("chatgpt-auth");
}

export function chatgptStatus() {
  const a = chatgptAuth();
  if (!a) return { signedIn: false as const, hostId: hostId() };
  return {
    signedIn: true as const,
    email: a.email,
    planUsage: (a.scope ?? "").split(/\s+/).includes(PLAN_SCOPE),
    clientId: a.client_id,
    hostId: hostId(),
    // The credential file came from another install: refresh still works, but say so.
    importedFromOtherHost: a.ext_agent_host_id !== hostId(),
  };
}

export function chatgptLogout() {
  // Keep the issued client_id so the next sign-in reuses the same registered agent.
  const a = chatgptAuth();
  deleteSecret("chatgpt-auth");
  if (a?.client_id) writeSecret("chatgpt-client", { client_id: a.client_id });
}

// ---------- authorization code + PKCE ----------

const pending = new Map<string, { nonce: string; verifier: string; redirectUri: string; createdAt: number }>();

const b64url = (b: Buffer) => b.toString("base64url");

export function startChatGPTLogin(redirectUri: string): string {
  for (const [k, v] of pending) if (Date.now() - v.createdAt > 10 * 60_000) pending.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  pending.set(state, { nonce, verifier, redirectUri, createdAt: Date.now() });

  const saved = chatgptAuth()?.client_id ?? readSecret<{ client_id: string }>("chatgpt-client")?.client_id;
  const q = new URLSearchParams({
    client_id: saved ?? "dynamic_agent_client",
    ext_agent_host_id: hostId(),
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  if (!saved) q.set("agent_name_hint", "Ants");
  const prev = chatgptAuth();
  if (prev?.id_token) q.set("id_token_hint", prev.id_token);
  if (prev?.email) q.set("login_hint", prev.email);
  return `${AUTHORIZE}?${q}`;
}

export async function finishChatGPTLogin(params: URLSearchParams): Promise<ChatGPTAuth> {
  const err = params.get("error");
  if (err) throw new Error(params.get("error_description") ?? err);
  const state = params.get("state") ?? "";
  const p = pending.get(state);
  if (!p) throw new Error("This sign-in link expired or was already used. Start again from Settings.");
  pending.delete(state);

  const clientId =
    params.get("client_id") ?? chatgptAuth()?.client_id ?? readSecret<{ client_id: string }>("chatgpt-client")?.client_id;
  if (!clientId) throw new Error("OpenAI did not return an issued client_id.");

  assertOutbound(TOKEN, { action: "ChatGPT token exchange" });
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: params.get("code") ?? "",
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      resource: RESOURCE,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await errorText(res)).message}`);
  const t: any = await res.json();

  const claims = t.id_token ? await verifyIdToken(t.id_token, clientId, p.nonce) : {};
  const scope: string = t.scope ?? params.get("scope") ?? "";
  const auth: ChatGPTAuth = {
    client_id: clientId,
    ext_agent_host_id: hostId(),
    email: claims.email,
    sub: claims.sub,
    id_token: t.id_token,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    scope,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
  writeSecret("chatgpt-auth", auth);
  if (scope && !scope.split(/\s+/).includes(PLAN_SCOPE)) {
    log.warn("chatgpt sign-in succeeded without plan usage scope");
  }
  return auth;
}

let refreshing: Promise<string> | null = null;

/** A fresh access token, refreshing once if it is about to expire. */
export async function chatgptToken(): Promise<string> {
  const a = chatgptAuth();
  if (!a) throw new ProviderError("Not signed in with ChatGPT. Open Settings to sign in, or switch this agent to an API key.");
  if (a.expires_at - Date.now() > 60_000) return a.access_token;
  if (!a.refresh_token) throw new ProviderError("ChatGPT sign-in expired. Sign in again from Settings.", 401);
  refreshing ??= (async () => {
    try {
      assertOutbound(TOKEN, { action: "ChatGPT token refresh" });
      const res = await fetch(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: a.client_id, refresh_token: a.refresh_token!, resource: RESOURCE }),
      });
      if (!res.ok) {
        const e = await errorText(res);
        throw new ProviderError(`ChatGPT sign-in could not be refreshed (${e.message}). Sign in again from Settings.`, res.status);
      }
      const t: any = await res.json();
      const next: ChatGPTAuth = {
        ...a,
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? a.refresh_token,
        id_token: t.id_token ?? a.id_token,
        scope: t.scope ?? a.scope,
        expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
      };
      writeSecret("chatgpt-auth", next);
      return next.access_token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export function explainChatGPTError(status: number, code: string | undefined, message: string): string | undefined {
  if (code === "subscription_sharing_usage_limit_exceeded")
    return "Your ChatGPT plan allowance is used up for now. Check chatgpt.com/settings/usage, or switch this agent to an API key in Settings.";
  if (code === "subscription_sharing_usage_unavailable")
    return "ChatGPT plan usage isn't available for this account right now. Switch this agent to an API key in Settings.";
  if (status === 401) return "ChatGPT sign-in was rejected. Sign in again from Settings.";
  if (status === 403) return `ChatGPT refused this request (403): ${message}`;
  return undefined;
}

// ---------- ID token validation ----------

let jwksCache: { keys: any[]; at: number } | null = null;

async function jwks(): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  assertOutbound(JWKS, { action: "ChatGPT signing keys" });
  const res = await fetch(JWKS);
  if (!res.ok) throw new Error(`Could not load OpenAI signing keys (${res.status})`);
  jwksCache = { keys: ((await res.json()) as any).keys ?? [], at: Date.now() };
  return jwksCache.keys;
}

async function verifyIdToken(token: string, clientId: string, nonce: string): Promise<any> {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("ID token signed with an unknown key");
  if (header.alg !== "RS256") throw new Error(`Unexpected ID token alg ${header.alg}`);
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("ID token signature is invalid");
  if (claims.iss !== ISSUER) throw new Error("ID token issuer mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error("ID token audience mismatch");
  if (claims.exp * 1000 < Date.now() - 60_000) throw new Error("ID token expired");
  if (claims.nonce !== nonce) throw new Error("ID token nonce mismatch");
  return claims;
}
