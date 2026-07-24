import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load.js";
import {
  loadPreferences,
  savePreferences,
  preferencesPath,
} from "../src/config/preferences.js";
import { upsertApiKey, getCredential, clearAllCredentials } from "../src/auth/store.js";
import { resolveAuth } from "../src/auth/resolve.js";
import { isProtectedWritePath } from "../src/agent/protected-paths.js";

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

  it("persists /model and /permissions via preferences across folders", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prefs-"));
    process.env.FORGE_HOME = tmp;
    delete process.env.FORGE_MODEL;
    delete process.env.FORGE_PERMISSION_MODE;

    fs.writeFileSync(
      path.join(tmp, "config.toml"),
      'model = "from-global"\npermission_mode = "default"\n',
    );

    savePreferences({ model: "pref-model", permissionMode: "acceptEdits" });
    const prefs = loadPreferences();
    assert.equal(prefs.model, "pref-model");
    assert.equal(prefs.permissionMode, "acceptEdits");
    assert.ok(fs.existsSync(preferencesPath()));

    const folderA = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-a-"));
    const folderB = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-b-"));
    const cfgA = loadConfig({}, folderA);
    const cfgB = loadConfig({}, folderB);
    assert.equal(cfgA.model, "pref-model");
    assert.equal(cfgA.permissionMode, "acceptEdits");
    assert.equal(cfgB.model, "pref-model");
    assert.equal(cfgB.permissionMode, "acceptEdits");

    // Partial update keeps the other field
    savePreferences({ model: "next-model" });
    assert.equal(loadPreferences().permissionMode, "acceptEdits");
    assert.equal(loadConfig({}, folderA).model, "next-model");

    // Env still wins over preferences
    process.env.FORGE_MODEL = "env-model";
    process.env.FORGE_PERMISSION_MODE = "plan";
    const cfgEnv = loadConfig({}, folderA);
    assert.equal(cfgEnv.model, "env-model");
    assert.equal(cfgEnv.permissionMode, "plan");
    delete process.env.FORGE_MODEL;
    delete process.env.FORGE_PERMISSION_MODE;

    // CLI overrides win
    const cfgCli = loadConfig(
      { model: "cli-model", permissionMode: "dontAsk" },
      folderA,
    );
    assert.equal(cfgCli.model, "cli-model");
    assert.equal(cfgCli.permissionMode, "dontAsk");

    assert.equal(isProtectedWritePath(preferencesPath()), true);
  });

  it("preferences beat project static model", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pref-home-"));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pref-proj-"));
    process.env.FORGE_HOME = home;
    delete process.env.FORGE_MODEL;
    delete process.env.FORGE_PERMISSION_MODE;

    fs.mkdirSync(path.join(proj, ".forge"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".forge", "config.toml"),
      'model = "project-model"\npermission_mode = "plan"\n',
    );
    savePreferences({ model: "user-pick", permissionMode: "acceptEdits" });
    const cfg = loadConfig({}, proj);
    assert.equal(cfg.model, "user-pick");
    assert.equal(cfg.permissionMode, "acceptEdits");
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
