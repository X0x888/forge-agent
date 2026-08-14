import type { SessionData } from "../session/session.js";
import { isLastVerificationStale } from "../session/session.js";
import type { FileMutation } from "../session/mutations.js";
import { readFileMutations } from "../session/mutations.js";
import { displayRelPath } from "../agent/tools/path-util.js";
import { detectProjectIntel } from "../util/project-intel.js";
import { clipAnsi, visibleWidth } from "../util/format.js";

/**
 * Pure formatter for the end-of-turn change summary (unattended runs):
 * which files actually changed on disk this turn + whether a verification
 * command has run since the last edit. Returns null when nothing was
 * edited — the REPL stays silent then.
 */
export function formatTurnChangeSummary(
  edits: FileMutation[],
  cwd: string,
  meta: SessionData["meta"],
  preferredCheck?: string | null,
): string | null {
  if (!edits.length) return null;
  const byPath = new Map<string, string>();
  for (const m of edits) byPath.set(m.path, m.kind);
  const names = [...byPath.entries()].map(([p, kind]) => {
    const label = displayRelPath(cwd, p);
    return kind === "create" ? `${label} (new)` : label;
  });
  const lv = meta.lastVerificationCommand?.trim();
  const next = preferredCheck?.trim();
  const verify = lv
    ? isLastVerificationStale(meta)
      ? `verify: ${lv} (stale — predates last edit)`
      : `verify: ${lv} ✓`
    : next
      ? `verify: none — run ${next}`
      : `verify: none — edits unverified`;
  const cols = process.stdout.isTTY ? process.stdout.columns || 80 : 80;
  const prefix = `  Δ ${byPath.size} file${byPath.size === 1 ? "" : "s"}: `;
  const suffix = `  ·  ${verify}`;
  const reserved = visibleWidth(prefix) + visibleWidth(suffix);
  if (reserved >= cols) {
    return `${prefix}${clipAnsi(suffix.trimStart(), Math.max(8, cols - visibleWidth(prefix)))}`;
  }
  const budget = cols - reserved;
  let shown = names.slice(0, 6);
  let more = names.length > shown.length ? ` +${names.length - shown.length} more` : "";
  while (
    shown.length > 1 &&
    visibleWidth(`${shown.join(", ")}${more}`) > budget
  ) {
    shown = shown.slice(0, -1);
    more = ` +${names.length - shown.length} more`;
  }
  let mid = `${shown.join(", ")}${more}`;
  if (visibleWidth(mid) > budget) mid = clipAnsi(mid, budget);
  return `${prefix}${mid}${suffix}`;
}

/**
 * Journal + intel shim for the Δ closer. Shared by the REPL and
 * non-JSON `forge run` so unattended logs show the same files+verify line.
 * Returns null when nothing was edited this turn (or the journal is missing).
 */
export function formatTurnChangeSummaryForSession(
  session: SessionData,
  turnAtStart: number,
): string | null {
  const edits = readFileMutations(session.meta.id).filter(
    (m) => m.turn > turnAtStart,
  );
  let preferred: string | null = null;
  try {
    preferred =
      detectProjectIntel(session.meta.cwd || process.cwd()).checkCommands[0] ??
      null;
  } catch {
    /* intel is best-effort */
  }
  return formatTurnChangeSummary(
    edits,
    session.meta.cwd,
    session.meta,
    preferred,
  );
}

/** Inputs for the dim why-this-run-stopped closer (REPL + non-JSON forge run). */
export interface RunStopReasonInput {
  hitCostCap?: boolean;
  hitMaxTurns?: boolean;
  releasedOnContinueCap?: boolean;
  aborted?: boolean;
  stopContinues?: number;
  lastErrorCode?: string | null;
}

/**
 * One dim line when a run did not stop cleanly. Silent on a normal Stop
 * so the Δ closer stays the last chrome. Shared by REPL and `forge run`.
 */
export function formatRunStopReason(input: RunStopReasonInput): string | null {
  if (input.aborted) {
    return "  stop: aborted — /retry or forge run --continue";
  }
  if (input.hitCostCap) {
    return "  stop: cost cap — raise /budget · --max-cost · FORGE_MAX_COST_USD";
  }
  if (input.hitMaxTurns) {
    return "  stop: max turns — raise max_turns or continue with a follow-up";
  }
  if (input.releasedOnContinueCap) {
    const n = input.stopContinues;
    const count =
      typeof n === "number" && Number.isFinite(n) && n > 0
        ? ` after ${n} harness continue${n === 1 ? "" : "s"}`
        : "";
    return `  stop: continue-cap${count} — narrow the task or raise FORGE_ULW_MAX_CONTINUES`;
  }
  const code = String(input.lastErrorCode || "").trim();
  if (code === "handoff_released") {
    return "  stop: handoff-guard — finish the work instead of asking to continue";
  }
  if (code === "proof_claim_released") {
    return "  stop: proof-claim — run a check before claiming done";
  }
  if (code === "max_cost") {
    return "  stop: cost cap — raise /budget · --max-cost · FORGE_MAX_COST_USD";
  }
  if (code === "max_turns") {
    return "  stop: max turns — raise max_turns or continue with a follow-up";
  }
  if (code.startsWith("continue_cap")) {
    return "  stop: continue-cap — narrow the task or raise FORGE_ULW_MAX_CONTINUES";
  }
  if (code === "max_run_ms") {
    return "  stop: wall-clock — raise FORGE_MAX_RUN_MS or narrow the task";
  }
  if (code === "empty_run") {
    return "  stop: empty run — forge doctor · forge auth · check model id";
  }
  return null;
}
