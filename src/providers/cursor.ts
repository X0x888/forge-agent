/**
 * Cursor LLM provider — AgentService/Run over HTTP/2 Connect-RPC.
 *
 * Forge owns tools: Cursor native execs are rejected and Forge function
 * defs are advertised as MCP tools. Streaming text/thinking maps onto the
 * shared ChatResponse shape so the agent loop is unchanged.
 */
import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamDelta,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { ProviderApiError } from "./errors.js";
import {
  armReasoningOutputWall,
  mergeAbortSignals,
  providerMaxWallMs,
  providerReasoningWallMs,
  providerTimeoutMs,
} from "../util/abort.js";
import {
  REASONING_LOOP_FINISH,
  REASONING_WALL_FINISH,
} from "../agent/reasoned-stop.js";
import {
  isReasoningMantra,
  shouldScanReasoningMantra,
} from "../agent/reasoning-loop.js";
import {
  CURSOR_API_BASE,
  CURSOR_CLIENT_VERSION,
  cursorApiHeaders,
} from "../auth/cursor.js";
import {
  CONNECT_END_STREAM,
  encodeAgentRunRequest,
  encodeAgentTurn,
  encodeClientMessage,
  encodeConnectFrame,
  encodeConversationActionUser,
  encodeConversationState,
  encodeExecClient,
  encodeKvClient,
  encodeMcpErrorResult,
  encodeMcpSuccessResult,
  encodeMcpToolDefinition,
  encodeMcpTools,
  encodeMessage,
  encodeRejected,
  encodeRequestContextResult,
  encodeString,
  encodeTurnStructure,
  hexKey,
  parseAgentServerMessage,
  parseConnectEndError,
  parseGetUsableModels,
  parseMcpArgs,
  parsePathArg,
  parseShellArg,
  sha256Bytes,
  systemPromptBlob,
} from "./cursor-proto.js";

const REJECT =
  "Tool not available in this environment. Use the MCP tools provided instead.";

const RUN_PATH = "/agent.v1.AgentService/Run";
const MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

function rethrowAbort(err: unknown, userSignal?: AbortSignal): void {
  if (userSignal?.aborted) {
    const e = new Error("Aborted");
    e.name = "AbortError";
    throw e;
  }
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "AbortError"
  ) {
    throw err;
  }
}

interface ParsedMessages {
  systemPrompt: string;
  userText: string;
  turns: Array<{ userText: string; assistantText: string }>;
  toolResults: Array<{ toolCallId: string; content: string }>;
}

function messageText(msg: ChatRequest["messages"][number]): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return msg.content ?? "";
}

function parseMessages(messages: ChatRequest["messages"]): ParsedMessages {
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => messageText(m))
    .filter(Boolean);
  const systemPrompt =
    systemParts.join("\n") || "You are a helpful coding assistant.";
  const toolResults: ParsedMessages["toolResults"] = [];
  const pairs: ParsedMessages["turns"] = [];
  let pendingUser = "";

  for (const msg of messages.filter((m) => m.role !== "system")) {
    if (msg.role === "tool") {
      toolResults.push({
        toolCallId: msg.tool_call_id || "",
        content: messageText(msg),
      });
      continue;
    }
    if (msg.role === "user") {
      if (pendingUser) pairs.push({ userText: pendingUser, assistantText: "" });
      pendingUser = messageText(msg);
      continue;
    }
    if (msg.role === "assistant") {
      const text = messageText(msg);
      if (pendingUser) {
        pairs.push({ userText: pendingUser, assistantText: text });
        pendingUser = "";
      }
    }
  }

  let lastUser = "";
  if (pendingUser) lastUser = pendingUser;
  else if (pairs.length && toolResults.length === 0) {
    const last = pairs.pop()!;
    lastUser = last.userText;
  }

  return {
    systemPrompt,
    userText: lastUser,
    turns: pairs,
    toolResults,
  };
}

function encodeToolDefs(tools?: ToolDefinition[]): Buffer[] {
  return (tools ?? []).map((t) =>
    encodeMcpToolDefinition({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }),
  );
}

