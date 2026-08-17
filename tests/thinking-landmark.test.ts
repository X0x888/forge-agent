import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateReasoningTokens,
  formatThinkingTurnOpen,
  createThinkingLandmark,
  thinkingLandmarkKey,
} from "../src/tui/turn-summary.js";
import { notifyStreamDelta } from "../src/agent/loop.js";
import { visibleWidth } from "../src/util/format.js";

describe("thinking landmark (first-token wait)", () => {
  it("estimates tokens from chars without keeping thought text", () => {
    assert.equal(estimateReasoningTokens(0), 0);
    assert.equal(estimateReasoningTokens(1), 1);
    assert.equal(estimateReasoningTokens(4), 1);
    assert.equal(estimateReasoningTokens(4800), 1200);
  });

  it("formatThinkingTurnOpen is silent until chars arrive", () => {
    assert.equal(formatThinkingTurnOpen({ chars: 0 }), null);
    assert.equal(formatThinkingTurnOpen({ chars: -1 }), null);
  });

  it("formatThinkingTurnOpen is count-only — never paints thought text", () => {
    const secret = "SECRET_THOUGHT_SHOULD_NOT_LEAK";
    const line = formatThinkingTurnOpen({
      chars: secret.length,
      elapsedSec: 18,
      color: false,
      width: 80,
    });
    assert.ok(line);
    assert.match(line, /^think › /);
    assert.match(line, / · 18s$/);
    assert.doesNotMatch(line, /SECRET_THOUGHT/);
    assert.doesNotMatch(line, /SHOULD_NOT_LEAK/);
  });

  it("formatThinkingTurnOpen clips to width and omits 0s elapsed", () => {
    const line = formatThinkingTurnOpen({
      chars: 40,
      elapsedSec: 0,
      color: false,
      width: 12,
    });
    assert.ok(line);
    assert.ok(visibleWidth(line) <= 12);
    assert.doesNotMatch(line!, / · 0s/);
  });

  it("thinkingLandmarkKey changes on token bucket or elapsed second", () => {
    assert.equal(thinkingLandmarkKey(4, 1), thinkingLandmarkKey(5, 1));
    assert.notEqual(thinkingLandmarkKey(4, 1), thinkingLandmarkKey(4, 2));
    assert.notEqual(thinkingLandmarkKey(4, 1), thinkingLandmarkKey(4000, 1));
  });

  it("TTY painter updates in place and never writes thought text", () => {
    const writes: string[] = [];
    const think = createThinkingLandmark({
      write: (s) => writes.push(s),
      tty: true,
      columns: () => 80,
      now: () => 1_000,
      color: false,
    });
    think.push(0);
    assert.equal(writes.length, 0);
    think.push(8);
    assert.ok(writes.some((w) => w.includes("think ›")));
    assert.ok(writes.every((w) => !/thought|secret/i.test(w)));
    const before = writes.length;
    think.push(1); // same token bucket (2), same second — no repaint
    assert.equal(writes.length, before);
    const taken = think.takeForReply("forge ›");
    assert.equal(taken, true);
    assert.match(writes.at(-1)!, /forge ›/);
    assert.equal(think.takeForReply("forge ›"), false);
  });

  it("non-TTY painter prints think › once then leaves it in the log", () => {
    const writes: string[] = [];
    const think = createThinkingLandmark({
      write: (s) => writes.push(s),
      tty: false,
      columns: () => 80,
      now: () => 1_000,
      color: false,
    });
    think.push(400);
    think.push(400);
    think.push(8000);
    const bodies = writes.join("");
    assert.equal([...bodies.matchAll(/think ›/g)].length, 1);
    assert.match(bodies, /\n$/);
    think.settle();
    assert.equal(think.takeForReply("forge ›"), false);
    assert.equal([...writes.join("").matchAll(/think ›/g)].length, 1);
  });

  it("settle resets so the next think burst starts a fresh count", () => {
    const writes: string[] = [];
    const think = createThinkingLandmark({
      write: (s) => writes.push(s),
      tty: true,
      columns: () => 80,
      now: () => 1_000,
      color: false,
    });
    think.push(8000);
    think.settle();
    writes.length = 0;
    think.push(8);
    assert.equal(think.chars(), 8);
    assert.match(writes.join(""), /think › 2\b/);
    assert.doesNotMatch(writes.join(""), /2\.0k|2k/);
  });

  it("settle keeps the think line in scrollback when tools start first", () => {
    const writes: string[] = [];
    const think = createThinkingLandmark({
      write: (s) => writes.push(s),
      tty: true,
      columns: () => 80,
      now: () => 1_000,
      color: false,
    });
    think.push(80);
    think.settle();
    assert.ok(writes.at(-1)?.endsWith("\n"));
    assert.equal(think.takeForReply("forge ›"), false);
  });
});

describe("notifyStreamDelta", () => {
  it("forwards reasoning as a char count and content as tokens — never the thought", () => {
    const thoughts: Array<{ chars: number }> = [];
    const tokens: string[] = [];
    notifyStreamDelta(
      { reasoning_content: "hidden chain of thought", content: "hi" },
      {
        onReasoning: (p) => thoughts.push(p),
        onToken: (t) => tokens.push(t),
      },
    );
    assert.deepEqual(thoughts, [{ chars: "hidden chain of thought".length }]);
    assert.deepEqual(tokens, ["hi"]);
    assert.ok(
      !JSON.stringify(thoughts).includes("hidden"),
      "event payload must not carry thought text",
    );
  });

  it("ignores empty reasoning and respects abort", () => {
    const thoughts: Array<{ chars: number }> = [];
    notifyStreamDelta(
      { reasoning_content: "", content: "x" },
      { onReasoning: (p) => thoughts.push(p), onToken: () => {} },
    );
    assert.deepEqual(thoughts, []);
    const ac = new AbortController();
    ac.abort();
    notifyStreamDelta(
      { reasoning_content: "nope", content: "nope" },
      { onReasoning: (p) => thoughts.push(p), onToken: () => {} },
      ac.signal,
    );
    assert.deepEqual(thoughts, []);
  });
});
