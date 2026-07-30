export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /**
   * xAI reasoning models (e.g. grok-4.5). Sent as top-level `reasoning_effort`
   * on chat/completions. Omit when the model does not support it.
   */
  reasoning_effort?: "low" | "medium" | "high";
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Anthropic prompt caching: tokens read from cache (0.1× input price). */
  cache_read_input_tokens?: number;
  /** Anthropic prompt caching: tokens written to cache (1.25× input price). */
  cache_creation_input_tokens?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  message: ChatMessage;
  finish_reason: string | null;
  usage?: ChatUsage;
}

export interface StreamDelta {
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
  finish_reason?: string | null;
}

export interface LLMProvider {
  readonly id: string;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  chatStream(
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
  /**
   * Hot-swap bearer / API key after OAuth refresh without rebuilding the client.
   * Optional — providers that ignore it simply cannot recover mid-session from 401.
   */
  updateCredentials?(token: string): void;
}
