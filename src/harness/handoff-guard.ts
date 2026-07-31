/**
 * Premature handoff / yield detector (oh-my-kimi "Finish, don't hand off").
 *
 * Models often stop mid-mandate with "let me know if you want me to continue"
 * or "shall I proceed?" — forcing the user to re-steer. Under ULW/goal/open
 * todos (or when the turn already mutated files), that is a harness failure:
 * Stop is blocked and the agent is told to finish what only it can do.
 *
 * Pure Q&A closers ("let me know if you have questions") still allow Stop
 * when there is no active driver and no in-flight work signal.
 */
import { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";

/** Soft Q&A closers — not a request for permission to keep working. */
const QA_CLOSER_RE =
  /\blet me know if you have (?:any )?(?:questions|feedback|concerns)\b|\bfeel free to ask(?:\s+(?:me\s+)?(?:if|anything|questions))?\b|\bhappy to (?:help|clarify)(?:\s+if needed)?\b/i;

/**
 * Hard "please re-steer me" / permission-to-continue closers.
 * Order matters only for match reporting — first hit wins.
 */
const HANDOFF_PATTERNS: RegExp[] = [
  // Explicit continue / implement permission asks
  /\bshall I (?:continue|proceed|keep going|go ahead|finish|implement|fix|ship|start)\b/i,
  /\bshould I (?:continue|proceed|keep going|go ahead|finish|implement|fix|ship|start)\b/i,
  /\bshould I keep (?:going|working)\b/i,
  /\bwant me to (?:continue|proceed|keep going|finish|implement|fix|ship|start)\b/i,
  /\bwant me to keep going\b/i,
  /\bdo you want me to\b/i,
  /\bwould you like me to\b/i,
  /\bif you(?:'d| would)? like me to\b/i,
  /\bif you want me to\b/i,
  /\blet me know if you (?:want|would like|need)(?:\s+me)?\b/i,
  /\blet me know (?:how|what) you(?:'d| would)? like\b/i,
  /\b(?:please\s+)?(?:just\s+)?(?:let me|ping me|tell me) if you (?:want|would like|need)\b/i,
  /\bhappy to continue\b/i,
  /\bI can continue if\b/i,
  /\bI(?:'ll| will) (?:wait|pause)(?: here)?\b/i,
  /\bawaiting your (?:go[- ]?ahead|approval|confirmation|input|direction)\b/i,
  /\bwaiting (?:for|on) your (?:go[- ]?ahead|approval|confirmation|input|direction)\b/i,
  /\bready when you are\b/i,
  /\bjust say the word\b/i,
  /\bsay the word (?:and|if)\b/i,
  /\bping me (?:when|if)\b/i,
  /\bfeel free to (?:tell|ask) me to\b/i,
  /\bI(?:'ll| will) stop here\b/i,
  /\bstopping here(?: for now)?\b/i,
  /\bI(?:'ll| will) pause here\b/i,
  // Generic "let me know if…" that is NOT a pure Q&A closer (checked below)
  /\blet me know if\b/i,
];

/** Signals the agent itself admits work remains. */
const INCOMPLETE_MARKERS_RE =
  /\b(?:still need to|still have to|not yet done|not yet finished|haven't (?:yet )?(?:finished|done|implemented)|remaining work|next step(?:s)? (?:would|will|is|are)|partial(?:ly)? (?:done|complete|fixed)|left to do|more to do|work remains|unfinished|I(?:'ll| will) (?:do|implement|fix|add|write) (?:that|this|it) next|I(?:'ll| will) (?:start|begin|continue) by (?:reading|checking|inspecting|looking|investigating|scanning|grepping|searching|opening|editing|fixing|implementing|running|writing)|let me (?:start by |begin by )?(?:investigate|look into|check|read|inspect|scan|grep|search|open|edit|fix|implement|run)|looking into this|investigating now|starting with (?:the |reading |checking |inspecting ))\b/i;

/** Terminal attestations — never block these as handoffs. */
const ATTESTATION_RE =
  /\*\*Goal achieved\.\*\*|\*\*Cycle complete\.\*\*|all tasks complete|all acceptance criteria (?:met|passed)/i;

export interface HandoffDetection {
  handoff: boolean;
  /** First matched pattern source (debug / tests). */
  match?: string;
  /** True when message also admits incomplete work. */
  incomplete?: boolean;
  /** Soft Q&A closer without a hard handoff ask. */
  qaCloser?: boolean;
}

/**
 * Detect premature yield / handoff language in an assistant closeout.
 * Pure function — no I/O.
 */
export function detectPrematureHandoff(message: string): HandoffDetection {
  const text = String(message || "").trim();
  if (!text) return { handoff: false };

  if (ATTESTATION_RE.test(text)) {
    return { handoff: false };
  }

  const incomplete = INCOMPLETE_MARKERS_RE.test(text);
  const qaCloser = QA_CLOSER_RE.test(text);

  for (const re of HANDOFF_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const matched = m[0];
    // Carve out pure Q&A: "let me know if you have questions" hits the generic
    // "let me know if" pattern but is not a permission-to-continue ask.
    if (
      /^let me know if$/i.test(matched.trim()) &&
      qaCloser &&
      !/\blet me know if you (?:want|would like|need)\b/i.test(text)
    ) {
      continue;
    }
    return {
      handoff: true,
      match: matched,
      incomplete,
      qaCloser,
    };
  }

  // Incomplete admission without an explicit handoff phrase still yields when
  // the model stops mid-task ("Next step would be to add tests.").
  if (incomplete) {
    return {
      handoff: true,
      match: "incomplete-marker",
      incomplete: true,
      qaCloser,
    };
  }

  return { handoff: false, qaCloser };
}

export interface HandoffStopInput {
  lastAssistantMessage: string;
  /** Latest user message — advisory Q&A softens continue-ask blocks. */
  lastUserMessage?: string;
  /** ULW cycle armed or session ultrawork flag. */
  ultrawork: boolean;
  /** Active (unpaused) goal objective present. */
  goalActive: boolean;
  openTodoCount: number;
  /** Session file-mutation count (any prior edits this session). */
  editCount: number;
  /**
   * How many times handoff already blocked this process turn streak.
   * After the cap, release so a stuck polite model cannot infinite-loop.
   */
  handoffBlocks?: number;
  /** Override cap (default 3). 0 = never release on handoff alone. */
  handoffBlockCap?: number;
  /**
   * Preferred project check commands (project-intel). Named in the reanchor
   * so the agent verifies instead of asking the user what to run.
   */
  preferredCheckCommands?: string[];
}

export interface HandoffStopDecision {
  block: boolean;
  /** Released after repeated handoff blocks (stuck polite model). */
  released?: boolean;
  reason?: string;
  reanchor?: string;
  detection?: HandoffDetection;
}

function defaultHandoffCap(): number {
  const raw = process.env.FORGE_HANDOFF_BLOCK_CAP?.trim();
  if (raw === undefined || raw === "") return 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.floor(n);
}

/**
 * Evaluate whether Stop should be blocked for a premature handoff.
 *
 * Blocks when handoff/incomplete language is present AND there is an active
 * driver or in-flight work signal (ULW, goal, open todos, prior edits with
 * incomplete markers). Soft Q&A closers alone never block outside a driver.
 * Hard continue-asks ("shall I implement…?") block even on greenfield turns
 * so the agent does the work instead of re-prompting.
 */
export function evaluateHandoffAtStop(
  input: HandoffStopInput,
): HandoffStopDecision {
  const detection = detectPrematureHandoff(input.lastAssistantMessage);
  if (!detection.handoff) {
    return { block: false, detection };
  }

  // Pure Q&A turns: allow soft continue-asks ("let me know if you want me to
  // implement") — that is a valid advisory closer, not a premature yield.
  // Still block incomplete mid-implementation markers when edits happened.
  const userAdvisory =
    Boolean(input.lastUserMessage) &&
    looksLikeAdvisoryUserMessage(input.lastUserMessage || "");
  if (userAdvisory) {
    const hardIncomplete =
      Boolean(detection.incomplete) && input.editCount > 0;
    if (!hardIncomplete) {
      return { block: false, detection };
    }
  }

  const hasDriver =
    input.ultrawork || input.goalActive || input.openTodoCount > 0;

  const hardContinue =
    detection.match !== "incomplete-marker" &&
    /\b(?:shall I|should I|want me to|would you like me to|do you want me to|if you(?:'d| would)? like me to|if you want me to|let me know if you (?:want|would like|need)|happy to continue|I can continue if|awaiting your|waiting (?:for|on) your|ready when you are|just say the word|I(?:'ll| will) stop here|stopping here|I(?:'ll| will) pause here)\b/i.test(
      input.lastAssistantMessage || "",
    );

  // Outside any driver: allow soft incomplete advice without edits; block hard
  // continue-asks always; block incomplete/handoff when edits already happened.
  if (!hasDriver) {
    const midImplementation =
      input.editCount > 0 && (Boolean(detection.incomplete) || hardContinue);
    if (!midImplementation && !hardContinue) {
      return { block: false, detection };
    }
  }

  // Cap: repeated handoff without progress → release (stuck polite model)
  const cap =
    input.handoffBlockCap !== undefined
      ? input.handoffBlockCap
      : defaultHandoffCap();
  const blocks = input.handoffBlocks ?? 0;
  if (cap > 0 && blocks >= cap) {
    return {
      block: false,
      released: true,
      detection,
      reason: `Handoff-guard released after ${blocks} polite-yield Stop attempts. Continue manually if work remains.`,
    };
  }

  const matchNote = detection.match ? `Matched: “${detection.match}”.` : "";
  const driverNote = hasDriver
    ? "An active harness driver (ULW / goal / open todos) requires finishing, not re-prompting the user."
    : "In-flight work or a permission-to-continue ask was detected — finish it or name a real external blocker.";

  const preferred = (input.preferredCheckCommands || [])
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const verifyLine = preferred.length
    ? `  • verify with: ${preferred.join("  ·  ")}`
    : `  • verify with the cheapest project check (test/typecheck)`;

  const reanchor = [
    `[Forge handoff-guard] Stop blocked — premature yield / handoff.`,
    matchNote,
    driverNote,
    ``,
    `Finish, don't hand off. What remains for the user must be something only the user can do:`,
    `  • a credential or secret you cannot access`,
    `  • a hard external blocker (network, missing service, human approval on shared prod)`,
    `  • destructive shared-state confirmation the user did not already grant`,
    `  • foreign in-progress work you cannot interpret`,
    ``,
    `There is no fifth reason to stop short. Do NOT ask “shall I continue?” or “let me know if…”.`,
    `Continue with tools now: implement the next concrete step, verify, and only stop when the mandate is resolved`,
    `(or attest **Goal achieved.** / **Cycle complete.** when a driver is armed).`,
    verifyLine,
  ].join("\n");

  return {
    block: true,
    detection,
    reason: reanchor,
    reanchor,
  };
}
