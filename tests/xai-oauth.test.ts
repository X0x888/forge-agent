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
import { getOAuthProfile, supportsOAuth } from "../src/auth/login.js";

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
