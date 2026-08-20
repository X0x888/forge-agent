/**
 * Cursor LLM provider — AgentService/Run over HTTP/2 Connect-RPC.
 *
 * Forge owns tools: Cursor native execs are rejected and Forge function
 * defs are advertised as MCP tools. Streaming text/thinking maps onto the
 * shared ChatResponse shape so the agent loop is unchanged.
 */
import http2 from "node:http2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  encodeClientMessage,
  encodeConnectFrame,
  encodeConversationActionUser,
  encodeConversationHistory,
  encodeConversationState,
  encodeExecClient,
  encodeExecClientThrow,
  encodeExecErrorResult,
  encodeExecStreamClose,
  encodeInteractionResponse,
  encodeKvClient,
  encodeListMcpResourcesEmpty,
  encodeMcpErrorResult,
  encodeMcpStateResult,
  encodeMcpSuccessResult,
  encodeMcpToolDefinition,
  encodeMcpTools,
  encodeMessage,
  encodeReadMcpResourceError,
  encodeRejected,
  encodeRequestContext,
  encodeRequestContextEnv,
  encodeRequestContextResult,
  encodeString,
  CURSOR_NATIVE_REJECT,
  hexKey,
  parseAgentServerMessage,
  parseConnectEndError,
  parseGetUsableModels,
  parseMcpArgs,
  parsePathArg,
  parseShellArg,
  sha256Bytes,
  systemPromptBlob,
  type CursorHistoryMessage,
} from "./cursor-proto.js";
import { resolveCursorRunModel } from "../config/cursor-model.js";
import { forgeHome } from "../util/fs.js";

const REJECT = CURSOR_NATIVE_REJECT;

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

export interface CursorConversation {
  systemPrompt: string;
  userText: string;
  turns: Array<{ userText: string; assistantText: string }>;
  /** Tool results after the last assistant, before any following user. */
  trailingToolResults: Array<{ toolCallId: string; content: string }>;
  /**
   * Prior user/assistant/tool messages (not the action user). Typed
   * ConversationHistory on a new Run — never root_prompt_messages_json.
   */
  history: CursorHistoryMessage[];
}

/** Real user action when the held-open Run is gone and history already has the last user. */
export const CURSOR_CONTINUE_PROMPT =
  "Continue the interrupted turn from the conversation history above. Do not repeat completed work.";

/**
 * Keep the AgentService Run open after we yielded tool_calls. turn_ended /
 * Connect EOF with pending MCP execs must not close it — the next chat()
 * writes results on the same stream. Closing forced a new Run with a fake
 * "(continue)" user turn, which is Connect `internal`.
 *
 * A completed text turn also stays open (`close: false` at turn_ended) so
 * the next user / ULW poke is a conversation_action, not a history rebase.
 * Only force-close (stream end, error, reasoning wall) tears it down.
 */
export function shouldCloseCursorLive(opts: {
  close: boolean;
  pendingCount: number;
}): boolean {
  return opts.close && opts.pendingCount === 0;
}

/**
 * Resume the held-open Run when:
 * - MCP execs are still unanswered (tool loop / admit-after-tools), or
 * - the stream is healthy and Forge has a new user action (ULW continue,
 *   next prompt). Opening a new Run and stuffing chat into
 *   root_prompt_messages_json is Connect `internal`.
 */
export function cursorShouldResumeLive(opts: {
  pendingCount: number;
  streamDead: boolean;
  trailingCount: number;
  hasUserAction?: boolean;
}): boolean {
  if (opts.streamDead) return false;
  return (
    opts.pendingCount > 0 ||
    opts.trailingCount > 0 ||
    Boolean(opts.hasUserAction)
  );
}

export function collectCursorToolResults(
  messages: ChatRequest["messages"],
): Array<{ toolCallId: string; content: string }> {
  const out: Array<{ toolCallId: string; content: string }> = [];
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    out.push({
      toolCallId: msg.tool_call_id || "",
      content: messageText(msg),
    });
  }
  return out;
}

/**
 * Dead-stream rebase: trailing tools already live on `history`. Only fill
 * an empty action — never a placeholder "(continue)" user turn.
 */
