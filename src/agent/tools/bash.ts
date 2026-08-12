import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolContext, ToolResult } from "./types.js";
import { createShellEnv } from "./env-policy.js";
import { boundToolOutput, BASH_MAX_CHARS } from "./truncate.js";
import { startBackgroundTask } from "./background-tasks.js";
import {
  defaultBashBackgroundTimeoutMs,
  defaultBashTimeoutMs,
} from "../../util/env.js";
import { isTruthy } from "../../util/bool.js";
import { numberFieldError } from "./arg-types.js";
import { editDistance } from "../../util/string-distance.js";
import { parseDurationMs } from "../../util/duration-ms.js";
import { createSafetyCheckpoint } from "../../util/git-checkpoint.js";
import {
  detectPackageManager,
  detectProjectIntel,
  missingBinaryTip,
  missingNodeModulesTip,
  multipleLockfilesTip,
  missingScriptTip,
  monorepoLayoutTip,
  nextCheckTip,
  permissionDeniedTip,
  wrongPackageManagerTip,
} from "../../util/project-intel.js";

const execAsync = promisify(exec);

/** Append package-manager / missing-script / missing-binary / next-check tips. */
function withPmTip(body: string, command: string, workspace: string): string {
  const tips: string[] = [];
  let hadMissingScript = false;
  let hadMissingBinary = false;
  let hadMonoLayout = false;
  let hadMissingNm = false;
  try {
    const pmTip = wrongPackageManagerTip(
      command,
      detectPackageManager(workspace),
      body,
    );
    if (pmTip) tips.push(pmTip);
  } catch {
    /* best-effort */
  }
  try {
    const miss = missingScriptTip(command, body, workspace);
    if (miss) {
      tips.push(miss);
      hadMissingScript = true;
    }
  } catch {
    /* best-effort */
  }
  try {
    const bin = missingBinaryTip(command, body, workspace);
    if (bin) {
      tips.push(bin);
      hadMissingBinary = true;
    }
  } catch {
    /* best-effort */
  }
  try {
    const nm = missingNodeModulesTip(body, workspace);
    if (nm) {
      tips.push(nm);
      hadMissingNm = true;
    }
  } catch {
    /* best-effort */
  }
  try {
    const multi = multipleLockfilesTip(command, workspace);
    if (multi) tips.push(multi);
  } catch {
    /* best-effort */
  }
  try {
    const perm = permissionDeniedTip(command, body);
    if (perm) tips.push(perm);
  } catch {
    /* best-effort */
  }
  try {
    const mono = monorepoLayoutTip(body, workspace);
    if (mono) {
      tips.push(mono);
      hadMonoLayout = true;
    }
  } catch {
    /* best-effort */
  }
  // Skip next-check when a more specific recovery tip already explains the failure.
  if (
    !hadMissingScript &&
    !hadMissingBinary &&
    !hadMonoLayout &&
    !hadMissingNm
  ) {
    try {
      const next = nextCheckTip(command, workspace);
      if (next) tips.push(next);
    } catch {
      /* best-effort */
    }
  }
  if (!tips.length) return body;
  // Cap tip noise — most specific tips are pushed first.
  const capped = tips.slice(0, 3);
  return `${body}\n\nTip: ${capped.join("\nTip: ")}`;
}

/** Parse timeout_ms: omitted → fallback; explicit invalid → null (fail closed). */
function resolveTimeoutMs(
  raw: unknown,
  fallback: number,
): { ok: true; ms: number } | { ok: false; tip?: string } {
  if (raw == null || String(raw).trim() === "") return { ok: true, ms: fallback };
  const key = String(raw).trim().toLowerCase();
  if (key === "default" || key === "def" || key === "auto" || key === "omit") {
    return { ok: true, ms: fallback };
  }
  // max/all/unlimited → 30 minutes (safety ceiling for long jobs)
  if (key === "max" || key === "unlimited" || key === "full" || key === "all") {
    return { ok: true, ms: Math.max(fallback, 30 * 60 * 1000) };
  }
  // Duration suffixes: 30s, 1m, 2h, 500ms (expert muscle memory).
  const parsedDur = parseDurationMs(key);
  if (parsedDur.ok && !/^\d+$/.test(key)) {
    // Cap absurd values at 24h
    return { ok: true, ms: Math.min(parsedDur.ms, 24 * 60 * 60 * 1000) };
  }
  if (!/^\d+$/.test(key)) {
    let tip: string | undefined;
    let best = Infinity;
    for (const c of ["default", "max", "all", "30s", "1m", "30000", "60000", "120000"]) {
      const d = editDistance(key, c);
      if (d < best && d <= Math.max(2, Math.floor(c.length / 2))) {
        best = d;
        tip = c;
      }
    }
    return tip ? { ok: false, tip } : { ok: false };
  }
  const n = Number(key);
  if (!Number.isFinite(n) || n < 1) return { ok: false };
  return { ok: true, ms: Math.floor(n) };
}


