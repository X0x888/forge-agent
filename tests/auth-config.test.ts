import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, defaultConfigToml } from "../src/config/load.js";
import {
  loadPreferences,
  savePreferences,
  preferencesPath,
} from "../src/config/preferences.js";
import { upsertApiKey, getCredential, clearAllCredentials } from "../src/auth/store.js";
import { resolveAuth } from "../src/auth/resolve.js";
import { isProtectedWritePath } from "../src/agent/protected-paths.js";
import {
  PermissionGate,
  checkBashHardDeny,
  isReadOnlyCommand,
  expandWeirdIpv4Literal,
  assertUrlSafe,
  toolFingerprint,
} from "../src/index.js";

describe("library public API (safety surface)", () => {
  it("exports permission/safety/SSRF helpers embedders need", async () => {
    assert.equal(typeof PermissionGate, "function");
    assert.equal(checkBashHardDeny("rm -rf /").ok, false);
    assert.equal(isReadOnlyCommand("node --version"), true);
    assert.equal(isReadOnlyCommand("git branch -D old"), false);
    assert.equal(expandWeirdIpv4Literal("2130706433"), "127.0.0.1");
    await assert.rejects(() => assertUrlSafe("http://[::ffff:7f00:1]/"), /Blocked/);
    assert.equal(
      toolFingerprint("bash", { command: "ls", run_in_background: true }),
      toolFingerprint("bash", { command: "ls", background: false }),
    );
  });
});

describe("auth + config", () => {
  it("defaultConfigToml keeps production safety defaults", () => {
    const t = defaultConfigToml();
    assert.match(t, /blocking_stop_hooks = true/);
    assert.match(t, /sandbox_missing_backend = "fail-closed"/);
    assert.match(t, /PRODUCTION\.md|RELIABILITY\.md/);
    assert.match(t, /FORGE_PROVIDER_TIMEOUT_MS|FORGE_LOG_JSON|FORGE_HEADLESS/);
  });

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

  it("ignores invalid FORGE_* enum env values (keeps defaults)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cfg-badenv-"));
    process.env.FORGE_HOME = tmp;
    process.env.FORGE_PROVIDER = "bogus-cloud";
    process.env.FORGE_PERMISSION_MODE = "not-a-mode";
    process.env.FORGE_SANDBOX = "paranoid";
    process.env.FORGE_SANDBOX_NETWORK = "maybe";
    process.env.FORGE_SANDBOX_MISSING_BACKEND = "explode";
    process.env.FORGE_READ_OUTSIDE = "whatever";
    process.env.FORGE_GOAL_STUCK_THRESHOLD = "0"; // would disable stuck-wall — ignore
    const cfg = loadConfig({}, tmp);
    assert.equal(cfg.provider, "xai"); // default — invalid env ignored
    assert.equal(cfg.permissionMode, "default");
    assert.equal(cfg.sandbox, "workspace");
    // sandboxNetwork is optional; invalid env must not set a poison value
    assert.ok(
      cfg.sandboxNetwork === undefined || cfg.sandboxNetwork === "unrestricted",
    );
    assert.equal(cfg.sandboxMissingBackend, "fail-closed");
    assert.equal(cfg.readOutsideWorkspace, "ask");
    assert.equal(cfg.goal.stuckThreshold, 3); // default — 0 ignored
    // Valid alias still works
    process.env.FORGE_PROVIDER = "grok";
    process.env.FORGE_PERMISSION_MODE = "plan";
    process.env.FORGE_SANDBOX = "strict";
    process.env.FORGE_SANDBOX_NETWORK = "blocked";
    process.env.FORGE_GOAL_STUCK_THRESHOLD = "7";
    const cfg2 = loadConfig({}, tmp);
    assert.equal(cfg2.provider, "xai");
    assert.equal(cfg2.permissionMode, "plan");
    assert.equal(cfg2.sandbox, "strict");
    assert.equal(cfg2.sandboxNetwork, "blocked");
    assert.equal(cfg2.goal.stuckThreshold, 7);
    delete process.env.FORGE_PROVIDER;
    delete process.env.FORGE_PERMISSION_MODE;
    delete process.env.FORGE_SANDBOX;
    delete process.env.FORGE_SANDBOX_NETWORK;
    delete process.env.FORGE_SANDBOX_MISSING_BACKEND;
    delete process.env.FORGE_READ_OUTSIDE;
    delete process.env.FORGE_GOAL_STUCK_THRESHOLD;
  });

  it("accepts FORGE_* expert aliases", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cfg-alias-"));
    const keys = [
      "FORGE_HOME",
      "FORGE_PROVIDER",
      "FORGE_PERMISSION_MODE",
      "FORGE_SANDBOX",
      "FORGE_SANDBOX_NETWORK",
    ] as const;
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) prev[k] = process.env[k];
    try {
      process.env.FORGE_HOME = tmp;
      process.env.FORGE_PROVIDER = "claude";
      process.env.FORGE_PERMISSION_MODE = "yolo";
      process.env.FORGE_SANDBOX = "readonly";
      process.env.FORGE_SANDBOX_NETWORK = "none";
      const cfg = loadConfig({}, tmp);
      assert.equal(cfg.provider, "anthropic");
      assert.equal(cfg.permissionMode, "bypassPermissions");
      assert.equal(cfg.sandbox, "read-only");
      assert.equal(cfg.sandboxNetwork, "blocked");
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k]!;
      }
    }
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

