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
import { locateEdit, applyMatch } from "../src/agent/tools/edit-match.js";
import {
  _resetTasksForTests,
  killTask,
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
});