/**
 * Destructive git shapes that should auto-checkpoint the tree first so the
 * expert can recover without manual stash. Conservative — only clear blast-radius.
 * FORGE_GIT_AUTO_CHECKPOINT=0 disables.
 */
export function isDestructiveGitCommand(command: string): boolean {
  const c = String(command || "").trim();
  if (!c) return false;
  // Match git as a primary command or after && / ; / ||
  const segs = c.split(/(?:&&|;|\|\|)/);
  for (const raw of segs) {
    const s = raw.trim().replace(/^\d*\s*/, ""); // strip leading job numbers
    if (!/^git(\s|$)/.test(s)) continue;
    // strip `git -C path` / `git --git-dir=...`
    let rest = s.replace(/^git\s+/, "");
    rest = rest.replace(/^(?:-C\s+\S+\s+|--git-dir=\S+\s+|--work-tree=\S+\s+)+/, "");
    if (
      /\breset\s+--hard\b/.test(rest) ||
      /\bclean\s+-[a-zA-Z]*f/.test(rest) || // clean -fd / -fx / -dff
      /\bcheckout\s+--\s+\.(\s|$)/.test(rest) ||
      /\brestore\s+--\s*(?:worktree\s+)?(?:--source=\S+\s+)?\.(\s|$)/.test(rest) ||
      /\bpush\s+.*--force\b/.test(rest) ||
      /\bpush\s+.*-f\b/.test(rest) ||
      /\bbranch\s+-[dD]\b/.test(rest) ||
      /\bstash\s+drop\b/.test(rest) ||
      /\bstash\s+clear\b/.test(rest)
    ) {
      return true;
    }
  }
  return false;
}

function maybeAutoCheckpointBeforeDestructiveGit(
  command: string,
  workspace: string,
): string {
  const off = (process.env.FORGE_GIT_AUTO_CHECKPOINT || "1").trim().toLowerCase();
  if (off === "0" || off === "false" || off === "off" || off === "no") return "";
  if (!isDestructiveGitCommand(command)) return "";
  try {
    const snap = createSafetyCheckpoint(workspace, { label: "pre-destructive-git" });
    if (snap.ok && snap.sha) {
      return (
        `[forge auto-checkpoint before destructive git: ${snap.sha}` +
        (snap.ref ? ` · ${snap.ref}` : "") +
        ` · restore: git stash apply ${snap.sha}]\n`
      );
    }
    if (snap.clean) return "";
    if (snap.detail) {
      return `[forge auto-checkpoint skipped: ${snap.detail.slice(0, 120)}]\n`;
    }
  } catch {
    /* */
  }
  return "";
}

