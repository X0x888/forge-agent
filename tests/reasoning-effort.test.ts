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
  bumpReasoningEffort,
  clampEffortForModel,
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
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";

describe("reasoning effort helpers", () => {
  it("parses aliases including max/xhigh", () => {
    assert.equal(parseReasoningEffort("low"), "low");
    assert.equal(parseReasoningEffort("L"), "low");
    assert.equal(parseReasoningEffort("med"), "medium");
    assert.equal(parseReasoningEffort("HIGH"), "high");
    assert.equal(parseReasoningEffort("max"), "max");
    assert.equal(parseReasoningEffort("xhigh"), "xhigh");
    assert.equal(parseReasoningEffort("minimal"), "minimal");
    assert.equal(parseReasoningEffort(""), null);
  });

  it("knows grok-4.5 supports low/medium/high with max=high", () => {
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

  it("knows grok-4.6 supports xhigh as max", () => {
    assert.equal(modelSupportsReasoningEffort("grok-4.6"), true);
    assert.deepEqual([...effortLevelsForModel("grok-4.6")], [
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    assert.equal(defaultEffortForModel("grok-4.6"), "xhigh");
  });

  it("deepseek v4 flash defaults to max", () => {
    assert.equal(
      modelSupportsReasoningEffort("deepseek/deepseek-v4-flash-0731"),
      true,
    );
    assert.equal(
      defaultEffortForModel("deepseek/deepseek-v4-flash-0731"),
      "max",
    );
    assert.equal(
      resolveReasoningEffort("deepseek/deepseek-v4-flash-0731", undefined),
      "max",
    );
    assert.equal(
      resolveReasoningEffort("deepseek/deepseek-v4-flash", "high"),
      "high",
    );
    assert.deepEqual(
      [...effortLevelsForModel("deepseek/deepseek-v4-flash")],
      ["low", "high", "max"],
    );
  });

  it("resolves configured vs default vs unsupported", () => {
    assert.equal(resolveReasoningEffort("grok-4.5", "low"), "low");
    assert.equal(resolveReasoningEffort("grok-4.5", undefined), "high");
    assert.equal(resolveReasoningEffort("grok-4", "high"), undefined);
  });

  it("clamps xhigh to max on deepseek", () => {
    assert.equal(
      clampEffortForModel("deepseek/deepseek-v4-flash", "xhigh"),
      "max",
    );
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

  it("includes max for deepseek v4 by default", () => {
    const req = buildChatRequest(
      {
        ...DEFAULT_CONFIG,
        model: "deepseek/deepseek-v4-flash-0731",
        reasoningEffort: undefined,
      },
      [],
    );
    assert.equal(req.reasoning_effort, "max");
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

  it("defaults effort to xhigh for grok-4.6 when unset", () => {
    const req = buildChatRequest(
      { ...DEFAULT_CONFIG, model: "grok-4.6", reasoningEffort: undefined },
      [],
    );
    assert.equal(req.reasoning_effort, "xhigh");
  });

  it("effort override wins over config (adaptive escalation)", () => {
    const req = buildChatRequest(
      { ...DEFAULT_CONFIG, model: "grok-4.5", reasoningEffort: "low" },
      [],
      "high",
    );
    assert.equal(req.reasoning_effort, "high");
  });
});

describe("OpenRouter body includes reasoning map", () => {
  it("buildBody sends reasoning_effort + reasoning for openrouter", () => {
    const p = new OpenAICompatProvider({
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
    });
    // access private via cast for unit test
    const body = (
      p as unknown as {
        buildBody: (
          req: {
            model: string;
            messages: [];
            reasoning_effort: string;
          },
          stream: boolean,
        ) => Record<string, unknown>;
      }
    ).buildBody(
      {
        model: "deepseek/deepseek-v4-flash",
        messages: [],
        reasoning_effort: "max",
      },
      false,
    );
    assert.equal(body.reasoning_effort, "max");
    // OpenRouter's normalized reasoning.effort enum takes "xhigh", NOT the
    // DeepSeek-native "max" — "max" is ignored upstream and silently falls
    // back to default effort. Top-level reasoning_effort stays "max".
    assert.deepEqual(body.reasoning, { effort: "xhigh", enabled: true });

    // Non-max efforts pass through unchanged on both fields.
    const body2 = (
      p as unknown as {
        buildBody: (
          req: { model: string; messages: []; reasoning_effort: string },
          stream: boolean,
        ) => Record<string, unknown>;
      }
    ).buildBody(
      { model: "x-ai/grok-4.5", messages: [], reasoning_effort: "high" },
      false,
    );
    assert.equal(body2.reasoning_effort, "high");
    assert.deepEqual(body2.reasoning, { effort: "high", enabled: true });
  });
});

describe("bumpReasoningEffort (adaptive escalation)", () => {
  it("bumps one notch within model levels", () => {
    assert.equal(bumpReasoningEffort("grok-4.5", "low"), "medium");
    assert.equal(bumpReasoningEffort("grok-4.5", "medium"), "high");
    assert.equal(bumpReasoningEffort("grok-4.5", "high"), "high");
  });

  it("uses the model default when current is undefined", () => {
    // grok-4.5 default is already high → bump is a no-op at the top
    assert.equal(bumpReasoningEffort("grok-4.5", undefined), "high");
  });

  it("returns undefined for models without effort support", () => {
    assert.equal(bumpReasoningEffort("grok-4", "low"), undefined);
  });

  it("bumps deepseek toward max", () => {
    assert.equal(
      bumpReasoningEffort("deepseek/deepseek-v4-flash", "low"),
      "high",
    );
    assert.equal(
      bumpReasoningEffort("deepseek/deepseek-v4-flash", "high"),
      "max",
    );
  });
});

describe("config + preferences effort", () => {
  beforeEach(() => {
    delete process.env.FORGE_MODEL;
    delete process.env.FORGE_EFFORT;
    delete process.env.FORGE_REASONING_EFFORT;
    delete process.env.FORGE_PROVIDER;
  });

  it("defaults to grok-4.6 with unset effort (resolve → xhigh)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-def-"));
    process.env.FORGE_HOME = home;
    const cfg = loadConfig({}, home);
    assert.equal(cfg.model, "grok-4.6");
    // Unset means request-time resolve uses model max (xhigh for grok-4.6)
    assert.equal(cfg.reasoningEffort, undefined);
    assert.equal(resolveReasoningEffort(cfg.model, cfg.reasoningEffort), "xhigh");
    assert.ok(cfg.providers.xai.models?.includes("grok-4.6"));
    assert.ok(cfg.providers.xai.models?.includes("grok-4.5"));
  });

  it("CLI model without --effort uses model max (not sticky high)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-cli-"));
    process.env.FORGE_HOME = home;
    savePreferences({ reasoningEffort: "high", model: "grok-4.5" });
    const cfg = loadConfig(
      {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash-0731",
      },
      home,
    );
    assert.equal(cfg.model, "deepseek/deepseek-v4-flash-0731");
    // Sticky high ignored when model came from CLI without --effort
    assert.equal(cfg.reasoningEffort, undefined);
    assert.equal(
      resolveReasoningEffort(cfg.model, cfg.reasoningEffort),
      "max",
    );
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

  it("persists effort via preferences when not overridden by CLI model", () => {
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
    assert.equal(classifyLiveSlash("/effort max"), "control");
    assert.equal(classifyLiveSlash("/model grok-4.5"), "control");
    assert.equal(classifyLiveSlash("/model"), "readonly");
  });

  it("empty /effort is a verdict card, not a numbered menu", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-peek-"));
    process.env.FORGE_HOME = home;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      model: "grok-4.6",
      reasoningEffort: "high" as const,
      workspace: tmp,
    };
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
    });
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/effort", { session, config, hooks });
    const out = String(r.output || "");
    assert.match(out, /effort  ·  high/);
    assert.doesNotMatch(out, /pick a value/i);
    assert.match(out, /Next  \/effort xhigh|Next  \/model/);
  });

  it("unknown /effort Nexts the tip and lists levels", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-unk-"));
    process.env.FORGE_HOME = home;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      model: "grok-4.6",
      reasoningEffort: "high" as const,
      workspace: tmp,
    };
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
    });
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/effort highe", { session, config, hooks });
    const out = String(r.output || "");
    assert.match(out, /effort  ·  unknown/);
    assert.match(out, /Did you mean: high/);
    assert.match(out, /low \| medium \| high \| xhigh/);
    assert.match(out, /Next  \/effort high/);
    assert.doesNotMatch(out, /Next  \/effort$/m);
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

  it("sets max on deepseek", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-ds-"));
    process.env.FORGE_HOME = home;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      provider: "openrouter" as const,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: undefined,
      workspace: tmp,
    };
    const session = createSession({
      cwd: tmp,
      provider: "openrouter",
      model: config.model,
    });
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/effort max", { session, config, hooks });
    assert.equal(config.reasoningEffort, "max");
    assert.match(r.output || "", /max/);
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

  it("accepts /model grok-4.6 xhigh and future grok-4.7", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-model-46-"));
    process.env.FORGE_HOME = home;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      model: "grok-4.5",
      workspace: tmp,
    };
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/model grok-4.6 xhigh", {
      session,
      config,
      hooks,
    });
    assert.equal(config.model, "grok-4.6");
    assert.equal(config.reasoningEffort, "xhigh");
    assert.match(r.output || "", /grok-4\.6/);
    assert.match(r.output || "", /xhigh/);
    assert.equal(config.contextWindow, 500_000);

    const r2 = await handleSlash("/model grok-4.7", {
      session,
      config,
      hooks,
    });
    assert.equal(config.model, "grok-4.7");
    assert.equal(config.reasoningEffort, "xhigh");
    assert.equal(config.contextWindow, 500_000);
    assert.match(r2.output || "", /grok-4\.7/);
  });

  it("rejects /model grok-45 as a typo of grok-4.5", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-model-typo-"));
    process.env.FORGE_HOME = home;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      model: "grok-4.6",
      workspace: tmp,
    };
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
    });
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/model grok-45", { session, config, hooks });
    assert.match(r.output || "", /Did you mean: grok-4\.5/);
    assert.equal(config.model, "grok-4.6");
  });

  it("/model deepseek without effort picks max", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-model-ds-"));
    process.env.FORGE_HOME = home;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
    const config = {
      ...DEFAULT_CONFIG,
      provider: "openrouter" as const,
      model: "anthropic/claude-sonnet-4",
      reasoningEffort: "high" as const,
      workspace: tmp,
    };
    const session = createSession({
      cwd: tmp,
      provider: "openrouter",
      model: config.model,
    });
    const hooks = new HookRunner(config, tmp);
    await handleSlash("/model deepseek/deepseek-v4-flash-0731", {
      session,
      config,
      hooks,
    });
    assert.equal(config.model, "deepseek/deepseek-v4-flash-0731");
    assert.equal(config.reasoningEffort, "max");
  });
});

