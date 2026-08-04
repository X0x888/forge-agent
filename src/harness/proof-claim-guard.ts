import { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";
/**
 * Proof-claim guard — "don't claim, prove" (oh-my-claude quality-claims).
 *
 * Models often close with "tests pass" / "all green" / "typecheck clean"
 * without having executed a verification command. Experts then re-steer:
 * "did you actually run the tests?" This guard blocks Stop once when a
 * success claim is present, no structural verificationRan signal fired,
 * and there is in-flight work (edits / goal / ULW / open todos).
 *
 * Outside ULW/goal, a silent stop after file edits with no successful check
 * is the same expert friction (oh-my-kimi free-triage "unverified change"):
 * block once with preferred checks + self-audit — no claim prose required.
 *
 * ULW already has its own proof-demand path; this covers goal-only and
 * plain implementation turns. Cap defaults to 1 so a stuck claim cannot
 * infinite-loop (FORGE_PROOF_CLAIM_BLOCK_CAP).
 */

import { detectWaveProof } from "./ulw-cycle.js";

/**
 * Strong success claims that imply a check already ran.
 * Broader than "I should run tests" — only block when the model asserts outcome.
 */
const PROOF_CLAIM_RE =
  /\b(?:all\s+)?(?:tests?|specs?|checks?)\s+(?:pass(?:es|ed|ing)?|green|succeed(?:ed)?|ok|clean|are green)\b|\b(?:pass(?:es|ed|ing)?|green|succeed(?:ed)?)\b[^\n]{0,40}?\b(?:tests?|specs?|checks?)\b|\b\d+\s+(?:tests?|specs?|checks?)\s+(?:pass(?:ed)?|ok|green)\b|\b(?:typecheck|type-check|typechecks|tsc|lint|build|ci)\s+(?:pass(?:es|ed|ing)?|clean(?:ly)?|green|ok|succeed(?:ed)?|no errors?)\b|\b(?:npm|pnpm|yarn|bun|pytest|jest|vitest|cargo|go)\s+(?:test|typecheck|lint|build)\b[^\n]{0,40}?\b(?:pass(?:ed|ing)?|green|ok|clean|exit\s*0)\b|\bverified (?:with|via|using)\s+(?:npm|pnpm|yarn|bun)\s+(?:test|typecheck|lint|build)\b|\bverified (?:with|via|using)\s+(?:pytest|jest|vitest|cargo\s+test|go\s+test|tsc|the\s+(?:test|suite|checks?)|(?:test|typecheck|lint|build)\s+suite|tests?|checks?)\b|\ball (?:checks?|tests?|specs?)\s+(?:are\s+)?green\b|\ball green\b|\bno (?:type )?errors?\b|\bexit(?:\s*code)?\s*0\b/i;

/**
 * Done/fixed closers that imply the work is verified when edits happened.
 * Only used when editCount > 0 (or ULW/goal/todos) — pure Q&A "I'm done
 * explaining" must not bounce. Cap still applies (default 1).
 */
const DONE_WITHOUT_PROOF_RE =
  /(?:^|\n)\s*(?:✅\s*)?(?:done|fixed|complete|completed|finished|shipped|ready(?:\s+to\s+merge)?|all set|lgtm|looks good)\s*[.!]?\s*$/im;

/** Terminal attestations with their own evidence path — skip here. */
const ATTESTATION_RE =
  /\*\*Goal achieved\.\*\*|\*\*Cycle complete\.\*\*|\*\*Wave complete\.\*\*/i;

export interface ProofClaimDetection {
  claim: boolean;
  match?: string;
}

export function detectProofClaim(
  message: string,
  opts?: { allowDoneClosers?: boolean },
): ProofClaimDetection {
  const text = String(message || "").trim();
  if (!text) return { claim: false };
  if (ATTESTATION_RE.test(text)) return { claim: false, match: "attestation" };
  const m = text.match(PROOF_CLAIM_RE);
  if (m) return { claim: true, match: m[0] };
  // Done/fixed closers only when caller says work is in flight (edits/etc).
  if (opts?.allowDoneClosers) {
    const d = text.match(DONE_WITHOUT_PROOF_RE);
    if (d) return { claim: true, match: d[0].trim() };
  }
  return { claim: false };
}

export interface ProofClaimStopInput {
  lastAssistantMessage: string;
  /** Latest user message — advisory Q&A softens bare Done./Fixed. closers. */
  lastUserMessage?: string;
  /** Structural: a verification bash command ran this wave/turn streak. */
  verificationRan: boolean;
  ultrawork: boolean;
  goalActive: boolean;
  openTodoCount: number;
  editCount: number;
  /**
   * How many times this guard already blocked this process turn streak.
   * After the cap, release (default 1).
   */
  proofClaimBlocks?: number;
  proofClaimBlockCap?: number;
  /**
   * Preferred project check commands (from project-intel). When set, the
   * reanchor names the real commands instead of a generic npm/pytest list.
   */
  preferredCheckCommands?: string[];
  /** Last successful verification command (session trail). */
  lastVerificationCommand?: string;
  /** True when last-verify is older than the latest file edit. */
  lastVerificationStale?: boolean;
}

export interface ProofClaimStopDecision {
  block: boolean;
  released?: boolean;
  reason?: string;
  reanchor?: string;
  detection?: ProofClaimDetection;
}

function defaultCap(): number {
  const raw = process.env.FORGE_PROOF_CLAIM_BLOCK_CAP?.trim();
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.floor(n);
}

/**
 * Block Stop when the assistant claims verification success without a
 * structural verification run, and work is in flight.
 */
export function evaluateProofClaimAtStop(
  input: ProofClaimStopInput,
): ProofClaimStopDecision {
  // Structural proof already present — never block.
  if (input.verificationRan) {
    return { block: false };
  }

  const workInFlight =
    input.ultrawork ||
    input.goalActive ||
    input.openTodoCount > 0 ||
    input.editCount > 0;

  // Secondary: message already cites command+outcome via shared detector —
  // still block if it's only a claim without verificationRan? detectWaveProof
  // without verificationRan is prose-only; we still want a real run when
  // edits happened. Use our stronger claim detector.
  // Done/fixed closers only count when work is in flight (edits/ULW/goal/todos).
  const userAdvisory =
    Boolean(input.lastUserMessage) &&
    looksLikeAdvisoryUserMessage(input.lastUserMessage || "");
  let detection = detectProofClaim(input.lastAssistantMessage, {
    // Bare Done./Fixed. after a pure Q&A turn is a Q&A closer, not a work claim.
    allowDoneClosers:
      workInFlight && input.editCount > 0 && !userAdvisory,
  });
  // Terminal attestations (**Goal achieved.** / **Cycle complete.**) own their
  // evidence path — never bounce them via done-closers or wave-proof prose.
  if (detection.match === "attestation") {
    return { block: false, detection: { claim: false } };
  }
  let silentUnverified = false;
  if (!detection.claim) {
    // Also accept detectWaveProof prose as a claim signal when edits exist
    // (covers "✅ tests" style that PROOF_CLAIM_RE might miss).
    const waveProofProse = detectWaveProof(input.lastAssistantMessage, false);
    if (waveProofProse) {
      // Treat prose wave-proof as a claim so reanchor matchNote is non-empty.
      detection = { claim: true, match: "wave-proof prose" };
    } else if (
      // Free-triage cheap signal (oh-my-kimi): plain session stopped after
      // edits with no successful structural check and no success claim.
      // ULW/goal own their proof/attestation paths — do not double-block.
      input.editCount > 0 &&
      !input.ultrawork &&
      !input.goalActive &&
      !userAdvisory
    ) {
      silentUnverified = true;
      detection = { claim: true, match: "edits without verification" };
    } else {
      return { block: false, detection };
    }
  }

  if (!workInFlight && !silentUnverified) {
    // Pure Q&A "tests usually pass when…" — allow
    return { block: false, detection };
  }

  const cap =
    input.proofClaimBlockCap !== undefined
      ? input.proofClaimBlockCap
      : defaultCap();
  const blocks = input.proofClaimBlocks ?? 0;
  if (cap > 0 && blocks >= cap) {
    return {
      block: false,
      released: true,
      detection,
      reason: `Proof-claim guard released after ${blocks} claim-without-run Stop attempt(s). Continue manually if verification is still needed.`,
    };
  }

  const matchNote = silentUnverified
    ? `Silent stop after ${input.editCount} file edit(s) with no successful verification this turn streak.`
    : detection.match
      ? `Claimed: “${detection.match}”.`
      : "A verification success claim was detected.";

  const preferred = (input.preferredCheckCommands || [])
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const checkLine = preferred.length
    ? `  • ${preferred.join("  ·  ")}`
    : `  • npm test / npm run typecheck / pytest / cargo test / go test / tsc`;

  const last = input.lastVerificationCommand?.trim();
  const trailNote = last
    ? input.lastVerificationStale
      ? `Session last-verify \`${last.slice(0, 60)}\` is STALE (edits after it) — re-run before claiming green.`
      : `Session last-verify \`${last.slice(0, 60)}\` is not enough alone — a successful check must run this turn streak.`
    : `No session last-verify trail — run a successful project check this turn.`;

  const reanchor = [
    silentUnverified
      ? `[Forge proof-claim] Stop blocked — edits without verification (free triage).`
      : `[Forge proof-claim] Stop blocked — verification claimed without running it.`,
    matchNote,
    `No successful verification command (test/typecheck/lint/build) this turn streak.`,
    trailNote,
    ``,
    preferred.length
      ? `Don't claim, prove. Run a project check NOW (preferred for this workspace):`
      : `Don't claim, prove. Run the cheapest relevant check NOW:`,
    checkLine,
    `  • then continue or stop with the real result (pass or fail + next fix)`,
    ``,
    `Self-audit (answer from the diff + commands that actually ran, not memory):`,
    `  1. Completeness — what did the request imply that you did not deliver?`,
    `  2. Evidence — which closing claim has no command/file that proves it?`,
    `  3. Framing — what rival reading did you pass on, and why is yours right?`,
    `  4. Tests — for each test touched, what breaks to make it go red?`,
    `  5. Fit — which neighbouring file did you compare the change against?`,
    `  6. Consequence — grep changed symbols; does every hit still make sense?`,
    ``,
    `Prose like "all green" without a command is not evidence. The harness tracks`,
    `structural verificationRan — execution, not judgment. Settle the check + audit, then close.`,
  ].join("\n");

  return {
    block: true,
    detection,
    reason: reanchor,
    reanchor,
  };
}

/**
 * Tips stamped on session `lastError` when the proof-claim guard releases
 * after its cap. Prefer the workspace's check commands over npm-hardcoded
 * examples so Python/Rust/Go/monorepo projects get useful resume orientation.
 */
export function proofClaimReleaseTips(
  preferredCheckCommands?: string[] | null,
): string[] {
  const cmds = (preferredCheckCommands || []).map((c) => String(c || "").trim()).filter(Boolean);
  const verifyTip = cmds.length
    ? `${cmds.slice(0, 2).join("  ·  ")}  ·  /retry`
    : "run the project check  ·  /retry";
  return ["Run the verification command, then continue", verifyTip];
}
