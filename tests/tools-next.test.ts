import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/agent/tools/index.js";
import {
  assertUrlSafe,
  isBlockedForHost,
  isNonPublicIp,
} from "../src/agent/tools/ssrf.js";
import { htmlToText, readBodyCapped } from "../src/agent/tools/web-fetch.js";
import { locateEdit, applyMatch } from "../src/agent/tools/edit-match.js";
import {
  _resetTasksForTests,
  killTask,
  killAllRunningTasks,
  listTasks,
  readTaskOutput,
} from "../src/agent/tools/background-tasks.js";

let tmpRoot: string;
let forgeHome: string;

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-next-"));
  forgeHome = path.join(tmpRoot, "forge-home");
  process.env.FORGE_HOME = forgeHome;
});

after(async () => {
  _resetTasksForTests();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("SSRF policy", () => {
  it("flags private and loopback IPs", () => {
    assert.equal(isNonPublicIp("127.0.0.1"), true);
    assert.equal(isNonPublicIp("10.0.0.1"), true);
    assert.equal(isNonPublicIp("192.168.1.1"), true);
    assert.equal(isNonPublicIp("169.254.1.1"), true);
    assert.equal(isNonPublicIp("100.64.0.1"), true);
    assert.equal(isNonPublicIp("8.8.8.8"), false);
    assert.equal(isNonPublicIp("::1"), true);
  });

  it("blocks loopback unless allowLocal + explicit host", () => {
    assert.equal(isBlockedForHost("127.0.0.1", "127.0.0.1", false), true);
    assert.equal(isBlockedForHost("127.0.0.1", "127.0.0.1", true), false);
    assert.equal(isBlockedForHost("127.0.0.1", "evil.example", true), true);
    assert.equal(isBlockedForHost("10.0.0.5", "10.0.0.5", true), true);
  });

  it("rejects file: and credentialed URLs", async () => {
    await assert.rejects(() => assertUrlSafe("file:///etc/passwd"), /http/);
    await assert.rejects(
      () => assertUrlSafe("https://user:pass@example.com/"),
      /credentials/,
    );
  });

  it("rejects literal private IPs", async () => {
    await assert.rejects(
      () => assertUrlSafe("http://127.0.0.1:8080/"),
      /Blocked/,
    );
    await assert.rejects(() => assertUrlSafe("http://10.1.2.3/"), /Blocked/);
  });

  it("allows explicit loopback when allow_local", async () => {
    const u = await assertUrlSafe("http://127.0.0.1:9/", true);
    assert.equal(u.hostname, "127.0.0.1");
  });
});

describe("block_anchor edit", () => {
  it("matches when middle lines drift slightly", () => {
    const content = [
      "export function compute(a: number) {",
      "  const x = a + 1;",
      "  const y = x * 2;",
      "  return y;",
      "}",
      "",
    ].join("\n");
    // middle lines differ in whitespace/wording slightly
    const old = [
      "export function compute(a: number) {",
      "const x = a+1;",
      "const y = x*2;",
      "return y;",
      "}",
    ].join("\n");
    const r = locateEdit(content, old, false);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(
        r.result.kind === "line_trimmed" || r.result.kind === "block_anchor",
      );
      const next = applyMatch(
        content,
        r.result,
        "export function compute(a: number) {\n  return a * 3;\n}",
        false,
      );
      assert.match(next, /return a \* 3/);
    }
  });
});

describe("web_fetch htmlToText", () => {
  it("decodes common entities and strips tags/scripts", () => {
    const out = htmlToText(
      "<html><script>evil()</script><style>.x{}</style><body><h1>Hi&nbsp;&amp;&lt;x&gt;</h1><br>line</body></html>",
    );
    assert.match(out, /Hi &<x>/);
    assert.match(out, /line/);
    assert.doesNotMatch(out, /evil|script|style|\.x/i);
    assert.doesNotMatch(out, /<h1>/);
  });

  it("never throws on invalid / out-of-range numeric entities", () => {
    // Previously String.fromCodePoint threw RangeError on these
    const nasty =
      "ok &#x110000; &#xFFFFFFFF; &#999999999; &#xD800; &#xDFFF; &#-1; end";
    assert.doesNotThrow(() => htmlToText(nasty));
    const out = htmlToText(nasty);
    assert.match(out, /^ok /);
    assert.match(out, / end$/);
    // Invalid entities preserved (or safely dropped) — must not crash the tool
    assert.ok(out.includes("&#x110000;") || out.includes("ok"));
  });

  it("decodes valid hex/decimal code points", () => {
    assert.equal(htmlToText("A&#x41;B&#66;C"), "AABBC");
    assert.equal(htmlToText("smile &#x1F600;"), "smile 😀");
  });
});

describe("readBodyCapped", () => {
  it("stops when body exceeds maxBytes without Content-Length", async () => {
    const payload = Buffer.alloc(64 * 1024, 0x61); // 64 KiB of 'a'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Push in chunks so the reader path is exercised
        const chunk = 8 * 1024;
        for (let off = 0; off < payload.length; off += chunk) {
          controller.enqueue(payload.subarray(off, off + chunk));
        }
        controller.close();
      },
    });
    const resp = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const small = await readBodyCapped(resp, 16 * 1024);
    assert.equal(small.tooLarge, true);
    assert.equal(small.buf.length, 0);
  });

  it("returns full body when under cap", async () => {
    const resp = new Response("hello forge", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const r = await readBodyCapped(resp, 1024);
    assert.equal(r.tooLarge, false);
    assert.equal(r.buf.toString("utf8"), "hello forge");
  });
});

