/**
 * Proof-claim guard — "don't claim, prove" (oh-my-claude quality-claims).
 *
 * Models often close with "tests pass" / "all green" / "typecheck clean"
 * without having executed a verification command. Experts then re-steer:
 * "did you actually run the tests?" This guard blocks Stop once when a
 * success claim is present, no structural verificationRan signal fired,
 * and there is in-flight work (edits / goal / ULW / open todos).
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

/** Terminal attestations with their own evidence path — skip here. */
const ATTESTATION_RE =
  /\*\*Goal achieved\.\*\*|\*\*Cycle complete\.\*\*|\*\*Wave complete\.\*\*/i;

export interface ProofClaimDetection {
  claim: boolean;
  match?: string;
}

export function detectProofClaim(message: string): ProofClaimDetection {
  const text = String(message || "").trim();
  if (!text) return { claim: false };
  if (ATTESTATION_RE.test(text)) return { claim: false };
  const m = text.match(PROOF_CLAIM_RE);
  if (!m) return { claim: false };
  return { claim: true, match: m[0] };
}

export interface ProofClaimStopInput {
  lastAssistantMessage: string;
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

  // Secondary: message already cites command+outcome via shared detector —
  // still block if it's only a claim without verificationRan? detectWaveProof
  // without verificationRan is prose-only; we still want a real run when
  // edits happened. Use our stronger claim detector.
  const detection = detectProofClaim(input.lastAssistantMessage);
  if (!detection.claim) {
    return { block: false, detection };
  }

  // Also accept detectWaveProof prose as a claim signal when edits exist
  // (covers "✅ tests" style that PROOF_CLAIM_RE might miss).
  const waveProofProse = detectWaveProof(input.lastAssistantMessage, false);
  if (!detection.claim && !waveProofProse) {
    return { block: false, detection };
  }

  const workInFlight =
    input.ultrawork ||
    input.goalActive ||
    input.openTodoCount > 0 ||
    input.editCount > 0;

  if (!workInFlight) {
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

  const matchNote = detection.match
    ? `Claimed: “${detection.match}”.`
    : "A verification success claim was detected.";

  const reanchor = [
    `[Forge proof-claim] Stop blocked — verification claimed without running it.`,
    matchNote,
    `No verification command (test/typecheck/lint/build) executed this turn streak.`,
    ``,
    `Don't claim, prove. Run the cheapest relevant check NOW:`,
    `  • npm test / npm run typecheck / pytest / cargo test / go test / tsc`,
    `  • then continue or stop with the real result (pass or fail + next fix)`,
    ``,
    `Prose like "all green" without a command is not evidence. The harness tracks`,
    `structural verificationRan — execution, not judgment.`,
  ].join("\n");

  return {
    block: true,
    detection,
    reason: reanchor,
    reanchor,
  };
}
