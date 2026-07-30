import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  forgeHome,
  ensureDir,
  readJsonFile,
  writeJsonFile,
  nowIso,
} from "../util/fs.js";
import { editDistance } from "../util/string-distance.js";
import { suggestName } from "../util/suggest.js";
import { formatRelativeTime } from "../util/format.js";
import { detectProjectHints, getGitSnapshot } from "../util/git-context.js";
import type { ChatMessage } from "../providers/types.js";
import type { PermissionMode } from "../config/types.js";
import { heartbeatSession } from "../statusline/active.js";
import { touchSessionLock } from "./lock.js";
import {
  compactMessagesStructured,
  type CompactContext,
} from "./compaction.js";
import { repairToolCallPairing } from "./message-repair.js";
import {
  restoreMutationsAfterTurn,
  copyFileMutations,
  clearFileMutations,
  type RestoreMutationsResult,
} from "./mutations.js";
import {
  copyUlwCycle,
  loadUlwCycle,
  saveUlwCycle,
} from "../harness/ulw-cycle.js";
import { copyGoal, loadGoal, saveGoal } from "../harness/goal.js";

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
   * `/plan` sets this without touching sticky preferences; `/build` restores
   * `permissionModeBeforePlan` (or default).
   */
  permissionMode?: PermissionMode;
  /**
   * Mode to restore when leaving plan via `/build`. Only meaningful while
   * `permissionMode === "plan"`.
   */
  permissionModeBeforePlan?: PermissionMode;
  ultrawork: boolean;
  turnCount: number;
  editCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
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
      userTurnMarks: [],
      ...(title ? { title } : {}),
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
    const preview = lastUserText(data).replace(/\s+/g, " ").trim().slice(0, 80);
    if (preview) data.meta.lastUserPreview = preview;
    else delete data.meta.lastUserPreview;
  } catch {
    /* never block save */
  }
  const dir = sessionDir(data.meta.id);
  ensureDir(dir);
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