describe("web_fetch live local server", () => {
  it("fetches HTML and strips tags; blocks default local without allow_local", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Hello Forge</h1><p>ok</p></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const url = `http://127.0.0.1:${addr.port}/`;

    const blocked = await executeTool(
      "web_fetch",
      JSON.stringify({ url }),
      { workspace: tmpRoot, sandbox: "off" },
    );
    assert.equal(blocked.isError, true);
    assert.match(blocked.output, /Blocked|Local host/i);

    const ok = await executeTool(
      "web_fetch",
      JSON.stringify({ url, allow_local: true }),
      { workspace: tmpRoot, sandbox: "off" },
    );
    assert.equal(ok.isError, undefined, ok.output);
    assert.match(ok.output, /Hello Forge/);
    assert.doesNotMatch(ok.output, /<h1>/);

    // Pre-aborted signal must cancel before network I/O
    const ac = new AbortController();
    ac.abort();
    const aborted = await executeTool(
      "web_fetch",
      JSON.stringify({ url, allow_local: true }),
      { workspace: tmpRoot, sandbox: "off", signal: ac.signal },
    );
    assert.equal(aborted.isError, true);
    assert.match(aborted.output, /Aborted/i);

    const searchAborted = await executeTool(
      "web_search",
      JSON.stringify({ query: "forge agent" }),
      { workspace: tmpRoot, sandbox: "off", signal: ac.signal },
    );
    assert.equal(searchAborted.isError, true);
    assert.match(searchAborted.output, /Aborted/i);

    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
});

describe("background bash tasks", () => {
  it("starts, polls, and completes", async () => {
    _resetTasksForTests();
    const ws = path.join(tmpRoot, "ws-bg");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };

    const start = await executeTool(
      "bash",
      JSON.stringify({
        command: "echo bg-hello-$$; sleep 0.3; echo done-bg",
        background: true,
      }),
      ctx,
    );
    assert.equal(start.isError, undefined, start.output);
    const m = start.output.match(/task_id:\s*(bg_\w+)/);
    assert.ok(m, start.output);
    const taskId = m![1];

    let status = "";
    for (let i = 0; i < 40; i++) {
      const out = await executeTool(
        "get_task_output",
        JSON.stringify({ task_id: taskId, tail: 50 }),
        ctx,
      );
      assert.equal(out.isError, undefined, out.output);
      if (out.output.includes("status: completed")) {
        status = "completed";
        assert.match(out.output, /done-bg|bg-hello/);
        break;
      }
      if (out.output.includes("status: failed")) {
        status = "failed";
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(status, "completed");
  });

  it("kills a long-running task", async () => {
    _resetTasksForTests();
    const ws = path.join(tmpRoot, "ws-kill");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };

    const start = await executeTool(
      "bash",
      JSON.stringify({
        command: "sleep 60",
        background: true,
      }),
      ctx,
    );
    assert.equal(start.isError, undefined, start.output);
    const m = start.output.match(/task_id:\s*(bg_\w+)/);
    assert.ok(m);
    const taskId = m![1];

    const killed = await executeTool(
      "kill_task",
      JSON.stringify({ task_id: taskId }),
      ctx,
    );
    assert.equal(killed.isError, undefined, killed.output);
    assert.match(killed.output, /Killed/);

    // allow process to settle
    await new Promise((r) => setTimeout(r, 100));
    const snap = await readTaskOutput(taskId, { tail: 20 });
    assert.match(snap, /status: killed|status: failed|status: completed/);
    void killTask; // imported for types
  });

  it("killAllRunningTasks stops every running bg shell", async () => {
    _resetTasksForTests();
    const ws = path.join(tmpRoot, "ws-killall");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };
    for (let i = 0; i < 2; i++) {
      const start = await executeTool(
        "bash",
        JSON.stringify({ command: "sleep 60", background: true }),
        ctx,
      );
      assert.equal(start.isError, undefined, start.output);
    }
    assert.equal(listTasks().filter((t) => t.status === "running").length, 2);
    const n = killAllRunningTasks({ force: true });
    assert.equal(n, 2);
    assert.equal(listTasks().filter((t) => t.status === "running").length, 0);
    assert.ok(listTasks().every((t) => t.status === "killed"));
    // Idempotent
    assert.equal(killAllRunningTasks({ force: true }), 0);
  });
});

