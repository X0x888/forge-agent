/**
 * Git worktree helpers for subagent isolation.
 *
 * Creates a detached linked worktree under ~/.forge/worktrees/ so nested
 * agents can edit without touching the parent checkout. On a completed
 * handoff, Forge captures the worktree diff and lands it into the parent
 * workspace (default) so isolation is not a dead-end. Incomplete /
 * aborted / error / stop-hook / cost-cap skip apply and keep the worktree. Best-effort
 * cleanup with
 * `git worktree remove --force` (and directory rm fallback). Keep the
 * worktree on land conflict or when FORGE_SUBAGENT_KEEP_WORKTREE=1.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { forgeHome, ensureDir } from "../util/fs.js";
import { log } from "../util/log.js";
import { appendFileMutation } from "../session/mutations.js";
import { createChildEnv } from "./tools/env-policy.js";
import { fileReadsForSession } from "./tools/file-read-state.js";

export interface SubagentWorktree {
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Git common dir / main repo root (absolute). */
  gitRoot: string;
  /** Detached or branch name used. */
  ref: string;
  /** Remove the worktree from disk + git metadata. */
  cleanup: () => Promise<void>;
}

/** Outcome of capturing + landing a subagent worktree into the parent. */
export type WorktreeLandStatus =
  | "clean" // no changes in worktree
  | "applied" // patch applied cleanly to parent
  | "conflict" // apply failed; worktree kept for manual recovery
  | "empty_patch" // files changed but patch was empty (e.g. mode-only)
  | "skipped" // landing disabled / aborted / forced keep
  | "error"; // unexpected failure capturing/applying

export interface WorktreeLandResult {
  status: WorktreeLandStatus;
  /** Absolute worktree path (may still exist when kept). */
  worktreePath: string;
  /** Parent workspace the patch targeted. */
  parentPath: string;
  /** Paths touched in the worktree (relative to worktree root). */
  changedFiles: string[];
  /** Short unified-diff stat lines (git diff --stat). */
  diffStat?: string;
  /** Whether the worktree directory was left on disk. */
  kept: boolean;
  /** Human-readable reason / error detail. */
  detail?: string;
  /** Bytes of the captured patch (for diagnostics). */
  patchBytes?: number;
  /** True when parent pre-images were written to the mutation journal. */
  journaled?: boolean;
}

function git(
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number; maxBuffer?: number },
): string {
  const raw = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts?.timeoutMs ?? 30_000,
    maxBuffer: opts?.maxBuffer ?? 2 * 1024 * 1024,
    env: createChildEnv(),
  });
  // Do not trimStart: porcelain v1 unstaged-only is `" M path"` and the
  // leading space is a status column. Trimming it made slice(3) drop `s`.
  return raw.trimEnd();
}

