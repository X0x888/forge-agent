/**
 * /logs + forge logs — sandbox/safety event tail (Warp-inspired).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatSandboxLogTail,
  logSandboxEvent,
  readSandboxLogTail,
  sandboxLogPath,
} from "../src/agent/sandbox-log.js";
import { handleSlash, classifyLiveSlash } from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("sandbox log tail + /logs", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-logs-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("readSandboxLogTail returns newest events and skips corrupt lines", () => {
    logSandboxEvent({ type: "deny", reason: "first", command: "rm -rf /" });
    logSandboxEvent({ type: "profile", profile: "workspace", backend: "bwrap" });
    const file = sandboxLogPath();
    fs.appendFileSync(file, "not-json\n", "utf8");
    logSandboxEvent({ type: "hard_deny", reason: "force-push" });

    const all = readSandboxLogTail(10);
    assert.equal(all.length, 3);
    assert.equal(all[0].type, "deny");
    assert.equal(all[2].type, "hard_deny");
    assert.equal(readSandboxLogTail(1).length, 1);
    assert.equal(readSandboxLogTail(1)[0].type, "hard_deny");
  });

  it("formatSandboxLogTail is human-readable", () => {
    const empty = formatSandboxLogTail(5);
    assert.match(empty, /No sandbox/);
    logSandboxEvent({
      type: "fail_closed",
      reason: "no backend",
      profile: "workspace",
    });
    const text = formatSandboxLogTail(5);
    assert.match(text, /fail_closed/);
    assert.match(text, /no backend/);
    assert.match(text, /sandbox\.jsonl/);
  });

  it("/logs is live-safe and handles path/limit", async () => {
    assert.equal(classifyLiveSlash("/logs"), "readonly");
    assert.equal(classifyLiveSlash("/logs 50"), "readonly");
    logSandboxEvent({ type: "rule_deny", rule: "Bash(curl *)", command: "curl x" });
    const s = createSession({ cwd: home, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, home);
    const r = await handleSlash("/logs 10", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(r.output || "", /rule_deny|curl/);
    const p = await handleSlash("/logs path", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(p.output, sandboxLogPath());

    const over = await handleSlash("/logs 201", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(over.handled, true);
    assert.match(over.output || "", /Invalid \/logs limit|1–200/);
  });
});
