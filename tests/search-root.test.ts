import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  isBroadSearchRoot,
  searchRootRefusal,
} from "../src/agent/tools/search-root.js";
import { toolGlob } from "../src/agent/tools/glob-list.js";
import { toolGrep } from "../src/agent/tools/grep.js";

describe("search-root", () => {
  it("home, /Users, and ~/Library are broad; a project dir is not", () => {
    assert.equal(isBroadSearchRoot(os.homedir()), true);
    assert.equal(isBroadSearchRoot("/"), true);
    assert.equal(isBroadSearchRoot("/Users"), true);
    assert.equal(isBroadSearchRoot(path.join(os.homedir(), "Library")), true);
    assert.equal(isBroadSearchRoot(path.join(os.homedir(), "Documents", "app")), false);
    assert.match(searchRootRefusal(os.homedir(), "glob"), /too broad/);
  });

  it("glob of $HOME errors without walking Library", async () => {
    const r = await toolGlob(
      { pattern: "**/*", path: os.homedir() },
      { workspace: path.join(os.homedir(), "Documents") },
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /too broad/);
    assert.doesNotMatch(r.output, /Application Support/);
  });

  it("grep of $HOME errors the same way", async () => {
    const r = await toolGrep(
      { pattern: "forge-game", path: os.homedir() },
      { workspace: path.join(os.homedir(), "Documents") },
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /too broad/);
  });

  it("six parallel home globs all error without walking Library", async () => {
    const ws = path.join(os.homedir(), "Documents");
    const started = Date.now();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () =>
        toolGlob({ pattern: "**/*", path: os.homedir() }, { workspace: ws }),
      ),
    );
    assert.ok(Date.now() - started < 2_000);
    for (const r of rs) {
      assert.equal(r.isError, true);
      assert.match(r.output, /too broad/);
      assert.doesNotMatch(r.output, /Application Support/);
    }
  });
});
