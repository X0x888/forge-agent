import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeAdvisoryUserMessage,
  FileReadState,
  fileReadGuardEnabled,
  detectProjectIntel,
  evaluateProofClaimAtStop,
} from "../src/index.js";

describe("public package exports (index)", () => {
  it("exports advisory intent helper", () => {
    assert.equal(typeof looksLikeAdvisoryUserMessage, "function");
    assert.equal(looksLikeAdvisoryUserMessage("what do you think?"), true);
  });

  it("exports FileReadState + guard flag", () => {
    assert.equal(typeof FileReadState, "function");
    assert.equal(typeof fileReadGuardEnabled, "function");
    const s = new FileReadState();
    assert.ok(s);
  });

  it("still exports project intel + proof-claim", () => {
    assert.equal(typeof detectProjectIntel, "function");
    assert.equal(typeof evaluateProofClaimAtStop, "function");
  });
});
