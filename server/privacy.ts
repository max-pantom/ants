import net from "node:net";
import { addAudit, getSetting, setSetting } from "./db.js";

export type PrivacyMode = "fully-local" | "self-hosted" | "hybrid";

let deployment: "local" | "server" = "local";

export function initPrivacy(mode: "local" | "server") {
  deployment = mode;
}

export function privacyMode(): PrivacyMode {
  return getSetting<PrivacyMode>("privacyMode", deployment === "server" ? "self-hosted" : "fully-local");
}

export function setPrivacyMode(mode: PrivacyMode) {
  setSetting("privacyMode", mode);
}

export function isLocalUrl(raw: string) {
  try {
    const u = new URL(raw);
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || net.isIP(h) === 4 && h.startsWith("127.") || h === "::1";
  } catch {
    return false;
  }
}

/** Fully-local and self-hosted modes fail closed for public-network destinations. */
export function assertOutbound(raw: string, detail: { action: string; agentId?: string; agentName?: string; bytes?: number } = { action: "request" }) {
  const allowed = privacyMode() === "hybrid" || isLocalUrl(raw);
  addAudit({
    agentId: detail.agentId ?? null,
    agentName: detail.agentName ?? null,
    kind: "outbound",
    action: detail.action,
    target: raw,
    risk: 2,
    approval: "policy",
    bytesSent: detail.bytes ?? 0,
    status: allowed ? "ok" : "blocked",
  });
  if (allowed) return;
  throw new Error(`Privacy mode ${privacyMode()} blocks public-network requests. Switch to Hybrid in Settings → Privacy to contact ${new URL(raw).host}.`);
}
