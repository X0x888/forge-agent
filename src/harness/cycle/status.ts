/**
 * Human surfaces for the cycle driver: dock badge, /cycle status card,
 * counts for the admit fingerprint, report facts.
 */
import {
  cycleActive,
  loadCycleState,
  openItems,
  type CycleRecord,
  type CycleState,
} from "./state.js";

/** Committed plan cycles recorded on a session's sidecar (metrics). */
export function ulwCyclesCommittedFor(sessionId: string): number {
  try {
    const s = loadCycleState(sessionId);
    if (!s || s.legacy) return 0;
    return s.cycles.filter((c) => c.commitSha).length;
  } catch {
    return 0;
  }
}

const PHASE_LABEL: Record<CycleState["phase"], string> = {
  plan: "PLAN",
  execute: "EXEC",
  review: "REVIEW",
  verify: "VERIFY",
  fix: "FIX",
  commit: "COMMIT",
  released: "OFF",
};

export function displayUlwMandate(s: Pick<CycleState, "mandate" | "direction"> | null | undefined): string {
  if (!s) return "(none)";
  if (s.mandate) return s.mandate;
  return s.direction ? `(derived) ${s.direction}` : "(no mandate — the Planner derives the direction)";
}

/** `ULW c3 EXEC 4/7` — for the dock and the prompt strip. */
export function formatUlwBadge(s: CycleState | null | undefined): string {
  if (!s || !cycleActive(s)) return "ULW off";
  const phase = PHASE_LABEL[s.phase];
  const items = s.items.length
    ? ` ${s.items.filter((i) => i.status === "done").length}/${s.items.length}`
    : "";
  const cap = s.maxCycles != null ? `/${s.maxCycles}` : "";
  const last = s.cycleZeroRequested ? " LAST" : "";
  return `ULW c${s.cycle}${cap} ${phase}${items}${last}`;
}

/** `cycle=3 phase=execute wave=4 items=2/7` — admit fingerprints and logs. */
export function formatUlwCounts(s: CycleState | null | undefined): string {
  if (!s) return "ULW off";
  const bits = [
    `cycle=${s.cycle}${s.maxCycles != null ? `/${s.maxCycles}` : ""}`,
    `phase=${s.phase}`,
    `wave=${s.wave}`,
    s.items.length ? `items=${s.items.filter((i) => i.status === "done").length}/${s.items.length}` : "",
    s.cycleZeroRequested ? "last-cycle" : "",
  ].filter(Boolean);
  return bits.join(" ");
}

