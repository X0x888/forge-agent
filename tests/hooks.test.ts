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

  it("survives a hooks dir that is a regular file (no startup crash)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hooks-bad-"));
    process.env.FORGE_HOME = path.join(tmp, "home");
    // Both hooks dirs exist but are regular files, not directories —
    // readdirSync would throw ENOTDIR through reload() → constructor.
    fs.mkdirSync(path.join(tmp, ".forge"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".forge", "hooks"), "not a dir");
    fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "home", "hooks"), "not a dir");

    const cfg = {
      ...DEFAULT_CONFIG,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const runner = new HookRunner(cfg, tmp);
    assert.deepEqual(runner.list(), {});
  });

  it("caps toolInput and prompt in the hook stdin payload", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hooks-cap-"));
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, ".forge", "hooks"), { recursive: true });

    // Echo back the received field sizes so the test can assert the caps.
    fs.writeFileSync(
      path.join(tmp, ".forge", "hooks", "pre.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const p=(j.prompt||'').length;const i=typeof j.toolInput==='string'?j.toolInput.length:JSON.stringify(j.toolInput||{}).length;console.log(JSON.stringify({decision:'deny',reason:'P='+p+' I='+i}))})\"",
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    const cfg = {
      ...DEFAULT_CONFIG,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const runner = new HookRunner(cfg, tmp);
    const big = "x".repeat(100 * 1024);
    const r = await runner.run("PreToolUse", {
      sessionId: "s1",
      cwd: tmp,
      workspaceRoot: tmp,
      toolName: "write_file",
      toolInput: { path: "big.txt", content: big },
      prompt: big,
    });
    assert.equal(r.decision, "deny");
    const m = String(r.reason || "").match(/P=(\d+) I=(\d+)/);
    assert.ok(m, `expected sizes in reason, got: ${r.reason}`);
    // 20k cap + short truncation note — well under the 100KB inputs.
    assert.ok(Number(m[1]) <= 20_100, `prompt not capped: ${m[1]}`);
    assert.ok(Number(m[2]) <= 20_100, `toolInput not capped: ${m[2]}`);
  });

  it("caps hook stdout/stderr accumulation without blocking the child", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hooks-ocap-"));
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, ".forge", "hooks"), { recursive: true });

    // 512KB stderr (way past the OS pipe buffer — the run wedges if we stop
    // draining) and no stdout verdict, so stderr surfaces as systemMessage.
    fs.writeFileSync(
      path.join(tmp, ".forge", "hooks", "pre.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "node -e \"process.stderr.write('x'.repeat(512*1024))\"",
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    const cfg = {
      ...DEFAULT_CONFIG,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const runner = new HookRunner(cfg, tmp);
    const r = await runner.run("PreToolUse", {
      sessionId: "s1",
      cwd: tmp,
      workspaceRoot: tmp,
      toolName: "bash",
      toolInput: { command: "echo hi" },
    });
    assert.equal(r.decision, "allow");
    // stderr made it through but truncated to the 64KB head cap.
    assert.equal((r.systemMessage || "").length, 64 * 1024);
  });

  it(
    "timeout kills the whole process group and escalates TERM→KILL",
    { skip: process.platform === "win32" },
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hooks-kill-"));
      process.env.FORGE_HOME = path.join(tmp, "home");
      fs.mkdirSync(path.join(tmp, ".forge", "hooks"), { recursive: true });

      // Hook ignores SIGTERM and spawns a `sleep` grandchild; both pids are
      // recorded so the test can prove group-kill + SIGKILL escalation.
      const pidFile = path.join(tmp, "child.pid");
      const grandPidFile = path.join(tmp, "grand.pid");
      process.env.HOOK_TEST_PIDFILE = pidFile;
      process.env.HOOK_TEST_GRAND_PIDFILE = grandPidFile;
      try {
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
                        "node -e \"process.on('SIGTERM',()=>{});const c=require('child_process').spawn('sleep',['30']);require('fs').writeFileSync(process.env.HOOK_TEST_GRAND_PIDFILE,String(c.pid));require('fs').writeFileSync(process.env.HOOK_TEST_PIDFILE,String(process.pid));setInterval(()=>{},1000)\"",
                      timeout: 1,
                    },
                  ],
                },
              ],
            },
          }),
          "utf8",
        );

        const cfg = {
          ...DEFAULT_CONFIG,
          blockingStopHooks: true,
          compatClaudeHooks: false,
          compatCursorHooks: false,
        };
        const runner = new HookRunner(cfg, tmp);
        const r = await runner.run("Stop", {
          sessionId: "s1",
          cwd: tmp,
          workspaceRoot: tmp,
        });
        assert.equal(r.blocked, true);
        assert.match(String(r.reason || ""), /timed out/i);

        // Wait out the 2s TERM→KILL grace, then both the TERM-ignoring hook
        // and its sleep grandchild must be reaped (pre-fix both orphaned).
        await new Promise((res) => setTimeout(res, 2600));
        const hookPid = Number(fs.readFileSync(pidFile, "utf8").trim());
        const grandPid = Number(fs.readFileSync(grandPidFile, "utf8").trim());
        assert.ok(hookPid > 0 && grandPid > 0);
        assert.throws(() => process.kill(hookPid, 0), /ESRCH/);
        assert.throws(() => process.kill(grandPid, 0), /ESRCH/);
      } finally {
        delete process.env.HOOK_TEST_PIDFILE;
        delete process.env.HOOK_TEST_GRAND_PIDFILE;
      }
    },
  );

});
