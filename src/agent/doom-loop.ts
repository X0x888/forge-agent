/**
 * Doom-loop detection (OpenCode-inspired), outcome-aware.
 *
 * Identical tool+args used to trip at N regardless of why. Success repeats
 * are thrash (trip at 2). MCP `partial` / connecting is waiting. Stubs are
 * "read the saved path", not re-call. get_task_output without wait is the
 * wrong tool. Error/timeout/empty still trip at the operator threshold.
 */
import { detectProjectIntel } from "../util/project-intel.js";
import { TOOL_CLEARED_MARKER } from "../session/tool-clearing.js";

export interface DoomLoopConfig {
  /** Consecutive identical tool fingerprints required to trip errors (default 3) */
  threshold?: number;
  /** Max fingerprints retained (default 12) */
  window?: number;
}

export type DoomOutcome =
  | "success"
  | "error"
  | "partial"
  | "stub"
  | "timeout"
  | "empty";

export type DoomHitKind = "doom" | "wait" | "stub" | "poll";

export interface DoomLoopHit {
  tool: string;
  fingerprint: string;
  count: number;
  message: string;
  kind: DoomHitKind;
}

type RecentEntry = {
  fp: string;
  outcome?: DoomOutcome;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Fingerprint a tool invocation for equality checks. */
export function toolFingerprint(
  name: string,
  input: Record<string, unknown>,
): string {
  // Drop noisy / non-semantic fields so retries that only flip transport knobs
  // (timeout, background, stream tail) still trip the doom-loop detector.
  const slim: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (
      k === "timeout_ms" ||
      k === "timeout" ||
      k === "raw" ||
      k === "background" ||
      k === "run_in_background" ||
      k === "stream" ||
      k === "tail" ||
      k === "allow_local"
    ) {
      continue;
    }
    slim[k] = v;
  }
  return `${name}::${stableStringify(slim)}`;
}

/** True when get_task_output is polling instead of wait=. Listing is not a poll. */
export function isTaskOutputPoll(
  name: string,
  input: Record<string, unknown>,
): boolean {
  const n = String(name || "").toLowerCase();
  if (n !== "get_task_output" && n !== "gettaskoutput") return false;
  const id = input.task_id ?? input.taskId;
  const ids = input.task_ids ?? input.taskIds;
  const hasId =
    (typeof id === "string" && id.trim() !== "") ||
    (Array.isArray(ids) && ids.length > 0);
  if (!hasId) return false;
  if (input.wait_mode != null && String(input.wait_mode).trim() !== "") {
    return false;
  }
  // timeout_ms is a documented alias of wait (and is stripped from the
  // fingerprint). Treat it as wait so a real blocker is not a poll.
  const wait = input.wait ?? input.wait_ms ?? input.timeout_ms ?? input.timeout;
  if (wait === true || wait === "true" || wait === "wait") return false;
  if (typeof wait === "number" && Number.isFinite(wait) && wait > 0) return false;
  if (typeof wait === "string") {
    const t = wait.trim().toLowerCase();
    if (t && t !== "0" && t !== "false" && t !== "off") return false;
  }
  return true;
}

