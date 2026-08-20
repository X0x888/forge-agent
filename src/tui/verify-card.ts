/**
 * `/verify` — the sit-down Next for a stale / red / missing proof trail.
 *
 * Typing `npm test` at › is a model prompt. This key runs the last or
 * project check (same PermissionGate + trail stamp as `!cmd`), then opens
 * verdict-first. Non-check args are refused. Designed empty is
 * `verify  ·  nothing to run`, not `verify  ·  ok`.
 */
import chalk from "chalk";
import { PermissionGate } from "../agent/permissions.js";
import type { ForgeConfig } from "../config/types.js";
import {
  isVerificationCommand,
  verificationPassedFromResult,
} from "../harness/ulw-cycle.js";
import type { SessionData } from "../session/session.js";
import { detectProjectIntel } from "../util/project-intel.js";
import { visibleWidth } from "../util/format.js";
import { runBangShell } from "./bang-shell.js";

export const VERIFY_BODY_MAX_LINES = 24;
export const VERIFY_BODY_MAX_CHARS = 3_500;

export type VerifyResolveReason =
  | "arg"
  | "last"
  | "project"
  | "empty"
  | "refused";

export interface VerifyResolve {
  command: string;
  reason: VerifyResolveReason;
  attempted?: string;
  preferred: string[];
}

export function resolveVerifyCommand(
  session: SessionData,
  config: Pick<ForgeConfig, "workspace">,
  arg?: string,
): VerifyResolve {
  const cwd = config.workspace || session.meta.cwd || process.cwd();
  let preferred: string[] = [];
  try {
    preferred = detectProjectIntel(cwd).checkCommands.filter((c) =>
      Boolean(c?.trim()),
    );
  } catch {
    preferred = [];
  }
  const last = session.meta.lastVerificationCommand?.trim() || "";
  const want = String(arg || "").trim();
  if (want) {
    if (isVerificationCommand(want, preferred) || want === last) {
      return { command: want, reason: "arg", preferred };
    }
    const hit = preferred.find(
      (p) =>
        p === want ||
        p.endsWith(` ${want}`) ||
        p.split(/\s+/).at(-1) === want,
    );
    if (hit) return { command: hit, reason: "arg", preferred };
    return { command: "", reason: "refused", attempted: want, preferred };
  }
  if (last) return { command: last, reason: "last", preferred };
  if (preferred[0]) return { command: preferred[0], reason: "project", preferred };
  return { command: "", reason: "empty", preferred };
}

export function formatVerifyVerdict(
  kind: "ok" | "fail" | "empty" | "refused",
  opts?: { color?: boolean },
): string {
  const color = opts?.color !== false;
  const title = color ? chalk.bold("verify") : "verify";
  if (kind === "empty") {
    const bit = color ? chalk.dim("nothing to run") : "nothing to run";
    return `${title}  ·  ${bit}`;
  }
  if (kind === "refused") {
    const bit = color ? chalk.yellow("refused") : "refused";
    return `${title}  ·  ${bit}`;
  }
  if (kind === "ok") {
    const bit = color ? chalk.green("ok") : "ok";
    return `${title}  ·  ${bit}`;
  }
  const bit = color ? chalk.red("✗") : "✗";
  return `${title}  ·  ${bit}`;
}

export function formatVerifyCloser(
  keys: string[],
  opts?: { columns?: number },
): string {
  const uniq: string[] = [];
  for (const k of keys) {
    const n = k.trim();
    if (n && !uniq.includes(n)) uniq.push(n);
  }
  if (!uniq.length) return "";
  const line = `Next  ${uniq.join("  ·  ")}`;
  const cols = Math.max(
    24,
    opts?.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  if (visibleWidth(line) <= cols) return line;
  return [`Next  ${uniq[0]}`, ...uniq.slice(1).map((k) => `  ·  ${k}`)].join(
    "\n",
  );
}

export function clipVerifyBody(printed: string): string {
  const lines = String(printed || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const body =
    lines[0]?.startsWith("!") ? lines.slice(1) : lines;
  const keep = body.slice(-VERIFY_BODY_MAX_LINES);
  let text = keep.join("\n").replace(/\s+$/u, "");
  if (body.length > keep.length) {
    text = `…(${body.length - keep.length} lines)\n${text}`;
  }
  if (text.length > VERIFY_BODY_MAX_CHARS) {
    text = `…\n${text.slice(-VERIFY_BODY_MAX_CHARS)}`;
  }
  return text;
}

export function formatVerifyCard(input: {
  kind: "ok" | "fail" | "empty" | "refused";
  command?: string;
  body?: string;
  note?: string;
  next: string[];
  color?: boolean;
  columns?: number;
}): string {
  const color = input.color !== false;
  const lines = [formatVerifyVerdict(input.kind, { color })];
  const cmd = input.command?.trim();
  if (cmd) {
    const row = `  $ ${cmd}`;
    lines.push(color ? chalk.dim(row) : row);
  }
  const note = input.note?.trim();
  if (note) {
    lines.push(color ? chalk.yellow(`  ${note}`) : `  ${note}`);
  }
  const body = clipVerifyBody(input.body || "");
  if (body) {
    for (const row of body.split("\n")) {
      lines.push(color ? chalk.dim(row) : row);
    }
  }
  const closer = formatVerifyCloser(input.next, { columns: input.columns });
  if (closer) lines.push(closer);
  return lines.filter((l) => l.length > 0).join("\n");
}

export async function runVerify(opts: {
  session: SessionData;
  config: ForgeConfig;
  arg?: string;
  persist?: boolean;
  interactive?: boolean;
  color?: boolean;
  columns?: number;
}): Promise<{ output: string; failed: boolean; command?: string }> {
  const resolved = resolveVerifyCommand(opts.session, opts.config, opts.arg);
  const color = opts.color;
  const columns = opts.columns;
  if (resolved.reason === "empty") {
    return {
      output: formatVerifyCard({
        kind: "empty",
        note: "No last check · no project check",
        next: ["/help verify"],
        color,
        columns,
      }),
      failed: false,
    };
  }
  if (resolved.reason === "refused") {
    const attempted = resolved.attempted || opts.arg || "";
    return {
      output: formatVerifyCard({
        kind: "refused",
        note: `not a project check: ${attempted.slice(0, 80)}`,
        next: ["/verify", resolved.preferred[0] ? `/verify ${resolved.preferred[0]}` : ""].filter(
          Boolean,
        ),
        color,
        columns,
      }),
      failed: true,
    };
  }

  const permissions = new PermissionGate({
    interactive: opts.interactive !== false,
  });
  const bang = await runBangShell({
    line: `!${resolved.command}`,
    config: opts.config,
    session: opts.session,
    permissions,
    persist: opts.persist,
    // A check is not a ship — do not increment turnCount or journal
    // fixtures `npm test` may write (same hole as treating /verify as !cmd).
    journal: false,
  });
  const denied = /denied/i.test(bang.output || "");
  const passed = verificationPassedFromResult({
    command: resolved.command,
    isError: bang.isError,
    output: bang.output,
  });
  const failed = !passed || Boolean(bang.isError);
  const next = failed
    ? denied
      ? ["/permissions", "/verify"]
      : ["/verify", "/last"]
    : ["/commit", "/diff"];
  return {
    output: formatVerifyCard({
      kind: failed ? "fail" : "ok",
      command: resolved.command,
      body: bang.output,
      next,
      color,
      columns,
    }),
    failed,
    command: resolved.command,
  };
}
