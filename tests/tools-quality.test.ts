import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/agent/tools/index.js";
import { locateEdit, applyMatch } from "../src/agent/tools/edit-match.js";
import { createShellEnv } from "../src/agent/tools/env-policy.js";
import {
  editDistance,
  pathNotFoundHint,
} from "../src/agent/tools/path-hints.js";
import { boundToolOutput } from "../src/agent/tools/truncate.js";
import { realpathWithinRoot } from "../src/util/fs.js";
import { detectLineEnding, joinBom, splitBom, toLineEnding } from "../src/agent/tools/text.js";

let tmpRoot: string;

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-tools-"));
});

after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("edit-match", () => {
  it("matches exact once", () => {
    const content = "a\nhello world\nb\n";
    const r = locateEdit(content, "hello world", false);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.kind, "exact");
      const next = applyMatch(content, r.result, "hi world", false);
      assert.match(next, /hi world/);
    }
  });

  it("rejects ambiguous exact without replace_all", () => {
    const r = locateEdit("foo x foo", "foo", false);
    assert.equal(r.ok, false);
  });

  it("falls back to line-trimmed match", () => {
    const content = "function foo() {\n  return 1;\n}\n";
    const old = "function foo() {\nreturn 1;\n}"; // missing indent
    const r = locateEdit(content, old, false);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.kind, "line_trimmed");
      const next = applyMatch(content, r.result, "function foo() {\n  return 2;\n}", false);
      assert.match(next, /return 2/);
    }
  });
});

describe("text BOM/CRLF", () => {
  it("preserves BOM and CRLF", () => {
    const raw = "\uFEFFline1\r\nline2\r\n";
    const { bom, text } = splitBom(raw);
    assert.equal(bom, "\uFEFF");
    assert.equal(detectLineEnding(text), "\r\n");
    const edited = toLineEnding("line1\nline2x\n", "\r\n");
    const out = joinBom(edited, bom);
    assert.equal(out.startsWith("\uFEFF"), true);
    assert.match(out, /\r\n/);
  });
});

describe("env policy", () => {
  it("scrubs secret-looking names by default", () => {
    const env = createShellEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      OPENAI_API_KEY: "sk-secret",
      MY_TOKEN: "tok",
      NORMAL_VAR: "ok",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.NORMAL_VAR, "ok");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.MY_TOKEN, undefined);
  });

  it("core inherit keeps only core names", () => {
    const env = createShellEnv(
      { PATH: "/bin", CUSTOM: "x", HOME: "/h" },
      { inherit: "core", ignoreDefaultExcludes: true },
    );
    assert.equal(env.PATH, "/bin");
    assert.equal(env.HOME, "/h");
    assert.equal(env.CUSTOM, undefined);
  });
});

describe("managed truncation", () => {
  it("saves full output when over limit", async () => {
    process.env.FORGE_HOME = path.join(tmpRoot, "forge-home");
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const r = await boundToolOutput(big, { maxLines: 100, maxBytes: 10_000 });
    assert.equal(r.truncated, true);
    assert.ok(r.outputPath);
    assert.match(r.text, /Output truncated/);
    const full = await fsp.readFile(r.outputPath!, "utf8");
    assert.equal(full.split("\n").length, 3000);
  });
});

describe("realpath containment", () => {
  it("allows paths under workspace", async () => {
    const ws = path.join(tmpRoot, "ws");
    await fsp.mkdir(ws, { recursive: true });
    const f = path.join(ws, "a.txt");
    await fsp.writeFile(f, "x");
    const r = await realpathWithinRoot(ws, f);
    assert.equal(r.ok, true);
  });

  it("blocks symlink escape outside workspace", async () => {
    const ws = path.join(tmpRoot, "ws-sym");
    const outside = path.join(tmpRoot, "outside-secret");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(outside, "secret");
    const link = path.join(ws, "escape");
    try {
      await fsp.symlink(outside, link);
    } catch {
      // Windows without privilege — skip
      return;
    }
    const r = await realpathWithinRoot(ws, link);
    assert.equal(r.ok, false);
  });
});

