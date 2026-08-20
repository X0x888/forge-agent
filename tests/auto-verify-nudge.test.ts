import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { midLoopVerifyNudge } from "../src/util/project-intel.js";

describe("midLoopVerifyNudge", () => {
  it("stays silent below edit threshold", () => {
    const prev = process.env.FORGE_AUTO_VERIFY_NUDGE;
    delete process.env.FORGE_AUTO_VERIFY_NUDGE;
    try {
      assert.equal(
        midLoopVerifyNudge({ editCount: 1, lastEditAt: new Date().toISOString() }, process.cwd()),
        "",
      );
    } finally {
      if (prev !== undefined) process.env.FORGE_AUTO_VERIFY_NUDGE = prev;
    }
  });

  it("fires after edit streak without verification", () => {
    const prev = process.env.FORGE_AUTO_VERIFY_NUDGE;
    const prevT = process.env.FORGE_AUTO_VERIFY_EDIT_THRESHOLD;
    process.env.FORGE_AUTO_VERIFY_NUDGE = "1";
    process.env.FORGE_AUTO_VERIFY_EDIT_THRESHOLD = "2";
    try {
      const msg = midLoopVerifyNudge(
        {
          editCount: 5,
          lastEditAt: new Date().toISOString(),
          lastVerificationAt: null,
        },
        process.cwd(),
      );
      assert.match(msg, /verify nudge/i);
      assert.match(msg, /without a fresh green verification/i);
      assert.match(msg, /\/verify/);
      assert.match(msg, /Do not ask the user/i);
    } finally {
      if (prev !== undefined) process.env.FORGE_AUTO_VERIFY_NUDGE = prev;
      else delete process.env.FORGE_AUTO_VERIFY_NUDGE;
      if (prevT !== undefined) process.env.FORGE_AUTO_VERIFY_EDIT_THRESHOLD = prevT;
      else delete process.env.FORGE_AUTO_VERIFY_EDIT_THRESHOLD;
    }
  });

  it("stays silent after fresh green verification", () => {
    const now = Date.now();
    const msg = midLoopVerifyNudge(
      {
        editCount: 10,
        lastEditAt: new Date(now - 5_000).toISOString(),
        lastVerificationAt: new Date(now).toISOString(),
        lastVerificationExitCode: 0,
        lastVerificationCommand: "npm test",
      },
      process.cwd(),
    );
    assert.equal(msg, "");
  });

  it("respects FORGE_AUTO_VERIFY_NUDGE=0", () => {
    const prev = process.env.FORGE_AUTO_VERIFY_NUDGE;
    process.env.FORGE_AUTO_VERIFY_NUDGE = "0";
    try {
      assert.equal(
        midLoopVerifyNudge(
          {
            editCount: 99,
            lastEditAt: new Date().toISOString(),
          },
          process.cwd(),
        ),
        "",
      );
    } finally {
      if (prev !== undefined) process.env.FORGE_AUTO_VERIFY_NUDGE = prev;
      else delete process.env.FORGE_AUTO_VERIFY_NUDGE;
    }
  });
});

describe("fix-until-green synthetic marker", () => {
  it("isSyntheticUserMessage recognizes fix-until-green", async () => {
    const { isSyntheticUserMessage } = await import("../src/session/session.js");
    assert.equal(
      isSyntheticUserMessage({
        role: "user",
        content: "[Forge harness — fix until green]\nVerification failed",
      }),
      true,
    );
  });
});
