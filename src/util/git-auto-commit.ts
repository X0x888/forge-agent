/**
 * Local auto-commit when an unattended ULW cycle actually finishes.
 * Never pushes. Kill-switch: FORGE_ULW_AUTO_COMMIT=0.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isFalsy } from "./bool.js";
import { nowIso } from "./fs.js";
import { findGitRoot, parsePorcelainPath } from "../agent/worktree.js";
import fs from "node:fs";
import { readFileMutations } from "../session/mutations.js";
import { activeMemoryRecords } from "../harness/decision-memory.js";
import {
  formatWaveLedger,
  loadUlwCycle,
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
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

export function porcelainPaths(cwd: string): string[] {
  const out = git(["status", "--porcelain"], cwd, 15_000);
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const p = parsePorcelainPath(line);
    if (p) paths.push(p);
  }
  return paths;
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
          /^(Ship landed|Ship:)/i.test(r.text),
      );
    return hit?.text;
  } catch {
    return undefined;
  }
}

function relKey(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  try {
    return path.relative(root, fs.realpathSync(abs)).replace(/\\/g, "/");
  } catch {
    return path.relative(root, path.resolve(root, p)).replace(/\\/g, "/");
  }
}

function matchJournalToDirty(
  journal: string[],
  dirty: string[],
  root: string,
): string[] {
  if (!journal.length) return dirty;
  const jKeys = new Set(journal.map((p) => relKey(root, p)));
  const jBases = journal.map((p) => path.basename(p));
  const out: string[] = [];
  for (const d of dirty) {
    const k = relKey(root, d);
    if (jKeys.has(k) || jKeys.has(d)) {
      out.push(d);
      continue;
    }
    const base = path.basename(d);
    if (
      jBases.includes(base) &&
      dirty.filter((x) => path.basename(x) === base).length === 1
    ) {
      out.push(d);
    }
  }
  return out;
}

export function buildAutoCommitBody(
  ulw: Pick<UlwCycleState, "wave" | "maxWaves" | "mandate" | "waves"> | null,
  files: string[],
): string {
  const lines: string[] = [
    "Unattended ULW finished — local commit only (never pushed).",
  ];
  if (ulw) {
    const cap =
      ulw.maxWaves != null && ulw.maxWaves > 0 ? `/${ulw.maxWaves}` : "";
    lines.push(`Cycle complete (wave ${ulw.wave}${cap}).`);
    if (ulw.mandate) lines.push(`Mandate: ${ulw.mandate.slice(0, 240)}`);
    const ledger = formatWaveLedger(ulw.waves, 8);
    if (ledger) lines.push(`Waves: ${ledger}`);
  }
  if (files.length) {
    lines.push(`Files: ${files.slice(0, 20).join(", ")}`);
    if (files.length > 20) lines.push(`… +${files.length - 20} more`);
  }
  return lines.join("\n");
}

function journalRelPaths(sessionId: string, root: string): string[] {
  const seen = new Set<string>();
  for (const m of readFileMutations(sessionId)) {
    const abs = path.resolve(m.path);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    seen.add(rel.replace(/\\/g, "/"));
  }
  return [...seen];
}

/**
 * Commit the ULW session's work after **Cycle complete.**
 * Prefers mutation-journal paths; falls back to the dirty tree when the
 * agent edited via bash. Skips secrets. Never push.
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

  const journal = journalRelPaths(opts.sessionId, root);
  const candidates = matchJournalToDirty(journal, dirty, root);
  const toAdd = candidates.filter((p) => !isSensitiveRelPath(p));
  if (!toAdd.length) {
    return {
      committed: false,
      skipped: candidates.length
        ? "only sensitive paths remain"
        : "no session files in the dirty tree",
    };
  }

  try {
    git(["add", "--", ...toAdd], root, 30_000);
  } catch (err) {
    return {
      committed: false,
      skipped: `git add failed: ${String((err as Error).message || err).slice(0, 160)}`,
    };
  }

  const ulw = loadUlwCycle(opts.sessionId);
  const subject = buildAutoCommitSubject(
    ulw?.mandate || "ULW cycle complete",
    shipHint(opts.sessionId),
  );
  const body = buildAutoCommitBody(ulw, toAdd);
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
  return {
    committed: true,
    sha: sha || undefined,
    subject,
    files: toAdd.length,
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
