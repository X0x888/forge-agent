import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  forgeHome,
  ensureDir,
  readJsonFile,
  writeJsonFile,
  nowIso,
} from "../util/fs.js";
import { editDistance } from "../util/string-distance.js";
import { suggestName } from "../util/suggest.js";
import {
  formatRelativeTime,
  estimateCostUsd,
  formatCost,
  clipAnsi,
  visibleWidth,
  formatToolDisplayName,
} from "../util/format.js";
import {
  costCapStatus,
  formatCostBudgetLine,
} from "../util/cost-budget.js";
import { getGitSnapshot } from "../util/git-context.js";
import { detectProjectIntel } from "../util/project-intel.js";
import { countProjectSkills } from "../agent/project-skills.js";
import type { ChatMessage } from "../providers/types.js";
import type { PermissionMode } from "../config/types.js";
import {
  filterFallbackChain,
  formatFallbackChain,
} from "../config/model-fallback.js";
import { heartbeatSession } from "../statusline/active.js";
import { touchSessionLock } from "./lock.js";
import {
  familyCostBreakdown,
  formatFamilyCostLines,
  normalizeSubagentUsage,
  type SubagentUsageRecord,
} from "./subagent-usage.js";
import { normalizeExploreMaps } from "./explore-map.js";
import { normalizeRequestPruneSticky } from "./request-prune.js";
import { isLastErrorProblem, sitDownNextForLastError } from "./last-error.js";
export {
  LAST_ERROR_OUTCOME_CODES,
  isLastErrorProblem,
  sitDownKeyFromTip,
  sitDownKeyFromCode,
  sitDownKeys,
  sitDownNextForLastError,
  retryRefusedNext,
} from "./last-error.js";
import {
  compactMessagesStructured,
  type CompactContext,
} from "./compaction.js";
import {
  clearFileReadsForSession,
  fileReadsForSession,
  forgetFileReadsSession,
} from "../agent/tools/file-read-state.js";
import { repairToolCallPairing } from "./message-repair.js";
import {
  restoreMutationsAfterTurn,
  editTrailFromMutations,
  copyFileMutations,
  clearFileMutations,
  type RestoreMutationsResult,
} from "./mutations.js";
import {
  copyUlwCycle,
  loadUlwCycle,
  resetUlwOnClear,
  isPlaceholderMandate,
  mandateFromUserText,
} from "../harness/ulw-cycle.js";
import { listActiveProjectMemory } from "../harness/project-memory.js";
import { copyGoal, loadGoal, saveGoal } from "../harness/goal.js";
import {
  copyDecisionMemory,
  clearDecisionMemory,
} from "../harness/decision-memory.js";

/** Max stored session title length (CLI --title / sessions title / /title). */
export const MAX_SESSION_TITLE_CHARS = 200;

export {
  compactMessagesStructured,
  buildStructuredSummary,
  pruneOversizedMessageBodies,
} from "./compaction.js";
export type { CompactContext, CompactResult, PruneBodiesResult } from "./compaction.js";
export { repairToolCallPairing } from "./message-repair.js";
export type { RestoreMutationsResult } from "./mutations.js";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  title?: string;
  /**
   * Compact last non-empty user prompt (for list/picker orientation).
   * Updated on save; never secrets-bearing by design (user text only, clipped).
   */
  lastUserPreview?: string;
  /**
   * When true, `pruneSessions` never deletes this session (experts keep
   * long-running incident / design threads across hygiene passes).
   */
  pinned?: boolean;
  /**
   * Session-scoped permission mode override (OpenCode-style /plan).
   * When set, resume restores this mode unless CLI `--permission-mode` is explicit.
   * `/plan` sets this without touching sticky preferences; `/build` or
   * `exit_plan_mode` restores `permissionModeBeforePlan` (or default).
   */
  permissionMode?: PermissionMode;
  /**
   * Mode to restore when leaving plan via `/build` or `exit_plan_mode`.
   * Only meaningful while `permissionMode === "plan"`.
   */
  permissionModeBeforePlan?: PermissionMode;
  /**
   * Same-provider fallback chain (`undefined` / `[]` = off).
   * Survives resume like `/model`. Hops below grok-4.5 high are dropped.
   */
  fallbackModels?: string[];
  /** Last same-provider model hop this session (from → to). */
  lastModelFallback?: { from: string; to: string; at: string };
  /**
   * Last stop reason (expert recovery / JSON). Failures are recovery;
   * `ulw_cycle_complete` is a successful wrap — see `isLastErrorProblem`.
   * Cleared on a successful turn unless keepLastError. Never stores tokens.
   */
  lastError?: {
    at: string;
    code: string;
    message: string;
    tips?: string[];
  };
  ultrawork: boolean;
  turnCount: number;
  editCount: number;
  /**
   * Last bash command that counted as structural verification (test/typecheck/…).
   * Helps resume orientation and proof-claim without rediscovering what was run.
   */
  lastVerificationCommand?: string;
  /** ISO timestamp when lastVerificationCommand was recorded. */
  lastVerificationAt?: string;
  /** False when the last recorded check failed (command still set). Absent on old sidecars = treat as green. */
  lastVerificationOk?: boolean;
  /** 0 green / 1 red. Mid-loop verify nudge already reads this. */
  lastVerificationExitCode?: number;
  /** New raw readFileSync test in a pin-budget repo — ULW proof tainted this wave. */
  rawPinProofTaint?: boolean;
  /**
   * Recent mill tool ids to omit on the next outbound request without
   * inventing requestPruneSticky (suffix only — prefix can still cache).
   */
  holdOmitToolIds?: string[];
  /** ISO timestamp of the most recent file edit (write/search_replace/apply_patch). */
  lastEditAt?: string;
  /** Last /checkpoint sha (git stash create dangling commit). */
  lastCheckpoint?: string;
  /** ISO timestamp when lastCheckpoint was taken. */
  lastCheckpointAt?: string;
  /** Last unattended ULW auto-commit (local only, never pushed). */
  lastAutoCommit?: {
    sha?: string;
    subject?: string;
    at: string;
    skipped?: string;
  };
  /**
   * Last-run harness-as-second-user meters (overwritten each loop).
   * Admits / Stop re-anchors / verify-fix-todo / bg-task frames.
   */
  harnessUserPokes?: number;
  admitCount?: number;
  proofPokes?: number;
  /** Last-run provider chat rounds. */
  providerRounds?: number;
  /** Session id this was forked from (conversation tree parent). */
  parentSessionId?: string;
  /** Short label of parent at fork time (title or id prefix). */
  parentSessionLabel?: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /**
   * Cached-input tokens reported by providers (xAI cached_tokens, DeepSeek
   * prompt_cache_hit_tokens, Anthropic cache_read). Feeds cache-aware cost
   * estimates; absent in older sessions (treated as 0).
   */
  totalCacheReadTokens?: number;
  /**
   * Last provider round (not the session smear). Dock `cache N%` prefers
   * this so a 99% prefix after a cold start is visible.
   */
  lastRoundPromptTokens?: number;
  lastRoundCacheReadTokens?: number;
  /**
   * How the last outbound request was slimmed: first_clip | sticky |
   * reclip | always. Absent when the last send was append-only.
   */
  lastPruneKind?: string;
  /**
   * Per-child spend ledger. Parent token totals already include these
   * (family number). The array is how you see which subagent spent what.
   * Not a cap.
   */
  subagentUsage?: SubagentUsageRecord[];
  /** Structured explore maps (pick + file claims). Latest wins on lookup. */
  exploreMaps?: import("./explore-map.js").ExploreMap[];
  /**
   * Frozen outbound prune set. After the first ≥180k clip, later requests
   * apply these stubs instead of re-aging — xAI prefix cache stays sticky.
   * Cleared on compact / /clear.
   */
  requestPruneSticky?: import("./request-prune.js").RequestPruneSticky;
  /**
   * Raw model ids the provider reported serving that DIVERGE from the
   * requested model (capped at 8). Provider-side tier routing made visible —
   * e.g. requested flash but billed pro. Absent = never diverged.
   */
  servedModels?: string[];
  /**
   * Optional per-session spend cap (USD estimate). When set, overrides
   * config.maxCostUsd for this session only. 0 = unlimited. Cleared on /clear hard.
   */
  maxCostUsd?: number;
  /** User message markers for rewind (indices into messages) */
  userTurnMarks?: number[];
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface SessionData {
  meta: SessionMeta;
  messages: ChatMessage[];
  todos: TodoItem[];
}

export function sessionDir(id: string): string {
  return path.join(forgeHome(), "sessions", id);
}

/**
 * Session ids are generated slugs (randomUUID today). Anything with path
 * separators, dots, or other characters outside the slug charset is not an
 * id — rejecting it keeps user input and on-disk meta from traversing out
 * of ~/.forge/sessions (e.g. "../../x" into deleteSessionDetailed → rm -rf).
 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

/** Absolute path to a session directory (resolves id/prefix/title when possible). */
export function resolveSessionDir(idOrPrefix: string): string | null {
  const full = resolveSessionId(idOrPrefix);
  if (!full) return null;
  return sessionDir(full);
}

/** Absolute path to session.json for a resolved session. */
export function resolveSessionJsonPath(idOrPrefix: string): string | null {
  const dir = resolveSessionDir(idOrPrefix);
  return dir ? path.join(dir, "session.json") : null;
}

export function createSession(opts: {
  cwd: string;
  provider: string;
  model: string;
  ultrawork?: boolean;
  /** Optional expert label (also settable later via /title or setSessionTitle). */
  title?: string;
  /** Floor-filtered same-provider hop list (`[]` = explicit off). */
  fallbackModels?: string[];
}): SessionData {
  const id = randomUUID();
  const now = nowIso();
  const title = (opts.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_TITLE_CHARS);
  const data: SessionData = {
    meta: {
      id,
      createdAt: now,
      updatedAt: now,
      cwd: opts.cwd,
      provider: opts.provider,
      model: opts.model,
      ultrawork: Boolean(opts.ultrawork),
      turnCount: 0,
      editCount: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCacheReadTokens: 0,
      userTurnMarks: [],
      ...(title ? { title } : {}),
      ...(Array.isArray(opts.fallbackModels)
        ? { fallbackModels: [...opts.fallbackModels] }
        : {}),
    },
    messages: [],
    todos: [],
  };
  saveSession(data);
  return data;
}

export function saveSession(data: SessionData): void {
  data.meta.updatedAt = nowIso();
  // Keep list/picker preview fresh without loading full histories later.
  try {
    const rawPrev = lastUserText(data);
    const fromKick = mandateFromUserText(rawPrev);
    const preview = (fromKick || rawPrev).replace(/\s+/g, " ").trim().slice(0, 80);
    if (preview) data.meta.lastUserPreview = preview;
    else delete data.meta.lastUserPreview;
  } catch {
    /* never block save */
  }
  const dir = sessionDir(data.meta.id);
  ensureDir(dir);
  // Cross-process meta merge: `forge sessions title/pin` writes the meta
  // sidecar only (never session.json) so it cannot roll back a running
  // session's messages. A long-lived process (open REPL) can hold an older
  // in-memory meta — do not let this save silently revert an externally-set
  // title/pin. In-process title/pin changes update the sidecar first
  // (setSessionTitle / setSessionPinned / clearConversation), so a sidecar
  // value missing from memory always came from another process.
  try {
    const side = readJsonFile<SessionMeta | null>(
      path.join(dir, "meta.json"),
      null,
    );
    if (side && typeof side === "object" && side.id === data.meta.id) {
      if (
        data.meta.title === undefined &&
        typeof side.title === "string" &&
        side.title.trim()
      ) {
        data.meta.title = side.title;
      }
      if (data.meta.pinned === undefined && side.pinned === true) {
        data.meta.pinned = true;
      }
    }
  } catch {
    /* never block save */
  }
  writeJsonFile(path.join(dir, "session.json"), data);
  // Sidecar meta for fast list/prune without parsing multi-MB histories
  try {
    writeJsonFile(path.join(dir, "meta.json"), data.meta);
  } catch {
    /* non-fatal */
  }
  try {
    heartbeatSession({
      sessionId: data.meta.id,
      cwd: data.meta.cwd,
      provider: data.meta.provider,
      model: data.meta.model,
    });
  } catch {
    /* never fail save on statusline */
  }
  // Keep exclusive lock timestamp fresh so multi-day runs stay visibly held
  // (lock acquisition no longer TTL-steals live pids; touch is for ops hygiene).
  try {
    touchSessionLock(data.meta.id);
  } catch {
    /* never fail save on lock touch */
  }
}

/**
 * Meta-only save for cheap CLI/REPL-settable fields (title/pinned). Writes
 * ONLY the meta.json sidecar — never session.json — so a possibly-stale
 * in-memory snapshot cannot roll back newer messages when a second process
 * races an open session (`forge sessions title/pin` vs a mid-run REPL).
 * Other fields are merged onto the on-disk sidecar so stale in-memory
 * counters do not regress list/prune views. loadSession treats the sidecar
 * as authoritative for title/pinned, and saveSession preserves externally-set
 * values, so the change survives later loads and saves.
 */
export function saveSessionMetaSidecar(session: SessionData): void {
  try {
    const dir = sessionDir(session.meta.id);
    ensureDir(dir);
    const sidePath = path.join(dir, "meta.json");
    const disk = readJsonFile<SessionMeta | null>(sidePath, null);
    const merged: SessionMeta =
      disk && typeof disk === "object" && disk.id === session.meta.id
        ? disk
        : { ...session.meta };
    merged.updatedAt = nowIso();
    if (session.meta.title) merged.title = session.meta.title;
    else delete merged.title;
    if (session.meta.pinned) merged.pinned = true;
    else delete merged.pinned;
    if (session.meta.lastModelFallback) {
      merged.lastModelFallback = session.meta.lastModelFallback;
    }
    if (session.meta.fallbackModels !== undefined) {
      merged.fallbackModels = session.meta.fallbackModels;
    }
    if (session.meta.model) merged.model = session.meta.model;
    writeJsonFile(sidePath, merged);
  } catch {
    /* meta sidecar best-effort — in-memory meta stays this process's source */
  }
}

/**
 * Overlay sidecar title/pinned onto a freshly loaded session. The meta.json
 * sidecar is authoritative for those fields: `forge sessions title/pin`
 * writes meta-only so a racing full rewrite never rolls back a running
 * session's messages.
 */
function overlaySidecarMeta(session: SessionData): void {
  try {
    const sidePath = path.join(sessionDir(session.meta.id), "meta.json");
    // No sidecar (legacy/crash-cleaned): session.json stays the only source.
    if (!fs.existsSync(sidePath)) return;
    const side = readJsonFile<SessionMeta | null>(sidePath, null);
    // Unparseable or foreign sidecar: keep session.json values.
    if (!side || typeof side !== "object" || side.id !== session.meta.id) {
      return;
    }
    if (typeof side.title === "string" && side.title.trim()) {
      session.meta.title = side.title;
    } else {
      delete session.meta.title;
    }
    if (side.pinned === true) session.meta.pinned = true;
    else delete session.meta.pinned;
    if (side.lastModelFallback && typeof side.lastModelFallback === "object") {
      session.meta.lastModelFallback = side.lastModelFallback;
    }
    if (Array.isArray(side.fallbackModels)) {
      session.meta.fallbackModels = side.fallbackModels;
    }
    if (typeof side.model === "string" && side.model.trim()) {
      session.meta.model = side.model.trim();
    }
  } catch {
    /* best-effort */
  }
}

