/**
 * /improve · /ralph continuous-improve arm.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  classifyLiveSlash,
  handleSlash,
} from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { loadUlwCycle } from "../src/harness/ulw-cycle.js";

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

describe("/improve", () => {
  let prevHome = "";
  let home = "";

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    home = fs.mkdtempSync(path.join(tmpRoot(), "forge-imp-home-"));
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

  it("is live control", () => {
    assert.equal(classifyLiveSlash("/improve"), "control");
    assert.equal(classifyLiveSlash("/ralph reliability"), "control");
  });

  it("arms ULW cycle 1 with continuous-improve mandate", async () => {
    const session = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "m",
    });
    const hooks = new HookRunner(DEFAULT_CONFIG, process.cwd());
    const r = await handleSlash("/improve reliability", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: process.cwd() },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.forwardPrompt);
    assert.match(String(r.output || ""), /Continuous improve|ULW|cycle/i);
    const u = loadUlwCycle(session.meta.id);
    assert.equal(u?.cycle, 1);
    assert.match(u?.mandate || "", /reliability|steering/i);
  });
});
