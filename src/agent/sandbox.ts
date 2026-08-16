/**
 * OS-level sandbox for bash child processes.
 *
 * Profiles (inspired by Grok Build):
 *   off       — no confinement
 *   workspace — write: CWD + ~/.forge + temp; read: everywhere; network: yes
 *   read-only — write: ~/.forge + temp only; network: blocked
 *   strict    — write: CWD + ~/.forge + temp; network: blocked
 *
 * macOS: sandbox-exec (Seatbelt)
 * Linux: bwrap (bubblewrap) when available
 * Windows: not supported
 *
 * missingBackend (default fail-closed):
 *   fail-closed — do not run unsandboxed; return error
 *   fallback    — warn + run unsandboxed (legacy)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgeHome } from "../util/fs.js";
import type {
  SandboxMissingBackend,
  SandboxNetwork,
  SandboxProfile,
} from "../config/types.js";
import { defaultNetworkForProfile } from "../config/types.js";
import { logSandboxEvent } from "./sandbox-log.js";

export interface SandboxRunOpts {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  profile: SandboxProfile;
  /** Override profile network default */
  network?: SandboxNetwork;
  missingBackend?: SandboxMissingBackend;
  /** Cancel in-flight child (Ctrl+C / turn abort) */
  signal?: AbortSignal;
  /** Last nonempty output line (throttled) for live ›. */
  onChunk?: (lastLine: string) => void;
}

/** Last nonempty line of a stdout/stderr chunk, stripped of ANSI, capped. */
export function extractLastNonemptyLine(chunk: string, max = 48): string {
  const lines = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (t) return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }
  return "";
}

export const BASH_PROGRESS_THROTTLE_MS = 200;

type ChunkEmitter = ((text: string) => void) & { flush: () => void };

function createChunkEmitter(onChunk?: (lastLine: string) => void): ChunkEmitter {
  if (!onChunk) {
    const noop = (() => {}) as unknown as ChunkEmitter;
    noop.flush = () => {};
    return noop;
  }
  let last = 0;
  let pending = "";
  const emit = ((text: string) => {
    const line = extractLastNonemptyLine(text);
    if (!line) return;
    pending = line;
    const now = Date.now();
    if (now - last < BASH_PROGRESS_THROTTLE_MS) return;
    last = now;
    try {
      onChunk(line);
    } catch {
      /* never break the child */
    }
  }) as ChunkEmitter;
  emit.flush = () => {
    if (!pending) return;
    try {
      onChunk(pending);
    } catch {
      /* */
    }
    pending = "";
  };
  return emit;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  sandboxed: boolean;
  backend: string;
  warning?: string;
  /** True when sandbox was required but unavailable and fail-closed refused run */
  failClosed?: boolean;
  network?: SandboxNetwork;
}

function which(bin: string): string | null {
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const p of paths) {
    const full = path.join(p, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* */
    }
  }
  return null;
}

export function detectSandboxBackend(): {
  platform: string;
  backend: "sandbox-exec" | "bwrap" | "none";
  available: boolean;
  path: string | null;
} {
  const platform = process.platform;
  if (platform === "darwin") {
    const p = which("sandbox-exec");
    return {
      platform,
      backend: p ? "sandbox-exec" : "none",
      available: Boolean(p),
      path: p,
    };
  }
  if (platform === "linux") {
    const p = which("bwrap");
    return {
      platform,
      backend: p ? "bwrap" : "none",
      available: Boolean(p),
      path: p,
    };
  }
  return { platform, backend: "none", available: false, path: null };
}

export function profileRestrictsNetwork(
  profile: SandboxProfile,
  override?: SandboxNetwork,
): boolean {
  const net = override ?? defaultNetworkForProfile(profile);
  return net === "blocked";
}

/**
 * Canonicalize a path for Seatbelt subpath rules. Seatbelt resolves symlinks
 * before matching — on macOS /var is a symlink to /private/var, so emitting
 * os.tmpdir() (/var/folders/…) uncanonicalized silently denies $TMPDIR writes.
 * Keeps the original path when realpath fails.
 */
