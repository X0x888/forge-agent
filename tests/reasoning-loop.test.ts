import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isReasoningMantra,
  REASONING_MANTRA_MIN_CHARS,
  shouldScanReasoningMantra,
} from "../src/agent/reasoning-loop.js";
import {
  isReasonedEmptyStop,
  REASONING_LOOP_FINISH,
} from "../src/agent/reasoned-stop.js";

function uniqueThought(chars: number): string {
  const parts: string[] = [];
  let n = 0;
  while (n < chars) {
    const chunk = `step ${parts.length} inspect src/file-${parts.length}.ts claim-${parts.length} `;
    parts.push(chunk);
    n += chunk.length;
  }
  return parts.join("").slice(0, chars);
}

describe("isReasoningMantra", () => {
  it("ignores short and unique long thought (working-wave shape)", () => {
    assert.equal(isReasoningMantra("I MUST pick a DIFFERENT surface. "), false);
    assert.equal(isReasoningMantra(uniqueThought(2496)), false);
    assert.equal(isReasoningMantra(uniqueThought(4000)), false);
    assert.equal(isReasoningMantra(uniqueThought(REASONING_MANTRA_MIN_CHARS)), false);
  });

  it("trips on the maze closer-mantra, not after a few repeats", () => {
    const prefix = uniqueThought(REASONING_MANTRA_MIN_CHARS);
    const closer =
      "The fix is in place and verified.\n\n**Proof:** test passed.\n\nReady for the next different surface. ";
    assert.equal(isReasoningMantra(prefix + closer.repeat(3)), false);
    assert.equal(isReasoningMantra(prefix + closer.repeat(12)), true);
  });

  it("throttles live scans until 3k and then every 256 chars", () => {
    assert.equal(shouldScanReasoningMantra(2999, 0), false);
    assert.equal(shouldScanReasoningMantra(3000, 0), true);
    assert.equal(shouldScanReasoningMantra(3100, 3000), false);
    assert.equal(shouldScanReasoningMantra(3260, 3000), true);
  });
});

describe("isReasonedEmptyStop reasoning_loop", () => {
  it("treats a mantra-loop finish as Stop", () => {
    assert.equal(
      isReasonedEmptyStop({
        text: "",
        toolCallCount: 0,
        reasoningContent: "",
        finishReason: REASONING_LOOP_FINISH,
      }),
      true,
    );
  });
});
