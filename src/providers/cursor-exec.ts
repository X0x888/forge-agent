/**
 * Map Cursor AgentService native execs onto Forge tools.
 *
 * Cursor Grok is trained on Write/StrReplace/Shell/Read. Rejecting those
 * (even with a "call write_file" string) made it search_mcp for editors
 * then python Path.write_text — skipping receipts, the read-guard, and
 * the mutation journal. Forge still owns execution: native execs become
 * the same tool_calls the xAI path uses.
 */
import fs from "node:fs";
import path from "node:path";
import {
  encodeConnectFrame,
  encodeClientMessage,
  encodeDeleteError,
  encodeDeleteSuccess,
  encodeExecClient,
  encodeExecStreamClose,
  encodeGrepError,
  encodeGrepSuccess,
  encodeLsError,
  encodeLsSuccess,
  encodeMcpErrorResult,
  encodeMcpSuccessResult,
  encodePiExecError,
  encodePiOutputSuccess,
  encodeReadError,
  encodeReadSuccess,
  encodeShellStreamExit,
  encodeShellStreamStart,
  encodeShellStreamStderr,
  encodeShellStreamStdout,
  encodeWriteError,
  encodeWriteSuccess,
  parseGrepArgs,
  parseLsArgs,
  parsePathArg,
  parsePiEditArgs,
  parsePiGrepArgs,
  parsePiReadArgs,
  parsePiWriteArgs,
  parseReadArgs,
  parseShellArg,
  parseWriteArgs,
} from "./cursor-proto.js";
import { stripReadFileLinePrefixes } from "../agent/tools/edit-match.js";

export const CURSOR_CONTROL_EXEC = new Set([
  "requestContextArgs",
  "mcpStateExecArgs",
  "listMcpResourcesExecArgs",
  "readMcpResourceExecArgs",
]);

export type CursorResultKind =
  | "mcp"
  | "write"
  | "read"
  | "ls"
  | "grep"
  | "delete"
  | "shell_stream"
  | "pi";

export interface CursorPendingExec {
  id: number;
  execId: string;
  toolCallId: string;
  toolName: string;
  resultKind: CursorResultKind;
  resultField: number;
  path?: string;
  command?: string;
  workingDirectory?: string;
  pattern?: string;
  rangeApplied?: boolean;
}

export interface MappedNativeExec {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  resultKind: Exclude<CursorResultKind, "mcp">;
  resultField: number;
  path?: string;
  command?: string;
  workingDirectory?: string;
  pattern?: string;
  rangeApplied?: boolean;
}

