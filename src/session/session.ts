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
}

export function loadSession(id: string): SessionData | null {
  // Allow short prefix match
  const full = resolveSessionId(id);
  if (!full) return null;
  return readJsonFile<SessionData | null>(
    path.join(sessionDir(full), "session.json"),
    null,
  );
}

/** Resolve full session id from prefix (min 4 chars). */
export function resolveSessionId(prefixOrId: string): string | null {
  const root = path.join(forgeHome(), "sessions");
  ensureDir(root);
  if (fs.existsSync(path.join(root, prefixOrId, "session.json"))) {
    return prefixOrId;
  }
  if (prefixOrId.length < 4) return null;
  try {
    const matches = fs
      .readdirSync(root)
      .filter((id) => id.startsWith(prefixOrId));
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
    ids = fs.readdirSync(root);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const id of ids) {
    const s = loadSession(id);
    if (s) metas.push(s.meta);
  }
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return metas.slice(0, limit);
}

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || "").length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export function compactMessages(
  messages: ChatMessage[],
  keepLast = 12,
): ChatMessage[] {
  if (messages.length <= keepLast + 2) return messages;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const dropped = rest.slice(0, Math.max(0, rest.length - keepLast));
  const kept = rest.slice(-keepLast);
  const summary: ChatMessage = {
    role: "user",
    content: `[Conversation compacted — ${dropped.length} earlier messages summarized]\nKey points from earlier turns were retained in session state. Continue from the recent context below.`,
  };
  return [...system, summary, ...kept];
}

/** Set title from first user message if unset. */
export function maybeSetTitle(session: SessionData, userMessage: string): void {
  if (session.meta.title) return;
  const t = userMessage.replace(/\s+/g, " ").trim().slice(0, 72);
  if (t) session.meta.title = t;
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
