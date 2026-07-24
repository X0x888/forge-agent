import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/agent/tools/index.js";
import { locateEdit, applyMatch } from "../src/agent/tools/edit-match.js";
import { createShellEnv } from "../src/agent/tools/env-policy.js";
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
    assert.match(w.output, /escapes workspace/i);
  });

  it("path hints on missing read", async () => {
    const ws = path.join(tmpRoot, "ws-hint");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "readme.md"), "# hi\n");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "readmi.md" }),
      ctx,
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /not found|Did you mean|workspace root/i);
  });
});

// keep fs import used for exists checks if needed
void fs;
