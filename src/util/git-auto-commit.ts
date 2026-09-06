/**
 * Local git commits during unattended ULW — one per reviewed, verified cycle.
 * Never pushes. Kill-switch: FORGE_ULW_AUTO_COMMIT=0.
 *
 * Staging rules are the harness's, not the model's: secrets never, disposable
 * test fixtures never, `.forge/` scratch never, and a look (screenshot / look
 * HTML) only when something in the tree references it.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isFalsy } from "./bool.js";
import { forgeHome, nowIso } from "./fs.js";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { findGitRoot, parsePorcelainPath } from "../agent/worktree.js";

const SENSITIVE_RE =
  /(^|\/)(\.env(\..+)?|.*\.(pem|p12|pfx|key)|id_rsa|id_ed25519|id_dsa|auth\.json|credentials|secrets?\.json)$/i;

/**
 * A look: an image or HTML file whose name or directory says "screenshot".
 * HashPet's run committed 78 of these (968 KB) under `images/`, none of
 * them loaded by the extension. A sprite the manifest names is a product
 * file and stays; a look nothing references is left unstaged and named.
 */
const LOOK_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|html?)$/i;
const LOOK_NAME_RE =
  /(^|[-_.])(look|looks|screenshot|screenshots|shot|shots|capture|captures|preview|previews|states?|frame\d*|before|after|snap|snapshot)([-_.]|$)/i;
const LOOK_DIR_RE = /(^|\/)(images|img|screenshots|shots|looks|captures|previews|snapshots)\//i;
const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|html?)$/i;
const ASSET_LOOKUP_CAP = 40;

export function isLookArtefactRelPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  if (!LOOK_EXT_RE.test(n)) return false;
  const base = n.split("/").pop() || "";
  return LOOK_NAME_RE.test(base.replace(/\.[^.]+$/, "")) || LOOK_DIR_RE.test(n);
}

/**
 * The project's `.forge/` holds the tracked memory mirror, commands, skills
 * and hooks. Anything else under it — a Chromium profile, a scratch dir —
 * is not a ship.
 */
const FORGE_KEEP_RE =
  /^\.forge\/(MEMORY\.md|AGENTS\.md|hooks\.json|config\.toml|commands\/|skills\/|hooks\/)/;

export function isForgeScratchRelPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n.startsWith(".forge/")) return false;
  return !FORGE_KEEP_RE.test(n);
}

export interface AutoCommitResult {
  committed: boolean;
  sha?: string;
  subject?: string;
  files?: number;
  skipped?: string;
  /** Look artefacts / scratch left unstaged on purpose (named in the admit). */
  leftUnstaged?: string[];
}

export function ulwAutoCommitEnabled(): boolean {
  return !isFalsy(process.env.FORGE_ULW_AUTO_COMMIT ?? "1");
}

/** Fallback only when the repo/user has no commit identity. */
export const ULW_COMMIT_NAME = "Forge";
export const ULW_COMMIT_EMAIL = "forge@local";

function git(args: string[], cwd: string, timeoutMs = 30_000): string {
  const raw = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: createChildEnv(),
  });
  // Do not trimStart: porcelain v1 unstaged-only is `" M path"` and the
  // leading space is a status column.
  return raw.trimEnd();
}

function gitQuiet(args: string[], cwd: string, timeoutMs = 8_000): string | null {
  try {
    return git(args, cwd, timeoutMs);
  } catch {
    return null;
  }
}

export function formatGitExecError(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  const stderr = String(e.stderr || "")
    .replace(/\s+/g, " ")
    .trim();
  if (stderr) return stderr.slice(0, 240);
  return String(e.message || err)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function gitHasAuthorIdentity(cwd: string): boolean {
  try {
    return Boolean(git(["var", "GIT_AUTHOR_IDENT"], cwd, 5_000));
  } catch {
    return false;
  }
}

/** `-c` overrides used only when `git var GIT_AUTHOR_IDENT` fails. */
export function commitIdentArgs(cwd: string): string[] {
  if (gitHasAuthorIdentity(cwd)) return [];
  return [
    "-c",
    `user.name=${ULW_COMMIT_NAME}`,
    "-c",
    `user.email=${ULW_COMMIT_EMAIL}`,
  ];
}

export function porcelainPaths(cwd: string): string[] {
  // -uall: a new directory is `?? src/ui.ts`, not `?? src/`.
  const out = git(["status", "--porcelain", "-uall"], cwd, 15_000);
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const p = parsePorcelainPath(line.replace(/\r$/, ""));
    if (p) paths.push(p);
  }
  return paths;
}

