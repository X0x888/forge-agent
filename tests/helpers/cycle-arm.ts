/**
 * Arm the plan-cycle driver with a plan already admitted, for tests that
 * exercise EXECUTE / REVIEW / COMMIT without running a Planner.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  armCycle,
  loadCycleState,
  saveCycleState,
  type CyclePlanItem,
  type CycleState,
} from "../../src/harness/cycle/index.js";

export function mkGitRepo(prefix = "forge-cycle-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: dir,
  });
  return dir;
}

/**
 * A fixture that arms the driver must own its git root. `TMPDIR` sits inside
 * this repo during `npm test`, `git rev-parse` walks up, and a cycle that
 * closes in a bare temp dir would commit the developer's working tree (it
 * did once: `ulw cycle 1: test plan`). Make the fixture dir a real repo, and
 * never arm on this repository itself.
 */
function ensureFixtureGitRoot(cwd: string): void {
  const abs = path.resolve(cwd);
  if (abs === path.resolve(process.cwd())) {
    throw new Error("armWithPlan: refusing to arm the driver on this repository itself");
  }
  if (fs.existsSync(path.join(abs, ".git"))) return;
  fs.mkdirSync(abs, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: abs });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "fixture"], {
    cwd: abs,
  });
}

export function armWithPlan(opts: {
  sessionId: string;
  cwd: string;
  mandate?: string | null;
  items?: Array<Partial<CyclePlanItem> & { title: string }>;
  verifyCommand?: string;
  maxCycles?: number | null;
}): CycleState {
  ensureFixtureGitRoot(opts.cwd);
  const s = armCycle({
    sessionId: opts.sessionId,
    mandate: opts.mandate ?? "add a widget",
    cwd: opts.cwd,
    maxCycles: opts.maxCycles ?? null,
  });
  s.cycle = 1;
  s.phase = "execute";
  s.planTitle = "test plan";
  s.items = (opts.items ?? [{ title: "ship the widget" }]).map((i, n) => ({
    id: i.id ?? `i${n + 1}`,
    title: i.title,
    files: i.files ?? [],
    proof: i.proof,
    status: i.status ?? "open",
  }));
  s.verifyCommand = opts.verifyCommand;
  s.cycles.push({
    n: 1,
    title: "test plan",
    startedAt: new Date().toISOString(),
    itemsTotal: s.items.length,
    itemsDone: 0,
    waves: 0,
    mustFix: [],
    verifyCommand: opts.verifyCommand,
  });
  saveCycleState(s);
  return loadCycleState(opts.sessionId)!;
}
