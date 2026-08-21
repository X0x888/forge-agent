import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/agent/tools/index.js";
import {
  locateEdit,
  applyMatch,
  editMissHint,
} from "../src/agent/tools/edit-match.js";
import { createShellEnv } from "../src/agent/tools/env-policy.js";
import {
  editDistance,
  pathNotFoundHint,
} from "../src/agent/tools/path-hints.js";
import { displayRelPath } from "../src/agent/tools/path-util.js";
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
    if (!r.ok) {
      assert.match(r.reason, /multiple times/i);
      assert.match(r.reason, /L1:|Found 2 exact matches/i);
      assert.match(r.reason, /replace_all/i);
    }
  });

  it("multi-match lists line numbers across lines", () => {
    const content = "alpha\nfoo here\nbeta\nfoo there\ngamma\n";
    const r = locateEdit(content, "foo", false);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /Found 2 exact matches/);
      assert.match(r.reason, /L2:/);
      assert.match(r.reason, /L4:/);
    }
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

  it("editMissHint for empty file is explicit", () => {
    const hint = editMissHint("", "anything");
    assert.match(hint, /empty/i);
    assert.match(hint, /write_file/i);
  });

  it("editMissHint suggests closest lines (not path typos)", () => {
    const content = [
      "export function greet(name: string) {",
      "  return `hello ${name}`;",
      "}",
      "",
      "export function bye(name: string) {",
      "  return `bye ${name}`;",
      "}",
    ].join("\n");
    const miss = "export function greett(name: string) {"; // typo in symbol
    const hint = editMissHint(content, miss);
    assert.match(hint, /Closest current lines/);
    assert.match(hint, /greet/);
    assert.doesNotMatch(hint, /Tips: re-read the file \(read_file\)/);
    assert.doesNotMatch(hint, /Did you mean one of these\?\n\s+\//); // path-style
    assert.doesNotMatch(hint, /workspace root is/);
  });

  it("editMissHint notes drifted multi-line blocks", () => {
    const content = "alpha\nbeta\ngamma\n";
    const old = "alpha\nBETA\ngamma\n";
    const hint = editMissHint(content, old);
    assert.match(hint, /first and last lines both appear|middle block/i);
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

  it("scrubs connection-string env names (not just *KEY*/*TOKEN*)", () => {
    const env = createShellEnv({
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://user:pass@localhost/db",
      DB_URL: "mysql://u:p@h/db",
      MONGODB_URI: "mongodb://u:p@h/db",
      REDIS_URL: "redis://:pass@h:6379",
      CONNECTION_STRING: "Server=.;Password=x",
      MYSQL_PWD: "secret",
      PGPASSFILE: "/home/u/.pgpass",
      SSLKEYLOGFILE: "/tmp/keys.log",
      PUBLIC_API_URL: "https://api.example.com", // not a secret name
      NORMAL_VAR: "ok",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.NORMAL_VAR, "ok");
    assert.equal(env.PUBLIC_API_URL, "https://api.example.com");
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.DB_URL, undefined);
    assert.equal(env.MONGODB_URI, undefined);
    assert.equal(env.REDIS_URL, undefined);
    assert.equal(env.CONNECTION_STRING, undefined);
    assert.equal(env.MYSQL_PWD, undefined);
    assert.equal(env.PGPASSFILE, undefined);
    assert.equal(env.SSLKEYLOGFILE, undefined);
  });

  it("strips process-injection env (LD_PRELOAD, NODE_OPTIONS, …)", () => {
    const env = createShellEnv({
      PATH: "/usr/bin",
      LD_PRELOAD: "/tmp/evil.so",
      NODE_OPTIONS: "--require /tmp/evil.js",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      PYTHONSTARTUP: "/tmp/evil.py",
      BASH_ENV: "/tmp/evil.sh",
      GIT_SSH_COMMAND: "evil",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.sshCommand",
      GIT_CONFIG_VALUE_0: "touch /tmp/pwned",
      NORMAL_VAR: "ok",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.NORMAL_VAR, "ok");
    assert.equal(env.LD_PRELOAD, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.DYLD_INSERT_LIBRARIES, undefined);
    assert.equal(env.PYTHONSTARTUP, undefined);
    assert.equal(env.BASH_ENV, undefined);
    assert.equal(env.GIT_SSH_COMMAND, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
    const forced = createShellEnv(
      { PATH: "/usr/bin" },
      { set: { NODE_OPTIONS: "--trace-warnings" } },
    );
    assert.equal(forced.NODE_OPTIONS, "--trace-warnings");
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

describe("read_file past EOF", () => {
  it("reports past-EOF clearly instead of empty-file", async () => {
    const ws = path.join(tmpRoot, "read-eof");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "a.txt"), "line1\nline2\nline3\n", "utf8");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "a.txt", offset: 100 }),
      ctx,
    );
    assert.equal(r.isError, undefined);
    assert.match(r.output, /past end of file/i);
    assert.match(r.output, /\d+ lines/);
    assert.match(r.output, /last line \d+/i);
    assert.doesNotMatch(r.output, /empty file/i);
    assert.doesNotMatch(r.output, /showing 100-99/);
  });

  it("empty file is reported as 0 lines", async () => {
    const ws = path.join(tmpRoot, "read-empty");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "e.txt"), "", "utf8");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "e.txt" }),
      ctx,
    );
    assert.match(r.output, /empty file/i);
    assert.match(r.output, /0 lines/);
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

describe("todo_write validation", () => {
  it("validates todos and marks errors", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const home = await fsp.mkdtemp(pathMod.join(tmpRoot, "todo-home-"));
    process.env.FORGE_HOME = home;
    const { createSession, saveSession } = await import("../src/session/session.js");
    const { applyTodos } = await import("../src/agent/todos.js");
    const ws = path.join(tmpRoot, "ws-todo-val");
    await fsp.mkdir(ws, { recursive: true });
    const session = createSession({ cwd: ws, provider: "xai", model: "m" });
    saveSession(session);

    const missing = applyTodos(session, null, true);
    assert.match(missing, /todo_write error/i);
    assert.match(missing, /required/i);

    const bad = applyTodos(session, [{ id: "1", content: "", status: "pending" }], true);
    assert.match(bad, /content is required/i);

    const badStatus = applyTodos(
      session,
      [{ id: "1", content: "x", status: "nope" }],
      true,
    );
    assert.match(badStatus, /status/i);

    const objContent = applyTodos(
      session,
      [{ id: "1", content: { x: 1 }, status: "pending" }],
      true,
    );
    assert.match(objContent, /content must be a string/i);

    const mergeEmpty = applyTodos(session, [], true);
    assert.match(mergeEmpty, /unchanged|does nothing/i);

    const ok = applyTodos(
      session,
      [{ id: "1", content: "ship it", status: "in_progress" }],
      true,
    );
    assert.match(ok, /Todos updated/);
    assert.match(ok, /ship it/);
    assert.equal(session.todos.length, 1);

    const errTool = await executeTool(
      "todo_write",
      JSON.stringify({ todos: "nope" }),
      { workspace: ws, sandbox: "off" as const },
      (todos, merge) => applyTodos(session, todos, merge),
    );
    assert.equal(errTool.isError, true);
    assert.match(errTool.output, /todo_write error/i);
  });
});

