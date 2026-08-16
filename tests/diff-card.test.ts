import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDiffReviewCard,
  parseGitStat,
  parsePorcelainFiles,
  porcelainLetter,
} from "../src/tui/diff-card.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("porcelainLetter", () => {
  it("reads XY columns without trimming the leading space", () => {
    assert.equal(porcelainLetter(" M"), "M");
    assert.equal(porcelainLetter("M "), "M");
    assert.equal(porcelainLetter("??"), "?");
    assert.equal(porcelainLetter("A "), "A");
    assert.equal(porcelainLetter("D "), "D");
    assert.equal(porcelainLetter("R "), "R");
    assert.equal(porcelainLetter("UU"), "U");
  });
});

describe("parsePorcelainFiles", () => {
  it("keeps unstaged-only paths (leading space)", () => {
    const files = parsePorcelainFiles(" M src/agent/worktree.ts\n?? tests/diff-card.test.ts\n");
    assert.deepEqual(
      files.map((f) => [f.letter, f.path, f.untracked]),
      [
        ["M", "src/agent/worktree.ts", false],
        ["?", "tests/diff-card.test.ts", true],
      ],
    );
  });
});

describe("parseGitStat", () => {
  it("reads per-file bars and the summary line", () => {
    const s = parseGitStat(
      [
        " src/foo.ts | 12 ++++++++----",
        " src/bar.ts |  3 +++",
        " 2 files changed, 11 insertions(+), 4 deletions(-)",
      ].join("\n"),
    );
    assert.equal(s.fileCount, 2);
    assert.equal(s.insertions, 11);
    assert.equal(s.deletions, 4);
    assert.deepEqual(s.files.get("src/foo.ts"), { added: 8, removed: 4 });
    assert.deepEqual(s.files.get("src/bar.ts"), { added: 3, removed: 0 });
  });
});

describe("formatDiffReviewCard", () => {
  it("clean tree is a designed empty state, not status: clean", () => {
    const card = strip(
      formatDiffReviewCard({
        porcelain: "",
        stat: "",
        wantPatch: false,
        checkCommands: ["npm run typecheck", "npm test"],
        columns: 80,
      }),
    );
    assert.match(card, /Nothing to review — tree clean/);
    assert.match(card, /verify: npm run typecheck · npm test/);
    assert.match(card, /\/last/);
    assert.doesNotMatch(card, /status: clean/);
    assert.doesNotMatch(card, /\/diff --full/);
  });

  it("dirty tree lists letters, counts, verify, and the --full hint", () => {
    const card = strip(
      formatDiffReviewCard({
        porcelain: " M src/commands/slash.ts\n?? tests/diff-card.test.ts\n",
        stat: [
          " src/commands/slash.ts | 12 ++++++++----",
          " 1 file changed, 8 insertions(+), 4 deletions(-)",
        ].join("\n"),
        wantPatch: false,
        checkCommands: ["npm test"],
        lastVerification: { command: "npm test", ok: true, stale: false },
        columns: 80,
      }),
    );
    assert.match(card, /Δ 2 files/);
    assert.match(card, /\+8/);
    assert.match(card, /−4/);
    assert.match(card, /M {2}src\/commands\/slash\.ts/);
    assert.match(card, /\? {2}tests\/diff-card\.test\.ts {2}new/);
    assert.match(card, /verify: npm test ✓/);
    assert.match(card, /\/diff --full/);
    assert.doesNotMatch(card, /^diff --git /m);
  });

  it("stale verify is a yellow callout", () => {
    const card = strip(
      formatDiffReviewCard({
        porcelain: " M src/a.ts\n",
        stat: " src/a.ts | 2 ++\n 1 file changed, 2 insertions(+)",
        wantPatch: false,
        lastVerification: { command: "npm test", ok: true, stale: true },
        columns: 80,
      }),
    );
    assert.match(card, /verify: npm test \(stale — predates last edit\)/);
  });

  it("--full paints the patch and drops the --full hint", () => {
    const card = formatDiffReviewCard({
      porcelain: " M src/a.ts\n",
      stat: " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
      wantPatch: true,
      patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      columns: 80,
    });
    const plain = strip(card);
    assert.match(plain, /\+new/);
    assert.match(plain, /-old/);
    assert.doesNotMatch(plain, /↳ \/diff --full/);
  });

  it("clips each row to the TTY width", () => {
    const long = `src/${"very-long-directory-name/".repeat(6)}file.ts`;
    const card = formatDiffReviewCard({
      porcelain: ` M ${long}\n`,
      stat: "",
      wantPatch: false,
      columns: 40,
    });
    for (const row of card.split("\n")) {
      assert.ok(
        strip(row).length <= 40 + 4,
        `row too wide: ${JSON.stringify(strip(row))}`,
      );
    }
  });
});
