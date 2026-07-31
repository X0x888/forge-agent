/**
 * Turn-end attention: terminal BEL + optional desktop notification.
 *
 * Experts leave long ULW/goal runs in the background; BEL alone is easy to
 * miss on modern terminals. Desktop notify (osascript / notify-send) is
 * opt-in via `/notify on` or FORGE_NOTIFY=1.
 *
 * Never throws. Never blocks the agent loop on notification failure.
 */

import { spawn } from "node:child_process";
import {
  loadPreferences,
  savePreferences,
  type UserPreferences,
} from "../config/preferences.js";

function envFlag(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (v == null || v === "") return undefined;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return undefined;
}

export interface AttentionOpts {
  /** Override preference object (tests). */
  bellOnTurnEnd?: boolean;
  notifyOnTurnEnd?: boolean;
  /** Force ring even when preference is off (used by /bell test). */
  force?: boolean;
}

/** Terminal BEL — preference, overridable by FORGE_BELL. */
export function isBellEnabled(opts: AttentionOpts | UserPreferences = {}): boolean {
  const env = envFlag("FORGE_BELL");
  if (env !== undefined) return env;
  if (typeof (opts as AttentionOpts).bellOnTurnEnd === "boolean") {
    return Boolean((opts as AttentionOpts).bellOnTurnEnd);
  }
  return loadPreferences().bellOnTurnEnd === true;
}

export function setBellEnabled(on: boolean): void {
  savePreferences({ bellOnTurnEnd: on });
}

/**
 * Desktop notification — preference, overridable by FORGE_NOTIFY.
 * Default off (opt-in). When on, fires after turn end alongside BEL.
 */
export function isNotifyEnabled(
  opts: AttentionOpts | UserPreferences = {},
): boolean {
  const env = envFlag("FORGE_NOTIFY");
  if (env !== undefined) return env;
  if (typeof (opts as AttentionOpts).notifyOnTurnEnd === "boolean") {
    return Boolean((opts as AttentionOpts).notifyOnTurnEnd);
  }
  return loadPreferences().notifyOnTurnEnd === true;
}

export function setNotifyEnabled(on: boolean): void {
  savePreferences({ notifyOnTurnEnd: on });
}

/**
 * Ring the terminal bell if enabled (or force).
 * Returns true when BEL was written.
 */
export function maybeRingBell(opts: AttentionOpts = {}): boolean {
  if (!opts.force && !isBellEnabled(opts)) return false;
  try {
    if (process.stdout?.isTTY) {
      process.stdout.write("\x07");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export interface NotifyPayload {
  title?: string;
  body?: string;
  /** Session id / short subtitle. */
  subtitle?: string;
  force?: boolean;
}

/**
 * Fire a best-effort desktop notification when enabled (or force).
 * Returns true when a notify process was spawned.
 */
export function maybeDesktopNotify(
  payload: NotifyPayload & AttentionOpts = {},
): boolean {
  if (!payload.force && !isNotifyEnabled(payload)) return false;
  try {
    return fireDesktopNotify(payload);
  } catch {
    return false;
  }
}

/** Combined turn-end attention (BEL + desktop). */
export function maybeTurnEndAttention(
  payload: NotifyPayload & AttentionOpts = {},
): void {
  maybeRingBell(payload);
  maybeDesktopNotify(payload);
}

/** Inputs for turn-end notify/BEL outcome label (pure). */
export interface TurnEndOutcomeInput {
  hitCostCap?: boolean;
  hitMaxTurns?: boolean;
  releasedOnContinueCap?: boolean;
  aborted?: boolean;
  lastErrorCode?: string | null;
  /** Session had file edits this run. */
  editCount?: number;
  /** Last successful structural verification command, if any. */
  lastVerificationCommand?: string | null;
  /** True when last-verify is older than the latest file edit. */
  lastVerificationStale?: boolean;
}

/**
 * Short outcome label for turn-end desktop notify / BEL body.
 * Prefer safety valves over generic "turn complete".
 * Append verify trail hints so background ULW experts see unfinished proof.
 */
export function turnEndOutcomeLabel(input: TurnEndOutcomeInput): string {
  if (input.hitCostCap) return "cost cap";
  if (input.hitMaxTurns) return "max turns";
  if (input.releasedOnContinueCap) return "continue cap";
  if (input.aborted) return "aborted";
  const code = String(input.lastErrorCode || "").trim();
  if (code === "handoff_released") return "handoff released";
  if (code === "proof_claim_released") return "proof-claim released";
  if (code === "max_cost") return "cost cap";
  if (code === "max_turns") return "max turns";
  if (code.startsWith("continue_cap")) return "continue cap";
  if (code) return `err:${code.slice(0, 32)}`;

  const edits =
    typeof input.editCount === "number" && Number.isFinite(input.editCount)
      ? input.editCount
      : 0;
  const last = String(input.lastVerificationCommand || "").trim();
  if (edits > 0 && !last) return "turn complete · no last-verify";
  if (last && input.lastVerificationStale) return "turn complete · last-verify stale";
  if (last) return "turn complete · verified";
  return "turn complete";
}

function fireDesktopNotify(payload: NotifyPayload): boolean {
  const title = sanitize(payload.title || "Forge", 80);
  const body = sanitize(payload.body || "Turn complete", 200);
  const subtitle = sanitize(payload.subtitle || "", 80);
  const platform = process.platform;

  if (platform === "darwin") {
    const script =
      `display notification ${osaStr(body)} with title ${osaStr(title)}` +
      (subtitle ? ` subtitle ${osaStr(subtitle)}` : "");
    return spawnDetached("osascript", ["-e", script]);
  }

  if (platform === "linux") {
    return spawnDetached("notify-send", ["--app-name=Forge", title, body]);
  }

  if (platform === "win32") {
    const ps = [
      `Add-Type -AssemblyName System.Windows.Forms`,
      `$n = New-Object System.Windows.Forms.NotifyIcon`,
      `$n.Icon = [System.Drawing.SystemIcons]::Information`,
      `$n.Visible = $true`,
      `$n.ShowBalloonTip(3000, ${psStr(title)}, ${psStr(body)}, [System.Windows.Forms.ToolTipIcon]::Info)`,
      `Start-Sleep -Milliseconds 500`,
      `$n.Dispose()`,
    ].join("; ");
    return spawnDetached("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      ps,
    ]);
  }

  return false;
}

function sanitize(s: string, max: number): string {
  return String(s || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "")
    .trim()
    .slice(0, max);
}

function osaStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function psStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function spawnDetached(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
