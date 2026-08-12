/**
 * Background task wait-until-done + parseWaitMs.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  _resetTasksForTests,
  startBackgroundTask,
  waitForTask,
  getTask,
} from "../src/agent/tools/background-tasks.js";
import {
  parseWaitMs,
  toolGetTaskOutput,
} from "../src/agent/tools/task-tools.js";

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

describe("parseWaitMs", () => {
  it("parses numbers and duration suffixes", () => {
    assert.equal(parseWaitMs(1500), 1500);
    assert.equal(parseWaitMs("2s"), 2000);
    assert.equal(parseWaitMs("1m"), 60_000);
    assert.equal(parseWaitMs("true"), 120_000);
    assert.equal(parseWaitMs("wait"), 120_000);
    assert.equal(parseWaitMs("off"), 0);
    assert.equal(parseWaitMs("nope"), null);
    assert.equal(parseWaitMs(-5), 0);
    assert.ok((parseWaitMs("2h") as number) <= 30 * 60_000);
  });
});

describe("waitForTask / get_task_output wait", () => {
  let prevHome = "";
  let fakeHome = "";

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    fakeHome = fs.mkdtempSync(path.join(tmpRoot(), "forge-bg-home-"));
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

  it("waitForTask resolves when the command exits", async () => {
    const cwd = tmpRoot();
    const r = await startBackgroundTask({
      command: "echo hi-wait && sleep 0.2 && echo done",
      cwd,
      profile: "off",
      timeoutMs: 15_000,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const w = await waitForTask(r.task.id, { timeoutMs: 10_000 });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    assert.equal(w.timedOut, false);
    assert.equal(w.task.status, "completed");
    assert.equal(w.task.exitCode, 0);
    assert.ok(w.waitedMs >= 0);
  });

  it("waitForTask times out while still running", async () => {
    const cwd = tmpRoot();
    const r = await startBackgroundTask({
      command: "sleep 5",
      cwd,
      profile: "off",
      timeoutMs: 30_000,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const w = await waitForTask(r.task.id, { timeoutMs: 200 });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    assert.equal(w.timedOut, true);
    assert.equal(w.task.status, "running");
    // cleanup
    const { killTask } = await import("../src/agent/tools/background-tasks.js");
    killTask(r.task.id);
  });

  it("toolGetTaskOutput wait returns final output without polling", async () => {
    const cwd = tmpRoot();
    const r = await startBackgroundTask({
      command: "printf 'line1\\nline2\\n' ; sleep 0.15 ; printf 'line3\\n'",
      cwd,
      profile: "off",
      timeoutMs: 15_000,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const out = await toolGetTaskOutput({
      task_id: r.task.id,
      wait: "2s",
      tail: 0,
    });
    assert.equal(out.isError, undefined);
    assert.match(out.output, /wait: reached completed/i);
    assert.match(out.output, /line3/);
    assert.match(out.output, /status: completed/);
  });
});


describe("bg completion notify", () => {
  it("formatInterjection passes harness notifications through", async () => {
    const { formatInterjection } = await import(
      "../src/harness/interjection.js"
    );
    const raw =
      "[Forge harness — background task completed]\ntask_id=t1  exit=0";
    const out = formatInterjection(raw);
    assert.match(out, /background task completed/);
    assert.doesNotMatch(out, /user sent a message/i);
    assert.doesNotMatch(out, /user_query/);
  });
});

