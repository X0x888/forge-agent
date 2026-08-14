/**
 * Session-scoped file read tracker — OpenCode-inspired stale-edit protection.
 *
 * When attached to ToolContext:
 *  - read_file records mtime/size after a successful file read
 *  - search_replace / write_file / apply_patch refuse to clobber a file the
 *    agent never read, or one that changed on disk since the last read/write
 *  - successful writes refresh the stamp so chained edits don't thrash
 *
 * Absent from ToolContext (unit tests, one-off executeTool) → no enforcement.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { realpathExistingPrefix } from "./path-util.js";

export type FileReadStamp = {
  mtimeMs: number;
  size: number;
  /** Wall clock when we last noted this path (debug / TTL). */
  notedAt: number;
  /**
   * Set only after a successful full-file read_file (no offset/limit).
   * Writes refresh the stamp without this field so the next read is not stubbed.
   */
  fullReadLines?: number;
};

const sessionFileReads = new Map<string, FileReadState>();

/** Per-session FileReadState so /compact (outside the loop) can clear stamps. */
export function fileReadsForSession(sessionId: string): FileReadState {
  const id = String(sessionId || "").trim();
  if (!id) return new FileReadState();
  let state = sessionFileReads.get(id);
  if (!state) {
    state = new FileReadState();
    sessionFileReads.set(id, state);
  }
  return state;
}

/** After compact the transcript no longer contains file bodies — force re-read. */
export function clearFileReadsForSession(sessionId?: string): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  sessionFileReads.get(id)?.clear();
}

/** Test helper — drop the registry entry so cases don't leak. */
export function forgetFileReadsSession(sessionId?: string): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  sessionFileReads.delete(id);
}

export class FileReadState {
  private readonly map = new Map<string, FileReadStamp>();

  /** Normalize to absolute realpath (macOS `/var` → `/private/var`). */
  static key(filePath: string): string {
    try {
      return realpathExistingPrefix(filePath);
    } catch {
      try {
        return path.resolve(filePath);
      } catch {
        return filePath;
      }
    }
  }

  get(filePath: string): FileReadStamp | undefined {
    return this.map.get(FileReadState.key(filePath));
  }

  clear(filePath?: string): void {
    if (filePath === undefined) {
      this.map.clear();
      return;
    }
    this.map.delete(FileReadState.key(filePath));
  }

  size(): number {
    return this.map.size;
  }

  note(
    filePath: string,
    st: { mtimeMs: number; size: number; fullReadLines?: number },
  ): void {
    this.map.set(FileReadState.key(filePath), {
      mtimeMs: st.mtimeMs,
      size: st.size,
      notedAt: Date.now(),
      ...(typeof st.fullReadLines === "number"
        ? { fullReadLines: st.fullReadLines }
        : {}),
    });
  }

  async noteFromDisk(filePath: string): Promise<boolean> {
    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile()) return false;
      this.note(filePath, { mtimeMs: st.mtimeMs, size: st.size });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Guard a mutation of an existing file.
   * Returns null when OK to proceed, or an error message for the model.
   */
  async checkBeforeMutate(
    filePath: string,
    opts: { tool: string; rel?: string },
  ): Promise<string | null> {
    let st: fs.Stats;
    try {
      st = await fsp.stat(filePath);
    } catch {
      // Missing file — create paths are fine (write_file / Add File).
      return null;
    }
    if (!st.isFile()) return null;

    const rel = opts.rel || path.basename(filePath);
    const prev = this.get(filePath);
    if (!prev) {
      return (
        `${opts.tool} blocked: ${rel} has not been read in this session. ` +
        `Call read_file first so the edit is based on current contents ` +
        `(prevents blind overwrites).\n` +
        `Recovery: read_file({ path: ${JSON.stringify(rel)} }) — a hunk or Full output spool is enough — then retry ${opts.tool}.`
      );
    }

    // Allow 1ms float noise; size must match exactly.
    const mtimeDrift = Math.abs(st.mtimeMs - prev.mtimeMs);
    if (st.size !== prev.size || mtimeDrift > 1.5) {
      // Refresh is NOT automatic — force re-read so the model sees the new body.
      this.clear(filePath);
      return (
        `${opts.tool} blocked: ${rel} changed on disk since it was last read ` +
        `(size ${prev.size}→${st.size}, mtime drift ${mtimeDrift.toFixed(0)}ms). ` +
        `Re-read the current hunk (not the whole file), then retry the edit with fresh old_string.\n` +
        `Recovery: read_file({ path: ${JSON.stringify(rel)} }) then retry ${opts.tool}.`
      );
    }
    return null;
  }

  /**
   * Drop stamps whose files vanished or changed on disk. Checkpoint compact
   * calls this instead of wiping the map so unattended edits can continue.
   */
  pruneStaleFromDiskSync(): number {
    let n = 0;
    for (const [key, stamp] of [...this.map.entries()]) {
      try {
        const st = fs.statSync(key);
        if (!st.isFile()) {
          this.map.delete(key);
          n += 1;
          continue;
        }
        const drift = Math.abs(st.mtimeMs - stamp.mtimeMs);
        if (st.size !== stamp.size || drift > 1.5) {
          this.map.delete(key);
          n += 1;
        }
      } catch {
        this.map.delete(key);
        n += 1;
      }
    }
    return n;
  }
}

/** Env kill-switch for emergencies / legacy scripts. */
export function fileReadGuardEnabled(): boolean {
  const v = (process.env.FORGE_FILE_READ_GUARD || "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}
