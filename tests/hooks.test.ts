import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HookRunner } from "../src/harness/hooks.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("hooks", () => {
  it("loads project hooks and blocks Stop on exit 2", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hooks-"));
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, ".forge", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "home", "hooks"), { recursive: true });

    // Stop hook that always blocks
    fs.writeFileSync(
      path.join(tmp, ".forge", "hooks", "stop.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "node -e \"console.log(JSON.stringify({decision:'block',reason:'not done yet'})); process.exit(2)\"",
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    // PreToolUse deny rm
    fs.writeFileSync(
      path.join(tmp, ".forge", "hooks", "pre.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [
                {
                  type: "command",
                  command:
                    "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const c=(j.toolInput&&j.toolInput.command)||'';if(/rm -rf/.test(c)){console.log(JSON.stringify({decision:'deny',reason:'no rm'}));process.exit(2)}console.log(JSON.stringify({decision:'allow'}))})\"",
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const runner = new HookRunner(config, tmp);

    const stop = await runner.run("Stop", {
      sessionId: "s1",
      cwd: tmp,
      workspaceRoot: tmp,
      lastAssistantMessage: "done?",
    });
    assert.equal(stop.blocked, true);
    assert.match(stop.reason || "", /not done/i);

    const preDeny = await runner.run("PreToolUse", {
      sessionId: "s1",
      cwd: tmp,
      workspaceRoot: tmp,
      toolName: "bash",
      toolInput: { command: "rm -rf /tmp/foo" },
    });
    assert.equal(preDeny.decision, "deny");

    const preAllow = await runner.run("PreToolUse", {
      sessionId: "s1",
      cwd: tmp,
      workspaceRoot: tmp,
      toolName: "bash",
      toolInput: { command: "echo hi" },
    });
    assert.equal(preAllow.blocked, false);
  });

  it("Stop hook timeout fails closed when blockingStopHooks is on", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hooks-to-"));
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, ".forge", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "home", "hooks"), { recursive: true });

    // Sleep longer than hook timeout — must block, not release
    fs.writeFileSync(
      path.join(tmp, ".forge", "hooks", "stop.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "sleep 5",
                  timeout: 1,
                },
              ],
            },
          ],
        },
      }),
    );

    // Isolate from host ~/.claude / ~/.cursor Stop hooks (compat defaults on).
    // Without this, a real Claude Stop hook can overwrite the timeout reason.
    const cfg = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
      workspace: tmp,
    };
    const runner = new HookRunner(cfg, tmp);
    const r = await runner.run("Stop", {
      sessionId: "s1",
      cwd: tmp,
      workspaceRoot: tmp,
    });
    assert.equal(r.blocked, true);
    assert.equal(r.decision, "block");
    assert.match(String(r.reason || ""), /timed out|fail-closed/i);

    // With blocking Stop off, timeout fails open
    const open = new HookRunner(
      { ...cfg, blockingStopHooks: false },
      tmp,
    );
    const r2 = await open.run("Stop", {
      sessionId: "s1",
      cwd: tmp,
      workspaceRoot: tmp,
    });
    assert.equal(r2.blocked, false);
    assert.equal(r2.decision, "allow");
  });

});
