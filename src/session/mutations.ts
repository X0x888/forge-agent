/**
 * Per-session file mutation journal for expert /undo that restores disk,
 * not just chat history (OpenCode snapshot/revert inspired, lightweight).
 *
 * Stored as ~/.forge/sessions/<id>/mutations.jsonl (mode 0600).
 * Each successful write_file / search_replace / apply_patch op appends one
 * entry with pre-image (or create marker). Rewind restores in reverse.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDir, forgeHome, nowIso } from "../util/fs.js";

/** Skip journaling (and restoring) bodies larger than this. */
export const MAX_MUTATION_BYTES = 256_000;
/** Stop appending once the journal itself is this large. */
export const MAX_MUTATION_JOURNAL_BYTES = 20 * 1024 * 1024;

function isChangelogAbsPath(absPath: string): boolean {
  const base = absPath.replace(/\\/g, "/").split("/").pop() || "";
  return /^changelog(\.(md|markdown|txt|rst))?$/i.test(base);
}

function sessionDir(id: string): string {
  return path.join(forgeHome(), "sessions", id);
}

export type FileMutationKind = "create" | "update" | "delete";

export interface FileMutation {
  /** Absolute path on disk */
  path: string;
  kind: FileMutationKind;
  /** Agent turn when the mutation landed (session.meta.turnCount). */
  turn: number;
  ts: string;
  /** Pre-image for update/delete. Omitted for create or when skipped. */
  before?: string;
  /**
   * Pre-image permission bits (e.g. 0o644, 0o755), journaled so /undo
   * restores the original mode instead of always tightening to 0600.
   * Absent in older journals — restore falls back to 0600 then.
   */
  mode?: number;
  /** True when body was too large / unreadable — restore will skip. */
  skipped?: boolean;
  reason?: string;
}

export interface RecordMutationInput {
  path: string;
  kind: FileMutationKind;
  before?: string;
  turn: number;
  /** Pre-image permission bits (stat.mode & 0o777) when known. */
  mode?: number;
  skipped?: boolean;
  reason?: string;
}

export interface RestoreMutationsResult {
  restored: string[];
  failed: Array<{ path: string; error: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

function journalPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "mutations.jsonl");
}

export function mutationsJournalPath(sessionId: string): string {
  return journalPath(sessionId);
}

export interface MutationsJournalStats {
  /** Sessions that have a mutations.jsonl file. */
  sessions: number;
  /** Total journal files bytes. */
  bytes: number;
  /** Best-effort entry count (line count). */
  entries: number;
}

/**
 * Aggregate mutation-journal disk use across sessions (doctor / hygiene).
 * Best-effort; never throws.
 */
export function mutationsJournalStats(limit = 500): MutationsJournalStats {
  const root = path.join(forgeHome(), "sessions");
  let sessions = 0;
  let bytes = 0;
  let entries = 0;
  try {
    const dirs = fs.readdirSync(root).slice(0, Math.max(1, limit));
    for (const id of dirs) {
      const file = path.join(root, id, "mutations.jsonl");
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        sessions += 1;
        bytes += st.size;
        // Cheap entry estimate: count newlines without loading huge bodies fully
        if (st.size <= 256 * 1024) {
          const raw = fs.readFileSync(file, "utf8");
          entries += raw.split(/\n/).filter((l) => l.trim()).length;
        } else {
          // Sample last 64 KiB for a lower-bound line count + note via size
          const fd = fs.openSync(file, "r");
          try {
            const n = Math.min(st.size, 64 * 1024);
            const buf = Buffer.alloc(n);
            fs.readSync(fd, buf, 0, n, st.size - n);
            const text = buf.toString("utf8");
            const lines = text.split(/\n/).filter((l) => l.trim()).length;
            // Rough scale-up from sample (best-effort)
            entries += Math.max(lines, Math.floor((st.size / n) * lines * 0.5));
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        /* missing */
      }
    }
  } catch {
    /* no sessions dir */
  }
  return { sessions, bytes, entries };
}

/** Keep the newest tail so /undo still sees late waves. */
const MUTATION_JOURNAL_KEEP_BYTES = 8 * 1024 * 1024;

function rotateMutationJournal(sessionId: string): void {
  const file = journalPath(sessionId);
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_MUTATION_JOURNAL_BYTES) return;
    const keep = Math.min(MUTATION_JOURNAL_KEEP_BYTES, st.size);
    const fd = fs.openSync(file, "r");
    let buf: Buffer;
    try {
      buf = Buffer.alloc(keep);
      fs.readSync(fd, buf, 0, keep, st.size - keep);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    const tail = nl >= 0 ? text.slice(nl + 1) : text;
    fs.writeFileSync(file, tail, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* windows */
    }
  } catch {
    /* best-effort */
  }
}

