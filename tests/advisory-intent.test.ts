import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeAdvisoryUserMessage } from "../src/util/advisory-intent.js";

describe("looksLikeAdvisoryUserMessage", () => {
  it("detects questions and opinion requests", () => {
    assert.equal(looksLikeAdvisoryUserMessage("what do you think?"), true);
    assert.equal(looksLikeAdvisoryUserMessage("How does OAuth work?"), true);
    assert.equal(
      looksLikeAdvisoryUserMessage("what do you think about the landing page?"),
      true,
    );
  });

  it("rejects implement/fix language", () => {
    assert.equal(
      looksLikeAdvisoryUserMessage("please implement the fix and ship it"),
      false,
    );
    assert.equal(looksLikeAdvisoryUserMessage("fix the bug in auth"), false);
    assert.equal(
      looksLikeAdvisoryUserMessage("How do I implement OAuth in this app?"),
      false,
    );
  });

  it("rejects empty", () => {
    assert.equal(looksLikeAdvisoryUserMessage(""), false);
    assert.equal(looksLikeAdvisoryUserMessage("   "), false);
  });

  it("treats soft ULW-style prompts as work orders", () => {
    assert.equal(
      looksLikeAdvisoryUserMessage(
        "improve the reliability of the harness under ULW for expert daily use",
      ),
      false,
    );
    assert.equal(
      looksLikeAdvisoryUserMessage("/ulw make this production-ready"),
      false,
    );
  });

  it("treats should/could questions as advisory", () => {
    assert.equal(
      looksLikeAdvisoryUserMessage("should I use postgres or sqlite?"),
      true,
    );
    assert.equal(
      looksLikeAdvisoryUserMessage("How should I structure the API?"),
      true,
    );
  });
});
