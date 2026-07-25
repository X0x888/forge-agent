/**
 * File-aware /undo journal + /init + /compact-and (OpenCode / Warp inspired).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSession,
  markUserTurn,
  rewindSessionDetailed,
  forkSession,
  clearConversation,
} from "../src/session/session.js";
import {
  appendFileMutation,
  readFileMutations,
  restoreMutationsAfterTurn,
  formatRestoreResult,
} from "../src/session/mutations.js";
import { executeTool } from "../src/agent/tools/index.js";
import {
  handleSlash,
  buildInitAgentsPrompt,
  buildReviewPrompt,
  completeSlash,
} from "../src/commands/slash.js";
import {
  defaultBashTimeoutMs,
  defaultBashBackgroundTimeoutMs,
} from "../src/util/env.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("file mutation journal + undo", () => {
  let home: string;
  let workspace: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mut-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mut-ws-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("write_file journals create and /undo removes the file", async () => {
    const s = createSession({
      cwd: workspace,
      provider: "xai",
      model: "grok-4",
    });
    s.meta.turnCount = 1;
    markUserTurn(s);
    s.messages.push({ role: "user", content: "add file" });

    const target = path.join(workspace, "hello.txt");
    const result = await executeTool(
      "write_file",
      JSON.stringify({ path: "hello.txt", content: "hi\n" }),
      {
        workspace,
        onEdit: () => {
          s.meta.editCount += 1;
        },
        recordMutation: (input) => {
          appendFileMutation(s.meta.id, {
            ...input,
            turn: s.meta.turnCount,
          });
        },
      },
    );
    assert.equal(result.isError, undefined);
    assert.ok(fs.existsSync(target));
    assert.equal(fs.readFileSync(target, "utf8"), "hi\n");

    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, "create");

    s.messages.push({ role: "assistant", content: "wrote" });
    const rw = rewindSessionDetailed(s, 1);
    assert.ok(rw.removed >= 1);
    assert.ok(rw.disk);
    assert.ok(rw.disk!.restored.length >= 1);
    assert.equal(fs.existsSync(target), false);
    assert.equal(readFileMutations(s.meta.id).length, 0);
  });

  it("search_replace journals update and /undo restores pre-image", async () => {
    const s = createSession({
      cwd: workspace,
      provider: "xai",
      model: "grok-4",
    });
    const target = path.join(workspace, "edit-me.ts");
    fs.writeFileSync(target, "export const n = 1;\n", "utf8");

    s.meta.turnCount = 1;
    markUserTurn(s);
    s.messages.push({ role: "user", content: "edit" });

    const result = await executeTool(
      "search_replace",
      JSON.stringify({
        path: "edit-me.ts",
        old_string: "export const n = 1;",
        new_string: "export const n = 2;",
      }),
      {
        workspace,
        recordMutation: (input) => {
          appendFileMutation(s.meta.id, {
            ...input,
            turn: s.meta.turnCount,
          });
        },
      },
    );
    assert.equal(result.isError, undefined);
    assert.match(fs.readFileSync(target, "utf8"), /n = 2/);

    s.messages.push({ role: "assistant", content: "edited" });
    const rw = rewindSessionDetailed(s, 1);
    assert.ok(rw.disk?.restored.some((r) => r.includes("edit-me.ts")));
    assert.equal(fs.readFileSync(target, "utf8"), "export const n = 1;\n");
  });

  it("apply_patch delete is restorable via journal", async () => {
    const s = createSession({
      cwd: workspace,
      provider: "xai",
      model: "grok-4",
    });
    const target = path.join(workspace, "gone.txt");
    fs.writeFileSync(target, "keep me\n", "utf8");
    s.meta.turnCount = 2;
    markUserTurn(s);
    s.messages.push({ role: "user", content: "delete" });

    const patch = `*** Begin Patch
*** Delete File: gone.txt
*** End Patch
`;
    const result = await executeTool(
      "apply_patch",
      JSON.stringify({ patchText: patch }),
      {
        workspace,
        recordMutation: (input) => {
          appendFileMutation(s.meta.id, {
            ...input,
            turn: s.meta.turnCount,
          });
        },
      },
    );
    assert.equal(result.isError, undefined);
    assert.equal(fs.existsSync(target), false);

    s.messages.push({ role: "assistant", content: "deleted" });
    rewindSessionDetailed(s, 1);
    assert.equal(fs.readFileSync(target, "utf8"), "keep me\n");
  });

  it("only restores mutations after keepThroughTurn", () => {
    const s = createSession({
      cwd: workspace,
      provider: "xai",
      model: "grok-4",
    });
    const a = path.join(workspace, "a.txt");
    const b = path.join(workspace, "b.txt");
    fs.writeFileSync(a, "A0\n", "utf8");
    fs.writeFileSync(b, "B0\n", "utf8");
    appendFileMutation(s.meta.id, {
      path: a,
      kind: "update",
      before: "A0\n",
      turn: 1,
    });
    fs.writeFileSync(a, "A1\n", "utf8");
    appendFileMutation(s.meta.id, {
      path: b,
      kind: "update",
      before: "B0\n",
      turn: 2,
    });
    fs.writeFileSync(b, "B1\n", "utf8");

    const r = restoreMutationsAfterTurn(s.meta.id, 1);
    assert.ok(r.restored.some((x) => x.includes("b.txt")));
    assert.equal(fs.readFileSync(b, "utf8"), "B0\n");
    assert.equal(fs.readFileSync(a, "utf8"), "A1\n"); // turn 1 kept
    assert.equal(readFileMutations(s.meta.id).length, 1);
  });

  it("fork copies mutation journal", () => {
    const s = createSession({
      cwd: workspace,
      provider: "xai",
      model: "grok-4",
    });
    appendFileMutation(s.meta.id, {
      path: path.join(workspace, "x"),
      kind: "create",
      turn: 1,
    });
    const f = forkSession(s, { title: "branch" });
    assert.equal(readFileMutations(f.meta.id).length, 1);
  });

  it("clearConversation drops journal", () => {
    const s = createSession({
      cwd: workspace,
      provider: "xai",
      model: "grok-4",
    });
    appendFileMutation(s.meta.id, {
      path: path.join(workspace, "x"),
      kind: "create",
      turn: 1,
    });
    clearConversation(s);
    assert.equal(readFileMutations(s.meta.id).length, 0);
  });

  it("formatRestoreResult is human-readable", () => {
    const text = formatRestoreResult({
      restored: ["~ /tmp/a"],
      failed: [],
      skipped: [{ path: "/tmp/big", reason: "too large" }],
    });
    assert.match(text, /Disk restored/);
    assert.match(text, /Skipped/);
    assert.match(text, /too large/);
  });
});

describe("/init and /compact-and slash commands", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-init-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("buildInitAgentsPrompt includes workspace and optional focus", () => {
    const p = buildInitAgentsPrompt("test commands", "/proj");
    assert.match(p, /AGENTS\.md/);
    assert.match(p, /\/proj/);
    assert.match(p, /test commands/);
  });

  it("/init forwards guided prompt", async () => {
    const s = createSession({ cwd: home, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, home);
    const r = await handleSlash("/init focus on CI", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: home },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.forwardPrompt);
    assert.match(r.forwardPrompt!, /AGENTS\.md/);
    assert.match(r.forwardPrompt!, /focus on CI/);
  });

  it("/compact-and requires a follow-up and then forwards", async () => {
    const s = createSession({ cwd: home, provider: "xai", model: "grok-4" });
    s.messages.push({ role: "user", content: "long history" });
    s.messages.push({ role: "assistant", content: "ok" });
    const hooks = new HookRunner(DEFAULT_CONFIG, home);
    const empty = await handleSlash("/compact-and", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.match(empty.output || "", /Usage/);
    assert.equal(empty.forwardPrompt, undefined);

    const r = await handleSlash("/compact-and continue the refactor", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.forwardPrompt, "continue the refactor");
    assert.match(r.output || "", /Compacted/);
  });

  it("tab-complete lists /init and /compact-and", () => {
    assert.ok(completeSlash("/in").some((c) => c === "/init"));
    assert.ok(completeSlash("/compact").some((c) => c === "/compact-and" || c === "/compact"));
  });

  it("/export to path uses mode 0600", async () => {
    const s = createSession({ cwd: home, provider: "xai", model: "grok-4" });
    s.messages.push({ role: "user", content: "secret-ish" });
    const out = path.join(home, "export.md");
    const hooks = new HookRunner(DEFAULT_CONFIG, home);
    const r = await handleSlash(`/export ${out}`, {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.match(r.output || "", /0600/);
    assert.ok(fs.existsSync(out));
    if (process.platform !== "win32") {
      const mode = fs.statSync(out).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });

  it("buildReviewPrompt scopes uncommitted / branch / commit / pr", () => {
    const u = buildReviewPrompt("uncommitted", "/ws");
    assert.match(u, /uncommitted working tree/i);
    assert.match(u, /git diff --cached/);
    const b = buildReviewPrompt("main", "/ws");
    assert.match(b, /main/);
    assert.match(b, /three-dot|HEAD/);
    const c = buildReviewPrompt("abc1234", "/ws");
    assert.match(c, /git show abc1234/);
    const p = buildReviewPrompt("42", "/ws");
    assert.match(p, /pull request 42|gh pr/i);
  });

  it("/review forwards review prompt", async () => {
    const s = createSession({ cwd: home, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, home);
    const r = await handleSlash("/review staged", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: home },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.forwardPrompt);
    assert.match(r.forwardPrompt!, /code reviewer/i);
    assert.match(r.forwardPrompt!, /staged/i);
  });

  it("/review rejects oversized / multiline targets", async () => {
    const s = createSession({ cwd: home, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, home);
    const r = await handleSlash("/review foo\nbar", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.match(r.output || "", /Invalid/);
    assert.equal(r.forwardPrompt, undefined);
  });

  it("tab-complete lists /review", () => {
    assert.ok(completeSlash("/rev").some((c) => c === "/review"));
  });

  it("FORGE_BASH_TIMEOUT_MS clamps and falls back", () => {
    const prev = process.env.FORGE_BASH_TIMEOUT_MS;
    const prevBg = process.env.FORGE_BASH_BG_TIMEOUT_MS;
    try {
      delete process.env.FORGE_BASH_TIMEOUT_MS;
      assert.equal(defaultBashTimeoutMs(), 120_000);
      process.env.FORGE_BASH_TIMEOUT_MS = "1000"; // below min → 5s
      assert.equal(defaultBashTimeoutMs(), 5_000);
      process.env.FORGE_BASH_TIMEOUT_MS = "600000";
      assert.equal(defaultBashTimeoutMs(), 600_000);
      process.env.FORGE_BASH_TIMEOUT_MS = "nope";
      assert.equal(defaultBashTimeoutMs(), 120_000);
      delete process.env.FORGE_BASH_BG_TIMEOUT_MS;
      assert.equal(defaultBashBackgroundTimeoutMs(), 30 * 60_000);
      process.env.FORGE_BASH_BG_TIMEOUT_MS = "1000";
      assert.equal(defaultBashBackgroundTimeoutMs(), 30_000);
    } finally {
      if (prev === undefined) delete process.env.FORGE_BASH_TIMEOUT_MS;
      else process.env.FORGE_BASH_TIMEOUT_MS = prev;
      if (prevBg === undefined) delete process.env.FORGE_BASH_BG_TIMEOUT_MS;
      else process.env.FORGE_BASH_BG_TIMEOUT_MS = prevBg;
    }
  });

  it("/undo reports disk restore via slash", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-undo-slash-"));
    const s = createSession({ cwd: ws, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    markUserTurn(s);
    s.messages.push({ role: "user", content: "write" });
    const f = path.join(ws, "z.txt");
    await executeTool(
      "write_file",
      JSON.stringify({ path: "z.txt", content: "z\n" }),
      {
        workspace: ws,
        recordMutation: (input) =>
          appendFileMutation(s.meta.id, { ...input, turn: 1 }),
      },
    );
    s.messages.push({ role: "assistant", content: "done" });
    assert.ok(fs.existsSync(f));
    const hooks = new HookRunner(DEFAULT_CONFIG, ws);
    const r = await handleSlash("/undo", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: ws },
      hooks,
    });
    assert.match(r.output || "", /Rewound/);
    assert.match(r.output || "", /Disk restored|already absent|z\.txt/);
    assert.equal(fs.existsSync(f), false);
  });
});
