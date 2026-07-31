/**
 * DeepSeek native provider (platform.deepseek.com sk-… keys).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProviderId } from "../src/util/provider-id.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { loadConfig } from "../src/config/load.js";
import { resolveAuth } from "../src/auth/resolve.js";
import { upsertApiKey, clearCredential, getActiveAccount } from "../src/auth/store.js";
import {
  modelSupportsReasoningEffort,
  resolveReasoningEffort,
} from "../src/config/reasoning.js";
import { modelContextWindow } from "../src/config/model-info.js";
import { createProvider } from "../src/providers/factory.js";
import { openRouterKeyFormatWarning } from "../src/auth/login.js";

describe("deepseek provider id", () => {
  it("normalizes deepseek and ds alias", () => {
    assert.deepEqual(normalizeProviderId("deepseek"), {
      ok: true,
      provider: "deepseek",
    });
    assert.deepEqual(normalizeProviderId("ds"), {
      ok: true,
      provider: "deepseek",
    });
  });
});

describe("deepseek catalog + defaults", () => {
  beforeEach(() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ds-"));
    process.env.FORGE_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.FORGE_PROVIDER;
    delete process.env.FORGE_MODEL;
  });

  it("has stock provider config", () => {
    const p = DEFAULT_CONFIG.providers.deepseek;
    assert.ok(p);
    assert.equal(p.apiKeyEnv, "DEEPSEEK_API_KEY");
    assert.equal(p.baseUrl, "https://api.deepseek.com");
    assert.equal(p.defaultModel, "deepseek-v4-flash");
    assert.ok(p.models?.includes("deepseek-v4-flash"));
    assert.ok(p.models?.includes("deepseek-v4-pro"));
  });

  it("CLI provider override picks default model", () => {
    const cfg = loadConfig({ provider: "deepseek" });
    assert.equal(cfg.provider, "deepseek");
    assert.equal(cfg.model, "deepseek-v4-flash");
  });

  it("resolves DEEPSEEK_API_KEY and stored api key", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-deepseek-key-1234567890";
    const cfg = loadConfig({ provider: "deepseek" });
    const auth = resolveAuth(cfg, "deepseek");
    assert.ok(auth);
    assert.equal(auth!.provider, "deepseek");
    assert.equal(auth!.method, "api_key");
    assert.match(auth!.accountLabel || "", /env:DEEPSEEK_API_KEY/);
    delete process.env.DEEPSEEK_API_KEY;

    upsertApiKey("deepseek", "sk-stored-deepseek-aaaaaaaaaa", "platform");
    const auth2 = resolveAuth(
      loadConfig({ provider: "deepseek" }),
      "deepseek",
    );
    assert.ok(auth2);
    assert.equal(auth2!.token, "sk-stored-deepseek-aaaaaaaaaa");
    assert.ok(getActiveAccount("deepseek"));
    clearCredential("deepseek");
  });

  it("effort max + 1M context for v4 flash", () => {
    assert.equal(modelSupportsReasoningEffort("deepseek-v4-flash"), true);
    assert.equal(resolveReasoningEffort("deepseek-v4-flash", undefined), "max");
    assert.equal(modelContextWindow("deepseek-v4-flash"), 1_048_576);
  });

  it("createProvider uses deepseek base URL", () => {
    const cfg = loadConfig({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    const p = createProvider(cfg, {
      provider: "deepseek",
      method: "api_key",
      token: "sk-test",
      baseUrl: cfg.providers.deepseek.baseUrl,
    });
    assert.equal(p.id, "deepseek");
  });

  it("openrouter key warning points at deepseek provider", () => {
    const w = openRouterKeyFormatWarning("sk-0aee5ae9c1bf4cf0a2e320b129437f3b");
    assert.ok(w);
    assert.match(w!, /deepseek/i);
  });
});
