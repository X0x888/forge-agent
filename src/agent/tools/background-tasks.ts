/**
 * Background shell tasks (Grok/OpenCode simplified).
 * In-process registry: start → get_task_output → kill_task.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forgeHome, ensureDirAsync } from "../../util/fs.js";
import { createShellEnv } from "./env-policy.js";
import type {
  SandboxMissingBackend,
  SandboxNetwork,
  SandboxProfile,
} from "../../config/types.js";
import { defaultNetworkForProfile } from "../../config/types.js";
import { detectSandboxBackend } from "../sandbox.js";

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
      const writePaths =
        o.profile === "read-only"
          ? [o.forge, o.tmp, "/private/tmp", "/var/tmp", "/private/var/tmp"]
          : [
              o.cwd,
              o.forge,
              o.tmp,
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

export async function startBackgroundTask(opts: {
  command: string;
  cwd: string;
  profile: SandboxProfile;
  network?: SandboxNetwork;
  missingBackend?: SandboxMissingBackend;
  timeoutMs?: number;
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

  const timeoutMs = opts.timeoutMs ?? 30 * 60_000; // 30m default for background
  const timer = setTimeout(() => {
    if (task.status === "running") {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* */
          }
        }, 3000);
      } catch {
        /* */
      }
      task.status = "timeout";
      task.endedAt = Date.now();
      task.error = `Timed out after ${timeoutMs}ms`;
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
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    spawnPlan.cleanup?.();
    task.status = "failed";
    task.error = err.message;
    task.endedAt = Date.now();
    task.child = undefined;
  });

  return { ok: true, task };
}

export function getTask(id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

export function listTasks(): BackgroundTask[] {
  return [...tasks.values()];
}

export async function readTaskOutput(
  id: string,
  opts: { tail?: number; stream?: "stdout" | "stderr" | "both" } = {},
): Promise<string> {
  const task = tasks.get(id);
  if (!task) return `Unknown task_id: ${id}`;

  const stream = opts.stream || "both";
  const tail = opts.tail ?? 200;
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
      const slice = lines.length > tail ? lines.slice(-tail) : lines;
      parts.push(
        `\n--- ${label} (last ${slice.length}/${lines.length} lines) ---`,
        slice.join("\n") || "(empty)",
      );
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
    return `Task ${id} is already ${task.status} (exit ${task.exitCode ?? "n/a"})`;
  }
  try {
    task.child?.kill("SIGTERM");
    setTimeout(() => {
      try {
        task.child?.kill("SIGKILL");
      } catch {
        /* */
      }
    }, 2000);
  } catch (err) {
    return `Failed to kill ${id}: ${(err as Error).message}`;
  }
  task.status = "killed";
  task.endedAt = Date.now();
  return `Killed task ${id} (pid ${task.pid ?? "n/a"})`;
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
}
