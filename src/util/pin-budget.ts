/**
 * Repo pin-budget law (maze AGENTS.md / tests/_meta/pin-budget.test.mjs).
 * New top-level tests that introduce raw readFileSync taint ULW proof.
 * Pin-only tests (pinPresent/readSrc, no production call) taint every repo —
 * maze 494926dd stamped 813 waves on regex pins that never called src/.
 */
import fs from "node:fs";
import path from "node:path";
import { loadUlwCycle, saveUlwCycle } from "../harness/ulw-cycle.js";
import { isPinOnlyTestSource } from "../harness/job-delta.js";
import type { SessionData } from "../session/session.js";

const RAW_PIN_RE = /\breadFileSync\b/;

export const RAW_PIN_WARNING =
  "Pin-budget: this test file now has raw readFileSync. " +
  "Route pins through tests/_helpers/pins.mjs or assert the function's return. " +
  "This wave cannot stamp w.";

export const PIN_ONLY_WARNING =
  "Pin-only test: source-text pins (pinPresent/readSrc/readFileSync) without a production assertion. " +
  "This wave cannot stamp w until a test calls src/ or a play-loop runs.";

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
 * If this write introduces a pin-only test (any repo) or a raw readFileSync
 * pin in a law repo, taint ULW proof and return a model-facing warning.
 */
export function applyRawPinSideEffects(opts: {
  cwd: string;
  absPath: string;
  before: string;
  after: string;
  sessionId?: string;
  session?: SessionData;
}): string | undefined {
  if (!isTopLevelTestFile(opts.absPath, opts.cwd)) return undefined;
  const pinOnly =
    isPinOnlyTestSource(opts.after || "") &&
    !isPinOnlyTestSource(opts.before || "");
  const rawLaw =
    pinBudgetLawPresent(opts.cwd) &&
    introducesRawReadFileSync(opts.before, opts.after);
  if (!pinOnly && !rawLaw) return undefined;
  noteRawPinProofTaint({
    sessionId: opts.sessionId,
    session: opts.session,
  });
  if (rawLaw) return RAW_PIN_WARNING;
  return PIN_ONLY_WARNING;
}

export function appendOutputWarning(
  output: string,
  warning: string | undefined,
): string {
  if (!warning) return output;
  return `${output.replace(/\s+$/, "")}\n\n${warning}`;
}
