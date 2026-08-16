/**
 * `/diff` change-review card — the post-turn "ship / steer / undo" surface.
 *
 * Porcelain + --stat in, scannable card out. `--full` reuses formatDiffBlock
 * so the review patch matches the transcript palette. Pure: no git.
 */
import chalk from "chalk";
import { parsePorcelainPath } from "../agent/worktree.js";
import { clipAnsi, formatDiffBlock, visibleWidth } from "../util/format.js";

export interface DiffReviewVerification {
  command?: string;
  ok?: boolean;
  stale?: boolean;
}

export interface DiffReviewInput {
  porcelain: string;
  stat: string;
  patch?: string;
  wantPatch: boolean;
  filterNote?: string;
  checkCommands?: string[];
  lastVerification?: DiffReviewVerification;
  columns?: number;
}

export type DiffStatusLetter = "M" | "A" | "D" | "R" | "C" | "U" | "?" | "T";

export interface DiffReviewFile {
  path: string;
  letter: DiffStatusLetter;
  added?: number;
  removed?: number;
  binary?: boolean;
  untracked?: boolean;
}

/** XY columns from one `git status --porcelain=v1` line. */
export function porcelainLetter(xy: string): DiffStatusLetter {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "U" || y === "U" || xy === "AA" || xy === "DD") return "U";
  if (x === "R" || y === "R") return "R";
  if (x === "C" || y === "C") return "C";
  if (x === "D" || y === "D") return "D";
  if (x === "?" || y === "?") return "?";
  if (x === "A" || y === "A") return "A";
  if (x === "T" || y === "T") return "T";
  return "M";
}

export function parsePorcelainFiles(porcelain: string): DiffReviewFile[] {
  const out: DiffReviewFile[] = [];
  for (const raw of porcelain.replace(/\r\n/g, "\n").split("\n")) {
    if (!raw) continue;
    const path = parsePorcelainPath(raw);
    if (!path) continue;
    const xy = raw.length >= 2 ? raw.slice(0, 2) : " M";
    const letter = porcelainLetter(xy);
    out.push({
      path,
      letter,
      untracked: letter === "?",
    });
  }
  return out;
}

export function parseGitStat(stat: string): {
  files: Map<string, { added: number; removed: number; binary?: boolean }>;
  insertions: number;
  deletions: number;
  fileCount: number;
} {
  const files = new Map<
    string,
    { added: number; removed: number; binary?: boolean }
  >();
  let insertions = 0;
  let deletions = 0;
  let fileCount = 0;
  for (const raw of stat.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (!line.trim()) continue;
    const summary = line
      .trim()
      .match(
        /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/u,
      );
    if (summary) {
      fileCount = Number(summary[1]) || 0;
      insertions = Number(summary[2] || 0);
      deletions = Number(summary[3] || 0);
      continue;
    }
    const piped = line.match(/^\s*(.+?)\s+\|\s+(.*)$/u);
    if (piped) {
      const p = piped[1]!.replace(/^"|"$/g, "").trim();
      const rest = piped[2]!.trim();
      if (/^Bin\b/i.test(rest)) {
        files.set(p, { added: 0, removed: 0, binary: true });
        continue;
      }
      const bars = rest.match(/^(\d+)\s*([+-]*)/u);
      if (bars) {
        const plus = (bars[2]!.match(/\+/g) ?? []).length;
        const minus = (bars[2]!.match(/-/g) ?? []).length;
        files.set(p, { added: plus, removed: minus });
        continue;
      }
      files.set(p, { added: 0, removed: 0 });
      continue;
    }
    // `--name-only` style leftover: a bare path
    const bare = line.trim();
    if (bare && !bare.includes("|") && !/^\d+ files? changed/.test(bare)) {
      files.set(bare.replace(/^"|"$/g, ""), { added: 0, removed: 0 });
    }
  }
  if (!fileCount) fileCount = files.size;
  if (!insertions && !deletions) {
    for (const f of files.values()) {
      insertions += f.added;
      deletions += f.removed;
    }
  }
  return { files, insertions, deletions, fileCount };
}

function paintLetter(letter: DiffStatusLetter): string {
  switch (letter) {
    case "A":
    case "?":
      return chalk.green(letter);
    case "D":
      return chalk.red(letter);
    case "R":
    case "C":
      return chalk.cyan(letter);
    case "U":
      return chalk.magenta(letter);
    default:
      return chalk.yellow(letter);
  }
}