/** Normalize meta sidecar fields so list/doctor never crash on partial JSON. */
function normalizeSessionMeta(
  fromSide: SessionMeta,
  expectedId?: string,
): SessionMeta {
  const rawId = String(fromSide.id || "");
  const out: SessionMeta = {
    ...fromSide,
    // Never trust a poisoned id from disk — fall back to the containing
    // directory name so downstream rm/rename targets stay inside the root.
    id: isValidSessionId(rawId) ? rawId : (expectedId ?? ""),
    cwd: String(fromSide.cwd || ""),
    provider: String(fromSide.provider || "unknown"),
    model: String(fromSide.model || "unknown"),
    createdAt: String(fromSide.createdAt || ""),
    updatedAt: String(fromSide.updatedAt || fromSide.createdAt || ""),
    ultrawork: Boolean(fromSide.ultrawork),
    turnCount: Number(fromSide.turnCount) || 0,
    editCount: Number(fromSide.editCount) || 0,
    totalPromptTokens: Number(fromSide.totalPromptTokens) || 0,
    totalCompletionTokens: Number(fromSide.totalCompletionTokens) || 0,
    totalCacheReadTokens: Number(fromSide.totalCacheReadTokens) || 0,
    ...((): { subagentUsage?: SubagentUsageRecord[] } => {
      const kids = normalizeSubagentUsage(fromSide.subagentUsage);
      return kids ? { subagentUsage: kids } : {};
    })(),
    ...(typeof fromSide.lastVerificationCommand === "string" &&
    fromSide.lastVerificationCommand.trim()
      ? {
          lastVerificationCommand: fromSide.lastVerificationCommand
            .trim()
            .slice(0, 240),
        }
      : {}),
    ...(typeof fromSide.lastVerificationAt === "string" &&
    fromSide.lastVerificationAt.trim()
      ? { lastVerificationAt: fromSide.lastVerificationAt.trim() }
      : {}),
    ...(typeof fromSide.lastVerificationOk === "boolean"
      ? { lastVerificationOk: fromSide.lastVerificationOk }
      : {}),
    ...(typeof fromSide.lastVerificationExitCode === "number" &&
    Number.isFinite(fromSide.lastVerificationExitCode)
      ? {
          lastVerificationExitCode: fromSide.lastVerificationExitCode === 0 ? 0 : 1,
        }
      : {}),
    ...(typeof fromSide.lastEditAt === "string" &&
    fromSide.lastEditAt.trim()
      ? { lastEditAt: fromSide.lastEditAt.trim() }
      : {}),
  };
  // Per-session spend cap (USD estimate). Preserve explicit 0 (= unlimited override).
  if (
    fromSide.maxCostUsd !== undefined &&
    fromSide.maxCostUsd !== null &&
    Number.isFinite(Number(fromSide.maxCostUsd))
  ) {
    const n = Number(fromSide.maxCostUsd);
    if (n >= 0 && n <= 1_000_000) {
      out.maxCostUsd = Math.round(n * 10_000) / 10_000;
    }
  } else {
    delete out.maxCostUsd;
  }
  const lastP = Number(fromSide.lastRoundPromptTokens);
  if (Number.isFinite(lastP) && lastP > 0) {
    out.lastRoundPromptTokens = Math.floor(lastP);
    const lastC = Number(fromSide.lastRoundCacheReadTokens);
    out.lastRoundCacheReadTokens =
      Number.isFinite(lastC) && lastC > 0 ? Math.floor(lastC) : 0;
  } else {
    delete out.lastRoundPromptTokens;
    delete out.lastRoundCacheReadTokens;
  }
  const pk = typeof fromSide.lastPruneKind === "string"
    ? fromSide.lastPruneKind.trim()
    : "";
  if (pk === "first_clip" || pk === "sticky" || pk === "reclip" || pk === "always") {
    out.lastPruneKind = pk;
  } else {
    delete out.lastPruneKind;
  }
  const maps = normalizeExploreMaps(fromSide.exploreMaps);
  if (maps) out.exploreMaps = maps;
  else delete out.exploreMaps;
  const sticky = normalizeRequestPruneSticky(fromSide.requestPruneSticky);
  if (sticky) out.requestPruneSticky = sticky;
  else delete out.requestPruneSticky;
  if (Array.isArray(fromSide.holdOmitToolIds)) {
    const ids = fromSide.holdOmitToolIds
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
      .slice(0, 48);
    if (ids.length) out.holdOmitToolIds = ids;
    else delete out.holdOmitToolIds;
  } else {
    delete out.holdOmitToolIds;
  }
  if (fromSide.pinned) out.pinned = true;
  else delete out.pinned;
  const pm = normalizeMetaPermissionMode(fromSide.permissionMode);
  if (pm) out.permissionMode = pm;
  else delete out.permissionMode;
  const before = normalizeMetaPermissionMode(fromSide.permissionModeBeforePlan);
  if (before) out.permissionModeBeforePlan = before;
  else delete out.permissionModeBeforePlan;
  if (Array.isArray(fromSide.fallbackModels)) {
    out.fallbackModels = fromSide.fallbackModels
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);
  } else if ("fallbackModels" in fromSide && fromSide.fallbackModels == null) {
    delete out.fallbackModels;
  }
  const hop = fromSide.lastModelFallback;
  if (
    hop &&
    typeof hop === "object" &&
    typeof (hop as { from?: unknown }).from === "string" &&
    typeof (hop as { to?: unknown }).to === "string" &&
    String((hop as { from: string }).from).trim() &&
    String((hop as { to: string }).to).trim()
  ) {
    const h = hop as { from: string; to: string; at?: unknown };
    out.lastModelFallback = {
      from: String(h.from).trim().slice(0, 120),
      to: String(h.to).trim().slice(0, 120),
      at: typeof h.at === "string" ? h.at : new Date().toISOString(),
    };
  } else if ("lastModelFallback" in fromSide && fromSide.lastModelFallback == null) {
    delete out.lastModelFallback;
  }
  const le = fromSide.lastError;
  if (
    le &&
    typeof le === "object" &&
    typeof (le as { message?: unknown }).message === "string" &&
    String((le as { message: string }).message).trim()
  ) {
    const o = le as {
      at?: unknown;
      code?: unknown;
      message: string;
      tips?: unknown;
    };
    out.lastError = {
      at: typeof o.at === "string" ? o.at : new Date().toISOString(),
      code: typeof o.code === "string" ? o.code : "error",
      message: String(o.message).trim().slice(0, 500),
      tips: Array.isArray(o.tips)
        ? o.tips
            .filter((t): t is string => typeof t === "string" && Boolean(t.trim()))
            .map((t) => t.trim().slice(0, 200))
            .slice(0, 6)
        : undefined,
    };
  } else {
    delete out.lastError;
  }
  return out;
}

/** Record a provider/run failure on the session for /status recovery. */
export function setSessionLastError(
  session: SessionData,
  err: { code: string; message: string; tips?: string[] },
): void {
  session.meta.lastError = {
    at: new Date().toISOString(),
    code: String(err.code || "error").slice(0, 64),
    message: String(err.message || "error").trim().slice(0, 500),
    tips: (err.tips || [])
      .filter((t) => typeof t === "string" && t.trim())
      .map((t) => t.trim().slice(0, 200))
      .slice(0, 6),
  };
  if (!session.meta.lastError.tips?.length) {
    delete session.meta.lastError.tips;
  }
}

/** Clear lastError after a successful agent turn. */
export function clearSessionLastError(session: SessionData): void {
  delete session.meta.lastError;
}

/** Provider/transport failures that should not stick on the HUD after resume. */
export const TRANSIENT_PROVIDER_ERROR_CODES = new Set([
  "quota_exhausted",
  "rate_limited",
  "provider_error",
  "empty_response",
  "overloaded",
  "timeout",
]);

/** Drop sticky quota/429/drop banners when the user (or ULW) starts a new turn. */
export function clearTransientProviderError(session: SessionData): boolean {
  const code = session.meta.lastError?.code || "";
  if (!TRANSIENT_PROVIDER_ERROR_CODES.has(code)) return false;
  delete session.meta.lastError;
  return true;
}

const META_PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

function normalizeMetaPermissionMode(raw: unknown): PermissionMode | undefined {
  if (typeof raw !== "string") return undefined;
  const mode = raw.trim() as PermissionMode;
  return META_PERMISSION_MODES.has(mode) ? mode : undefined;
}

/**
 * Apply session-scoped permission override onto live config (resume /plan).
 * Returns true when config.permissionMode changed.
 */
export function applySessionPermissionMode(
  config: { permissionMode: PermissionMode },
  session: SessionData,
): boolean {
  const mode = session.meta.permissionMode;
  if (!mode || !META_PERMISSION_MODES.has(mode)) return false;
  if (config.permissionMode === mode) return false;
  config.permissionMode = mode;
  return true;
}

/**
 * Enter plan mode for this session only (does not touch sticky preferences).
 * Remembers the prior mode for `/build` restore.
 */
export function enterSessionPlanMode(
  config: { permissionMode: PermissionMode },
  session: SessionData,
): { changed: boolean; previous: PermissionMode } {
  const previous = config.permissionMode;
  if (previous === "plan" && session.meta.permissionMode === "plan") {
    return { changed: false, previous };
  }
  if (previous !== "plan") {
    session.meta.permissionModeBeforePlan = previous;
  } else if (!session.meta.permissionModeBeforePlan) {
    session.meta.permissionModeBeforePlan = "default";
  }
  session.meta.permissionMode = "plan";
  config.permissionMode = "plan";
  return { changed: previous !== "plan", previous };
}

/**
 * Leave plan mode: restore `permissionModeBeforePlan` (or default).
 * Clears session plan override so resume falls back to sticky prefs / CLI
 * (OpenCode build-switch — plan is temporary, not a sticky session mode).
 */
export function exitSessionPlanMode(
  config: { permissionMode: PermissionMode },
  session: SessionData,
  opts?: { restoreTo?: PermissionMode },
): { mode: PermissionMode; wasPlan: boolean } {
  const wasPlan =
    config.permissionMode === "plan" || session.meta.permissionMode === "plan";
  const restore =
    opts?.restoreTo ||
    session.meta.permissionModeBeforePlan ||
    (config.permissionMode !== "plan" ? config.permissionMode : "default");
  const mode = META_PERMISSION_MODES.has(restore) ? restore : "default";
  config.permissionMode = mode;
  delete session.meta.permissionModeBeforePlan;
  // Drop session override entirely after leaving plan — sticky prefs + CLI win.
  delete session.meta.permissionMode;
  return { mode, wasPlan };
}

/** Persist session-scoped permission mode (and plan restore) to disk. */
export function persistSessionMode(session: SessionData): void {
  saveSession(session);
}

/**
 * Read meta for a known full session directory id (no resolve/title lookup).
 * Used by resolveSessionId title scan to avoid recursion.
 */