/** Stage as a batch; on failure, add survivors one-by-one so one bad path cannot skip the commit. */
export function stageAutoCommitPaths(
  root: string,
  paths: string[],
): { staged: string[]; failed: string[] } {
  if (!paths.length) return { staged: [], failed: [] };
  try {
    git(["add", "--", ...paths], root, 30_000);
    return { staged: paths, failed: [] };
  } catch {
    const staged: string[] = [];
    const failed: string[] = [];
    for (const p of paths) {
      try {
        git(["add", "--", p], root, 15_000);
        staged.push(p);
      } catch {
        failed.push(p);
      }
    }
    return { staged, failed };
  }
}

export function isSensitiveRelPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/");
  return SENSITIVE_RE.test(norm);
}

/** Do not mint a commit for CHANGELOG alone. */
export function isChangelogRelPath(rel: string): boolean {
  const base = rel.replace(/\\/g, "/").split("/").pop() || "";
  return /^changelog(\.(md|markdown|txt|rst))?$/i.test(base);
}

/**
 * Worktree-land tests write disposable files under `src/agent/__wt_land_*`
 * so `git status -uall` can see them. They are not product files.
 */
export function isDisposableTestRelPath(rel: string): boolean {
  const base = rel.replace(/\\/g, "/").split("/").pop() || "";
  return base.startsWith("__wt_land_");
}

