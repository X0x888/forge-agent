import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isAgentBrowserCommand,
  listChromeLookDirs,
  rehomeFiles,
  removeChromeLookDirs,
} from "../src/util/look-cleanup.js";

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
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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
});
