/** Shared PATH probe for language server binaries. */
import fs from "node:fs";
import path from "node:path";

export function commandOnPath(cmd: string): boolean {
  if (!cmd || !cmd.trim()) return false;
  if (cmd.includes("/") || cmd.includes("\\")) {
    try {
      return fs.existsSync(cmd);
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH || "";
  const parts = pathEnv.split(path.delimiter);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  // Also check common Go bin when gopls might be there but not PATH-fixed yet
  const extra: string[] = [];
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      extra.push(path.join(home, "go", "bin"));
      extra.push(path.join(home, ".cargo", "bin"));
      extra.push(path.join(home, ".local", "bin"));
    }
  } catch {
    /* */
  }
  const dirs = [...parts, ...extra];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, cmd + ext))) return true;
      } catch {
        /* */
      }
    }
  }
  return false;
}
