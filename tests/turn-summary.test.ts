import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTurnChangeSummary } from "../src/tui/turn-summary.js";
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

test("turn summary: paths outside cwd stay absolute", () => {
  const line = formatTurnChangeSummary([mut("/etc/x.conf")], CWD, baseMeta);
  assert.match(line!, /Δ 1 file: \/etc\/x\.conf/);
});

test("turn summary: more than six files collapse into +N more", () => {
  const edits = Array.from({ length: 8 }, (_, i) => mut(`/repo/f${i}.ts`));
  const line = formatTurnChangeSummary(edits, CWD, baseMeta)!;
  assert.match(line, /\+2 more/);
  assert.doesNotMatch(line, /f6\.ts/);
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