export function canonicalSandboxPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function seatbeltProfile(opts: {
  profile: SandboxProfile;
  cwd: string;
  forge: string;
  tmp: string;
  restrictNetwork: boolean;
}): string {
  const cwd = opts.cwd;
  const forge = opts.forge;
  const tmp = canonicalSandboxPath(opts.tmp);
  const privateTmp = "/private/tmp";
  const varTmp = "/var/tmp";
  const privateVarTmp = "/private/var/tmp";

  const writePaths =
    opts.profile === "read-only"
      ? [forge, tmp, privateTmp, varTmp, privateVarTmp]
      : [cwd, forge, tmp, privateTmp, varTmp, privateVarTmp];

  const writeAllow = writePaths
    .map((p) => `  (subpath ${JSON.stringify(p)})`)
    .join("\n");

  const networkClause = opts.restrictNetwork
    ? `(deny network*)\n(deny network-outbound)\n(deny network-inbound)`
    : `(allow network*)`;

  return `
(version 1)
(debug deny)
(allow default)
(deny file-write*)
(deny file-write-mode)
(deny file-write-owner)
(deny file-write-setugid)
(allow file-write-data
${writeAllow}
  (literal "/dev/null")
  (literal "/dev/dtracehelper")
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
(allow mach-priv-host-port)
${networkClause}
`.trim();
}

function runRaw(
  file: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onChunk?: (lastLine: string) => void;
  },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ stdout: "", stderr: "Aborted", code: 130 });
      return;
    }
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    // Mirror the execAsync fallback's maxBuffer (4MB): a runaway `yes` or a
    // log-spewing build must not OOM the CLI before the wall-clock timeout.
    const OUTPUT_CAP = 4 * 1024 * 1024;
    let outputCapped = false;
    const emit = createChunkEmitter(opts.onChunk);
    const finish = (result: {
      stdout: string;
      stderr: string;
      code: number | null;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      emit.flush();
      resolve(result);
    };
    const killChild = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* */
      }
      // unref like grep.ts: a settled run must not hold the event loop for the
      // SIGKILL grace window (delays CLI exit up to 2s).
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* */
        }
      }, 2000).unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, opts.timeoutMs);
    const onAbort = () => {
      stderr = (stderr ? stderr + "\n" : "") + "Aborted";
      killChild();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => {
      if (outputCapped) return;
      const text = d.toString();
      stdout += text;
      emit(text);
      if (stdout.length > OUTPUT_CAP) {
        stdout = stdout.slice(0, OUTPUT_CAP);
        outputCapped = true;
        killChild();
      }
    });
    child.stderr?.on("data", (d) => {
      if (outputCapped) return;
      const text = d.toString();
      stderr += text;
      emit(text);
      if (stderr.length > OUTPUT_CAP) {
        stderr = stderr.slice(0, OUTPUT_CAP);
        outputCapped = true;
        killChild();
      }
    });
    child.on("error", (err) => {
      finish({
        stdout,
        stderr: stderr + "\n" + err.message,
        code: opts.signal?.aborted ? 130 : timedOut ? 124 : 1,
      });
    });
    child.on("close", (code) => {
      if (opts.signal?.aborted) {
        finish({ stdout, stderr, code: 130 });
        return;
      }
      if (outputCapped) {
        const note = `Output exceeded ${OUTPUT_CAP} bytes — killed (re-run with a narrower command or redirect to a file)`;
        finish({
          stdout,
          stderr: stderr ? `${stderr}\n${note}` : note,
          code: code ?? 1,
        });
        return;
      }
      if (timedOut) {
        const note = `Command timed out after ${opts.timeoutMs}ms`;
        finish({
          stdout,
          stderr: stderr ? `${stderr}\n${note}` : note,
          // 124 matches common timeout(1) / FORGE_MAX_RUN_MS convention
          code: 124,
        });
        return;
      }
      finish({
        stdout,
        stderr,
        code,
      });
    });
  });
}

function missingBackendMessage(platform: string): string {
  if (platform === "darwin") {
    return "sandbox-exec not found. Install Xcode Command Line Tools, or set sandbox=off / sandbox_missing_backend=fallback.";
  }
  if (platform === "linux") {
    return "bwrap (bubblewrap) not found. Install bubblewrap, or set sandbox=off / sandbox_missing_backend=fallback.";
  }
  return `Sandbox not supported on ${platform}. Use WSL/Linux/macOS, or set sandbox=off.`;
}