describe("list_dir empty", () => {
  it("empty directory names the path", async () => {
    const ws = path.join(tmpRoot, "ws-list-empty");
    await fsp.mkdir(path.join(ws, "empty"), { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "list_dir",
      JSON.stringify({ path: "empty" }),
      ctx,
    );
    assert.match(r.output, /empty/i);
    assert.match(r.output, /Directory is empty|Tips:/i);
  });
});

describe("grep/glob empty results", () => {
  it("grep no-match includes pattern and path", async () => {
    const ws = path.join(tmpRoot, "ws-grep-empty");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "a.ts"), "const x = 1;\n", "utf8");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "grep",
      JSON.stringify({ pattern: "zzz_no_match_token", path: ws }),
      ctx,
    );
    assert.equal(r.isError, undefined);
    assert.match(r.output, /No matches found/i);
    assert.match(r.output, /zzz_no_match_token/);
    assert.match(r.output, /Tips:/i);
  });

  it("glob no-match includes pattern", async () => {
    const ws = path.join(tmpRoot, "ws-glob-empty");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "glob",
      JSON.stringify({ pattern: "**/*.nomatch-ext", path: ws }),
      ctx,
    );
    assert.equal(r.isError, undefined);
    assert.match(r.output, /No files matched/i);
    assert.match(r.output, /nomatch-ext/);
    assert.match(r.output, /Tips:/i);
  });
});

describe("bash timeout", () => {
  it("tips foreground full-suite commands", async () => {
    const { FULL_SUITE_FOREGROUND_TIP, toolBash } = await import(
      "../src/agent/tools/bash.js"
    );
    const ws = path.join(tmpRoot, "ws-bash-suite");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(
      path.join(ws, "package.json"),
      JSON.stringify({ name: "t", scripts: { test: "echo ok" } }),
    );
    const r = await toolBash(
      { command: "npm test" },
      { workspace: ws, sandbox: "off" } as any,
    );
    assert.match(r.output, /pin the REPL/i);
    assert.match(FULL_SUITE_FOREGROUND_TIP, /background:true/);
  });

  it("reports timeout with duration and exit code 124", async () => {
    const ws = path.join(tmpRoot, "ws-bash-timeout");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "bash",
      JSON.stringify({ command: "sleep 5", timeout_ms: 200 }),
      ctx,
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /timed out after 200ms/i);
    assert.match(r.output, /exit code 124/i);
  });
});

describe("bash exit code footer", () => {
  it("includes exit code when command fails with output", async () => {
    const ws = path.join(tmpRoot, "ws-bash-exit");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "bash",
      JSON.stringify({ command: "echo fail-msg; exit 7" }),
      ctx,
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /fail-msg/);
    assert.match(r.output, /exit code 7/i);
  });

  it("rejects whitespace-only command", async () => {
    const ws = path.join(tmpRoot, "ws-bash-ws");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    for (const command of ["", "   ", "\t\n"]) {
      const r = await executeTool(
        "bash",
        JSON.stringify({ command }),
        ctx,
      );
      assert.equal(r.isError, true, `command=${JSON.stringify(command)}`);
      assert.match(r.output, /command is required/i);
    }
  });

  it("empty bash example uses preferred project check", async () => {
    const ws = path.join(tmpRoot, "ws-bash-empty-intel");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(
      path.join(ws, "package.json"),
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    await fsp.writeFile(path.join(ws, "package-lock.json"), "{}");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool("bash", JSON.stringify({ command: "" }), ctx);
    assert.equal(r.isError, true);
    assert.match(r.output, /command is required/i);
    assert.match(r.output, /npm run typecheck|npm test/);
    assert.match(r.output, /Prefer project checks from \/context/i);
  });
});

