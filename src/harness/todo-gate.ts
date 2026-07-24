/**
 * Todo nudge + optional Stop gate (Grok Build–inspired).
 *
 * - Nudge: soft mid-turn reminder to use todo_write when ULW/goal is active
 *   and the model has gone several assistant steps without updating todos.
 * - Gate: at Stop, block when ULW is armed and open todos remain without
 *   cycle/goal attestation (complements ultrawork backstop in stop-guard).
 */

export interface TodoNudgeState {
  /** Assistant turns (tool-or-text) since last successful todo_write */
  turnsSinceTodoWrite: number;
  /** Nudges fired this user prompt */
  nudgesThisPrompt: number;
  lastTodoWriteAtTurn: number;
}

export interface TodoNudgeConfig {
  enabled: boolean;
  /** Turns without todo_write before first nudge */
  turnsSinceTodoWrite: number;
  /** Minimum turns between nudges */
  turnsBetweenReminders: number;
  /** Cap nudges per user prompt */
  maxNudgesPerPrompt: number;
}

export interface TodoGateConfig {
  /** When true (default under ULW), open todos block Stop without attestation */
  enabled: boolean;
  maxFiresPerPrompt: number;
}

export const DEFAULT_TODO_NUDGE: TodoNudgeConfig = {
  enabled: true,
  turnsSinceTodoWrite: 3,
  turnsBetweenReminders: 5,
  maxNudgesPerPrompt: 2,
};

export const DEFAULT_TODO_GATE: TodoGateConfig = {
  enabled: true,
  maxFiresPerPrompt: 3,
};

const nudgeBySession = new Map<string, TodoNudgeState>();
const gateFiresBySession = new Map<string, number>();

export function getTodoNudgeState(sessionId: string): TodoNudgeState {
  let s = nudgeBySession.get(sessionId);
  if (!s) {
    s = {
      turnsSinceTodoWrite: 0,
      nudgesThisPrompt: 0,
      lastTodoWriteAtTurn: 0,
    };
    nudgeBySession.set(sessionId, s);
  }
  return s;
}

/** Call at the start of each user-driven agent loop. */
export function resetTodoNudgeForPrompt(sessionId: string): void {
  const s = getTodoNudgeState(sessionId);
  s.nudgesThisPrompt = 0;
  gateFiresBySession.set(sessionId, 0);
}

export function noteTodoWrite(sessionId: string, turn: number): void {
  const s = getTodoNudgeState(sessionId);
  s.turnsSinceTodoWrite = 0;
  s.lastTodoWriteAtTurn = turn;
}

export function noteAssistantTurn(sessionId: string): void {
  const s = getTodoNudgeState(sessionId);
  s.turnsSinceTodoWrite += 1;
}

/**
 * Maybe produce a soft todo nudge message. Returns null when not needed.
 */
export function maybeTodoNudge(opts: {
  sessionId: string;
  harnessActive: boolean;
  openTodoCount: number;
  config?: Partial<TodoNudgeConfig>;
}): string | null {
  const cfg = { ...DEFAULT_TODO_NUDGE, ...opts.config };
  if (!cfg.enabled || !opts.harnessActive) return null;

  const s = getTodoNudgeState(opts.sessionId);
  if (s.nudgesThisPrompt >= cfg.maxNudgesPerPrompt) return null;
  if (s.turnsSinceTodoWrite < cfg.turnsSinceTodoWrite) return null;

  // Space out nudges
  if (
    s.nudgesThisPrompt > 0 &&
    s.turnsSinceTodoWrite <
      cfg.turnsSinceTodoWrite + cfg.turnsBetweenReminders * s.nudgesThisPrompt
  ) {
    return null;
  }

  s.nudgesThisPrompt += 1;
  s.turnsSinceTodoWrite = 0; // reset streak so turnsBetween applies

  const openHint =
    opts.openTodoCount > 0
      ? `${opts.openTodoCount} open todo(s) on the board — advance or close them.`
      : `No todos recorded yet — create a short wave plan with todo_write, then execute.`;

  return [
    `[Forge system-reminder — TodoNudge]`,
    `Multi-step harness work is active and it has been several turns without todo_write.`,
    openHint,
    `Update todos now, then continue. Do not stop solely to discuss the plan.`,
  ].join("\n");
}

export function getTodoGateFires(sessionId: string): number {
  return gateFiresBySession.get(sessionId) ?? 0;
}

export function incrementTodoGateFires(sessionId: string): number {
  const n = (gateFiresBySession.get(sessionId) ?? 0) + 1;
  gateFiresBySession.set(sessionId, n);
  return n;
}

/** Test helpers */
export function clearTodoGateState(sessionId?: string): void {
  if (sessionId) {
    nudgeBySession.delete(sessionId);
    gateFiresBySession.delete(sessionId);
  } else {
    nudgeBySession.clear();
    gateFiresBySession.clear();
  }
}

const ATTEST_RE =
  /\*\*Goal achieved\.\*\*|\*\*Cycle complete\.\*\*|\*\*Wave complete\.\*\*|all tasks complete/i;

/**
 * Evaluate todo gate at Stop. Returns block message or null to allow.
 */
export function evaluateTodoGateAtStop(opts: {
  sessionId: string;
  ulwEnabled: boolean;
  ultraworkFlag: boolean;
  openTodoCount: number;
  lastAssistantMessage: string;
  config?: Partial<TodoGateConfig>;
}): { block: boolean; reason?: string; reanchor?: string } {
  const cfg = { ...DEFAULT_TODO_GATE, ...opts.config };
  if (!cfg.enabled) return { block: false };
  if (!opts.ulwEnabled && !opts.ultraworkFlag) return { block: false };
  if (opts.openTodoCount <= 0) return { block: false };
  if (ATTEST_RE.test(opts.lastAssistantMessage || "")) return { block: false };

  const fires = getTodoGateFires(opts.sessionId);
  if (fires >= cfg.maxFiresPerPrompt) {
    return { block: false }; // cap reached — release to avoid infinite loop
  }

  incrementTodoGateFires(opts.sessionId);
  const msg = [
    `[Forge TodoGate] Stop blocked — ${opts.openTodoCount} open todo(s) remain.`,
    `Complete, cancel with reason, or finish the wave and attest **Cycle complete.** / **Goal achieved.**`,
    `TodoGate fire ${fires + 1}/${cfg.maxFiresPerPrompt} this prompt.`,
  ].join("\n");

  return { block: true, reason: msg, reanchor: msg };
}