interface PendingExec {
  id: number;
  execId: string;
  toolCallId: string;
  toolName: string;
}

interface LiveSession {
  session: http2.ClientHttp2Session;
  stream: http2.ClientHttp2Stream;
  write: (data: Uint8Array) => void;
  heartbeat: ReturnType<typeof setInterval>;
  blobStore: Map<string, Buffer>;
  mcpTools: Buffer[];
  pending: PendingExec[];
  buffer: Buffer;
}

const liveSessions = new Map<string, LiveSession>();

export function sessionKeyForRequest(req: ChatRequest): string {
  const id = (req.conversationId || "").trim();
  if (id) return `${req.model}:${id}`;
  const first = req.messages.find((m) => m.role === "user");
  const seed =
    typeof first?.content === "string" ? first.content.slice(0, 200) : req.model;
  return `${req.model}:${sha256Bytes(Buffer.from(seed)).toString("hex").slice(0, 16)}`;
}

function closeLive(key: string): void {
  const live = liveSessions.get(key);
  if (!live) return;
  liveSessions.delete(key);
  clearInterval(live.heartbeat);
  try {
    live.stream.close();
  } catch {
    /* */
  }
  try {
    live.session.close();
  } catch {
    /* */
  }
}

function buildRunPayload(req: ChatRequest, parsed: ParsedMessages): {
  bytes: Buffer;
  blobStore: Map<string, Buffer>;
  mcpTools: Buffer[];
} {
  const blobStore = new Map<string, Buffer>();
  const sys = systemPromptBlob(parsed.systemPrompt);
  blobStore.set(hexKey(sys.id), sys.data);

  const turns: Buffer[] = [];
  for (const t of parsed.turns) {
    turns.push(
      encodeTurnStructure(
        encodeAgentTurn(t.userText, randomUUID(), t.assistantText || undefined),
      ),
    );
  }

  const mcp = encodeToolDefs(req.tools);
  const run = encodeAgentRunRequest({
    conversationState: encodeConversationState({
      systemBlobId: sys.id,
      turns,
    }),
    action: encodeConversationActionUser(
      parsed.userText || "(continue)",
      randomUUID(),
    ),
    modelId: req.model,
    conversationId: req.conversationId || randomUUID(),
    mcpTools: mcp.length ? encodeMcpTools(mcp) : undefined,
  });
  return {
    bytes: encodeConnectFrame(encodeClientMessage({ runRequest: run })),
    blobStore,
    mcpTools: mcp,
  };
}

function wrapReject(rejectField: number, inner: Uint8Array): Buffer {
  return encodeMessage(rejectField, inner);
}

function nativeRejectFrame(exec: {
  id: number;
  execId: string;
  execKind: string;
  payload: Uint8Array;
}): Buffer {
  const path = parsePathArg(exec.payload);
  const shell = parseShellArg(exec.payload);
  let resultField = 11;
  let result: Buffer = encodeMcpErrorResult(REJECT);

  switch (exec.execKind) {
    case "readArgs":
      resultField = 7;
      result = wrapReject(3, encodeRejected(path, REJECT));
      break;
    case "lsArgs":
      resultField = 8;
      result = wrapReject(3, encodeRejected(path, REJECT));
      break;
    case "writeArgs":
      resultField = 3;
      result = wrapReject(6, encodeRejected(path, REJECT));
      break;
    case "deleteArgs":
      resultField = 4;
      result = wrapReject(6, encodeRejected(path, REJECT));
      break;
    case "grepArgs":
      resultField = 5;
      result = wrapReject(2, encodeString(1, REJECT));
      break;
    case "shellArgs":
    case "shellStreamArgs":
      resultField = 2;
      result = wrapReject(
        4,
        encodeRejected(shell.command, REJECT, {
          workingDirectory: shell.workingDirectory,
        }),
      );
      break;
    case "backgroundShellSpawnArgs":
      resultField = 16;
      result = wrapReject(
        3,
        encodeRejected(shell.command, REJECT, {
          workingDirectory: shell.workingDirectory,
        }),
      );
      break;
    case "fetchArgs":
      resultField = 20;
      result = wrapReject(2, encodeRejected(path, REJECT));
      break;
    case "diagnosticsArgs":
      resultField = 9;
      result = wrapReject(3, encodeRejected("", REJECT));
      break;
    default:
      resultField = 11;
      result = encodeMcpErrorResult(REJECT);
  }

  return encodeConnectFrame(
    encodeClientMessage({
      execClient: encodeExecClient({
        id: exec.id,
        execId: exec.execId,
        resultField,
        result,
      }),
    }),
  );
}

