/**
 * Journal bash workspace writes so /undo restores disk.
 *
 * write_file / search_replace / apply_patch already append mutations.jsonl.
 * Models still escape via `echo >`, `tee`, `python -c`, codegen scripts —
 * those writes were invisible to the daily-loop trail (editCount, /undo).
 *
 * Mechanism: git porcelain delta around the command. Pre-bash bodies are
 * snapshotted for already-dirty paths (HEAD is wrong when write_file ran
 * earlier this session). Newly dirty clean files use HEAD. Untracked new
 * files are creates. Ignored/artifact paths stay out (git does not list them).
 *
 * Foreground wraps run() in withBashMutationJournal. Background snapshots
 * at start and applies on exit (or /undo settle for the undone turn).
 *
 * Designed empty: not a repo · clean tree · no recordMutation
 * · FORGE_BASH_MUTATION_JOURNAL=0 · still running (until exit or settle).
 * Journal is best-effort — never fail bash.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAX_MUTATION_BYTES } from "../../session/mutations.js";
import { createChildEnv } from "./env-policy.js";
import {
  findGitRoot,
  parsePorcelainPath,
  unquotePorcelainPath,
} from "../worktree.js";
import type { ToolContext } from "./types.js";

/** Cap pre-bash body snapshots so a filthy tree does not stall every bash. */
export const MAX_BASH_JOURNAL_FILES = 40;
/** Skip journaling when porcelain is this noisy (broken ignore). */
export const MAX_BASH_PORCELAIN_LINES = 200;

export type BashFileSnap = {
  existed: boolean;
  before?: string;
  mode?: number;
  skipped?: boolean;
  reason?: string;
};

export type BashTreeSnapshot = {
  root: string;
  /** rel path → raw porcelain line */
  beforeLines: Map<string, string>;
  /** rel path → pre-bash file body (subset; cap applies) */
  beforeFiles: Map<string, BashFileSnap>;
};

export function bashMutationJournalEnabled(): boolean {
  const v = (process.env.FORGE_BASH_MUTATION_JOURNAL || "1")
    .trim()
    .toLowerCase();
  return (
    v !== "0" &&
    v !== "false" &&
    v !== "off" &&
    v !== "no" &&
    v !== "disabled"
  );
}

function git(args: string[], cwd: string, timeoutMs = 8_000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: createChildEnv(),
  }).trimEnd();
}

/** Source path of `R  old -> new` (parsePorcelainPath returns dest only). */
export function parsePorcelainRenameFrom(line: string): string | null {
  if (!line.includes(" -> ")) return null;
  let body: string | null = null;
  if (line.length >= 4 && line[2] === " ") body = line.slice(3);
  else if (line.length >= 3 && /^[MADRCU?!] /.test(line)) body = line.slice(2);
  if (!body) return null;
  const idx = body.indexOf(" -> ");
  if (idx < 0) return null;
  const from = unquotePorcelainPath(body.slice(0, idx));
  return from || null;
}

/** Resolve + realpath so /var vs /private/var ignore matches hold. */
export function normAbsVariants(p: string): string[] {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  const out = [resolved];
  try {
    const real = fs.realpathSync(p).replace(/\\/g, "/");
    if (real !== resolved) out.push(real);
  } catch {
    /* missing / unreadable — resolved only */
  }
  return out;
}

export function listPorcelain(
  root: string,
): Map<string, string> | null {
  try {
    const raw = git(["status", "--porcelain=v1", "-uall"], root, 8_000);
    const map = new Map<string, string>();
    if (!raw) return map;
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_BASH_PORCELAIN_LINES) return null;
    for (const line of lines) {
      const rel = parsePorcelainPath(line);
      if (!rel) continue;
      map.set(rel.replace(/\\/g, "/"), line);
    }
    return map;
  } catch {
    return null;
  }
}

