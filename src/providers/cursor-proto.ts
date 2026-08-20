/**
 * Minimal protobuf + Connect framing for Cursor AgentService.
 *
 * Field numbers come from agent.v1 (Cursor CLI). We only encode/decode the
 * messages Forge needs: run request, text/thinking deltas, MCP tools, KV
 * blobs, and native-tool rejects.
 */
import { createHash } from "node:crypto";

export const CONNECT_END_STREAM = 0b0000_0010;
export const CONNECT_COMPRESSED = 0b0000_0001;

export function encodeVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

export function decodeVarint(
  buf: Uint8Array,
  offset = 0,
): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i]!;
    result |= (b & 0x7f) << shift;
    i += 1;
    if ((b & 0x80) === 0) return { value: result >>> 0, next: i };
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error("truncated protobuf varint");
}

function key(field: number, wire: number): Buffer {
  return encodeVarint((field << 3) | wire);
}

export function encodeBytes(field: number, data: Uint8Array): Buffer {
  return Buffer.concat([
    key(field, 2),
    encodeVarint(data.length),
    Buffer.from(data),
  ]);
}

export function encodeString(field: number, value: string): Buffer {
  return encodeBytes(field, Buffer.from(value, "utf8"));
}

export function encodeUint32(field: number, value: number): Buffer {
  return Buffer.concat([key(field, 0), encodeVarint(value >>> 0)]);
}

export function encodeBool(field: number, value: boolean): Buffer {
  return encodeUint32(field, value ? 1 : 0);
}

export function encodeMessage(field: number, inner: Uint8Array): Buffer {
  return encodeBytes(field, inner);
}

export interface ProtoField {
  field: number;
  wire: number;
  bytes: Uint8Array;
  varint?: number;
}

