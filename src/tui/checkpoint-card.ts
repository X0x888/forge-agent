/**
 * `/checkpoint` — the sit-down key for the safety snapshot.
 *
 * ULW arm and pre-destructive git used to take a `git stash create` and
 * tell you `git stash apply` (a merge, and a model prompt at ›). The
 * snapshot also missed untracked files, and `/checkpoint restore` ignored
 * `ulw.checkpointSha` so the sit-down Next lied.
 *
 * This key opens a verdict-first card. `/checkpoint snap` takes a snapshot
 * (untracked in, secrets out). `/checkpoint restore` rewinds the tree.
 * Next is always a slash key — never `git stash apply`.
 */
import chalk from "chalk";
import { clearFileReadsForSession } from "../agent/tools/file-read-state.js";
import type { ForgeConfig } from "../config/types.js";
import { loadUlwCycle } from "../harness/ulw-cycle.js";
import type { SessionData } from "../session/session.js";
import { saveSession } from "../session/session.js";
import {
  applySafetyCheckpoint,
  createSafetyCheckpoint,
} from "../util/git-checkpoint.js";
import { formatVerifyCloser } from "./verify-card.js";

export type CheckpointKind =
  | "none"
  | "ok"
  | "empty"
  | "restored"
  | "norepo"
  | "plan"
  | "fail";

export type CheckpointVerb = "peek" | "snap" | "restore" | "help";

export interface CheckpointArg {
  verb: CheckpointVerb;
  sha?: string;
}

const PEEK_TOKS = new Set(["", "status", "list", "ls", "show", "?"]);
const SNAP_TOKS = new Set(["snap", "create", "take", "save", "new"]);
const RESTORE_TOKS = new Set(["restore", "apply", "pop", "rewind"]);

