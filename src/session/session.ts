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
  return readJsonFile<SessionData | null>(
    path.join(sessionDir(id), "session.json"),
    null,
  );
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
  // Rough: ~4 chars per token
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
