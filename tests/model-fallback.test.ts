import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderApiError } from "../src/providers/errors.js";
import {
  applyFallbackHop,
  defaultFallbackModels,
  FALLBACK_DEFAULT_MARKER,
  FALLBACK_FLOOR_LABEL,
  filterFallbackChain,
  formatFallbackChain,
  isModelFallbackWorthy,
  materializeFallbackModels,
  meetsFallbackFloor,
  nextFallbackModel,
  normalizeFallbackModelId,
  parseFallbackModels,
  providerAcceptsFallbackId,
  rebindFallbackModels,
} from "../src/config/model-fallback.js";
import { handleFallbackSlash } from "../src/commands/slash.js";
import { DEFAULT_CONFIG, type ForgeConfig } from "../src/config/types.js";

describe("parseFallbackModels", () => {
  it("parses csv / arrays and treats off as empty", () => {
    assert.deepEqual(parseFallbackModels("grok-4.5, grok-4"), [
      "grok-4.5",
      "grok-4",
    ]);
    assert.deepEqual(parseFallbackModels(["a", "a", "b"]), ["a", "b"]);
    assert.deepEqual(parseFallbackModels("off"), []);
    assert.deepEqual(parseFallbackModels("none"), []);
    assert.deepEqual(parseFallbackModels("on"), [FALLBACK_DEFAULT_MARKER]);
    assert.deepEqual(parseFallbackModels("default"), [FALLBACK_DEFAULT_MARKER]);
    assert.deepEqual(parseFallbackModels(true), [FALLBACK_DEFAULT_MARKER]);
    assert.equal(parseFallbackModels(undefined), undefined);
  });
});

describe("meetsFallbackFloor", () => {
  it("accepts grok-4.5+ at high and rejects weaker Grok", () => {
    assert.equal(meetsFallbackFloor("grok-4.5"), true);
    assert.equal(meetsFallbackFloor("grok-4.6"), true);
    assert.equal(meetsFallbackFloor("grok-4.7"), true);
    assert.equal(meetsFallbackFloor("x-ai/grok-4.5"), true);
    assert.equal(meetsFallbackFloor("cursor-grok-4.5-high"), true);
    assert.equal(meetsFallbackFloor("cursor-grok-4.6-xhigh-fast"), true);
    assert.equal(meetsFallbackFloor("grok-4"), false);
    assert.equal(meetsFallbackFloor("grok-3"), false);
    assert.equal(meetsFallbackFloor("grok-3-mini"), false);
    assert.equal(meetsFallbackFloor("cursor-grok-4.6-low-fast"), false);
  });

  it("rejects composer/auto/haiku/flash and unknown custom ids", () => {
    assert.equal(meetsFallbackFloor("composer-2.5"), false);
    assert.equal(meetsFallbackFloor("auto"), false);
    assert.equal(meetsFallbackFloor("claude-haiku-4-20250414"), false);
    assert.equal(meetsFallbackFloor("claude-sonnet-4-20250514"), false);
    assert.equal(meetsFallbackFloor("gpt-4o"), false);
    assert.equal(meetsFallbackFloor("gpt-4.1"), false);
    assert.equal(meetsFallbackFloor("gemini-2.5-flash"), false);
    assert.equal(meetsFallbackFloor("my-custom-grok"), false);
    assert.equal(meetsFallbackFloor("claude-sonnet-5-medium"), false);
  });

  it("accepts peer families at high", () => {
    assert.equal(meetsFallbackFloor("claude-opus-4-20250514"), true);
    assert.equal(meetsFallbackFloor("claude-sonnet-5-high"), true);
    assert.equal(meetsFallbackFloor("claude-fable-5-high"), true);
    assert.equal(meetsFallbackFloor("o3"), true);
    assert.equal(meetsFallbackFloor("gemini-2.5-pro"), true);
    assert.equal(meetsFallbackFloor("gpt-5.5"), true);
  });
});

