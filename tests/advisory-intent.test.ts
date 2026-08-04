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

  it("recalls common mid-run Q&A / opinion phrasings without a trailing ?", () => {
    assert.equal(looksLikeAdvisoryUserMessage("Thoughts on this approach"), true);
    assert.equal(looksLikeAdvisoryUserMessage("wdyt"), true);
    assert.equal(looksLikeAdvisoryUserMessage("LMK what you think"), true);
    assert.equal(looksLikeAdvisoryUserMessage("take a look at this"), true);
    assert.equal(looksLikeAdvisoryUserMessage("review the PR"), true);
    assert.equal(looksLikeAdvisoryUserMessage("help me understand the harness"), true);
    assert.equal(looksLikeAdvisoryUserMessage("walk me through /goal"), true);
    assert.equal(looksLikeAdvisoryUserMessage("tell me about blocking Stop"), true);
    assert.equal(looksLikeAdvisoryUserMessage("pros and cons of subagents"), true);
    assert.equal(looksLikeAdvisoryUserMessage("just curious how ULW works"), true);
    assert.equal(looksLikeAdvisoryUserMessage("curious about the stop guard"), true);
    assert.equal(looksLikeAdvisoryUserMessage("opinion on this design"), true);
    assert.equal(looksLikeAdvisoryUserMessage("feedback on the PR"), true);
    assert.equal(looksLikeAdvisoryUserMessage("sanity check this"), true);
    assert.equal(looksLikeAdvisoryUserMessage("am I missing something"), true);
    assert.equal(looksLikeAdvisoryUserMessage("remind me how /goal works"), true);
    assert.equal(looksLikeAdvisoryUserMessage("recap the harness"), true);
    assert.equal(looksLikeAdvisoryUserMessage("clarify the cycle flag"), true);
    assert.equal(looksLikeAdvisoryUserMessage("TL;DR of ULW"), true);
    assert.equal(looksLikeAdvisoryUserMessage("ELI5 the goal protocol"), true);
    assert.equal(looksLikeAdvisoryUserMessage("in plain english what does TodoGate do"), true);
    assert.equal(looksLikeAdvisoryUserMessage("second opinion on the approach"), true);
    assert.equal(looksLikeAdvisoryUserMessage("gut check"), true);
    assert.equal(looksLikeAdvisoryUserMessage("tradeoffs"), true);
    assert.equal(looksLikeAdvisoryUserMessage("trade-offs of this design"), true);
    assert.equal(looksLikeAdvisoryUserMessage("downsides"), true);
    assert.equal(looksLikeAdvisoryUserMessage("concerns with this approach"), true);
    assert.equal(looksLikeAdvisoryUserMessage("give me the gist"), true);
    assert.equal(looksLikeAdvisoryUserMessage("gist of the change"), true);
    assert.equal(looksLikeAdvisoryUserMessage("high level overview"), true);
  });

  it("keeps explicit edit/change work orders non-advisory", () => {
    assert.equal(
      looksLikeAdvisoryUserMessage("please change the timeout"),
      false,
    );
    assert.equal(
      looksLikeAdvisoryUserMessage("go ahead and patch the file"),
      false,
    );
    assert.equal(
      looksLikeAdvisoryUserMessage("review the PR and fix the bugs"),
      false,
    );
  });
});
