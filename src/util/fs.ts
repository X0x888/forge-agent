import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function forgeHome(): string {
  const override = process.env.FORGE_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".forge");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export async function ensureDirAsync(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function readJsonFileAsync<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file: string, data: unknown, mode = 0o600): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* windows */
  }
}

export async function writeJsonFileAsync(
  file: string,
  data: unknown,
  mode = 0o600,
): Promise<void> {
  await ensureDirAsync(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  await fsp.rename(tmp, file);
  try {
    await fsp.chmod(file, mode);
  } catch {
    /* windows */
  }
}

export function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function isWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot + path.sep)
  );
}

/**
 * Resolve a path and check it stays under `root` after realpath/symlink
 * expansion. For non-existent targets, realpath the deepest existing ancestor
 * and re-join remaining segments (so write-to-new-file still gets containment).
 */
export async function realpathWithinRoot(
  root: string,
  target: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const resolvedRoot = path.resolve(root);
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }

  const logical = path.resolve(target);
  let realTarget: string;
  try {
    realTarget = await fsp.realpath(logical);
  } catch {
    // Walk up until an existing ancestor is found, then re-join.
    let cursor = logical;
    const missing: string[] = [];
    while (true) {
      try {
        const ancestor = await fsp.realpath(cursor);
        realTarget = path.join(ancestor, ...missing.reverse());
        break;
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          return {
            ok: false,
            reason: `Cannot resolve path (no existing ancestor): ${logical}`,
          };
        }
        missing.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }

  if (
    realTarget === realRoot ||
    realTarget.startsWith(realRoot + path.sep)
  ) {
    return { ok: true, path: realTarget };
  }
  return {
    ok: false,
    reason: `Path escapes workspace after symlink resolution: ${logical} → ${realTarget} (root: ${realRoot})`,
  };
}