function heartbeatFrame(): Buffer {
  return encodeConnectFrame(encodeClientMessage({ heartbeat: true }));
}

export class CursorProvider implements LLMProvider {
  readonly id = "cursor";
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || CURSOR_API_BASE).replace(/\/$/, "");
  }

  updateCredentials(token: string): void {
    this.apiKey = token;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.chatStream(req, () => {}, signal);
  }

  async chatStream(
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const { signal: merged, dispose, touch } = mergeAbortSignals(
      signal,
      providerTimeoutMs(),
      { maxWallMs: providerMaxWallMs() },
    );
    try {
      return await this.runStream(req, onDelta, merged, touch, () => {});
    } catch (err) {
      rethrowAbort(err, signal);
      throw err;
    } finally {
      dispose();
    }
  }

  private async runStream(
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
    signal: AbortSignal,
    touch: () => void,
    noteVisible: () => void,
  ): Promise<ChatResponse> {
    const key = sessionKeyForRequest(req);
    const parsed = parseMessages(req.messages);
    const existing = liveSessions.get(key);

    if (existing && parsed.toolResults.length) {
      return this.resumeWithToolResults(
        key,
        existing,
        parsed.toolResults,
        req,
        onDelta,
        signal,
        touch,
        noteVisible,
      );
    }
    if (existing) closeLive(key);

    const payload = buildRunPayload(req, parsed);
    return this.openAndRead(
      key,
      payload.bytes,
      payload.blobStore,
      payload.mcpTools,
      req,
      onDelta,
      signal,
      touch,
      noteVisible,
    );
  }

  private openHttp2(): Promise<{
    session: http2.ClientHttp2Session;
    stream: http2.ClientHttp2Stream;
  }> {
    return new Promise((resolve, reject) => {
      const session = http2.connect(this.baseUrl);
      const onErr = (err: Error) => {
        session.close();
        reject(err);
      };
      session.once("error", onErr);
      session.once("connect", () => {
        session.removeListener("error", onErr);
        const stream = session.request({
          ":method": "POST",
          ":path": RUN_PATH,
          "content-type": "application/connect+proto",
          te: "trailers",
          authorization: `Bearer ${this.apiKey}`,
          "connect-protocol-version": "1",
          "x-request-id": randomUUID(),
          ...cursorApiHeaders(),
          "x-cursor-client-version": CURSOR_CLIENT_VERSION,
        });
        resolve({ session, stream });
      });
    });
  }

  private async openAndRead(
    key: string,
    firstFrame: Buffer,
    blobStore: Map<string, Buffer>,
    mcpTools: Buffer[],
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
    signal: AbortSignal,
    touch: () => void,
    noteVisible: () => void,
  ): Promise<ChatResponse> {
    const { session, stream } = await this.openHttp2();
    const live: LiveSession = {
      session,
      stream,
      write: (data) => {
        if (!stream.closed && !stream.destroyed) stream.write(data);
      },
      heartbeat: setInterval(() => {
        try {
          if (!stream.closed && !stream.destroyed) stream.write(heartbeatFrame());
        } catch {
          /* */
        }
      }, 5_000),
      blobStore,
      mcpTools,
      pending: [],
      buffer: Buffer.alloc(0),
    };
    live.heartbeat.unref?.();
    liveSessions.set(key, live);
    live.write(firstFrame);

    const onAbort = () => closeLive(key);
    if (signal.aborted) {
      onAbort();
      const e = new Error("Aborted");
      e.name = "AbortError";
      throw e;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      return await this.readLoop(
        key,
        live,
        req,
        onDelta,
        signal,
        touch,
        noteVisible,
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async resumeWithToolResults(
    key: string,
    live: LiveSession,
    results: Array<{ toolCallId: string; content: string }>,
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
    signal: AbortSignal,
    touch: () => void,
    noteVisible: () => void,
  ): Promise<ChatResponse> {
    for (const exec of live.pending) {
      const hit = results.find((r) => r.toolCallId === exec.toolCallId);
      const result = hit
        ? encodeMcpSuccessResult(hit.content, false)
        : encodeMcpErrorResult("Tool result not provided");
      live.write(
        encodeConnectFrame(
          encodeClientMessage({
            execClient: encodeExecClient({
              id: exec.id,
              execId: exec.execId,
              resultField: 11,
              result,
            }),
          }),
        ),
      );
    }
    live.pending = [];
    live.mcpTools = encodeToolDefs(req.tools);
    return this.readLoop(key, live, req, onDelta, signal, touch, noteVisible);
  }

  private async readLoop(
    key: string,
    live: LiveSession,
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
    signal: AbortSignal,
    touch: () => void,
    noteVisible: () => void,
  ): Promise<ChatResponse> {
    let content = "";
    let reasoningContent = "";
    let mantraScanAt = 0;
    const toolCalls: ToolCall[] = [];
    let finishReason: string | null = null;
    let streamCut = false;
    let reasoningWallFired = false;
    const wall = armReasoningOutputWall(providerReasoningWallMs(), () => {
      reasoningWallFired = true;
      if (!finishReason) {
        finishReason = REASONING_WALL_FINISH;
        onDelta({ finish_reason: REASONING_WALL_FINISH });
      }
      streamCut = true;
      closeLive(key);
    });

    const cut = (reason: string) => {
      if (!finishReason) {
        finishReason = reason;
        onDelta({ finish_reason: reason });
      }
      streamCut = true;
      closeLive(key);
    };

    const handlePayload = (flags: number, payload: Uint8Array): boolean => {
      touch();
      if (flags & CONNECT_END_STREAM) {
        const err = parseConnectEndError(payload);
        if (err) {
          throw new ProviderApiError({
            provider: "cursor",
            status: 400,
            body: err,
          });
        }
        return true;
      }
      const events = parseAgentServerMessage(payload);
      for (const ev of events) {
        if (ev.kind === "text") {
          content += ev.text;
          noteVisible();
          wall.noteVisibleOutput();
          onDelta({ content: ev.text });
        } else if (ev.kind === "thinking") {
          reasoningContent += ev.text;
          onDelta({ reasoning_content: ev.text });
          if (
            shouldScanReasoningMantra(reasoningContent.length, mantraScanAt)
          ) {
            mantraScanAt = reasoningContent.length;
            if (isReasoningMantra(reasoningContent)) {
              cut(REASONING_LOOP_FINISH);
              return true;
            }
          }
        } else if (ev.kind === "kv") {
          if (ev.kvKind === "get") {
            const data = live.blobStore.get(hexKey(ev.blobId));
            live.write(
              encodeConnectFrame(
                encodeClientMessage({
                  kvClient: encodeKvClient({
                    id: ev.id,
                    getBlob: data ?? null,
                  }),
                }),
              ),
            );
          } else {
            if (ev.blobId?.length && ev.blobData) {
              live.blobStore.set(hexKey(ev.blobId), Buffer.from(ev.blobData));
            }
            live.write(
              encodeConnectFrame(
                encodeClientMessage({
                  kvClient: encodeKvClient({ id: ev.id, setBlob: true }),
                }),
              ),
            );
          }
        } else if (ev.kind === "exec") {
          if (ev.execKind === "requestContextArgs") {
            live.write(
              encodeConnectFrame(
                encodeClientMessage({
                  execClient: encodeExecClient({
                    id: ev.id,
                    execId: ev.execId,
                    resultField: 10,
                    result: encodeRequestContextResult(live.mcpTools),
                  }),
                }),
              ),
            );
          } else if (ev.execKind === "mcpArgs") {
            const mcp = parseMcpArgs(ev.payload);
            const toolCallId = mcp.toolCallId || randomUUID();
            const name = mcp.toolName || mcp.name;
            const args = JSON.stringify(mcp.args ?? {});
            const tc: ToolCall = {
              id: toolCallId,
              type: "function",
              function: { name, arguments: args },
            };
            toolCalls.push(tc);
            live.pending.push({
              id: ev.id,
              execId: ev.execId,
              toolCallId,
              toolName: name,
            });
            onDelta({
              tool_calls: [
                {
                  index: toolCalls.length - 1,
                  id: toolCallId,
                  type: "function",
                  function: { name, arguments: args },
                },
              ],
            });
            noteVisible();
            wall.noteVisibleOutput();
          } else {
            live.write(nativeRejectFrame(ev));
          }
        }
      }
      if (live.pending.length) {
        finishReason = "tool_calls";
        onDelta({ finish_reason: "tool_calls" });
        return true;
      }
      return false;
    };

    return new Promise<ChatResponse>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        wall.dispose();
        if (reasoningWallFired && !finishReason) {
          finishReason = REASONING_WALL_FINISH;
        }
        if (live.pending.length) {
          finishReason = "tool_calls";
        } else {
          closeLive(key);
        }
        resolve({
          id: `cursor-${randomUUID()}`,
          model: req.model,
          message: {
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls.length ? toolCalls : undefined,
            reasoning_content: reasoningContent || undefined,
          },
          finish_reason: finishReason || "stop",
        });
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        wall.dispose();
        closeLive(key);
        reject(err);
      };

      live.stream.on("response", (headers) => {
        touch();
        const status = Number(headers[":status"] || 0);
        if (status && status >= 400) {
          fail(
            new ProviderApiError({
              provider: "cursor",
              status,
              body: `Cursor AgentService HTTP ${status}`,
            }),
          );
        }
      });

      live.stream.on("data", (chunk: Buffer) => {
        if (streamCut || settled) return;
        live.buffer = Buffer.concat([live.buffer, chunk]);
        while (live.buffer.length >= 5) {
          const flags = live.buffer[0]!;
          const len = live.buffer.readUInt32BE(1);
          if (live.buffer.length < 5 + len) break;
          const payload = live.buffer.subarray(5, 5 + len);
          live.buffer = live.buffer.subarray(5 + len);
          try {
            const done = handlePayload(flags, payload);
            if (done) {
              finish();
              return;
            }
          } catch (err) {
            fail(err);
            return;
          }
        }
      });

      live.stream.on("end", () => finish());
      live.stream.on("error", (err) => fail(err));
      live.session.on("error", (err) => fail(err));
      signal.addEventListener(
        "abort",
        () => {
          const e = new Error("Aborted");
          e.name = "AbortError";
          fail(e);
        },
        { once: true },
      );
    });
  }
}

