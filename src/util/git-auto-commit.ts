/**
 * Local git commits during unattended ULW (wave close + Cycle complete).
 * Never pushes. Kill-switch: FORGE_ULW_AUTO_COMMIT=0.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isFalsy } from "./bool.js";
import { forgeHome, nowIso } from "./fs.js";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { findGitRoot, parsePorcelainPath } from "../agent/worktree.js";
import { activeMemoryRecords } from "../harness/decision-memory.js";
import {
  displayUlwMandate,
  formatWaveLedger,
  isPlaceholderMandate,
  loadUlwCycle,
  noteUlwTreeAfterAutoCommit,
  type UlwCycleState,
} from "../harness/ulw-cycle.js";
import { waveMovedJob } from "../harness/ulw-job-card.js";
import { isTestOrHarnessPath } from "../harness/tests-without-body.js";
import { isSlashPeekMillShip } from "../harness/same-surface.js";
import {
  extractShipSummary,
  pickShipHint,
} from "../harness/ship-close.js";
import { findUnreferencedAssets } from "../harness/tree-shape.js";

const SENSITIVE_RE =
  /(^|\/)(\.env(\..+)?|.*\.(pem|p12|pfx|key)|id_rsa|id_ed25519|id_dsa|auth\.json|credentials|secrets?\.json)$/i;

/**
 * A look: an image or HTML file whose name or directory says "screenshot".
 * HashPet's run committed 78 of these (968 KB) under `images/`, none of
 * them loaded by the extension — the play-loop asked for a look, the model
 * wrote the look into the repo, auto-commit staged everything dirty. A
 * sprite the manifest names is a product file and stays; a look nothing
 * references is left unstaged and named in the wave admit.
 */
const LOOK_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|html?)$/i;
const LOOK_NAME_RE =
  /(^|[-_.])(look|looks|screenshot|screenshots|shot|shots|capture|captures|preview|previews|states?|frame\d*|before|after|snap|snapshot)([-_.]|$)/i;
const LOOK_DIR_RE = /(^|\/)(images|img|screenshots|shots|looks|captures|previews|snapshots)\//i;

export function isLookArtefactRelPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  if (!LOOK_EXT_RE.test(n)) return false;
  const base = n.split("/").pop() || "";
  return LOOK_NAME_RE.test(base.replace(/\.[^.]+$/, "")) || LOOK_DIR_RE.test(n);
}

/**
 * The project's `.forge/` holds the tracked memory mirror, commands, skills
 * and hooks. Anything else under it — a Chromium profile the model pointed
 * `--user-data-dir` at, a scratch dir — is not a ship (HashPet's `.forge/`
 * carried 19 `chrome-look*` profiles, 36 MB).
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

/** Fallback only when the repo/user has no commit identity (maze dogfood). */
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
  // leading space is a status column. Trimming it made slice(3) drop `s`
  // (`src/…` → `rc/…`) so the first dirty file failed `git add` and the
  // whole Cycle-complete commit was skipped.
  return raw.trimEnd();
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
  // -uall: a new directory is `?? src/ui.ts`, not `?? src/` (which cannot
  // match a journaled file and skipped the whole Cycle-complete commit).
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

/** Consolidation theater — do not mint a commit for CHANGELOG alone. */
export function isChangelogRelPath(rel: string): boolean {
  const base = rel.replace(/\\/g, "/").split("/").pop() || "";
  return /^changelog(\.(md|markdown|txt|rst))?$/i.test(base);
}

/**
 * Worktree-land tests write disposable files under `src/agent/__wt_land_*`
 * so `git status -uall` can see them. They are not product files — ULW
 * auto-commit must not snapshot them (Cursor dogfood shipped five of these
 * as "Acting on the ULW re-anchor").
 */
export function isDisposableTestRelPath(rel: string): boolean {
  const base = rel.replace(/\\/g, "/").split("/").pop() || "";
  return base.startsWith("__wt_land_");
}

function isReanchorCommitHint(text: string | undefined): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return (
    /\bActing on the ULW re-anchor\b/i.test(t) ||
    /\bStop blocked\b/i.test(t) ||
    /\bDo not stop\. Do not ask permission\b/i.test(t) ||
    /^\[Forge ULW cycle driver\]/i.test(t)
  );
}

