import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCursorAuthFileToken,
  cursorApiHeaders,
  isCursorProvider,
  CURSOR_PROVIDER_ID,
  CURSOR_API_BASE,
  generateCursorAuthParams,
  decodeJwtPayload,
  cursorTokenExpiryEpoch,
  emailFromCursorToken,
  looksLikeCursorApiKey,
  storeCursorFromAccessToken,
  refreshCursorToken,
} from "../src/auth/cursor.js";
import { normalizeProviderId, providerIdHelp } from "../src/util/provider-id.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { createProvider } from "../src/providers/factory.js";
import { supportsOAuth, getOAuthProfile } from "../src/auth/login.js";
import {
  CursorProvider,
  applyCursorReconnectAction,
  buildCursorConversationState,
  collectCursorToolResults,
  CURSOR_CONTINUE_PROMPT,
  cursorShouldResumeLive,
  prepareCursorConversation,
  shouldCloseCursorLive,
} from "../src/providers/cursor.js";
import {
  encodeProtobufValue,
  decodeProtobufValue,
  encodeUserMessage,
  decodeFields,
  fieldStr,
  encodeConnectFrame,
  encodeConnectUnaryRequest,
  decodeConnectUnaryResponse,
  decodeConnectFrames,
  parseAgentServerMessage,
  parseGetUsableModels,
  parseTurnEnded,
  parseUsageFields,
  encodeClientMessage,
  encodeConversationActionUser,
  encodeConversationHistory,
  encodeConversationState,
  encodeExecClientThrow,
  encodeExecStreamClose,
  encodeInteractionResponse,
  encodeMcpStateResult,
  encodeMcpToolDefinition,
  encodeMessage,
  encodeRequestContext,
  encodeRequestContextEnv,
  encodeString,
  encodeUint32,
  fieldBytes,
  CONNECT_END_STREAM,
} from "../src/providers/cursor-proto.js";
import { estimateCostUsd } from "../src/util/format.js";
import { providerSupportsRemoteCatalog } from "../src/config/model-catalog.js";
import {
  upsertOAuth,
  getCredential,
  getAccount,
  listAccounts,
  clearAllCredentials,
} from "../src/auth/store.js";
import { refreshCredentialIfNeeded } from "../src/auth/refresh.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

describe("cursor provider id", () => {
  it("normalizes cursor aliases", () => {
    assert.deepEqual(normalizeProviderId("cursor"), {
      ok: true,
      provider: "cursor",
    });
    assert.deepEqual(normalizeProviderId("cursor-ai"), {
      ok: true,
      provider: "cursor",
    });
    assert.deepEqual(normalizeProviderId("cursorai"), {
      ok: true,
      provider: "cursor",
    });
    assert.ok(providerIdHelp().includes("cursor"));
  });

  it("isCursorProvider recognizes aliases", () => {
    assert.equal(isCursorProvider("cursor"), true);
    assert.equal(isCursorProvider("cursor-ai"), true);
    assert.equal(isCursorProvider("xai"), false);
  });

  it("ships in DEFAULT_CONFIG with oauth + cursor base", () => {
    const p = DEFAULT_CONFIG.providers.cursor;
    assert.ok(p);
    assert.equal(p.supportsOAuth, true);
    assert.equal(p.baseUrl, "https://api2.cursor.sh");
    assert.equal(p.defaultModel, "cursor-grok-4.6-xhigh-fast");
    assert.ok(p.models?.includes("composer-2.5"));
    assert.ok(p.models?.includes("cursor-grok-4.6-xhigh-fast"));
    assert.ok(p.models?.includes("claude-fable-5"));
  });

  it("supportsOAuth and profile for cursor", () => {
    assert.equal(supportsOAuth("cursor"), true);
    const profile = getOAuthProfile("cursor");
    assert.ok(profile);
    assert.ok(profile!.authorizeUrl.includes("cursor.com"));
  });
});

