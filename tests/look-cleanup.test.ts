import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  _listProcessesForTests,
  isAgentBrowserCommand,
  killOrphanAgentBrowsers,
  listChromeLookDirs,
  rehomeFiles,
  removeChromeLookDirs,
} from "../src/util/look-cleanup.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("look-cleanup", () => {
  it("matches Chromium only when the cmdline cites an owned Forge path", () => {
    const owned = ["/Users/x/.forge/tmp/playwright-output", "/proj/.forge"];
    assert.equal(
      isAgentBrowserCommand(
        "/Chromium --user-data-dir=/Users/x/.forge/tmp/playwright-output/mcp",
        owned,
      ),
      true,
    );
    assert.equal(
      isAgentBrowserCommand(
        "/Chromium --user-data-dir=/proj/.forge/chrome-look3",
        owned,
      ),
      true,
    );
    assert.equal(
      isAgentBrowserCommand(
        "/Chromium --user-data-dir=/tmp/hashpet-c17-profile-p9555",
        owned,
      ),
      true,
    );
    assert.equal(
      isAgentBrowserCommand(
        "/Chromium --user-data-dir=/tmp/mom-claim-1788902526885",
        owned,
      ),
      true,
    );
    assert.equal(
      isAgentBrowserCommand(
        "/Chromium --user-data-dir=/Users/x/.forge/sessions/planner-c34/chrome-fresh3",
        owned,
      ),
      true,
    );
    assert.equal(
      isAgentBrowserCommand(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        owned,
      ),
      false,
    );
    assert.equal(
      isAgentBrowserCommand(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/unrelated-profile",
        owned,
      ),
      false,
    );
    assert.equal(
      isAgentBrowserCommand("vim README.md", owned),
      false,
    );
  });

  it("removes .forge/chrome-look* dirs and rehomes look files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-look-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "forge-looks-dest-"));
    try {
      const profile = path.join(root, ".forge", "chrome-look12");
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, "Local State"), "{}\n");
      assert.equal(listChromeLookDirs(root).length, 1);
      const removed = removeChromeLookDirs(root);
      assert.deepEqual(removed, [".forge/chrome-look12"]);
      assert.equal(fs.existsSync(profile), false);

      fs.mkdirSync(path.join(root, "images"), { recursive: true });
      fs.writeFileSync(path.join(root, "images", "home-look.png"), "png");
      const { moved, failed } = rehomeFiles({
        cwd: root,
        relPaths: ["images/home-look.png"],
        destDir: dest,
      });
      assert.deepEqual(failed, []);
      assert.deepEqual(moved, ["images/home-look.png"]);
      assert.equal(fs.existsSync(path.join(root, "images", "home-look.png")), false);
      assert.equal(fs.existsSync(path.join(dest, "home-look.png")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it("removes workspace .forge/chrome-cft-planner (not only chrome-look*)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-look-cft-"));
    try {
      const profile = path.join(root, ".forge", "chrome-cft-planner");
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, "Local State"), "{}\n");
      const skip = path.join(root, ".forge", "chrome-other");
      fs.mkdirSync(skip, { recursive: true });
      assert.equal(listChromeLookDirs(root).length, 1);
      const removed = removeChromeLookDirs(root);
      assert.deepEqual(removed, [".forge/chrome-cft-planner"]);
      assert.equal(fs.existsSync(profile), false);
      assert.equal(fs.existsSync(skip), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("kills only agent-browser rows, never stock Chrome", () => {
    const prevReap = process.env.FORGE_BROWSER_REAP;
    delete process.env.FORGE_BROWSER_REAP;
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid;
    assert.ok(pid && pid > 1);
    try {
      const killedStock = killOrphanAgentBrowsers(undefined, {
        rows: [
          {
            pid,
            cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          },
        ],
      });
      assert.equal(killedStock, 0);
      assert.equal(pidAlive(pid), true);

      const killed = killOrphanAgentBrowsers(undefined, {
        rows: [
          {
            pid,
            cmd: "/Chromium --user-data-dir=/tmp/hashpet-c17-profile-p9555",
          },
        ],
      });
      assert.equal(killed, 1);
    } finally {
      if (prevReap === undefined) delete process.env.FORGE_BROWSER_REAP;
      else process.env.FORGE_BROWSER_REAP = prevReap;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already reaped */
      }
      child.unref();
    }
    assert.ok(Array.isArray(_listProcessesForTests()));
  });
});
