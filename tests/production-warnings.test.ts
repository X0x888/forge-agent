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

  it("flags FORGE_UNCHANGED_READ_STUB=0", () => {
    const prev = process.env.FORGE_UNCHANGED_READ_STUB;
    process.env.FORGE_UNCHANGED_READ_STUB = "0";
    try {
      const w = productionWarningsForRun(
        { ...DEFAULT_CONFIG },
        {
          _testDirtyFiles: 0,
          _testSessionCount: 0,
          _testPinnedCount: 0,
        },
      );
      assert.ok(w.some((x) => /FORGE_UNCHANGED_READ_STUB=0/i.test(x)));
    } finally {
      if (prev === undefined) delete process.env.FORGE_UNCHANGED_READ_STUB;
      else process.env.FORGE_UNCHANGED_READ_STUB = prev;
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

  it("normalizes permission aliases (yolo/deny) before warning", () => {
    const yolo = productionWarningsForRun(
      { ...DEFAULT_CONFIG, permissionMode: "yolo" as any },
      {
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(
      yolo.some((x) => /permissionMode=bypassPermissions \(yolo\)/i.test(x)),
      "yolo alias must warn like bypassPermissions",
    );

    const deny = productionWarningsForRun(
      { ...DEFAULT_CONFIG, permissionMode: "deny" as any },
      {
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(
      deny.some((x) => /permissionMode=dontAsk/i.test(x)),
      "deny alias must warn like dontAsk",
    );
  });

  it("normalizes sandbox off aliases (none/false/0) before warning", () => {
    for (const alias of ["none", "false", "0"] as const) {
      const w = productionWarningsForRun(
        { ...DEFAULT_CONFIG, sandbox: alias as any },
        {
          _testDirtyFiles: 0,
          _testSessionCount: 0,
          _testPinnedCount: 0,
        },
      );
      assert.ok(
        w.some((x) => /sandbox=off/i.test(x)),
        `sandbox=${alias} must warn like sandbox=off`,
      );
    }
  });


  it("warns when subagent land=discard and auto-verify off", () => {
    const prevLand = process.env.FORGE_SUBAGENT_LAND;
    const prevNudge = process.env.FORGE_AUTO_VERIFY_NUDGE;
    const prevFix = process.env.FORGE_FIX_UNTIL_GREEN;
    const prevCp = process.env.FORGE_ULW_CHECKPOINT;
    const prevAc = process.env.FORGE_ULW_AUTO_COMMIT;
    process.env.FORGE_SUBAGENT_LAND = "discard";
    process.env.FORGE_AUTO_VERIFY_NUDGE = "0";
    process.env.FORGE_FIX_UNTIL_GREEN = "0";
    process.env.FORGE_ULW_CHECKPOINT = "0";
    process.env.FORGE_ULW_AUTO_COMMIT = "0";
    try {
      const w = productionWarningsForRun(
        { ...DEFAULT_CONFIG },
        {
          ultrawork: true,
          _testDirtyFiles: 0,
          _testSessionCount: 0,
          _testPinnedCount: 0,
        },
      );
      assert.ok(
        w.some((x) => /FORGE_SUBAGENT_LAND=discard/i.test(x)),
        "land=discard should warn",
      );
      assert.ok(
        w.some((x) => /FORGE_AUTO_VERIFY_NUDGE=0/i.test(x)),
        "auto-verify off should warn",
      );
      assert.ok(
        w.some((x) => /FORGE_FIX_UNTIL_GREEN=0/i.test(x)),
        "fix-until-green off should warn",
      );
      assert.ok(
        w.some((x) => /FORGE_ULW_CHECKPOINT=0/i.test(x)),
        "ulw checkpoint off should warn under ULW",
      );
      assert.ok(
        w.some((x) => /FORGE_ULW_AUTO_COMMIT=0/i.test(x)),
        "ulw auto-commit off should warn under ULW",
      );
    } finally {
      if (prevLand === undefined) delete process.env.FORGE_SUBAGENT_LAND;
      else process.env.FORGE_SUBAGENT_LAND = prevLand;
      if (prevNudge === undefined) delete process.env.FORGE_AUTO_VERIFY_NUDGE;
      else process.env.FORGE_AUTO_VERIFY_NUDGE = prevNudge;
      if (prevFix === undefined) delete process.env.FORGE_FIX_UNTIL_GREEN;
      else process.env.FORGE_FIX_UNTIL_GREEN = prevFix;
      if (prevCp === undefined) delete process.env.FORGE_ULW_CHECKPOINT;
      else process.env.FORGE_ULW_CHECKPOINT = prevCp;
      if (prevAc === undefined) delete process.env.FORGE_ULW_AUTO_COMMIT;
      else process.env.FORGE_ULW_AUTO_COMMIT = prevAc;
    }
  });

});
