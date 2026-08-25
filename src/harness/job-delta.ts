/**
 * Job-delta credit — maze unlimited dogfood (494926dd, 813 waves).
 *
 * Soft prompts are a job and unlimited ULW is the loop. The mill still
 * got paid: `Wave shipped` + a green pin test moved `w` while the wish
 * did not. Credit is computed from the tree and the tests, not from the
 * closer's poetry.
 */
import fs from "node:fs";
import path from "node:path";
import { isTestOrHarnessPath } from "./tests-without-body.js";

const PIN_API_RE =
  /\bpinPresent\s*\(|\bpinAbsent\s*\(|\breadSrc\s*\(|\breadSrcMany\s*\(/;
const RAW_READ_RE = /\breadFileSync\s*\(/;
const PROD_IMPORT_RE = /from\s+['"](?:\.\.\/)+src\//;
const ASSERT_RE =
  /\bassert\.(?:equal|deepEqual|strictEqual|notEqual|ok|match|doesNotMatch)\s*\(/;

/** Second consecutive css/md/test-only ship does not increment w. */
export const CHROME_PATH_HOLD = 1;

export const PIN_ONLY_ADMIT = [
  "[Forge harness — mid-conversation update]",
  "Wave shipped on pin-only tests does not increment w.",
  "pinPresent / readSrc / raw readFileSync pins are not proof. Assert a production function's return, or run a play-loop.",
  "Unlimited ULW continues. This w=N/M is the only wave number.",
].join("\n");

export const JOB_FLAT_ADMIT = [
  "[Forge harness — mid-conversation update]",
  "Wave shipped on chrome-only paths (css / markdown / tests) does not increment w after the first of that class.",
  "Batch a production play-path, architecture, or play-loop so the job moves. Unlimited ULW continues.",
  "This w=N/M is the only wave number.",
].join("\n");

export const REORIENT_EVIDENCE_ADMIT = [
  "[Forge ULW cycle driver] Stop blocked — PLAN is re-armed and a new Reading is not a ticket.",
  "Named-ship exhaust / same-surface hold requires a real look: one explore child (parseable map) or a play-loop.",
  "Then write the Reading. A new noun is not a new class. A red test suite or open defect is a different class.",
  "Unlimited ULW continues. Or /cycle 0.",
].join("\n");

export type WaveTestProofKind = "behavioral" | "pin-only" | "none";

export type StampJobDecision =
  | { ok: true; chrome: boolean }
  | { ok: false; reason: "pin" | "chrome"; admit: string };

/** True when the file's contract is source-text pins, not a function return. */
export function isPinOnlyTestSource(src: string): boolean {
  const t = src || "";
  const hasPinApi = PIN_API_RE.test(t);
  const hasRawPin = RAW_READ_RE.test(t) && /\bassert\.match\b/.test(t);
  if (!hasPinApi && !hasRawPin) return false;
  if (!PROD_IMPORT_RE.test(t) || !ASSERT_RE.test(t)) return true;
  const stripped = t
    .replace(/pinPresent\s*\([\s\S]*?\)\s*;?/g, "")
    .replace(/pinAbsent\s*\([\s\S]*?\)\s*;?/g, "")
    .replace(/readSrc(?:Many)?\s*\([^)]*\)/g, "");
  return !(PROD_IMPORT_RE.test(stripped) && ASSERT_RE.test(stripped));
}

export function isBehavioralTestSource(src: string): boolean {
  const t = src || "";
  if (!PROD_IMPORT_RE.test(t) || !ASSERT_RE.test(t)) return false;
  return !isPinOnlyTestSource(t);
}

export function isChromeOnlyPath(p: string): boolean {
  const n = (p || "").replace(/\\/g, "/").trim();
  if (!n) return false;
  if (isTestOrHarnessPath(n)) return true;
  if (/\.(css|md)$/i.test(n)) return true;
  if (/(^|\/)CHANGELOG\.md$/i.test(n)) return true;
  if (/(^|\/)style\.css$/i.test(n)) return true;
  return false;
}

export function isChromeOnlyPaths(paths: string[]): boolean {
  const list = (paths || []).map((p) => p.replace(/\\/g, "/").trim()).filter(Boolean);
  if (!list.length) return false;
  return list.every(isChromeOnlyPath);
}

export function waveTestProofKind(opts: {
  cwd?: string;
  paths?: string[];
}): WaveTestProofKind {
  const tests = (opts.paths || [])
    .map((p) => p.replace(/\\/g, "/").trim())
    .filter((p) => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(p));
  if (!tests.length) return "none";
  if (!opts.cwd) return "none";
  let anyBeh = false;
  let anyPin = false;
  for (const rel of tests) {
    let src = "";
    try {
      src = fs.readFileSync(path.resolve(opts.cwd, rel), "utf8");
    } catch {
      continue;
    }
    if (isBehavioralTestSource(src)) anyBeh = true;
    else if (isPinOnlyTestSource(src)) anyPin = true;
  }
  if (anyBeh) return "behavioral";
  if (anyPin) return "pin-only";
  return "none";
}

/**
 * Should this declared ship increment `w`?
 * Empty paths (tests that omit cwd) do not refuse — unknown is not chrome.
 */
export function decideWaveJobCredit(opts: {
  paths?: string[];
  cwd?: string;
  pinTaint?: boolean;
  playLoop?: boolean;
  chromeStreak?: number;
}): StampJobDecision {
  if (opts.playLoop) return { ok: true, chrome: false };
  const paths = opts.paths || [];
  const kind = waveTestProofKind({ cwd: opts.cwd, paths });
  const pinBlocked =
    kind === "pin-only" ||
    (Boolean(opts.pinTaint) && kind !== "behavioral");
  if (pinBlocked) return { ok: false, reason: "pin", admit: PIN_ONLY_ADMIT };
  const chrome = isChromeOnlyPaths(paths);
  if (chrome && (opts.chromeStreak ?? 0) >= CHROME_PATH_HOLD) {
    return { ok: false, reason: "chrome", admit: JOB_FLAT_ADMIT };
  }
  return { ok: true, chrome };
}
