import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  XAI_AUTHORIZE_URL,
  XAI_DEVICE_CODE_URL,
  XAI_PUBLIC_CLIENT_ID,
  XAI_SCOPES,
  XAI_TOKEN_URL,
  XAI_DEFAULT_REDIRECT_URI,
  emailFromIdToken,
  xaiRedirectPortFromUri,
} from "../src/auth/xai-oauth.js";
import {
  getOAuthProfile,
  loginInteractive,
  supportsOAuth,
  waitForOAuthCallback,
} from "../src/auth/login.js";
import { readGrokXaiSession } from "../src/auth/import-grok.js";
import { listAccounts } from "../src/auth/store.js";
import { nowEpoch } from "../src/util/fs.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

describe("SuperGrok / xAI OIDC profile", () => {
  it("uses Grok CLI public client and oauth2 endpoints", () => {
    assert.match(XAI_PUBLIC_CLIENT_ID, /^[0-9a-f-]{36}$/i);
    assert.equal(XAI_AUTHORIZE_URL, "https://auth.x.ai/oauth2/authorize");
    assert.equal(XAI_TOKEN_URL, "https://auth.x.ai/oauth2/token");
    assert.equal(XAI_DEVICE_CODE_URL, "https://auth.x.ai/oauth2/device/code");
    assert.ok(XAI_SCOPES.includes("offline_access"));
    assert.ok(XAI_SCOPES.includes("grok-cli:access"));
    assert.ok(XAI_SCOPES.includes("api:access"));
    assert.match(XAI_DEFAULT_REDIRECT_URI, /127\.0\.0\.1:56121\/callback/);
    assert.equal(xaiRedirectPortFromUri(XAI_DEFAULT_REDIRECT_URI), 56121);
  });

  it("wires xai login profile to SuperGrok OIDC", () => {
    assert.equal(supportsOAuth("xai"), true);
    const p = getOAuthProfile("xai");
    assert.ok(p);
    assert.equal(p!.clientId, XAI_PUBLIC_CLIENT_ID);
    assert.equal(p!.authorizeUrl, XAI_AUTHORIZE_URL);
    assert.equal(p!.tokenUrl, XAI_TOKEN_URL);
    assert.equal(p!.deviceCodeUrl, XAI_DEVICE_CODE_URL);
    assert.equal(p!.redirectUri, XAI_DEFAULT_REDIRECT_URI);
    assert.ok(p!.scopes.includes("grok-cli:access"));
  });

  it("decodes email from id_token payload for display", () => {
    // header.payload.sig — payload is {"email":"user@example.com"}
    const payload = Buffer.from(
      JSON.stringify({ email: "user@example.com" }),
    ).toString("base64url");
    const fake = `eyJhbGciOiJub25lIn0.${payload}.sig`;
    assert.equal(emailFromIdToken(fake), "user@example.com");
    assert.equal(emailFromIdToken(undefined), undefined);
    assert.equal(emailFromIdToken("not-a-jwt"), undefined);
  });
});

