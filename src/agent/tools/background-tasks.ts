/**
 * Background shell tasks (Grok/OpenCode simplified).
 * In-process registry: start → get_task_output → kill_task.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pushInterjection } from "../../harness/interjection.js";
import { forgeHome, ensureDirAsync } from "../../util/fs.js";
import { createShellEnv } from "./env-policy.js";
import type {
  SandboxMissingBackend,
  SandboxNetwork,
  SandboxProfile,
} from "../../config/types.js";
import { defaultNetworkForProfile } from "../../config/types.js";
import { detectSandboxBackend, canonicalSandboxPath } from "../sandbox.js";
import { syncBackgroundCounts } from "../../statusline/activity.js";

export type TaskStatus = "running" | "completed" | "failed" | "killed" | "timeout";

export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  pid?: number;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  stdoutPath: string;
  stderrPath: string;
  error?: string;
  sandboxed: boolean;
  backend: string;
  child?: ChildProcess;
}

const tasks = new Map<string, BackgroundTask>();
const MAX_TASKS = 32;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function tasksDir(): string {
  return path.join(forgeHome(), "background-tasks");
}

function newId(): string {
  return `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pruneOld(): void {
  if (tasks.size < MAX_TASKS) return;
  const done = [...tasks.values()]
    .filter((t) => t.status !== "running")
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  while (tasks.size >= MAX_TASKS && done.length) {
    const t = done.shift()!;
    tasks.delete(t.id);
  }
}

function publishBgActivity(): void {
  const all = [...tasks.values()];
  const running = all.filter((t) => t.status === "running");
  const hint = running[0]
    ? running[0].command.replace(/\s+/g, " ").slice(0, 48)
    : undefined;
  syncBackgroundCounts({
    running: running.length,
    total: all.length,
    hint,
  });
}

interface SpawnPlan {
  file: string;
  args: string[];
  sandboxed: boolean;
  backend: string;
  cleanup?: () => void;
}

function planSpawn(opts: {
  command: string;
  cwd: string;
  profile: SandboxProfile;
  network?: SandboxNetwork;
  missingBackend: SandboxMissingBackend;
}): SpawnPlan | { failClosed: true; message: string } {
  const shell = process.env.SHELL || "/bin/bash";
  const profile = opts.profile || "workspace";
  const network = opts.network ?? defaultNetworkForProfile(profile);
  const restrictNetwork = network === "blocked";

  if (profile === "off") {
    return {
      file: shell,
      args: ["-c", opts.command],
      sandboxed: false,
      backend: "none",
    };
  }

  const detected = detectSandboxBackend();
  const forge = forgeHome();
  const tmp = os.tmpdir();
  const cwd = path.resolve(opts.cwd);

  if (process.platform === "darwin" && detected.path) {
    // Lazy import seatbelt text via dynamic rebuild of minimal profile
    const { writeSeatbeltProfile } = getSeatbeltWriter();
    const profPath = path.join(
      tmp,
      `forge-bg-sbx-${process.pid}-${Date.now()}.sb`,
    );
    writeSeatbeltProfile({
      profile,
      cwd,
      forge: path.resolve(forge),
      tmp: path.resolve(tmp),
      restrictNetwork,
      profPath,
    });
    return {
      file: detected.path,
      args: ["-f", profPath, shell, "-c", opts.command],
      sandboxed: true,
      backend: "sandbox-exec",
      cleanup: () => {
        try {
          fs.unlinkSync(profPath);
        } catch {
          /* */
        }
      },
    };
  }

  if (process.platform === "linux" && detected.path) {
    const args: string[] = [
      "--die-with-parent",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      tmp,
      tmp,
    ];
    if (profile !== "read-only") {
      args.push("--bind", cwd, cwd);
    }
    try {
      fs.mkdirSync(forge, { recursive: true });
    } catch {
      /* */
    }
    args.push("--bind", path.resolve(forge), path.resolve(forge));
    if (restrictNetwork) args.push("--unshare-net");
    args.push("--chdir", cwd, "--", shell, "-c", opts.command);
    return {
      file: detected.path,
      args,
      sandboxed: true,
      backend: "bwrap",
    };
  }

  if (opts.missingBackend === "fail-closed") {
    return {
      failClosed: true,
      message:
        detected.available
          ? `Sandbox not supported for background on ${process.platform}`
          : `Sandbox backend unavailable (fail-closed). Install bwrap / Xcode CLT, or set sandbox=off.`,
    };
  }

  return {
    file: shell,
    args: ["-c", opts.command],
    sandboxed: false,
    backend: "none",
  };
}

