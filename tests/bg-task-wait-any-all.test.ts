/**
 * grok-build-style wait_any / wait_all on background bash tasks.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  _resetTasksForTests,
  startBackgroundTask,
  waitForTasks,
} from "../src/agent/tools/background-tasks.js";
import {
  parseTaskIds,
  parseWaitMode,
  toolGetTaskOutput,
} from "../src/agent/tools/task-tools.js";

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

async function startSleep(cwd: string, seconds: number) {
  const r = await startBackgroundTask({
    command: `sleep ${seconds}`,
    cwd,
    profile: "off",
    timeoutMs: 30_000,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

describe("parseTaskIds / parseWaitMode", () => {
  it("accepts arrays, csv, and grok-build any|all aliases", () => {
    assert.deepEqual(parseTaskIds({ task_id: "a" }), ["a"]);
    assert.deepEqual(parseTaskIds({ task_ids: ["a", "b", "a"] }), ["a", "b"]);
    assert.deepEqual(parseTaskIds({ task_ids: "a, b  c" }), ["a", "b", "c"]);
    assert.equal(parseWaitMode(undefined), "all");
    assert.equal(parseWaitMode("any"), "any");
    assert.equal(parseWaitMode("first"), "any");
    assert.equal(parseWaitMode("ALL"), "all");
    assert.equal(parseWaitMode("nope"), null);
  });
});

describe("waitForTasks any|all", () => {
  let tmp = "";

  before(() => {
    tmp = fs.mkdtempSync(path.join(tmpRoot(), "forge-wait-any-all-"));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    _resetTasksForTests();
  });

  it("any returns when the first of several tasks finishes", async () => {
    const a = await startSleep(tmp, 0.2);
    const b = await startSleep(tmp, 8);
    const t0 = Date.now();
    const r = await waitForTasks([a.id, b.id], { timeoutMs: 4000, mode: "any" });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.timedOut, false);
    assert.equal(r.mode, "any");
    assert.equal(r.winner?.id, a.id);
    assert.ok(elapsed < 3500, `any-wait took ${elapsed}ms`);
    assert.equal(b.status, "running");
    b.child?.kill("SIGTERM");
  });

  it("all blocks until every listed task finishes", async () => {
    const a = await startSleep(tmp, 0.15);
    const b = await startSleep(tmp, 0.3);
    const r = await waitForTasks([a.id, b.id], { timeoutMs: 4000, mode: "all" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.timedOut, false);
    assert.equal(r.stillRunning.length, 0);
    assert.equal(r.tasks.length, 2);
    assert.ok(r.tasks.every((t) => t.status !== "running"));
  });

  it("empty ids lock the running set at start (all)", async () => {
    await startSleep(tmp, 0.15);
    await startSleep(tmp, 0.25);
    const r = await waitForTasks([], { timeoutMs: 4000, mode: "all" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.tasks.length, 2);
    assert.equal(r.stillRunning.length, 0);
  });

  it("unknown id fails closed", async () => {
    const r = await waitForTasks(["nope-task"], { timeoutMs: 100, mode: "all" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /Unknown task_id: nope-task/);
  });

  it("get_task_output wait_mode=any surfaces both tasks and the winner", async () => {
    const a = await startSleep(tmp, 0.15);
    const b = await startSleep(tmp, 8);
    const out = await toolGetTaskOutput({
      task_ids: [a.id, b.id],
      wait_mode: "any",
      wait: 4000,
      tail: 5,
    });
    assert.match(out.output, /wait: .* reached (completed|failed|killed) in \d+ms \(any\)/);
    assert.match(out.output, new RegExp(`- ${a.id} \\[`));
    assert.match(out.output, new RegExp(`- ${b.id} \\[`));
    b.child?.kill("SIGTERM");
  });

  it("get_task_output wait_mode=all with no ids waits on every running task", async () => {
    await startSleep(tmp, 0.15);
    await startSleep(tmp, 0.25);
    const out = await toolGetTaskOutput({ wait_mode: "all", wait: 4000, tail: 5 });
    assert.match(out.output, /wait: all 2 task\(s\) finished/);
  });
});
