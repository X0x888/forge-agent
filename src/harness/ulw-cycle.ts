/**
 * Ultrawork relentless cycle driver.
 *
 * User-facing control:
 *   cycle = 1  → keep looping research → waves → serendipity → review → repeat
 *   cycle = 0  → finish the current wave as the LAST cycle, then release Stop
 *
 * Armed by /ulw (and forge --ulw). Soft prompts ("improve the code") are
 * expanded into a god-scope mandate so the harness still drives correctly.
 */
import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowIso, nowEpoch } from "../util/fs.js";

export type CycleFlag = 0 | 1;

export interface UlwCycleState {
  /** Ultrawork cycle driver armed */
  enabled: boolean;
  /**
   * 1 = continue relentless cycles
   * 0 = last cycle — finish current wave then allow stop after attestation
   */
  cycle: CycleFlag;
  /** Wave counter (increments each Stop re-anchor while cycle=1) */
  wave: number;
  /** Total Stop blocks by this driver */
  blocks: number;
  /** Consecutive no-progress blocks */
  stuckBlocks: number;
  lastBlockEditCount: number;
  /** Original user mandate (possibly soft) */
  mandate: string;
  /** Expanded operational mandate shown to the model */
  expandedMandate: string;
  softPrompt: boolean;
  startedAt: string;
  updatedAt: string;
  sessionId: string;
}

export interface UlwStopDecision {
  block: boolean;
  reason?: string;
  reanchor?: string;
  stuckReleased?: boolean;
  lastCycleReleased?: boolean;
}

const LAST_CYCLE_ATTEST_RE =
  /\*\*Cycle complete\.\*\*|\*\*Wave complete\.\*\*|\*\*Last cycle complete\.\*\*|CYCLE COMPLETE|LAST CYCLE COMPLETE/i;

const SOFT_PROMPT_RE =
  /^(please\s+)?(improve|fix|polish|clean|harden|refactor|optimize|enhance|update|upgrade|review|audit|tidy|beautify|simplify|modernize)(\s+(the|this|our|my))?(\s+\w+){0,6}\.?$/i;

const BARE_IMPERATIVE_RE =
  /^(fix|improve|polish|clean|harden|refactor|optimize|ship|audit|review|test)\.?$/i;

export function ulwStatePath(sessionId: string): string {
  return path.join(forgeHome(), "sessions", sessionId, "ulw.json");
}

export function loadUlwCycle(sessionId: string): UlwCycleState | null {
  return readJsonFile<UlwCycleState | null>(ulwStatePath(sessionId), null);
}

export function saveUlwCycle(state: UlwCycleState): void {
  state.updatedAt = nowIso();
  writeJsonFile(ulwStatePath(state.sessionId), state);
}