/** Normalize meta sidecar fields so list/doctor never crash on partial JSON. */
function normalizeSessionMeta(fromSide: SessionMeta): SessionMeta {
  const out: SessionMeta = {
    ...fromSide,
    id: fromSide.id,
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
  };
  if (fromSide.pinned) out.pinned = true;
  else delete out.pinned;
  const pm = normalizeMetaPermissionMode(fromSide.permissionMode);
  if (pm) out.permissionMode = pm;
  else delete out.permissionMode;
  const before = normalizeMetaPermissionMode(fromSide.permissionModeBeforePlan);
  if (before) out.permissionModeBeforePlan = before;
  else delete out.permissionModeBeforePlan;
  return out;
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
 * Clears session override when restored mode matches sticky default path.
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
  // Keep session override only when non-default sticky would otherwise drift;
  // experts expect /build to return to normal build permissions for this session.
  if (mode === "plan") {
    session.meta.permissionMode = "plan";
  } else {
    // Persist the restored mode so resume stays out of plan.
    session.meta.permissionMode = mode;
  }
  return { mode, wasPlan };
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
      return normalizeSessionMeta(fromSide);
    }
    // Fallback: session.json only (legacy / missing sidecar)
    const primary = path.join(sessionDir(fullId), "session.json");
    const data = readJsonFile<SessionData | null>(primary, null);
    if (data?.meta?.id) {
      try {
        writeJsonFile(metaPath, data.meta);
      } catch {
        /* non-fatal */
      }
      return normalizeSessionMeta(data.meta);
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
      gitLine = `  git:      ${git.branch}${dirty}${ch}`;
    }
  } catch {
    /* */
  }
  try {
    const hints = detectProjectHints(m.cwd || process.cwd());
    let pkg = "";
    try {
      const pkgPath = path.join(m.cwd || process.cwd(), "package.json");
      if (fs.existsSync(pkgPath)) {
        const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (raw.name) {
          pkg = raw.version ? `${raw.name}@${raw.version}` : raw.name;
        }
      }
    } catch {
      /* */
    }
    const bits = [pkg || null, hints.length ? hints.join(",") : null].filter(
      Boolean,
    );
    if (bits.length) projectLine = `  project:  ${bits.join(" · ")}`;
  } catch {
    /* */
  }
  const lines = [
    `Session ${m.id}`,
    `  title:    ${m.title || "(untitled)"}`,
    `  updated:  ${m.updatedAt}${age && age !== "—" ? `  (${age})` : ""}`,
    `  created:  ${m.createdAt}`,
    `  cwd:      ${m.cwd}`,
    `  path:     ${sessionDir(m.id)}`,
    gitLine,
    projectLine,
    `  model:    ${m.provider}/${m.model}`,
    `  turns:    ${m.turnCount}  edits=${m.editCount}  msgs=${session.messages.length}`,
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
      ? `  mode:     PLAN (session-scoped — /build to implement)`
      : m.permissionMode
        ? `  mode:     ${m.permissionMode} (session override)`
        : null,
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
  if (sessionDirLooksValid(path.join(root, raw))) {
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
    } catch {
      return false; // dead pid → treat as free
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
}

/**
 * Prune old sessions for disk hygiene (experts accumulate many ULW runs).
 * Keeps the newest `keep` sessions; optionally also drops anything older than `maxAgeDays`.
 * Never deletes `protectIds` (e.g. the active REPL session).
 * Never deletes sessions held by another live process (foreign session.lock).
 */
export function pruneSessions(opts?: {
  keep?: number;
  maxAgeDays?: number;
  protectIds?: string[];
  /** Skip foreign live locks (default true). */
  skipLocked?: boolean;
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
  const all = listSessions(10_000);
  const cutoff =
    maxAgeDays != null && maxAgeDays > 0
      ? Date.now() - maxAgeDays * 86_400_000
      : null;

  const deleted: string[] = [];
  let skippedLocked = 0;
  // Newest first from listSessions
  let skippedPinned = 0;
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
      if (deleteSession(meta.id)) deleted.push(meta.id);
    }
  });

  return {
    deleted,
    kept: all.length - deleted.length,
    scanned: all.length,
    skippedLocked,
    skippedPinned,
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

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let msgs = 0;
  for (const m of messages) {
    msgs += 1;
    chars += (m.content || "").length;
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
 */
export function estimateRequestTokens(
  messages: ChatMessage[],
  extras?: { toolsJsonChars?: number; reserveTokens?: number },
): number {
  let n = estimateTokens(messages);
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
  return compactMessagesStructured(messages, { keepLast, context }).messages;
}

/** Set title from first user message if unset. */
export function maybeSetTitle(session: SessionData, userMessage: string): void {
  if (session.meta.title) return;
  const t = userMessage.replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_TITLE_CHARS);
  if (t) session.meta.title = t;
}

/**
 * Explicitly set (or clear) a session title. Empty/whitespace clears.
 * Returns the stored title (undefined when cleared).
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
    saveSession(session);
    return undefined;
  }
  session.meta.title = t;
  saveSession(session);
  return t;
}

/** Pin/unpin a session so prune never deletes it. Returns new pinned state. */
export function setSessionPinned(session: SessionData, pinned: boolean): boolean {
  if (pinned) session.meta.pinned = true;
  else delete session.meta.pinned;
  saveSession(session);
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
 * Rebuild userTurnMarks from current messages after compact/load so
 * /undo and /retry never restore disk against a no-op chat rewind.
 */
export function rebuildUserTurnMarks(session: SessionData): void {
  const marks: number[] = [];
  for (let i = 0; i < session.messages.length; i++) {
    if (session.messages[i]?.role === "user") marks.push(i);
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
    // Fallback: drop trailing messages until last user
    let cut = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === "user") {
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
  saveSession(session);
  return { removed, turns: n, disk };
}

export function exportSessionMarkdown(session: SessionData): string {
  const lines: string[] = [
    `# Forge session ${session.meta.id}`,
    ``,
    `- Created: ${session.meta.createdAt}`,
    `- Updated: ${session.meta.updatedAt}`,
    `- Model: ${session.meta.provider}/${session.meta.model}`,
    `- Title: ${session.meta.title || "(untitled)"}`,
    `- Tokens: in=${session.meta.totalPromptTokens} out=${session.meta.totalCompletionTokens}`,
    ``,
    `---`,
    ``,
  ];
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
    const tools =
      t.tools.length > 1 ? `  (${t.tools.slice(-3).join(", ")})` : `  (${t.tools[0]})`;
    return `  ${tag}  ${t.path}${tools}`;
  });
  const scope = opts?.mutatedOnly ? "mutations" : "paths";
  return (
    `Session files (${items.length} ${scope}, newest first):\n` +
    lines.join("\n") +
    `\nR=read  A=write  M=edit  P=patch  D=delete  ·  /files writes  ·  /diff`
  );
}

/**
 * Most recent non-empty user message text (for /retry).
 * Skips empty/whitespace-only turns.
 */
export function lastUserText(session: SessionData): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "user") {
      const t = (m.content || "").trim();
      if (t) return t;
    }
  }
  return "";
}

