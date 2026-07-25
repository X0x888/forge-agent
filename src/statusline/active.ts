/**
 * Active-session registry so the HUD can show live/idle/stale.
 * Written by the REPL / agent loop; read by `forge status`.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome, ensureDir, readJsonFile, writeJsonFile, nowIso, nowEpoch } from "../util/fs.js";

export interface ActiveEntry {
  sessionId: string;
  pid: number;
  cwd: string;
  provider: string;
  model: string;
  startedAt: string;
  heartbeatAt: string;
  /** epoch seconds */
  heartbeatEpoch: number;
  /** Agent is mid-turn (thinking / tools) */
  busy?: boolean;
  /** idle | thinking | tool | compacting | stop_guard | waiting */
  phase?: string;
  /** Tool name or short detail */
  phaseDetail?: string;
  /** Running background shell tasks */
  bgRunning?: number;
}

export interface ActiveRegistry {
  version: 1;
  sessions: Record<string, ActiveEntry>;
}

function registryPath(): string {
  return path.join(forgeHome(), "active_sessions.json");
}

export function loadActiveRegistry(): ActiveRegistry {
  const raw = readJsonFile<ActiveRegistry>(registryPath(), {
    version: 1,
    sessions: {},
  });
  return {
    version: 1,
    sessions: { ...(raw.sessions || {}) },
  };
}

export function saveActiveRegistry(reg: ActiveRegistry): void {
  ensureDir(forgeHome());
  writeJsonFile(registryPath(), reg, 0o600);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Register or refresh this process as the owner of a session. */
export function heartbeatSession(opts: {
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  busy?: boolean;
  phase?: string;
  phaseDetail?: string;
  bgRunning?: number;
}): void {
  const reg = loadActiveRegistry();
  const now = nowEpoch();
  const prev = reg.sessions[opts.sessionId];
  reg.sessions[opts.sessionId] = {
    sessionId: opts.sessionId,
    pid: process.pid,
    cwd: opts.cwd,
    provider: opts.provider,
    model: opts.model,
    startedAt: prev?.startedAt || nowIso(),
    heartbeatAt: nowIso(),
    heartbeatEpoch: now,
    busy: opts.busy ?? prev?.busy,
    phase: opts.phase ?? prev?.phase,
    phaseDetail:
      opts.phaseDetail !== undefined ? opts.phaseDetail : prev?.phaseDetail,
    bgRunning: opts.bgRunning ?? prev?.bgRunning,
  };
  // GC dead pids
  for (const [id, e] of Object.entries(reg.sessions)) {
    if (!isPidAlive(e.pid) && now - e.heartbeatEpoch > 120) {
      delete reg.sessions[id];
    }
  }
  saveActiveRegistry(reg);
}

export function releaseSession(sessionId: string): void {
  const reg = loadActiveRegistry();
  delete reg.sessions[sessionId];
  saveActiveRegistry(reg);
}

export function getActiveEntry(sessionId: string): ActiveEntry | undefined {
  const reg = loadActiveRegistry();
  return reg.sessions[sessionId];
}

export type Liveness = "live" | "working" | "idle" | "stale" | "unknown";

export function computeLiveness(
  sessionId: string,
  updatedAtIso: string,
): { liveness: Liveness; idleSec: number } {
  const updatedMs = Date.parse(updatedAtIso);
  const idleSec = Number.isNaN(updatedMs)
    ? 0
    : Math.max(0, Math.floor((Date.now() - updatedMs) / 1000));

  const active = getActiveEntry(sessionId);
  if (active && isPidAlive(active.pid)) {
    const hbAge = nowEpoch() - active.heartbeatEpoch;
    if (hbAge <= 15) {
      // Mid-turn or background work → "working" so HUD shows more than live
      if (active.busy || (active.bgRunning ?? 0) > 0) {
        return { liveness: "working", idleSec };
      }
      return { liveness: "live", idleSec };
    }
    if (hbAge <= 120) return { liveness: "idle", idleSec };
  }

  if (idleSec > 600) return { liveness: "stale", idleSec };
  if (idleSec > 120) return { liveness: "idle", idleSec };
  // recently updated on disk but no live owner
  return { liveness: active ? "idle" : "unknown", idleSec };
}

export function listActiveSessions(): ActiveEntry[] {
  const reg = loadActiveRegistry();
  const out: ActiveEntry[] = [];
  for (const e of Object.values(reg.sessions)) {
    if (isPidAlive(e.pid)) out.push(e);
  }
  return out.sort((a, b) => b.heartbeatEpoch - a.heartbeatEpoch);
}
