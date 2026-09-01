/**
 * Verification credit: the check that ran is the proof, whichever channel
 * observed it. The doctrine says "background:true then get_task_output";
 * dogfood obeyed — 20/28 checks on a Swift app, 45/61 on a Rust workspace
 * — and every one of them was proof=✗ because only foreground results were
 * credited and `swift test` / `./build.sh` were not checks at all.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isObserverOnlyCommand,
  isVerificationCommand,
} from "../src/harness/verify-command.js";
import {
  classifyVerificationRun,
  countsTowardVerification,
  evaluateUlwAtStop,
  isFullSuiteCommand,
  isIsolateTestCommand,
  isTypecheckCommand,
  loadUlwCycle,
  maybeAdoptDeclaredChecks,
  ulwPreferredCheckCommands,
  CONSOLIDATION_EVERY,
} from "../src/harness/ulw-cycle.js";
import {
  extractDeclaredChecks,
  looksLikeCheckCommand,
  mergePreferredChecks,
} from "../src/harness/declared-checks.js";
import {
  _resetTasksForTests,
  onBackgroundTaskSettled,
  readTaskLogTailForVerification,
  startBackgroundTask,
  waitForTask,
  type BackgroundTask,
} from "../src/agent/tools/background-tasks.js";
import {
  bgTaskIdsFromToolCall,
  creditBackgroundTaskVerification,
  type HarnessRunStats,
} from "../src/agent/loop.js";
import { armUlwReady } from "./helpers/ulw-arm.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vcredit-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "forge-vcredit-cwd-"));
}

function freshStats(): HarnessRunStats {
  return {
    verificationRuns: 0,
    verificationPassedRuns: 0,
    verificationHelperOnlyRuns: 0,
    verificationFullSuiteRuns: 0,
    effortBoostTurns: 0,
    creditedBgTaskIds: new Set<string>(),
  };
}

describe("verification command recognition", () => {
  it("knows swift / xcodebuild / zig / dotnet / dart / just / repo scripts", () => {
    const yes = [
      "swift test",
      "swift build -c release",
      "xcodebuild -scheme App test",
      "zig build test",
      "dotnet test",
      "flutter test",
      "just ci",
      "make verify",
      "cargo nextest run",
      "./build.sh",
      './build.sh && "build/Sounds Isolator.app/Contents/MacOS/SoundsIsolator" --self-test; echo ',
      "scripts/test.sh",
      "bash scripts/check.sh",
      "python tools/selftest.py",
      "./run-tests",
      "cd pkg && npm test",
      "FOO=1 pytest -q",
    ];
    for (const c of yes) assert.equal(isVerificationCommand(c), true, c);
  });

  it("does not count observers, arrangers, or quoted mentions", () => {
    const no = [
      "pgrep -lf 'cargo test --workspace' | head -3 || echo clear",
      'echo "npm test"',
      "echo npm test && echo done",
      "grep -rn 'cargo test' src",
      "rm -rf ./test",
      "git diff -- tests/",
      "cat ./build.sh",
      "ls ./build",
      "./build",
      "open build/App.app",
    ];
    for (const c of no) assert.equal(isVerificationCommand(c), false, c);
    assert.equal(isObserverOnlyCommand("pgrep -lf 'cargo test'"), true);
    assert.equal(isObserverOnlyCommand("cd x && cargo test"), false);
    // Background *starts* still observe nothing — the settle/join credits.
    assert.equal(
      countsTowardVerification({ command: "cargo test", background: true }),
      false,
    );
  });

  it("full-suite vs isolate vs typecheck across stacks", () => {
    assert.equal(isFullSuiteCommand("cargo test --workspace"), true);
    assert.equal(isFullSuiteCommand("cargo test"), true);
    assert.equal(isIsolateTestCommand("cargo test -p together-core --lib send_and_readiness"), true);
    assert.equal(isIsolateTestCommand("cargo test send_and_readiness -- --nocapture"), true);
    assert.equal(isFullSuiteCommand("swift test"), true);
    assert.equal(isIsolateTestCommand("swift test --filter SleepDream"), true);
    assert.equal(isFullSuiteCommand("go test ./..."), true);
    assert.equal(isIsolateTestCommand("go test -run TestFoo ./internal/x"), true);
    assert.equal(isFullSuiteCommand("dotnet test"), true);
    assert.equal(isFullSuiteCommand("zig build test"), true);
    assert.equal(isFullSuiteCommand("make check"), true);
    assert.equal(isTypecheckCommand("cargo check"), true);
    assert.equal(isTypecheckCommand("cargo clippy --all-targets"), true);
    assert.equal(isTypecheckCommand("swift build"), true);
    assert.equal(isTypecheckCommand("go vet ./..."), true);
    assert.equal(isTypecheckCommand("zig build"), true);
    assert.equal(isTypecheckCommand("zig build test"), false);
    assert.equal(isTypecheckCommand("cargo test"), false);
  });
});

describe("classifyVerificationRun", () => {
  it("foreground: green suite is passed + fullSuite; a fail count is red", () => {
    const green = classifyVerificationRun({
      command: "npm test",
      isError: false,
      output: "ℹ pass 12\nℹ fail 0",
    });
    assert.deepEqual(green, { ran: true, passed: true, isolate: false, fullSuite: true });
    const red = classifyVerificationRun({
      command: "npm test",
      isError: false,
      output: "ℹ pass 9\nℹ fail 3",
    });
    assert.equal(red.ran, true);
    assert.equal(red.passed, false);
    assert.equal(red.fullSuite, false);
  });

  it("isolates and typechecks are ran, not ✓ — even when green", () => {
    const iso = classifyVerificationRun({
      command: "node --test tests/foo.test.ts",
      exitCode: 0,
      output: "ℹ pass 3",
    });
    assert.equal(iso.ran, true);
    assert.equal(iso.isolate, true);
    assert.equal(iso.fullSuite, false);
    const tc = classifyVerificationRun({ command: "npm run typecheck", exitCode: 0 });
    assert.equal(tc.isolate, true);
  });

  it("background exit codes decide: 0 passes, non-zero fails, non-checks never ran", () => {
    const ok = classifyVerificationRun({ command: "cargo test --workspace", exitCode: 0, output: "test result: ok. 412 passed" });
    assert.deepEqual(ok, { ran: true, passed: true, isolate: false, fullSuite: true });
    const bad = classifyVerificationRun({ command: "cargo test --workspace", exitCode: 101, output: "test result: FAILED. 2 failed" });
    assert.equal(bad.ran, true);
    assert.equal(bad.passed, false);
    const swift = classifyVerificationRun({
      command: './build.sh && "build/Sounds Isolator.app/Contents/MacOS/SoundsIsolator" --self-test; echo ',
      exitCode: 0,
      output: "self-test ok",
    });
    assert.equal(swift.ran, true);
    assert.equal(swift.passed, true);
    const none = classifyVerificationRun({ command: "sleep 5", exitCode: 0 });
    assert.equal(none.ran, false);
  });
});

describe("background task settle → verification credit", () => {
  afterEach(() => {
    _resetTasksForTests();
  });

  it("a settled background check credits once, via listener or join, with its exit code", async () => {
    const cwd = tmpRoot();
    const script = path.join(cwd, "check.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho 'ℹ pass 4'\necho 'ℹ fail 0'\nexit 0\n");
    fs.chmodSync(script, 0o755);
    const settled: BackgroundTask[] = [];
    const off = onBackgroundTaskSettled((t) => settled.push(t));
    try {
      const r = await startBackgroundTask({
        command: "./check.sh",
        cwd,
        profile: "off",
        timeoutMs: 15_000,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      const w = await waitForTask(r.task.id, { timeoutMs: 10_000 });
      assert.equal(w.ok, true);
      // Listener saw the exit.
      assert.equal(settled.length, 1);
      assert.equal(settled[0]!.id, r.task.id);
      assert.equal(settled[0]!.status, "completed");
      assert.match(readTaskLogTailForVerification(settled[0]!), /fail 0/);

      const stats = freshStats();
      const meta: { lastVerificationCommand?: string; lastVerificationOk?: boolean; editCount?: number } = {};
      const cls = creditBackgroundTaskVerification({
        task: settled[0]!,
        harnessStats: stats,
        meta: meta as never,
      });
      assert.equal(cls?.ran, true);
      assert.equal(cls?.passed, true);
      assert.equal(stats.verificationRuns, 1);
      assert.equal(stats.verificationPassedRuns, 1);
      assert.equal(meta.lastVerificationCommand, "./check.sh");
      assert.equal(meta.lastVerificationOk, true);
      // The join path sees the same task — no double credit.
      const again = creditBackgroundTaskVerification({
        task: settled[0]!,
        harnessStats: stats,
        meta: meta as never,
      });
      assert.equal(again, null);
      assert.equal(stats.verificationRuns, 1);
    } finally {
      off();
    }
  });

  it("a red background suite is ran-not-passed and keeps the trail red", async () => {
    const cwd = tmpRoot();
    const script = path.join(cwd, "test.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho 'ℹ pass 1'\necho 'ℹ fail 2'\nexit 1\n");
    fs.chmodSync(script, 0o755);
    const r = await startBackgroundTask({ command: "./test.sh", cwd, profile: "off", timeoutMs: 15_000 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const w = await waitForTask(r.task.id, { timeoutMs: 10_000 });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    assert.equal(w.task.status, "failed");
    const stats = freshStats();
    const meta: { lastVerificationOk?: boolean } = {};
    const cls = creditBackgroundTaskVerification({ task: w.task, harnessStats: stats, meta: meta as never });
    assert.equal(cls?.ran, true);
    assert.equal(cls?.passed, false);
    assert.equal(stats.verificationRuns, 1);
    assert.equal(stats.verificationPassedRuns, 0);
    assert.equal(meta.lastVerificationOk, false);
  });

  it("a background task that is not a check is ignored (and not re-inspected)", async () => {
    const cwd = tmpRoot();
    const r = await startBackgroundTask({ command: "echo hi", cwd, profile: "off", timeoutMs: 15_000 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const w = await waitForTask(r.task.id, { timeoutMs: 10_000 });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    const stats = freshStats();
    const cls = creditBackgroundTaskVerification({ task: w.task, harnessStats: stats, meta: {} as never });
    assert.equal(cls?.ran, false);
    assert.equal(stats.verificationRuns, 0);
    assert.ok(stats.creditedBgTaskIds.has(w.task.id));
  });

  it("bgTaskIdsFromToolCall reads args and the printed task_id lines", () => {
    assert.deepEqual(bgTaskIdsFromToolCall({ task_id: "t1" }, "task_id: t1\nstatus: completed"), ["t1"]);
    assert.deepEqual(
      bgTaskIdsFromToolCall({ task_ids: ["a", "b"] }, "task_id: a\n---\ntask_id: c\n").sort(),
      ["a", "b", "c"],
    );
    assert.deepEqual(bgTaskIdsFromToolCall({ task_ids: "x, y" }, undefined).sort(), ["x", "y"]);
  });
});

describe("declared verify commands", () => {
  it("harvests the Reading's / Bet's command that proves it, refuses prose and product verbs", () => {
    assert.deepEqual(
      extractDeclaredChecks(
        "Reading: Product is menu-bar isolator. Better: hotkey pause. Passed on: overlay. ONE ship: isolationHotKeyAction pause; tests; Verify: ./build.sh && --self-test.",
      ),
      ["./build.sh && --self-test"],
    );
    assert.deepEqual(
      extractDeclaredChecks(
        "Bet: one-command CSV export — src/export/csv.ts — first slice: `forge export --csv` writes rows; proof: node --test tests/export.test.ts",
      ),
      ["node --test tests/export.test.ts"],
    );
    assert.deepEqual(extractDeclaredChecks("Verify: the login flow works end to end."), []);
    assert.deepEqual(extractDeclaredChecks("Check: echo done"), []);
    assert.deepEqual(extractDeclaredChecks("Files: `src/export/csv.ts`, `src/tui/dock.ts`"), []);
    assert.equal(looksLikeCheckCommand("make selfcheck"), true);
    assert.equal(looksLikeCheckCommand("just verify-all"), true);
    assert.equal(looksLikeCheckCommand("forge export --csv"), false);
    assert.equal(looksLikeCheckCommand("node dist/cli.js --help"), false);
    assert.equal(looksLikeCheckCommand("pgrep -lf 'cargo test'"), false);
  });

  it("mergePreferredChecks puts declared first and dedupes", () => {
    assert.deepEqual(mergePreferredChecks(["npm test", "npm run typecheck"], ["make selfcheck", "npm test"]), [
      "make selfcheck",
      "npm test",
      "npm run typecheck",
    ]);
    assert.deepEqual(mergePreferredChecks(undefined, []), undefined);
    assert.deepEqual(mergePreferredChecks(["npm test"], undefined), ["npm test"]);
  });

  it("adopted checks make an unknown project command structural proof", () => {
    withHome(() => {
      const sid = "declared-1";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      armUlwReady(sid, "Improve this tool comprehensively.", { cycle: 1, skipCheckpoint: true });
      const s = loadUlwCycle(sid)!;
      // armUlwReady's seeded Reading already declared `npm test`.
      assert.deepEqual(s.declaredChecks, ["npm test"]);
      assert.equal(maybeAdoptDeclaredChecks(s, "Reading: the ONE ship is X in src/a.ts. Verify: make selfcheck"), true);
      assert.deepEqual(s.declaredChecks, ["make selfcheck", "npm test"]);
      // Same text again does not churn; a new one goes first.
      assert.equal(maybeAdoptDeclaredChecks(s, "Verify: make selfcheck"), false);
      assert.equal(maybeAdoptDeclaredChecks(s, "Proof: just ci-fast"), true);
      assert.deepEqual(s.declaredChecks, ["just ci-fast", "make selfcheck", "npm test"]);

      // Without the sidecar the command is not a check; with it, it is a full suite.
      assert.equal(isVerificationCommand("make selfcheck"), false);
      assert.equal(isVerificationCommand("make selfcheck", ["make selfcheck"]), true);
      assert.equal(isFullSuiteCommand("make selfcheck", ["make selfcheck"]), true);
      assert.equal(isFullSuiteCommand("cd app && ./build.sh --self-test", ["./build.sh"]), true);
      const cls = classifyVerificationRun({ command: "make selfcheck", exitCode: 0, preferredCheckCommands: ["make selfcheck"] });
      assert.deepEqual(cls, { ran: true, passed: true, isolate: false, fullSuite: true });
    });
  });

  it("a Stop closer with Verify: lands on the sidecar and ulwPreferredCheckCommands merges it", () => {
    withHome(() => {
      const sid = "declared-stop";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      armUlwReady(sid, "Improve this tool comprehensively.", { cycle: 1, skipCheckpoint: true });
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "Ship landed: hotkey pause no longer races Core Audio. Verify: ./build.sh && --self-test",
        editCount: 5,
        openTodoCount: 0,
        stuckThreshold: 50,
      });
      assert.deepEqual(loadUlwCycle(sid)!.declaredChecks, ["./build.sh && --self-test", "npm test"]);
      // Declared first, stack table after, deduped.
      assert.deepEqual(ulwPreferredCheckCommands(sid, ["npm test", "npm run typecheck"]), [
        "./build.sh && --self-test",
        "npm test",
        "npm run typecheck",
      ]);
      assert.deepEqual(ulwPreferredCheckCommands(undefined, ["npm test"]), ["npm test"]);
    });
  });
});

describe("proof demand re-arms at consolidation", () => {
  it("a proof-less run is asked again every consolidation wave, not twice per run", () => {
    withHome(() => {
      const sid = "proof-rearm";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      armUlwReady(sid, "improve", { cycle: 1, skipCheckpoint: true });
      const stop = (editCount: number) =>
        evaluateUlwAtStop({
          sessionId: sid,
          lastAssistantMessage: "did some edits",
          editCount,
          openTodoCount: 0,
          stuckThreshold: 50,
        });
      assert.equal(stop(2).proofDemanded, true);
      assert.equal(stop(4).proofDemanded, true);
      assert.equal(stop(6).proofDemanded, false, "cap reached");
      assert.equal(loadUlwCycle(sid)!.proofDemands, 2);
      // Wave CONSOLIDATION_EVERY re-arms the demand on the consolidation boundary itself.
      const d = stop(8);
      assert.equal(loadUlwCycle(sid)!.wave, CONSOLIDATION_EVERY);
      assert.equal(d.proofDemanded, true);
      assert.equal(loadUlwCycle(sid)!.proofDemands, 1);
    });
  });
});