describe("tool name aliases and unknown-tool tips", () => {
  it("accepts Shell/read aliases and suggests on unknown names", async () => {
    const ws = path.join(tmpRoot, "ws-tool-alias");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "a.txt"), "hi\n");
    const ctx = { workspace: ws, sandbox: "off" as const };

    const shell = await executeTool(
      "Shell",
      JSON.stringify({ command: "echo alias-ok" }),
      ctx,
    );
    assert.equal(shell.isError, undefined, shell.output);
    assert.match(shell.output, /alias-ok/);

    const read = await executeTool(
      "read",
      JSON.stringify({ path: "a.txt" }),
      ctx,
    );
    assert.equal(read.isError, undefined, read.output);
    assert.match(read.output, /hi/);

    const unk = await executeTool("read_fil", "{}", ctx);
    assert.equal(unk.isError, true);
    assert.match(unk.output, /Did you mean: read_file/);
    assert.match(unk.output, /Available:/);

    // doubled stream-bug names recover for aliases too
    const { normalizeToolName } = await import("../src/agent/tools/index.js");
    assert.equal(normalizeToolName("ShellShell"), "Shell");
    assert.equal(normalizeToolName("bashbash"), "bash");
    assert.equal(normalizeToolName("readread"), "read");
  });
});

describe("tool numeric/format arg validation", () => {
  it("rejects invalid bash/web_fetch/get_task_output args", async () => {
    const ws = path.join(tmpRoot, "ws-tool-args");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };

    const bashBad = await executeTool(
      "bash",
      JSON.stringify({ command: "echo hi", timeout_ms: "abc" }),
      ctx,
    );
    assert.equal(bashBad.isError, true);
    assert.match(bashBad.output, /invalid timeout_ms/i);

    const fetchFmt = await executeTool(
      "web_fetch",
      JSON.stringify({ url: "https://example.com", format: "xml" }),
      ctx,
    );
    assert.equal(fetchFmt.isError, true);
    assert.match(fetchFmt.output, /invalid format/i);

    const fetchTo = await executeTool(
      "web_fetch",
      JSON.stringify({ url: "https://example.com", timeout_ms: -1 }),
      ctx,
    );
    assert.equal(fetchTo.isError, true);
    assert.match(fetchTo.output, /invalid timeout_ms/i);

    // Start a bg task so tail validation is reached (unknown id short-circuits earlier)
    const start = await executeTool(
      "bash",
      JSON.stringify({ command: "sleep 30", background: true }),
      ctx,
    );
    assert.equal(start.isError, undefined, start.output);
    const m = start.output.match(/task_id:\s*(bg_\w+)/);
    assert.ok(m);
    const tailBad = await executeTool(
      "get_task_output",
      JSON.stringify({ task_id: m![1], tail: "abc" }),
      ctx,
    );
    assert.equal(tailBad.isError, true);
    assert.match(tailBad.output, /invalid tail/i);

    const streamBad = await executeTool(
      "get_task_output",
      JSON.stringify({ task_id: m![1], stream: "nope" }),
      ctx,
    );
    assert.equal(streamBad.isError, true);
    assert.match(streamBad.output, /invalid stream/i);
  });
});

describe("grep head_limit validation", () => {
  it("rejects invalid head_limit", async () => {
    const ws = path.join(tmpRoot, "ws-grep-hl");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "a.ts"), "const foo = 1;\n");
    const ctx = { workspace: ws, sandbox: "off" as const };
    for (const head_limit of ["abc", -1] as const) {
      const r = await executeTool(
        "grep",
        JSON.stringify({ pattern: "foo", head_limit }),
        ctx,
      );
      assert.equal(r.isError, true, String(head_limit));
      assert.match(r.output, /invalid head_limit/i);
    }
    const ok = await executeTool(
      "grep",
      JSON.stringify({ pattern: "foo", head_limit: 0 }),
      ctx,
    );
    assert.equal(ok.isError, undefined, ok.output);
    assert.match(ok.output, /foo/);
  });
});

describe("read_file offset/limit validation", () => {
  it("rejects non-numeric offset/limit", async () => {
    const ws = path.join(tmpRoot, "ws-read-ol");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "a.txt"), "one\ntwo\n");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const badOff = await executeTool(
      "read_file",
      JSON.stringify({ path: "a.txt", offset: "abc" }),
      ctx,
    );
    assert.equal(badOff.isError, true);
    assert.match(badOff.output, /invalid offset/i);
    const badLim = await executeTool(
      "read_file",
      JSON.stringify({ path: "a.txt", limit: "nope" }),
      ctx,
    );
    assert.equal(badLim.isError, true);
    assert.match(badLim.output, /invalid limit/i);
    const neg = await executeTool(
      "read_file",
      JSON.stringify({ path: "a.txt", offset: -1 }),
      ctx,
    );
    assert.equal(neg.isError, true);
  });
});