export async function toolBash(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Trim so whitespace-only is rejected (was a silent no-op success).
  if (args.command != null && typeof args.command !== "string") {
    const kind =
      args.command === null
        ? "null"
        : Array.isArray(args.command)
          ? "array"
          : typeof args.command;
    return {
      output: `bash error: command must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const command = String(args.command || "").trim();
  if (!command) {
    let example = "npm test";
    let longEx = "npm run build";
    try {
      const intel = detectProjectIntel(ctx.workspace || process.cwd());
      if (intel.checkCommands[0]) example = intel.checkCommands[0];
      if (intel.checkCommands[1]) longEx = intel.checkCommands[1];
      else if (intel.checkCommands[0]) longEx = intel.checkCommands[0];
    } catch {
      /* */
    }
    // Escape for JSON example embedding
    const exJson = JSON.stringify(example);
    const longJson = JSON.stringify(longEx);
    return {
      output:
        "bash error: command is required (non-empty string).\n" +
        `Example: { "command": ${exJson}, "timeout_ms": "120s" }\n` +
        `For long jobs: { "command": ${longJson}, "background": true } then get_task_output.\n` +
        "Prefer project checks from /context when verifying edits.",
      isError: true,
    };
  }
  const timeoutRes = resolveTimeoutMs(args.timeout_ms, defaultBashTimeoutMs());
  if (!timeoutRes.ok) {
    return {
      output:
        numberFieldError(
          "bash",
          "timeout_ms",
          args.timeout_ms,
          (timeoutRes.tip ? `Did you mean: ${timeoutRes.tip}? ` : "") +
            "Pass a positive integer ms (or 30s/1m/2h), or default|max|all (omit for default).",
        ),
      isError: true,
    };
  }
  const timeout = timeoutRes.ms;
  const profile = ctx.sandbox ?? "workspace";
  const missingBackend = ctx.sandboxMissingBackend ?? "fail-closed";
  const env = createShellEnv(process.env);

  if (isTruthy(args.background) || isTruthy(args.run_in_background)) {
    const bgTimeoutRes = resolveTimeoutMs(
      args.timeout_ms,
      defaultBashBackgroundTimeoutMs(),
    );
    if (!bgTimeoutRes.ok) {
      return {
        output:
          numberFieldError(
            "bash",
            "timeout_ms",
            args.timeout_ms,
            (bgTimeoutRes.tip ? `Did you mean: ${bgTimeoutRes.tip}? ` : "") +
              "Pass a positive integer ms (or 30s/1m/2h), or default|max|all (omit for default).",
          ),
        isError: true,
      };
    }
    const bgTimeoutMs = bgTimeoutRes.ms;
  const autoCpNote = maybeAutoCheckpointBeforeDestructiveGit(
      command,
      ctx.workspace || process.cwd(),
    );
  const started = await startBackgroundTask({
      command,
      cwd: ctx.workspace,
      sessionId: ctx.sessionId,
      profile,
      network: ctx.sandboxNetwork,
      missingBackend,
      timeoutMs: bgTimeoutMs,
    });
    if (!started.ok) {
      return {
        output: started.message,
        isError: true,
      };
    }
  const t = started.task;
    const bgTimeout = bgTimeoutMs;
    return {
      output:
        autoCpNote +
        `Background task started.\n` +
        `task_id: ${t.id}\n` +
        `pid: ${t.pid ?? "n/a"}\n` +
        `timeout_ms: ${bgTimeout}\n` +
        `sandbox: ${t.backend}${t.sandboxed ? "" : " (unsandboxed)"}\n` +
        `stdout: ${t.stdoutPath}\n` +
        `stderr: ${t.stderrPath}\n` +
        `Use get_task_output({ task_id, wait: "2m" }) to await; kill_task to stop.`,
    };
  }

  const autoCpNoteFg = maybeAutoCheckpointBeforeDestructiveGit(
    command,
    ctx.workspace || process.cwd(),
  );
  try {
    const { execCommandSandboxed } = await import("./sandbox-exec.js");
    if (ctx.signal?.aborted) {
      return { output: "Aborted", isError: true };
    }
  const result = await execCommandSandboxed({
      command,
      cwd: ctx.workspace,
      timeoutMs: timeout,
      profile,
      network: ctx.sandboxNetwork,
      missingBackend,
      env,
      signal: ctx.signal,
    });
    if (result.failClosed) {
      const managed = await boundToolOutput(
        result.stderr ||
          "Sandbox backend unavailable (fail-closed). Install bwrap / Xcode CLT, or set sandbox=off.",
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
    if (ctx.signal?.aborted || result.code === 130) {
      const managed = await boundToolOutput(
        result.stderr || "Aborted",
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
  const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const net = result.network ? ` net=${result.network}` : "";
    const meta = result.sandboxed
      ? `[sandbox:${result.backend}${net}] `
      : result.warning
        ? `[sandbox:off — ${result.warning}] `
        : "";
    if (result.code && result.code !== 0) {
      // Always surface exit code — models often miss it when stderr is noisy.
      // 124 = wall-clock timeout (sandbox runner convention).
      const timeoutNote =
        result.code === 124 && !/timed out/i.test(out)
          ? `\nCommand timed out after ${timeout}ms`
          : "";
      const body = out
        ? `${out}${timeoutNote}\n\n[exit code ${result.code}]`
        : result.code === 124
          ? `Command timed out after ${timeout}ms (exit code 124)`
          : `Command failed (exit code ${result.code})`;
      const managed = await boundToolOutput(
        withPmTip(meta + body, command, ctx.workspace),
        {
          maxChars: BASH_MAX_CHARS,
        },
      );
      return { output: autoCpNoteFg + managed.text, isError: true };
    }
  const managed = await boundToolOutput(meta + (out || "(no output)"), {
      maxChars: BASH_MAX_CHARS,
    });
    return { output: autoCpNoteFg + managed.text };
  } catch (err) {
    if (ctx.signal?.aborted) {
      return { output: "Aborted", isError: true };
    }
    if (profile !== "off" && missingBackend === "fail-closed") {
      const managed = await boundToolOutput(
        `Sandbox error (fail-closed): ${(err as Error).message}`,
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx.workspace,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env,
        signal: ctx.signal,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n");
      const managed = await boundToolOutput(
        `[sandbox:fallback] ${out || "(no output)"}`,
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text };
    } catch (err2) {
      if (ctx.signal?.aborted) {
        return { output: "Aborted", isError: true };
      }
      const e = err2 as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number;
      };
      const out = [e.stdout, e.stderr, e.message, (err as Error).message]
        .filter(Boolean)
        .join("\n");
      const managed = await boundToolOutput(
        withPmTip(out || `Command failed (code ${e.code})`, command, ctx.workspace),
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
  }
}