/** Soft / weak prompts that need god-scope expansion under ULW. */
export function isSoftPrompt(prompt: string): boolean {
  const t = prompt.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.length < 12) return true;
  if (BARE_IMPERATIVE_RE.test(t)) return true;
  if (SOFT_PROMPT_RE.test(t)) return true;
  // No concrete deliverable markers
  const hasConcrete =
    /\b(test|tests|pass|endpoint|file|bug|error|fail|migrate|add|implement|remove|delete|until|acceptance|criteria|must|should not)\b/i.test(
      t,
    ) || /`[^`]+`|\.[a-z]{1,4}\b|\/[\w./-]+/.test(t);
  if (!hasConcrete && t.length < 80 && /improve|better|nice|clean|polish|fix/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Expand a (possibly soft) user mandate into operational instructions
 * the model can execute wave-by-wave.
 */
export function expandUlwMandate(mandate: string): { expanded: string; soft: boolean } {
  const soft = isSoftPrompt(mandate);
  const base = mandate.replace(/\s+/g, " ").trim() || "improve the codebase";

  if (!soft) {
    return {
      soft: false,
      expanded: [
        `User mandate: ${base}`,
        `Execute relentlessly under the ULW cycle protocol until cycle flag is 0 and the last wave is attested complete.`,
      ].join("\n"),
    };
  }

  return {
    soft: true,
    expanded: [
      `User mandate (SOFT — expand to full god-scope, do not ask what they meant): "${base}"`,
      ``,
      `Interpret as: identify real quality/correctness/DX gaps in THIS workspace and ship improvements end-to-end.`,
      `You own technical judgment. Declare your interpretation in one sentence and start working.`,
      ``,
      `God-scope scan (do this, not a vague pep talk):`,
      `1. Inventory: project type, how to build/test, obvious entrypoints, git status, existing TODOs/FIXMEs.`,
      `2. Gap list: bugs, missing tests, broken scripts, brittle paths, security footguns, dead code that blocks clarity, UX/CLI gaps — prioritize by impact × confidence.`,
      `3. Wave plan: 3–7 concrete waves; execute Wave 1 immediately.`,
      `4. Serendipity: if you verify an adjacent bug on a path already open, fix it when the fix is bounded (log as Serendipity).`,
      `5. Independent review after each wave: re-read diffs, run cheapest proof, then either next wave or (if cycle=0) attest last cycle complete.`,
      ``,
      `Forbidden: stopping with "looks fine", asking "what should I improve?", deferring to a future session, inventing scope to gold-plate forever without shipping.`,
    ].join("\n"),
  };
}

export function armUlwCycle(
  sessionId: string,
  mandate: string,
  opts?: { cycle?: CycleFlag },
): UlwCycleState {
  const { expanded, soft } = expandUlwMandate(mandate);
  const prev = loadUlwCycle(sessionId);
  const state: UlwCycleState = {
    enabled: true,
    cycle: opts?.cycle ?? 1,
    wave: prev?.enabled ? prev.wave : 0,
    blocks: prev?.blocks ?? 0,
    stuckBlocks: 0,
    lastBlockEditCount: 0,
    mandate: mandate.replace(/\s+/g, " ").trim() || "improve the codebase",
    expandedMandate: expanded,
    softPrompt: soft,
    startedAt: prev?.enabled ? prev.startedAt : nowIso(),
    updatedAt: nowIso(),
    sessionId,
  };
  saveUlwCycle(state);
  return state;
}

export function setCycleFlag(sessionId: string, cycle: CycleFlag): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s || !s.enabled) {
    // Allow arming cycle control only when ULW is on — create dormant? better require /ulw first
    return null;
  }
  s.cycle = cycle;
  if (cycle === 1) {
    s.stuckBlocks = 0;
  }
  saveUlwCycle(s);
  return s;
}

/**
 * Copy ULW cycle state onto a forked session id (expert branch keeps the driver).
 * No-op when source has no armed/persisted state.
 */
export function copyUlwCycle(fromId: string, toId: string): UlwCycleState | null {
  if (!fromId || !toId || fromId === toId) return null;
  const src = loadUlwCycle(fromId);
  if (!src) return null;
  const next: UlwCycleState = {
    ...src,
    sessionId: toId,
    // Fresh stuck counters on the branch — progress is independent
    stuckBlocks: 0,
    lastBlockEditCount: 0,
    updatedAt: nowIso(),
  };
  saveUlwCycle(next);
  return next;
}

export function disarmUlwCycle(sessionId: string): void {
  const s = loadUlwCycle(sessionId);
  if (!s) return;
  s.enabled = false;
  s.cycle = 0;
  saveUlwCycle(s);
}

/**
 * Compact counters for HUD / logs: `cycle=1 wave=3 blocks=5`.
 * Wave increments each time the driver re-anchors Stop while cycle=1.
 */
export function formatUlwCounts(s: Pick<UlwCycleState, "cycle" | "wave" | "blocks">): string {
  return `cycle=${s.cycle} wave=${s.wave} blocks=${s.blocks}`;
}

/** One-line badge for prompt flags / footers: `c=1 w=3 b=5`. */
export function formatUlwBadge(s: Pick<UlwCycleState, "cycle" | "wave" | "blocks">): string {
  const parts = [`c=${s.cycle}`, `w=${s.wave}`];
  if (s.blocks > 0) parts.push(`b=${s.blocks}`);
  return parts.join(" ");
}

/**
 * Shown to humans during ULW turns (stop re-anchor logs, kickoff, status).
 * Mirrors live mid-run slash policy in the REPL.
 */
export const ULW_LIVE_CONTROLS_HINT =
  "Live mid-run (type while working — no Ctrl+C): /cycle 0 last wave · /cycle 1 continue · /ulw-off disarm";

export function formatUlwStatus(s: UlwCycleState | null): string {
  if (!s || !s.enabled) {
    return [
      "ULW cycle: OFF",
      "  Arm with: /ulw <task>   or   /ulw improve the code",
      "  Cycle flag: set with /cycle 1 (continue) or /cycle 0 (last wave then stop)",
      `  ${ULW_LIVE_CONTROLS_HINT}`,
    ].join("\n");
  }
  return [
    `ULW cycle: ON  |  ${formatUlwCounts(s)}  ${s.cycle === 1 ? "(CONTINUE — relentless)" : "(LAST — finish current wave)"}`,
    `  Mandate: ${s.mandate}`,
    `  Soft prompt expanded: ${s.softPrompt ? "yes" : "no"}`,
    `  ${ULW_LIVE_CONTROLS_HINT}`,
    `  User controls:`,
    `    /cycle 1   — keep looping waves forever (until stuck-wall)`,
    `    /cycle 0   — treat current work as the LAST cycle; agent finishes wave then stops`,
    `    /ulw-off   — disarm immediately`,
    `  Agent attestation when cycle=0 and wave done: **Cycle complete.**`,
  ].join("\n");
}

/**
 * Stop evaluation for ULW cycle driver.
 */
export function evaluateUlwAtStop(opts: {
  sessionId: string;
  lastAssistantMessage: string;
  editCount: number;
  openTodoCount: number;
  stuckThreshold: number;
}): UlwStopDecision {
  const s = loadUlwCycle(opts.sessionId);
  if (!s || !s.enabled) return { block: false };

  // cycle=0 + attestation → release
  if (s.cycle === 0 && LAST_CYCLE_ATTEST_RE.test(opts.lastAssistantMessage || "")) {
    s.enabled = false;
    saveUlwCycle(s);
    return {
      block: false,
      lastCycleReleased: true,
      reason: "ULW last cycle attested complete — released.",
    };
  }

  // Progress / stuck tracking
  const progressed = opts.editCount > s.lastBlockEditCount;
  if (progressed) {
    s.stuckBlocks = 0;
  } else {
    s.stuckBlocks += 1;
  }
  s.blocks += 1;
  s.lastBlockEditCount = opts.editCount;

  if (opts.stuckThreshold > 0 && s.stuckBlocks >= opts.stuckThreshold) {
    s.enabled = false;
    s.cycle = 0;
    saveUlwCycle(s);
    return {
      block: false,
      stuckReleased: true,
      reason: `ULW stuck-wall: ${s.stuckBlocks} consecutive Stop attempts with no file edits. Cycle released. Re-arm with /ulw or /cycle 1.`,
    };
  }

  if (s.cycle === 1) {
    s.wave += 1;
    saveUlwCycle(s);
    const reanchor = buildCycleReanchor(s, {
      openTodos: opts.openTodoCount,
      mode: "continue",
    });
    return { block: true, reason: reanchor, reanchor };
  }

  // cycle === 0: force finish current wave (no "I'll stop mid-wave")
  saveUlwCycle(s);
  const reanchor = buildCycleReanchor(s, {
    openTodos: opts.openTodoCount,
    mode: "last",
  });
  return { block: true, reason: reanchor, reanchor };
}

function buildCycleReanchor(
  s: UlwCycleState,
  opts: { openTodos: number; mode: "continue" | "last" },
): string {
  if (opts.mode === "continue") {
    return [
      `[Forge ULW cycle driver] Stop blocked — ${formatUlwCounts(s)} (CONTINUE).`,
      `Mandate: ${s.mandate}`,
      `Wave about to start: ${s.wave}  (Stop blocks so far: ${s.blocks}; stuck-streak tracked)`,
      ``,
      `Execute the ULW CYCLE (do not skip steps):`,
      `1. RESEARCH — re-scan gaps vs mandate; update todo_write with concrete items.`,
      `2. THINK — pick the highest-impact bounded wave; think out of the box if the obvious path is blocked.`,
      `3. IMPLEMENT — ship the wave with real code/tests; verify with cheapest proof.`,
      `4. SERENDIPITY — fix verified adjacent defects on already-loaded paths when the fix is bounded; note under Serendipity.`,
      `5. REVIEW — independent pass: re-read your diff, check for regressions, no open todos left for THIS wave.`,
      `6. REPEAT — do NOT stop. Begin the next research scan. The user sets cycle=0 when they want this to be the last loop.`,
      ``,
      s.softPrompt
        ? `Soft original prompt — keep discovering real gaps; do not ask the user to clarify "improve".`
        : `Stay aligned with the mandate above.`,
      opts.openTodos > 0
        ? `Open todos: ${opts.openTodos} — clear or complete them before claiming a wave done.`
        : `No open todos recorded — create a short wave plan via todo_write then execute.`,
      ``,
      `User control (independent flag): /cycle 0 = finish current wave as last · /cycle 1 = keep going · /ulw-off = disarm.`,
      `${ULW_LIVE_CONTROLS_HINT}`,
      `Do not stop. Do not ask permission to continue. Next tool calls now.`,
    ].join("\n");
  }

  return [
    `[Forge ULW cycle driver] Stop blocked — ${formatUlwCounts(s)} (LAST CYCLE).`,
    `Mandate: ${s.mandate}`,
    `Wave: ${s.wave}  — finish THIS wave completely, then attest and stop.`,
    ``,
    `Required:`,
    `1. Complete all open work for the current wave (todos, verification).`,
    `2. Independent review of the diff.`,
    `3. Attest exactly: **Cycle complete.** with a short checklist of what shipped + evidence (commands/results).`,
    `4. Do NOT start a new ambitious wave. Polish/finish only.`,
    ``,
    `Until you attest **Cycle complete.**, Stop remains blocked.`,
    opts.openTodos > 0
      ? `Still ${opts.openTodos} open todo(s) — close them or cancel with reason.`
      : `No open todos — review + attest if the wave is truly done.`,
    ``,
    `${ULW_LIVE_CONTROLS_HINT}`,
    `User may flip back to /cycle 1 if they want more waves after all.`,
  ].join("\n");
}

/** Injected into the user message path when /ulw arms on a soft prompt. */
export function ulwKickoffMessage(state: UlwCycleState): string {
  return [
    state.expandedMandate,
    ``,
    `## ULW runtime controls (read carefully)`,
    `- Counters RIGHT NOW: **${formatUlwCounts(state)}**  ${state.cycle === 1 ? "(CONTINUE relentless loops)" : "(LAST cycle)"}`,
    `- The user can flip cycle any time with /cycle 0 or /cycle 1 — including while you are mid-turn (live controls). Independent of your opinion of "done".`,
    `- While cycle=1, the harness will block Stop and force the research→implement→serendipity→review→repeat loop.`,
    `- When cycle=0, finish the current wave and attest **Cycle complete.**`,
    `- ${ULW_LIVE_CONTROLS_HINT}`,
    ``,
    `Start Wave 1 now: research first, then ship.`,
  ].join("\n");
}

export function parseCycleArg(arg: string): CycleFlag | null {
  const t = arg.trim().toLowerCase();
  if (t === "1" || t === "on" || t === "continue" || t === "go") return 1;
  if (t === "0" || t === "off" || t === "last" || t === "stop" || t === "done") return 0;
  return null;
}

// silence unused import if tree-shaken
void nowEpoch;