describe("cursor local config readers", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cursor-"));
    prevHome = process.env.HOME;
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = tmp;
    process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads accessToken from ~/.cursor/auth.json", () => {
    const dir = path.join(tmp, ".cursor");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        accessToken: "eyJhbGciOiJub25lIn0.e30.sig",
        refreshToken: "refresh-local",
        email: "dev@cursor.test",
      }),
      "utf8",
    );
    const got = readCursorAuthFileToken();
    assert.ok(got);
    assert.equal(got!.accessToken, "eyJhbGciOiJub25lIn0.e30.sig");
    assert.equal(got!.refreshToken, "refresh-local");
    assert.equal(got!.email, "dev@cursor.test");
    assert.ok(got!.source.includes("auth.json"));
  });

  it("reads sdk auth.json apiKey", () => {
    const dir = path.join(tmp, ".cursor", "sdk");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ apiKey: "crsr_sdk_test_key_abcdefghijklmnopqrstuvwxyz" }),
      "utf8",
    );
    const got = readCursorAuthFileToken();
    assert.ok(got);
    assert.ok(got!.accessToken.startsWith("crsr_"));
  });

  it("returns null when no local files", () => {
    assert.equal(readCursorAuthFileToken(), null);
  });
});

describe("cursor tokens + headers + factory", () => {
  it("parses JWT expiry and email", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = fakeJwt({ exp, email: "ada@cursor.test" });
    assert.equal(emailFromCursorToken(token), "ada@cursor.test");
    const got = cursorTokenExpiryEpoch(token);
    assert.ok(got < exp);
    assert.ok(got > exp - 10 * 60);
    assert.equal(looksLikeCursorApiKey("crsr_abc"), true);
    assert.equal(looksLikeCursorApiKey(token), false);
  });

  it("decodeJwtPayload rejects junk", () => {
    assert.equal(decodeJwtPayload("not-a-jwt"), null);
  });

  it("generateCursorAuthParams builds loginDeepControl URL", () => {
    const p = generateCursorAuthParams();
    assert.ok(p.uuid);
    assert.ok(p.verifier);
    assert.ok(p.challenge);
    assert.ok(p.loginUrl.includes("loginDeepControl"));
    assert.ok(p.loginUrl.includes(p.uuid));
    assert.ok(p.loginUrl.includes("redirectTarget=cli"));
  });

  it("sets Cursor CLI headers", () => {
    const h = cursorApiHeaders();
    assert.equal(h["x-ghost-mode"], "true");
    assert.equal(h["x-cursor-client-type"], "cli");
    assert.ok(h["x-cursor-client-version"]?.startsWith("cli-"));
  });

  it("createProvider returns CursorProvider", () => {
    const provider = createProvider(DEFAULT_CONFIG, {
      provider: "cursor",
      method: "subscription",
      token: "cursor-access",
      baseUrl: CURSOR_API_BASE,
    });
    assert.equal(provider.id, "cursor");
    assert.ok(provider instanceof CursorProvider);
    assert.equal(typeof provider.chat, "function");
    assert.equal(typeof provider.chatStream, "function");
  });
});

