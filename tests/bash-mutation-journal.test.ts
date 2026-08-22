/**
 * Bash workspace writes join the mutation journal so /undo restores disk.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  applyBashTreeDelta,
  bashMutationJournalEnabled,
  beginBashTreeSnapshot,
  parsePorcelainRenameFrom,
} from "../src/agent/tools/bash-mutation-journal.js";
import {
  _resetTasksForTests,
  waitForTask,
} from "../src/agent/tools/background-tasks.js";
import { executeTool } from "../src/agent/tools/index.js";
import {
  appendFileMutation,
  readFileMutations,
  restoreMutationsAfterTurn,
} from "../src/session/mutations.js";
import {
  createSession,
  markUserTurn,
  rewindSessionDetailed,
} from "../src/session/session.js";
import { runBangShell } from "../src/tui/bang-shell.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

function scaffoldGitRepo(dir: string): void {
  const gitDir = path.join(dir, ".git");
  fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(gitDir, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
  );
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      HOME: dir,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("parsePorcelainRenameFrom", () => {
  it("returns the source of R old -> new", () => {
    assert.equal(parsePorcelainRenameFrom('R  "old.ts" -> "new file.ts"'), "old.ts");
    assert.equal(parsePorcelainRenameFrom("R  src/a.ts -> src/b.ts"), "src/a.ts");
    assert.equal(parsePorcelainRenameFrom(" M src/a.ts"), null);
  });
});

describe("bash mutation journal", () => {
  let home: string;
  let dir: string;
  let prevHome: string | undefined;
  let prevJournal: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bmj-home-"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bmj-"));
    prevHome = process.env.FORGE_HOME;
    prevJournal = process.env.FORGE_BASH_MUTATION_JOURNAL;
    process.env.FORGE_HOME = home;
    delete process.env.FORGE_BASH_MUTATION_JOURNAL;
    scaffoldGitRepo(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevJournal === undefined) delete process.env.FORGE_BASH_MUTATION_JOURNAL;
    else process.env.FORGE_BASH_MUTATION_JOURNAL = prevJournal;
    _resetTasksForTests();
  });

  function ctxRecord(sessionId: string, turn = 1) {
    let edits = 0;
    return {
      workspace: dir,
      edits: () => edits,
      recordMutation: (input: {
        path: string;
        kind: "create" | "update" | "delete";
        before?: string;
        mode?: number;
        skipped?: boolean;
        reason?: string;
      }) => {
        appendFileMutation(sessionId, { ...input, turn });
      },
      onEdit: () => {
        edits += 1;
      },
    };
  }

  it("enabled by default and honors FORGE_BASH_MUTATION_JOURNAL=0", () => {
    assert.equal(bashMutationJournalEnabled(), true);
    process.env.FORGE_BASH_MUTATION_JOURNAL = "0";
    assert.equal(bashMutationJournalEnabled(), false);
  });

  it("begin is null outside a git repo", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bmj-nogit-"));
    fs.writeFileSync(path.join(empty, ".git"), "gitdir: /nonexistent-bmj\n");
    assert.equal(beginBashTreeSnapshot(empty), null);
  });

  it("host GIT_DIR cannot redirect the journal porcelain to a decoy repo", () => {
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bmj-decoy-"));
    scaffoldGitRepo(decoy);
    fs.writeFileSync(path.join(decoy, "only-decoy.txt"), "decoy\n");
    git(decoy, ["add", "only-decoy.txt"]);
    git(decoy, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "decoy"]);

    const prevGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(decoy, ".git");
    try {
      const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
      s.meta.turnCount = 1;
      const snap = beginBashTreeSnapshot(dir);
      assert.ok(snap, "workspace repo must still snapshot under host GIT_DIR");
      fs.writeFileSync(path.join(dir, "from-workspace.txt"), "hello\n");
      const rec = ctxRecord(s.meta.id);
      const n = applyBashTreeDelta(snap, rec);
      assert.equal(n, 1);
      const journal = readFileMutations(s.meta.id);
      assert.equal(journal.length, 1);
      assert.ok(journal[0].path.endsWith("from-workspace.txt"));
    } finally {
      if (prevGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prevGitDir;
      try {
        fs.rmSync(decoy, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  it("journals a new untracked file as create and /undo removes it", () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    const snap = beginBashTreeSnapshot(dir);
    assert.ok(snap);
    fs.writeFileSync(path.join(dir, "new.txt"), "hello\n");
    const rec = ctxRecord(s.meta.id);
    const n = applyBashTreeDelta(snap, rec);
    assert.equal(n, 1);
    assert.equal(rec.edits(), 1);
    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, "create");
    assert.ok(journal[0].path.endsWith("new.txt"));

    const restored = restoreMutationsAfterTurn(s.meta.id, 0);
    assert.ok(restored.restored.length >= 1);
    assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
  });

  it("journals a clean tracked edit using HEAD, not a later dirty snapshot", () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    const snap = beginBashTreeSnapshot(dir);
    assert.ok(snap);
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    applyBashTreeDelta(snap, ctxRecord(s.meta.id));
    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, "update");
    assert.equal(journal[0].before, "one\n");

    restoreMutationsAfterTurn(s.meta.id, 0);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "one\n");
  });

  it("already-dirty files journal the pre-bash body, not HEAD", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    const snap = beginBashTreeSnapshot(dir);
    assert.ok(snap);
    fs.writeFileSync(path.join(dir, "a.txt"), "three\n");
    applyBashTreeDelta(snap, ctxRecord(s.meta.id));
    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].before, "two\n");

    restoreMutationsAfterTurn(s.meta.id, 0);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "two\n");
  });

  it("journals a tracked delete from a clean tree", () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    const snap = beginBashTreeSnapshot(dir);
    assert.ok(snap);
    fs.unlinkSync(path.join(dir, "a.txt"));
    applyBashTreeDelta(snap, ctxRecord(s.meta.id));
    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, "delete");
    assert.equal(journal[0].before, "one\n");

    restoreMutationsAfterTurn(s.meta.id, 0);
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "one\n");
  });

  it("clean tree + no writes journals nothing", () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    const snap = beginBashTreeSnapshot(dir);
    assert.ok(snap);
    const n = applyBashTreeDelta(snap, ctxRecord(s.meta.id));
    assert.equal(n, 0);
    assert.equal(readFileMutations(s.meta.id).length, 0);
  });

  it("index-only git add of an already-dirty file is not a mutation", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    const snap = beginBashTreeSnapshot(dir);
    assert.ok(snap);
    git(dir, ["add", "a.txt"]);
    const n = applyBashTreeDelta(snap, ctxRecord(s.meta.id));
    assert.equal(n, 0);
  });

  it("toolBash echo-redirect journals create; failed write still journals", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    markUserTurn(s);
    s.messages.push({ role: "user", content: "write via bash" });

    const created = path.join(dir, "via-bash.txt");
    const result = await executeTool(
      "bash",
      JSON.stringify({
        command: "printf 'via\\n' > via-bash.txt && false",
      }),
      {
        workspace: dir,
        sandbox: "off",
        sandboxMissingBackend: "fallback",
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
    assert.equal(result.isError, true);
    assert.ok(fs.existsSync(created));
    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, "create");

    s.messages.push({ role: "assistant", content: "wrote" });
    const rw = rewindSessionDetailed(s, 1);
    assert.ok(rw.disk && rw.disk.restored.length >= 1);
    assert.equal(fs.existsSync(created), false);
  });

  it("read-only bash does not stamp the journal or editCount", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    let edits = 0;
    await executeTool("bash", JSON.stringify({ command: "printf ok" }), {
      workspace: dir,
      sandbox: "off",
      sandboxMissingBackend: "fallback",
      onEdit: () => {
        edits += 1;
      },
      recordMutation: (input) => {
        appendFileMutation(s.meta.id, { ...input, turn: 1 });
      },
    });
    assert.equal(edits, 0);
    assert.equal(readFileMutations(s.meta.id).length, 0);
  });

  it("journal:false bang write is not journaled ( /verify path )", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    const turns = s.meta.turnCount || 0;
    const r = await runBangShell({
      line: "!printf 'skip\\n' > skip.txt",
      config: {
        ...DEFAULT_CONFIG,
        workspace: dir,
        permissionMode: "bypassPermissions",
      },
      session: s,
      permissions: new PermissionGate({ interactive: false }),
      journal: false,
    });
    assert.equal(r.handled, true);
    assert.ok(fs.existsSync(path.join(dir, "skip.txt")));
    assert.equal(s.meta.turnCount || 0, turns);
    assert.equal(readFileMutations(s.meta.id).length, 0);
  });

  it("idle bang-shell write is a turn /undo restores", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    const r = await runBangShell({
      line: "!printf 'bang\\n' > bang.txt",
      config: {
        ...DEFAULT_CONFIG,
        workspace: dir,
        permissionMode: "bypassPermissions",
      },
      session: s,
      permissions: new PermissionGate({ interactive: false }),
    });
    assert.equal(r.handled, true);
    assert.ok(fs.existsSync(path.join(dir, "bang.txt")));
    assert.ok((s.meta.turnCount || 0) >= 1);
    assert.equal(readFileMutations(s.meta.id).length, 1);

    const rw = rewindSessionDetailed(s, 1);
    assert.ok(rw.removed >= 1);
    assert.ok(rw.disk && rw.disk.restored.length >= 1);
    assert.equal(fs.existsSync(path.join(dir, "bang.txt")), false);
  });

  function taskIdFrom(output: string): string {
    const m = output.match(/task_id:\s*(\S+)/);
    assert.ok(m, output);
    return m![1];
  }

  function bashCtx(s: ReturnType<typeof createSession>) {
    return {
      workspace: dir,
      sandbox: "off" as const,
      sandboxMissingBackend: "fallback" as const,
      sessionId: s.meta.id,
      session: s,
      onEdit: () => {
        s.meta.editCount += 1;
      },
      recordMutation: (input: {
        path: string;
        kind: "create" | "update" | "delete";
        before?: string;
        mode?: number;
        skipped?: boolean;
        reason?: string;
      }) => {
        appendFileMutation(s.meta.id, {
          ...input,
          turn: s.meta.turnCount,
        });
      },
    };
  }

  it("applyBashTreeDelta ignoreAbsPaths skips a concurrent path", () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    const snap = beginBashTreeSnapshot(dir);
    assert.ok(snap);
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    fs.writeFileSync(path.join(dir, "extra.txt"), "x\n");
    const rec = ctxRecord(s.meta.id);
    const n = applyBashTreeDelta(snap, rec, {
      ignoreAbsPaths: [path.join(dir, "a.txt")],
    });
    assert.equal(n, 1);
    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    assert.ok(journal[0].path.endsWith("extra.txt"));
  });

  it("background bash create journals on exit and /undo removes it", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    markUserTurn(s);
    s.messages.push({ role: "user", content: "bg write" });
    const created = path.join(dir, "via-bg.txt");
    const result = await executeTool(
      "bash",
      JSON.stringify({
        command: "printf 'via-bg\\n' > via-bg.txt",
        background: true,
      }),
      bashCtx(s),
    );
    assert.equal(result.isError, undefined);
    const id = taskIdFrom(result.output);
    const w = await waitForTask(id, { timeoutMs: 10_000 });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    assert.equal(w.task.status, "completed");
    assert.ok(fs.existsSync(created));
    const journal = readFileMutations(s.meta.id);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, "create");
    assert.ok(journal[0].path.endsWith("via-bg.txt"));

    s.messages.push({ role: "assistant", content: "wrote" });
    const rw = rewindSessionDetailed(s, 1);
    assert.ok(rw.disk && rw.disk.restored.length >= 1);
    assert.equal(fs.existsSync(created), false);
  });

  it("failed background write still journals", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    const created = path.join(dir, "fail-bg.txt");
    const result = await executeTool(
      "bash",
      JSON.stringify({
        command: "printf 'x\\n' > fail-bg.txt && false",
        background: true,
      }),
      bashCtx(s),
    );
    const id = taskIdFrom(result.output);
    const w = await waitForTask(id, { timeoutMs: 10_000 });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    assert.equal(w.task.status, "failed");
    assert.ok(fs.existsSync(created));
    assert.equal(readFileMutations(s.meta.id).length, 1);
    restoreMutationsAfterTurn(s.meta.id, 0);
    assert.equal(fs.existsSync(created), false);
  });

  it("read-only background bash does not stamp the journal", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    let edits = 0;
    const ctx = bashCtx(s);
    ctx.onEdit = () => {
      edits += 1;
    };
    const result = await executeTool(
      "bash",
      JSON.stringify({ command: "printf ok", background: true }),
      ctx,
    );
    const id = taskIdFrom(result.output);
    await waitForTask(id, { timeoutMs: 10_000 });
    assert.equal(edits, 0);
    assert.equal(readFileMutations(s.meta.id).length, 0);
  });

  it("background journal honors FORGE_BASH_MUTATION_JOURNAL=0", async () => {
    process.env.FORGE_BASH_MUTATION_JOURNAL = "0";
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    const result = await executeTool(
      "bash",
      JSON.stringify({
        command: "printf 'no\\n' > no-journal.txt",
        background: true,
      }),
      bashCtx(s),
    );
    const id = taskIdFrom(result.output);
    await waitForTask(id, { timeoutMs: 10_000 });
    assert.ok(fs.existsSync(path.join(dir, "no-journal.txt")));
    assert.equal(readFileMutations(s.meta.id).length, 0);
  });

  it("concurrent write_file during bg is not double-journaled", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    const ctx = bashCtx(s);
    const result = await executeTool(
      "bash",
      JSON.stringify({
        command: "sleep 0.35 && printf 'bg\\n' > bg-only.txt",
        background: true,
      }),
      ctx,
    );
    const id = taskIdFrom(result.output);
    const other = await executeTool(
      "write_file",
      JSON.stringify({ path: "other.txt", content: "tool\n" }),
      ctx,
    );
    assert.equal(other.isError, undefined);
    const w = await waitForTask(id, { timeoutMs: 10_000 });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    assert.equal(w.task.status, "completed");
    const journal = readFileMutations(s.meta.id);
    const bases = journal.map((m) => path.basename(m.path)).sort();
    assert.deepEqual(bases, ["bg-only.txt", "other.txt"]);
    assert.equal(journal.filter((m) => m.path.endsWith("other.txt")).length, 1);
  });

  it("/undo of the launch turn kills in-flight bg so it cannot recreate the file", async () => {
    const s = createSession({ cwd: dir, provider: "xai", model: "grok-4" });
    s.meta.turnCount = 1;
    markUserTurn(s);
    s.messages.push({ role: "user", content: "slow bg" });
    const late = path.join(dir, "late.txt");
    const result = await executeTool(
      "bash",
      JSON.stringify({
        command: "sleep 8 && printf 'late\\n' > late.txt",
        background: true,
      }),
      bashCtx(s),
    );
    const id = taskIdFrom(result.output);
    s.messages.push({ role: "assistant", content: "started" });
    const rw = rewindSessionDetailed(s, 1);
    assert.ok(rw.removed >= 1);
    assert.equal(fs.existsSync(late), false);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fs.existsSync(late), false);
    const w = await waitForTask(id, { timeoutMs: 5_000 });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    assert.equal(w.task.status, "killed");
    assert.equal(fs.existsSync(late), false);
  });
});
