import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * Single source of truth for the CLI version (package.json).
 * Works from both src/ (tsx) and dist/ (built).
 */
export function getForgeVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/util → ../..  or  dist/util → ../..
    const root = path.resolve(here, "../..");
    const pkgPath = path.join(root, "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* fall through */
  }
  try {
    const req = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = req("../../package.json") as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* */
  }
  return "0.0.0-dev";
}
