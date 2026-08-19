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
import { CursorProvider } from "../src/providers/cursor.js";
import {
  encodeProtobufValue,
  decodeProtobufValue,
  encodeUserMessage,
  decodeFields,
  fieldStr,
  encodeConnectFrame,
  decodeConnectFrames,
  parseAgentServerMessage,
  encodeClientMessage,
  encodeMessage,
  encodeString,
  CONNECT_END_STREAM,
} from "../src/providers/cursor-proto.js";
import { upsertOAuth, getCredential, clearAllCredentials } from "../src/auth/store.js";
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
    assert.equal(p.defaultModel, "composer-2.5");
    assert.ok(p.models?.includes("composer-2.5"));
    assert.ok(p.models?.includes("grok-4.6"));
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
});
