import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  withStdinLease,
  setStdinLeaseHolder,
  resetStdinLeaseForTests,
  stdinLeaseHeld,
} from "../src/tui/stdin-lease.js";
import { createPromptEditor } from "../src/tui/prompt-editor.js";

describe("stdin lease", () => {
  beforeEach(() => {
    resetStdinLeaseForTests();
  });

  it("suspends the holder for the duration of the callback", async () => {
    const events: string[] = [];
    setStdinLeaseHolder({
      suspend: () => events.push("suspend"),
      resume: () => events.push("resume"),
    });
    assert.equal(stdinLeaseHeld(), false);
    const out = await withStdinLease(async () => {
      events.push("inside");
      assert.equal(stdinLeaseHeld(), true);
      return 7;
    });
    assert.equal(out, 7);
    assert.deepEqual(events, ["suspend", "inside", "resume"]);
    assert.equal(stdinLeaseHeld(), false);
  });

  it("nests: only outermost lease resumes", async () => {
    let depth = 0;
    let suspends = 0;
    let resumes = 0;
    setStdinLeaseHolder({
      suspend: () => {
        suspends += 1;
        depth += 1;
      },
      resume: () => {
        resumes += 1;
        depth -= 1;
      },
    });
    await withStdinLease(async () => {
      assert.equal(suspends, 1);
      await withStdinLease(async () => {
        assert.equal(suspends, 1);
        assert.equal(resumes, 0);
        assert.equal(stdinLeaseHeld(), true);
      });
      assert.equal(resumes, 0);
      assert.equal(stdinLeaseHeld(), true);
    });
    assert.equal(suspends, 1);
    assert.equal(resumes, 1);
    assert.equal(depth, 0);
    assert.equal(stdinLeaseHeld(), false);
  });

  it("resumes after a thrown callback", async () => {
    let resumes = 0;
    setStdinLeaseHolder({
      suspend: () => {},
      resume: () => {
        resumes += 1;
      },
    });
    await assert.rejects(
      withStdinLease(async () => {
        throw new Error("ask failed");
      }),
      /ask failed/,
    );
    assert.equal(resumes, 1);
    assert.equal(stdinLeaseHeld(), false);
  });

  it("is a no-op when no holder is registered", async () => {
    const v = await withStdinLease(async () => "ok");
    assert.equal(v, "ok");
    assert.equal(stdinLeaseHeld(), false);
  });
});

describe("prompt-editor suspend/resume", () => {
  it("classic fallback ignores prompt() while suspended and keeps the buffer", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ed = createPromptEditor({
      input,
      output,
      forceReadline: true,
    });
    ed.setLine("draft y");
    assert.equal(ed.getLine(), "draft y");
    assert.equal(ed.isSuspended(), false);
    ed.suspend();
    assert.equal(ed.isSuspended(), true);
    ed.prompt(); // must not throw / must not unsuspend
    assert.equal(ed.isSuspended(), true);
    assert.equal(ed.getLine(), "draft y");
    ed.resume();
    assert.equal(ed.isSuspended(), false);
    assert.equal(ed.getLine(), "draft y");
    ed.close();
  });
});

describe("REPL dock vs stdin lease", () => {
  it("pauses the sticky dock while a nested prompt holds stdin", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/tui/repl.ts"),
      "utf8",
    );
    assert.match(src, /bottomDock\.pause\(\)/);
    assert.match(src, /bottomDock\.resume\(\)/);
    assert.match(
      src,
      /setStdinLeaseHolder\(\{[\s\S]*bottomDock\.pause\(\)[\s\S]*rl\.suspend\(\)[\s\S]*rl\.resume\(\)[\s\S]*bottomDock\.resume\(\)/,
    );
  });
});