/** Minimal seatbelt writer to avoid circular deps with full sandbox module. */
function getSeatbeltWriter() {
  return {
    writeSeatbeltProfile(o: {
      profile: SandboxProfile;
      cwd: string;
      forge: string;
      tmp: string;
      restrictNetwork: boolean;
      profPath: string;
    }) {
      // Seatbelt canonicalizes subpath rules (macOS /var → /private/var), so
      // the tmp path must be canonical or $TMPDIR writes are denied.
      const tmp = canonicalSandboxPath(o.tmp);
      const writePaths =
        o.profile === "read-only"
          ? [o.forge, tmp, "/private/tmp", "/var/tmp", "/private/var/tmp"]
          : [
              o.cwd,
              o.forge,
              tmp,
              "/private/tmp",
              "/var/tmp",
              "/private/var/tmp",
            ];
      const writeAllow = writePaths
        .map((p) => `  (subpath ${JSON.stringify(p)})`)
        .join("\n");
      const networkClause = o.restrictNetwork
        ? `(deny network*)\n(deny network-outbound)\n(deny network-inbound)`
        : `(allow network*)`;
      const text = `
(version 1)
(debug deny)
(allow default)
(deny file-write*)
(allow file-write-data
${writeAllow}
  (literal "/dev/null")
  (literal "/dev/tty")
  (regex #"^/dev/fd/")
  (regex #"^/dev/ttys")
)
(allow file-write*
${writeAllow}
  (literal "/dev/null")
  (regex #"^/dev/fd/")
  (regex #"^/dev/ttys")
)
(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys") (regex #"^/dev/fd/"))
(allow process-exec*)
(allow process-fork)
(allow process-info*)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
${networkClause}
`.trim();
      fs.writeFileSync(o.profPath, text, { mode: 0o600 });
    },
  };
}


function maybeNotifyBgComplete(
  task: BackgroundTask,
  sessionId?: string,
): void {
  const off = (process.env.FORGE_BG_NOTIFY || "1").trim().toLowerCase();
  if (off === "0" || off === "false" || off === "off" || off === "no") return;
  if (!sessionId) return;
  try {
    const dur =
      task.endedAt && task.startedAt
        ? Math.max(0, task.endedAt - task.startedAt)
        : 0;
    const cmd = String(task.command || "").slice(0, 120);
    const status = task.status;
    const code =
      task.exitCode === null || task.exitCode === undefined
        ? "?"
        : String(task.exitCode);
    const msg =
      `[Forge harness — background task ${status}]\n` +
      `task_id=${task.id}  exit=${code}  ${dur}ms\n` +
      `command: ${cmd}${String(task.command || "").length > 120 ? "…" : ""}\n` +
      `Use get_task_output({ task_id: "${task.id}", tail: 80 }) for logs, then continue. ` +
      `Do not ask the user — act on the result.`;
    pushInterjection(sessionId, msg);
  } catch {
    /* never break bg lifecycle */
  }
}

export async function startBackgroundTask(opts: {
  command: string;
  cwd: string;
  profile: SandboxProfile;
  network?: SandboxNetwork;
  missingBackend?: SandboxMissingBackend;
  timeoutMs?: number;
  /** When set, completion pushes a mid-run interjection so the agent continues without polling. */
  sessionId?: string;
}): Promise<
  | { ok: true; task: BackgroundTask }
  | { ok: false; message: string; failClosed?: boolean }
