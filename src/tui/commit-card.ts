/**
 * `/commit` — the sit-down key that closes the day.
 *
 * Typing `/commit` used to start a model turn ("draft a message").
 * That is the same hole `/verify` closed for `npm test`: a key that
 * becomes a prompt. This key opens a verdict-first card; `/commit do`
 * creates the local commit (never push, no model). Designed empty is
 * `commit  ·  nothing to commit`, not `commit  ·  ok`.
 *
 * `/commit draft` keeps the model escape hatch (handleSlash).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import { findGitRoot, parsePorcelainPath } from "../agent/worktree.js";
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import { isLastVerificationStale } from "../session/session.js";
import {
  commitIdentArgs,
  formatGitExecError,
  isDisposableTestRelPath,
  isSensitiveRelPath,
  stageAutoCommitPaths,
} from "../util/git-auto-commit.js";
import { formatVerifyCloser } from "./verify-card.js";

export type CommitKind =
  | "ok"
  | "peek"
  | "empty"
  | "norepo"
  | "plan"
  | "fail";

export interface CommitArg {
  doCommit: boolean;
  stagedOnly: boolean;
  wantDraft: boolean;
  help: boolean;
}

const DO_TOKS = new Set(["do", "run", "create", "make", "yes", "commit"]);
const STAGED_TOKS = new Set(["staged", "index", "cached"]);
const DRAFT_TOKS = new Set(["draft", "prompt", "message"]);

export function parseCommitArg(arg?: string): CommitArg {
  const tokens = String(arg || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return {
    doCommit: tokens.some((t) => DO_TOKS.has(t)),
    stagedOnly: tokens.some((t) => STAGED_TOKS.has(t)),
    wantDraft: tokens.some((t) => DRAFT_TOKS.has(t)),
    help: tokens.some((t) => t.startsWith("-") || t === "help"),
  };
}

export function commitUsage(): string {
  return (
    "Usage: /commit [staged] [do] [draft]\n" +
    "  (empty)  card from unstaged+staged (no git commit)\n" +
    "  staged   index only\n" +
    "  do       create the commit (no push, no model)\n" +
    "  draft    model-write a message (escape hatch)\n"
  );
}

function gitOut(args: string[], cwd: string, timeoutMs = 15_000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  }).trimEnd();
}

export interface CommitTree {
  root: string | null;
  files: string[];
  staged: string[];
  unstaged: string[];
  skipped: string[];
  unmerged: string[];
  error?: string;
}

function emptyTree(
  root: string | null,
  extra?: Partial<CommitTree>,
): CommitTree {
  return {
    root,
    files: [],
    staged: [],
    unstaged: [],
    skipped: [],
    unmerged: [],
    ...extra,
  };
}

/** Porcelain XY pairs that mean a conflicted / unmerged path. */
const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function isUnmergedPorcelain(line: string): boolean {
  const x = line[0] ?? " ";
  const y = line[1] ?? " ";
  return UNMERGED_XY.has(`${x}${y}`);
}

export function inspectCommitTree(
  cwd: string,
  stagedOnly = false,
): CommitTree {
  const root = findGitRoot(cwd);
  if (!root) return emptyTree(null);
  let porcelain = "";
  try {
    porcelain = gitOut(["status", "--porcelain", "-uall"], root);
  } catch (err) {
    return emptyTree(root, { error: formatGitExecError(err) });
  }
  const staged: string[] = [];
  const unstaged: string[] = [];
  const skipped: string[] = [];
  const unmerged: string[] = [];
  const seen = new Set<string>();
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const p = parsePorcelainPath(line);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (isUnmergedPorcelain(line)) {
      unmerged.push(p);
      continue;
    }
    if (isSensitiveRelPath(p) || isDisposableTestRelPath(p)) {
      skipped.push(p);
      continue;
    }
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const inIndex = x !== " " && x !== "?";
    const inWork = y !== " " || x === "?";
    if (inIndex) staged.push(p);
    if (inWork) unstaged.push(p);
  }
  const files = stagedOnly ? [...staged] : [...new Set([...staged, ...unstaged])];
  return { root, files, staged, unstaged, skipped, unmerged };
}