export function decodeFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = decodeVarint(buf, i);
    i = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const v = decodeVarint(buf, i);
      out.push({
        field,
        wire,
        bytes: buf.subarray(i, v.next),
        varint: v.value,
      });
      i = v.next;
    } else if (wire === 1) {
      out.push({ field, wire, bytes: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = decodeVarint(buf, i);
      i = len.next;
      out.push({ field, wire, bytes: buf.subarray(i, i + len.value) });
      i += len.value;
    } else if (wire === 5) {
      out.push({ field, wire, bytes: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

export function fieldStr(fields: ProtoField[], n: number): string | undefined {
  const f = fields.find((x) => x.field === n && x.wire === 2);
  if (!f) return undefined;
  return Buffer.from(f.bytes).toString("utf8");
}

export function fieldBytes(
  fields: ProtoField[],
  n: number,
): Uint8Array | undefined {
  return fields.find((x) => x.field === n && x.wire === 2)?.bytes;
}

export function fieldVarint(fields: ProtoField[], n: number): number | undefined {
  return fields.find((x) => x.field === n)?.varint;
}

export function fieldRepeated(
  fields: ProtoField[],
  n: number,
): ProtoField[] {
  return fields.filter((x) => x.field === n);
}

export function encodeConnectFrame(payload: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

/** Connect unary request (empty protobuf is a 5-byte zero-length frame). */
export function encodeConnectUnaryRequest(
  payload: Uint8Array = Buffer.alloc(0),
): Buffer {
  return encodeConnectFrame(payload, 0);
}

/**
 * Connect unary response: framed payload + optional end-stream JSON error.
 * Raw protobuf (no 5-byte prefix) is accepted so we can parse either style.
 */
export function decodeConnectUnaryResponse(buf: Uint8Array): {
  payload: Uint8Array;
  error?: string;
} {
  if (buf.length >= 5) {
    const flags = buf[0]!;
    const len =
      ((buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!) >>> 0;
    const connectFlags = (flags & ~0x03) === 0;
    if (connectFlags && len <= buf.length - 5) {
      const frames = decodeConnectFrames(buf);
      let payload: Uint8Array = new Uint8Array();
      let error: string | undefined;
      for (const fr of frames) {
        if (fr.flags & CONNECT_END_STREAM) {
          error = parseConnectEndError(fr.payload) || error;
        } else if (fr.payload.length) {
          payload = fr.payload;
        }
      }
      return { payload, error };
    }
  }
  return { payload: buf };
}

export function decodeConnectFrames(buf: Uint8Array): Array<{
  flags: number;
  payload: Uint8Array;
}> {
  const frames: Array<{ flags: number; payload: Uint8Array }> = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flags = buf[i]!;
    const view = new DataView(buf.buffer, buf.byteOffset + i, 5);
    const len = view.getUint32(1, false);
    if (i + 5 + len > buf.length) break;
    frames.push({ flags, payload: buf.subarray(i + 5, i + 5 + len) });
    i += 5 + len;
  }
  return frames;
}

/** google.protobuf.Value binary from JSON. */
export function encodeProtobufValue(value: unknown): Buffer {
  if (value === null || value === undefined) {
    return encodeUint32(1, 0); // null_value
  }
  if (typeof value === "number") {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value, 0);
    return Buffer.concat([key(2, 1), buf]);
  }
  if (typeof value === "string") {
    return encodeString(3, value);
  }
  if (typeof value === "boolean") {
    return encodeBool(4, value);
  }
  if (Array.isArray(value)) {
    const items = Buffer.concat(value.map((v) => encodeMessage(1, encodeProtobufValue(v))));
    return encodeMessage(6, items);
  }
  if (typeof value === "object") {
    const entries: Buffer[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      entries.push(
        encodeMessage(1, Buffer.concat([encodeString(1, k), encodeMessage(2, encodeProtobufValue(v))])),
      );
    }
    return encodeMessage(5, Buffer.concat(entries));
  }
  return encodeString(3, String(value));
}

export function decodeProtobufValue(buf: Uint8Array): unknown {
  const fields = decodeFields(buf);
  for (const f of fields) {
    if (f.field === 1) return null;
    if (f.field === 2 && f.bytes.length >= 8) {
      return Buffer.from(f.bytes).readDoubleLE(0);
    }
    if (f.field === 3) return Buffer.from(f.bytes).toString("utf8");
    if (f.field === 4) return Boolean(f.varint);
    if (f.field === 5) {
      const obj: Record<string, unknown> = {};
      for (const entry of decodeFields(f.bytes).filter((x) => x.field === 1)) {
        const inner = decodeFields(entry.bytes);
        const k = fieldStr(inner, 1);
        const vBuf = fieldBytes(inner, 2);
        if (k) obj[k] = vBuf ? decodeProtobufValue(vBuf) : null;
      }
      return obj;
    }
    if (f.field === 6) {
      return decodeFields(f.bytes)
        .filter((x) => x.field === 1)
        .map((x) => decodeProtobufValue(x.bytes));
    }
  }
  return null;
}

export function encodeUserMessage(text: string, messageId: string): Buffer {
  return Buffer.concat([encodeString(1, text), encodeString(2, messageId)]);
}

export function encodeAssistantMessage(text: string): Buffer {
  return encodeString(1, text);
}

export function encodeConversationStepAssistant(text: string): Buffer {
  return encodeMessage(1, encodeAssistantMessage(text));
}

export function encodeAgentTurn(
  userText: string,
  userId: string,
  assistantText?: string,
): Buffer {
  const parts: Buffer[] = [encodeBytes(1, encodeUserMessage(userText, userId))];
  if (assistantText) {
    parts.push(encodeBytes(2, encodeConversationStepAssistant(assistantText)));
  }
  return Buffer.concat(parts);
}

export function encodeTurnStructure(agentTurn: Uint8Array): Buffer {
  return encodeMessage(1, agentTurn);
}

export function encodeConversationState(opts: {
  systemBlobId?: Uint8Array;
  /** Repeated JSON chat messages (`root_prompt_messages_json`). */
  seedJson?: string[];
  turns?: Uint8Array[];
}): Buffer {
  const parts: Buffer[] = [];
  if (opts.seedJson?.length) {
    for (const msg of opts.seedJson) {
      if (msg) parts.push(encodeString(1, msg));
    }
  } else if (opts.systemBlobId && opts.systemBlobId.length) {
    // First turn: content-addressed system blob; server KV-gets the bytes.
    parts.push(encodeBytes(1, opts.systemBlobId));
  }
  for (const t of opts.turns ?? []) {
    parts.push(encodeBytes(8, t));
  }
  return Buffer.concat(parts);
}

/** JSON lines for ConversationStateStructure.seed (rebase / history Runs). */
export function encodeSeedChatJson(opts: {
  systemPrompt: string;
  turns: Array<{ userText: string; assistantText: string }>;
}): string[] {
  const out: string[] = [];
  if (opts.systemPrompt.trim()) {
    out.push(JSON.stringify({ role: "system", content: opts.systemPrompt }));
  }
  for (const t of opts.turns) {
    if (t.userText.trim()) {
      out.push(JSON.stringify({ role: "user", content: t.userText }));
    }
    if (t.assistantText.trim()) {
      out.push(JSON.stringify({ role: "assistant", content: t.assistantText }));
    }
  }
  return out;
}

export function encodeModelParameter(id: string, value: string): Buffer {
  return Buffer.concat([encodeString(1, id), encodeString(2, value)]);
}

/**
 * agent.v1.RequestedModel — field 9 on AgentRunRequest.
 * Parameters: thinking / reasoning / effort / fast (Cursor CLI ModelParameterValue).
 */
export function encodeRequestedModel(opts: {
  modelId: string;
  maxMode?: boolean;
  parameters?: Array<{ id: string; value: string }>;
  isVariantString?: boolean;
}): Buffer {
  const parts = [encodeString(1, opts.modelId)];
  if (opts.maxMode) parts.push(encodeBool(2, true));
  for (const p of opts.parameters ?? []) {
    parts.push(encodeMessage(3, encodeModelParameter(p.id, p.value)));
  }
  if (opts.isVariantString) parts.push(encodeBool(8, true));
  return Buffer.concat(parts);
}

/**
 * agent.v1.ModelDetails.
 * thinking_details (2) is an empty message: present = thinking on.
 * max_mode (7) is Cursor Max Mode / 1M context.
 */
export function encodeModelDetails(
  modelId: string,
  opts?: { thinking?: boolean; maxMode?: boolean },
): Buffer {
  const parts = [
    encodeString(1, modelId),
    encodeString(3, modelId),
    encodeString(4, modelId),
    encodeString(5, modelId),
  ];
  if (opts?.thinking) {
    parts.push(encodeMessage(2, Buffer.alloc(0)));
  }
  if (opts?.maxMode) {
    parts.push(encodeBool(7, true));
  }
  return Buffer.concat(parts);
}

export function encodeMcpToolDefinition(opts: {
  name: string;
  description: string;
  parameters: unknown;
}): Buffer {
  return Buffer.concat([
    encodeString(1, opts.name),
    encodeString(2, opts.description || ""),
    encodeBytes(3, encodeProtobufValue(opts.parameters ?? { type: "object" })),
    encodeString(4, "forge"),
    encodeString(5, opts.name),
  ]);
}

export function encodeMcpTools(defs: Uint8Array[]): Buffer {
  return Buffer.concat(defs.map((d) => encodeMessage(1, d)));
}

export function encodeRequestContextEnv(opts: {
  osVersion: string;
  workspace: string;
  shell: string;
  timeZone: string;
  projectFolder: string;
  isHome: boolean;
}): Buffer {
  const ws = opts.workspace;
  return Buffer.concat([
    encodeString(1, opts.osVersion),
    encodeString(2, ws),
    encodeString(3, opts.shell),
    encodeBool(5, false),
    encodeString(7, `${opts.projectFolder}/terminals`),
    encodeString(10, opts.timeZone),
    encodeString(11, opts.projectFolder),
    encodeString(12, `${opts.projectFolder}/agent-transcripts`),
    encodeBool(14, false),
    encodeBool(20, opts.isHome),
    encodeString(21, ws),
  ]);
}

/** RequestContextPayload: env (#4) + tools (#7) + complete flags. */
export function encodeRequestContext(opts: {
  env: Uint8Array;
  toolDefs: Uint8Array[];
  projectFolder: string;
}): Buffer {
  const parts = [
    encodeMessage(4, opts.env),
    ...opts.toolDefs.map((d) => encodeMessage(7, d)),
    encodeBool(17, false),
    encodeBool(24, false),
    encodeBool(40, true),
    encodeBool(44, true),
  ];
  const fsOpts = Buffer.concat([
    encodeBool(1, true),
    encodeString(2, opts.projectFolder),
  ]);
  parts.push(encodeMessage(23, fsOpts));
  return Buffer.concat(parts);
}

export function encodeRequestContextResult(ctx: Uint8Array): Buffer {
  const success = encodeMessage(1, ctx);
  return encodeMessage(1, success);
}

/** ConversationHistoryTextContent — `{ text }`. */
export function encodeHistoryTextContent(text: string): Buffer {
  return encodeString(1, text);
}

export type CursorHistoryMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text?: string;
      reasoning?: string;
      toolCalls?: Array<{ id: string; name: string; args: string }>;
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      text: string;
      isError?: boolean;
    };

/**
 * agent.v1.ConversationHistory — typed user/assistant/tool replay.
 * Attach on UserMessageAction.conversation_history (field 7), not on
 * ConversationState.root_prompt_messages_json (that slot is the system blob).
 */
export function encodeConversationHistory(
  messages: CursorHistoryMessage[],
): Buffer | undefined {
  const parts: Buffer[] = [];
  for (const m of messages) {
    const encoded = encodeConversationHistoryMessage(m);
    if (encoded) parts.push(encodeMessage(1, encoded));
  }
  if (!parts.length) return undefined;
  return Buffer.concat(parts);
}

export function encodeConversationHistoryMessage(
  m: CursorHistoryMessage,
): Buffer | undefined {
  if (m.role === "user") {
    const text = m.text.trim();
    if (!text) return undefined;
    const content = encodeMessage(1, encodeHistoryTextContent(text));
    return encodeMessage(1, encodeMessage(1, content));
  }
  if (m.role === "assistant") {
    const contents: Buffer[] = [];
    if (m.text?.trim()) {
      contents.push(encodeMessage(1, encodeHistoryTextContent(m.text)));
    }
    if (m.reasoning?.trim()) {
      contents.push(encodeMessage(2, encodeString(1, m.reasoning)));
    }
    for (const tc of m.toolCalls ?? []) {
      contents.push(
        encodeMessage(
          4,
          Buffer.concat([
            encodeString(1, tc.id),
            encodeString(2, tc.name),
            encodeString(3, tc.args || "{}"),
          ]),
        ),
      );
    }
    if (!contents.length) return undefined;
    const assistant = Buffer.concat(
      contents.map((c) => encodeMessage(1, c)),
    );
    return encodeMessage(2, assistant);
  }
  const toolParts = [
    encodeString(1, m.toolCallId),
    encodeString(2, m.toolName || "tool"),
    encodeMessage(3, encodeMessage(1, encodeHistoryTextContent(m.text || ""))),
  ];
  if (m.isError) toolParts.push(encodeBool(4, true));
  return encodeMessage(3, Buffer.concat(toolParts));
}

export function encodeUserMessageAction(
  text: string,
  messageId: string,
  requestContext?: Uint8Array,
  conversationHistory?: Uint8Array,
): Buffer {
  const parts = [encodeMessage(1, encodeUserMessage(text, messageId))];
  if (requestContext && requestContext.length) {
    parts.push(encodeMessage(2, requestContext));
  }
  if (conversationHistory && conversationHistory.length) {
    parts.push(encodeMessage(7, conversationHistory));
  }
  return Buffer.concat(parts);
}

export function encodeConversationActionUser(
  text: string,
  messageId: string,
  requestContext?: Uint8Array,
  conversationHistory?: Uint8Array,
): Buffer {
  return encodeMessage(
    1,
    encodeUserMessageAction(
      text,
      messageId,
      requestContext,
      conversationHistory,
    ),
  );
}

export function encodeAgentRunRequest(opts: {
  conversationState: Uint8Array;
  action: Uint8Array;
  modelId: string;
  conversationId: string;
  mcpTools?: Uint8Array;
  thinking?: boolean;
  maxMode?: boolean;
  parameters?: Array<{ id: string; value: string }>;
  isVariantString?: boolean;
}): Buffer {
  const parts = [
    encodeMessage(1, opts.conversationState),
    encodeMessage(2, opts.action),
    encodeMessage(
      3,
      encodeModelDetails(opts.modelId, {
        thinking: opts.thinking,
        maxMode: opts.maxMode,
      }),
    ),
  ];
  if (opts.mcpTools && opts.mcpTools.length) {
    parts.push(encodeMessage(4, opts.mcpTools));
  }
  parts.push(encodeString(5, opts.conversationId));
  // requested_model (9) is optional. Sending a partial RequestedModel made
  // AgentService return Connect `internal`; the CLI often omits it and puts
  // the catalog variant id on model_details alone.
  return Buffer.concat(parts);
}

export function encodeClientMessage(opts: {
  runRequest?: Uint8Array;
  execClient?: Uint8Array;
  kvClient?: Uint8Array;
  conversationAction?: Uint8Array;
  execControl?: Uint8Array;
  interactionResponse?: Uint8Array;
  heartbeat?: boolean;
}): Buffer {
  if (opts.runRequest) return encodeMessage(1, opts.runRequest);
  if (opts.execClient) return encodeMessage(2, opts.execClient);
  if (opts.kvClient) return encodeMessage(3, opts.kvClient);
  if (opts.conversationAction) return encodeMessage(4, opts.conversationAction);
  if (opts.execControl) return encodeMessage(5, opts.execControl);
  if (opts.interactionResponse) return encodeMessage(6, opts.interactionResponse);
  if (opts.heartbeat) return encodeMessage(7, Buffer.alloc(0));
  return Buffer.alloc(0);
}

/** ACM #5 stream_close — without this, AgentService waits on heartbeats forever. */
export function encodeExecStreamClose(id: number): Buffer {
  return encodeMessage(1, encodeUint32(1, id));
}

/** ACM #5 throw — unblocks an exec variant we cannot satisfy. */
export function encodeExecClientThrow(id: number, error: string): Buffer {
  return encodeMessage(
    2,
    Buffer.concat([encodeUint32(1, id), encodeString(2, error)]),
  );
}

export function encodeMcpStateResult(toolDefs: Uint8Array[]): Buffer {
  const server = Buffer.concat([
    encodeString(1, "forge"),
    encodeString(2, "forge"),
    ...toolDefs.map((d) => encodeMessage(5, d)),
    encodeString(7, "ready"),
  ]);
  return encodeMessage(1, encodeMessage(1, server));
}

export function encodeListMcpResourcesEmpty(): Buffer {
  return encodeMessage(1, Buffer.alloc(0));
}

export function encodeReadMcpResourceError(uri: string, error: string): Buffer {
  return encodeMessage(
    2,
    Buffer.concat([encodeString(1, uri), encodeString(2, error)]),
  );
}

export function encodeExecErrorResult(error: string): Buffer {
  return encodeMessage(2, encodeString(1, error));
}

const INTERACTION_REJECT =
  "Not available in this environment. Use the MCP tools provided instead.";

/** Headless InteractionResponse — reject UI queries so the Run does not wait. */
export function encodeInteractionResponse(
  id: number,
  variantField: number,
): Buffer {
  const reason = encodeString(1, INTERACTION_REJECT);
  let body: Buffer;
  if (variantField === 8) {
    body = encodeMessage(8, encodeMessage(1, Buffer.alloc(0)));
  } else if (variantField === 3) {
    body = encodeMessage(3, encodeMessage(1, encodeMessage(3, reason)));
  } else if (variantField === 7) {
    body = encodeMessage(7, encodeMessage(1, encodeMessage(2, reason)));
  } else if (variantField === 10) {
    body = encodeMessage(10, encodeMessage(3, reason));
  } else if (variantField === 13) {
    body = encodeMessage(13, encodeMessage(2, reason));
  } else {
    const field = variantField > 0 ? variantField : 2;
    body = encodeMessage(field, encodeMessage(2, reason));
  }
  return Buffer.concat([encodeUint32(1, id), body]);
}

export function encodeExecClient(opts: {
  id: number;
  execId: string;
  resultField: number;
  result: Uint8Array;
}): Buffer {
  return Buffer.concat([
    encodeUint32(1, opts.id),
    encodeString(15, opts.execId),
    encodeMessage(opts.resultField, opts.result),
  ]);
}

export function encodeKvClient(opts: {
  id: number;
  getBlob?: Uint8Array | null;
  setBlob?: boolean;
}): Buffer {
  const parts = [encodeUint32(1, opts.id)];
  if (opts.getBlob !== undefined) {
    parts.push(
      encodeMessage(
        2,
        opts.getBlob && opts.getBlob.length
          ? encodeBytes(1, opts.getBlob)
          : Buffer.alloc(0),
      ),
    );
  } else if (opts.setBlob) {
    parts.push(encodeMessage(3, Buffer.alloc(0)));
  }
  return Buffer.concat(parts);
}

export function encodeMcpSuccessResult(text: string, isError = false): Buffer {
  const textContent = encodeString(1, text);
  const item = encodeMessage(1, textContent);
  const success = Buffer.concat([
    encodeMessage(1, item),
    encodeBool(2, isError),
  ]);
  return encodeMessage(1, success);
}

export function encodeMcpErrorResult(error: string): Buffer {
  return encodeMessage(2, encodeString(1, error));
}

export function encodeRejected(pathOrCmd: string, reason: string, extra?: {
  workingDirectory?: string;
}): Buffer {
  const parts = [encodeString(1, pathOrCmd), encodeString(2, reason)];
  if (extra?.workingDirectory != null) {
    // ShellRejected: command=1, workingDirectory=2, reason=3
    return Buffer.concat([
      encodeString(1, pathOrCmd),
      encodeString(2, extra.workingDirectory),
      encodeString(3, reason),
      encodeBool(4, false),
    ]);
  }
  return Buffer.concat(parts);
}

export function encodeNativeReject(
  resultField: number,
  rejectField: number,
  inner: Uint8Array,
): Buffer {
  return encodeMessage(resultField, encodeMessage(rejectField, inner));
}

export function sha256Bytes(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

export function systemPromptBlob(systemPrompt: string): {
  id: Buffer;
  data: Buffer;
} {
  const json = JSON.stringify({ role: "system", content: systemPrompt });
  const data = Buffer.from(json, "utf8");
  return { id: sha256Bytes(data), data };
}

export type CursorServerEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "heartbeat" }
  | { kind: "turn_ended" }
  | {
      kind: "exec";
      id: number;
      execId: string;
      execKind: string;
      field: number;
      payload: Uint8Array;
    }
  | {
      kind: "kv";
      id: number;
      kvKind: "get" | "set";
      blobId: Uint8Array;
      blobData?: Uint8Array;
    }
  | {
      kind: "interaction";
      id: number;
      field: number;
    }
  | {
      kind: "usage";
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }
  | { kind: "end"; error?: string };

/**
 * InteractionUpdate.turn_ended (#14): input, output, cache_read, cache_write,
 * reasoning. Not the nested junk on fields 5/6/8.
 */
export function parseTurnEnded(buf: Uint8Array): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} | undefined {
  const fields = decodeFields(buf);
  if (!fields.length) return undefined;
  if (fields.some((f) => f.wire !== 0)) return undefined;
  const prompt = fieldVarint(fields, 1) ?? 0;
  const output = fieldVarint(fields, 2) ?? 0;
  const cacheRead = fieldVarint(fields, 3) ?? 0;
  const cacheWrite = fieldVarint(fields, 4) ?? 0;
  const reasoning = fieldVarint(fields, 5) ?? 0;
  if (
    prompt === 0 &&
    output === 0 &&
    cacheRead === 0 &&
    cacheWrite === 0 &&
    reasoning === 0
  ) {
    return undefined;
  }
  if (prompt > 100_000_000 || output > 100_000_000) return undefined;
  const completion = output + reasoning;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
  };
}

/** @deprecated TurnEnded is the usage source; kept for tests of the old path. */
export function parseUsageFields(
  buf: Uint8Array,
): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} | undefined {
  const ended = parseTurnEnded(buf);
  if (!ended) return undefined;
  if (ended.prompt_tokens < 32 && !ended.cache_read_input_tokens) {
    return undefined;
  }
  return {
    prompt_tokens: ended.prompt_tokens,
    completion_tokens: ended.completion_tokens,
    total_tokens: ended.total_tokens,
  };
}

const EXEC_KIND: Record<number, string> = {
  2: "shellArgs",
  3: "writeArgs",
  4: "deleteArgs",
  5: "grepArgs",
  7: "readArgs",
  8: "lsArgs",
  9: "diagnosticsArgs",
  10: "requestContextArgs",
  11: "mcpArgs",
  14: "shellStreamArgs",
  16: "backgroundShellSpawnArgs",
  17: "listMcpResourcesExecArgs",
  18: "readMcpResourceExecArgs",
  20: "fetchArgs",
  21: "recordScreenArgs",
  22: "computerUseArgs",
  23: "writeShellStdinArgs",
  28: "subagentArgs",
  36: "mcpStateExecArgs",
  45: "piReadArgs",
  46: "piBashArgs",
  47: "piEditArgs",
  48: "piWriteArgs",
  49: "piGrepArgs",
  50: "piFindArgs",
  51: "piLsArgs",
};

const EXEC_META_FIELDS = new Set([1, 15, 19]);

export function parseMcpArgs(payload: Uint8Array): {
  name: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
} {
  const fields = decodeFields(payload);
  const args: Record<string, unknown> = {};
  for (const entry of fieldRepeated(fields, 2)) {
    const inner = decodeFields(entry.bytes);
    const k = fieldStr(inner, 1);
    const v = fieldBytes(inner, 2);
    if (k) args[k] = v ? decodeProtobufValue(v) : null;
  }
  return {
    name: fieldStr(fields, 1) || "",
    toolCallId: fieldStr(fields, 3) || "",
    toolName: fieldStr(fields, 5) || fieldStr(fields, 1) || "",
    args,
  };
}

export function parsePathArg(payload: Uint8Array): string {
  return fieldStr(decodeFields(payload), 1) || "";
}

export function parseShellArg(payload: Uint8Array): {
  command: string;
  workingDirectory: string;
} {
  const f = decodeFields(payload);
  return {
    command: fieldStr(f, 1) || "",
    workingDirectory: fieldStr(f, 2) || "",
  };
}

export function parseAgentServerMessage(payload: Uint8Array): CursorServerEvent[] {
  const events: CursorServerEvent[] = [];
  const fields = decodeFields(payload);
  for (const f of fields) {
    if (f.field === 1 && f.wire === 2) {
      // InteractionUpdate — text_delta=1, thinking_delta=4 (nested { text=1 })
      const inner = decodeFields(f.bytes);
      const textMsg = fieldBytes(inner, 1);
      if (textMsg) {
        const t = fieldStr(decodeFields(textMsg), 1);
        if (t) events.push({ kind: "text", text: t });
      }
      const thinkMsg = fieldBytes(inner, 4);
      if (thinkMsg) {
        const t = fieldStr(decodeFields(thinkMsg), 1);
        if (t) events.push({ kind: "thinking", text: t });
      }
      if (inner.some((x) => x.field === 13)) {
        events.push({ kind: "heartbeat" });
      }
      const endedBuf = fieldBytes(inner, 14);
      if (endedBuf) {
        const usage = parseTurnEnded(endedBuf);
        if (usage) events.push({ kind: "usage", ...usage });
        events.push({ kind: "turn_ended" });
      }
    } else if (f.field === 2 && f.wire === 2) {
      const inner = decodeFields(f.bytes);
      const id = fieldVarint(inner, 1) ?? 0;
      const execId = fieldStr(inner, 15) || "";
      let found = false;
      for (const [num, name] of Object.entries(EXEC_KIND)) {
        const n = Number(num);
        const payloadBytes = fieldBytes(inner, n);
        if (payloadBytes) {
          found = true;
          events.push({
            kind: "exec",
            id,
            execId,
            execKind: name,
            field: n,
            payload: payloadBytes,
          });
        }
      }
      if (!found) {
        for (const innerF of inner) {
          if (innerF.wire !== 2 || EXEC_META_FIELDS.has(innerF.field)) continue;
          events.push({
            kind: "exec",
            id,
            execId,
            execKind: `unknown_${innerF.field}`,
            field: innerF.field,
            payload: innerF.bytes,
          });
          break;
        }
      }
    } else if (f.field === 7 && f.wire === 2) {
      const inner = decodeFields(f.bytes);
      const id = fieldVarint(inner, 1) ?? 0;
      const variant = inner.find((x) => x.wire === 2 && x.field !== 1);
      events.push({
        kind: "interaction",
        id,
        field: variant?.field ?? 0,
      });
    } else if (f.field === 4 && f.wire === 2) {
      const inner = decodeFields(f.bytes);
      const id = fieldVarint(inner, 1) ?? 0;
      const get = fieldBytes(inner, 2);
      const set = fieldBytes(inner, 3);
      if (get) {
        const g = decodeFields(get);
        events.push({
          kind: "kv",
          id,
          kvKind: "get",
          blobId: fieldBytes(g, 1) || new Uint8Array(),
        });
      } else if (set) {
        const s = decodeFields(set);
        events.push({
          kind: "kv",
          id,
          kvKind: "set",
          blobId: fieldBytes(s, 1) || new Uint8Array(),
          blobData: fieldBytes(s, 2),
        });
      }
    } else if (f.field === 5 && f.wire === 2) {
      const usage = parseTurnEnded(f.bytes);
      if (usage && usage.prompt_tokens >= 32) {
        events.push({ kind: "usage", ...usage });
      }
    }
  }
  return events;
}

export function parseConnectEndError(payload: Uint8Array): string | undefined {
  try {
    const json = JSON.parse(Buffer.from(payload).toString("utf8")) as {
      error?: { code?: string; message?: string };
    };
    if (json.error) {
      return `${json.error.code || "error"}: ${json.error.message || "unknown"}`;
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function parseGetUsableModels(payload: Uint8Array): Array<{
  id: string;
  name: string;
}> {
  const { payload: inner, error } = decodeConnectUnaryResponse(payload);
  if (error && !inner.length) return [];
  const fields = decodeFields(inner);
  const models: Array<{ id: string; name: string }> = [];
  for (const m of fieldRepeated(fields, 1)) {
    const f = decodeFields(m.bytes);
    const id = fieldStr(f, 1) || "";
    if (!id) continue;
    const name =
      fieldStr(f, 4) || fieldStr(f, 5) || fieldStr(f, 3) || id;
    models.push({ id, name });
  }
  return models;
}

export function hexKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
