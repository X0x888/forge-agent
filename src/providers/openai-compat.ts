import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamDelta,
  ToolCall,
} from "./types.js";
import { throwIfNotOk } from "./errors.js";
import { mergeAbortSignals, providerTimeoutMs } from "../util/abort.js";

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

  updateCredentials(token: string): void {
    this.apiKey = token;
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
    // OpenAI-compatible: without this, streaming responses often omit usage
    // and /cost + session totals stay wrong for long expert sessions.
    if (stream) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = this.buildBody(req, false);
    const { signal: merged, dispose } = mergeAbortSignals(
      signal,
      providerTimeoutMs(),
    );
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: merged,
      });
      await throwIfNotOk(this.id, resp);
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
      if (!choice) {
        throw new Error(`${this.id} API error: empty choices array`);
      }
      return {
        id: json.id,
        model: json.model,
        message: choice.message,
        finish_reason: choice.finish_reason,
        usage: json.usage,
      };
    } catch (err) {
      rethrowAbort(err, signal);
      throw err;
    } finally {
      dispose();
    }
  }

  async chatStream(
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const body = this.buildBody(req, true);
    const { signal: merged, dispose } = mergeAbortSignals(
      signal,
      providerTimeoutMs(),
    );
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: merged,
      });
    } catch (err) {
      dispose();
      rethrowAbort(err, signal);
      throw err;
    }
    try {
      await throwIfNotOk(this.id, resp);
    } catch (err) {
      dispose();
      throw err;
    }
    if (!resp.body) {
      dispose();
      throw new Error("No response body for stream");
    }

    const reader = resp.body.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    if (merged.aborted) {
      onAbort();
      dispose();
      rethrowAbort(merged.reason ?? new Error("Aborted"), signal);
      throw new Error("Aborted");
    }
    merged.addEventListener("abort", onAbort, { once: true });

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls: ToolCall[] = [];
    let finishReason: string | null = null;
    let id = "";
    let model = req.model;
    let usage: ChatResponse["usage"] | undefined;

    try {
      while (true) {
        if (merged.aborted) {
          rethrowAbort(merged.reason ?? new Error("Aborted"), signal);
          throw new Error("Aborted");
        }
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
              usage?: ChatResponse["usage"];
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
            if (chunk.usage) usage = chunk.usage;
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
          } catch (err) {
            if ((err as Error).message === "Aborted") throw err;
            if (/timed out after/i.test((err as Error).message || "")) throw err;
            /* skip malformed SSE */
          }
        }
      }
    } catch (err) {
      rethrowAbort(err, signal);
      throw err;
    } finally {
      merged.removeEventListener("abort", onAbort);
      dispose();
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }

    // Compact sparse toolCalls array (providers may skip indices)
    const compactTools = toolCalls.filter(Boolean);

    const message: ChatMessage = {
      role: "assistant",
      content: content || null,
      tool_calls: compactTools.length > 0 ? compactTools : undefined,
    };
    return {
      id: id || `chatcmpl_${Date.now()}`,
      model,
      message,
      finish_reason: finishReason,
      usage,
    };
  }
}

/** Map AbortError / timeout reason into a clear Error for the retry layer. */
function rethrowAbort(err: unknown, userSignal?: AbortSignal): void {
  if (userSignal?.aborted) {
    throw new Error("Aborted");
  }
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err ?? "");
  if (/timed out after \d+ms/i.test(msg)) {
    throw new Error(msg);
  }
  if (
    (err &&
      typeof err === "object" &&
      "name" in err &&
      String((err as { name?: string }).name) === "AbortError") ||
    /abort/i.test(msg)
  ) {
    // fetch abort without user signal → treat as timeout-ish network abort
    if (/timed out/i.test(msg)) throw new Error(msg);
    throw new Error(msg || "Aborted");
  }
}