export function draftCommitSubject(opts: {
  title?: string;
  files: string[];
}): string {
  const title = String(opts.title || "")
    .replace(/\s+/g, " ")
    .trim();
  if (title && !/^\(?untitled\)?$/i.test(title)) {
    return title.length > 68 ? `${title.slice(0, 67)}…` : title;
  }
  const files = opts.files.filter(Boolean);
  if (!files.length) return "Update files";
  const base = files[0].replace(/\\/g, "/").split("/").pop() || files[0];
  if (files.length === 1) return `Update ${base}`.slice(0, 68);
  return `Update ${base} and ${files.length - 1} more`.slice(0, 68);
}

export function draftCommitBody(opts: {
  files: string[];
  lastVerificationCommand?: string;
}): string {
  const lines: string[] = [];
  if (opts.files.length) {
    lines.push(`Files: ${opts.files.slice(0, 20).join(", ")}`);
    if (opts.files.length > 20) {
      lines.push(`… +${opts.files.length - 20} more`);
    }
  }
  const last = opts.lastVerificationCommand?.trim();
  if (last) lines.push(`Last verify: ${last.slice(0, 80)}`);
  return lines.join("\n");
}

export function formatCommitVerdict(
  kind: CommitKind,
  opts?: { color?: boolean; fileCount?: number },
): string {
  const color = opts?.color !== false;
  const title = color ? chalk.bold("commit") : "commit";
  const bit = (text: string, paint?: (s: string) => string) =>
    color && paint ? paint(text) : text;
  if (kind === "empty") {
    return `${title}  ·  ${bit("nothing to commit", chalk.dim)}`;
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
  if (kind === "ok") {
    return `${title}  ·  ${bit("ok", chalk.green)}`;
  }
  const n = opts?.fileCount ?? 0;
  const label = n === 1 ? "1 file" : `${n} files`;
  return `${title}  ·  ${bit(label, chalk.cyan)}`;
}

export function formatCommitCard(input: {
  kind: CommitKind;
  subject?: string;
  sha?: string;
  files?: string[];
  skipped?: string[];
  note?: string;
  next: string[];
  color?: boolean;
  columns?: number;
}): string {
  const color = input.color !== false;
  const files = input.files ?? [];
  const lines = [
    formatCommitVerdict(input.kind, { color, fileCount: files.length }),
  ];
  const sha = input.sha?.trim();
  if (sha) {
    const row = `  ${sha}`;
    lines.push(color ? chalk.green(row) : row);
  }
  const subject = input.subject?.trim();
  if (subject) {
    const row = `  ${subject}`;
    lines.push(color ? chalk.white(row) : row);
  }
  const note = input.note?.trim();
  if (note) {
    lines.push(color ? chalk.yellow(`  ${note}`) : `  ${note}`);
  }
  for (const f of files.slice(0, 12)) {
    const row = `  · ${f}`;
    lines.push(color ? chalk.dim(row) : row);
  }
  if (files.length > 12) {
    const more = `  · +${files.length - 12} more`;
    lines.push(color ? chalk.dim(more) : more);
  }
  for (const f of (input.skipped ?? []).slice(0, 4)) {
    const row = `  skipped  ${f}`;
    lines.push(color ? chalk.yellow(row) : row);
  }
  const closer = formatVerifyCloser(input.next, { columns: input.columns });
  if (closer) lines.push(closer);
  return lines.filter((l) => l.length > 0).join("\n");
}

export interface SessionCommitResult {
  ok: boolean;
  sha?: string;
  subject?: string;
  files: string[];
  skipped: string[];
  error?: string;
}

export function createSessionCommit(opts: {
  cwd: string;
  stagedOnly?: boolean;
  title?: string;
  lastVerificationCommand?: string;
}): SessionCommitResult {
  const tree = inspectCommitTree(opts.cwd, Boolean(opts.stagedOnly));
  if (!tree.root) {
    return { ok: false, files: [], skipped: [], error: "not a git repository" };
  }
  if (tree.error) {
    return {
      ok: false,
      files: [],
      skipped: tree.skipped,
      error: tree.error,
    };
  }
  if (tree.unmerged.length) {
    return {
      ok: false,
      files: tree.unmerged,
      skipped: tree.skipped,
      error: "unmerged paths — resolve conflicts first",
    };
  }
  const skipped = tree.skipped;
  let toCommit = tree.files;
  if (!opts.stagedOnly) {
    const { staged, failed } = stageAutoCommitPaths(tree.root, tree.files);
    if (!staged.length) {
      return {
        ok: false,
        files: tree.files,
        skipped,
        error: failed[0]
          ? `git add failed: ${failed[0]}`
          : "nothing to stage",
      };
    }
    toCommit = staged;
  } else if (!toCommit.length) {
    return { ok: false, files: [], skipped, error: "nothing staged" };
  }

  const subject = draftCommitSubject({
    title: opts.title,
    files: toCommit,
  });
  const body = draftCommitBody({
    files: toCommit,
    lastVerificationCommand: opts.lastVerificationCommand,
  });
  try {
    // Pathspecs only — a bare `git commit` would include skipped secrets
    // already sitting in the index. The card listed `toCommit`; that is
    // what lands.
    gitOut(
      [
        ...commitIdentArgs(tree.root),
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        subject,
        ...(body ? ["-m", body] : []),
        "--",
        ...toCommit,
      ],
      tree.root,
      60_000,
    );
  } catch (err) {
    return {
      ok: false,
      files: toCommit,
      skipped,
      subject,
      error: formatGitExecError(err),
    };
  }
  let sha = "";
  try {
    sha = gitOut(["rev-parse", "--short", "HEAD"], tree.root, 5_000).trim();
  } catch {
    sha = "";
  }
  return { ok: true, sha: sha || undefined, subject, files: toCommit, skipped };
}

function staleVerifyNote(session: SessionData): string {
  const last = session.meta.lastVerificationCommand?.trim();
  const edits = session.meta.editCount || 0;
  if (edits <= 0) return "";
  if (!last) return "edits with no recorded verification";
  if (isLastVerificationStale(session.meta)) {
    return `last-verify stale (\`${last.slice(0, 48)}\`)`;
  }
  return "";
}

function commitNext(opts: {
  kind: CommitKind;
  stagedOnly: boolean;
  stale: boolean;
  missingVerify: boolean;
}): string[] {
  const doKey = opts.stagedOnly ? "/commit staged do" : "/commit do";
  if (opts.kind === "empty") return ["/diff", "/status"];
  if (opts.kind === "norepo") return ["/status"];
  if (opts.kind === "plan") return ["/build", "/commit"];
  if (opts.kind === "fail") return [doKey, "/diff"];
  if (opts.kind === "ok") return ["/last", "/diff"];
  const next: string[] = [];
  if (opts.stale || opts.missingVerify) next.push("/verify");
  next.push(doKey);
  if (!opts.stagedOnly && opts.kind === "peek") next.push("/diff");
  return next;
}

export function runCommit(opts: {
  session: SessionData;
  config: Pick<ForgeConfig, "workspace" | "permissionMode">;
  doCommit?: boolean;
  stagedOnly?: boolean;
  color?: boolean;
  columns?: number;
}): { output: string; failed: boolean; sha?: string } {
  const cwd =
    opts.config.workspace || opts.session.meta.cwd || process.cwd();
  const stagedOnly = Boolean(opts.stagedOnly);
  const doCommit = Boolean(opts.doCommit);
  const color = opts.color;
  const columns = opts.columns;
  const stale = Boolean(staleVerifyNote(opts.session));
  const missingVerify =
    (opts.session.meta.editCount || 0) > 0 &&
    !opts.session.meta.lastVerificationCommand?.trim();

  if (doCommit && opts.config.permissionMode === "plan") {
    return {
      output: formatCommitCard({
        kind: "plan",
        note: "Plan mode cannot create commits (bash/git denied).",
        next: commitNext({
          kind: "plan",
          stagedOnly,
          stale,
          missingVerify,
        }),
        color,
        columns,
      }),
      failed: true,
    };
  }

  const tree = inspectCommitTree(cwd, stagedOnly);
  if (!tree.root) {
    return {
      output: formatCommitCard({
        kind: "norepo",
        note: `${path.resolve(cwd)} — initialize a work tree first.`,
        next: commitNext({
          kind: "norepo",
          stagedOnly,
          stale,
          missingVerify,
        }),
        color,
        columns,
      }),
      failed: true,
    };
  }

  if (tree.error) {
    return {
      output: formatCommitCard({
        kind: "fail",
        note: tree.error,
        next: commitNext({
          kind: "fail",
          stagedOnly,
          stale,
          missingVerify,
        }),
        color,
        columns,
      }),
      failed: true,
    };
  }

  if (tree.unmerged.length) {
    return {
      output: formatCommitCard({
        kind: doCommit ? "fail" : "peek",
        files: [...tree.unmerged, ...tree.files],
        skipped: tree.skipped,
        note: "Unmerged paths — resolve conflicts first.",
        next: ["/diff"],
        color,
        columns,
      }),
      failed: doCommit,
    };
  }

  if (!tree.files.length) {
    const note = stagedOnly
      ? tree.skipped.length
        ? "Nothing staged (secrets skipped). /commit without staged."
        : "Nothing staged. /commit without staged, or stage files first."
      : tree.skipped.length
        ? "Only skipped paths remain (secrets / fixtures)."
        : "Working tree clean.";
    return {
      output: formatCommitCard({
        kind: "empty",
        note,
        skipped: tree.skipped,
        next: commitNext({
          kind: "empty",
          stagedOnly,
          stale,
          missingVerify,
        }),
        color,
        columns,
      }),
      failed: false,
    };
  }

  const subject = draftCommitSubject({
    title: opts.session.meta.title,
    files: tree.files,
  });
  const staleNote = staleVerifyNote(opts.session);

  if (!doCommit) {
    return {
      output: formatCommitCard({
        kind: "peek",
        subject,
        files: tree.files,
        skipped: tree.skipped,
        note: staleNote || undefined,
        next: commitNext({
          kind: "peek",
          stagedOnly,
          stale,
          missingVerify,
        }),
        color,
        columns,
      }),
      failed: false,
    };
  }

  const created = createSessionCommit({
    cwd,
    stagedOnly,
    title: opts.session.meta.title,
    lastVerificationCommand: opts.session.meta.lastVerificationCommand,
  });
  if (!created.ok) {
    return {
      output: formatCommitCard({
        kind: "fail",
        subject: created.subject || subject,
        files: created.files,
        skipped: created.skipped,
        note: created.error || "git commit failed",
        next: commitNext({
          kind: "fail",
          stagedOnly,
          stale,
          missingVerify,
        }),
        color,
        columns,
      }),
      failed: true,
    };
  }
  return {
    output: formatCommitCard({
      kind: "ok",
      sha: created.sha,
      subject: created.subject || subject,
      files: created.files,
      skipped: created.skipped,
      note: staleNote || undefined,
      next: commitNext({
        kind: "ok",
        stagedOnly,
        stale,
        missingVerify,
      }),
      color,
      columns,
    }),
    failed: false,
    sha: created.sha,
  };
}
