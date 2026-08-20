import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGrokGeneration,
  grokEffortLevels,
  grokContextWindow,
  grokCostRates,
  grokAtLeast,
  isGrokLineageModel,
  latestGrokFlagshipId,
} from "../src/config/grok-model.js";
import {
  defaultEffortForModel,
  effortLevelsForModel,
  modelSupportsReasoningEffort,
  resolveReasoningEffort,
  clampEffortForModel,
  bumpReasoningEffort,
} from "../src/config/reasoning.js";
import { modelContextWindow } from "../src/config/model-info.js";
import { estimateCostUsd } from "../src/util/format.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  isAcceptableUnknownModelId,
  isVersionedModelSibling,
  splitModelFamilyVersion,
} from "../src/util/suggest.js";

describe("grokAtLeast", () => {
  it("treats grok-4.5+ as at least 4.5 and rejects older/mini/non-text", () => {
    assert.equal(grokAtLeast("grok-4.5", 4, 5), true);
    assert.equal(grokAtLeast("cursor-grok-4.6-xhigh-fast", 4, 5), true);
    assert.equal(grokAtLeast("grok-4", 4, 5), false);
    assert.equal(grokAtLeast("grok-3-mini", 4, 5), false);
    assert.equal(grokAtLeast("claude-sonnet-5", 4, 5), null);
  });
});

describe("parseGrokGeneration", () => {
  it("parses flagship and prefixed ids", () => {
    assert.deepEqual(parseGrokGeneration("grok-4.6"), {
      major: 4,
      minor: 6,
      variant: "",
      key: "grok-4.6",
    });
    assert.equal(parseGrokGeneration("x-ai/grok-4.6-latest")?.minor, 6);
    assert.equal(parseGrokGeneration("GROK-4.5")?.minor, 5);
    assert.equal(parseGrokGeneration("grok-4")?.minor, 0);
    assert.equal(parseGrokGeneration("grok-3-mini")?.variant, "mini");
    assert.equal(parseGrokGeneration("claude-sonnet-4"), null);
  });
});

describe("Grok flagship effort inherit", () => {
  it("grok-4.5 max is high; grok-4.6 max is xhigh", () => {
    assert.deepEqual([...effortLevelsForModel("grok-4.5")], [
      "low",
      "medium",
      "high",
    ]);
    assert.equal(defaultEffortForModel("grok-4.5"), "high");
    assert.deepEqual([...effortLevelsForModel("grok-4.6")], [
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    assert.equal(defaultEffortForModel("grok-4.6"), "xhigh");
    assert.equal(resolveReasoningEffort("grok-4.6", undefined), "xhigh");
    assert.equal(resolveReasoningEffort("x-ai/grok-4.6-latest", "high"), "high");
  });

  it("xhigh clamps to high on grok-4.5 and stays on grok-4.6", () => {
    assert.equal(clampEffortForModel("grok-4.5", "xhigh"), "high");
    assert.equal(clampEffortForModel("grok-4.6", "xhigh"), "xhigh");
    assert.equal(clampEffortForModel("grok-4.6", "max"), "xhigh");
  });

  it("future flagship ids inherit the latest known max (xhigh)", () => {
    for (const id of ["grok-4.7", "grok-4.8", "grok-5", "grok-5.1", "x-ai/grok-4.7"]) {
      assert.equal(modelSupportsReasoningEffort(id), true, id);
      assert.equal(defaultEffortForModel(id), "xhigh", id);
      assert.ok(effortLevelsForModel(id).includes("xhigh"), id);
      assert.equal(modelContextWindow(id), 500_000, id);
    }
  });

  it("older Grok lines do not gain xhigh", () => {
    assert.equal(modelSupportsReasoningEffort("grok-4"), false);
    assert.equal(grokEffortLevels("grok-4"), undefined);
    assert.equal(modelContextWindow("grok-4"), 256_000);
    assert.equal(modelSupportsReasoningEffort("grok-3"), false);
    assert.equal(modelContextWindow("grok-3"), 131_072);
    assert.equal(modelContextWindow("grok-3-mini"), 131_072);
  });

  it("grok-4.20 product line is not treated as newer than 4.6", () => {
    assert.equal(grokEffortLevels("grok-4.20"), undefined);
    assert.equal(grokContextWindow("grok-4.20"), 1_000_000);
    assert.deepEqual(
      [...(grokEffortLevels("grok-4.20-multi-agent") || [])],
      ["low", "medium", "high", "xhigh"],
    );
  });

  it("bumps grok-4.6 toward xhigh", () => {
    assert.equal(bumpReasoningEffort("grok-4.6", "high"), "xhigh");
    assert.equal(bumpReasoningEffort("grok-4.6", "xhigh"), "xhigh");
    assert.equal(bumpReasoningEffort("grok-4.6", undefined), "xhigh");
  });

  it("latest flagship id tracks the last milestone", () => {
    assert.equal(latestGrokFlagshipId(), "grok-4.6");
    assert.equal(isGrokLineageModel("grok-4.7"), true);
    assert.equal(isGrokLineageModel("grok-imagine-image"), false);
  });
});

describe("Grok cost inherit", () => {
  it("grok-4.6 and newer use $2/$6 cache $0.50", () => {
    const expected = estimateCostUsd("xai", 1_000_000, 1_000_000, "grok-4.6");
    assert.ok(Math.abs(expected - (2 + 6)) < 1e-9);
    assert.equal(
      estimateCostUsd("xai", 1_000_000, 1_000_000, "grok-4.7"),
      expected,
    );
    assert.equal(
      grokCostRates("grok-4.6")?.cacheIn,
      0.5,
    );
  });
});

describe("version-bump is not a catalog typo", () => {
  it("splits family + version", () => {
    assert.deepEqual(splitModelFamilyVersion("grok-4.6"), {
      family: "grok",
      version: "4.6",
    });
    assert.deepEqual(splitModelFamilyVersion("x-ai/grok-4.7"), {
      family: "grok",
      version: "4.7",
    });
  });

  it("accepts grok-4.7 next to catalog grok-4.6", () => {
    assert.equal(isVersionedModelSibling("grok-4.7", "grok-4.6"), true);
    assert.equal(isAcceptableUnknownModelId("grok-4.7", "grok-4.6"), true);
    assert.equal(isAcceptableUnknownModelId("grok-4.6", "grok-4.5"), true);
    assert.equal(isAcceptableUnknownModelId("grok-5", "grok-4.6"), true);
  });

  it("still treats punctuation typos as typos", () => {
    assert.equal(isAcceptableUnknownModelId("grok-45", "grok-4.5"), false);
    assert.equal(isAcceptableUnknownModelId("grok-46", "grok-4.6"), false);
  });
});

describe("DEFAULT_CONFIG ships grok-4.6", () => {
  it("xAI default is grok-4.6 with xhigh max", () => {
    assert.equal(DEFAULT_CONFIG.model, "grok-4.6");
    assert.equal(DEFAULT_CONFIG.providers.xai.defaultModel, "grok-4.6");
    assert.ok(DEFAULT_CONFIG.providers.xai.models?.includes("grok-4.6"));
    assert.ok(DEFAULT_CONFIG.providers.xai.models?.includes("grok-4.5"));
    assert.equal(resolveReasoningEffort(DEFAULT_CONFIG.model, undefined), "xhigh");
    assert.equal(modelContextWindow(DEFAULT_CONFIG.model), 500_000);
  });
});
