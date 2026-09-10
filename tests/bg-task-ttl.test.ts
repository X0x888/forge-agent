/**
 * Background-task disk TTL janitor.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  _resetTasksForTests,
  janitorBackgroundTasks,
  killTask,
  startBackgroundTask,
} from "../src/agent/tools/background-tasks.js";
import { forgeHome } from "../src/util/fs.js";

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

describe("janitorBackgroundTasks", () => {
  let prevHome = "";
  let fakeHome = "";

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    fakeHome = fs.mkdtempSync(path.join(tmpRoot(), "forge-bg-ttl-"));
    process.env.FORGE_HOME = fakeHome;
  });

  afterEach(() => {
    _resetTasksForTests();
  });

  after(() => {
    if (prevHome) process.env.FORGE_HOME = prevHome;
    else delete process.env.FORGE_HOME;
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("deletes settled task dirs older than TTL and never leaves the folder", async () => {
    process.env.FORGE_HOME = fakeHome;
    const root = path.join(forgeHome(), "background-tasks");
    fs.mkdirSync(root, { recursive: true });
    const oldId = "bg_old_dead1";
    const freshId = "bg_fresh_keep";
    const oldDir = path.join(root, oldId);
    const freshDir = path.join(root, freshId);
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "stdout.txt"), "old");
    fs.writeFileSync(path.join(freshDir, "stdout.txt"), "new");
    const oldSec = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldDir, oldSec, oldSec);
    fs.utimesSync(path.join(oldDir, "stdout.txt"), oldSec, oldSec);

    const outside = path.join(fakeHome, "do-not-touch");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "safe");

    const r = janitorBackgroundTasks({
      maxAgeMs: 24 * 60 * 60 * 1000,
      nowMs: Date.now(),
    });
    assert.ok(r.removed.includes(oldId), `removed=${r.removed.join(",")}`);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(freshDir), true);
    assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
  });

  it("does not delete a running task dir even when mtime is old", async () => {
    process.env.FORGE_HOME = fakeHome;
    const cwd = tmpRoot();
    const started = await startBackgroundTask({
      command: "sleep 30",
      cwd,
      profile: "off",
      timeoutMs: 60_000,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const dir = path.dirname(started.task.stdoutPath);
    const oldSec = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    try {
      fs.utimesSync(dir, oldSec, oldSec);
    } catch {
      /* */
    }
    const r = janitorBackgroundTasks({ maxAgeMs: 1000 });
    assert.equal(r.removed.includes(started.task.id), false);
    assert.equal(fs.existsSync(dir), true);
    killTask(started.task.id);
  });
});