export function classifyToolDoomOutcome(
  content: string,
  isError?: boolean,
): DoomOutcome {
  const s = (content || "").trim();
  if (
    s.includes(TOOL_CLEARED_MARKER) ||
    /Full output:\s+\S+\s+—\s+use read_file/i.test(s) ||
    /Do not re-run \S+ to restore this result/i.test(s)
  ) {
    return "stub";
  }
  if (
    /\(Partial:\s*some servers still connecting/i.test(s) ||
    /some servers still connecting or failed/i.test(s)
  ) {
    return "partial";
  }
  if (isError) {
    if (
      /timed out after\b/i.test(s) ||
      /\[exit code 124\]/i.test(s) ||
      /\bCommand timed out\b/i.test(s)
    ) {
      return "timeout";
    }
    return "error";
  }
  if (!s || /^(No MCP tools\b|No MCP tools matched)/i.test(s)) return "empty";
  return "success";
}

export class DoomLoopTracker {
  private readonly threshold: number;
  private readonly window: number;
  private recent: RecentEntry[] = [];
  private lastHit: { fp: string; kind: DoomHitKind } | null = null;

  constructor(cfg: DoomLoopConfig = {}) {
    this.threshold = cfg.threshold ?? 3;
    this.window = cfg.window ?? 12;
  }

  reset(): void {
    this.recent = [];
    this.lastHit = null;
  }

  /**
   * Record a tool call. Returns a hit when the streak of identical
   * fingerprints warrants a strategy change (kind depends on prior outcomes).
   */
  observe(name: string, input: Record<string, unknown>): DoomLoopHit | null {
    const fp = toolFingerprint(name, input);
    const prior: RecentEntry[] = [];
    for (let i = this.recent.length - 1; i >= 0; i--) {
      if (this.recent[i]!.fp !== fp) break;
      prior.unshift(this.recent[i]!);
    }
    this.recent.push({ fp });
    if (this.recent.length > this.window) {
      this.recent = this.recent.slice(-this.window);
    }

    if (this.lastHit && this.lastHit.fp !== fp) this.lastHit = null;

    const count = prior.length + 1;
    const outcomes = prior
      .map((p) => p.outcome)
      .filter((o): o is DoomOutcome => Boolean(o));
    const hit = this.classifyHit(name, input, fp, count, outcomes);
    if (!hit) return null;
    if (this.lastHit?.fp === fp && this.lastHit.kind === hit.kind) return null;
    this.lastHit = { fp, kind: hit.kind };
    return hit;
  }

  /** Attach the result of the most recent matching fingerprint (this call). */
  noteResult(
    name: string,
    input: Record<string, unknown>,
    content: string,
    isError?: boolean,
  ): void {
    const fp = toolFingerprint(name, input);
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const e = this.recent[i]!;
      if (e.fp === fp && e.outcome === undefined) {
        e.outcome = classifyToolDoomOutcome(content, isError);
        return;
      }
    }
  }

  private classifyHit(
    name: string,
    input: Record<string, unknown>,
    fp: string,
    count: number,
    outcomes: DoomOutcome[],
  ): DoomLoopHit | null {
    const preview = summarizeInput(input);

    if (isTaskOutputPoll(name, input) && count >= 2) {
      return {
        tool: name,
        fingerprint: fp,
        count,
        kind: "poll",
        message:
          `[Forge] get_task_output on the same task_id ${count} times without wait=. ` +
          `Do not poll. Use get_task_output({ task_id, wait: 120000 }) (or wait_mode=any|all).`,
      };
    }

    if (outcomes.length > 0 && outcomes.every((o) => o === "partial")) {
      if (count >= 2) {
        return {
          tool: name,
          fingerprint: fp,
          count,
          kind: "wait",
          message:
            `[Forge] \`${name}\` is still partial (MCP servers connecting)${
              preview ? ` (${preview})` : ""
            }. ` +
            `Do not repeat the same search. Wait, /mcp status, then search a narrower query — ` +
            `or call_mcp on a name you already have.`,
        };
      }
      return null;
    }

    if (outcomes.length > 0 && outcomes.every((o) => o === "stub")) {
      if (count >= 2) {
        return {
          tool: name,
          fingerprint: fp,
          count,
          kind: "stub",
          message:
            `[Forge] Previous \`${name}\` result was cleared to a stub` +
            (preview ? ` (${preview})` : "") +
            `. read_file the Full output path — do not re-issue the same call.`,
        };
      }
      return null;
    }

    const successOnly =
      outcomes.length > 0 && outcomes.every((o) => o === "success");
    if (successOnly && count >= 2) {
      return {
        tool: name,
        fingerprint: fp,
        count,
        kind: "doom",
        message: buildDoomMessage(name, input, count, "success"),
      };
    }

    const failish = outcomes.filter(
      (o) => o === "error" || o === "timeout" || o === "empty",
    );
    if (failish.length >= this.threshold - 1 && count >= this.threshold) {
      const kind = failish[failish.length - 1]!;
      return {
        tool: name,
        fingerprint: fp,
        count,
        kind: "doom",
        message: buildDoomMessage(name, input, count, kind),
      };
    }

    // No outcomes yet (parallel batch / first calls) — identical × threshold.
    if (outcomes.length === 0 && count >= this.threshold) {
      return {
        tool: name,
        fingerprint: fp,
        count,
        kind: "doom",
        message: buildDoomMessage(name, input, count),
      };
    }

    return null;
  }
}

function preferredVerifyHint(): string {
  try {
    const cmd = detectProjectIntel(process.cwd()).checkCommands[0];
    if (cmd) return cmd;
  } catch {
    /* optional */
  }
  return "typecheck/test";
}

function buildDoomMessage(
  name: string,
  input: Record<string, unknown>,
  count: number,
  outcome?: DoomOutcome,
): string {
  const preview = summarizeInput(input);
  const verify = preferredVerifyHint();
  const head =
    `[Forge doom-loop] You called \`${name}\` with the same arguments ${count} times in a row` +
    (preview ? ` (${preview})` : "");
  if (outcome === "success") {
    return (
      `${head}. You already have this result. STOP repeating. ` +
      `Use the previous output, change the query/path, or switch tools.`
    );
  }
  if (outcome === "timeout") {
    return (
      `${head}. Timed out. STOP repeating the same call. ` +
      `Raise wait/timeout, background the job, or change approach.`
    );
  }
  if (outcome === "empty") {
    return (
      `${head}. Empty result. STOP repeating. ` +
      `Change the query/path, or use a different tool.`
    );
  }
  if (outcome === "error") {
    return (
      `${head}. STOP repeating. Change approach: use a different tool or different arguments, or edit the file. ` +
      `If the tool error names a missing path/arg, fix that first; if permission denied, do not retry the same mutation. ` +
      `When stuck after edits, run \`${verify}\` once to learn the real failure.`
    );
  }
  return (
    `${head}. STOP repeating. Change approach: use a different tool or different arguments, or edit the file. ` +
    `If a previous result was cleared, read_file the saved output path — do not re-read the same window. ` +
    `Identical retries waste turns and will keep failing. ` +
    `If the tool error names a missing path/arg, fix that first; if permission denied, do not retry the same mutation. ` +
    `When stuck after edits, run \`${verify}\` once to learn the real failure.`
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  if (typeof input.command === "string") {
    return `command=${JSON.stringify(String(input.command).slice(0, 80))}`;
  }
  if (typeof input.path === "string") {
    return `path=${JSON.stringify(String(input.path).slice(0, 80))}`;
  }
  if (typeof input.pattern === "string") {
    return `pattern=${JSON.stringify(String(input.pattern).slice(0, 60))}`;
  }
  if (typeof input.query === "string") {
    return `query=${JSON.stringify(String(input.query).slice(0, 60))}`;
  }
  if (typeof input.task_id === "string") {
    return `task_id=${JSON.stringify(String(input.task_id).slice(0, 40))}`;
  }
  try {
    return JSON.stringify(input).slice(0, 100);
  } catch {
    return "";
  }
}