function readSessionMetaExact(fullId: string): SessionMeta | null {
  try {
    const metaPath = path.join(sessionDir(fullId), "meta.json");
    const fromSide = readJsonFile<SessionMeta | null>(metaPath, null);
    if (fromSide?.id && typeof fromSide.id === "string") {
      return normalizeSessionMeta(fromSide, fullId);
    }
    // Fallback: session.json only (legacy / missing sidecar)
    const primary = path.join(sessionDir(fullId), "session.json");
    const data = readJsonFile<SessionData | null>(primary, null);
    if (data?.meta?.id) {
      const healed = normalizeSessionMeta(data.meta, fullId);
      try {
        writeJsonFile(metaPath, healed);
      } catch {
        /* non-fatal */
      }
      return healed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Load meta only (prefers meta.json sidecar; falls back to full session). */
export function loadSessionMeta(idOrPrefix: string): SessionMeta | null {
  try {
    const full = resolveSessionId(idOrPrefix);
    if (!full) return null;
    return readSessionMetaExact(full);
  } catch {
    // Corrupt session dir must never break list/doctor
    return null;
  }
}

/**
 * Load a session by id/prefix.
 *
 * Recovery order (crash-safe):
 * 1. session.json
 * 2. newest leftover atomic write tmp (`session.json.<pid>.tmp`)
 *
 * Atomic writes rename tmp → final; a kill mid-write can leave only the tmp.
 */
export function loadSession(id: string): SessionData | null {
  // Allow short prefix match
  const full = resolveSessionId(id);
  if (!full) return null;
  const dir = sessionDir(full);
  const primary = path.join(dir, "session.json");
  const fromPrimary = readJsonFile<SessionData | null>(primary, null);
  if (fromPrimary?.meta?.id) {
    const norm = normalizeLoadedSession(fromPrimary);
    if (norm.session) overlaySidecarMeta(norm.session);
    // Persist heals (orphan tool pairs / dropped bad roles) so disk stays clean.
    // Skip re-save when another live process holds the lock — avoid racing writers.
    if (norm.session && norm.dirty && !sessionHasForeignLiveLock(full)) {
      try {
        saveSession(norm.session);
      } catch {
        /* still return in-memory heal */
      }
    }
    return norm.session;
  }

  const recovered = recoverSessionFromTmp(dir);
  if (recovered) {
    const cleaned = normalizeLoadedSession(recovered);
    if (cleaned.session) overlaySidecarMeta(cleaned.session);
    // Promote recovered payload so subsequent loads are normal (unless foreign lock)
    try {
      if (cleaned.session && !sessionHasForeignLiveLock(full)) {
        saveSession(cleaned.session);
      }
    } catch {
      /* still return in-memory recovery */
    }
    return cleaned.session;
  }
  return null;
}

/** Best-effort recovery from atomic-write temp files left after a crash. */
export function recoverSessionFromTmp(dir: string): SessionData | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const tmps = entries
    .filter((n) => n.startsWith("session.json.") && n.endsWith(".tmp"))
    .map((n) => {
      const p = path.join(dir, n);
      try {
        return { p, mtime: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { p: string; mtime: number } => Boolean(x))
    .sort((a, b) => b.mtime - a.mtime);

  for (const t of tmps) {
    const data = readJsonFile<SessionData | null>(t.p, null);
    if (data?.meta?.id && Array.isArray(data.messages)) {
      // Return raw payload; loadSession normalizes + promotes to primary
      return data;
    }
  }
  return null;
}

/**
 * Fork a session into a new id (deep copy of messages/todos/meta counters).
 * Useful before risky ULW waves or when branching an experiment.
 */
export function forkSession(
  source: SessionData,
  opts?: { title?: string },
): SessionData {
  const id = randomUUID();
  const now = nowIso();
  const meta = structuredClone(source.meta);
  // Forks are experiments — never inherit pin (source stays protected).
  delete meta.pinned;
  // Fresh experiment — don't inherit prior provider failure banner.
  delete meta.lastError;
  const data: SessionData = {
    meta: {
      ...meta,
      id,
      createdAt: now,
      updatedAt: now,
      title:
        opts?.title ||
        (source.meta.title
          ? `fork of ${source.meta.title}`.slice(0, MAX_SESSION_TITLE_CHARS)
          : `fork of ${source.meta.id.slice(0, 8)}`),
      // Fresh turn marks relative to copied messages
      userTurnMarks: [...(source.meta.userTurnMarks || [])],
      // Conversation tree lineage (survives list/resume/share)
      parentSessionId: source.meta.id,
      parentSessionLabel: (
        source.meta.title ||
        source.meta.id.slice(0, 8)
      ).slice(0, MAX_SESSION_TITLE_CHARS),
    },
    messages: structuredClone(source.messages),
    todos: structuredClone(source.todos || []),
  };
  saveSession(data);
  // Fork inherits mutation journal so /undo still restores pre-images.
  try {
    copyFileMutations(source.meta.id, id);
  } catch {
    /* best-effort */
  }
  // Fork inherits ULW + /goal harness drivers (sidecar files keyed by session id).
  // Without this, /fork mid-ULW silently drops the relentless cycle — a production footgun.
  try {
    copyUlwCycle(source.meta.id, id);
  } catch {
    /* best-effort */
  }
  try {
    copyGoal(source.meta.id, id);
  } catch {
    /* best-effort */
  }
  try {
    copyDecisionMemory(source.meta.id, id);
  } catch {
    /* best-effort */
  }
  return data;
}

/** Machine-readable session export for experts / CI artifacts. */
export function exportSessionJson(session: SessionData): string {
  return (
    JSON.stringify(
      {
        meta: session.meta,
        todos: session.todos,
        messageCount: session.messages.length,
        messages: session.messages,
        exportedAt: nowIso(),
        format: "forge-session-v1",
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Import a forge-session-v1 JSON export into a new session id.
 * Does not reuse the original id (avoids clobbering live sessions).
 */
export function importSessionJson(
  raw: string,
  opts?: { cwd?: string; title?: string },
): SessionData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid session JSON: ${(err as Error).message}`);
  }
  const obj = parsed as {
    format?: string;
    meta?: Partial<SessionMeta>;
    messages?: ChatMessage[];
    todos?: TodoItem[];
  };
  if (!obj || typeof obj !== "object") {
    throw new Error("Invalid session JSON: expected object");
  }
  if (obj.format && obj.format !== "forge-session-v1") {
    throw new Error(`Unsupported session format: ${obj.format}`);
  }
  if (!Array.isArray(obj.messages)) {
    throw new Error("Invalid session JSON: messages[] required");
  }
  const messages = sanitizeImportedMessages(obj.messages);
  const todos = sanitizeImportedTodos(obj.todos);
  const healed = repairToolCallPairing(messages);
  const now = nowIso();
  const id = randomUUID();
  const src = obj.meta || {};
  const lastPrev =
    typeof src.lastUserPreview === "string"
      ? src.lastUserPreview.replace(/\s+/g, " ").trim().slice(0, 80)
      : "";
  const data: SessionData = {
    meta: {
      id,
      createdAt: now,
      updatedAt: now,
      cwd: opts?.cwd || src.cwd || process.cwd(),
      provider: String(src.provider || "xai"),
      model: String(src.model || "unknown"),
      title:
        opts?.title ||
        (src.title ? `import of ${src.title}`.slice(0, MAX_SESSION_TITLE_CHARS) : `import ${id.slice(0, 8)}`),
      // Imports are new ids — never inherit pin (re-pin explicitly if needed).
      ultrawork: Boolean(src.ultrawork),
      turnCount: Number(src.turnCount) || 0,
      editCount: Number(src.editCount) || 0,
      totalPromptTokens: Number(src.totalPromptTokens) || 0,
      totalCompletionTokens: Number(src.totalCompletionTokens) || 0,
      totalCacheReadTokens: Number(src.totalCacheReadTokens) || 0,
      ...(typeof src.lastRoundPromptTokens === "number" &&
      src.lastRoundPromptTokens > 0
        ? {
            lastRoundPromptTokens: Math.floor(src.lastRoundPromptTokens),
            lastRoundCacheReadTokens:
              Math.max(0, Math.floor(Number(src.lastRoundCacheReadTokens) || 0)),
          }
        : {}),
      ...((): { exploreMaps?: import("./explore-map.js").ExploreMap[] } => {
        const maps = normalizeExploreMaps(src.exploreMaps);
        return maps ? { exploreMaps: maps } : {};
      })(),
      ...((): { subagentUsage?: SubagentUsageRecord[] } => {
        const kids = normalizeSubagentUsage(src.subagentUsage);
        return kids ? { subagentUsage: kids } : {};
      })(),
      ...(Array.isArray(src.servedModels) && src.servedModels.length
        ? { servedModels: src.servedModels.slice(0, 8).map(String) }
        : {}),
      ...(typeof src.lastVerificationCommand === "string" &&
      src.lastVerificationCommand.trim()
        ? {
            lastVerificationCommand: src.lastVerificationCommand
              .trim()
              .slice(0, 240),
          }
        : {}),
      ...(typeof src.lastVerificationAt === "string" &&
      src.lastVerificationAt.trim()
        ? { lastVerificationAt: src.lastVerificationAt.trim() }
        : {}),
      ...(typeof src.lastVerificationOk === "boolean"
        ? { lastVerificationOk: src.lastVerificationOk }
        : {}),
      ...(typeof src.lastVerificationExitCode === "number" &&
      Number.isFinite(src.lastVerificationExitCode)
        ? {
            lastVerificationExitCode: src.lastVerificationExitCode === 0 ? 0 : 1,
          }
        : {}),
      ...(typeof src.lastEditAt === "string" &&
      src.lastEditAt.trim()
        ? { lastEditAt: src.lastEditAt.trim() }
        : {}),
      ...(src.maxCostUsd !== undefined &&
      src.maxCostUsd !== null &&
      Number.isFinite(Number(src.maxCostUsd)) &&
      Number(src.maxCostUsd) >= 0 &&
      Number(src.maxCostUsd) <= 1_000_000
        ? {
            maxCostUsd:
              Math.round(Number(src.maxCostUsd) * 10_000) / 10_000,
          }
        : {}),
      ...(Array.isArray(src.fallbackModels)
        ? {
            fallbackModels: filterFallbackChain(
              src.fallbackModels
                .map((x) => String(x ?? "").trim())
                .filter(Boolean),
              String(src.provider || "xai"),
            ).kept.slice(0, 8),
          }
        : {}),
      ...(src.lastModelFallback &&
      typeof src.lastModelFallback.from === "string" &&
      typeof src.lastModelFallback.to === "string"
        ? {
            lastModelFallback: {
              from: src.lastModelFallback.from.trim().slice(0, 120),
              to: src.lastModelFallback.to.trim().slice(0, 120),
              at:
                typeof src.lastModelFallback.at === "string"
                  ? src.lastModelFallback.at
                  : new Date().toISOString(),
            },
          }
        : {}),
      ...(lastPrev ? { lastUserPreview: lastPrev } : {}),
      userTurnMarks: Array.isArray(src.userTurnMarks)
        ? src.userTurnMarks
            .map((n) => Number(n))
            .filter(
              (n) =>
                Number.isInteger(n) && n >= 0 && n < healed.messages.length,
            )
        : [],
    },
    messages: healed.messages,
    todos,
  };
  // If export lacked lastUserPreview, derive from messages on first save.
  saveSession(data);
  return data;
}

const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Soft-normalize a session loaded from disk/tmp.
 * Drops invalid-role messages and bad todos so a corrupt session.json cannot
 * crash the REPL or poison the provider request. Returns null if unusable.
 * `dirty` means the caller should re-save so disk matches the healed transcript.
 */
function normalizeLoadedSession(
  data: SessionData,
): { session: SessionData | null; dirty: boolean } {
  if (!data?.meta?.id) return { session: null, dirty: false };
  const rawMsgs = Array.isArray(data.messages) ? data.messages : [];
  const beforeLen = rawMsgs.length;
  const messages: ChatMessage[] = [];
  let dropped = 0;
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      dropped += 1;
      continue;
    }
    const msg = m as unknown as Record<string, unknown>;
    const role = String(msg.role || "");
    if (!VALID_ROLES.has(role)) {
      dropped += 1;
      continue;
    }
    const clone = structuredClone(msg) as unknown as ChatMessage;
    clone.role = role as ChatMessage["role"];
    if (clone.content == null) clone.content = "";
    messages.push(clone);
  }
  // Heal orphan tool_calls / tool results after role filtering so the next
  // provider request never 400s on an illegal sequence from a crash mid-batch.
  const healed = repairToolCallPairing(messages);
  data.messages = healed.messages;
  const todosBefore = Array.isArray(data.todos) ? data.todos.length : 0;
  data.todos = sanitizeImportedTodos(data.todos);
  let marksDirty = false;
  if (!Array.isArray(data.meta.userTurnMarks)) {
    data.meta.userTurnMarks = [];
    marksDirty = true;
  } else {
    const nextMarks = data.meta.userTurnMarks
      .map((n) => Number(n))
      .filter(
        (n) =>
          Number.isInteger(n) && n >= 0 && n < data.messages.length,
      );
    if (
      nextMarks.length !== data.meta.userTurnMarks.length ||
      nextMarks.some((n, i) => n !== data.meta.userTurnMarks![i])
    ) {
      marksDirty = true;
    }
    data.meta.userTurnMarks = nextMarks;
  }
  const dirty =
    dropped > 0 ||
    healed.changed ||
    beforeLen !== messages.length ||
    todosBefore !== data.todos.length ||
    marksDirty;
  return { session: data, dirty };
}

/** Strict validate + clone messages so corrupt exports cannot poison the agent loop. */
function sanitizeImportedMessages(raw: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      throw new Error(`Invalid session JSON: messages[${i}] must be an object`);
    }
    const msg = m as Record<string, unknown>;
    const role = String(msg.role || "");
    if (!VALID_ROLES.has(role)) {
      throw new Error(
        `Invalid session JSON: messages[${i}].role must be system|user|assistant|tool (got "${role || "missing"}")`,
      );
    }
    const clone = structuredClone(msg) as unknown as ChatMessage;
    clone.role = role as ChatMessage["role"];
    if (clone.content == null) clone.content = "";
    out.push(clone);
  }
  return out;
}

function sanitizeImportedTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  const statuses = new Set([
    "pending",
    "in_progress",
    "completed",
    "cancelled",
  ]);
  for (const t of raw) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    const item = t as Record<string, unknown>;
    const id = String(item.id || "").trim();
    const content = String(item.content || "").trim();
    const status = String(item.status || "pending");
    if (!id || !content) continue;
    if (!statuses.has(status)) continue;
    out.push({
      id,
      content,
      status: status as TodoItem["status"],
    });
  }
  return out;
}

function clipPickerField(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (max <= 0 || !t) return "";
  if (visibleWidth(t) <= max) return t;
  if (max === 1) return "…";
  return clipAnsi(t, max - 1) + "…";
}

function formatPickerPreview(text: string, max: number): string {
  const inner = clipPickerField(text, Math.max(0, max - 2));
  return inner ? `“${inner}”` : "";
}

function paintPickerTitle(title: string, untitled: boolean): string {
  if (!title) return title;
  return untitled ? chalk.dim(title) : chalk.bold(title);
}

function paintPickerPreview(preview: string): string {
  return preview ? chalk.dim(preview) : "";
}

/** Color harness / health badges; unknown extras (cwd, error codes) stay dim. */
export function paintPickerBadge(bit: string): string {
  switch (bit) {
    case "*":
      return chalk.cyan.bold("*");
    case "✓":
      return chalk.green("✓");
    case "✓~":
      return chalk.yellow("✓~");
    case "ULW":
      return chalk.magenta("ULW");
    case "PIN":
      return chalk.cyan("PIN");
    case "PLAN":
      return chalk.blue("PLAN");
    case "ERR":
      return chalk.red("ERR");
    case "LOCK":
      return chalk.yellow("LOCK");
    case "GOAL":
    case "GOAL⏸":
      return chalk.yellow(bit);
    case "FORK":
      return chalk.dim("FORK");
    default:
      return chalk.dim(bit);
  }
}

/**
 * Short lastError glance for `/sessions` / `/resume` / `forge sessions list`.
 * Code + message, one field — the picker paints and clips it.
 * Successful wraps (`ulw_cycle_complete`) are not a problem.
 */
export function sessionPickerProblem(
  s: Pick<SessionMeta, "lastError">,
): string {
  const err = s.lastError;
  if (!err || !isLastErrorProblem(err)) return "";
  const code = String(err.code || "").replace(/\s+/g, " ").trim();
  const msg = String(err.message || "").replace(/\s+/g, " ").trim();
  if (!code && !msg) return "";
  if (code && msg) {
    return msg.toLowerCase().includes(code.toLowerCase())
      ? msg
      : `${code} ${msg}`;
  }
  return code || msg;
}

/**
 * One-row `/sessions` / `forge sessions list` picker.
 * Title (the job) leads; lastError problem leads when present.
 * Id / age recede; model/cost/turns drop first. Still one TTY row.
 */
export function formatSessionPickerRow(
  s: SessionMeta,
  extras: string[] = [],
  columns?: number,
): string {
  const age = formatRelativeTime(s.updatedAt).padStart(8);
  const untitled = !String(s.title || "").trim();
  const rawTitle = (s.title || "(untitled)").replace(/\s+/g, " ").trim();
  const rawPrev = (s.lastUserPreview || "").replace(/\s+/g, " ").trim();
  const problem = sessionPickerProblem(s);
  const errCode = String(s.lastError?.code || "").trim();
  const badges: string[] = [];
  if (s.lastVerificationCommand?.trim()) {
    if (s.lastVerificationOk === false) badges.push("✗");
    else badges.push(isLastVerificationStale(s) ? "✓~" : "✓");
  }
  if (s.ultrawork) badges.push("ULW");
  if (s.pinned) badges.push("PIN");
  if (s.permissionMode === "plan") badges.push("PLAN");
  if (isLastErrorProblem(s.lastError) && !problem) badges.push("ERR");
  for (const extra of extras) {
    const bit = extra.trim();
    if (!bit) continue;
    if (problem && errCode) {
      const folded = bit.replace(/^[\[\]]+|[\[\]]+$/g, "");
      if (folded === errCode || bit === `[${errCode}]`) continue;
    }
    badges.push(bit);
  }
  let cost = "";
  try {
    const tok = (s.totalPromptTokens || 0) + (s.totalCompletionTokens || 0);
    if (tok > 0) {
      cost = `~${formatCost(
        estimateCostUsd(
          s.provider || "xai",
          s.totalPromptTokens || 0,
          s.totalCompletionTokens || 0,
          s.model,
          s.totalCacheReadTokens || 0,
        ),
      )}`;
    }
  } catch {
    /* */
  }
  const cols =
    columns ??
    (process.stdout.isTTY ? process.stdout.columns || 80 : Number.POSITIVE_INFINITY);
  const join = (parts: string[]): string => parts.filter(Boolean).join("  ");
  const badgeStr = badges.map(paintPickerBadge).join(" ");
  const id = chalk.dim(s.id.slice(0, 8));
  const ageBit = chalk.dim(age);
  const gap = 2;

  const fit = (
    titleMax: number,
    previewMax: number,
    problemMax: number,
    extrasBits: string[],
  ): string => {
    const title = paintPickerTitle(clipPickerField(rawTitle, titleMax), untitled);
    const preview = problem
      ? ""
      : paintPickerPreview(formatPickerPreview(rawPrev, previewMax));
    const prob = problem ? chalk.red(clipPickerField(problem, problemMax)) : "";
    return join([prob, title, badgeStr, preview, ageBit, id, ...extrasBits]);
  };

  const titleNeed = Math.min(visibleWidth(rawTitle), 48);
  const prevNeed = !problem && rawPrev ? Math.min(visibleWidth(rawPrev) + 2, 56) : 0;
  const problemNeed = problem ? Math.min(visibleWidth(problem), 48) : 0;
  const rounds = s.providerRounds ?? 0;
  const turnBit =
    rounds > (s.turnCount ?? 0)
      ? `t=${s.turnCount ?? 0} r=${rounds}`
      : `t=${s.turnCount ?? 0}`;
  const extrasAll = [s.model, turnBit, cost].filter(Boolean);
  if (!Number.isFinite(cols) || cols < 24) {
    return fit(
      titleNeed,
      prevNeed,
      problemNeed,
      extrasAll.map((b) => chalk.dim(b)),
    );
  }

  const badgeBudget = badgeStr ? visibleWidth(badgeStr) + gap : 0;
  let remaining = Math.max(0, cols - badgeBudget);
  let titleMax = 0;
  let previewMax = 0;
  let problemMax = 0;
  const take = (want: number): number => {
    if (want <= 0 || remaining < 3) return 0;
    const got = Math.min(want, remaining - gap);
    if (got <= 0) return 0;
    remaining -= got + gap;
    return got;
  };
  // Job first: title, then problem or last-you; id/age recede via clip.
  titleMax = take(Math.min(titleNeed, 20));
  if (problem) problemMax = take(Math.min(problemNeed, 28));
  else previewMax = take(Math.min(prevNeed, 28));
  titleMax += take(titleNeed - titleMax);
  if (problem) problemMax += take(problemNeed - problemMax);
  else previewMax += take(prevNeed - previewMax);
  const extrasBits: string[] = [];
  for (const bit of extrasAll) {
    const w = visibleWidth(bit) + gap;
    if (bit && w <= remaining) {
      extrasBits.push(chalk.dim(bit));
      remaining -= w;
    }
  }
  const line = fit(titleMax, previewMax, problemMax, extrasBits);
  return visibleWidth(line) <= cols ? line : clipAnsi(line, cols);
}

/** 1-based index into a printed session list. `null` if `arg` is not a small integer in range. */
export function parseSessionListIndex(arg: string, length: number): number | null {
  const t = String(arg ?? "").trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  if (n < 1 || n > length) return null;
  return n - 1;
}

/** Verdict for `/sessions errors` — not a lecture, not `sessions  ·  ok`. */
export function formatSessionsErrorsVerdict(count: number): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) return "sessions  ·  none";
  return `sessions  ·  ${n} error${n === 1 ? "" : "s"}`;
}

/**
 * Typeable Next after the errors list. First row is `/resume 1`;
 * lastErr of that row adds the sit-down key (`/accounts`, not a CLI dump).
 * Designed empty: `Next  /status`.
 */
export function formatSessionsErrorsCloser(
  first?: Pick<SessionMeta, "lastError"> | null,
): string {
  if (!first) return "Next  /status";
  const keys = ["/resume 1"];
  const next = sitDownNextForLastError(first.lastError);
  if (next && !keys.includes(next)) keys.push(next);
  return `Next  ${keys.join("  ·  ")}`;
}

/** Numbered wrapper for `/resume` / `/sessions` / `forge sessions list`. */
export function formatNumberedPickerRow(
  index: number,
  s: SessionMeta,
  extras: string[] = [],
  columns?: number,
): string {
  const cols =
    columns ??
    (process.stdout.isTTY ? process.stdout.columns || 80 : Number.POSITIVE_INFINITY);
  const idx = chalk.dim(String(index + 1).padStart(2));
  const inner = Number.isFinite(cols) ? Math.max(24, cols - 3) : cols;
  return `${idx} ${formatSessionPickerRow(s, extras, inner)}`;
}

/** Compact human summary for `forge sessions show`. */
export function formatSessionSummary(session: SessionData): string {
  const m = session.meta;
  const openTodos = (session.todos || []).filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;
  const age = formatRelativeTime(m.updatedAt);
  let gitLine: string | null = null;
  let projectLine: string | null = null;
  try {
    const git = getGitSnapshot(m.cwd || process.cwd());
    if (git.branch) {
      const dirty = git.dirty ? " dirty" : "";
      const ch =
        typeof git.changedFiles === "number" ? ` Δ${git.changedFiles}` : "";
      const wt = git.isWorktree ? " worktree" : "";
      gitLine = `  git:      ${git.branch}${dirty}${ch}${wt}`;
    }
  } catch {
    /* */
  }
  try {
    const intel = detectProjectIntel(m.cwd || process.cwd());
    const bits = [
      intel.packageName
        ? intel.packageVersion
          ? `${intel.packageName}@${intel.packageVersion}`
          : intel.packageName
        : null,
      intel.packageManager || null,
      intel.kinds.length ? intel.kinds.join(",") : null,
      intel.checkCommands.length
        ? `checks=${intel.checkCommands.slice(0, 3).join(" | ")}`
        : null,
      intel.monorepoRoot
        ? `mono=${path.basename(intel.monorepoRoot)}`
        : null,
    ].filter(Boolean);
    if (bits.length) projectLine = `  project:  ${bits.join(" · ")}`;
  } catch {
    /* */
  }
  const lines = [
    `Session ${m.id}`,
    `  title:    ${m.title || "(untitled)"}`,
    m.parentSessionId
      ? `  forked:   ${(m.parentSessionLabel || m.parentSessionId.slice(0, 8)).slice(0, 48)} ← ${m.parentSessionId.slice(0, 8)}…`
      : null,
    (() => {
      try {
        const kids = listSessionForks(m.id, { limit: 6 });
        if (!kids.length) return null;
        const labels = kids
          .map((k) => (k.title || k.id.slice(0, 8)).slice(0, 24))
          .join(" · ");
        return `  forks:    ${kids.length}  ${labels}${kids.length >= 6 ? " …" : ""}`;
      } catch {
        return null;
      }
    })(),
    `  updated:  ${m.updatedAt}${age && age !== "—" ? `  (${age})` : ""}`,
    `  created:  ${m.createdAt}`,
    `  cwd:      ${m.cwd}`,
    `  path:     ${sessionDir(m.id)}`,
    gitLine,
    projectLine,
    `  model:    ${m.provider}/${m.model}`,
    `  turns:    ${m.turnCount}  edits=${m.editCount}  msgs=${session.messages.length}` +
      (m.providerRounds && m.providerRounds > m.turnCount
        ? `  rounds=${m.providerRounds}`
        : ""),
    `  tokens:   in=${m.totalPromptTokens} out=${m.totalCompletionTokens}`,
    `  todos:    ${session.todos?.length || 0} (${openTodos} open)`,
    (() => {
      if (!m.ultrawork) return `  ultrawork: no`;
      try {
        const u = loadUlwCycle(m.id);
        if (u?.enabled && typeof u.cycle === "number") {
          return `  ultrawork: yes  ULW c=${u.cycle} w=${u.wave}`;
        }
      } catch {
        /* */
      }
      return `  ultrawork: yes`;
    })(),
    (() => {
      try {
        const g = loadGoal(m.id);
        if (g?.objective && g.status === "active") {
          const obj =
            g.objective.length > 72 ? `${g.objective.slice(0, 72)}…` : g.objective;
          return `  goal:     ${obj}${g.paused ? " (paused)" : ""}`;
        }
      } catch {
        /* */
      }
      return null;
    })(),
    `  pinned:   ${m.pinned ? "yes (/unpin to allow prune)" : "no (/pin to keep)"}`,
    m.permissionMode === "plan"
      ? `  mode:     PLAN (session-scoped — exit_plan_mode or /build)`
      : m.permissionMode
        ? `  mode:     ${m.permissionMode} (session override)`
        : null,
    isLastErrorProblem(m.lastError)
      ? `  lastErr:  [${m.lastError!.code}] ${m.lastError!.message.slice(0, 120)}`
      : null,
    (() => {
      const last = m.lastVerificationCommand?.trim();
      if (!last) return null;
      const when = m.lastVerificationAt
        ? ` @ ${m.lastVerificationAt.slice(0, 19).replace("T", " ")}`
        : "";
      const stale = isLastVerificationStale(m)
        ? "  ⚠ stale (edits after verify)"
        : "";
      return `  last-verify: ${last.slice(0, 100)}${last.length > 100 ? "…" : ""}${when}${stale}`;
    })(),
    m.lastUserPreview
      ? `  last you: ${m.lastUserPreview}`
      : null,
  ].filter((x): x is string => x != null);
  // Orient experts inspecting a session from the CLI without a full export.
  try {
    const touched = listSessionTouchedFiles(session, {
      limit: 8,
      mutatedOnly: true,
    });
    if (touched.length) {
      const bits = touched
        .slice(0, 6)
        .map((t) => t.path)
        .join(", ");
      const more = touched.length > 6 ? ` +${touched.length - 6}` : "";
      lines.push(`  files:    ${bits}${more}  (/files writes)`);
    }
  } catch {
    /* never break show on files */
  }
  try {
    const peek = formatResumePeek(session, { maxChars: 180 });
    if (peek) {
      lines.push(``, peek, `  tip:     forge --session ${m.id.slice(0, 8)}  ·  /last 3  ·  /files  ·  /retry`);
    }
  } catch {
    /* never break show on peek */
  }
  return lines.join("\n");
}

function sessionDirLooksValid(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "session.json"))) return true;
  if (fs.existsSync(path.join(dir, "meta.json"))) return true;
  // Crash mid-atomic-write: only tmp remains
  try {
    return fs
      .readdirSync(dir)
      .some((n) => n.startsWith("session.json.") && n.endsWith(".tmp"));
  } catch {
    return false;
  }
}

/**
 * Resolve full session id from:
 * 1. exact directory id
 * 2. unique id prefix (min 4 chars)
 * 3. unique exact title (case-insensitive)
 * 4. unique title / lastUserPreview substring (min 2 chars)
 *
 * Ambiguous matches return null (callers can listSessions({ query }) for hints).
 */
export function resolveSessionId(prefixOrId: string): string | null {
  const root = path.join(forgeHome(), "sessions");
  ensureDir(root);
  const raw = (prefixOrId || "").trim();
  if (!raw) return null;
  if (isValidSessionId(raw) && sessionDirLooksValid(path.join(root, raw))) {
    return raw;
  }
  // Unique id prefix (min 4 chars) — UUID fragments stay first-class.
  if (raw.length >= 4) {
    try {
      const matches = fs
        .readdirSync(root)
        .filter(
          (id) => id.startsWith(raw) && sessionDirLooksValid(path.join(root, id)),
        );
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    } catch {
      /* */
    }
  }
  // Experts remember /title labels and last prompts — not UUID prefixes.
  const q = raw.toLowerCase();
  if (q.length < 2) return null;
  try {
    // Scan sidecars directly (avoid listSessions limit defaults).
    const ids = fs.readdirSync(root).filter((id) => {
      try {
        return fs.statSync(path.join(root, id)).isDirectory();
      } catch {
        return false;
      }
    });
    const metas: SessionMeta[] = [];
    for (const id of ids) {
      try {
        // Exact-id read — never call loadSessionMeta (would re-enter resolve).
        const meta = readSessionMetaExact(id);
        if (meta) metas.push(meta);
      } catch {
        /* skip */
      }
    }
    metas.sort((a, b) => {
      const au = a.updatedAt || "";
      const bu = b.updatedAt || "";
      return bu.localeCompare(au);
    });
    const exactTitle = metas.filter(
      (m) => (m.title || "").trim().toLowerCase() === q,
    );
    if (exactTitle.length === 1) return exactTitle[0].id;
    if (exactTitle.length > 1) return null;
    const soft = metas.filter((m) => {
      const title = (m.title || "").toLowerCase();
      const prev = (m.lastUserPreview || "").toLowerCase();
      return title.includes(q) || prev.includes(q);
    });
    if (soft.length === 1) return soft[0].id;
  } catch {
    /* */
  }
  return null;
}

/** Suggest sessions when resolveSessionId fails (ambiguous / not found). */
export function suggestSessions(
  query: string,
  opts: { limit?: number; cwd?: string } = {},
): SessionMeta[] {
  const q = (query || "").trim();
  if (!q) return [];
  const limit =
    typeof opts.limit === "number" && opts.limit > 0 ? Math.floor(opts.limit) : 5;
  return listSessions({
    query: q,
    limit,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
}

/** Human error when id/title lookup fails — includes close matches when any. */
/** Shared close-match ranking for human + JSON session_not_found recovery. */
function collectSessionLookupHits(
  query: string,
  opts: { cwd?: string; limit?: number } = {},
): SessionMeta[] {
  const q = (query || "").trim();
  if (!q) return [];
  const limit =
    typeof opts.limit === "number" && opts.limit > 0 ? Math.floor(opts.limit) : 5;
  let hits = suggestSessions(q, {
    limit,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  // Title typo recovery (alpa-project → alpha-project), ranked by edit distance.
  if (!hits.length && q.length >= 4) {
    const recent = listSessions({
      limit: 40,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    hits = recent
      .map((s) => {
        const title = (s.title || "").trim();
        if (!title) return null;
        const tip = suggestName(q, [title], {
          minLength: 4,
          minScore: 36,
          requirePrefix3: false,
        });
        if (!tip) return null;
        const d = editDistance(q.toLowerCase(), title.toLowerCase());
        return { s, d };
      })
      .filter((x): x is { s: SessionMeta; d: number } => x != null)
      .sort((a, b) => a.d - b.d || b.s.updatedAt.localeCompare(a.s.updatedAt))
      .slice(0, limit)
      .map((x) => x.s);
  }
  // Id prefix / short-id typo recovery.
  if (!hits.length && q.length >= 4) {
    const recent = listSessions({
      limit: 40,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const qCompact = q.replace(/-/g, "");
    const idHits = recent.filter(
      (s) =>
        s.id.startsWith(q) || s.id.replace(/-/g, "").startsWith(qCompact),
    );
    if (idHits.length) {
      hits = idHits.slice(0, limit);
    } else {
      hits = recent
        .map((s) => {
          const short = s.id.slice(0, 8);
          const tip = suggestName(q.slice(0, 8), [short, s.id], {
            minLength: 4,
            minScore: 40,
            requirePrefix3: false,
          });
          return tip ? s : null;
        })
        .filter((s): s is SessionMeta => Boolean(s))
        .slice(0, limit);
    }
  }
  return hits;
}

export function formatSessionLookupMiss(
  query: string,
  opts: { cwd?: string; limit?: number } = {},
): string {
  const q = (query || "").trim() || "(empty)";
  const hits = q === "(empty)" ? [] : collectSessionLookupHits(q, opts);
  if (!hits.length) {
    return (
      `Session not found: ${q}\n` +
      `Try: id prefix (≥4 chars) · exact /title · unique title substring · /sessions search ${q} · forge sessions search ${q}`
    );
  }
  const lines = hits.map((s) => {
    const title = (s.title || "(untitled)").slice(0, 36);
    const prev = s.lastUserPreview
      ? `  “${s.lastUserPreview.slice(0, 28)}${s.lastUserPreview.length > 28 ? "…" : ""}”`
      : "";
    return `  ${s.id.slice(0, 8)}  ${title}${prev}`;
  });
  const multi = hits.length > 1;
  return (
    (multi
      ? `Ambiguous session “${q}” — ${hits.length} matches:\n`
      : `Session not found: ${q}\nDid you mean:\n`) +
    lines.join("\n") +
    `\nUse a longer id prefix or unique /title.`
  );
}

export interface ListSessionsOpts {
  /**
   * Max sessions to return (default 20).
   * `0` means unlimited (return all matches after filters).
   */
  limit?: number;
  /** Only sessions whose cwd resolves equal to this path. */
  cwd?: string;
  /**
   * Case-insensitive substring match against id, title, and lastUserPreview.
   * Useful for multi-project experts locating labeled sessions.
   */
  query?: string;
  /** When true, only pinned sessions. When false, only unpinned. */
  pinned?: boolean;
}

/**
 * List sessions newest-first.
 * Accepts a bare limit number (legacy) or {@link ListSessionsOpts}.
 * Filters (cwd/query) apply before the limit so multi-project lists stay complete.
 */
/** Structured close-matches for session_not_found --json (id/title/path). */
export function listSessionLookupSuggestions(
  query: string,
  opts: { cwd?: string; limit?: number } = {},
): Array<{ id: string; title: string | null; path: string; relativeAge: string }> {
  return collectSessionLookupHits(query, opts).map((s) => ({
    id: s.id,
    title: s.title || null,
    path: sessionDir(s.id),
    relativeAge: formatRelativeTime(s.updatedAt || s.createdAt),
  }));
}

export function listSessions(
  limitOrOpts: number | ListSessionsOpts = 20,
): SessionMeta[] {
  const opts: ListSessionsOpts =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts || {};
  // 0 = unlimited; positive = cap; missing/NaN/negative → default 20
  let limit = 20;
  if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
    if (opts.limit === 0) limit = Number.MAX_SAFE_INTEGER;
    else if (opts.limit > 0) limit = Math.floor(opts.limit);
  }
  let cwdFilter: string | null = null;
  if (opts.cwd) {
    try {
      cwdFilter = path.resolve(opts.cwd);
    } catch {
      cwdFilter = null;
    }
  }
  const query = (opts.query || "").trim().toLowerCase();
  const pinnedFilter =
    typeof opts.pinned === "boolean" ? opts.pinned : undefined;

  const root = path.join(forgeHome(), "sessions");
  ensureDir(root);
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root).filter((id) => {
      try {
        return fs.statSync(path.join(root, id)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const id of ids) {
    // Prefer sidecar meta.json — avoids parsing huge session.json histories.
    // One corrupt dir must never break the whole list (doctor /sessions).
    try {
      const meta = loadSessionMeta(id);
      if (!meta) continue;
      if (cwdFilter) {
        if (!meta.cwd) continue;
        try {
          if (path.resolve(meta.cwd) !== cwdFilter) continue;
        } catch {
          continue;
        }
      }
      if (pinnedFilter === true && !meta.pinned) continue;
      if (pinnedFilter === false && meta.pinned) continue;
      if (query) {
        const hay =
          `${meta.id} ${meta.title || ""} ${meta.lastUserPreview || ""}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      metas.push(meta);
    } catch {
      /* skip */
    }
  }
  metas.sort((a, b) => {
    const au = a.updatedAt || "";
    const bu = b.updatedAt || "";
    return au < bu ? 1 : au > bu ? -1 : 0;
  });
  return metas.slice(0, limit);
}

export interface RecentSessionHit {
  /** Null when every same-cwd candidate was skipped (e.g. all foreign-locked). */
  meta: SessionMeta | null;
  /** How many same-cwd sessions were skipped due to foreign live locks. */
  skippedLocked: number;
  /** Same-cwd candidates considered (after age filter). */
  candidates: number;
}

/**
 * Newest session for a workspace cwd (path-normalized).
 * Used by interactive REPL auto-resume (`forge` without --new/--session).
 *
 * Skips sessions held by another live process (foreign session.lock) so
 * experts don't auto-attach into a concurrent REPL by accident.
 *
 * Returns null only when there are no same-cwd candidates at all.
 * When candidates exist but all are locked, returns `{ meta: null, skippedLocked, candidates }`.
 *
 * @param maxAgeDays drop candidates older than this (default 14); 0 = no age filter
 */
/** Sessions forked from a given parent (conversation tree children). */
export function listSessionForks(
  parentId: string,
  opts: { limit?: number } = {},
): SessionMeta[] {
  const id = String(parentId || "").trim();
  if (!id) return [];
  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.min(50, Math.floor(opts.limit))
      : 12;
  const all = listSessions({ limit: 200 });
  return all
    .filter((m) => m.parentSessionId === id)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, limit);
}


export function findRecentSessionForCwd(
  cwd: string,
  opts?: { maxAgeDays?: number; limitScan?: number; skipLocked?: boolean },
): RecentSessionHit | null {
  const target = path.resolve(cwd);
  const maxAgeDays = opts?.maxAgeDays ?? 14;
  const skipLocked = opts?.skipLocked !== false;
  const cutoff =
    maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : 0;
  // listSessions already filters by cwd; only age + lock remain.
  const scan = listSessions({
    limit: opts?.limitScan ?? 200,
    cwd: target,
  });
  let skippedLocked = 0;
  let candidates = 0;
  for (const m of scan) {
    if (cutoff > 0) {
      const t = Date.parse(m.updatedAt || "");
      if (!Number.isFinite(t) || t < cutoff) continue;
    }
    candidates += 1;
    if (skipLocked && sessionHasForeignLiveLock(m.id)) {
      skippedLocked += 1;
      continue;
    }
    return { meta: m, skippedLocked, candidates };
  }
  if (candidates === 0) return null;
  return { meta: null, skippedLocked, candidates };
}

/** True when another live pid holds session.lock (not this process). */
export function sessionHasForeignLiveLock(sessionId: string): boolean {
  try {
    // Inline read (lock.ts imports sessionDir from this module — avoid cycle).
    const lockFile = path.join(sessionDir(sessionId), "session.lock");
    if (!fs.existsSync(lockFile)) return false;
    const raw = fs.readFileSync(lockFile, "utf8");
    const info = JSON.parse(raw) as { pid?: unknown };
    const pid = Number(info?.pid);
    // Match lock.ts validation: invalid pid → treat as absent
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(Math.trunc(pid), 0);
      return true; // foreign + alive
    } catch (err) {
      // EPERM = process exists but owned by another user — still ALIVE
      // (mirrors lock.ts pidAlive; treating it as free let delete/prune/
      // auto-resume steal foreign live sessions).
      return (
        typeof err === "object" &&
        err !== null &&
        (err as NodeJS.ErrnoException).code === "EPERM"
      );
    }
  } catch {
    return false;
  }
}

export type DeleteSessionResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not_found" | "locked"; id?: string; detail?: string };

/**
 * Delete a session directory (and lock).
 * Refuses when another live process holds session.lock unless `force: true`.
 */
export function deleteSession(
  idOrPrefix: string,
  opts?: { force?: boolean },
): boolean {
  return deleteSessionDetailed(idOrPrefix, opts).ok;
}

/** Structured delete for CLI/REPL messaging. */
export function deleteSessionDetailed(
  idOrPrefix: string,
  opts?: { force?: boolean },
): DeleteSessionResult {
  const full = resolveSessionId(idOrPrefix);
  if (!full) return { ok: false, reason: "not_found" };
  if (!opts?.force && sessionHasForeignLiveLock(full)) {
    return {
      ok: false,
      reason: "locked",
      id: full,
      detail:
        "session is locked by another live process (pass --force to delete anyway)",
    };
  }
  const dir = sessionDir(full);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      forgetFileReadsSession(full);
    } catch {
      /* best-effort — disk already gone */
    }
    return { ok: true, id: full };
  } catch {
    return { ok: false, reason: "not_found", id: full };
  }
}

export interface PruneSessionsResult {
  deleted: string[];
  kept: number;
  scanned: number;
  /** Sessions skipped because another live process holds session.lock */
  skippedLocked: number;
  /** Sessions skipped because meta.pinned (expert keep forever) */
  skippedPinned: number;
  /**
   * Sessions with lastError skipped so experts can inspect failures
   * (`/sessions errors`) before disk hygiene removes them.
   */
  skippedLastError: number;
  /** How many deleted sessions carried lastError (only when forceLastError). */
  deletedWithLastError: number;
}

/**
 * Prune old sessions for disk hygiene (experts accumulate many ULW runs).
 * Keeps the newest `keep` sessions; optionally also drops anything older than `maxAgeDays`.
 * Never deletes `protectIds` (e.g. the active REPL session).
 * Never deletes sessions held by another live process (foreign session.lock).
 * By default also skips sessions with `meta.lastError` (recovery backlog) unless
 * `forceLastError` is set — experts inspect failures via `/sessions errors` first.
 */
export function pruneSessions(opts?: {
  keep?: number;
  maxAgeDays?: number;
  protectIds?: string[];
  /** Skip foreign live locks (default true). */
  skipLocked?: boolean;
  /**
   * When true, allow pruning sessions that still carry lastError.
   * Default false so failed runs survive hygiene until reviewed.
   */
  forceLastError?: boolean;
}): PruneSessionsResult {
  // 0 is valid (keep none). NaN/negative fall back to 50.
  const keepRaw = opts?.keep;
  const keep =
    typeof keepRaw === "number" && Number.isFinite(keepRaw) && keepRaw >= 0
      ? Math.floor(keepRaw)
      : 50;
  const maxAgeDays = opts?.maxAgeDays;
  const protect = new Set(opts?.protectIds || []);
  const skipLocked = opts?.skipLocked !== false;
  const forceLastError = Boolean(opts?.forceLastError);
  const all = listSessions(10_000);
  const cutoff =
    maxAgeDays != null && maxAgeDays > 0
      ? Date.now() - maxAgeDays * 86_400_000
      : null;

  const deleted: string[] = [];
  let skippedLocked = 0;
  // Newest first from listSessions
  let skippedPinned = 0;
  let skippedLastError = 0;
  let deletedWithLastError = 0;
  all.forEach((meta, index) => {
    if (protect.has(meta.id)) return;
    if (meta.pinned) {
      skippedPinned += 1;
      return;
    }
    const ts = Date.parse(meta.updatedAt || "");
    const tooOld =
      cutoff != null && Number.isFinite(ts) && ts < cutoff;
    const overKeep = index >= keep;
    if (tooOld || overKeep) {
      if (skipLocked && sessionHasForeignLiveLock(meta.id)) {
        skippedLocked += 1;
        return;
      }
      const hasErr = isLastErrorProblem(meta.lastError);
      if (hasErr && !forceLastError) {
        skippedLastError += 1;
        return;
      }
      if (deleteSession(meta.id)) {
        deleted.push(meta.id);
        if (hasErr) deletedWithLastError += 1;
      }
    }
  });

  return {
    deleted,
    kept: all.length - deleted.length,
    scanned: all.length,
    skippedLocked,
    skippedPinned,
    skippedLastError,
    deletedWithLastError,
  };
}

/**
 * Conservative token estimate for agent transcripts (code/JSON-heavy).
 * Prefer overshooting slightly so auto-compact fires before the provider
 * hard-rejects (~500k on grok-4.5). chars/4 under-counted and let HUD show
 * ~85% while the API already saw 100%+.
 */
const CHARS_PER_TOKEN = 3.2;
/** Per-message role/framing overhead (provider chat templates). */
const MSG_FRAME_TOKENS = 6;

export function estimateTokens(
  messages: ChatMessage[],
  opts?: { includeReasoning?: boolean },
): number {
  let chars = 0;
  let msgs = 0;
  for (const m of messages) {
    msgs += 1;
    chars += (m.content || "").length;
    if (opts?.includeReasoning && m.reasoning_content) {
      chars += m.reasoning_content.length;
    }
    if (m.tool_call_id) chars += m.tool_call_id.length + 12;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars +=
          (tc.function.name || "").length +
          (tc.function.arguments || "").length +
          32;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + msgs * MSG_FRAME_TOKENS;
}

/**
 * Full request estimate including tool schemas (sent every turn, not in history).
 * `includeReasoning` is HUD-only — the prune estimator stays reasoning-free
 * so counting thoughts cannot move the 180k clip.
 */
export function estimateRequestTokens(
  messages: ChatMessage[],
  extras?: {
    toolsJsonChars?: number;
    reserveTokens?: number;
    includeReasoning?: boolean;
  },
): number {
  let n = estimateTokens(messages, {
    includeReasoning: extras?.includeReasoning,
  });
  if (extras?.toolsJsonChars && extras.toolsJsonChars > 0) {
    n += Math.ceil(extras.toolsJsonChars / CHARS_PER_TOKEN) + 48;
  }
  if (extras?.reserveTokens && extras.reserveTokens > 0) {
    n += extras.reserveTokens;
  }
  return n;
}

export function compactMessages(
  messages: ChatMessage[],
  keepLast = 12,
  context?: CompactContext,
): ChatMessage[] {
  const result = compactMessagesStructured(messages, { keepLast, context });
  // Checkpoint must not wipe FileReadState — unattended edits continue on
  // stamps whose files still match disk. Drop only vanished/changed paths.
  if (context?.sessionId && result.droppedCount > 0) {
    try {
      fileReadsForSession(context.sessionId).pruneStaleFromDiskSync();
    } catch {
      /* */
    }
  }
  return result.messages;
}

/**
 * Derive a scannable session title from a user prompt (OpenCode-style hygiene).
 * Prefer mandate/goal lines over harness boilerplate; word-boundary truncate.
 * Returns undefined for empty / pure slash-control input (no noisy titles).
 */
export function deriveSessionTitle(
  userMessage: string,
  maxChars: number = MAX_SESSION_TITLE_CHARS,
): string | undefined {
  const cap = Math.max(8, Math.min(Math.floor(maxChars) || MAX_SESSION_TITLE_CHARS, 500));
  let raw = String(userMessage ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return undefined;

  // Pure live slash controls should not become session titles
  if (/^\/[a-z][\w-]*(?:\s|$)/i.test(raw) && !raw.includes("\n")) {
    return undefined;
  }

  // Prefer explicit mandate / goal lines when present (ULW /goal wrappers)
  const mandate =
    raw.match(/^\s*User mandate:\s*(.+)$/im)?.[1] ||
    raw.match(/^\s*Mandate:\s*(.+)$/im)?.[1] ||
    raw.match(/^\s*Goal:\s*(.+)$/im)?.[1] ||
    raw.match(/^\s*Objective:\s*(.+)$/im)?.[1];
  if (
    mandate &&
    !isPlaceholderMandate(mandate) &&
    !/pending work-order/i.test(mandate)
  ) {
    raw = mandate.trim();
  }

  // Drop common harness / protocol boilerplate blocks
  const dropLine =
    /^(#{1,6}\s|[-*•]\s*(?:Counters?|ULW|cycle=|max_waves|Permission mode|Todos?\b|Attest\b|Execute relentlessly|CONTINUE relentless|The user can flip|While cycle=|When cycle=|max_waves:|Live mid-run|Start Wave|##\s*ULW|##\s*Goal|##\s*Git|##\s*Todos)|User mandate:\s*$|Execute relentlessly\b|under the ULW cycle protocol\b)/i;

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !dropLine.test(l));

  let pick =
    lines.find((l) => l.length >= 8 && !/^\/[a-z]/i.test(l)) ||
    lines[0] ||
    "";
  if (!pick) return undefined;

  // If still a giant single line, prefer first sentence-ish chunk
  if (pick.length > cap && /[.!?]/.test(pick)) {
    const m = pick.match(/^(.+?[.!?])(\s|$)/);
    if (m && m[1].length >= 12 && m[1].length <= cap) pick = m[1];
  }

  let out = pick
    .replace(/\s+/g, " ")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .trim();
  if (!out) return undefined;

  // Strip leading conversational filler that wastes the 28-char list column
  out = out.replace(
    /^(please\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|help me\s+)/i,
    "",
  );
  // Capitalize first letter for scannability (keep rest as-is for paths/code)
  if (/^[a-z]/.test(out)) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
  }

  if (out.length > cap) {
    let cut = out.slice(0, cap);
    const sp = cut.lastIndexOf(" ");
    if (sp > Math.floor(cap * 0.55)) cut = cut.slice(0, sp);
    out = cut.replace(/[.,;:]+$/g, "").trimEnd() + "…";
  }

  return out || undefined;
}

/** Set title from first user message if unset (smart derive; never overwrites). */
export function maybeSetTitle(session: SessionData, userMessage: string): void {
  if (session.meta.title) return;
  const t = deriveSessionTitle(userMessage);
  if (t) session.meta.title = t;
}

/**
 * Explicitly set (or clear) a session title. Empty/whitespace clears.
 * Returns the stored title (undefined when cleared).
 * Meta-only write: a full saveSession from a possibly-stale in-memory
 * snapshot could roll back newer messages of a racing open session.
 */
export function setSessionTitle(
  session: SessionData,
  title: string | undefined | null,
): string | undefined {
  // Safety net — callers should fail closed above this; never silent-truncate to 72.
  const t = (title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SESSION_TITLE_CHARS);
  if (!t) {
    session.meta.title = undefined;
    saveSessionMetaSidecar(session);
    return undefined;
  }
  session.meta.title = t;
  saveSessionMetaSidecar(session);
  return t;
}

/** Pin/unpin a session so prune never deletes it. Returns new pinned state. */
export function setSessionPinned(session: SessionData, pinned: boolean): boolean {
  if (pinned) session.meta.pinned = true;
  else delete session.meta.pinned;
  saveSessionMetaSidecar(session);
  return Boolean(session.meta.pinned);
}

export function isSessionPinned(sessionOrMeta: SessionData | SessionMeta): boolean {
  const m = "meta" in sessionOrMeta ? sessionOrMeta.meta : sessionOrMeta;
  return Boolean(m.pinned);
}

/** Record index of a new user turn for rewind support. */
export function markUserTurn(session: SessionData): void {
  if (!session.meta.userTurnMarks) session.meta.userTurnMarks = [];
  session.meta.userTurnMarks.push(session.messages.length);
}

/**
 * Synthetic user-role messages the harness injects into the transcript
 * itself — compact summaries, mid-conversation harness admissions, live
 * slash notices, interjection frames, stop-guard re-anchors, continue
 * steers, todo nudges. They are not real user turns: /undo and /retry must
 * never treat them as rewind boundaries (turnCount and the mutations
 * journal count real prompts only). Detected via the stable prefixes the
 * producers emit, so existing sessions on disk need no schema change.
 */
const SYNTHETIC_USER_PREFIXES = [
  "[Forge", // admissions · re-anchors · steers · nudges (all self-emitted)
  "[User control — mid-run]",
  "[Conversation compacted — ",
  "The user sent a message while you were working:",
  "[Forge harness — verify nudge]",
  "[Forge harness — fix until green]",
  "[Forge harness — background task ",
];

export function isSyntheticUserMessage(msg: ChatMessage): boolean {
  if (msg.role !== "user" || typeof msg.content !== "string") return false;
  const text = msg.content.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * Rebuild userTurnMarks from current messages after compact/load so
 * /undo and /retry never restore disk against a no-op chat rewind.
 * Synthetic harness messages (compact summary, admissions, notices) are
 * excluded — marking them made /undo cut mid-turn and revert the wrong
 * journaled mutations.
 */
export function rebuildUserTurnMarks(session: SessionData): void {
  const marks: number[] = [];
  for (let i = 0; i < session.messages.length; i++) {
    const m = session.messages[i];
    if (m?.role === "user" && !isSyntheticUserMessage(m)) marks.push(i);
  }
  session.meta.userTurnMarks = marks;
}

export interface RewindSessionResult {
  /** Messages removed from history. */
  removed: number;
  /** Turns rewound (user turns). */
  turns: number;
  /** Disk restore summary (empty when no journaled mutations). */
  disk?: RestoreMutationsResult;
}

/**
 * Rewind to before the last N user turns (default 1).
 * Also restores journaled file mutations from those turns (OpenCode-inspired).
 * Returns number of messages removed (legacy) — prefer rewindSessionDetailed.
 */
export function rewindSession(session: SessionData, turns = 1): number {
  return rewindSessionDetailed(session, turns).removed;
}

/**
 * Rewind chat + restore disk mutations for the last N user turns.
 */
export function rewindSessionDetailed(
  session: SessionData,
  turns = 1,
): RewindSessionResult {
  // Compact can leave marks past messages.length — resync first.
  let marks = session.meta.userTurnMarks || [];
  if (
    marks.length > 0 &&
    marks.some((m) => m < 0 || m >= session.messages.length)
  ) {
    rebuildUserTurnMarks(session);
    marks = session.meta.userTurnMarks || [];
  }
  if (marks.length === 0) {
    // Fallback: drop trailing messages until last real user turn
    // (synthetic harness messages are not rewind boundaries either).
    let cut = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role === "user" && !isSyntheticUserMessage(m)) {
        cut = i;
        break;
      }
    }
    if (cut < 0) return { removed: 0, turns: 0 };
    const removed = session.messages.length - cut;
    if (removed <= 0) return { removed: 0, turns: 0 };
    const prevTurn = session.meta.turnCount;
    session.messages = session.messages.slice(0, cut);
    session.meta.turnCount = Math.max(0, session.meta.turnCount - 1);
    rebuildUserTurnMarks(session);
    const disk = restoreMutationsAfterTurn(
      session.meta.id,
      session.meta.turnCount,
    );
    try {
      const trail = editTrailFromMutations(session.meta.id);
      session.meta.editCount = trail.editCount;
      if (trail.lastEditAt) session.meta.lastEditAt = trail.lastEditAt;
      else delete session.meta.lastEditAt;
    } catch {
      /* best-effort */
    }
    saveSession(session);
    return {
      removed,
      turns: prevTurn > session.meta.turnCount ? 1 : 0,
      disk,
    };
  }
  const n = Math.max(1, Math.min(turns, marks.length));
  const cut = marks[marks.length - n];
  if (typeof cut !== "number" || cut < 0 || cut >= session.messages.length) {
    rebuildUserTurnMarks(session);
    return { removed: 0, turns: 0 };
  }
  const removed = session.messages.length - cut;
  // Never restore disk if chat rewind is a no-op (stale marks after compact).
  if (removed <= 0) {
    rebuildUserTurnMarks(session);
    saveSession(session);
    return { removed: 0, turns: 0 };
  }
  session.messages = session.messages.slice(0, cut);
  session.meta.userTurnMarks = marks.slice(0, marks.length - n);
  session.meta.turnCount = Math.max(0, session.meta.turnCount - n);
  rebuildUserTurnMarks(session);
  const disk = restoreMutationsAfterTurn(
    session.meta.id,
    session.meta.turnCount,
  );
  try {
    const trail = editTrailFromMutations(session.meta.id);
    session.meta.editCount = trail.editCount;
    if (trail.lastEditAt) session.meta.lastEditAt = trail.lastEditAt;
    else delete session.meta.lastEditAt;
  } catch {
    /* best-effort */
  }
  saveSession(session);
  return { removed, turns: n, disk };
}

export function exportSessionMarkdown(session: SessionData): string {
  const cwd = session.meta.cwd || process.cwd();
  let projectLine: string | null = null;
  try {
    const intel = detectProjectIntel(cwd);
    const bits = [
      intel.packageName
        ? intel.packageVersion
          ? `${intel.packageName}@${intel.packageVersion}`
          : intel.packageName
        : null,
      intel.packageManager || null,
      intel.checkCommands.length
        ? `checks=${intel.checkCommands.slice(0, 4).join(" | ")}`
        : null,
      intel.monorepoRoot
        ? `mono=${path.basename(intel.monorepoRoot)}`
        : null,
    ].filter(Boolean);
    if (bits.length) projectLine = `- Project: ${bits.join(" · ")}`;
  } catch {
    projectLine = null;
  }
  let lastVerifyLine: string | null = null;
  const last = session.meta.lastVerificationCommand?.trim();
  if (last) {
    const when = session.meta.lastVerificationAt
      ? ` @ ${session.meta.lastVerificationAt.slice(0, 19).replace("T", " ")}`
      : "";
    const stale = isLastVerificationStale(session.meta)
      ? "  ⚠ stale (edits after verify)"
      : "";
    lastVerifyLine =
      `- Last verify: \`${last.slice(0, 120)}\`${last.length > 120 ? "…" : ""}${when}${stale}`;
  }
  const lines: string[] = [
    `# Forge session ${session.meta.id}`,
    ``,
    `- Created: ${session.meta.createdAt}`,
    `- Updated: ${session.meta.updatedAt}`,
    `- Model: ${session.meta.provider}/${session.meta.model}`,
    `- Title: ${session.meta.title || "(untitled)"}`,
    session.meta.parentSessionId
      ? `- Forked from: ${session.meta.parentSessionLabel || session.meta.parentSessionId.slice(0, 8)} (${session.meta.parentSessionId})`
      : null,
    `- Cwd: ${cwd}`,
    `- Turns: ${session.meta.turnCount || 0}  edits=${session.meta.editCount || 0}  msgs=${session.messages.length}`,
    projectLine,
    lastVerifyLine,
    `- Tokens: in=${session.meta.totalPromptTokens} out=${session.meta.totalCompletionTokens}`,
    (() => {
      try {
        const cost = estimateCostUsd(
          session.meta.provider || "xai",
          session.meta.totalPromptTokens || 0,
          session.meta.totalCompletionTokens || 0,
          session.meta.model,
          session.meta.totalCacheReadTokens || 0,
        );
        const bits = [`- Est. cost: ${formatCost(cost)}`];
        const family = formatFamilyCostLines(
          familyCostBreakdown(session.meta),
        );
        for (const line of family) bits.push(`- ${line.trim()}`);
        if (
          session.meta.maxCostUsd !== undefined &&
          session.meta.maxCostUsd !== null
        ) {
          const st = costCapStatus(
            {
              maxCostUsd: 0,
              provider: session.meta.provider || "xai",
              model: session.meta.model,
            },
            session.meta,
          );
          bits.push(`- ${formatCostBudgetLine(st)}`);
        }
        return bits.join("\n");
      } catch {
        return null;
      }
    })(),
    isLastErrorProblem(session.meta.lastError)
      ? `- Last error: [${session.meta.lastError!.code}] ${session.meta.lastError!.message}` +
        (session.meta.lastError!.tips?.[0]
          ? ` → ${session.meta.lastError!.tips[0]}`
          : "")
      : null,
    session.meta.lastModelFallback
      ? `- Last model hop: ${session.meta.lastModelFallback.from} → ${session.meta.lastModelFallback.to}`
      : null,
    ``,
    `---`,
    ``,
  ].filter((x): x is string => x != null);
  for (const m of session.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      lines.push(`### tool (${m.tool_call_id || "?"})`);
      lines.push("```");
      lines.push((m.content || "").slice(0, 4000));
      lines.push("```");
      lines.push("");
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      lines.push(`### assistant`);
      if (m.content) lines.push(m.content);
      for (const tc of m.tool_calls) {
        lines.push(
          `- tool_call \`${tc.function.name}\`(\`${tc.function.arguments.slice(0, 200)}\`)`,
        );
      }
      lines.push("");
      continue;
    }
    lines.push(`### ${m.role}`);
    lines.push(m.content || "");
    lines.push("");
  }
  return lines.join("\n");
}

export function lastAssistantText(session: SessionData): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "assistant" && m.content) return m.content;
  }
  return "";
}

