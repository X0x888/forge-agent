/**
 * Native-app look: window/sim screenshot, HID click, Godot --write-movie.
 * TCC -10004 / LS 115 / EPERM become a limited receipt, not a 25-turn retry.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sessionLooksDir } from "../../util/git-auto-commit.js";
import {
  classifyLookLimit,
  lookLimitReceipt,
} from "../../util/look-infra.js";
import type { ToolContext, ToolResult } from "./types.js";

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT",
  );
}

function execErrText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const stderr =
    err && typeof err === "object" && "stderr" in err
      ? String((err as { stderr?: Buffer | string }).stderr ?? "")
      : "";
  return `${msg}\n${stderr}`;
}

function limitedFrom(err: unknown, fallback?: "tcc" | "ls115" | "eperm" | "display"): ToolResult {
  const text = execErrText(err);
  const kind = classifyLookLimit(text) ?? fallback;
  if (!kind) {
    return {
      output: `look_native error: ${text.slice(0, 200).trim() || "command failed"}`,
      isError: true,
    };
  }
  return { output: lookLimitReceipt(kind, text.slice(0, 200)), isError: false };
}

function numArg(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function looksDest(sessionId: string, destRel: string, ext: string): string {
  const dir = sessionLooksDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const destName = path.basename(destRel).replace(/[^\w.-]+/g, "_") || `look${ext}`;
  return path.join(dir, destName.endsWith(ext) ? destName : `${destName}${ext}`);
}

function needSession(ctx: ToolContext): { ok: true; id: string } | { ok: false; result: ToolResult } {
  const id = ctx.sessionId || ctx.session?.meta?.id;
  if (!id) {
    return {
      ok: false,
      result: {
        output: "look_native error: no session id — cannot write the look PNG.",
        isError: true,
      },
    };
  }
  return { ok: true, id };
}

function needDarwin(): ToolResult | null {
  if (process.platform === "darwin") return null;
  return {
    output:
      "look_native: this host is not macOS. Use call_mcp playwright on web, or the product CLI.",
    isError: true,
  };
}

function hidClick(x: number, y: number): ToolResult {
  const xi = Math.round(x);
  const yi = Math.round(y);
  try {
    execFileSync("cliclick", [`c:${xi},${yi}`], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      output: `look_native click: cliclick HID tap at ${xi},${yi}. Screenshot to confirm.`,
    };
  } catch (err) {
    if (!isNotFound(err)) return limitedFrom(err);
  }
  try {
    execFileSync(
      "osascript",
      ["-e", `tell application "System Events" to click at {${xi}, ${yi}}`],
      { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return {
      output: `look_native click: System Events HID tap at ${xi},${yi}. Do not retry osascript if this is limited.`,
    };
  } catch (err) {
    return limitedFrom(err);
  }
}

function simScreenshot(dest: string, device: string): ToolResult {
  try {
    execFileSync("xcrun", ["simctl", "io", device, "screenshot", dest], {
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (isNotFound(err)) {
      return {
        output: "look_native sim: xcrun/simctl not found. Kernel/CLI is the look.",
        isError: false,
      };
    }
    return limitedFrom(err, "ls115");
  }
  try {
    const st = fs.statSync(dest);
    if (st.size < 32) return { output: lookLimitReceipt("display", `${dest} is ${st.size} bytes`) };
  } catch {
    return { output: lookLimitReceipt("display", "sim screenshot missing") };
  }
  return {
    output: `look_native sim: wrote ${dest} (simctl io ${device} screenshot). Read that PNG (vision).`,
  };
}

function simTap(x: number, y: number, device: string): ToolResult {
  try {
    execFileSync("idb", ["ui", "tap", String(Math.round(x)), String(Math.round(y))], {
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      output: `look_native sim: idb ui tap ${Math.round(x)},${Math.round(y)} on ${device}.`,
    };
  } catch (err) {
    if (!isNotFound(err)) return limitedFrom(err);
  }
  return hidClick(x, y);
}

function findGodotBin(): string | undefined {
  const env = process.env.GODOT?.trim();
  const candidates = [
    env,
    "godot",
    "Godot",
    "/Applications/Godot.app/Contents/MacOS/Godot",
    "/Applications/Godot_mono.app/Contents/MacOS/Godot",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { timeout: 4000, stdio: "ignore" });
      return c;
    } catch (err) {
      if (isNotFound(err)) continue;
      return c;
    }
  }
  return undefined;
}

function writeMovie(opts: {
  destDir: string;
  project: string;
  frames: number;
}): ToolResult {
  const bin = findGodotBin();
  if (!bin) {
    return {
      output:
        "Looked: limited — Godot not on PATH (set GODOT). Do not retry osascript. Use the product CLI.",
      isError: false,
    };
  }
  fs.mkdirSync(opts.destDir, { recursive: true });
  const movie = path.join(opts.destDir, "look");
  try {
    execFileSync(
      bin,
      [
        "--display-driver",
        "headless",
        "--rendering-method",
        "gl_compatibility",
        "--write-movie",
        movie,
        "--quit-after",
        String(opts.frames),
        "--path",
        opts.project,
      ],
      { timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    return limitedFrom(err, "display");
  }
  return {
    output:
      `look_native movie: Godot --write-movie ${movie} --quit-after ${opts.frames}. ` +
      `Read the frames (vision). Kill any leftover Godot; do not open -a Godot.`,
  };
}

function screenshotWindow(dest: string, window: string): ToolResult {
  try {
    if (window) {
      execFileSync("screencapture", ["-l", window, dest], {
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      execFileSync("screencapture", ["-x", dest], {
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch (err) {
    return limitedFrom(err);
  }
  try {
    const st = fs.statSync(dest);
    if (st.size < 32) {
      return { output: lookLimitReceipt("display", `${dest} is ${st.size} bytes`) };
    }
  } catch {
    return { output: lookLimitReceipt("display", "screenshot missing") };
  }
  return {
    output:
      `look_native: wrote ${dest}. Read that PNG (vision). ` +
      `Do not retry osascript. If the grab is the desktop lock screen, Looked: limited.`,
  };
}

export async function toolLookNative(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = String(args.action ?? args.op ?? "screenshot").trim().toLowerCase();
  if (action === "classify") {
    const text = String(args.text ?? args.stderr ?? "");
    const kind = classifyLookLimit(text);
    if (!kind) {
      return { output: "look_native classify: no TCC/LS115/EPERM/display signature." };
    }
    return { output: lookLimitReceipt(kind), isError: false };
  }

  const clickish = action === "click" || action === "hid" || action === "tap";
  const simish = action === "sim" || action === "simctl" || action === "sim-screenshot" || action === "sim-tap";
  const movieish = action === "movie" || action === "write-movie" || action === "godot";

  if (clickish) {
    const darwin = needDarwin();
    if (darwin) return darwin;
    const x = numArg(args, "x", "clientX");
    const y = numArg(args, "y", "clientY");
    if (x == null || y == null) {
      return { output: "look_native click: x and y are required.", isError: true };
    }
    return hidClick(x, y);
  }

  if (simish) {
    const darwin = needDarwin();
    if (darwin) return darwin;
    const sess = needSession(ctx);
    if (!sess.ok) return sess.result;
    const device = String(args.device ?? args.udid ?? "booted").trim() || "booted";
    const x = numArg(args, "x", "clientX");
    const y = numArg(args, "y", "clientY");
    if (x != null && y != null) {
      const tap = simTap(x, y, device);
      if (tap.isError || /limited/i.test(tap.output)) return tap;
    }
    const destRel = String(args.dest ?? args.path ?? `sim-${Date.now()}.png`);
    const dest = looksDest(sess.id, destRel, ".png");
    return simScreenshot(dest, device);
  }

  if (movieish) {
    const sess = needSession(ctx);
    if (!sess.ok) return sess.result;
    const destRel = String(args.dest ?? `movie-${Date.now()}`);
    const destDir = looksDest(sess.id, destRel, "");
    const project =
      args.path != null && String(args.path).trim()
        ? path.resolve(ctx.workspace || process.cwd(), String(args.path).trim())
        : path.resolve(ctx.workspace || process.cwd());
    const framesRaw = numArg(args, "frames", "quit_after", "quitAfter");
    const frames = Math.max(1, Math.min(30, framesRaw != null ? Math.floor(framesRaw) : 4));
    return writeMovie({ destDir, project, frames });
  }

  const sess = needSession(ctx);
  if (!sess.ok) return sess.result;
  const darwin = needDarwin();
  if (darwin) return darwin;
  const destRel = String(args.dest ?? args.path ?? `native-${Date.now()}.png`);
  const dest = looksDest(sess.id, destRel, ".png");
  const window = args.window != null ? String(args.window).trim() : "";
  return screenshotWindow(dest, window);
}
