import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeAgainstBaseline, runCheckCommand } from "../src/harness/cycle/verify.js";
import { pidAlive, processKillGraceMs } from "../src/util/process-tree.js";
import {
  extractFailingTests,
  isFullSuiteCommand,
  isGodotProductCheck,
  isIsolateTestCommand,
} from "../src/harness/verification.js";

describe("isIsolateTestCommand — vitest / jest / mocha", () => {
  it("named files or a name filter are isolates; the bare runner is the suite", () => {
    assert.equal(isIsolateTestCommand("cd extension && npx vitest run src/__tests__/badge.test.ts"), true);
    assert.equal(isIsolateTestCommand("npx jest src/a.test.ts src/b.test.ts"), true);
    assert.equal(isIsolateTestCommand("npx vitest run -t 'plants tomorrow'"), true);
    assert.equal(isIsolateTestCommand("npx mocha --grep badge"), true);
    assert.equal(isIsolateTestCommand("cd extension && npx vitest run"), false);
    assert.equal(isIsolateTestCommand("npx jest --coverage"), false);
    assert.equal(isIsolateTestCommand("cd extension && npm test"), false);
  });

  it("cargo -p isolate plus godot headless smoke is the product gate, not an isolate", () => {
    const compound =
      "cargo test -p game_core --offline && godot --path godot --headless --script res://scripts/smoke.gd";
    assert.equal(isIsolateTestCommand("cargo test -p game_core --offline"), true);
    assert.equal(isGodotProductCheck("godot --path godot --headless --script res://scripts/smoke.gd"), true);
    assert.equal(isIsolateTestCommand(compound), false);
    assert.equal(isFullSuiteCommand(compound), true);
    assert.equal(isFullSuiteCommand("godot --path godot --headless --script res://scripts/smoke.gd"), true);
  });
});

describe("extractFailingTests", () => {
  it("node:test — top-level and nested ✖ rows, durations stripped, the 'failing tests:' banner skipped", () => {
    const out = [
      "✔ passes (1.2ms)",
      "✖ renders colour (12.5ms)",
      "  ✖ a workspace inside a repo commits only its own subtree — never the enclosing repo's dirty files (545.039636ms)",
      "✖ failing tests:",
      "✖ renders colour (12.5ms)",
      "ℹ fail 2",
    ].join("\n");
    assert.deepEqual(extractFailingTests(out), [
      "renders colour",
      "a workspace inside a repo commits only its own subtree — never the enclosing repo's dirty files",
    ]);
  });

  it("TAP, jest / vitest, pytest, cargo, go, mocha", () => {
    assert.deepEqual(extractFailingTests("not ok 3 - the flag prints nothing\nok 4 - fine"), ["the flag prints nothing"]);
    assert.deepEqual(extractFailingTests("  ✕ adds two numbers (3 ms)\n  × subtracts\nFAIL src/math.test.ts"), [
      "adds two numbers",
      "subtracts",
      "src/math.test.ts",
    ]);
    assert.deepEqual(extractFailingTests("FAILED tests/test_x.py::test_add - assert 1 == 2\nPASSED tests/test_y.py::t"), [
      "tests/test_x.py::test_add",
    ]);
    assert.deepEqual(extractFailingTests("test parse::handles_empty ... FAILED\ntest parse::ok ... ok"), ["parse::handles_empty"]);
    assert.deepEqual(extractFailingTests("--- FAIL: TestParse (0.00s)\n--- PASS: TestOk (0.00s)"), ["TestParse"]);
    assert.deepEqual(extractFailingTests("  1) renders the header\n  2) wraps long lines"), ["renders the header", "wraps long lines"]);
  });

  it("ANSI colour is stripped; a green run names nothing", () => {
    assert.deepEqual(extractFailingTests("\x1b[31m✖ red one (1ms)\x1b[0m"), ["red one"]);
    assert.deepEqual(extractFailingTests("✔ all good\nℹ pass 10\nℹ fail 0"), []);
  });
});

