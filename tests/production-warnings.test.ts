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

  it("flags FORGE_FILE_READ_GUARD=0", () => {
    const prev = process.env.FORGE_FILE_READ_GUARD;
    process.env.FORGE_FILE_READ_GUARD = "0";
    try {
      const w = productionWarningsForRun(
        { ...DEFAULT_CONFIG },
        {
          _testDirtyFiles: 0,
          _testSessionCount: 0,
          _testPinnedCount: 0,
        },
      );
      assert.ok(w.some((x) => /FORGE_FILE_READ_GUARD=0/i.test(x)));
    } finally {
      if (prev === undefined) delete process.env.FORGE_FILE_READ_GUARD;
      else process.env.FORGE_FILE_READ_GUARD = prev;
    }
  });

  it("flags missing node_modules", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG },
      {
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
        _testMissingNodeModules: true,
      },
    );
    assert.ok(w.some((x) => /node_modules missing/i.test(x)));
  });

  it("flags packageManager vs lockfile mismatch in workspace", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pw-mismatch-"));
    fs.writeFileSync(
      path.join(d, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    );
    fs.writeFileSync(path.join(d, "package-lock.json"), "{}");
    fs.mkdirSync(path.join(d, "node_modules"), { recursive: true });
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG, workspace: d },
      {
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(w.some((x) => /packageManager=.*pnpm/i.test(x) && /package-lock/i.test(x)));
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

  it("flags edits without recorded verification", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG },
      {
        editCount: 3,
        lastVerificationCommand: undefined,
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(w.some((x) => /editsWithoutVerification/i.test(x)));
    assert.ok(w.some((x) => /3 edit/i.test(x)));
  });

  it("does not flag edits when lastVerificationCommand is set", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG },
      {
        editCount: 3,
        lastVerificationCommand: "npm test",
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(!w.some((x) => /editsWithoutVerification/i.test(x)));
  });

  it("flags stale last verification when edits after check", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG },
      {
        editCount: 2,
        lastVerificationCommand: "npm test",
        lastVerificationAt: "2026-04-10T12:00:00.000Z",
        lastEditAt: "2026-04-10T12:10:00.000Z",
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(w.some((x) => /staleLastVerification/i.test(x)));
    assert.ok(w.some((x) => /npm test/i.test(x)));
  });

  it("does not flag stale when verify is newer than edits", () => {
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG },
      {
        editCount: 2,
        lastVerificationCommand: "npm test",
        lastVerificationAt: "2026-04-10T12:10:00.000Z",
        lastEditAt: "2026-04-10T12:00:00.000Z",
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(!w.some((x) => /staleLastVerification/i.test(x)));
  });

  it("flags FORGE_VERIFY_HINT=0", () => {
    const prev = process.env.FORGE_VERIFY_HINT;
    process.env.FORGE_VERIFY_HINT = "0";
    try {
      const w = productionWarningsForRun(
        { ...DEFAULT_CONFIG },
        {
          _testDirtyFiles: 0,
          _testSessionCount: 0,
          _testPinnedCount: 0,
        },
      );
      assert.ok(w.some((x) => /FORGE_VERIFY_HINT=0/i.test(x)));
    } finally {
      if (prev === undefined) delete process.env.FORGE_VERIFY_HINT;
      else process.env.FORGE_VERIFY_HINT = prev;
    }
  });
});