describe("loadConfig provider default model", () => {
  it("CLI provider override without model uses provider defaultModel", () => {
    const cfg = loadConfig({ provider: "anthropic" });
    assert.equal(cfg.provider, "anthropic");
    assert.match(cfg.model, /claude/i);
    const oai = loadConfig({ provider: "openai" });
    assert.equal(oai.provider, "openai");
    assert.match(oai.model, /gpt/i);
    const explicit = loadConfig({ provider: "anthropic", model: "claude-custom" });
    assert.equal(explicit.model, "claude-custom");
    const same = loadConfig({ provider: "xai" });
    // default provider — model stays default unless prefs differ
    assert.equal(same.provider, "xai");
  });

  it("FORGE_PROVIDER without FORGE_MODEL uses provider defaultModel", () => {
    const prevP = process.env.FORGE_PROVIDER;
    const prevM = process.env.FORGE_MODEL;
    try {
      process.env.FORGE_PROVIDER = "google";
      delete process.env.FORGE_MODEL;
      const cfg = loadConfig();
      assert.equal(cfg.provider, "google");
      assert.match(cfg.model, /gemini/i);
      process.env.FORGE_MODEL = "gemini-custom";
      const explicit = loadConfig();
      assert.equal(explicit.model, "gemini-custom");
    } finally {
      if (prevP === undefined) delete process.env.FORGE_PROVIDER;
      else process.env.FORGE_PROVIDER = prevP;
      if (prevM === undefined) delete process.env.FORGE_MODEL;
      else process.env.FORGE_MODEL = prevM;
    }
  });
});

describe("stored credential without sticky provider", () => {
  it("does not silently use other providers when config provider differs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-auth-stored-"));
    const prevHome = process.env.FORGE_HOME;
    const prevGrok = process.env.GROK_HOME;
    const prevXai = process.env.XAI_API_KEY;
    const prevAnt = process.env.ANTHROPIC_API_KEY;
    const prevProv = process.env.FORGE_PROVIDER;
    try {
      process.env.FORGE_HOME = tmp;
      // Isolate from developer ~/.grok SuperGrok session (live xAI import)
      process.env.GROK_HOME = path.join(tmp, "no-grok");
      delete process.env.XAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.FORGE_PROVIDER;
      upsertApiKey("anthropic", "sk-test-stored-anthropic");
      const cfgXai = loadConfig({}, tmp);
      assert.equal(cfgXai.provider, "xai");
      assert.equal(resolveAuth(cfgXai), null);
      const { savePreferences } = await import("../src/config/preferences.js");
      savePreferences({ provider: "anthropic" });
      const cfgAnt = loadConfig({}, tmp);
      assert.equal(cfgAnt.provider, "anthropic");
      const auth = resolveAuth(cfgAnt);
      assert.ok(auth);
      assert.equal(auth!.provider, "anthropic");
      assert.equal(auth!.token, "sk-test-stored-anthropic");
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prevHome;
      if (prevGrok === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevGrok;
      if (prevXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prevXai;
      if (prevAnt === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnt;
      if (prevProv === undefined) delete process.env.FORGE_PROVIDER;
      else process.env.FORGE_PROVIDER = prevProv;
    }
  });
});

