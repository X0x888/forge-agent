import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
  supportsOAuth,
  waitForOAuthCallback,
} from "../src/auth/login.js";
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