describe("nextFallbackModel", () => {
  it("is off when unset or empty", () => {
    const cfg = {
      provider: "xai",
      model: "grok-4.6",
    } as Pick<ForgeConfig, "provider" | "model" | "fallbackModels">;
    assert.equal(nextFallbackModel(cfg), undefined);
    assert.equal(
      nextFallbackModel({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: [],
      }),
      undefined,
    );
  });

  it("opts in to grok-4.6 → grok-4.5 and never grok-4", () => {
    const cfg = {
      provider: "xai",
      model: "grok-4.6",
      fallbackModels: defaultFallbackModels("xai", "grok-4.6"),
    } as Pick<ForgeConfig, "provider" | "model" | "fallbackModels">;
    assert.deepEqual(cfg.fallbackModels, ["grok-4.6", "grok-4.5"]);
    assert.equal(nextFallbackModel(cfg), "grok-4.5");
    assert.equal(
      nextFallbackModel(cfg, { tried: ["grok-4.5"] }),
      undefined,
    );
  });

  it("drops explicit models below the floor", () => {
    assert.equal(
      nextFallbackModel({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: ["grok-4", "grok-3", "my-custom-grok"],
      }),
      undefined,
    );
    assert.equal(
      nextFallbackModel({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: ["grok-4.5", "grok-4"],
      }),
      "grok-4.5",
    );
  });

  it("accepts a future grok flagship even if not in the static catalog", () => {
    assert.equal(
      nextFallbackModel({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: ["grok-4.7"],
      }),
      "grok-4.7",
    );
  });

  it("Cursor chain uses wire ids and never auto/composer", () => {
    const chain = defaultFallbackModels("cursor", "cursor-grok-4.6-xhigh-fast");
    assert.ok(chain.includes("cursor-grok-4.6-xhigh-fast"));
    assert.ok(chain.includes("cursor-grok-4.5-high"));
    assert.ok(!chain.some((m) => /auto|composer/i.test(m)));
    assert.equal(
      normalizeFallbackModelId("cursor", "grok-4.5"),
      "cursor-grok-4.5-high",
    );
    assert.equal(
      nextFallbackModel({
        provider: "cursor",
        model: "cursor-grok-4.6-xhigh-fast",
        fallbackModels: chain,
      }),
      "cursor-grok-4.6-high-fast",
    );
    assert.equal(
      nextFallbackModel({
        provider: "cursor",
        model: "cursor-grok-4.6-xhigh-fast",
        fallbackModels: ["auto", "composer-2.5", "grok-4"],
      }),
      undefined,
    );
  });

  it("unwraps Cursor wire ids on xAI and OpenRouter", () => {
    assert.equal(
      normalizeFallbackModelId("xai", "cursor-grok-4.6-xhigh-fast"),
      "grok-4.6",
    );
    assert.equal(
      normalizeFallbackModelId("openrouter", "cursor-grok-4.5-high"),
      "x-ai/grok-4.5",
    );
    assert.equal(
      nextFallbackModel({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: defaultFallbackModels("cursor"),
      }),
      "grok-4.5",
    );
  });

  it("does not unwrap a below-floor Cursor effort into a bare flagship", () => {
    assert.deepEqual(
      filterFallbackChain(["cursor-grok-4.6-low-fast"], "xai").kept,
      [],
    );
  });

  it("rejects a Grok hop on Anthropic and a Claude hop on xAI", () => {
    assert.equal(providerAcceptsFallbackId("anthropic", "grok-4.5"), false);
    assert.equal(providerAcceptsFallbackId("xai", "claude-opus-4-20250514"), false);
    assert.equal(
      nextFallbackModel({
        provider: "anthropic",
        model: "claude-opus-4-20250514",
        fallbackModels: ["grok-4.5", "grok-4.6"],
      }),
      undefined,
    );
  });

  it("rebinds a catalog-default chain across providers", () => {
    const cursor = defaultFallbackModels("cursor");
    assert.deepEqual(rebindFallbackModels(cursor, "cursor", "xai"), [
      "grok-4.6",
      "grok-4.5",
    ]);
    assert.deepEqual(
      rebindFallbackModels(["grok-4.5"], "xai", "cursor"),
      ["cursor-grok-4.5-high"],
    );
    assert.deepEqual(
      rebindFallbackModels(["grok-4.5"], "xai", "anthropic"),
      [],
    );
  });

  it("formatFallbackChain labels off / explicit", () => {
    assert.equal(
      formatFallbackChain({ provider: "xai", model: "grok-4.6" }),
      "off",
    );
    assert.equal(
      formatFallbackChain({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: [],
      }),
      "off",
    );
    assert.equal(
      formatFallbackChain({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: ["grok-4.5", "grok-4"],
      }),
      "grok-4.5",
    );
  });
});

describe("materializeFallbackModels", () => {
  it("expands on and drops below-floor ids", () => {
    assert.deepEqual(
      materializeFallbackModels(
        [FALLBACK_DEFAULT_MARKER],
        "xai",
        "grok-4.6",
      ),
      ["grok-4.6", "grok-4.5"],
    );
    assert.deepEqual(
      materializeFallbackModels(["grok-4.5", "grok-4"], "xai", "grok-4.6"),
      ["grok-4.5"],
    );
    assert.equal(
      materializeFallbackModels(undefined, "xai", "grok-4.6"),
      undefined,
    );
  });
});

describe("applyFallbackHop", () => {
  it("raises a low effort pin to the floor", () => {
    const config = {
      ...DEFAULT_CONFIG,
      model: "grok-4.6",
      reasoningEffort: "low" as const,
      fallbackModels: ["grok-4.5"],
    };
    const to = applyFallbackHop(config, "grok-4.5");
    assert.equal(to, "grok-4.5");
    assert.equal(config.reasoningEffort, "high");
  });

  it("rewrites Cursor aliases to a high wire id", () => {
    const config = {
      ...DEFAULT_CONFIG,
      provider: "cursor",
      model: "cursor-grok-4.6-xhigh-fast",
    };
    const to = applyFallbackHop(config, "grok-4.5");
    assert.equal(to, "cursor-grok-4.5-high");
    assert.equal(config.model, "cursor-grok-4.5-high");
  });

  it("does not hop to a family the provider cannot serve", () => {
    assert.equal(
      applyFallbackHop(
        {
          ...DEFAULT_CONFIG,
          provider: "anthropic",
          model: "claude-opus-4-20250514",
        },
        "grok-4.5",
      ),
      "claude-opus-4-20250514",
    );
  });
});

