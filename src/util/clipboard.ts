/**
 * Best-effort system clipboard write for /copy.
 * Tries platform-native tools; returns which backend succeeded.
 */
import { execFileSync, execSync } from "node:child_process";

export type ClipboardResult =
  | { ok: true; backend: string }
  | { ok: false; error: string };

function tryExec(
  cmd: string,
  args: string[],
  text: string,
  backend: string,
): ClipboardResult | null {
  try {
    execFileSync(cmd, args, {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5_000,
    });
    return { ok: true, backend };
  } catch {
    return null;
  }
}

/**
 * Copy plain text to the OS clipboard.
 * Order: macOS pbcopy → Wayland wl-copy → X11 xclip → X11 xsel →
 * Windows clip → WSL clip.exe.
 */
export function copyToClipboard(text: string): ClipboardResult {
  if (text == null) {
    return { ok: false, error: "nothing to copy" };
  }
  const body = String(text);

  if (process.platform === "darwin") {
    const r = tryExec("pbcopy", [], body, "pbcopy");
    if (r) return r;
    return { ok: false, error: "pbcopy failed" };
  }

  if (process.platform === "win32") {
    // `clip` reads stdin on Windows
    try {
      execSync("clip", {
        input: body,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        timeout: 5_000,
      });
      return { ok: true, backend: "clip" };
    } catch {
      return { ok: false, error: "clip failed" };
    }
  }

  // Linux / BSD / WSL
  const candidates: Array<[string, string[], string]> = [
    ["wl-copy", [], "wl-copy"],
    ["xclip", ["-selection", "clipboard"], "xclip"],
    ["xsel", ["--clipboard", "--input"], "xsel"],
    // WSL often has clip.exe on PATH
    ["clip.exe", [], "clip.exe"],
  ];
  for (const [cmd, args, name] of candidates) {
    const r = tryExec(cmd, args, body, name);
    if (r) return r;
  }

  return {
    ok: false,
    error:
      "no clipboard tool found (install wl-copy, xclip, or xsel; on macOS use pbcopy)",
  };
}