describe("cursor proto codec", () => {
  it("roundtrips protobuf JSON values", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    const encoded = encodeProtobufValue(schema);
    const decoded = decodeProtobufValue(encoded) as typeof schema;
    assert.equal(decoded.type, "object");
    assert.equal((decoded.properties as { path: { type: string } }).path.type, "string");
    assert.deepEqual(decoded.required, ["path"]);
  });

  it("encodes user messages", () => {
    const buf = encodeUserMessage("hello", "msg-1");
    const fields = decodeFields(buf);
    assert.equal(fieldStr(fields, 1), "hello");
    assert.equal(fieldStr(fields, 2), "msg-1");
  });

  it("frames and unframes Connect messages", () => {
    const inner = encodeClientMessage({ heartbeat: true });
    const frame = encodeConnectFrame(inner);
    const frames = decodeConnectFrames(frame);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.flags, 0);
    assert.deepEqual(Buffer.from(frames[0]!.payload), inner);
  });

  it("parses text deltas from AgentServerMessage", () => {
    // interaction_update=1 { text_delta=1 { text=1 "hi" } }
    const payload = encodeMessage(1, encodeMessage(1, encodeString(1, "hi")));
    const events = parseAgentServerMessage(payload);
    assert.ok(events.some((e) => e.kind === "text" && e.text === "hi"));
  });

  it("parses connect end-stream errors", () => {
    const frame = encodeConnectFrame(
      Buffer.from(JSON.stringify({ error: { code: "unauthenticated", message: "nope" } })),
      CONNECT_END_STREAM,
    );
    const frames = decodeConnectFrames(frame);
    assert.equal(frames[0]!.flags & CONNECT_END_STREAM, CONNECT_END_STREAM);
  });

  it("decodes Connect unary frames and raw proto", () => {
    const inner = encodeMessage(1, encodeString(1, "composer-2.5"));
    const framed = encodeConnectUnaryRequest(inner);
    const decoded = decodeConnectUnaryResponse(framed);
    assert.deepEqual(Buffer.from(decoded.payload), inner);
    const raw = decodeConnectUnaryResponse(inner);
    assert.deepEqual(Buffer.from(raw.payload), inner);
  });

  it("parses GetUsableModels through Connect framing", () => {
    const model = Buffer.concat([
      encodeString(1, "composer-2.5"),
      encodeString(4, "Composer 2.5"),
    ]);
    const body = encodeMessage(1, model);
    const framed = encodeConnectUnaryRequest(body);
    const models = parseGetUsableModels(framed);
    assert.equal(models.length, 1);
    assert.equal(models[0]!.id, "composer-2.5");
    assert.equal(models[0]!.name, "Composer 2.5");
  });

  it("parses TurnEnded usage + cache_read from InteractionUpdate field 14", () => {
    const ended = Buffer.concat([
      encodeUint32(1, 48_000),
      encodeUint32(2, 900),
      encodeUint32(3, 40_000),
      encodeUint32(4, 0),
      encodeUint32(5, 200),
    ]);
    const payload = encodeMessage(1, encodeMessage(14, ended));
    const events = parseAgentServerMessage(payload);
    const hit = events.find((e) => e.kind === "usage");
    assert.ok(hit && hit.kind === "usage");
    assert.equal(hit.prompt_tokens, 48_000);
    assert.equal(hit.completion_tokens, 1_100);
    assert.equal(hit.cache_read_input_tokens, 40_000);
    assert.ok(events.some((e) => e.kind === "turn_ended"));
    const parsed = parseTurnEnded(ended);
    assert.equal(parsed?.cache_read_input_tokens, 40_000);
    assert.equal(parseUsageFields(encodeString(1, "nope")), undefined);
    assert.equal(parseUsageFields(encodeUint32(1, 11)), undefined);
  });

  it("RequestContext env carries the real workspace, not a stale IDE cwd", () => {
    const env = encodeRequestContextEnv({
      osVersion: "darwin",
      workspace: "/Users/s./code/hobby/forge-agent",
      shell: "/bin/zsh",
      timeZone: "UTC",
      projectFolder: "/tmp/cursor-projects/forge",
      isHome: false,
    });
    const ctx = encodeRequestContext({
      env,
      toolDefs: [],
      projectFolder: "/tmp/cursor-projects/forge",
    });
    const fields = decodeFields(ctx);
    const envBuf = fieldBytes(fields, 4);
    assert.ok(envBuf);
    assert.equal(
      fieldStr(decodeFields(envBuf), 21),
      "/Users/s./code/hobby/forge-agent",
    );
    const action = encodeConversationActionUser("hi", "m1", ctx);
    const uma = decodeFields(decodeFields(action)[0]!.bytes);
    assert.ok(uma.some((f) => f.field === 2));
  });

  it("does not treat InteractionUpdate fields 5/6/8 as usage", () => {
    const junk = Buffer.concat([
      encodeUint32(1, 5),
      encodeUint32(2, 2),
      encodeUint32(3, 11),
    ]);
    const inner = Buffer.concat([
      encodeMessage(1, encodeString(1, "hi")),
      encodeMessage(5, junk),
    ]);
    const events = parseAgentServerMessage(encodeMessage(1, inner));
    assert.ok(events.some((e) => e.kind === "text"));
    assert.equal(events.some((e) => e.kind === "usage"), false);
  });

  it("encodes exec stream_close as ACM field 5", () => {
    const inner = encodeExecStreamClose(7);
    const framed = encodeClientMessage({ execControl: inner });
    const fields = decodeFields(framed);
    assert.equal(fields[0]!.field, 5);
    const close = decodeFields(fields[0]!.bytes);
    assert.equal(close[0]!.field, 1);
  });

  it("parses mcp_state / unknown execs and interaction queries", () => {
    const mcpState = encodeMessage(
      2,
      Buffer.concat([
        encodeUint32(1, 3),
        encodeMessage(36, encodeString(1, "forge")),
      ]),
    );
    const st = parseAgentServerMessage(mcpState);
    assert.equal(st[0]?.kind, "exec");
    if (st[0]?.kind === "exec") {
      assert.equal(st[0].execKind, "mcpStateExecArgs");
      assert.equal(st[0].id, 3);
    }

    const unknown = encodeMessage(
      2,
      Buffer.concat([
        encodeUint32(1, 9),
        encodeMessage(99, encodeString(1, "x")),
      ]),
    );
    const unk = parseAgentServerMessage(unknown);
    assert.equal(unk[0]?.kind, "exec");
    if (unk[0]?.kind === "exec") {
      assert.equal(unk[0].execKind, "unknown_99");
    }

    const iq = encodeMessage(
      7,
      Buffer.concat([encodeUint32(1, 4), encodeMessage(2, encodeString(1, "q"))]),
    );
    const q = parseAgentServerMessage(iq);
    assert.equal(q[0]?.kind, "interaction");
    if (q[0]?.kind === "interaction") {
      assert.equal(q[0].id, 4);
      assert.equal(q[0].field, 2);
    }
  });

  it("encodes mid-run conversation_action as ACM field 4", () => {
    const framed = encodeClientMessage({
      conversationAction: encodeConversationActionUser("admit", "m9"),
    });
    const fields = decodeFields(framed);
    assert.equal(fields[0]!.field, 4);
  });

  it("encodes interaction reject as ACM field 6", () => {
    const framed = encodeClientMessage({
      interactionResponse: encodeInteractionResponse(4, 2),
    });
    const fields = decodeFields(framed);
    assert.equal(fields[0]!.field, 6);
    const inner = decodeFields(fields[0]!.bytes);
    assert.equal(inner.some((f) => f.field === 1 && f.varint === 4), true);
    assert.equal(inner.some((f) => f.field === 2), true);
  });

  it("encodes mcp_state success with forge tools", () => {
    const def = encodeMcpToolDefinition({
      name: "list_dir",
      description: "list",
      parameters: { type: "object" },
    });
    const buf = encodeMcpStateResult([def]);
    const result = decodeFields(buf);
    assert.equal(result[0]!.field, 1);
  });

  it("encodes exec throw as ACM control field 2", () => {
    const framed = encodeClientMessage({
      execControl: encodeExecClientThrow(8, "nope"),
    });
    const fields = decodeFields(framed);
    assert.equal(fields[0]!.field, 5);
    const ctrl = decodeFields(fields[0]!.bytes);
    assert.equal(ctrl[0]!.field, 2);
  });

  it("ConversationState on every Run is the system blob, not chat JSON", () => {
    const { state } = buildCursorConversationState("You are Forge.");
    const fields = decodeFields(state);
    assert.equal(fields.length, 1);
    assert.equal(fields[0]!.field, 1);
    assert.equal(fields[0]!.bytes.length, 32);
    assert.equal(fields.some((f) => f.field === 8), false);
    const asText = fieldStr(fields, 1) || "";
    assert.equal(asText.includes('"role":"user"'), false);
    assert.equal(asText.includes('"role":"assistant"'), false);
  });

  it("rebase action carries typed ConversationHistory, not root_prompt JSON", () => {
    const history = encodeConversationHistory([
      { role: "user", text: "mandate" },
      {
        role: "assistant",
        text: "looking",
        toolCalls: [{ id: "c1", name: "list_dir", args: "{}" }],
      },
      { role: "tool", toolCallId: "c1", toolName: "list_dir", text: "src/" },
      { role: "assistant", text: "Ship landed" },
    ]);
    assert.ok(history);
    const action = encodeConversationActionUser(
      "[Forge ULW cycle driver] Stop blocked",
      "m2",
      undefined,
      history,
    );
    const uma = decodeFields(decodeFields(action)[0]!.bytes);
    assert.equal(uma.some((f) => f.field === 1), true);
    const hist = uma.find((f) => f.field === 7);
    assert.ok(hist);
    const msgs = decodeFields(hist.bytes).filter((f) => f.field === 1);
    assert.equal(msgs.length, 4);
    assert.equal(decodeFields(msgs[0]!.bytes)[0]!.field, 1);
    assert.equal(decodeFields(msgs[1]!.bytes)[0]!.field, 2);
    assert.equal(decodeFields(msgs[2]!.bytes)[0]!.field, 3);
    assert.equal(decodeFields(msgs[3]!.bytes)[0]!.field, 2);
    const userMsg = decodeFields(decodeFields(msgs[0]!.bytes)[0]!.bytes);
    const userContent = decodeFields(userMsg[0]!.bytes);
    const userText = decodeFields(userContent[0]!.bytes);
    assert.equal(fieldStr(userText, 1), "mandate");
    const toolMsg = decodeFields(decodeFields(msgs[2]!.bytes)[0]!.bytes);
    assert.equal(fieldStr(toolMsg, 1), "c1");
    assert.equal(fieldStr(toolMsg, 2), "list_dir");
  });
});