> {
  pruneOld();
  const plan = planSpawn({
    command: opts.command,
    cwd: opts.cwd,
    profile: opts.profile,
    network: opts.network,
    missingBackend: opts.missingBackend ?? "fail-closed",
  });
  if ("failClosed" in plan && plan.failClosed) {
    return { ok: false, message: plan.message, failClosed: true };
  }
  const spawnPlan = plan as SpawnPlan;

  const id = newId();
  const dir = path.join(tasksDir(), id);
  await ensureDirAsync(dir);
  const stdoutPath = path.join(dir, "stdout.txt");
  const stderrPath = path.join(dir, "stderr.txt");
  await fsp.writeFile(stdoutPath, "", "utf8");
  await fsp.writeFile(stderrPath, "", "utf8");

  const env = createShellEnv(process.env);
  const outFd = fs.openSync(stdoutPath, "a");
  const errFd = fs.openSync(stderrPath, "a");

  let child: ChildProcess;
  try {
    child = spawn(spawnPlan.file, spawnPlan.args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", outFd, errFd],
      detached: false,
    });
  } catch (err) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    spawnPlan.cleanup?.();
    return { ok: false, message: `Failed to spawn: ${(err as Error).message}` };
  }

  // Parent can close its copies; child keeps FDs
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const task: BackgroundTask = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    status: "running",
    pid: child.pid,
    exitCode: null,
    startedAt: Date.now(),
    stdoutPath,
    stderrPath,
    sandboxed: spawnPlan.sandboxed,
    backend: spawnPlan.backend,
    child,
  };
  tasks.set(id, task);
  publishBgActivity();

  const timeoutMs = opts.timeoutMs ?? 30 * 60_000; // 30m default for background
  const timer = setTimeout(() => {
    if (task.status === "running") {
      try {
        child.kill("SIGTERM");
        // unref: SIGKILL grace must not hold the event loop after timeout.
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* */
          }
        }, 3000).unref?.();
      } catch {
        /* */
      }
      task.status = "timeout";
      task.endedAt = Date.now();
      task.error = `Timed out after ${timeoutMs}ms`;
      publishBgActivity();
    }
  }, timeoutMs);
  timer.unref?.();

  child.on("close", (code) => {
    clearTimeout(timer);
    spawnPlan.cleanup?.();
    if (task.status === "running") {
      task.status = code === 0 ? "completed" : "failed";
      task.exitCode = code;
      task.endedAt = Date.now();
    } else if (task.status === "timeout" || task.status === "killed") {
      task.exitCode = code;
      task.endedAt = task.endedAt || Date.now();
    }
    task.child = undefined;
    publishBgActivity();
    maybeNotifyBgComplete(task, opts.sessionId);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    spawnPlan.cleanup?.();
    task.status = "failed";
    task.error = err.message;
    task.endedAt = Date.now();
    task.child = undefined;
    publishBgActivity();
    maybeNotifyBgComplete(task, opts.sessionId);
  });

  return { ok: true, task };
}

export function getTask(id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

export function listTasks(): BackgroundTask[] {
  return [...tasks.values()];
}

/**
 * Block until a background task leaves `running`, or until timeoutMs elapses.
 * Uses the child process `close` event when available; falls back to polling.
 * Returns the task snapshot (may still be running on timeout).
 */
export async function waitForTask(
  id: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<
  | { ok: true; task: BackgroundTask; timedOut: boolean; waitedMs: number }
  | { ok: false; error: string }
> {
  const task = tasks.get(id);
  if (!task) return { ok: false, error: `Unknown task_id: ${id}` };

  const timeoutMs = Math.max(
    0,
    Math.min(
      30 * 60_000,
      Number.isFinite(opts.timeoutMs as number)
        ? Math.floor(opts.timeoutMs as number)
        : 120_000,
    ),
  );
  const pollMs = Math.max(25, Math.min(2000, opts.pollMs ?? 100));
  const started = Date.now();

  if (task.status !== "running") {
    return { ok: true, task, timedOut: false, waitedMs: 0 };
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        task.child?.off?.("close", onClose);
      } catch {
        /* */
      }
      clearInterval(poller);
      clearTimeout(timer);
      resolve();
    };
    const onClose = () => finish();
    try {
      task.child?.once?.("close", onClose);
    } catch {
      /* */
    }
    const poller = setInterval(() => {
      const t = tasks.get(id);
      if (!t || t.status !== "running") finish();
    }, pollMs);
    poller.unref?.();
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });

  const final = tasks.get(id) || task;
  const waitedMs = Date.now() - started;
  const timedOut = final.status === "running";
  return { ok: true, task: final, timedOut, waitedMs };
}