export function buildAutoCommitSubject(mandate: string, hint?: string): string {
  const fromShip = hint ? extractShipSummary(hint) : undefined;
  let t = (fromShip || hint || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^["']|["']$/g, "");
  t = t.replace(/^\*{0,2}Reading:\*{0,2}\s*/i, "");
  t = t.replace(/^Correction:\s*/i, "");
  t = t.replace(/^\*{0,2}Cycle complete\.?\*{0,2}\s*/i, "");
  t = t.replace(/\*{1,2}/g, "").replace(/\s+/g, " ").trim();
  // The model's own wave count drifts from the harness's (HashPet subjects
  // said "Wave 160 — Consolidation" while the body said "Wave 791."). The
  // body carries the harness number; the subject carries the ship.
  t = t.replace(/^Wave\s+\d+\s*(?:[—–-]+|:)\s*/i, "").trim();
  if (isReanchorCommitHint(t)) t = "";
  // "Cycle complete.\n✅ npm test — green" is not a ship body.
  if (/^[✅✗]/.test(t) || /^Proof:/i.test(t)) t = "";
  // Mandate is last resort — a packed "Cycle complete" wave used to commit
  // the raw user prompt ("comprehensively evaulate this tool…").
  if (t.length < 12) {
    t = (mandate || "").replace(/\s+/g, " ").trim();
  }
  if (t.length > 68) t = `${t.slice(0, 67)}…`;
  return t || "ULW cycle complete";
}

function shipHint(sessionId: string): string | undefined {
  try {
    const ulw = loadUlwCycle(sessionId);
    const waves = ulw?.waves ?? [];
    const last = waves.length ? waves[waves.length - 1] : undefined;
    const prev = waves.length > 1 ? waves[waves.length - 2] : undefined;
    return pickShipHint({
      records: activeMemoryRecords(sessionId),
      prevWaveTs: prev?.ts,
      lastWaveSummary: last?.summary,
    });
  } catch {
    /* */
  }
  return undefined;
}

export function buildAutoCommitBody(
  ulw: Pick<UlwCycleState, "wave" | "maxWaves" | "mandate" | "waves"> | null,
  files: string[],
): string {
  const lines: string[] = [
    "Unattended ULW snapshot — local commit only (never pushed).",
  ];
  if (ulw) {
    const cap =
      ulw.maxWaves != null && ulw.maxWaves > 0 ? `/${ulw.maxWaves}` : "";
    lines.push(`Wave ${ulw.wave}${cap}.`);
    if (ulw.mandate) {
      lines.push(`Mandate: ${displayUlwMandate(ulw.mandate).slice(0, 240)}`);
    }
    const ledger = formatWaveLedger(ulw.waves, 8);
    if (ledger) lines.push(`Waves: ${ledger}`);
  }
  if (files.length) {
    lines.push(`Files: ${files.slice(0, 20).join(", ")}`);
    if (files.length > 20) lines.push(`… +${files.length - 20} more`);
  }
  return lines.join("\n");
}

/**
 * Commit the current dirty tree (minus secrets). Call at each wave close
 * and on Cycle complete so a 5-hour unattended run does not pile one
 * giant uncommitted chunk. Never pushes.
 */
export function maybeAutoCommitOnUlwDone(opts: {
  cwd: string;
  sessionId: string;
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

  let toAdd = dirty.filter(
    (p) =>
      !isSensitiveRelPath(p) &&
      !isDisposableTestRelPath(p) &&
      !isForgeScratchRelPath(p),
  );
  // Looks nothing references stay out of the commit. One `git grep` per
  // candidate, capped inside findUnreferencedAssets.
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

  const ulw = loadUlwCycle(opts.sessionId);
  if (ulw && isPlaceholderMandate(ulw.mandate)) {
    return { committed: false, skipped: "pending work-order" };
  }
  if (ulw?.lastReflect === "score") {
    return { committed: false, skipped: "LAST reflect score (read-only)" };
  }
  if (
    ulw?.lastReflect === "closeout" &&
    toAdd.every((p) => isTestOrHarnessPath(p) || isChangelogRelPath(p))
  ) {
    return { committed: false, skipped: "LAST close-out tests-only" };
  }
  const lastWave = ulw?.waves?.length
    ? ulw.waves[ulw.waves.length - 1]
    : undefined;
  if (lastWave && (lastWave.editDelta ?? 0) <= 0) {
    return { committed: false, skipped: "zero-edit wave" };
  }
  if (
    lastWave &&
    (lastWave.millClass || lastWave.siblingMill) &&
    !waveMovedJob(lastWave)
  ) {
    return { committed: false, skipped: "mill ship (not a job move)" };
  }
  if (
    lastWave &&
    isSlashPeekMillShip(lastWave.summary || lastWave.classText || "") &&
    (ulw?.peekMillStreak ?? 0) >= 2
  ) {
    return { committed: false, skipped: "slash-peek mill" };
  }
  if (
    lastWave?.chrome &&
    toAdd.every((p) => isTestOrHarnessPath(p) || isChangelogRelPath(p))
  ) {
    return { committed: false, skipped: "chrome/tests-without-body" };
  }
  const hint = shipHint(opts.sessionId);
  if (isReanchorCommitHint(hint)) {
    return { committed: false, skipped: "re-anchor is not a ship" };
  }
  const subject = buildAutoCommitSubject(
    ulw ? displayUlwMandate(ulw.mandate) : "ULW cycle complete",
    hint,
  );
  if (isReanchorCommitHint(subject)) {
    return { committed: false, skipped: "re-anchor is not a ship" };
  }
  const body = buildAutoCommitBody(ulw, staged);
  try {
    // Fallback author when the machine has no user.name/email (maze: 43
    // waves staged, every commit skipped with "Author identity unknown").
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
  try {
    noteUlwTreeAfterAutoCommit(opts.sessionId, root);
  } catch {
    /* fingerprint reset is best-effort */
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