function mergeFiles(
  porcelain: DiffReviewFile[],
  stat: ReturnType<typeof parseGitStat>,
): DiffReviewFile[] {
  const byPath = new Map<string, DiffReviewFile>();
  for (const f of porcelain) byPath.set(f.path, { ...f });
  for (const [p, counts] of stat.files) {
    const prev = byPath.get(p);
    if (prev) {
      prev.added = counts.added;
      prev.removed = counts.removed;
      prev.binary = counts.binary;
    } else {
      byPath.set(p, {
        path: p,
        letter: "M",
        added: counts.added,
        removed: counts.removed,
        binary: counts.binary,
      });
    }
  }
  const ordered: DiffReviewFile[] = [];
  const seen = new Set<string>();
  for (const f of porcelain) {
    const hit = byPath.get(f.path);
    if (hit) {
      ordered.push(hit);
      seen.add(f.path);
    }
  }
  for (const [p, f] of byPath) {
    if (!seen.has(p)) ordered.push(f);
  }
  return ordered;
}

function countsBit(added?: number, removed?: number, binary?: boolean): string {
  if (binary) return "bin";
  const a = added ?? 0;
  const r = removed ?? 0;
  if (a === 0 && r === 0) return "";
  const bits: string[] = [];
  if (a > 0) bits.push(chalk.green(`+${a}`));
  if (r > 0) bits.push(chalk.red(`−${r}`));
  return bits.join(" ");
}

function verifyLine(
  input: DiffReviewInput,
  dirty: boolean,
): { text: string; callout: boolean } | null {
  const last = input.lastVerification?.command?.trim();
  const checks = (input.checkCommands ?? []).map((c) => c.trim()).filter(Boolean);
  if (last) {
    const stale = Boolean(input.lastVerification?.stale);
    const red = input.lastVerification?.ok === false;
    const mark = stale
      ? " (stale — predates last edit)"
      : red
        ? " ✗"
        : " ✓";
    return {
      text: `  verify: ${last}${mark}`,
      callout: stale || red,
    };
  }
  if (checks.length) {
    return {
      text: `  verify: ${checks.slice(0, 3).join(" · ")}`,
      callout: dirty,
    };
  }
  if (dirty) {
    return { text: "  verify: none — edits unverified", callout: true };
  }
  return null;
}

/**
 * Scannable `/diff` card. Clean tree is a designed empty state, not
 * `status: clean`.
 */
export function formatDiffReviewCard(input: DiffReviewInput): string {
  const cols = Math.max(
    24,
    input.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  const clip = (s: string): string =>
    visibleWidth(s) > cols ? clipAnsi(s, cols) : s;

  const porcelain = parsePorcelainFiles(input.porcelain);
  const stat = parseGitStat(input.stat);
  const files = mergeFiles(porcelain, stat);
  const dirty = files.length > 0;
  const filter = input.filterNote?.trim();

  const lines: string[] = [];
  if (!dirty) {
    lines.push(clip("Nothing to review — tree clean"));
  } else {
    const n = files.length;
    const fileWord = n === 1 ? "file" : "files";
    const plus = stat.insertions;
    const minus = stat.deletions;
    const counts =
      plus || minus
        ? `  ·  ${chalk.green(`+${plus}`)} ${chalk.red(`−${minus}`)}`
        : "";
    const vs = filter ? `  ·  ${filter}` : "";
    lines.push(clip(`Δ ${n} ${fileWord}${counts}${vs}`));

    const shown = files.slice(0, 16);
    const pathBudget = Math.max(12, cols - 18);
    for (const f of shown) {
      const letter = paintLetter(f.letter);
      const countsStr = f.untracked
        ? chalk.dim("new")
        : countsBit(f.added, f.removed, f.binary);
      const path =
        f.path.length > pathBudget
          ? `…${f.path.slice(-(pathBudget - 1))}`
          : f.path;
      const row = countsStr
        ? `  ${letter}  ${path}  ${countsStr}`
        : `  ${letter}  ${path}`;
      lines.push(clip(row));
    }
    if (files.length > shown.length) {
      lines.push(clip(chalk.dim(`  +${files.length - shown.length} more`)));
    }
  }

  const verify = verifyLine(input, dirty);
  if (verify) {
    lines.push(
      clip(verify.callout ? chalk.yellow(verify.text) : chalk.dim(verify.text)),
    );
  }

  if (dirty && !input.wantPatch) {
    lines.push(clip(chalk.dim("  ↳ /diff --full  ·  /commit  ·  /undo")));
  } else if (!dirty) {
    lines.push(clip(chalk.dim("  ↳ /last  ·  /commit when dirty")));
  }

  if (input.wantPatch) {
    const patch = (input.patch ?? "").trimEnd();
    if (patch.trim()) {
      lines.push("");
      lines.push(formatDiffBlock(patch, { maxLines: 120, indent: "  " }));
    }
  }

  return lines.join("\n");
}
