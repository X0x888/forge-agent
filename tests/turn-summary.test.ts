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
  formatThinkingTurnOpen,
} from "../src/tui/turn-summary.js";
import { visibleWidth } from "../src/util/format.js";
import { createMarkdownRenderer } from "../src/tui/markdown.js";
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

test("turn summary: a failed check shows ✗, not verify: none", () => {
  const line = formatTurnChangeSummary([mut("/repo/a.ts")], CWD, {
    lastVerificationCommand: "npm test",
    lastVerificationAt: "2026-01-01T00:10:00Z",
    lastVerificationOk: false,
    lastEditAt: "2026-01-01T00:05:00Z",
    editCount: 2,
  } as never)!;
  assert.match(line, /verify: npm test ✗/);
  assert.doesNotMatch(line, /verify: none/);
});

test("turn summary: unverified verify sits on its own line", () => {
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
    const card = formatTurnChangeSummary(edits, CWD, baseMeta)!;
    const rows = card.split("\n");
    assert.equal(rows.length, 2);
    assert.ok(visibleWidth(rows[0]!) <= 48);
    assert.ok(visibleWidth(rows[1]!) <= 48);
    assert.match(rows[0]!, /Δ 8 files:/);
    assert.match(rows[1]!, /verify:/);
    const ok = formatTurnChangeSummary(edits, CWD, {
      lastVerificationCommand: "npm test",
      lastVerificationAt: "2026-01-01T00:10:00Z",
      lastEditAt: "2026-01-01T00:05:00Z",
      editCount: 2,
    } as never)!;
    assert.ok(!ok.includes("\n"));
    assert.match(ok, /verify: npm test ✓/);
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
    formatRunStopReason({ lastErrorCode: "thought_only_cap" }) ?? "",
    /thought-only/,
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
  assert.match(
    formatRunStopReason({ stuckReleased: true }) ?? "",
    /stuck-wall/,
  );
  assert.match(
    formatRunStopReason({ lastCycleReleased: true }) ?? "",
    /cycle complete/,
  );
  assert.match(
    formatRunStopReason({ lastCycleSatDown: true }) ?? "",
    /wrap sat down/,
  );
  assert.match(
    formatRunStopReason({ lastErrorCode: "ulw_stuck_wall" }) ?? "",
    /stuck-wall/,
  );
  // Flags win over lastError
  assert.match(
    formatRunStopReason({
      hitCostCap: true,
      lastErrorCode: "handoff_released",
    }) ?? "",
    /cost cap/,
  );
  // Provider lastError used to be silent — now a Next closer
  assert.match(
    formatRunStopReason({ lastErrorCode: "rate_limited" }) ?? "",
    /Next  \/accounts/,
  );
  assert.match(
    formatRunStopReason({ lastErrorCode: "auth_expired" }) ?? "",
    /Next  \/auth/,
  );
  assert.equal(formatRunStopReason({ lastErrorCode: "" }), null);
});

test("run stop reason: REPL default is slash keys, never a CLI dump", () => {
  const dump = /forge\s|FORGE_|--max-cost|--continue/;
  const cases: Parameters<typeof formatRunStopReason>[0][] = [
    { aborted: true },
    { hitCostCap: true },
    { hitMaxTurns: true },
    { releasedOnContinueCap: true, stopContinues: 3 },
    { lastErrorCode: "empty_run" },
    { lastErrorCode: "max_run_ms" },
    { lastErrorCode: "max_cost" },
    { lastErrorCode: "max_turns" },
    { lastErrorCode: "continue_cap_stop" },
    { lastErrorCode: "rate_limited" },
  ];
  for (const input of cases) {
    const line = formatRunStopReason(input) ?? "";
    assert.doesNotMatch(line, dump, JSON.stringify(input));
  }
  assert.match(formatRunStopReason({ aborted: true }) ?? "", /\/retry/);
  assert.match(formatRunStopReason({ hitCostCap: true }) ?? "", /\/budget/);
  assert.match(
    formatRunStopReason({ lastErrorCode: "empty_run" }) ?? "",
    /\/doctor/,
  );
  assert.match(
    formatRunStopReason({ lastErrorCode: "empty_run" }) ?? "",
    /\/auth/,
  );
});

test("run stop reason: headless surface keeps CLI verbs", () => {
  assert.match(
    formatRunStopReason({ aborted: true, surface: "run" }) ?? "",
    /forge run --continue/,
  );
  assert.match(
    formatRunStopReason({ hitCostCap: true, surface: "run" }) ?? "",
    /FORGE_MAX_COST_USD/,
  );
  assert.match(
    formatRunStopReason({ lastErrorCode: "empty_run", surface: "run" }) ?? "",
    /forge doctor/,
  );
  assert.match(
    formatRunStopReason({ lastErrorCode: "rate_limited", surface: "run" }) ?? "",
    /forge accounts switch|forge run --continue/,
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
  const block = src.slice(print, print + 500);
  assert.match(block, /surface:\s*"run"/);
  const repl = fs.readFileSync(
    path.join(process.cwd(), "src/tui/repl.ts"),
    "utf8",
  );
  const replPrint = repl.indexOf("formatRunStopReason({");
  assert.ok(replPrint > 0, "REPL stop closer missing");
  assert.match(repl.slice(replPrint, replPrint + 500), /surface:\s*"repl"/);
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

test("NO_COLOR wins over color:true on the forced-chalk surfaces", () => {
  // `forge ›` and `think ›` build a Chalk instance at
  // `Math.max(chalk.level, 1)` because chalk under-detects some real TTYs.
  // That max also undid NO_COLOR: log.ts sets FORCE_COLOR=0, chalk falls to
  // level 0, and the max put it straight back to 1. The streamed markdown
  // renderer did the same on every assistant message.
  const prior = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = "1";
    const open = formatAssistantTurnOpen({ color: true });
    assert.equal(open, "forge ›");
    const think = formatThinkingTurnOpen({ chars: 400, elapsedSec: 3, color: true });
    assert.ok(think);
    assert.ok(!think!.includes("\x1b["), JSON.stringify(think));
    // The markdown renderer keeps its layout and drops only the escapes.
    const r = createMarkdownRenderer({ color: true, width: 40 });
    const md = r.push("# Title\n\n- a **bold** item with `code`\n") + r.end();
    assert.ok(!md.includes("\x1b["), JSON.stringify(md));
    assert.match(md, /Title/);
    assert.match(md, /a bold item with code/);
  } finally {
    if (prior == null) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prior;
  }
  // Unset again: the same three surfaces still paint.
  assert.ok(formatAssistantTurnOpen({ color: true }).includes("\x1b["));
});
