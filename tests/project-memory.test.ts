/**
 * Cross-session project memory.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendProjectMemory,
  archiveProjectMemory,
  clearProjectMemory,
  formatProjectMemoryForPrompt,
  formatProjectMemoryStatus,
  listActiveProjectMemory,
  loadProjectMemory,
  projectMemoryJsonPath,
  projectMemoryKey,
  resolveProjectMemoryRoot,
  stableProjectMemoryMarkdown,
} from "../src/harness/project-memory.js";
import { toolMemoryWrite } from "../src/agent/tools/memory-write.js";
import type { ToolContext } from "../src/agent/tools/types.js";

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

describe("project memory", () => {
  let prevHome = "";
  let fakeHome = "";
  let ws = "";

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    fakeHome = fs.mkdtempSync(path.join(tmpRoot(), "forge-pm-home-"));
    process.env.FORGE_HOME = fakeHome;
    // Must sit OUTSIDE this repo's git root — resolveProjectMemoryRoot walks up to git.
    // npm test sets TMPDIR=$PWD/.tmp, which os.tmpdir() honors — so force a real OS temp.
    const prevTmp = process.env.TMPDIR;
    delete process.env.TMPDIR;
    const outsideBase = fs.realpathSync(os.tmpdir());
    if (prevTmp !== undefined) process.env.TMPDIR = prevTmp;
    ws = fs.mkdtempSync(path.join(outsideBase, "forge-pm-ws-"));
    fs.writeFileSync(path.join(ws, "README.md"), "# t\n");
  });

  afterEach(() => {
    clearProjectMemory(ws);
  });

  after(() => {
    if (prevHome) process.env.FORGE_HOME = prevHome;
    else delete process.env.FORGE_HOME;
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      /* */
    }
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("keys by resolved root", () => {
    const root = resolveProjectMemoryRoot(ws);
    assert.equal(root, path.resolve(ws));
    assert.equal(projectMemoryKey(root).length, 16);
  });

  it("appends, dedupes, and formats prompt", () => {
    const a = appendProjectMemory(ws, {
      kind: "constraint",
      text: "Never weaken auth tests",
      source: "user",
    });
    assert.ok(a);
    const dup = appendProjectMemory(ws, {
      kind: "constraint",
      text: "Never weaken auth tests",
    });
    assert.equal(dup, null);
    appendProjectMemory(ws, {
      kind: "gotcha",
      text: "Use TMPDIR=$PWD/.tmp in tests",
    });
    const active = listActiveProjectMemory(ws);
    assert.equal(active.length, 2);
    const prompt = formatProjectMemoryForPrompt(ws);
    assert.match(prompt, /Project memory/);
    assert.match(prompt, /Never weaken auth tests/);
    assert.match(prompt, /TMPDIR/);
    // constraints should appear before gotchas / observations ordering
    assert.ok(
      prompt.indexOf("Never weaken") < prompt.indexOf("TMPDIR"),
    );
    const status = formatProjectMemoryStatus(ws);
    assert.match(status, /2 active/);
  });

  it("writes markdown mirror under .forge/MEMORY.md", () => {
    appendProjectMemory(ws, {
      kind: "convention",
      text: "ESM only with .js imports",
    });
    const md = path.join(ws, ".forge", "MEMORY.md");
    assert.ok(fs.existsSync(md));
    const body = fs.readFileSync(md, "utf8");
    assert.match(body, /ESM only/);
    assert.match(body, /convention/i);
  });

  it("does not rewrite MEMORY.md when only the updated timestamp would change", () => {
    appendProjectMemory(ws, {
      kind: "gotcha",
      text: "do not churn the tracked memory mirror",
    });
    const md = path.join(ws, ".forge", "MEMORY.md");
    const before = fs.readFileSync(md, "utf8");
    const beforeMtime = fs.statSync(md).mtimeMs;
    // Import path: delete JSON so the next load re-seeds from the mirror
    // and saveStore() would previously rewrite updated= and dirty git.
    fs.rmSync(projectMemoryJsonPath(ws), { force: true });
    loadProjectMemory(ws);
    const after = fs.readFileSync(md, "utf8");
    assert.equal(stableProjectMemoryMarkdown(after), stableProjectMemoryMarkdown(before));
    assert.equal(after, before, "timestamp-only rewrite must not touch the file");
    assert.equal(fs.statSync(md).mtimeMs, beforeMtime);
  });

  it("archives and clears", () => {
    appendProjectMemory(ws, { text: "temp fact", kind: "fact" });
    assert.equal(listActiveProjectMemory(ws).length, 1);
    assert.equal(archiveProjectMemory(ws, "temp fact"), 1);
    assert.equal(listActiveProjectMemory(ws).length, 0);
    appendProjectMemory(ws, { text: "a", kind: "fact" });
    appendProjectMemory(ws, { text: "b", kind: "fact" });
    assert.equal(clearProjectMemory(ws), 2);
    assert.equal(listActiveProjectMemory(ws).length, 0);
  });

  it("toolMemoryWrite scope=project works without session id", async () => {
    const ctx = {
      workspace: ws,
      sessionId: undefined,
    } as unknown as ToolContext;
    const r = await toolMemoryWrite(
      {
        scope: "project",
        kind: "gotcha",
        text: "sandboxed git init may fail chmod",
      },
      ctx,
    );
    assert.equal(r.isError, undefined);
    assert.match(r.output, /project gotcha/i);
    assert.equal(listActiveProjectMemory(ws).length, 1);
  });

  it("survives reload via JSON store", () => {
    appendProjectMemory(ws, {
      kind: "priority",
      text: "Ship reliability before polish",
    });
    const again = loadProjectMemory(ws);
    assert.ok(
      again.records.some((r) => r.text.includes("reliability before polish")),
    );
  });
});