function cycleRow(c: CycleRecord): string {
  const verify =
    c.verifyPassed === true
      ? c.verifyInherited
        ? `✓ vs baseline (${c.verifyInherited} pre-existing still red)`
        : "✓"
      : c.verifyPassed === false
        ? "✗"
        : c.verifyCommand
          ? "–"
          : "";
  return [
    `  c${c.n}`,
    c.title ? c.title.slice(0, 48) : "(plan)",
    `${c.itemsDone}/${c.itemsTotal}`,
    `${c.waves}w`,
    c.reviewVerdict ? c.reviewVerdict : "",
    verify ? `verify ${verify}` : "",
    c.commitSha ? c.commitSha : c.endedAt ? "no commit" : "open",
    // The Reviewer's answer to "would a user notice this cycle?" — the
    // column to read down when a run has been going all night — and whether
    // the Planner claimed it before the spend.
    c.worth ? `worth ${/^\s*no\b/i.test(c.worth) ? "no" : "yes"}${c.worthClaim ? " (claimed)" : ""}` : c.worthClaim ? "worth claimed" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `2 kept · 1 broken · 1 absent` — the product's own checklist as last inspected. */
function promiseTally(s: CycleState): string {
  const p = s.promises ?? [];
  if (!p.length) return "";
  const n = (state: "kept" | "broken" | "absent" | "unknown") => p.filter((x) => x.state === state).length;
  return `${n("kept")} kept · ${n("broken")} broken · ${n("absent")} absent${n("unknown") ? ` · ${n("unknown")} unknown` : ""}`;
}

export function formatUlwStatus(s: CycleState | null | undefined): string {
  if (!s) return "ULW: off — /ulw [mandate] arms the plan-cycle driver.";
  if (s.legacy) {
    return "ULW: off — this session's ulw.json is from the retired wave engine; /ulw [mandate] re-arms with the plan-cycle driver.";
  }
  if (!cycleActive(s)) {
    const st: CycleState = s;
    return `ULW: off${st.endReason ? ` (${st.endReason})` : ""} — ${st.cycles.length} cycle(s) recorded. /ulw [mandate] re-arms.`;
  }
  const lines: string[] = [
    `ULW: ${formatUlwBadge(s)}${s.humanPlan ? " · human /plan" : ""}`,
    `  Mandate: ${displayUlwMandate(s).slice(0, 200)}`,
  ];
  if (s.identity) lines.push(`  Identity: ${s.identity.slice(0, 200)}`);
  const tally = promiseTally(s);
  if (tally) lines.push(`  Promises: ${tally}`);
  if (s.planTitle) lines.push(`  Plan: ${s.planTitle}`);
  const open = openItems(s);
  if (s.items.length) {
    lines.push(`  Items: ${s.items.length - open.length}/${s.items.length} done`);
    for (const i of open.slice(0, 6)) lines.push(`    ○ ${i.id} ${i.title.slice(0, 90)}`);
    if (open.length > 6) lines.push(`    … +${open.length - 6} more`);
  }
  if (s.verifyCommand) lines.push(`  Verify: ${s.verifyCommand}`);
  if (s.lastReview) {
    lines.push(
      `  Last review: ${s.lastReview.verdict}${s.lastReview.mustFix.length ? ` · must-fix ${s.lastReview.mustFix.length}` : ""}`,
    );
  }
  if (s.phase === "fix") lines.push(`  Fix rounds: ${s.fixRounds}`);
  if (s.cycles.length) {
    lines.push(`  Cycles:`);
    for (const c of s.cycles.slice(-6)) lines.push(cycleRow(c));
  }
  lines.push(
    `  Stop: ${
      s.cycleZeroRequested
        ? "after this cycle is reviewed and committed (/cycle 0)"
        : s.maxCycles != null
          ? `after cycle ${s.maxCycles} (/max-cycles)`
          : "when the Planner says fulfilled, or /cycle 0"
    }`,
  );
  return lines.join("\n");
}

/** Facts for the run report. */
export function cycleReportFacts(s: CycleState | null | undefined): {
  active: boolean;
  outcome: string;
  shipped: string[];
  notDone: string[];
  needsYou: string[];
  verified: string[];
} {
  if (!s || s.legacy) {
    return { active: false, outcome: "", shipped: [], notDone: [], needsYou: [], verified: [] };
  }
  // The Planner's claim before the spend and the Reviewer's finding after,
  // side by side: whether the boss's sentence held is readable per cycle.
  const shipped = s.cycles
    .filter((c) => c.itemsDone > 0 || c.commitSha)
    .map(
      (c) =>
        `Cycle ${c.n}${c.title ? ` — ${c.title}` : ""}: ${c.itemsDone}/${c.itemsTotal} items${c.commitSha ? `, commit ${c.commitSha}` : ""}` +
        (c.worthClaim ? ` · claimed: ${oneLine(c.worthClaim, 160)}` : "") +
        (c.worth ? ` · found: ${oneLine(c.worth, 160)}` : ""),
    );
  const verified = s.cycles
    .filter((c) => c.verifyCommand)
    .map(
      (c) =>
        `Cycle ${c.n}: \`${c.verifyCommand}\` ${
          c.verifyPassed
            ? c.verifyInherited
              ? `green vs baseline (${c.verifyInherited} pre-existing still red)`
              : "green"
            : c.verifyPassed === false
              ? "RED"
              : "not run"
        }`,
    );
  const notDone: string[] = [];
  for (const i of openItems(s)) notDone.push(`${i.title} (cycle ${s.cycle}, open)`);
  const last = s.cycles[s.cycles.length - 1];
  for (const m of last?.mustFix ?? []) notDone.push(`Must-fix: ${m}`);
  // Unkept promises need repair; unknown promises still need evidence.
  for (const p of s.promises ?? []) {
    if (p.state === "kept") continue;
    notDone.push(`Promise ${p.state}: ${p.text}${p.seen ? ` — ${p.seen}` : ""}`);
  }
  const needsYou: string[] = [];
  for (const o of s.lastReview?.operator ?? []) needsYou.push(o);
  const st: CycleState = s;
  const outcome = cycleActive(st)
    ? `ULW cycle ${st.cycle} in ${st.phase}`
    : st.endReason === "fulfilled"
      ? `Done — the Planner judged the mandate fulfilled after ${st.cycles.filter((c) => c.commitSha).length} committed cycle(s)`
      : st.endReason === "cycle-zero"
        ? `Stopped on /cycle 0 after cycle ${st.cycle}`
        : st.endReason === "max-cycles"
          ? `Stopped at max_cycles ${st.maxCycles}`
          : st.endReason === "fix-cap"
            ? `Blocked — verification or review findings remain in cycle ${st.cycle}`
            : st.endReason === "no-progress"
              ? `Stopped — ${st.directExecuteStreak} synthesized cycle(s) in a row landed nothing (no-progress wall); re-arm with /ulw or give a mandate`
              : st.endReason === "blocked"
                ? `Blocked — the Planner needs the user`
                : st.endReason
                ? `ULW ended (${st.endReason})`
                : "";
  return { active: cycleActive(s), outcome, shipped, notDone, needsYou, verified };
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
