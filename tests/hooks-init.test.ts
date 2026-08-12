/**
 * /hooks init scaffold + list/reload.
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

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

describe("/hooks init", () => {
  let prevHome = "";
  let home = "";
  let ws = "";

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    home = fs.mkdtempSync(path.join(tmpRoot(), "forge-hooks-home-"));
    process.env.FORGE_HOME = home;
    // Nested under fake home so git walk-up stays local (empty .git dir).
    ws = fs.mkdtempSync(path.join(home, "ws-"));
    fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  });

  after(() => {
    if (prevHome) process.env.FORGE_HOME = prevHome;
    else delete process.env.FORGE_HOME;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* */
    }
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("classifies list as readonly and init as control", () => {
    assert.equal(classifyLiveSlash("/hooks"), "readonly");
    assert.equal(classifyLiveSlash("/hooks list"), "readonly");
    assert.equal(classifyLiveSlash("/hooks init"), "control");
    assert.equal(classifyLiveSlash("/hooks reload"), "control");
  });

  it("scaffolds example-stop.json and reloads", async () => {
    const session = createSession({ cwd: ws, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, ws);
    const r = await handleSlash("/hooks init", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: ws },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Wrote|Already exists/);
    const target = path.join(ws, ".forge", "hooks", "example-stop.json");
    assert.ok(fs.existsSync(target), "scaffold file should exist");
    const body = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.ok(body.hooks?.Stop);

    const list = await handleSlash("/hooks", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: ws },
      hooks,
    });
    assert.match(String(list.output || ""), /Stop|hooks init|Loaded hooks|matcher/i);

    const reload = await handleSlash("/hooks reload", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: ws },
      hooks,
    });
    assert.match(String(reload.output || ""), /Reload/i);
  });
});
