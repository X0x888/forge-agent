import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { boundToolOutput } from "./truncate.js";

function findRg(): string | null {
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const p of paths) {
    for (const name of process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"]) {
      const full = path.join(p, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* */
      }
    }
  }
  return null;
}


async function assertSearchRoot(
  searchPath: string,
  label: string,
  workspace: string,
): Promise<ToolResult | null> {
  try {
    const st = await fsp.stat(searchPath);
    if (!st.isDirectory() && !st.isFile()) {
      return { output: `grep path is not a file or directory: ${label}`, isError: true };
    }
    return null;
  } catch {
    const hint = await pathNotFoundHint(searchPath, workspace);
    return {
      output: `Path not found for grep: ${label}\n${hint}`,
      isError: true,
    };
  }
}

function runRg(
  rg: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(rg, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: err.message, code: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

async function toolGrepJs(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = String(args.pattern || "");
  const searchPath = args.path
    ? resolvePath(ctx.workspace, String(args.path))
    : ctx.workspace;
  const pathLabel = args.path ? String(args.path) : ".";
  const badRoot = await assertSearchRoot(searchPath, pathLabel, ctx.workspace);
  if (badRoot) return badRoot;
  const globPat = args.glob ? String(args.glob) : "**/*";
  const headLimit = Number(args.head_limit) || 50;
  const flags = args.case_insensitive ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return { output: `Invalid regex: ${pattern}`, isError: true };
  }

  // Single-file path: search that file only (glob cwd=file is invalid).
  let files: string[];
  const st = await fsp.stat(searchPath);
  if (st.isFile()) {
    files = [searchPath];
  } else {
    files = await glob(globPat, {
      cwd: searchPath,
      nodir: true,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      dot: false,
    });
  }

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= headLimit) break;
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const rel = path.relative(ctx.workspace, file);
        matches.push(`${rel}:${i + 1}:${lines[i]}`);
        if (matches.length >= headLimit) break;
      }
    }
  }
  const body = matches.length
    ? `[grep:js-fallback] ${matches.join("\n")}`
    : "No matches found";
  const managed = await boundToolOutput(body);
  return { output: managed.text };
}

export async function toolGrep(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = String(args.pattern || "");
  if (!pattern) return { output: "pattern is required", isError: true };

  const rg = findRg();
  if (!rg) {
    return toolGrepJs(args, ctx);
  }

  const searchPath = args.path
    ? resolvePath(ctx.workspace, String(args.path))
    : ctx.workspace;
  const pathLabel = args.path ? String(args.path) : ".";
  const badRoot = await assertSearchRoot(searchPath, pathLabel, ctx.workspace);
  if (badRoot) return badRoot;
  const headLimit = Number(args.head_limit) || 50;
  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(headLimit),
  ];
  if (args.case_insensitive) rgArgs.push("-i");
  if (args.glob) {
    rgArgs.push("--glob", String(args.glob));
  }
  rgArgs.push("--glob", "!**/node_modules/**", "--glob", "!**/.git/**", "--glob", "!**/dist/**");
  rgArgs.push("--", pattern, searchPath);

  const result = await runRg(rg, rgArgs, ctx.workspace);
  // rg exit 1 = no matches
  if (result.code === 1 || (!result.stdout.trim() && !result.stderr.trim())) {
    return { output: "No matches found" };
  }
  if (result.code !== 0 && result.code !== 1) {
    // fall back if rg failed for other reasons
    if (result.stderr) {
      const fb = await toolGrepJs(args, ctx);
      return {
        output: `[rg error: ${result.stderr.trim()}]\n${fb.output}`,
        isError: fb.isError,
      };
    }
  }

  // Rewrite absolute paths to workspace-relative when possible
  const lines = result.stdout
    .split("\n")
    .filter(Boolean)
    .slice(0, headLimit)
    .map((line) => {
      if (line.startsWith(ctx.workspace + path.sep)) {
        return path.relative(ctx.workspace, line.split(":")[0]) + line.slice(line.indexOf(":"));
      }
      // searchPath may be absolute prefix
      try {
        const colon = line.indexOf(":");
        if (colon > 0) {
          const fp = line.slice(0, colon);
          if (path.isAbsolute(fp)) {
            return path.relative(ctx.workspace, fp) + line.slice(colon);
          }
        }
      } catch {
        /* */
      }
      return line;
    });

  const managed = await boundToolOutput(lines.join("\n") || "No matches found");
  return { output: managed.text };
}
