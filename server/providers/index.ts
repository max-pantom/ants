import { readSecret } from "../secrets.js";
import { getSetting } from "../db.js";
import { CompatClient } from "./openai-compat.js";
import { ResponsesClient } from "./responses.js";
import { CHATGPT_API, chatgptAuth, chatgptToken, explainChatGPTError } from "./chatgpt.js";
import { markXaiRejected, xaiAuth, xaiOauthToken } from "./xai-device.js";
import { ProviderError, type ModelClient, type ModelRequest, type ProviderId } from "./types.js";

export * from "./types.js";

export interface ProviderSettings {
  openai: { baseUrl: string };
  xai: { baseUrl: string };
  compat: { baseUrl: string; label: string };
  default: { provider: ProviderId | null; model: string | null };
}

export const defaultProviderSettings: ProviderSettings = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  xai: { baseUrl: "https://api.x.ai/v1" },
  compat: { baseUrl: "http://127.0.0.1:11434/v1", label: "Local" },
  default: { provider: null, model: null },
};

export function providerSettings(): ProviderSettings {
  const s = getSetting<Partial<ProviderSettings>>("providers", {});
  return {
    openai: { ...defaultProviderSettings.openai, ...s.openai },
    xai: { ...defaultProviderSettings.xai, ...s.xai },
    compat: { ...defaultProviderSettings.compat, ...s.compat },
    default: { ...defaultProviderSettings.default, ...s.default },
  };
}

export const keyOf = (p: "openai" | "xai" | "compat") => readSecret<{ key: string }>(`${p}-key`)?.key;

/** Which ways in are usable right now. */
export function availability(): Record<ProviderId, boolean> {
  return {
    openai: !!keyOf("openai"),
    xai: !!keyOf("xai") || !!xaiAuth(),
    // A local server usually needs no key, so the compatible provider is always offered.
    compat: true,
    chatgpt: !!chatgptAuth(),
  };
}

/** xAI: subscription token first if present, key as the fallback. One fallback, never a loop. */
class XaiClient implements ModelClient {
  private s = providerSettings().xai;
  private viaKey = new CompatClient({ baseUrl: this.s.baseUrl, label: "xAI", token: async () => keyOf("xai") });
  private viaOauth = new CompatClient({ baseUrl: this.s.baseUrl, label: "xAI (subscription)", token: xaiOauthToken });

  private useOauth() {
    return !!xaiAuth() && !getSetting<string | null>("xaiOauthRejected", null);
  }

  private async run<T>(f: (c: CompatClient) => Promise<T>): Promise<T> {
    if (!this.useOauth()) {
      if (!keyOf("xai")) {
        throw new ProviderError(
          xaiAuth()
            ? "xAI rejected the subscription login earlier (403). Add an xAI API key in Settings to keep going."
            : "No xAI key or subscription login. Add one in Settings.",
        );
      }
      return f(this.viaKey);
    }
    try {
      return await f(this.viaOauth);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 403) {
        markXaiRejected(e.message);
        if (keyOf("xai")) return f(this.viaKey);
        throw new ProviderError(
          "xAI accepted the subscription login but refused inference (403). Some SuperGrok tiers are not allowed on the API. Add an xAI API key in Settings.",
          403,
        );
      }
      throw e;
    }
  }

  complete(req: ModelRequest) {
    return this.run((c) => c.complete(req));
  }
  listModels() {
    return this.run((c) => c.listModels());
  }
}

export function clientFor(provider: ProviderId): ModelClient {
  const s = providerSettings();
  switch (provider) {
    case "openai":
      return new CompatClient({
        baseUrl: s.openai.baseUrl,
        label: "OpenAI",
        token: async () => {
          const k = keyOf("openai");
          if (!k) throw new ProviderError("No OpenAI API key. Add one in Settings.");
          return k;
        },
      });
    case "xai":
      return new XaiClient();
    case "compat":
      return new CompatClient({ baseUrl: s.compat.baseUrl, label: s.compat.label || "Compatible endpoint", token: async () => keyOf("compat") });
    case "chatgpt":
      return new ResponsesClient({ baseUrl: CHATGPT_API, label: "ChatGPT", token: chatgptToken, explain: explainChatGPTError });
    default:
      throw new ProviderError(`Unknown provider ${provider}`);
  }
}

/** The host resolves an agent's provider and model. Empty fields fall back to the host default. */
export function resolveModel(agent: { provider: string | null; model: string | null }) {
  const d = providerSettings().default;
  const provider = (agent.provider || d.provider) as ProviderId | null;
  const model = agent.model || (provider === d.provider ? d.model : null) || d.model;
  if (!provider || !model) return null;
  return { provider, model };
}
