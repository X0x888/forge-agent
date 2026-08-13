import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expandUserMentions,
  extractPathMentions,
} from "../src/util/user-mentions.js";
import { FileReadState } from "../src/agent/tools/file-read-state.js";
import { completeAtMention, forgeCompleter } from "../src/tui/complete.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("user @path mentions", () => {
  it("extracts workspace-relative files and skips images / traversal", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mention-"));
    const hits = extractPathMentions(
      "look at @src/cli.ts and @shot.png and @../etc/passwd and @/etc/hosts",
      tmp,
    );
    assert.deepEqual(
      hits.map((h) => h.rel),
      ["src/cli.ts"],
    );
    const quoted = extractPathMentions(
      'see @"src/foo bar.ts" and @\'docs/a.md\'',
      tmp,
    );
    assert.deepEqual(
      quoted.map((h) => h.rel),
      ["src/foo bar.ts", "docs/a.md"],
    );
  });

  it("inlines file contents and stamps FileReadState", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mention-"));
    fs.mkdirSync(path.join(tmp, "src"));
    fs.writeFileSync(path.join(tmp, "src", "cli.ts"), "export const x = 1;\n");
    const reads = new FileReadState();
    const out = expandUserMentions("fix @src/cli.ts please", tmp, reads);
    assert.match(out, /User @path mentions/);
    assert.match(out, /export const x = 1;/);
    assert.match(out, /--- @src\/cli\.ts ---/);
    assert.ok(reads.get(path.join(tmp, "src", "cli.ts")));
    const again = expandUserMentions(out, tmp, reads);
    assert.equal(again, out);
    const resumed = new FileReadState();
    expandUserMentions(out, tmp, resumed);
    assert.ok(resumed.get(path.join(tmp, "src", "cli.ts")));
  });

  it("does not inline missing or binary files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mention-"));
    fs.writeFileSync(path.join(tmp, "a.bin"), Buffer.from([0, 1, 2, 0]));
    const missing = expandUserMentions("see @nope.ts", tmp);
    assert.equal(missing, "see @nope.ts");
    const bin = expandUserMentions("see @a.bin", tmp);
    assert.equal(bin, "see @a.bin");
  });

  it("tab-completes @src/cli from workspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-at-"));
    fs.mkdirSync(path.join(tmp, "src"));
    fs.writeFileSync(path.join(tmp, "src", "cli.ts"), "");
    fs.writeFileSync(path.join(tmp, "src", "cli.test.ts"), "");
    const [hits] = completeAtMention("please read @src/cli", tmp)!;
    assert.ok(hits.some((h) => h === "@src/cli.ts"));
    assert.ok(hits.some((h) => h === "@src/cli.test.ts"));
    const [viaRepl] = forgeCompleter("please read @src/cli", {
      ...DEFAULT_CONFIG,
      workspace: tmp,
    });
    assert.ok(viaRepl.some((h) => h === "@src/cli.ts"));
  });

  it("refuses @../ traversal in completer", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-at-"));
    assert.equal(completeAtMention("x @../secret", tmp), null);
  });
});