export async function readTaskOutput(
  id: string,
  opts: { tail?: number; stream?: "stdout" | "stderr" | "both" } = {},
): Promise<string> {
  const task = tasks.get(id);
  if (!task) return `Unknown task_id: ${id}`;

  const stream = opts.stream || "both";
  // tail: undefined → 200; 0 → full captured output; positive → last N lines
  const tailRaw = opts.tail;
  const tail =
    typeof tailRaw === "number" && Number.isFinite(tailRaw) && tailRaw >= 0
      ? Math.floor(tailRaw)
      : 200;
  const parts: string[] = [
    `task_id: ${task.id}`,
    `status: ${task.status}`,
    `pid: ${task.pid ?? "n/a"}`,
    `exit_code: ${task.exitCode === null ? "n/a" : task.exitCode}`,
    `sandbox: ${task.backend}${task.sandboxed ? "" : " (unsandboxed)"}`,
    `command: ${task.command}`,
    `elapsed_ms: ${(task.endedAt || Date.now()) - task.startedAt}`,
  ];
  if (task.error) parts.push(`error: ${task.error}`);
  if (task.status !== "running") {
    parts.push(
      `note: task is ${task.status} — output below is final; start a new background bash if you need another run.`,
    );
  }

  const readTail = async (file: string, label: string) => {
    try {
      const st = await fsp.stat(file);
      let text: string;
      if (st.size > MAX_CAPTURE_BYTES) {
        const fh = await fsp.open(file, "r");
        try {
          const start = Math.max(0, st.size - MAX_CAPTURE_BYTES);
          const buf = Buffer.alloc(st.size - start);
          await fh.read(buf, 0, buf.length, start);
          text = buf.toString("utf8");
        } finally {
          await fh.close();
        }
        text = `[… earlier output truncated, file ${file} ${st.size} bytes …]\n` + text;
      } else {
        text = await fsp.readFile(file, "utf8");
      }
      const lines = text.split("\n");
      const slice =
        tail === 0 || lines.length <= tail ? lines : lines.slice(-tail);
      const head =
        tail === 0
          ? `\n--- ${label} (${lines.length} lines) ---`
          : `\n--- ${label} (last ${slice.length}/${lines.length} lines) ---`;
      parts.push(head, slice.join("\n") || "(empty)");
    } catch (err) {
      parts.push(`\n--- ${label} ---\n(error reading: ${(err as Error).message})`);
    }
  };

  if (stream === "stdout" || stream === "both") await readTail(task.stdoutPath, "stdout");
  if (stream === "stderr" || stream === "both") await readTail(task.stderrPath, "stderr");
  parts.push(
    `\nFull logs: ${task.stdoutPath}` +
      (stream !== "stdout" ? ` and ${task.stderrPath}` : ""),
  );
  return parts.join("\n");
}

export function killTask(id: string): string {
  const task = tasks.get(id);
  if (!task) return `Unknown task_id: ${id}`;
  if (task.status !== "running") {
    const cmd = task.command.replace(/\s+/g, " ").slice(0, 80);
    const cmdNote = cmd ? ` · ${cmd}${task.command.length > 80 ? "…" : ""}` : "";
    return (
      `Task ${id} is already ${task.status} (exit ${task.exitCode ?? "n/a"})${cmdNote}\n` +
      `Use get_task_output to read logs, or start a new bash { background: true } task.`
    );
  }
  try {
    task.child?.kill("SIGTERM");
    // unref: SIGKILL grace must not hold the event loop (delays CLI exit).
    setTimeout(() => {
      try {
        task.child?.kill("SIGKILL");
      } catch {
        /* */
      }
    }, 2000).unref?.();
  } catch (err) {
    return `Failed to kill ${id}: ${(err as Error).message}`;
  }
  task.status = "killed";
  task.endedAt = Date.now();
  publishBgActivity();
  return `Killed task ${id} (pid ${task.pid ?? "n/a"})`;
}

/**
 * Terminate all in-process background shell tasks (REPL exit / process teardown).
 * SIGTERM first; optional immediate SIGKILL for hard exit paths.
 * Returns how many running tasks were signalled.
 */
export function killAllRunningTasks(opts?: {
  /** When true, send SIGKILL immediately (no 2s grace). Default false. */
  force?: boolean;
}): number {
  let n = 0;
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    n += 1;
    try {
      if (opts?.force) {
        task.child?.kill("SIGKILL");
      } else {
        task.child?.kill("SIGTERM");
        const child = task.child;
        // unref: teardown-path SIGKILL grace must not delay process exit.
        setTimeout(() => {
          try {
            if (task.status === "running" || task.status === "killed") {
              child?.kill("SIGKILL");
            }
          } catch {
            /* */
          }
        }, 1500).unref?.();
      }
    } catch {
      /* */
    }
    task.status = "killed";
    task.endedAt = Date.now();
  }
  if (n > 0) publishBgActivity();
  return n;
}

/** Test helper */
export function _resetTasksForTests(): void {
  for (const t of tasks.values()) {
    try {
      t.child?.kill("SIGKILL");
    } catch {
      /* */
    }
  }
  tasks.clear();
  publishBgActivity();
}

let exitHookInstalled = false;

/**
 * Best-effort safety net: if the process dies without going through REPL/headless
 * teardown, still try to kill in-process background shells.
 * Idempotent; safe to call multiple times.
 */
export function installBackgroundTaskExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const run = () => {
    try {
      killAllRunningTasks({ force: true });
    } catch {
      /* */
    }
  };
  process.once("exit", run);
  process.once("beforeExit", run);
}
