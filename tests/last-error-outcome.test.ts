import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isLastErrorProblem,
  LAST_ERROR_OUTCOME_CODES,
} from "../src/session/last-error.js";
import {
  collectStatusIssues,
  formatStatusVerdict,
} from "../src/tui/status-card.js";
import {
  createSession,
  setSessionLastError,
  formatSessionPickerRow,
  sessionPickerProblem,
} from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("isLastErrorProblem", () => {
  it("treats provider failures as problems", () => {
    assert.equal(
      isLastErrorProblem({ code: "rate_limited", message: "xai HTTP 429" }),
      true,
    );
    assert.equal(
      isLastErrorProblem({ code: "ulw_stuck_wall", message: "no progress" }),
      true,
    );
  });

  it("treats ulw_cycle_complete as a finished job, not a crash", () => {
    assert.ok(LAST_ERROR_OUTCOME_CODES.has("ulw_cycle_complete"));
    assert.equal(
      isLastErrorProblem({
        code: "ulw_cycle_complete",
        message: "ULW last cycle attested complete — released.",
      }),
      false,
    );
    assert.equal(isLastErrorProblem(undefined), false);
    assert.equal(isLastErrorProblem({ code: "", message: "" }), false);
  });
});

describe("status + picker after Cycle complete", () => {
  function tmpHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-last-err-out-"));
    process.env.FORGE_HOME = dir;
    return dir;
  }

  it("/status is ok when lastError is only a successful wrap", () => {
    tmpHome();
    const session = createSession({
      cwd: "/tmp",
      provider: "xai",
      model: "grok-4",
    });
    setSessionLastError(session, {
      code: "ulw_cycle_complete",
      message: "ULW last cycle attested complete — released.",
      tips: ["/cycle 1"],
    });
    const issues = collectStatusIssues({
      config: { ...DEFAULT_CONFIG, contextWindow: 500_000, workspace: "/tmp" },
      session,
    });
    assert.equal(issues.length, 0);
    assert.equal(
      strip(formatStatusVerdict(issues, { color: false })),
      "status  ·  ok",
    );
  });

  it("rate_limited still opens /status on lastErr", () => {
    tmpHome();
    const session = createSession({
      cwd: "/tmp",
      provider: "xai",
      model: "grok-4",
    });
    setSessionLastError(session, {
      code: "rate_limited",
      message: "xai HTTP 429",
      tips: ["forge accounts switch"],
    });
    const issues = collectStatusIssues({
      config: { ...DEFAULT_CONFIG, contextWindow: 500_000, workspace: "/tmp" },
      session,
    });
    assert.equal(issues[0]?.kind, "lastErr");
  });

  it("picker stays title-first after Cycle complete (no red problem)", () => {
    tmpHome();
    const s = createSession({
      cwd: "/tmp",
      provider: "xai",
      model: "grok-4.6",
      title: "evaluate then improve",
    });
    s.meta.lastError = {
      at: "t",
      code: "ulw_cycle_complete",
      message: "ULW last cycle attested complete — released.",
    };
    assert.equal(sessionPickerProblem(s.meta), "");
    const row = strip(formatSessionPickerRow(s.meta, [], 100));
    const titleAt = row.indexOf("evaluate then improve");
    const idAt = row.indexOf(s.meta.id.slice(0, 8));
    assert.ok(titleAt >= 0 && titleAt < idAt, row);
    assert.doesNotMatch(row, /ulw_cycle_complete/);
    assert.doesNotMatch(row, /released/);
  });

  it("/sessions errors lists 429s, not Cycle complete", async () => {
    const tmp = tmpHome();
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { saveSession } = await import("../src/session/session.js");
    const good = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "cycle-done",
    });
    setSessionLastError(good, {
      code: "ulw_cycle_complete",
      message: "ULW last cycle attested complete — released.",
    });
    saveSession(good);
    const bad = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "rate-fail",
    });
    setSessionLastError(bad, {
      code: "rate_limited",
      message: "xai HTTP 429",
    });
    saveSession(bad);
    const r = await handleSlash("/sessions errors", {
      session: good,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks: new HookRunner(DEFAULT_CONFIG, tmp),
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "");
    assert.match(out, /rate-fail/);
    assert.doesNotMatch(out, /cycle-done/);
  });

  it("prune may drop a Cycle complete session (it is not a failure backlog)", async () => {
    const tmp = tmpHome();
    const { saveSession, pruneSessions, listSessions } = await import(
      "../src/session/session.js"
    );
    const done = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "cycle-done",
    });
    setSessionLastError(done, {
      code: "ulw_cycle_complete",
      message: "ULW last cycle attested complete — released.",
    });
    done.meta.updatedAt = new Date(Date.now() - 90 * 86400_000).toISOString();
    saveSession(done);
    const r = pruneSessions({ keep: 0, maxAgeDays: 1 });
    assert.equal(r.skippedLastError, 0);
    assert.ok(!listSessions(100).some((m) => m.id === done.meta.id));
  });
});
