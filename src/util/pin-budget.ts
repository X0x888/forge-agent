/**
 * Repo pin-budget law (maze AGENTS.md / tests/_meta/pin-budget.test.mjs).
 * New top-level tests that introduce raw readFileSync taint ULW proof.
 */
import fs from "node:fs";
import path from "node:path";
import { loadUlwCycle, saveUlwCycle } from "../harness/ulw-cycle.js";
import type { SessionData } from "../session/session.js";

const RAW_PIN_RE = /\breadFileSync\b/;

export const RAW_PIN_WARNING =
  "Pin-budget: this test file now has raw readFileSync. " +
  "Route pins through tests/_helpers/pins.mjs or assert the function's return. " +
  "This wave cannot stamp proof=true.";

export function pinBudgetLawPresent(cwd: string): boolean {
  if (!cwd) return false;
  try {
    return (
      fs.existsSync(path.join(cwd, "tests/_meta/pin-budget.test.mjs")) ||
      fs.existsSync(path.join(cwd, "tests/_helpers/pins.mjs"))
    );
  } catch {
    return false;
  }
}

export function isTopLevelTestFile(absPath: string, cwd: string): boolean {
  if (!absPath || !cwd) return false;
  let rel = absPath;
  try {
    rel = path.relative(cwd, absPath);
  } catch {
    /* use abs */
  }
  const n = rel.replace(/\\/g, "/");
  if (n.startsWith("tests/_")) return false;
  return /^tests\/[^/]+\.test\.(mjs|js|cjs|ts)$/.test(n);
}

export function introducesRawReadFileSync(
  before: string,
  after: string,
): boolean {
  return RAW_PIN_RE.test(after || "") && !RAW_PIN_RE.test(before || "");
}

/** Stamp ULW + session so the open wave cannot claim proof. */
export function noteRawPinProofTaint(opts: {
  sessionId?: string;
  session?: SessionData;
}): void {
  if (opts.session) {
    opts.session.meta.rawPinProofTaint = true;
  }
  const sid = opts.sessionId || opts.session?.meta.id;
  if (!sid) return;
  try {
    const s = loadUlwCycle(sid);
    if (!s?.enabled) return;
    s.rawPinProofTaint = true;
    saveUlwCycle(s);
  } catch {
    /* sidecar optional */
  }
}

/**
 * If this write introduces a raw pin in a repo that forbids it, taint proof
 * and return a model-facing warning. Otherwise undefined.
 */
export function applyRawPinSideEffects(opts: {
  cwd: string;
  absPath: string;
  before: string;
  after: string;
  sessionId?: string;
  session?: SessionData;
}): string | undefined {
  if (!pinBudgetLawPresent(opts.cwd)) return undefined;
  if (!isTopLevelTestFile(opts.absPath, opts.cwd)) return undefined;
  if (!introducesRawReadFileSync(opts.before, opts.after)) return undefined;
  noteRawPinProofTaint({
    sessionId: opts.sessionId,
    session: opts.session,
  });
  return RAW_PIN_WARNING;
}

export function appendOutputWarning(
  output: string,
  warning: string | undefined,
): string {
  if (!warning) return output;
  return `${output.replace(/\s+$/, "")}\n\n${warning}`;
}
