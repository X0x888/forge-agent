import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createProofPokeState,
  lastUserIsProofPoke,
  noteFixUntilGreen,
  noteGreenVerification,
  noteRedVerification,
  noteUlwProofDemand,
  noteVerifyNudge,
  shouldEmitFixUntilGreen,
  shouldEmitVerifyNudge,
  PROOF_IN_FLIGHT_EDIT_GRACE,
} from "../src/harness/proof-poke.js";

describe("proof-poke: one user-channel speaker", () => {
  it("red check → one fix, zero verify-nudge", () => {
    const s = createProofPokeState();
    noteRedVerification(s, 8);
    assert.equal(shouldEmitFixUntilGreen(s, {}), true);
    noteFixUntilGreen(s);
    assert.equal(shouldEmitFixUntilGreen(s, {}), false);
    assert.equal(
      shouldEmitVerifyNudge(s, { editCount: 10 }),
      false,
    );
  });

  it("ULW proof-demand then boundary → zero extra verify-nudge", () => {
    const s = createProofPokeState();
    noteUlwProofDemand(s);
    assert.equal(
      shouldEmitVerifyNudge(s, { editCount: 20 }),
      false,
    );
    assert.equal(shouldEmitFixUntilGreen(s, {}), false);
  });

  it("last user already a proof poke → skip", () => {
    const s = createProofPokeState();
    assert.equal(
      lastUserIsProofPoke("[Forge harness — verify nudge]\nrun tests"),
      true,
    );
    assert.equal(
      lastUserIsProofPoke("[Forge harness — fix until green]\nred"),
      true,
    );
    assert.equal(
      lastUserIsProofPoke(
        "[Forge ULW cycle driver] Stop blocked — Last wave ran no successful verification — run proof NOW",
      ),
      true,
    );
    assert.equal(
      shouldEmitVerifyNudge(s, {
        lastUserContent: "[Forge harness — verify nudge]\nrun tests",
        editCount: 20,
      }),
      false,
    );
    assert.equal(
      shouldEmitFixUntilGreen(s, {
        lastUserContent: "[Forge harness — fix until green]\nred",
      }),
      false,
    );
  });

  it("proof-in-flight stays silent until green or N further edits", () => {
    const s = createProofPokeState();
    noteRedVerification(s, 8);
    assert.equal(
      shouldEmitVerifyNudge(s, { editCount: 8 }),
      false,
    );
    assert.equal(
      shouldEmitVerifyNudge(s, {
        editCount: 8 + PROOF_IN_FLIGHT_EDIT_GRACE - 1,
      }),
      false,
    );
    assert.equal(
      shouldEmitVerifyNudge(s, {
        editCount: 8 + PROOF_IN_FLIGHT_EDIT_GRACE,
      }),
      true,
    );
    noteGreenVerification(s);
    assert.equal(
      shouldEmitVerifyNudge(s, { editCount: 8 }),
      true,
    );
    noteVerifyNudge(s);
    assert.equal(
      shouldEmitVerifyNudge(s, { editCount: 99 }),
      false,
    );
  });

  it("does not treat a real user turn as a proof poke", () => {
    assert.equal(lastUserIsProofPoke("please keep going"), false);
    assert.equal(lastUserIsProofPoke("## ULW armed\nMandate: x"), false);
  });
});
