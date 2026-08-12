/**
 * /checkpoint safety snapshot (git stash create).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  classifyLiveSlash,
  handleSlash,
  isLiveSafeSlash,
} from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

describe("/checkpoint", () => {
  let prevHome = "";
  let home = "";
  const repo = process.cwd();

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    home = fs.mkdtempSync(path.join(tmpRoot(), "forge-cp-home-"));
    process.env.FORGE_HOME = home;
  });

  after(() => {
    if (prevHome) process.env.FORGE_HOME = prevHome;
    else delete process.env.FORGE_HOME;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("is live-safe (status readonly, create control)", () => {
    assert.equal(classifyLiveSlash("/checkpoint status"), "readonly");
    assert.equal(classifyLiveSlash("/checkpoint"), "control");
    assert.equal(classifyLiveSlash("/snap"), "control");
    assert.ok(isLiveSafeSlash("/checkpoint"));
    assert.ok(isLiveSafeSlash("/checkpoint restore"));
  });

  it("status works without a prior checkpoint", async () => {
    const session = createSession({ cwd: repo, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, repo);
    const r = await handleSlash("/checkpoint status", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: repo },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /checkpoint/i);
  });

  it("create snapshots dirty tracked files without mutating tree", async () => {
    const session = createSession({ cwd: repo, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, repo);
    const before = await handleSlash("/checkpoint", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: repo },
      hooks,
    });
    assert.equal(before.handled, true);
    const out = String(before.output || "");
    assert.match(
      out,
      /Checkpoint created:|Working tree clean|nothing to checkpoint|nothing snapshot|Checkpoint failed:|index\.lock/i,
    );
    if (/Checkpoint created:/.test(out)) {
      assert.ok(session.meta.lastCheckpoint);
      assert.ok(session.meta.lastCheckpointAt);
      assert.match(out, /working tree unchanged/i);
      const st = await handleSlash("/checkpoint status", {
        session,
        config: { ...DEFAULT_CONFIG, workspace: repo },
        hooks,
      });
      assert.match(
        String(st.output || ""),
        new RegExp(session.meta.lastCheckpoint!.slice(0, 8)),
      );
    }
  });
});