export type TouchedFileOp = "read" | "write" | "edit" | "delete" | "patch" | "other";

export interface TouchedFile {
  path: string;
  /** Last mutating/read op seen for this path (newest wins). */
  op: TouchedFileOp;
  /** Tools that referenced the path (newest last, unique). */
  tools: string[];
  /** True if any write/edit/delete/patch touched it. */
  mutated: boolean;
}

const PATH_ARG_KEYS = [
  "path",
  "file",
  "filepath",
  "file_path",
  "filename",
  "target",
  "dest",
  "destination",
  "to",
  "from",
  "old_path",
  "new_path",
  "src",
  "source",
] as const;

function classifyToolOp(tool: string): TouchedFileOp {
  const t = tool.toLowerCase();
  if (t === "read_file" || t === "read") return "read";
  if (t === "write_file" || t === "write") return "write";
  if (t === "search_replace" || t === "edit" || t === "str_replace") return "edit";
  if (t === "apply_patch" || t === "applypatch") return "patch";
  if (t.includes("delete") || t === "rm") return "delete";
  return "other";
}

function opMutates(op: TouchedFileOp): boolean {
  return op === "write" || op === "edit" || op === "delete" || op === "patch";
}

function pushTouchedPath(
  map: Map<string, TouchedFile>,
  order: string[],
  rawPath: string,
  tool: string,
): void {
  const p = String(rawPath || "").trim();
  if (!p || p.length > 512) return;
  // Skip obvious non-paths / URLs
  if (/^https?:\/\//i.test(p)) return;
  if (p.includes("\0")) return;
  const op = classifyToolOp(tool);
  const prev = map.get(p);
  if (!prev) {
    map.set(p, {
      path: p,
      op,
      tools: [tool],
      mutated: opMutates(op),
    });
    order.push(p);
    return;
  }
  prev.op = op;
  prev.mutated = prev.mutated || opMutates(op);
  if (!prev.tools.includes(tool)) prev.tools.push(tool);
}

function collectPathsFromArgs(
  map: Map<string, TouchedFile>,
  order: string[],
  tool: string,
  args: Record<string, unknown>,
): void {
  for (const k of PATH_ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) {
      pushTouchedPath(map, order, v, tool);
    }
  }
  // apply_patch: extract paths from patch grammar without full apply
  const patch =
    typeof args.patchText === "string"
      ? args.patchText
      : typeof args.patch === "string"
        ? args.patch
        : "";
  if (patch && (tool === "apply_patch" || /Begin Patch/i.test(patch))) {
    for (const line of patch.split(/\r?\n/)) {
      const m = line.match(
        /^\*\*\*\s+(?:Add|Update|Delete|Move)\s+File:\s+(.+)$/i,
      );
      if (m?.[1]) pushTouchedPath(map, order, m[1].trim(), tool);
      const m2 = line.match(/^\*\*\*\s+Move\s+to:\s+(.+)$/i);
      if (m2?.[1]) pushTouchedPath(map, order, m2[1].trim(), tool);
    }
  }
}

