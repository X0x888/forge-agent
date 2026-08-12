import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  suggestName,
  suggestSessionAction,
  isAcceptableUnknownModelId,
} from "../src/util/suggest.js";

describe("suggestName", () => {
  it("matches punctuation-insensitive model ids", () => {
    assert.equal(
      suggestName("grok-45", ["grok-4.5", "grok-4", "grok-3"], {
        minLength: 3,
        minScore: 38,
        requirePrefix3: false,
      }),
      "grok-4.5",
    );
  });

  it("suggests provider and session action typos", () => {
    assert.equal(
      suggestName("xaai", ["xai", "anthropic", "openai"], {
        minLength: 2,
        minScore: 36,
        requirePrefix3: false,
      }),
      "xai",
    );
    assert.equal(suggestSessionAction("prun"), "prune");
    assert.equal(suggestSessionAction("serach"), "search");
    assert.equal(suggestSessionAction("foo"), null);
    assert.equal(suggestSessionAction("incident"), null);
  });

  it("does not treat a Grok version bump as a punctuation typo", () => {
    assert.equal(isAcceptableUnknownModelId("grok-4.7", "grok-4.6"), true);
    assert.equal(isAcceptableUnknownModelId("grok-45", "grok-4.5"), false);
  });

  it("does not false-positive short unrelated tokens", () => {
    assert.equal(
      suggestName("hi", ["help", "hooks", "hud"], {
        minLength: 4,
        minScore: 38,
      }),
      null,
    );
  });

  it("tie-breaks equal scores by lower edit distance (writs→writes not edits)", () => {
    assert.equal(
      suggestName(
        "writs",
        ["writes", "mutations", "edits", "all", "reads"],
        { minLength: 2, minScore: 36, requirePrefix3: false },
      ),
      "writes",
    );
  });
});
