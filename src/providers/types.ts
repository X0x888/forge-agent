export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Multimodal user content (vision) — used on outbound ChatRequest only. */
export type ChatContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    };

export interface ChatMessage {
  role: Role;
  /** Session history stays string; vision parts are expanded only on ChatRequest. */
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /**
   * Reasoning-model thought trace (xAI `reasoning_content`). Must be
   * replayed on the next request or the prefix cache misses. Thought text
   * is never painted — the TUI shows a count-only `think ›` landmark.
   */
  reasoning_content?: string;
}

/** Outbound message (may include image parts after vision expand). */
export type OutboundChatMessage = Omit<ChatMessage, "content"> & {
  content: string | ChatContentPart[] | null;
};

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
  messages: OutboundChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /**
   * Sticky conversation id for xAI prefix cache (`x-grok-conv-id`).
   * Same session → same shard. Other providers ignore it.
   */
  conversationId?: string;
  /**
   * Reasoning / thinking effort when the model supports it.
   * Sent as top-level `reasoning_effort` (and OpenRouter `reasoning.effort`).
   * Omit when the model does not support it.
   */
  reasoning_effort?:
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  /**
   * Session context budget (tokens). Cursor maps ≥1M, or a window above the
   * hosted default (Cursor Grok 256k → 500k pin), onto AgentService `max_mode`.
   * Other providers ignore it.
   */
  context_window?: number;
  /**
   * Absolute workspace root. Cursor AgentService RequestContext.env uses this
   * as workspace_paths / process_working_directory; omitting it lets the
   * backend invent a stale IDE cwd.
   */
  workspace?: string;
  /**
   * OpenAI-compat / xAI `tool_choice`. `required` after a thought-only Stop
   * so the next turn cannot be another silent judge.
   */
  tool_choice?: "auto" | "required";
  /**
   * Cursor: close the held-open AgentService Run and open a new one with
   * the (pruned) conversation_history. Tool continuations still resume the
   * live stream. Other providers ignore it.
   */
  rebaseConversation?: boolean;
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
  /** Reasoning delta — captured for replay; UI gets a char count only. */
  reasoning_content?: string;
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