describe("completion", () => {
  it("lists grok-4.6/4.5 in /model and efforts in /effort", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      provider: "xai" as const,
      model: "grok-4.5",
      reasoningEffort: "high" as const,
    };
    const [models] = forgeCompleter("/model gr", cfg);
    assert.ok(models.some((h) => h.includes("grok-4.5")));
    assert.ok(models.some((h) => h.includes("grok-4.6")));

    const [efforts] = forgeCompleter("/effort ", cfg);
    assert.ok(efforts.some((h) => h.includes("low")));
    assert.ok(efforts.some((h) => h.includes("medium")));
    assert.ok(efforts.some((h) => h.includes("high")));
    // grok-4.5 max is "high" (no separate "max" level)
    assert.ok(!efforts.some((h) => h === "/effort max"));

    const cfg46 = {
      ...DEFAULT_CONFIG,
      provider: "xai" as const,
      model: "grok-4.6",
    };
    const [efforts46] = forgeCompleter("/effort ", cfg46);
    assert.ok(efforts46.some((h) => h.includes("xhigh")));

    const dsCfg = {
      ...DEFAULT_CONFIG,
      provider: "openrouter" as const,
      model: "deepseek/deepseek-v4-flash",
    };
    const [dsEfforts] = forgeCompleter("/effort ", dsCfg);
    assert.ok(dsEfforts.some((h) => h.includes("max")));
  });
});