describe("judgeAgainstBaseline", () => {
  const red = (failures: string[], exitCode = 1) => ({
    command: "npm test",
    exitCode,
    timedOut: false,
    failures,
    cls: { ran: true, passed: false, isolate: false, fullSuite: false },
  });
  const baseline = { command: "npm test", exitCode: 1, failures: ["renders colour", "hud width"], at: "t" };

  it("exit 0 is green regardless of baseline", () => {
    const v = judgeAgainstBaseline(
      { ...red([]), exitCode: 0, cls: { ran: true, passed: true, isolate: false, fullSuite: true } },
      undefined,
    );
    assert.equal(v.passed, true);
    assert.equal(v.note, "green");
  });

  it("no baseline: red stays red and every failure is new", () => {
    const v = judgeAgainstBaseline(red(["a", "b"]), undefined);
    assert.equal(v.passed, false);
    assert.deepEqual(v.newFailures, ["a", "b"]);
    assert.match(v.note, /no baseline/);
  });

  it("all failures in the baseline → green vs baseline, inherited named", () => {
    const v = judgeAgainstBaseline(red(["hud width", "renders colour"]), baseline);
    assert.equal(v.passed, true);
    assert.deepEqual(v.inherited, ["hud width", "renders colour"]);
    assert.deepEqual(v.newFailures, []);
    assert.match(v.note, /2 pre-existing failure\(s\) unchanged/);
  });

  it("one new failure among old ones → red, only the new one is the executor's", () => {
    const v = judgeAgainstBaseline(red(["renders colour", "my new test"]), baseline);
    assert.equal(v.passed, false);
    assert.deepEqual(v.newFailures, ["my new test"]);
    assert.deepEqual(v.inherited, ["renders colour"]);
  });

  it("a red run with no named failures, a timeout, or a different command cannot be excused by the baseline", () => {
    assert.equal(judgeAgainstBaseline(red([]), baseline).passed, false);
    assert.match(judgeAgainstBaseline(red([]), baseline).note, /no failing tests named/);
    assert.equal(judgeAgainstBaseline({ ...red([]), timedOut: true }, baseline).passed, false);
    assert.equal(judgeAgainstBaseline({ ...red(["hud width"]), command: "npm run test:unit" }, baseline).passed, false);
  });
});

describe("runCheckCommand", () => {
  it("captures the full output, a tail, and the failing test names", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-"));
    const run = await runCheckCommand({
      command: `printf '✔ ok (1ms)\\n✖ broken thing (2ms)\\nℹ fail 1\\n'; exit 1`,
      cwd,
      timeoutMs: 10_000,
    });
    assert.equal(run.exitCode, 1);
    assert.equal(run.cls.passed, false);
    assert.deepEqual(run.failures, ["broken thing"]);
    assert.match(run.output, /broken thing/);
    assert.equal(run.tail, run.output);
  });

  it("waits for close so a late stdout line is not dropped", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-late-"));
    fs.writeFileSync(
      path.join(cwd, "late.mjs"),
      "process.stdout.write('early\\n');\nsetTimeout(() => process.stdout.write('late\\n'), 80);\n",
    );
    const run = await runCheckCommand({
      command: "node late.mjs",
      cwd,
      timeoutMs: 10_000,
    });
    assert.match(run.output, /early/);
    assert.match(run.output, /late/);
    assert.equal(run.timedOut, false);
  });

  it("refuses npm run preview without spawning", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-prev-"));
    const run = await runCheckCommand({
      command: "npm run preview",
      cwd,
      timeoutMs: 2_000,
    });
    assert.equal(run.cls.passed, false);
    assert.match(run.output, /never exits/);
    assert.equal(run.timedOut, false);
    assert.equal(run.ms, 0);
  });

  it("times out a sleep and settles", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-sleep-"));
    const run = await runCheckCommand({
      command: "sleep 30",
      cwd,
      timeoutMs: 400,
    });
    assert.equal(run.timedOut, true);
    assert.equal(run.cls.passed, false);
  });

  it("kills the process group so a grandchild does not survive timeout", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-verify-pg-"));
    const marker = path.join(cwd, "grandchild.pid");
    const run = await runCheckCommand({
      command: `sleep 60 & echo $! > "${marker}"; wait`,
      cwd,
      timeoutMs: 500,
    });
    assert.equal(run.timedOut, true);
    await new Promise((r) => setTimeout(r, processKillGraceMs() + 80));
    const raw = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 1) {
      assert.equal(pidAlive(pid), false, `grandchild pid ${pid} still alive`);
    }
  });
});
