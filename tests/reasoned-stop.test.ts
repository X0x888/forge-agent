import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isReasonedEmptyStop,
  REASONING_WALL_FINISH,
  formatThoughtOnlyRecoverPoke,
  THOUGHT_ONLY_OBSERVE_POKE,
} from "../src/agent/reasoned-stop.js";

describe("isReasonedEmptyStop", () => {
  it("treats thought + stop + no tools as Stop, not an empty glitch", () => {
    assert.equal(
      isReasonedEmptyStop({
        text: "",
        toolCallCount: 0,
        reasoningContent: "I MUST pick a DIFFERENT surface. ".repeat(80),
        finishReason: "stop",
      }),
      true,
    );
  });

  it("treats a reasoning-wall finish as Stop", () => {
    assert.equal(
      isReasonedEmptyStop({
        text: "",
        toolCallCount: 0,
        reasoningContent: "",
        finishReason: REASONING_WALL_FINISH,
      }),
      true,
    );
  });

  it("does not steal true empty glitches (no thought)", () => {
    assert.equal(
      isReasonedEmptyStop({
        text: "",
        toolCallCount: 0,
        reasoningContent: "",
        finishReason: "stop",
      }),
      false,
    );
  });

  it("does not steal length / content_filter / tools / text", () => {
    const thought = "hidden chain of thought";
    assert.equal(
      isReasonedEmptyStop({
        text: "",
        toolCallCount: 0,
        reasoningContent: thought,
        finishReason: "length",
      }),
      false,
    );
    assert.equal(
      isReasonedEmptyStop({
        text: "",
        toolCallCount: 0,
        reasoningContent: thought,
        finishReason: "content_filter",
      }),
      false,
    );
    assert.equal(
      isReasonedEmptyStop({
        text: "",
        toolCallCount: 1,
        reasoningContent: thought,
        finishReason: "stop",
      }),
      false,
    );
    assert.equal(
      isReasonedEmptyStop({
        text: "Wave shipped.",
        toolCallCount: 0,
        reasoningContent: thought,
        finishReason: "stop",
      }),
      false,
    );
  });

  it("thought-only recover poke never reprints Wave 1", () => {
    const once = formatThoughtOnlyRecoverPoke(1);
    assert.match(once, /MUST be a tool call/);
    assert.match(once, /Do not reprint Wave 1/);
    assert.ok(once.includes(THOUGHT_ONLY_OBSERVE_POKE));
    assert.doesNotMatch(once, /Wave 1 reading:/);
    const later = formatThoughtOnlyRecoverPoke(3);
    assert.match(later, /git diff --stat/);
    const look = formatThoughtOnlyRecoverPoke(3, { forceLook: true });
    assert.match(look, /spawn_subagent type=explore/);
    assert.doesNotMatch(look, /Wave 1 reading:/);
  });
});
