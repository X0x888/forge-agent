/**
 * Persistent command history for ↑/↓ in the REPL.
 * Stored as one line per entry under ~/.forge/history.
 * Multi-line drafts are escaped (`\n` → `\\n`) via prompt-editor helpers.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome, ensureDir } from "../util/fs.js";
import {
  decodeHistoryEntry,
  encodeHistoryEntry,
} from "./prompt-editor.js";

const MAX = 500;

export function historyPath(): string {
  return path.join(forgeHome(), "history");
}

export function loadHistory(limit = MAX): string[] {
  try {
    const raw = fs.readFileSync(historyPath(), "utf8");
    return raw
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .map(decodeHistoryEntry)
      .slice(-limit);
  } catch {
    return [];
  }
}

export function appendHistory(line: string): void {
  // Preserve internal newlines; only trim trailing whitespace on last line edge
  const t = line.replace(/\s+$/u, "").replace(/^\s+$/u, "");
  if (!t.trim()) return;
  // skip secrets-ish
  if (/api[_-]?key|password|secret|token\s*=/i.test(t) && t.length > 40) return;
  try {
    ensureDir(forgeHome());
    const prev = loadHistory();
    // de-dupe consecutive
    if (prev[prev.length - 1] === t) return;
    prev.push(t);
    const trimmed = prev.slice(-MAX);
    fs.writeFileSync(
      historyPath(),
      trimmed.map(encodeHistoryEntry).join("\n") + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* ignore */
  }
}

/** Seed a readline Interface's history (newest last in Node's model). */
export function applyHistoryToReadline(
  rl: { history?: string[] },
  entries: string[],
): void {
  // Node stores history with most recent first in some versions; createInterface
  // accepts history option as string[] with newest at the end in Node 20+.
  if (Array.isArray((rl as { history: string[] }).history)) {
    (rl as { history: string[] }).history = [...entries].reverse();
  }
}