/** Append one mutation (best-effort; never throws into the agent loop). */
export function appendFileMutation(
  sessionId: string,
  input: RecordMutationInput,
): void {
  try {
    if (isChangelogAbsPath(input.path)) {
      return;
    }
    const dir = sessionDir(sessionId);
    ensureDir(dir);
    try {
      const st = fs.statSync(journalPath(sessionId));
      if (st.size >= MAX_MUTATION_JOURNAL_BYTES) {
        rotateMutationJournal(sessionId);
      }
    } catch {
      /* no journal yet */
    }
    const entry: FileMutation = {
      path: input.path,
      kind: input.kind,
      turn: input.turn,
      ts: nowIso(),
    };
    // Journal the pre-image mode so restore can re-apply it (0600 fallback
    // when unknown — older journals and unreadable stats). Mask to plain
    // permission bits: never restore setuid/setgid/sticky.
    if (typeof input.mode === "number" && Number.isFinite(input.mode)) {
      entry.mode = input.mode & 0o777;
    }
    if (input.skipped) {
      entry.skipped = true;
      if (input.reason) entry.reason = input.reason;
    } else if (input.kind !== "create") {
      const before = input.before ?? "";
      const bytes = Buffer.byteLength(before, "utf8");
      if (bytes > MAX_MUTATION_BYTES) {
        entry.skipped = true;
        entry.reason = `pre-image ${bytes} bytes exceeds ${MAX_MUTATION_BYTES}`;
      } else {
        entry.before = before;
      }
    }
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(journalPath(sessionId), line, { mode: 0o600 });
    try {
      fs.chmodSync(journalPath(sessionId), 0o600);
    } catch {
      /* windows */
    }
  } catch {
    /* journal is best-effort */
  }
}

/**
 * Snapshot current file state and classify create vs update for journaling.
 * Returns null when the path cannot be read as a file (caller may still write).
 */
export async function snapshotForWrite(
  absPath: string,
): Promise<{ kind: "create" | "update"; before?: string; mode?: number; skipped?: boolean; reason?: string }> {
  try {
    const st = await fsp.stat(absPath);
    if (st.isDirectory()) {
      return { kind: "update", skipped: true, reason: "path is a directory" };
    }
    if (isChangelogAbsPath(absPath)) {
      return {
        kind: "update",
        skipped: true,
        reason: "changelog pre-image skipped",
      };
    }
    if (st.size > MAX_MUTATION_BYTES) {
      return {
        kind: "update",
        skipped: true,
        reason: `existing file ${st.size} bytes exceeds journal cap`,
      };
    }
    const before = await fsp.readFile(absPath, "utf8");
    return { kind: "update", before, mode: st.mode & 0o777 };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { kind: "create" };
    return {
      kind: "update",
      skipped: true,
      reason: `cannot read pre-image: ${(err as Error).message}`,
    };
  }
}

/**
 * Absolute paths journaled at or after `isoTs` (ISO-8601; lexicographic).
 * Background bash apply uses this to skip concurrent write_file / fg bash.
 */
export function mutationAbsPathsAfter(
  sessionId: string,
  isoTs: string,
): Set<string> {
  const out = new Set<string>();
  if (!sessionId || !isoTs) return out;
  for (const m of readFileMutations(sessionId)) {
    if (
      typeof m.ts === "string" &&
      m.ts >= isoTs &&
      typeof m.path === "string"
    ) {
      const resolved = path.resolve(m.path).replace(/\\/g, "/");
      out.add(resolved);
      try {
        out.add(fs.realpathSync(m.path).replace(/\\/g, "/"));
      } catch {
        /* missing */
      }
    }
  }
  return out;
}

export type BeforeRestoreMutationsFn = (
  sessionId: string,
  keepThroughTurn: number,
) => void;

let beforeRestoreHook: BeforeRestoreMutationsFn | undefined;

/** Register a pre-restore settler (background bash journals). Replaces prior. */
export function onBeforeRestoreMutations(
  fn: BeforeRestoreMutationsFn | undefined,
): void {
  beforeRestoreHook = fn;
}

export function readFileMutations(sessionId: string): FileMutation[] {
  const file = journalPath(sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: FileMutation[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t) as FileMutation;
      if (m && typeof m.path === "string" && typeof m.kind === "string") {
        out.push(m);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** Drop journal entries with turn > keepThroughTurn (inclusive keep). */
export function truncateMutationsAfterTurn(
  sessionId: string,
  keepThroughTurn: number,
): FileMutation[] {
  const all = readFileMutations(sessionId);
  const kept = all.filter(
    (m) => typeof m.turn === "number" && m.turn <= keepThroughTurn,
  );
  writeMutationsJournal(sessionId, kept);
  return all.filter((m) => typeof m.turn === "number" && m.turn > keepThroughTurn);
}

function writeMutationsJournal(sessionId: string, entries: FileMutation[]): void {
  const file = journalPath(sessionId);
  try {
    if (entries.length === 0) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* missing ok */
      }
      return;
    }
    ensureDir(sessionDir(sessionId));
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* */
    }
  } catch {
    /* best-effort */
  }
}

/** Clear the entire journal (e.g. /clear hard). */
export function clearFileMutations(sessionId: string): void {
  writeMutationsJournal(sessionId, []);
}

/**
 * Copy journal when forking a session so the fork can still undo its history.
 */
