/**
 * One user-channel proof speaker per prompt.
 *
 * Verify-nudge, fix-until-green, and ULW Stop proof-demand used to stack
 * as three separate user turns after a red check. This module is the
 * in-loop gate — do not turn those systems off; dedup the channel.
 */

export type ProofPokeKind = "fix" | "verify" | "ulw-stop";

export interface ProofPokeState {
  /** At most one user-channel proof poke this prompt. */
  pokedThisPrompt: boolean;
  kind?: ProofPokeKind;
  /** Red check started a repair — suppress verify-nudge until green or N edits. */
  proofInFlight: boolean;
  editsAtProofStart?: number;
}

/** Extra edits after a red check before verify-nudge may speak again. */
export const PROOF_IN_FLIGHT_EDIT_GRACE = 8;

const PROOF_POKE_PREFIXES = [
  "[Forge harness — verify nudge]",
  "[Forge harness — fix until green]",
] as const;

export function createProofPokeState(): ProofPokeState {
  return { pokedThisPrompt: false, proofInFlight: false };
}

export function lastUserIsProofPoke(content: string | undefined): boolean {
  const t = String(content || "").trimStart();
  if (!t) return false;
  if (PROOF_POKE_PREFIXES.some((p) => t.startsWith(p))) return true;
  // ULW re-anchor that is already demanding proof — not a second speaker.
  return (
    t.startsWith("[Forge ULW cycle driver]") &&
    /proof NOW|Verification failed|attestation needs evidence|check failed/i.test(
      t,
    )
  );
}

export function noteRedVerification(
  state: ProofPokeState,
  editCount: number,
): void {
  state.proofInFlight = true;
  state.editsAtProofStart = editCount;
}

export function noteGreenVerification(state: ProofPokeState): void {
  state.proofInFlight = false;
  state.editsAtProofStart = undefined;
}

export function noteUlwProofDemand(state: ProofPokeState): void {
  state.proofInFlight = true;
  state.pokedThisPrompt = true;
  state.kind = "ulw-stop";
}

export function noteFixUntilGreen(state: ProofPokeState): void {
  state.pokedThisPrompt = true;
  state.kind = "fix";
}

export function noteVerifyNudge(state: ProofPokeState): void {
  state.pokedThisPrompt = true;
  state.kind = "verify";
}

export function shouldEmitFixUntilGreen(
  state: ProofPokeState,
  opts: { lastUserContent?: string },
): boolean {
  if (state.pokedThisPrompt) return false;
  if (lastUserIsProofPoke(opts.lastUserContent)) return false;
  return true;
}

export function shouldEmitVerifyNudge(
  state: ProofPokeState,
  opts: { lastUserContent?: string; editCount: number },
): boolean {
  if (state.pokedThisPrompt) return false;
  if (lastUserIsProofPoke(opts.lastUserContent)) return false;
  if (state.proofInFlight) {
    const start = state.editsAtProofStart ?? 0;
    if (opts.editCount - start < PROOF_IN_FLIGHT_EDIT_GRACE) return false;
    // Grace expired — allow one verify, then the poke latch holds.
  }
  return true;
}
