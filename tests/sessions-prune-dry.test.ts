/**
 * Journal Next is previewable: --dry is not --deny.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSession,
  pruneSessions,
  saveSession,
  sessionDir,
  setSessionLastError,
} from "../src/session/session.js";
import { pruneMutationJournals } from "../src/session/mutations.js";
import { handleSlash } from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import {
  sanitizeUnknownDryHint,
  unknownOptionHint,
} from "../src/cli/unknown-option.js";
import { shellCompletionScript } from "../src/util/completion-script.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "src", "cli.ts");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prune-dry-"));
  process.env.FORGE_HOME = dir;
  return dir;
}

function forge(home: string, args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(TSX, [CLI, ...args], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, FORGE_HOME: home, FORCE_COLOR: "0", NO_COLOR: "1" },
    timeout: 20_000,
  });
  return {
    status: r.status,
    stdout: strip(r.stdout || ""),
    stderr: strip(r.stderr || ""),
  };
}

describe("unknownOptionHint --dry", () => {
  it("does not suggest --deny", () => {
    const r = unknownOptionHint("unknown option '--dry'");
    assert.equal(r.suggestion, undefined);
    assert.match(String(r.hint || ""), /sessions prune --journals --dry/);
    assert.doesNotMatch(JSON.stringify(r), /--deny/);
    const run = unknownOptionHint("unknown option '--dry-run'");
    assert.doesNotMatch(JSON.stringify(run), /--deny/);
    const stripped = sanitizeUnknownDryHint(
      "error: unknown option '--dry'\n(Did you mean --deny?)\n",
    );
    assert.doesNotMatch(stripped, /Did you mean/);
    assert.match(stripped, /unknown option '--dry'/);
    assert.match(
      sanitizeUnknownDryHint("error: unknown option '--json'\n(Did you mean --json?)\n"),
      /Did you mean --json/,
    );
  });
});

describe("completion prune --dry", () => {
  it("bash/zsh/fish prune lists --dry", () => {
    const bash = shellCompletionScript("bash");
    const zsh = shellCompletionScript("zsh");
    const fish = shellCompletionScript("fish");
    assert.match(bash, /prune\) COMPREPLY=.*--journals --dry/);
    assert.match(zsh, /values 'prune'.*--journals --dry/);
    assert.match(fish, /sessions" -l dry /);
  });
});

describe("/sessions prune --journals --dry", () => {
  it("previews then a following prune without --dry deletes", async () => {
    const prev = process.env.FORGE_HOME;
    const home = tmpHome();
    try {
      const ws = path.join(home, "ws");
      fs.mkdirSync(ws);
      const active = createSession({ cwd: ws, provider: "xai", model: "grok-4" });
      const other = createSession({ cwd: ws, provider: "xai", model: "grok-4" });
      const journal = path.join(home, "sessions", other.meta.id, "mutations.jsonl");
      fs.writeFileSync(journal, "x".repeat(2048));
      const hooks = new HookRunner(DEFAULT_CONFIG, ws);
      const preview = await handleSlash("/sessions prune --journals --dry", {
        session: active,
        config: DEFAULT_CONFIG,
        hooks,
      });
      assert.equal(preview.handled, true);
      assert.match(String(preview.output || ""), /Would drop 1 undo journal/);
      assert.equal(fs.existsSync(journal), true);
      const dropped = await handleSlash("/sessions prune --journals", {
        session: active,
        config: DEFAULT_CONFIG,
        hooks,
      });
      assert.match(String(dropped.output || ""), /Dropped 1 undo journal/);
      assert.equal(fs.existsSync(journal), false);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
  });
});

describe("forge sessions prune --journals --dry", () => {
  it("CLI dry leaves the file; next prune deletes; doctor/stats --dry are not --deny", () => {
    const home = tmpHome();
    const sessDir = path.join(home, "sessions", "abc123deadbeef");
    fs.mkdirSync(sessDir, { recursive: true });
    const journal = path.join(sessDir, "mutations.jsonl");
    fs.writeFileSync(journal, "x".repeat(1024));

    const dry = forge(home, ["sessions", "prune", "--journals", "--dry", "--json"]);
    assert.equal(dry.status, 0, dry.stderr);
    const body = JSON.parse(dry.stdout) as {
      ok?: boolean;
      dry?: boolean;
      deleted?: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.dry, true);
    assert.equal(body.deleted, 1);
    assert.doesNotMatch(dry.stdout + dry.stderr, /Did you mean `--deny`|Did you mean --deny/);
    assert.equal(fs.existsSync(journal), true);

    const wet = forge(home, ["sessions", "prune", "--journals", "--json"]);
    assert.equal(wet.status, 0, wet.stderr);
    const wetBody = JSON.parse(wet.stdout) as { deleted?: number; dry?: boolean };
    assert.equal(wetBody.deleted, 1);
    assert.equal(wetBody.dry, false);
    assert.equal(fs.existsSync(journal), false);

    const doctor = forge(home, ["doctor", "--dry"]);
    assert.notEqual(doctor.status, 0);
    assert.doesNotMatch(doctor.stdout + doctor.stderr, /Did you mean `--deny`|Did you mean --deny/);
    const stats = forge(home, ["stats", "--dry"]);
    assert.notEqual(stats.status, 0);
    assert.doesNotMatch(stats.stdout + stats.stderr, /Did you mean `--deny`|Did you mean --deny/);
  });
});

describe("pruneMutationJournals dry kernel", () => {
  it("dry then wet", () => {
    const home = tmpHome();
    const dir = path.join(home, "sessions", "orphan-j");
    fs.mkdirSync(dir, { recursive: true });
    const journal = path.join(dir, "mutations.jsonl");
    fs.writeFileSync(journal, "n\n");
    const preview = pruneMutationJournals({ dry: true });
    assert.equal(preview.deleted, 1);
    assert.equal(fs.existsSync(journal), true);
    assert.equal(pruneMutationJournals().deleted, 1);
    assert.equal(fs.existsSync(journal), false);
  });
});

describe("pruneSessions --keep/--orphans --dry", () => {
  it("keep 1 dry leaves dirs; wet deletes", () => {
    const prev = process.env.FORGE_HOME;
    const home = tmpHome();
    try {
      const ws = path.join(home, "ws");
      fs.mkdirSync(ws);
      const old = createSession({ cwd: ws, provider: "xai", model: "m", title: "old" });
      old.meta.updatedAt = "2020-01-01T00:00:00.000Z";
      saveSession(old);
      const mid = createSession({ cwd: ws, provider: "xai", model: "m", title: "mid" });
      mid.meta.updatedAt = "2021-01-01T00:00:00.000Z";
      saveSession(mid);
      const newest = createSession({ cwd: ws, provider: "xai", model: "m", title: "new" });
      newest.meta.updatedAt = "2022-01-01T00:00:00.000Z";
      saveSession(newest);
      const preview = pruneSessions({ keep: 1, dry: true });
      assert.equal(preview.dry, true);
      assert.equal(preview.deleted.length, 2);
      assert.ok(preview.deleted.includes(old.meta.id));
      assert.ok(preview.deleted.includes(mid.meta.id));
      assert.ok(!preview.deleted.includes(newest.meta.id));
      assert.equal(fs.existsSync(sessionDir(old.meta.id)), true);
      assert.equal(fs.existsSync(sessionDir(mid.meta.id)), true);
      assert.equal(fs.existsSync(sessionDir(newest.meta.id)), true);
      const wet = pruneSessions({ keep: 1 });
      assert.equal(wet.dry, false);
      assert.equal(wet.deleted.length, 2);
      assert.equal(fs.existsSync(sessionDir(old.meta.id)), false);
      assert.equal(fs.existsSync(sessionDir(newest.meta.id)), true);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
  });

  it("orphans dry leaves the mill; wet deletes mill and keeps parent", () => {
    const prev = process.env.FORGE_HOME;
    const home = tmpHome();
    try {
      const parent = createSession({
        cwd: home,
        provider: "xai",
        model: "m",
        title: "ulw parent",
      });
      fs.writeFileSync(
        path.join(sessionDir(parent.meta.id), "ulw.json"),
        JSON.stringify({ version: 2, cycle: 1 }),
      );
      saveSession(parent);
      const mill = createSession({
        cwd: home,
        provider: "xai",
        model: "m",
        title: "subagent: Find next play-path hole",
      });
      mill.meta.subagent = {
        parentId: parent.meta.id,
        type: "explore",
        isolation: "none",
      };
      setSessionLastError(mill, {
        code: "max_turns",
        message: "maxTurns (25) reached — releasing.",
      });
      saveSession(mill);
      const preview = pruneSessions({ keep: 50, orphans: true, dry: true });
      assert.equal(preview.dry, true);
      assert.ok(preview.deletedOrphans >= 1);
      assert.ok(preview.deleted.includes(mill.meta.id));
      assert.ok(!preview.deleted.includes(parent.meta.id));
      assert.equal(fs.existsSync(sessionDir(mill.meta.id)), true);
      const wet = pruneSessions({ keep: 50, orphans: true });
      assert.equal(wet.dry, false);
      assert.ok(wet.deleted.includes(mill.meta.id));
      assert.equal(fs.existsSync(sessionDir(mill.meta.id)), false);
      assert.equal(fs.existsSync(sessionDir(parent.meta.id)), true);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
  });
});

describe("/sessions prune --keep 1 --dry", () => {
  it("previews then a following prune without --dry deletes", async () => {
    const prev = process.env.FORGE_HOME;
    const home = tmpHome();
    try {
      const ws = path.join(home, "ws");
      fs.mkdirSync(ws);
      const old = createSession({ cwd: ws, provider: "xai", model: "m", title: "old" });
      const extra = createSession({ cwd: ws, provider: "xai", model: "m", title: "extra" });
      const active = createSession({ cwd: ws, provider: "xai", model: "m", title: "active" });
      const hooks = new HookRunner(DEFAULT_CONFIG, ws);
      const preview = await handleSlash("/sessions prune --keep 1 --dry", {
        session: active,
        config: DEFAULT_CONFIG,
        hooks,
      });
      assert.equal(preview.handled, true);
      assert.match(String(preview.output || ""), /Would prune 2 session/);
      assert.doesNotMatch(String(preview.output || ""), /Usage:.*--journals --dry/);
      assert.equal(fs.existsSync(sessionDir(old.meta.id)), true);
      const dropped = await handleSlash("/sessions prune --keep 1", {
        session: active,
        config: DEFAULT_CONFIG,
        hooks,
      });
      assert.match(String(dropped.output || ""), /Pruned 2 session/);
      assert.equal(fs.existsSync(sessionDir(old.meta.id)), false);
      assert.equal(fs.existsSync(sessionDir(extra.meta.id)), false);
      assert.equal(fs.existsSync(sessionDir(active.meta.id)), true);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
  });
});

describe("forge sessions prune --keep/--orphans --dry", () => {
  it("CLI dry leaves dirs; wet deletes; not --deny", () => {
    const home = tmpHome();
    const ws = path.join(home, "ws");
    fs.mkdirSync(ws);
    const old = createSession({ cwd: ws, provider: "xai", model: "m", title: "old" });
    old.meta.updatedAt = "2020-01-01T00:00:00.000Z";
    saveSession(old);
    const newest = createSession({ cwd: ws, provider: "xai", model: "m", title: "new" });
    newest.meta.updatedAt = "2022-01-01T00:00:00.000Z";
    saveSession(newest);
    const parent = createSession({
      cwd: ws,
      provider: "xai",
      model: "m",
      title: "ulw parent",
    });
    parent.meta.updatedAt = "2023-01-01T00:00:00.000Z";
    fs.writeFileSync(
      path.join(sessionDir(parent.meta.id), "ulw.json"),
      JSON.stringify({ version: 2, cycle: 1 }),
    );
    saveSession(parent);
    const mill = createSession({
      cwd: ws,
      provider: "xai",
      model: "m",
      title: "subagent: mill",
    });
    mill.meta.updatedAt = "2023-06-01T00:00:00.000Z";
    mill.meta.subagent = {
      parentId: parent.meta.id,
      type: "explore",
      isolation: "none",
    };
    saveSession(mill);

    const keepDry = forge(home, ["sessions", "prune", "--keep", "1", "--dry", "--json"]);
    assert.equal(keepDry.status, 0, keepDry.stderr);
    assert.doesNotMatch(keepDry.stdout + keepDry.stderr, /Usage:.*--journals --dry/);
    assert.doesNotMatch(keepDry.stdout + keepDry.stderr, /Did you mean `--deny`|Did you mean --deny/);
    const keepBody = JSON.parse(keepDry.stdout) as {
      ok?: boolean;
      dry?: boolean;
      deleted?: string[];
    };
    assert.equal(keepBody.ok, true);
    assert.equal(keepBody.dry, true);
    assert.ok((keepBody.deleted || []).length >= 1);
    assert.equal(fs.existsSync(sessionDir(old.meta.id)), true);

    const orphanDry = forge(home, ["sessions", "prune", "--orphans", "--dry", "--json"]);
    assert.equal(orphanDry.status, 0, orphanDry.stderr);
    assert.doesNotMatch(orphanDry.stdout + orphanDry.stderr, /Usage:.*--journals --dry/);
    const orphanBody = JSON.parse(orphanDry.stdout) as {
      dry?: boolean;
      deletedOrphans?: number;
      deleted?: string[];
    };
    assert.equal(orphanBody.dry, true);
    assert.ok((orphanBody.deletedOrphans || 0) >= 1);
    assert.ok((orphanBody.deleted || []).includes(mill.meta.id));
    assert.equal(fs.existsSync(sessionDir(mill.meta.id)), true);

    const journal = path.join(sessionDir(newest.meta.id), "mutations.jsonl");
    fs.writeFileSync(journal, "x".repeat(64));
    const jDry = forge(home, ["sessions", "prune", "--journals", "--dry", "--json"]);
    assert.equal(jDry.status, 0, jDry.stderr);
    const jBody = JSON.parse(jDry.stdout) as { journals?: boolean; dry?: boolean; deleted?: number };
    assert.equal(jBody.journals, true);
    assert.equal(jBody.dry, true);
    assert.equal(fs.existsSync(journal), true);
    assert.equal(fs.existsSync(sessionDir(newest.meta.id)), true);

    const wetKeep = forge(home, ["sessions", "prune", "--keep", "1", "--json"]);
    assert.equal(wetKeep.status, 0, wetKeep.stderr);
    const wetBody = JSON.parse(wetKeep.stdout) as { dry?: boolean; deleted?: string[] };
    assert.equal(wetBody.dry, false);
    assert.ok((wetBody.deleted || []).length >= 1);
    assert.equal(fs.existsSync(sessionDir(old.meta.id)), false);
  });
});
