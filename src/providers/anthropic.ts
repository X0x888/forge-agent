import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LLMProvider,
  StreamDelta,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { throwIfNotOk } from "./errors.js";
import { parseToolArguments } from "../util/json-repair.js";
import { mergeAbortSignals, providerTimeoutMs } from "../util/abort.js";

/**
 * Map Anthropic stop_reason → OpenAI-compat finish_reason used by the agent loop.
 * `refusal` becomes `content_filter` so steerage/cap paths apply.
 */
export function mapAnthropicStopReason(
  stopReason: string | null | undefined,
): string | null {
  if (stopReason == null || stopReason === "") return stopReason ?? null;
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "refusal") return "content_filter";
  return stopReason;
}

/** Prompt caching is on by default; FORGE_ANTHROPIC_CACHE=0|false disables. */
function promptCacheEnabled(): boolean {
  return (
    process.env.FORGE_ANTHROPIC_CACHE !== "0" &&
    process.env.FORGE_ANTHROPIC_CACHE !== "false"
  );
}

/** Pick the optional prompt-cache counters off an Anthropic usage object. */
function cacheUsageFields(u?: {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} {
  const out: {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } = {};
  if (u?.cache_read_input_tokens != null) {
    out.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  if (u?.cache_creation_input_tokens != null) {
    out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  return out;
}

/**
 * Anthropic EXCLUDES cache_read/cache_creation tokens from input_tokens.
 * Fold both buckets into prompt_tokens so session token totals and the
 * /budget spend cap (estimateCostUsd sees only scalar prompt/completion)
 * do not under-report the cached prefix. Cache reads priced at full input
 * rate overestimate — the same safe direction as the OpenAI-compat side,
 * whose prompt_tokens already include cached tokens (see estimateCostUsd).
 */
function toChatUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): ChatUsage {
  const prompt =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  const completion = u.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...cacheUsageFields(u),
  };
}

/**
 * Merge a message_delta usage event into the accumulated stream usage.
 * message_delta usually omits input/cache counters — keep the message_start
 * values unless the event overrides them. prev.prompt_tokens is already
 * cache-folded, so re-fold only when the delta carries fresh input_tokens.
 */
function mergeStreamUsage(
  prev: ChatUsage | undefined,
  u: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): ChatUsage {
  const cacheRead =
    u.cache_read_input_tokens ?? prev?.cache_read_input_tokens ?? 0;
  const cacheWrite =
    u.cache_creation_input_tokens ?? prev?.cache_creation_input_tokens ?? 0;
  const prompt =
    u.input_tokens != null
      ? u.input_tokens + cacheRead + cacheWrite
      : (prev?.prompt_tokens ?? 0);
  const completion = u.output_tokens ?? prev?.completion_tokens ?? 0;
  const merged: ChatUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cacheRead) merged.cache_read_input_tokens = cacheRead;
  if (cacheWrite) merged.cache_creation_input_tokens = cacheWrite;
  return merged;
}

