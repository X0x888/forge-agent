import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderApiError } from "../src/providers/errors.js";
import {
  defaultFallbackModels,
  formatFallbackChain,
  isModelFallbackWorthy,
  nextFallbackModel,
  parseFallbackModels,
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
    assert.equal(parseFallbackModels(undefined), undefined);
  });
});

describe("nextFallbackModel", () => {
  it("defaults grok-4.6 → grok-4.5 then grok-4", () => {
    const cfg = {
      provider: "xai",
      model: "grok-4.6",
    } as Pick<ForgeConfig, "provider" | "model" | "fallbackModels">;
    assert.equal(nextFallbackModel(cfg), "grok-4.5");
    assert.equal(nextFallbackModel(cfg, { tried: ["grok-4.5"] }), "grok-4");
    assert.equal(
      nextFallbackModel(cfg, { tried: ["grok-4.5", "grok-4"] }),
      undefined,
    );
  });

  it("empty explicit chain disables fallback", () => {
    assert.equal(
      nextFallbackModel({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: [],
      }),
      undefined,
    );
  });

  it("honors explicit custom models even if not in catalog", () => {
    assert.equal(
      nextFallbackModel({
        provider: "xai",
        model: "grok-4.6",
        fallbackModels: ["my-custom-grok"],
      }),
      "my-custom-grok",
    );
  });

  it("skips the current model in the default chain", () => {
    assert.deepEqual(defaultFallbackModels("xai", "grok-4.5"), ["grok-4"]);
  });

  it("formatFallbackChain labels defaults / off / explicit", () => {
    assert.equal(
      formatFallbackChain({ provider: "xai", model: "grok-4.6" }),
      "defaults → grok-4.5",
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
        fallbackModels: ["grok-4", "grok-3"],
      }),
      "grok-4 → grok-3",
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
  it("sets / shows / disables the chain", () => {
    const config = { ...DEFAULT_CONFIG, model: "grok-4.6", provider: "xai" };
    let r = handleFallbackSlash("", { config });
    assert.match(r.output ?? "", /defaults/);
    r = handleFallbackSlash("grok-4, grok-3", { config });
    assert.deepEqual(config.fallbackModels, ["grok-4", "grok-3"]);
    r = handleFallbackSlash("off", { config });
    assert.deepEqual(config.fallbackModels, []);
    r = handleFallbackSlash("default", { config });
    assert.equal(config.fallbackModels, undefined);
    assert.match(r.output ?? "", /defaults/);
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
      assert.deepEqual(session.meta.fallbackModels, ["grok-4.5", "grok-4"]);
      handleFallbackSlash("off", { config, session });
      assert.deepEqual(session.meta.fallbackModels, []);
      handleFallbackSlash("default", { config, session });
      assert.equal(session.meta.fallbackModels, undefined);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