describe("sticky provider preference", () => {
  it("savePreferences provider is applied by loadConfig", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pref-provider-"));
    const prevHome = process.env.FORGE_HOME;
    const prevXai = process.env.XAI_API_KEY;
    const prevAnt = process.env.ANTHROPIC_API_KEY;
    const prevProv = process.env.FORGE_PROVIDER;
    try {
      process.env.FORGE_HOME = tmp;
      delete process.env.XAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.FORGE_PROVIDER;
      const { savePreferences, loadPreferences } = await import(
        "../src/config/preferences.js"
      );
      savePreferences({ provider: "anthropic" });
      assert.equal(loadPreferences().provider, "anthropic");
      const cfg = loadConfig({}, tmp);
      assert.equal(cfg.provider, "anthropic");
      assert.match(cfg.model, /claude/i);
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prevHome;
      if (prevXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prevXai;
      if (prevAnt === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnt;
      if (prevProv === undefined) delete process.env.FORGE_PROVIDER;
      else process.env.FORGE_PROVIDER = prevProv;
    }
  });
});

describe("logout clears sticky provider", () => {
  it("full logout removes preferences.provider", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-logout-sticky-"));
    const prevHome = process.env.FORGE_HOME;
    const prevProv = process.env.FORGE_PROVIDER;
    try {
      process.env.FORGE_HOME = tmp;
      delete process.env.FORGE_PROVIDER;
      const { savePreferences, loadPreferences } = await import(
        "../src/config/preferences.js"
      );
      savePreferences({ provider: "anthropic" });
      assert.equal(loadPreferences().provider, "anthropic");
      // simulate full logout sticky clear
      savePreferences({ provider: null });
      assert.equal(loadPreferences().provider, undefined);
      const cfg = loadConfig({}, tmp);
      assert.equal(cfg.provider, "xai");
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prevHome;
      if (prevProv === undefined) delete process.env.FORGE_PROVIDER;
      else process.env.FORGE_PROVIDER = prevProv;
    }
  });
});

describe("provider switch clears model pref", () => {
  it("savePreferences({provider}) drops stale model", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pref-switch-"));
    const prevHome = process.env.FORGE_HOME;
    const prevProv = process.env.FORGE_PROVIDER;
    const prevModel = process.env.FORGE_MODEL;
    try {
      process.env.FORGE_HOME = tmp;
      delete process.env.FORGE_PROVIDER;
      delete process.env.FORGE_MODEL;
      const { savePreferences, loadPreferences } = await import(
        "../src/config/preferences.js"
      );
      savePreferences({ provider: "xai", model: "grok-4.5" });
      assert.equal(loadPreferences().model, "grok-4.5");
      savePreferences({ provider: "anthropic" });
      assert.equal(loadPreferences().provider, "anthropic");
      assert.equal(loadPreferences().model, undefined);
      const cfg = loadConfig({}, tmp);
      assert.equal(cfg.provider, "anthropic");
      assert.match(cfg.model, /claude/i);
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prevHome;
      if (prevProv === undefined) delete process.env.FORGE_PROVIDER;
      else process.env.FORGE_PROVIDER = prevProv;
      if (prevModel === undefined) delete process.env.FORGE_MODEL;
      else process.env.FORGE_MODEL = prevModel;
    }
  });
});
