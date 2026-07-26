import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseReasoningEffort,
  resolveReasoningEffort,
  modelSupportsReasoningEffort,
  effortLevelsForModel,
  defaultEffortForModel,
} from "../src/config/reasoning.js";
import { buildChatRequest, resolveMaxTurns } from "../src/agent/loop.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { loadConfig } from "../src/config/load.js";
import { savePreferences, loadPreferences } from "../src/config/preferences.js";
import {
  classifyLiveSlash,
  handleSlash,
} from "../src/commands/slash.js";
import { forgeCompleter } from "../src/tui/complete.js";
import { createSession } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("reasoning effort helpers", () => {
  it("parses aliases", () => {
    assert.equal(parseReasoningEffort("low"), "low");
    assert.equal(parseReasoningEffort("L"), "low");
    assert.equal(parseReasoningEffort("med"), "medium");
    assert.equal(parseReasoningEffort("HIGH"), "high");
    assert.equal(parseReasoningEffort("xhigh"), null);
    assert.equal(parseReasoningEffort(""), null);
  });

  it("knows grok-4.5 supports low/medium/high", () => {
    assert.equal(modelSupportsReasoningEffort("grok-4.5"), true);
    assert.equal(modelSupportsReasoningEffort("xai/grok-4.5"), true);
    assert.equal(modelSupportsReasoningEffort("grok-4"), false);
    assert.deepEqual([...effortLevelsForModel("grok-4.5")], [
      "low",
      "medium",
      "high",
    ]);
    assert.equal(defaultEffortForModel("grok-4.5"), "high");
  });

  it("resolves configured vs default vs unsupported", () => {
    assert.equal(resolveReasoningEffort("grok-4.5", "low"), "low");
    assert.equal(resolveReasoningEffort("grok-4.5", undefined), "high");
    assert.equal(resolveReasoningEffort("grok-4", "high"), undefined);
  });
});

describe("resolveMaxTurns", () => {
  it("treats 0 / negative / invalid as unlimited", () => {
    assert.equal(resolveMaxTurns(0), Number.POSITIVE_INFINITY);
    assert.equal(resolveMaxTurns(-1), Number.POSITIVE_INFINITY);
    assert.equal(resolveMaxTurns(undefined), Number.POSITIVE_INFINITY);
    assert.equal(resolveMaxTurns(NaN), Number.POSITIVE_INFINITY);
  });

  it("floors positive budgets", () => {
    assert.equal(resolveMaxTurns(200), 200);
    assert.equal(resolveMaxTurns(3.9), 3);
  });
});

describe("buildChatRequest reasoning_effort", () => {
  it("includes reasoning_effort for grok-4.5", () => {
    const req = buildChatRequest(
      { ...DEFAULT_CONFIG, model: "grok-4.5", reasoningEffort: "medium" },
      [{ role: "user", content: "hi" }],
    );
    assert.equal(req.model, "grok-4.5");
    assert.equal(req.reasoning_effort, "medium");
  });

  it("omits reasoning_effort for models without support", () => {
    const req = buildChatRequest(
      { ...DEFAULT_CONFIG, model: "grok-4", reasoningEffort: "high" },
      [{ role: "user", content: "hi" }],
    );
    assert.equal(req.reasoning_effort, undefined);
  });

  it("defaults effort to high for grok-4.5 when unset", () => {
    const req = buildChatRequest(
      { ...DEFAULT_CONFIG, model: "grok-4.5", reasoningEffort: undefined },
      [],
    );
    assert.equal(req.reasoning_effort, "high");
  });
});

describe("config + preferences effort", () => {
  beforeEach(() => {
    delete process.env.FORGE_MODEL;
    delete process.env.FORGE_EFFORT;
    delete process.env.FORGE_REASONING_EFFORT;
  });

  it("defaults to grok-4.5 high", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-def-"));
    process.env.FORGE_HOME = home;
    const cfg = loadConfig({}, home);
    assert.equal(cfg.model, "grok-4.5");
    assert.equal(cfg.reasoningEffort, "high");
    assert.ok(cfg.providers.xai.models?.includes("grok-4.5"));
  });

  it("loads reasoning_effort from toml and env", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-toml-"));
    process.env.FORGE_HOME = home;
    fs.writeFileSync(
      path.join(home, "config.toml"),
      'model = "grok-4.5"\nreasoning_effort = "low"\n',
    );
    const cfg = loadConfig({}, home);
    assert.equal(cfg.reasoningEffort, "low");

    process.env.FORGE_EFFORT = "medium";
    const cfgEnv = loadConfig({}, home);
    assert.equal(cfgEnv.reasoningEffort, "medium");
    delete process.env.FORGE_EFFORT;
  });

  it("persists effort via preferences", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-prefs-"));
    process.env.FORGE_HOME = home;
    savePreferences({ reasoningEffort: "low", model: "grok-4.5" });
    assert.equal(loadPreferences().reasoningEffort, "low");
    const cfg = loadConfig({}, home);
    assert.equal(cfg.reasoningEffort, "low");
    assert.equal(cfg.model, "grok-4.5");
  });
});

describe("/effort slash", () => {
  it("classifies live policy", () => {
    assert.equal(classifyLiveSlash("/effort"), "readonly");
    assert.equal(classifyLiveSlash("/effort low"), "control");
    assert.equal(classifyLiveSlash("/effort high"), "control");
    assert.equal(classifyLiveSlash("/model grok-4.5"), "idle-only");
  });

  it("sets effort on supporting model", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-slash-"));
    process.env.FORGE_HOME = home;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      model: "grok-4.5",
      reasoningEffort: "high" as const,
      workspace: tmp,
    };
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/effort medium", {
      session,
      config,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(r.output || "", /medium/);
    assert.equal(config.reasoningEffort, "medium");
    assert.equal(loadPreferences().reasoningEffort, "medium");
  });

  it("rejects effort on non-supporting model", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      model: "grok-4",
      workspace: tmp,
    };
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/effort low", { session, config, hooks });
    assert.match(r.output || "", /does not support/i);
  });

  it("accepts /model grok-4.5 low", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-model-effort-"));
    process.env.FORGE_HOME = home;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      model: "grok-4",
      workspace: tmp,
    };
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/model grok-4.5 low", {
      session,
      config,
      hooks,
    });
    assert.equal(config.model, "grok-4.5");
    assert.equal(config.reasoningEffort, "low");
    assert.match(r.output || "", /grok-4\.5/);
    assert.match(r.output || "", /low/);
  });
});

describe("completion", () => {
  it("lists grok-4.5 in /model and efforts in /effort", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      provider: "xai" as const,
      model: "grok-4.5",
      reasoningEffort: "high" as const,
    };
    const [models] = forgeCompleter("/model gr", cfg);
    assert.ok(models.some((h) => h.includes("grok-4.5")));

    const [efforts] = forgeCompleter("/effort ", cfg);
    assert.ok(efforts.some((h) => h.includes("low")));
    assert.ok(efforts.some((h) => h.includes("medium")));
    assert.ok(efforts.some((h) => h.includes("high")));
  });
});
