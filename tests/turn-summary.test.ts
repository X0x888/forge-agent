import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatTurnChangeSummary,
  formatTurnChangeSummaryForSession,
  composeTurnCloser,
  formatRunStopReason,
  formatUserTurnOpen,
  formatAssistantTurnOpen,
} from "../src/tui/turn-summary.js";
import { visibleWidth } from "../src/util/format.js";
import {
  appendFileMutation,
  type FileMutation,
} from "../src/session/mutations.js";
import type { SessionData } from "../src/session/session.js";

const CWD = "/repo";
const mut = (
  p: string,
  kind: FileMutation["kind"] = "update",
): FileMutation => ({ path: p, kind, turn: 5, ts: "2026-01-01T00:00:00Z" });

const baseMeta = {
  lastVerificationCommand: undefined,
  lastVerificationAt: undefined,
  lastEditAt: undefined,
  editCount: 1,
} as never;

test("turn summary: silent when nothing edited", () => {
  assert.equal(formatTurnChangeSummary([], CWD, baseMeta), null);
});

test("turn summary: files relative to cwd, new files labeled, unverified flagged", () => {
  const line = formatTurnChangeSummary(
    [mut("/repo/src/a.ts"), mut("/repo/src/b.ts", "create")],
    CWD,
    baseMeta,
  );
  assert.ok(line);
  assert.match(line, /Δ 2 files: src\/a\.ts, src\/b\.ts \(new\)/);
  assert.match(line, /verify: none — edits unverified/);
});

test("turn summary: unverified names the preferred project check", () => {
  const line = formatTurnChangeSummary(
    [mut("/repo/src/a.ts")],
    CWD,
    baseMeta,
    "npm run typecheck",
  );
  assert.match(line!, /verify: none — run npm run typecheck/);
  assert.doesNotMatch(line!, /edits unverified/);
});

test("turn summary: paths outside cwd stay absolute", () => {
  const line = formatTurnChangeSummary([mut("/etc/x.conf")], CWD, baseMeta);
  assert.match(line!, /Δ 1 file: \/etc\/x\.conf/);
});

test("turn summary: more than six files collapse into +N more", () => {
  const prevCols = process.stdout.columns;
  const prevTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "columns", {
    value: 120,
    configurable: true,
  });
  try {
    const edits = Array.from({ length: 8 }, (_, i) => mut(`/repo/f${i}.ts`));
    const line = formatTurnChangeSummary(edits, CWD, baseMeta)!;
    assert.match(line, /\+2 more/);
    assert.doesNotMatch(line, /f6\.ts/);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      value: prevTty,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: prevCols,
      configurable: true,
    });
  }
});

test("turn summary: fresh verification shows ✓, stale shows predates-last-edit", () => {
  const fresh = formatTurnChangeSummary([mut("/repo/a.ts")], CWD, {
    lastVerificationCommand: "npm test",
    lastVerificationAt: "2026-01-01T00:10:00Z",
    lastEditAt: "2026-01-01T00:05:00Z",
    editCount: 2,
  } as never)!;
  assert.match(fresh, /verify: npm test ✓/);

  const stale = formatTurnChangeSummary([mut("/repo/a.ts")], CWD, {
    lastVerificationCommand: "npm test",
    lastVerificationAt: "2026-01-01T00:01:00Z",
    lastEditAt: "2026-01-01T00:05:00Z",
    editCount: 2,
  } as never)!;
  assert.match(stale, /verify: npm test \(stale — predates last edit\)/);
});

test("turn summary: clips to one TTY row and keeps verify", () => {
  const prevCols = process.stdout.columns;
  const prevTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "columns", {
    value: 48,
    configurable: true,
  });
  try {
    const edits = Array.from({ length: 8 }, (_, i) =>
      mut(`/repo/very/long/path/to/source/file-${i}.ts`),
    );
    const line = formatTurnChangeSummary(edits, CWD, baseMeta)!;
    assert.ok(!line.includes("\n"));
    assert.ok(visibleWidth(line) <= 48);
    assert.match(line, /Δ 8 files:/);
    assert.match(line, /verify:/);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      value: prevTty,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: prevCols,
      configurable: true,
    });
  }
});