describe("browser OAuth callback watchdog", () => {
  function startCallback(timeoutMs: number) {
    return waitForOAuthCallback({
      port: 0, // ephemeral — real port read off the server
      redirectPath: "/callback",
      expectedState: "state-abc",
      provider: "test",
      redirectUri: "http://127.0.0.1/callback",
      timeoutMs,
    });
  }

  function listeningPort(server: Server): Promise<number> {
    return new Promise((resolve) => {
      server.on("listening", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  // Node nulls _onTimeout inside clearTimeout — observable proof the
  // watchdog was cleared rather than left to linger for 5 minutes.
  const timerCleared = (timer: NodeJS.Timeout) =>
    (timer as unknown as { _onTimeout: unknown })._onTimeout === null;

  it("clears the watchdog timer on the success path", async () => {
    const cb = startCallback(60_000);
    // unref'd: the watchdog alone can never hold the CLI open.
    assert.equal(cb.timer.hasRef(), false);
    const port = await listeningPort(cb.server);
    const resp = await fetch(
      `http://127.0.0.1:${port}/callback?code=test-code&state=state-abc`,
      { headers: { Connection: "close" } },
    );
    assert.equal(resp.status, 200);
    assert.equal(await cb.promise, "test-code");
    assert.equal(timerCleared(cb.timer), true);
  });

  it("clears the watchdog on the OAuth error-callback path", async () => {
    const cb = startCallback(60_000);
    const port = await listeningPort(cb.server);
    // Attach the rejection handler BEFORE the callback rejects.
    const rejection = assert.rejects(cb.promise, /access_denied/);
    const resp = await fetch(
      `http://127.0.0.1:${port}/callback?error=access_denied`,
      { headers: { Connection: "close" } },
    );
    assert.equal(resp.status, 400);
    await rejection;
    assert.equal(timerCleared(cb.timer), true);
  });

  it("still rejects when the watchdog fires (unref keeps semantics)", async () => {
    const cb = startCallback(50);
    await assert.rejects(cb.promise, /timed out/);
  });
});

describe("device code login resilience", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevFetch: typeof globalThis.fetch;
  let prevDeviceUrl: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-device-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    prevFetch = globalThis.fetch;
    prevDeviceUrl = process.env.FORGE_DEVICE_AUTH_URL;
    delete process.env.FORGE_DEVICE_AUTH_URL;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevDeviceUrl === undefined) delete process.env.FORGE_DEVICE_AUTH_URL;
    else process.env.FORGE_DEVICE_AUTH_URL = prevDeviceUrl;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  const JSON_HEADERS = { "content-type": "application/json" };

  /**
   * Stub the device-code start endpoint (interval 0 → 3s poll floor) plus a
   * scripted token endpoint. No verification_uri → no browser open().
   */
  function stubStartAndPoll(onPoll: (n: number) => Response): () => number {
    let polls = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "dc-test",
            user_code: "UC-TEST",
            interval: 0,
            expires_in: 30,
          }),
          { status: 200, headers: JSON_HEADERS },
        );
      }
      polls += 1;
      return onPoll(polls);
    }) as typeof fetch;
    return () => polls;
  }

  it("tolerates a transient network error while the device code is valid", async () => {
    const pollCount = stubStartAndPoll((n) => {
      // One transport blip must not abort the whole login (RFC 8628 polls
      // until the deadline).
      if (n === 1) throw new Error("socket hang up");
      return new Response(
        JSON.stringify({
          access_token: "dev-tok",
          refresh_token: "dev-rt",
          expires_in: 3600,
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    });
    const r = await loginInteractive({ provider: "xai", method: "device" });
    assert.ok(r.accountId);
    assert.equal(pollCount(), 2);
    assert.equal(listAccounts("xai").length, 1);
  });

  it("aborts on terminal RFC 8628 errors (access_denied)", async () => {
    const pollCount = stubStartAndPoll(
      () =>
        new Response(
          JSON.stringify({
            error: "access_denied",
            error_description: "User said no",
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
    );
    await assert.rejects(
      loginInteractive({ provider: "xai", method: "device" }),
      /User said no/,
    );
    assert.equal(pollCount(), 1);
  });

  it("clean error when device-code start returns a non-JSON body", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>bad gateway</html>", { status: 200 })) as typeof fetch;
    await assert.rejects(
      loginInteractive({ provider: "xai", method: "device" }),
      /expected a JSON device_code response/,
    );
  });
});

describe("grok auth.json import heuristics", () => {
  let tmp: string;
  let prevGrokHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-grokimp-"));
    prevGrokHome = process.env.GROK_HOME;
    process.env.GROK_HOME = tmp;
  });

  afterEach(() => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  function writeGrokAuth(entries: Record<string, unknown>): void {
    fs.writeFileSync(path.join(tmp, "auth.json"), JSON.stringify(entries));
  }

  it("rejects non-xAI oidc entries (the String(v) === '[object Object]' bug)", () => {
    // oidc_client_id as an OBJECT: the old `String(v).length > 0` clause was
    // always true and admitted ANY entry as an xAI token candidate.
    writeGrokAuth({
      "random-key": { key: "tok-not-xai", oidc_client_id: { nested: true } },
    });
    assert.equal(readGrokXaiSession(), null);
    // A foreign provider's OIDC client id string is not xAI either.
    writeGrokAuth({
      "random-key": { key: "tok-foreign", oidc_client_id: "other-client" },
    });
    assert.equal(readGrokXaiSession(), null);
  });

  it("accepts an entry carrying xAI's public client id without an x.ai key", () => {
    writeGrokAuth({
      "opaque-key": {
        key: "tok-xai-session",
        oidc_client_id: XAI_PUBLIC_CLIENT_ID,
        expires_at: nowEpoch() + 3600,
      },
    });
    const s = readGrokXaiSession();
    assert.equal(s?.accessToken, "tok-xai-session");
    assert.equal(s?.clientId, XAI_PUBLIC_CLIENT_ID);
  });

  it("still accepts auth.x.ai-keyed entries", () => {
    writeGrokAuth({
      [`https://auth.x.ai::${XAI_PUBLIC_CLIENT_ID}`]: {
        key: "tok-xai-keyed",
        expires_at: nowEpoch() + 3600,
      },
    });
    assert.equal(readGrokXaiSession()?.accessToken, "tok-xai-keyed");
  });
});
