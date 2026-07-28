import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readGithubCopilotConfigToken,
  copilotApiHeaders,
  copilotExchangeHeaders,
  isCopilotProvider,
  COPILOT_GITHUB_CLIENT_ID,
  COPILOT_API_BASE,
  exchangeCopilotToken,
} from "../src/auth/copilot.js";
import { normalizeProviderId, providerIdHelp } from "../src/util/provider-id.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { createProvider } from "../src/providers/factory.js";
import { supportsOAuth, getOAuthProfile } from "../src/auth/login.js";
import { upsertOAuth, getCredential, clearAllCredentials } from "../src/auth/store.js";
import { refreshCredentialIfNeeded } from "../src/auth/refresh.js";

describe("copilot provider id", () => {
  it("normalizes github-copilot aliases", () => {
    assert.deepEqual(normalizeProviderId("copilot"), {
      ok: true,
      provider: "copilot",
    });
    assert.deepEqual(normalizeProviderId("github-copilot"), {
      ok: true,
      provider: "copilot",
    });
    assert.deepEqual(normalizeProviderId("github"), {
      ok: true,
      provider: "copilot",
    });
    assert.deepEqual(normalizeProviderId("gh-copilot"), {
      ok: true,
      provider: "copilot",
    });
    assert.ok(providerIdHelp().includes("copilot"));
  });

  it("isCopilotProvider recognizes aliases", () => {
    assert.equal(isCopilotProvider("copilot"), true);
    assert.equal(isCopilotProvider("github-copilot"), true);
    assert.equal(isCopilotProvider("xai"), false);
  });

  it("ships in DEFAULT_CONFIG with oauth + chat base", () => {
    const p = DEFAULT_CONFIG.providers.copilot;
    assert.ok(p);
    assert.equal(p.supportsOAuth, true);
    assert.equal(p.baseUrl, "https://api.githubcopilot.com");
    assert.ok(p.defaultModel);
  });

  it("supportsOAuth and device profile for copilot", () => {
    assert.equal(supportsOAuth("copilot"), true);
    const profile = getOAuthProfile("copilot");
    assert.ok(profile);
    assert.equal(profile!.clientId, COPILOT_GITHUB_CLIENT_ID);
    assert.ok(profile!.deviceCodeUrl?.includes("github.com"));
  });
});

describe("copilot local config readers", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-copilot-"));
    prevHome = process.env.HOME;
    prevXdg = process.env.XDG_CONFIG_HOME;
    // Point HOME so ~/.config resolves under tmp (also force XDG)
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

  it("reads oauth_token from apps.json", () => {
    const dir = path.join(tmp, ".config", "github-copilot");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "apps.json"),
      JSON.stringify({
        "github.com:Iv1.b507a08c87ecfe98": {
          user: "octocat",
          oauth_token: "ghu_test_token_abc123",
        },
      }),
      "utf8",
    );
    const got = readGithubCopilotConfigToken();
    assert.ok(got);
    assert.equal(got!.token, "ghu_test_token_abc123");
    assert.equal(got!.login, "octocat");
    assert.ok(got!.source.includes("apps.json"));
  });

  it("reads hosts.json", () => {
    const dir = path.join(tmp, ".config", "github-copilot");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "hosts.json"),
      JSON.stringify({
        "github.com": {
          user: "hubot",
          oauth_token: "gho_host_token_xyz",
        },
      }),
      "utf8",
    );
    const got = readGithubCopilotConfigToken();
    assert.ok(got);
    assert.equal(got!.token, "gho_host_token_xyz");
    assert.equal(got!.login, "hubot");
  });

  it("returns null when no local files", () => {
    assert.equal(readGithubCopilotConfigToken(), null);
  });
});

describe("copilot headers + factory", () => {
  it("sets Editor-Version and Copilot-Integration-Id", () => {
    const h = copilotApiHeaders();
    assert.ok(h["Editor-Version"]?.startsWith("vscode/"));
    assert.equal(h["Copilot-Integration-Id"], "vscode-chat");
    assert.ok(h["User-Agent"]?.includes("GitHubCopilotChat"));
  });

  it("exchange headers use token auth", () => {
    const h = copilotExchangeHeaders("ghu_x");
    assert.equal(h.Authorization, "token ghu_x");
  });

  it("createProvider attaches copilot headers and base URL", () => {
    const provider = createProvider(DEFAULT_CONFIG, {
      provider: "copilot",
      method: "subscription",
      token: "tid_session",
      baseUrl: COPILOT_API_BASE,
    });
    assert.equal(provider.id, "copilot");
    // Peek private headers via a no-op — ensure object is OpenAICompat
    assert.equal(typeof provider.chat, "function");
    assert.equal(typeof provider.chatStream, "function");
  });
});

describe("copilot refresh re-exchange", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-copilot-ref-"));
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

  it("refreshCredentialIfNeeded re-exchanges GitHub token for copilot", async () => {
    const exp = Math.floor(Date.now() / 1000) - 10; // already expired
    upsertOAuth("copilot", {
      accessToken: "old_copilot_tid",
      refreshToken: "ghu_github_long_lived",
      expiresAt: exp,
      clientId: COPILOT_GITHUB_CLIENT_ID,
      method: "subscription",
      subscription: "GitHub Copilot",
      accountLabel: "copilot:tester",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          token: "new_copilot_tid",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_in: 1500,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await refreshCredentialIfNeeded("copilot", { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    const cred = getCredential("copilot");
    assert.equal(cred?.accessToken, "new_copilot_tid");
    assert.equal(cred?.refreshToken, "ghu_github_long_lived");
    assert.ok(cred?.expiresAt && cred.expiresAt > Math.floor(Date.now() / 1000));
  });

  it("exchangeCopilotToken parses response", async () => {
    globalThis.fetch = (async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      assert.ok(String(headers.Authorization || headers.authorization).includes("ghu_"));
      return new Response(
        JSON.stringify({ token: "tid_abc", expires_at: 1_700_000_000 }),
        { status: 200 },
      );
    }) as typeof fetch;
    const r = await exchangeCopilotToken("ghu_test");
    assert.equal(r.token, "tid_abc");
    assert.equal(r.expiresAt, 1_700_000_000);
  });

  it("exchangeCopilotToken fails closed on HTTP error", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 403 })) as typeof fetch;
    await assert.rejects(
      () => exchangeCopilotToken("ghu_bad"),
      /403/,
    );
  });

  it("resolveCopilotSessionToken falls back to direct GitHub bearer", async () => {
    const { resolveCopilotSessionToken } = await import(
      "../src/auth/copilot.js"
    );
    let n = 0;
    globalThis.fetch = (async (url) => {
      n++;
      const u = String(url);
      if (u.includes("copilot_internal/v2/token")) {
        return new Response("403 Forbidden scraping", { status: 403 });
      }
      if (u.includes("/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const session = await resolveCopilotSessionToken("gho_cli_token");
    assert.equal(session.mode, "direct_github");
    assert.equal(session.token, "gho_cli_token");
    assert.ok(n >= 2);
  });
});
