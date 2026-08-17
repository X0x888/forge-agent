/**
 * Tests-without-body — maze max20 wave 1 stamped `Wave shipped` on a
 * red `carriedGifts.test.ts` (proof=✗) before the engine wire existed.
 * That moved `w` and shoved the real ship into wave 2 with a lying subject.
 *
 * A declared ship that is only test / lockfile edits and is not proven
 * does not increment `w`. Wire the body, then close.
 */

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_RE = /(?:^|\/)(?:__tests__|tests?)\//;
const HARNESS_BASENAME_RE =
  /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i;

const REDGREEN_CLOSER_RE =
  /forge-redgreen|writing tests?.{0,80}first|tests? first,? then (?:wiring|the body)|red[- ]?green|test-first, then/i;

export function isTestOrHarnessPath(p: string): boolean {
  const n = (p || "").replace(/\\/g, "/");
  if (!n.trim()) return false;
  const base = n.split("/").pop() || "";
  if (TEST_FILE_RE.test(base)) return true;
  if (TEST_DIR_RE.test(n)) return true;
  return HARNESS_BASENAME_RE.test(base);
}

export function isTestsWithoutBodyCloser(text: string): boolean {
  return REDGREEN_CLOSER_RE.test(text || "");
}

export function isTestsWithoutBodyShip(opts: {
  proof: boolean;
  paths?: string[];
  closer?: string;
}): boolean {
  if (opts.proof) return false;
  const paths = (opts.paths || [])
    .map((p) => p.replace(/\\/g, "/").trim())
    .filter(Boolean);
  if (paths.length > 0 && paths.every((p) => isTestOrHarnessPath(p))) {
    return true;
  }
  return isTestsWithoutBodyCloser(opts.closer || "");
}

export const TESTS_WITHOUT_BODY_ADMIT = [
  "[Forge harness — mid-conversation update]",
  "Wave shipped on tests-without-body (proof ✗) does not increment w.",
  "Wire the production body, run a check that can fail, then close.",
  "This w=N/M is the only wave number. Do not invent Wave K.",
].join("\n");
