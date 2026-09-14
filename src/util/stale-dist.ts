import fs from "node:fs";
import path from "node:path";

/**
 * PATH `forge` is dist/cli.js. tsx / `src/cli.ts` already run this tree.
 */
export function detectRunningFromDist(argv: string[] = process.argv): boolean {
  return argv.some((a) => /(?:^|[/\\])dist[/\\]cli\.js$/i.test(a));
}

/** Package root that owns the running `dist/cli.js` (or `src/cli.ts`). */
export function checkoutRootFromArgv(argv: string[] = process.argv): string | null {
  const entry = argv.find(
    (a) =>
      /(?:^|[/\\])dist[/\\]cli\.js$/i.test(a) ||
      /(?:^|[/\\])src[/\\]cli\.ts$/i.test(a),
  );
  if (!entry) return null;
  return path.resolve(path.dirname(entry), "..");
}

export function isStaleDistBinary(input: {
  runningFromDist: boolean;
  distMtimeMs: number | null;
  srcMtimeMs: number | null;
}): boolean {
  if (!input.runningFromDist) return false;
  if (input.distMtimeMs == null || input.srcMtimeMs == null) return false;
  return input.distMtimeMs < input.srcMtimeMs;
}

export function readDistSrcMtimes(
  root: string,
  statSync: (p: string) => { mtimeMs: number } = (p) => fs.statSync(p),
): { distMtimeMs: number | null; srcMtimeMs: number | null } {
  const mtime = (p: string): number | null => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  return {
    distMtimeMs: mtime(path.join(root, "dist", "cli.js")),
    srcMtimeMs: mtime(path.join(root, "src", "cli.ts")),
  };
}

/** Hygiene rec for doctor: dist lags src while PATH is the built binary. */
export function assessStaleDist(opts?: {
  argv?: string[];
  root?: string;
  distMtimeMs?: number | null;
  srcMtimeMs?: number | null;
  statSync?: (p: string) => { mtimeMs: number };
}): {
  stale: boolean;
  runningFromDist: boolean;
} {
  const argv = opts?.argv ?? process.argv;
  const runningFromDist = detectRunningFromDist(argv);
  if (!runningFromDist) {
    return { stale: false, runningFromDist: false };
  }
  const root = opts?.root ?? checkoutRootFromArgv(argv);
  if (!root) {
    return { stale: false, runningFromDist: true };
  }
  const times =
    opts?.distMtimeMs !== undefined || opts?.srcMtimeMs !== undefined
      ? {
          distMtimeMs: opts.distMtimeMs ?? null,
          srcMtimeMs: opts.srcMtimeMs ?? null,
        }
      : readDistSrcMtimes(root, opts?.statSync);
  return {
    runningFromDist: true,
    stale: isStaleDistBinary({ runningFromDist: true, ...times }),
  };
}
