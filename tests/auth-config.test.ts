import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load.js";
import { upsertApiKey, getCredential, clearAllCredentials } from "../src/auth/store.js";
import { resolveAuth } from "../src/auth/resolve.js";

describe("auth + config", () => {
  it("loads defaults and env overrides", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cfg-"));
    process.env.FORGE_HOME = tmp;
    process.env.FORGE_MODEL = "test-model";
    process.env.FORGE_PROVIDER = "openai";
    const cfg = loadConfig({}, tmp);
    assert.equal(cfg.model, "test-model");
    assert.equal(cfg.provider, "openai");
    assert.equal(cfg.blockingStopHooks, true);
    assert.equal(cfg.goal.enabled, true);
    delete process.env.FORGE_MODEL;
    delete process.env.FORGE_PROVIDER;
  });

  it("stores and resolves API keys", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-auth-"));
    process.env.FORGE_HOME = tmp;
    delete process.env.XAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    clearAllCredentials();
    upsertApiKey("xai", "xai-test-key-123");
    const cred = getCredential("xai");
    assert.equal(cred?.accessToken, "xai-test-key-123");
    assert.equal(cred?.method, "api_key");

    const cfg = loadConfig({ provider: "xai" }, tmp);
    const auth = resolveAuth(cfg, "xai");
    assert.ok(auth);
    assert.equal(auth!.token, "xai-test-key-123");
    assert.equal(auth!.method, "api_key");
  });

  it("env key takes precedence over stored", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-auth2-"));
    process.env.FORGE_HOME = tmp;
    upsertApiKey("xai", "stored-key");
    process.env.XAI_API_KEY = "env-key";
    const cfg = loadConfig({ provider: "xai" }, tmp);
    const auth = resolveAuth(cfg, "xai");
    assert.equal(auth?.token, "env-key");
    assert.equal(auth?.accountLabel, "env:XAI_API_KEY");
    delete process.env.XAI_API_KEY;
  });
});