describe("executeTool integration", () => {
  it("writes and reads with line numbers", async () => {
    const ws = path.join(tmpRoot, "ws-io");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };

    const w = await executeTool(
      "write_file",
      JSON.stringify({ path: "hello.ts", content: "const x = 1;\nconst y = 2;\n" }),
      ctx,
    );
    assert.equal(w.isError, undefined);

    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "hello.ts" }),
      ctx,
    );
    assert.equal(r.isError, undefined);
    assert.match(r.output, /1\|const x = 1;/);
    assert.match(r.output, /2\|const y = 2;/);
  });

  it("search_replace with line-trimmed fallback", async () => {
    const ws = path.join(tmpRoot, "ws-edit");
    await fsp.mkdir(ws, { recursive: true });
    const file = path.join(ws, "m.ts");
    await fsp.writeFile(file, "export function f() {\n  return 1;\n}\n");
    const ctx = { workspace: ws, sandbox: "off" as const };

    const e = await executeTool(
      "search_replace",
      JSON.stringify({
        path: "m.ts",
        old_string: "export function f() {\nreturn 1;\n}",
        new_string: "export function f() {\n  return 2;\n}",
      }),
      ctx,
    );
    assert.equal(e.isError, undefined, e.output);
    assert.match(e.output, /line_trimmed|Edited/);
    const body = await fsp.readFile(file, "utf8");
    assert.match(body, /return 2/);
  });

  it("grep finds content", async () => {
    const ws = path.join(tmpRoot, "ws-grep");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "a.ts"), "unique_token_xyz = 1\n");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const g = await executeTool(
      "grep",
      JSON.stringify({ pattern: "unique_token_xyz", path: ws }),
      ctx,
    );
    assert.equal(g.isError, undefined, g.output);
    assert.match(g.output, /unique_token_xyz/);
  });

  it("refuses write outside workspace", async () => {
    const ws = path.join(tmpRoot, "ws-bound");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const outside = path.join(tmpRoot, "nope.txt");
    const w = await executeTool(
      "write_file",
      JSON.stringify({ path: outside, content: "x" }),
      ctx,
    );
    assert.equal(w.isError, true);
    assert.match(w.output, /escapes workspace|write_file failed/i);
  });

  it("write_file creates parent dirs and notes it", async () => {
    const ws = path.join(tmpRoot, "ws-write-parents");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const w = await executeTool(
      "write_file",
      JSON.stringify({
        path: "nested/deep/file.ts",
        content: "export const n = 1;\n",
      }),
      ctx,
    );
    assert.equal(w.isError, undefined, w.output);
    assert.match(w.output, /Wrote nested\/deep\/file\.ts/);
    assert.match(w.output, /created parent directories/i);
    const body = await fsp.readFile(
      path.join(ws, "nested", "deep", "file.ts"),
      "utf8",
    );
    assert.match(body, /export const n = 1/);

    // Second write into existing parents — no parent note
    const w2 = await executeTool(
      "write_file",
      JSON.stringify({
        path: "nested/deep/file.ts",
        content: "export const n = 2;\n",
      }),
      ctx,
    );
    assert.equal(w2.isError, undefined, w2.output);
    assert.doesNotMatch(w2.output, /created parent directories/i);
  });

  it("write_file and search_replace refuse directory targets", async () => {
    const ws = path.join(tmpRoot, "ws-write-dir");
    await fsp.mkdir(path.join(ws, "subdir"), { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const w = await executeTool(
      "write_file",
      JSON.stringify({ path: "subdir", content: "nope" }),
      ctx,
    );
    assert.equal(w.isError, true);
    assert.match(w.output, /is a directory/i);
    assert.doesNotMatch(w.output, /EISDIR/i);

    const e = await executeTool(
      "search_replace",
      JSON.stringify({
        path: "subdir",
        old_string: "a",
        new_string: "b",
      }),
      ctx,
    );
    assert.equal(e.isError, true);
    assert.match(e.output, /is a directory/i);
  });

  it("path hints on missing read (typo distance)", async () => {
    const ws = path.join(tmpRoot, "ws-hint");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "readme.md"), "# hi\n");
    const ctx = { workspace: ws, sandbox: "off" as const };
    // "readmi.md" is 1 edit from "readme.md" — substring match alone misses this
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "readmi.md" }),
      ctx,
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /Did you mean/i);
    assert.match(r.output, /readme\.md/);
    assert.match(r.output, /workspace root/i);
  });

  it("read_file soft-hints on large files (≥2 MiB)", async () => {
    const ws = path.join(tmpRoot, "ws-large");
    await fsp.mkdir(ws, { recursive: true });
    const big = path.join(ws, "big.txt");
    // Non-null padding (truncate would be all \\0 → binary refuse)
    const chunk = "abcdefghijklmnopqrstuvwxyz012345\n"; // 33 bytes
    const target = 2 * 1024 * 1024 + 64;
    const reps = Math.ceil(target / chunk.length);
    await fsp.writeFile(big, chunk.repeat(reps));
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "big.txt", limit: 5 }),
      ctx,
    );
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /bytes/);
    assert.match(r.output, /prefer smaller limit|grep/i);
  });
});

