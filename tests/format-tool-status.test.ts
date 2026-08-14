import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatToolStart,
  formatToolEnd,
  formatFailedToolTail,
  visibleWidth,
} from "../src/util/format.js";
import {
  formatDefaultToolEndTranscript,
  formatVerboseToolEndTranscript,
} from "../src/tui/tool-transcript.js";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("default tool status line", () => {
  it("puts args on the end line so default transcript can skip ▸", () => {
    const start = strip(
      formatToolStart("write_file", { path: "src/tui/repl.ts" }),
    );
    const end = strip(
      formatToolEnd("write_file", {
        isError: false,
        ms: 12,
        bytes: 40,
        args: { path: "src/tui/repl.ts" },
      }),
    );
    assert.match(start, /▸ write_file path=src\/tui\/repl\.ts/);
    assert.match(end, /✓ write_file path=src\/tui\/repl\.ts\s+12ms/);
    assert.match(end, /diff /);
    assert.equal(end.includes("\n"), false, "end line must stay one row");
  });

  it("summarizes spawn_subagent as type: description, not prompt JSON", () => {
    const args = {
      subagent_type: "explore",
      description: "map daily REPL dumps",
      prompt:
        "Read src/tui/repl.ts and list leftover chrome. Do not invent files.",
    };
    const end = strip(
      formatToolEnd("spawn_subagent", {
        isError: false,
        ms: 2400,
        bytes: 800,
        args,
      }),
    );
    assert.match(end, /✓ spawn_subagent explore: map daily REPL dumps/);
    assert.doesNotMatch(end, /Read src\/tui\/repl/);
    assert.doesNotMatch(end, /"prompt"/);
    assert.equal(end.includes("\n"), false);
  });

  it("does not treat a generic type= field as a subagent", () => {
    const end = strip(
      formatToolEnd("write_file", {
        isError: false,
        ms: 3,
        bytes: 10,
        args: { type: "module", path: "src/a.ts" },
      }),
    );
    assert.match(end, /✓ write_file path=src\/a\.ts/);
    assert.doesNotMatch(end, /module:/);
  });

  it("summarizes todo_write as N · ▶ title, not board JSON", () => {
    const end = strip(
      formatToolEnd("todo_write", {
        isError: false,
        ms: 4,
        bytes: 80,
        args: {
          merge: true,
          todos: [
            { id: "a", content: "smoke leftover dumps", status: "completed" },
            { id: "b", content: "hostile review daily-REPL", status: "in_progress" },
          ],
        },
      }),
    );
    assert.match(end, /✓ todo_write 2 · ▶ hostile review daily-REPL \+1/);
    assert.doesNotMatch(end, /"todos"/);
    assert.doesNotMatch(end, /smoke leftover/);
    assert.equal(end.includes("\n"), false);
  });

  it("summarizes ask_user as the question, not choices JSON", () => {
    const end = strip(
      formatToolEnd("ask_user", {
        isError: false,
        ms: 9,
        bytes: 20,
        args: {
          question: "Keep the default slim /diff?",
          choices: ["yes", "no"],
        },
      }),
    );
    assert.match(end, /✓ ask_user Keep the default slim \/diff\? \(2\)/);
    assert.doesNotMatch(end, /"choices"/);
    assert.equal(end.includes("\n"), false);
  });

  it("summarizes memory_write as kind: text, not payload JSON", () => {
    const end = strip(
      formatToolEnd("memory_write", {
        isError: false,
        ms: 2,
        bytes: 40,
        args: {
          scope: "project",
          kind: "gotcha",
          text: "npm test sets TMPDIR=$PWD/.tmp",
        },
      }),
    );
    assert.match(end, /✓ memory_write project · gotcha: npm test sets TMPDIR=/);
    assert.doesNotMatch(end, /"text"/);
    assert.equal(end.includes("\n"), false);
  });

  it("summarizes call_mcp as tool_name, not arguments JSON", () => {
    const end = strip(
      formatToolEnd("call_mcp", {
        isError: false,
        ms: 80,
        bytes: 200,
        args: {
          tool_name: "github__list_issues",
          arguments: { owner: "X0x888", repo: "forge-agent", state: "open" },
        },
      }),
    );
    assert.match(end, /✓ call_mcp github__list_issues · 3 args/);
    assert.doesNotMatch(end, /"arguments"/);
    assert.doesNotMatch(end, /X0x888/);
    assert.equal(end.includes("\n"), false);
  });

  it("summarizes mcp_prompt as name, not arguments JSON", () => {
    const end = strip(
      formatToolEnd("mcp_prompt", {
        isError: false,
        ms: 12,
        bytes: 80,
        args: {
          action: "get",
          name: "context7__resolve-library-id",
          arguments: { libraryName: "react" },
        },
      }),
    );
    assert.match(end, /✓ mcp_prompt context7__resolve-library-id · 1 arg/);
    assert.doesNotMatch(end, /"arguments"/);
    assert.doesNotMatch(end, /libraryName/);
    assert.equal(end.includes("\n"), false);
  });

  it("summarizes exit_plan_mode as plan=, not payload JSON", () => {
    const end = strip(
      formatToolEnd("exit_plan_mode", {
        isError: false,
        ms: 5,
        bytes: 80,
        args: {
          plan: "Ship slim /diff then prove.",
          extra: { files: ["a.ts"] },
        },
      }),
    );
    assert.match(end, /✓ exit_plan_mode plan=Ship slim \/diff then prove\./);
    assert.doesNotMatch(end, /"extra"/);
    assert.equal(end.includes("\n"), false);
  });

  it("summarizes get_task_output as task_id, not wait JSON", () => {
    const end = strip(
      formatToolEnd("get_task_output", {
        isError: false,
        ms: 12,
        bytes: 40,
        args: { task_id: "abc123", wait: 30_000, tail: 200 },
      }),
    );
    assert.match(end, /✓ get_task_output task_id=abc123/);
    assert.doesNotMatch(end, /"wait"/);
    assert.equal(end.includes("\n"), false);
  });

  it("keeps a compact fail line when args are omitted", () => {
    const end = strip(
      formatToolEnd("bash", { isError: true, ms: 8, bytes: 80 }),
    );
    assert.match(end, /✗ bash\s+8ms/);
    assert.doesNotMatch(end, /command=/);
  });

  it("inlines the first error line on the ✗ row", () => {
    const end = strip(
      formatToolEnd("write_file", {
        isError: true,
        ms: 4,
        bytes: 40,
        args: { path: "src/a.ts" },
        output: "Permission denied: plan mode — /build to implement\nmore",
      }),
    );
    assert.match(end, /✗ write_file path=src\/a\.ts  Permission denied: plan mode/);
    assert.equal(end.includes("\n"), false, "fail line must stay one row");
    assert.doesNotMatch(end, /more$/);
  });

  it("inlines the real failure, not the npm/TAP header", () => {
    const out = [
      "npm test",
      ...Array.from({ length: 8 }, (_, i) => `ok ${i}`),
      "not ok 9 — expected 2",
      "  AssertionError: expected 2",
      "    at file:///tmp/t.test.ts:10:5",
    ].join("\n");
    const end = strip(
      formatToolEnd("bash", {
        isError: true,
        ms: 80,
        bytes: 400,
        args: { command: "npm test" },
        output: out,
      }),
    );
    assert.match(end, /✗ bash command=npm test  not ok 9 — expected 2/);
    assert.doesNotMatch(end, /npm test  \d+ms/);
    assert.doesNotMatch(end, /AssertionError/);
    assert.equal(end.includes("\n"), false);
  });

  it("inlines a TypeScript diagnostic over the tsc banner", () => {
    const end = strip(
      formatToolEnd("bash", {
        isError: true,
        ms: 12,
        bytes: 200,
        output: [
          "src/tui/repl.ts:10:5 - error TS2345: Argument of type 'string' is not assignable.",
          "10     foo(1)",
        ].join("\n"),
      }),
    );
    assert.match(end, /error TS2345/);
    assert.doesNotMatch(end, /foo\(1\)/);
  });

  it("clips the ✓/✗ row to one TTY row", () => {
    const end = formatToolEnd("write_file", {
      isError: true,
      ms: 12,
      bytes: 80,
      args: { path: "src/tui/status-bar.ts" },
      output: "Permission denied: plan mode — /build to implement",
      width: 28,
    });
    assert.ok(visibleWidth(end) <= 28, `width ${visibleWidth(end)} > 28`);
    assert.equal(end.includes("\n"), false);
    assert.match(strip(end), /✗ write_file/);
  });

  it("failed-tool tail is last 5 extra lines and skips the ✗-row reason", () => {
    const out = [
      "npm test",
      ...Array.from({ length: 20 }, (_, i) => `ok ${i}`),
      "not ok 21 — expected 2",
      "  AssertionError: expected 2",
      "    at file:///tmp/t.test.ts:10:5",
    ].join("\n");
    const tail = strip(formatFailedToolTail(out));
    assert.ok(tail.includes("AssertionError"));
    assert.ok(tail.includes("t.test.ts"));
    assert.ok(tail.includes("… ("));
    assert.ok(tail.includes("/verbose"));
    assert.ok(!tail.includes("not ok 21"), "reason already lives on the ✗ row");
    assert.ok(!tail.includes("npm test"));
    assert.ok(!tail.includes("ok 0"));
    assert.equal(formatFailedToolTail("Permission denied"), "");
    assert.equal(formatFailedToolTail(""), "");
  });

  it("default transcript inlines the reason and keeps a last-lines tail", () => {
    const out = [
      "npm test",
      ...Array.from({ length: 20 }, (_, i) => `ok ${i}`),
      "not ok 21 — expected 2",
      "  AssertionError: expected 2",
      "    at file:///tmp/t.test.ts:10:5",
    ].join("\n");
    const text = strip(
      formatDefaultToolEndTranscript("bash", {
        isError: true,
        ms: 80,
        bytes: 400,
        args: { command: "npm test" },
        output: out,
      }),
    );
    assert.match(text, /✗ bash command=npm test  not ok 21 — expected 2/);
    assert.match(text, /AssertionError/);
    assert.match(text, /t\.test\.ts/);
    assert.match(text, /\/verbose/);
    const ok = strip(
      formatDefaultToolEndTranscript("write_file", {
        isError: false,
        ms: 12,
        bytes: 40,
        args: { path: "src/a.ts" },
        output: "wrote src/a.ts",
      }),
    );
    assert.match(ok, /✓ write_file path=src\/a\.ts/);
    assert.doesNotMatch(ok, /wrote src\/a\.ts/);
  });

  it("verbose transcript prints the full output block", () => {
    const text = strip(
      formatVerboseToolEndTranscript("bash", {
        isError: false,
        ms: 9,
        bytes: 20,
        args: { command: "echo hi" },
        output: "hello\nworld",
      }),
    );
    assert.match(text, /✓ bash command=echo hi/);
    assert.match(text, /hello/);
    assert.match(text, /world/);
  });
});
