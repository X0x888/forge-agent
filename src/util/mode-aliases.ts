/**
 * Permission / sandbox aliases shared by CLI flags and FORGE_* env vars.
 */
import type {
  PermissionMode,
  SandboxNetwork,
  SandboxProfile,
} from "../config/types.js";

const PERMISSION_ALIASES: Record<string, PermissionMode> = {
  "dont-ask": "dontAsk",
  "dont_ask": "dontAsk",
  deny: "dontAsk",
  ask: "dontAsk",
  "no-ask": "dontAsk",
  "never-ask": "dontAsk",
  yolo: "bypassPermissions",
  always: "bypassPermissions",
  bypass: "bypassPermissions",
  accept: "acceptEdits",
  edits: "acceptEdits",
};

const SANDBOX_ALIASES: Record<string, SandboxProfile> = {
  readonly: "read-only",
  read_only: "read-only",
  ro: "read-only",
  ws: "workspace",
  work: "workspace",
  none: "off",
  false: "off",
  "0": "off",
  full: "strict",
  locked: "strict",
};

const NETWORK_ALIASES: Record<string, SandboxNetwork> = {
  none: "blocked",
  off: "blocked",
  block: "blocked",
  deny: "blocked",
  no: "blocked",
  open: "unrestricted",
  full: "unrestricted",
  allow: "unrestricted",
  yes: "unrestricted",
  any: "unrestricted",
};

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

const SANDBOX_PROFILES = new Set<SandboxProfile>([
  "off",
  "workspace",
  "read-only",
  "strict",
]);

const SANDBOX_NETWORKS = new Set<SandboxNetwork>(["unrestricted", "blocked"]);

export function normalizePermissionMode(
  raw: unknown,
): PermissionMode | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const mode = PERMISSION_ALIASES[s.toLowerCase()] || (s as PermissionMode);
  return PERMISSION_MODES.has(mode) ? mode : null;
}

export function normalizeSandboxProfile(
  raw: unknown,
): SandboxProfile | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const profile =
    SANDBOX_ALIASES[s.toLowerCase()] || (s as SandboxProfile);
  return SANDBOX_PROFILES.has(profile) ? profile : null;
}

export function normalizeSandboxNetwork(
  raw: unknown,
): SandboxNetwork | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const net = NETWORK_ALIASES[s.toLowerCase()] || (s as SandboxNetwork);
  return SANDBOX_NETWORKS.has(net) ? net : null;
}
