/**
 * Headless forge run "/plan" · custom commands resolution.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveHeadlessSlashPrompt,
  stripAnsi,
} from "../src/commands/headless-slash.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("resolveHeadlessSlashPrompt", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hsl-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(process.env.FORGE_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("passthrough for normal prompts", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await resolveHeadlessSlashPrompt({
      prompt: "fix the flaky test",
      session,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.kind, "passthrough");
    if (r.kind === "passthrough") {
      assert.equal(r.prompt, "fix the flaky test");
    }
  });

  it("/plan is done without model call and sets plan mode", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "acceptEdits" as const,
    };
    const r = await resolveHeadlessSlashPrompt({
      prompt: "/plan design the migration",
      session,
      config: cfg,
      hooks,
    });
    assert.equal(r.kind, "done");
    assert.equal(cfg.permissionMode, "plan");
    if (r.kind === "done") {
      assert.equal(r.command, "/plan");
      assert.match(stripAnsi(r.output), /PLAN/i);
    }
  });

  it("custom command expands to prompt", async () => {
    const ws = path.join(tmp, "proj");
    fs.mkdirSync(path.join(ws, ".forge", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".forge", "commands", "ship.md"),
      "Ship $ARGUMENTS with tests\n",
    );
    const session = createSession({ cwd: ws, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, ws);
    const r = await resolveHeadlessSlashPrompt({
      prompt: "/ship auth module",
      session,
      config: { ...DEFAULT_CONFIG, workspace: ws },
      hooks,
    });
    assert.equal(r.kind, "prompt");
    if (r.kind === "prompt") {
      assert.equal(r.prompt, "Ship auth module with tests");
    }
  });

  it("stripAnsi removes color codes", () => {
    assert.equal(stripAnsi("\x1b[34mPLAN\x1b[0m"), "PLAN");
  });
});
