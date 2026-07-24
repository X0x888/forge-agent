import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamDelta,
  ToolCall,
} from "./types.js";

/**
 * Merge a streamed tool-name delta into the accumulator.
 *
 * Providers differ: some send one full name, some re-send the full name on
 * every chunk, some send growing prefixes, some send true fragments.
 * Naive `+=` turns a repeated full name into `bashbash` (broken tools).
 */
export function mergeStreamedToolName(current: string, delta: string): string {
  if (!delta) return current;
  if (!current) return delta;
  if (delta === current) return current;
  if (delta.startsWith(current)) return delta; // growing prefix
  if (current.startsWith(delta)) return current; // shorter re-send
  // True fragment append (rare for names, common pattern for args)
  return current + delta;
}

/**
 * OpenAI-compatible chat completions client.
 * Works with xAI, OpenAI, OpenRouter, Google OpenAI-compat endpoint, and custom proxies.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  private baseUrl: string;
  private apiKey: string;
  private extraHeaders: Record<string, string>;

  constructor(opts: {
    id: string;
    baseUrl: string;
    apiKey: string;
    extraHeaders?: Record<string, string>;
  }) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream,
    };
    if (req.reasoning_effort) {
      body.reasoning_effort = req.reasoning_effort;
    }
    return body;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(req, false);
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${this.id} API error ${resp.status}: ${text.slice(0, 800)}`);
    }
    const json = (await resp.json()) as {
      id: string;
      model: string;
      choices: Array<{
        message: ChatMessage;
        finish_reason: string | null;
      }>;
      usage?: ChatResponse["usage"];
    };
    const choice = json.choices[0];
    return {
      id: json.id,
      model: json.model,
      message: choice.message,
      finish_reason: choice.finish_reason,
      usage: json.usage,
    };
  }

  async chatStream(
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
  ): Promise<ChatResponse> {
    const body = this.buildBody(req, true);
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${this.id} API error ${resp.status}: ${text.slice(0, 800)}`);
    }
    if (!resp.body) throw new Error("No response body for stream");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls: ToolCall[] = [];
    let finishReason: string | null = null;
    let id = "";
    let model = req.model;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as {
            id?: string;
            model?: string;
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: "function";
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          };
          if (chunk.id) id = chunk.id;
          if (chunk.model) model = chunk.model;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (delta.content) {
            content += delta.content;
            onDelta({ content: delta.content });
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) {
                // Start empty — never seed name then append (xAI/OpenAI often
                // re-send the full name each chunk → "bashbash").
                toolCalls[idx] = {
                  id: tc.id || `call_${idx}`,
                  type: "function",
                  function: { name: "", arguments: "" },
                };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) {
                toolCalls[idx].function.name = mergeStreamedToolName(
                  toolCalls[idx].function.name,
                  tc.function.name,
                );
              }
              if (tc.function?.arguments) {
                toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
            onDelta({ tool_calls: delta.tool_calls });
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            onDelta({ finish_reason: choice.finish_reason });
          }
        } catch {
          /* skip malformed SSE */
        }
      }
    }

    const message: ChatMessage = {
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    return {
      id: id || `chatcmpl_${Date.now()}`,
      model,
      message,
      finish_reason: finishReason,
    };
  }
}
