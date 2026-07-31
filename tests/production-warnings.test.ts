import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { productionWarningsForRun } from "../src/util/production-warnings.js";

describe("productionWarningsForRun", () => {
  it("flags post-run safety valves", () => {
    const base = {
      ...DEFAULT_CONFIG,
      sandbox: "workspace" as const,
      permissionMode: "default" as const,
      maxCostUsd: 0,
    };
    const w = productionWarningsForRun(base, {
      hitCostCap: true,
      hitMaxTurns: true,
      releasedOnContinueCap: true,
      _testDirtyFiles: 0,
      _testSessionCount: 0,
      _testPinnedCount: 0,
    });
    assert.ok(w.some((x) => /hitCostCap/i.test(x)));
    assert.ok(w.some((x) => /hitMaxTurns/i.test(x)));
    assert.ok(w.some((x) => /releasedOnContinueCap/i.test(x)));
  });

  it("flags ULW without spend cap", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG, maxCostUsd: 0 },
      {
        ultrawork: true,
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(w.some((x) => /ULW armed without a spend cap/i.test(x)));
  });

  it("does not flag ULW when budget armed", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG, maxCostUsd: 5 },
      {
        ultrawork: true,
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(!w.some((x) => /ULW armed without a spend cap/i.test(x)));
    assert.ok(w.some((x) => /maxCostUsd=\$5/i.test(x)));
  });

  it("session budget 0 overrides config cap for ULW warn", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG, maxCostUsd: 10 },
      {
        ultrawork: true,
        sessionMaxCostUsd: 0,
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(w.some((x) => /ULW armed without a spend cap/i.test(x)));
  });

  it("dirty tree under ULW at ≥20", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG, maxCostUsd: 5 },
      {
        ultrawork: true,
        _testDirtyFiles: 25,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(w.some((x) => /dirty tree has 25/i.test(x)));
  });

  it("dirty tree outside ULW only at ≥100", () => {
    const mild = productionWarningsForRun(
      { ...DEFAULT_CONFIG },
      {
        ultrawork: false,
        _testDirtyFiles: 40,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(!mild.some((x) => /dirty tree/i.test(x)));
    const heavy = productionWarningsForRun(
      { ...DEFAULT_CONFIG },
      {
        ultrawork: false,
        _testDirtyFiles: 120,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(heavy.some((x) => /dirty tree has 120/i.test(x)));
  });
});