export function applyCursorReconnectAction(
  parsed: CursorConversation,
): CursorConversation {
  if (!parsed.userText.trim()) parsed.userText = CURSOR_CONTINUE_PROMPT;
  return parsed;
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

function foldToolResults(
  assistant: string,
  results: Array<{ toolCallId: string; content: string }>,
): string {
  if (!results.length) return assistant;
  const extra = results
    .map((t) => `[Tool result ${t.toolCallId}]\n${t.content}`)
    .join("\n");
  return [assistant, extra].filter(Boolean).join("\n");
}

function toolNameForCall(
  names: Map<string, string>,
  toolCallId: string,
  fallback?: string,
): string {
  return names.get(toolCallId) || fallback || "tool";
}

function turnsFromHistory(
  history: CursorHistoryMessage[],
): Array<{ userText: string; assistantText: string }> {
  const turns: Array<{ userText: string; assistantText: string }> = [];
  let userText = "";
  let assistantText = "";
  const flush = () => {
    if (!userText && !assistantText) return;
    turns.push({ userText, assistantText });
    userText = "";
    assistantText = "";
  };
  for (const m of history) {
    if (m.role === "user") {
      if (assistantText) flush();
      userText = userText ? `${userText}\n\n${m.text}` : m.text;
      continue;
    }
    if (m.role === "assistant") {
      const bits = [
        m.text,
        ...(m.toolCalls ?? []).map(
          (tc) => `[Called ${tc.name} id=${tc.id}] ${tc.args}`,
        ),
      ].filter(Boolean);
      const chunk = bits.join("\n");
      assistantText = assistantText ? `${assistantText}\n${chunk}` : chunk;
      continue;
    }
    assistantText = foldToolResults(assistantText, [
      { toolCallId: m.toolCallId, content: m.text },
    ]);
  }
  flush();
  return turns;
}

/**
 * Map Forge chat onto a Cursor action + typed ConversationHistory.
 * Consecutive user messages (context-admit / ULW poke) merge into the
 * action — a user-only historical turn is Connect `internal`.
 */
export function prepareCursorConversation(
  messages: ChatRequest["messages"],
): CursorConversation {
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => messageText(m))
    .filter(Boolean);
  const systemPrompt =
    systemParts.join("\n") || "You are a helpful coding assistant.";

  const history: CursorHistoryMessage[] = [];
  const pendingUsers: string[] = [];
  const trailing: Array<{ toolCallId: string; content: string }> = [];
  const toolNames = new Map<string, string>();
  let afterAssistantTools = false;

  const takePendingUser = (): string => {
    const text = pendingUsers.join("\n\n");
    pendingUsers.length = 0;
    return text;
  };

  const flushPendingUserToHistory = () => {
    const text = takePendingUser();
    if (text.trim()) history.push({ role: "user", text });
  };

  const absorbTrailing = () => {
    for (const t of trailing) {
      history.push({
        role: "tool",
        toolCallId: t.toolCallId,
        toolName: toolNameForCall(toolNames, t.toolCallId),
        text: t.content,
      });
    }
    trailing.length = 0;
  };

  for (const msg of messages.filter((m) => m.role !== "system")) {
    if (msg.role === "user") {
      absorbTrailing();
      pendingUsers.push(messageText(msg));
      afterAssistantTools = false;
      continue;
    }
    if (msg.role === "assistant") {
      absorbTrailing();
      flushPendingUserToHistory();
      const calls = (msg.tool_calls ?? []).map((tc) => {
        const id = tc.id || "";
        const name = tc.function.name || "tool";
        if (id) toolNames.set(id, name);
        return { id, name, args: tc.function.arguments?.trim() || "{}" };
      });
      history.push({
        role: "assistant",
        text: messageText(msg),
        reasoning: msg.reasoning_content,
        toolCalls: calls.length ? calls : undefined,
      });
      afterAssistantTools = calls.length > 0;
      continue;
    }
    if (msg.role === "tool") {
      const item = {
        toolCallId: msg.tool_call_id || "",
        content: messageText(msg),
      };
      if (item.toolCallId && msg.name) toolNames.set(item.toolCallId, msg.name);
      if (afterAssistantTools) trailing.push(item);
      else {
        history.push({
          role: "tool",
          toolCallId: item.toolCallId,
          toolName: toolNameForCall(toolNames, item.toolCallId, msg.name),
          text: item.content,
        });
      }
    }
  }

  const userText = takePendingUser();
  const historyForRebase: CursorHistoryMessage[] = [
    ...history,
    ...trailing.map((t) => ({
      role: "tool" as const,
      toolCallId: t.toolCallId,
      toolName: toolNameForCall(toolNames, t.toolCallId),
      text: t.content,
    })),
  ];

  return {
    systemPrompt,
    userText,
    turns: turnsFromHistory(historyForRebase),
    trailingToolResults: [...trailing],
    history: historyForRebase,
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

/** One in-flight chat() wait on a long-lived AgentService stream. */
interface LiveTurn {
  req: ChatRequest;
  onDelta: (delta: StreamDelta) => void;
  touch: () => void;
  noteVisible: () => void;
  content: string;
  reasoningContent: string;
  mantraScanAt: number;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: ChatResponse["usage"];
  wall: ReturnType<typeof armReasoningOutputWall>;
  resolve: (r: ChatResponse) => void;
  reject: (e: unknown) => void;
  settled: boolean;
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
  pumpStarted: boolean;
  streamCut: boolean;
  turn: LiveTurn | null;
  workspace: string;
  requestContext: Buffer;
  conversationId?: string;
  toolFlush?: ReturnType<typeof setTimeout>;
}

/** Cursor sometimes joins a local id and `fc_…` with a newline. */
function cursorToolCallId(raw: string, fallback: string): string {
  const first = raw
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .find(Boolean);
  return first || fallback;
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

function workspaceFromRequest(req: ChatRequest): string {
  const pinned = req.workspace?.trim();
  if (pinned) return path.resolve(pinned);
  for (const m of req.messages) {
    if (m.role !== "system" || typeof m.content !== "string") continue;
    const hit = m.content.match(/^Root:\s*(.+)$/m);
    if (hit?.[1]?.trim()) return path.resolve(hit[1].trim());
  }
  return process.cwd();
}

function cursorProjectFolder(workspace: string): string {
  const slug = workspace
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const dir = path.join(forgeHome(), "cursor-projects", slug || "workspace");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* */
  }
  return dir;
}

function buildCursorRequestContext(workspace: string, mcpTools: Buffer[]): Buffer {
  const projectFolder = cursorProjectFolder(workspace);
  return encodeRequestContext({
    env: encodeRequestContextEnv({
      osVersion: `${process.platform} ${os.release()}`,
      workspace,
      shell: process.env.SHELL || "/bin/zsh",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      projectFolder,
      isHome: path.resolve(workspace) === path.resolve(os.homedir()),
    }),
    toolDefs: mcpTools,
    projectFolder,
  });
}

function writeExecAndClose(
  live: LiveSession,
  opts: { id: number; execId: string; resultField: number; result: Uint8Array },
): void {
  live.write(
    encodeConnectFrame(
      encodeClientMessage({
        execClient: encodeExecClient(opts),
      }),
    ),
  );
  live.write(
    encodeConnectFrame(
      encodeClientMessage({
        execControl: encodeExecStreamClose(opts.id),
      }),
    ),
  );
}

function closeLive(key: string, session?: LiveSession): void {
  const live = liveSessions.get(key);
  if (!live) return;
  if (session && live !== session) return;
  liveSessions.delete(key);
  if (live.toolFlush) clearTimeout(live.toolFlush);
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

/**
 * Drop stale Runs for this Forge session (model switch) or an idle leftover
 * after /new. Never close a different conversation that still has pending
 * MCP execs — a Cursor subagent would otherwise kill the parent Run.
 */
function closeOtherLives(keepKey: string, conversationId?: string): void {
  const id = (conversationId || "").trim();
  for (const [key, live] of [...liveSessions]) {
    if (key === keepKey) continue;
    if (id && live.conversationId === id) {
      closeLive(key, live);
      continue;
    }
    if (live.pending.length > 0) continue;
    if (live.turn && !live.turn.settled) continue;
    if (id && live.conversationId && live.conversationId !== id) {
      closeLive(key, live);
    }
  }
}

/** ConversationState is always the system blob — never chat JSON in field 1. */
export function buildCursorConversationState(systemPrompt: string): {
  state: Buffer;
  blobStore: Map<string, Buffer>;
} {
  const blobStore = new Map<string, Buffer>();
  const sys = systemPromptBlob(systemPrompt);
  blobStore.set(hexKey(sys.id), sys.data);
  return {
    state: encodeConversationState({ systemBlobId: sys.id, turns: [] }),
    blobStore,
  };
}

function buildRunPayload(req: ChatRequest, parsed: CursorConversation): {
  bytes: Buffer;
  blobStore: Map<string, Buffer>;
  mcpTools: Buffer[];
  workspace: string;
  requestContext: Buffer;
} {
  const { state: conversationState, blobStore } = buildCursorConversationState(
    parsed.systemPrompt,
  );

  const mcp = encodeToolDefs(req.tools);
  const workspace = workspaceFromRequest(req);
  const requestContext = buildCursorRequestContext(workspace, mcp);
  const model = resolveCursorRunModel({
    model: req.model,
    reasoningEffort: req.reasoning_effort,
    contextWindow: req.context_window,
  });
  const history = parsed.history.length
    ? encodeConversationHistory(parsed.history)
    : undefined;
  const run = encodeAgentRunRequest({
    conversationState,
    action: encodeConversationActionUser(
      parsed.userText || CURSOR_CONTINUE_PROMPT,
      randomUUID(),
      requestContext,
      history,
    ),
    modelId: model.serverId,
    // New HTTP/2 Run → new conversation_id. Reusing a dead Run's id (Forge
    // session id) after the stream dropped is Connect `internal`. Tool
    // continuations stay on the live stream and never rebuild this payload.
    conversationId: randomUUID(),
    mcpTools: mcp.length ? encodeMcpTools(mcp) : undefined,
    thinking: model.thinking,
    maxMode: model.maxMode,
    parameters: model.parameters,
    isVariantString: model.isVariantString,
  });
  return {
    bytes: encodeConnectFrame(encodeClientMessage({ runRequest: run })),
    blobStore,
    mcpTools: mcp,
    workspace,
    requestContext,
  };
}

function wrapReject(rejectField: number, inner: Uint8Array): Buffer {
  return encodeMessage(rejectField, inner);
}

function nativeRejectPayload(exec: {
  execKind: string;
  payload: Uint8Array;
}): { resultField: number; result: Buffer } {
  const filePath = parsePathArg(exec.payload);
  const shell = parseShellArg(exec.payload);
  switch (exec.execKind) {
    case "readArgs":
      return { resultField: 7, result: wrapReject(3, encodeRejected(filePath, REJECT)) };
    case "lsArgs":
      return { resultField: 8, result: wrapReject(3, encodeRejected(filePath, REJECT)) };
    case "writeArgs":
      return { resultField: 3, result: wrapReject(6, encodeRejected(filePath, REJECT)) };
    case "deleteArgs":
      return { resultField: 4, result: wrapReject(6, encodeRejected(filePath, REJECT)) };
    case "grepArgs":
      return { resultField: 5, result: wrapReject(2, encodeString(1, REJECT)) };
    case "shellArgs":
    case "shellStreamArgs":
      return {
        resultField: 2,
        result: wrapReject(
          4,
          encodeRejected(shell.command, REJECT, {
            workingDirectory: shell.workingDirectory,
          }),
        ),
      };
    case "backgroundShellSpawnArgs":
      return {
        resultField: 16,
        result: wrapReject(
          3,
          encodeRejected(shell.command, REJECT, {
            workingDirectory: shell.workingDirectory,
          }),
        ),
      };
    case "fetchArgs":
      return { resultField: 20, result: wrapReject(2, encodeRejected(filePath, REJECT)) };
    case "diagnosticsArgs":
      return { resultField: 9, result: wrapReject(3, encodeRejected("", REJECT)) };
    default:
      return { resultField: 11, result: encodeMcpErrorResult(REJECT) };
  }
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
    closeOtherLives(key, req.conversationId);
    const parsed = prepareCursorConversation(req.messages);
    const existing = liveSessions.get(key);
    const streamDead =
      !!existing &&
      (existing.streamCut ||
        existing.stream.closed ||
        existing.stream.destroyed);

    if (
      existing &&
      cursorShouldResumeLive({
        pendingCount: existing.pending.length,
        streamDead,
        trailingCount: parsed.trailingToolResults.length,
        hasUserAction: Boolean(parsed.userText.trim()),
      })
    ) {
      const results = parsed.trailingToolResults.length
        ? parsed.trailingToolResults
        : collectCursorToolResults(req.messages);
      const followUpUser =
        parsed.trailingToolResults.length === 0 && parsed.userText.trim()
          ? parsed.userText
          : undefined;
      return this.resumeWithToolResults(
        key,
        existing,
        results,
        req,
        onDelta,
        signal,
        touch,
        noteVisible,
        followUpUser,
      );
    }
    if (existing) closeLive(key, existing);
    applyCursorReconnectAction(parsed);

    const payload = buildRunPayload(req, parsed);
    return this.openAndRead(
      key,
      payload.bytes,
      payload.blobStore,
      payload.mcpTools,
      payload.workspace,
      payload.requestContext,
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
    workspace: string,
    requestContext: Buffer,
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
      pumpStarted: false,
      streamCut: false,
      turn: null,
      workspace,
      requestContext,
      conversationId: (req.conversationId || "").trim() || undefined,
    };
    live.heartbeat.unref?.();
    liveSessions.set(key, live);
    this.ensurePump(key, live);
    live.write(firstFrame);
    return this.waitForTurn(key, live, req, onDelta, signal, touch, noteVisible);
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
    followUpUser?: string,
  ): Promise<ChatResponse> {
    for (const exec of live.pending) {
      const want = cursorToolCallId(exec.toolCallId, exec.execId);
      const hit = results.find(
        (r) =>
          cursorToolCallId(r.toolCallId, r.toolCallId) === want ||
          r.toolCallId === exec.execId ||
          r.toolCallId === exec.toolCallId,
      );
      const result = hit
        ? encodeMcpSuccessResult(hit.content, false)
        : encodeMcpErrorResult("Tool result not provided");
      writeExecAndClose(live, {
        id: exec.id,
        execId: exec.execId,
        resultField: 11,
        result,
      });
    }
    live.pending = [];
    live.mcpTools = encodeToolDefs(req.tools);
    live.workspace = workspaceFromRequest(req);
    live.requestContext = buildCursorRequestContext(live.workspace, live.mcpTools);
    const extra = followUpUser?.trim();
    if (extra) {
      live.write(
        encodeConnectFrame(
          encodeClientMessage({
            conversationAction: encodeConversationActionUser(
              extra,
              randomUUID(),
              live.requestContext,
            ),
          }),
        ),
      );
    }
    return this.waitForTurn(key, live, req, onDelta, signal, touch, noteVisible);
  }

  /**
   * One Connect reader for the life of the HTTP/2 stream. KV/requestContext
   * keep being answered while Forge runs tools; stacking readLoop listeners
   * dropped those frames and AgentService returned `internal`.
   */
  private ensurePump(key: string, live: LiveSession): void {
    if (live.pumpStarted) return;
    live.pumpStarted = true;

    live.stream.on("response", (headers) => {
      live.turn?.touch();
      const status = Number(headers[":status"] || 0);
      if (status && status >= 400) {
        this.failTurn(
          key,
          live,
          new ProviderApiError({
            provider: "cursor",
            status,
            body: `Cursor AgentService HTTP ${status}`,
          }),
        );
      }
    });

    live.stream.on("data", (chunk: Buffer) => {
      if (live.streamCut) return;
      live.buffer = Buffer.concat([live.buffer, chunk]);
      this.consumeBuffer(key, live);
    });

    live.stream.on("end", () =>
      this.finishTurn(key, live, { close: true, force: true }),
    );
    live.stream.on("error", (err) => this.failTurn(key, live, err));
    live.session.on("error", (err) => this.failTurn(key, live, err));
  }

  private waitForTurn(
    key: string,
    live: LiveSession,
    req: ChatRequest,
    onDelta: (delta: StreamDelta) => void,
    signal: AbortSignal,
    touch: () => void,
    noteVisible: () => void,
  ): Promise<ChatResponse> {
    if (signal.aborted) {
      closeLive(key, live);
      const e = new Error("Aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    }
    return new Promise<ChatResponse>((resolve, reject) => {
      const wall = armReasoningOutputWall(providerReasoningWallMs(), () => {
        const turn = live.turn;
        if (!turn || turn.settled) {
          live.streamCut = true;
          closeLive(key, live);
          return;
        }
        if (!turn.finishReason) {
          turn.finishReason = REASONING_WALL_FINISH;
          turn.onDelta({ finish_reason: REASONING_WALL_FINISH });
        }
        live.streamCut = true;
        this.finishTurn(key, live, { close: true });
      });
      live.turn = {
        req,
        onDelta,
        touch,
        noteVisible,
        content: "",
        reasoningContent: "",
        mantraScanAt: 0,
        toolCalls: [],
        finishReason: null,
        resolve,
        reject,
        settled: false,
        wall,
      };
      const onAbort = () => {
        const e = new Error("Aborted");
        e.name = "AbortError";
        this.failTurn(key, live, e);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const prevResolve = resolve;
      const prevReject = reject;
      live.turn.resolve = (r) => {
        signal.removeEventListener("abort", onAbort);
        prevResolve(r);
      };
      live.turn.reject = (e) => {
        signal.removeEventListener("abort", onAbort);
        prevReject(e);
      };
      // Leftover frames from the previous pause (KV after mcpArgs).
      this.consumeBuffer(key, live);
    });
  }

  private consumeBuffer(key: string, live: LiveSession): void {
    while (!live.streamCut && live.buffer.length >= 5) {
      const flags = live.buffer[0]!;
      const len = live.buffer.readUInt32BE(1);
      if (live.buffer.length < 5 + len) break;
      const payload = live.buffer.subarray(5, 5 + len);
      live.buffer = live.buffer.subarray(5 + len);
      try {
        this.handleFrame(key, live, flags, payload);
      } catch (err) {
        this.failTurn(key, live, err);
        return;
      }
    }
  }

  private handleFrame(
    key: string,
    live: LiveSession,
    flags: number,
    payload: Uint8Array,
  ): void {
    if (flags & CONNECT_END_STREAM) {
      const err = parseConnectEndError(payload);
      if (err) {
        throw new ProviderApiError({
          provider: "cursor",
          status: 400,
          body: err,
        });
      }
      this.finishTurn(key, live, { close: true });
      return;
    }
    const events = parseAgentServerMessage(payload);
    if (events.some((e) => e.kind !== "heartbeat")) {
      live.turn?.touch();
    }
    const turn = live.turn;
    for (const ev of events) {
      if (ev.kind !== "usage" || !turn || turn.settled) continue;
      turn.usage = {
        prompt_tokens: ev.prompt_tokens,
        completion_tokens: ev.completion_tokens,
        total_tokens: ev.total_tokens,
        cache_read_input_tokens: ev.cache_read_input_tokens,
        cache_creation_input_tokens: ev.cache_creation_input_tokens,
      };
    }
    for (const ev of events) {
      if (ev.kind === "heartbeat" || ev.kind === "usage") continue;
      if (ev.kind === "turn_ended") {
        if (live.toolFlush) {
          clearTimeout(live.toolFlush);
          live.toolFlush = undefined;
        }
        this.finishTurn(key, live, { close: false });
        continue;
      }
      if (ev.kind === "kv") {
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
        continue;
      }
      if (ev.kind === "interaction") {
        live.write(
          encodeConnectFrame(
            encodeClientMessage({
              interactionResponse: encodeInteractionResponse(ev.id, ev.field),
            }),
          ),
        );
        continue;
      }
      if (ev.kind === "exec" && ev.execKind !== "mcpArgs") {
        this.replyNonMcpExec(live, ev);
        continue;
      }
      if (!turn || turn.settled) {
        if (ev.kind === "exec" && ev.execKind === "mcpArgs") {
          writeExecAndClose(live, {
            id: ev.id,
            execId: ev.execId,
            resultField: 11,
            result: encodeMcpErrorResult("Tool call arrived after turn settled"),
          });
        }
        continue;
      }
      if (ev.kind === "text") {
        turn.content += ev.text;
        turn.noteVisible();
        turn.wall.noteVisibleOutput();
        turn.onDelta({ content: ev.text });
      } else if (ev.kind === "thinking") {
        turn.reasoningContent += ev.text;
        turn.onDelta({ reasoning_content: ev.text });
        if (
          shouldScanReasoningMantra(turn.reasoningContent.length, turn.mantraScanAt)
        ) {
          turn.mantraScanAt = turn.reasoningContent.length;
          if (isReasoningMantra(turn.reasoningContent)) {
            turn.finishReason = REASONING_LOOP_FINISH;
            turn.onDelta({ finish_reason: REASONING_LOOP_FINISH });
            live.streamCut = true;
            this.finishTurn(key, live, { close: true });
            return;
          }
        }
      } else if (ev.kind === "exec" && ev.execKind === "mcpArgs") {
        const mcp = parseMcpArgs(ev.payload);
        const toolCallId = cursorToolCallId(
          mcp.toolCallId,
          ev.execId || randomUUID(),
        );
        const name = mcp.toolName || mcp.name;
        const args = JSON.stringify(mcp.args ?? {});
        const tc: ToolCall = {
          id: toolCallId,
          type: "function",
          function: { name, arguments: args },
        };
        turn.toolCalls.push(tc);
        live.pending.push({
          id: ev.id,
          execId: ev.execId,
          toolCallId,
          toolName: name,
        });
        turn.onDelta({
          tool_calls: [
            {
              index: turn.toolCalls.length - 1,
              id: toolCallId,
              type: "function",
              function: { name, arguments: args },
            },
          ],
        });
        turn.noteVisible();
        turn.wall.noteVisibleOutput();
      }
    }
    if (turn && !turn.settled && live.pending.length) {
      this.scheduleToolFlush(key, live);
    }
  }

  /**
   * Cursor may emit several mcpArgs in consecutive frames. Flushing on the
   * first one dropped the rest (turn.settled) and left the server waiting.
   */
  private scheduleToolFlush(key: string, live: LiveSession): void {
    if (live.toolFlush) clearTimeout(live.toolFlush);
    live.toolFlush = setTimeout(() => {
      live.toolFlush = undefined;
      const turn = live.turn;
      if (!turn || turn.settled || !live.pending.length) return;
      turn.finishReason = "tool_calls";
      turn.onDelta({ finish_reason: "tool_calls" });
      this.finishTurn(key, live, { close: false });
    }, 40);
    live.toolFlush.unref?.();
  }

  private replyNonMcpExec(
    live: LiveSession,
    ev: {
      id: number;
      execId: string;
      execKind: string;
      field: number;
      payload: Uint8Array;
    },
  ): void {
    if (ev.execKind === "requestContextArgs") {
      writeExecAndClose(live, {
        id: ev.id,
        execId: ev.execId,
        resultField: 10,
        result: encodeRequestContextResult(live.requestContext),
      });
      return;
    }
    if (ev.execKind === "mcpStateExecArgs") {
      writeExecAndClose(live, {
        id: ev.id,
        execId: ev.execId,
        resultField: 36,
        result: encodeMcpStateResult(live.mcpTools),
      });
      return;
    }
    if (ev.execKind === "listMcpResourcesExecArgs") {
      writeExecAndClose(live, {
        id: ev.id,
        execId: ev.execId,
        resultField: 17,
        result: encodeListMcpResourcesEmpty(),
      });
      return;
    }
    if (ev.execKind === "readMcpResourceExecArgs") {
      writeExecAndClose(live, {
        id: ev.id,
        execId: ev.execId,
        resultField: 18,
        result: encodeReadMcpResourceError(parsePathArg(ev.payload), REJECT),
      });
      return;
    }
    if (ev.execKind.startsWith("unknown_")) {
      live.write(
        encodeConnectFrame(
          encodeClientMessage({
            execControl: encodeExecClientThrow(ev.id, REJECT),
          }),
        ),
      );
      live.write(
        encodeConnectFrame(
          encodeClientMessage({ execControl: encodeExecStreamClose(ev.id) }),
        ),
      );
      return;
    }
    if (ev.execKind.startsWith("pi") || ev.execKind === "subagentArgs") {
      writeExecAndClose(live, {
        id: ev.id,
        execId: ev.execId,
        resultField: ev.execKind === "subagentArgs" ? 28 : ev.field + 1,
        result: encodeExecErrorResult(REJECT),
      });
      return;
    }
    const rejected = nativeRejectPayload(ev);
    writeExecAndClose(live, {
      id: ev.id,
      execId: ev.execId,
      resultField: rejected.resultField,
      result: rejected.result,
    });
  }

  private finishTurn(
    key: string,
    live: LiveSession,
    opts: { close: boolean; force?: boolean },
  ): void {
    const turn = live.turn;
    if (live.toolFlush) {
      clearTimeout(live.toolFlush);
      live.toolFlush = undefined;
    }
    const closeNow =
      opts.force ||
      shouldCloseCursorLive({
        close: opts.close,
        pendingCount: live.pending.length,
      });
    if (!turn || turn.settled) {
      if (closeNow) closeLive(key, live);
      return;
    }
    turn.settled = true;
    turn.wall.dispose();
    if (live.pending.length) turn.finishReason = "tool_calls";
    if (closeNow) closeLive(key, live);
    turn.resolve({
      id: `cursor-${randomUUID()}`,
      model: turn.req.model,
      message: {
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.length ? turn.toolCalls : undefined,
        reasoning_content: turn.reasoningContent || undefined,
      },
      finish_reason: turn.finishReason || "stop",
      usage: turn.usage,
    });
  }

  private failTurn(key: string, live: LiveSession, err: unknown): void {
    const turn = live.turn;
    closeLive(key, live);
    if (!turn || turn.settled) return;
    turn.settled = true;
    turn.wall.dispose();
    turn.reject(err);
  }
}

/** Unary GetUsableModels — best-effort catalog refresh (Connect-RPC). */
export async function fetchCursorUsableModels(
  apiKey: string,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<Array<{ id: string; name: string }>> {
  const key = apiKey.trim();
  if (!key) return [];
  const base = (opts?.baseUrl || CURSOR_API_BASE).replace(/\/$/, "");
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  return new Promise((resolve) => {
    const session = http2.connect(base);
    const timer = setTimeout(() => {
      session.close();
      resolve([]);
    }, timeoutMs);
    timer.unref?.();
    const fail = () => {
      clearTimeout(timer);
      try {
        session.close();
      } catch {
        /* */
      }
      resolve([]);
    };
    session.on("error", fail);
    session.on("connect", () => {
      const stream = session.request({
        ":method": "POST",
        ":path": MODELS_PATH,
        "content-type": "application/proto",
        te: "trailers",
        authorization: `Bearer ${key}`,
        "x-request-id": randomUUID(),
        ...cursorApiHeaders(),
      });
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        clearTimeout(timer);
        session.close();
        try {
          resolve(parseGetUsableModels(Buffer.concat(chunks)));
        } catch {
          resolve([]);
        }
      });
      stream.on("error", fail);
      stream.end(Buffer.alloc(0));
    });
  });
}

export const CURSOR_FALLBACK_MODELS = [
  "cursor-grok-4.6-xhigh-fast",
  "cursor-grok-4.6-high-fast",
  "cursor-grok-4.6-high",
  "composer-2.5",
  "cursor-grok-4.5-high",
  "claude-fable-5-high",
  "claude-opus-5-high",
  "claude-sonnet-5-high",
  "auto",
] as const;