describe("path trim fail-closed", () => {
  it("rejects whitespace-only paths on read/write/edit/list/grep/glob", async () => {
    const ws = path.join(tmpRoot, "ws-path-trim");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "read_file", args: { path: "   " } },
      { tool: "write_file", args: { path: "   ", content: "x" } },
      { tool: "search_replace", args: { path: "   ", old_string: "a", new_string: "b" } },
      { tool: "list_dir", args: { path: "   " } },
      { tool: "grep", args: { pattern: "foo", path: "   " } },
      { tool: "glob", args: { pattern: "*.ts", path: "   " } },
    ];
    for (const { tool, args } of cases) {
      const r = await executeTool(tool, JSON.stringify(args), ctx);
      assert.equal(r.isError, true, tool);
      assert.match(r.output, /path is required/i, tool);
      if (
        tool === "read_file" ||
        tool === "write_file" ||
        tool === "search_replace"
      ) {
        assert.match(r.output, /workspace-relative path/i, tool);
        assert.match(r.output, /list_dir\/glob/i, tool);
      }
      if (tool === "list_dir" || tool === "grep" || tool === "glob") {
        assert.match(r.output, /omit path/i, tool);
      }
    }
  });

  it("rejects whitespace-only grep/glob patterns", async () => {
    const ws = path.join(tmpRoot, "ws-pattern-trim");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    for (const { tool, args } of [
      { tool: "grep", args: { pattern: "   " } },
      { tool: "glob", args: { pattern: "   " } },
      { tool: "grep", args: { pattern: "" } },
      { tool: "glob", args: { pattern: "" } },
    ] as const) {
      const r = await executeTool(tool, JSON.stringify(args), ctx);
      assert.equal(r.isError, true, tool);
      assert.match(r.output, /pattern is required/i, tool);
      assert.match(r.output, /Whitespace-only patterns fail closed/i, tool);
    }
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

  it("CHANGELOG multi-match prepends at the first heading", async () => {
    const ws = path.join(tmpRoot, "ws-changelog");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(
      path.join(ws, "CHANGELOG.md"),
      "## [Unreleased]\n### a\n## [Unreleased]\n### b\n",
    );
    const r = await executeTool(
      "search_replace",
      JSON.stringify({
        path: "CHANGELOG.md",
        old_string: "## [Unreleased]",
        new_string: "## [Unreleased]\n### c",
      }),
      { workspace: ws, sandbox: "off" as const },
    );
    assert.notEqual(r.isError, true, r.output);
    assert.match(r.output, /first CHANGELOG match/i);
    const body = await fsp.readFile(path.join(ws, "CHANGELOG.md"), "utf8");
    assert.match(body, /## \[Unreleased\]\n### c\n### a/);
    assert.match(body, /## \[Unreleased\]\n### b/);
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
    assert.doesNotMatch(e.output, /--- a\//);
    assert.doesNotMatch(e.output, /diff truncated/);
    assert.ok(e.diff, "TUI diff stays on ToolResult.diff");
    assert.match(e.diff!, /--- a\//);
    const body = await fsp.readFile(file, "utf8");
    assert.match(body, /return 2/);
    const n = body === "" ? 0 : body.split("\n").length;
    assert.match(e.output, new RegExp(`\\(${n} lines?\\)`));
    const header = e.output.split("\n")[0] ?? "";
    assert.doesNotMatch(header, /truncated|omitted|saved to/i);
    const last = e.output.trim().split("\n").pop() ?? "";
    if (last.startsWith("Tip:")) {
      assert.match(last, /Tip: verify with/);
    }
  });

  it("FORGE_EDIT_RECEIPT=legacy embeds shortDiff in output", async () => {
    const prev = process.env.FORGE_EDIT_RECEIPT;
    process.env.FORGE_EDIT_RECEIPT = "legacy";
    try {
      const ws = path.join(tmpRoot, "ws-edit-legacy");
      await fsp.mkdir(ws, { recursive: true });
      const file = path.join(ws, "m.ts");
      await fsp.writeFile(file, "const x = 1;\n");
      const e = await executeTool(
        "search_replace",
        JSON.stringify({
          path: "m.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        }),
        { workspace: ws, sandbox: "off" as const },
      );
      assert.equal(e.isError, undefined, e.output);
      assert.match(e.output, /--- a\//);
      assert.ok(e.diff?.startsWith("--- a/"));
    } finally {
      if (prev === undefined) delete process.env.FORGE_EDIT_RECEIPT;
      else process.env.FORGE_EDIT_RECEIPT = prev;
    }
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

  it("read_file limit 0 and grep head_limit 0 are unlimited", async () => {
    const ws = path.join(tmpRoot, "ws-limit0");
    await fsp.mkdir(ws, { recursive: true });
    const lines = Array.from({ length: 30 }, (_, i) => `line_${i}_token`);
    await fsp.writeFile(path.join(ws, "big.txt"), lines.join("\n") + "\n");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: path.join(ws, "big.txt"), limit: 0 }),
      ctx,
    );
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /line_0_token/);
    assert.match(r.output, /line_29_token/);
    // Default limit 2000 would also show all 30 — ensure limit:0 is not treated as missing
    // by checking a file larger than DEFAULT would still work with offset
    const r2 = await executeTool(
      "read_file",
      JSON.stringify({ path: path.join(ws, "big.txt"), offset: 25, limit: 0 }),
      ctx,
    );
    assert.match(r2.output, /line_29_token/);
    assert.doesNotMatch(r2.output, /line_0_token/);

    // Many matches — head_limit 0 must not stop at 50
    const many = Array.from({ length: 60 }, (_, i) => `hit_marker_${i}`).join("\n");
    await fsp.writeFile(path.join(ws, "many.txt"), many + "\n");
    const g = await executeTool(
      "grep",
      JSON.stringify({
        pattern: "hit_marker_",
        path: path.join(ws, "many.txt"),
        head_limit: 0,
      }),
      ctx,
    );
    assert.equal(g.isError, undefined, g.output);
    const hits = (g.output.match(/hit_marker_/g) || []).length;
    assert.ok(hits >= 60, `expected ≥60 hits, got ${hits}: ${g.output.slice(0, 200)}`);
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
    assert.doesNotMatch(w.output, /--- a\//);
    assert.ok(w.diff);
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

  it("write_file rejects non-string content", async () => {
    const ws = path.join(tmpRoot, "ws-write-content");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    const missing = await executeTool(
      "write_file",
      JSON.stringify({ path: "a.txt" }),
      ctx,
    );
    assert.equal(missing.isError, true);
    assert.match(missing.output, /content is required/i);
    const obj = await executeTool(
      "write_file",
      JSON.stringify({ path: "a.txt", content: { a: 1 } }),
      ctx,
    );
    assert.equal(obj.isError, true);
    assert.match(obj.output, /content must be a string/i);
    const empty = await executeTool(
      "write_file",
      JSON.stringify({ path: "empty.txt", content: "" }),
      ctx,
    );
    assert.equal(empty.isError, undefined);
    assert.match(empty.output, /Wrote empty\.txt|Wrote/);
  });

  it("search_replace rejects non-string old_string/new_string", async () => {
    const ws = path.join(tmpRoot, "ws-edit-content");
    await fsp.mkdir(ws, { recursive: true });
    await fsp.writeFile(path.join(ws, "t.txt"), "hello\n");
    const ctx = { workspace: ws, sandbox: "off" as const };
    const badNew = await executeTool(
      "search_replace",
      JSON.stringify({ path: "t.txt", old_string: "hello", new_string: { x: 1 } }),
      ctx,
    );
    assert.equal(badNew.isError, true);
    assert.match(badNew.output, /new_string must be a string/i);
    const body = await fsp.readFile(path.join(ws, "t.txt"), "utf8");
    assert.equal(body, "hello\n");
  });

  it("rejects non-string command/query/url/patchText", async () => {
    const ctx = { workspace: tmpRoot, sandbox: "off" as const };
    const cases: Array<{ tool: string; args: Record<string, unknown>; re: RegExp }> = [
      { tool: "bash", args: { command: { cmd: "echo" } }, re: /command must be a string/i },
      { tool: "web_search", args: { query: { q: "x" } }, re: /query must be a string/i },
      { tool: "web_fetch", args: { url: { href: "http://x" } }, re: /url must be a string/i },
      {
        tool: "apply_patch",
        args: { patchText: { not: "string" } },
        re: /patchText must be a string/i,
      },
      { tool: "grep", args: { pattern: { re: "x" } }, re: /pattern must be a string/i },
      { tool: "glob", args: { pattern: { p: "*" } }, re: /pattern must be a string/i },
      { tool: "read_file", args: { path: { p: "a" } }, re: /path must be a string/i },
      { tool: "list_dir", args: { path: { p: "." } }, re: /path must be a string/i },
    ];
    for (const { tool, args, re } of cases) {
      const r = await executeTool(tool, JSON.stringify(args), ctx);
      assert.equal(r.isError, true, tool);
      assert.match(r.output, re, tool);
    }
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
    // Unrelated missing parent → no false sibling suggestions.
    assert.doesNotMatch(missingParent, /Did you mean/);
    assert.match(missingParent, /workspace root/);

    // Parent-dir typo: walk up and suggest the real sibling directory.
    await fsp.mkdir(path.join(ws, "src"), { recursive: true });
    await fsp.writeFile(path.join(ws, "src", "main.ts"), "x\n");
    const parentTypo = await pathNotFoundHint(
      path.join(ws, "srcx", "main.ts"),
      ws,
    );
    assert.match(parentTypo, /Did you mean/);
    assert.match(parentTypo, /src[/\\]?/);
    assert.match(parentTypo, /workspace root/);
  });

  it("pathNotFoundHint finds the same basename in another folder", async () => {
    const ws = path.join(tmpRoot, "ws-basename");
    await fsp.mkdir(path.join(ws, "src", "scenes", "hearth"), { recursive: true });
    await fsp.writeFile(
      path.join(ws, "src", "scenes", "hearth", "tea-sip.js"),
      "export {}\n",
    );
    const hint = await pathNotFoundHint(
      path.join(ws, "src", "systems", "tea-sip.js"),
      ws,
    );
    assert.match(hint, /Did you mean/);
    assert.match(hint, /scenes[/\\]hearth[/\\]tea-sip\.js/);
  });

  it("displayRelPath realpath-normalizes macOS /var vs /private/var", () => {
    const ws = path.join(tmpRoot, "rel-ws");
    fs.mkdirSync(ws, { recursive: true });
    const nested = path.join(ws, "nested", "file.txt");
    let wsKey = ws;
    try {
      wsKey = fs.realpathSync(ws);
    } catch {
      /* keep */
    }
    const rel = displayRelPath(wsKey, nested);
    assert.equal(rel, path.join("nested", "file.txt"));
    assert.doesNotMatch(rel, /\.\./);
    const rel2 = displayRelPath(ws, nested);
    assert.equal(rel2, path.join("nested", "file.txt"));
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

describe("get_task_output arg validation order", () => {
  it("reports invalid tail/stream even without task_id", async () => {
    const ctx = { workspace: tmpRoot, sandbox: "off" as const };
    const tail = await executeTool(
      "get_task_output",
      JSON.stringify({ tail: -1 }),
      ctx,
    );
    assert.equal(tail.isError, true);
    assert.match(tail.output, /invalid tail/i);
    const stream = await executeTool(
      "get_task_output",
      JSON.stringify({ stream: "nope" }),
      ctx,
    );
    assert.equal(stream.isError, true);
    assert.match(stream.output, /invalid stream/i);
    const badId = await executeTool(
      "get_task_output",
      JSON.stringify({ task_id: { id: "x" } }),
      ctx,
    );
    assert.equal(badId.isError, true);
    assert.match(badId.output, /task_id must be a string/i);
  });
});

describe("get_task_output stream typo suggestion", () => {
  it("suggests stdout/stderr/both for near-miss tokens", async () => {
    const { toolGetTaskOutput } = await import("../src/agent/tools/task-tools.js");
    const ctx = { workspace: process.cwd() };
    const a = await toolGetTaskOutput({ stream: "stdot" }, ctx as any);
    assert.equal(a.isError, true);
    assert.match(a.output, /Did you mean: stdout/i);
    const b = await toolGetTaskOutput({ stream: "err" }, ctx as any);
    assert.match(b.output, /Did you mean: stderr/i);
    const c = await toolGetTaskOutput({ stream: "all" }, ctx as any);
    assert.match(c.output, /Did you mean: both/i);
  });
});

describe("web_fetch format typo suggestion", () => {
  it("suggests text/markdown for txt/md", async () => {
    const { toolWebFetch } = await import("../src/agent/tools/web-fetch.js");
    const ctx = { workspace: process.cwd(), signal: AbortSignal.timeout(1000) };
    const a = await toolWebFetch({ url: "https://example.com", format: "txt" }, ctx as any);
    assert.equal(a.isError, true);
    assert.match(a.output, /Did you mean: text/i);
    const b = await toolWebFetch({ url: "https://example.com", format: "md" }, ctx as any);
    assert.match(b.output, /Did you mean: markdown/i);
  });
});

describe("todo_write status typo suggestion", () => {
  it("suggests in_progress/completed for doing/done", async () => {
    const { applyTodos } = await import("../src/agent/todos.js");
    const { createSession } = await import("../src/session/session.js");
    const s = createSession({ cwd: process.cwd(), provider: "xai", model: "grok-4.5" });
    const a = applyTodos(s, [{ id: "1", content: "x", status: "doing" }], false);
    assert.match(a, /todo_write error/);
    assert.match(a, /Did you mean: in_progress/i);
    const b = applyTodos(s, [{ id: "1", content: "x", status: "done" }], false);
    assert.match(b, /Did you mean: completed/i);
  });
});

describe("list_dir file path guidance", () => {
  it("hints read_file/grep when path is a file", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { toolListDir } = await import("../src/agent/tools/glob-list.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-listdir-"));
    fs.writeFileSync(path.join(dir, "file.txt"), "hi");
    const r = await toolListDir(
      { path: "file.txt" },
      { workspace: dir } as any,
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /not a directory/i);
    assert.match(r.output, /read_file|grep/i);
  });
});

describe("web_fetch non-http scheme tip", () => {
  it("suggests https for ftp/file", async () => {
    const { toolWebFetch } = await import("../src/agent/tools/web-fetch.js");
    const ctx = { workspace: process.cwd(), signal: AbortSignal.timeout(1000) };
    const a = await toolWebFetch({ url: "ftp://example.com/a" }, ctx as any);
    assert.equal(a.isError, true);
    assert.match(a.output, /http\(s\)/i);
    assert.match(a.output, /Did you mean https/i);
  });
});

describe("apply_patch Move File grammar hint", () => {
  it("hints Update File + Move to for Move File lines", async () => {
    const { parsePatch } = await import("../src/agent/tools/patch.js");
    const r = parsePatch("*** Begin Patch\n*** Move File: a.ts\n*** End Patch");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Move to/i);
      assert.match(r.error, /Update File/i);
    }
  });
});

describe("apply_patch empty file paths", () => {
  it("hints path form for empty Add/Delete File", async () => {
    const { parsePatch } = await import("../src/agent/tools/patch.js");
    const a = parsePatch("*** Begin Patch\n*** Add File:\n*** End Patch");
    assert.equal(a.ok, false);
    if (!a.ok) assert.match(a.error, /Add File: relative/i);
    const d = parsePatch("*** Begin Patch\n*** Delete File:\n*** End Patch");
    assert.equal(d.ok, false);
    if (!d.ok) assert.match(d.error, /Delete File: relative/i);
  });
});

describe("grep head_limit all alias", () => {
  it("accepts all|max|full as unlimited", async () => {
    const { toolGrep } = await import("../src/agent/tools/grep.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp", "forge-grep-hl-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.ts"), "const forge = 1\n");
    const r = await toolGrep(
      { pattern: "forge", path: ".", head_limit: "all" },
      { workspace: dir } as any,
    );
    assert.notEqual(r.isError, true);
    assert.match(r.output, /forge/);
    const bad = await toolGrep(
      { pattern: "forge", head_limit: "nope" },
      { workspace: dir } as any,
    );
    assert.equal(bad.isError, true);
    assert.match(bad.output, /all\|max\|full/i);
  });
});

describe("web_search num_results all alias", () => {
  it("accepts all|max|full as 10 and rejects garbage", async () => {
    // Unit-test parser path via tool with aborted signal to avoid network.
    const { toolWebSearch } = await import("../src/agent/tools/web-search.js");
    const bad = await toolWebSearch(
      { query: "x", num_results: "nope" },
      { workspace: process.cwd(), signal: AbortSignal.abort() } as any,
    );
    assert.equal(bad.isError, true);
    assert.match(bad.output, /all\|max\|full|1–10|1-10/i);
    // all should not fail validation (may abort or return results)
    const ok = await toolWebSearch(
      { query: "x", num_results: "all" },
      { workspace: process.cwd(), signal: AbortSignal.abort() } as any,
    );
    // Either aborted after validation or results — must not be invalid num_results
    assert.ok(!/invalid num_results/i.test(ok.output));
  });
});

describe("get_task_output tail all alias", () => {
  it("accepts all and suggests for al", async () => {
    const { toolGetTaskOutput } = await import("../src/agent/tools/task-tools.js");
    const ctx = { workspace: process.cwd() } as any;
    // no tasks — still validates tail before task_id required path when stream/tail set
    const all = await toolGetTaskOutput({ tail: "all" }, ctx);
    // should not be invalid tail
    assert.ok(!/invalid tail/i.test(all.output));
    const al = await toolGetTaskOutput({ tail: "al" }, ctx);
    assert.equal(al.isError, true);
    assert.match(al.output, /invalid tail/i);
    assert.match(al.output, /Did you mean: all/i);
  });
});

describe("bash timeout_ms aliases", () => {
  it("accepts default/max/all and tips typos", async () => {
    const { toolBash } = await import("../src/agent/tools/bash.js");
    const ctx = {
      workspace: process.cwd(),
      signal: AbortSignal.timeout(5000),
      config: { sandbox: "off" },
      sandbox: "off",
    } as any;
    const def = await toolBash({ command: "echo ok", timeout_ms: "default" }, ctx);
    assert.notEqual(def.isError, true);
    assert.match(def.output, /ok/);
    const bad = await toolBash({ command: "echo ok", timeout_ms: "al" }, ctx);
    assert.equal(bad.isError, true);
    assert.match(bad.output, /Did you mean: all|timeout_ms/i);
  });
});

describe("apply_patch missing End Patch message", () => {
  it("distinguishes missing end vs begin markers", async () => {
    const { parsePatch } = await import("../src/agent/tools/patch.js");
    const r = parsePatch("*** Begin Patch\n*** Add File: a.ts\n+hi\n");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /missing \*\*\* End Patch/i);
  });
});

describe("apply_patch empty update no-op", () => {
  it("rejects empty @@ without Move to", async () => {
    const { parsePatch } = await import("../src/agent/tools/patch.js");
    const r = parsePatch(
      "*** Begin Patch\n*** Update File: a.ts\n@@\n*** End Patch",
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no-op|Move to/i);
  });
});

describe("bash timeout_ms duration suffixes", () => {
  it("accepts 30s/1m and rejects garbage", async () => {
    const { toolBash } = await import("../src/agent/tools/bash.js");
    const ctx = {
      workspace: process.cwd(),
      signal: AbortSignal.timeout(5000),
      sandbox: "off",
      config: { sandbox: "off" },
    } as any;
    const s = await toolBash({ command: "echo ok", timeout_ms: "30s" }, ctx);
    assert.notEqual(s.isError, true);
    assert.match(s.output, /ok/);
    const m = await toolBash({ command: "echo ok", timeout_ms: "1m" }, ctx);
    assert.notEqual(m.isError, true);
    const bad = await toolBash({ command: "echo ok", timeout_ms: "30x" }, ctx);
    assert.equal(bad.isError, true);
  });
});

describe("web_fetch timeout_ms duration suffixes", () => {
  it("accepts 30s and rejects garbage before network", async () => {
    const { toolWebFetch } = await import("../src/agent/tools/web-fetch.js");
    const bad = await toolWebFetch(
      { url: "https://example.com", timeout_ms: "nope" },
      { workspace: process.cwd(), signal: AbortSignal.abort() } as any,
    );
    assert.equal(bad.isError, true);
    assert.match(bad.output, /timeout_ms/i);
    // valid duration should pass validation (may abort on fetch)
    const ok = await toolWebFetch(
      { url: "https://example.com", timeout_ms: "30s" },
      { workspace: process.cwd(), signal: AbortSignal.abort() } as any,
    );
    assert.ok(!/invalid timeout_ms/i.test(ok.output));
  });
});

describe("search_replace whitespace-only old_string", () => {
  it("fails closed instead of matching blank lines", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { toolEdit } = await import("../src/agent/tools/edit.js");
    const dir = path.join(process.cwd(), ".tmp", "forge-ws-edit");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.ts"), "x\n\ny\n");
    const r = await toolEdit(
      { path: "a.ts", old_string: "   ", new_string: "z" },
      { workspace: dir } as any,
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /whitespace-only/i);
  });
});

describe("apply_patch context-only update no-op", () => {
  it("rejects context-only @@ without -/+ edits", async () => {
    const { parsePatch } = await import("../src/agent/tools/patch.js");
    const r = parsePatch(
      "*** Begin Patch\n*** Update File: a.ts\n@@\n context line\n*** End Patch",
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no-op|context-only/i);
  });
});


describe("stripReadFileLinePrefixes", () => {
  it("strips read_file numbered paste from old_string", async () => {
    const { stripReadFileLinePrefixes } = await import(
      "../src/agent/tools/edit-match.js"
    );
    const raw = "    12|const x = 1;\n    13|const y = 2;";
    const r = stripReadFileLinePrefixes(raw);
    assert.equal(r.stripped, true);
    assert.equal(r.text, "const x = 1;\nconst y = 2;");
  });

  it("leaves normal code alone", async () => {
    const { stripReadFileLinePrefixes } = await import(
      "../src/agent/tools/edit-match.js"
    );
    const raw = "const a = 1;\nconst b = 2;";
    const r = stripReadFileLinePrefixes(raw);
    assert.equal(r.stripped, false);
    assert.equal(r.text, raw);
  });

  it("does not strip non-contiguous numbered runs", async () => {
    const { stripReadFileLinePrefixes } = await import(
      "../src/agent/tools/edit-match.js"
    );
    const twoWindows = "     1|foo\n    18|bar";
    const gap = stripReadFileLinePrefixes(twoWindows);
    assert.equal(gap.stripped, false);
    const withGap = "     1|foo\n… 5 lines not shown …\n     7|bar";
    const g = stripReadFileLinePrefixes(withGap);
    assert.equal(g.stripped, false);
    const header = "Edited a.ts (2 lines)\n     1|foo\n     2|bar";
    assert.equal(stripReadFileLinePrefixes(header).stripped, false);
    const dec = "     3|c\n     2|b";
    assert.equal(stripReadFileLinePrefixes(dec).stripped, false);
  });

  it("does not strip single-line unpadded 1|pipe data", async () => {
    const { stripReadFileLinePrefixes } = await import(
      "../src/agent/tools/edit-match.js"
    );
    const raw = "1|pipe-data";
    const r = stripReadFileLinePrefixes(raw);
    assert.equal(r.stripped, false);
    assert.equal(r.text, raw);
  });

  it("search_replace accepts numbered paste as old_string", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ln-edit-"));
    const f = path.join(dir, "a.ts");
    fs.writeFileSync(f, "const x = 1;\nconst y = 2;\n");
    const r = await executeTool(
      "search_replace",
      JSON.stringify({
        path: "a.ts",
        old_string: "     1|const x = 1;\n     2|const y = 2;",
        new_string: "     1|const x = 9;\n     2|const y = 2;",
      }),
      { workspace: dir },
    );
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /stripped read_file line-number prefixes/);
    assert.equal(fs.readFileSync(f, "utf8"), "const x = 9;\nconst y = 2;\n");
  });
});


describe("editMissHint numbered paste tip", () => {
  it("mentions line-number prefixes when old_string is mixed numbered", async () => {
    const { editMissHint } = await import("../src/agent/tools/edit-match.js");
    const hint = editMissHint(
      "const x = 1;\nconst y = 2;\n",
      "const x = 1;\n    13|const y = 2;",
    );
    assert.match(hint, /line-number prefixes|N\|/i);
  });
});


describe("write_file line-prefix strip", () => {
  it("write_file strips numbered paste content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ln-write-"));
    const r = await executeTool(
      "write_file",
      JSON.stringify({
        path: "b.ts",
        content: "     1|export const a = 1;\n     2|export const b = 2;\n",
      }),
      { workspace: dir },
    );
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /stripped read_file line-number prefixes/);
    assert.equal(
      fs.readFileSync(path.join(dir, "b.ts"), "utf8"),
      "export const a = 1;\nexport const b = 2;\n",
    );
  });
});