/** Unary GetUsableModels — best-effort catalog refresh. */
export async function fetchCursorUsableModels(
  apiKey: string,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<Array<{ id: string; name: string }>> {
  const base = (opts?.baseUrl || CURSOR_API_BASE).replace(/\/$/, "");
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  return new Promise((resolve) => {
    const session = http2.connect(base);
    const timer = setTimeout(() => {
      session.close();
      resolve([]);
    }, timeoutMs);
    timer.unref?.();
    session.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    session.on("connect", () => {
      const stream = session.request({
        ":method": "POST",
        ":path": MODELS_PATH,
        "content-type": "application/proto",
        te: "trailers",
        authorization: `Bearer ${apiKey}`,
        ...cursorApiHeaders(),
      });
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        clearTimeout(timer);
        session.close();
        try {
          const buf = Buffer.concat(chunks);
          resolve(parseGetUsableModels(buf));
        } catch {
          resolve([]);
        }
      });
      stream.on("error", () => {
        clearTimeout(timer);
        session.close();
        resolve([]);
      });
      stream.end(Buffer.alloc(0));
    });
  });
}

export const CURSOR_FALLBACK_MODELS = [
  "composer-2.5",
  "grok-4.6",
  "grok-4.5",
  "claude-sonnet-5",
  "claude-opus-5",
  "gpt-5.5",
  "gemini-3.1-pro",
  "auto",
] as const;
