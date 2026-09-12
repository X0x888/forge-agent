import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  inflightChildCount,
  killAllInflightTrees,
  killProcessTree,
  registerInflightChild,
  spawnOwnGroupOpts,
  _resetInflightChildrenForTests,
} from "../src/util/process-tree.js";
import { nextSigintAction } from "../src/tui/hints.js";
import { resolveBashTimeoutMs } from "../src/agent/tools/bash.js";
import {
  BASH_FOREGROUND_TIMEOUT_CAP_MS,
  BASH_BACKGROUND_TIMEOUT_CAP_MS,
} from "../src/util/env.js";
import { executeTool } from "../src/agent/tools/index.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("nextSigintAction", () => {
  it("aborts once, then force-quits while aborting", () => {
    assert.equal(
      nextSigintAction({ busy: true, aborting: false, quitArmed: false }),
      "abort",
    );
    assert.equal(
      nextSigintAction({ busy: true, aborting: true, quitArmed: false }),
      "force-quit",
    );
    assert.equal(
      nextSigintAction({ busy: false, aborting: false, quitArmed: false }),
      "arm-quit",
    );
    assert.equal(
      nextSigintAction({ busy: false, aborting: false, quitArmed: true }),
      "quit",
    );
  });
});

describe("resolveBashTimeoutMs cap", () => {
  it("caps numeric and duration at 30m foreground", () => {
    const cap = BASH_FOREGROUND_TIMEOUT_CAP_MS;
    const huge = resolveBashTimeoutMs(86_400_000, 120_000, cap);
    assert.equal(huge.ok, true);
    if (huge.ok) assert.equal(huge.ms, cap);
    const dur = resolveBashTimeoutMs("2h", 120_000, cap);
    assert.equal(dur.ok, true);
    if (dur.ok) assert.equal(dur.ms, cap);
    const all = resolveBashTimeoutMs("all", 120_000, cap);
    assert.equal(all.ok, true);
    if (all.ok) assert.equal(all.ms, cap);
  });

  it("background cap is 6h", () => {
    const cap = BASH_BACKGROUND_TIMEOUT_CAP_MS;
    const dur = resolveBashTimeoutMs("2h", 30 * 60_000, cap);
    assert.equal(dur.ok, true);
    if (dur.ok) assert.equal(dur.ms, 2 * 60 * 60_000);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("process-tree kill", () => {
  it(
    "timeout reaps a SIGTERM-ignoring grandchild and settles",
    { skip: process.platform === "win32" },
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pg-"));
      const grand = path.join(tmp, "grand.pid");
      const wrapper = path.join(tmp, "wrap.mjs");
      fs.writeFileSync(
        wrapper,
        `
import { spawn } from "node:child_process";
import fs from "node:fs";
process.on("SIGTERM", () => {});
const c = spawn("sleep", ["30"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(grand)}, String(c.pid));
setInterval(() => {}, 1000);
`,
      );
      const t0 = Date.now();
      // Long enough that node can boot wrap.mjs under a loaded suite; the
      // assertion is "settles", not "times out in 2s".
      const bashP = executeTool(
        "bash",
        JSON.stringify({
          command: `node ${JSON.stringify(wrapper)}`,
          timeout_ms: 6_000,
        }),
        { workspace: tmp, sandbox: "off", config: { sandbox: "off" } },
      );
      let gpid = 0;
      while (Date.now() - t0 < 5_000) {
        try {
          gpid = Number(fs.readFileSync(grand, "utf8").trim());
          if (gpid > 0) break;
        } catch {
          /* wrapper has not spawned yet */
        }
        await sleep(50);
      }
      assert.ok(gpid > 0, "wrapper must record the grandchild pid before bash times out");
      assert.equal(pidAlive(gpid), true, "grandchild is running when timeout is armed");
      const r = await bashP;
      assert.equal(r.isError, true);
      assert.match(r.output, /timed out/i);
      assert.ok(
        Date.now() - t0 < 15_000,
        `bash timeout must settle, took ${Date.now() - t0}ms`,
      );
      const deadBy = Date.now() + 4_000;
      while (pidAlive(gpid) && Date.now() < deadBy) await sleep(50);
      assert.equal(pidAlive(gpid), false, "grandchild must die with the group");
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  );

  it("killAllInflightTrees signals registered children", () => {
    _resetInflightChildrenForTests();
    const child = spawn("sleep", ["30"], {
      stdio: "ignore",
      ...spawnOwnGroupOpts(),
    });
    registerInflightChild(child);
    assert.ok(inflightChildCount() >= 1);
    killAllInflightTrees("SIGKILL");
    _resetInflightChildrenForTests();
  });

  it("killProcessTree is safe on an already-dead child", () => {
    const child = spawn("true", [], { stdio: "ignore" });
    child.kill("SIGKILL");
    assert.equal(typeof killProcessTree(child, "SIGKILL"), "boolean");
  });
});
