import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectPrematureHandoff,
  evaluateHandoffAtStop,
} from "../src/harness/handoff-guard.js";

describe("detectPrematureHandoff", () => {
  it("flags classic polite yields", () => {
    const cases = [
      "Done for now. Let me know if you want me to continue.",
      "Shall I continue with the tests?",
      "Want me to implement the remaining pieces?",
      "Happy to continue if you'd like.",
      "I'll stop here — ping me when ready.",
      "Ready when you are.",
      "Awaiting your go-ahead before shipping.",
    ];
    for (const msg of cases) {
      const d = detectPrematureHandoff(msg);
      assert.equal(d.handoff, true, `expected handoff: ${msg}`);
    }
  });

  it("does not flag pure Q&A closers as handoff", () => {
    const d = detectPrematureHandoff(
      "The answer is 42. Let me know if you have any questions.",
    );
    assert.equal(d.handoff, false);
    assert.equal(d.qaCloser, true);
  });

  it("does not flag goal/cycle attestations", () => {
    const d = detectPrematureHandoff(
      "**Goal achieved.**\n✅ shipped\nLet me know if you want me to continue.",
    );
    assert.equal(d.handoff, false);
  });

  it("flags incomplete mid-task closers", () => {
    const d = detectPrematureHandoff(
      "Parser is wired. Next step would be to add integration tests.",
    );
    assert.equal(d.handoff, true);
    assert.equal(d.incomplete, true);
    assert.equal(d.match, "incomplete-marker");
  });

  it("handles empty input", () => {
    assert.equal(detectPrematureHandoff("").handoff, false);
    assert.equal(detectPrematureHandoff("   ").handoff, false);
  });
});

describe("evaluateHandoffAtStop", () => {
  it("blocks under ULW for polite yield", () => {
    const r = evaluateHandoffAtStop({
      lastAssistantMessage: "Let me know if you want me to continue.",
      ultrawork: true,
      goalActive: false,
      openTodoCount: 0,
      editCount: 0,
    });
    assert.equal(r.block, true);
    assert.match(r.reanchor || "", /handoff-guard/i);
  });

  it("blocks under open todos", () => {
    const r = evaluateHandoffAtStop({
      lastAssistantMessage: "Stopping here for now.",
      ultrawork: false,
      goalActive: false,
      openTodoCount: 2,
      editCount: 0,
    });
    assert.equal(r.block, true);
  });

  it("blocks hard continue-ask without driver", () => {
    const r = evaluateHandoffAtStop({
      lastAssistantMessage: "Shall I proceed with the refactor?",
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 0,
    });
    assert.equal(r.block, true);
  });

  it("allows Q&A closer without driver", () => {
    const r = evaluateHandoffAtStop({
      lastAssistantMessage: "Hope that helps. Let me know if you have questions.",
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 0,
    });
    assert.equal(r.block, false);
  });

  it("allows incomplete advice without edits outside driver", () => {
    const r = evaluateHandoffAtStop({
      lastAssistantMessage: "Next step would be to add a cache layer.",
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 0,
    });
    assert.equal(r.block, false);
  });

  it("blocks incomplete closer after edits outside driver", () => {
    const r = evaluateHandoffAtStop({
      lastAssistantMessage: "Next step would be to add a cache layer.",
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 3,
    });
    assert.equal(r.block, true);
  });

  it("releases after handoff block cap", () => {
    const r = evaluateHandoffAtStop({
      lastAssistantMessage: "Want me to keep going?",
      ultrawork: true,
      goalActive: false,
      openTodoCount: 0,
      editCount: 1,
      handoffBlocks: 3,
      handoffBlockCap: 3,
    });
    assert.equal(r.block, false);
    assert.equal(r.released, true);
  });

  it("never blocks clean completion text", () => {
    const r = evaluateHandoffAtStop({
      lastAssistantMessage:
        "Shipped the retry path and verified with npm test (all green).",
      ultrawork: true,
      goalActive: false,
      openTodoCount: 0,
      editCount: 4,
    });
    assert.equal(r.block, false);
  });
});
