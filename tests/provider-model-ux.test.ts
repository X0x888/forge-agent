/**
 * OpenRouter / multi-provider inline config UX:
 * /provider, /model free-form, /temperature, /max-tokens, recent models.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  loadPreferences,
  savePreferences,
  rememberRecentModel,
  lastModelForProvider,
} from "../src/config/preferences.js";
import {
  buildModelCatalogSync,
  providerAllowsFreeFormModels,
  trackRecentModel,
  staticModelsForProvider,
} from "../src/config/model-catalog.js";
import {
  classifyLiveSlash,
  handleSlash,
  handleProviderSlash,
  handleModelSlash,
  handleTemperatureSlash,
  handleMaxTokensSlash,
} from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";
import { forgeCompleter } from "../src/tui/complete.js";
import { upsertApiKey } from "../src/auth/store.js";

function tmpHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.FORGE_HOME = home;
  return home;
}

function makeOpts(provider: string, model: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ws-"));
  const config = {
    ...DEFAULT_CONFIG,
    provider,
    model,
    workspace: tmp,
    temperature: 0.2,
    maxTokens: 16384,
  };
  const session = createSession({ cwd: tmp, provider, model });
  const hooks = new HookRunner(config, tmp);
  return { config, session, hooks, tmp };
}

describe("provider free-form flags", () => {
  it("openrouter and custom allow free-form models", () => {
    assert.equal(providerAllowsFreeFormModels("openrouter"), true);
    assert.equal(providerAllowsFreeFormModels("custom"), true);
    assert.equal(providerAllowsFreeFormModels("xai"), false);
    assert.equal(providerAllowsFreeFormModels("anthropic"), false);
  });

  it("openrouter static catalog includes deepseek flash", () => {
    const ids = staticModelsForProvider(DEFAULT_CONFIG, "openrouter");
    assert.ok(ids.some((m) => m.includes("deepseek")));
    assert.ok(ids.includes("deepseek/deepseek-v4-flash"));
    assert.ok(ids.includes("x-ai/grok-4.6"));
  });
});

describe("recent models + lastModelByProvider", () => {
  beforeEach(() => {
    tmpHome(`forge-recent-${process.pid}-`);
  });

  it("rememberRecentModel de-dupes and caps", () => {
    rememberRecentModel("openrouter", "deepseek/deepseek-v4-flash");
    rememberRecentModel("openrouter", "anthropic/claude-sonnet-4");
    rememberRecentModel("openrouter", "deepseek/deepseek-v4-flash");
    const prefs = loadPreferences();
    assert.deepEqual(prefs.recentModels?.openrouter?.slice(0, 2), [
      "deepseek/deepseek-v4-flash",
      "anthropic/claude-sonnet-4",
    ]);
    assert.equal(
      lastModelForProvider("openrouter"),
      "deepseek/deepseek-v4-flash",
    );
  });

  it("savePreferences provider switch restores last model", () => {
    savePreferences({
      provider: "xai",
      model: "grok-4.5",
      modelProvider: "xai",
    });
    savePreferences({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      modelProvider: "openrouter",
    });
    // Switch back without model → restore grok-4.5
    savePreferences({ provider: "xai" });
    const prefs = loadPreferences();
    assert.equal(prefs.provider, "xai");
    assert.equal(prefs.model, "grok-4.5");
  });
});

describe("buildModelCatalogSync", () => {
  beforeEach(() => {
    tmpHome(`forge-cat-${process.pid}-`);
  });

  it("merges recent into openrouter catalog", () => {
    trackRecentModel("openrouter", "myorg/custom-finetune");
    const cat = buildModelCatalogSync(DEFAULT_CONFIG, "openrouter");
    assert.ok(cat.ids.includes("myorg/custom-finetune"));
    assert.ok(cat.freeForm);
    assert.ok(cat.models.some((m) => m.source === "recent"));
  });
});

describe("live slash classification", () => {
  it("classifies provider/model/temperature/max-tokens", () => {
    assert.equal(classifyLiveSlash("/provider"), "readonly");
    assert.equal(classifyLiveSlash("/provider openrouter"), "control");
    assert.equal(classifyLiveSlash("/model"), "readonly");
    assert.equal(
      classifyLiveSlash("/model deepseek/deepseek-v4-flash"),
      "control",
    );
    assert.equal(classifyLiveSlash("/temperature"), "readonly");
    assert.equal(classifyLiveSlash("/temperature 0.5"), "control");
    assert.equal(classifyLiveSlash("/temp 0.1"), "control");
    assert.equal(classifyLiveSlash("/max-tokens"), "readonly");
    assert.equal(classifyLiveSlash("/max-tokens 8192"), "control");
  });
});

describe("/provider slash", () => {
  beforeEach(() => {
    tmpHome(`forge-prov-${process.pid}-`);
  });

  it("lists providers when bare", async () => {
    const opts = makeOpts("xai", "grok-4.5");
    const r = await handleProviderSlash("", opts);
    assert.equal(r.handled, true);
    assert.match(r.output || "", /openrouter/i);
    assert.match(r.output || "", /active: xai/);
  });

  it("switches to openrouter and restores default/last model", async () => {
    upsertApiKey("openrouter", "sk-or-test-key", "test-or");
    const opts = makeOpts("xai", "grok-4.5");
    const r = await handleProviderSlash("openrouter", opts);
    assert.equal(r.handled, true);
    assert.equal(r.providerUpdated, true);
    assert.equal(opts.config.provider, "openrouter");
    assert.notEqual(opts.config.model, "grok-4.5");
    assert.match(r.output || "", /openrouter/i);
    // sticky
    assert.equal(loadPreferences().provider, "openrouter");
  });

  it("accepts or alias for openrouter", async () => {
    upsertApiKey("openrouter", "sk-or-test-key-2", "t2");
    const opts = makeOpts("xai", "grok-4.5");
    const r = await handleProviderSlash("or", opts);
    assert.equal(opts.config.provider, "openrouter");
    assert.equal(r.providerUpdated, true);
  });

  it("rejects unknown provider with tip", async () => {
    const opts = makeOpts("xai", "grok-4.5");
    const r = await handleProviderSlash("openroutr", opts);
    assert.match(r.output || "", /Did you mean|Unknown provider/i);
    assert.equal(opts.config.provider, "xai");
  });
});

describe("/model free-form on openrouter", () => {
  beforeEach(() => {
    tmpHome(`forge-model-or-${process.pid}-`);
  });

  it("accepts free-form deepseek id", async () => {
    const opts = makeOpts("openrouter", "anthropic/claude-sonnet-4");
    const r = await handleModelSlash("deepseek/deepseek-v4-flash", opts);
    assert.equal(opts.config.model, "deepseek/deepseek-v4-flash");
    assert.match(r.output || "", /deepseek\/deepseek-v4-flash/);
    assert.equal(
      lastModelForProvider("openrouter"),
      "deepseek/deepseek-v4-flash",
    );
  });

  it("bare /model shows provider header and free-form tip", async () => {
    const opts = makeOpts("openrouter", "deepseek/deepseek-v4-flash");
    const r = await handleModelSlash("", opts);
    assert.match(r.output || "", /Provider: openrouter/);
    assert.match(r.output || "", /Free-form|free-form/i);
  });
});

describe("/temperature and /max-tokens", () => {
  it("sets session temperature", () => {
    const opts = makeOpts("openrouter", "deepseek/deepseek-v4-flash");
    const r = handleTemperatureSlash("0.5", opts);
    assert.equal(opts.config.temperature, 0.5);
    assert.match(r.output || "", /0\.5/);
  });

  it("rejects out-of-range temperature", () => {
    const opts = makeOpts("openrouter", "m");
    const r = handleTemperatureSlash("3", opts);
    assert.match(r.output || "", /Invalid/);
    assert.equal(opts.config.temperature, 0.2);
  });

  it("sets max_tokens", () => {
    const opts = makeOpts("openrouter", "m");
    const r = handleMaxTokensSlash("8192", opts);
    assert.equal(opts.config.maxTokens, 8192);
    assert.match(r.output || "", /8192/);
  });
});

describe("context window auto + /context-window", () => {
  beforeEach(() => {
    tmpHome(`forge-ctx-${process.pid}-`);
  });

  it("knows deepseek v4 flash is ~1M", async () => {
    const { modelContextWindow, parseContextWindowArg, applyModelContextWindow } =
      await import("../src/config/model-info.js");
    assert.equal(modelContextWindow("deepseek/deepseek-v4-flash"), 1_048_576);
    assert.equal(modelContextWindow("deepseek-v4-flash"), 1_048_576);
    assert.equal(parseContextWindowArg("1m"), 1_000_000);
    assert.equal(parseContextWindowArg("200k"), 200_000);
    assert.equal(parseContextWindowArg("auto"), "auto");

    const cfg = {
      model: "deepseek/deepseek-v4-flash",
      contextWindow: 500_000,
      contextWindowExplicit: false as boolean | undefined,
    };
    const r = applyModelContextWindow(cfg);
    assert.equal(r.changed, true);
    assert.equal(cfg.contextWindow, 1_048_576);
  });

  it("/model applies model max context by default", async () => {
    const opts = makeOpts("openrouter", "anthropic/claude-sonnet-4");
    opts.config.contextWindow = 500_000;
    opts.config.contextWindowExplicit = false;
    await handleModelSlash("deepseek/deepseek-v4-flash", opts);
    assert.equal(opts.config.model, "deepseek/deepseek-v4-flash");
    assert.equal(opts.config.contextWindow, 1_048_576);
    assert.equal(opts.config.contextWindowExplicit, false);
  });

  it("/context-window pins and auto restores", async () => {
    const {
      handleContextWindowSlash,
    } = await import("../src/commands/slash.js");
    const { applyModelContextWindow } = await import(
      "../src/config/model-info.js"
    );
    const opts = makeOpts("openrouter", "deepseek/deepseek-v4-flash");
    opts.config.contextWindowExplicit = false;
    opts.config.contextWindow = 500_000;
    applyModelContextWindow(opts.config);
    const pin = handleContextWindowSlash("200k", opts);
    assert.equal(opts.config.contextWindow, 200_000);
    assert.equal(opts.config.contextWindowExplicit, true);
    assert.match(pin.output || "", /pinned/i);

    const auto = handleContextWindowSlash("auto", opts);
    assert.equal(opts.config.contextWindowExplicit, false);
    assert.equal(opts.config.contextWindow, 1_048_576);
    assert.match(auto.output || "", /auto|model max/i);
  });

  it("classifyLiveSlash for context-window", () => {
    assert.equal(classifyLiveSlash("/context-window"), "readonly");
    assert.equal(classifyLiveSlash("/context-window 1m"), "control");
    assert.equal(classifyLiveSlash("/ctx-window auto"), "control");
  });
});

describe("completion", () => {
  it("completes /provider openrouter", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      provider: "xai" as const,
      model: "grok-4.5",
    };
    const [hits] = forgeCompleter("/provider op", cfg);
    assert.ok(hits.some((h) => h.includes("openrouter")));
  });

  it("completes openrouter models including deepseek", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      provider: "openrouter" as const,
      model: "anthropic/claude-sonnet-4",
    };
    const [hits] = forgeCompleter("/model deep", cfg);
    assert.ok(
      hits.some((h) => h.includes("deepseek")),
      `expected deepseek in ${JSON.stringify(hits)}`,
    );
  });
});

describe("handleSlash integration", () => {
  beforeEach(() => {
    tmpHome(`forge-slash-int-${process.pid}-`);
  });

  it("/provider openrouter then /model free-form", async () => {
    upsertApiKey("openrouter", "sk-or-int", "int");
    const opts = makeOpts("xai", "grok-4.5");
    const p = await handleSlash("/provider openrouter", opts);
    assert.equal(p.providerUpdated, true);
    assert.equal(opts.config.provider, "openrouter");
    const m = await handleSlash(
      "/model deepseek/deepseek-v4-flash",
      opts,
    );
    assert.equal(opts.config.model, "deepseek/deepseek-v4-flash");
    assert.match(m.output || "", /deepseek/);
    const t = await handleSlash("/temperature 0.3", opts);
    assert.equal(opts.config.temperature, 0.3);
    assert.match(t.output || "", /0\.3/);
  });
});
