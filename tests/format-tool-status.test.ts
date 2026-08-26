import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatToolStart,
  formatToolEnd,
  formatFailedToolTail,
  firstToolErrorLine,
  compactToolDenyReason,
  visibleWidth,
} from "../src/util/format.js";
import {
  createToolEndCoalescer,
  createToolStartDelayer,
  formatCoalescedToolEnd,
  formatDefaultToolEndTranscript,
  formatSubagentTranscriptPreview,
  formatVerboseToolEndTranscript,
  formatWebSearchTranscriptPreview,
  formatLspTranscriptPreview,
  stripSubagentHeader,
} from "../src/tui/tool-transcript.js";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("verbose tool end with receipt + diff", () => {
  it("colorizes r.diff even when output has no --- a/", () => {
    const text = formatVerboseToolEndTranscript("search_replace", {
      isError: false,
      ms: 5,
      bytes: 80,
      args: { path: "src/a.ts" },
      output: "Edited src/a.ts (2 lines) · −1 +1 · lines 1–2 of 2",
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new",
      stats: { added: 1, removed: 1 },
    });
    const bare = strip(text);
    assert.match(bare, /\+1 -1/);
    assert.match(bare, /--- a\/src\/a\.ts/);
  });
});

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
    assert.match(start, /▸ write src\/tui\/repl\.ts/);
    assert.match(end, /✓ write src\/tui\/repl\.ts\s+12ms/);
    assert.doesNotMatch(start, /path=/);
    assert.doesNotMatch(end, /write_file|path=/);
    assert.match(end, /diff /);
    assert.equal(end.includes("\n"), false, "end line must stay one row");
  });

  it("prints +added -removed when stats are set", () => {
    const withStats = strip(
      formatToolEnd("search_replace", {
        isError: false,
        ms: 8,
        bytes: 400,
        args: { path: "src/a.ts" },
        stats: { added: 8, removed: 6 },
      }),
    );
    assert.match(withStats, /✓ edit src\/a\.ts/);
    assert.match(withStats, /\+8 -6/);
    assert.doesNotMatch(withStats, /search_replace|path=|diff /);
    const unknown = strip(
      formatToolEnd("write_file", {
        isError: false,
        ms: 3,
        bytes: 10,
        args: { path: "huge.log" },
        stats: { added: 12, removed: null },
      }),
    );
    assert.match(unknown, /\+12 -\?/);
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

  it("PLAN omitted type display is explore when display args carry the resolved type", () => {
    const end = strip(
      formatToolEnd("spawn_subagent", {
        isError: false,
        ms: 12,
        bytes: 100,
        args: {
          description: "Explore product core loop",
          prompt: "Map the loop. Do not invent files.",
          subagent_type: "explore",
        },
      }),
    );
    assert.match(end, /✓ spawn_subagent explore: Explore product core loop/);
    assert.doesNotMatch(end, /general-purpose/);
    assert.doesNotMatch(end, /"prompt"/);
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
    assert.match(end, /✓ write src\/a\.ts/);
    assert.doesNotMatch(end, /module:|path=/);
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
    assert.match(end, /✗ write src\/a\.ts  Permission denied: plan mode/);
    assert.doesNotMatch(end, /path=/);
    assert.equal(end.includes("\n"), false, "fail line must stay one row");
    assert.doesNotMatch(end, /more$/);
  });

  it("compacts permission-gate lectures on the ✗ row", () => {
    assert.equal(
      compactToolDenyReason("Tool denied by permission gate: user_reject"),
      "denied",
    );
    assert.equal(
      compactToolDenyReason(
        "Tool denied by permission gate: plan_mode: bash mutations denied — read-only shell ok",
      ),
      "plan mode",
    );
    assert.equal(
      compactToolDenyReason(
        'Tool denied by permission gate: ulw_orient: general-purpose spawn denied — PLAN may spawn explore/plan only. Next: retry this turn as spawn_subagent({ subagent_type: "explore" })',
      ),
      "orient",
    );
    assert.equal(
      compactToolDenyReason(
        "HARD DENY [cloud-metadata-imds]: Refusing cloud instance-metadata fetch",
      ),
      "hard deny cloud-metadata-imds",
    );
    assert.equal(compactToolDenyReason("not ok 9 — expected 2"), null);
    assert.equal(
      firstToolErrorLine("Tool denied by permission gate: user_reject"),
      "denied",
    );
    const end = strip(
      formatToolEnd("bash", {
        isError: true,
        ms: 0,
        bytes: 80,
        args: { command: "rm -rf dist" },
        output: "Tool denied by permission gate: user_reject",
      }),
    );
    assert.match(end, /✗ bash rm -rf dist  denied/);
    assert.doesNotMatch(end, /permission gate/);
    assert.doesNotMatch(end, /user_reject/);
    assert.equal(
      formatFailedToolTail("Tool denied by permission gate: user_reject"),
      "",
    );
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
    assert.match(end, /✗ bash npm test  not ok 9 — expected 2/);
    assert.doesNotMatch(end, /command=/);
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

  it("clips long args before the ✗ reason so the failure stays visible", () => {
    const painted = formatToolEnd("bash", {
      isError: true,
      ms: 80,
      bytes: 400,
      args: {
        command:
          "npx tsx --test tests/very-long-path/to/some/deeply/nested/file.test.ts --test-name-pattern 'keeps the failure visible'",
      },
      output: "Permission denied: plan mode — /build to implement",
      width: 80,
    });
    const end = strip(painted);
    assert.match(end, /✗ bash/);
    assert.match(end, /Permission denied/);
    assert.equal(end.includes("\n"), false);
    assert.ok(visibleWidth(painted) <= 80);
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
    assert.match(strip(end), /✗ write/);
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
    assert.match(text, /✗ bash npm test  not ok 21 — expected 2/);
    assert.doesNotMatch(text, /command=/);
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
    assert.match(ok, /✓ write src\/a\.ts/);
    assert.doesNotMatch(ok, /wrote src\/a\.ts|path=/);
  });

  it("default transcript shows a compact edit diff without --- a/ headers", () => {
    const text = strip(
      formatDefaultToolEndTranscript("search_replace", {
        isError: false,
        ms: 5,
        bytes: 80,
        args: { path: "src/a.ts" },
        output: "Edited src/a.ts (2 lines) · −1 +1 · lines 1–2 of 2",
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old line\n+new line",
        stats: { added: 1, removed: 1 },
      }),
    );
    assert.match(text, /✓ edit src\/a\.ts/);
    assert.match(text, /\+1 -1/);
    assert.match(text, /-old line/);
    assert.match(text, /\+new line/);
    assert.doesNotMatch(text, /--- a\/src\/a\.ts|\+\+\+ b\//);
    const none = strip(
      formatDefaultToolEndTranscript("search_replace", {
        isError: false,
        ms: 2,
        bytes: 10,
        args: { path: "src/a.ts" },
        diff: "(no line-level diff)",
      }),
    );
    assert.doesNotMatch(none, /no line-level/);
    assert.equal(none.includes("\n"), false);
  });

  it("spawn_subagent default transcript previews the child report, not the header", () => {
    const report = [
      "### Subagent result: map daily REPL dumps",
      "- status: completed",
      "- type: explore · mode: read-only · turns: 4/40 · edits: 0",
      "- session_id: abc123",
      "- artifact_path: /tmp/artifact.md",
      "",
      "pick: Ctrl+R is the ship",
      "passed_on: HUD clips",
      "files:",
      "  src/tui/prompt-editor.ts:1  search mode",
    ].join("\n");
    assert.equal(
      stripSubagentHeader(report).startsWith("pick:"),
      true,
    );
    const preview = strip(formatSubagentTranscriptPreview(report, { maxLines: 2 }));
    assert.match(preview, /pick: Ctrl\+R is the ship/);
    assert.match(preview, /passed_on: HUD clips/);
    assert.match(preview, /\+2 more · \/verbose/);
    assert.doesNotMatch(preview, /### Subagent|session_id|artifact_path/);
    const text = strip(
      formatDefaultToolEndTranscript("spawn_subagent", {
        isError: false,
        ms: 2400,
        bytes: 800,
        args: { subagent_type: "explore", description: "map daily REPL dumps" },
        output: report,
      }),
    );
    assert.match(text, /✓ spawn_subagent explore: map daily REPL dumps/);
    assert.match(text, /pick: Ctrl\+R is the ship/);
    assert.doesNotMatch(text, /### Subagent result/);
    const bare = strip(
      formatDefaultToolEndTranscript("spawn_subagent", {
        isError: false,
        ms: 10,
        bytes: 4,
        args: { subagent_type: "explore", description: "empty" },
      }),
    );
    assert.equal(bare.includes("\n"), false);
  });

  it("successful long bash shows a last-lines tail; echo stays one row", () => {
    const testOut = [
      "> forge-agent@0.9.99 test",
      "> tsx --test tests/*.test.ts",
      "",
      "✔ formatToolEnd clips",
      "✔ spawn_subagent preview",
      "ℹ tests 36",
      "ℹ pass 36",
      "ℹ fail 0",
    ].join("\n");
    const text = strip(
      formatDefaultToolEndTranscript("bash", {
        isError: false,
        ms: 1200,
        bytes: 400,
        args: { command: "npm test" },
        output: testOut,
      }),
    );
    assert.match(text, /✓ bash npm test/);
    assert.match(text, /pass 36/);
    assert.match(text, /fail 0/);
    assert.match(text, /more lines · \/verbose/);
    const echo = strip(
      formatDefaultToolEndTranscript("bash", {
        isError: false,
        ms: 4,
        bytes: 3,
        args: { command: "echo hi" },
        output: "hi",
      }),
    );
    assert.match(echo, /✓ bash echo hi/);
    assert.equal(echo.includes("\n"), false);
  });

  it("web_search default transcript lists hit titles, not URLs", () => {
    const html = [
      "## Search results for forge cli",
      "1. **Forge CLI**",
      "   https://example.com/forge",
      "   A coding agent.",
      "2. **Getting started**",
      "   https://example.com/start",
      "",
      "_Source: DuckDuckGo HTML_",
    ].join("\n");
    const preview = strip(formatWebSearchTranscriptPreview(html));
    assert.match(preview, /1\. Forge CLI/);
    assert.match(preview, /2\. Getting started/);
    assert.doesNotMatch(preview, /https:\/\/|Search results for|_Source/);
    const text = strip(
      formatDefaultToolEndTranscript("web_search", {
        isError: false,
        ms: 400,
        bytes: 200,
        args: { query: "forge cli" },
        output: html,
      }),
    );
    assert.match(text, /✓ web_search forge cli/);
    assert.match(text, /1\. Forge CLI/);
    const empty = strip(
      formatDefaultToolEndTranscript("web_search", {
        isError: false,
        ms: 80,
        bytes: 40,
        args: { query: "zzz" },
        output: 'No structured results for "zzz". Try a more specific query.',
      }),
    );
    assert.equal(empty.includes("\n"), false);
  });

  it("lsp diagnostics preview shows counts and first hits", () => {
    const report = [
      "Diagnostics: 2 error(s), 1 warning(s), 0 info/hint",
      "src/a.ts:10:2 error [2345]: Type 'string' is not assignable",
      "src/b.ts:4:1 error: Cannot find name 'foo'",
      "src/c.ts:1:1 warning: unused",
    ].join("\n");
    const preview = strip(formatLspTranscriptPreview(report, { maxLines: 3 }));
    assert.match(preview, /2 error\(s\)/);
    assert.match(preview, /src\/a\.ts:10:2/);
    assert.match(preview, /\+1 more · \/verbose/);
    assert.equal(formatLspTranscriptPreview("No diagnostics."), "");
    const text = strip(
      formatDefaultToolEndTranscript("lsp", {
        isError: false,
        ms: 120,
        bytes: 80,
        args: { action: "diagnostics", path: "src/a.ts" },
        output: report,
      }),
    );
    assert.match(text, /2 error\(s\)/);
    assert.match(text, /src\/a\.ts:10:2/);
    const clean = strip(
      formatDefaultToolEndTranscript("lsp", {
        isError: false,
        ms: 40,
        bytes: 16,
        args: { action: "diagnostics", path: "src/ok.ts" },
        output: "No diagnostics.",
      }),
    );
    assert.equal(clean.includes("\n"), false);
  });

  it("get_task_output default transcript shows the last log lines", () => {
    const log = [
      "wait: reached completed in 1200ms",
      "ok 1 extract",
      "ok 2 format",
      "ok 3 flush",
      "pass 3",
    ].join("\n");
    const text = strip(
      formatDefaultToolEndTranscript("get_task_output", {
        isError: false,
        ms: 80,
        bytes: 80,
        args: { task_id: "bg_abc" },
        output: log,
      }),
    );
    assert.match(text, /✓ get_task_output task_id=bg_abc/);
    assert.match(text, /pass 3/);
    const short = strip(
      formatDefaultToolEndTranscript("get_task_output", {
        isError: false,
        ms: 20,
        bytes: 20,
        args: { task_id: "bg_abc" },
        output: "still running",
      }),
    );
    assert.equal(short.includes("\n"), false);
  });

  it("web_fetch default transcript shows the first heading and prose", () => {
    const page = [
      "# Forge CLI",
      "",
      "A TypeScript coding agent with a blocking harness.",
      "More body that should not all dump.",
    ].join("\n");
    const text = strip(
      formatDefaultToolEndTranscript("web_fetch", {
        isError: false,
        ms: 200,
        bytes: 80,
        args: { url: "https://example.com" },
        output: page,
      }),
    );
    assert.match(text, /✓ web_fetch/);
    assert.match(text, /Forge CLI/);
    assert.match(text, /TypeScript coding agent/);
    const tiny = strip(
      formatDefaultToolEndTranscript("web_fetch", {
        isError: false,
        ms: 40,
        bytes: 4,
        args: { url: "https://example.com/ok" },
        output: "ok",
      }),
    );
    assert.equal(tiny.includes("\n"), false);
  });

  it("call_mcp default transcript previews the first result lines", () => {
    const body = [
      "title: Forge CLI",
      "url: https://example.com",
      "snippet: A coding agent.",
      "title: Docs",
      "url: https://example.com/docs",
    ].join("\n");
    const text = strip(
      formatDefaultToolEndTranscript("call_mcp", {
        isError: false,
        ms: 300,
        bytes: 80,
        args: { tool_name: "context7__query" },
        output: body,
      }),
    );
    assert.match(text, /✓ call_mcp/);
    assert.match(text, /title: Forge CLI/);
    assert.match(text, /\+1 more · \/verbose/);
    const short = strip(
      formatDefaultToolEndTranscript("call_mcp", {
        isError: false,
        ms: 20,
        bytes: 4,
        args: { tool_name: "x__ok" },
        output: "ok",
      }),
    );
    assert.equal(short.includes("\n"), false);
  });

  it("search_mcp default transcript lists matched tool names", () => {
    const body = [
      'MCP tools matching "browser" (3):',
      "- **playwright__click** [read-only] — Click an element",
      "- **playwright__navigate** — Open a URL",
      "- **playwright__screenshot** — Capture the page",
    ].join("\n");
    const text = strip(
      formatDefaultToolEndTranscript("search_mcp", {
        isError: false,
        ms: 80,
        bytes: 120,
        args: { query: "browser" },
        output: body,
      }),
    );
    assert.match(text, /✓ search_mcp/);
    assert.match(text, /playwright__click/);
    assert.match(text, /playwright__screenshot/);
    const empty = strip(
      formatDefaultToolEndTranscript("search_mcp", {
        isError: false,
        ms: 20,
        bytes: 20,
        args: { query: "zzz" },
        output: 'No MCP tools matched "zzz".',
      }),
    );
    assert.equal(empty.includes("\n"), false);
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
    assert.match(text, /✓ bash echo hi/);
    assert.doesNotMatch(text, /command=/);
    assert.match(text, /hello/);
    assert.match(text, /world/);
  });

  it("joins grep pattern + path and keeps labeled keys for plan/task_id", () => {
    const grep = strip(
      formatToolEnd("grep", {
        isError: false,
        ms: 6,
        bytes: 20,
        args: { pattern: "TODO", path: "src/tui" },
      }),
    );
    assert.match(grep, /✓ grep TODO src\/tui/);
    assert.doesNotMatch(grep, /pattern=|path=/);
    const plan = strip(
      formatToolEnd("exit_plan_mode", {
        isError: false,
        ms: 5,
        bytes: 80,
        args: { plan: "Ship slim /diff then prove." },
      }),
    );
    assert.match(plan, /plan=Ship slim \/diff then prove\./);
    const wait = strip(
      formatToolEnd("get_task_output", {
        isError: false,
        ms: 12,
        bytes: 40,
        args: { task_id: "abc123" },
      }),
    );
    assert.match(wait, /task_id=abc123/);
  });
});

describe("coalesced same-tool successes", () => {
  it("keeps a single success as a normal ✓ row", () => {
    const bare = strip(
      formatCoalescedToolEnd("grep", 1, {
        ms: 12,
        bytes: 40,
        args: { pattern: "foo" },
      }),
    );
    assert.match(bare, /✓ grep foo/);
    assert.doesNotMatch(bare, /pattern=|×/);
  });

  it("collapses consecutive same-tool successes to ×N", () => {
    const lines: string[] = [];
    const c = createToolEndCoalescer((line) => lines.push(strip(line)));
    c.push("grep", { ms: 10, bytes: 20, args: { pattern: "a" } });
    c.push("grep", { ms: 11, bytes: 21, args: { pattern: "b" } });
    c.push("grep", { ms: 12, bytes: 22, args: { pattern: "c" } });
    assert.equal(lines.length, 0);
    c.flush();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /✓ grep ×3 c/);
    assert.doesNotMatch(lines[0]!, /pattern=/);
    assert.match(lines[0]!, /33ms/);
  });

  it("flushes the group before a failure and does not join ✗ rows", () => {
    const lines: string[] = [];
    const c = createToolEndCoalescer((line) => lines.push(strip(line)));
    c.push("read_file", { ms: 4, bytes: 10, args: { path: "a.ts" } });
    c.push("read_file", { ms: 5, bytes: 11, args: { path: "b.ts" } });
    c.push("bash", {
      isError: true,
      ms: 8,
      bytes: 40,
      args: { command: "npm test" },
      output: "not ok — expected 2",
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /✓ read ×2 b\.ts/);
    assert.match(lines[1]!, /✗ bash npm test/);
    assert.doesNotMatch(lines.join("\n"), /path=|command=|read_file/);
    c.flush();
    assert.equal(lines.length, 2);
  });

  it("flushUnless keeps a same-name burst and prints before a different tool", () => {
    const lines: string[] = [];
    const c = createToolEndCoalescer((line) => lines.push(strip(line)));
    c.push("grep", { ms: 4, bytes: 10, args: { pattern: "a" } });
    c.push("grep", { ms: 5, bytes: 11, args: { pattern: "b" } });
    c.flushUnless("grep");
    assert.equal(lines.length, 0);
    c.flushUnless("bash");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /✓ grep ×2 b/);
  });

  it("does not coalesce successful edits that carry a diff", () => {
    const lines: string[] = [];
    const c = createToolEndCoalescer((line) => lines.push(strip(line)));
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new";
    c.push("search_replace", {
      ms: 4,
      bytes: 20,
      args: { path: "src/a.ts" },
      diff,
    });
    c.push("search_replace", {
      ms: 5,
      bytes: 22,
      args: { path: "src/b.ts" },
      diff,
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /✓ edit src\/a\.ts/);
    assert.match(lines[1]!, /✓ edit src\/b\.ts/);
    assert.match(lines.join("\n"), /-old/);
    assert.doesNotMatch(lines.join("\n"), /×|--- a\//);
  });

  it("does not coalesce spawn_subagent rows that carry a report", () => {
    const lines: string[] = [];
    const c = createToolEndCoalescer((line) => lines.push(strip(line)));
    const report = "### Subagent result: a\n- status: completed\n\npick: one";
    c.push("spawn_subagent", {
      ms: 100,
      bytes: 40,
      args: { subagent_type: "explore", description: "a" },
      output: report,
    });
    c.push("spawn_subagent", {
      ms: 120,
      bytes: 50,
      args: { subagent_type: "explore", description: "b" },
      output: "### Subagent result: b\n- status: completed\n\npick: two",
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /✓ spawn_subagent explore: a/);
    assert.match(lines[1]!, /✓ spawn_subagent explore: b/);
    assert.match(lines.join("\n"), /pick: one/);
    assert.match(lines.join("\n"), /pick: two/);
    assert.doesNotMatch(lines.join("\n"), /×/);
  });

  it("does not coalesce long successful bash that carries a tail", () => {
    const lines: string[] = [];
    const c = createToolEndCoalescer((line) => lines.push(strip(line)));
    const out = "a\nb\nc\nd\ne\npass 12";
    c.push("bash", { ms: 80, bytes: 20, args: { command: "npm test" }, output: out });
    c.push("bash", { ms: 90, bytes: 22, args: { command: "npm test" }, output: out });
    assert.equal(lines.length, 2);
    assert.match(lines.join("\n"), /pass 12/);
    assert.doesNotMatch(lines.join("\n"), /×/);
  });

  it("does not coalesce /verbose rows", () => {
    const lines: string[] = [];
    const c = createToolEndCoalescer((line) => lines.push(strip(line)));
    c.push("grep", { ms: 4, bytes: 10, args: { pattern: "a" } }, { verbose: true });
    c.push("grep", { ms: 5, bytes: 11, args: { pattern: "b" } }, { verbose: true });
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /✓ grep a/);
    assert.match(lines[1]!, /✓ grep b/);
    assert.doesNotMatch(lines.join("\n"), /×|pattern=/);
  });
});

describe("delayed tool start", () => {
  function fakeClock() {
    const timers = new Map<number, () => void>();
    let nextId = 1;
    return {
      printed: [] as string[],
      setTimeout(fn: () => void, _ms: number) {
        const id = nextId++;
        timers.set(id, fn);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        timers.delete(handle as unknown as number);
      },
      fireAll() {
        for (const fn of [...timers.values()]) fn();
        timers.clear();
      },
      pending() {
        return timers.size;
      },
    };
  }

  it("does not print ▸ when the tool settles before the delay", () => {
    const clock = fakeClock();
    const d = createToolStartDelayer((line) => clock.printed.push(strip(line)), {
      delayMs: 700,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d.push("bash", { command: "npm test" });
    assert.equal(clock.printed.length, 0);
    d.settle("bash");
    clock.fireAll();
    assert.equal(clock.printed.length, 0);
    assert.equal(clock.pending(), 0);
  });

  it("prints ▸ once the delay fires on a still-running tool", () => {
    const clock = fakeClock();
    const d = createToolStartDelayer((line) => clock.printed.push(strip(line)), {
      delayMs: 700,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d.push("bash", { command: "npm test" });
    clock.fireAll();
    assert.equal(clock.printed.length, 1);
    assert.match(clock.printed[0]!, /▸ bash npm test/);
    d.settle("bash");
    clock.fireAll();
    assert.equal(clock.printed.length, 1);
  });

  it("prints immediately when /verbose or delayMs is 0", () => {
    const lines: string[] = [];
    const verbose = createToolStartDelayer((line) => lines.push(strip(line)), {
      delayMs: 700,
    });
    verbose.push("read_file", { path: "src/a.ts" }, { immediate: true });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /▸ read src\/a\.ts/);
    verbose.settle("read_file");

    const instant = createToolStartDelayer((line) => lines.push(strip(line)), {
      delayMs: 0,
    });
    instant.push("grep", { pattern: "foo" });
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /▸ grep foo/);
    instant.settle("grep");
  });

  it("flush drops unfired starts and does not leak timers", () => {
    const clock = fakeClock();
    const d = createToolStartDelayer((line) => clock.printed.push(strip(line)), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d.push("bash", { command: "sleep 30" });
    d.flush();
    clock.fireAll();
    assert.equal(clock.printed.length, 0);
    assert.equal(clock.pending(), 0);
  });

  it("cancels each of a same-name burst that all finish under the delay", () => {
    const clock = fakeClock();
    const d = createToolStartDelayer((line) => clock.printed.push(strip(line)), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d.push("grep", { pattern: "a" });
    d.push("grep", { pattern: "b" });
    d.push("grep", { pattern: "c" });
    d.settle("grep");
    d.settle("grep");
    d.settle("grep");
    clock.fireAll();
    assert.equal(clock.printed.length, 0);
  });
});