function clipPreview(text: string, max: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "(empty)";
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/**
 * Compact peek of the last N user/assistant turns (for /last after resume).
 * Tool chatter is summarized; system messages skipped.
 */
export function formatRecentTurns(
  session: SessionData,
  opts?: { turns?: number; maxChars?: number },
): string {
  const turnsWanted = Math.max(1, Math.min(20, opts?.turns ?? 1));
  const maxChars = Math.max(40, Math.min(2000, opts?.maxChars ?? 320));

  type Block =
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string; tools: string[] };

  const blocks: Block[] = [];
  for (const m of session.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
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

  if (turns.length === 0) {
    return "No user/assistant turns in this session yet.";
  }

  const slice = turns.slice(-turnsWanted);
  const startIdx = turns.length - slice.length + 1;
  const lines: string[] = [
    `Last ${slice.length} turn(s) of ${turns.length}` +
      (session.meta.title ? ` — ${session.meta.title}` : "") +
      ` · ${session.meta.id.slice(0, 8)}`,
  ];

  slice.forEach((t, i) => {
    const n = startIdx + i;
    lines.push("");
    lines.push(`── turn ${n} ──`);
    if (t.user) {
      lines.push(`you:  ${clipPreview(t.user, maxChars)}`);
    }
    if (t.assistants.length === 0) {
      lines.push(`forge: (no assistant reply yet)`);
    } else {
      const texts = t.assistants.map((a) => a.text).filter(Boolean);
      const tools = t.assistants.flatMap((a) => a.tools).filter((x) => x && x !== "·");
      const uniqTools = [...new Set(tools)];
      const body = texts.join(" ").trim();
      if (body) lines.push(`forge: ${clipPreview(body, maxChars)}`);
      else if (uniqTools.length) lines.push(`forge: (tool calls only)`);
      else lines.push(`forge: (empty)`);
      if (uniqTools.length) {
        const shown = uniqTools.slice(0, 8);
        const more = uniqTools.length - shown.length;
        lines.push(
          `tools: ${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`,
        );
      }
    }
  });

  lines.push("");
  lines.push("Tip: /retry · /copy · /export · /share");
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
  const hasTurn = session.messages.some(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      Boolean((m.content || "").trim() || m.tool_calls?.length),
  );
  if (!hasTurn) return "";
  // Drop the trailing tip line — resume banner already points at /last.
  return formatRecentTurns(session, {
    turns: 1,
    maxChars: opts?.maxChars ?? 200,
  })
    .split("\n")
    .filter((ln) => !/^Tip:/.test(ln))
    .join("\n")
    .trimEnd();
}

/**
 * Resume orientation: last-turn peek + compact mutated-files line.
 * Empty when neither is available.
 */
export function formatResumeOrientation(
  session: SessionData,
  opts?: { maxChars?: number; fileLimit?: number },
): string {
  const parts: string[] = [];
  try {
    const peek = formatResumePeek(session, { maxChars: opts?.maxChars });
    if (peek) parts.push(peek);
  } catch {
    /* */
  }
  try {
    if (session.meta.permissionMode === "plan") {
      parts.push("Mode: PLAN (session-scoped) — /build to implement");
    } else if (
      session.meta.permissionMode &&
      session.meta.permissionMode !== "default" &&
      session.meta.permissionMode !== "acceptEdits"
    ) {
      parts.push(`Mode: ${session.meta.permissionMode} (session override)`);
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
      parts.push(`Files: ${bits}${touched.length >= (opts?.fileLimit ?? 6) ? "…" : ""}  (/files writes)`);
    }
  } catch {
    /* */
  }
  return parts.join("\n");
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
      gitLine = `  git:      ${git.branch}${dirty}${ch}`;
    }
  } catch {
    /* */
  }
  try {
    const hints = detectProjectHints(m.cwd || process.cwd());
    let pkg = "";
    try {
      const pkgPath = path.join(m.cwd || process.cwd(), "package.json");
      if (fs.existsSync(pkgPath)) {
        const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (raw.name) {
          pkg = raw.version ? `${raw.name}@${raw.version}` : raw.name;
        }
      }
    } catch {
      /* */
    }
    const bits = [pkg || null, hints.length ? hints.join(",") : null].filter(
      Boolean,
    );
    if (bits.length) projectLine = `  project:  ${bits.join(" · ")}`;
  } catch {
    /* */
  }
  const lines = [
    `Forge session ${id8} — ${title}`,
    `  provider: ${m.provider}/${m.model}`,
    `  cwd:      ${cwd}`,
    `  path:     ${dir}`,
    gitLine,
    projectLine,
    goalLine,
    `  turns:    ${m.turnCount}  edits=${m.editCount}  msgs=${session.messages.length}`,
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
  session.meta.title = undefined;
  session.meta.lastUserPreview = undefined;
  // History gone — journal would restore against the wrong timeline.
  try {
    clearFileMutations(session.meta.id);
  } catch {
    /* best-effort */
  }
  // Reset stuck-wall baselines on harness sidecars. Otherwise lastBlockEditCount
  // from the old timeline makes editCount=0 look like permanent no-progress.
  try {
    const ulw = loadUlwCycle(session.meta.id);
    if (ulw) {
      ulw.lastBlockEditCount = 0;
      ulw.stuckBlocks = 0;
      saveUlwCycle(ulw);
    }
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