const PI_RESULT_FIELD: Record<string, number> = {
  piReadArgs: 46,
  piBashArgs: 47,
  piEditArgs: 48,
  piWriteArgs: 49,
  piGrepArgs: 50,
  piFindArgs: 51,
  piLsArgs: 52,
};

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function mapCursorNativeExec(ev: {
  execKind: string;
  execId: string;
  payload: Uint8Array;
}): MappedNativeExec | null {
  const fallbackId = ev.execId || "";
  switch (ev.execKind) {
    case "writeArgs": {
      const w = parseWriteArgs(ev.payload);
      if (!w.path || w.binary || w.content === undefined) return null;
      return {
        toolName: "write_file",
        args: { path: w.path, content: w.content },
        toolCallId: w.toolCallId || fallbackId,
        resultKind: "write",
        resultField: 3,
        path: w.path,
      };
    }
    case "readArgs": {
      const r = parseReadArgs(ev.payload);
      if (!r.path) return null;
      const args: Record<string, unknown> = { path: r.path };
      if (r.offset) args.offset = r.offset;
      // Unbounded native read (edit handshake) must not inherit Forge's
      // 1000-line default — pass limit=0 (all remaining).
      args.limit = r.limit ?? 0;
      return {
        toolName: "read_file",
        args,
        toolCallId: r.toolCallId || fallbackId,
        resultKind: "read",
        resultField: 7,
        path: r.path,
        rangeApplied: Boolean(r.offset || r.limit),
      };
    }
    case "lsArgs": {
      const l = parseLsArgs(ev.payload);
      if (!l.path) return null;
      return {
        toolName: "list_dir",
        args: { path: l.path },
        toolCallId: l.toolCallId || fallbackId,
        resultKind: "ls",
        resultField: 8,
        path: l.path,
      };
    }
    case "grepArgs": {
      const g = parseGrepArgs(ev.payload);
      if (!g.pattern) {
        const pattern = g.glob || "**/*";
        return {
          toolName: "glob",
          args: {
            pattern,
            ...(g.path ? { path: g.path } : {}),
          },
          toolCallId: g.toolCallId || fallbackId,
          resultKind: "grep",
          resultField: 5,
          path: g.path,
          pattern,
        };
      }
      return {
        toolName: "grep",
        args: {
          pattern: g.pattern,
          ...(g.path ? { path: g.path } : {}),
          ...(g.glob ? { glob: g.glob } : {}),
        },
        toolCallId: g.toolCallId || fallbackId,
        resultKind: "grep",
        resultField: 5,
        path: g.path,
        pattern: g.pattern,
      };
    }
    case "deleteArgs": {
      const p = parsePathArg(ev.payload);
      if (!p) return null;
      return {
        toolName: "bash",
        args: { command: `rm -f -- ${shellQuote(p)}` },
        toolCallId: fallbackId,
        resultKind: "delete",
        resultField: 4,
        path: p,
      };
    }
    case "shellStreamArgs": {
      const s = parseShellArg(ev.payload);
      if (!s.command) return null;
      return {
        toolName: "bash",
        args: { command: s.command },
        toolCallId: fallbackId,
        resultKind: "shell_stream",
        resultField: 14,
        command: s.command,
        workingDirectory: s.workingDirectory,
      };
    }
    case "piWriteArgs": {
      const w = parsePiWriteArgs(ev.payload);
      if (!w.path) return null;
      return {
        toolName: "write_file",
        args: { path: w.path, content: w.content },
        toolCallId: fallbackId,
        resultKind: "pi",
        resultField: PI_RESULT_FIELD.piWriteArgs!,
        path: w.path,
      };
    }
    case "piEditArgs": {
      const e = parsePiEditArgs(ev.payload);
      if (!e.path || !e.oldString || e.newString === undefined) return null;
      return {
        toolName: "search_replace",
        args: {
          path: e.path,
          old_string: e.oldString,
          new_string: e.newString,
        },
        toolCallId: fallbackId,
        resultKind: "pi",
        resultField: PI_RESULT_FIELD.piEditArgs!,
        path: e.path,
      };
    }
    case "piReadArgs": {
      const r = parsePiReadArgs(ev.payload);
      if (!r.path) return null;
      return {
        toolName: "read_file",
        args: {
          path: r.path,
          ...(r.offset ? { offset: r.offset } : {}),
          limit: r.limit ?? 0,
        },
        toolCallId: fallbackId,
        resultKind: "pi",
        resultField: PI_RESULT_FIELD.piReadArgs!,
        path: r.path,
      };
    }
    case "piBashArgs": {
      const s = parseShellArg(ev.payload);
      if (!s.command) return null;
      return {
        toolName: "bash",
        args: { command: s.command },
        toolCallId: fallbackId,
        resultKind: "pi",
        resultField: PI_RESULT_FIELD.piBashArgs!,
        command: s.command,
      };
    }
    case "piGrepArgs": {
      const g = parsePiGrepArgs(ev.payload);
      if (!g.pattern) return null;
      return {
        toolName: "grep",
        args: {
          pattern: g.pattern,
          ...(g.path ? { path: g.path } : {}),
          ...(g.glob ? { glob: g.glob } : {}),
        },
        toolCallId: fallbackId,
        resultKind: "pi",
        resultField: PI_RESULT_FIELD.piGrepArgs!,
        path: g.path,
        pattern: g.pattern,
      };
    }
    case "piFindArgs": {
      const g = parsePiGrepArgs(ev.payload);
      const pattern = g.pattern || "**/*";
      return {
        toolName: "glob",
        args: {
          pattern,
          ...(g.path ? { path: g.path } : {}),
        },
        toolCallId: fallbackId,
        resultKind: "pi",
        resultField: PI_RESULT_FIELD.piFindArgs!,
        path: g.path,
        pattern,
      };
    }
    case "piLsArgs": {
      const l = parseLsArgs(ev.payload);
      if (!l.path) return null;
      return {
        toolName: "list_dir",
        args: { path: l.path },
        toolCallId: fallbackId,
        resultKind: "pi",
        resultField: PI_RESULT_FIELD.piLsArgs!,
        path: l.path,
      };
    }
    default:
      return null;
  }
}

export function toolOutputLooksError(content: string, toolName: string): boolean {
  const t = content.trim();
  if (/^[\w./-]+ error:/i.test(t)) return true;
  if (/^(error|failed):/i.test(t)) return true;
  if (/old_string not found/i.test(t)) return true;
  if (/refuses unread|file-read-guard/i.test(t)) return true;
  const exit = t.match(/\[exit code (\d+)\]\s*$/m);
  if (exit && exit[1] !== "0") return true;
  if (toolName === "bash" && /Command failed \(exit code [1-9]/i.test(t)) {
    return true;
  }
  return false;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function fileStats(workspace: string, rel: string | undefined): {
  lines: number;
  size: number;
} | undefined {
  if (!rel) return undefined;
  try {
    const abs = path.resolve(workspace, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) return { lines: 0, size: st.size };
    const buf = fs.readFileSync(abs);
    const n = buf.length === 0 ? 0 : countLines(buf.toString("utf8"));
    return { lines: n, size: st.size };
  } catch {
    return undefined;
  }
}

/** Strip Forge `N|` envelopes so Cursor cannot echo them into a later write. */
export function rawFileTextFromToolOutput(output: string): {
  content: string;
  truncated: boolean;
} {
  let body = output;
  const header = body.match(/^File: [^\n]+\n/);
  if (header) body = body.slice(header[0].length);
  const stripped = stripReadFileLinePrefixes(body);
  const truncated =
    /use offset=\d+ for more|collect cap hit|\[truncated|Output truncated|tool-output\//i.test(
      output,
    );
  return { content: stripped.text, truncated };
}

function pathishLines(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("File:") || t.startsWith("[")) continue;
    const m = t.match(/^(\S+?)(?:\s|$|:)/);
    const p = m?.[1] ?? t;
    if (!p.includes("/") && !/\.\w{1,8}$/.test(p)) continue;
    if (p.length > 512) continue;
    out.push(p);
    if (out.length >= 80) break;
  }
  return out;
}

