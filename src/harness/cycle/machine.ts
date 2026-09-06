/**
 * Pure cycle transitions at a Stop boundary.
 *
 * `decideAtStop` reads facts (edits, board, tree movement, the closer) and
 * returns the one action the orchestrator performs. It mutates only the
 * ledger and the counters that belong to a Stop (wave, stuck, blocks); the
 * phase moves when the orchestrator finishes the action. Nothing here reads
 * intent from prose except the literal `Plan complete.` closer, which is a
 * declared token, not a classification.
 */
import { nowIso } from "../../util/fs.js";
import { PLAN_COMPLETE_RE } from "./artifacts.js";
import { openItems, type CycleEndReason, type CycleState } from "./state.js";

export interface StopFacts {
  editCount: number;
  openTodoCount: number;
  lastAssistantMessage: string;
  diffFingerprint?: string | null;
  verificationRan: boolean;
  verificationPassed: boolean;
  verificationFullSuite: boolean;
  /** Consecutive no-progress Stops in EXECUTE before the cycle closes early. */
  stuckThreshold: number;
}

export type CycleAction =
  /** No plan on disk — run the Planner (cycle 0, or after a commit). */
  | { kind: "plan" }
  /** EXECUTE is over — verify → review → verify → commit → next. */
  | { kind: "close-cycle"; why: "items-done" | "plan-complete" | "replan" | "stuck" }
  /** FIX phase — re-run the verify command. */
  | { kind: "verify" }
  /** Executor keeps going. */
  | { kind: "reanchor"; why: "items-open" }
  /** The user owns planning (/plan); the turn may end, the run stays armed. */
  | { kind: "yield"; why: "human-plan" }
  | { kind: "release"; reason: CycleEndReason };

function clip(t: string, n = 140): string {
  const s = (t || "").replace(/\s+/g, " ").trim();
  if (!s) return "(no closing summary)";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Record the Stop as a wave and update the progress / stuck counters. */
function stampWave(s: CycleState, f: StopFacts): { progressed: boolean } {
  const editDelta = Math.max(0, f.editCount - s.lastBlockEditCount);
  let netDiff: "new" | "revisit" | "none" | "n/a" = "n/a";
  const fp = f.diffFingerprint ?? null;
  if (fp != null) {
    if (fp === s.lastDiffFp) netDiff = "none";
    else if (s.seenDiffFps.includes(fp)) netDiff = "revisit";
    else netDiff = "new";
    if (!s.seenDiffFps.includes(fp)) s.seenDiffFps.push(fp);
    s.lastDiffFp = fp;
  }
  s.wave += 1;
  s.totalWaves += 1;
  s.ledger.push({
    cycle: s.cycle,
    wave: s.wave,
    ts: nowIso(),
    editDelta,
    netDiff,
    proofRan: f.verificationRan,
    proofPassed: f.verificationPassed,
    fullSuite: f.verificationFullSuite,
    summary: clip(f.lastAssistantMessage),
  });
  const progressed = editDelta > 0 || netDiff === "new";
  if (progressed) s.stuckBlocks = 0;
  else s.stuckBlocks += 1;
  s.lastBlockEditCount = f.editCount;
  s.blocks += 1;
  return { progressed };
}

export function decideAtStop(s: CycleState, f: StopFacts): CycleAction {
  if (!s.enabled || s.legacy || s.phase === "released") {
    return { kind: "release", reason: s.endReason ?? "disarmed" };
  }
  switch (s.phase) {
    case "plan":
      if (s.humanPlan) return { kind: "yield", why: "human-plan" };
      return { kind: "plan" };
    case "execute": {
      stampWave(s, f);
      if (s.replanRequested) return { kind: "close-cycle", why: "replan" };
      if (PLAN_COMPLETE_RE.test(f.lastAssistantMessage || "")) {
        return { kind: "close-cycle", why: "plan-complete" };
      }
      // The plan items are the truth; the board is mirrored onto them by
      // syncItemsFromTodos before this runs. An empty board with open items
      // (seeding failed, or the model wiped it) is not a finished plan.
      if (openItems(s).length === 0) {
        return { kind: "close-cycle", why: "items-done" };
      }
      if (f.stuckThreshold > 0 && s.stuckBlocks >= f.stuckThreshold) {
        return { kind: "close-cycle", why: "stuck" };
      }
      return { kind: "reanchor", why: "items-open" };
    }
    case "fix":
      return { kind: "verify" };
    case "review":
    case "verify":
    case "commit":
      // A transition interrupted mid-flight (abort, crash); resume it.
      return { kind: "close-cycle", why: "items-done" };
    default:
      return { kind: "release", reason: "disarmed" };
  }
}

/** Items the executor's board still lists — kept in sync from todo status. */
export function syncItemsFromTodos(
  s: CycleState,
  todos: ReadonlyArray<{ id: string; status: string }>,
): void {
  const byId = new Map(todos.map((t) => [t.id, t.status]));
  for (const it of s.items) {
    const st = byId.get(it.id);
    if (!st) continue;
    if (st === "completed") it.status = "done";
    else if (st === "cancelled") it.status = "cancelled";
    else it.status = "open";
  }
}
