import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamDelta,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { throwIfNotOk } from "./errors.js";
import { parseToolArguments } from "../util/json-repair.js";
import { mergeAbortSignals, providerTimeoutMs } from "../util/abort.js";

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
    const out: unknown[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        system = (system ? system + "\n\n" : "") + (m.content || "");
        continue;
      }
      if (m.role === "user") {
        out.push({ role: "user", content: m.content || "" });
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
        out.push({
          role: "assistant",
          content: content.length ? content : [{ type: "text", text: "" }],
        });
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
        const last = out[out.length - 1] as
          | { role: string; content: unknown }
          | undefined;
        if (last && last.role === "user" && Array.isArray(last.content)) {
          (last.content as unknown[]).push(block);
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
    usage?: { input_tokens: number; output_tokens: number };
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
    const finish =
      json.stop_reason === "tool_use"
        ? "tool_calls"
        : json.stop_reason === "end_turn"
          ? "stop"
          : json.stop_reason;
    return {
      id: json.id,
      model: json.model,
      message: {
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
      finish_reason: finish,
      usage: json.usage
        ? {
            prompt_tokens: json.usage.input_tokens,
            completion_tokens: json.usage.output_tokens,
            total_tokens: json.usage.input_tokens + json.usage.output_tokens,
          }
        : undefined,
    };
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const { system, messages } = this.convertMessages(req.messages);
    const body = {
      model: req.model,
      max_tokens: req.max_tokens ?? 8192,
      temperature: req.temperature,
      system,
      messages,
      tools: this.convertTools(req.tools),
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
    const body = {
      model: req.model,
      max_tokens: req.max_tokens ?? 8192,
      temperature: req.temperature,
      system,
      messages,
      tools: this.convertTools(req.tools),
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
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    if (merged.aborted) {
      onAbort();
      dispose();
      throw new Error(signal?.aborted ? "Aborted" : "Aborted");
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
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          try {
            const event = JSON.parse(data) as {
              type: string;
              message?: {
                id: string;
                model: string;
                usage?: { input_tokens?: number; output_tokens?: number };
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
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (event.type === "message_start" && event.message) {
              id = event.message.id;
              model = event.message.model;
              if (event.message.usage) {
                usage = {
                  prompt_tokens: event.message.usage.input_tokens ?? 0,
                  completion_tokens: event.message.usage.output_tokens ?? 0,
                  total_tokens:
                    (event.message.usage.input_tokens ?? 0) +
                    (event.message.usage.output_tokens ?? 0),
                };
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
                finishReason =
                  event.delta.stop_reason === "tool_use"
                    ? "tool_calls"
                    : event.delta.stop_reason === "end_turn"
                      ? "stop"
                      : event.delta.stop_reason;
                onDelta({ finish_reason: finishReason });
              }
              if (event.usage) {
                usage = {
                  prompt_tokens:
                    event.usage.input_tokens ?? usage?.prompt_tokens ?? 0,
                  completion_tokens:
                    event.usage.output_tokens ?? usage?.completion_tokens ?? 0,
                  total_tokens:
                    (event.usage.input_tokens ?? usage?.prompt_tokens ?? 0) +
                    (event.usage.output_tokens ?? usage?.completion_tokens ?? 0),
                };
              }
            }
          } catch (err) {
            if ((err as Error).message === "Aborted") throw err;
            /* skip */
          }
        }
      }
    } finally {
      merged.removeEventListener("abort", onAbort);
      dispose();
      try {
        reader.releaseLock();
      } catch {
        /* */
      }
    }

    // Flush incomplete tool block if stream ended mid-tool (truncated args)
    if (currentTool) {
      toolCalls.push({
        id: currentTool.id,
        type: "function",
        function: {
          name: currentTool.name,
          arguments: currentTool.args || "{}",
        },
      });
      currentTool = null;
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
