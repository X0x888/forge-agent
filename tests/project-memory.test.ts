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
  sweepProjectMemory,
} from "../src/harness/project-memory.js";
import {
  classifyStaleProjectMemory,
  formatProjectMemoryBannerLine,
  looksLikeCycleScopedMemory,
} from "../src/harness/project-memory-sweep.js";
import { toolMemoryWrite } from "../src/agent/tools/memory-write.js";
import type { ToolContext } from "../src/agent/tools/types.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { handleSlash } from "../src/commands/slash.js";
import { HookRunner } from "../src/harness/hooks.js";

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

  it("classifies leftover cycle readings and superseded checkpoint facts", () => {
    assert.equal(
      looksLikeCycleScopedMemory(
        "Daily-loop reading (this cycle): job + what's wrong. Ships: /verify, /done",
      ),
      true,
    );
    assert.equal(
      looksLikeCycleScopedMemory(
        "blockingStopHooks defaults to true — never weaken Stop fail-closed",
      ),
      false,
    );
    const now = Date.now();
    const recs = [
      {
        id: "old",
        at: new Date(now - 60_000).toISOString(),
        kind: "fact" as const,
        text: "ULW arm auto-checkpoints dirty trees via git stash create (FORGE_ULW_CHECKPOINT=0 off). Restore: /checkpoint restore.",
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "cycle",
        at: new Date(now - 30_000).toISOString(),
        kind: "decision" as const,
        text: "Daily-loop reading (this cycle): job + what's wrong + the next key you type at ›. Ships: /verify, lastErr slash keys. Do not re-derive.",
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "new",
        at: new Date(now).toISOString(),
        kind: "gotcha" as const,
        text: "Safety checkpoints use a temp index (untracked in, secrets out), not git stash create. Restore is git restore --source=sha overwrite + mixed reset — never git stash apply. /checkpoint restore falls back to ulw.checkpointSha.",
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "keep",
        at: new Date(now).toISOString(),
        kind: "constraint" as const,
        text: "blockingStopHooks defaults to true — never weaken Stop fail-closed (timeout/error keeps agent working).",
        source: "agent" as const,
        status: "active" as const,
      },
    ];
    const hits = classifyStaleProjectMemory(recs);
    assert.ok(hits.some((h) => h.id === "cycle" && h.reason === "cycle-scoped" && h.auto));
    assert.ok(hits.some((h) => h.id === "old" && h.reason === "superseded" && h.auto));
    assert.ok(!hits.some((h) => h.id === "keep"));
    assert.ok(!hits.some((h) => h.id === "new"));
  });

  it("does not treat neighboring gotchas as superseded (sit-down / porcelain)", () => {
    const now = Date.now();
    const recs = [
      {
        id: "porcelain-old",
        at: new Date(now - 50_000).toISOString(),
        kind: "gotcha" as const,
        text: 'git() in worktree.ts must not trimStart porcelain: unstaged-only is " M path". trim() made slice(3) drop first char (src→rc) and hide untracked. tests/__wt_land__/ is gitignored — worktree-land fixtures live under src/agent/__wt_land_*.',
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "sit-down",
        at: new Date(now - 40_000).toISOString(),
        kind: "convention" as const,
        text: "Sit-down Next at › is a slash key, never a CLI dump (`npm test`, `forge accounts switch`, `forge login`). lastErr map: 429/quota → /accounts, auth → /auth, overflow → /compact, max_cost → /budget, else /retry. Headless `forge run` keeps CLI verbs.",
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "porcelain-new",
        at: new Date(now - 20_000).toISOString(),
        kind: "gotcha" as const,
        text: 'parsePorcelainPath / unquotePorcelainPath are public. git() uses trimEnd only — never trimStart porcelain. Unit test: " M src/agent/worktree.ts" → src/agent/worktree.ts.',
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "never-land",
        at: new Date(now - 10_000).toISOString(),
        kind: "gotcha" as const,
        text: "Never land src/agent/worktree.ts or AGENTS.md in worktree-land tests — a failed /undo restore deletes the file. Use disposable src/agent/__wt_land_* fixtures + journalLandedPreimages unit path.",
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "auth",
        at: new Date(now).toISOString(),
        kind: "gotcha" as const,
        text: "`/auth` empty is `auth  ·  none` with no Next — login is not a › key. `/accounts` empty still closer `/auth`. `formatAuthCard` hides Next `/auth` so the lastErr key is not circular.",
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "git-apply",
        at: new Date(now - 5_000).toISOString(),
        kind: "gotcha" as const,
        text: "git apply --3way stages files; land path prefers plain apply then 3way+unstage so parent index stays clean. Unstage must use git() (trimEnd only) + parsePorcelainPath — never execFileSync().trim() on porcelain.",
        source: "agent" as const,
        status: "active" as const,
      },
      {
        id: "checkpoint",
        at: new Date(now + 1_000).toISOString(),
        kind: "gotcha" as const,
        text: "Safety checkpoints use a temp index (untracked in, secrets out), not git stash create. Restore is git restore --source=sha overwrite + mixed reset — never git stash apply.",
        source: "agent" as const,
        status: "active" as const,
      },
    ];
    const hits = classifyStaleProjectMemory(recs);
    assert.ok(!hits.some((h) => h.id === "porcelain-old"), JSON.stringify(hits));
    assert.ok(!hits.some((h) => h.id === "sit-down"), JSON.stringify(hits));
    assert.ok(!hits.some((h) => h.id === "git-apply"), JSON.stringify(hits));
  });

  it("does not auto-archive user-written cycle notes", () => {
    const hits = classifyStaleProjectMemory([
      {
        id: "u",
        at: new Date().toISOString(),
        kind: "decision",
        text: "Keep this cycle focused on the lease card. Ships: /verify",
        source: "user",
        status: "active",
      },
    ]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.auto, false);
    assert.equal(hits[0]?.reason, "cycle-scoped");
  });

  it("sweep archives leftovers and prompt injection drops them", () => {
    appendProjectMemory(ws, {
      kind: "decision",
      text: "Daily-loop reading (this cycle): finish the sit-down keys. Ships: /verify",
      source: "agent",
    });
    appendProjectMemory(ws, {
      kind: "constraint",
      text: "Never weaken auth tests",
      source: "user",
    });
    const result = sweepProjectMemory(ws, { force: true });
    assert.equal(result.archived.length, 1);
    assert.equal(result.archived[0]?.reason, "cycle-scoped");
    const active = listActiveProjectMemory(ws);
    assert.equal(active.length, 1);
    assert.match(active[0]!.text, /Never weaken auth tests/);
    const prompt = formatProjectMemoryForPrompt(ws);
    assert.match(prompt, /Never weaken auth tests/);
    assert.doesNotMatch(prompt, /Daily-loop reading/);
    assert.match(prompt, /\/memory project/);
  });

  it("FORGE_MEMORY_SWEEP=0 skips auto apply; force prune still works", () => {
    const prev = process.env.FORGE_MEMORY_SWEEP;
    process.env.FORGE_MEMORY_SWEEP = "0";
    try {
      appendProjectMemory(ws, {
        kind: "decision",
        text: "Wave 2 reading (this cycle): only the prune card. Ships: /memory",
        source: "agent",
      });
      const dry = sweepProjectMemory(ws);
      assert.equal(dry.applied, false);
      assert.equal(listActiveProjectMemory(ws).length, 1);
      const forced = sweepProjectMemory(ws, { force: true });
      assert.equal(forced.archived.length, 1);
      assert.equal(listActiveProjectMemory(ws).length, 0);
    } finally {
      if (prev === undefined) delete process.env.FORGE_MEMORY_SWEEP;
      else process.env.FORGE_MEMORY_SWEEP = prev;
    }
  });

  it("banner reminder names /memory project", () => {
    const line = formatProjectMemoryBannerLine({
      active: 16,
      archived: [
        {
          id: "x",
          kind: "decision",
          text: "this cycle leftover",
          source: "agent",
          reason: "cycle-scoped",
          detail: "cycle",
          auto: true,
        },
      ],
    });
    assert.match(String(line), /memory {2}· {2}16 active/);
    assert.match(String(line), /archived 1 leftover/);
    assert.match(String(line), /Next {2}\/memory project/);
  });

  it("memory_write scope=project refuses cycle-scoped text", async () => {
    const ctx = {
      workspace: ws,
      sessionId: "sess-pm-cycle",
    } as unknown as ToolContext;
    const r = await toolMemoryWrite(
      {
        scope: "project",
        kind: "decision",
        text: "Daily-loop reading (this cycle): do not put this in project memory. Ships: /verify",
      },
      ctx,
    );
    assert.match(r.output, /Refused project memory/i);
    assert.equal(listActiveProjectMemory(ws).length, 0);
    assert.match(r.output, /scope=session/);
  });

  it("/memory project prune dry then apply", async () => {
    appendProjectMemory(ws, {
      kind: "decision",
      text: "Reading (this cycle): prune card. Ships: /verify",
      source: "agent",
    });
    const session = createSession({
      cwd: ws,
      provider: "xai",
      model: "grok-4",
    });
    const config = { ...DEFAULT_CONFIG, workspace: ws };
    const hooks = new HookRunner(config, ws);
    const dry = await handleSlash("/memory project prune dry", {
      session,
      config,
      hooks,
    });
    assert.equal(dry.handled, true);
    assert.match(String(dry.output || ""), /memory prune {2}· {2}1 leftover \(dry\)/);
    assert.equal(listActiveProjectMemory(ws).length, 1);
    const apply = await handleSlash("/memory prune", {
      session,
      config,
      hooks,
    });
    assert.match(String(apply.output || ""), /archived 1 leftover/);
    assert.equal(listActiveProjectMemory(ws).length, 0);
  });

  it("bare /memory is leftover/healthy peek, not a ledger dump", async () => {
    const session = createSession({
      cwd: ws,
      provider: "xai",
      model: "grok-4",
    });
    const config = { ...DEFAULT_CONFIG, workspace: ws };
    const hooks = new HookRunner(config, ws);
    const empty = await handleSlash("/memory", { session, config, hooks });
    assert.match(String(empty.output || ""), /^memory {2}· {2}none/m);
    assert.match(String(empty.output || ""), /session 0 {2}· {2}project 0/);
    assert.match(String(empty.output || ""), /Next {2}\/memory add/);
    assert.doesNotMatch(String(empty.output || ""), /Decision memory:|root:|store:/);

    appendProjectMemory(ws, {
      kind: "decision",
      text: "Reading (this cycle): peek leftover. Ships: /memory",
      source: "agent",
    });
    const leftover = await handleSlash("/memory", { session, config, hooks });
    assert.match(String(leftover.output || ""), /^memory {2}· {2}leftover/m);
    assert.match(String(leftover.output || ""), /1 leftover/);
    assert.match(String(leftover.output || ""), /Next {2}\/memory project prune/);
    assert.doesNotMatch(String(leftover.output || ""), /Decision memory:/);

    const list = await handleSlash("/memory list", { session, config, hooks });
    assert.match(String(list.output || ""), /Decision memory:/);
    assert.match(String(list.output || ""), /Project memory:/);
  });
});
