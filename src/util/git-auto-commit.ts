/**
 * Local git commits during unattended ULW (wave close + Cycle complete).
 * Never pushes. Kill-switch: FORGE_ULW_AUTO_COMMIT=0.
 */
import { execFileSync } from "node:child_process";
import { isFalsy } from "./bool.js";
import { nowIso } from "./fs.js";
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

const SENSITIVE_RE =
  /(^|\/)(\.env(\..+)?|.*\.(pem|p12|pfx|key)|id_rsa|id_ed25519|id_dsa|auth\.json|credentials|secrets?\.json)$/i;

export interface AutoCommitResult {
  committed: boolean;
  sha?: string;
  subject?: string;
  files?: number;
  skipped?: string;
}

export function ulwAutoCommitEnabled(): boolean {
  return !isFalsy(process.env.FORGE_ULW_AUTO_COMMIT ?? "1");
}

function git(args: string[], cwd: string, timeoutMs = 30_000): string {
  const raw = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  // Do not trimStart: porcelain v1 unstaged-only is `" M path"` and the
  // leading space is a status column. Trimming it made slice(3) drop `s`
  // (`src/…` → `rc/…`) so the first dirty file failed `git add` and the
  // whole Cycle-complete commit was skipped.
  return raw.trimEnd();
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

export function buildAutoCommitSubject(mandate: string, hint?: string): string {
  let t = (hint || mandate || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^["']|["']$/g, "");
  t = t.replace(/^\*{0,2}Reading:\*{0,2}\s*/i, "");
  t = t.replace(/^Ship landed:\s*/i, "");
  t = t.replace(/^Correction:\s*/i, "");
  if (t.length > 68) t = `${t.slice(0, 67)}…`;
  return t || "ULW cycle complete";
}

function shipHint(sessionId: string): string | undefined {
  try {
    const recs = activeMemoryRecords(sessionId);
    const hit = [...recs]
      .reverse()
      .find(
        (r) =>
          r.source === "agent" &&
          (r.kind === "decision" || r.kind === "observation") &&
          /^(Ship landed|Ship:)|Wave \d+.*shipped/i.test(r.text),
      );
    return hit?.text;
  } catch {
    return undefined;
  }
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
      skipped: `status failed: ${String((err as Error).message || err).slice(0, 160)}`,
    };
  }
  if (!dirty.length) return { committed: false, skipped: "working tree clean" };

  const toAdd = dirty.filter((p) => !isSensitiveRelPath(p));
  if (!toAdd.length) {
    return {
      committed: false,
      skipped: "only sensitive paths remain",
    };
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
  const subject = buildAutoCommitSubject(
    ulw ? displayUlwMandate(ulw.mandate) : "ULW cycle complete",
    shipHint(opts.sessionId),
  );
  const body = buildAutoCommitBody(ulw, staged);
  try {
    git(["commit", "-m", subject, "-m", body], root, 60_000);
  } catch (err) {
    return {
      committed: false,
      skipped: `git commit failed: ${String((err as Error).message || err).slice(0, 200)}`,
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
  };
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
