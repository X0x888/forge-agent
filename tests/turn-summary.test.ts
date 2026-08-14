import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTurnChangeSummary } from "../src/tui/turn-summary.js";
import { visibleWidth } from "../src/util/format.js";
import type { FileMutation } from "../src/session/mutations.js";

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
