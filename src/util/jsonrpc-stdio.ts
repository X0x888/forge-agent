/**
 * Content-Length framed JSON-RPC 2.0 over child-process stdio.
 * Used by MCP (stdio transport) and LSP language servers.
 *
 * Production notes:
 * - Partial headers/bodies buffered until complete
 * - Concurrent request id map with per-call timeouts
 * - Process death fails pending requests (never hang forever)
 * - Output caps so a runaway server cannot OOM the agent
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { log } from "./log.js";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface JsonRpcStdioOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Soft cap on accumulated unread stdout (bytes). Default 8 MiB. */
  maxBufferBytes?: number;
  /** Label for logs (e.g. mcp:github, lsp:typescript). */
  label?: string;
  /** Called for notifications (no id) and server-initiated requests. */
  onNotification?: (method: string, params: unknown) => void;
  /** Called for server→client requests that need a response. Return result or throw. */
  onServerRequest?: (
    method: string,
    params: unknown,
    id: JsonRpcId,
  ) => Promise<unknown> | unknown;
  /** Abort whole transport (kills child). */
  signal?: AbortSignal;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const HEADER_MAX = 8 * 1024;

export class JsonRpcStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<string | number, Pending>();
  private closed = false;
  private closeError: Error | null = null;
  private readonly maxBuffer: number;
  private readonly label: string;
  private readonly opts: JsonRpcStdioOptions;
  private stderrTail = "";

  constructor(opts: JsonRpcStdioOptions) {
    this.opts = opts;
    this.maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
    this.label = opts.label || "jsonrpc";
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get alive(): boolean {
    return Boolean(this.child && !this.closed && this.child.exitCode == null);
  }

  get lastStderr(): string {
    return this.stderrTail;
  }

  start(): void {
    if (this.child) return;
    const { command, args = [], env, cwd, signal } = this.opts;
    try {
      this.child = spawn(command, args, {
        cwd,
        env: createChildEnv(env, { keepSecrets: true }),
        stdio: ["pipe", "pipe", "pipe"],
        // Detached so timeout kills can target the process group on Unix.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      this.closed = true;
      this.closeError = err as Error;
      throw err;
    }

    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + s).slice(-4000);
    });
    this.child.on("error", (err) => {
      this.failAll(err);
    });
    this.child.on("exit", (code, sig) => {
      const err = new Error(
        `${this.label} exited (code=${code ?? "null"} signal=${sig ?? "null"})` +
          (this.stderrTail
            ? `\nstderr: ${this.stderrTail.slice(-500)}`
            : ""),
      );
      this.failAll(err);
    });

    if (signal) {
      if (signal.aborted) {
        void this.dispose();
      } else {
        signal.addEventListener("abort", () => void this.dispose(), {
          once: true,
        });
      }
    }
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.closed) {
      throw this.closeError || new Error(`${this.label} is closed`);
    }
    if (!this.child) this.start();
    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.label} request timed out after ${timeoutMs}ms: ${method}`,
          ),
        );
      }, timeoutMs);
      // Don't keep the process alive solely for pending RPC.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child) return;
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`${this.label} disposed`));
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode != null) return;
    try {
      // Graceful: try to close stdin so servers that exit on EOF can wind down.
      child.stdin.end();
    } catch {
      /* */
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      const t = setTimeout(() => {
        try {
          if (process.platform !== "win32" && child.pid) {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              child.kill("SIGTERM");
            }
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          /* */
        }
        const t2 = setTimeout(() => {
          try {
            if (process.platform !== "win32" && child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            } else {
              child.kill("SIGKILL");
            }
          } catch {
            /* */
          }
          resolve();
        }, 800);
        t2.unref?.();
      }, 1500);
      t.unref?.();
    });
  }

  private write(msg: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) {
      throw new Error(`${this.label}: stdin not writable`);
    }
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const header = Buffer.from(
      `Content-Length: ${body.length}\r\n\r\n`,
      "utf8",
    );
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.maxBuffer) {
      const err = new Error(
        `${this.label}: stdout buffer exceeded ${this.maxBuffer} bytes — killing`,
      );
      log.warn(err.message);
      void this.dispose();
      this.failAll(err);
      return;
    }
    // Parse as many full messages as available
    for (;;) {
      const parsed = this.tryParseOne();
      if (!parsed) break;
      void this.dispatch(parsed);
    }
  }

  private tryParseOne(): JsonRpcMessage | null {
    // Content-Length framing
    const headerEnd = indexOfHeaderEnd(this.buf);
    if (headerEnd === -1) {
      // Newline-delimited JSON fallback (some MCP servers)
      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) {
        if (this.buf.length > HEADER_MAX) {
          // Drop garbage line if no framing
          this.buf = Buffer.alloc(0);
        }
        return null;
      }
      const line = this.buf.subarray(0, nl).toString("utf8").trim();
      this.buf = this.buf.subarray(nl + 1);
      if (!line || line.startsWith("Content-Length")) return null;
      try {
        return JSON.parse(line) as JsonRpcMessage;
      } catch {
        return null;
      }
    }
    if (headerEnd > HEADER_MAX) {
      this.buf = this.buf.subarray(headerEnd);
      return null;
    }
    const headerText = this.buf.subarray(0, headerEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!m) {
      this.buf = this.buf.subarray(headerEnd);
      return null;
    }
    const len = Number(m[1]);
    if (!Number.isFinite(len) || len < 0 || len > this.maxBuffer) {
      this.buf = this.buf.subarray(headerEnd);
      return null;
    }
    // headerEnd points at start of body (after \r\n\r\n or \n\n)
    const bodyStart = headerEnd;
    if (this.buf.length < bodyStart + len) return null;
    const body = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
    this.buf = this.buf.subarray(bodyStart + len);
    try {
      return JSON.parse(body) as JsonRpcMessage;
    } catch {
      return null;
    }
  }

  private async dispatch(msg: JsonRpcMessage): Promise<void> {
    if ("id" in msg && msg.id != null && ("result" in msg || "error" in msg)) {
      const pending = this.pending.get(msg.id as string | number);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id as string | number);
      if (msg.error) {
        pending.reject(
          new Error(
            `${this.label} RPC error ${msg.error.code}: ${msg.error.message}`,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server request (has id + method) or notification (method only)
    if ("method" in msg && typeof msg.method === "string") {
      const method = msg.method;
      const params = "params" in msg ? msg.params : undefined;
      if ("id" in msg && msg.id != null && this.opts.onServerRequest) {
        try {
          const result = await this.opts.onServerRequest(
            method,
            params,
            msg.id,
          );
          this.write({
            jsonrpc: "2.0",
            id: msg.id,
            result: result ?? null,
          });
        } catch (err) {
          this.write({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return;
      }
      this.opts.onNotification?.(method, params);
    }
  }

  private failAll(err: Error): void {
    this.closed = true;
    this.closeError = err;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** Index of first byte after the header terminator (\r\n\r\n or \n\n). */
function indexOfHeaderEnd(buf: Buffer): number {
  for (let i = 0; i < buf.length - 3; i++) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i + 4;
    }
  }
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) {
      return i + 2;
    }
  }
  return -1;
}
