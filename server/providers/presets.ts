// Hosted providers that speak the OpenAI chat-completions dialect. Each one is the same
// CompatClient pointed at a different base URL with its own API key, so adding one is a row here.
export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  /** Where the user creates a key. Shown in Settings. */
  keyUrl: string;
}

export const PRESETS: Preset[] = [
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", keyUrl: "https://api.together.ai/settings/api-keys" },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);