function parseExitCode(output: string, isError: boolean): number {
  const m = output.match(/\[exit code (\d+)\]/);
  if (m) return Number(m[1]);
  return isError ? 1 : 0;
}

function writeExec(
  write: (data: Uint8Array) => void,
  opts: { id: number; execId: string; resultField: number; result: Uint8Array },
): void {
  write(
    encodeConnectFrame(
      encodeClientMessage({
        execClient: encodeExecClient(opts),
      }),
    ),
  );
}

function writeClose(write: (data: Uint8Array) => void, id: number): void {
  write(
    encodeConnectFrame(
      encodeClientMessage({ execControl: encodeExecStreamClose(id) }),
    ),
  );
}

/**
 * Reply to a pending exec with the Forge tool output, then stream_close.
 */
export function writeCursorToolResult(
  write: (data: Uint8Array) => void,
  exec: CursorPendingExec,
  content: string | undefined,
  workspace: string,
): void {
  const missing = content === undefined;
  const text = content ?? "Tool result not provided";
  const isError = missing || toolOutputLooksError(text, exec.toolName);

  if (exec.resultKind === "mcp") {
    writeExec(write, {
      id: exec.id,
      execId: exec.execId,
      resultField: exec.resultField || 11,
      result: missing
        ? encodeMcpErrorResult(text)
        : encodeMcpSuccessResult(text, isError),
    });
    writeClose(write, exec.id);
    return;
  }

  if (exec.resultKind === "shell_stream") {
    writeExec(write, {
      id: exec.id,
      execId: exec.execId,
      resultField: 14,
      result: encodeShellStreamStart(),
    });
    if (isError) {
      writeExec(write, {
        id: exec.id,
        execId: exec.execId,
        resultField: 14,
        result: encodeShellStreamStderr(text.slice(0, 32_000)),
      });
    } else if (text) {
      writeExec(write, {
        id: exec.id,
        execId: exec.execId,
        resultField: 14,
        result: encodeShellStreamStdout(text.slice(0, 32_000)),
      });
    }
    writeExec(write, {
      id: exec.id,
      execId: exec.execId,
      resultField: 14,
      result: encodeShellStreamExit(parseExitCode(text, isError)),
    });
    writeClose(write, exec.id);
    return;
  }

  const result = encodeTypedNativeResult(exec, text, isError, workspace);
  writeExec(write, {
    id: exec.id,
    execId: exec.execId,
    resultField: exec.resultField,
    result,
  });
  writeClose(write, exec.id);
}

function encodeTypedNativeResult(
  exec: CursorPendingExec,
  text: string,
  isError: boolean,
  workspace: string,
): Buffer {
  const filePath = exec.path || "";
  if (exec.resultKind === "write") {
    if (isError) return encodeWriteError(filePath, text.slice(0, 4000));
    const st = fileStats(workspace, filePath);
    return encodeWriteSuccess({
      path: filePath,
      linesCreated: st?.lines ?? countLines(text),
      fileSize: st?.size ?? Buffer.byteLength(text),
    });
  }
  if (exec.resultKind === "read") {
    if (isError) return encodeReadError(filePath, text.slice(0, 4000));
    const raw = rawFileTextFromToolOutput(text);
    const st = fileStats(workspace, filePath);
    return encodeReadSuccess({
      path: filePath,
      content: raw.content,
      totalLines: st?.lines ?? countLines(raw.content),
      fileSize: st?.size ?? Buffer.byteLength(raw.content),
      truncated: raw.truncated,
      rangeApplied: Boolean(exec.rangeApplied),
    });
  }
  if (exec.resultKind === "ls") {
    if (isError) return encodeLsError(filePath, text.slice(0, 4000));
    const files = pathishLines(text).map((p) =>
      p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p,
    );
    const abs = filePath
      ? path.resolve(workspace, filePath)
      : path.resolve(workspace);
    return encodeLsSuccess({ absPath: abs, files });
  }
  if (exec.resultKind === "grep") {
    if (isError) return encodeGrepError(text.slice(0, 4000));
    return encodeGrepSuccess({
      pattern: exec.pattern || "",
      path: filePath || workspace,
      files: pathishLines(text),
    });
  }
  if (exec.resultKind === "delete") {
    if (isError) return encodeDeleteError(filePath, text.slice(0, 4000));
    return encodeDeleteSuccess(filePath);
  }
  // pi + background spawn
  if (isError) return encodePiExecError(text.slice(0, 4000));
  return encodePiOutputSuccess(text.slice(0, 32_000));
}