/**
 * Paths referenced by tool calls in this session (newest last).
 * Used by `/files` so experts can re-orient after resume without grepping history.
 */
export function listSessionTouchedFiles(
  session: SessionData,
  opts?: { limit?: number; mutatedOnly?: boolean },
): TouchedFile[] {
  const limit =
    typeof opts?.limit === "number" && opts.limit > 0
      ? Math.min(200, Math.floor(opts.limit))
      : 40;
  const map = new Map<string, TouchedFile>();
  const order: string[] = [];
  for (const m of session.messages) {
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    for (const tc of m.tool_calls) {
      const tool = tc.function?.name || "tool";
      let args: Record<string, unknown> = {};
      try {
        // Lazy import avoided — keep session free of heavy deps; JSON.parse is enough
        // for path extraction (truncated args still often have "path":"...").
        const raw = tc.function?.arguments || "";
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        }
      } catch {
        // Best-effort regex for "path":"..."
        const raw = tc.function?.arguments || "";
        const pm = raw.match(/"(?:path|file|filepath|file_path)"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (pm?.[1]) {
          try {
            pushTouchedPath(
              map,
              order,
              JSON.parse(`"${pm[1]}"`) as string,
              tool,
            );
          } catch {
            pushTouchedPath(map, order, pm[1].replace(/\\"/g, '"'), tool);
          }
        }
        // apply_patch may still have *** lines even when JSON is broken
        if (raw.includes("***")) {
          collectPathsFromArgs(map, order, tool, { patchText: raw });
        }
        continue;
      }
      collectPathsFromArgs(map, order, tool, args);
    }
  }
  let items = order.map((p) => map.get(p)!).filter(Boolean);
  if (opts?.mutatedOnly) items = items.filter((t) => t.mutated);
  // Newest last in order — reverse for display (newest first)
  items = items.slice().reverse();
  return items.slice(0, limit);
}

/** Human list for `/files` and resume orientation. */
export function formatSessionTouchedFiles(
  session: SessionData,
  opts?: { limit?: number; mutatedOnly?: boolean },
): string {
  const items = listSessionTouchedFiles(session, opts);
  if (!items.length) {
    return opts?.mutatedOnly
      ? "No file mutations recorded in this session yet."
      : "No file paths recorded in tool calls yet.";
  }
  const width = Math.max(
    24,
    process.stdout.isTTY ? (process.stdout.columns ?? 80) : 80,
  );
  const lines = items.map((t) => {
    const tag = t.mutated
      ? t.op === "delete"
        ? "D"
        : t.op === "write"
          ? "A"
          : t.op === "patch"
            ? "P"
            : "M"
      : "R";
    const prefix = `  ${tag}  `;
    const tools =
      t.tools.length > 1
        ? `  (${t.tools.slice(-3).join(", ")})`
        : t.tools[0]
          ? `  (${t.tools[0]})`
          : "";
    let row = `${prefix}${t.path}${tools}`;
    if (visibleWidth(row) > width) {
      row = `${prefix}${t.path}`;
    }
    if (visibleWidth(row) > width) {
      const pathBudget = Math.max(8, width - visibleWidth(prefix));
      row = `${prefix}${clipAnsi(t.path, pathBudget)}`;
    }
    return row;
  });
  const scope = opts?.mutatedOnly ? "mutations" : "paths";
  return (
    `Session files (${items.length} ${scope}, newest first):\n` +
    lines.join("\n") +
    `\nR=read  A=write  M=edit  P=patch  D=delete  ·  /files writes  ·  /diff --full`
  );
}

/**
 * Most recent non-empty user message text (for /retry).
 * Skips empty/whitespace-only turns.
 */
export function lastUserText(session: SessionData): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role !== "user") continue;
    if (isSyntheticUserMessage(m)) continue;
    const t = (m.content || "").trim();
    if (t) return t;
  }
  return "";
}

