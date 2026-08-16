import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatBangOutput,
  parseBangCommand,
  runBangShell,
} from "../src/tui/bang-shell.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import chalk from "chalk";

describe("bang-shell", () => {
  it("parses !command and ignores non-bang", () => {
    assert.equal(parseBangCommand("!git status"), "git status");
    assert.equal(parseBangCommand("!"), "");
    assert.equal(parseBangCommand("git status"), null);
    assert.equal(parseBangCommand("/help"), null);
  });

  it("runs a read-only command and appends to the session", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bang-"));
    process.env.FORGE_HOME = tmp;
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "default" as const,
    };
    const r = await runBangShell({
      line: "!echo bang-ok",
      config,
      session,
      permissions: new PermissionGate({ interactive: false }),
    });
    assert.equal(r.handled, true);
    assert.match(r.output, /bang-ok/);
    const last = session.messages.at(-1);
    assert.equal(last?.role, "user");
    assert.match(String(last?.content), /bang-shell/);
    assert.match(String(last?.content), /bang-ok/);
  });

  it("forwards onProgress last-lines from the bang command", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bang-"));
    process.env.FORGE_HOME = tmp;
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const seen: string[] = [];
    const r = await runBangShell({
      line: "!printf 'bang-one\\nbang-two\\n'",
      config: { ...DEFAULT_CONFIG, workspace: tmp, permissionMode: "default" },
      session,
      permissions: new PermissionGate({ interactive: false }),
      persist: false,
      onProgress: (line) => seen.push(line),
    });
    assert.equal(r.handled, true);
    assert.ok(seen.some((l) => /bang-/.test(l)), `progress=${JSON.stringify(seen)}`);
  });

  it("denies mutating bash in plan mode", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bang-"));
    process.env.FORGE_HOME = tmp;
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "plan" as const,
    };
    const r = await runBangShell({
      line: "!rm -rf /tmp/nope",
      config,
      session,
      permissions: new PermissionGate({ interactive: false }),
    });
    assert.equal(r.handled, true);
    assert.match(r.output, /denied/i);
  });

  it("empty bang prints usage", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bang-"));
    process.env.FORGE_HOME = tmp;
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const r = await runBangShell({
      line: "!",
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      session,
      permissions: new PermissionGate({ interactive: false }),
    });
    assert.equal(r.handled, true);
    assert.match(r.output, /Usage/);
  });

  it("stamps last-verify when the bang command is a successful project check", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bang-"));
    process.env.FORGE_HOME = tmp;
    fs.writeFileSync(path.join(tmp, "Makefile"), "test:\n\ttrue\n");
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const r = await runBangShell({
      line: "!make test",
      config: {
        ...DEFAULT_CONFIG,
        workspace: tmp,
        permissionMode: "default",
      },
      session,
      permissions: new PermissionGate({ interactive: false }),
    });
    assert.equal(r.handled, true);
    assert.doesNotMatch(r.output, /denied/i);
    assert.equal(session.meta.lastVerificationCommand, "make test");
    assert.ok(session.meta.lastVerificationAt);
  });

  it("still hard-denies IMDS even when user-initiated", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bang-"));
    process.env.FORGE_HOME = tmp;
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const r = await runBangShell({
      line: "!curl http://169.254.169.254/latest/meta-data/",
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      session,
      permissions: new PermissionGate({ interactive: false }),
    });
    assert.equal(r.handled, true);
    assert.match(r.output, /denied/i);
  });

  it("paints failed bang-shell red instead of cyan", () => {
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      const ok = formatBangOutput("! echo ok\nbang-ok");
      const fail = formatBangOutput("! denied: plan mode", true);
      assert.match(ok, /\u001b\[36m/);
      assert.doesNotMatch(ok, /\u001b\[31m/);
      assert.match(fail, /\u001b\[31m/);
      assert.doesNotMatch(fail, /\u001b\[36m/);
    } finally {
      chalk.level = prevLevel;
    }
  });
});