export function copyFileMutations(fromId: string, toId: string): void {
  const entries = readFileMutations(fromId);
  if (!entries.length) return;
  writeMutationsJournal(toId, entries);
}

/**
 * Restore disk for mutations belonging to turns after `keepThroughTurn`.
 * Applies in reverse chronological order.
 *
 * Journal is rewritten only after restore attempts: successfully restored
 * (and skipped) entries are dropped; failed entries are kept so `/undo` can
 * retry without losing pre-images.
 */

/**
 * Recompute session edit trail from the surviving mutations journal.
 * Used after /undo · /retry so last-verify stale detection stays honest
 * when disk edits are restored away.
 */
export function editTrailFromMutations(sessionId: string): {
  editCount: number;
  lastEditAt?: string;
} {
  const all = readFileMutations(sessionId);
  if (!all.length) return { editCount: 0 };
  let lastEditAt: string | undefined;
  let maxTs = -1;
  for (const m of all) {
    const ts = Date.parse(m.ts || "");
    if (Number.isFinite(ts) && ts >= maxTs) {
      maxTs = ts;
      lastEditAt = m.ts;
    }
  }
  return {
    editCount: all.length,
    ...(lastEditAt ? { lastEditAt } : {}),
  };
}

export function restoreMutationsAfterTurn(
  sessionId: string,
  keepThroughTurn: number,
): RestoreMutationsResult {
  try {
    beforeRestoreHook?.(sessionId, keepThroughTurn);
  } catch {
    /* settler is best-effort */
  }
  const all = readFileMutations(sessionId);
  const kept = all.filter(
    (m) => typeof m.turn === "number" && m.turn <= keepThroughTurn,
  );
  const doomed = all.filter(
    (m) => typeof m.turn === "number" && m.turn > keepThroughTurn,
  );
  // Reverse: last mutation first
  const ordered = doomed.slice().reverse();
  const restored: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const failedEntries: FileMutation[] = [];

  for (const m of ordered) {
    if (m.skipped) {
      skipped.push({
        path: m.path,
        reason: m.reason || "pre-image not journaled",
      });
      continue;
    }
    try {
      if (m.kind === "create") {
        // File was created in the undone turn — remove if still a file
        if (fs.existsSync(m.path)) {
          const st = fs.statSync(m.path);
          if (st.isFile()) {
            fs.unlinkSync(m.path);
            restored.push(`- ${m.path}`);
          } else {
            skipped.push({
              path: m.path,
              reason: "create-restore target is not a regular file",
            });
          }
        } else {
          restored.push(`- ${m.path} (already absent)`);
        }
      } else if (m.kind === "delete" || m.kind === "update") {
        const dir = path.dirname(m.path);
        fs.mkdirSync(dir, { recursive: true });
        const body = m.before ?? "";
        const tmp = path.join(
          dir,
          `.${path.basename(m.path)}.${process.pid}.undo.tmp`,
        );
        // Restore the journaled pre-image mode (executable scripts stay +x,
        // world-readable files stay 0644). Fall back to restrictive 0600 only
        // when the mode is unknown (older journals) — pre-images may be secrets.
        const mode =
          typeof m.mode === "number" && Number.isFinite(m.mode)
            ? m.mode & 0o777
            : 0o600;
        fs.writeFileSync(tmp, body, { encoding: "utf8", mode });
        fs.renameSync(tmp, m.path);
        try {
          fs.chmodSync(m.path, mode);
        } catch {
          /* */
        }
        restored.push(
          m.kind === "delete" ? `+ ${m.path}` : `~ ${m.path}`,
        );
      }
    } catch (err) {
      failed.push({
        path: m.path,
        error: (err as Error).message,
      });
      failedEntries.push(m);
    }
  }

  // Keep surviving entries + failed undos (so retry can recover pre-images).
  // Preserve original chronological order for failed re-appends.
  const failedSet = new Set(failedEntries);
  const failedInOrder = doomed.filter((m) => failedSet.has(m));
  writeMutationsJournal(sessionId, [...kept, ...failedInOrder]);

  return { restored, failed, skipped };
}

/** Format restore result for slash output. */
export function formatRestoreResult(r: RestoreMutationsResult): string {
  const lines: string[] = [];
  if (r.restored.length) {
    lines.push(`Disk restored (${r.restored.length}):`);
    for (const p of r.restored.slice(0, 30)) lines.push(`  ${p}`);
    if (r.restored.length > 30) {
      lines.push(`  … +${r.restored.length - 30} more`);
    }
  }
  if (r.skipped.length) {
    lines.push(`Skipped (${r.skipped.length}) — no pre-image / too large:`);
    for (const s of r.skipped.slice(0, 10)) {
      lines.push(`  ${s.path}: ${s.reason}`);
    }
  }
  if (r.failed.length) {
    lines.push(`Failed (${r.failed.length}):`);
    for (const f of r.failed.slice(0, 10)) {
      lines.push(`  ${f.path}: ${f.error}`);
    }
  }
  if (!lines.length) return "";
  return lines.join("\n");
}