/**
 * Native Anthropic Messages API adapter.
 * Converts OpenAI-style tool messages to Anthropic content blocks.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  private baseUrl: string;
  private apiKey: string;

  constructor(opts: { baseUrl?: string; apiKey: string }) {
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
  }

  updateCredentials(token: string): void {
    this.apiKey = token;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  private convertMessages(messages: ChatMessage[]): {
    system?: string;
    messages: unknown[];
  } {
    let system: string | undefined;
    const out: Array<{ role: string; content: unknown[] }> = [];

    // Anthropic 400s on empty text blocks ("text content blocks must be
    // non-empty") and on non-alternating roles. Persisted history can hold
    // empty user/assistant messages (empty-response recovery leaves
    // content:null), so skip empty blocks/messages and merge any same-role
    // neighbors the skips leave behind.
    const pushBlocks = (role: "user" | "assistant", blocks: unknown[]) => {
      if (blocks.length === 0) return;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else out.push({ role, content: blocks });
    };

    for (const m of messages) {
      if (m.role === "system") {
        system = (system ? system + "\n\n" : "") + (m.content || "");
        continue;
      }
      if (m.role === "user") {
        if (m.content) pushBlocks("user", [{ type: "text", text: m.content }]);
        continue;
      }
      if (m.role === "assistant") {
        const content: unknown[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            const parsed = parseToolArguments(tc.function.arguments || "{}");
            const input = parsed.ok ? parsed.value : { raw: tc.function.arguments };
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }
        pushBlocks("assistant", content);
        continue;
      }
      if (m.role === "tool") {
        // Anthropic expects tool_result as user content blocks.
        // Merge consecutive tool results into one user message.
        const block = {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content || "",
        };
        const last = out[out.length - 1];
        if (last && last.role === "user") {
          last.content.push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
      }
    }
    return { system, messages: out };
  }

  private convertTools(tools?: ToolDefinition[]): unknown[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  /**
   * Anthropic prompt caching (default on; FORGE_ANTHROPIC_CACHE=0|false off).
   * Marks the stable request prefix — system prompt and tool list — with an
   * ephemeral cache breakpoint: system becomes an array of text blocks whose
   * last block carries cache_control, and the LAST tool gets cache_control.
   * Cache reads are 0.1× input price; 5-min TTL refreshed per hit.
   */
  private applyPromptCache(
    system: string | undefined,
    tools: unknown[] | undefined,
  ): { system?: unknown; tools?: unknown[] } {
    if (!promptCacheEnabled()) return { system, tools };
    const cachedSystem: unknown = system
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system;
    const cachedTools = tools?.length
      ? tools.map((t, i) =>
          i === tools.length - 1
            ? {
                ...(t as Record<string, unknown>),
                cache_control: { type: "ephemeral" },
              }
            : t,
        )
      : tools;
    return { system: cachedSystem, tools: cachedTools };
  }

  /**
   * Rolling history breakpoint: mark the LAST message so the conversation
   * prefix (not just system+tools) is served from cache on the next turn —
   * the breakpoint walks forward one delta-write per turn (Claude Code
   * style). Without this the growing history is re-billed at full input
   * price every turn. 3 of Anthropic's 4 breakpoints used: system, tools,
   * history.
   */
  private applyHistoryCacheBreakpoint(messages: unknown[]): unknown[] {
    if (!promptCacheEnabled() || messages.length === 0) return messages;
    const idx = messages.length - 1;
    const last = messages[idx] as { role?: string; content?: unknown };
    if (!last || typeof last !== "object") return messages;
    const cc = { cache_control: { type: "ephemeral" } };
    let content: unknown;
    if (typeof last.content === "string") {
      content = [{ type: "text", text: last.content, ...cc }];
    } else if (Array.isArray(last.content) && last.content.length > 0) {
      const blocks = [...last.content];
      const tail = blocks[blocks.length - 1];
      blocks[blocks.length - 1] =
        tail && typeof tail === "object" ? { ...tail, ...cc } : tail;
      content = blocks;
    } else {
      return messages;
    }
    const out = [...messages];
    out[idx] = { ...last, content };
    return out;
  }

  private parseResponse(json: {
    id: string;
    model: string;
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    stop_reason: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  }): ChatResponse {
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of json.content || []) {
      if (block.type === "text" && block.text) content += block.text;
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id || `toolu_${toolCalls.length}`,
          type: "function",
          function: {
            name: block.name || "",
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }
    const finish = mapAnthropicStopReason(json.stop_reason);
    return {
      id: json.id,
      model: json.model,
      message: {
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
      finish_reason: finish,
      usage: json.usage ? toChatUsage(json.usage) : undefined,
    };
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const { system, messages } = this.convertMessages(req.messages);
    const cached = this.applyPromptCache(system, this.convertTools(req.tools));
    const body = {
      model: req.model,
      max_tokens: req.max_tokens ?? 8192,
      temperature: req.temperature,
      system: cached.system,
      messages: this.applyHistoryCacheBreakpoint(messages),
      tools: cached.tools,
      stream: false,
    };
    const { signal: merged, dispose } = mergeAbortSignals(
      signal,
      providerTimeoutMs(),
    );
    try {
      const resp = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: merged,
      });
      await throwIfNotOk("anthropic", resp);
      const json = await resp.json();
      return this.parseResponse(json as never);
    } catch (err) {
      if (signal?.aborted) throw new Error("Aborted");
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed out after/i.test(msg)) throw new Error(msg);
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
    const { system, messages } = this.convertMessages(req.messages);
    const cached = this.applyPromptCache(system, this.convertTools(req.tools));
    const body = {
      model: req.model,
      max_tokens: req.max_tokens ?? 8192,
      temperature: req.temperature,
      system: cached.system,
      messages: this.applyHistoryCacheBreakpoint(messages),
      tools: cached.tools,
      stream: true,
    };
    const { signal: merged, dispose } = mergeAbortSignals(
      signal,
      providerTimeoutMs(),
    );
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: merged,
      });
    } catch (err) {
      dispose();
      if (signal?.aborted) throw new Error("Aborted");
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed out after/i.test(msg)) throw new Error(msg);
      throw err;
    }
    try {
      await throwIfNotOk("anthropic", resp);
    } catch (err) {
      dispose();
      throw err;
    }
    if (!resp.body) {
      dispose();
      throw new Error("No stream body");
    }

    const reader = resp.body.getReader();
    let readerCancelled = false;
    const cancelReader = () => {
      if (readerCancelled) return;
      readerCancelled = true;
      reader.cancel().catch(() => {});
    };
    const onAbort = () => {
      cancelReader();
    };
    if (merged.aborted) {
      onAbort();
      dispose();
      // Provider wall-clock timeout must NOT masquerade as a user abort —
      // "Aborted" is non-retryable, a timeout is (parity with openai-compat).
      if (signal?.aborted) throw new Error("Aborted");
      throw new Error(
        merged.reason instanceof Error ? merged.reason.message : "Aborted",
      );
    }
    merged.addEventListener("abort", onAbort, { once: true });

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls: ToolCall[] = [];
    let currentTool: { id: string; name: string; args: string } | null = null;
    let finishReason: string | null = null;
    let id = "";
    let model = req.model;
    let usage: ChatResponse["usage"] | undefined;

    const processSseLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (!data) return;
      const event = JSON.parse(data) as {
        type: string;
        message?: {
          id: string;
          model: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        index?: number;
        content_block?: {
          type: string;
          text?: string;
          id?: string;
          name?: string;
        };
        delta?: {
          type: string;
          text?: string;
          partial_json?: string;
          stop_reason?: string;
        };
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        error?: { type?: string; message?: string };
      };
      // Anthropic error events mid-stream (overloaded, rate limit, etc.)
      if (event.type === "error" || event.error) {
        const msg =
          event.error?.message ||
          event.error?.type ||
          "stream error";
        throw new Error(`${this.id} stream error: ${msg}`);
      }
      if (event.type === "message_start" && event.message) {
        id = event.message.id;
        model = event.message.model;
        if (event.message.usage) {
          usage = toChatUsage(event.message.usage);
        }
      }
      if (event.type === "content_block_start" && event.content_block) {
        if (event.content_block.type === "tool_use") {
          currentTool = {
            id: event.content_block.id || `toolu_${toolCalls.length}`,
            name: event.content_block.name || "",
            args: "",
          };
        }
      }
      if (event.type === "content_block_delta" && event.delta) {
        if (event.delta.type === "text_delta" && event.delta.text) {
          content += event.delta.text;
          onDelta({ content: event.delta.text });
        }
        if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
          if (currentTool) currentTool.args += event.delta.partial_json;
        }
      }
      if (event.type === "content_block_stop" && currentTool) {
        toolCalls.push({
          id: currentTool.id,
          type: "function",
          function: {
            name: currentTool.name,
            arguments: currentTool.args || "{}",
          },
        });
        onDelta({
          tool_calls: [
            {
              index: toolCalls.length - 1,
              id: currentTool.id,
              function: {
                name: currentTool.name,
                arguments: currentTool.args,
              },
            },
          ],
        });
        currentTool = null;
      }
      if (event.type === "message_delta") {
        if (event.delta?.stop_reason) {
          finishReason = mapAnthropicStopReason(event.delta.stop_reason);
          onDelta({ finish_reason: finishReason });
        }
        if (event.usage) {
          usage = mergeStreamUsage(usage, event.usage);
        }
      }
    };

    try {
      while (true) {
        if (merged.aborted) {
          throw new Error(
            signal?.aborted
              ? "Aborted"
              : merged.reason instanceof Error
                ? merged.reason.message
                : "Aborted",
          );
        }
        const { done, value } = await reader.read();
        // reader.cancel() (abort/timeout) resolves a pending read() with
        // { done: true } — re-check abort before treating it as a clean
        // end-of-stream, or a mid-stream Esc/timeout returns partial content
        // as a successful completion.
        if (merged.aborted) {
          throw new Error(
            signal?.aborted
              ? "Aborted"
              : merged.reason instanceof Error
                ? merged.reason.message
                : "Aborted",
          );
        }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            processSseLine(line);
          } catch (err) {
            if ((err as Error).message === "Aborted") throw err;
            if (/timed out after/i.test((err as Error).message || "")) throw err;
            if (/stream error:/i.test((err as Error).message || "")) throw err;
            /* skip malformed SSE */
          }
        }
      }
      // Same guard after loop exit — an aborted stream must not fall
      // through to the tool-flush/return path with partial content.
      if (merged.aborted) {
        throw new Error(
          signal?.aborted
            ? "Aborted"
            : merged.reason instanceof Error
              ? merged.reason.message
              : "Aborted",
        );
      }
      // Flush trailing buffer (final event without newline) — parity with
      // openai-compat; a final unterminated SSE line carries finish_reason
      // and usage.
      if (buffer.trim()) {
        try {
          processSseLine(buffer);
        } catch (err) {
          if (/stream error:/i.test((err as Error).message || "")) throw err;
        }
      }
    } finally {
      merged.removeEventListener("abort", onAbort);
      dispose();
      // Cancel before releaseLock: mid-stream throw paths (e.g. `stream
      // error:`) must not leave the underlying fetch body hanging.
      cancelReader();
      try {
        reader.releaseLock();
      } catch {
        /* */
      }
    }

    // Flush incomplete tool block if stream ended mid-tool (truncated args).
    // Widen past the stale null narrowing — all currentTool writes happen
    // inside the processSseLine closure, which CFA cannot see.
    const pendingTool = currentTool as {
      id: string;
      name: string;
      args: string;
    } | null;
    if (pendingTool) {
      toolCalls.push({
        id: pendingTool.id,
        type: "function",
        function: {
          name: pendingTool.name,
          arguments: pendingTool.args || "{}",
        },
      });
      currentTool = null;
    }

    // Empty stream with no stop_reason is almost always a dropped connection —
    // surface as retryable rather than a silent blank assistant turn.
    if (!content && toolCalls.length === 0 && !finishReason && !usage) {
      throw new Error(
        `${this.id} stream ended with empty response (no content, tools, or finish_reason) — likely a dropped connection; retry or switch model`,
      );
    }

    return {
      id: id || `msg_${Date.now()}`,
      model,
      message: {
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
      finish_reason: finishReason,
      usage,
    };
  }
}