function clipPreview(text: string, max: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "(empty)";
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Soft-wrap a single paragraph to `width` (spaces preferred, then hard-break). */
export function wrapPlain(text: string, width: number): string[] {
  const w = Math.max(16, width);
  const t = String(text ?? "").replace(/\s+$/u, "");
  if (!t) return [""];
  if (visibleWidth(t) <= w) return [t];
  const parts = t.split(/(\s+)/);
  const rows: string[] = [];
  let cur = "";
  const flush = (): void => {
    const s = cur.replace(/\s+$/u, "");
    if (s) rows.push(s);
    cur = "";
  };
  const hardBreak = (token: string): void => {
    let rest = token;
    while (visibleWidth(rest) > w) {
      let acc = "";
      let i = 0;
      for (; i < rest.length; i++) {
        if (visibleWidth(acc + rest[i]) > w) break;
        acc += rest[i];
      }
      if (!acc) {
        acc = rest[0]!;
        i = 1;
      }
      rows.push(acc);
      rest = rest.slice(i);
    }
    cur = rest;
  };
  for (const part of parts) {
    if (!part) continue;
    if (cur && visibleWidth(cur + part) > w) {
      flush();
      if (visibleWidth(part) > w) hardBreak(part.trimStart());
      else cur = part.trimStart();
    } else {
      cur += part;
    }
  }
  flush();
  return rows.length ? rows : [""];
}

function formatTurnBubble(
  label: string,
  text: string,
  maxChars: number,
  width: number,
): string[] {
  const raw = String(text ?? "").replace(/^\s+|\s+$/gu, "");
  if (!raw) return [`${label} (empty)`];
  const clipped =
    raw.length > maxChars
      ? `${raw.slice(0, Math.max(0, maxChars - 1)).replace(/\s+$/u, "")}…`
      : raw;
  const inner = Math.max(16, width - 2);
  const out = [label];
  for (const para of clipped.split("\n")) {
    for (const row of wrapPlain(para, inner)) out.push(`  ${row}`);
  }
  return out;
}

/**
 * Session-scoped files + verify + lastErr trailer for the `/last` card.
 * Compact resume peeks stay one-row — they already have formatCompactResumeCard.
 * lastErr Next is a slash key (same as sit-down), not a CLI dump.
 */
export function formatLastRecapTrailer(
  session: SessionData,
  width: number,
): string[] {
  const cols = Math.max(24, width);
  const clipRow = (s: string): string =>
    visibleWidth(s) > cols ? clipAnsi(s, cols) : s;
  const lines: string[] = [];
  const err = session.meta.lastError;
  const errNext = sitDownNextForLastError(err);
  if (isLastErrorProblem(err) && err?.message) {
    const msg = err.message.replace(/\s+/g, " ").trim().slice(0, 80);
    lines.push(clipRow(chalk.red(`  lastErr  [${err.code}] ${msg}`)));
  }
  let files: TouchedFile[] = [];
  try {
    files = listSessionTouchedFiles(session, { mutatedOnly: true, limit: 6 });
  } catch {
    /* journal / messages are best-effort */
  }
  if (files.length) {
    const names = files.map((t) =>
      t.op === "write" ? `${t.path} (new)` : t.op === "delete" ? `${t.path} (del)` : t.path,
    );
    const prefix = "  files  ";
    let shown = names.slice(0, 4);
    let more =
      names.length > shown.length ? ` +${names.length - shown.length} more` : "";
    while (
      shown.length > 1 &&
      visibleWidth(`${prefix}${shown.join(", ")}${more}`) > cols
    ) {
      shown = shown.slice(0, -1);
      more = ` +${names.length - shown.length} more`;
    }
    let mid = `${shown.join(", ")}${more}`;
    if (visibleWidth(prefix + mid) > cols) {
      mid = clipAnsi(mid, Math.max(8, cols - visibleWidth(prefix)));
    }
    lines.push(clipRow(`${prefix}${mid}`));
  }

  const lv = session.meta.lastVerificationCommand?.trim();
  const stale = isLastVerificationStale(session.meta);
  const red = session.meta.lastVerificationOk === false;
  const edits = (session.meta.editCount || 0) > 0 || files.length > 0;
  if (lv) {
    const mark = stale ? " (stale — predates last edit)" : red ? " ✗" : " ✓";
    const text = `  verify: ${lv}${mark}`;
    lines.push(clipRow(stale || red ? chalk.yellow(text) : chalk.dim(text)));
  } else if (edits) {
    lines.push(clipRow(chalk.yellow("  verify: none — /verify")));
  }

  const verifyProblem = Boolean(stale || red || (edits && !lv));
  const keys: string[] = [];
  if (errNext) keys.push(errNext);
  if (verifyProblem && !keys.includes("/verify")) keys.push("/verify");
  if (files.length || lv || edits) {
    for (const k of verifyProblem
      ? ["/diff", "/files"]
      : ["/diff", "/files", "/undo"]) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  if (keys.length) {
    const closer = errNext
      ? `Next  ${keys.join("  ·  ")}`
      : `  ↳ ${keys.join("  ·  ")}`;
    lines.push(clipRow(chalk.dim(closer)));
  }
  return lines;
}

/**
 * Last N user/assistant turns.
 * Default is a wrapped conversation card (`/last`). Pass `compact: true`
 * for the one-row resume peek (banner / session show).
 */
export function formatRecentTurns(
  session: SessionData,
  opts?: { turns?: number; maxChars?: number; compact?: boolean },
): string {
  const turnsWanted = Math.max(1, Math.min(20, opts?.turns ?? 1));
  const compact = opts?.compact === true;
  const maxChars = Math.max(
    40,
    Math.min(2000, opts?.maxChars ?? (compact ? 320 : 900)),
  );

  type Block =
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string; tools: string[] };

  const blocks: Block[] = [];
  for (const m of session.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (isSyntheticUserMessage(m)) continue;
      const text = (m.content || "").trim();
      if (!text) continue;
      blocks.push({ kind: "user", text });
      continue;
    }
    if (m.role === "assistant") {
      const tools = (m.tool_calls || []).map((tc) => tc.function.name);
      const text = (m.content || "").trim();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "assistant" && !text && tools.length) {
        prev.tools.push(...tools);
        continue;
      }
      blocks.push({ kind: "assistant", text, tools });
      continue;
    }
    // tool results — fold into preceding assistant summary when present
    if (m.role === "tool") {
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "assistant") {
        if (!prev.tools.includes("tool")) prev.tools.push("·");
      }
    }
  }

  // Group into user-led turns (assistant-only preamble kept as its own turn)
  type Turn = { user?: string; assistants: Array<{ text: string; tools: string[] }> };
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const b of blocks) {
    if (b.kind === "user") {
      cur = { user: b.text, assistants: [] };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { assistants: [] };
        turns.push(cur);
      }
      cur.assistants.push({ text: b.text, tools: b.tools });
    }
  }

  const width = Math.max(
    24,
    process.stdout.isTTY ? (process.stdout.columns ?? 80) : 80,
  );
  if (turns.length === 0) {
    if (compact) return "No user/assistant turns in this session yet.";
    const trailer = formatLastRecapTrailer(session, width);
    return [
      "No user/assistant turns in this session yet.",
      ...(trailer.length
        ? trailer
        : [chalk.dim("  ↳ type a task  ·  /diff  ·  /help")]),
    ].join("\n");
  }

  const slice = turns.slice(-turnsWanted);
  const startIdx = turns.length - slice.length + 1;
  const clipRow = (s: string): string =>
    visibleWidth(s) > width ? clipAnsi(s, width) : s;
  const lines: string[] = [
    clipRow(
      `Last ${slice.length} turn(s) of ${turns.length}` +
        (session.meta.title ? ` — ${session.meta.title}` : "") +
        ` · ${session.meta.id.slice(0, 8)}`,
    ),
  ];

  slice.forEach((t, i) => {
    const n = startIdx + i;
    lines.push("");
    lines.push(clipRow(`── turn ${n} ──`));
    const texts = t.assistants.map((a) => a.text).filter(Boolean);
    const tools = t.assistants
      .flatMap((a) => a.tools)
      .filter((x) => x && x !== "·");
    const uniqTools = [...new Set(tools)].map(formatToolDisplayName);
    if (compact) {
      if (t.user) {
        lines.push(clipRow(`you:  ${clipPreview(t.user, maxChars)}`));
      }
      if (t.assistants.length === 0) {
        lines.push(clipRow(`forge: (no assistant reply yet)`));
      } else {
        const body = texts.join(" ").trim();
        if (body) lines.push(clipRow(`forge: ${clipPreview(body, maxChars)}`));
        else if (uniqTools.length) lines.push(clipRow(`forge: (tool calls only)`));
        else lines.push(clipRow(`forge: (empty)`));
      }
    } else {
      if (t.user) {
        lines.push(
          ...formatTurnBubble(chalk.cyan("you ›"), t.user, maxChars, width),
        );
      }
      if (t.assistants.length === 0) {
        lines.push(chalk.dim("forge ›  (no assistant reply yet)"));
      } else {
        const body = texts.join("\n\n").trim();
        if (body) {
          lines.push(
            ...formatTurnBubble(chalk.dim("forge ›"), body, maxChars, width),
          );
        } else if (uniqTools.length) {
          lines.push(chalk.dim("forge ›  (tool calls only)"));
        } else {
          lines.push(chalk.dim("forge ›  (empty)"));
        }
      }
    }
    if (uniqTools.length) {
      const shown = uniqTools.slice(0, 8);
      const more = uniqTools.length - shown.length;
      lines.push(
        clipRow(
          chalk.dim(
            `tools  ${shown.join(" · ")}${more > 0 ? ` +${more}` : ""}`,
          ),
        ),
      );
    }
  });

  if (!compact) {
    const trailer = formatLastRecapTrailer(session, width);
    if (trailer.length) {
      lines.push("");
      lines.push(...trailer);
    }
  }

  return lines.join("\n");
}