export function parseCheckpointArg(arg?: string): CheckpointArg {
  const tokens = String(arg || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const head = (tokens[0] || "").toLowerCase();
  if (!head || PEEK_TOKS.has(head)) {
    return { verb: "peek", sha: tokens[1] };
  }
  if (head === "help" || head.startsWith("-")) {
    return { verb: "help" };
  }
  if (SNAP_TOKS.has(head)) {
    return { verb: "snap" };
  }
  if (RESTORE_TOKS.has(head)) {
    return { verb: "restore", sha: tokens[1] };
  }
  // `/checkpoint <sha>` is restore of that object (typed Next leftover).
  if (/^[0-9a-f]{7,40}$/i.test(head) && tokens.length === 1) {
    return { verb: "restore", sha: head };
  }
  return { verb: "help" };
}

export function checkpointUsage(): string {
  return (
    "Usage: /checkpoint [status|snap|restore] [sha]\n" +
    "  (empty)   card for the last snapshot (no disk change)\n" +
    "  snap      take a snapshot (worktree untouched; untracked included)\n" +
    "  restore   rewind the tree to the last (or given) snapshot\n"
  );
}

export function resolveCheckpointSha(
  session: Pick<SessionData, "meta">,
  explicit?: string,
): string {
  const want = String(explicit || "").trim();
  if (want) return want;
  const local = String(session.meta.lastCheckpoint || "").trim();
  if (local) return local;
  try {
    return String(loadUlwCycle(session.meta.id)?.checkpointSha || "").trim();
  } catch {
    return "";
  }
}

export function stampCheckpoint(
  session: SessionData,
  sha: string,
  persist = true,
): void {
  const id = String(sha || "").trim();
  if (!id) return;
  session.meta.lastCheckpoint = id;
  session.meta.lastCheckpointAt = new Date().toISOString();
  if (!persist) return;
  try {
    saveSession(session);
  } catch {
    /* */
  }
}

export function formatCheckpointVerdict(
  kind: CheckpointKind,
  opts?: { color?: boolean; fileCount?: number },
): string {
  const color = opts?.color !== false;
  const title = color ? chalk.bold("checkpoint") : "checkpoint";
  const bit = (text: string, paint: (s: string) => string) =>
    color ? paint(text) : text;
  if (kind === "none") {
    return `${title}  ·  ${bit("none", chalk.dim)}`;
  }
  if (kind === "empty") {
    return `${title}  ·  ${bit("nothing to snapshot", chalk.dim)}`;
  }
  if (kind === "norepo") {
    return `${title}  ·  ${bit("not a repo", chalk.yellow)}`;
  }
  if (kind === "plan") {
    return `${title}  ·  ${bit("plan", chalk.yellow)}`;
  }
  if (kind === "fail") {
    return `${title}  ·  ${bit("✗", chalk.red)}`;
  }
  if (kind === "restored") {
    return `${title}  ·  ${bit("restored", chalk.green)}`;
  }
  const n = opts?.fileCount;
  if (typeof n === "number" && n > 0) {
    const label = n === 1 ? "1 file" : `${n} files`;
    return `${title}  ·  ${bit(label, chalk.cyan)}`;
  }
  return `${title}  ·  ${bit("ok", chalk.green)}`;
}

export function formatCheckpointCard(input: {
  kind: CheckpointKind;
  sha?: string;
  note?: string;
  files?: number;
  next: string[];
  color?: boolean;
  columns?: number;
}): string {
  const color = input.color !== false;
  const lines = [
    formatCheckpointVerdict(input.kind, {
      color,
      fileCount: input.files,
    }),
  ];
  const sha = input.sha?.trim();
  if (sha) {
    const row = `  ${sha}`;
    lines.push(color ? chalk.green(row) : row);
  }
  const note = input.note?.trim();
  if (note) {
    lines.push(color ? chalk.yellow(`  ${note}`) : `  ${note}`);
  }
  const closer = formatVerifyCloser(input.next, { columns: input.columns });
  if (closer) lines.push(closer);
  return lines.filter((l) => l.length > 0).join("\n");
}

export function runCheckpoint(opts: {
  session: SessionData;
  config: Pick<ForgeConfig, "workspace" | "permissionMode">;
  arg?: string;
  color?: boolean;
  persist?: boolean;
}): { output: string; failed?: boolean; session?: SessionData } {
  const parsed = parseCheckpointArg(opts.arg);
  const color = opts.color !== false;
  const persist = opts.persist !== false;
  const cwd =
    opts.config.workspace || opts.session.meta.cwd || process.cwd();

  if (parsed.verb === "help") {
    return { output: checkpointUsage() };
  }

  if (parsed.verb === "peek") {
    const sha = resolveCheckpointSha(opts.session, parsed.sha);
    if (!sha) {
      return {
        output: formatCheckpointCard({
          kind: "none",
          next: ["/checkpoint snap"],
          color,
        }),
      };
    }
    return {
      output: formatCheckpointCard({
        kind: "ok",
        sha,
        next: ["/checkpoint restore"],
        color,
      }),
    };
  }

  if (parsed.verb === "snap") {
    const snap = createSafetyCheckpoint(cwd, {
      label: opts.session.meta.id.slice(0, 12),
    });
    if (!snap.ok) {
      const norepo = /not a git repository/i.test(snap.detail || "");
      return {
        output: formatCheckpointCard({
          kind: norepo ? "norepo" : "fail",
          note: snap.detail,
          next: norepo ? [] : ["/diff"],
          color,
        }),
        failed: true,
      };
    }
    if (snap.clean || !snap.sha) {
      return {
        output: formatCheckpointCard({
          kind: "empty",
          note: snap.detail || "Working tree clean.",
          next: ["/diff"],
          color,
        }),
      };
    }
    stampCheckpoint(opts.session, snap.sha, persist);
    return {
      output: formatCheckpointCard({
        kind: "ok",
        sha: snap.sha,
        files: snap.dirtyPaths,
        note: "Working tree unchanged.",
        next: ["/checkpoint restore"],
        color,
      }),
      session: opts.session,
    };
  }

  if (opts.config.permissionMode === "plan") {
    return {
      output: formatCheckpointCard({
        kind: "plan",
        note: "Plan mode cannot restore. /build first.",
        next: ["/build"],
        color,
      }),
      failed: true,
    };
  }

  const sha = resolveCheckpointSha(opts.session, parsed.sha);
  if (!sha) {
    return {
      output: formatCheckpointCard({
        kind: "none",
        note: "No snapshot yet.",
        next: ["/checkpoint snap"],
        color,
      }),
      failed: true,
    };
  }
  const r = applySafetyCheckpoint(cwd, sha);
  if (!r.ok) {
    const norepo = /not a git repository/i.test(r.detail || "");
    return {
      output: formatCheckpointCard({
        kind: norepo ? "norepo" : "fail",
        sha,
        note: r.detail || "restore failed",
        next: norepo ? ["/checkpoint snap"] : ["/diff"],
        color,
      }),
      failed: true,
    };
  }
  try {
    clearFileReadsForSession(opts.session.meta.id);
  } catch {
    /* */
  }
  return {
    output: formatCheckpointCard({
      kind: "restored",
      sha,
      next: ["/diff", "/verify"],
      color,
    }),
    session: opts.session,
  };
}
