/**
 * Best-effort system clipboard write for /copy.
 * Tries platform-native tools; returns which backend succeeded.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export type ClipboardImageResult =
  | { ok: true; path: string; backend: string }
  | { ok: false; error: string };

function clipboardImageDest(): string {
  const dir = path.join(os.homedir(), ".forge", "clipboard");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `paste-${Date.now()}.png`);
}

/**
 * Best-effort clipboard → PNG file for /paste.
 * macOS: pngpaste, then osascript JPEG/PNG, then pbpaste (rare).
 * Linux: wl-paste, xclip.
 */
export function saveClipboardImage(): ClipboardImageResult {
  const dest = clipboardImageDest();
  const tryFile = (cmd: string, args: string[]): boolean => {
    try {
      execFileSync(cmd, args, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 8_000,
      });
      return fs.existsSync(dest) && fs.statSync(dest).size > 32;
    } catch {
      return false;
    }
  };

  if (process.platform === "darwin") {
    if (tryFile("pngpaste", [dest])) {
      return { ok: true, path: dest, backend: "pngpaste" };
    }
    try {
      const script = `
        set out to POSIX file ${JSON.stringify(dest)}
        try
          set theImage to the clipboard as «class PNGf»
          set f to open for access out with write permission
          set eof f to 0
          write theImage to f
          close access f
          return "ok"
        on error
          try
            set theImage to the clipboard as JPEG picture
            set f to open for access out with write permission
            set eof f to 0
            write theImage to f
            close access f
            return "ok"
          on error errMsg
            return "err"
          end try
        end try
      `;
      execFileSync("osascript", ["-e", script], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 8_000,
      });
      if (fs.existsSync(dest) && fs.statSync(dest).size > 32) {
        return { ok: true, path: dest, backend: "osascript" };
      }
    } catch {
      /* */
    }
    return {
      ok: false,
      error:
        "clipboard has no image (copy a screenshot, or brew install pngpaste)",
    };
  }

  if (tryFile("wl-paste", ["--type", "image/png", "-o", dest])) {
    return { ok: true, path: dest, backend: "wl-paste" };
  }
  try {
    const buf = execFileSync(
      "xclip",
      ["-selection", "clipboard", "-t", "image/png", "-o"],
      { timeout: 8_000, maxBuffer: 20 * 1024 * 1024 },
    );
    if (buf && buf.length > 32) {
      fs.writeFileSync(dest, buf);
      return { ok: true, path: dest, backend: "xclip" };
    }
  } catch {
    /* */
  }

  try {
    fs.unlinkSync(dest);
  } catch {
    /* */
  }
  return {
    ok: false,
    error:
      "clipboard has no image (install pngpaste / wl-paste / xclip, then copy a screenshot)",
  };
}