/**
 * Compact one-turn peek for resume banners (auto-resume + /resume).
 * Returns empty string when the session has no user/assistant turns yet.
 */
export function formatResumePeek(
  session: SessionData,
  opts?: { maxChars?: number },
): string {
  const hasTurn = session.messages.some((m) => {
    if (m.role === "user") {
      return !isSyntheticUserMessage(m) && Boolean((m.content || "").trim());
    }
    if (m.role === "assistant") {
      return Boolean((m.content || "").trim() || m.tool_calls?.length);
    }
    return false;
  });
  if (!hasTurn) return "";
  return formatRecentTurns(session, {
    turns: 1,
    maxChars: opts?.maxChars ?? 200,
    compact: true,
  });
}

/**
 * True when a recorded last-verify is older than the latest file edit.
 * Experts must not trust a green trail after subsequent mutations.
 */
export function isLastVerificationStale(meta: {
  lastVerificationAt?: string;
  lastEditAt?: string;
  editCount?: number;
}): boolean {
  const v = meta.lastVerificationAt?.trim();
  const e = meta.lastEditAt?.trim();
  if (!v || !e) return false;
  const vt = Date.parse(v);
  const et = Date.parse(e);
  if (!Number.isFinite(vt) || !Number.isFinite(et)) return false;
  return et > vt;
}

/**
 * First-paint resume card (banner + auto-resume). Two lines max:
 *   you: last intent  ·  PLAN/lastErr
 *   files  ·  Last verify
 * Full /resume keeps the verbose dump.
 */
export function formatCompactResumeCard(
  session: SessionData,
  opts?: { maxChars?: number; fileLimit?: number },
): string {
  const maxChars = Math.max(40, Math.min(240, opts?.maxChars ?? 180));
  const fileLimit = opts?.fileLimit ?? 4;
  const flags: string[] = [];
  try {
    if (session.meta.permissionMode === "plan") flags.push("PLAN");
    else if (
      session.meta.permissionMode &&
      session.meta.permissionMode !== "default" &&
      session.meta.permissionMode !== "acceptEdits"
    ) {
      flags.push(String(session.meta.permissionMode));
    }
  } catch {
    /* */
  }
  try {
    const le = session.meta.lastError;
    if (isLastErrorProblem(le) && le?.code) flags.push(`lastErr ${le.code}`);
  } catch {
    /* */
  }
  const headBits: string[] = [];
  try {
    const you = lastUserText(session);
    if (you) headBits.push(`you: ${clipPreview(you, maxChars)}`);
  } catch {
    /* */
  }
  headBits.push(...flags);

  const trail: string[] = [];
  try {
    const touched = listSessionTouchedFiles(session, {
      limit: fileLimit,
      mutatedOnly: true,
    });
    if (touched.length) {
      const bits = touched.map((t) => t.path).join(", ");
      trail.push(`${bits}${touched.length >= fileLimit ? "…" : ""}`);
    }
  } catch {
    /* */
  }
  try {
    const last = session.meta.lastVerificationCommand?.trim();
    if (last) {
      const stale = isLastVerificationStale(session.meta) ? " ⚠ stale" : "";
      trail.push(
        `Last verify: ${last.slice(0, 48)}${last.length > 48 ? "…" : ""}${stale}`,
      );
    } else if ((session.meta.editCount || 0) > 0) {
      trail.push(`Last verify: (none after ${session.meta.editCount} edit(s))`);
    }
  } catch {
    /* */
  }
  return [headBits.join("  ·  "), trail.join("  ·  ")]
    .filter((l) => l.trim())
    .join("\n");
}

function wrapResumeKeys(line: string, cols: number): string {
  if (visibleWidth(line) <= cols) return line;
  const caret = "  ↳ ";
  const body = line.startsWith(caret) ? line.slice(caret.length) : line;
  const tokens = body
    .split(" · ")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return line;
  const out: string[] = [`${caret}${tokens[0]}`];
  for (const tok of tokens.slice(1)) out.push(`    · ${tok}`);
  return out.join("\n");
}