describe("web + apply_patch empty recovery", () => {
  it("web_search empty query fails closed with tip", async () => {
    const ws = path.join(tmpRoot, "ws-web-empty");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    for (const query of ["", "   "]) {
      const r = await executeTool(
        "web_search",
        JSON.stringify({ query }),
        ctx,
      );
      assert.equal(r.isError, true);
      assert.match(r.output, /query is required/i);
      assert.match(r.output, /Whitespace-only queries fail closed/i);
    }
  });

  it("web_fetch empty url fails closed with tip", async () => {
    const ws = path.join(tmpRoot, "ws-fetch-empty");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    for (const url of ["", "   "]) {
      const r = await executeTool(
        "web_fetch",
        JSON.stringify({ url }),
        ctx,
      );
      assert.equal(r.isError, true);
      assert.match(r.output, /url is required/i);
      assert.match(r.output, /Whitespace-only URLs fail closed/i);
    }
  });

  it("apply_patch empty patchText fails closed with tip", async () => {
    const ws = path.join(tmpRoot, "ws-patch-empty");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    for (const patchText of ["", "   "]) {
      const r = await executeTool(
        "apply_patch",
        JSON.stringify({ patchText }),
        ctx,
      );
      assert.equal(r.isError, true);
      assert.match(r.output, /patchText is required/i);
      assert.match(r.output, /Whitespace-only patchText fail/i);
    }
  });
});

  it("todo_write null todos fails closed with merge tip", async () => {
    const ws = path.join(tmpRoot, "ws-todo-null");
    await fsp.mkdir(ws, { recursive: true });
    const { createSession } = await import("../src/session/session.js");
    const { applyTodos } = await import("../src/agent/todos.js");
    const session = createSession({ cwd: ws, provider: "xai", model: "m" });
    const missing = applyTodos(session, null, true);
    assert.match(missing, /todos array is required/i);
    assert.match(missing, /merge:true with \[\] is a no-op/i);
    const notArr = applyTodos(session, { id: "1" } as any, true);
    assert.match(notArr, /must be an array/i);
  });

