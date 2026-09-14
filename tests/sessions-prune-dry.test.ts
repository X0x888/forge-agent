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
import { createSession } from "../src/session/session.js";
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