test("turn summary: session shim only includes edits after turnAtStart", () => {
  const prevHome = process.env.FORGE_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-turn-sum-"));
  process.env.FORGE_HOME = tmp;
  try {
    const sid = "sess-turn-sum";
    fs.mkdirSync(path.join(tmp, "sessions", sid), { recursive: true });
    appendFileMutation(sid, {
      path: "/repo/old.ts",
      kind: "update",
      turn: 3,
      before: "old",
    });
    appendFileMutation(sid, {
      path: "/repo/src/a.ts",
      kind: "update",
      turn: 5,
      before: "a",
    });
    appendFileMutation(sid, {
      path: "/repo/src/b.ts",
      kind: "create",
      turn: 5,
    });
    const session = {
      meta: {
        id: sid,
        cwd: "/repo",
        lastVerificationCommand: undefined,
        lastVerificationAt: undefined,
        lastEditAt: undefined,
        editCount: 2,
      },
    } as SessionData;
    const line = formatTurnChangeSummaryForSession(session, 4);
    assert.ok(line);
    assert.match(line, /Δ 2 files: src\/a\.ts, src\/b\.ts \(new\)/);
    assert.doesNotMatch(line, /old\.ts/);
    assert.equal(formatTurnChangeSummaryForSession(session, 5), null);
  } finally {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composeTurnCloser: delta-only when footer is just the rule", () => {
  const delta = "Δ 1 file: src/a.ts · verify: none — edits unverified";
  assert.equal(composeTurnCloser("──", delta), delta);
  assert.equal(composeTurnCloser("\u001b[2m──\u001b[0m", delta), delta);
});

test("composeTurnCloser: joins health + Δ on a wide TTY", () => {
  const prevCols = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    value: 160,
    configurable: true,
  });
  try {
    const joined = composeTurnCloser(
      "──  turn in=1.2k out=400 ~$0.01  harness on",
      "Δ 1 file: src/a.ts · verify: none — run npm test",
    );
    assert.match(joined, /turn in=/);
    assert.match(joined, /Δ 1 file/);
    assert.doesNotMatch(joined, /\n/);
  } finally {
    Object.defineProperty(process.stdout, "columns", {
      value: prevCols,
      configurable: true,
    });
  }
});

test("composeTurnCloser: stacks on a narrow TTY instead of clipping Δ", () => {
  const prevCols = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    value: 48,
    configurable: true,
  });
  try {
    const stacked = composeTurnCloser(
      "──  turn in=12.4k out=3.1k ~$0.42  harness on",
      "Δ 2 files: src/a.ts, src/b.ts (new) · verify: none — run npm run typecheck",
    );
    assert.match(stacked, /\n/);
    const [health, delta] = stacked.split("\n");
    assert.match(health, /turn in=/);
    assert.match(delta, /Δ 2 files/);
    assert.match(delta, /typecheck/);
  } finally {
    Object.defineProperty(process.stdout, "columns", {
      value: prevCols,
      configurable: true,
    });
  }
});

test("run stop reason: silent on a clean Stop", () => {
  assert.equal(formatRunStopReason({}), null);
  assert.equal(formatRunStopReason({ stopContinues: 2 }), null);
});

test("run stop reason: cost / turns / continue-cap / empty / abort", () => {
  assert.match(formatRunStopReason({ hitCostCap: true }) ?? "", /cost cap/);
  assert.match(formatRunStopReason({ hitMaxTurns: true }) ?? "", /max turns/);
  assert.match(
    formatRunStopReason({ releasedOnContinueCap: true, stopContinues: 3 }) ?? "",
    /continue-cap after 3 harness continues/,
  );
  assert.match(
    formatRunStopReason({ lastErrorCode: "empty_run" }) ?? "",
    /empty run/,
  );
  assert.match(formatRunStopReason({ aborted: true }) ?? "", /aborted/);
  assert.match(
    formatRunStopReason({ lastErrorCode: "handoff_released" }) ?? "",
    /handoff-guard/,
  );
  // Flags win over lastError
  assert.match(
    formatRunStopReason({
      hitCostCap: true,
      lastErrorCode: "handoff_released",
    }) ?? "",
    /cost cap/,
  );
});

test("run stop reason: forge run prints the shared closer after empty_run stamp", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/cli.ts"),
    "utf8",
  );
  const emptyStamp = src.indexOf('code: "empty_run"');
  const print = src.indexOf("formatRunStopReason({");
  assert.ok(emptyStamp > 0, "empty_run stamp missing");
  assert.ok(print > emptyStamp, "stop closer must print after empty_run stamp");
});

test("user turn open: silent on empty, clips, queues", () => {
  assert.equal(formatUserTurnOpen(""), null);
  assert.equal(formatUserTurnOpen("   \n\t  "), null);
  const line = formatUserTurnOpen("fix the login bug", { width: 80 });
  assert.equal(line, "you › fix the login bug");
  const queued = formatUserTurnOpen("also run tests", {
    width: 80,
    queued: 2,
  });
  assert.equal(queued, "you › also run tests  ·  queued q:2");
  const collapsed = formatUserTurnOpen("line one\n\nline two", { width: 80 });
  assert.equal(collapsed, "you › line one line two");
  const clipped = formatUserTurnOpen("abcdefghij", { width: 12 });
  assert.ok(clipped);
  assert.ok(clipped.startsWith("you › "));
  assert.ok(clipped.endsWith("…"));
  assert.ok(visibleWidth(clipped) <= 12);
});

test("assistant turn open pairs with you ›", () => {
  assert.equal(formatAssistantTurnOpen({ color: false }), "forge ›");
  const styled = formatAssistantTurnOpen({ color: true });
  assert.match(styled, /forge ›/);
  assert.ok(styled.includes("\x1b["), "TTY label should be dim");
});