describe("path-hints", () => {
  it("editDistance is symmetric and handles basics", async () => {
    assert.equal(editDistance("abc", "abc"), 0);
    assert.equal(editDistance("abc", "ab"), 1);
    assert.equal(editDistance("kitten", "sitting"), 3);
    assert.equal(editDistance("readme.md", "readmi.md"), 1);
    assert.equal(editDistance("a", "b"), 1);
    const { stringSimilarity } = await import("../src/util/string-distance.js");
    assert.equal(stringSimilarity("abc", "abc"), 1);
    assert.ok(stringSimilarity("kitten", "sitting") > 0.5);
    assert.ok(stringSimilarity("ab", "xy") < 0.5);
  });

  it("pathNotFoundHint suggests typos and always notes workspace", async () => {
    const ws = path.join(tmpRoot, "ws-ph");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "config.toml"), "x=1\n");
    await fsp.writeFile(path.join(ws, "package.json"), "{}\n");

    const typo = await pathNotFoundHint(path.join(ws, "config.tml"), ws);
    assert.match(typo, /Did you mean/);
    assert.match(typo, /config\.toml/);
    assert.match(typo, new RegExp(`workspace root is ${ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const missingParent = await pathNotFoundHint(
      path.join(ws, "no-such-dir", "file.ts"),
      ws,
    );
    assert.doesNotMatch(missingParent, /Did you mean/);
    assert.match(missingParent, /workspace root/);
  });
});

describe("glob / list_dir missing paths", () => {
  it("glob reports missing search root (not empty match) + hints", async () => {
    const ws = path.join(tmpRoot, "ws-glob");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.mkdir(path.join(ws, "src"));
    const ctx = { workspace: ws, sandbox: "off" as const };

    const missing = await executeTool(
      "glob",
      JSON.stringify({ pattern: "**/*.ts", path: "srcx" }),
      ctx,
    );
    assert.equal(missing.isError, true);
    assert.match(missing.output, /Directory not found for glob/i);
    assert.match(missing.output, /Did you mean|workspace root/i);
    assert.doesNotMatch(missing.output, /No files matched/);

    const empty = await executeTool(
      "glob",
      JSON.stringify({ pattern: "**/*.nope", path: "src" }),
      ctx,
    );
    assert.equal(empty.isError, undefined, empty.output);
    assert.match(empty.output, /No files matched/);

    const listed = await executeTool(
      "list_dir",
      JSON.stringify({ path: "srcx" }),
      ctx,
    );
    assert.equal(listed.isError, true);
    assert.match(listed.output, /Directory not found/i);

    // File path must not look like "not found" (models thrash on wrong recovery)
    await fsp.writeFile(path.join(ws, "src", "only-file.ts"), "export {};\n");
    const fileAsDir = await executeTool(
      "list_dir",
      JSON.stringify({ path: "src/only-file.ts" }),
      ctx,
    );
    assert.equal(fileAsDir.isError, true);
    assert.match(fileAsDir.output, /not a directory/i);
    assert.doesNotMatch(fileAsDir.output, /Directory not found/i);

    const grepped = await executeTool(
      "grep",
      JSON.stringify({ pattern: "foo", path: "srcx" }),
      ctx,
    );
    assert.equal(grepped.isError, true);
    assert.match(grepped.output, /Path not found for grep/i);

    // Single-file path (JS fallback path must not use glob cwd=file)
    await fsp.writeFile(path.join(ws, "src", "hit.ts"), "const foo = 1;\n");
    const fileHit = await executeTool(
      "grep",
      JSON.stringify({ pattern: "foo", path: "src/hit.ts" }),
      ctx,
    );
    assert.equal(fileHit.isError, undefined, fileHit.output);
    assert.match(fileHit.output, /foo/);
  });
});

// keep fs import used for exists checks if needed
void fs;
