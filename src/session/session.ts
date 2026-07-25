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
export {
  compactMessagesStructured,
  buildStructuredSummary,
  pruneOversizedMessageBodies,
} from "./compaction.js";
export type { CompactContext, CompactResult, PruneBodiesResult } from "./compaction.js";

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
}): SessionData {
  const id = randomUUID();
  const now = nowIso();
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
  const full = resolveSessionId(idOrPrefix);
  if (!full) return null;
  const metaPath = path.join(sessionDir(full), "meta.json");
  const fromSide = readJsonFile<SessionMeta | null>(metaPath, null);
  if (fromSide?.id) return fromSide;
  const s = loadSession(full);
  if (!s?.meta) return null;
  // Backfill sidecar so subsequent list/prune stay cheap (legacy sessions)
  try {
    writeJsonFile(metaPath, s.meta);
  } catch {
    /* non-fatal */
  }
  return s.meta;
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
  if (fromPrimary?.meta?.id) return fromPrimary;

  const recovered = recoverSessionFromTmp(dir);
  if (recovered) {
    // Promote recovered payload so subsequent loads are normal
    try {
      saveSession(recovered);
    } catch {
      /* still return in-memory recovery */
    }
    return recovered;
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
        ? [...src.userTurnMarks]
        : [],
    },
    messages: structuredClone(obj.messages),
    todos: Array.isArray(obj.todos) ? structuredClone(obj.todos) : [],
  };
  saveSession(data);
  return data;
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

export function listSessions(limit = 20): SessionMeta[] {
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
    // Prefer sidecar meta.json — avoids parsing huge session.json histories
    const meta = loadSessionMeta(id);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return metas.slice(0, limit);
}

/**
 * Newest session for a workspace cwd (path-normalized).
 * Used by interactive REPL auto-resume (`forge` without --new/--session).
 *
 * Skips sessions held by another live process (foreign session.lock) so
 * experts don't auto-attach into a concurrent REPL by accident.
 *
 * @param maxAgeDays drop candidates older than this (default 14); 0 = no age filter
 */
export function findRecentSessionForCwd(
  cwd: string,
  opts?: { maxAgeDays?: number; limitScan?: number; skipLocked?: boolean },
): SessionMeta | null {
  const target = path.resolve(cwd);
  const maxAgeDays = opts?.maxAgeDays ?? 14;
  const skipLocked = opts?.skipLocked !== false;
  const cutoff =
    maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : 0;
  const scan = listSessions(opts?.limitScan ?? 200);
  for (const m of scan) {
    if (!m.cwd) continue;
    try {
      if (path.resolve(m.cwd) !== target) continue;
    } catch {
      continue;
    }
    if (cutoff > 0) {
      const t = Date.parse(m.updatedAt || "");
      if (!Number.isFinite(t) || t < cutoff) continue;
    }
    if (skipLocked && sessionHasForeignLiveLock(m.id)) continue;
    return m;
  }
  return null;
}

/** True when another live pid holds session.lock (not this process). */
function sessionHasForeignLiveLock(sessionId: string): boolean {
  try {
    // Lazy import path via dynamic require-style to avoid circular init issues:
    // lock.ts imports sessionDir from this module.
    const lockFile = path.join(sessionDir(sessionId), "session.lock");
    if (!fs.existsSync(lockFile)) return false;
    const raw = fs.readFileSync(lockFile, "utf8");
    const info = JSON.parse(raw) as { pid?: number };
    const pid = Number(info?.pid);
    if (!pid || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true; // foreign + alive
    } catch {
      return false; // dead pid → treat as free
    }
  } catch {
    return false;
  }
}

/** Delete a session directory (and lock). Returns true if removed. */
export function deleteSession(idOrPrefix: string): boolean {
  const full = resolveSessionId(idOrPrefix);
  if (!full) return false;
  const dir = sessionDir(full);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface PruneSessionsResult {
  deleted: string[];
  kept: number;
  scanned: number;
}

/**
 * Prune old sessions for disk hygiene (experts accumulate many ULW runs).
 * Keeps the newest `keep` sessions; optionally also drops anything older than `maxAgeDays`.
 * Never deletes `protectIds` (e.g. the active REPL session).
 */
export function pruneSessions(opts?: {
  keep?: number;
  maxAgeDays?: number;
  protectIds?: string[];
}): PruneSessionsResult {
  const keep = opts?.keep ?? 50;
  const maxAgeDays = opts?.maxAgeDays;
  const protect = new Set(opts?.protectIds || []);
  const all = listSessions(10_000);
  const cutoff =
    maxAgeDays != null && maxAgeDays > 0
      ? Date.now() - maxAgeDays * 86_400_000
      : null;

  const deleted: string[] = [];
  // Newest first from listSessions
  all.forEach((meta, index) => {
    if (protect.has(meta.id)) return;
    const tooOld =
      cutoff != null && Date.parse(meta.updatedAt || "") < cutoff;
    const overKeep = index >= keep;
    if (tooOld || overKeep) {
      if (deleteSession(meta.id)) deleted.push(meta.id);
    }
  });

  return {
    deleted,
    kept: all.length - deleted.length,
    scanned: all.length,
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
