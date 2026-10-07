// The model client is one interface. Three ways in sit behind it:
// an API key (OpenAI, xAI, any OpenAI-compatible URL), Sign in with ChatGPT,
// and xAI device login. An agent stores a provider id and a model id; the host resolves it.

export type ChatMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: { id: string; name: string; args: string }[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  messages: ChatMsg[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onText?: (fullTextSoFar: string) => void;
}

export interface ModelResult {
  text: string;
  toolCalls: { id: string; name: string; args: string }[];
}

export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelResult>;
  listModels(): Promise<string[]>;
}

/** An error with a message that is safe and useful to show in the chat. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
  }
}

export type ProviderId = "openai" | "xai" | "compat" | "chatgpt";

export const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "openai", label: "OpenAI (API key)" },
  { id: "xai", label: "xAI / Grok" },
  { id: "compat", label: "OpenAI-compatible" },
  { id: "chatgpt", label: "ChatGPT plan (official preview)" },
];