function untrackedFiles(cwd: string): string[] {
  const out = gitQuiet(["ls-files", "--others", "--exclude-standard"], cwd, 4000);
  return (out || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function untrackedReferences(cwd: string, needle: string): boolean {
  for (const rel of untrackedFiles(cwd).slice(0, 200)) {
    if (ASSET_EXT_RE.test(rel)) continue;
    try {
      const st = fs.statSync(path.join(cwd, rel));
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      if (fs.readFileSync(path.join(cwd, rel), "utf8").includes(needle)) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

/**
 * Assets nothing references: `git grep -l -F <basename>` over tracked files
 * that are not themselves assets, plus the untracked dirty tree. Capped.
 */
export function findUnreferencedAssets(cwd: string, assets: string[]): string[] {
  const out: string[] = [];
  for (const rel of assets.slice(0, ASSET_LOOKUP_CAP)) {
    const base = path.basename(rel);
    if (!base) continue;
    const hits = gitQuiet(
      [
        "grep",
        "-l",
        "-I",
        "-F",
        base,
        "--",
        ".",
        ":!*.png",
        ":!*.jpg",
        ":!*.jpeg",
        ":!*.gif",
        ":!*.webp",
        ":!*.bmp",
        ":!*.ico",
        ":!*.html",
        ":!*.htm",
      ],
      cwd,
      4000,
    );
    const referenced = Boolean(hits && hits.trim()) || untrackedReferences(cwd, base);
    if (!referenced) out.push(rel);
  }
  return out;
}

/**
 * Commit the current dirty tree (minus secrets, scratch and orphan looks)
 * with the given subject and body. Never pushes.
 */
export function commitDirtyTree(opts: {
  cwd: string;
  subject: string;
  body: string;
  permissionMode?: string;
}): AutoCommitResult {
  if (!ulwAutoCommitEnabled()) {
    return { committed: false, skipped: "FORGE_ULW_AUTO_COMMIT=0" };
  }
  if (opts.permissionMode === "plan") {
    return { committed: false, skipped: "plan mode" };
  }
  const root = findGitRoot(opts.cwd);
  if (!root) return { committed: false, skipped: "not a git repository" };

  let dirty: string[];
  try {
    dirty = porcelainPaths(root);
  } catch (err) {
    return {
      committed: false,
      skipped: `status failed: ${formatGitExecError(err)}`,
    };
  }
  if (!dirty.length) return { committed: false, skipped: "working tree clean" };

  // A run scoped to a subdirectory (monorepo package, or a fixture whose
  // temp dir sits inside a repo) commits only what lies under its workspace.
  // Without this, `git rev-parse` walks up and the cycle commit sweeps the
  // enclosing repo's dirty tree — a test run once committed this repo.
  const scope = path.relative(root, path.resolve(opts.cwd)).replace(/\\/g, "/");
  if (scope && !scope.startsWith("..")) {
    dirty = dirty.filter((p) => p === scope || p.startsWith(`${scope}/`));
    if (!dirty.length) {
      return { committed: false, skipped: `no changes under ${scope}/` };
    }
  }

  let toAdd = dirty.filter(
    (p) =>
      !isSensitiveRelPath(p) &&
      !isDisposableTestRelPath(p) &&
      !isForgeScratchRelPath(p),
  );
  const leftUnstaged = dirty.filter(isForgeScratchRelPath);
  const looks = toAdd.filter(isLookArtefactRelPath);
  if (looks.length) {
    let orphan: string[] = [];
    try {
      orphan = findUnreferencedAssets(root, looks);
    } catch {
      orphan = [];
    }
    if (orphan.length) {
      const drop = new Set(orphan);
      toAdd = toAdd.filter((p) => !drop.has(p));
      leftUnstaged.push(...orphan);
    }
  }
  if (!toAdd.length) {
    return {
      committed: false,
      skipped: leftUnstaged.length
        ? "only look artefacts / scratch remain"
        : dirty.every(isDisposableTestRelPath)
          ? "only disposable test fixtures remain"
          : "only sensitive paths remain",
      ...(leftUnstaged.length ? { leftUnstaged } : {}),
    };
  }
  if (toAdd.every((p) => isChangelogRelPath(p))) {
    return { committed: false, skipped: "changelog-only" };
  }

  const { staged, failed } = stageAutoCommitPaths(root, toAdd);
  if (!staged.length) {
    return {
      committed: false,
      skipped: `git add failed: ${failed[0] || toAdd[0]}`.slice(0, 280),
    };
  }

  const subject = (opts.subject || "").replace(/\s+/g, " ").trim().slice(0, 72) || "ULW cycle";
  const body = [opts.body.trim(), `Files: ${staged.slice(0, 20).join(", ")}${staged.length > 20 ? ` … +${staged.length - 20} more` : ""}`]
    .filter(Boolean)
    .join("\n");
  try {
    // --no-gpg-sign / --no-verify: unattended snapshot, never wait on
    // pinentry or a pre-commit hook.
    git(
      [
        ...commitIdentArgs(root),
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        subject,
        "-m",
        body,
      ],
      root,
      60_000,
    );
  } catch (err) {
    return {
      committed: false,
      skipped: `git commit failed: ${formatGitExecError(err)}`,
    };
  }

  let sha = "";
  try {
    sha = git(["rev-parse", "--short", "HEAD"], root, 5_000);
  } catch {
    sha = "";
  }
  return {
    committed: true,
    sha: sha || undefined,
    subject,
    files: staged.length,
    ...(leftUnstaged.length ? { leftUnstaged } : {}),
  };
}

/** Where a session's looks belong: outside the repo, beside its ledger. */
export function sessionLooksDir(sessionId: string): string {
  return path.join(forgeHome(), "sessions", sessionId, "looks");
}

/**
 * Harness line after a commit that left looks / scratch unstaged. Named so
 * the model stops writing them into the tree, not so it stages them.
 */
export function formatLeftUnstagedAdmit(
  result: Pick<AutoCommitResult, "leftUnstaged">,
  sessionId: string,
): string | undefined {
  const left = result.leftUnstaged ?? [];
  if (!left.length) return undefined;
  const shown = left.slice(0, 4).join(", ");
  const more = left.length > 4 ? ` (+${left.length - 4} more)` : "";
  return [
    "[Forge harness — mid-conversation update]",
    `Auto-commit left ${left.length} file(s) unstaged — looks nothing in the product references, or \`.forge/\` scratch: ${shown}${more}.`,
    `Screenshots, look HTML and browser profiles belong outside the repo: ${sessionLooksDir(sessionId)} (or --user-data-dir under ~/.forge/tmp). A sprite the product loads is a product file and commits as usual. Delete or move these; do not \`git add\` them.`,
  ].join("\n");
}

export function autoCommitStamp(result: AutoCommitResult): {
  sha?: string;
  subject?: string;
  at: string;
  skipped?: string;
} {
  return {
    sha: result.sha,
    subject: result.subject,
    at: nowIso(),
    skipped: result.skipped,
  };
}