describe("cursor conversation replay", () => {
  it("uses the latest user as the action and keeps prior turns", () => {
    const got = prepareCursorConversation([
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ]);
    assert.equal(got.systemPrompt, "sys");
    assert.equal(got.userText, "second");
    assert.equal(got.turns.length, 1);
    assert.equal(got.turns[0]!.userText, "first");
    assert.equal(got.turns[0]!.assistantText, "ok");
    assert.equal(got.trailingToolResults.length, 0);
    assert.equal(got.history.length, 2);
    assert.equal(got.history[0]!.role, "user");
    assert.equal(got.history[1]!.role, "assistant");
  });

  it("merges consecutive user messages so context-admit is not a half-turn", () => {
    const got = prepareCursorConversation([
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "user",
        content:
          "[Forge harness — mid-conversation update]\nBranch: main",
      },
    ]);
    assert.equal(got.turns.length, 0);
    assert.equal(got.history.length, 0);
    assert.match(got.userText, /task/);
    assert.match(got.userText, /mid-conversation/);
  });

  it("merges a post-turn admit into the action, not a user-only history row", () => {
    const got = prepareCursorConversation([
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
      { role: "user", content: "admit" },
    ]);
    assert.equal(got.turns.length, 1);
    assert.equal(got.turns[0]!.assistantText, "ok");
    assert.match(got.userText, /second/);
    assert.match(got.userText, /admit/);
    assert.equal(got.history.some((m) => m.role === "user" && m.text === "second"), false);
  });

  it("keeps tool calls on the assistant and trailing results for the live Run", () => {
    const got = prepareCursorConversation([
      { role: "user", content: "edit it" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "bash", arguments: "{\"command\":\"ls\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "a.ts" },
    ]);
    const asst = got.history.find((m) => m.role === "assistant");
    assert.ok(asst && asst.role === "assistant");
    assert.equal(asst.toolCalls?.[0]?.name, "bash");
    assert.equal(got.trailingToolResults.length, 1);
    assert.equal(got.trailingToolResults[0]!.toolCallId, "c1");
    assert.equal(got.userText, "");
    assert.equal(got.history.some((m) => m.role === "tool"), true);
  });

  it("records completed tools before a follow-up assistant", () => {
    const got = prepareCursorConversation([
      { role: "user", content: "edit it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "export const x = 1" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ]);
    assert.equal(got.userText, "next");
    assert.equal(got.trailingToolResults.length, 0);
    assert.equal(got.history.map((m) => m.role).join(","), "user,assistant,tool,assistant");
    const tool = got.history.find((m) => m.role === "tool");
    assert.ok(tool && tool.role === "tool");
    assert.equal(tool.toolName, "read_file");
    assert.match(tool.text, /export const x/);
  });

  it("dead-stream rebase uses a real continue prompt and keeps tools on history", () => {
    const got = applyCursorReconnectAction(
      prepareCursorConversation([
        { role: "user", content: "edit it" },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "list_dir", arguments: "{\"path\":\".\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "src/" },
      ]),
    );
    assert.equal(got.userText, CURSOR_CONTINUE_PROMPT);
    assert.equal(got.userText.includes("(continue)"), false);
    assert.equal(got.history.some((m) => m.role === "tool"), true);
  });

  it("keeps the live Run open when MCP results are still pending", () => {
    assert.equal(shouldCloseCursorLive({ close: true, pendingCount: 1 }), false);
    assert.equal(shouldCloseCursorLive({ close: true, pendingCount: 0 }), true);
    assert.equal(shouldCloseCursorLive({ close: false, pendingCount: 0 }), false);
  });

  it("resumes the live Run when a harness user follows unanswered tools", () => {
    const messages = [
      { role: "user" as const, content: "task" },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function" as const,
            function: { name: "grep", arguments: "{}" },
          },
          {
            id: "c2",
            type: "function" as const,
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool" as const, tool_call_id: "c1", content: "hit" },
      { role: "tool" as const, tool_call_id: "c2", content: "file" },
      {
        role: "user" as const,
        content:
          "[Forge harness — mid-conversation update]\nEvaluate-class mandate: write the reading.",
      },
    ];
    const got = prepareCursorConversation(messages);
    assert.equal(got.trailingToolResults.length, 0);
    assert.match(got.userText, /Evaluate-class/);
    assert.equal(
      cursorShouldResumeLive({
        pendingCount: 2,
        streamDead: false,
        trailingCount: got.trailingToolResults.length,
      }),
      true,
    );
    const results = collectCursorToolResults(messages);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.toolCallId, "c1");
    assert.equal(
      cursorShouldResumeLive({
        pendingCount: 0,
        streamDead: false,
        trailingCount: 0,
      }),
      false,
    );
  });

  it("resumes a healthy Run for the next user after a completed text turn", () => {
    const got = prepareCursorConversation([
      { role: "user", content: "comprehensively evaluate this tool" },
      { role: "assistant", content: "Ship landed: first-live-run steer hint" },
      {
        role: "user",
        content: "[Forge ULW cycle driver] Stop blocked — cycle=1 wave=1/4",
      },
    ]);
    assert.match(got.userText, /Stop blocked/);
    assert.equal(got.history.length, 2);
    assert.equal(
      cursorShouldResumeLive({
        pendingCount: 0,
        streamDead: false,
        trailingCount: 0,
        hasUserAction: Boolean(got.userText.trim()),
      }),
      true,
    );
    assert.equal(
      cursorShouldResumeLive({
        pendingCount: 0,
        streamDead: true,
        trailingCount: 0,
        hasUserAction: true,
      }),
      false,
    );
  });
});

describe("cursor catalog + cost", () => {
  it("treats cursor as a remote catalog provider", () => {
    assert.equal(providerSupportsRemoteCatalog("cursor"), true);
    assert.equal(providerSupportsRemoteCatalog("anthropic"), false);
  });

  it("native Cursor quota estimates $0", () => {
    assert.equal(estimateCostUsd("cursor", 1_000_000, 50_000, "composer-2.5"), 0);
    assert.equal(estimateCostUsd("cursor-ai", 1_000_000, 50_000, "grok-4.6"), 0);
    assert.ok(estimateCostUsd("xai", 1_000_000, 50_000, "grok-4.6") > 0);
  });
});

describe("cursor refresh", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cursor-ref-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    clearAllCredentials();
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refreshCredentialIfNeeded exchanges Cursor refresh token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 10;
    const next = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: "ada@cursor.test",
    });
    upsertOAuth("cursor", {
      accessToken: "old-cursor-jwt",
      refreshToken: "cursor-refresh-long",
      expiresAt: exp,
      clientId: "cursor-cli",
      method: "subscription",
      subscription: "Cursor",
      accountLabel: "cursor:ada@cursor.test",
    });

    globalThis.fetch = (async (url, init) => {
      assert.ok(String(url).includes("exchange_user_api_key"));
      const headers = init?.headers as Record<string, string>;
      assert.match(String(headers.Authorization || headers.authorization), /Bearer cursor-refresh-long/);
      return new Response(
        JSON.stringify({
          accessToken: next,
          refreshToken: "cursor-refresh-rotated",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await refreshCredentialIfNeeded("cursor", { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    const cred = getCredential("cursor");
    assert.equal(cred?.accessToken, next);
    assert.equal(cred?.refreshToken, "cursor-refresh-rotated");
  });

  it("refreshCursorToken fails closed on HTTP error", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    await assert.rejects(
      () => refreshCursorToken("dead"),
      /Cursor token refresh failed \(401\)/,
    );
  });

  it("storeCursorFromAccessToken persists subscription", async () => {
    const token = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 7200,
      email: "ada@cursor.test",
    });
    const r = await storeCursorFromAccessToken(token, {
      refreshToken: "rt",
      label: "cursor:ada@cursor.test",
    });
    assert.equal(r.imported, true);
    assert.equal(r.email, "ada@cursor.test");
    const cred = getCredential(CURSOR_PROVIDER_ID);
    assert.equal(cred?.accessToken, token);
    assert.equal(cred?.refreshToken, "rt");
    assert.equal(cred?.method, "subscription");
  });

  it("forceNew keeps the first Cursor account when JWT has no email", async () => {
    const t1 = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 7200,
      sub: "user-1",
    });
    const t2 = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 7200,
      sub: "user-2",
    });
    const a = await storeCursorFromAccessToken(t1, {
      refreshToken: "rt-a",
    });
    const b = await storeCursorFromAccessToken(t2, {
      refreshToken: "rt-b",
      forceNew: true,
    });
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.notEqual(a.accountId, b.accountId);
    assert.equal(listAccounts(CURSOR_PROVIDER_ID).length, 2);
    assert.equal(getAccount(a.accountId!)?.accessToken, t1);
    assert.equal(getAccount(b.accountId!)?.accessToken, t2);
  });

  it("forceNew keeps the first Cursor account when emails match", async () => {
    const t1 = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 7200,
      email: "ada@cursor.test",
    });
    const t2 = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 7200,
      email: "ada@cursor.test",
    });
    const a = await storeCursorFromAccessToken(t1, {
      refreshToken: "rt-a",
    });
    const b = await storeCursorFromAccessToken(t2, {
      refreshToken: "rt-b",
      forceNew: true,
    });
    assert.equal(b.created, true);
    assert.notEqual(a.accountId, b.accountId);
    assert.equal(listAccounts(CURSOR_PROVIDER_ID).length, 2);
    assert.equal(getAccount(a.accountId!)?.accessToken, t1);
    assert.equal(getAccount(b.accountId!)?.accessToken, t2);
  });
});