describe("task-tools error paths", () => {
  it("get_task_output / kill_task require task_id and list actives when present", async () => {
    _resetTasksForTests();
    const ws = path.join(tmpRoot, "ws-task-err");
    await fsp.mkdir(ws, { recursive: true });
    const ctx = { workspace: ws, sandbox: "off" as const };

    const emptyOut = await executeTool("get_task_output", "{}", ctx);
    assert.equal(emptyOut.isError, true);
    assert.match(emptyOut.output, /task_id is required/i);
    assert.match(emptyOut.output, /No background tasks/i);

    const emptyKill = await executeTool("kill_task", "{}", ctx);
    assert.equal(emptyKill.isError, true);
    assert.match(emptyKill.output, /task_id is required/i);
    assert.match(emptyKill.output, /No background tasks/i);

    const unknown = await executeTool(
      "get_task_output",
      JSON.stringify({ task_id: "nope-xyz" }),
      ctx,
    );
    assert.equal(unknown.isError, true);
    assert.match(unknown.output, /Unknown task_id/i);

    const start = await executeTool(
      "bash",
      JSON.stringify({ command: "sleep 30", background: true }),
      ctx,
    );
    assert.equal(start.isError, undefined, start.output);
    const m = start.output.match(/task_id[:\s]+([a-zA-Z0-9_-]+)/i);
    assert.ok(m, start.output);

    const listOut = await executeTool("get_task_output", "{}", ctx);
    assert.equal(listOut.isError, true);
    assert.match(listOut.output, /Active tasks/i);
    assert.match(listOut.output, new RegExp(m![1]));

    const listKill = await executeTool("kill_task", "{}", ctx);
    assert.equal(listKill.isError, true);
    assert.match(listKill.output, /Active tasks/i);
    assert.match(listKill.output, new RegExp(m![1]));

    killAllRunningTasks({ force: true });
  });
});

describe("TOOL_DEFINITIONS agent guidance", () => {
  it("documents path hints, parent dirs, and large-file guidance", async () => {
    const { TOOL_DEFINITIONS } = await import(
      "../src/agent/tools/definitions.js"
    );
    const byName = Object.fromEntries(
      TOOL_DEFINITIONS.map((t) => [t.function.name, t.function.description]),
    );
    const byFull = Object.fromEntries(
      TOOL_DEFINITIONS.map((t) => [t.function.name, t.function]),
    );
    assert.match(byName.read_file || "", /did you mean|typo/i);
    assert.match(byName.read_file || "", /2 MiB|large/i);
    assert.match(byName.write_file || "", /parent director/i);
    assert.match(byName.write_file || "", /directory target|Refuses directory/i);
    assert.match(byName.search_replace || "", /not a directory/i);
    assert.match(byName.glob || "", /path hints|No files matched/i);
    assert.match(byName.grep || "", /Missing paths|hints/i);
    assert.match(byName.list_dir || "", /path-not-found|hints/i);
    assert.match(byName.web_fetch || "", /entities never throw|SSRF/i);
    assert.match(byName.web_fetch || "", /abort|Ctrl\+C|FORGE_MAX_RUN_MS/i);
    assert.match(byName.web_search || "", /abort|Ctrl\+C|FORGE_MAX_RUN_MS/i);
    assert.match(byName.kill_task || "", /Omit task_id|list active|get_task_output/i);
    assert.match(byName.get_task_output || "", /Omit task_id|list active/i);
    assert.match(byName.apply_patch || "", /typo|path hint/i);
    // Schema must match runtime: omit task_id lists actives (not required)
    const killReq = byFull.kill_task?.parameters?.required || [];
    const getReq = byFull.get_task_output?.parameters?.required || [];
    assert.ok(!killReq.includes("task_id"));
    assert.ok(!getReq.includes("task_id"));
  });
});
