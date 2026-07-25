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
import type { ChatMessage } from "../providers/types.js";
import { heartbeatSession } from "../statusline/active.js";
import {
  compactMessagesStructured,
  type CompactContext,
} from "./compaction.js";
import { repairToolCallPairing } from "./message-repair.js";
export {
  compactMessagesStructured,
  buildStructuredSummary,
  pruneOversizedMessageBodies,
} from "./compaction.js";
export type { CompactContext, CompactResult, PruneBodiesResult } from "./compaction.js";
export { repairToolCallPairing } from "./message-repair.js";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  title?: string;
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
  const title = (opts.title ?? "").replace(/\s+/g, " ").trim().slice(0, 72);
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
}

/** Load meta only (prefers meta.json sidecar; falls back to full session). */
export function loadSessionMeta(idOrPrefix: string): SessionMeta | null {
  try {
    const full = resolveSessionId(idOrPrefix);
    if (!full) return null;
    const metaPath = path.join(sessionDir(full), "meta.json");
    const fromSide = readJsonFile<SessionMeta | null>(metaPath, null);
    if (fromSide?.id && typeof fromSide.id === "string") {
      // Soft-normalize required string fields so list/doctor never crash
      return {
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
    }
    const s = loadSession(full);
    if (!s?.meta) return null;
    // Backfill sidecar so subsequent list/prune stay cheap (legacy sessions)
    try {
      writeJsonFile(metaPath, s.meta);
    } catch {
      /* non-fatal */
    }
    return s.meta;
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
    // Persist heals (orphan tool pairs / dropped bad roles) so disk stays clean
    if (norm.session && norm.dirty) {
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
    // Promote recovered payload so subsequent loads are normal
    try {
      if (cleaned.session) saveSession(cleaned.session);
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
  const data: SessionData = {
    meta: {
      ...structuredClone(source.meta),
      id,
      createdAt: now,
      updatedAt: now,
      title:
        opts?.title ||
        (source.meta.title
          ? `fork of ${source.meta.title}`.slice(0, 72)
          : `fork of ${source.meta.id.slice(0, 8)}`),
      // Fresh turn marks relative to copied messages
      userTurnMarks: [...(source.meta.userTurnMarks || [])],
    },
    messages: structuredClone(source.messages),
    todos: structuredClone(source.todos || []),
  };
  saveSession(data);
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
        (src.title ? `import of ${src.title}`.slice(0, 72) : `import ${id.slice(0, 8)}`),
      ultrawork: Boolean(src.ultrawork),
      turnCount: Number(src.turnCount) || 0,
      editCount: Number(src.editCount) || 0,
      totalPromptTokens: Number(src.totalPromptTokens) || 0,
      totalCompletionTokens: Number(src.totalCompletionTokens) || 0,
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
  const lines = [
    `Session ${m.id}`,
    `  title:    ${m.title || "(untitled)"}`,
    `  updated:  ${m.updatedAt}`,
    `  created:  ${m.createdAt}`,
    `  cwd:      ${m.cwd}`,
    `  model:    ${m.provider}/${m.model}`,
    `  turns:    ${m.turnCount}  edits=${m.editCount}  msgs=${session.messages.length}`,
    `  tokens:   in=${m.totalPromptTokens} out=${m.totalCompletionTokens}`,
    `  todos:    ${session.todos?.length || 0} (${openTodos} open)`,
    `  ultrawork:${m.ultrawork ? " yes" : " no"}`,
  ];
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

/** Resolve full session id from prefix (min 4 chars). */
export function resolveSessionId(prefixOrId: string): string | null {
  const root = path.join(forgeHome(), "sessions");
  ensureDir(root);
  if (sessionDirLooksValid(path.join(root, prefixOrId))) {
    return prefixOrId;
  }
  if (prefixOrId.length < 4) return null;
  try {
    const matches = fs
      .readdirSync(root)
      .filter(
        (id) => id.startsWith(prefixOrId) && sessionDirLooksValid(path.join(root, id)),
      );
    if (matches.length === 1) return matches[0];
  } catch {
    /* */
  }
  return null;
}

export interface ListSessionsOpts {
  /** Max sessions to return (default 20). */
  limit?: number;
  /** Only sessions whose cwd resolves equal to this path. */
  cwd?: string;
  /**
   * Case-insensitive substring match against id and title.
   * Useful for multi-project experts locating labeled sessions.
   */
  query?: string;
}

/**
 * List sessions newest-first.
 * Accepts a bare limit number (legacy) or {@link ListSessionsOpts}.
 * Filters (cwd/query) apply before the limit so multi-project lists stay complete.
 */
export function listSessions(
  limitOrOpts: number | ListSessionsOpts = 20,
): SessionMeta[] {
  const opts: ListSessionsOpts =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts || {};
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 20;
  let cwdFilter: string | null = null;
  if (opts.cwd) {
    try {
      cwdFilter = path.resolve(opts.cwd);
    } catch {
      cwdFilter = null;
    }
  }
  const query = (opts.query || "").trim().toLowerCase();

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
      if (query) {
        const hay = `${meta.id} ${meta.title || ""}`.toLowerCase();
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
  const keep = opts?.keep ?? 50;
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
  all.forEach((meta, index) => {
    if (protect.has(meta.id)) return;
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
  const t = userMessage.replace(/\s+/g, " ").trim().slice(0, 72);
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
  const t = (title ?? "").replace(/\s+/g, " ").trim().slice(0, 72);
  if (!t) {
    session.meta.title = undefined;
    saveSession(session);
    return undefined;
  }
  session.meta.title = t;
  saveSession(session);
  return t;
}

/** Record index of a new user turn for rewind support. */
export function markUserTurn(session: SessionData): void {
  if (!session.meta.userTurnMarks) session.meta.userTurnMarks = [];
  session.meta.userTurnMarks.push(session.messages.length);
}

/**
 * Rewind to before the last N user turns (default 1).
 * Returns number of messages removed.
 */
export function rewindSession(session: SessionData, turns = 1): number {
  const marks = session.meta.userTurnMarks || [];
  if (marks.length === 0) {
    // Fallback: drop trailing messages until last user
    let cut = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === "user") {
        cut = i;
        break;
      }
    }
    if (cut < 0) return 0;
    const removed = session.messages.length - cut;
    session.messages = session.messages.slice(0, cut);
    saveSession(session);
    return removed;
  }
  const n = Math.max(1, Math.min(turns, marks.length));
  const cut = marks[marks.length - n];
  const removed = session.messages.length - cut;
  session.messages = session.messages.slice(0, cut);
  session.meta.userTurnMarks = marks.slice(0, marks.length - n);
  session.meta.turnCount = Math.max(0, session.meta.turnCount - n);
  saveSession(session);
  return removed;
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

export function clearConversation(session: SessionData): void {
  const system = session.messages.filter((m) => m.role === "system");
  session.messages = system;
  session.todos = [];
  session.meta.userTurnMarks = [];
  session.meta.turnCount = 0;
  session.meta.title = undefined;
  saveSession(session);
}