export function unquotePorcelainPath(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Parse one `git status --porcelain=v1` line into a changed path.
 * Unstaged-only is `" M path"` — the first column is a space; do not
 * trim the line before slicing or `src/…` becomes `rc/…`.
 */
export function parsePorcelainPath(line: string): string | null {
  if (!line) return null;
  let body: string | null = null;
  // Standard porcelain v1: two XY columns, then a space, then the path.
  if (line.length >= 4 && line[2] === " ") {
    body = line.slice(3);
  } else if (
    // Recover a trim()-damaged unstaged line (`" M src/…"` → `"M src/…"`).
    line.length >= 3 &&
    /^[MADRCU?!] /.test(line) &&
    line[2] !== " "
  ) {
    body = line.slice(2);
  }
  if (body == null) return null;
  if (body.includes(" -> ")) {
    const dest = unquotePorcelainPath(body.split(" -> ").pop() ?? "");
    return dest || null;
  }
  const p = unquotePorcelainPath(body);
  return p || null;
}

/** Resolve git top-level for a workspace path, or null if not a repo. */
export function findGitRoot(start: string): string | null {
  try {
    const root = git(["rev-parse", "--show-toplevel"], start);
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

export function worktreeBaseDir(): string {
  return path.join(forgeHome(), "worktrees");
}

/**
 * Create a detached worktree at HEAD for isolated subagent work.
 * Throws with a clear message when git is unavailable or not a repo.
 */
export function createSubagentWorktree(opts: {
  workspace: string;
  /** Short label for the directory name (sanitized). */
  label?: string;
  sessionId?: string;
}): SubagentWorktree {
  const workspace = path.resolve(opts.workspace);
  const gitRoot = findGitRoot(workspace);
  if (!gitRoot) {
    throw new Error(
      "isolation=worktree requires a git repository (no .git found from workspace). " +
        "Use isolation=none or init a git repo first.",
    );
  }

  // Verify git binary works
  try {
    git(["--version"], gitRoot);
  } catch {
    throw new Error(
      "isolation=worktree requires the `git` CLI on PATH.",
    );
  }

  const slug = sanitizeLabel(opts.label || "sub");
  const id =
    (opts.sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) ||
    randomBytes(4).toString("hex");
  const dirName = `sub-${slug}-${id}-${Date.now().toString(36)}`.slice(0, 80);
  const wtPath = path.join(worktreeBaseDir(), dirName);
  ensureDir(worktreeBaseDir());

  // Detached HEAD at current commit — no branch pollution.
  // --force not needed for new path.
  try {
    git(
      ["worktree", "add", "--detach", wtPath, "HEAD"],
      gitRoot,
      { timeoutMs: 60_000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Clean partial dir
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
    } catch {
      /* */
    }
    throw new Error(
      `Failed to create git worktree at ${wtPath}: ${msg.slice(0, 400)}`,
    );
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      git(
        ["worktree", "remove", "--force", wtPath],
        gitRoot,
        { timeoutMs: 60_000 },
      );
    } catch {
      // Fallback: prune + rm
      try {
        git(["worktree", "prune"], gitRoot, { timeoutMs: 15_000 });
      } catch {
        /* */
      }
      try {
        fs.rmSync(wtPath, { recursive: true, force: true });
      } catch (e) {
        log.warn(
          `worktree cleanup incomplete: ${wtPath} (${(e as Error).message})`,
        );
      }
    }
  };

  return {
    path: wtPath,
    gitRoot,
    ref: "HEAD (detached)",
    cleanup,
  };
}

function sanitizeLabel(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "sub"
  );
}

export type IsolationMode = "none" | "worktree";

/**
 * Default isolation for a spawn. General-purpose implement work goes to a
 * detached worktree when the workspace is a git repo so parent files stay
 * untouched until auto-land. Explore/plan stay in-place (read-only).
 * Explicit `isolation=none` / `worktree` still wins.
 * `FORGE_SUBAGENT_ISOLATION=none|worktree` overrides the implicit default.
 */
export function defaultIsolationForSpawn(opts: {
  type?: string;
  isolation?: unknown;
  workspace?: string;
}): IsolationMode {
  const explicitRaw = opts.isolation;
  const hasExplicit =
    explicitRaw !== undefined &&
    explicitRaw !== null &&
    String(explicitRaw).trim() !== "";
  if (hasExplicit) return resolveIsolationMode(explicitRaw);
  const kind = String(opts.type || "general-purpose").toLowerCase();
  if (kind === "explore" || kind === "plan") return "none";
  const env = process.env.FORGE_SUBAGENT_ISOLATION;
  if (env != null && String(env).trim() !== "") {
    return resolveIsolationMode(env);
  }
  const ws = opts.workspace;
  if (ws && findGitRoot(ws)) return "worktree";
  return "none";
}

export function resolveIsolationMode(raw: unknown): IsolationMode {
  const s = String(raw ?? "none")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (
    s === "worktree" ||
    s === "wt" ||
    s === "git-worktree" ||
    s === "isolated" ||
    s === "isolate"
  ) {
    return "worktree";
  }
  return "none";
}

/**
 * Land policy for isolation=worktree subagents.
 * - auto (default): capture diff + apply into parent; keep worktree on conflict
 * - keep: never apply; leave worktree on disk for manual review
 * - discard: never apply; always remove worktree (legacy behavior)
 */
export function resolveWorktreeLandMode(
  raw?: string | null,
): "auto" | "keep" | "discard" {
  const env =
    raw ??
    process.env.FORGE_SUBAGENT_LAND ??
    process.env.FORGE_WORKTREE_LAND ??
    "auto";
  const s = String(env).trim().toLowerCase();
  if (
    s === "0" ||
    s === "false" ||
    s === "off" ||
    s === "discard" ||
    s === "none"
  ) {
    return "discard";
  }
  if (s === "keep" || s === "manual" || s === "review") {
    return "keep";
  }
  return "auto";
}

/** List changed paths inside a worktree (tracked mods + untracked, no ignore). */
export function listWorktreeChangedFiles(worktreePath: string): string[] {
  try {
    const out = git(
      ["status", "--porcelain=v1", "-uall", "--ignore-submodules=all"],
      worktreePath,
      { timeoutMs: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (!out) return [];
    const files: string[] = [];
    for (const line of out.split("\n")) {
      const p = parsePorcelainPath(line);
      if (p) files.push(p);
    }
    return [...new Set(files)];
  } catch {
    return [];
  }
}

/** `git diff --stat HEAD` + untracked note for human-readable summary. */
export function worktreeDiffStat(worktreePath: string): string {
  const chunks: string[] = [];
  try {
    const stat = git(
      ["diff", "--stat", "HEAD"],
      worktreePath,
      { timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (stat) chunks.push(stat);
  } catch {
    /* */
  }
  try {
    const untracked = git(
      ["ls-files", "--others", "--exclude-standard"],
      worktreePath,
      { timeoutMs: 15_000 },
    );
    if (untracked) {
      const n = untracked.split("\n").filter(Boolean).length;
      chunks.push(`${n} untracked file${n === 1 ? "" : "s"}`);
    }
  } catch {
    /* */
  }
  return chunks.join("\n").trim();
}

/**
 * Capture a full worktree patch (tracked diffs + untracked as /dev/null diffs)
 * suitable for `git apply` in the parent checkout.
 */
export function captureWorktreePatch(worktreePath: string): {
  patch: string;
  changedFiles: string[];
  diffStat: string;
} {
  const changedFiles = listWorktreeChangedFiles(worktreePath);
  const diffStat = worktreeDiffStat(worktreePath);
  const parts: string[] = [];

  // Tracked changes (incl. renames) vs HEAD
  try {
    const tracked = execFileSync(
      "git",
      ["diff", "--binary", "--find-renames", "HEAD"],
      {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: createChildEnv(),
      },
    );
    if (tracked) parts.push(tracked.endsWith("\n") ? tracked : tracked + "\n");
  } catch {
    /* empty or failed */
  }

  // Untracked files as new-file diffs
  let untracked: string[] = [];
  try {
    const raw = git(
      ["ls-files", "--others", "--exclude-standard"],
      worktreePath,
      { timeoutMs: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    untracked = raw ? raw.split("\n").filter(Boolean) : [];
  } catch {
    untracked = [];
  }

  for (const rel of untracked) {
    const abs = path.join(worktreePath, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      // Cap individual untracked file size (8 MiB) to avoid blowing buffers
      if (st.size > 8 * 1024 * 1024) {
        log.warn(
          `worktree land: skip large untracked file ${rel} (${st.size} bytes)`,
        );
        continue;
      }
    } catch {
      continue;
    }
    try {
      const fileDiff = execFileSync(
        "git",
        ["diff", "--binary", "--no-index", "--", "/dev/null", rel],
        {
          cwd: worktreePath,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          env: createChildEnv(),
        },
      );
      // git diff --no-index exits 0 only when identical; real diffs throw below.
      if (fileDiff) {
        parts.push(fileDiff.endsWith("\n") ? fileDiff : fileDiff + "\n");
      }
    } catch (err: unknown) {
      // execFileSync throws on exit code 1; stdout is on error.stdout
      const e = err as { stdout?: string };
      const out = typeof e.stdout === "string" ? e.stdout : "";
      if (out) {
        parts.push(out.endsWith("\n") ? out : out + "\n");
      }
    }
  }

  return {
    patch: parts.join(""),
    changedFiles,
    diffStat,
  };
}

/**
 * Apply a captured worktree patch into the parent workspace.
 * Returns ok=false with stderr detail on conflict / reject.
 */
/** Snapshot parent-tree pre-images so /undo can revert a worktree land. */
export function snapshotParentPreimages(
  parentPath: string,
  relPaths: string[],
): Map<string, { before?: string; mode?: number; existed: boolean }> {
  const out = new Map<
    string,
    { before?: string; mode?: number; existed: boolean }
  >();
  for (const rel of relPaths) {
    const abs = path.resolve(parentPath, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        out.set(rel, { existed: false });
        continue;
      }
      out.set(rel, {
        existed: true,
        before: fs.readFileSync(abs, "utf8"),
        mode: st.mode & 0o777,
      });
    } catch {
      out.set(rel, { existed: false });
    }
  }
  return out;
}

/** Restore parent files to a pre-apply snapshot (failed --3way cleanup). */
export function restoreParentPreimages(
  parentPath: string,
  snapshots: Map<string, { before?: string; mode?: number; existed: boolean }>,
): void {
  for (const [rel, snap] of snapshots) {
    const abs = path.resolve(parentPath, rel);
    try {
      if (!snap.existed) {
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
        continue;
      }
      if (snap.before !== undefined) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, snap.before, { encoding: "utf8" });
        if (snap.mode !== undefined) {
          try {
            fs.chmodSync(abs, snap.mode);
          } catch {
            /* best-effort */
          }
        }
      }
    } catch {
      /* best-effort */
    }
  }
}

export function journalLandedPreimages(opts: {
  sessionId: string;
  parentPath: string;
  relPaths: string[];
  snapshots: Map<string, { before?: string; mode?: number; existed: boolean }>;
  turn: number;
}): void {
  for (const rel of opts.relPaths) {
    const snap = opts.snapshots.get(rel);
    const abs = path.resolve(opts.parentPath, rel);
    appendFileMutation(opts.sessionId, {
      path: abs,
      kind: snap?.existed ? "update" : "create",
      before: snap?.existed ? snap.before : undefined,
      mode: snap?.mode,
      turn: opts.turn,
    });
    try {
      fileReadsForSession(opts.sessionId).clear(abs);
    } catch {
      /* best-effort */
    }
  }
}

export function applyWorktreePatch(
  parentPath: string,
  patch: string,
): { ok: boolean; detail?: string } {
  if (!patch.trim()) {
    return { ok: true, detail: "empty patch" };
  }
  const tmp = path.join(
    os.tmpdir(),
    `forge-wt-land-${process.pid}-${randomBytes(4).toString("hex")}.patch`,
  );
  // Snapshot index state so --3way cannot leave staged junk in the parent.
  let indexBefore = "";
  try {
    indexBefore = git(["status", "--porcelain=v1"], parentPath, {
      timeoutMs: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    indexBefore = "";
  }
  const unstageNewIndexEntries = () => {
    try {
      const after = git(["status", "--porcelain=v1"], parentPath, {
        timeoutMs: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      // Lines starting with A/M/D/R/C in first column are index changes.
      const staged: string[] = [];
      for (const line of after.split("\n")) {
        if (!line || line.length < 4) continue;
        const x = line[0]; // index status
        if (x === " " || x === "?" || x === "!") continue;
        // Only unstage paths that were not already staged before apply
        if (indexBefore.includes(line)) continue;
        const rel = parsePorcelainPath(line);
        if (rel) staged.push(rel);
      }
      if (staged.length) {
        execFileSync(
          "git",
          ["reset", "-q", "HEAD", "--", ...staged],
          {
            cwd: parentPath,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 15_000,
            env: createChildEnv(),
          },
        );
      }
    } catch {
      /* best-effort — never fail the land because unstage failed */
    }
  };
  try {
    fs.writeFileSync(tmp, patch, { encoding: "utf8", mode: 0o600 });
    // Prefer plain apply (never touches index). Fall back to --3way when the
    // parent drifted; then unstage anything --3way added to the index.
    try {
      execFileSync("git", ["apply", "--whitespace=nowarn", tmp], {
        cwd: parentPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: createChildEnv(),
      });
      return { ok: true };
    } catch (errPlain: unknown) {
      const ePlain = errPlain as { stderr?: string; message?: string };
      try {
        execFileSync("git", ["apply", "--3way", "--whitespace=nowarn", tmp], {
          cwd: parentPath,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          env: createChildEnv(),
        });
        unstageNewIndexEntries();
        return { ok: true };
      } catch (err: unknown) {
        unstageNewIndexEntries();
        const e = err as { stderr?: string; message?: string };
        const detail = String(
          e.stderr || ePlain.stderr || e.message || ePlain.message || "apply failed",
        )
          .trim()
          .slice(0, 800);
        return { ok: false, detail };
      }
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* */
    }
  }
}

/**
 * Capture worktree changes and land them into the parent workspace.
 *
 * Default policy (`auto`): apply patch; on success remove worktree; on conflict
 * keep worktree + report paths so the parent agent can recover without data loss.
 *
 * Env:
 * - FORGE_SUBAGENT_LAND=auto|keep|discard (alias FORGE_WORKTREE_LAND)
 * - FORGE_SUBAGENT_KEEP_WORKTREE=1 forces keep (no apply, leave on disk)
 */
export async function landSubagentWorktree(opts: {
  worktree: SubagentWorktree;
  parentWorkspace: string;
  /** Override land mode (tests). */
  mode?: "auto" | "keep" | "discard";
  /** Force keep (env KEEP_WORKTREE / aborted runs). */
  forceKeep?: boolean;
  /** Skip apply (incomplete / aborted / failed subagent) but still report diff. */
  skipApply?: boolean;
  /** Parent session id — journals pre-images so /undo can revert the land. */
  sessionId?: string;
  /** Parent turn for the mutation journal. */
  turn?: number;
}): Promise<WorktreeLandResult> {
  const { worktree } = opts;
  const parentPath = path.resolve(opts.parentWorkspace);
  const mode = opts.mode ?? resolveWorktreeLandMode();
  const forceKeep =
    opts.forceKeep ||
    process.env.FORGE_SUBAGENT_KEEP_WORKTREE === "1" ||
    process.env.FORGE_SUBAGENT_KEEP_WORKTREE === "true" ||
    process.env.FORGE_SUBAGENT_KEEP === "1" ||
    process.env.FORGE_SUBAGENT_KEEP === "true";

  const base = {
    worktreePath: worktree.path,
    parentPath,
  };

  let captured: { patch: string; changedFiles: string[]; diffStat: string };
  try {
    captured = captureWorktreePatch(worktree.path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Keep on capture failure so work is not lost
    return {
      ...base,
      status: "error",
      changedFiles: [],
      kept: true,
      detail: `capture failed: ${msg.slice(0, 400)}`,
    };
  }

  const { patch, changedFiles, diffStat } = captured;
  const patchBytes = Buffer.byteLength(patch, "utf8");

  if (changedFiles.length === 0 && !patch.trim()) {
    if (!forceKeep && mode !== "keep") {
      await worktree.cleanup().catch(() => {});
      return {
        ...base,
        status: "clean",
        changedFiles: [],
        diffStat,
        kept: false,
        patchBytes: 0,
      };
    }
    return {
      ...base,
      status: "clean",
      changedFiles: [],
      diffStat,
      kept: true,
      patchBytes: 0,
      detail: forceKeep || mode === "keep" ? "kept (no changes)" : undefined,
    };
  }

  // Incomplete runs keep the worktree even when land=discard — discard
  // used to cleanup() before skipApply and destroy the only copy.
  if (forceKeep || mode === "keep" || opts.skipApply) {
    return {
      ...base,
      status: "skipped",
      changedFiles,
      diffStat,
      kept: true,
      patchBytes,
      detail: opts.skipApply
        ? "apply skipped (incomplete/aborted/failed run) — worktree kept"
        : "land=keep — review and merge manually",
    };
  }

  // discard: drop worktree without applying (completed children only)
  if (mode === "discard") {
    await worktree.cleanup().catch(() => {});
    return {
      ...base,
      status: "skipped",
      changedFiles,
      diffStat,
      kept: false,
      patchBytes,
      detail: "land=discard — worktree removed without applying",
    };
  }

  // auto: apply into parent
  if (!patch.trim()) {
    // Changed files listed but no patch (e.g. submodule noise) — keep to be safe
    return {
      ...base,
      status: "empty_patch",
      changedFiles,
      diffStat,
      kept: true,
      patchBytes: 0,
      detail: "changes detected but patch empty — worktree kept",
    };
  }

  const preimages = changedFiles.length
    ? snapshotParentPreimages(parentPath, changedFiles)
    : null;
  const applied = applyWorktreePatch(parentPath, patch);
  if (!applied.ok && preimages) {
    restoreParentPreimages(parentPath, preimages);
  }
  if (applied.ok) {
    let journaled = false;
    if (opts.sessionId && preimages) {
      try {
        journalLandedPreimages({
          sessionId: opts.sessionId,
          parentPath,
          relPaths: changedFiles,
          snapshots: preimages,
          turn: opts.turn ?? 0,
        });
        journaled = true;
      } catch {
        /* journal is best-effort */
      }
    }
    await worktree.cleanup().catch(() => {});
    return {
      ...base,
      status: "applied",
      changedFiles,
      diffStat,
      kept: false,
      patchBytes,
      ...(journaled ? { journaled: true } : {}),
      detail: `landed ${changedFiles.length} file(s) into parent`,
    };
  }

  // Partial land: try each file independently so one conflict doesn't drop everything.
  const partial = tryPartialWorktreeLand(worktree.path, parentPath, changedFiles);
  let journaledPartial = false;
  if (partial.applied.length > 0 && opts.sessionId && preimages) {
    try {
      journalLandedPreimages({
        sessionId: opts.sessionId,
        parentPath,
        relPaths: partial.applied,
        snapshots: preimages,
        turn: opts.turn ?? 0,
      });
      journaledPartial = true;
    } catch {
      /* journal is best-effort */
    }
  }
  if (partial.applied.length > 0 && partial.failed.length === 0) {
    await worktree.cleanup().catch(() => {});
    return {
      ...base,
      status: "applied",
      changedFiles: partial.applied,
      diffStat,
      kept: false,
      patchBytes,
      ...(journaledPartial ? { journaled: true } : {}),
      detail: `landed ${partial.applied.length} file(s) via per-file fallback`,
    };
  }
  if (partial.applied.length > 0) {
    // Keep worktree for the failed remainder
    log.warn(
      `worktree land partial (${worktree.path}): ${partial.applied.length} ok, ${partial.failed.length} failed`,
    );
    return {
      ...base,
      status: "conflict",
      changedFiles,
      diffStat,
      kept: true,
      patchBytes,
      ...(journaledPartial ? { journaled: true } : {}),
      detail:
        `partial land: ok=[${partial.applied.slice(0, 8).join(", ")}]` +
        (partial.applied.length > 8 ? ` +${partial.applied.length - 8}` : "") +
        `; failed=[${partial.failed.slice(0, 8).join(", ")}]` +
        (partial.failed.length > 8 ? ` +${partial.failed.length - 8}` : "") +
        ` — worktree kept`,
    };
  }

  // Conflict: keep worktree for recovery
  log.warn(
    `worktree land conflict (${worktree.path}): ${(applied.detail || "").slice(0, 200)}`,
  );
  return {
    ...base,
    status: "conflict",
    changedFiles,
    diffStat,
    kept: true,
    patchBytes,
    detail: applied.detail || "git apply failed",
  };
}

/** Best-effort per-file land when the full patch conflicts. */
function tryPartialWorktreeLand(
  worktreePath: string,
  parentPath: string,
  changedFiles: string[],
): { applied: string[]; failed: string[] } {
  const applied: string[] = [];
  const failed: string[] = [];
  for (const rel of changedFiles) {
    try {
      const src = path.join(worktreePath, rel);
      const dest = path.join(parentPath, rel);
      if (!fs.existsSync(src)) {
        // deletion in worktree
        if (fs.existsSync(dest)) {
          fs.rmSync(dest, { force: true });
          applied.push(rel);
        } else {
          failed.push(rel);
        }
        continue;
      }
      const st = fs.statSync(src);
      if (!st.isFile()) {
        failed.push(rel);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      applied.push(rel);
    } catch {
      failed.push(rel);
    }
  }
  return { applied, failed };
}

/** Format a land result as a short block for the parent agent / tool result. */
export function formatWorktreeLandSummary(r: WorktreeLandResult): string {
  const lines: string[] = [];
  const fileN = r.changedFiles.length;
  const filesHint =
    fileN === 0
      ? "no file changes"
      : `${fileN} file${fileN === 1 ? "" : "s"}: ${r.changedFiles
          .slice(0, 12)
          .join(", ")}${fileN > 12 ? `, +${fileN - 12} more` : ""}`;

  switch (r.status) {
    case "clean":
      lines.push(
        r.kept
          ? `[worktree] clean — kept ${r.worktreePath}`
          : `[worktree] clean — removed ${r.worktreePath}`,
      );
      break;
    case "applied":
      lines.push(
        r.journaled
          ? `[worktree] landed into parent (${filesHint}) — worktree removed · /undo reverts`
          : `[worktree] landed into parent (${filesHint}) — worktree removed`,
      );
      break;
    case "conflict":
      lines.push(
        `[worktree] LAND CONFLICT — kept ${r.worktreePath}`,
        `  ${filesHint}`,
        `  reason: ${(r.detail || "apply failed").slice(0, 300)}`,
        r.journaled
          ? `  recover: landed files can be reverted with /undo; inspect worktree, then: git worktree remove --force <path>`
          : `  recover: inspect worktree, copy/merge into parent, then: git worktree remove --force <path>`,
      );
      break;
    case "empty_patch":
      lines.push(
        `[worktree] changes present but empty patch — kept ${r.worktreePath}`,
        `  ${filesHint}`,
      );
      break;
    case "skipped":
      lines.push(
        `[worktree] ${r.kept ? "kept" : "removed"} ${r.worktreePath}` +
          (r.detail ? ` — ${r.detail}` : ""),
      );
      if (fileN > 0) lines.push(`  ${filesHint}`);
      break;
    case "error":
      lines.push(
        `[worktree] land error — kept ${r.worktreePath}: ${(r.detail || "unknown").slice(0, 300)}`,
      );
      break;
  }

  if (r.diffStat && r.status !== "clean") {
    const statLines = r.diffStat.split("\n").slice(0, 16);
    lines.push("  diffstat:");
    for (const s of statLines) lines.push(`    ${s}`);
  }

  return lines.filter(Boolean).join("\n");
}
