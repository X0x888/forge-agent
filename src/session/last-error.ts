/**
 * lastError is a stop-reason bag: provider failures AND successful wraps.
 * Human cards (status / sessions / HUD ERR / prune) must not treat a
 * finished ULW cycle as a crash.
 *
 * Sit-down Next is a key you type at ›. CLI dumps (`forge accounts switch`)
 * become a model prompt — same hole `/verify` closed for `npm test`.
 */

/** Codes that mean the run ended as designed — keep on meta, not as lastErr. */
export const LAST_ERROR_OUTCOME_CODES = new Set(["ulw_cycle_complete"]);

export function isLastErrorProblem(
  err?: { code?: string; message?: string } | null,
): boolean {
  if (!err) return false;
  const code = String(err.code || "").trim();
  if (LAST_ERROR_OUTCOME_CODES.has(code)) return false;
  return Boolean(code || String(err.message || "").trim());
}

export type LastErrorCodeCount = { code: string; count: number };

/** Grouped lastError-problem counts — glance the class before the picker. */
export interface LastErrorTally {
  total: number;
  byCode: LastErrorCodeCount[];
}

/**
 * Count problem lastErrors by code (newest-unrelated; designed wraps omitted).
 * Used by doctor and `/sessions errors` so a max_turns backlog cannot hide 429s.
 */
export function tallyLastErrorProblems(
  sessions: ReadonlyArray<{
    lastError?: { code?: string; message?: string } | null;
  }>,
): LastErrorTally {
  const map = new Map<string, number>();
  let total = 0;
  for (const s of sessions) {
    if (!isLastErrorProblem(s.lastError)) continue;
    total += 1;
    const code = String(s.lastError?.code || "").trim() || "unknown";
    map.set(code, (map.get(code) || 0) + 1);
  }
  const byCode = [...map.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return { total, byCode };
}

export function lastErrorTallyRecord(
  tally: LastErrorTally,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of tally.byCode) out[row.code] = row.count;
  return out;
}

/** Compact `45 max_turns · 8 bad_request` line. Empty tally → `""`. */
export function formatLastErrorTally(
  tally: LastErrorTally,
  opts?: { maxCodes?: number },
): string {
  if (tally.total <= 0 || tally.byCode.length === 0) return "";
  const maxRaw = opts?.maxCodes;
  const max =
    typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.floor(maxRaw)
      : 8;
  const bits = tally.byCode.slice(0, max).map((r) => `${r.count} ${r.code}`);
  const rest = tally.byCode.slice(max).reduce((n, r) => n + r.count, 0);
  if (rest > 0) bits.push(`+${rest} other`);
  return bits.join(" · ");
}

/** Advice / CLI verbs that are not typeable at ›. */
const SIT_DOWN_ADVICE = new Set([
  "wait",
  "vendor console",
  "check network",
  "raise forge_max_run_ms",
  "raise max_turns",
  "narrow the task",
  "type to continue",
  "change approach",
  "rephrase",
]);

/** `forge <cmd>` → slash that exists in the REPL. */
const FORGE_CMD_TO_SLASH: Record<string, string> = {
  accounts: "/accounts",
  login: "/auth",
  auth: "/auth",
  doctor: "/doctor",
  models: "/model",
  model: "/model",
  status: "/status",
  retry: "/retry",
  budget: "/budget",
  compact: "/compact",
  sessions: "/sessions",
  run: "/retry",
};

const SLASH_ALIASES: Record<string, string> = {
  "/login": "/auth",
  "/models": "/model",
  "/hud": "/status",
  "/again": "/retry",
};

function normalizeFailureCode(code: string): string {
  const c = String(code || "").trim();
  if (c === "http_429") return "rate_limited";
  if (c === "http_401") return "auth_expired";
  if (c === "http_403") return "auth_forbidden";
  if (c === "http_402") return "quota_exhausted";
  if (c === "http_529") return "provider_overloaded";
  if (c === "http_408" || c === "http_504") return "timeout";
  if (c === "http_404") return "not_found";
  if (c.startsWith("continue_cap")) return "continue_cap";
  return c;
}

function normalizeSitDownSlash(cmd: string): string {
  const name = `/${String(cmd || "")
    .trim()
    .replace(/^\//, "")
    .toLowerCase()
    .split(/\s+/)[0] || ""}`;
  if (name === "/") return "";
  return SLASH_ALIASES[name] || name;
}

/**
 * Rewrite one recovery tip into a key you can type at ›.
 * Designed empty (advice / unknown CLI) → undefined — caller picks the next.
 */
export function sitDownKeyFromTip(raw?: string): string | undefined {
  const text = String(raw || "").trim();
  if (!text) return undefined;
  const lower = text.toLowerCase();
  if (SIT_DOWN_ADVICE.has(lower)) return undefined;

  const slash = text.match(/(?:^|[\s·]|→)(\/[A-Za-z][\w-]*)\b/);
  if (slash) {
    const key = normalizeSitDownSlash(slash[1] || "");
    return key || undefined;
  }

  const forge = text.match(/\bforge\s+([A-Za-z][\w-]*)\b/);
  if (forge) {
    const mapped = FORGE_CMD_TO_SLASH[String(forge[1] || "").toLowerCase()];
    if (mapped) return mapped;
  }

  return undefined;
}

/** Primary sit-down key from a lastError / provider failure code. */
export function sitDownKeyFromCode(code?: string): string | undefined {
  const c = normalizeFailureCode(String(code || "").trim());
  if (!c) return undefined;
  switch (c) {
    case "rate_limited":
    case "quota_exhausted":
    case "org_verification":
      return "/accounts";
    case "auth_expired":
    case "auth_forbidden":
      return "/auth";
    case "context_overflow":
    case "context_pressure":
      return "/compact";
    case "not_found":
    case "model_deprecated":
    case "unsupported_feature":
      return "/model";
    case "max_cost":
      return "/budget";
    case "empty_run":
      return "/doctor";
    default:
      return "/retry";
  }
}

/**
 * Map a bag of recovery keys (CLI + advice + slashes) onto › keys.
 * Drops advice. Dedupes. Does not invent `/retry` — caller decides fallback.
 */
export function sitDownKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const mapped =
      sitDownKeyFromTip(k) ||
      (String(k || "").trim().startsWith("/")
        ? normalizeSitDownSlash(k)
        : undefined);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Sit-down Next for lastErr — one typeable slash key.
 * No problem → undefined (designed empty: no lastErr Next).
 * Unknown code / unusable tips → `/retry`.
 */
export function sitDownNextForLastError(
  err?: { code?: string; message?: string; tips?: string[] } | null,
): string | undefined {
  if (!isLastErrorProblem(err)) return undefined;
  for (const tip of err?.tips || []) {
    const key = sitDownKeyFromTip(tip);
    if (key) return key;
  }
  return sitDownKeyFromCode(err?.code) || "/retry";
}

const RETRY_REFUSED_KEYS = new Set(["/accounts", "/auth", "/budget"]);

/**
 * `/retry` will not fix these lastErrs — name the key instead of
 * burning another 429 / 401 / cost-cap turn.
 */
export function retryRefusedNext(
  err?: { code?: string; message?: string } | null,
): string | undefined {
  if (!isLastErrorProblem(err)) return undefined;
  const key = sitDownKeyFromCode(err?.code);
  if (key && RETRY_REFUSED_KEYS.has(key)) return key;
  return undefined;
}
