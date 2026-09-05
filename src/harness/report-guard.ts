/**
 * Report guard — the closing message must stand on its own and must not
 * hand homework back.
 *
 * Two detectors, one Stop block each at most (FORGE_REPORT_BLOCK_CAP, default 2):
 *
 *  1. Homework hand-back: "you can now run…", "next step for you: add…",
 *     "you'll need to configure…". The only things a closing message may
 *     leave to the user are a missing secret, a hard external blocker, or an
 *     irreversible action — each written as an `Operator:` line. Anything
 *     else the agent does itself (sisyphus OPERATOR_PREFIX rule, made native).
 *
 *  2. Run-wide shape after a multi-round run (harness re-anchored ≥ 2 times
 *     and files changed): the closer must lead with an outcome sentence and
 *     carry bold-labelled sections (What shipped / Verified / Not done /
 *     Needs you). A last-round-only "Fixed the reviewer's nit." is bounced
 *     once with the harness facts so the model writes the whole-run report.
 *
 * Advisory Q&A turns never bounce.
 *
 * The closer a user of this tool actually reads is the driver attestation
 * (`**Cycle complete.**` after `/cycle 0`, `**Goal achieved.**`), and the
 * goal / ULW drivers release on it inside stop-guard long before step 8 can
 * look at it. `evaluateAttestationHomeworkAtStop` is that same check run
 * ahead of the drivers, so a bounce costs one round and never a wave.
 */
import { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";

const OPERATOR_RE = /\bOperator:/i;

/**
 * Lines that hand the user work the agent could do.
 *
 * Directive forms only. "You'll need to configure…", "you should run…",
 * "you might want to add…" hand work back. "You can now run `forge status`
 * to see it" is an affordance — it tells the user what they have, which is
 * exactly what a closing message is for — and used to be bounced on the
 * bare modal `can`. The corpus in `tests/fixtures/prose-corpus.ts` pins both
 * sides of that line.
 */
const HOMEWORK_PATTERNS: RegExp[] = [
  /\byou(?:'ll\s+need\s+to|'ll\s+want\s+to|'ll\s+have\s+to|'d\s+need\s+to|'d\s+want\s+to|\s+(?:should|must|will\s+need\s+to|need\s+to|have\s+to|will\s+want\s+to|might\s+want\s+to|may\s+want\s+to|would\s+need\s+to|will\s+have\s+to|would\s+want\s+to|ought\s+to))\s+(?:now\s+|then\s+|also\s+|still\s+|manually\s+|probably\s+)?(?:run|re-?run|add|update|set|configure|verify|check|test|review|install|enable|create|write|wire|hook|deploy|merge|open|try|apply|fix|finish|implement|edit|change|adjust|tweak|bump|regenerate|rebuild|restart|commit|push|clean|remove|delete|rename|move|migrate|fill|replace|complete|extend|integrate|validate|double-?check)\b/i,
  /\b(?:next\s+steps?|follow-?ups?|to-?dos?|remaining\s+(?:work|items?|tasks?)|what'?s\s+left|left\s+to\s+do|action\s+items?)\s+(?:for|on)\s+(?:you|your\s+(?:side|end))\b/i,
  /\b(?:for\s+you\s+to\s+(?:run|add|update|set|configure|verify|check|test|review|install|enable|create|write|wire|hook|deploy|merge|apply|fix|finish|implement|edit|change|complete)|on\s+your\s+(?:side|end)\s+(?:to|:)|left\s+(?:for|to)\s+you)\b/i,
  /^\s*(?:[-*•]\s*)?please\s+(?:run|re-?run|add|update|verify|check|test|review|install|configure|apply|merge|fix|finish|complete|deploy|restart|regenerate)\b/im,
  /\b(?:i(?:'m|\s+am)\s+leaving|i(?:'ll|\s+will)\s+leave|i\s+(?:leave|left)|leaving)\s+(?:that|this|it|the\s+(?:[\w-]+\s+){0,3}?)(?:to|for)\s+you\b/i,
  /\b(?:i\s+)?(?:did\s+not|didn't|have\s+not|haven't|could\s+not|couldn't)\s+(?:run|test|verify|check|finish|complete)\b[^.\n]{0,60}\byou\s+(?:can|could|should|may|might|will\s+need\s+to|need\s+to)\b/i,
  // "you can now run the migration when you are ready" — the deferral turns
  // an affordance into a hand-back: the agent is parking an action on the
  // user's calendar.
  /\byou\s+can\s+(?:now\s+|then\s+)?(?:run|re-?run|deploy|apply|merge|push|trigger|kick\s+off|start|execute|release|publish)\b[^.\n]{0,80}\b(?:when(?:ever)?\s+you(?:'re|\s+are)\s+ready|when\s+you\s+(?:like|want|wish|get\s+a\s+chance|have\s+a\s+moment)|at\s+your\s+convenience|whenever\s+(?:you\s+like|suits))\b/i,
  // "you can run lint and fix anything it reports" — the coordinated verb is
  // the work being handed over.
  /\byou\s+can\s+(?:now\s+|then\s+)?\w+[^.\n]{0,80}\band\s+(?:then\s+)?(?:fix|add|update|wire|configure|finish|complete|implement|set|install|apply|merge|review|verify|check|adjust|tweak|clean\s+up|resolve|address|handle)\b/i,
];

/**
 * Exemptions on the same line: the allowed reasons a closing message may
 * leave something to the user — a secret, an external/environment blocker,
 * an irreversible action, or a decision that is theirs to make — plus
 * code/quotes (stripped before matching).
 */
const ALLOWED_REASON_RE =
  /\b(?:secret|credential|api[\s-]?key|token|password|passphrase|2fa|mfa|oauth|log\s*in|login|sign[\s-]?in|account|billing|subscription|quota|rate[\s-]?limit|external|third[\s-]?party|network|vpn|firewall|dns|upstream|vendor|human\s+approval|approval\s+on|shared\s+prod|production\s+(?:db|database|data)|irreversible|destructive|force[\s-]?push|drop\s+(?:the\s+)?(?:table|database|db)|delete\s+(?:the\s+)?(?:prod|production|remote|branch|repo)|wipe|rm\s+-rf|purge|revoke|rotate\s+(?:the\s+)?(?:key|token|secret)|docker|container|simulator|emulator|device|hardware|gpu|not\s+installed|isn't\s+installed|missing\s+(?:binary|tool|dependency|runtime)|no\s+(?:docker|network|internet|display)|sandbox|EPERM|EACCES|permission\s+denied|(?:your|the\s+user'?s?)\s+(?:call|decision|choice|preference)|decide|decision|design\s+choice|product\s+(?:call|decision)|up\s+to\s+you|if\s+you\s+(?:prefer|want|like|disagree))\b/i;

/** Driver attestations — the drivers own their shape, not the homework rule. */
const ATTESTATION_RE =
  /\*\*Goal achieved\.\*\*|\*\*Cycle complete\.\*\*|\*\*Wave complete\.\*\*/i;
/** Same tokens, for stripping the marker off the outcome line. */
const ATTESTATION_TOKEN_RE =
  /\*\*(?:Goal achieved|Cycle complete|Wave complete)\.\*\*/gi;

/** Any driver attestation in the message. */
export function isAttestation(message: string): boolean {
  return ATTESTATION_RE.test(String(message || ""));
}

/**
 * Is this the closer of the whole run — the message the user reads first?
 * `**Goal achieved.**` always is. `**Cycle complete.**` is only when ULW is
 * winding down (`/cycle 0`) or already off; under cycle=1 it declares a wave
 * and the run continues.
 */
export function isTerminalAttestation(
  message: string,
  opts?: { ulwEnabled?: boolean; ulwCycle?: number },
): boolean {
  const msg = String(message || "");
  if (/\*\*Goal achieved\.\*\*/i.test(msg)) return true;
  if (!/\*\*Cycle complete\.\*\*/i.test(msg)) return false;
  return !opts?.ulwEnabled || opts.ulwCycle === 0;
}

export interface HomeworkDetection {
  homework: boolean;
  /** Offending lines (clipped). */
  lines: string[];
  match?: string;
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/** Detect homework handed back to the user. Pure — no I/O. */
export function detectHomework(message: string): HomeworkDetection {
  const text = stripCodeFences(String(message || ""));
  if (!text.trim()) return { homework: false, lines: [] };
  const offenders: string[] = [];
  let firstMatch: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (OPERATOR_RE.test(line)) continue;
    if (ALLOWED_REASON_RE.test(line)) continue;
    for (const re of HOMEWORK_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      offenders.push(line.length > 140 ? `${line.slice(0, 139)}…` : line);
      if (!firstMatch) firstMatch = m[0];
      break;
    }
  }
  return {
    homework: offenders.length > 0,
    lines: offenders.slice(0, 4),
    match: firstMatch,
  };
}

/**
 * A section label: a markdown heading, or a line that is nothing but a short
 * bold / underlined phrase (optionally with a trailing colon).
 *
 * Any label counts. The old check required labels from a fixed list
 * (`What shipped`, `Verified`, …), so a report a careful writer had already
 * sectioned as `## Changes` / `## Testing` / `## Caveats` was bounced and
 * told to re-write itself in harness-ese. The shape we need is "an outcome
 * sentence and sections", not those four words.
 */
const REPORT_LABEL_RE =
  /^\s*(?:#{1,6}\s+\S.{0,70}|\*\*[^*\n]{2,60}\*\*\s*:?|__[^_\n]{2,60}__\s*:?)\s*$/;

/** Count of bold / heading section labels a report is expected to have. */
export function countReportLabels(message: string): number {
  let n = 0;
  for (const line of String(message || "").split(/\r?\n/)) {
    if (REPORT_LABEL_RE.test(line)) n += 1;
  }
  return n;
}

/**
 * Does the closer look like a run-wide report: an outcome line near the top
 * (a sentence, not a heading-only stub) and at least two labelled sections?
 *
 * The first three non-empty lines are candidates, so a title ("## Summary"),
 * a section label, or a driver attestation (`**Cycle complete.**` on its own
 * line, the required opening of a ULW closer) does not read as a missing
 * outcome.
 */
export function looksLikeRunReport(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  if (countReportLabels(text) < 2) return false;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const raw of lines.slice(0, 3)) {
    // "## Summary" / "**What shipped**" as a title is fine — the sentence follows.
    if (/^#{1,4}\s/.test(raw) || REPORT_LABEL_RE.test(raw)) continue;
    // The outcome should be a sentence, not a bare attestation or a
    // last-round nit ("Fixed the typo.") shorter than a few words.
    const words = raw
      .replace(ATTESTATION_TOKEN_RE, " ")
      .replace(/[*#_`>-]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    if (words >= 4) return true;
  }
  return false;
}

export interface ReportStopInput {
  lastAssistantMessage: string;
  lastUserMessage?: string;
  /** Harness Stop re-anchors this run so far (review rounds). */
  stopContinues: number;
  editCount: number;
  /** ULW armed or session ultrawork flag. */
  ultrawork: boolean;
  goalActive: boolean;
  openTodoCount: number;
  /** Blocks already spent by this guard this run. */
  reportBlocks?: number;
  reportBlockCap?: number;
  /** Lazily built harness facts for the reanchor (run-report facts). */
  factsProvider?: () => string[];
}

export interface ReportStopDecision {
  block: boolean;
  released?: boolean;
  kind?: "homework" | "shape";
  reason?: string;
  reanchor?: string;
  homework?: HomeworkDetection;
}

function defaultCap(): number {
  const raw = process.env.FORGE_REPORT_BLOCK_CAP?.trim();
  if (raw === undefined || raw === "") return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.floor(n);
}

export function reportGuardEnabled(): boolean {
  const v = process.env.FORGE_REPORT_GUARD?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** Multi-round threshold: harness re-anchored at least this many times. */
export const REPORT_MULTI_ROUND_MIN = 2;

/** Harness facts block for a reanchor (empty when there is nothing to say). */
function factsLines(provider?: () => string[]): string[] {
  const facts = (() => {
    try {
      return (provider?.() || []).slice(0, 24);
    } catch {
      return [] as string[];
    }
  })();
  return facts.length
    ? [
        ``,
        `Harness facts for this run (use them; do not re-derive):`,
        ...facts.map((f) => `  ${f}`),
      ]
    : [];
}

/** The homework reanchor — shared by the attestation gate and step 8. */
function homeworkReanchor(
  homework: HomeworkDetection,
  facts: string[],
  closer: string,
): string {
  return [
    `[Forge report-guard] Stop blocked — the closing message hands work back to the user.`,
    ...homework.lines.map((l) => `  ↳ ${l}`),
    ``,
    `Never hand homework back. Do it now with tools (run the check, add the test, wire the config, finish the piece), then close.`,
    `The only things a closing message may leave to the user: a missing secret, a hard external or environment blocker, an irreversible action, or a decision that is theirs — each as its own line starting with \`Operator:\` and saying why.`,
    ...facts,
    ``,
    closer,
  ].join("\n");
}

const RUN_WIDE_CLOSER = `Then write the final report: one outcome sentence first, then sections under headings of your choosing (for example **What shipped** · **Verified** · **Not done** · **Needs you** — Operator: items or "Nothing"), covering the whole run since the user's request.`;

export interface AttestationReportInput {
  lastAssistantMessage: string;
  lastUserMessage?: string;
  /** ULW armed, and its cycle flag — a cycle=1 "Cycle complete." is a wave. */
  ulwEnabled?: boolean;
  ulwCycle?: number;
  /** Harness Stop re-anchors this run so far. */
  stopContinues?: number;
  editCount?: number;
  reportBlocks?: number;
  reportBlockCap?: number;
  factsProvider?: () => string[];
}

/**
 * The terminal attestation, checked before the goal / ULW drivers consume the
 * Stop. `**Cycle complete.**` after `/cycle 0` is the last thing the user
 * reads after a hundred waves: it may not hand homework back, and after a
 * multi-round run it may not be a bare "12 waves, all green" either.
 *
 * Blocking here leaves every driver's state untouched (no wave is spent, no
 * evidence nudge is consumed) — the model re-attests on the next round and
 * the driver releases as it would have.
 */
export function evaluateAttestationHomeworkAtStop(
  input: AttestationReportInput,
): ReportStopDecision {
  if (!reportGuardEnabled()) return { block: false };
  const msg = String(input.lastAssistantMessage || "");
  if (!msg.trim()) return { block: false };
  if (
    !isTerminalAttestation(msg, {
      ulwEnabled: input.ulwEnabled,
      ulwCycle: input.ulwCycle,
    })
  ) {
    return { block: false };
  }
  if (
    input.lastUserMessage &&
    looksLikeAdvisoryUserMessage(input.lastUserMessage)
  ) {
    return { block: false };
  }

  const homework = detectHomework(msg);
  const multiRound =
    (input.stopContinues ?? 0) >= REPORT_MULTI_ROUND_MIN &&
    (input.editCount ?? 0) > 0;
  const shapeMissing = multiRound && !looksLikeRunReport(msg);
  if (!homework.homework && !shapeMissing) return { block: false };

  const cap = input.reportBlockCap ?? defaultCap();
  const blocks = input.reportBlocks ?? 0;
  if (cap === 0) return { block: false, homework };
  if (blocks >= cap) {
    return {
      block: false,
      released: true,
      homework,
      reason: `Report-guard released after ${blocks} bounce${blocks === 1 ? "" : "s"}.`,
    };
  }

  const facts = factsLines(input.factsProvider);
  if (homework.homework) {
    const reanchor = homeworkReanchor(
      homework,
      facts,
      `Then re-attest with the same marker, and make the attestation the whole-run report: one outcome sentence, then sections (for example **What shipped** · **Verified** · **Not done** · **Needs you** — Operator: items or "Nothing").`,
    );
    return { block: true, kind: "homework", homework, reason: reanchor, reanchor };
  }

  const reanchor = [
    `[Forge report-guard] Stop blocked — after ${input.stopContinues} harness rounds the attestation covers only the close-out.`,
    `This message is the run's report and the user will not scroll. Re-attest with the same marker, then — under headings of your choosing, for example:`,
    `  1. One plain outcome sentence (done / partly done / blocked, and what they now have).`,
    `  2. **What shipped** — every wave since the mandate, not this close-out; numbers beside the thing they count.`,
    `  3. **Verified** — the commands you ran and their results.`,
    `  4. **Not done** — with why.`,
    `  5. **Needs you** — only \`Operator:\` items (secret / external blocker / irreversible / your decision), else "Nothing".`,
    `Bullets of one or two sentences, plain words a layman reads in one pass. No new work is required — report, then stop.`,
    ...facts,
  ].join("\n");
  return { block: true, kind: "shape", homework, reason: reanchor, reanchor };
}

export function evaluateReportAtStop(input: ReportStopInput): ReportStopDecision {
  if (!reportGuardEnabled()) return { block: false };
  const msg = String(input.lastAssistantMessage || "");
  if (!msg.trim()) return { block: false };

  const userAdvisory =
    Boolean(input.lastUserMessage) &&
    looksLikeAdvisoryUserMessage(input.lastUserMessage || "");
  const workInFlight =
    input.ultrawork ||
    input.goalActive ||
    input.openTodoCount > 0 ||
    input.editCount > 0;
  // Advisory Q&A is an answer, not a run: "you could add a test" is advice.
  if (userAdvisory) return { block: false };
  if (!workInFlight) return { block: false };

  const cap = input.reportBlockCap ?? defaultCap();
  const blocks = input.reportBlocks ?? 0;
  const homework = detectHomework(msg);
  const multiRound =
    input.stopContinues >= REPORT_MULTI_ROUND_MIN && input.editCount > 0;
  // A driver attestation owns its own shape (and is checked ahead of the
  // drivers by evaluateAttestationHomeworkAtStop) — only homework applies here.
  const shapeMissing =
    multiRound && !isAttestation(msg) && !looksLikeRunReport(msg);

  if (!homework.homework && !shapeMissing) return { block: false };
  if (cap > 0 && blocks >= cap) {
    return {
      block: false,
      released: true,
      homework,
      reason: `Report-guard released after ${blocks} bounce${blocks === 1 ? "" : "s"}.`,
    };
  }
  if (cap === 0) return { block: false, homework };

  const factsBlock = factsLines(input.factsProvider);

  if (homework.homework) {
    const reanchor = homeworkReanchor(homework, factsBlock, RUN_WIDE_CLOSER);
    return { block: true, kind: "homework", homework, reason: reanchor, reanchor };
  }

  const reanchor = [
    `[Forge report-guard] Stop blocked — after ${input.stopContinues} harness rounds the closing message covers only the last round.`,
    `The user will not scroll. Write a report of the whole run since their request that stands on its own — under headings of your choosing, for example:`,
    `  1. One plain outcome sentence first (done / partly done / blocked, and what they now have).`,
    `  2. **What shipped** — every change of the run, not the last fix; numbers beside the thing they count.`,
    `  3. **Verified** — the commands you ran and their results.`,
    `  4. **Not done** — with why.`,
    `  5. **Needs you** — only \`Operator:\` items (secret / external blocker / irreversible / your decision), else "Nothing".`,
    `Bullets of one or two sentences, plain words a layman reads in one pass. No new work is required — report, then stop.`,
    ...factsBlock,
  ].join("\n");
  return { block: true, kind: "shape", homework, reason: reanchor, reanchor };
}