function apiErr(status: number, body: string): ProviderApiError {
  return new ProviderApiError({ provider: "xai", status, body });
}

describe("isModelFallbackWorthy", () => {
  it("accepts 429/5xx/overloaded and rejects auth/quota", () => {
    assert.equal(isModelFallbackWorthy(apiErr(429, "rate")), true);
    assert.equal(isModelFallbackWorthy(apiErr(503, "boom")), true);
    assert.equal(isModelFallbackWorthy(apiErr(529, "overloaded")), true);
    assert.equal(isModelFallbackWorthy(apiErr(401, "bad key")), false);
    assert.equal(
      isModelFallbackWorthy(new Error("The OAuth2 access token could not be validated")),
      false,
    );
    assert.equal(isModelFallbackWorthy(new Error("model is overloaded")), true);
  });
});

describe("handleFallbackSlash", () => {
  it("sets / shows / disables the chain and rejects below-floor ids", () => {
    const config = { ...DEFAULT_CONFIG, model: "grok-4.6", provider: "xai" };
    let r = handleFallbackSlash("", { config });
    assert.match(r.output ?? "", /fallback  ·  off/);
    assert.doesNotMatch(r.output ?? "", /Usage:/);
    assert.match(r.output ?? "", /Next  \/fallback on/);
    assert.match(r.output ?? "", new RegExp(FALLBACK_FLOOR_LABEL.replace(".", "\\.")));
    r = handleFallbackSlash("on", { config });
    assert.deepEqual(config.fallbackModels, ["grok-4.6", "grok-4.5"]);
    r = handleFallbackSlash("grok-4, grok-3", { config });
    assert.deepEqual(config.fallbackModels, ["grok-4.6", "grok-4.5"]);
    assert.match(r.output ?? "", /rejected/);
    r = handleFallbackSlash("grok-4.5, grok-4", { config });
    assert.deepEqual(config.fallbackModels, ["grok-4.5"]);
    assert.match(r.output ?? "", /dropped/);
    r = handleFallbackSlash("off", { config });
    assert.deepEqual(config.fallbackModels, []);
    r = handleFallbackSlash("default", { config });
    assert.deepEqual(config.fallbackModels, ["grok-4.6", "grok-4.5"]);
  });

  it("persists the chain on session meta (survives resume)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fallback-"));
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    try {
      const { createSession } = await import("../src/session/session.js");
      const session = createSession({
        cwd: tmp,
        provider: "xai",
        model: "grok-4.6",
      });
      const config = { ...DEFAULT_CONFIG, model: "grok-4.6", provider: "xai" };
      handleFallbackSlash("grok-4.5, grok-4", { config, session });
      assert.deepEqual(session.meta.fallbackModels, ["grok-4.5"]);
      handleFallbackSlash("off", { config, session });
      assert.deepEqual(session.meta.fallbackModels, []);
      handleFallbackSlash("on", { config, session });
      assert.deepEqual(session.meta.fallbackModels, ["grok-4.6", "grok-4.5"]);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("filterFallbackChain", () => {
  it("normalizes Cursor grok-4.5 to the high wire id", () => {
    const { kept, dropped } = filterFallbackChain(
      ["grok-4.5", "auto", "composer-2.5"],
      "cursor",
    );
    assert.deepEqual(kept, ["cursor-grok-4.5-high"]);
    assert.deepEqual(dropped, ["auto", "composer-2.5"]);
  });
});

describe("loadConfig fallback", () => {
  it("stays off by default and expands FORGE_FALLBACK_MODELS=on", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fb-load-"));
    const prevHome = process.env.FORGE_HOME;
    const prevFb = process.env.FORGE_FALLBACK_MODELS;
    process.env.FORGE_HOME = tmp;
    try {
      const { loadConfig } = await import("../src/config/load.js");
      delete process.env.FORGE_FALLBACK_MODELS;
      const off = loadConfig({}, tmp);
      assert.equal(off.fallbackModels, undefined);
      process.env.FORGE_FALLBACK_MODELS = "on";
      const on = loadConfig({}, tmp);
      assert.deepEqual(on.fallbackModels, ["grok-4.6", "grok-4.5"]);
      process.env.FORGE_FALLBACK_MODELS = "grok-4.5, grok-4";
      const filtered = loadConfig({}, tmp);
      assert.deepEqual(filtered.fallbackModels, ["grok-4.5"]);
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prevHome;
      if (prevFb === undefined) delete process.env.FORGE_FALLBACK_MODELS;
      else process.env.FORGE_FALLBACK_MODELS = prevFb;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
