import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessStaleDist,
  checkoutRootFromArgv,
  detectRunningFromDist,
  isStaleDistBinary,
} from "../src/util/stale-dist.js";
import { formatDoctorCloser } from "../src/tui/doctor-card.js";

describe("stale dist vs src/cli.ts", () => {
  it("is stale only when running dist older than src", () => {
    assert.equal(
      isStaleDistBinary({
        runningFromDist: true,
        distMtimeMs: 100,
        srcMtimeMs: 200,
      }),
      true,
    );
    assert.equal(
      isStaleDistBinary({
        runningFromDist: true,
        distMtimeMs: 300,
        srcMtimeMs: 200,
      }),
      false,
    );
    assert.equal(
      isStaleDistBinary({
        runningFromDist: true,
        distMtimeMs: 200,
        srcMtimeMs: 200,
      }),
      false,
    );
    assert.equal(
      isStaleDistBinary({
        runningFromDist: false,
        distMtimeMs: 100,
        srcMtimeMs: 200,
      }),
      false,
    );
    assert.equal(
      isStaleDistBinary({
        runningFromDist: true,
        distMtimeMs: null,
        srcMtimeMs: 200,
      }),
      false,
    );
  });

  it("detects PATH dist/cli.js and ignores tsx src/cli.ts", () => {
    assert.equal(
      detectRunningFromDist(["node", "/repo/dist/cli.js", "doctor"]),
      true,
    );
    assert.equal(
      detectRunningFromDist(["node", "/usr/bin/tsx", "/repo/src/cli.ts", "doctor"]),
      false,
    );
    assert.equal(
      detectRunningFromDist(["node", "/repo/src/cli.ts", "help"]),
      false,
    );
    assert.equal(
      checkoutRootFromArgv(["node", "/repo/dist/cli.js"]),
      "/repo",
    );
  });

  it("assessStaleDist stubs mtimes: dist older is stale, tsx is not", () => {
    assert.equal(
      assessStaleDist({
        argv: ["node", "/repo/dist/cli.js", "doctor"],
        distMtimeMs: 1,
        srcMtimeMs: 2,
      }).stale,
      true,
    );
    assert.equal(
      assessStaleDist({
        argv: ["node", "/repo/dist/cli.js", "doctor"],
        distMtimeMs: 3,
        srcMtimeMs: 2,
      }).stale,
      false,
    );
    assert.equal(
      assessStaleDist({
        argv: ["node", "/usr/bin/tsx", "/repo/src/cli.ts", "doctor"],
        distMtimeMs: 1,
        srcMtimeMs: 2,
      }).stale,
      false,
    );
  });

  it("CLI doctor Next is bash install.sh; REPL closer omits it", () => {
    const recs = [
      {
        id: "stale-dist",
        severity: "hygiene" as const,
        detail: "Built dist/cli.js is older than src/cli.ts — PATH forge lags this checkout",
        cliAction: "bash install.sh",
      },
    ];
    const cli = formatDoctorCloser([], {
      surface: "cli",
      recommendations: recs,
    });
    assert.match(cli, /bash install\.sh/);
    const repl = formatDoctorCloser([], { recommendations: recs });
    assert.doesNotMatch(repl, /bash install\.sh/);
  });
});