export function snapshotWorkspaceFile(abs: string): BashFileSnap {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) {
      return { existed: false, skipped: true, reason: "not a regular file" };
    }
    if (st.size > MAX_MUTATION_BYTES) {
      return {
        existed: true,
        mode: st.mode & 0o777,
        skipped: true,
        reason: `existing file ${st.size} bytes exceeds journal cap`,
      };
    }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) {
      return {
        existed: true,
        mode: st.mode & 0o777,
        skipped: true,
        reason: "binary pre-image skipped",
      };
    }
    return {
      existed: true,
      before: buf.toString("utf8"),
      mode: st.mode & 0o777,
    };
  } catch {
    return { existed: false };
  }
}

function showHead(
  root: string,
  rel: string,
): { before?: string; skipped?: boolean; reason?: string } {
  try {
    const buf = execFileSync("git", ["show", `HEAD:${rel}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8_000,
      maxBuffer: MAX_MUTATION_BYTES + 4096,
      env: createChildEnv(),
    }) as Buffer;
    if (buf.length > MAX_MUTATION_BYTES) {
      return {
        skipped: true,
        reason: `HEAD ${buf.length} bytes exceeds journal cap`,
      };
    }
    if (buf.includes(0)) {
      return { skipped: true, reason: "binary HEAD pre-image skipped" };
    }
    return { before: buf.toString("utf8") };
  } catch {
    return {};
  }
}

export function beginBashTreeSnapshot(
  workspace: string,
): BashTreeSnapshot | null {
  if (!bashMutationJournalEnabled()) return null;
  const start = path.resolve(workspace || process.cwd());
  const root = findGitRoot(start);
  if (!root) return null;
  const beforeLines = listPorcelain(root);
  if (!beforeLines) return null;
  const beforeFiles = new Map<string, BashFileSnap>();
  let n = 0;
  for (const rel of beforeLines.keys()) {
    if (n >= MAX_BASH_JOURNAL_FILES) break;
    beforeFiles.set(rel, snapshotWorkspaceFile(path.resolve(root, rel)));
    n += 1;
  }
  return { root, beforeLines, beforeFiles };
}

function collectPaths(
  beforeLines: Map<string, string>,
  afterLines: Map<string, string>,
): Set<string> {
  const paths = new Set<string>([
    ...beforeLines.keys(),
    ...afterLines.keys(),
  ]);
  for (const line of afterLines.values()) {
    const from = parsePorcelainRenameFrom(line);
    if (from) paths.add(from.replace(/\\/g, "/"));
  }
  for (const line of beforeLines.values()) {
    const from = parsePorcelainRenameFrom(line);
    if (from) paths.add(from.replace(/\\/g, "/"));
  }
  return paths;
}

function classifyDelta(opts: {
  abs: string;
  rel: string;
  root: string;
  beforeLine?: string;
  afterLine?: string;
  beforeFile?: BashFileSnap;
  afterFile: BashFileSnap;
}): {
  path: string;
  kind: "create" | "update" | "delete";
  before?: string;
  mode?: number;
  skipped?: boolean;
  reason?: string;
} | null {
  const { abs, rel, root, beforeLine, afterLine, beforeFile, afterFile } =
    opts;
  const nowMissing = !afterFile.existed;

  if (beforeLine && !afterLine) {
    if (nowMissing) {
      if (beforeFile?.skipped) {
        return {
          path: abs,
          kind: "delete",
          skipped: true,
          reason: beforeFile.reason,
        };
      }
      if (beforeFile?.existed && beforeFile.before !== undefined) {
        return {
          path: abs,
          kind: "delete",
          before: beforeFile.before,
          mode: beforeFile.mode,
        };
      }
      return null;
    }
    if (beforeFile?.skipped) {
      return {
        path: abs,
        kind: "update",
        skipped: true,
        reason: beforeFile.reason,
      };
    }
    if (
      beforeFile?.before !== undefined &&
      beforeFile.before !== afterFile.before
    ) {
      return {
        path: abs,
        kind: "update",
        before: beforeFile.before,
        mode: beforeFile.mode,
      };
    }
    return null;
  }

  if (!beforeLine && afterLine) {
    if (nowMissing) {
      const head = showHead(root, rel);
      if (head.skipped) {
        return {
          path: abs,
          kind: "delete",
          skipped: true,
          reason: head.reason,
        };
      }
      if (head.before !== undefined) {
        return { path: abs, kind: "delete", before: head.before };
      }
      return null;
    }
    if (afterFile.skipped && afterFile.existed) {
      const head = showHead(root, rel);
      return {
        path: abs,
        kind: head.before !== undefined ? "update" : "create",
        skipped: true,
        reason: afterFile.reason,
      };
    }
    const head = showHead(root, rel);
    if (head.before !== undefined) {
      if (head.before === afterFile.before) return null;
      return { path: abs, kind: "update", before: head.before };
    }
    return { path: abs, kind: "create" };
  }

  // Dirty before and after.
  if (beforeFile?.skipped) {
    return {
      path: abs,
      kind: nowMissing ? "delete" : "update",
      skipped: true,
      reason: beforeFile.reason,
    };
  }
  if (!beforeFile) {
    return {
      path: abs,
      kind: nowMissing ? "delete" : "update",
      skipped: true,
      reason: "pre-bash snapshot cap",
    };
  }
  if (nowMissing) {
    return {
      path: abs,
      kind: "delete",
      before: beforeFile.before,
      mode: beforeFile.mode,
    };
  }
  if (beforeFile.before === afterFile.before) return null;
  return {
    path: abs,
    kind: "update",
    before: beforeFile.before,
    mode: beforeFile.mode,
  };
}

/** Append journal entries for paths bash changed. Returns count recorded. */
export function applyBashTreeDelta(
  snap: BashTreeSnapshot,
  ctx: ToolContext,
  opts?: { ignoreAbsPaths?: Iterable<string> },
): number {
  if (!ctx.recordMutation) return 0;
  const afterLines = listPorcelain(snap.root);
  if (!afterLines) return 0;

  const ignore = opts?.ignoreAbsPaths
    ? new Set([...opts.ignoreAbsPaths].flatMap(normAbsVariants))
    : null;

  let journaled = 0;
  for (const rel of collectPaths(snap.beforeLines, afterLines)) {
    const beforeLine = snap.beforeLines.get(rel);
    const afterLine = afterLines.get(rel);
    const abs = path.resolve(snap.root, rel);
    if (ignore && normAbsVariants(abs).some((p) => ignore.has(p))) continue;
    const afterFile = snapshotWorkspaceFile(abs);
    const beforeFile = snap.beforeFiles.get(rel);

    if (beforeLine === afterLine) {
      const beforeBody = beforeFile?.before;
      const afterBody = afterFile.existed ? afterFile.before : undefined;
      if (beforeBody === afterBody) continue;
    }
    if (!beforeLine && !afterLine) continue;

    const input = classifyDelta({
      abs,
      rel,
      root: snap.root,
      beforeLine,
      afterLine,
      beforeFile,
      afterFile,
    });
    if (!input) continue;
    try {
      ctx.recordMutation(input);
      journaled += 1;
      try {
        ctx.onEdit?.();
      } catch {
        /* */
      }
      try {
        ctx.fileReads?.clear(abs);
      } catch {
        /* */
      }
    } catch {
      /* journal best-effort */
    }
  }
  return journaled;
}

/** Snapshot → run → journal. Never throws out of the journal path. */
export async function withBashMutationJournal<T>(
  ctx: ToolContext,
  run: () => Promise<T>,
): Promise<T> {
  let snap: BashTreeSnapshot | null = null;
  try {
    if (ctx.recordMutation && bashMutationJournalEnabled()) {
      snap = beginBashTreeSnapshot(ctx.workspace);
    }
  } catch {
    snap = null;
  }
  try {
    return await run();
  } finally {
    if (snap) {
      try {
        applyBashTreeDelta(snap, ctx);
      } catch {
        /* journal best-effort */
      }
    }
  }
}