export function formatResumeOrientation(
  session: SessionData,
  opts?: {
    maxChars?: number;
    fileLimit?: number;
    compact?: boolean;
    columns?: number;
  },
): string {
  const compact = opts?.compact === true;
  if (compact) return formatCompactResumeCard(session, opts);
  const cols = Math.max(
    24,
    opts?.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  const clip = (s: string): string =>
    visibleWidth(s) > cols ? clipAnsi(s, cols) : s;
  const parts: string[] = [];
  try {
    const peek = formatResumePeek(session, { maxChars: opts?.maxChars });
    if (peek) parts.push(peek);
  } catch {
    /* */
  }
  try {
    if (session.meta.permissionMode === "plan") {
      parts.push("PLAN  ·  /build");
    } else if (
      session.meta.permissionMode &&
      session.meta.permissionMode !== "default" &&
      session.meta.permissionMode !== "acceptEdits"
    ) {
      parts.push(`mode  ${session.meta.permissionMode}`);
    }
  } catch {
    /* */
  }
  try {
    const le = session.meta.lastError;
    if (isLastErrorProblem(le) && le?.message) {
      parts.push(
        `Last error: [${le.code}] ${le.message.slice(0, 140)}` +
          (le.tips?.[0] ? ` → ${le.tips[0]}` : ""),
      );
    }
  } catch {
    /* */
  }
  try {
    const hop = session.meta.lastModelFallback;
    if (hop?.from && hop.to && !compact) {
      parts.push(`Last model hop: ${hop.from} → ${hop.to}`);
    }
  } catch {
    /* */
  }
  try {
    // Surface spend cap on resume so experts see the valve before continuing.
    // Session override is what matters on resume (config may differ on host).
    if (
      !compact &&
      session.meta.maxCostUsd !== undefined &&
      session.meta.maxCostUsd !== null
    ) {
      const st = costCapStatus(
        {
          maxCostUsd: 0,
          provider: session.meta.provider || "xai",
          model: session.meta.model,
        },
        session.meta,
      );
      parts.push(formatCostBudgetLine(st));
    }
  } catch {
    /* */
  }
  try {
    const touched = listSessionTouchedFiles(session, {
      limit: opts?.fileLimit ?? 6,
      mutatedOnly: true,
    });
    if (touched.length) {
      const bits = touched.map((t) => t.path).join(", ");
      parts.push(
        `files  ${bits}${touched.length >= (opts?.fileLimit ?? 6) ? "…" : ""}  ·  /files`,
      );
    }
  } catch {
    /* */
  }
  try {
    // Preferred checks so resume doesn't require rediscovering the stack.
    if (compact) throw new Error("skip");
    const intel = detectProjectIntel(session.meta.cwd || process.cwd());
    if (intel.checkCommands[0]) {
      parts.push(
        `Checks: ${intel.checkCommands.slice(0, 3).join(" · ")}` +
          (intel.packageManager ? `  (pm=${intel.packageManager})` : ""),
      );
    }
  } catch {
    /* */
  }
  try {
    const last = session.meta.lastVerificationCommand?.trim();
    if (last) {
      const when = session.meta.lastVerificationAt
        ? ` @ ${session.meta.lastVerificationAt.slice(0, 19).replace("T", " ")}`
        : "";
      const stale = isLastVerificationStale(session.meta)
        ? "  ⚠ stale (edits after verify)"
        : "";
      parts.push(
        `Last verify: ${last.slice(0, 80)}${last.length > 80 ? "…" : ""}${when}${stale}`,
      );
    } else if ((session.meta.editCount || 0) > 0) {
      let tip = "npm test / typecheck";
      try {
        const intel = detectProjectIntel(session.meta.cwd || process.cwd());
        if (intel.checkCommands[0]) tip = intel.checkCommands[0];
      } catch {
        /* */
      }
      parts.push(
        `Last verify: (none after ${session.meta.editCount} edit(s) — prefer \`${tip}\`)`,
      );
    }
  } catch {
    /* */
  }
  try {
    if (compact) throw new Error("skip");
    const n = listActiveProjectMemory(
      session.meta.cwd || process.cwd(),
    ).length;
    if (n > 0) {
      parts.push(
        `Project memory: ${n} note${n === 1 ? "" : "s"}  (/memory project)`,
      );
    }
  } catch {
    /* */
  }
  try {
    if (compact) throw new Error("skip");
    let cp = session.meta.lastCheckpoint;
    if (!cp) {
      try {
        cp = loadUlwCycle(session.meta.id)?.checkpointSha;
      } catch {
        /* */
      }
    }
    if (cp) {
      parts.push(`Checkpoint: ${cp.slice(0, 12)}…  (/checkpoint restore)`);
    }
  } catch {
    /* */
  }
  try {
    if (session.meta.parentSessionId && !compact) {
      const pl =
        session.meta.parentSessionLabel ||
        session.meta.parentSessionId.slice(0, 8);
      parts.push(
        `Forked from: ${pl} (${session.meta.parentSessionId.slice(0, 8)}…)`,
      );
    }
  } catch {
    /* */
  }
  const body = parts.map(clip);
  if (body.length) {
    body.push(wrapResumeKeys("  ↳ type a task  ·  /diff  ·  /last", cols));
  }
  return body.join("\n");
}

/**
 * Pasteable session card for handoff / Slack / tickets.
 * No secrets — ids, labels, and resume/export commands only.
 */
export function formatSessionShareCard(
  session: SessionData,
  opts?: { includePreview?: boolean; previewChars?: number },
): string {
  const m = session.meta;
  const id8 = m.id.slice(0, 8);
  const title = (m.title || "untitled").slice(0, MAX_SESSION_TITLE_CHARS);
  const cwd = m.cwd || "(unknown cwd)";
  let ulwFlag: string | null = null;
  if (m.ultrawork) {
    try {
      const u = loadUlwCycle(m.id);
      ulwFlag =
        u?.enabled && typeof u.cycle === "number"
          ? `ULW c=${u.cycle} w=${u.wave}`
          : "ULW";
    } catch {
      ulwFlag = "ULW";
    }
  }
  let goalLine: string | null = null;
  try {
    const g = loadGoal(m.id);
    if (g?.objective && g.status === "active") {
      const obj =
        g.objective.length > 80 ? `${g.objective.slice(0, 80)}…` : g.objective;
      goalLine = `  goal:     ${obj}${g.paused ? " (paused)" : ""}`;
    }
  } catch {
    /* */
  }
  const flags = [
    ulwFlag,
    m.pinned ? "PIN" : null,
    m.permissionMode === "plan"
      ? "PLAN"
      : m.permissionMode && m.permissionMode !== "default"
        ? `perms=${m.permissionMode}`
        : null,
  ].filter(Boolean);
  const titleResume =
    m.title && m.title !== "untitled"
      ? `  forge --session ${JSON.stringify(m.title)}   # by /title`
      : null;
  const dir = sessionDir(m.id);
  let gitLine: string | null = null;
  let projectLine: string | null = null;
  try {
    const git = getGitSnapshot(m.cwd || process.cwd());
    if (git.branch) {
      const dirty = git.dirty ? " dirty" : "";
      const ch =
        typeof git.changedFiles === "number" ? ` Δ${git.changedFiles}` : "";
      const wt = git.isWorktree ? " worktree" : "";
      gitLine = `  git:      ${git.branch}${dirty}${ch}${wt}`;
    }
  } catch {
    /* */
  }
  try {
    const intel = detectProjectIntel(m.cwd || process.cwd());
    let skillsBit: string | null = null;
    try {
      const n = countProjectSkills(m.cwd || process.cwd());
      if (n > 0) skillsBit = `skills=${n}`;
    } catch {
      /* */
    }
    const bits = [
      intel.packageName
        ? intel.packageVersion
          ? `${intel.packageName}@${intel.packageVersion}`
          : intel.packageName
        : null,
      intel.packageManager || null,
      intel.kinds.length ? intel.kinds.join(",") : null,
      intel.checkCommands.length
        ? `checks=${intel.checkCommands.slice(0, 3).join(" | ")}`
        : null,
      intel.monorepoRoot
        ? `mono=${path.basename(intel.monorepoRoot)}`
        : null,
      skillsBit,
    ].filter(Boolean);
    if (bits.length) projectLine = `  project:  ${bits.join(" · ")}`;
  } catch {
    /* */
  }
  let memoryLine: string | null = null;
  try {
    const n = listActiveProjectMemory(m.cwd || process.cwd()).length;
    if (n > 0) memoryLine = `  memory:   ${n} project note${n === 1 ? "" : "s"} · /memory project`;
  } catch {
    /* */
  }
  let forkLine: string | null = null;
  if (m.parentSessionId) {
    forkLine = `  forked:   ${(m.parentSessionLabel || m.parentSessionId.slice(0, 8)).slice(0, 40)} ← ${m.parentSessionId.slice(0, 8)}…`;
  }
  let checkpointLine: string | null = null;
  if (m.lastCheckpoint) {
    checkpointLine = `  checkpoint: ${m.lastCheckpoint.slice(0, 12)}… · /checkpoint restore`;
  } else {
    try {
      const u = loadUlwCycle(m.id);
      if (u?.checkpointSha) {
        checkpointLine = `  checkpoint: ${u.checkpointSha.slice(0, 12)}… (ulw) · /checkpoint restore`;
      }
    } catch {
      /* */
    }
  }
  let lastVerifyLine: string | null = null;
  try {
    const last = m.lastVerificationCommand?.trim();
    if (last) {
      const when = m.lastVerificationAt
        ? ` @ ${m.lastVerificationAt.slice(0, 19).replace("T", " ")}`
        : "";
      const stale = isLastVerificationStale(m)
        ? "  ⚠ stale (edits after verify)"
        : "";
      lastVerifyLine =
        `  last-verify: ${last.slice(0, 100)}${last.length > 100 ? "…" : ""}${when}${stale}`;
    } else if ((m.editCount || 0) > 0) {
      lastVerifyLine =
        `  last-verify: (none after ${m.editCount} edit(s) — /verify)`;
    }
  } catch {
    /* */
  }
  const lines = [
    `Forge session ${id8} — ${title}`,
    `  provider: ${m.provider}/${m.model}`,
    `  fallback: ${formatFallbackChain({
      provider: m.provider,
      model: m.model,
      fallbackModels: m.fallbackModels,
    })}`,
    m.lastModelFallback
      ? `  lastHop:  ${m.lastModelFallback.from} → ${m.lastModelFallback.to}`
      : null,
    `  cwd:      ${cwd}`,
    `  path:     ${dir}`,
    gitLine,
    projectLine,
    memoryLine,
    forkLine,
    checkpointLine,
    lastVerifyLine,
    goalLine,
    isLastErrorProblem(m.lastError)
      ? `  lastErr:  [${m.lastError!.code}] ${m.lastError!.message.slice(0, 120)}`
      : null,
    `  turns:    ${m.turnCount}  edits=${m.editCount}  msgs=${session.messages.length}` +
      (m.providerRounds && m.providerRounds > m.turnCount
        ? `  rounds=${m.providerRounds}`
        : ""),
    (() => {
      try {
        const cost = estimateCostUsd(
          m.provider || "xai",
          m.totalPromptTokens || 0,
          m.totalCompletionTokens || 0,
          m.model,
          m.totalCacheReadTokens || 0,
        );
        const family = formatFamilyCostLines(familyCostBreakdown(m));
        const tok =
          (m.totalPromptTokens || 0) + (m.totalCompletionTokens || 0) > 0
            ? [
                `  tokens:   in=${m.totalPromptTokens || 0} out=${m.totalCompletionTokens || 0} · est ${formatCost(cost)}`,
                ...family,
              ].join("\n")
            : family.length
              ? family.join("\n")
              : null;
        if (
          m.maxCostUsd !== undefined &&
          m.maxCostUsd !== null
        ) {
          const st = costCapStatus(
            {
              maxCostUsd: 0,
              provider: m.provider || "xai",
              model: m.model,
            },
            m,
          );
          const budget = `  budget:   ${formatCostBudgetLine(st)}`;
          return [tok, budget].filter(Boolean).join("\n");
        }
        return tok;
      } catch {
        return null;
      }
    })(),
    flags.length ? `  flags:    ${flags.join(" ")}` : null,
    ``,
    `Resume:`,
    `  forge --session ${id8}`,
    titleResume,
    `  forge run "continue" --session ${id8} --json`,
    `  forge run "next step" --continue --json   # newest same-cwd (fail-closed if none)`,
    `Export:`,
    `  forge sessions export ${id8} --format md`,
    `  forge sessions export ${id8} --format json --out ./session-${id8}.json`,
    `  forge sessions export ${id8} --format json --json   # envelope {ok,body}`,
    `Label:  /title "…"  ·  forge sessions title ${id8} "…"  ·  Keep: /pin  ·  Path: /path`,
    `Search: forge sessions search / list -q ${JSON.stringify(title).slice(0, 40)}`,
    `CI:     forge "…" --json  ·  forge auth --json  ·  forge doctor --json  ·  forge tips --json  ·  forge status --session ${id8} --json`,
    `Peek:   /last 3  ·  /files  ·  /retry  ·  forge news`,
  ].filter((x): x is string => x != null);
  const shareKeys: string[] = [];
  const shareErr = sitDownNextForLastError(m.lastError);
  if (shareErr) shareKeys.push(shareErr);
  if (
    isLastVerificationStale(m) ||
    ((m.editCount || 0) > 0 && !m.lastVerificationCommand?.trim())
  ) {
    if (!shareKeys.includes("/verify")) shareKeys.push("/verify");
  }
  if (shareKeys.length) {
    lines.push(`Next  ${shareKeys.join("  ·  ")}`);
  }

  if (opts?.includePreview !== false) {
    const preview = lastAssistantText(session).trim();
    if (preview) {
      const max = opts?.previewChars ?? 280;
      const clip =
        preview.length > max ? preview.slice(0, max).trimEnd() + "…" : preview;
      lines.push(``, `Last assistant:`, clip);
    }
  }
  return lines.join("\n");
}

/** Compact / /clear rewrite the prefix — drop the frozen omit set. */
export function clearRequestPruneSticky(session: SessionData): void {
  delete session.meta.requestPruneSticky;
  delete session.meta.holdOmitToolIds;
}

export function clearConversation(session: SessionData): void {
  const system = session.messages.filter((m) => m.role === "system");
  session.messages = system;
  session.todos = [];
  session.meta.userTurnMarks = [];
  session.meta.turnCount = 0;
  // Reset progress counters so ULW/goal stuck-wall does not treat pre-clear
  // edits as "progress" on the wiped timeline (and /cost starts clean).
  session.meta.editCount = 0;
  session.meta.totalPromptTokens = 0;
  session.meta.totalCompletionTokens = 0;
  delete session.meta.subagentUsage;
  delete session.meta.exploreMaps;
  clearRequestPruneSticky(session);
  delete session.meta.lastRoundPromptTokens;
  delete session.meta.lastRoundCacheReadTokens;
  delete session.meta.lastPruneKind;
  // Drop per-session spend override so the next conversation inherits config again.
  delete session.meta.maxCostUsd;
  session.meta.title = undefined;
  session.meta.lastUserPreview = undefined;
  delete session.meta.lastError;
  delete session.meta.lastVerificationCommand;
  delete session.meta.lastVerificationAt;
  delete session.meta.lastVerificationOk;
  delete session.meta.lastVerificationExitCode;
  delete session.meta.lastEditAt;
  delete session.meta.rawPinProofTaint;
  // Clear the on-disk meta sidecar title NOW so the saveSession below (whose
  // cross-process merge preserves externally-set titles) does not resurrect
  // the wiped title from the pre-clear sidecar.
  saveSessionMetaSidecar(session);
  // History gone — journal would restore against the wrong timeline.
  try {
    clearFileMutations(session.meta.id);
  } catch {
    /* best-effort */
  }
  // Same session id — unread-edit stamps would otherwise survive a wiped
  // transcript (same hole as compact).
  try {
    clearFileReadsForSession(session.meta.id);
  } catch {
    /* best-effort */
  }
  // Reset stuck-wall baselines and the work-order. Otherwise lastBlockEditCount
  // from the old timeline makes editCount=0 look like permanent no-progress,
  // and the next typed sentence is steering on leftover chrome.
  try {
    resetUlwOnClear(session.meta.id);
  } catch {
    /* best-effort */
  }
  try {
    clearDecisionMemory(session.meta.id);
  } catch {
    /* best-effort */
  }
  try {
    const g = loadGoal(session.meta.id);
    if (g && g.objective) {
      g.lastBlockEditCount = 0;
      g.stuckBlocks = 0;
      saveGoal(g);
    }
  } catch {
    /* best-effort */
  }
  saveSession(session);
}
