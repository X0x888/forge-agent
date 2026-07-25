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

const execAsync = promisify(exec);

function truthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

function resolveTimeoutMs(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export async function toolBash(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const command = String(args.command || "");
  if (!command) return { output: "command is required", isError: true };
  const timeout = resolveTimeoutMs(args.timeout_ms, defaultBashTimeoutMs());
  const profile = ctx.sandbox ?? "workspace";
  const missingBackend = ctx.sandboxMissingBackend ?? "fail-closed";
  const env = createShellEnv(process.env);

  if (truthy(args.background) || truthy(args.run_in_background)) {
    const started = await startBackgroundTask({
      command,
      cwd: ctx.workspace,
      profile,
      network: ctx.sandboxNetwork,
      missingBackend,
      timeoutMs: resolveTimeoutMs(
        args.timeout_ms,
        defaultBashBackgroundTimeoutMs(),
      ),
    });
    if (!started.ok) {
      return {
        output: started.message,
        isError: true,
      };
    }
    const t = started.task;
    return {
      output:
        `Background task started.\n` +
        `task_id: ${t.id}\n` +
        `pid: ${t.pid ?? "n/a"}\n` +
        `sandbox: ${t.backend}${t.sandboxed ? "" : " (unsandboxed)"}\n` +
        `stdout: ${t.stdoutPath}\n` +
        `stderr: ${t.stderrPath}\n` +
        `Use get_task_output with this task_id to poll; kill_task to stop.`,
    };
  }

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
      const managed = await boundToolOutput(
        meta + (out || `Command failed (code ${result.code})`),
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
    const managed = await boundToolOutput(meta + (out || "(no output)"), {
      maxChars: BASH_MAX_CHARS,
    });
    return { output: managed.text };
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
        out || `Command failed (code ${e.code})`,
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
  }
}