/** Run a shell command, optionally sandboxed. */
export async function runSandboxed(opts: SandboxRunOpts): Promise<SandboxRunResult> {
  const profile = opts.profile || "off";
  const network = opts.network ?? defaultNetworkForProfile(profile);
  const restrictNetwork = network === "blocked";
  const shell = process.env.SHELL || "/bin/bash";
  const shellArgs = ["-c", opts.command];

  if (profile === "off") {
    const r = await runRaw(shell, shellArgs, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      signal: opts.signal,
      onChunk: opts.onChunk,
    });
    return {
      ...r,
      sandboxed: false,
      backend: "none",
      network,
    };
  }

  const platform = process.platform;
  const forge = forgeHome();
  const tmp = os.tmpdir();
  const detected = detectSandboxBackend();

  // --- macOS Seatbelt ---
  if (platform === "darwin") {
    const sb = detected.path;
    if (sb) {
      const profileText = seatbeltProfile({
        profile,
        cwd: path.resolve(opts.cwd),
        forge: path.resolve(forge),
        tmp: path.resolve(tmp),
        restrictNetwork,
      });
      const profPath = path.join(
        tmp,
        `forge-sbx-${process.pid}-${Date.now()}.sb`,
      );
      try {
        fs.writeFileSync(profPath, profileText, { mode: 0o600 });
        const r = await runRaw(sb, ["-f", profPath, shell, ...shellArgs], {
          cwd: opts.cwd,
          timeoutMs: opts.timeoutMs,
          env: opts.env,
          signal: opts.signal,
          onChunk: opts.onChunk,
        });
        return {
          ...r,
          sandboxed: true,
          backend: "sandbox-exec",
          network,
        };
      } finally {
        try {
          fs.unlinkSync(profPath);
        } catch {
          /* */
        }
      }
    }
    return {
      stdout: "",
      stderr: "",
      code: 1,
      sandboxed: false,
      backend: "none",
      network,
      warning: missingBackendMessage("darwin"),
    };
  }

  // --- Linux: bubblewrap ---
  if (platform === "linux") {
    const bwrap = detected.path;
    if (bwrap) {
      const cwd = path.resolve(opts.cwd);
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
      if (restrictNetwork) {
        args.push("--unshare-net");
      }
      args.push("--chdir", cwd);
      args.push("--", shell, ...shellArgs);
      const r = await runRaw(bwrap, args, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        signal: opts.signal,
        onChunk: opts.onChunk,
      });
      return { ...r, sandboxed: true, backend: "bwrap", network };
    }
    return {
      stdout: "",
      stderr: "",
      code: 1,
      sandboxed: false,
      backend: "none",
      network,
      warning: missingBackendMessage("linux"),
    };
  }

  return {
    stdout: "",
    stderr: "",
    code: 1,
    sandboxed: false,
    backend: "none",
    network,
    warning: missingBackendMessage(platform),
  };
}

/**
 * Execute command with sandbox when profile != off.
 * Default fail-closed when backend missing.
 */
export async function execCommandSandboxed(
  opts: SandboxRunOpts,
): Promise<SandboxRunResult> {
  const missingBackend = opts.missingBackend ?? "fail-closed";
  const network = opts.network ?? defaultNetworkForProfile(opts.profile);

  if (opts.profile === "off") {
    const r = await runRaw(process.env.SHELL || "/bin/bash", ["-c", opts.command], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      signal: opts.signal,
      onChunk: opts.onChunk,
    });
    return { ...r, sandboxed: false, backend: "none", network };
  }

  const result = await runSandboxed({ ...opts, network });
  if (result.sandboxed) {
    return result;
  }

  // Backend missing
  if (missingBackend === "fail-closed") {
    const msg =
      result.warning ||
      "Sandbox backend unavailable; refusing to run unsandboxed (fail-closed). " +
      "Install/enable sandbox-exec (macOS) or bubblewrap, or set FORGE_SANDBOX_MISSING_BACKEND=fallback only if you accept unsandboxed bash.";
    logSandboxEvent({
      type: "fail_closed",
      profile: opts.profile,
      reason: msg,
      command: opts.command,
      network,
    });
    return {
      stdout: "",
      stderr: `[forge sandbox] FAIL-CLOSED: ${msg}`,
      code: 1,
      sandboxed: false,
      backend: "none",
      warning: msg,
      failClosed: true,
      network,
    };
  }

  // legacy fallback
  logSandboxEvent({
    type: "fallback",
    profile: opts.profile,
    reason: result.warning || "unsandboxed fallback",
    command: opts.command,
    network,
  });
  const r = await runRaw(process.env.SHELL || "/bin/bash", ["-c", opts.command], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    env: opts.env,
    signal: opts.signal,
  });
  return {
    ...r,
    sandboxed: false,
    backend: "none",
    warning: result.warning,
    network,
    stderr:
      (result.warning ? `[forge sandbox] ${result.warning}\n` : "") + (r.stderr || ""),
  };
}

export function describeSandbox(
  profile: SandboxProfile,
  network?: SandboxNetwork,
): string {
  const net = network ?? defaultNetworkForProfile(profile);
  const netLabel = net === "blocked" ? "network blocked" : "network open";
  switch (profile) {
    case "off":
      return `off (no OS confinement; ${netLabel})`;
    case "workspace":
      return `workspace (write: CWD + ~/.forge + temp; ${netLabel})`;
    case "read-only":
      return `read-only (write: ~/.forge + temp only; ${netLabel})`;
    case "strict":
      return `strict (write: CWD + ~/.forge + temp; ${netLabel})`;
    default:
      return String(profile);
  }
}
