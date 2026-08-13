import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDockFallbackHop } from "../src/tui/bottom-status.js";

describe("formatDockFallbackHop", () => {
  it("renders a compact from→to hop", () => {
    assert.equal(
      formatDockFallbackHop({ from: "grok-4.6", to: "grok-4.5" }),
      "fb:grok-4.6→grok-4.5",
    );
  });

  it("omits missing or same-model hops", () => {
    assert.equal(formatDockFallbackHop(undefined), undefined);
    assert.equal(
      formatDockFallbackHop({ from: "grok-4.6", to: "grok-4.6" }),
      undefined,
    );
  });
});
